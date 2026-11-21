import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiCatalogItem,
  type AiInput,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderResult,
  type AiToolDef,
} from '../ai.types.js';
import { loadInputFile } from './background.js';
import { pickMessage, str } from './http.js';

const execFileAsync = promisify(execFile);

/**
 * Up4K REST v1 (chuẩn SDK/CLI `up4k@0.4.1` — https://up4k.io/developers & https://up4k.io/openapi.json)
 * Xác thực: `Authorization: Bearer cx_live_...`
 *
 * Quy trình REST v1:
 *   1. `GET /api/v1/me` -> kiểm tra `access.unlocked`, `engines`, `engines_maintenance`, `api_daily_jobs`,
 *      `active_count`/`max_active`, `max_seconds` (thường 35s) và `long_video` (`eligible`, `min_seconds`,
 *      `max_upload_bytes`, `max_seconds[engine]`).
 *   2. `POST /api/v1/jobs` (+ `Idempotency-Key`) kèm `filename`, `size`, `duration`, `width`, `height`,
 *      `fps` (`avg_frame_rate` thực tế, tuyệt đối không dùng `r_frame_rate`), `engine`,
 *      `output_frame` (chỉ gửi `"uhd"` cho `4k-fast` khi bật UHD; mặc định `"native"`),
 *      `sharpness` (chỉ gửi cho `pro-4k` & `pro-4k-max`), và `consent` (`selfLikeness` + `selfLikenessConsent`).
 *   3. `single` (`upload_method === "PUT"`):
 *      - `PUT` binary lên `upload_url` chỉ với đúng `upload_headers` + `Content-Length` (tuyệt đối không gửi `Bearer` hay header lạ chưa ký);
 *      - `POST /api/v1/jobs/{id}/submit`.
 *      `long` (`kind === "long"` hoặc `upload_method === "multipart"`):
 *      - `POST multipart_url` `{ action: "create" }` -> `sign` (tối đa 20 parts/lần) -> 4 luồng `PUT` song song
 *        (chỉ gửi `Content-Length`, lưu `ETag`) -> `{ action: "complete", upload_id, parts }` (không gọi `/submit`);
 *      - Nếu lỗi không thể phục hồi trước khi `complete`, gọi `{ action: "abort", upload_id }` để giải phóng slot active.
 *   4. Poll `GET /api/v1/jobs/{id}` (`uploading` | `queued` | `claimed` | `running` | `done` | `rejected` | `failed` | `canceled` | `expired`).
 *   5. Khi `done`: tải file kết quả từ `GET /api/v1/jobs/{id}/download` (đường dẫn tương đối cần `Bearer`; nếu redirect sang kho lưu trữ ngoài thì tự bỏ `Bearer`).
 *
 * Công thức giá gốc (credit):
 *   - `4k-fast`: ≤ 35s = 1.0 credit cố định; > 35s = ceil(seconds / 35) credit (tối đa 60 phút)
 *   - `pro-4k`: mỗi 4.5s = 1 credit, tính từng 0.1 credit -> ceil((seconds / 4.5) * 10) / 10 (tối đa 5 phút)
 *   - `pro-4k-max` & `pro-4k-max-creative`: mỗi 2.5s = 1 credit, tính từng 0.1 credit -> ceil((seconds / 2.5) * 10) / 10 (tối đa 5 phút)
 */

const DEFAULT_ORIGIN = 'https://up4k.io';
const UP4K_CLIENT_VERSION = '0.4.1';
const USER_AGENT = `up4k/${UP4K_CLIENT_VERSION} NovAIStudio/1.0`;
const MAX_SINGLE_BYTES = 500 * 1024 * 1024; // 500 MiB
const DEFAULT_LONG_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
const MIN_LONG_SIDE = 500;
const MAX_LONG_SIDE = 2560;

type Up4kEngine = '4k-fast' | 'pro-4k' | 'pro-4k-max' | 'pro-4k-max-creative';

const ENGINES: { value: Up4kEngine; label: string }[] = [
  { value: '4k-fast', label: '4K Fast · Siêu tiết kiệm (đồng giá video ≤ 35s)' },
  { value: 'pro-4k', label: '4K Pro · Nét tự nhiên, chống nháy (tối đa 5 phút)' },
  { value: 'pro-4k-max', label: '4K Max · Độ chi tiết cao cấp nhất (tối đa 5 phút)' },
  { value: 'pro-4k-max-creative', label: '4K Max Creative · AI tái tạo chi tiết sâu da, tóc, vải (tối đa 5 phút)' },
];

const MAX_STYLE_OPTIONS = [
  { value: 'faithful', label: 'Trung thực · Bám sát bản gốc, tuỳ chỉnh độ nét' },
  { value: 'creative', label: 'Sáng tạo · AI vẽ thêm chi tiết sâu cho da, tóc, vải' },
];

const SHARPNESS_OPTIONS = [
  { value: 'can-bang', label: 'Cân bằng (khuyên dùng)' },
  { value: 'net', label: 'Nét' },
  { value: 'cuc-net', label: 'Cực nét' },
  { value: 'mem', label: 'Mềm' },
  { value: 'tu-nhien', label: 'Tự nhiên' },
];

const OUTPUT_FRAME_OPTIONS = [
  { value: 'native', label: 'Khung 4K theo tỉ lệ gốc (3416–4096px · nhanh hơn)' },
  { value: 'uhd', label: 'Chuẩn UHD 3840×2160 (TV / máy chiếu)' },
];

