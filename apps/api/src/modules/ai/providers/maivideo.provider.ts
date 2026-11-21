import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiCatalogItem,
  type AiFieldDef,
  type AiFieldOption,
  type AiInput,
  type AiOutputFile,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderResult,
  type AiToolDef,
} from '../ai.types.js';
import { loadInputFile } from './background.js';
import { str } from './http.js';

/**
 * MaiVideo Studio API — https://maivideo.top (`SV15`, T-373)
 * - Xác thực: Header `X-API-Key: sk_live_...`
 * - Đơn vị quy đổi chuẩn gốc (không tính khuyến mãi nạp): `1 credit = 1.000đ` (`rate = 1000`, `markup = 35%`):
 *   + Premium Video (`500.000đ / 500 credit = 1.000đ/credit`):
 *     - MiniMax H3 (`minimax-h3`, 768p/1440p, 5–15s): 2 credit / 5s đầu + 0,2 credit/giây vượt 5s (đọc động từ `/api/v1/video-generation/models`).
 *     - Wan 3.0 (`wan-3.0`, 720p/1080p, 2–30s, có tiếng): 2 credit / 5s đầu + 0,2 credit/giây vượt 5s.
 *     - Seedance 2.0 Fast (`seedance-2.0-fast`, 720p, 4–15s, có tiếng): 3 credit / 5s đầu + 0,4 credit/giây vượt 5s.
 *     - PixVerse V6 / V5.6 / C1: tính theo bảng giá gốc + 35%.
 *   + Ảnh AI (`500.000đ / 4.000 ảnh = 125đ/ảnh` = `0.125 credit`): GPT Image 2.5 Pro/Fast, Nano Banana 2.1/Pro/2, Seedream 5.5.
 *   + Giọng đọc TTS (`400.000đ / 500.000 ký tự = 800đ/1.000 ký tự` = `0.8 credit/1k ký tự`).
 * - Mọi file ảnh/video/audio kết quả (`file_url` / `audio_url`) được tải trực tiếp ở tầng máy chủ bằng `X-API-Key` thành `Buffer`
 *   rồi lưu thẳng vào storage nội bộ, tuyệt đối không lộ tên miền hay mã job của nguồn ra ngoài.
 */

const DEFAULT_BASE = 'https://maivideo.top';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

function normalizeBaseUrl(raw?: string): string {
  const s = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  return s || DEFAULT_BASE;
}

