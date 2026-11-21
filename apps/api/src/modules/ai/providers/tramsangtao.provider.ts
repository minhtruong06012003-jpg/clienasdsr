import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AiProviderError,
  type AiCallContext,
  type AiCatalogItem,
  type AiFieldDef,
  type AiInput,
  type AiOutputFile,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderResult,
  type AiToolDef,
} from '../ai.types.js';
import { guessType, str } from './http.js';

/**
 * Trạm Sáng Tạo REST API v1 — https://api.tramsangtao.com/v1 (Bearer sk_live_...)
 * - Nguồn bảng giá thực tế cho API key: `GET /v1/models` (`pricing[]` — lưu ý tài liệu mục "Tính tiền khi gọi API":
 *   job tạo qua API tính theo giá gốc `pricing[]`, KHÔNG áp `discount_percent` hiển thị trên giao diện web).
 * - Tỉ giá mặc định: `1 credit = 44.75đ` (khớp gói mở API nhỏ nhất Pro `179.000đ / 4.000 credit = 44,75đ/cr` để nạp gói nào cũng không bao giờ lỗ;
 *   nếu nạp gói Business `41,58đ/cr`, Enterprise `39,96đ/cr` hoặc Enterprise 5X `35,99đ/cr` thì lãi thực tế càng dày hơn, hoặc chỉnh tại tab Khoá API).
 * - Lãi mặc định công cụ: `+22%` so với giá gốc (`markup: 22`).
 */

const DEFAULT_BASE = 'https://api.tramsangtao.com/v1';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime,video/webm';
const AUD_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';

interface TstPricingRow {
  server?: string;
  key?: string;
  config_key?: string;
  credits?: number;
  resolution?: string;
  duration?: string;
  audio?: boolean;
  speed?: string;
}

interface TstModelEntry {
  model: string;
  name?: string;
  type?: string;
  pricing?: TstPricingRow[];
}

interface TstToolDef extends AiToolDef {
  modelId: string;
}

