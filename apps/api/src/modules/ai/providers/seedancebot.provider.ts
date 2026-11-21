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
 * Seedance Studio API — https://api.seedancecreationbot.online (`SV18`, T-464)
 * - Xác thực: `Authorization: Bearer sk-...`
 * - Đơn vị ví gốc: `VNĐ` (`rate = 1`, `costUnit = 'VNĐ'`)
 * - Hỗ trợ đầy đủ:
 *   + Tạo video (`/v1/videos`): Seedance 2.5 (4–30s, tới 30 ảnh + 30s video tham chiếu), Seedance 2.5 Flash, Seedance 2.5 Ultra HD, Seedance 2.0, Seedance 2.0 Mini, Veo 3.1 Fast
 *   + Tạo & sửa ảnh (`/v1/images`): 9 model (GPT Image 2.5 / 2, Nano Banana Pro / 2.1 / 2, Seedream 5.5 / 5.0 Pro / 5.0 / 4.0S)
 *   + Nâng nét video (`/v1/upscale`): nâng 480p -> 720p / 1080p, 720p -> 1080p
 *   + Huỷ đơn trực tiếp (`DELETE /v1/videos/{id}`, `/v1/images/{id}`, `/v1/upscale/{id}`) tự hoàn tiền ví nguồn
 *   + Tải thẳng toàn bộ file MP4/PNG kết quả về kho nội bộ để không bao giờ lộ tên miền nguồn.
 */

const DEFAULT_BASE = 'https://api.seedancecreationbot.online';
const IMG_ACCEPT = 'image/jpeg,image/png,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime,video/webm';
const AUD_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/mp4,audio/x-m4a,audio/ogg';

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

function normalizeBaseUrl(raw?: string): string {
  const s = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return s || DEFAULT_BASE;
}

function sanitizeSdbError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/402|insufficient_balance|số dư.*dưới|không đủ số dư|ví tối thiểu|nạp ví/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/401|403|invalid.*key|unauthorized|khóa api|api new/i.test(s)) {
    return 'Kết nối máy chủ xử lý tạm gián đoạn xác thực, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/429|queue|hàng đợi|quá tải|too many|rate.?limit/i.test(s)) {
    return 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại vào ví.';
  }
  if (/kiểm duyệt|từ chối|policy|unsafe|nsfw|sensitive|vi phạm/i.test(s)) {
    return 'Nội dung mô tả hoặc tệp tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*seedancecreationbot[\w.-]*\.[a-z.]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\bseedancecreationbot(?:\.online)?\b/gi, 'Hệ thống AI')
    .replace(/\bSeedance\s+AI\s+Studio\b/gi, 'Hệ thống AI')
    .replace(/\bbot\s+Telegram\b/gi, 'hệ thống')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function sdbJson<T = any>(
  cfg: AiProviderConfig,
  v1Path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ data: T; status: number }> {
  const { timeoutMs = 45_000, headers: extraHeaders, ...rest } = init;
  const apiKey = str(cfg.apiKey).trim();
  if (!apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const base = normalizeBaseUrl(cfg.baseUrl);
  const fullPath = v1Path.startsWith('/v1/') || v1Path.startsWith('/healthz') ? v1Path : `/v1${v1Path.startsWith('/') ? '' : '/'}${v1Path}`;
  const url = v1Path.startsWith('http') ? v1Path : `${base}${fullPath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
    data = { rawText: text.slice(0, 400) };
  }

  if (!res.ok) {
    const rawMsg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.detail === 'string' && data.detail) ||
      (Array.isArray(data?.detail) && data.detail.map((d: any) => d?.msg).filter(Boolean).join('; ')) ||
      (typeof data?.error === 'string' && data.error) ||
      `HTTP ${res.status}`;
    const retryable = res.status >= 500 || res.status === 429;
    throw new AiProviderError(
      sanitizeSdbError(rawMsg) || 'Yêu cầu xử lý không thành công, vui lòng thử lại',
      { status: res.status, data },
      retryable,
    );
  }

  return { data: data as T, status: res.status };
}

async function sdbDownloadBinary(cfg: AiProviderConfig, filePathOrUrl: string): Promise<{ data: Buffer; mimeType: string }> {
  const apiKey = str(cfg.apiKey).trim();
  const base = normalizeBaseUrl(cfg.baseUrl);
  const url = filePathOrUrl.startsWith('http')
    ? filePathOrUrl
    : `${base}${filePathOrUrl.startsWith('/') ? '' : '/'}${filePathOrUrl}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        'User-Agent': 'NovAIStudio/1.0',
      },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new AiProviderError('Chưa tải được tệp kết quả từ máy chủ xử lý, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
  }
  if (!res.ok) {
    throw new AiProviderError(
      'Tệp kết quả đang hoàn tất đồng bộ, hệ thống sẽ thử lại',
      { status: res.status },
      res.status >= 500 || res.status === 404 || res.status === 429,
    );
  }
  const ct = res.headers.get('content-type') || '';
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) {
    throw new AiProviderError('Tệp kết quả rỗng tạm thời, hệ thống sẽ thử lại', {}, true);
  }
  return { data, mimeType: ct.split(';')[0].trim() };
}

// ---------------- Bảng giá dự phòng & Đồng bộ giá live (`/v1/models` + `/v1/prices`) ----------------

type VideoPriceTable = Record<string, Record<string, Record<string, number>>>;

