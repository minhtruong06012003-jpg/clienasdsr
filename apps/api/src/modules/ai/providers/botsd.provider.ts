import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiCatalogItem,
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
 * BotSD Seedance Workspace — https://botsd.pro (`SV14`)
 * - Xác thực: `apiKey` lưu dạng `username:password` (tự động đăng nhập `POST /api/web/account/login` lấy & giữ phiên `clientToken`)
 *   hoặc dán trực tiếp `clientToken`.
 * - Đơn vị gốc: `Point` (`P`). Tỉ giá an toàn mặc định: `1 Point = 454.55đ` (khớp gói lẻ nhỏ nhất `50.000đ / 110P = 454,55đ/P`;
 *   nếu nạp gói `500k = 416,7đ/P`, `1tr = 384,6đ/P`, `2tr = 363,6đ/P` thì biên lợi nhuận thực tế còn cao hơn nữa).
 * - Tải trực tiếp file MP4 về máy chủ qua `/api/web/video/{id}` để che kín 100% tên/link nguồn.
 * - Tích hợp sẵn `maintenanceCheck()` đồng bộ tự động 2 chiều `globalMaintenance` & `durationModelMaintenance` (T-358).
 */

const DEFAULT_BASE = 'https://botsd.pro';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime';
const AUD_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

interface BotsdToolDef extends AiToolDef {
  modelCode: 'sd25' | 'sd25hd' | 'sd25flash' | 'sd20' | 'muse' | 'seedream-5.5';
}

interface BotsdSessionData {
  clientToken?: string;
  balance?: number;
  mode?: string;
  accountUsername?: string | null;
  globalMaintenance?: boolean;
  durationModelMaintenance?: Record<string, Record<string, boolean>>;
  videoPricing?: Record<string, Record<string, { regular?: number; current?: number }>>;
}

function normalizeBaseUrl(raw?: string): string {
  const trimmed = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_BASE;
}