function normalizeBaseUrl(raw?: string): string {
  const trimmed = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE;
  if (/\/v1$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function sanitizeUpstreamText(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/insufficient|không đủ credit|402/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại.';
  }
  if (/rate limit|slot|concurrent|quá tải|busy|429/i.test(s)) {
    return 'Hệ thống tạo video đang kín luồng xử lý tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại.';
  }
  if (/content_policy|eligibility|nsfw|kiểm duyệt|vi phạm|sensitive|policy/i.test(s)) {
    return 'Nội dung mô tả hoặc file tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng đổi ảnh/video hoặc chỉnh lại mô tả rồi thử lại. Tiền đã được hoàn lại.';
  }
  if (/server_unverified|chưa được xác minh|tạm đóng|unavailable|503/i.test(s)) {
    return 'Máy chủ model này đang bảo trì tạm thời, vui lòng thử lại sau hoặc chọn máy chủ khác. Tiền đã được hoàn lại.';
  }
  return s
    .replace(/sk_live_[A-Za-z0-9_-]+/g, '***')
    .replace(/(?:https?:\/\/)?[\w.-]*tramsangtao[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\b(?:trạm\s*sáng\s*tạo|tram\s*sang\s*tao|tramsangtao|higgsfield|dreamina|runway)\b/gi, 'Hệ thống AI')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractApiError(payload: any, status: number): string {
  const detail = payload?.detail;
  if (typeof detail === 'string' && detail.trim()) return sanitizeUpstreamText(detail);
  if (detail && typeof detail === 'object') {
    const errObj = detail.error ?? detail;
    const code = String(errObj?.code ?? '');
    const msg = String(errObj?.message ?? '');
    if (code) return sanitizeUpstreamText(`${code}: ${msg}`);
    if (msg) return sanitizeUpstreamText(msg);
  }
  const msg = payload?.error?.message ?? payload?.error ?? payload?.message;
  if (typeof msg === 'string' && msg.trim()) return sanitizeUpstreamText(msg);
  return sanitizeUpstreamText(`Máy chủ xử lý trả mã HTTP ${status}`);
}

async function tstFetch<T = any>(
  cfg: AiProviderConfig,
  path: string,
  opts: {
    method?: string;
    json?: unknown;
    body?: BodyInit;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  if (!cfg.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey.trim()}`,
    Accept: 'application/json',
    'User-Agent': 'NovAIStudio/1.0',
    ...(opts.headers ?? {}),
  };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    throw new AiProviderError(
      /timeout|abort/i.test(msg)
        ? 'Kết nối tới máy chủ xử lý quá thời gian chờ, vui lòng thử lại'
        : 'Không kết nối được tới máy chủ xử lý AI, vui lòng thử lại sau ít giây',
      { cause: msg },
      true,
    );
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  if (!res.ok) {
    const retryable = res.status >= 500 && res.status !== 503;
    throw new AiProviderError(extractApiError(data, res.status), { status: res.status, data }, retryable);
  }
  return data as T;
}

/** Bộ nhớ đệm 10 phút bảng giá gốc `/v1/models` theo Base URL */
let modelsCache: { at: number; base: string; byModel: Map<string, TstModelEntry> } | null = null;
let modelsInflight: Promise<Map<string, TstModelEntry>> | null = null;

async function getLiveModels(cfg: AiProviderConfig, force = false): Promise<Map<string, TstModelEntry>> {
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!force && modelsCache && modelsCache.base === base && Date.now() - modelsCache.at < 600_000) {
    return modelsCache.byModel;
  }
  if (!cfg.apiKey) return modelsCache?.byModel ?? new Map();
  if (!force && modelsInflight) return modelsInflight;

  modelsInflight = (async () => {
    try {
      const data = await tstFetch<{ models?: TstModelEntry[] }>(cfg, '/models', { timeoutMs: 20_000 });
      const map = new Map<string, TstModelEntry>();
      for (const m of data?.models ?? []) {
        if (m?.model) map.set(m.model, m);
      }
      if (map.size > 0) {
        modelsCache = { at: Date.now(), base, byModel: map };
      }
    } catch {
      // Giữ cache cũ hoặc dùng bảng giá dự phòng bên dưới nếu mạng chập chờn
    } finally {
      modelsInflight = null;
    }
    return modelsCache?.byModel ?? new Map();
  })();

  return modelsInflight;
}

function lookupCredits(
  live: Map<string, TstModelEntry>,
  modelId: string,
  rowKey: string,
  fallback: number,
  server?: string,
): number {
  const entry = live.get(modelId);
  const rows = entry?.pricing ?? [];
  if (rows.length) {
    const exact = rows.find(
      (r) =>
        (!server || r.server === server) &&
        (r.key === rowKey || r.config_key === rowKey) &&
        Number(r.credits) > 0,
    );
    if (exact) return Number(exact.credits);
    const anySrv = rows.find((r) => (r.key === rowKey || r.config_key === rowKey) && Number(r.credits) > 0);
    if (anySrv) return Number(anySrv.credits);
  }
  return fallback;
}

function normalizeRes(raw: unknown, allowed: string[], def: string): string {
  const v = str(raw).toLowerCase();
  return allowed.includes(v) ? v : def;
}

function clampInt(raw: unknown, min: number, max: number, def: number): number {
  const s = str(raw).replace(/s$/i, '').trim();
  if (!s) return def;
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function pickInt(raw: unknown, allowed: number[], def: number): number {
  const s = str(raw).replace(/s$/i, '').trim();
  const n = Math.round(Number(s));
  return allowed.includes(n) ? n : def;
}

function boolVal(raw: unknown, def: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return def;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return def;
}

async function resolveMediaSeconds(
  input: AiInput,
  ctx: AiCallContext,
  fieldName: string,
  sampleDefaultSec: number,
  minSec: number,
  maxSec: number,
  mediaLabel: string,
): Promise<number> {
  if (typeof input.__sampleSec === 'number' && input.__sampleSec > 0) {
    return Math.max(minSec, Math.min(maxSec, input.__sampleSec));
  }
  const url = str(input[fieldName]);
  if (!url || input.__sample === true) {
    return sampleDefaultSec;
  }
  const probed = await ctx.uploadDuration(url);
  if (probed !== null && Number.isFinite(probed) && probed > 0) {
    if (probed < minSec - 0.25) {
      throw new BadRequestException(`${mediaLabel} quá ngắn (${probed.toFixed(1)}s) — yêu cầu tối thiểu ${minSec} giây`);
    }
    if (probed > maxSec + 0.4) {
      throw new BadRequestException(`${mediaLabel} dài ${probed.toFixed(1)}s — vượt quá giới hạn tối đa ${Math.floor(maxSec)} giây`);
    }
    return Math.max(minSec, probed);
  }
  if (/^https?:\/\//i.test(url)) {
    const hint = Number(input.duration);
    if (Number.isFinite(hint) && hint > 0) return Math.max(minSec, Math.min(maxSec, hint));
    return sampleDefaultSec;
  }
  throw new BadRequestException(`Không đọc được thời lượng ${mediaLabel.toLowerCase()}, vui lòng tải lên file hợp lệ`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadMediaBuffer(
  ctx: AiCallContext,
  url: string,
  fallbackExt: string,
  fallbackMime: string,
): Promise<{ data: Buffer; mimeType: string; filename: string }> {
  const local = await ctx.readUpload(url);
  if (local) return local;
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!res || !res.ok) {
      throw new AiProviderError('Không tải được file đầu vào từ đường dẫn cung cấp — tiền đã được hoàn lại');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMime;
    const rawName = url.split('?')[0].split('/').pop() || `input.${fallbackExt}`;
    const filename = /\.[a-z0-9]{2,5}$/i.test(rawName) ? rawName : `input.${fallbackExt}`;
    return { data: buf, mimeType: mime, filename };
  }
  throw new AiProviderError('Không đọc được file đầu vào đã tải lên — vui lòng tải lại file');
}

async function uploadToTst(
  ctx: AiCallContext,
  rawUrl: string,
  kind: 'image' | 'video' | 'audio',
): Promise<{ url: string; fileId?: string; audioId?: string }> {
  const ext = kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'mp3';
  const mime = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  const file = await loadMediaBuffer(ctx, rawUrl, ext, mime);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType || mime }), file.filename);

  const init = await tstFetch<any>(ctx.config, `/files/upload/${kind}`, {
    method: 'POST',
    body: form,
    timeoutMs: 120_000,
  });

  const directUrl = str(init?.r2_url || init?.url || init?.audio_url);
  const directAudioId = str(init?.audio_id);
  const directId = str(init?.file_id || init?.id);
  const uploadId = str(init?.upload_id);
  const initStatus = str(init?.status).toLowerCase();

  if (directUrl && (kind !== 'audio' || directAudioId || initStatus === 'completed' || initStatus === 'ready')) {
    return { url: directUrl, fileId: directId || undefined, audioId: directAudioId || undefined };
  }

  if (uploadId) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(2_000);
      const st = await tstFetch<any>(ctx.config, `/files/upload/${encodeURIComponent(uploadId)}/status`, {
        timeoutMs: 20_000,
      });
      const status = str(st?.status).toLowerCase();
      if (status === 'completed' || status === 'ready' || status === 'succeeded') {
        const finalUrl = str(st?.r2_url || st?.url || st?.audio_url || directUrl);
        const finalAudioId = str(st?.audio_id || directAudioId);
        if (!finalUrl) break;
        return {
          url: finalUrl,
          fileId: str(st?.file_id || st?.id || directId) || undefined,
          audioId: finalAudioId || undefined,
        };
      }
      if (status === 'failed' || status === 'error') {
        throw new AiProviderError(
          sanitizeUpstreamText(st?.error || st?.message || 'Xử lý file đầu vào thất bại, vui lòng đổi file khác'),
          st,
        );
      }
    }
  }

  if (directUrl) {
    return { url: directUrl, fileId: directId || undefined, audioId: directAudioId || undefined };
  }
  throw new AiProviderError('Không tải được file đầu vào lên máy chủ xử lý — tiền đã được hoàn lại', init);
}

function collectImageInputs(input: AiInput): string[] {
  const out: string[] = [];
  if (Array.isArray(input.images)) {
    for (const item of input.images) {
      const u = str(item);
      if (u) out.push(u);
    }
  } else if (str(input.images)) {
    out.push(str(input.images));
  }
  for (const k of ['image', 'start_image', 'end_image']) {
    const u = str(input[k]);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function durationSelectOptions(min: number, max: number): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  for (let s = min; s <= max; s++) {
    opts.push({ value: String(s), label: `${s} giây` });
  }
  return opts;
}

const ASPECT_STD: { value: string; label: string }[] = [
  { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
  { value: '16:9', label: '16:9 (Ngang · YouTube)' },
  { value: '1:1', label: '1:1 (Vuông)' },
];

const ASPECT_WIDE: { value: string; label: string }[] = [
  { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
  { value: '16:9', label: '16:9 (Ngang · YouTube)' },
  { value: '1:1', label: '1:1 (Vuông)' },
  { value: '4:3', label: '4:3 (Cổ điển)' },
  { value: '3:4', label: '3:4 (Chân dung)' },
  { value: '21:9', label: '21:9 (Điện ảnh)' },
];

const BASE_PRICING = { mode: 'cost' as const, markup: 22 };

const TOOLS: TstToolDef[] = [
  // ================= 7 SẢN PHẨM TỐI ƯU (BẬT MẶC ĐỊNH) =================
  {
    key: 'kling-avatar',
    modelId: 'kling-avatar',
    name: 'Kling Avatar 2.0 (Nhân vật nói theo giọng đọc)',
    category: 'video',
    icon: 'user-round-check',
    badge: 'SV12',
    description: 'Biến 1 ảnh chân dung + file giọng đọc thành video nhân vật nói chuyện, nhép môi & biểu cảm tự nhiên (720p / 1080p, tính theo giây âm thanh, tối đa 120s).',
    output: 'video',
    unitLabel: 'giây',
    costPerUnit: 15,
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'image',
        label: 'Ảnh khuôn mặt nhân vật',
        type: 'image',
        required: true,
        accept: IMG_ACCEPT,
        help: 'Ảnh rõ mặt chính diện hoặc góc nghiêng nhẹ (JPG, PNG, WEBP)',
      },
      {
        name: 'audio',
        label: 'File giọng nói / lời thoại (Tối đa 120 giây)',
        type: 'audio',
        required: true,
        accept: AUD_ACCEPT,
        help: 'Tải lên file MP3, WAV hoặc M4A — thời lượng video tự khớp đúng độ dài file âm thanh',
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p (Tiết kiệm)' },
          { value: '1080p', label: 'Full HD 1080p (Sắc nét)' },
        ],
      },
      {
        name: 'aspect_ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: ASPECT_STD,
      },
      {
        name: 'prompt',
        label: 'Mô tả biểu cảm / cử chỉ (Tuỳ chọn)',
        type: 'textarea',
        required: false,
        max: 20_000,
        placeholder: 'Ví dụ: Nhân vật mỉm cười tự nhiên, gật đầu nhẹ theo nhịp nói, ánh sáng studio...',
      },
    ],
  },
  {
    key: 'kling-2.5-turbo',
    modelId: 'kling-2.5-turbo',
    name: 'Tạo video Kling 2.5 Turbo (Siêu tốc · Tiết kiệm)',
    category: 'video',
    icon: 'zap',
    badge: 'SV12',
    description: 'Tạo video từ văn bản hoặc ảnh đầu vào bằng Kling 2.5 Turbo tốc độ cao, chuyển động mượt, chi phí cực rẻ (5s / 10s, HD 720p & Full HD 1080p).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả chuyển động / Kịch bản (Prompt)',
        type: 'textarea',
        required: true,
        max: 20_000,
        placeholder: 'Mô tả chi tiết cảnh quay, hành động nhân vật, góc máy...',
      },
      {
        name: 'image',
        label: 'Ảnh bắt đầu (Tuỳ chọn — bỏ trống nếu tạo từ văn bản)',
        type: 'image',
        required: false,
        accept: IMG_ACCEPT,
        help: 'Tải 1 ảnh để chuyển ảnh thành video (I2V), hoặc để trống để tạo từ văn bản (T2V)',
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p (Siêu rẻ)' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        required: true,
        default: '5',
        options: [
          { value: '5', label: '5 giây' },
          { value: '10', label: '10 giây' },
        ],
      },
      {
        name: 'aspect_ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: ASPECT_STD,
      },
    ],
  },
  {
    key: 'wan-3.0',
    modelId: 'wan-3.0',
    name: 'Tạo video Wan 3.0 (Có âm thanh · Tới 30s)',
    category: 'video',
    icon: 'film',
    badge: 'SV12',
    description: 'Tạo video Wan 3.0 thế hệ mới dài từ 2–30 giây kèm âm thanh gốc sống động, hỗ trợ tạo từ văn bản, ảnh tham chiếu hoặc cặp Khung đầu – Khung cuối (480p / 720p / 1080p).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả nội dung & âm thanh (Prompt)',
        type: 'textarea',
        required: true,
        max: 20_000,
        placeholder: 'Mô tả chi tiết bối cảnh, chuyển động nhân vật, lời thoại hoặc hiệu ứng âm thanh...',
      },
      {
        name: 'image_mode',
        label: 'Chế độ ảnh đầu vào',
        type: 'select',
        required: true,
        default: 'references',
        options: [
          { value: 'references', label: 'Văn bản / Ảnh tham chiếu nhân vật (0–2 ảnh)' },
          { value: 'frames', label: 'Khung hình đầu & Khung hình cuối' },
        ],
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 2 ảnh)',
        type: 'image',
        required: false,
        multiple: true,
        maxFiles: 2,
        accept: IMG_ACCEPT,
        showIf: { field: 'image_mode', in: ['references'] },
        help: 'Bỏ trống để tạo từ văn bản (T2V), hoặc tải 1–2 ảnh tham chiếu nhân vật/bối cảnh',
      },
      {
        name: 'start_image',
        label: 'Ảnh khung đầu (Start Frame)',
        type: 'image',
        required: false,
        accept: IMG_ACCEPT,
        showIf: { field: 'image_mode', in: ['frames'] },
      },
      {
        name: 'end_image',
        label: 'Ảnh khung cuối (End Frame — Tuỳ chọn)',
        type: 'image',
        required: false,
        accept: IMG_ACCEPT,
        showIf: { field: 'image_mode', in: ['frames'] },
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '480p',
        options: [
          { value: '480p', label: 'SD 480p (Siêu tiết kiệm)' },
          { value: '720p', label: 'HD 720p' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      {
        name: 'duration',
        label: 'Thời lượng video',
        type: 'select',
        required: true,
        default: '5',
        options: durationSelectOptions(2, 30),
      },
      {
        name: 'aspect_ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: [
          { value: '9:16', label: '9:16 (Dọc · TikTok / Reels)' },
          { value: '16:9', label: '16:9 (Ngang · YouTube)' },
          { value: '1:1', label: '1:1 (Vuông)' },
          { value: '4:3', label: '4:3' },
          { value: '3:4', label: '3:4' },
        ],
        showIf: { field: 'image_mode', in: ['references'] },
      },
      {
        name: 'audio',
        label: 'Tự động tạo âm thanh đồng bộ',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  {
    key: 'seedance-2.0-mini',
    modelId: 'seedance-2.0-mini',
    name: 'Seedance 2.0 Mini (Có âm thanh · 4s–15s)',
    category: 'video',
    icon: 'sparkles',
    badge: 'SV12',
    description: 'Phiên bản tiết kiệm nhất dòng Seedance 2.0: tạo video từ văn bản hoặc đa tham chiếu (ảnh + video + âm thanh), tự sinh âm thanh đồng bộ, chọn lẻ từng giây từ 4–15s.',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Có thể gọi <<<image_1>>>, <<<video_1>>>, <<<audio_1>>>)',
        type: 'textarea',
        required: true,
        max: 20_000,
        placeholder: 'Mô tả cảnh quay, chuyển động, âm thanh...',
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 5 ảnh)',
        type: 'image',
        required: false,
        multiple: true,
        maxFiles: 5,
        accept: IMG_ACCEPT,
        help: 'Tải 1–5 ảnh tham chiếu nhân vật/sản phẩm, hoặc để trống để tạo từ văn bản',
      },
      {
        name: 'video',
        label: 'Video tham chiếu chuyển động (Tuỳ chọn, ≤ 10s)',
        type: 'video',
        required: false,
        accept: VID_ACCEPT,
      },
      {
        name: 'ref_audio',
        label: 'Âm thanh tham chiếu (Tuỳ chọn, MP3/WAV)',
        type: 'audio',
        required: false,
        accept: AUD_ACCEPT,
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '480p',
        options: [
          { value: '480p', label: 'SD 480p (Rẻ nhất)' },
          { value: '720p', label: 'HD 720p' },
        ],
      },
      {
        name: 'duration',
        label: 'Thời lượng video',
        type: 'select',
        required: true,
        default: '5',
        options: durationSelectOptions(4, 15),
      },
      {
        name: 'aspect_ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: ASPECT_WIDE,
      },
      {
        name: 'audio',
        label: 'Tự động tạo âm thanh cho video',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  {
    key: 'seedance-2.0-fast',
    modelId: 'seedance-2.0-fast',
    name: 'Seedance 2.0 Fast (Đa tham chiếu · Có âm thanh)',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV12',
    description: 'Seedance 2.0 Fast tốc độ cao: hỗ trợ tới 5 ảnh tham chiếu + 1 video mẫu + 1 âm thanh mẫu, tự sinh tiếng sống động (5s / 8s / 10s / 15s, 480p & 720p).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Có thể gọi <<<image_1>>>, <<<video_1>>>, <<<audio_1>>>)',
        type: 'textarea',
        required: true,
        max: 20_000,
        placeholder: 'Mô tả hành động của <<<image_1>>>, bối cảnh, góc máy...',
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu nhân vật / bối cảnh (1–5 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 5,
        accept: IMG_ACCEPT,
        help: 'Cần ít nhất 1 ảnh tham chiếu (JPG, PNG, WEBP — tối đa 5 ảnh)',
      },
      {
        name: 'video',
        label: 'Video tham chiếu (Tuỳ chọn, ≤ 10s)',
        type: 'video',
        required: false,
        accept: VID_ACCEPT,
      },
      {
        name: 'ref_audio',
        label: 'Âm thanh tham chiếu (Tuỳ chọn, MP3/WAV)',
        type: 'audio',
        required: false,
        accept: AUD_ACCEPT,
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '480p',
        options: [
          { value: '480p', label: 'SD 480p (Tiết kiệm)' },
          { value: '720p', label: 'HD 720p' },
        ],
      },
      {
        name: 'duration',
        label: 'Thời lượng video',
        type: 'select',
        required: true,
        default: '5',
        options: [
          { value: '5', label: '5 giây' },
          { value: '8', label: '8 giây' },
          { value: '10', label: '10 giây' },
          { value: '15', label: '15 giây' },
        ],
      },
      {
        name: 'aspect_ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: ASPECT_WIDE,
      },
      {
        name: 'audio',
        label: 'Tự động tạo âm thanh cho video',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  {
    key: 'motion-control-2.6',
    modelId: 'motion-control-2.6',
    name: 'Motion Control 2.6 (720p / 1080p · Tính theo giây tới 30s)',
    category: 'video',
    icon: 'person-standing',
    badge: 'SV12',
    description: 'Sao chép chuyển động mượt mà từ video mẫu (3s–30s) sang ảnh nhân vật, hỗ trợ cả HD 720p & Full HD 1080p, chỉ tính phí đúng theo số giây của video mẫu.',
    output: 'video',
    unitLabel: 'giây',
    costPerUnit: 10,
    pairs: { fields: ['image', 'video'], max: 5, linkField: 'video' },
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'image',
        label: 'Ảnh nhân vật mục tiêu',
        type: 'image',
        required: true,
        accept: IMG_ACCEPT,
        help: 'Ảnh rõ mặt & dáng nhân vật (JPG, PNG, WEBP)',
      },
      {
        name: 'video',
        label: 'Video chuyển động mẫu (3 – 30 giây)',
        type: 'video',
        required: true,
        accept: VID_ACCEPT,
        help: 'Video nhảy múa / hành động mẫu từ 3s đến tối đa 30s (MP4, MOV, WEBM)',
      },
      {
        name: 'resolution',
        label: 'Chất lượng đầu ra',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p (Tiêu chuẩn)' },
          { value: '1080p', label: 'Full HD 1080p (Sắc nét)' },
        ],
      },
      {
        name: 'prompt',
        label: 'Ghi chú mô tả thêm (Tuỳ chọn)',
        type: 'text',
        required: false,
        max: 1000,
        placeholder: 'Bỏ trống hoặc mô tả ngắn trang phục / biểu cảm...',
      },
    ],
  },
  {
    key: 'motion-control-3.0',
    modelId: 'motion-control-3.0',
    name: 'Motion Control 3.0 (720p / 1080p · Tính theo giây tới 30s)',
    category: 'video',
    icon: 'person-standing',
    badge: 'SV12',
    description: 'Motion Control 3.0 thế hệ mới giữ chi tiết khuôn mặt, bàn tay & chuyển động phức tạp cực chuẩn (3s–30s, HD 720p & Full HD 1080p, tính đúng theo giây).',
    output: 'video',
    unitLabel: 'giây',
    costPerUnit: 15,
    pairs: { fields: ['image', 'video'], max: 5, linkField: 'video' },
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'image',
        label: 'Ảnh nhân vật mục tiêu',
        type: 'image',
        required: true,
        accept: IMG_ACCEPT,
        help: 'Ảnh rõ mặt & dáng nhân vật (JPG, PNG, WEBP)',
      },
      {
        name: 'video',
        label: 'Video chuyển động mẫu (3 – 30 giây)',
        type: 'video',
        required: true,
        accept: VID_ACCEPT,
        help: 'Video nhảy múa / hành động mẫu từ 3s đến tối đa 30s (MP4, MOV, WEBM)',
      },
      {
        name: 'resolution',
        label: 'Chất lượng đầu ra',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p (Tiêu chuẩn)' },
          { value: '1080p', label: 'Full HD 1080p (Sắc nét)' },
        ],
      },
      {
        name: 'prompt',
        label: 'Ghi chú mô tả thêm (Tuỳ chọn)',
        type: 'text',
        required: false,
        max: 1000,
        placeholder: 'Bỏ trống hoặc mô tả ngắn trang phục / biểu cảm...',
      },
    ],
  },

  // ================= CÁC SẢN PHẨM DỰ PHÒNG / GIÁ CAO HƠN (TẮT MẶC ĐỊNH, ADMIN KIỂM TRA BẬT SAU) =================
  {
    key: 'seedance-2.0',
    modelId: 'seedance-2.0',
    name: 'Seedance 2.0 Chuẩn (Tới Full HD 1080p · 15s)',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV12',
    description: 'Seedance 2.0 bản chất lượng cao hỗ trợ tới Full HD 1080p, đa tham chiếu 5 ảnh + video + âm thanh (5s / 8s / 10s / 15s).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000 },
      { name: 'images', label: 'Ảnh tham chiếu (1–5 ảnh)', type: 'image', required: true, multiple: true, maxFiles: 5, accept: IMG_ACCEPT },
      { name: 'video', label: 'Video tham chiếu (Tuỳ chọn, ≤ 10s)', type: 'video', required: false, accept: VID_ACCEPT },
      { name: 'ref_audio', label: 'Âm thanh tham chiếu (Tuỳ chọn)', type: 'audio', required: false, accept: AUD_ACCEPT },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '480p', label: 'SD 480p' },
          { value: '720p', label: 'HD 720p' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      {
        name: 'duration',
        label: 'Thời lượng video',
        type: 'select',
        required: true,
        default: '5',
        options: [
          { value: '5', label: '5 giây' },
          { value: '8', label: '8 giây' },
          { value: '10', label: '10 giây' },
          { value: '15', label: '15 giây' },
        ],
      },
      { name: 'aspect_ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: ASPECT_WIDE },
      { name: 'audio', label: 'Tự động tạo âm thanh', type: 'boolean', required: false, default: true },
    ],
  },
  {
    key: 'seedance-2.5',
    modelId: 'seedance-2.5',
    name: 'Seedance 2.5 (Tới 30s · Full HD 1080p · Có tiếng)',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV12',
    description: 'Seedance 2.5 cao cấp tạo từ văn bản hoặc tới 10 ảnh tham chiếu, thời lượng 4–30 giây kèm âm thanh điện ảnh.',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000 },
      { name: 'images', label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 10 ảnh)', type: 'image', required: false, multiple: true, maxFiles: 10, accept: IMG_ACCEPT },
      { name: 'video', label: 'Video tham chiếu (Tuỳ chọn — cộng thêm số giây video mẫu vào phí)', type: 'video', required: false, accept: VID_ACCEPT },
      { name: 'ref_audio', label: 'Âm thanh tham chiếu (Tuỳ chọn)', type: 'audio', required: false, accept: AUD_ACCEPT },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '480p', label: 'SD 480p' },
          { value: '720p', label: 'HD 720p' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      { name: 'duration', label: 'Thời lượng video', type: 'select', required: true, default: '5', options: durationSelectOptions(4, 30) },
      { name: 'aspect_ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: ASPECT_WIDE },
      { name: 'audio', label: 'Tự động tạo âm thanh', type: 'boolean', required: false, default: true },
    ],
  },
  {
    key: 'topaz-upscale',
    modelId: 'topaz-upscale',
    name: 'Nâng cấp Video 4K Topaz (Tối đa 40s)',
    category: 'video',
    icon: 'wand-sparkles',
    badge: 'SV12',
    description: 'Tăng độ sắc nét video lên chuẩn 4K bằng Topaz AI giữ nguyên 100% nội dung gốc (tối đa 40 giây, tính theo giây).',
    output: 'video',
    unitLabel: 'giây',
    costPerUnit: 14,
    pricing: BASE_PRICING,
    fields: [
      {
        name: 'video',
        label: 'Video cần nâng cấp 4K (Tối đa 40 giây)',
        type: 'video',
        required: true,
        accept: VID_ACCEPT,
      },
    ],
  },
  {
    key: 'kling-3.0-omni',
    modelId: 'kling-3.0-omni',
    name: 'Kling 3.0 Omni (Đa tham chiếu & Biến đổi video · 3s–15s)',
    category: 'video',
    icon: 'film',
    badge: 'SV12',
    description: 'Tạo video từ văn bản, tới 7 ảnh tham chiếu hoặc biến đổi video gốc kèm âm thanh (720p / 1080p, 3–15s).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000 },
      { name: 'images', label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 4 ảnh)', type: 'image', required: false, multiple: true, maxFiles: 4, accept: IMG_ACCEPT },
      { name: 'video', label: 'Video gốc biến đổi (Tuỳ chọn)', type: 'video', required: false, accept: VID_ACCEPT },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: durationSelectOptions(3, 15) },
      { name: 'aspect_ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: ASPECT_STD },
      { name: 'audio', label: 'Âm thanh tự nhiên', type: 'boolean', required: false, default: true },
    ],
  },
  {
    key: 'kling-4.0-video',
    modelId: 'kling-4.0-video',
    name: 'Kling 4.0 Video (Tới 30s · 1080p · Có âm thanh)',
    category: 'video',
    icon: 'film',
    badge: 'SV12',
    description: 'Kling 4.0 hỗ trợ tới 10 ảnh tham chiếu, khung đầu – cuối hoặc video tham chiếu, dài từ 3–30 giây kèm âm thanh.',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000 },
      { name: 'images', label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 10 ảnh)', type: 'image', required: false, multiple: true, maxFiles: 10, accept: IMG_ACCEPT },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: [
          { value: '720p', label: 'HD 720p' },
          { value: '1080p', label: 'Full HD 1080p' },
        ],
      },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: durationSelectOptions(3, 30) },
      { name: 'aspect_ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: ASPECT_STD },
      { name: 'audio', label: 'Âm thanh đồng bộ', type: 'boolean', required: false, default: true },
    ],
  },
  {
    key: 'minimax-hailuo-3.0',
    modelId: 'minimax-hailuo-3.0',
    name: 'MiniMax Hailuo 3.0 (768p / 2K · 5s–15s)',
    category: 'video',
    icon: 'film',
    badge: 'SV12',
    description: 'MiniMax H3 độ nét 768p & 2K sắc nét, hỗ trợ ảnh tham chiếu hoặc cặp Khung đầu – Khung cuối (5–15 giây).',
    output: 'video',
    copies: 4,
    pricing: BASE_PRICING,
    fields: [
      { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000 },
      { name: 'images', label: 'Ảnh tham chiếu (Tuỳ chọn, tối đa 2 ảnh)', type: 'image', required: false, multiple: true, maxFiles: 2, accept: IMG_ACCEPT },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '768p',
        options: [
          { value: '768p', label: 'HD+ 768p' },
          { value: '2k', label: '2K QHD' },
        ],
      },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '6', options: durationSelectOptions(5, 15) },
      { name: 'aspect_ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: ASPECT_WIDE },
    ],
  },
];

function extractJobFiles(job: any, fallbackType: 'video' | 'image' | 'audio'): AiOutputFile[] {
  const candidates: string[] = [];
  const pushUrl = (v: unknown) => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) {
      candidates.push(v.trim());
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const k of ['url', 'video_url', 'image_url', 'audio_url', 'output_url', 'download_url']) {
        if (typeof obj[k] === 'string' && /^https?:\/\//i.test(String(obj[k]).trim())) {
          candidates.push(String(obj[k]).trim());
        }
      }
    }
  };
  if (Array.isArray(job?.outputs)) job.outputs.forEach(pushUrl);
  if (Array.isArray(job?.results)) job.results.forEach(pushUrl);
  for (const k of ['result', 'output_url', 'video_url', 'image_url', 'audio_url', 'url']) {
    pushUrl(job?.[k]);
  }
  const unique = [...new Set(candidates)];
  return unique.map((url) => ({ url, type: guessType(url, fallbackType) }));
}

function mapJobToResult(job: any, tool: AiToolDef, fallbackId?: string): AiProviderResult {
  const id = str(job?.job_id || job?.id || fallbackId);
  const status = str(job?.status).toLowerCase();
  const fallbackType: 'video' | 'image' | 'audio' =
    tool.output === 'image' ? 'image' : tool.output === 'audio' ? 'audio' : 'video';

  if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
    const files = extractJobFiles(job, fallbackType);
    if (!files.length) {
      return {
        status: 'failed',
        providerTaskId: id,
        error: 'Máy chủ xử lý không trả về file kết quả — tiền đã được hoàn lại',
        raw: job,
      };
    }
    return { status: 'succeeded', providerTaskId: id, progress: 100, files, raw: job };
  }

  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
    const rawErr = job?.error_message || job?.error || job?.detail || job?.message;
    return {
      status: 'failed',
      providerTaskId: id,
      error: sanitizeUpstreamText(rawErr) || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại',
      raw: job,
    };
  }

  const prog = Number(job?.progress);
  return {
    status: 'processing',
    providerTaskId: id,
    progress: Number.isFinite(prog) && prog > 0 ? Math.min(99, Math.round(prog)) : undefined,
    raw: job,
  };
}

export const tramsangtaoProvider: AiProvider = {
  key: 'tramsangtao',
  name: 'Trạm Sáng Tạo (tramsangtao.com)',
  website: 'https://tramsangtao.com',
  tools: TOOLS,
  costUnit: 'credit',
  // Mốc gốc không khuyến mãi 49,5đ/credit (khớp gói Starter 99.000đ / 2.000 credit = 49,5đ/cr — T-389/T-390)
  rate: 49.5,

  async cost(tool, input, ctx) {
    const t = tool as TstToolDef;
    const live = await getLiveModels(ctx.config, Boolean(input.__fresh));

    switch (t.modelId) {
      case 'kling-avatar': {
        const q = normalizeRes(input.quality, ['720p', '1080p'], '720p');
        const perSec = lookupCredits(live, 'kling-avatar', `${q}-per-s`, q === '1080p' ? 25 : 15, 'vip2');
        const sec = await resolveMediaSeconds(input, ctx, 'audio', 5, 1, 120, 'File âm thanh');
        return Math.max(1, Math.ceil(sec)) * perSec;
      }

      case 'kling-2.5-turbo': {
        const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
        const dur = str(input.duration).replace(/s$/i, '') === '10' ? '10' : '5';
        const srv = res === '1080p' ? 'vip1' : 'fast';
        const fallback = res === '1080p' ? (dur === '10' ? 150 : 80) : dur === '10' ? 50 : 30;
        return lookupCredits(live, 'kling-2.5-turbo', `${res}-${dur}s-fast`, fallback, srv);
      }

      case 'wan-3.0': {
        const res = normalizeRes(input.resolution, ['480p', '720p', '1080p'], '480p');
        const dur = clampInt(input.duration, 2, 30, 5);
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '1080p' ? 60 : res === '720p' ? 30 : audio ? 16 : 14;
        return lookupCredits(live, 'wan-3.0', key, fb, 'vip3') * dur;
      }

      case 'seedance-2.0-mini': {
        const res = normalizeRes(input.resolution, ['480p', '720p'], '480p');
        const dur = clampInt(input.duration, 4, 15, 5);
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '720p' ? 30 : 22;
        return lookupCredits(live, 'seedance-2.0-mini', key, fb, 'vip3') * dur;
      }

      case 'seedance-2.0-fast': {
        const res = normalizeRes(input.resolution, ['480p', '720p'], '480p');
        const dur = pickInt(input.duration, [5, 8, 10, 15], 5);
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '720p' ? 50 : 25;
        return lookupCredits(live, 'seedance-2.0-fast', key, fb, 'vip3') * dur;
      }

      case 'seedance-2.0': {
        const res = normalizeRes(input.resolution, ['480p', '720p', '1080p'], '720p');
        const dur = pickInt(input.duration, [5, 8, 10, 15], 5);
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '1080p' ? 120 : res === '720p' ? 60 : 45;
        return lookupCredits(live, 'seedance-2.0', key, fb, 'vip3') * dur;
      }

      case 'seedance-2.5': {
        const res = normalizeRes(input.resolution, ['480p', '720p', '1080p'], '720p');
        const dur = clampInt(input.duration, 4, 30, 5);
        const audio = boolVal(input.audio, true);
        let extraRefSec = 0;
        if (str(input.video) && input.__sample !== true) {
          const vSec = await ctx.uploadDuration(str(input.video));
          if (vSec !== null && Number.isFinite(vSec) && vSec > 0) {
            extraRefSec = Math.min(15, Math.ceil(vSec));
          }
        }
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '1080p' ? 250 : res === '720p' ? 120 : 60;
        return lookupCredits(live, 'seedance-2.5', key, fb, 'vip3') * (dur + extraRefSec);
      }

      case 'motion-control-2.6':
      case 'motion-control-3.0': {
        const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
        const fb =
          t.modelId === 'motion-control-3.0'
            ? res === '1080p'
              ? 22
              : 15
            : res === '1080p'
              ? 18
              : 10;
        const perSec = lookupCredits(live, t.modelId, res, fb, 'vip2');
        const sec = await resolveMediaSeconds(input, ctx, 'video', 5, 3, 30, 'Video chuyển động mẫu');
        return Math.ceil(sec) * perSec;
      }

      case 'topaz-upscale': {
        const perSec = lookupCredits(live, 'topaz-upscale', '4k-per-s', 14, 'vip3');
        const sec = await resolveMediaSeconds(input, ctx, 'video', 10, 1, 40, 'Video đầu vào');
        return Math.max(1, Math.ceil(sec)) * perSec;
      }

      case 'kling-3.0-omni': {
        const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
        const dur = clampInt(input.duration, 3, 15, 5);
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '1080p' ? (audio ? 45 : 30) : audio ? 36 : 24;
        return lookupCredits(live, 'kling-3.0-omni', key, fb, 'vip1') * dur;
      }

      case 'kling-4.0-video': {
        const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
        let sec = clampInt(input.duration, 3, 30, 5);
        if (str(input.video) && input.__sample !== true) {
          const vSec = await resolveMediaSeconds(input, ctx, 'video', sec, 3, 30, 'Video tham chiếu');
          sec = Math.max(3, Math.ceil(vSec));
        }
        const audio = boolVal(input.audio, true);
        const key = `${res}${audio ? '-audio' : ''}-per-s`;
        const fb = res === '1080p' ? 72 : 36;
        return lookupCredits(live, 'kling-4.0-video', key, fb, 'vip1') * sec;
      }

      case 'minimax-hailuo-3.0': {
        const res = normalizeRes(input.resolution, ['768p', '2k'], '768p');
        const dur = clampInt(input.duration, 5, 15, 6);
        const fb = res === '2k' ? 50 : 35;
        return lookupCredits(live, 'minimax-hailuo-3.0', `${res}-per-s`, fb, 'vip3') * dur;
      }

      default:
        return null;
    }
  },

  async submit(tool, input: AiInput, ctx) {
    const t = tool as TstToolDef;
    const idemKey = `novai-${t.modelId}-${randomUUID()}`;

    if (t.modelId === 'kling-avatar') {
      const [imgUp, audUp] = await Promise.all([
        uploadToTst(ctx, str(input.image), 'image'),
        uploadToTst(ctx, str(input.audio), 'audio'),
      ]);
      if (!audUp.audioId) {
        throw new AiProviderError('Không khởi tạo được mã giọng đọc từ file âm thanh, vui lòng thử lại bằng file MP3/WAV chuẩn');
      }
      const quality = normalizeRes(input.quality, ['720p', '1080p'], '720p');
      const payload: Record<string, unknown> = {
        model: 'kling-avatar',
        server_id: 'vip2',
        image_url: imgUp.url,
        audio_url: audUp.url,
        audio_id: audUp.audioId,
        quality,
        aspect_ratio: str(input.aspect_ratio) || '9:16',
      };
      if (str(input.prompt)) payload.prompt = str(input.prompt);
      const res = await tstFetch<any>(ctx.config, '/kol-ai/generate', {
        json: payload,
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!res?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', res);
      return mapJobToResult(res, tool, res.job_id);
    }

    if (t.modelId === 'motion-control-2.6' || t.modelId === 'motion-control-3.0') {
      const [imgUp, vidUp] = await Promise.all([
        uploadToTst(ctx, str(input.image), 'image'),
        uploadToTst(ctx, str(input.video), 'video'),
      ]);
      const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
      const payload: Record<string, unknown> = {
        model: t.modelId,
        server_id: 'vip2',
        character_image_url: imgUp.url,
        motion_video_url: vidUp.url,
        mode: res === '1080p' ? 'pro' : 'std',
        resolution: res,
      };
      if (str(input.prompt)) payload.prompt = str(input.prompt);
      const job = await tstFetch<any>(ctx.config, '/motion/generate', {
        json: payload,
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
      return mapJobToResult(job, tool, job.job_id);
    }

    if (t.modelId === 'topaz-upscale') {
      const vidUp = await uploadToTst(ctx, str(input.video), 'video');
      const job = await tstFetch<any>(ctx.config, '/upscale/video', {
        json: { video_url: vidUp.url, server_id: 'vip3' },
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
      return mapJobToResult(job, tool, job.job_id);
    }

    if (
      t.modelId === 'seedance-2.0-mini' ||
      t.modelId === 'seedance-2.0-fast' ||
      t.modelId === 'seedance-2.0' ||
      t.modelId === 'seedance-2.5'
    ) {
      const rawImgs = collectImageInputs(input);
      const imgUploads = await Promise.all(rawImgs.map((u) => uploadToTst(ctx, u, 'image')));
      const vidUpload = str(input.video) ? await uploadToTst(ctx, str(input.video), 'video') : null;
      const audUpload = str(input.ref_audio) ? await uploadToTst(ctx, str(input.ref_audio), 'audio') : null;

      const res = normalizeRes(
        input.resolution,
        t.modelId === 'seedance-2.0' || t.modelId === 'seedance-2.5' ? ['480p', '720p', '1080p'] : ['480p', '720p'],
        t.modelId === 'seedance-2.0' || t.modelId === 'seedance-2.5' ? '720p' : '480p',
      );
      const dur =
        t.modelId === 'seedance-2.0-fast' || t.modelId === 'seedance-2.0'
          ? pickInt(input.duration, [5, 8, 10, 15], 5)
          : t.modelId === 'seedance-2.5'
            ? clampInt(input.duration, 4, 30, 5)
            : clampInt(input.duration, 4, 15, 5);
      const audio = boolVal(input.audio, true);
      const aspect = str(input.aspect_ratio) || '9:16';

      // Seedance 2.0 Mini khi không có ảnh tham chiếu: gửi qua `/v1/generate` (mode references hỗ trợ T2V không ảnh)
      if (t.modelId === 'seedance-2.0-mini' && imgUploads.length === 0 && !vidUpload && !audUpload) {
        const gen = await tstFetch<any>(ctx.config, '/generate', {
          json: {
            model: 'seedance-2.0-mini',
            server_id: 'vip3',
            mode: 'references',
            prompt: str(input.prompt),
            params: { resolution: res, duration: dur, aspect_ratio: aspect, audio },
          },
          headers: { 'Idempotency-Key': idemKey },
          timeoutMs: 90_000,
        });
        if (!gen?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', gen);
        return mapJobToResult(gen, tool, gen.job_id);
      }

      const payload: Record<string, unknown> = {
        model: t.modelId,
        server_id: 'vip3',
        prompt: str(input.prompt),
        duration: dur,
        resolution: res,
        aspect_ratio: aspect,
        audio,
      };
      if (imgUploads.length) payload.img_urls = imgUploads.map((x) => x.url);
      if (vidUpload) payload.video_url = vidUpload.url;
      if (audUpload) payload.audio_url = audUpload.url;

      const job = await tstFetch<any>(ctx.config, '/seedance/generate', {
        json: payload,
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
      return mapJobToResult(job, tool, job.job_id);
    }

    // Các model Video qua `/v1/video/generate`: kling-2.5-turbo, wan-3.0, kling-3.0-omni, kling-4.0-video, minimax-hailuo-3.0
    const rawImgs = collectImageInputs(input);
    const imgUploads = await Promise.all(rawImgs.map((u) => uploadToTst(ctx, u, 'image')));
    const vidUpload = str(input.video) ? await uploadToTst(ctx, str(input.video), 'video') : null;

    if (t.modelId === 'kling-2.5-turbo') {
      const res = normalizeRes(input.resolution, ['720p', '1080p'], '720p');
      const dur = str(input.duration).replace(/s$/i, '') === '10' ? 10 : 5;
      const payload: Record<string, unknown> = {
        model: 'kling-2.5-turbo',
        server_id: res === '1080p' ? 'vip1' : 'fast',
        prompt: str(input.prompt),
        duration: dur,
        resolution: res,
        aspect_ratio: str(input.aspect_ratio) || '9:16',
        speed: 'fast',
      };
      if (imgUploads[0]) payload.img_url = imgUploads[0].url;
      const job = await tstFetch<any>(ctx.config, '/video/generate', {
        json: payload,
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
      return mapJobToResult(job, tool, job.job_id);
    }

    if (t.modelId === 'wan-3.0') {
      const res = normalizeRes(input.resolution, ['480p', '720p', '1080p'], '480p');
      const dur = clampInt(input.duration, 2, 30, 5);
      const imageMode = str(input.image_mode) === 'frames' ? 'frames' : 'references';
      const payload: Record<string, unknown> = {
        model: 'wan-3.0',
        server_id: 'vip3',
        prompt: str(input.prompt),
        duration: dur,
        resolution: res,
        aspect_ratio: str(input.aspect_ratio) || '9:16',
        audio: boolVal(input.audio, true),
        image_mode: imageMode,
      };
      if (imgUploads.length) payload.image_urls = imgUploads.map((x) => x.url);
      const job = await tstFetch<any>(ctx.config, '/video/generate', {
        json: payload,
        headers: { 'Idempotency-Key': idemKey },
        timeoutMs: 90_000,
      });
      if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
      return mapJobToResult(job, tool, job.job_id);
    }

    // kling-3.0-omni / kling-4.0-video / minimax-hailuo-3.0
    const serverMap: Record<string, string> = {
      'kling-3.0-omni': 'vip1',
      'kling-4.0-video': 'vip1',
      'minimax-hailuo-3.0': 'vip3',
    };
    const payload: Record<string, unknown> = {
      model: t.modelId,
      server_id: serverMap[t.modelId] ?? 'vip1',
      prompt: str(input.prompt),
      duration: clampInt(input.duration, 3, 30, 5),
      resolution: str(input.resolution) || '720p',
      aspect_ratio: str(input.aspect_ratio) || '9:16',
    };
    if (t.modelId !== 'minimax-hailuo-3.0') payload.audio = boolVal(input.audio, true);
    if (imgUploads.length) payload.image_urls = imgUploads.map((x) => x.url);
    if (vidUpload) payload.video_url = vidUpload.url;

    const job = await tstFetch<any>(ctx.config, '/video/generate', {
      json: payload,
      headers: { 'Idempotency-Key': idemKey },
      timeoutMs: 90_000,
    });
    if (!job?.job_id) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ', job);
    return mapJobToResult(job, tool, job.job_id);
  },

  async poll(tool, id, ctx) {
    const job = await tstFetch<any>(ctx.config, `/jobs/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
    return mapJobToResult(job, tool, id);
  },

  async balance(ctx) {
    if (!ctx.config.apiKey) return null;
    const data = await tstFetch<{ balance?: number }>(ctx.config, '/balance', { timeoutMs: 15_000 });
    const bal = Number(data?.balance);
    return Number.isFinite(bal) ? { balance: Math.round(bal * 100) / 100, unit: 'credit' } : null;
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    if (!ctx.config.apiKey) return [];
    const live = await getLiveModels(ctx.config, true);
    return [...live.values()].map((m) => ({
      id: m.model,
      label: m.name ? `${m.name} (${m.model})` : m.model,
    }));
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const live = await getLiveModels(ctx.config, true).catch(() => null);
    if (!live || live.size < 3) return { addedTools: [], removedKeys: [] };
    const removedKeys: string[] = [];
    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (t.modelId && !live.has(t.modelId)) {
        removedKeys.push(`tramsangtao.${t.key}`);
        TOOLS.splice(i, 1);
      }
    }
    return { addedTools: [], removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey) return null;
    const live = await getLiveModels(ctx.config, true).catch(() => null);
    if (!live || live.size === 0) return null;
    const down = new Set<string>();
    for (const t of TOOLS) {
      const entry = live.get(t.modelId);
      if (!entry || !Array.isArray(entry.pricing) || entry.pricing.length === 0) {
        down.add(t.key);
      }
    }
    return down;
  },
};