const FALLBACK_VIDEO_FAST: VideoPriceTable = {
  'Seedance 2.5': {
    '480': { '4': 2800, '5': 3500, '6': 3700, '8': 4000, '10': 5000, '12': 6000, '15': 7500, '20': 9500, '25': 11500, '30': 13500 },
    '720': { '4': 4000, '5': 5000, '6': 5500, '8': 6500, '10': 8500, '12': 10000, '15': 11500, '20': 14300, '25': 17200, '30': 20000 },
    '1080': { '4': 6000, '5': 7500, '6': 8400, '8': 10000, '10': 12500, '12': 15000, '15': 17500, '20': 21700, '25': 25900, '30': 30000 },
  },
  'Seedance 2.5 Flash': {
    '480': { '4': 2400, '5': 3000, '6': 3300, '8': 3800, '10': 4500, '12': 5500, '15': 6800, '20': 8500, '25': 10300, '30': 12000 },
    '720': { '4': 3500, '5': 4300, '6': 4800, '8': 5800, '10': 7500, '12': 8800, '15': 10300, '20': 12900, '25': 15500, '30': 18000 },
    '1080': { '4': 5100, '5': 6300, '6': 7000, '8': 8300, '10': 10500, '12': 12500, '15': 15000, '20': 19000, '25': 23000, '30': 27000 },
  },
  'Seedance 2.0': {
    '480': { '4': 2000, '5': 2500, '6': 2900, '8': 3500, '10': 4000, '12': 5000, '15': 6000 },
    '720': { '4': 2800, '5': 3500, '6': 4000, '8': 5000, '10': 6500, '12': 7500, '15': 9000 },
    '1080': { '4': 4000, '5': 5000, '6': 5500, '8': 6500, '10': 8500, '12': 10000, '15': 12500 },
  },
  'Seedance 2.0 Mini': {
    '480': { '4': 1600, '5': 2000, '6': 2400, '8': 3000, '10': 3500, '12': 4500, '15': 5500 },
    '720': { '4': 2400, '5': 3000, '6': 3500, '8': 4500, '10': 5500, '12': 6500, '15': 8000 },
  },
  'Veo 3.1 Fast': {
    '720': { '8': 11500 },
    '1080': { '8': 15000 },
  },
};

const FALLBACK_VIDEO_HD: VideoPriceTable = {
  'Seedance 2.5': {
    '720': { '4': 6000, '5': 8000, '8': 10000, '10': 13000, '12': 15500, '15': 18000, '20': 22000, '30': 31000 },
    '1080': { '4': 9500, '5': 11500, '8': 15500, '10': 19500, '12': 23000, '15': 27000, '20': 33500, '30': 46500 },
  },
};

const FALLBACK_IMAGE_VND: Record<string, number> = {
  'Seedream 4.0S': 400,
  'Seedream 5.0': 500,
  'GPT Image 2.5': 700,
  'Nano Banana 2.1': 700,
  'Seedream 5.5': 800,
  'Nano Banana 2': 800,
  'Seedream 5.0 Pro': 900,
  'Nano Banana Pro': 1000,
  'GPT Image 2': 1100,
};

interface SdbLivePricing {
  at: number;
  fast: VideoPriceTable;
  hd: VideoPriceTable;
  images: Record<string, number>;
  upscale: { to720: number; to1080: number; minJob: number };
}

let liveCache: SdbLivePricing | null = null;

async function getLivePricing(cfg: AiProviderConfig, force = false): Promise<SdbLivePricing> {
  if (!force && liveCache && Date.now() - liveCache.at < 120_000) return liveCache;
  if (!str(cfg.apiKey).trim()) {
    return (
      liveCache ?? {
        at: 0,
        fast: FALLBACK_VIDEO_FAST,
        hd: FALLBACK_VIDEO_HD,
        images: FALLBACK_IMAGE_VND,
        upscale: { to720: 150, to1080: 300, minJob: 2000 },
      }
    );
  }
  try {
    const [{ data: modelsRes }, { data: pricesRes }] = await Promise.all([
      sdbJson<{ models?: any[] }>(cfg, '/v1/models', { timeoutMs: 12_000 }),
      sdbJson<any>(cfg, '/v1/prices', { timeoutMs: 12_000 }),
    ]);
    const fast: VideoPriceTable = structuredClone(FALLBACK_VIDEO_FAST);
    if (pricesRes?.prices && typeof pricesRes.prices === 'object') {
      for (const [mName, byRes] of Object.entries<any>(pricesRes.prices)) {
        if (!byRes || typeof byRes !== 'object') continue;
        fast[mName] ??= {};
        for (const [resK, byDur] of Object.entries<any>(byRes)) {
          if (!byDur || typeof byDur !== 'object') continue;
          fast[mName][resK] = { ...(fast[mName][resK] ?? {}), ...byDur };
        }
      }
    }
    for (const m of modelsRes?.models ?? []) {
      if (!m?.model || !m?.prices) continue;
      fast[m.model] ??= {};
      for (const [resK, byDur] of Object.entries<any>(m.prices)) {
        if (!byDur || typeof byDur !== 'object') continue;
        fast[m.model][resK] = { ...(fast[m.model][resK] ?? {}), ...byDur };
      }
    }
    const hd: VideoPriceTable = structuredClone(FALLBACK_VIDEO_HD);
    if (pricesRes?.hd_prices && typeof pricesRes.hd_prices === 'object') {
      for (const [mName, byRes] of Object.entries<any>(pricesRes.hd_prices)) {
        if (!byRes || typeof byRes !== 'object') continue;
        hd[mName] ??= {};
        for (const [resK, byDur] of Object.entries<any>(byRes)) {
          if (!byDur || typeof byDur !== 'object') continue;
          hd[mName][resK] = { ...(hd[mName][resK] ?? {}), ...byDur };
        }
      }
    }
    const images: Record<string, number> = {
      ...FALLBACK_IMAGE_VND,
      ...(pricesRes?.image_prices && typeof pricesRes.image_prices === 'object' ? pricesRes.image_prices : {}),
    };
    const up = pricesRes?.upscale_prices ?? {};
    liveCache = {
      at: Date.now(),
      fast,
      hd,
      images,
      upscale: {
        to720: Number(up['480_to_720']) || 150,
        to1080: Number(up['480_to_1080']) || 300,
        minJob: Number(up.min_per_job) || 2000,
      },
    };
    return liveCache;
  } catch {
    return (
      liveCache ?? {
        at: Date.now(),
        fast: FALLBACK_VIDEO_FAST,
        hd: FALLBACK_VIDEO_HD,
        images: FALLBACK_IMAGE_VND,
        upscale: { to720: 150, to1080: 300, minJob: 2000 },
      }
    );
  }
}