const TOOLS: AiToolDef[] = [
  {
    key: 'video-4k-upscale',
    name: 'Nâng cấp video 4K',
    category: 'voice',
    icon: 'sparkles',
    badge: 'SV2',
    featured: true,
    description:
      'Nâng độ phân giải video từ 480p / 720p / 1080p lên chuẩn 4K sắc nét, giữ nguyên âm thanh gốc. Tối ưu đặc biệt cho video AI (Seedance 2.5, Kling, Veo, Sora) giúp tiết kiệm hơn 50% chi phí tạo video.',
    output: 'video',
    supportsCost: true,
    unitLabel: 'lượt',
    priceHint: '4K Fast đồng giá video ≤ 35s · 4K Pro / 4K Max tính chính xác từng 0,1 credit theo giây',
    fields: [
      {
        name: 'model',
        label: 'Model AI',
        type: 'select',
        required: true,
        default: '4k-fast',
        options: ENGINES,
      },
      {
        name: 'video',
        label: 'Video cần nâng cấp lên 4K',
        type: 'video',
        required: true,
        accept: 'video/mp4,video/quicktime,video/webm',
        help: 'Hỗ trợ MP4, MOV, WEBM (video > 30 fps hoặc kích thước lệch chuẩn được tự động chuẩn hoá). 4K Fast nhận video tới 60 phút; 4K Pro & 4K Max nhận tới 5 phút.',
      },
      {
        name: 'max_style',
        label: 'Kiểu tái tạo 4K Max',
        type: 'select',
        required: false,
        default: 'faithful',
        options: MAX_STYLE_OPTIONS,
        showIf: { field: 'model', in: ['pro-4k-max'] },
        help: 'Kiểu Trung thực bám sát chi tiết gốc và cho phép chỉnh độ nét; Kiểu Sáng tạo để AI vẽ thêm chi tiết sâu da, tóc, vải (nhanh hơn, cùng đơn giá).',
      },
      {
        name: 'sharpness',
        label: 'Độ sắc nét chi tiết',
        type: 'select',
        required: true,
        default: 'can-bang',
        options: SHARPNESS_OPTIONS,
        showIf: { field: 'model', in: ['pro-4k', 'pro-4k-max'] },
        help: 'Tuỳ chỉnh mức tái tạo chi tiết bề mặt cho 4K Pro và 4K Max (Trung thực). Chế độ 4K Max Creative tự động dùng mức Cân bằng.',
      },
      {
        name: 'output_frame',
        label: 'Khung hình đầu ra',
        type: 'select',
        required: true,
        default: 'native',
        options: OUTPUT_FRAME_OPTIONS,
        showIf: { field: 'model', in: ['4k-fast'] },
        help: 'Giữ khung tỉ lệ gốc (cạnh dài 3416–4096px) giúp giao kết quả nhanh hơn; chỉ chọn Chuẩn UHD 3840×2160 khi nơi phát bắt buộc đúng 3840×2160.',
      },
      {
        name: 'selfLikeness',
        label: 'Video có hình ảnh / giọng nói thật của chính tôi',
        type: 'boolean',
        default: false,
        help: 'Để Tắt nếu là video tạo bằng AI (Seedance, Kling, Veo...). Khi Bật, bạn xác nhận có quyền và đồng ý xử lý hình ảnh/giọng nói cá nhân để nâng cấp 4K.',
      },
    ],
    pricing: { mode: 'cost', markup: 38 },
  },
];

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function siteOrigin(cfg: AiProviderConfig): string {
  const raw = (cfg.baseUrl || DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
  const stripped = raw.replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '');
  return stripped || DEFAULT_ORIGIN;
}

function apiUrl(cfg: AiProviderConfig, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const origin = siteOrigin(cfg);
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean.startsWith('/api/v1/')) return `${origin}${clean}`;
  return `${origin}/api/v1${clean}`;
}

const scrubBrand = (msg: string | undefined | null): string =>
  (msg ?? '')
    .replace(/(?:https?:\/\/)?[\w.-]*(?:up4k|chugax)[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\b(?:up4k|chugax(?:\s*ai)?)\b/gi, 'Hệ thống AI')
    .replace(/\bcredit(?:s)?\b/gi, 'lượt')
    .replace(/\s{2,}/g, ' ')
    .trim();

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const parsed = Date.parse(headerVal);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - Date.now());
  return null;
}