function sanitizeMaiVideoError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/quota|hết lượt|không đủ credit|còn\s*0\s*credit|bổ sung credit|insufficient|seedance_credits|out of credit|limit exceeded|nâng cấp gói/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/401|api key|unauthorized|invalid key|revoked/i.test(s)) {
    return 'Kết nối máy chủ xử lý tạm gián đoạn xác thực, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/policy|unsafe|nsfw|vi phạm|kiểm duyệt|sensitive|blocked/i.test(s)) {
    return 'Nội dung mô tả hoặc ảnh tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.';
  }
  if (/429|rate.?limit|quá nhiều yêu cầu|too many/i.test(s)) {
    return 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại vào ví.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*maivideo[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\bmaivideo(?:\.top)?\b/gi, 'Hệ thống AI')
    .replace(/\b(?:piximg|pixvideo|hfvid)_[a-z0-9_-]+/gi, '')
    .replace(/\b11lab\.id\.vn\b/gi, 'Hệ thống AI')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractErrorMessage(data: any, status: number): string {
  const candidates = [
    data?.error,
    data?.detail,
    data?.message,
    data?.job?.error,
    Array.isArray(data?.job?.items) ? data.job.items.find((x: any) => x?.error)?.error : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return sanitizeMaiVideoError(c);
    if (Array.isArray(c) && c.length > 0) {
      const msg = c.map((item: any) => item?.msg || JSON.stringify(item)).join('; ');
      if (msg.trim()) return sanitizeMaiVideoError(msg);
    }
  }
  return `Máy chủ xử lý trả lỗi (HTTP ${status})`;
}

async function maiJson<T = any>(
  cfg: AiProviderConfig,
  subpath: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const apiKey = (cfg.apiKey || '').trim();
  if (!apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const base = normalizeBaseUrl(cfg.baseUrl);
  const { timeoutMs = 45_000, headers: extraHeaders, ...rest } = init;
  const url = subpath.startsWith('http') ? subpath : `${base}${subpath.startsWith('/') ? '' : '/'}${subpath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
        'User-Agent': 'NovAIStudio/1.0',
        ...(extraHeaders as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AiProviderError('Kết nối máy chủ xử lý tạm gián đoạn, hệ thống sẽ tự thử lại', { error: (err as Error).message }, true);
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { rawText: text.slice(0, 500) };
  }

  if (!res.ok || data?.success === false) {
    throw new AiProviderError(
      extractErrorMessage(data, res.status),
      data,
      res.status >= 500 || res.status === 429,
    );
  }
  return data as T;
}

async function downloadProtectedAsset(
  cfg: AiProviderConfig,
  rawFileUrl: string,
  fallbackMime: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const apiKey = (cfg.apiKey || '').trim();
  const base = normalizeBaseUrl(cfg.baseUrl);
  const fullUrl = /^https?:\/\//i.test(rawFileUrl)
    ? rawFileUrl
    : `${base}${rawFileUrl.startsWith('/') ? '' : '/'}${rawFileUrl}`;

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'NovAIStudio/1.0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new AiProviderError('Không tải được file kết quả từ máy chủ xử lý, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
  }

  if (!res.ok) {
    throw new AiProviderError(
      `Không tải được file kết quả (HTTP ${res.status})`,
      { status: res.status },
      res.status >= 500 || res.status === 429,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new AiProviderError('File kết quả trả về rỗng, hệ thống sẽ thử lại', {}, true);
  }
  const mimeType = (res.headers.get('content-type') || fallbackMime).split(';')[0].trim() || fallbackMime;
  return { data: buf, mimeType };
}

async function encodeRefImages(input: AiInput, ctx: AiCallContext, maxFiles: number): Promise<string[]> {
  const rawList: string[] = [];
  const pushVal = (v: unknown) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string' && item.trim()) rawList.push(item.trim());
    } else if (typeof v === 'string' && v.trim()) {
      rawList.push(v.trim());
    }
  };
  pushVal(input.image);
  pushVal(input.images);
  pushVal(input.referenceImages);

  const unique = [...new Set(rawList)].slice(0, maxFiles);
  const out: string[] = [];
  for (const url of unique) {
    if (/^data:image\//i.test(url)) {
      out.push(url);
      continue;
    }
    const loaded = await loadInputFile(ctx.readUpload, url);
    const mime = loaded.mimeType?.startsWith('image/') ? loaded.mimeType : 'image/png';
    out.push(`data:${mime};base64,${loaded.data.toString('base64')}`);
  }
  return out;
}

// ---------------- Cache động danh mục Model Video / Ảnh / Giọng đọc ----------------

interface VideoModelSpec {
  label?: string;
  credit_cost?: number | null;
  credit_base_duration?: number | null;
  credit_cost_per_second?: number | null;
}

interface CachedCatalogState {
  at: number;
  videoModels: Record<string, VideoModelSpec>;
  imageModels: Record<string, string>;
  seedanceRemaining: number | null;
  imageQuotaAvailable: number | null;
  videoQuotaRemaining: number | null;
}

interface MaiVoiceEntry {
  voiceId: string;
  name: string;
  language: string;
  gender: 'male' | 'female' | 'neutral';
  provider: 'omnivoice' | 'elevenlabs_vn';
}

let catalogCache: { key: string; state: CachedCatalogState } | null = null;
let voicesCache: { key: string; at: number; items: MaiVoiceEntry[] } | null = null;

async function getCatalogState(cfg: AiProviderConfig, force = false): Promise<CachedCatalogState | null> {
  if (!cfg.apiKey?.trim()) return null;
  const cacheKey = `${normalizeBaseUrl(cfg.baseUrl)}|${cfg.apiKey.trim()}`;
  if (!force && catalogCache && catalogCache.key === cacheKey && Date.now() - catalogCache.state.at < 3 * 60_000) {
    return catalogCache.state;
  }
  try {
    const [vidRes, imgRes] = await Promise.all([
      maiJson<any>(cfg, '/api/v1/video-generation/models', { timeoutMs: 20_000 }),
      maiJson<any>(cfg, '/api/v1/image-generation/models', { timeoutMs: 20_000 }),
    ]);
    const sc = vidRes?.seedance_credits;
    const seedRem = Number(sc?.total_remaining ?? sc?.remaining);
    const imgAvail = Number(imgRes?.quota?.available ?? imgRes?.quota?.remaining);
    const vidRem = Number(vidRes?.quota?.remaining);
    const state: CachedCatalogState = {
      at: Date.now(),
      videoModels: (vidRes?.models && typeof vidRes.models === 'object' ? vidRes.models : {}) as Record<string, VideoModelSpec>,
      imageModels: (imgRes?.models && typeof imgRes.models === 'object' ? imgRes.models : {}) as Record<string, string>,
      seedanceRemaining: Number.isFinite(seedRem) ? seedRem : null,
      imageQuotaAvailable: Number.isFinite(imgAvail) ? imgAvail : null,
      videoQuotaRemaining: Number.isFinite(vidRem) ? vidRem : null,
    };
    catalogCache = { key: cacheKey, state };
    return state;
  } catch {
    return catalogCache?.key === cacheKey ? catalogCache.state : null;
  }
}

async function getLiveVoices(cfg: AiProviderConfig, force = false): Promise<MaiVoiceEntry[]> {
  if (!cfg.apiKey?.trim()) return [];
  const cacheKey = `${normalizeBaseUrl(cfg.baseUrl)}|${cfg.apiKey.trim()}`;
  if (!force && voicesCache && voicesCache.key === cacheKey && Date.now() - voicesCache.at < 10 * 60_000) {
    return voicesCache.items;
  }
  try {
    const data = await maiJson<any>(cfg, '/api/v1/voices?provider=all&limit=500', { timeoutMs: 25_000 });
    const rawVoices = Array.isArray(data?.voices) ? data.voices : [];
    const seen = new Set<string>();
    const items: MaiVoiceEntry[] = [];
    for (const v of rawVoices) {
      const voiceId = String(v?.voice_id || v?.id || '').trim();
      if (!voiceId || seen.has(voiceId)) continue;
      seen.add(voiceId);
      const rawProv = String(v?.provider || 'omnivoice').trim();
      const provider: 'omnivoice' | 'elevenlabs_vn' = rawProv === 'elevenlabs_vn' ? 'elevenlabs_vn' : 'omnivoice';
      const cleanName = String(v?.name || voiceId)
        .replace(/\s*\[11lab\]\s*/gi, ' (ElevenLabs)')
        .replace(/\s*\[omnivoice\]\s*/gi, '')
        .trim();
      const g = String(v?.gender || '').toLowerCase();
      const gender: 'male' | 'female' | 'neutral' = g === 'male' ? 'male' : g === 'female' ? 'female' : 'neutral';
      const language = String(v?.language || 'vi').toLowerCase().trim() || 'vi';
      items.push({ voiceId, name: cleanName || voiceId, language, gender, provider });
    }
    voicesCache = { key: cacheKey, at: Date.now(), items };
    return items;
  } catch {
    return voicesCache?.key === cacheKey ? voicesCache.items : [];
  }
}

// ---------------- Định nghĩa công cụ (+35% so với giá gốc không khuyến mãi) ----------------

interface MaiToolDef extends AiToolDef {
  kind: 'video' | 'image' | 'tts' | 'free';
  upstreamModel?: string;
  baseCost?: number;
  baseDuration?: number;
  perExtraSec?: number;
  maxRefImages?: number;
  supportsAudio?: boolean;
  supportsMultiShot?: boolean;
  supportsBackground?: boolean;
  supportsDetailLevel?: boolean;
}

const DEFAULT_MARKUP = 35;
/** Gói Ảnh AI gốc không khuyến mãi: 500.000đ / 4.000 ảnh = 125đ/ảnh = 0.125 credit (tỉ giá 1 credit = 1.000đ) */
const IMAGE_BASE_CREDIT = 0.125;
/** Gói Voice gốc không khuyến mãi: 400.000đ / 500.000 ký tự = 800đ / 1.000 ký tự = 0.8 credit / 1.000 ký tự */
const TTS_CREDIT_PER_1K = 0.8;

const VIDEO_TOOLS: MaiToolDef[] = [
  {
    key: 'minimax-h3',
    kind: 'video',
    upstreamModel: 'minimax-h3',
    baseCost: 2.0,
    baseDuration: 5,
    perExtraSec: 0.2,
    maxRefImages: 9,
    name: 'MiniMax H3 — Tạo Video 2K Đa Tham Chiếu',
    category: 'video',
    icon: 'film',
    badge: 'SV15',
    featured: true,
    output: 'video',
    description: 'Tạo video điện ảnh độ phân giải tới 2K (1440p), thời lượng 5–15 giây, hỗ trợ tới 9 ảnh tham chiếu đồng nhất nhân vật & bối cảnh.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả cảnh quay (Prompt)',
        type: 'textarea',
        required: true,
        max: 7000,
        placeholder: 'Mô tả chuyển động nhân vật, góc máy, ánh sáng, bối cảnh điện ảnh...',
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu / Khung hình gốc (tuỳ chọn, tối đa 9 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 9,
        help: '1 ảnh = tạo video từ ảnh (Image-to-Video); nhiều ảnh = tham chiếu nhân vật & bối cảnh đồng nhất',
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        default: '1440p',
        options: opts([
          ['768p', '768p (HD Tiêu chuẩn)'],
          ['1440p', '1440p (2K Siêu nét)'],
        ]),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây'],
          ['12', '12 giây'],
          ['15', '15 giây'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc Shorts/Reels/TikTok)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['21:9', '21:9 (Điện ảnh rộng)'],
          ['auto', 'Tự động theo ảnh gốc'],
        ]),
      },
    ],
  },
  {
    key: 'wan-3-0',
    kind: 'video',
    upstreamModel: 'wan-3.0',
    baseCost: 2.0,
    baseDuration: 5,
    perExtraSec: 0.2,
    maxRefImages: 10,
    supportsAudio: true,
    name: 'Wan 3.0 — Tạo Video 1080p Tới 30 Giây Có Tiếng',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV15',
    featured: true,
    output: 'video',
    description: 'Tạo video dài liền mạch tới 30 giây Full HD 1080p kèm âm thanh tự động, nhận tối đa 10 ảnh tham chiếu và mô tả kịch bản dài tới 20.000 ký tự.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả kịch bản video (Prompt)',
        type: 'textarea',
        required: true,
        max: 20000,
        placeholder: 'Mô tả chi tiết hành động, lời thoại, âm thanh môi trường và chuyển động máy quay...',
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu / Khung hình gốc (tuỳ chọn, tối đa 10 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 10,
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        default: '1080p',
        options: opts([
          ['720p', '720p (HD)'],
          ['1080p', '1080p (Full HD)'],
        ]),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây'],
          ['15', '15 giây'],
          ['20', '20 giây'],
          ['25', '25 giây'],
          ['30', '30 giây'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc Shorts/Reels/TikTok)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['auto', 'Tự động theo ảnh gốc'],
        ]),
      },
      {
        name: 'audio',
        label: 'Tự động lồng âm thanh & hiệu ứng tiếng động',
        type: 'boolean',
        default: true,
      },
    ],
  },
  {
    key: 'seedance-2-0-fast',
    kind: 'video',
    upstreamModel: 'seedance-2.0-fast',
    baseCost: 3.0,
    baseDuration: 5,
    perExtraSec: 0.4,
    maxRefImages: 9,
    supportsAudio: true,
    name: 'Seedance 2.0 Fast — Tạo Video Có Tiếng Đa Tham Chiếu',
    category: 'video',
    icon: 'video',
    badge: 'SV15',
    featured: true,
    output: 'video',
    description: 'Tạo video Seedance 2.0 Fast tốc độ cao 4–15 giây có âm thanh đồng bộ, hỗ trợ tới 9 ảnh tham chiếu nhân vật.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Prompt)',
        type: 'textarea',
        required: true,
        max: 5000,
        placeholder: 'Mô tả cảnh quay, chuyển động nhân vật và âm thanh...',
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu / Khung hình gốc (tuỳ chọn, tối đa 9 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 9,
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['4', '4 giây'],
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây'],
          ['12', '12 giây'],
          ['15', '15 giây'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc Shorts/Reels/TikTok)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['21:9', '21:9 (Điện ảnh rộng)'],
        ]),
      },
      {
        name: 'audio',
        label: 'Tự động tạo âm thanh cùng video',
        type: 'boolean',
        default: true,
      },
    ],
  },
  {
    key: 'pixverse-v6',
    kind: 'video',
    upstreamModel: 'v6',
    baseCost: 3.0,
    baseDuration: 5,
    perExtraSec: 0.4,
    maxRefImages: 7,
    supportsAudio: true,
    supportsMultiShot: true,
    name: 'PixVerse V6 — Tạo Video 1080p Multi-Shot Có Tiếng',
    category: 'video',
    icon: 'sparkles',
    badge: 'SV15',
    output: 'video',
    description: 'Thế hệ PixVerse V6 mới nhất hỗ trợ chuyển cảnh Multi-Shot thông minh, âm thanh sống động, Full HD 1080p tới 15 giây.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Prompt)',
        type: 'textarea',
        required: true,
        max: 5000,
        placeholder: 'Mô tả cảnh quay, chuyển động và hiệu ứng điện ảnh...',
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu / Khung hình gốc (tuỳ chọn, tối đa 7 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 7,
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        default: '1080p',
        options: opts([
          ['720p', '720p (HD)'],
          ['1080p', '1080p (Full HD)'],
        ]),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây'],
          ['15', '15 giây'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['3:2', '3:2'],
          ['2:3', '2:3'],
          ['21:9', '21:9'],
        ]),
      },
      {
        name: 'audio',
        label: 'Tạo kèm âm thanh',
        type: 'boolean',
        default: true,
      },
      {
        name: 'multiShot',
        label: 'Chuyển cảnh đa góc máy (Multi-Shot)',
        type: 'boolean',
        default: false,
      },
    ],
  },
  {
    key: 'pixverse-v5-6',
    kind: 'video',
    upstreamModel: 'v5.6',
    baseCost: 2.5,
    baseDuration: 5,
    perExtraSec: 0.3,
    maxRefImages: 7,
    supportsAudio: true,
    supportsMultiShot: true,
    name: 'PixVerse V5.6 — Tạo Video Nhanh 1080p Có Tiếng',
    category: 'video',
    icon: 'video',
    badge: 'SV15',
    output: 'video',
    description: 'Tạo video PixVerse V5.6 tốc độ nhanh, hỗ trợ 480p / 720p / 1080p kèm âm thanh & Multi-Shot.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Prompt)',
        type: 'textarea',
        required: true,
        max: 5000,
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 7 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 7,
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        default: '720p',
        options: opts([
          ['480p', '480p (Nháp nhanh)'],
          ['720p', '720p (HD)'],
          ['1080p', '1080p (Full HD · tối đa 8s)'],
        ]),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây (tự đưa về 8s nếu chọn 1080p)'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
        ]),
      },
      {
        name: 'audio',
        label: 'Tạo kèm âm thanh',
        type: 'boolean',
        default: true,
      },
    ],
  },
  {
    key: 'pixverse-c1',
    kind: 'video',
    upstreamModel: 'pixverse-c1',
    baseCost: 3.0,
    baseDuration: 5,
    perExtraSec: 0.4,
    maxRefImages: 7,
    supportsAudio: true,
    supportsMultiShot: true,
    name: 'PixVerse C1 — Tạo Video Sáng Tạo 1080p',
    category: 'video',
    icon: 'wand-sparkles',
    badge: 'SV15',
    output: 'video',
    description: 'Model điện ảnh sáng tạo PixVerse C1 720p/1080p tới 15 giây, hỗ trợ âm thanh và tới 7 ảnh tham chiếu.',
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 1000 },
    supportsCost: true,
    fields: [
      {
        name: 'prompt',
        label: 'Mô tả video (Prompt)',
        type: 'textarea',
        required: true,
        max: 5000,
      },
      {
        name: 'referenceImages',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 7 ảnh)',
        type: 'file',
        accept: IMG_ACCEPT,
        multiple: true,
        maxFiles: 7,
      },
      {
        name: 'quality',
        label: 'Độ phân giải',
        type: 'select',
        default: '1080p',
        options: opts([
          ['720p', '720p (HD)'],
          ['1080p', '1080p (Full HD)'],
        ]),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        default: '5',
        options: opts([
          ['5', '5 giây'],
          ['8', '8 giây'],
          ['10', '10 giây'],
          ['15', '15 giây'],
        ]),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '16:9',
        options: opts([
          ['16:9', '16:9 (Ngang)'],
          ['9:16', '9:16 (Dọc)'],
          ['1:1', '1:1 (Vuông)'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
        ]),
      },
      {
        name: 'audio',
        label: 'Tạo kèm âm thanh',
        type: 'boolean',
        default: true,
      },
    ],
  },
];

function makeImageTool(cfg: {
  key: string;
  upstreamModel: string;
  name: string;
  description: string;
  resolutions: [string, string][];
  defaultRes: string;
  ratios: [string, string][];
  detailLevels?: [string, string][];
  defaultDetail?: string;
  supportsBackground?: boolean;
}): MaiToolDef {
  const fields: AiFieldDef[] = [
    {
      name: 'prompt',
      label: 'Mô tả hình ảnh (Prompt)',
      type: 'textarea',
      required: true,
      max: 9999,
      placeholder: 'Mô tả chi tiết bức ảnh cần tạo hoặc yêu cầu chỉnh sửa ảnh tham chiếu...',
    },
    {
      name: 'referenceImages',
      label: 'Ảnh tham chiếu / Ảnh gốc cần sửa (tuỳ chọn, tối đa 9 ảnh)',
      type: 'file',
      accept: IMG_ACCEPT,
      multiple: true,
      maxFiles: 9,
    },
    {
      name: 'resolution',
      label: 'Độ phân giải',
      type: 'select',
      default: cfg.defaultRes,
      options: opts(cfg.resolutions),
    },
    {
      name: 'aspectRatio',
      label: 'Tỉ lệ khung hình',
      type: 'select',
      default: '1:1',
      options: opts(cfg.ratios),
    },
  ];
  if (cfg.detailLevels?.length) {
    fields.push({
      name: 'detailLevel',
      label: 'Mức độ chi tiết (Quality)',
      type: 'select',
      default: cfg.defaultDetail ?? cfg.detailLevels[0][0],
      options: opts(cfg.detailLevels),
    });
  }
  if (cfg.supportsBackground) {
    fields.push({
      name: 'background',
      label: 'Nền ảnh (Background)',
      type: 'select',
      default: 'auto',
      options: opts([
        ['auto', 'Tự động (Auto)'],
        ['transparent', 'Tách nền trong suốt (PNG Transparent)'],
        ['opaque', 'Nền đặc (Opaque)'],
      ]),
    });
  }
  return {
    key: cfg.key,
    kind: 'image',
    upstreamModel: cfg.upstreamModel,
    baseCost: IMAGE_BASE_CREDIT,
    maxRefImages: 9,
    supportsBackground: cfg.supportsBackground,
    supportsDetailLevel: !!cfg.detailLevels?.length,
    name: cfg.name,
    category: 'image',
    icon: 'image',
    badge: 'SV15',
    featured: true,
    output: 'image',
    description: cfg.description,
    pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 100 },
    supportsCost: true,
    fields,
  };
}

const GPT_RATIOS: [string, string][] = [
  ['1:1', '1:1 (Vuông)'],
  ['16:9', '16:9 (Ngang)'],
  ['9:16', '9:16 (Dọc)'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['3:2', '3:2'],
  ['2:3', '2:3'],
  ['21:9', '21:9 (Điện ảnh)'],
];

const GEMINI_RATIOS: [string, string][] = [
  ['auto', 'Tự động'],
  ['1:1', '1:1 (Vuông)'],
  ['16:9', '16:9 (Ngang)'],
  ['9:16', '9:16 (Dọc)'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['4:5', '4:5 (Chân dung MXH)'],
  ['5:4', '5:4'],
  ['3:2', '3:2'],
  ['2:3', '2:3'],
  ['21:9', '21:9 (Điện ảnh)'],
];

const STD_4K_RES: [string, string][] = [
  ['2160p', '4K Ultra HD (2160p)'],
];

const IMAGE_TOOLS: MaiToolDef[] = [
  makeImageTool({
    key: 'gpt-image-2-5-sunburst',
    upstreamModel: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Pro — Tạo Ảnh 4K & Tách Nền',
    description: 'Bản Quality cao cấp nhất của GPT Image 2.5: vẽ chữ Việt/Anh cực chuẩn, hỗ trợ tách nền PNG trong suốt và xuất thẳng 4K.',
    resolutions: STD_4K_RES,
    defaultRes: '2160p',
    ratios: GPT_RATIOS,
    detailLevels: [
      ['medium', 'Tiêu chuẩn (Medium)'],
      ['high', 'Chi tiết cao (High)'],
      ['xhigh', 'Siêu chi tiết (X-High)'],
      ['max', 'Tối đa (Max Quality)'],
    ],
    defaultDetail: 'high',
    supportsBackground: true,
  }),
  makeImageTool({
    key: 'gpt-image-2-5-flare',
    upstreamModel: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Fast — Tạo Ảnh 4K Nhanh & Tách Nền',
    description: 'Bản tốc độ cao GPT Image 2.5 Flare: xuất ảnh 4K cực nhanh, hỗ trợ tách nền trong suốt và tới 9 ảnh tham chiếu.',
    resolutions: STD_4K_RES,
    defaultRes: '2160p',
    ratios: GPT_RATIOS,
    detailLevels: [
      ['low', 'Nhanh (Low)'],
      ['medium', 'Tiêu chuẩn (Medium)'],
      ['high', 'Chi tiết cao (High)'],
      ['xhigh', 'Siêu chi tiết (X-High)'],
      ['max', 'Tối đa (Max)'],
    ],
    defaultDetail: 'high',
    supportsBackground: true,
  }),
  makeImageTool({
    key: 'nano-banana-2-1',
    upstreamModel: 'gemini-nano-banana-2.1',
    name: 'Nano Banana 2.1 — Tạo & Chỉnh Sửa Ảnh 4K',
    description: 'Thế hệ Nano Banana 2.1 mới nhất hỗ trợ tạo & ghép sửa tới 9 ảnh tham chiếu với độ phân giải 4K sắc nét.',
    resolutions: STD_4K_RES,
    defaultRes: '2160p',
    ratios: GEMINI_RATIOS,
    detailLevels: [
      ['minimal', 'Nhanh (Minimal)'],
      ['medium', 'Cân bằng (Medium)'],
      ['high', 'Chi tiết cao (High)'],
    ],
    defaultDetail: 'high',
  }),
  makeImageTool({
    key: 'nano-banana-pro',
    upstreamModel: 'gemini-3.0',
    name: 'Nano Banana Pro — Tạo & Sửa Ảnh 4K Chuyên Sâu',
    description: 'Nano Banana Pro (Gemini 3.0) chuyên bố cục phức tạp, giữ nét khuôn mặt & sản phẩm chuẩn xác tới 4K.',
    resolutions: STD_4K_RES,
    defaultRes: '2160p',
    ratios: GEMINI_RATIOS,
  }),
  makeImageTool({
    key: 'nano-banana-2',
    upstreamModel: 'gemini-3.1-flash',
    name: 'Nano Banana 2 — Tạo Ảnh 4K Tốc Độ Cao',
    description: 'Nano Banana 2 (Gemini 3.1 Flash) tốc độ phản hồi nhanh, hỗ trợ tạo ảnh & chỉnh sửa đa tham chiếu lên tới 4K.',
    resolutions: STD_4K_RES,
    defaultRes: '2160p',
    ratios: GEMINI_RATIOS,
  }),
  makeImageTool({
    key: 'seedream-5-5',
    upstreamModel: 'seedream-5.5',
    name: 'Seedream 5.5 — Ảnh Nghệ Thuật & Tách Nền',
    description: 'Seedream 5.5 chuyên chân dung điện ảnh, thương mại điện tử, hỗ trợ tách nền trong suốt và tới 9 ảnh tham chiếu.',
    resolutions: [
      ['1080p', 'Full HD (1080p)'],
      ['1.5k', '1.5K'],
      ['1440p', '2K (1440p)'],
      ['1800p', 'Ultra Sharp (1800p)'],
    ],
    defaultRes: '1800p',
    ratios: GEMINI_RATIOS,
    supportsBackground: true,
  }),
];

const TTS_TOOL: MaiToolDef = {
  key: 'tts',
  kind: 'tts',
  name: 'Chuyển Văn Bản Thành Giọng Đọc AI (Đa Ngôn Ngữ)',
  category: 'voice',
  icon: 'mic',
  badge: 'SV15',
  output: 'audio',
  description: 'Chuyển văn bản thành giọng đọc tiếng Việt & quốc tế tự nhiên (tới 20.000 ký tự/lượt), tuỳ chỉnh tốc độ đọc và nhịp nghỉ dấu câu.',
  unitLabel: '1.000 ký tự',
  costPerUnit: TTS_CREDIT_PER_1K,
  pricing: { mode: 'cost', markup: DEFAULT_MARKUP, min: 100 },
  supportsCost: true,
  fields: [
    {
      name: 'voice',
      label: 'Giọng đọc AI',
      type: 'select',
      required: true,
      picker: 'voice',
      preview: '/api/public/ai/voice-preview/maivideo/{value}',
      filterLangs: ['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'ru'],
      default: 'Omni7cb381b5a82e',
      options: [
        {
          value: 'Omni7cb381b5a82e',
          label: 'Mai Thanh - Review',
          gender: 'female',
          langs: ['vi'],
        },
      ],
    },
    {
      name: 'text',
      label: 'Văn bản cần chuyển thành giọng nói',
      type: 'textarea',
      required: true,
      max: 20000,
      placeholder: 'Nhập nội dung văn bản cần đọc (tối đa 20.000 ký tự)...',
    },
    {
      name: 'language',
      label: 'Ngôn ngữ đọc',
      type: 'select',
      default: 'auto',
      options: opts([
        ['auto', 'Tự động nhận diện ngôn ngữ'],
        ['vi', 'Tiếng Việt (vi)'],
        ['en', 'Tiếng Anh (en)'],
        ['zh', 'Tiếng Trung (zh)'],
        ['ja', 'Tiếng Nhật (ja)'],
        ['ko', 'Tiếng Hàn (ko)'],
        ['fr', 'Tiếng Pháp (fr)'],
        ['de', 'Tiếng Đức (de)'],
        ['es', 'Tiếng Tây Ban Nha (es)'],
        ['ru', 'Tiếng Nga (ru)'],
      ]),
    },
    {
      name: 'speed',
      label: 'Tốc độ đọc',
      type: 'select',
      default: '1.0',
      options: opts([
        ['0.8', '0.8× · Chậm rãi'],
        ['0.9', '0.9× · Hơi chậm'],
        ['1.0', '1.0× · Tự nhiên (Mặc định)'],
        ['1.1', '1.1× · Hơi nhanh'],
        ['1.25', '1.25× · Nhanh vừa (Review)'],
        ['1.5', '1.5× · Nhanh'],
      ]),
    },
  ],
};

const FREE_UTILITY_TOOLS: MaiToolDef[] = [
  {
    key: 'bulk-download',
    kind: 'free',
    name: 'Tải Video Hàng Loạt Không Logo',
    category: 'cong-cu-mien-phi',
    icon: 'download',
    badge: 'MIỄN PHÍ',
    featured: true,
    splitModels: false,
    output: 'video',
    unitLabel: 'lượt',
    description:
      'Dán danh sách link hoặc quét cả kênh TikTok, Douyin, YouTube Shorts, Reels, Instagram, Bilibili, Xiaohongshu để tải video hàng loạt chất lượng cao không logo & nén ZIP 1 chạm — miễn phí 0đ.',
    pricing: { mode: 'free' },
    fields: [
      {
        name: 'urls',
        label: 'Danh sách liên kết video (mỗi dòng 1 link)',
        type: 'textarea',
        required: true,
        max: 10000,
        placeholder: 'https://www.tiktok.com/@.../video/...\nhttps://www.youtube.com/shorts/...',
      },
    ],
  },
  {
    key: 'xoa-meta-hinh-anh',
    kind: 'free',
    name: 'Xóa Metadata Hình Ảnh Hàng Loạt',
    category: 'cong-cu-mien-phi',
    icon: 'image',
    badge: 'MIỄN PHÍ',
    featured: true,
    splitModels: false,
    output: 'image',
    unitLabel: 'lượt',
    description:
      'Tải lên tối đa 50 ảnh cùng lúc để xoá sạch thông tin ẩn EXIF, vị trí GPS, thiết bị chụp và dấu vết prompt AI ngay trên trình duyệt — bảo mật tuyệt đối, tải về từng ảnh hoặc nén .ZIP miễn phí 0đ.',
    pricing: { mode: 'free' },
    fields: [
      {
        name: 'images',
        label: 'Hình ảnh cần xoá metadata (tối đa 50 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 50,
        accept: IMG_ACCEPT,
      },
    ],
  },
];

const TOOLS: MaiToolDef[] = [...VIDEO_TOOLS, ...IMAGE_TOOLS, TTS_TOOL, ...FREE_UTILITY_TOOLS];

function effectiveCharUnits(text: string): number {
  const s = text.trim();
  if (!s) return 1;
  const cjk = (s.match(CJK_RE) || []).length;
  const effectiveChars = s.length + cjk * 1.5;
  return Math.max(0.1, effectiveChars / 1000);
}

function findMaiTool(tool: AiToolDef): MaiToolDef {
  return (TOOLS.find((t) => t.key === tool.key) ?? tool) as MaiToolDef;
}

export const maivideoProvider: AiProvider = {
  key: 'maivideo',
  name: 'MaiVideo Studio (maivideo.top)',
  website: 'https://maivideo.top',
  costUnit: 'credit',
  rate: 1000,
  tools: TOOLS,

  async resolveFields(tool, ctx) {
    const t = findMaiTool(tool);
    if (t.kind !== 'tts') return tool.fields;
    const voices = await getLiveVoices(ctx.config);
    if (!voices.length) return tool.fields;
    const voiceOptions: AiFieldOption[] = voices.map((v) => ({
      value: v.voiceId,
      label: v.name,
      gender: v.gender,
      langs: [v.language],
      badge: v.provider === 'elevenlabs_vn' ? 'HD' : undefined,
    }));
    return tool.fields.map((f) =>
      f.name === 'voice'
        ? {
            ...f,
            default: voiceOptions.some((o) => o.value === f.default) ? f.default : voiceOptions[0].value,
            options: voiceOptions,
          }
        : f,
    );
  },

  async cost(tool, input, ctx) {
    const t = findMaiTool(tool);
    if (t.kind === 'free') {
      return 0;
    }
    if (t.kind === 'image') {
      return IMAGE_BASE_CREDIT;
    }
    if (t.kind === 'tts') {
      const text = str(input.text);
      const units = text.trim() ? effectiveCharUnits(text) : 1;
      return Math.round(units * TTS_CREDIT_PER_1K * 10000) / 10000;
    }

    // Video: ưu tiên đọc chi phí credit thực tế trực tiếp từ API `/api/v1/video-generation/models` để tự bắt kịp nếu nguồn đổi giá
    const rawDur = Number(input.duration ?? 5) || 5;
    const quality = str(input.quality || '720p');
    const dur = t.upstreamModel === 'v5.6' && quality === '1080p' ? Math.min(8, rawDur) : rawDur;

    const live = await getCatalogState(ctx.config);
    const liveSpec = t.upstreamModel ? live?.videoModels?.[t.upstreamModel] : undefined;
    const baseCost =
      liveSpec && typeof liveSpec.credit_cost === 'number' && liveSpec.credit_cost > 0
        ? liveSpec.credit_cost
        : (t.baseCost ?? 3.0);
    const baseDur =
      liveSpec && typeof liveSpec.credit_base_duration === 'number' && liveSpec.credit_base_duration > 0
        ? liveSpec.credit_base_duration
        : (t.baseDuration ?? 5);
    const perExtra =
      liveSpec && typeof liveSpec.credit_cost_per_second === 'number' && liveSpec.credit_cost_per_second >= 0
        ? liveSpec.credit_cost_per_second
        : (t.perExtraSec ?? 0.4);

    const extraSec = Math.max(0, dur - baseDur);
    return Math.round((baseCost + extraSec * perExtra) * 10000) / 10000;
  },

  async submit(tool, input, ctx): Promise<AiProviderResult> {
    const t = findMaiTool(tool);
    if (t.kind === 'free') {
      return { status: 'succeeded', providerTaskId: `free:${Date.now()}`, text: 'Hoàn tất xử lý trực tiếp trên trình duyệt' };
    }

    if (t.kind === 'tts') {
      const text = str(input.text).trim();
      if (!text) throw new BadRequestException('Vui lòng nhập văn bản cần chuyển thành giọng nói');
      const voiceId = str(input.voice || 'Omni7cb381b5a82e').trim();
      const voices = await getLiveVoices(ctx.config);
      const matched = voices.find((v) => v.voiceId === voiceId);
      const provider = matched?.provider ?? (/^omni/i.test(voiceId) ? 'omnivoice' : 'elevenlabs_vn');
      const language = str(input.language || 'auto').trim() || 'auto';
      const speed = Math.min(2.0, Math.max(0.5, Number(input.speed || 1.0) || 1.0));

      const payload: Record<string, unknown> = {
        voice_id: voiceId,
        provider,
        text,
        language,
        speed,
      };
      if (provider === 'elevenlabs_vn') {
        payload.elevenlabs_api = '11lab.id.vn';
      } else {
        payload.num_step = 16;
      }

      const data = await maiJson<any>(ctx.config, '/api/v1/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 120_000,
      });
      const audioUrl = str(data?.audio_url).trim();
      if (!audioUrl) {
        throw new AiProviderError('Máy chủ giọng đọc chưa trả file âm thanh, vui lòng thử lại', data, true);
      }
      const fallbackMime = audioUrl.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
      const downloaded = await downloadProtectedAsset(ctx.config, audioUrl, fallbackMime);
      const file: AiOutputFile = { url: '', type: 'audio', data: downloaded.data, mimeType: downloaded.mimeType };
      return { status: 'succeeded', progress: 100, files: [file], raw: { voiceId, provider, textLength: data?.text_length } };
    }

    if (t.kind === 'image') {
      const prompt = str(input.prompt).trim();
      if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả hình ảnh');
      const refs = await encodeRefImages(input, ctx, t.maxRefImages ?? 9);
      const payload: Record<string, unknown> = {
        prompt,
        model: t.upstreamModel,
        resolution: str(input.resolution || '2160p'),
        aspect_ratio: str(input.aspectRatio || '1:1'),
        n: 1,
        reference_image_urls: refs,
      };
      if (t.supportsDetailLevel && input.detailLevel) {
        payload.detail_level = str(input.detailLevel);
      }
      if (t.supportsBackground && input.background) {
        payload.background = str(input.background);
      }

      const data = await maiJson<any>(ctx.config, '/api/v1/image-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 90_000,
      });
      const jobId = str(data?.job_id || data?.job?.id).trim();
      if (!jobId) {
        throw new AiProviderError('Không nhận được mã tác vụ tạo ảnh từ máy chủ xử lý', data, true);
      }
      return {
        status: 'processing',
        providerTaskId: `img:${jobId}`,
        progress: 5,
        raw: { jobId, status: data?.status },
      };
    }

    // Video generation
    const prompt = str(input.prompt).trim();
    if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả video');
    const refs = await encodeRefImages(input, ctx, t.maxRefImages ?? 9);
    const quality = str(input.quality || (t.upstreamModel === 'minimax-h3' ? '1440p' : t.upstreamModel === 'seedance-2.0-fast' ? '720p' : '1080p'));
    const rawDur = Math.max(2, Math.round(Number(input.duration ?? 5) || 5));
    const duration = t.upstreamModel === 'v5.6' && quality === '1080p' ? Math.min(8, rawDur) : rawDur;
    const aspectRatio = str(input.aspectRatio || '16:9');

    const payload: Record<string, unknown> = {
      prompt,
      model: t.upstreamModel,
      quality,
      duration,
      count: 1,
      aspect_ratio: aspectRatio,
      audio: t.supportsAudio ? input.audio !== false : false,
      multi_shot: t.supportsMultiShot ? Boolean(input.multiShot) : false,
      reference_image_urls: refs,
    };

    const data = await maiJson<any>(ctx.config, '/api/v1/video-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
    });
    const jobId = str(data?.job_id || data?.job?.id).trim();
    if (!jobId) {
      throw new AiProviderError('Không nhận được mã tác vụ tạo video từ máy chủ xử lý', data, true);
    }
    return {
      status: 'processing',
      providerTaskId: `vid:${jobId}`,
      progress: 5,
      raw: { jobId, status: data?.status },
    };
  },

  async poll(tool, rawTaskId, ctx): Promise<AiProviderResult> {
    const t = findMaiTool(tool);
    let mode: 'img' | 'vid' = t.kind === 'image' ? 'img' : 'vid';
    let jobId = rawTaskId;
    if (rawTaskId.startsWith('img:')) {
      mode = 'img';
      jobId = rawTaskId.slice(4);
    } else if (rawTaskId.startsWith('vid:')) {
      mode = 'vid';
      jobId = rawTaskId.slice(4);
    } else if (rawTaskId.startsWith('piximg_')) {
      mode = 'img';
    }

    const endpoint =
      mode === 'img'
        ? `/api/v1/image-generation/${encodeURIComponent(jobId)}`
        : `/api/v1/video-generation/${encodeURIComponent(jobId)}`;

    const data = await maiJson<any>(ctx.config, endpoint, { timeoutMs: 35_000 });
    const status = str(data?.status || data?.job?.status).toLowerCase();

    if (status === 'completed' || status === 'partial') {
      const rawItems: any[] = mode === 'img' ? (Array.isArray(data?.images) ? data.images : []) : (Array.isArray(data?.videos) ? data.videos : []);
      const validUrls = rawItems.map((it) => str(it?.file_url).trim()).filter(Boolean);
      if (validUrls.length > 0) {
        const files: AiOutputFile[] = [];
        for (const u of validUrls) {
          const fallbackMime = mode === 'img' ? 'image/png' : 'video/mp4';
          const dl = await downloadProtectedAsset(ctx.config, u, fallbackMime);
          files.push({
            url: '',
            type: mode === 'img' ? 'image' : 'video',
            data: dl.data,
            mimeType: dl.mimeType,
          });
        }
        return {
          status: 'succeeded',
          providerTaskId: rawTaskId,
          progress: 100,
          files,
          raw: { status, count: files.length },
        };
      }
      if (status === 'partial' || status === 'completed') {
        return {
          status: 'failed',
          providerTaskId: rawTaskId,
          error: extractErrorMessage(data, 200) || 'Tác vụ xử lý không tạo được kết quả hợp lệ, tiền đã được hoàn lại vào ví.',
          raw: { status },
        };
      }
    }

    if (status === 'error' || status === 'failed' || status === 'cancelled' || status === 'canceled') {
      return {
        status: 'failed',
        providerTaskId: rawTaskId,
        error: extractErrorMessage(data, 200) || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại vào ví.',
        raw: { status },
      };
    }

    const total = Number(data?.job?.total) || 1;
    const completed = Number(data?.job?.completed) || 0;
    const computedProg = status === 'running' ? Math.max(25, Math.min(95, Math.round((completed / total) * 100) || 45)) : 12;
    return {
      status: 'processing',
      providerTaskId: rawTaskId,
      progress: computedProg,
      raw: { status },
    };
  },

  async voiceSample(voiceId, ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const voices = await getLiveVoices(ctx.config);
    const matched = voices.find((v) => v.voiceId === voiceId);
    if (!matched) return null;
    const sampleByLang: Record<string, string> = {
      vi: 'Xin chào, đây là giọng đọc mẫu trí tuệ nhân tạo chất lượng cao.',
      en: 'Hello, this is a natural high quality artificial intelligence voice sample.',
      zh: '您好，这是一段自然流畅的人工智能语音试听样本。',
      ja: 'こんにちは、これは高品質なAI音声サンプルの試聴です。',
      ko: '안녕하세요, 고품질 인공지능 음성 샘플 미리듣기입니다.',
    };
    const sampleText = sampleByLang[matched.language] ?? sampleByLang.en;
    const payload: Record<string, unknown> = {
      voice_id: matched.voiceId,
      provider: matched.provider,
      text: sampleText,
      language: matched.language || 'auto',
      speed: 1.0,
    };
    if (matched.provider === 'elevenlabs_vn') payload.elevenlabs_api = '11lab.id.vn';
    else payload.num_step = 16;

    const data = await maiJson<any>(ctx.config, '/api/v1/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    });
    const audioUrl = str(data?.audio_url).trim();
    if (!audioUrl) return null;
    const fallbackMime = audioUrl.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
    return downloadProtectedAsset(ctx.config, audioUrl, fallbackMime);
  },

  async balance(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const state = await getCatalogState(ctx.config, true);
    if (!state) return null;
    if (state.seedanceRemaining !== null && state.seedanceRemaining > 0) {
      return { balance: Math.round(state.seedanceRemaining * 100) / 100, unit: 'credit video' };
    }
    if (state.imageQuotaAvailable !== null && state.imageQuotaAvailable > 0) {
      return { balance: Math.round(state.imageQuotaAvailable), unit: 'lượt ảnh (0 credit video)' };
    }
    return { balance: state.seedanceRemaining ?? 0, unit: 'credit' };
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    const state = await getCatalogState(ctx.config, true);
    if (!state) return TOOLS.map((t) => ({ id: t.key, label: t.name }));
    const items: AiCatalogItem[] = [];
    for (const [id, spec] of Object.entries(state.videoModels)) {
      items.push({ id: `video:${id}`, label: `Video · ${spec?.label || id}` });
    }
    for (const [id, label] of Object.entries(state.imageModels)) {
      items.push({ id: `image:${id}`, label: `Image · ${label || id}` });
    }
    items.push({ id: 'tts:all', label: 'TTS · Voice Synthesis' });
    return items;
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const state = await getCatalogState(ctx.config, true).catch(() => null);
    if (!state) return { addedTools: [], removedKeys: [] };
    const removedKeys: string[] = [];
    const vidCount = Object.keys(state.videoModels).length;
    const imgCount = Object.keys(state.imageModels).length;

    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (t.kind === 'video' && vidCount >= 2 && t.upstreamModel && !state.videoModels[t.upstreamModel]) {
        removedKeys.push(`maivideo.${t.key}`);
        TOOLS.splice(i, 1);
      } else if (t.kind === 'image' && imgCount >= 3 && t.upstreamModel && !state.imageModels[t.upstreamModel]) {
        removedKeys.push(`maivideo.${t.key}`);
        TOOLS.splice(i, 1);
      }
    }
    return { addedTools: [], removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const state = await getCatalogState(ctx.config, true);
    if (!state) return null;
    const down = new Set<string>();
    const hasVideoCatalog = Object.keys(state.videoModels).length > 0;
    const hasImageCatalog = Object.keys(state.imageModels).length > 0;
    for (const t of TOOLS) {
      if (t.kind === 'video') {
        if (hasVideoCatalog && t.upstreamModel && !state.videoModels[t.upstreamModel]) {
          down.add(t.key);
        }
        if (state.seedanceRemaining !== null && state.seedanceRemaining < (t.baseCost ?? 1)) {
          down.add(t.key);
        }
      }
      if (t.kind === 'image' && hasImageCatalog && t.upstreamModel && !state.imageModels[t.upstreamModel]) {
        down.add(t.key);
      }
    }
    return down;
  },
};