function sanitizeBotsdError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/insufficient|không đủ point|not enough|hết point|balance/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại.';
  }
  if (/maintenance|bảo trì/i.test(s)) {
    return 'Mô hình này đang tạm bảo trì trên máy chủ xử lý, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại.';
  }
  if (/policy|unsafe|nsfw|vi phạm|kiểm duyệt|người thật/i.test(s)) {
    return 'Nội dung mô tả hoặc ảnh nhân vật chưa phù hợp chính sách kiểm duyệt AI, vui lòng thử chế độ Người thật hoặc đổi ảnh khác. Tiền đã được hoàn lại.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*botsd[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\bbotsd(?:\.pro)?\b/gi, 'Hệ thống AI')
    .replace(/\bPoint\b/gi, 'đơn vị')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const tokenCache = new Map<string, { token: string; at: number }>();
let sessionCache: { key: string; at: number; data: BotsdSessionData } | null = null;

async function ensureClientToken(cfg: AiProviderConfig, forceLogin = false): Promise<string> {
  const rawKey = (cfg.apiKey || '').trim();
  if (!rawKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình thông tin kết nối');
  if (!rawKey.includes(':')) return rawKey;

  const base = normalizeBaseUrl(cfg.baseUrl);
  const cacheKey = `${base}|${rawKey}`;
  const cached = tokenCache.get(cacheKey);
  if (!forceLogin && cached && Date.now() - cached.at < 30 * 60_000) {
    return cached.token;
  }

  const sepIdx = rawKey.indexOf(':');
  const username = rawKey.slice(0, sepIdx).trim();
  const password = rawKey.slice(sepIdx + 1).trim();

  const res = await fetch(`${base}/api/web/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
    body: JSON.stringify({
      clientToken: cached?.token || '',
      language: 'vi',
      username,
      password,
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => {
    throw new AiProviderError('Kết nối máy chủ xử lý tạm gián đoạn, hệ thống sẽ thử lại', { error: e.message }, true);
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.clientToken) {
    throw new AiProviderError(
      sanitizeBotsdError(data?.error || `Không xác thực được phiên kết nối (HTTP ${res.status})`),
      data,
      res.status >= 500,
    );
  }
  const token = String(data.clientToken);
  tokenCache.set(cacheKey, { token, at: Date.now() });
  return token;
}

async function getLiveSession(cfg: AiProviderConfig, force = false): Promise<BotsdSessionData | null> {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const cacheKey = `${base}|${(cfg.apiKey || '').slice(0, 12)}`;
  if (!force && sessionCache && sessionCache.key === cacheKey && Date.now() - sessionCache.at < 3 * 60_000) {
    return sessionCache.data;
  }
  try {
    const token = cfg.apiKey ? await ensureClientToken(cfg, false) : '';
    const res = await fetch(`${base}/api/web/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
      body: JSON.stringify({ clientToken: token, language: 'vi' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return sessionCache?.data ?? null;
    const data = (await res.json()) as BotsdSessionData;
    if (cfg.apiKey?.includes(':') && data.mode !== 'account') {
      const freshToken = await ensureClientToken(cfg, true);
      const res2 = await fetch(`${base}/api/web/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
        body: JSON.stringify({ clientToken: freshToken, language: 'vi' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res2.ok) {
        const data2 = (await res2.json()) as BotsdSessionData;
        sessionCache = { key: cacheKey, at: Date.now(), data: data2 };
        return data2;
      }
    }
    sessionCache = { key: cacheKey, at: Date.now(), data };
    return data;
  } catch {
    return sessionCache?.data ?? null;
  }
}

function upscalePoints(seconds: number, resolution: string): number {
  if (resolution === '1080p' || resolution === '1080p-real') {
    return seconds >= 30 ? 4 : seconds >= 15 ? 2 : 1;
  }
  if (resolution === '4k') {
    return seconds >= 30 ? 6 : seconds >= 15 ? 3 : 2;
  }
  return 0;
}

function basePoints(
  sess: BotsdSessionData | null,
  model: Exclude<BotsdToolDef['modelCode'], 'seedream-5.5'>,
  seconds: number,
): number {
  const liveVal = Number(sess?.videoPricing?.[model]?.[String(seconds)]?.current);
  if (Number.isFinite(liveVal) && liveVal > 0) return liveVal;
  switch (model) {
    case 'sd25':
      return seconds >= 30 ? 50 : seconds >= 15 ? 25 : seconds >= 10 ? 18 : 9;
    case 'sd25hd':
      return seconds >= 30 ? 70 : seconds >= 15 ? 35 : seconds >= 10 ? 24 : 12;
    case 'sd25flash':
      return seconds >= 30 ? 42 : seconds >= 15 ? 21 : seconds >= 10 ? 14 : 7;
    case 'sd20':
      return seconds >= 15 ? 8 : seconds >= 10 ? 6 : 2;
    case 'muse':
      return seconds >= 10 ? 4 : 2;
  }
}

const RATIOS_6 = opts([
  ['9:16', '9:16'],
  ['16:9', '16:9'],
  ['1:1', '1:1'],
  ['3:4', '3:4'],
  ['4:3', '4:3'],
  ['21:9', '21:9'],
]);

const DUR_SD25 = opts([
  ['5', '5s'],
  ['10', '10s'],
  ['15', '15s'],
  ['30', '30s'],
]);

const RES_UPSCALE = opts([
  ['original', '720p (Mặc định)'],
  ['1080p', '1080p (Làm nét)'],
  ['4k', '4K (Làm nét)'],
]);

const TOOLS: BotsdToolDef[] = [
  {
    key: 'seedance-2.5-720p',
    modelCode: 'sd25',
    name: 'Seedance 2.5 Video (720p – 4K · Tới 30s · Siêu Rẻ)',
    category: 'video',
    icon: 'film',
    badge: 'HOT',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.5 tạo video điện ảnh dài 5–30 giây có tiếng, hỗ trợ ghép tới 10 ảnh + video/âm thanh tham chiếu (@image1, @video1, @audio1) và nâng nét tới 4K.',
    output: 'video',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 10)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Gọi @image1, @image2… trong mô tả để giữ đồng nhất khuôn mặt / trang phục / sản phẩm (+0đ phụ phí ảnh)',
      },
      {
        name: 'video',
        label: 'Video tham chiếu chuyển động (tuỳ chọn, tối đa 15s)',
        type: 'video',
        accept: VID_ACCEPT,
        help: 'Nếu đính kèm video tham chiếu, chi phí cộng thêm theo số giây thực tế của video tham chiếu',
      },
      {
        name: 'audio',
        label: 'Âm thanh / giọng nói tham chiếu (tuỳ chọn)',
        type: 'audio',
        accept: AUD_ACCEPT,
        help: 'Đính kèm âm thanh tham chiếu miễn phí phụ phí (+0đ)',
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        max: 15000,
        placeholder: 'Mô tả chi tiết cảnh quay, chuyển động máy quay, lời thoại (gọi @image1, @image2… nếu có ảnh tham chiếu)...',
      },
      { name: 'aspectRatio', label: 'Khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_SD25 },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: 'original', options: RES_UPSCALE },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedance-2.5-1080p',
    modelCode: 'sd25hd',
    name: 'Seedance 2.5 Full HD 1080p Gốc (Tới 30s)',
    category: 'video',
    icon: 'film',
    badge: '1080P',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.5 xuất trực tiếp độ phân giải Full HD 1080p nguyên bản sắc nét dài 5–30 giây có âm thanh, hỗ trợ ảnh/video/audio tham chiếu.',
    output: 'video',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 10)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Gọi @image1, @image2… trong mô tả để giữ đồng nhất nhân vật / sản phẩm',
      },
      {
        name: 'video',
        label: 'Video tham chiếu (tuỳ chọn, tối đa 15s)',
        type: 'video',
        accept: VID_ACCEPT,
      },
      {
        name: 'audio',
        label: 'Âm thanh tham chiếu (tuỳ chọn)',
        type: 'audio',
        accept: AUD_ACCEPT,
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        max: 15000,
        placeholder: 'Mô tả chi tiết cảnh quay Full HD 1080p, ánh sáng, chuyển động...',
      },
      { name: 'aspectRatio', label: 'Khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_SD25 },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedance-2.5-flash',
    modelCode: 'sd25flash',
    name: 'Seedance 2.5 Flash 480p (Tạo Nhanh · Tới 30s)',
    category: 'video',
    icon: 'film',
    badge: 'RẺ',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.5 Flash 480p nguyên bản tạo cực nhanh với chi phí siêu rẻ cho clip 5–30 giây, hỗ trợ tới 10 ảnh + video/audio tham chiếu.',
    output: 'video',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 10)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
      },
      {
        name: 'video',
        label: 'Video tham chiếu (tuỳ chọn, tối đa 15s)',
        type: 'video',
        accept: VID_ACCEPT,
      },
      {
        name: 'audio',
        label: 'Âm thanh tham chiếu (tuỳ chọn)',
        type: 'audio',
        accept: AUD_ACCEPT,
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        max: 15000,
        placeholder: 'Mô tả ý tưởng cảnh quay nhanh (gọi @image1, @image2…)...',
      },
      { name: 'aspectRatio', label: 'Khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_SD25 },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedance-2.0',
    modelCode: 'sd20',
    name: 'Seedance 2.0 (Siêu Rẻ 10s–15s · Hỗ Trợ Ảnh Người Thật)',
    category: 'video',
    icon: 'film',
    badge: 'HOT',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.0 giá siêu hời cho clip 10s & 15s, hỗ trợ tới 10 ảnh tham chiếu kèm chế độ mở khoá ảnh Người thật (Cơ bản / Chuyên sâu) và làm nét 4K.',
    output: 'video',
    fields: [
      {
        name: 'engine',
        label: 'Chế độ ảnh nhân vật',
        type: 'select',
        required: true,
        default: 'none',
        options: opts([
          ['none', 'Tiêu chuẩn'],
          ['rp', 'Người thật Cơ bản'],
          ['rpd', 'Người thật Chuyên sâu'],
        ]),
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tối đa 10 ảnh)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Nếu bật chế độ Người thật, bắt buộc tải lên ít nhất 1 ảnh nhân vật rõ mặt',
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        max: 15000,
        placeholder: 'Mô tả chuyển động nhân vật @image1, bối cảnh, góc máy...',
      },
      { name: 'aspectRatio', label: 'Khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '10', options: opts([['10', '10s'], ['15', '15s']]) },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: 'original', options: RES_UPSCALE },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'muse-ai',
    modelCode: 'muse',
    name: 'Muse AI Video (5s & 10s · Siêu Tiết Kiệm)',
    category: 'video',
    icon: 'film',
    badge: 'RẺ',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Tạo video Muse AI nhanh 5s & 10s chi phí cực rẻ từ văn bản hoặc ảnh khung hình đầu, hỗ trợ nâng nét tới 4K.',
    output: 'video',
    fields: [
      {
        name: 'image',
        label: 'Ảnh khung hình đầu (tuỳ chọn)',
        type: 'image',
        accept: IMG_ACCEPT,
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả cảnh quay, ánh sáng và chuyển động...',
      },
      { name: 'aspectRatio', label: 'Khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: opts([['5', '5s'], ['10', '10s']]) },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: 'original', options: RES_UPSCALE },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
  {
    key: 'seedream-5.5',
    modelCode: 'seedream-5.5',
    name: 'Seedream 5.5 — Tạo & Ghép Ảnh AI 2K Đa Tham Chiếu',
    category: 'image',
    icon: 'image',
    badge: 'SV14',
    featured: true,
    supportsCost: true,
    unitLabel: 'ảnh',
    description: 'Tạo & chỉnh sửa ảnh Seedream 5.5 sắc nét 1.5K / 2K, hỗ trợ tới 10 ảnh tham chiếu đồng nhất nhân vật, trang phục & sản phẩm với 15 tỉ lệ khung hình.',
    output: 'image',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 10 ảnh)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Tải lên tối đa 10 ảnh tham chiếu nhân vật, sản phẩm hoặc phong cách cần giữ đồng nhất',
      },
      {
        name: 'prompt',
        label: 'Mô tả hình ảnh (Prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả chi tiết hình ảnh bạn muốn tạo hoặc chỉnh sửa...',
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '1:1',
        options: opts([
          ['1:1', '1:1 (Vuông)'],
          ['9:16', '9:16 (Dọc)'],
          ['16:9', '16:9 (Ngang)'],
          ['3:4', '3:4'],
          ['4:3', '4:3'],
          ['2:3', '2:3'],
          ['3:2', '3:2'],
          ['4:5', '4:5 (Chân dung MXH)'],
          ['5:4', '5:4'],
          ['1:2', '1:2'],
          ['2:1', '2:1'],
          ['9:21', '9:21'],
          ['21:9', '21:9 (Điện ảnh)'],
          ['1:3', '1:3'],
          ['3:1', '3:1'],
        ]),
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '1.5k',
        options: opts([
          ['1.5k', '1.5K (Tiêu chuẩn · Tiết kiệm)'],
          ['2k', '2K (Siêu nét)'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 200 },
  },
];

async function encodeRefItem(
  ctx: AiCallContext,
  url: string,
  idx: number,
  durationSec = 0,
): Promise<{ clientId: string; name: string; type: string; durationMs: number; data: string }> {
  const f = await loadInputFile(ctx.readUpload, url);
  return {
    clientId: `webimg_${idx + 1}`,
    name: f.filename || `ref_${idx + 1}`,
    type: f.mimeType || 'image/jpeg',
    durationMs: Math.round(Math.max(0, durationSec) * 1000),
    data: f.data.toString('base64'),
  };
}

export const botsdProvider: AiProvider = {
  key: 'botsd',
  name: 'BotSD · Seedance 2.5 & 2.0 (botsd.pro)',
  website: 'https://botsd.pro',
  tools: TOOLS,
  costUnit: 'point',
  // Mốc an toàn 454,55đ/Point (gói nhỏ nhất 50.000đ / 110P = 454,55đ; gói 500k = 416,7đ, 1tr = 384,6đ, 2tr = 363,6đ)
  rate: 454.55,

  async cost(tool, input, ctx) {
    const t = tool as BotsdToolDef;
    if (t.modelCode === 'seedream-5.5') {
      const imgRes = str(input.resolution || '1.5k').toLowerCase();
      return imgRes === '2k' ? 2 : 1;
    }
    const sess = await getLiveSession(ctx.config);
    const sec = Number(str(input.duration).replace(/s$/i, '')) || (t.modelCode === 'sd20' ? 10 : 5);
    const fixedRes = t.modelCode === 'sd25hd' || t.modelCode === 'sd25flash';
    const res = fixedRes ? 'original' : str(input.resolution) || 'original';

    const base = basePoints(sess, t.modelCode, sec);
    let points = base;

    const is25 = t.modelCode === 'sd25' || t.modelCode === 'sd25hd' || t.modelCode === 'sd25flash';
    if (is25 && str(input.video) && input.__sample !== true) {
      const probed = await ctx.uploadDuration(str(input.video));
      if (probed !== null && Number.isFinite(probed) && probed > 0) {
        if (probed > 15.5) throw new BadRequestException(`Video tham chiếu dài ${probed.toFixed(1)}s — tối đa 15 giây`);
        points = Math.ceil((base * (sec + probed)) / sec);
      }
    }

    const upscale = fixedRes ? 0 : upscalePoints(sec, res);
    const rpMode = t.modelCode === 'sd20' ? str(input.engine) : 'none';
    const rpExtra = rpMode === 'rpd' ? 2 : rpMode === 'rp' ? 1 : 0;

    return points + upscale + rpExtra;
  },

  async submit(tool, input, ctx) {
    const t = tool as BotsdToolDef;
    const base = normalizeBaseUrl(ctx.config.baseUrl);

    const rawImgs = Array.isArray(input.images)
      ? input.images.map(str).filter(Boolean)
      : str(input.images)
        ? [str(input.images)]
        : str(input.image)
          ? [str(input.image)]
          : [];

    if (t.modelCode === 'seedream-5.5') {
      const prompt = str(input.prompt).trim();
      if (!prompt) throw new BadRequestException('Vui lòng nhập mô tả hình ảnh');
      const encodedRefs: { clientId: string; name: string; type: string; durationMs: number; data: string }[] = [];
      for (let i = 0; i < Math.min(rawImgs.length, 10); i++) {
        encodedRefs.push(await encodeRefItem(ctx, rawImgs[i], encodedRefs.length, 0));
      }
      const ratio = str(input.aspectRatio) || '1:1';
      const resolution = str(input.resolution || '1.5k').toLowerCase() === '2k' ? '2k' : '1.5k';

      const doImageCreate = async (token: string) => {
        const res = await fetch(`${base}/api/web/image/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
          body: JSON.stringify({
            clientToken: token,
            language: 'vi',
            prompt,
            images: encodedRefs,
            model: 'seedream-5.5',
            ratio,
            resolution,
            quality: 'medium',
          }),
          signal: AbortSignal.timeout(90_000),
        });
        const data: any = await res.json().catch(() => ({}));
        return { res, data };
      };

      let token = await ensureClientToken(ctx.config, false);
      let { res, data } = await doImageCreate(token);
      if (!res.ok && ctx.config.apiKey?.includes(':') && /login|guest|session|token|401|403/i.test(String(data?.error ?? ''))) {
        token = await ensureClientToken(ctx.config, true);
        ({ res, data } = await doImageCreate(token));
      }

      if (!res.ok || !data?.job?.id) {
        throw new AiProviderError(
          sanitizeBotsdError(data?.error || `Không khởi tạo được tác vụ tạo ảnh (HTTP ${res.status})`),
          data,
          res.status >= 500 || res.status === 429,
        );
      }

      return {
        status: 'processing',
        providerTaskId: `img:${String(data.job.id)}`,
        progress: 5,
        raw: { jobId: data.job.id },
      };
    }

    const sec = Number(str(input.duration).replace(/s$/i, '')) || (t.modelCode === 'sd20' ? 10 : 5);
    const fixedRes = t.modelCode === 'sd25hd' || t.modelCode === 'sd25flash';
    const resolution = fixedRes ? 'original' : str(input.resolution) || 'original';
    const ratio = str(input.aspectRatio) || '9:16';

    const rpMode = t.modelCode === 'sd20' ? str(input.engine) : 'none';
    const realPersonDeepMode = rpMode === 'rpd';
    const realPersonMode = rpMode === 'rp' || realPersonDeepMode;
    if (realPersonMode && rawImgs.length === 0) {
      throw new BadRequestException('Chế độ Người thật yêu cầu tải lên ít nhất 1 ảnh nhân vật');
    }

    const encodedRefs: { clientId: string; name: string; type: string; durationMs: number; data: string }[] = [];
    for (let i = 0; i < Math.min(rawImgs.length, 10); i++) {
      encodedRefs.push(await encodeRefItem(ctx, rawImgs[i], encodedRefs.length, 0));
    }

    const is25 = t.modelCode === 'sd25' || t.modelCode === 'sd25hd' || t.modelCode === 'sd25flash';
    if (is25 && str(input.video)) {
      const vDur = (await ctx.uploadDuration(str(input.video))) ?? 5;
      if (vDur > 15.5) throw new BadRequestException(`Video tham chiếu dài ${vDur.toFixed(1)}s — tối đa 15 giây`);
      encodedRefs.push(await encodeRefItem(ctx, str(input.video), encodedRefs.length, vDur));
    }
    if (is25 && str(input.audio)) {
      const aDur = (await ctx.uploadDuration(str(input.audio))) ?? 5;
      encodedRefs.push(await encodeRefItem(ctx, str(input.audio), encodedRefs.length, aDur));
    }

    const doCreate = async (token: string) => {
      const res = await fetch(`${base}/api/web/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
        body: JSON.stringify({
          clientToken: token,
          language: 'vi',
          prompt: str(input.prompt),
          images: encodedRefs,
          seconds: sec,
          model: t.modelCode,
          ratio,
          resolution,
          realPersonMode,
          realPersonDeepMode,
          promptImageMode: false,
          highSpeedVideo: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const data: any = await res.json().catch(() => ({}));
      return { res, data };
    };

    let token = await ensureClientToken(ctx.config, false);
    let { res, data } = await doCreate(token);
    if (!res.ok && ctx.config.apiKey?.includes(':') && /login|guest|session|token|401|403/i.test(String(data?.error ?? ''))) {
      token = await ensureClientToken(ctx.config, true);
      ({ res, data } = await doCreate(token));
    }

    if (!res.ok || !data?.job?.id) {
      throw new AiProviderError(
        sanitizeBotsdError(data?.error || `Không khởi tạo được tác vụ video (HTTP ${res.status})`),
        data,
        res.status >= 500 || res.status === 429,
      );
    }

    return {
      status: 'processing',
      providerTaskId: String(data.job.id),
      progress: 5,
      raw: { jobId: data.job.id },
    };
  },

  async poll(tool, id, ctx): Promise<AiProviderResult> {
    const t = tool as BotsdToolDef;
    const base = normalizeBaseUrl(ctx.config.baseUrl);
    const token = await ensureClientToken(ctx.config, false);

    if (id.startsWith('img:') || t.modelCode === 'seedream-5.5') {
      const imgId = id.startsWith('img:') ? id.slice(4) : id;
      const imgJobUrl = `${base}/api/web/image/job/${encodeURIComponent(imgId)}?clientToken=${encodeURIComponent(token)}`;
      let res: Response;
      try {
        res = await fetch(imgJobUrl, {
          headers: { 'User-Agent': 'NovAIStudio/1.0' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new AiProviderError('Kết nối kiểm tra tiến độ ảnh tạm gián đoạn, hệ thống sẽ hỏi lại', { error: (err as Error).message }, true);
      }

      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new AiProviderError(
          sanitizeBotsdError(data?.error || `Lỗi kiểm tra tiến độ ảnh (HTTP ${res.status})`),
          data,
          res.status >= 500 || res.status === 429,
        );
      }

      const job = data?.job ?? {};
      const cancelled = Boolean(job.cancelled || job.canceled) || /^(cancelled|canceled)$/i.test(str(job.status));
      if (cancelled || job.failed) {
        return {
          status: 'failed',
          providerTaskId: id,
          error: sanitizeBotsdError(job.message || 'Tạo ảnh không thành công, tiền đã được hoàn lại vào ví') || 'Tạo ảnh không thành công, tiền đã được hoàn lại vào ví',
          raw: job,
        };
      }

      if (job.completed) {
        const count = Math.max(1, Number(job.imageCount) || 1);
        const files: AiOutputFile[] = [];
        for (let i = 0; i < count; i++) {
          const fileUrl = `${base}/api/web/image/file/${encodeURIComponent(imgId)}/${i}?clientToken=${encodeURIComponent(token)}&download=1`;
          const dl = await fetch(fileUrl, {
            headers: { 'User-Agent': 'NovAIStudio/1.0' },
            redirect: 'follow',
            signal: AbortSignal.timeout(90_000),
          }).catch((e: Error) => {
            throw new AiProviderError('Không tải được file ảnh kết quả, hệ thống sẽ thử lại', { error: e.message }, true);
          });
          if (!dl.ok) {
            throw new AiProviderError(`Không tải được ảnh kết quả (HTTP ${dl.status})`, { status: dl.status }, dl.status >= 500 || dl.status === 429);
          }
          const buf = Buffer.from(await dl.arrayBuffer());
          if (!buf.length) throw new AiProviderError('File ảnh kết quả rỗng', { imgId, i }, true);
          files.push({
            url: '',
            type: 'image',
            data: buf,
            mimeType: dl.headers.get('content-type') || 'image/png',
          });
        }
        return { status: 'succeeded', providerTaskId: id, progress: 100, files, raw: { id: imgId, imageCount: files.length } };
      }

      const prog = Number(job.progressPercent);
      return {
        status: 'processing',
        providerTaskId: id,
        progress: Number.isFinite(prog) && prog > 0 ? Math.min(99, Math.round(prog)) : 35,
        raw: { id: imgId, status: job.status },
      };
    }

    const url = `${base}/api/web/job/${encodeURIComponent(id)}?clientToken=${encodeURIComponent(token)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'NovAIStudio/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AiProviderError('Kết nối kiểm tra tiến độ tạm gián đoạn, hệ thống sẽ hỏi lại', { error: (err as Error).message }, true);
    }

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AiProviderError(
        sanitizeBotsdError(data?.error || `Lỗi kiểm tra tiến độ (HTTP ${res.status})`),
        data,
        res.status >= 500 || res.status === 429,
      );
    }

    const job = data?.job ?? {};
    const cancelled = Boolean(job.cancelled || job.canceled) || /^(cancelled|canceled)$/i.test(str(job.status));
    if (cancelled || job.failed) {
      return {
        status: 'failed',
        providerTaskId: id,
        error: sanitizeBotsdError(job.message || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại') || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại',
        raw: job,
      };
    }

    if (job.videoReady) {
      const videoUrl = `${base}/api/web/video/${encodeURIComponent(id)}?clientToken=${encodeURIComponent(token)}&download=1`;
      const dl = await fetch(videoUrl, {
        headers: { 'User-Agent': 'NovAIStudio/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      }).catch((e: Error) => {
        throw new AiProviderError('Không tải được file video kết quả, hệ thống sẽ thử lại', { error: e.message }, true);
      });
      if (!dl.ok) {
        throw new AiProviderError(`Không tải được video kết quả (HTTP ${dl.status})`, { status: dl.status }, dl.status >= 500 || dl.status === 429);
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      if (!buf.length) throw new AiProviderError('File video kết quả rỗng', { id }, true);
      const file: AiOutputFile = { url: '', type: 'video', data: buf, mimeType: dl.headers.get('content-type') || 'video/mp4' };
      return { status: 'succeeded', providerTaskId: id, progress: 100, files: [file], raw: { id } };
    }

    const prog = Number(job.progressPercent);
    return {
      status: 'processing',
      providerTaskId: id,
      progress: Number.isFinite(prog) && prog > 0 ? Math.min(99, Math.round(prog)) : undefined,
      raw: { id, status: job.status, progressPercent: job.progressPercent },
    };
  },

  async balance(ctx) {
    if (!ctx.config.apiKey) return null;
    const sess = await getLiveSession(ctx.config, true);
    const bal = Number(sess?.balance);
    return Number.isFinite(bal) ? { balance: Math.round(bal * 100) / 100, unit: 'point' } : null;
  },

  async catalog(): Promise<AiCatalogItem[]> {
    return TOOLS.map((t) => ({ id: t.modelCode, label: `${t.name} (${t.modelCode})` }));
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey) return null;
    const sess = await getLiveSession(ctx.config, true);
    if (!sess) return null;
    const dmm = sess.durationModelMaintenance ?? {};
    const down = new Set<string>();
    for (const t of TOOLS) {
      if (t.modelCode === 'seedream-5.5') continue;
      if (sess.globalMaintenance === true) {
        down.add(t.key);
        continue;
      }
      const durField = t.fields.find((f) => f.name === 'duration');
      const durs = (durField?.options ?? []).map((o) => String(o.value));
      const modelMaint = dmm[t.modelCode] ?? {};
      if (durs.length > 0 && durs.every((d) => modelMaint[d] === true)) {
        down.add(t.key);
      }
    }
    return down;
  },
};
