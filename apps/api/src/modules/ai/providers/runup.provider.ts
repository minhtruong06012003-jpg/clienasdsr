import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import { AiProviderError, type AiCallContext, type AiInput, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { loadInputFile } from './background.js';
import { pickMessage, providerFetch, str } from './http.js';

const execFileAsync = promisify(execFile);

/**
 * Runup Studio — https://runup.studio/developer-api/docs, base https://runup.studio/api/v1, header `Authorization: Bearer rup_live_...`.
 * Partner API v1 chỉ có Video Upscale 4K (`runup-upscale`, mode `Detail`), chạy bất đồng bộ 4 bước:
 *   1. POST /video-jobs { filename, content_type, size_bytes, width, height, fps, duration_seconds, tool, mode } + header Idempotency-Key
 *      -> { id, credits (giá dự kiến), upload: { url, headers } } (upload.url hiệu lực 15 phút);
 *   2. PUT file gốc lên upload.url CHỈ với upload.headers (không gửi Bearer);
 *   3. POST /video-jobs/{id}/start;
 *   4. GET /video-jobs/{id} (uploading → queued → processing → complete | failed); complete có result.download_url (15 phút) -> tải về lưu.
 * - Giá: 3 UP / giây video đầu vào (làm tròn lên từng giây), 1 UP = 10đ -> `cost` = UP × tỉ giá quy đổi (mặc định 10).
 * - Giới hạn nguồn: fps ≤ 31, file ≤ 2 GB, thời lượng theo gói (Pro 62s, Founder 182s), 60 request / phút mỗi khoá.
 * - Số dư: GET /account -> { balance_up, balance_vnd, plan, max_duration_seconds } (nguồn thêm ngày 2026-11-16).
 */

const TOOL = 'runup-upscale';
const MODE = 'Detail';
/** UP mỗi giây video đầu vào (mode Detail) — theo tài liệu ngày 2026-11-16 */
const UP_PER_SECOND = 3;
const MAX_FPS = 31;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Định dạng nguồn nhận */
const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' };

const TOOLS: AiToolDef[] = [
  {
    key: 'video-upscale-4k',
    name: 'Làm nét video 4K',
    category: 'voice',
    icon: 'sparkles',
    badge: 'NEW',
    description: 'Nâng video lên 4K, phục hồi chi tiết khuôn mặt, tóc, chữ và cảnh vật sắc nét. Giá tính theo số giây của video gốc.',
    output: 'video',
    fields: [
      {
        name: 'video',
        label: 'Video cần làm nét',
        type: 'video',
        required: true,
        accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
        help: 'MP4, MOV, WEBM, MKV · tối đa 60 giây (quá dài sẽ bị từ chối và hoàn tiền), tối đa 30 fps',
      },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
    unitLabel: 'giây',
  },
];

/** Giới hạn thời lượng của gói Runup khi không đọc được GET /account (gói Pro) */
const FALLBACK_MAX_SECONDS = 62;
/** Cache thông tin tài khoản nguồn 5 phút (giới hạn thời lượng theo gói) */
let accountCache: { at: number; key: string; account: any } | null = null;

async function account(ctx: AiCallContext, fresh = false): Promise<any> {
  if (!fresh && accountCache?.key === ctx.config.apiKey && Date.now() - accountCache.at < 300_000) return accountCache.account;
  const res = await providerFetch<any>(ctx.config, '/account', { timeoutMs: 20_000 });
  accountCache = { at: Date.now(), key: ctx.config.apiKey, account: res };
  return res;
}

/** Thời lượng tối đa (giây) gói hiện tại của nguồn nhận; lỗi mạng thì dùng mức gói Pro */
async function maxSeconds(ctx: AiCallContext): Promise<number> {
  const n = Number((await account(ctx).catch(() => null))?.max_duration_seconds);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_MAX_SECONDS;
}

/** Độ dài (giây, làm tròn lên) video khách tải lên; chưa tải file (báo giá tạm trên form) thì tính 10 giây */
async function uploadSeconds(ctx: AiCallContext, url: unknown): Promise<number> {
  if (!str(url)) return 10;
  const sec = await ctx.uploadDuration(str(url));
  if (sec === null || !Number.isFinite(sec) || sec <= 0) throw new BadRequestException('Không đọc được độ dài video, vui lòng dùng MP4 / MOV / WEBM / MKV');
  return Math.ceil(sec);
}

/** Kích thước, fps, thời lượng của video (ffprobe trên file tạm) — nguồn bắt buộc khai báo khi tạo job */
async function probe(data: Buffer, ext: string): Promise<{ width: number; height: number; fps: number; duration: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'novai-runup-'));
  const file = join(dir, `input.${ext}`);
  try {
    await writeFile(file, data);
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', file],
      { timeout: 30_000 },
    );
    const info = JSON.parse(String(stdout || '{}'));
    const s = info?.streams?.[0] ?? {};
    const rate = (v: unknown) => {
      const [a, b] = String(v ?? '').split('/').map(Number);
      return b ? a / b : a;
    };
    const fps = [rate(s.avg_frame_rate), rate(s.r_frame_rate)].find((x) => Number.isFinite(x) && x > 0) ?? 0;
    return { width: Number(s.width) || 0, height: Number(s.height) || 0, fps: Math.round(fps * 1000) / 1000, duration: Number(info?.format?.duration) || 0 };
  } catch {
    throw new BadRequestException('Không đọc được thông tin video, vui lòng dùng MP4 / MOV / WEBM / MKV');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Trạng thái job của nguồn -> kết quả chung; complete thì tải MP4 (link 15 phút) về để lưu */
async function toResult(job: any, id: string): Promise<AiProviderResult> {
  const status = str(job?.status).toLowerCase();
  if (status === 'complete') {
    const url = str(job?.result?.download_url);
    if (!url) return { status: 'processing', providerTaskId: id, progress: 99, raw: job };
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    } catch (err) {
      // link hết hạn / lỗi mạng -> lần hỏi sau đọc lại trạng thái để lấy link mới
      throw new AiProviderError('Không tải được video kết quả, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
    }
    if (!res.ok) throw new AiProviderError('Không tải được video kết quả, hệ thống sẽ thử lại', { status: res.status, job }, true);
    const data = Buffer.from(await res.arrayBuffer());
    const mimeType = (res.headers.get('content-type') || 'video/mp4').split(';')[0].trim();
    return { status: 'succeeded', providerTaskId: id, files: [{ url: '', type: 'video', name: `${id}-4k.mp4`, data, mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4' }], raw: job };
  }
  if (status === 'failed') {
    const rawMsg = str(job?.error?.message) || pickMessage(job);
    const cleanMsg = /could not complete this video|processing_failed/i.test(`${str(job?.error?.code)} ${rawMsg}`)
      ? 'Máy chủ làm nét 4K không xử lý được video này (có thể do chuẩn nén đặc biệt hoặc cảnh quá phức tạp), vui lòng thử lại hoặc xuất lại MP4 H.264 — tiền đã được hoàn lại'
      : rawMsg
        ? `${rawMsg.replace(/runup\s*studio|runup\.studio/gi, 'Hệ thống AI').trim()}. Tiền đã được hoàn lại`
        : 'Làm nét video thất bại, tiền đã được hoàn lại';
    return { status: 'failed', providerTaskId: id, error: cleanMsg, raw: job };
  }
  return { status: 'processing', providerTaskId: id, progress: Number(job?.progress) || undefined, raw: job };
}

/** Tự động hạ khung hình video > 30 fps (vd 32 / 50 / 60 fps trên điện thoại) về chuẩn 30 fps MP4 H.264 để nguồn nhận xử lý mượt */
async function normalizeFpsTo30(data: Buffer, ext: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'novai-runup-fps-'));
  const inFile = join(dir, `in.${ext || 'mp4'}`);
  const outFile = join(dir, 'out.mp4');
  try {
    await writeFile(inFile, data);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inFile, '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile],
      { timeout: 180_000 },
    );
    return await readFile(outFile);
  } catch {
    throw new AiProviderError('Video có tốc độ khung hình trên 30 fps và không tự chuyển đổi được. Vui lòng xuất lại video 24 / 25 / 30 fps — tiền đã được hoàn lại');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const runupProvider: AiProvider = {
  key: 'runup',
  name: 'Runup Studio (runup.studio)',
  website: 'https://runup.studio',
  tools: TOOLS,
  // 1 UP = 10đ; admin đổi theo giá nạp thật ở tab Khoá API nhà cung cấp
  costUnit: 'UP',
  rate: 10,

  async cost(_tool, input, ctx) {
    return (await uploadSeconds(ctx, input.video)) * UP_PER_SECOND;
  },

  async submit(_tool, input: AiInput, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
    const video = await loadInputFile(ctx.readUpload, str(input.video));
    let ext = (video.filename.split('.').pop() ?? '').toLowerCase();
    let contentType = Object.values(CONTENT_TYPES).includes(video.mimeType) ? video.mimeType : CONTENT_TYPES[ext];
    if (!contentType) throw new AiProviderError('Chỉ nhận video MP4, MOV, WEBM hoặc MKV — tiền đã được hoàn lại');
    if (video.data.length > MAX_BYTES) throw new AiProviderError('Video quá lớn (tối đa 2 GB) — tiền đã được hoàn lại');
    let videoBytes = video.data;
    let videoFilename = video.filename || `input.${ext || 'mp4'}`;
    let meta = await probe(videoBytes, ext || 'mp4').catch(() => {
      throw new AiProviderError('Không đọc được thông tin video, vui lòng dùng file MP4 / MOV hợp lệ — tiền đã được hoàn lại');
    });
    if (!meta.width || !meta.height || !meta.duration) throw new AiProviderError('Không đọc được kích thước hoặc thời lượng video — tiền đã được hoàn lại');
    // nguồn từ chối video dài hơn giới hạn gói (403 membership_video_duration_limit) -> báo trước bằng tiếng Việt, không gọi nguồn
    const max = await maxSeconds(ctx);
    if (meta.duration > max) {
      throw new AiProviderError(`Video dài ${Math.ceil(meta.duration)} giây, công cụ chỉ nhận video tối đa ${Math.floor(max)} giây. Vui lòng cắt ngắn video rồi thử lại — tiền đã được hoàn lại`);
    }
    if (meta.fps > MAX_FPS) {
      videoBytes = await normalizeFpsTo30(videoBytes, ext || 'mp4');
      ext = 'mp4';
      contentType = 'video/mp4';
      videoFilename = videoFilename.replace(/\.[^.]+$/, '') + '-30fps.mp4';
      meta = await probe(videoBytes, 'mp4');
    }

    // 1. tạo job (cùng Idempotency-Key + cùng body nguồn trả lại job cũ, không tạo trùng)
    const job = await providerFetch<any>(ctx.config, '/video-jobs', {
      json: {
        filename: videoFilename,
        content_type: contentType,
        size_bytes: videoBytes.length,
        width: meta.width,
        height: meta.height,
        fps: Math.min(30, meta.fps),
        duration_seconds: Math.round(meta.duration * 1000) / 1000,
        tool: TOOL,
        mode: MODE,
      },
      headers: { Authorization: `Bearer ${ctx.config.apiKey}`, 'Idempotency-Key': `novai-${randomUUID()}` },
    });
    const id = str(job?.id);
    const uploadUrl = str(job?.upload?.url);
    if (!id || !uploadUrl) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', job);

    // 2. tải file gốc lên link ký sẵn: chỉ gửi đúng header nguồn trả về, không kèm Bearer
    const headers: Record<string, string> = { 'content-type': contentType, ...(job.upload.headers ?? {}) };
    let put: Response;
    try {
      put = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(videoBytes), signal: AbortSignal.timeout(600_000) });
    } catch (err) {
      throw new AiProviderError('Không tải được video lên nhà cung cấp, tiền đã được hoàn lại', { id, error: (err as Error).message });
    }
    if (!put.ok) throw new AiProviderError('Không tải được video lên nhà cung cấp, tiền đã được hoàn lại', { id, status: put.status, body: (await put.text().catch(() => '')).slice(0, 500) });

    // 3. bắt đầu xử lý (nguồn trừ UP lúc này)
    const started = await providerFetch<any>(ctx.config, `/video-jobs/${encodeURIComponent(id)}/start`, { method: 'POST' });
    return toResult({ ...job, ...started }, id);
  },

  async poll(_tool, id, ctx) {
    return toResult(await providerFetch<any>(ctx.config, `/video-jobs/${encodeURIComponent(id)}`), id);
  },

  /** Số dư UP (GET /account) — trang admin + bot Telegram báo khi số dư thấp / thay đổi mức */
  async balance(ctx) {
    const res = await account(ctx, true);
    return { balance: Number(res?.balance_up ?? 0), unit: 'UP' };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const res = await account(ctx, true).catch(() => null);
    if (!res) return null;
    const st = String((res as any)?.status ?? '').toLowerCase();
    if (/maint|suspend|disable|ban/.test(st)) return 'ALL';
    return new Set<string>();
  },
};