async function up4kFetch<T = any>(
  cfg: AiProviderConfig,
  path: string,
  opts: {
    method?: string;
    json?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    attempts?: number;
  } = {},
): Promise<T> {
  const url = apiUrl(cfg, path);
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const maxAttempts = Math.max(1, opts.attempts ?? 3);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers ?? {}),
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    let text = '';
    try {
      res = await fetch(url, {
        method,
        headers,
        redirect: 'error',
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      text = await res.text();
    } catch (err) {
      if (attempt + 1 < maxAttempts) {
        await sleepMs(Math.min(5_000, 600 * 2 ** attempt));
        continue;
      }
      throw new AiProviderError(
        'Máy chủ nâng cấp 4K đang bận tạm thời, hệ thống sẽ tự thử lại ngay',
        { error: (err as Error).message },
        true,
      );
    }

    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { body: text.slice(0, 800) };
    }

    if (res.ok) {
      return data as T;
    }

    const code = str(data?.error?.code).toLowerCase();
    const rawMsg = str(data?.error?.message) || pickMessage(data);

    // Tự động chờ ngắn & thử lại với lỗi tạm thời (`rate_limited` 120 req/phút, `storage_unavailable` 503, 5xx)
    const inlineRetryable =
      (res.status === 429 && code === 'rate_limited') ||
      code === 'storage_unavailable' ||
      res.status >= 500;
    if (inlineRetryable && attempt + 1 < maxAttempts) {
      const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
      const waitMs = retryAfter !== null ? Math.min(10_000, Math.max(400, retryAfter)) : Math.min(6_000, 600 * 2 ** attempt);
      await sleepMs(waitMs);
      continue;
    }

    if (res.status === 401 || res.status === 402 || code === 'no_credits' || code === 'invalid_api_key') {
      throw new AiProviderError(
        'Công cụ đang bảo trì tạm thời, vui lòng thử lại sau. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (
      res.status === 403 ||
      res.status === 426 ||
      code === 'api_locked' ||
      code === 'account_suspended' ||
      code === 'engine_unavailable' ||
      code === 'uploads_closed' ||
      code === 'upgrade_required'
    ) {
      throw new AiProviderError(
        'Gói nâng cấp 4K này hiện tạm bảo trì, vui lòng chọn chế độ khác hoặc thử lại sau. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (
      res.status === 423 ||
      code === 'locked_for_review' ||
      code === 'active_limit' ||
      code === 'rate_limited' ||
      code === 'storage_unavailable' ||
      res.status >= 500
    ) {
      throw new AiProviderError(
        'Đang chờ luồng xử lý 4K trống, hệ thống sẽ tự gửi ngay trong giây lát',
        { status: res.status, code, data, waitingSlot: true },
        true,
      );
    }
    if (code === 'daily_limit') {
      throw new AiProviderError(
        'Hệ thống nâng cấp 4K đã đạt hạn mức xử lý trong ngày, vui lòng thử lại sau. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (code === 'source_aspect_ratio') {
      throw new AiProviderError(
        'Tỉ lệ khung hình video vượt giới hạn hỗ trợ (tối đa 21:9) — vui lòng xuất lại video theo tỉ lệ chuẩn. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (code === 'source_short_side' || code === 'resolution_limit' || code === 'source_dimensions_missing') {
      throw new AiProviderError(
        'Độ phân giải video đầu vào không nằm trong ngưỡng hỗ trợ của chế độ này — vui lòng xuất lại MP4 chuẩn. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (code === 'frame_rate_limit') {
      throw new AiProviderError(
        'Video vượt quá tốc độ khung hình tối đa 30 fps — vui lòng xuất lại ở 30 fps trở xuống. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }
    if (code === 'duration_limit') {
      throw new AiProviderError(
        'Thời lượng video vượt giới hạn tối đa của chế độ nâng cấp 4K đã chọn. Tiền đã được hoàn lại.',
        { status: res.status, code, data },
        false,
      );
    }

    const clean = scrubBrand(rawMsg) || `Yêu cầu nâng cấp video không hợp lệ (HTTP ${res.status})`;
    throw new AiProviderError(`${clean} — tiền đã được hoàn lại`, { status: res.status, code, data }, false);
  }

  throw new AiProviderError('Máy chủ nâng cấp 4K đang bận tạm thời, hệ thống sẽ tự thử lại ngay', undefined, true);
}

interface Up4kAccountMe {
  tier?: string;
  credits?: { free?: number; mine?: number };
  max_seconds?: number;
  active_count?: number;
  max_active?: number;
  api_daily_jobs?: { used?: number; limit?: number | null };
  limits?: { max_seconds?: number; active_count?: number; max_active?: number };
  access?: { unlocked?: boolean; reason?: string | null };
  engines?: string[];
  engines_maintenance?: string[];
  long_video?: {
    enabled?: boolean;
    eligible?: boolean;
    min_seconds?: number;
    max_upload_bytes?: number;
    max_seconds?: Record<string, number>;
  };
}

let meCache: { at: number; key: string; data: Up4kAccountMe } | null = null;

async function fetchMe(cfg: AiProviderConfig, fresh = false): Promise<Up4kAccountMe> {
  if (!fresh && meCache?.key === cfg.apiKey && Date.now() - meCache.at < 90_000) return meCache.data;
  const data = await up4kFetch<Up4kAccountMe>(cfg, '/me', { timeoutMs: 15_000, attempts: 2 });
  meCache = { at: Date.now(), key: cfg.apiKey, data };
  return data;
}

function resolveEngine(input: AiInput): Up4kEngine {
  const m = str(input.model || input.engine).trim().toLowerCase();
  if (m === 'pro-4k-max-creative' || m === '4k-max-creative') return 'pro-4k-max-creative';
  if (m === 'pro-4k-max' || m === '4k-max') {
    return str(input.max_style).trim().toLowerCase() === 'creative' ? 'pro-4k-max-creative' : 'pro-4k-max';
  }
  if (m === 'pro-4k' || m === 'pro-4k-trial' || m === '4k-pro') return 'pro-4k';
  return '4k-fast';
}

/** Tính đúng số credit gốc theo công thức niêm yết của Up4K */
function calcUp4kCredits(engine: Up4kEngine, durationSec: number): number {
  const sec = Math.max(1, durationSec);
  if (engine === 'pro-4k') {
    return Math.max(0.1, Math.ceil((sec / 4.5) * 10 - 1e-9) / 10);
  }
  if (engine === 'pro-4k-max' || engine === 'pro-4k-max-creative') {
    return Math.max(0.1, Math.ceil((sec / 2.5) * 10 - 1e-9) / 10);
  }
  // 4k-fast: ≤ 35s = 1 credit; > 35s = mỗi 35s tính 1 credit làm tròn lên
  return sec <= 35 ? 1 : Math.ceil(sec / 35 - 1e-9);
}

interface ProbedVideo {
  width: number;
  height: number;
  fps: number;
  duration: number;
}

async function probeVideo(data: Buffer, ext: string): Promise<ProbedVideo> {
  const dir = await mkdtemp(join(tmpdir(), 'novai-up4k-probe-'));
  const file = join(dir, `input.${ext || 'mp4'}`);
  try {
    await writeFile(file, data);
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,duration:format=duration',
        '-of',
        'json',
        file,
      ],
      { timeout: 30_000 },
    );
    const info = JSON.parse(String(stdout || '{}'));
    const s = info?.streams?.[0] ?? {};
    const parseAvgRate = (v: unknown): number => {
      const [num, den] = String(v ?? '').split('/').map(Number);
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) return num / den;
      return Number.isFinite(num) && num > 0 ? num : 0;
    };
    const fps = parseAvgRate(s.avg_frame_rate);
    const dur = Number(info?.format?.duration ?? s.duration) || 0;
    return {
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      fps: fps > 0 ? Math.round(fps * 1000) / 1000 : 0,
      duration: dur,
    };
  } catch {
    throw new BadRequestException('Không đọc được thông tin video, vui lòng tải lên file MP4 / MOV / WEBM hợp lệ');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Chuẩn hoá tự động bằng ffmpeg theo đúng điều kiện nhận nguồn của Up4K v0.4.1:
 * - Chỉ nhận MP4 / MOV (`.webm` tự chuyển sang `.mp4` H.264);
 * - Tốc độ khung hình trung bình `avg_frame_rate` ≤ 30 fps (`> 30.05` hạ về `30 fps`);
 * - Cạnh dài mọi gói nằm trong khoảng `500–2560 px` (`resolution_limit`);
 * - `pro-4k`: cạnh ngắn ≤ 1080 px (1081–1088 nguồn tự cắt, > 1088 hệ thống thu chuẩn về ≤ 1080 px), tỉ lệ khung ≤ 21:9 (`source_aspect_ratio`);
 * - `pro-4k-max` & `pro-4k-max-creative`: cạnh ngắn `480–1080 px` (`source_short_side`), tỉ lệ khung ≤ 21:9.
 */
async function ensureCompatibleMp4(
  data: Buffer,
  ext: string,
  meta: ProbedVideo,
  engine: Up4kEngine,
): Promise<{ bytes: Buffer; ext: string; meta: ProbedVideo; changed: boolean }> {
  const isPro = engine !== '4k-fast';
  const isMax = engine === 'pro-4k-max' || engine === 'pro-4k-max-creative';

  let w = meta.width;
  let h = meta.height;
  const origLong = Math.max(w, h);
  const origShort = Math.min(w, h);

  // Kiểm tra tỉ lệ khung hình quá dẹt (> 21:9 = 2.333...) trên các gói Pro/Max
  const aspect = origLong / Math.max(1, origShort);
  const needsPad21x9 = isPro && aspect > 21 / 9 + 0.015;
  if (needsPad21x9) {
    const minShort = Math.ceil((origLong * 9) / 21 / 2) * 2;
    if (w >= h) h = Math.max(h, minShort);
    else w = Math.max(w, minShort);
  }

  let scaleFactor = 1;
  const curLong = Math.max(w, h);
  const curShort = Math.min(w, h);

  if (curLong < MIN_LONG_SIDE) {
    scaleFactor = Math.max(scaleFactor, (MIN_LONG_SIDE + 4) / Math.max(1, curLong));
  }
  if (isMax && curShort * scaleFactor < 480) {
    scaleFactor = Math.max(scaleFactor, 480 / Math.max(1, curShort));
  }

  let nw = Math.max(2, Math.round((w * scaleFactor) / 2) * 2);
  let nh = Math.max(2, Math.round((h * scaleFactor) / 2) * 2);

  // Sau khi nâng cạnh nhỏ (nếu có), đảm bảo không vượt trần cạnh dài 2560px và cạnh ngắn 1080px (với Pro/Max > 1088px)
  let downFactor = 1;
  if (Math.max(nw, nh) > MAX_LONG_SIDE) {
    downFactor = Math.min(downFactor, MAX_LONG_SIDE / Math.max(nw, nh));
  }
  if (isPro && Math.min(nw, nh) > 1088) {
    downFactor = Math.min(downFactor, 1080 / Math.min(nw, nh));
  }
  if (downFactor < 1) {
    nw = Math.max(2, Math.floor((nw * downFactor) / 2) * 2);
    nh = Math.max(2, Math.floor((nh * downFactor) / 2) * 2);
  }

  const needsMp4 = ext !== 'mp4' && ext !== 'mov';
  const needsFps = meta.fps > 30.05;
  const needsGeometry = needsPad21x9 || nw !== meta.width || nh !== meta.height;

  if (!needsMp4 && !needsFps && !needsGeometry) {
    return { bytes: data, ext, meta, changed: false };
  }

  const vfParts: string[] = [];
  if (needsFps) vfParts.push('fps=30');
  if (needsPad21x9) {
    // Co vừa khung đích `nw × nh` và đệm viền đen cân tâm để không méo hình khi nguồn vượt 21:9
    vfParts.push(`scale=${nw}:${nh}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${nw}:${nh}:(ow-iw)/2:(oh-ih)/2:black`);
  } else if (nw !== meta.width || nh !== meta.height) {
    vfParts.push(`scale=${nw}:${nh}:flags=lanczos`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'novai-up4k-norm-'));
  const inFile = join(dir, `in.${ext || 'mp4'}`);
  const outFile = join(dir, 'out.mp4');
  try {
    await writeFile(inFile, data);
    const args = ['-y', '-i', inFile];
    if (vfParts.length) {
      args.push('-vf', vfParts.join(','));
    }
    args.push(
      '-t',
      String(Math.round(meta.duration * 1000) / 1000),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outFile,
    );
    await execFileAsync('ffmpeg', args, { timeout: 300_000 });
    const outBytes = await readFile(outFile);
    const newMeta = await probeVideo(outBytes, 'mp4');
    return { bytes: outBytes, ext: 'mp4', meta: newMeta, changed: true };
  } catch {
    throw new AiProviderError(
      'Không chuẩn hoá được định dạng / khung hình video đầu vào (yêu cầu MP4/MOV, ≤ 30 fps). Vui lòng xuất lại MP4 H.264 — tiền đã được hoàn lại',
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function putPresignedSingle(
  uploadUrl: string,
  uploadHeaders: Record<string, unknown> | null | undefined,
  videoBytes: Buffer,
  jobId: string,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Khớp chuẩn `api-client.js` của `up4k@0.4.1`: chỉ dùng đúng `upload_headers` nguồn ký + `Content-Length`, tuyệt đối không đính kèm `Bearer`
    const headers = new Headers();
    if (uploadHeaders && typeof uploadHeaders === 'object') {
      for (const [hk, hv] of Object.entries(uploadHeaders)) {
        if (typeof hv === 'string' && hk.toLowerCase() !== 'authorization') {
          headers.set(hk, hv);
        }
      }
    }
    headers.set('Content-Length', String(videoBytes.length));

    let putRes: Response;
    try {
      putRes = await fetch(uploadUrl, {
        method: 'PUT',
        redirect: 'error',
        headers,
        body: new Uint8Array(videoBytes),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (err) {
      if (attempt + 1 < maxAttempts) {
        await sleepMs(Math.min(5_000, 700 * 2 ** attempt));
        continue;
      }
      throw new AiProviderError(
        'Không tải được video lên máy chủ nâng cấp 4K, hệ thống sẽ thử lại',
        { id: jobId, error: (err as Error).message },
        true,
      );
    }

    if (putRes.ok) {
      await putRes.arrayBuffer().catch(() => undefined);
      return;
    }

    const bodySnippet = (await putRes.text().catch(() => '')).slice(0, 400);
    if ((putRes.status >= 500 || putRes.status === 429) && attempt + 1 < maxAttempts) {
      await sleepMs(Math.min(6_000, 800 * 2 ** attempt));
      continue;
    }

    throw new AiProviderError(
      `Tải video lên kho xử lý 4K thất bại (HTTP ${putRes.status})`,
      { id: jobId, status: putRes.status, body: bodySnippet },
      putRes.status >= 500 || putRes.status === 429,
    );
  }
}

async function putPresignedPart(putUrl: string, chunk: Buffer, partNum: number, totalParts: number): Promise<string> {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let putRes: Response;
    try {
      // Khớp chuẩn `putPart` trong `up4k@0.4.1`: presigned part URL chỉ nhận `Content-Length`, tuyệt đối không gửi `Bearer` hay `Content-Type` lạ
      putRes = await fetch(putUrl, {
        method: 'PUT',
        redirect: 'error',
        headers: { 'Content-Length': String(chunk.byteLength) },
        body: new Uint8Array(chunk),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (attempt + 1 < maxAttempts) {
        await sleepMs(Math.min(6_000, 600 * 2 ** attempt));
        continue;
      }
      throw new AiProviderError(
        'Kết nối gián đoạn khi tải video dài lên máy chủ nâng cấp 4K, hệ thống sẽ thử lại',
        { partNum, error: (err as Error).message },
        true,
      );
    }

    if (!putRes.ok) {
      const errText = (await putRes.text().catch(() => '')).slice(0, 300);
      if ((putRes.status >= 500 || putRes.status === 429) && attempt + 1 < maxAttempts) {
        await sleepMs(Math.min(8_000, 700 * 2 ** attempt));
        continue;
      }
      throw new AiProviderError(
        `Tải phần ${partNum}/${totalParts} lên máy chủ nâng cấp 4K thất bại (HTTP ${putRes.status})`,
        { partNum, status: putRes.status, body: errText },
        putRes.status >= 500 || putRes.status === 429,
      );
    }

    await putRes.arrayBuffer().catch(() => undefined);
    const etag = (putRes.headers.get('etag') || putRes.headers.get('ETag') || '').trim();
    if (!etag) {
      if (attempt + 1 < maxAttempts) {
        await sleepMs(600);
        continue;
      }
      throw new AiProviderError(`Kho lưu trữ không trả ETag cho phần ${partNum}`, { partNum });
    }
    return etag;
  }
  throw new AiProviderError(`Không tải được phần ${partNum}/${totalParts}`, { partNum }, true);
}

async function uploadMultipartLongJob(
  cfg: AiProviderConfig,
  multipartUrl: string,
  videoBytes: Buffer,
  parallel = 4,
): Promise<{ ok?: boolean; state?: string }> {
  const created = await up4kFetch<any>(cfg, multipartUrl, {
    method: 'POST',
    json: { action: 'create' },
    timeoutMs: 30_000,
  });

  const uploadId = str(created?.upload_id);
  if (created?.completed === true && uploadId) {
    return up4kFetch<any>(cfg, multipartUrl, {
      method: 'POST',
      json: { action: 'complete', upload_id: uploadId, parts: [] },
      timeoutMs: 60_000,
    });
  }

  const partSize = Math.max(5 * 1024 * 1024, Number(created?.part_size) || 10 * 1024 * 1024);
  if (!uploadId) throw new AiProviderError('Máy chủ xử lý không khởi tạo được phiên tải video dài', created);

  const totalParts = Math.max(1, Math.ceil(videoBytes.length / partSize));
  const etags = new Map<number, string>();

  try {
    // Ký tối đa 20 parts mỗi lượt (mỗi lệnh create/sign/complete tự động gia hạn bộ đếm 30 phút của phiên upload)
    for (let startPart = 1; startPart <= totalParts; startPart += 20) {
      const batchNums: number[] = [];
      for (let p = startPart; p < startPart + 20 && p <= totalParts; p++) batchNums.push(p);

      const signed = await up4kFetch<any>(cfg, multipartUrl, {
        method: 'POST',
        json: { action: 'sign', upload_id: uploadId, parts: batchNums },
        timeoutMs: 30_000,
      });
      const urls: Record<string, string> = signed?.urls ?? {};

      let cursor = 0;
      let firstErr: unknown = null;
      const worker = async () => {
        while (cursor < batchNums.length && firstErr === null) {
          const partNum = batchNums[cursor++];
          const putUrl = str(urls[String(partNum)]);
          if (!putUrl) {
            firstErr = new AiProviderError(`Thiếu đường dẫn tải phần ${partNum}/${totalParts}`, signed);
            return;
          }
          const offset = (partNum - 1) * partSize;
          const chunk = videoBytes.subarray(offset, Math.min(videoBytes.length, offset + partSize));
          try {
            const etag = await putPresignedPart(putUrl, chunk, partNum, totalParts);
            etags.set(partNum, etag);
          } catch (err) {
            if (firstErr === null) firstErr = err;
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(parallel, batchNums.length) }, () => worker()));
      if (firstErr !== null) throw firstErr;
    }
  } catch (err) {
    // Nếu lỗi không cho thử lại tiếp, chủ động abort phiên upload để giải phóng slot active_count trên nguồn
    if (!(err instanceof AiProviderError && err.retryable)) {
      await up4kFetch(cfg, multipartUrl, {
        method: 'POST',
        json: { action: 'abort', upload_id: uploadId },
        timeoutMs: 10_000,
        attempts: 1,
      }).catch(() => null);
    }
    throw err;
  }

  const completedParts = [...etags.entries()]
    .sort(([a], [b]) => a - b)
    .map(([part, etag]) => ({ part, etag }));

  return up4kFetch<any>(cfg, multipartUrl, {
    method: 'POST',
    json: { action: 'complete', upload_id: uploadId, parts: completedParts },
    timeoutMs: 90_000,
  });
}

async function download4kResult(cfg: AiProviderConfig, jobId: string, downloadPath?: string): Promise<Buffer> {
  const cleanRel = downloadPath && downloadPath.startsWith('/') ? downloadPath : `/api/v1/jobs/${encodeURIComponent(jobId)}/download`;
  const initialUrl = apiUrl(cfg, cleanRel);
  const originHost = (() => {
    try {
      return new URL(siteOrigin(cfg)).hostname.toLowerCase();
    } catch {
      return 'up4k.io';
    }
  })();

  for (let attempt = 0; attempt < 3; attempt++) {
    let currentUrl = initialUrl;
    let res: Response | null = null;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const sameHost = (() => {
          try {
            return new URL(currentUrl).hostname.toLowerCase() === originHost;
          } catch {
            return false;
          }
        })();
        res = await fetch(currentUrl, {
          headers: {
            ...(sameHost ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            'User-Agent': USER_AGENT,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(300_000),
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (loc) {
            currentUrl = new URL(loc, currentUrl).toString();
            continue;
          }
        }
        break;
      }
    } catch (err) {
      if (attempt < 2) {
        await sleepMs(1000 * (attempt + 1));
        continue;
      }
      throw new AiProviderError('Không tải được file kết quả 4K, hệ thống sẽ tự thử lại', { error: (err as Error).message }, true);
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      const retryable = status >= 500 || status === 429 || status === 0;
      if (retryable && attempt < 2) {
        await sleepMs(1500 * (attempt + 1));
        continue;
      }
      throw new AiProviderError(
        retryable
          ? 'Máy chủ lưu trữ 4K tạm bận khi tải kết quả, hệ thống sẽ tự thử lại'
          : 'Kết quả video 4K đã hết hạn hoặc không còn khả dụng — tiền đã được hoàn lại',
        { status, jobId },
        retryable,
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      if (attempt < 2) {
        await sleepMs(1000);
        continue;
      }
      throw new AiProviderError('File kết quả 4K trả về rỗng, hệ thống sẽ tự thử lại', { jobId }, true);
    }
    return buf;
  }

  throw new AiProviderError('Không tải được file kết quả 4K, hệ thống sẽ tự thử lại', { jobId }, true);
}

async function mapJobState(cfg: AiProviderConfig, job: any, id: string): Promise<AiProviderResult> {
  const state = str(job?.state ?? job?.status).toLowerCase();

  if (state === 'done' || state === 'complete' || state === 'completed') {
    const data = await download4kResult(cfg, id, str(job?.download_url));
    return {
      status: 'succeeded',
      providerTaskId: id,
      files: [
        {
          url: '',
          type: 'video',
          name: `${id}-4k.mp4`,
          data,
          mimeType: 'video/mp4',
        },
      ],
      raw: job,
    };
  }

  if (['failed', 'rejected', 'canceled', 'cancelled', 'expired'].includes(state)) {
    const code = str(job?.error?.code ?? job?.reason).toLowerCase();
    const rawMsg =
      typeof job?.error === 'string'
        ? job.error
        : str(job?.error?.message) || pickMessage(job);
    let cleanMsg: string;
    if (state === 'rejected' || /rejected|policy|content|input_rejected/i.test(`${code} ${rawMsg}`)) {
      cleanMsg = 'Video đầu vào bị bộ lọc nội dung từ chối xử lý. Tiền đã được hoàn lại vào ví.';
    } else if (code === 'input_frame_rate_high' || /frame_rate/i.test(code)) {
      cleanMsg = 'Video vượt quá tốc độ khung hình 30 fps cho phép. Tiền đã được hoàn lại vào ví.';
    } else if (state === 'expired') {
      cleanMsg = 'Phiên xử lý quá thời gian chờ nên đơn đã được huỷ, tiền đã được hoàn lại vào ví.';
    } else if (rawMsg) {
      cleanMsg = `${scrubBrand(rawMsg)}. Tiền đã được hoàn lại vào ví.`;
    } else {
      cleanMsg = 'Nâng cấp video 4K không thành công, tiền đã được hoàn lại vào ví.';
    }
    return { status: 'failed', providerTaskId: id, error: cleanMsg, raw: job };
  }

  const progNum = Number(job?.progress);
  const progress =
    Number.isFinite(progNum) && progNum > 0
      ? Math.min(99, Math.max(10, Math.round(progNum)))
      : state === 'running'
        ? 55
        : state === 'claimed'
          ? 28
          : 12;

  return {
    status: 'processing',
    providerTaskId: id,
    progress,
    raw: job,
  };
}

const CATALOG_LABELS: Record<string, string> = {
  '4k-fast': '4K Fast (≤ 35s đồng giá, tối đa 60 phút)',
  'pro-4k': '4K Pro (4.5s/credit, tối đa 5 phút)',
  'pro-4k-max': '4K Max · Trung thực (2.5s/credit, tối đa 5 phút)',
  'pro-4k-max-creative': '4K Max Creative · Sáng tạo (2.5s/credit, tối đa 5 phút)',
};

export const up4kProvider: AiProvider = {
  key: 'up4k',
  name: 'Up4K (up4k.io)',
  website: 'https://up4k.io',
  tools: TOOLS,
  costUnit: 'credit',
  // Mốc an toàn 2.620đ/credit (bằng giá gốc không khuyến mãi của gói mở API nhỏ nhất 199.000đ / 76 credit = 2.618đ -> nạp lại không ưu đãi vẫn không bao giờ hụt vốn)
  rate: 2620,

  async cost(_tool, input, ctx) {
    const engine = resolveEngine(input);
    const videoUrl = str(input.video);
    let sec = typeof input.__sampleSec === 'number' && input.__sampleSec > 0 ? input.__sampleSec : 10;
    if (videoUrl && input.__sample !== true) {
      const probed = await ctx.uploadDuration(videoUrl);
      if (probed !== null && Number.isFinite(probed) && probed > 0) {
        sec = probed;
      } else if (/^https?:\/\//i.test(videoUrl)) {
        // Trường hợp đối tác gọi `POST /api/v1/generations/estimate` truyền `video_url` ngoài chưa tải về kho local
        const hintDur = Number(input.duration);
        sec = Number.isFinite(hintDur) && hintDur > 0 ? hintDur : 10;
      } else {
        throw new BadRequestException('Không đọc được độ dài video, vui lòng tải lên file MP4 / MOV / WEBM hợp lệ');
      }
    }
    return calcUp4kCredits(engine, sec);
  },

  async submit(_tool, input: AiInput, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');

    const requestedEngine = resolveEngine(input);
    const loaded = await loadInputFile(ctx.readUpload, str(input.video));
    const origExt = (loaded.filename.split('.').pop() ?? '').toLowerCase();
    if (!['mp4', 'mov', 'webm'].includes(origExt) && !/^video\/(mp4|quicktime|webm)$/i.test(loaded.mimeType)) {
      throw new AiProviderError('Chỉ hỗ trợ định dạng video MP4, MOV hoặc WEBM — tiền đã được hoàn lại');
    }

    const initialMeta = await probeVideo(loaded.data, origExt || 'mp4').catch(() => {
      throw new AiProviderError('Không đọc được thông tin video đầu vào, vui lòng xuất lại MP4 / MOV hợp lệ — tiền đã được hoàn lại');
    });
    if (!initialMeta.width || !initialMeta.height || initialMeta.duration <= 0) {
      throw new AiProviderError('Không xác định được kích thước hoặc thời lượng video — tiền đã được hoàn lại');
    }

    // Kiểm tra trạng thái tài khoản & engine từ `/api/v1/me` theo chuẩn `up4k@0.4.1` trước khi tốn CPU chuẩn hoá / upload
    const me = await fetchMe(ctx.config).catch(() => null);
    let finalEngine: Up4kEngine = requestedEngine;

    if (me) {
      if (me.access && me.access.unlocked === false) {
        throw new AiProviderError(
          'Cổng nâng cấp 4K đang tạm khoá bảo trì, vui lòng thử lại sau. Tiền đã được hoàn lại.',
          { access: me.access },
          false,
        );
      }

      const dailyLimit = me.api_daily_jobs?.limit;
      const dailyUsed = Number(me.api_daily_jobs?.used ?? 0);
      if (typeof dailyLimit === 'number' && dailyLimit > 0 && dailyUsed >= dailyLimit) {
        throw new AiProviderError(
          'Hệ thống nâng cấp 4K đã đạt hạn mức xử lý trong ngày, vui lòng thử lại sau. Tiền đã được hoàn lại.',
          { api_daily_jobs: me.api_daily_jobs },
          false,
        );
      }

      if (Array.isArray(me.engines)) {
        if (finalEngine === 'pro-4k-max-creative' && !me.engines.includes('pro-4k-max-creative') && me.engines.includes('pro-4k-max')) {
          finalEngine = 'pro-4k-max';
        } else {
          const openOk =
            me.engines.includes(finalEngine) ||
            (finalEngine === 'pro-4k' && me.engines.includes('pro-4k-trial'));
          if (!openOk) {
            throw new AiProviderError(
              'Chế độ nâng cấp 4K này hiện tạm ngưng nhận video mới, vui lòng chọn chế độ khác. Tiền đã được hoàn lại.',
              { finalEngine, engines: me.engines },
              false,
            );
          }
        }
      }

      if (Array.isArray(me.engines_maintenance)) {
        const inMaint =
          me.engines_maintenance.includes(finalEngine) ||
          (finalEngine === 'pro-4k' && me.engines_maintenance.includes('pro-4k-trial'));
        if (inMaint) {
          throw new AiProviderError(
            'Chế độ nâng cấp 4K này đang bảo trì tạm thời, vui lòng chọn chế độ khác hoặc thử lại sau. Tiền đã được hoàn lại.',
            { finalEngine, engines_maintenance: me.engines_maintenance },
            false,
          );
        }
      }

      const activeCount = Number(me.active_count ?? me.limits?.active_count ?? 0);
      const maxActive = Number(me.max_active ?? me.limits?.max_active ?? 50);
      if (maxActive > 0 && activeCount >= maxActive) {
        throw new AiProviderError(
          'Đang chờ luồng xử lý 4K trống, hệ thống sẽ tự gửi ngay trong giây lát',
          { activeCount, maxActive, waitingSlot: true },
          true,
        );
      }
    }

    const shortCap = Number(me?.long_video?.min_seconds ?? me?.max_seconds ?? me?.limits?.max_seconds) || 35;
    const isLongClip = initialMeta.duration > shortCap;
    const defaultEngineMax = finalEngine === '4k-fast' ? 3600 : 300;
    const engineLongCap =
      Number(me?.long_video?.max_seconds?.[finalEngine]) ||
      (finalEngine === 'pro-4k' ? Number(me?.long_video?.max_seconds?.['pro-4k-trial']) : 0) ||
      defaultEngineMax;

    if (isLongClip) {
      if (me && me.long_video?.eligible !== true) {
        throw new AiProviderError(
          `Video dài ${Math.ceil(initialMeta.duration)} giây (hiện chỉ nhận tối đa ${Math.floor(shortCap)} giây mỗi clip). Vui lòng cắt ngắn video — tiền đã được hoàn lại`,
        );
      }
      if (initialMeta.duration > engineLongCap) {
        const labelMax = engineLongCap >= 3600 ? `${Math.round(engineLongCap / 60)} phút` : `${Math.round(engineLongCap / 60)} phút (${engineLongCap}s)`;
        throw new AiProviderError(
          `Video dài ${Math.ceil(initialMeta.duration)} giây, vượt mức tối đa ${labelMax} của chế độ đã chọn — tiền đã được hoàn lại`,
        );
      }
    }

    const norm = await ensureCompatibleMp4(loaded.data, origExt || 'mp4', initialMeta, finalEngine);
    const videoBytes = norm.bytes;
    const ext = norm.ext;
    const meta = norm.meta;
    const baseName = (loaded.filename || `clip.${ext}`).replace(/\.[^.]+$/, '');
    const filename = `${baseName}.${ext}`;

    const isFinalLong = meta.duration > shortCap;
    const maxBytesAllowed = isFinalLong
      ? Number(me?.long_video?.max_upload_bytes) || DEFAULT_LONG_MAX_BYTES
      : MAX_SINGLE_BYTES;
    if (videoBytes.length > maxBytesAllowed) {
      const maxMb = Math.round(maxBytesAllowed / (1024 * 1024));
      throw new AiProviderError(`Dung lượng video vượt quá giới hạn ${maxMb}MB — tiền đã được hoàn lại`);
    }

    const selfLikeness =
      input.selfLikeness === true ||
      input.selfLikeness === 'true' ||
      input.self_likeness === true ||
      input.self_likeness === 'true';
    const sharpness = SHARPNESS_OPTIONS.some((o) => o.value === str(input.sharpness)) ? str(input.sharpness) : 'can-bang';
    const outputFrame = str(input.output_frame) === 'uhd' || input.uhd === true || input.uhd === 'true' ? 'uhd' : 'native';

    // Chuẩn body `CreateJobBody` của `up4k@0.4.1`:
    // - `output_frame`: chỉ gửi `"uhd"` cho `4k-fast` khi bật UHD (mặc định API đã là `"native"`);
    // - `sharpness`: chỉ gửi cho `pro-4k` và `pro-4k-max` (tuyệt đối không gửi cho `4k-fast` & `pro-4k-max-creative`);
    // - `fps`: gửi `avg_frame_rate` thực tế (≤ 30).
    const createBody: Record<string, unknown> = {
      filename,
      size: videoBytes.length,
      duration: Math.round(meta.duration * 1000) / 1000,
      width: meta.width,
      height: meta.height,
      ...(meta.fps > 0 ? { fps: Math.min(30, Math.round(meta.fps * 1000) / 1000) } : {}),
      engine: finalEngine,
      ...(finalEngine === '4k-fast' && outputFrame === 'uhd' ? { output_frame: 'uhd' } : {}),
      ...(finalEngine === 'pro-4k' || finalEngine === 'pro-4k-max' ? { sharpness } : {}),
      consent: selfLikeness ? { selfLikeness: true, selfLikenessConsent: true } : { selfLikeness: false },
    };

    const idempotencyKey = `novai-${randomUUID()}`;
    const job = await up4kFetch<any>(ctx.config, '/jobs', {
      method: 'POST',
      json: createBody,
      headers: { 'Idempotency-Key': idempotencyKey },
      timeoutMs: 60_000,
    });

    const id = str(job?.id);
    if (!id) throw new AiProviderError('Máy chủ nâng cấp 4K không trả mã tác vụ', job);

    // Chốt chặn chống lệch phí tuyệt đối trước khi upload/submit (lúc này nguồn chưa trừ credit):
    // Đối chiếu trực tiếp với đúng thời lượng `uploadDuration` đã dùng lúc báo giá thu tiền khách.
    const billedDuration = (await ctx.uploadDuration(str(input.video)).catch(() => null)) ?? initialMeta.duration;
    const expectedCredits = calcUp4kCredits(requestedEngine, billedDuration);
    const upstreamCharge = Number(job?.charge ?? job?.credits ?? 0);
    if (Number.isFinite(upstreamCharge) && upstreamCharge > expectedCredits + 0.01) {
      await up4kFetch(ctx.config, `/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        timeoutMs: 10_000,
        attempts: 1,
      }).catch(() => null);
      throw new AiProviderError(
        `Thời lượng thực tế của video (${meta.duration.toFixed(1)}s) lệch so với header file (${billedDuration.toFixed(1)}s) — vui lòng xuất lại MP4 chuẩn rồi gửi lại (tiền đã được hoàn lại 100%)`,
        { id, expectedCredits, upstreamCharge },
        false,
      );
    }

    if (job?.kind === 'long' || job?.upload_method === 'multipart') {
      const mpUrl = str(job?.multipart_url) || `/api/v1/jobs/${encodeURIComponent(id)}/multipart`;
      const completed = await uploadMultipartLongJob(ctx.config, mpUrl, videoBytes, 4);
      return mapJobState(ctx.config, { ...job, ...completed }, id);
    }

    const uploadUrl = str(job?.upload_url);
    if (uploadUrl) {
      await putPresignedSingle(uploadUrl, job?.upload_headers, videoBytes, id);
    }

    const submitted = await up4kFetch<any>(ctx.config, `/jobs/${encodeURIComponent(id)}/submit`, {
      method: 'POST',
      timeoutMs: 60_000,
    });

    return mapJobState(ctx.config, { ...job, ...submitted }, id);
  },

  async poll(_tool, id, ctx) {
    const job = await up4kFetch<any>(ctx.config, `/jobs/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
    return mapJobState(ctx.config, job, id);
  },

  async balance(ctx) {
    if (!ctx.config.apiKey) return null;
    const me = await fetchMe(ctx.config, true);
    const mine = Number(me?.credits?.mine ?? 0);
    const free = Number(me?.credits?.free ?? 0);
    const total = Math.round((mine + free) * 100) / 100;
    return Number.isFinite(total) ? { balance: total, unit: 'credit' } : null;
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    if (!ctx.config.apiKey) return [];
    const me = await fetchMe(ctx.config, true);
    const open = (me.engines ?? []).filter((e) => e !== 'pro-4k-trial');
    return open.map((id) => ({ id, label: CATALOG_LABELS[id] ?? id }));
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    try {
      const me = await fetchMe(ctx.config, true);
      if (me.access?.unlocked === false) return 'ALL';
      const maintEngines = new Set((me.engines_maintenance ?? []).map((e) => String(e).toLowerCase()));
      const down = new Set<string>();
      const mf = TOOLS[0]?.fields.find((f) => f.name === 'model' && Array.isArray(f.options));
      const opts = mf?.options ?? [];
      for (const opt of opts) {
        const val = String(opt.value).toLowerCase();
        if (
          maintEngines.has(val) ||
          (val === 'pro-4k' && maintEngines.has('pro-4k-trial')) ||
          (val === 'pro-4k-max' && maintEngines.has('pro-4k-max') && maintEngines.has('pro-4k-max-creative'))
        ) {
          down.add(`video-4k-upscale~${opt.value}`);
        }
      }
      if (opts.length > 0 && down.size === opts.length) down.add('video-4k-upscale');
      return down;
    } catch {
      return null;
    }
  },
};
