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
 * PlenxAI Developer API — https://plenxai.com (`SV17`, T-441)
 * - Base URL: `https://plenxai.com` -> `/api/v1/developer/*`
 * - Xác thực: Header `X-API-Key: pk_...` (tuyệt đối không gửi qua Authorization)
 * - Tỉ giá gốc mặc định an toàn: `1 credit = 75đ` (`rate = 75`, `markup = 28%`; gói Enterprise 3tr/60k cr = 50đ/cr lời sâu hơn).
 * - Đồng bộ giá trực tiếp từ `GET /api/v1/developer/models`, tải media đầu vào qua Presign R2 (`/media-upload/presign` -> `PUT` -> `/confirm`),
 *   và tải toàn bộ ảnh/video kết quả về storage nội bộ để ẩn 100% nguồn.
 */

const DEFAULT_BASE = 'https://plenxai.com';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime,video/webm';

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

function normalizeBaseUrl(raw?: string): string {
  const s = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '').replace(/\/api\/v1(?:\/developer)?$/i, '');
  return s || DEFAULT_BASE;
}

function sanitizePlenxError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/insufficient_credits|không đủ credits?|out of credit|403|gói hiện tại không có quyền/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/401|api key|unauthorized|invalid key|thu hồi/i.test(s)) {
    return 'Kết nối máy chủ xử lý tạm gián đoạn xác thực, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/429|concurrent|đồng thời|queue|quá tải|too many/i.test(s)) {
    return 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại vào ví.';
  }
  if (/policy|unsafe|nsfw|vi phạm|kiểm duyệt|sensitive|blocked/i.test(s)) {
    return 'Nội dung mô tả hoặc tệp tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*plenx(?:ai)?[\w.-]*\.[a-z.]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\bplenx(?:ai)?(?:\.com)?\b/gi, 'Hệ thống AI')
    .replace(/\bPlenEX\b/gi, 'Hệ thống AI')
    .replace(/\bcredits?\b/gi, 'đơn vị')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function plenxJson<T = any>(
  cfg: AiProviderConfig,
  devPath: string,
  init: RequestInit & { timeoutMs?: number; requireAuth?: boolean } = {},
): Promise<{ data: T; status: number; headers: Headers }> {
  const { timeoutMs = 45_000, requireAuth = true, headers: extraHeaders, ...rest } = init;
  const apiKey = (cfg.apiKey || '').trim();
  if (requireAuth && !apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const base = normalizeBaseUrl(cfg.baseUrl);
  const fullPath = devPath.startsWith('/api/') ? devPath : `/api/v1/developer${devPath.startsWith('/') ? '' : '/'}${devPath}`;
  const url = devPath.startsWith('http') ? devPath : `${base}${fullPath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
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

  if (!res.ok) {
    // Đặc thù GET /status/{task_id}: 404 kèm X-Poll-Stop: true
    if (res.status === 404 && res.headers.get('x-poll-stop') === 'true') {
      return { data: { success: false, status: 'error', error_message: 'Tác vụ không tồn tại hoặc đã kết thúc trên máy chủ xử lý' } as unknown as T, status: 404, headers: res.headers };
    }
    const rawMsg = data?.message ?? data?.detail ?? data?.error ?? `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500;
    throw new AiProviderError(sanitizePlenxError(rawMsg) || `Máy chủ xử lý trả lỗi (HTTP ${res.status})`, data, retryable);
  }

  // PlenxAI trả HTTP 200 với `success: false` khi từ chối hàng đợi / thiếu credit
  if (data && typeof data === 'object' && data.success === false && !devPath.startsWith('/status/')) {
    const errCode = String(data.error ?? '');
    const retryable = /queue|concurrent|busy|rate/i.test(errCode);
    throw new AiProviderError(sanitizePlenxError(data.message || data.error || 'Yêu cầu bị từ chối tạm thời'), data, retryable);
  }

  return { data: data as T, status: res.status, headers: res.headers };
}

/** Upload media lên R2 của PlenxAI qua `/media-upload/presign` -> `PUT` -> `/media-upload/confirm` (fallback `/direct` cho ảnh nhỏ) */
async function uploadPlenxMedia(
  cfg: AiProviderConfig,
  buf: Buffer,
  mimeType: string,
  filename: string,
  mediaType: 'image' | 'video',
): Promise<string> {
  try {
    const { data: presign } = await plenxJson<{
      success: boolean;
      upload_url: string;
      upload_key: string;
      public_url?: string;
    }>(cfg, '/media-upload/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: filename.slice(0, 120) || (mediaType === 'video' ? 'video.mp4' : 'image.jpg'),
        content_type: mimeType,
        file_size: buf.length,
        media_type: mediaType,
      }),
      timeoutMs: 30_000,
    });

    const putRes = await fetch(presign.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(120_000),
    });
    if (!putRes.ok) {
      throw new Error(`PUT R2 HTTP ${putRes.status}`);
    }

    const { data: confirmed } = await plenxJson<{
      success: boolean;
      url?: string;
      cdn_url?: string | null;
    }>(cfg, '/media-upload/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_key: presign.upload_key,
        media_type: mediaType,
        push_to_cdn: false,
      }),
      timeoutMs: 30_000,
    });
    const finalUrl = confirmed.url || confirmed.cdn_url || presign.public_url;
    if (finalUrl) return finalUrl;
  } catch (err) {
    if (mediaType === 'image' && buf.length <= 8 * 1024 * 1024) {
      const { data: direct } = await plenxJson<{ url?: string; cdn_url?: string | null }>(cfg, '/media-upload/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_data: `data:${mimeType};base64,${buf.toString('base64')}`,
          filename: filename.slice(0, 100) || 'image.jpg',
          media_type: 'image',
        }),
        timeoutMs: 45_000,
      });
      if (direct?.url || direct?.cdn_url) return (direct.url || direct.cdn_url)!;
    }
    throw err instanceof AiProviderError
      ? err
      : new AiProviderError('Không tải được tệp đầu vào lên máy chủ xử lý, vui lòng thử lại', { error: (err as Error).message }, true);
  }
  throw new AiProviderError('Không nhận được đường dẫn tệp sau khi tải lên máy chủ xử lý');
}

interface LivePricingEntry {
  quality?: string | null;
  credit_cost: number;
  cost_type: 'per_gen' | 'per_second';
}

interface LiveModelItem {
  id: string;
  name?: string;
  description?: string;
  type: 'image' | 'video';
  resolutions?: string[];
  durations?: number[];
  aspect_ratios?: string[];
  max_reference_images?: number;
  servers: Map<string, LivePricingEntry[]>;
}

interface LiveModelCache {
  at: number;
  byId: Map<string, LiveModelItem>;
}

let catalogCache: LiveModelCache | null = null;

async function getLiveModels(cfg: AiProviderConfig, force = false): Promise<LiveModelCache['byId']> {
  if (!force && catalogCache && Date.now() - catalogCache.at < 120_000) return catalogCache.byId;
  const byId = new Map<string, LiveModelItem>();
  try {
    const { data } = await plenxJson<{ image_models?: any[]; video_models?: any[] }>(cfg, '/models', {
      requireAuth: false,
      timeoutMs: 15_000,
    });
    const ingest = (m: any, fallbackType: 'image' | 'video') => {
      if (!m?.id) return;
      const srvMap = new Map<string, LivePricingEntry[]>();
      for (const s of m.servers ?? []) {
        if (s?.slug && Array.isArray(s.pricing)) srvMap.set(String(s.slug), s.pricing);
      }
      byId.set(String(m.id), {
        id: String(m.id),
        name: typeof m.name === 'string' ? m.name : String(m.id),
        description: typeof m.description === 'string' ? m.description : undefined,
        type: m.type === 'image' || fallbackType === 'image' ? 'image' : 'video',
        resolutions: Array.isArray(m.resolutions) ? m.resolutions.map(String) : undefined,
        durations: Array.isArray(m.durations) ? m.durations.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : undefined,
        aspect_ratios: Array.isArray(m.aspect_ratios) ? m.aspect_ratios.map(String) : undefined,
        max_reference_images: Number.isFinite(Number(m.max_reference_images)) ? Number(m.max_reference_images) : undefined,
        servers: srvMap,
      });
    };
    for (const m of data.image_models ?? []) ingest(m, 'image');
    for (const m of data.video_models ?? []) ingest(m, 'video');
    if (byId.size > 0) catalogCache = { at: Date.now(), byId };
  } catch {
    // dùng fallback nếu lỗi mạng tạm thời
  }
  return catalogCache?.byId ?? byId;
}