function interpolatePrice(byDur: Record<string, number> | undefined, sec: number): number | null {
  if (!byDur) return null;
  const direct = Number(byDur[String(sec)]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const pts = Object.entries(byDur)
    .map(([k, v]) => ({ s: Number(k), c: Number(v) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.c) && x.c > 0)
    .sort((a, b) => a.s - b.s);
  if (!pts.length) return null;
  if (sec <= pts[0].s) return pts[0].c;
  if (sec >= pts[pts.length - 1].s) return pts[pts.length - 1].c;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (sec >= a.s && sec <= b.s) {
      const t = (sec - a.s) / (b.s - a.s);
      return Math.round((a.c + t * (b.c - a.c)) / 100) * 100;
    }
  }
  return pts[0].c;
}

// ---------------- Cấu hình 16 sản phẩm trên SV18 ----------------

const VID_RATIOS = opts([
  ['9:16', '9:16 (Dọc)'],
  ['16:9', '16:9 (Ngang)'],
  ['1:1', '1:1 (Vuông)'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['21:9', '21:9 (Điện ảnh)'],
  ['auto', 'Tự động theo ảnh'],
]);

const IMG_RATIOS = opts([
  ['1:1', '1:1 (Vuông)'],
  ['16:9', '16:9 (Ngang)'],
  ['9:16', '9:16 (Dọc)'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['3:2', '3:2'],
  ['2:3', '2:3'],
]);

const DUR_4_30 = opts([
  ['4', '4 giây'],
  ['5', '5 giây'],
  ['6', '6 giây'],
  ['8', '8 giây'],
  ['10', '10 giây'],
  ['12', '12 giây'],
  ['15', '15 giây'],
  ['20', '20 giây'],
  ['25', '25 giây'],
  ['30', '30 giây'],
]);

const DUR_4_15 = opts([
  ['4', '4 giây'],
  ['5', '5 giây'],
  ['6', '6 giây'],
  ['8', '8 giây'],
  ['10', '10 giây'],
  ['12', '12 giây'],
  ['15', '15 giây'],
]);

const IMAGE_MODES = opts([
  ['reference', 'Ảnh tham chiếu đồng nhất (@Image1, @Image2...)'],
  ['first_frame', 'Khung hình đầu tiên (1 ảnh)'],
  ['first_last', 'Khung đầu & khung cuối (2 ảnh)'],
]);

interface SdbVideoSpec {
  kind: 'video';
  key: string;
  name: string;
  description: string;
  upstreamModel: string;
  speed: 'fast' | 'hd';
  resolutions: [string, string][];
  defaultRes: string;
  durations: AiFieldOption[];
  defaultDur: string;
  maxImages: number;
  allowMediaRefs: boolean;
  badge?: string;
}

interface SdbImageSpec {
  kind: 'image';
  key: string;
  name: string;
  description: string;
  upstreamModel: string;
}

interface SdbUpscaleSpec {
  kind: 'upscale';
  key: string;
  name: string;
  description: string;
}

type SdbSpec = SdbVideoSpec | SdbImageSpec | SdbUpscaleSpec;

const SPECS: SdbSpec[] = [
  {
    kind: 'video',
    key: 'seedance-2.5',
    name: 'Seedance 2.5 Video (480p – 1080p · 4s–30s · Tới 30 ảnh)',
    description: 'Tạo video Seedance 2.5 từ 4–30 giây có âm thanh tự động, hỗ trợ tới 30 ảnh tham chiếu (@Image1..@Image30), video tham chiếu tới 30s và âm thanh mẫu.',
    upstreamModel: 'Seedance 2.5',
    speed: 'fast',
    resolutions: [
      ['480p', '480p SD (Siêu tiết kiệm)'],
      ['720p', '720p HD (Chuẩn nét)'],
      ['1080p', '1080p Full HD'],
    ],
    defaultRes: '720p',
    durations: DUR_4_30,
    defaultDur: '5',
    maxImages: 30,
    allowMediaRefs: true,
    badge: 'HOT',
  },
  {
    kind: 'video',
    key: 'seedance-2.5-flash',
    name: 'Seedance 2.5 Flash Video (480p – 1080p · 4s–30s · Tốc độ nhanh)',
    description: 'Tạo video Seedance 2.5 Flash tốc độ cao dài 4–30 giây có âm thanh, hỗ trợ tới 10 ảnh tham chiếu cùng video và âm thanh mẫu.',
    upstreamModel: 'Seedance 2.5 Flash',
    speed: 'fast',
    resolutions: [
      ['480p', '480p SD (Siêu tiết kiệm)'],
      ['720p', '720p HD (Chuẩn nét)'],
      ['1080p', '1080p Full HD'],
    ],
    defaultRes: '720p',
    durations: DUR_4_30,
    defaultDur: '5',
    maxImages: 10,
    allowMediaRefs: true,
    badge: 'NHANH',
  },
  {
    kind: 'video',
    key: 'seedance-2.5-ultra',
    name: 'Seedance 2.5 Ultra HD (720p / 1080p · Cụm nhanh 4–8 phút)',
    description: 'Cụm máy chủ Ultra ưu tiên tốc độ kết xuất 4–8 phút và độ sắc nét cao nhất cho Seedance 2.5 (720p / 1080p, 4s–30s).',
    upstreamModel: 'Seedance 2.5',
    speed: 'hd',
    resolutions: [
      ['720p', '720p HD Ultra'],
      ['1080p', '1080p Full HD Ultra'],
    ],
    defaultRes: '720p',
    durations: DUR_4_30,
    defaultDur: '5',
    maxImages: 30,
    allowMediaRefs: true,
  },
  {
    kind: 'video',
    key: 'seedance-2.0',
    name: 'Seedance 2.0 Video (480p – 1080p · 4s–15s)',
    description: 'Tạo video Seedance 2.0 dài 4–15 giây có âm thanh, hỗ trợ tới 9 ảnh tham chiếu và video/âm thanh mẫu.',
    upstreamModel: 'Seedance 2.0',
    speed: 'fast',
    resolutions: [
      ['480p', '480p SD'],
      ['720p', '720p HD'],
      ['1080p', '1080p Full HD'],
    ],
    defaultRes: '720p',
    durations: DUR_4_15,
    defaultDur: '5',
    maxImages: 9,
    allowMediaRefs: true,
  },
  {
    kind: 'video',
    key: 'seedance-2.0-mini',
    name: 'Seedance 2.0 Mini Video (480p / 720p · 4s–15s)',
    description: 'Phiên bản Seedance 2.0 Mini tiết kiệm chi phí (480p / 720p, 4–15 giây, hỗ trợ tới 9 ảnh tham chiếu).',
    upstreamModel: 'Seedance 2.0 Mini',
    speed: 'fast',
    resolutions: [
      ['480p', '480p SD'],
      ['720p', '720p HD'],
    ],
    defaultRes: '720p',
    durations: DUR_4_15,
    defaultDur: '5',
    maxImages: 9,
    allowMediaRefs: true,
  },
  {
    kind: 'video',
    key: 'veo-3.1-fast',
    name: 'Google Veo 3.1 Fast (8s · 720p / 1080p)',
    description: 'Tạo video Google Veo 3.1 Fast thời lượng 8 giây có âm thanh.',
    upstreamModel: 'Veo 3.1 Fast',
    speed: 'fast',
    resolutions: [
      ['720p', '720p HD'],
      ['1080p', '1080p Full HD'],
    ],
    defaultRes: '720p',
    durations: opts([['8', '8 giây']]),
    defaultDur: '8',
    maxImages: 2,
    allowMediaRefs: false,
  },
  // 9 model Tạo & Sửa ảnh
  {
    kind: 'image',
    key: 'gpt-image-2.5',
    name: 'Tạo & Sửa ảnh GPT Image 2.5',
    description: 'Tạo hoặc chỉnh sửa ảnh chất lượng cao với GPT Image 2.5 (hỗ trợ tối đa 6 ảnh tham chiếu, xuất 1–4 ảnh PNG).',
    upstreamModel: 'GPT Image 2.5',
  },
  {
    kind: 'image',
    key: 'gpt-image-2',
    name: 'Tạo & Sửa ảnh GPT Image 2',
    description: 'Tạo hoặc chỉnh sửa ảnh với GPT Image 2 (hỗ trợ tới 6 ảnh tham chiếu, xuất 1–4 ảnh PNG).',
    upstreamModel: 'GPT Image 2',
  },
  {
    kind: 'image',
    key: 'nano-banana-pro',
    name: 'Tạo & Sửa ảnh Nano Banana Pro',
    description: 'Tạo và ghép ảnh độ chi tiết cao với Nano Banana Pro (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Nano Banana Pro',
  },
  {
    kind: 'image',
    key: 'nano-banana-2.1',
    name: 'Tạo & Sửa ảnh Nano Banana 2.1',
    description: 'Tạo và biến đổi ảnh nhanh với Nano Banana 2.1 (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Nano Banana 2.1',
  },
  {
    kind: 'image',
    key: 'nano-banana-2',
    name: 'Tạo & Sửa ảnh Nano Banana 2',
    description: 'Tạo và ghép ảnh với Nano Banana 2 (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Nano Banana 2',
  },
  {
    kind: 'image',
    key: 'seedream-5.5',
    name: 'Tạo & Sửa ảnh Seedream 5.5',
    description: 'Tạo ảnh nghệ thuật và chân dung sắc nét với Seedream 5.5 (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Seedream 5.5',
  },
  {
    kind: 'image',
    key: 'seedream-5.0-pro',
    name: 'Tạo & Sửa ảnh Seedream 5.0 Pro',
    description: 'Tạo ảnh chất lượng cao với Seedream 5.0 Pro (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Seedream 5.0 Pro',
  },
  {
    kind: 'image',
    key: 'seedream-5.0',
    name: 'Tạo & Sửa ảnh Seedream 5.0',
    description: 'Tạo ảnh đa phong cách với Seedream 5.0 (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Seedream 5.0',
  },
  {
    kind: 'image',
    key: 'seedream-4.0s',
    name: 'Tạo & Sửa ảnh Seedream 4.0S',
    description: 'Tạo ảnh tốc độ nhanh với Seedream 4.0S (hỗ trợ tới 6 ảnh tham chiếu).',
    upstreamModel: 'Seedream 4.0S',
  },
  // Nâng nét Video
  {
    kind: 'upscale',
    key: 'upscale-video',
    name: 'Nâng nét Video AI 720p / 1080p (Tối đa 60 giây)',
    description: 'Nâng độ phân giải và làm nét video từ 480p lên 720p / 1080p hoặc từ 720p lên 1080p (tối đa 60 giây).',
  },
];

function buildToolDef(spec: SdbSpec): AiToolDef {
  if (spec.kind === 'video') {
    const fields: AiFieldDef[] = [
      {
        name: 'prompt',
        label: 'Mô tả video',
        type: 'textarea',
        required: true,
        max: 30_000,
        placeholder: 'Mô tả chi tiết cảnh quay, chuyển động... (Nếu đính kèm ảnh tham chiếu, gọi @Image1, @Image2... trong mô tả)',
      },
      {
        name: 'images',
        label: `Ảnh tham chiếu / Khung hình (tuỳ chọn, tối đa ${spec.maxImages} ảnh)`,
        type: 'image',
        multiple: true,
        maxFiles: spec.maxImages,
        accept: IMG_ACCEPT,
      },
      {
        name: 'imageMode',
        label: 'Chế độ dùng ảnh',
        type: 'select',
        default: 'reference',
        options: IMAGE_MODES,
      },
      ...(spec.allowMediaRefs
        ? ([
            {
              name: 'video',
              label: 'Video tham chiếu (tuỳ chọn, 2s–15s/30s)',
              type: 'video',
              accept: VID_ACCEPT,
            },
            {
              name: 'audioFile',
              label: 'Âm thanh tham chiếu (tuỳ chọn, 2s–15s)',
              type: 'audio',
              accept: AUD_ACCEPT,
            },
          ] as AiFieldDef[])
        : []),
      {
        name: 'resolution',
        label: 'Chất lượng',
        type: 'select',
        required: true,
        default: spec.defaultRes,
        options: opts(spec.resolutions),
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        required: true,
        default: spec.defaultDur,
        options: spec.durations,
      },
      {
        name: 'ratio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        default: '9:16',
        options: VID_RATIOS,
      },
      {
        name: 'audio',
        label: 'Tạo âm thanh tự động',
        type: 'boolean',
        default: true,
      },
    ];
    return {
      key: spec.key,
      name: spec.name,
      category: 'video',
      icon: 'Video',
      badge: spec.badge,
      description: spec.description,
      output: 'video',
      splitModels: false,
      supportsCost: true,
      pricing: { mode: 'cost', markup: 28 },
      fields,
    };
  }

  if (spec.kind === 'image') {
    return {
      key: spec.key,
      name: spec.name,
      category: 'image',
      icon: 'Image',
      description: spec.description,
      output: 'image',
      splitModels: false,
      supportsCost: true,
      unitLabel: 'ảnh',
      pricing: { mode: 'cost', markup: 28 },
      fields: [
        {
          name: 'prompt',
          label: 'Mô tả ảnh',
          type: 'textarea',
          required: true,
          max: 30_000,
          placeholder: 'Mô tả bức ảnh cần tạo (hoặc cách chỉnh sửa ảnh tham chiếu)...',
        },
        {
          name: 'images',
          label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 6 ảnh)',
          type: 'image',
          multiple: true,
          maxFiles: 6,
          accept: IMG_ACCEPT,
        },
        {
          name: 'ratio',
          label: 'Tỉ lệ khung hình',
          type: 'select',
          default: '1:1',
          options: IMG_RATIOS,
        },
        {
          name: 'count',
          label: 'Số lượng ảnh',
          type: 'select',
          default: '1',
          options: opts([
            ['1', '1 ảnh'],
            ['2', '2 ảnh'],
            ['3', '3 ảnh'],
            ['4', '4 ảnh'],
          ]),
        },
      ],
    };
  }

  return {
    key: spec.key,
    name: spec.name,
    category: 'video',
    icon: 'Sparkles',
    description: spec.description,
    output: 'video',
    splitModels: false,
    supportsCost: true,
    pricing: { mode: 'cost', markup: 28 },
    fields: [
      {
        name: 'video',
        label: 'Video cần nâng nét (480p / 720p · Tối đa 60 giây)',
        type: 'video',
        required: true,
        accept: VID_ACCEPT,
      },
      {
        name: 'target',
        label: 'Độ phân giải đích',
        type: 'select',
        required: true,
        default: '1080',
        options: opts([
          ['1080', '1080p Full HD'],
          ['720', '720p HD'],
        ]),
      },
    ],
  };
}

const TOOLS: AiToolDef[] = SPECS.map(buildToolDef);

async function encodeDataUri(
  ctx: AiCallContext,
  rawUrl: string,
  fallbackMime: string,
  standardizeImg = false,
): Promise<string> {
  const target = standardizeImg && ctx.ensureStandardImage ? await ctx.ensureStandardImage(rawUrl) : rawUrl;
  const loaded = await loadInputFile(ctx.readUpload, target);
  const mime = loaded.mimeType || fallbackMime;
  return `data:${mime};base64,${loaded.data.toString('base64')}`;
}

export const seedancebotProvider: AiProvider = {
  key: 'seedancebot',
  name: 'Seedance Studio (seedancecreationbot.online)',
  website: 'https://seedancecreationbot.online',
  tools: TOOLS,
  costUnit: 'VNĐ',
  rate: 1,

  async balance(ctx) {
    if (!str(ctx.config.apiKey).trim()) return null;
    const { data } = await sdbJson<{ balance?: number }>(ctx.config, '/v1/me', { timeoutMs: 12_000 });
    const bal = Number(data?.balance);
    return Number.isFinite(bal) ? { balance: Math.max(0, bal), unit: 'VNĐ' } : null;
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    const live = await getLivePricing(ctx.config);
    const items: AiCatalogItem[] = [];
    for (const m of Object.keys(live.fast)) items.push({ id: `video:${m}`, label: m });
    for (const m of Object.keys(live.images)) items.push({ id: `image:${m}`, label: m });
    items.push({ id: 'upscale:1080', label: 'Video Upscale 1080p' });
    return items;
  },

  async discoverTools(ctx) {
    if (!str(ctx.config.apiKey).trim()) return { addedTools: [], removedKeys: [] };
    const live = await getLivePricing(ctx.config, true);
    const removedKeys: string[] = [];

    const liveVidCount = Object.keys(live.fast).length + Object.keys(live.hd).length;
    const liveImgCount = Object.keys(live.images).length;
    if (liveVidCount >= 2 && liveImgCount >= 2) {
      for (let i = SPECS.length - 1; i >= 0; i--) {
        const s = SPECS[i];
        if (s.kind === 'upscale') continue;
        const alive =
          s.kind === 'video'
            ? Boolean((s.speed === 'hd' ? live.hd : live.fast)[s.upstreamModel])
            : Boolean(live.images[s.upstreamModel]);
        if (!alive) {
          SPECS.splice(i, 1);
          const tIdx = TOOLS.findIndex((t) => t.key === s.key);
          if (tIdx >= 0) TOOLS.splice(tIdx, 1);
          removedKeys.push(`seedancebot.${s.key}`);
        }
      }
    }

    const coveredVid = new Set(SPECS.filter((s): s is SdbVideoSpec => s.kind === 'video' && s.speed === 'fast').map((s) => s.upstreamModel));
    const coveredImg = new Set(SPECS.filter((s): s is SdbImageSpec => s.kind === 'image').map((s) => s.upstreamModel));
    const usedKeys = new Set(TOOLS.map((t) => t.key));
    const addedTools: AiToolDef[] = [];

    const makeKey = (raw: string, prefix: string) => {
      const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const k = usedKeys.has(slug) ? `${prefix}-${slug}` : slug;
      usedKeys.add(k);
      return k;
    };

    for (const [mName, byRes] of Object.entries(live.fast)) {
      if (coveredVid.has(mName)) continue;
      const resNums = Object.keys(byRes).filter((r) => Object.keys(byRes[r] ?? {}).length > 0);
      if (!resNums.length) continue;
      const allDurs = [...new Set(resNums.flatMap((r) => Object.keys(byRes[r] ?? {}).map(Number)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
      if (!allDurs.length) continue;
      const defRes = resNums.includes('720') ? '720p' : `${resNums[0]}p`;
      const defDur = allDurs.includes(5) ? '5' : String(allDurs[0]);
      const spec: SdbVideoSpec = {
        kind: 'video',
        key: makeKey(mName, 'vid'),
        name: `${mName} Video`,
        description: `Tạo video AI bằng model ${mName}.`,
        upstreamModel: mName,
        speed: 'fast',
        resolutions: resNums.map((r): [string, string] => [`${r}p`, `${r}p`]),
        defaultRes: defRes,
        durations: allDurs.map((d) => ({ value: String(d), label: `${d} giây` })),
        defaultDur: defDur,
        maxImages: 9,
        allowMediaRefs: /seedance/i.test(mName),
      };
      SPECS.push(spec);
      const def = buildToolDef(spec);
      TOOLS.push(def);
      addedTools.push(def);
    }

    for (const [mName, price] of Object.entries(live.images)) {
      if (coveredImg.has(mName) || !(Number(price) > 0)) continue;
      const spec: SdbImageSpec = {
        kind: 'image',
        key: makeKey(mName, 'img'),
        name: `Tạo & Sửa ảnh ${mName}`,
        description: `Tạo và chỉnh sửa ảnh AI bằng model ${mName}.`,
        upstreamModel: mName,
      };
      SPECS.push(spec);
      const def = buildToolDef(spec);
      TOOLS.push(def);
      addedTools.push(def);
    }

    return { addedTools, removedKeys };
  },

  async cost(tool, input, ctx) {
    const spec = SPECS.find((s) => s.key === tool.key);
    if (!spec) return null;
    const live = await getLivePricing(ctx.config, Boolean(input.__fresh));

    if (spec.kind === 'video') {
      const resNum = str(input.resolution || spec.defaultRes).replace(/p$/i, '');
      const dur = Math.max(4, Math.min(30, parseInt(str(input.duration || spec.defaultDur), 10) || Number(spec.defaultDur)));
      const table = spec.speed === 'hd' ? live.hd : live.fast;
      const byRes = table[spec.upstreamModel]?.[resNum] ?? table[spec.upstreamModel]?.['720'];
      return interpolatePrice(byRes, dur);
    }

    if (spec.kind === 'image') {
      const unit = live.images[spec.upstreamModel] ?? FALLBACK_IMAGE_VND[spec.upstreamModel] ?? 800;
      const n = Math.max(1, Math.min(4, parseInt(str(input.count || '1'), 10) || 1));
      return unit * n;
    }

    const target = str(input.target || '1080') === '720' ? 720 : 1080;
    let sec = 10;
    const vidUrl = str(input.video).trim();
    if (vidUrl && !input.__sample) {
      const measured = await ctx.uploadDuration(vidUrl);
      if (measured && measured > 0) sec = Math.min(60, Math.max(1, Math.ceil(measured)));
    }
    const perSec = target === 720 ? live.upscale.to720 : live.upscale.to1080;
    return Math.max(live.upscale.minJob, Math.ceil((sec * perSec) / 100) * 100);
  },

  async submit(tool, input: AiInput, ctx: AiCallContext): Promise<AiProviderResult> {
    const spec = SPECS.find((s) => s.key === tool.key);
    if (!spec) throw new BadRequestException(`Không tìm thấy cấu hình công cụ ${tool.key}`);

    if (spec.kind === 'video') {
      const prompt = str(input.prompt).trim();
      if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả video');

      const rawImgs = Array.isArray(input.images) ? input.images : input.images ? [input.images] : [];
      const imgList = rawImgs.map((x) => str(x).trim()).filter(Boolean).slice(0, spec.maxImages);
      const imageMode = str(input.imageMode || 'reference');
      if (imageMode === 'first_frame' && imgList.length !== 1) {
        throw new BadRequestException('Chế độ Khung hình đầu tiên yêu cầu đúng 1 ảnh');
      }
      if (imageMode === 'first_last' && imgList.length !== 2) {
        throw new BadRequestException('Chế độ Khung đầu & khung cuối yêu cầu đúng 2 ảnh');
      }

      const vidRef = spec.allowMediaRefs ? str(input.video).trim() : '';
      const audRef = spec.allowMediaRefs ? str(input.audioFile).trim() : '';
      if (imageMode !== 'reference' && (vidRef || audRef)) {
        throw new BadRequestException('Chế độ Khung đầu / cuối không dùng kèm video hoặc âm thanh tham chiếu (hãy chuyển sang chế độ Ảnh tham chiếu)');
      }
      if (audRef && !imgList.length && !vidRef) {
        throw new BadRequestException('Âm thanh tham chiếu cần kèm ít nhất 1 ảnh hoặc 1 video tham chiếu');
      }

      const encodedImgs: string[] = [];
      for (const u of imgList) encodedImgs.push(await encodeDataUri(ctx, u, 'image/jpeg', true));

      const resNum = parseInt(str(input.resolution || spec.defaultRes).replace(/p$/i, ''), 10) || 720;
      const dur = Math.max(4, Math.min(30, parseInt(str(input.duration || spec.defaultDur), 10) || Number(spec.defaultDur)));
      const ratio = str(input.ratio || '9:16');
      const withAudio = input.audio !== false && input.audio !== 'false';

      const payload: Record<string, unknown> = {
        prompt,
        model: spec.upstreamModel,
        duration: dur,
        resolution: resNum,
        ratio,
        audio: withAudio,
        speed: spec.speed,
        image_mode: imageMode,
      };
      if (encodedImgs.length) payload.images = encodedImgs;
      if (vidRef) payload.reference_video = await encodeDataUri(ctx, vidRef, 'video/mp4', false);
      if (audRef) payload.reference_audio = await encodeDataUri(ctx, audRef, 'audio/mpeg', false);

      const { data } = await sdbJson<any>(ctx.config, '/v1/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 90_000,
      });
      const id = str(data?.id || data?.order_id);
      if (!id) throw new AiProviderError('Không nhận được mã tác vụ từ máy chủ xử lý', { data }, true);
      return { status: 'processing', providerTaskId: `vid:${id}`, progress: 5, raw: data };
    }

    if (spec.kind === 'image') {
      const prompt = str(input.prompt).trim();
      if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả ảnh');
      const rawImgs = Array.isArray(input.images) ? input.images : input.images ? [input.images] : [];
      const imgList = rawImgs.map((x) => str(x).trim()).filter(Boolean).slice(0, 6);
      const encodedImgs: string[] = [];
      for (const u of imgList) encodedImgs.push(await encodeDataUri(ctx, u, 'image/jpeg', true));
      const n = Math.max(1, Math.min(4, parseInt(str(input.count || '1'), 10) || 1));
      const ratio = str(input.ratio || '1:1');

      const { data } = await sdbJson<any>(ctx.config, '/v1/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          model: spec.upstreamModel,
          n,
          ratio,
          ...(encodedImgs.length ? { images: encodedImgs } : {}),
        }),
        timeoutMs: 60_000,
      });
      const id = str(data?.id || data?.job_id);
      if (!id) throw new AiProviderError('Không nhận được mã tác vụ ảnh từ máy chủ xử lý', { data }, true);
      return { status: 'processing', providerTaskId: `img:${id}`, progress: 5, raw: data };
    }

    const vidUrl = str(input.video).trim();
    if (!vidUrl) throw new BadRequestException('Vui lòng tải lên video cần nâng nét');
    const measured = await ctx.uploadDuration(vidUrl);
    if (measured && measured > 60.5) {
      throw new BadRequestException(`Video dài ${measured.toFixed(1)}s — công cụ này hỗ trợ tối đa 60 giây`);
    }
    const target = str(input.target || '1080') === '720' ? 720 : 1080;
    const videoData = await encodeDataUri(ctx, vidUrl, 'video/mp4', false);
    const { data } = await sdbJson<any>(ctx.config, '/v1/upscale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: videoData, target }),
      timeoutMs: 120_000,
    });
    const id = str(data?.id || data?.job_id);
    if (!id) throw new AiProviderError('Không nhận được mã tác vụ nâng nét từ máy chủ xử lý', { data }, true);
    return { status: 'processing', providerTaskId: `up:${id}`, progress: 5, raw: data };
  },

  async poll(tool, providerTaskId: string, ctx: AiCallContext): Promise<AiProviderResult> {
    const [rawPrefix, rawRest] = providerTaskId.includes(':')
      ? (providerTaskId.split(':', 2) as [string, string])
      : [tool.output === 'image' ? 'img' : tool.key === 'upscale-video' ? 'up' : 'vid', providerTaskId];
    const kind = rawPrefix === 'img' || rawPrefix === 'up' ? rawPrefix : 'vid';
    const id = rawRest.trim();

    const statusPath = kind === 'img' ? `/v1/images/${encodeURIComponent(id)}` : kind === 'up' ? `/v1/upscale/${encodeURIComponent(id)}` : `/v1/videos/${encodeURIComponent(id)}`;
    const { data } = await sdbJson<any>(ctx.config, statusPath, { timeoutMs: 30_000 });
    const st = str(data?.status).toLowerCase();

    if (st === 'completed' || st === 'succeeded' || st === 'done') {
      if (kind === 'img') {
        const imgUrls: string[] = Array.isArray(data?.images) && data.images.length
          ? data.images.map((u: unknown) => str(u)).filter(Boolean)
          : Array.from({ length: Math.max(1, Number(data?.n) || 1) }, (_, idx) => `/v1/images/${encodeURIComponent(id)}/file/${idx}`);
        const files: AiOutputFile[] = [];
        for (let i = 0; i < imgUrls.length; i++) {
          const bin = await sdbDownloadBinary(ctx.config, imgUrls[i]);
          const ext = bin.mimeType.includes('webp') ? 'webp' : bin.mimeType.includes('jpeg') ? 'jpg' : 'png';
          files.push({
            url: '',
            type: 'image',
            name: `${id}_${i + 1}.${ext}`,
            data: bin.data,
            mimeType: bin.mimeType || 'image/png',
          });
        }
        return { status: 'succeeded', providerTaskId, progress: 100, files, raw: data };
      }

      const dlPath =
        str(data?.download_url) ||
        (kind === 'up' ? `/v1/upscale/${encodeURIComponent(id)}/file` : `/v1/videos/${encodeURIComponent(id)}/file`);
      const bin = await sdbDownloadBinary(ctx.config, dlPath);
      return {
        status: 'succeeded',
        providerTaskId,
        progress: 100,
        files: [
          {
            url: '',
            type: 'video',
            name: `${id}.mp4`,
            data: bin.data,
            mimeType: 'video/mp4',
          },
        ],
        raw: data,
      };
    }

    if (st === 'failed' || st === 'cancelled' || st === 'canceled' || st === 'rejected' || st === 'error') {
      const errMsg = sanitizeSdbError(data?.error || data?.message || 'Tác vụ không thành công');
      return {
        status: 'failed',
        providerTaskId,
        error: errMsg || 'Tác vụ xử lý thất bại, tiền đã được hoàn lại vào ví.',
        raw: data,
      };
    }

    const pct = Number(data?.progress);
    return {
      status: 'processing',
      providerTaskId,
      progress: Number.isFinite(pct) && pct > 0 ? Math.min(99, pct) : 20,
      raw: data,
    };
  },

  async cancel(tool, providerTaskId: string, ctx: AiCallContext) {
    const [rawPrefix, rawRest] = providerTaskId.includes(':')
      ? (providerTaskId.split(':', 2) as [string, string])
      : [tool.output === 'image' ? 'img' : tool.key === 'upscale-video' ? 'up' : 'vid', providerTaskId];
    const kind = rawPrefix === 'img' || rawPrefix === 'up' ? rawPrefix : 'vid';
    const id = rawRest.trim();
    const delPath =
      kind === 'img'
        ? `/v1/images/${encodeURIComponent(id)}`
        : kind === 'up'
          ? `/v1/upscale/${encodeURIComponent(id)}`
          : `/v1/videos/${encodeURIComponent(id)}`;
    try {
      const { data, status } = await sdbJson<any>(ctx.config, delPath, { method: 'DELETE', timeoutMs: 8_000 });
      return {
        ok: true,
        httpStatus: status,
        upstreamStatus: str(data?.status) || 'cancelled',
        note: 'Đã gửi lệnh huỷ & tự hoàn ví trên SV18',
        raw: data,
      };
    } catch (err) {
      return {
        ok: false,
        upstreamStatus: 'cannot_cancel',
        note: `Không huỷ được đơn trên SV18 (có thể đơn đã bắt đầu render): ${(err as Error).message.slice(0, 120)}`,
      };
    }
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    try {
      const [{ data: modelsRes, status: mStatus }, { data: pricesRes }] = await Promise.all([
        sdbJson<{ models?: any[]; maintenance?: boolean }>(ctx.config, '/v1/models', { timeoutMs: 12_000 }),
        sdbJson<any>(ctx.config, '/v1/prices', { timeoutMs: 12_000 }).catch(() => ({ data: null })),
      ]);
      if (mStatus === 503 || modelsRes?.maintenance === true) return 'ALL';
      const models = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
      if (!models.length && !pricesRes) return null;

      const activeVid = new Set<string>();
      const maintVid = new Set<string>();
      for (const m of models) {
        const name = str(m?.model).trim();
        if (!name) continue;
        const st = str(m?.status).toLowerCase();
        const isMaint = m?.maintenance === true || m?.enabled === false || /maint|off|down|disable/i.test(st);
        if (isMaint) maintVid.add(name);
        else activeVid.add(name);
      }

      const down = new Set<string>();
      for (const spec of SPECS) {
        if (spec.kind === 'video') {
          const inPrices =
            spec.speed === 'hd'
              ? Boolean(pricesRes?.hd_prices?.[spec.upstreamModel])
              : Boolean(pricesRes?.prices?.[spec.upstreamModel]);
          if (maintVid.has(spec.upstreamModel) || (models.length >= 3 && !activeVid.has(spec.upstreamModel) && !inPrices)) {
            down.add(spec.key);
          }
        } else if (spec.kind === 'image' && pricesRes?.image_prices && typeof pricesRes.image_prices === 'object') {
          if (Object.keys(pricesRes.image_prices).length >= 3 && !(spec.upstreamModel in pricesRes.image_prices)) {
            down.add(spec.key);
          }
        }
      }
      return down;
    } catch {
      return null;
    }
  },
};