interface PlenxVideoSpec {
  kind: 'video' | 'video-omni' | 'motion';
  key: string;
  upstreamModel: string;
  server: string;
  alt4kServer?: string;
  name: string;
  description: string;
  durations: number[];
  qualities: string[];
  defaultOption: string;
  ratios: [string, string][];
  maxRefs?: number;
  allowVideoRef?: boolean;
  hasAudioToggle?: boolean;
  featured?: boolean;
  /** Bảng giá dự phòng: quality -> { cost, perSecond } */
  fallbackPricing: Record<string, { cost: number; perSecond: boolean }>;
}

interface PlenxImageSpec {
  kind: 'image';
  key: string;
  upstreamModel: string;
  modelVariants?: [string, string][];
  server: string;
  name: string;
  description: string;
  resolutions: [string, string][];
  defaultRes: string;
  ratios: [string, string][];
  maxRefs: number;
  featured?: boolean;
  fallbackPricing: Record<string, number>;
}

type PlenxSpec = PlenxVideoSpec | PlenxImageSpec;

const SPECS: PlenxSpec[] = [
  // ==================== NHÓM TỐI ƯU BẬT SẴN (14 CÔNG CỤ) ====================
  {
    kind: 'video',
    key: 'veo-3-1-relaxed',
    upstreamModel: 'veo-3.1-relaxed',
    server: 'flow',
    name: 'Google Veo 3.1 Relaxed · Siêu tiết kiệm (720p/1080p)',
    description: 'Tạo video Google Veo 3.1 bản Relaxed giá siêu rẻ (chỉ 5–7 credit/video 4–8 giây, hỗ trợ từ văn bản hoặc tới 3 ảnh tham chiếu).',
    durations: [8, 6, 4],
    qualities: ['720p', '1080p'],
    defaultOption: '8|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 3,
    featured: true,
    fallbackPricing: { '720p': { cost: 5, perSecond: false }, '1080p': { cost: 7, perSecond: false } },
  },
  {
    kind: 'video',
    key: 'veo-3-1-lite',
    upstreamModel: 'veo-3.1-lite',
    server: 'flow-veo3',
    name: 'Google Veo 3.1 Lite · Tiết kiệm tới 4K (4–8s)',
    description: 'Tạo video Google Veo 3.1 Lite sắc nét (720p / 1080p / 4K, 4–8 giây; chế độ 1080p/4K tự xuất chuẩn 8s) từ văn bản hoặc ảnh tham chiếu.',
    durations: [8, 6, 4],
    qualities: ['720p', '1080p', '4k'],
    defaultOption: '8|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 3,
    featured: true,
    fallbackPricing: { '720p': { cost: 6, perSecond: false }, '1080p': { cost: 8, perSecond: false }, '4k': { cost: 40, perSecond: false } },
  },
  {
    kind: 'video',
    key: 'veo-3-1-fast',
    upstreamModel: 'veo-3.1-fast',
    server: 'vip-01',
    name: 'Google Veo 3.1 Fast · Tốc độ cao tới 4K (4–8s)',
    description: 'Tạo video Google Veo 3.1 Fast tốc độ cao (4s / 6s / 8s, độ nét 720p / 1080p / 4K).',
    durations: [8, 6, 4],
    qualities: ['720p', '1080p', '4k'],
    defaultOption: '8|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 3,
    fallbackPricing: { '720p': { cost: 10, perSecond: false }, '1080p': { cost: 14, perSecond: false }, '4k': { cost: 60, perSecond: false } },
  },
  {
    kind: 'video',
    key: 'veo-3-relaxed',
    upstreamModel: 'veo-3-relaxed',
    server: 'flow',
    name: 'Google Veo 3 Relaxed · Tiết kiệm (720p/1080p)',
    description: 'Tạo video Google Veo 3 bản Relaxed giá siêu rẻ (chỉ 5–7 credit/video 8 giây, hỗ trợ từ văn bản hoặc khung đầu / cuối).',
    durations: [8, 6, 4],
    qualities: ['720p', '1080p'],
    defaultOption: '8|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 2,
    fallbackPricing: { '720p': { cost: 5, perSecond: false }, '1080p': { cost: 7, perSecond: false } },
  },
  {
    kind: 'video',
    key: 'veo-3-fast',
    upstreamModel: 'veo-3-fast',
    server: 'vip-01',
    name: 'Google Veo 3 Fast · Tốc độ cao tới 4K (4–8s)',
    description: 'Tạo video Google Veo 3 Fast tốc độ cao (4s / 6s / 8s, độ nét 720p / 1080p / 4K).',
    durations: [8, 6, 4],
    qualities: ['720p', '1080p', '4k'],
    defaultOption: '8|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 2,
    fallbackPricing: { '720p': { cost: 10, perSecond: false }, '1080p': { cost: 14, perSecond: false }, '4k': { cost: 60, perSecond: false } },
  },
  {
    kind: 'video-omni',
    key: 'omni-flash',
    upstreamModel: 'omni-flash-video',
    server: 'cheap',
    alt4kServer: 'flow',
    name: 'Google Omni Flash 1.0 · Siêu rẻ (3–10s, tới 4K)',
    description: 'Tạo video Google Omni Flash giá cực rẻ (chỉ từ 1 credit/giây ở 720p), hỗ trợ văn bản, tới 10 ảnh tham chiếu và biến đổi video (V2V).',
    durations: [3, 4, 5, 6, 7, 8, 9, 10],
    qualities: ['720p', '1080p', '4k'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)']],
    maxRefs: 10,
    allowVideoRef: true,
    featured: true,
    fallbackPricing: { '720p': { cost: 1, perSecond: true }, '1080p': { cost: 2, perSecond: true }, '4k': { cost: 10, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'omni-flash-12',
    upstreamModel: 'omni-flash-12-video',
    server: 'cheap',
    alt4kServer: 'flow',
    name: 'Google Omni Flash 1.2 · Tới 15s, 4K & Đa tham chiếu',
    description: 'Bản nâng cấp Omni Flash 1.2 kéo dài 3–15 giây, độ phân giải tới 4K, nhận tới 10 ảnh & video tham chiếu.',
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 12, 15],
    qualities: ['720p', '1080p', '4k'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)'], ['4:3', '4:3'], ['3:4', '3:4'], ['Auto', 'Tự động']],
    maxRefs: 10,
    allowVideoRef: true,
    featured: true,
    fallbackPricing: { '720p': { cost: 2, perSecond: true }, '1080p': { cost: 4, perSecond: true }, '4k': { cost: 14, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'seedance-2-5-flash',
    upstreamModel: 'seedance-2.5-flash',
    server: 'nova',
    name: 'Seedance 2.5 Flash · Siêu rẻ tới 30s (480p–1080p)',
    description: 'Tạo video Seedance 2.5 Flash giá siêu tốt (5s–30s, có âm thanh, kèm tới 10 ảnh & video tham chiếu).',
    durations: [5, 8, 10, 12, 15, 30],
    qualities: ['480p', '720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)']],
    maxRefs: 10,
    allowVideoRef: true,
    hasAudioToggle: true,
    featured: true,
    fallbackPricing: { '480p': { cost: 5, perSecond: true }, '720p': { cost: 8, perSecond: true }, '1080p': { cost: 12, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'flux-3-video',
    upstreamModel: 'flux-3',
    server: 'cheap',
    name: 'FLUX 3 Video · Thế hệ mới (5s–20s, 720p/1080p)',
    description: 'Model tạo video điện ảnh FLUX 3 mới nhất (5s–20s, 720p/1080p, có âm thanh & hỗ trợ ảnh/video tham chiếu).',
    durations: [5, 10, 15, 20],
    qualities: ['720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)'], ['4:3', '4:3'], ['3:4', '3:4']],
    maxRefs: 6,
    allowVideoRef: true,
    hasAudioToggle: true,
    featured: true,
    fallbackPricing: { '720p': { cost: 7, perSecond: true }, '1080p': { cost: 10, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'grok-video-1-5',
    upstreamModel: 'grok-video-1.5',
    server: 'mag',
    name: 'Grok Video 1.5 · Tiết kiệm tới 15s (480p–1080p)',
    description: 'Tạo video Grok Video 1.5 sắc nét có âm thanh (5s–15s, ghép tới 8 ảnh tham chiếu bằng <IMAGE_1>, <IMAGE_2>).',
    durations: [5, 6, 8, 10, 12, 15],
    qualities: ['480p', '720p', '1080p'],
    defaultOption: '6|720p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)'], ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9']],
    maxRefs: 8,
    featured: true,
    fallbackPricing: { '480p': { cost: 2, perSecond: true }, '720p': { cost: 3, perSecond: true }, '1080p': { cost: 4, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'minimax-h3',
    upstreamModel: 'minimax-h3',
    server: 'enhance',
    name: 'MiniMax H3 · Đồng giá 5–15s tới 2K',
    description: 'Tạo video MiniMax H3 đồng giá theo độ phân giải (480p chỉ 5 cr · 720p · 1080p · 2K, dài tới 15 giây, hỗ trợ đa ảnh tham chiếu).',
    durations: [5, 10, 15],
    qualities: ['480p', '720p', '1080p', '2k'],
    defaultOption: '10|480p',
    ratios: [['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)'], ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9']],
    maxRefs: 8,
    fallbackPricing: { '480p': { cost: 5, perSecond: false }, '720p': { cost: 10, perSecond: false }, '1080p': { cost: 20, perSecond: false }, '2k': { cost: 30, perSecond: false } },
  },
  {
    kind: 'image',
    key: 'grok-image',
    upstreamModel: 'grok-image',
    server: 'mag',
    name: 'Grok Image · Siêu rẻ (tới 4 ảnh tham chiếu)',
    description: 'Tạo & biến đổi ảnh Grok AI sắc nét chỉ 1 credit/ảnh, nhận tới 4 ảnh tham chiếu.',
    resolutions: [['1k', 'Chuẩn HD (1K)']],
    defaultRes: '1k',
    ratios: [['1:1', '1:1 (Vuông)'], ['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['4:3', '4:3'], ['3:4', '3:4'], ['3:2', '3:2'], ['2:3', '2:3'], ['21:9', '21:9']],
    maxRefs: 4,
    featured: true,
    fallbackPricing: { '1k': 1 },
  },
  {
    kind: 'image',
    key: 'nano-banana-pro',
    upstreamModel: 'nano-banana-pro',
    server: 'vip-01',
    name: 'Nano Banana PRO · Ảnh 1K / 2K / 4K (tới 8 ảnh tham chiếu)',
    description: 'Tạo & ghép ảnh Gemini Nano Banana PRO chuẩn 1K / 2K / 4K siêu nét, hỗ trợ tối đa 8 ảnh tham chiếu.',
    resolutions: [['1k', '1K'], ['2k', '2K'], ['4k', '4K Siêu nét']],
    defaultRes: '2k',
    ratios: [['Auto', 'Tự động'], ['1:1', '1:1 (Vuông)'], ['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['4:3', '4:3'], ['3:4', '3:4']],
    maxRefs: 8,
    featured: true,
    fallbackPricing: { '1k': 2, '2k': 3, '4k': 4 },
  },
  {
    kind: 'image',
    key: 'nano-banana-2',
    upstreamModel: 'nano-banana-2',
    server: 'business',
    name: 'Nano Banana 2 · Ảnh 1K / 2K / 4K (tới 8 ảnh tham chiếu)',
    description: 'Tạo & chỉnh sửa ảnh Nano Banana 2 tốc độ cao (1K / 2K / 4K), hỗ trợ tối đa 8 ảnh tham chiếu.',
    resolutions: [['1k', '1K'], ['2k', '2K'], ['4k', '4K Siêu nét']],
    defaultRes: '2k',
    ratios: [['Auto', 'Tự động'], ['1:1', '1:1 (Vuông)'], ['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['4:3', '4:3'], ['3:4', '3:4'], ['3:2', '3:2'], ['21:9', '21:9']],
    maxRefs: 8,
    featured: true,
    fallbackPricing: { '1k': 2, '2k': 4, '4k': 7 },
  },
  {
    kind: 'image',
    key: 'kling-3-omni-image',
    upstreamModel: 'kling-3-omni-image',
    server: 'business',
    name: 'Kling 3.0 Omni Image · Ảnh 1K–4K (tới 10 ảnh tham chiếu)',
    description: 'Tạo ảnh Kling 3.0 Omni thế hệ mới (1K / 2K / 4K), ghép nhất quán tới 10 ảnh tham chiếu.',
    resolutions: [['1k', '1K'], ['2k', '2K'], ['4k', '4K Siêu nét']],
    defaultRes: '2k',
    ratios: [['Auto', 'Tự động'], ['1:1', '1:1 (Vuông)'], ['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['4:3', '4:3'], ['3:4', '3:4'], ['3:2', '3:2'], ['2:3', '2:3'], ['21:9', '21:9']],
    maxRefs: 10,
    fallbackPricing: { '1k': 3, '2k': 4, '4k': 5 },
  },
  {
    kind: 'image',
    key: 'gpt-image-2-6',
    upstreamModel: 'gpt-image-2.6',
    modelVariants: [
      ['gpt-image-2.6', 'GPT Image 2.6 (Đa dụng)'],
      ['gpt-image-2.6-flare', 'GPT Image 2.6 Flare (Bám sát mô tả)'],
      ['gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst (Quảng cáo chi tiết cao)'],
    ],
    server: 'wirouter',
    name: 'GPT Image 2.6 (Chuẩn / Flare / Sunburst · 1K–4K)',
    description: 'Bộ 3 model OpenAI GPT Image 2.6 mới nhất (1K / 2K / 4K, ghép tới 8 ảnh tham chiếu).',
    resolutions: [['1k', '1K'], ['2k', '2K'], ['4k', '4K Siêu nét']],
    defaultRes: '1k',
    ratios: [['1:1', '1:1 (Vuông)'], ['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['4:3', '4:3'], ['3:4', '3:4'], ['3:2', '3:2'], ['2:3', '2:3']],
    maxRefs: 8,
    fallbackPricing: { '1k': 8, '2k': 12, '4k': 20 },
  },

  // ==================== NHÓM ĐỂ CHẾ ĐỘ ẨN MẶC ĐỊNH (enabled = false) ====================
  {
    kind: 'video-omni',
    key: 'seedance-2-5',
    upstreamModel: 'seedance-2.5',
    server: 'nova',
    name: 'Seedance 2.5 (480p–1080p, tới 30s)',
    description: 'Tạo video Seedance 2.5 đa tham chiếu tới 30 giây.',
    durations: [5, 8, 10, 12, 15, 20, 30],
    qualities: ['480p', '720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']],
    maxRefs: 10,
    allowVideoRef: true,
    hasAudioToggle: true,
    fallbackPricing: { '480p': { cost: 7, perSecond: true }, '720p': { cost: 12, perSecond: true }, '1080p': { cost: 15, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'seedance-2-0-pro',
    upstreamModel: 'seedance-2.0-pro',
    server: 'cheap',
    name: 'Seedance 2.0 Pro (480p–4K, tới 15s)',
    description: 'Tạo video Seedance 2.0 Pro chất lượng cao.',
    durations: [5, 8, 10, 12, 15],
    qualities: ['480p', '720p', '1080p', '4k'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']],
    maxRefs: 10,
    hasAudioToggle: true,
    fallbackPricing: { '480p': { cost: 10, perSecond: true }, '720p': { cost: 16, perSecond: true }, '1080p': { cost: 37, perSecond: true }, '4k': { cost: 74, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'wan-3-0',
    upstreamModel: 'wan-3.0',
    server: 'pcs',
    name: 'Wan 3.0 Video (480p–1080p, tới 30s)',
    description: 'Tạo video Wan 3.0 có âm thanh tới 30 giây.',
    durations: [5, 10, 15, 30],
    qualities: ['480p', '720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']],
    maxRefs: 6,
    hasAudioToggle: true,
    fallbackPricing: { '480p': { cost: 6, perSecond: true }, '720p': { cost: 9, perSecond: true }, '1080p': { cost: 18, perSecond: true } },
  },
  {
    kind: 'video-omni',
    key: 'kling-4-0',
    upstreamModel: 'kling-4.0',
    server: 'gon',
    name: 'Kling 4.0 Video (720p/1080p, tới 30s)',
    description: 'Tạo video Kling 4.0 dài tới 30 giây.',
    durations: [3, 5, 8, 10, 15, 20, 25, 30],
    qualities: ['720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['21:9', '21:9']],
    maxRefs: 6,
    fallbackPricing: { '720p': { cost: 8, perSecond: true }, '1080p': { cost: 11, perSecond: true } },
  },
  {
    kind: 'motion',
    key: 'kling-motion',
    upstreamModel: 'kling-motion',
    server: 'business',
    name: 'Kling Motion Control 2.6 (720p/1080p)',
    description: 'Chuyển chuyển động từ video mẫu sang ảnh nhân vật.',
    durations: [5, 10],
    qualities: ['720p', '1080p'],
    defaultOption: '5|720p',
    ratios: [['9:16', '9:16'], ['16:9', '16:9']],
    fallbackPricing: { '720p': { cost: 4, perSecond: true }, '1080p': { cost: 6, perSecond: true } },
  },
  {
    kind: 'image',
    key: 'seedream-5-5',
    upstreamModel: 'seedream-5-5',
    server: 'business',
    name: 'Seedream 5.5 (1K / 2K)',
    description: 'Tạo ảnh Seedream 5.5 kèm tối đa 4 ảnh tham chiếu.',
    resolutions: [['1k', '1K'], ['2k', '2K']],
    defaultRes: '1k',
    ratios: [['1:1', '1:1'], ['16:9', '16:9'], ['9:16', '9:16'], ['4:3', '4:3'], ['3:4', '3:4']],
    maxRefs: 4,
    fallbackPricing: { '1k': 7, '2k': 12 },
  },
];

function buildToolFields(spec: PlenxSpec): AiFieldDef[] {
  if (spec.kind === 'image') {
    const fields: AiFieldDef[] = [];
    if (spec.modelVariants?.length) {
      fields.push({
        name: 'variant',
        label: 'Phiên bản Model',
        type: 'select',
        default: spec.modelVariants[0][0],
        options: opts(spec.modelVariants),
      });
    }
    fields.push(
      {
        name: 'prompt',
        label: 'Mô tả hình ảnh',
        type: 'textarea',
        required: true,
        max: 30_000,
        placeholder: 'Mô tả chi tiết bức ảnh muốn tạo hoặc cách ghép các ảnh tham chiếu...',
      },
      {
        name: 'refs',
        label: 'Ảnh tham chiếu (tuỳ chọn)',
        type: 'image',
        multiple: true,
        maxFiles: spec.maxRefs,
        accept: IMG_ACCEPT,
        help: `Tối đa ${spec.maxRefs} ảnh tham chiếu JPG/PNG/WebP.`,
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        default: spec.defaultRes,
        options: opts(spec.resolutions),
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: spec.ratios[0][0],
        options: opts(spec.ratios),
      },
    );
    return fields;
  }

  if (spec.kind === 'motion') {
    return [
      { name: 'image', label: 'Ảnh nhân vật', type: 'image', required: true, accept: IMG_ACCEPT },
      { name: 'video', label: 'Video chuyển động mẫu (tối đa 30s)', type: 'video', required: true, accept: VID_ACCEPT },
      { name: 'prompt', label: 'Mô tả bối cảnh bổ sung (tuỳ chọn)', type: 'textarea', max: 30_000 },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        default: '720p',
        options: opts([['720p', '720p HD'], ['1080p', '1080p Full HD']]),
      },
      {
        name: 'originalSound',
        label: 'Giữ âm thanh gốc từ video mẫu',
        type: 'boolean',
        default: true,
      },
    ];
  }

  // video / video-omni: tách riêng Độ phân giải + Thời lượng chuẩn dạng
  const defParsed = /^(\d+)\|([a-z0-9]+)$/i.exec(spec.defaultOption);
  const defDur = defParsed ? defParsed[1] : String(spec.durations[0]);
  const defQual = defParsed ? defParsed[2].toLowerCase() : spec.qualities[0];
  const qualLabel = (q: string) => {
    const l = q.toLowerCase();
    if (l === '4k') return '4K Ultra HD';
    if (l === '2k') return '2K QHD';
    if (l === '1080p') return '1080p Full HD';
    if (l === '768p') return '768p Tiết kiệm';
    if (l === '720p') return '720p HD';
    if (l === '480p') return '480p Tiết kiệm';
    return q.toUpperCase();
  };

  const fields: AiFieldDef[] = [
    {
      name: 'prompt',
      label: 'Mô tả video',
      type: 'textarea',
      required: true,
      max: 30_000,
      placeholder: 'Mô tả cảnh quay, chuyển động, ánh sáng...',
    },
    {
      name: 'refs',
      label: spec.kind === 'video' ? 'Ảnh khung đầu / tham chiếu (tuỳ chọn)' : 'Ảnh tham chiếu / Khung đầu (tuỳ chọn)',
      type: 'image',
      multiple: true,
      maxFiles: spec.maxRefs ?? 4,
      accept: IMG_ACCEPT,
      help:
        spec.key === 'grok-video-1-5'
          ? 'Gọi từng ảnh bằng <IMAGE_1>, <IMAGE_2>... trong mô tả (1080p cần ít nhất 1 ảnh).'
          : `Tối đa ${spec.maxRefs ?? 4} ảnh JPG/PNG/WebP.`,
    },
  ];
  if (spec.allowVideoRef) {
    fields.push({
      name: 'video',
      label: 'Video tham chiếu / Video gốc V2V (tuỳ chọn)',
      type: 'video',
      accept: VID_ACCEPT,
      help: 'Đính kèm video để biến đổi bối cảnh (V2V) hoặc học chuyển động camera.',
    });
  }
  fields.push(
    {
      name: 'resolution',
      label: 'Chất lượng',
      type: 'select',
      required: true,
      default: defQual,
      options: spec.qualities.map((q) => ({ value: q.toLowerCase(), label: qualLabel(q) })),
    },
    {
      name: 'duration',
      label: 'Thời lượng',
      type: 'select',
      required: true,
      default: defDur,
      options: spec.durations.map((d) => ({ value: String(d), label: `${d} giây` })),
    },
    {
      name: 'aspectRatio',
      label: 'Tỉ lệ khung hình',
      type: 'select',
      default: spec.ratios[0][0],
      options: opts(spec.ratios),
    },
  );
  if (spec.hasAudioToggle) {
    fields.push({
      name: 'withAudio',
      label: 'Tạo âm thanh tự động',
      type: 'boolean',
      default: true,
    });
  }
  return fields;
}

function normalizeVideoQuality(raw: string, allowed: string[], fallback: string): string {
  const lower = raw.trim().toLowerCase();
  const exact = allowed.find((q) => q.toLowerCase() === lower);
  if (exact) return exact.toLowerCase();
  const fallbackChain: Record<string, string[]> = {
    '768p': ['480p', '720p', '1080p'],
    '480p': ['768p', '720p', '1080p'],
    '4k': ['2k', '1080p', '720p'],
    '2k': ['1080p', '4k', '720p'],
    '1080p': ['720p', '2k', '480p'],
    '720p': ['1080p', '480p', '768p'],
  };
  for (const cand of fallbackChain[lower] ?? []) {
    const hit = allowed.find((q) => q.toLowerCase() === cand);
    if (hit) return hit.toLowerCase();
  }
  return fallback;
}

function parseVideoParams(input: AiInput, spec: PlenxVideoSpec): { duration: number; quality: string } {
  const fm = /^(\d+)\|([a-z0-9]+)$/i.exec(spec.defaultOption);
  const defDur = fm ? Number(fm[1]) : spec.durations[0];
  const defQual = fm ? fm[2].toLowerCase() : spec.qualities[0].toLowerCase();

  if (input.option) {
    const m = /^(\d+)\|([a-z0-9]+)$/i.exec(String(input.option).trim());
    if (m) {
      const d = Number(m[1]);
      return {
        duration: spec.durations.includes(d) ? d : defDur,
        quality: normalizeVideoQuality(m[2], spec.qualities, defQual),
      };
    }
  }
  const rawDur = Number(String(input.duration ?? '').replace(/[^\d]/g, ''));
  const duration = spec.durations.includes(rawDur) ? rawDur : defDur;
  const rawQual = str(input.resolution ?? input.quality);
  return { duration, quality: normalizeVideoQuality(rawQual, spec.qualities, defQual) };
}

const TOOLS: AiToolDef[] = [
  ...SPECS.map((spec) => ({
    key: spec.key,
    name: spec.name,
    description: spec.description,
    category: spec.kind === 'image' ? 'image' : spec.kind === 'motion' ? 'text' : 'video',
    icon: spec.kind === 'image' ? 'Image' : 'Film',
    output: (spec.kind === 'image' ? 'image' : 'video') as 'image' | 'video',
    featured: spec.featured,
    supportsCost: true,
    supportsDurationTiers: spec.kind !== 'image' && 'durations' in spec && spec.durations.includes(30),
    fields: buildToolFields(spec),
    pricing: { mode: 'cost' as const, markup: 28 },
  })),
  {
    key: 'remove-bg',
    name: 'Xoá nền ảnh AI một chạm (Tách nền PNG trong suốt · Tới 10 ảnh)',
    description: 'Tự động tách chủ thể, xoá sạch nền ảnh chỉ trong vài giây và xuất file PNG nền trong suốt sắc nét (hỗ trợ xử lý hàng loạt tới 10 ảnh/lượt, miễn phí 0đ).',
    category: 'cong-cu-mien-phi',
    icon: 'Eraser',
    output: 'image',
    featured: true,
    supportsCost: false,
    fields: [
      {
        name: 'images',
        label: 'Ảnh cần xoá nền (1 – 10 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Hỗ trợ tải 1 ảnh hoặc chọn cùng lúc tới 10 ảnh JPG/PNG/WebP để xoá nền hàng loạt.',
      },
    ],
    pricing: { mode: 'free' },
  },
];

const plenxSessionCache = new Map<string, { accessToken: string; refreshToken?: string; expMs: number }>();

function decodeJwtExpMs(jwt: string): number {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function fetchPlenxUserBalance(cfg: AiProviderConfig): Promise<{ balance: number; unit: string } | null> {
  const raw = str(cfg.sessionCookie).trim();
  if (!raw) return null;

  const base = normalizeBaseUrl(cfg.baseUrl);
  const cacheKey = `${base}|${raw.slice(0, 64)}`;
  const now = Date.now();
  let cached = plenxSessionCache.get(cacheKey);

  const callMe = async (token: string) => {
    const res = await fetch(`${base}/api/v1/users/me`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const me = (await res.json()) as { credit_balance?: number; free_credits?: number };
    const total = (Number(me.credit_balance) || 0) + (Number(me.free_credits) || 0);
    return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
  };

  if (cached && cached.accessToken && cached.expMs > now + 60_000) {
    const bal = await callMe(cached.accessToken);
    if (bal !== null) return { balance: bal, unit: 'credit' };
  }

  let candidateAccess = '';
  let candidateRefresh = cached?.refreshToken || '';

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { access_token?: string; refresh_token?: string };
      candidateAccess = str(parsed.access_token).trim();
      candidateRefresh = str(parsed.refresh_token).trim() || candidateRefresh;
    } catch {
      /* ignore */
    }
  } else if (/^bearer\s+/i.test(raw)) {
    candidateAccess = raw.replace(/^bearer\s+/i, '').trim();
  } else if (raw.includes(':') && !raw.startsWith('eyJ')) {
    const idx = raw.indexOf(':');
    const email = raw.slice(0, idx).trim();
    const password = raw.slice(idx + 1).trim();
    if (email && password) {
      const loginRes = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(12_000),
      });
      if (loginRes.ok) {
        const d = (await loginRes.json()) as { access_token?: string; refresh_token?: string };
        candidateAccess = str(d.access_token).trim();
        candidateRefresh = str(d.refresh_token).trim() || candidateRefresh;
      }
    }
  } else {
    // Có thể là refresh_token hoặc access_token JWT
    candidateAccess = raw;
    if (!candidateRefresh) candidateRefresh = raw;
  }

  if (candidateAccess) {
    const exp = decodeJwtExpMs(candidateAccess);
    if (!exp || exp > now + 15_000) {
      const bal = await callMe(candidateAccess);
      if (bal !== null) {
        plenxSessionCache.set(cacheKey, {
          accessToken: candidateAccess,
          refreshToken: candidateRefresh !== candidateAccess ? candidateRefresh : undefined,
          expMs: exp || now + 10 * 60_000,
        });
        return { balance: bal, unit: 'credit' };
      }
    }
  }

  if (candidateRefresh) {
    const refRes = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ refresh_token: candidateRefresh }),
      signal: AbortSignal.timeout(12_000),
    });
    if (refRes.ok) {
      const d = (await refRes.json()) as { access_token?: string; refresh_token?: string };
      const newAccess = str(d.access_token).trim();
      const newRefresh = str(d.refresh_token).trim() || candidateRefresh;
      if (newAccess) {
        const bal = await callMe(newAccess);
        if (bal !== null) {
          plenxSessionCache.set(cacheKey, {
            accessToken: newAccess,
            refreshToken: newRefresh,
            expMs: decodeJwtExpMs(newAccess) || now + 10 * 60_000,
          });
          return { balance: bal, unit: 'credit' };
        }
      }
    }
  }

  throw new AiProviderError('Token phiên plenxai.com đã hết hạn hoặc không hợp lệ — vui lòng dán lại refresh_token mới hoặc xoá trống để dùng sổ theo dõi credit tự động');
}

export const plenxaiProvider: AiProvider = {
  key: 'plenxai',
  name: 'PlenxAI Developer (plenxai.com)',
  website: 'https://plenxai.com',
  costUnit: 'credit',
  rate: 84,
  tools: TOOLS,

  async balance(ctx) {
    return fetchPlenxUserBalance(ctx.config);
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    const map = await getLiveModels(ctx.config);
    return [...map.keys()].map((id) => ({ id, label: id }));
  },

  async discoverTools(ctx) {
    const live = await getLiveModels(ctx.config, true);
    const removedKeys: string[] = [];

    if (live.size >= 15) {
      const hasActiveServer = (mId: string) => {
        const entry = live.get(mId);
        if (!entry) return false;
        for (const rows of entry.servers.values()) {
          if (rows.some((r) => Number(r.credit_cost) > 0)) return true;
        }
        return false;
      };
      for (let i = SPECS.length - 1; i >= 0; i--) {
        const s = SPECS[i];
        const alive =
          s.kind === 'image' && s.modelVariants?.length
            ? s.modelVariants.some(([vid]) => hasActiveServer(vid))
            : hasActiveServer(s.upstreamModel);
        if (!alive) {
          SPECS.splice(i, 1);
          const tIdx = TOOLS.findIndex((t) => t.key === s.key);
          if (tIdx >= 0) TOOLS.splice(tIdx, 1);
          removedKeys.push(`plenxai.${s.key}`);
        }
      }
    }

    const coveredModels = new Set<string>();
    const usedKeys = new Set<string>(TOOLS.map((t) => t.key));
    for (const s of SPECS) {
      coveredModels.add(s.upstreamModel);
      if (s.kind === 'image' && s.modelVariants) {
        for (const [vid] of s.modelVariants) coveredModels.add(vid);
      }
    }
    const addedTools: AiToolDef[] = [];
    for (const m of live.values()) {
      if (coveredModels.has(m.id)) continue;
      // Chọn server có đơn giá khởi điểm thấp nhất đang hoạt động
      let bestSrv = '';
      let bestMin = Infinity;
      let bestRows: LivePricingEntry[] = [];
      for (const [srv, rows] of m.servers.entries()) {
        const valid = rows.filter((r) => Number(r.credit_cost) > 0);
        if (!valid.length) continue;
        const minC = Math.min(...valid.map((r) => Number(r.credit_cost)));
        if (minC < bestMin) {
          bestMin = minC;
          bestSrv = srv;
          bestRows = valid;
        }
      }
      if (!bestSrv || !bestRows.length) continue;

      const baseSlug = m.id.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
      const toolKey = usedKeys.has(baseSlug) ? `auto-${baseSlug}` : baseSlug;
      usedKeys.add(toolKey);
      coveredModels.add(m.id);

      const rawRatios = (m.aspect_ratios?.length ? m.aspect_ratios : ['1:1', '16:9', '9:16', '4:3', '3:4']).map(
        (r): [string, string] => [r, r],
      );
      const cleanName = sanitizePlenxError(m.name || m.id) || m.id;
      const cleanDesc = sanitizePlenxError(m.description || '') || `Tạo ${m.type === 'image' ? 'ảnh' : 'video'} AI bằng ${cleanName}.`;

      let spec: PlenxSpec;
      if (m.type === 'image') {
        const quals = [...new Set(bestRows.map((r) => String(r.quality || '1k').toLowerCase()))];
        const fb: Record<string, number> = {};
        for (const r of bestRows) {
          const q = String(r.quality || '1k').toLowerCase();
          if (!fb[q] || r.credit_cost < fb[q]) fb[q] = r.credit_cost;
        }
        spec = {
          kind: 'image',
          key: toolKey,
          upstreamModel: m.id,
          server: bestSrv,
          name: cleanName,
          description: cleanDesc,
          resolutions: (quals.length ? quals : ['1k', '2k']).map((q): [string, string] => [q, q.toUpperCase()]),
          defaultRes: quals[0] || '1k',
          ratios: rawRatios,
          maxRefs: m.max_reference_images ?? 4,
          fallbackPricing: fb,
        };
      } else {
        const quals = [...new Set(bestRows.map((r) => String(r.quality || '720p').toLowerCase()))];
        const durs = m.durations?.length ? m.durations : /veo/i.test(m.id) ? [8] : [5, 8, 10];
        const defQual = quals.includes('720p') ? '720p' : quals[0] || '720p';
        const defDur = durs.includes(5) ? 5 : durs[0] || 5;
        const fb: Record<string, { cost: number; perSecond: boolean }> = {};
        for (const r of bestRows) {
          const q = String(r.quality || defQual).toLowerCase();
          if (!fb[q]) fb[q] = { cost: r.credit_cost, perSecond: r.cost_type === 'per_second' };
        }
        const isMotion = /motion/i.test(m.id);
        spec = isMotion
          ? {
              kind: 'motion',
              key: toolKey,
              upstreamModel: m.id,
              server: bestSrv,
              name: cleanName,
              description: cleanDesc,
              durations: durs,
              qualities: quals.length ? quals : ['720p', '1080p'],
              defaultOption: `${defDur}|${defQual}`,
              ratios: rawRatios,
              fallbackPricing: fb,
            }
          : {
              kind: 'video-omni',
              key: toolKey,
              upstreamModel: m.id,
              server: bestSrv,
              name: cleanName,
              description: cleanDesc,
              durations: durs,
              qualities: quals.length ? quals : ['720p', '1080p'],
              defaultOption: `${defDur}|${defQual}`,
              ratios: rawRatios,
              maxRefs: m.max_reference_images ?? 4,
              hasAudioToggle: bestRows.some((r: any) => r.include_audio !== undefined),
              fallbackPricing: fb,
            };
      }

      SPECS.push(spec);
      const def: AiToolDef = {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        category: spec.kind === 'image' ? 'image' : 'video',
        icon: spec.kind === 'image' ? 'Image' : 'Film',
        output: spec.kind === 'image' ? 'image' : 'video',
        supportsCost: true,
        supportsDurationTiers: spec.kind !== 'image' && spec.durations.includes(30),
        fields: buildToolFields(spec),
        pricing: { mode: 'cost', markup: 28 },
      };
      TOOLS.push(def);
      addedTools.push(def);
    }
    return { addedTools, removedKeys };
  },

  async cost(tool, input, ctx) {
    const spec = SPECS.find((s) => s.key === tool.key);
    if (!spec) return null;
    const liveMap = await getLiveModels(ctx.config, Boolean(input.__fresh));

    if (spec.kind === 'image') {
      const res = str(input.resolution || spec.defaultRes).toLowerCase();
      const modelId = spec.modelVariants ? str(input.variant || spec.upstreamModel) : spec.upstreamModel;
      const liveSrv = liveMap.get(modelId)?.servers.get(spec.server);
      const hit = liveSrv?.find((p) => String(p.quality ?? '').toLowerCase() === res);
      if (hit && hit.credit_cost > 0) return hit.credit_cost;
      return spec.fallbackPricing[res] ?? Object.values(spec.fallbackPricing)[0] ?? 2;
    }

    if (spec.kind === 'motion') {
      const res = str(input.resolution || '720p').toLowerCase();
      const vidUrl = str(input.video).trim();
      let sec = 8;
      if (vidUrl && !input.__sample) {
        const measured = await ctx.uploadDuration(vidUrl);
        if (measured && measured > 0) sec = Math.min(30, Math.max(3, Math.ceil(measured)));
      }
      const fb = spec.fallbackPricing[res] ?? { cost: 4, perSecond: true };
      return fb.perSecond ? fb.cost * sec : fb.cost;
    }

    const { duration, quality } = parseVideoParams(input, spec);
    const hasVideoRef = Boolean(str(input.video).trim());
    const refCount = Array.isArray(input.refs) ? input.refs.filter(Boolean).length : input.refs ? 1 : 0;
    const needsFlow =
      (quality === '4k' && spec.alt4kServer) ||
      (spec.key === 'omni-flash' && (hasVideoRef || refCount > 3) && spec.alt4kServer);
    const targetServer = needsFlow ? spec.alt4kServer! : spec.server;

    const liveSrv = liveMap.get(spec.upstreamModel)?.servers.get(targetServer);
    const hit =
      liveSrv?.find((p) => String(p.quality ?? '').toLowerCase() === quality) ??
      (spec.key === 'minimax-h3' && quality === '480p'
        ? liveSrv?.find((p) => String(p.quality ?? '').toLowerCase() === '768p')
        : undefined);
    if (hit && hit.credit_cost > 0) {
      return hit.cost_type === 'per_second' ? Math.round(hit.credit_cost * duration * 100) / 100 : hit.credit_cost;
    }
    const fb = spec.fallbackPricing[quality] ?? Object.values(spec.fallbackPricing)[0];
    if (!fb) return null;
    return fb.perSecond ? Math.round(fb.cost * duration * 100) / 100 : fb.cost;
  },

  async submit(tool, input: AiInput, ctx: AiCallContext): Promise<AiProviderResult> {
    const uploadImg = async (rawUrl: string, idx: number) => {
      const stdUrl = ctx.ensureStandardImage ? await ctx.ensureStandardImage(rawUrl) : rawUrl;
      const loaded = await loadInputFile(ctx.readUpload, stdUrl);
      const ext = loaded.mimeType === 'image/png' ? 'png' : loaded.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const mime = loaded.mimeType === 'image/png' || loaded.mimeType === 'image/webp' ? loaded.mimeType : 'image/jpeg';
      return uploadPlenxMedia(ctx.config, loaded.data, mime, `ref_${idx + 1}.${ext}`, 'image');
    };

    if (tool.key === 'remove-bg') {
      const rawImgs = input.images ?? input.image ?? input.refs;
      const list = (Array.isArray(rawImgs) ? rawImgs : rawImgs ? [rawImgs] : [])
        .map((x) => str(x).trim())
        .filter(Boolean)
        .slice(0, 10);
      if (!list.length) throw new BadRequestException('Vui lòng tải lên ít nhất 1 ảnh cần xoá nền');

      const uploadedUrls: string[] = [];
      for (let i = 0; i < list.length; i++) uploadedUrls.push(await uploadImg(list[i], i));

      let outUrls: string[] = [];
      if (uploadedUrls.length === 1) {
        const { data } = await plenxJson<{ success?: boolean; output_url?: string; error?: string | null }>(
          ctx.config,
          '/remove-background',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url: uploadedUrls[0] }),
            timeoutMs: 60_000,
          },
        );
        if (!data?.output_url) {
          throw new AiProviderError(sanitizePlenxError(data?.error || 'Không tách được nền ảnh này, vui lòng thử ảnh khác'), data);
        }
        outUrls = [data.output_url];
      } else {
        const { data } = await plenxJson<{
          success?: boolean;
          results?: { success?: boolean; output_url?: string; error?: string | null }[];
        }>(ctx.config, '/remove-background/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_urls: uploadedUrls }),
          timeoutMs: 90_000,
        });
        outUrls = (data?.results ?? [])
          .filter((r) => r?.success && typeof r.output_url === 'string' && r.output_url.length > 0)
          .map((r) => r.output_url!);
        if (!outUrls.length) {
          throw new AiProviderError('Không tách được nền cho các ảnh đã chọn, vui lòng thử lại', data);
        }
      }

      const files: AiOutputFile[] = [];
      for (let i = 0; i < outUrls.length; i++) {
        const dl = await fetch(outUrls[i], {
          headers: { 'User-Agent': 'NovAIStudio/1.0' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!dl.ok) throw new AiProviderError(`Không tải được ảnh kết quả (HTTP ${dl.status})`, null, dl.status >= 500);
        const buf = Buffer.from(await dl.arrayBuffer());
        files.push({
          url: '',
          type: 'image',
          name: `nobg_${i + 1}.png`,
          data: buf,
          mimeType: 'image/png',
        });
      }
      return { status: 'succeeded', progress: 100, files };
    }

    const spec = SPECS.find((s) => s.key === tool.key);
    if (!spec) throw new BadRequestException(`Không tìm thấy cấu hình model ${tool.key}`);

    const uploadVid = async (rawUrl: string) => {
      const prepped = ctx.ensureVideoMaxBytes ? await ctx.ensureVideoMaxBytes(rawUrl, 45 * 1024 * 1024) : rawUrl;
      const loaded = await loadInputFile(ctx.readUpload, prepped);
      const ext = loaded.mimeType === 'video/webm' ? 'webm' : loaded.mimeType === 'video/quicktime' ? 'mov' : 'mp4';
      const mime = loaded.mimeType === 'video/webm' || loaded.mimeType === 'video/quicktime' ? loaded.mimeType : 'video/mp4';
      return uploadPlenxMedia(ctx.config, loaded.data, mime, `video_ref.${ext}`, 'video');
    };

    if (spec.kind === 'image') {
      const prompt = str(input.prompt).trim();
      if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả hình ảnh');
      const rawRefs = (Array.isArray(input.refs) ? input.refs : input.refs ? [input.refs] : [])
        .map((x) => str(x).trim())
        .filter(Boolean);
      const uploadedRefs: string[] = [];
      for (let i = 0; i < rawRefs.length; i++) uploadedRefs.push(await uploadImg(rawRefs[i], i));

      const modelId = spec.modelVariants ? str(input.variant || spec.upstreamModel) : spec.upstreamModel;
      const rawImgRes = str(input.resolution || spec.defaultRes).toLowerCase();
      const validImgRes = spec.resolutions.find(([r]) => r.toLowerCase() === rawImgRes)?.[0] ?? spec.defaultRes;
      const rawImgRatio = str(input.aspectRatio || spec.ratios[0][0]);
      const validImgRatio = spec.ratios.find(([r]) => r.toLowerCase() === rawImgRatio.toLowerCase())?.[0] ?? spec.ratios[0][0];
      const payload: Record<string, unknown> = {
        prompt,
        model: modelId,
        resolution: validImgRes.toLowerCase(),
        aspect_ratio: validImgRatio,
        server: spec.server,
      };
      if (uploadedRefs.length) payload.references_urls = uploadedRefs;

      const { data } = await plenxJson<{ task_id?: string }>(ctx.config, '/generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
      });
      const taskId = str(data?.task_id).trim();
      if (!taskId) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ ảnh', data);
      return { status: 'processing', providerTaskId: taskId, progress: 5, raw: data };
    }

    if (spec.kind === 'motion') {
      const imgUrl = str(input.image).trim();
      const vidUrl = str(input.video).trim();
      if (!imgUrl || !vidUrl) throw new BadRequestException('Vui lòng tải lên đủ ảnh nhân vật và video chuyển động mẫu');
      const [charR2, vidR2] = await Promise.all([uploadImg(imgUrl, 0), uploadVid(vidUrl)]);
      const payload: Record<string, unknown> = {
        character_image_url: charR2,
        video_reference_url: vidR2,
        model: spec.upstreamModel,
        prompt: str(input.prompt).trim() || 'Smooth natural motion',
        resolution: str(input.resolution || '720p').toLowerCase(),
        character_orientation: 'video',
        original_sound: input.originalSound !== false && input.originalSound !== 'false',
        server: spec.server,
      };
      const { data } = await plenxJson<{ task_id?: string }>(ctx.config, '/generate/motion-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
      });
      const taskId = str(data?.task_id).trim();
      if (!taskId) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ Motion Control', data);
      return { status: 'processing', providerTaskId: taskId, progress: 5, raw: data };
    }

    // Video / Video-Omni
    let prompt = str(input.prompt).trim();
    if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả video');
    let { duration, quality } = parseVideoParams(input, spec);
    const rawRatio = str(input.aspectRatio || spec.ratios[0][0]);
    const ratio = spec.ratios.find(([r]) => r.toLowerCase() === rawRatio.toLowerCase())?.[0] ?? spec.ratios[0][0];

    const rawRefs = (Array.isArray(input.refs) ? input.refs : input.refs ? [input.refs] : [])
      .map((x) => str(x).trim())
      .filter(Boolean);
    const rawVid = str(input.video).trim();

    // Quy tắc PlenxAI cho Veo 3.1 Lite: 1080p/4k hoặc R2V (3 ảnh) chỉ nhận duration = 8 (đồng giá per_gen)
    if (spec.key === 'veo-3-1-lite' && (quality !== '720p' || rawRefs.length > 2)) {
      duration = 8;
    }

    // Grok Video 1.5 ở 1080p bắt buộc có ảnh đầu vào; nếu không có ảnh và <= 720p tự chuyển sang `grok-video` (cùng server `mag` giá 2–3 cr/s)
    let effectiveModel = spec.upstreamModel;
    if (spec.key === 'grok-video-1-5' && rawRefs.length === 0) {
      if (quality === '1080p') {
        throw new BadRequestException('Grok Video 1.5 ở độ phân giải 1080p cần đính kèm ít nhất 1 ảnh tham chiếu (hoặc chọn 720p/480p để tạo từ văn bản)');
      }
      effectiveModel = 'grok-video';
    }

    const uploadedImgs: string[] = [];
    for (let i = 0; i < rawRefs.length; i++) uploadedImgs.push(await uploadImg(rawRefs[i], i));
    const uploadedVid = rawVid ? await uploadVid(rawVid) : null;

    if (spec.kind === 'video' && uploadedImgs.length <= 2 && !uploadedVid) {
      // Gọi `/generate/video` cho T2V hoặc I2V (start_image_url + end_image_url) của dòng Veo 3 / Veo 3.1
      const payload: Record<string, unknown> = {
        prompt,
        model: effectiveModel,
        mode: uploadedImgs.length > 0 ? 'i2v' : 't2v',
        duration,
        quality: quality === '4k' ? '4k' : quality,
        aspect_ratio: ratio,
        server: spec.server,
      };
      if (uploadedImgs[0]) payload.start_image_url = uploadedImgs[0];
      if (uploadedImgs[1]) payload.end_image_url = uploadedImgs[1];

      const { data } = await plenxJson<{ task_id?: string }>(ctx.config, '/generate/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
      });
      const taskId = str(data?.task_id).trim();
      if (!taskId) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ video', data);
      return { status: 'processing', providerTaskId: taskId, progress: 5, raw: data };
    }

    // Gọi `/generate/video-omni`
    if (effectiveModel.startsWith('grok-video') && uploadedImgs.length > 0) {
      // Chuẩn hoá `<IMAGE_0>` -> `<IMAGE_1>` khớp tài liệu Grok trên PlenxAI
      prompt = prompt.replace(/<IMAGE_0>/gi, '<IMAGE_1>');
    }
    const needsFlow =
      (quality === '4k' && spec.alt4kServer) ||
      (spec.key === 'omni-flash' && (Boolean(uploadedVid) || uploadedImgs.length > 3) && spec.alt4kServer);
    const targetServer = needsFlow ? spec.alt4kServer! : spec.server;

    const omniPayload: Record<string, unknown> = {
      prompt,
      model: effectiveModel,
      duration,
      aspect_ratio: ratio,
      resolution: quality,
      server: targetServer,
    };
    if (spec.hasAudioToggle) {
      omniPayload.generate_audio = input.withAudio !== false && input.withAudio !== 'false';
    }
    if (uploadedVid) {
      omniPayload.reference_videos = [uploadedVid];
    }
    if (uploadedImgs.length === 1 && !effectiveModel.startsWith('veo-3') && !(spec.key === 'omni-flash' && targetServer === 'cheap')) {
      omniPayload.input_image_url = uploadedImgs[0];
    } else if (uploadedImgs.length > 0) {
      omniPayload.reference_images = uploadedImgs;
    }

    const { data } = await plenxJson<{ task_id?: string }>(ctx.config, '/generate/video-omni', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(omniPayload),
      timeoutMs: 60_000,
    });
    const taskId = str(data?.task_id).trim();
    if (!taskId) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ Video Omni', data);
    return { status: 'processing', providerTaskId: taskId, progress: 5, raw: data };
  },

  async poll(tool, providerTaskId, ctx): Promise<AiProviderResult> {
    const { data } = await plenxJson<{
      success?: boolean;
      status?: string;
      result_url?: string | null;
      output_url?: string | null;
      urls?: string[];
      error_message?: string | null;
      error?: string | null;
      progress?: number;
    }>(ctx.config, `/status/${encodeURIComponent(providerTaskId)}`, { timeoutMs: 30_000 });

    const st = String(data?.status ?? '').toLowerCase();
    if (st === 'completed' || st === 'succeeded' || st === 'done') {
      const urls = Array.isArray(data?.urls) && data.urls.length
        ? data.urls
        : [data?.result_url || data?.output_url].filter((u): u is string => typeof u === 'string' && u.length > 0);
      if (!urls.length) {
        throw new AiProviderError('Tác vụ báo hoàn tất nhưng chưa trả về đường dẫn kết quả', data, true);
      }

      const files: AiOutputFile[] = [];
      for (let i = 0; i < urls.length; i++) {
        const dl = await fetch(urls[i], {
          headers: { 'User-Agent': 'NovAIStudio/1.0' },
          signal: AbortSignal.timeout(120_000),
        });
        if (!dl.ok) {
          throw new AiProviderError(`Không tải được tệp kết quả từ máy chủ xử lý (HTTP ${dl.status})`, data, dl.status >= 500);
        }
        const buf = Buffer.from(await dl.arrayBuffer());
        const ct = (dl.headers.get('content-type') || (tool.output === 'image' ? 'image/png' : 'video/mp4')).split(';')[0].trim();
        const ext = tool.output === 'image' ? (ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png') : 'mp4';
        files.push({
          url: '',
          type: tool.output,
          name: `${tool.output}_${i + 1}.${ext}`,
          data: buf,
          mimeType: ct,
        });
      }
      return { status: 'succeeded', progress: 100, files, raw: data };
    }

    if (st === 'error' || st === 'failed' || st === 'cancelled') {
      const err = sanitizePlenxError(data?.error_message || data?.error || 'Tác vụ xử lý không thành công');
      return { status: 'failed', error: err || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại vào ví.', raw: data };
    }

    const p = Number(data?.progress);
    const progress = Number.isFinite(p) && p > 0 ? Math.min(99, Math.max(10, Math.round(p))) : st === 'processing' ? 45 : 15;
    return { status: 'processing', progress, raw: data };
  },

  async cancel(_tool, providerTaskId, ctx) {
    try {
      const { data } = await plenxJson<{ status?: string }>(ctx.config, `/status/${encodeURIComponent(providerTaskId)}`, { timeoutMs: 8_000 });
      const st = String(data?.status ?? 'unknown');
      return {
        ok: false,
        upstreamStatus: st,
        note: `Nguồn PlenxAI (SV17) không mở endpoint huỷ qua API Key · Trạng thái nguồn: ${st}`,
      };
    } catch (err) {
      return { ok: false, upstreamStatus: 'error', note: `Kiểm tra trạng thái nguồn khi huỷ: ${(err as Error).message.slice(0, 120)}` };
    }
  },

  async maintenanceCheck(ctx) {
    try {
      const { data, status } = await plenxJson<{ image_models?: any[]; video_models?: any[] }>(ctx.config, '/models', {
        requireAuth: false,
        timeoutMs: 12_000,
      });
      if (status === 503) return 'ALL';
      const rawAll = [...(data?.image_models ?? []), ...(data?.video_models ?? [])];
      if (rawAll.length < 10) return null;

      const healthyModelServers = new Map<string, Set<string>>();
      for (const m of rawAll) {
        const id = String(m?.id ?? '').trim();
        if (!id) continue;
        const mSt = String(m?.status ?? '').toLowerCase();
        if (m?.maintenance === true || m?.enabled === false || m?.is_active === false || /maint|off|down|disable/i.test(mSt)) {
          continue;
        }
        const srvs = new Set<string>();
        for (const s of m?.servers ?? []) {
          const slug = String(s?.slug ?? '').trim();
          const sSt = String(s?.status ?? '').toLowerCase();
          const sMaint = s?.maintenance === true || s?.enabled === false || s?.is_active === false || /maint|off|down|disable/i.test(sSt);
          const hasPrice = Array.isArray(s?.pricing) && s.pricing.some((r: any) => Number(r?.credit_cost) > 0);
          if (slug && !sMaint && hasPrice) srvs.add(slug);
        }
        if (srvs.size > 0) healthyModelServers.set(id, srvs);
      }

      const down = new Set<string>();
      for (const spec of SPECS) {
        if (spec.kind === 'image' && spec.modelVariants?.length) {
          const anyOk = spec.modelVariants.some(([vid]) => (healthyModelServers.get(vid)?.size ?? 0) > 0);
          if (!anyOk) down.add(spec.key);
          continue;
        }
        const srvs = healthyModelServers.get(spec.upstreamModel);
        if (!srvs || srvs.size === 0) {
          down.add(spec.key);
        }
      }
      return down;
    } catch {
      return null;
    }
  },
};
