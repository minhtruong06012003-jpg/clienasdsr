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
import { guessType, str } from './http.js';

/**
 * 79AI / GoMMO Gateway REST API v2 — https://v2.api.gommo.net (Bearer token + domain `79ai.net`)
 * - Bảng giá credit động trực tiếp từ `GET /ai/models?type=video|image|music&domain=79ai.net`.
 * - Tỉ giá gốc an toàn mặc định: `1 credit = 1.05đ` (khớp mốc lẻ nhỏ nhất START `100.000đ + 5% VAT = 105.000đ / 100.000 credit`).
 * - Biên lợi nhuận mặc định công cụ: `+28%` từ giá gốc (`markup: 28`), tính đầy đủ cả phụ phí video đầu vào (`input_plus_output`).
 */

const DEFAULT_BASE = 'https://v2.api.gommo.net';
const DEFAULT_DOMAIN = '79ai.net';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const VID_ACCEPT = 'video/mp4,video/webm,video/quicktime';
const AUD_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

interface GommoPriceRow {
  mode?: string;
  resolution?: string;
  duration?: string | number;
  price?: number;
}

interface GommoModelEntry {
  id_base?: string;
  model: string;
  name?: string;
  status?: string;
  mediaKind?: 'video' | 'image' | 'music';
  price?: number;
  rate_type?: string;
  prices?: GommoPriceRow[];
  configs?: {
    pricing?: { mode?: string; input?: { ratio?: number } };
    pricing1?: { mode?: string; input?: { ratio?: number } };
  };
}

interface GommoToolDef extends AiToolDef {
  mediaKind: 'video' | 'image' | 'music' | 'avatar';
  modelId: string;
  defaultMode?: string;
  fallbackPrice?: number;
}

function normalizeBaseUrl(raw?: string): string {
  const trimmed = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_BASE;
}

function resolveDomain(cfg: AiProviderConfig): string {
  const d = str((cfg as Record<string, unknown>).domain)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  return d || DEFAULT_DOMAIN;
}

function sanitizeGommoError(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/insufficient|không đủ|hết credit|balance|credit_not_enough|402/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại.';
  }
  if (/thiếu thông tin tên miền|domain|unauthorized|forbidden|token|401|403/i.test(s)) {
    return 'Công cụ đang bảo trì kết nối máy chủ, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại.';
  }
  if (/rate.?limit|quá tải|busy|queue|429/i.test(s)) {
    return 'Hệ thống AI đang quá tải tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại.';
  }
  if (/unsafe|nsfw|policy|kiểm duyệt|vi phạm|sensitive|moderation/i.test(s)) {
    return 'Nội dung mô tả hoặc file tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh lại rồi thử lại. Tiền đã được hoàn lại.';
  }
  if (/bảo trì|maintenance|503|unavailable/i.test(s)) {
    return 'Mô hình này đang bảo trì tạm thời trên máy chủ xử lý, vui lòng thử lại sau. Tiền đã được hoàn lại.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*(?:gommo|79ai|79router)[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\b(?:79ai(?:\.net)?|gommo(?:\.net)?|go-mmo)\b/gi, 'Hệ thống AI')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function gommoFetch<T = any>(
  cfg: AiProviderConfig,
  path: string,
  options: {
    method?: string;
    json?: unknown;
    formParams?: Record<string, string>;
    multipart?: FormData;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  if (!cfg.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const token = cfg.apiKey.trim();
  const url = /^https?:\/\//i.test(path) ? path : `${normalizeBaseUrl(cfg.baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Gommo-Token': token,
    Accept: 'application/json',
    'User-Agent': 'NovAIStudio/1.0',
  };
  let body: BodyInit | undefined;
  if (options.multipart) {
    body = options.multipart;
  } else if (options.formParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.formParams).toString();
  } else if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const method = options.method ?? (body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new AiProviderError(
      'Kết nối máy chủ xử lý AI bị gián đoạn tạm thời, hệ thống sẽ thử lại',
      { error: (err as Error).message },
      true,
    );
  }

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const failedEnvelope =
    !res.ok ||
    parsed?.success === false ||
    parsed?.ok === false ||
    (typeof parsed?.data?.error === 'number' && parsed.data.error !== 0);

  if (failedEnvelope) {
    const rawMsg =
      parsed?.message ??
      parsed?.data?.message ??
      parsed?.error?.message ??
      parsed?.error ??
      `Máy chủ xử lý trả mã HTTP ${res.status}`;
    const retryable = res.status >= 500 || res.status === 429;
    throw new AiProviderError(sanitizeGommoError(rawMsg) || 'Không gửi được yêu cầu xử lý AI', parsed ?? { status: res.status }, retryable);
  }

  return parsed as T;
}

const CATALOG_TTL_MS = 10 * 60_000;
let catalogCache: { key: string; at: number; map: Map<string, GommoModelEntry> } | null = null;
let catalogInflight: Promise<Map<string, GommoModelEntry>> | null = null;

async function getLiveCatalog(cfg: AiProviderConfig, force = false): Promise<Map<string, GommoModelEntry>> {
  const cacheKey = `${normalizeBaseUrl(cfg.baseUrl)}|${resolveDomain(cfg)}|${(cfg.apiKey || '').slice(-10)}`;
  if (!force && catalogCache && catalogCache.key === cacheKey && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.map;
  }
  if (!cfg.apiKey) return catalogCache?.map ?? new Map();
  if (catalogInflight && !force) return catalogInflight;

  catalogInflight = (async () => {
    try {
      const domain = encodeURIComponent(resolveDomain(cfg));
      const [vRes, iRes, mRes] = await Promise.all([
        gommoFetch<any>(cfg, `/ai/models?type=video&domain=${domain}`, { timeoutMs: 20_000 }).catch(() => null),
        gommoFetch<any>(cfg, `/ai/models?type=image&domain=${domain}`, { timeoutMs: 20_000 }).catch(() => null),
        gommoFetch<any>(cfg, `/ai/models?type=music&domain=${domain}`, { timeoutMs: 20_000 }).catch(() => null),
      ]);
      const map = new Map<string, GommoModelEntry>();
      const packs: [any, 'video' | 'image' | 'music'][] = [
        [vRes, 'video'],
        [iRes, 'image'],
        [mRes, 'music'],
      ];
      for (const [pack, mediaKind] of packs) {
        const list = Array.isArray(pack?.data) ? pack.data : [];
        for (const item of list) {
          const entry: GommoModelEntry = { ...(item as GommoModelEntry), mediaKind };
          const m = str(item?.model || item?.id_base);
          if (m) map.set(m, entry);
          const idb = str(item?.id_base);
          if (idb && !map.has(idb)) map.set(idb, entry);
        }
      }
      if (map.size > 0) {
        catalogCache = { key: cacheKey, at: Date.now(), map };
        return map;
      }
    } finally {
      catalogInflight = null;
    }
    return catalogCache?.map ?? new Map();
  })();

  return catalogInflight;
}

function matchResKey(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  return na.replace(/p$/i, '') === nb.replace(/p$/i, '');
}

function lookupPrice(
  live: Map<string, GommoModelEntry>,
  modelId: string,
  query: { mode?: string; resolution?: string; duration?: number | string },
  fallback: number,
): number {
  const entry = live.get(modelId);
  if (!entry) return fallback;
  const rows = Array.isArray(entry.prices) ? entry.prices : [];
  if (rows.length > 0) {
    const wantMode = query.mode?.toLowerCase().trim();
    const wantRes = query.resolution?.toLowerCase().trim();
    const wantDur = query.duration !== undefined ? String(query.duration).replace(/s$/i, '').trim() : undefined;

    const exact = rows.find((r) => {
      if (!(Number(r.price) > 0)) return false;
      if (wantMode && r.mode && r.mode.toLowerCase() !== wantMode) return false;
      if (wantRes && r.resolution && !matchResKey(r.resolution, wantRes)) return false;
      if (wantDur && r.duration !== undefined && r.duration !== null && String(r.duration) !== wantDur) return false;
      return true;
    });
    if (exact && Number(exact.price) > 0) return Number(exact.price);

    // Nếu thời lượng nằm ngoài tập rời rạc thì suy tỉ lệ theo giây trên cùng (mode, resolution)
    if (wantDur && Number(wantDur) > 0) {
      const sameTier = rows.find(
        (r) =>
          Number(r.price) > 0 &&
          Number(r.duration) > 0 &&
          (!wantMode || !r.mode || r.mode.toLowerCase() === wantMode) &&
          (!wantRes || !r.resolution || matchResKey(r.resolution, wantRes)),
      );
      if (sameTier) {
        const perSec = Number(sameTier.price) / Number(sameTier.duration);
        return Math.ceil(perSec * Number(wantDur));
      }
    }
  }
  if (Number(entry.price) > 0 && entry.rate_type !== 'per_second') {
    return Number(entry.price);
  }
  return fallback;
}

function clampInt(raw: unknown, min: number, max: number, def: number): number {
  const s = str(raw).replace(/s$/i, '').trim();
  if (!s) return def;
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
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

async function uploadImageToGommo(ctx: AiCallContext, url: string): Promise<{ url: string; idBase?: string }> {
  try {
    const file = await loadInputFile(ctx.readUpload, url);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType || 'image/jpeg' }), file.filename || 'image.jpg');
    form.append('domain', resolveDomain(ctx.config));
    const res = await gommoFetch<any>(ctx.config, '/ai/upload/image', { multipart: form, timeoutMs: 60_000 });
    const uploadedUrl = str(res?.data?.url ?? res?.url);
    if (uploadedUrl) {
      return { url: uploadedUrl, idBase: str(res?.data?.id_base) || undefined };
    }
  } catch (err) {
    if (/^https?:\/\//i.test(url)) return { url };
    throw err;
  }
  if (/^https?:\/\//i.test(url)) return { url };
  throw new AiProviderError('Không tải được ảnh tham chiếu lên máy chủ xử lý');
}

const DUR_4_15 = opts([
  ['4', '4s'],
  ['5', '5s'],
  ['6', '6s'],
  ['8', '8s'],
  ['10', '10s'],
  ['12', '12s'],
  ['15', '15s'],
]);

const DUR_5_15 = opts([
  ['5', '5s'],
  ['6', '6s'],
  ['8', '8s'],
  ['10', '10s'],
  ['12', '12s'],
  ['15', '15s'],
]);

const DUR_3_20 = opts([
  ['4', '4s'],
  ['5', '5s'],
  ['6', '6s'],
  ['8', '8s'],
  ['10', '10s'],
  ['12', '12s'],
  ['15', '15s'],
  ['20', '20s'],
]);

const DUR_4_30 = opts([
  ['5', '5s'],
  ['8', '8s'],
  ['10', '10s'],
  ['15', '15s'],
  ['20', '20s'],
  ['25', '25s'],
  ['30', '30s'],
]);

const RATIOS_6 = opts([
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
  ['3:4', '3:4'],
  ['4:3', '4:3'],
  ['21:9', '21:9'],
]);

const RATIOS_5 = opts([
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
  ['3:4', '3:4'],
  ['4:3', '4:3'],
]);

function videoModeFields(optsCfg: {
  startEnd?: boolean;
  startOnly?: boolean;
  maxRefs?: number;
  allowRefVideo?: boolean;
  allowRefAudio?: boolean;
}): AiFieldDef[] {
  const modeOptions: [string, string][] = [['t2v', 'Từ mô tả']];
  if (optsCfg.startEnd || optsCfg.startOnly) modeOptions.push(['i2v', 'Ảnh thành video']);
  if ((optsCfg.maxRefs ?? 0) > 0) modeOptions.push(['ref', 'Ảnh tham chiếu']);

  const fields: AiFieldDef[] = [
    { name: 'mode', label: 'Chế độ tạo', type: 'select', required: true, default: 't2v', options: opts(modeOptions) },
  ];
  if ((optsCfg.maxRefs ?? 0) > 0) {
    fields.push({
      name: 'images',
      label: `Ảnh tham chiếu (tối đa ${optsCfg.maxRefs})`,
      type: 'image',
      required: true,
      multiple: true,
      maxFiles: optsCfg.maxRefs,
      accept: IMG_ACCEPT,
      showIf: { field: 'mode', in: ['ref'] },
      help: 'Tải các ảnh nhân vật / sản phẩm / bối cảnh tham chiếu theo thứ tự @image1, @image2…',
    });
    if (optsCfg.allowRefVideo) {
      fields.push({
        name: 'video',
        label: 'Video tham chiếu (tuỳ chọn, tối đa 15s)',
        type: 'video',
        accept: VID_ACCEPT,
        showIf: { field: 'mode', in: ['ref'] },
        help: 'Nếu đính kèm video tham chiếu (@video1), chi phí tính thêm phần thời lượng đọc chuyển động đầu vào theo quy định model.',
      });
    }
    if (optsCfg.allowRefAudio) {
      fields.push({
        name: 'audio',
        label: 'Âm thanh tham chiếu (tuỳ chọn, tối đa 15s)',
        type: 'audio',
        accept: AUD_ACCEPT,
        showIf: { field: 'mode', in: ['ref'] },
        help: 'Đính kèm giọng nói hoặc nhạc nền tham chiếu (@audio1) nếu cần.',
      });
    }
  }
  if (optsCfg.startEnd || optsCfg.startOnly) {
    fields.push({
      name: 'image',
      label: 'Ảnh khung đầu',
      type: 'image',
      required: true,
      accept: IMG_ACCEPT,
      showIf: { field: 'mode', in: ['i2v'] },
      help: 'Ảnh khung hình mở đầu của video',
    });
    if (optsCfg.startEnd) {
      fields.push({
        name: 'lastFrame',
        label: 'Ảnh khung cuối (tuỳ chọn)',
        type: 'image',
        accept: IMG_ACCEPT,
        showIf: { field: 'mode', in: ['i2v'] },
        help: 'Ảnh chốt khung hình kết thúc video (nếu cần chuyển cảnh đầu–cuối)',
      });
    }
  }
  return fields;
}

const TOOLS: GommoToolDef[] = [
  {
    key: 'gemini-omni-1.2',
    modelId: 'gemini-omni-flash-1.2',
    mediaKind: 'video',
    name: 'Gemini Omni Flash 1.2 (Tới 4K · Đa tham chiếu)',
    category: 'video',
    icon: 'film',
    badge: '4K',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Tạo video AI siêu tiết kiệm độ nét từ 360p, HD 720p, Full HD 1080p tới Ultra HD 4K dài tới 20 giây; hỗ trợ khung đầu–cuối hoặc tối đa 8 ảnh tham chiếu.',
    output: 'video',
    fields: [
      ...videoModeFields({ startEnd: true, maxRefs: 8 }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả chi tiết cảnh quay, chuyển động nhân vật, ánh sáng, góc máy...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '16:9', options: opts([['16:9', '16:9'], ['9:16', '9:16']]) },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_3_20 },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: opts([
          ['720p', '720p'],
          ['1080p', '1080p'],
          ['4k', '4K Ultra HD'],
          ['360p', '360p (Nháp rẻ)'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
  {
    key: 'seedance-2.0-omni',
    modelId: 'seedance_20_pro_edit',
    mediaKind: 'video',
    name: 'Seedance 2.0 Omni (Tới 4K · Ảnh/Video/Audio tham chiếu)',
    category: 'video',
    icon: 'film',
    badge: 'HOT',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.0 Omni đa phương thức độ nét tới 4K, dài 4–15 giây, ghép tới 9 ảnh + video/âm thanh tham chiếu (@image1, @video1, @audio1) giữ đồng nhất nhân vật.',
    output: 'video',
    fields: [
      {
        name: 'engine',
        label: 'Chế độ xử lý',
        type: 'select',
        required: true,
        default: 'business_fast',
        options: opts([
          ['business_fast', 'Fast (Tiết kiệm)'],
          ['business_professional', 'Professional'],
        ]),
      },
      ...videoModeFields({ maxRefs: 9, allowRefVideo: true, allowRefAudio: true }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Ví dụ: @image1 bước đi tự tin trên phố đêm mưa, ánh đèn neon phản chiếu điện ảnh...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_4_15 },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: opts([
          ['720p', '720p'],
          ['1080p', '1080p'],
          ['4k', '4K Ultra HD'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedance-2.0',
    modelId: 'seedance_20_pro',
    mediaKind: 'video',
    name: 'Seedance 2.0 Video (Khung đầu/cuối · Tới 1080p)',
    category: 'video',
    icon: 'film',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Seedance 2.0 tạo video chuyển động mượt 480p / 720p / 1080p dài 4–15 giây từ văn bản, ảnh đầu–cuối hoặc tới 9 ảnh tham chiếu.',
    output: 'video',
    fields: [
      {
        name: 'engine',
        label: 'Chế độ xử lý',
        type: 'select',
        required: true,
        default: 'fast',
        options: opts([
          ['fast', 'Fast (Tiết kiệm)'],
          ['professional', 'Professional'],
        ]),
      },
      ...videoModeFields({ startEnd: true, maxRefs: 9 }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả chi tiết chuyển động nhân vật, bối cảnh, góc máy...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_4_15 },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: opts([
          ['480p', '480p'],
          ['720p', '720p'],
          ['1080p', '1080p'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedance-2.0-mini',
    modelId: 'seedance_20_mini',
    mediaKind: 'video',
    name: 'Seedance 2.0 Mini (Siêu tiết kiệm · Đa tham chiếu)',
    category: 'video',
    icon: 'film',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Bản thu gọn tốc độ cao & tiết kiệm chi phí của Seedance 2.0 (480p / 720p, 4–15s), hỗ trợ tối đa 6 ảnh + video/audio tham chiếu.',
    output: 'video',
    fields: [
      ...videoModeFields({ maxRefs: 6, allowRefVideo: true, allowRefAudio: true }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả cảnh quay hoặc gọi @image1, @image2...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_4_15 },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: '480p', options: opts([['480p', '480p'], ['720p', '720p']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'wan-3.0-cheap',
    modelId: 'wan_3_0',
    mediaKind: 'video',
    name: 'Wan 3.0 Video (Tiết kiệm · Dài tới 30s)',
    category: 'video',
    icon: 'film',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Alibaba Wan 3.0 luồng tiết kiệm tạo video dài liên tục 5–30 giây (480p / 720p / 1080p), hỗ trợ ảnh đầu–cuối hoặc tối đa 10 ảnh tham chiếu.',
    output: 'video',
    fields: [
      ...videoModeFields({ startEnd: true, maxRefs: 10, allowRefVideo: true }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả cảnh quay, lời thoại, góc máy chuyển động...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_5 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_4_30 },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '480p',
        options: opts([
          ['480p', '480p'],
          ['720p', '720p'],
          ['1080p', '1080p'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'kling-2.5-relax',
    modelId: 'kling_video_2_5',
    mediaKind: 'video',
    name: 'Kling 2.5 Video (Luồng Siêu Rẻ · Khung đầu/cuối)',
    category: 'video',
    icon: 'film',
    badge: 'RẺ',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Tạo video Kling 2.5 dài 5s hoặc 10s với chế độ Relax siêu tiết kiệm (chỉ dưới 1.000đ/clip 5s), hỗ trợ văn bản hoặc ảnh đầu–cuối.',
    output: 'video',
    fields: [
      {
        name: 'engine',
        label: 'Tốc độ xử lý',
        type: 'select',
        required: true,
        default: 'relax',
        options: opts([
          ['relax', 'Relax (Siêu rẻ)'],
          ['standard', 'Standard (Nhanh)'],
          ['professional', 'Professional'],
        ]),
      },
      ...videoModeFields({ startEnd: true }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả chuyển động mượt mà của chủ thể và ống kính...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: opts([['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']]) },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: opts([['5', '5s'], ['10', '10s']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
  {
    key: 'meta-muse-video',
    modelId: 'meta_muse_video',
    mediaKind: 'video',
    name: 'Meta Muse 1.0 Video (10s HD 720p)',
    category: 'video',
    icon: 'film',
    badge: 'NEW',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Mô hình Meta Muse 1.0 tạo trọn vẹn video dài 10 giây chuẩn HD 720p chi phí cực thấp, hỗ trợ khung đầu–cuối hoặc tối đa 3 ảnh tham chiếu.',
    output: 'video',
    fields: [
      ...videoModeFields({ startEnd: true, maxRefs: 3 }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả cảnh quay điện ảnh, ánh sáng, chuyển động nhân vật...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '16:9', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '10', options: opts([['10', '10s']]) },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: '720p', options: opts([['720p', '720p']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
  {
    key: 'veo-3.1-lite',
    modelId: 'veo_3_1',
    mediaKind: 'video',
    name: 'Google Veo 3.1 (Lite & Fast · Tới 4K)',
    category: 'video',
    icon: 'film',
    badge: 'HOT',
    featured: true,
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Google Veo 3.1 bản Lite siêu rẻ và Fast tạo video 4s / 6s / 8s độ nét từ 720p, Full HD 1080p tới Ultra HD 4K, hỗ trợ ảnh đầu–cuối & tham chiếu.',
    output: 'video',
    fields: [
      {
        name: 'engine',
        label: 'Phiên bản',
        type: 'select',
        required: true,
        default: 'lite',
        options: opts([
          ['lite', 'Lite (Siêu rẻ)'],
          ['fast', 'Fast (Nhanh)'],
        ]),
      },
      ...videoModeFields({ startEnd: true, maxRefs: 3 }),
      {
        name: 'prompt',
        label: 'Mô tả cảnh & âm thanh (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả bối cảnh, chuyển động máy quay, hội thoại / âm thanh tự nhiên...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '16:9', options: opts([['16:9', '16:9'], ['9:16', '9:16']]) },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '8', options: opts([['8', '8s'], ['6', '6s'], ['4', '4s']]) },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        options: opts([
          ['720p', '720p'],
          ['1080p', '1080p'],
          ['4k', '4K Ultra HD'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
  {
    key: 'kling-lipsync',
    modelId: 'kling_video_lipsync',
    mediaKind: 'avatar',
    name: 'Kling Avatar LipSync (Nhép môi chân dung AI)',
    category: 'video',
    icon: 'user-round',
    badge: 'HOT',
    featured: true,
    supportsCost: true,
    unitLabel: 'giây',
    description: 'Tải lên 1 ảnh chân dung nhân vật + 1 file giọng nói (MP3/WAV/M4A) để tạo video nhân vật nói chuyện, khớp khẩu hình tự nhiên tính lẻ từng giây.',
    output: 'video',
    fields: [
      {
        name: 'image',
        label: 'Ảnh chân dung nhân vật',
        type: 'image',
        required: true,
        accept: IMG_ACCEPT,
        help: 'Ảnh rõ khuôn mặt nhìn thẳng hoặc hơi nghiêng nhẹ để khẩu hình tự nhiên nhất',
      },
      {
        name: 'audio',
        label: 'File giọng nói (MP3 / WAV / M4A, 2–60s)',
        type: 'audio',
        required: true,
        accept: AUD_ACCEPT,
        help: 'Chi phí tính tự động theo đúng số giây thực tế của file âm thanh',
      },
      {
        name: 'prompt',
        label: 'Gợi ý biểu cảm / cử chỉ (tuỳ chọn)',
        type: 'textarea',
        required: false,
        placeholder: 'Ví dụ: biểu cảm tươi tắn, gật đầu tự nhiên khi trò chuyện...',
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'heygen-video',
    modelId: 'heygen_video',
    mediaKind: 'video',
    name: 'HeyGen Video AI (Nhân vật & Thuyết trình)',
    category: 'video',
    icon: 'video',
    badge: 'NEW',
    supportsCost: true,
    unitLabel: 'lượt',
    description: 'Mô hình HeyGen Video tạo video nhân vật nói chuyện, quảng cáo sản phẩm & storytelling dài 5–15 giây kèm giọng nói và âm thanh đồng bộ.',
    output: 'video',
    fields: [
      ...videoModeFields({ startOnly: true, maxRefs: 6, allowRefAudio: true }),
      {
        name: 'prompt',
        label: 'Kịch bản cảnh quay & lời thoại (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả nhân vật thuyết trình, lời thoại và bối cảnh...',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS_6 },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: DUR_5_15 },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: '480p', options: opts([['480p', '480p'], ['768p', '768p HD']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'genjutsu-replace',
    modelId: 'genjutsu_lite',
    mediaKind: 'video',
    name: 'Thay Vật Thể Trong Video AI (Genjutsu Lite)',
    category: 'video',
    icon: 'wand-sparkles',
    badge: 'NEW',
    supportsCost: true,
    unitLabel: 'giây',
    description: 'Tải lên video gốc (4–15 giây) kèm ảnh sản phẩm/vật thể mới để AI tự động thay vật thể vào video, giữ nguyên chuyển động tay, ánh sáng và góc máy gốc.',
    output: 'video',
    fields: [
      {
        name: 'video',
        label: 'Video gốc cần thay vật thể (4–15s)',
        type: 'video',
        required: true,
        accept: VID_ACCEPT,
        help: 'Thời lượng video đầu ra khớp với video gốc tải lên (4–15 giây)',
      },
      {
        name: 'images',
        label: 'Ảnh vật thể / sản phẩm mới (1–4 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 4,
        accept: IMG_ACCEPT,
        help: 'Tải ảnh sản phẩm cần ghép vào video (gọi @image1 trong mô tả)',
      },
      {
        name: 'prompt',
        label: 'Yêu cầu thay thế (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Ví dụ: Thay chai nước trên tay nhân vật bằng sản phẩm trong @image1, giữ nguyên chuyển động và ánh sáng...',
      },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: '720p', options: opts([['720p', '720p'], ['1080p', '1080p']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 2000 },
  },
  {
    key: 'suno-music',
    modelId: 'suno-v6.0',
    mediaKind: 'music',
    name: 'Tạo Nhạc & Bài Hát AI Suno (v6.0 & v5.5)',
    category: 'audio',
    icon: 'music',
    badge: 'HOT',
    featured: true,
    splitModels: false,
    supportsCost: true,
    unitLabel: 'bài',
    description: 'Sáng tác bài hát trọn vẹn có giọng ca sĩ Việt/Anh tự nhiên, hòa âm phối khí chuyên nghiệp bằng Suno 6.0 & Suno 5.5.',
    output: 'audio',
    fields: [
      {
        name: 'engine',
        label: 'Phiên bản Suno',
        type: 'select',
        required: true,
        default: 'suno-v6.0',
        options: opts([
          ['suno-v6.0', 'Suno 6.0 (Mới nhất)'],
          ['suno-v5.5', 'Suno 5.5 (Tiết kiệm)'],
        ]),
      },
      {
        name: 'title',
        label: 'Tên bài hát',
        type: 'text',
        required: true,
        max: 120,
        placeholder: 'Ví dụ: Nắng Ban Mai',
      },
      {
        name: 'styles',
        label: 'Thể loại & phong cách nhạc',
        type: 'text',
        required: false,
        max: 300,
        placeholder: 'Ví dụ: V-Pop ballad, acoustic guitar, piano ấm áp, cảm xúc...',
      },
      {
        name: 'gender',
        label: 'Giọng hát',
        type: 'select',
        required: true,
        default: 'auto',
        options: opts([
          ['auto', 'Tự động hợp bài'],
          ['f', 'Giọng Nữ'],
          ['m', 'Giọng Nam'],
        ]),
      },
      {
        name: 'prompt',
        label: 'Lời bài hát hoặc ý tưởng chủ đề',
        type: 'textarea',
        required: true,
        max: 5000,
        placeholder: 'Nhập lời bài hát ([Verse], [Chorus]...) hoặc mô tả chủ đề để AI tự viết lời & phối nhạc...',
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 1000 },
  },
  {
    key: 'seedream-5.5',
    modelId: 'seedream-5.5',
    mediaKind: 'image',
    name: 'Tạo & Ghép Ảnh Seedream 5.5 (1K – 4K)',
    category: 'image',
    icon: 'image',
    badge: '4K',
    featured: true,
    supportsCost: true,
    unitLabel: 'ảnh',
    description: 'ByteDance Seedream 5.5 tạo và chỉnh sửa/ghép tới 10 ảnh tham chiếu sắc nét chuẩn 1K, 2K, 4K với mức giá siêu tiết kiệm.',
    output: 'image',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu / ảnh gốc (tuỳ chọn, tối đa 10)',
        type: 'image',
        multiple: true,
        maxFiles: 10,
        accept: IMG_ACCEPT,
        help: 'Bỏ trống nếu tạo ảnh mới từ văn bản; tải ảnh lên nếu muốn giữ nhân vật/sản phẩm hoặc ghép ảnh',
      },
      {
        name: 'prompt',
        label: 'Mô tả hình ảnh (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả chi tiết chủ thể, bố cục, ánh sáng, phong cách nhiếp ảnh...',
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '1:1',
        options: opts([
          ['1:1', '1:1'],
          ['16:9', '16:9'],
          ['9:16', '9:16'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['3:2', '3:2'],
          ['2:3', '2:3'],
          ['21:9', '21:9'],
          ['auto', 'Tự động'],
        ]),
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '2k',
        options: opts([
          ['1k', '1K'],
          ['2k', '2K Sắc nét'],
          ['4k', '4K Ultra HD'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 300 },
  },
  {
    key: 'gpt-image-2.6',
    modelId: 'gpt-image-2.6-flare',
    mediaKind: 'image',
    name: 'Tạo & Sửa Ảnh GPT Image 2.6 (Flare & Sunburst · 4K)',
    category: 'image',
    icon: 'sparkles',
    badge: 'NEW',
    splitModels: false,
    supportsCost: true,
    unitLabel: 'ảnh',
    description: 'Thế hệ GPT Image 2.6 (Flare & Sunburst) hiểu ngữ cảnh và chữ tiếng Việt/Anh cực chuẩn, hỗ trợ tới 8 ảnh tham chiếu và xuất ảnh 1K / 2K / 4K.',
    output: 'image',
    fields: [
      {
        name: 'variant',
        label: 'Biến thể mô hình',
        type: 'select',
        required: true,
        default: 'gpt-image-2.6-flare',
        options: opts([
          ['gpt-image-2.6-flare', 'GPT Image 2.6 Flare'],
          ['gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst'],
        ]),
      },
      {
        name: 'engine',
        label: 'Chất lượng render',
        type: 'select',
        required: true,
        default: 'low',
        options: opts([
          ['low', 'Tiết kiệm (Low)'],
          ['medium', 'Cân bằng (Medium)'],
          ['high', 'Cao cấp (High)'],
        ]),
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tuỳ chọn, tối đa 8)',
        type: 'image',
        multiple: true,
        maxFiles: 8,
        accept: IMG_ACCEPT,
      },
      {
        name: 'prompt',
        label: 'Mô tả hình ảnh (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Mô tả bố cục, chữ in trên ảnh, sản phẩm, phong cách thiết kế...',
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '1:1',
        options: opts([
          ['1:1', '1:1'],
          ['16:9', '16:9'],
          ['9:16', '9:16'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['3:2', '3:2'],
          ['2:3', '2:3'],
          ['21:9', '21:9'],
        ]),
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '1k',
        options: opts([
          ['1k', '1K'],
          ['2k', '2K'],
          ['4k', '4K'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 28, min: 300 },
  },
  {
    key: 'ideogram-4.5',
    modelId: 'ideogram-4-5',
    mediaKind: 'image',
    name: 'Ideogram 4.5 (Thiết kế Poster, Logo & Chữ chuẩn xác)',
    category: 'image',
    icon: 'palette',
    badge: 'NEW',
    supportsCost: true,
    unitLabel: 'ảnh',
    description: 'Ideogram 4.5 chuyên thiết kế banner quảng cáo, poster thương hiệu, typography & logo sắc nét tới 2K, hỗ trợ tới 5 ảnh tham chiếu.',
    output: 'image',
    fields: [
      {
        name: 'engine',
        label: 'Chất lượng render',
        type: 'select',
        required: true,
        default: 'low',
        options: opts([
          ['low', 'Tiết kiệm (Low)'],
          ['medium', 'Cân bằng (Medium)'],
          ['high', 'Cao cấp (High)'],
        ]),
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu phong cách / bố cục (tuỳ chọn, tối đa 5)',
        type: 'image',
        multiple: true,
        maxFiles: 5,
        accept: IMG_ACCEPT,
      },
      {
        name: 'prompt',
        label: 'Mô tả thiết kế & nội dung chữ trên ảnh',
        type: 'textarea',
        required: true,
        placeholder: 'Ví dụ: Poster quảng cáo cà phê cao cấp, dòng chữ lớn "MORNING BREW" sắc nét...',
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '1:1',
        options: opts([
          ['1:1', '1:1'],
          ['16:9', '16:9'],
          ['9:16', '9:16'],
          ['4:3', '4:3'],
          ['3:4', '3:4'],
          ['4:5', '4:5'],
          ['3:2', '3:2'],
          ['2:3', '2:3'],
          ['auto', 'Tự động'],
        ]),
      },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, default: '1k', options: opts([['1k', '1K'], ['2k', '2K']]) },
    ],
    pricing: { mode: 'cost', markup: 28, min: 500 },
  },
];

function extractResultFiles(payload: any, defaultType: 'video' | 'image' | 'audio'): AiOutputFile[] {
  const data = payload?.data ?? payload;
  const raw = payload?.raw ?? {};
  const candidates: string[] = [];
  const pushUrl = (u: unknown) => {
    const s = str(u);
    if (s && /^https?:\/\//i.test(s) && !candidates.includes(s)) candidates.push(s);
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      pushUrl(item?.result_url ?? item?.audio_url ?? item?.video_url ?? item?.url ?? item?.file_url);
    }
  } else if (data && typeof data === 'object') {
    pushUrl(data.result_url);
    pushUrl(data.audio_url);
    pushUrl(data.video_url);
    pushUrl(data.download_url);
    pushUrl(data.file_url);
    pushUrl(data.media_url);
    pushUrl(data.url);
    if (Array.isArray(data.urls)) data.urls.forEach(pushUrl);
    if (Array.isArray(data.mediaUrls)) data.mediaUrls.forEach(pushUrl);
    if (Array.isArray(data.images)) data.images.forEach((x: any) => pushUrl(typeof x === 'string' ? x : x?.url));
  }

  for (const info of [raw?.videoInfo, raw?.imageInfo, raw?.musicInfo, raw?.audioInfo]) {
    if (info && typeof info === 'object') {
      pushUrl(info.result_url ?? info.audio_url ?? info.video_url ?? info.download_url ?? info.url);
      if (Array.isArray(info.urls)) info.urls.forEach(pushUrl);
    }
  }

  return candidates.map((url) => ({ url, type: guessType(url, defaultType) }));
}

function mapGommoJobStatus(
  payload: any,
  taskId: string,
  defaultType: 'video' | 'image' | 'audio',
): AiProviderResult {
  const data = payload?.data ?? payload ?? {};
  const raw = payload?.raw ?? {};
  const statusRaw = str(
    data?.status ??
      raw?.videoInfo?.status ??
      raw?.imageInfo?.status ??
      raw?.musicInfo?.status ??
      raw?.audioInfo?.status,
  ).toUpperCase();

  const files = extractResultFiles(payload, defaultType);

  if (
    ['SUCCESS', 'COMPLETED', 'DONE', 'MEDIA_GENERATION_STATUS_SUCCESSFUL'].includes(statusRaw) ||
    (files.length > 0 && !['PENDING', 'PROCESSING', 'QUEUED', 'ACTIVE', 'PENDING_ACTIVE', 'PENDING_PROCESSING'].includes(statusRaw))
  ) {
    if (!files.length) {
      return {
        status: 'failed',
        providerTaskId: taskId,
        error: 'Máy chủ xử lý báo hoàn tất nhưng không trả file kết quả — tiền đã được hoàn lại',
        raw: payload,
      };
    }
    return { status: 'succeeded', providerTaskId: taskId, progress: 100, files, raw: payload };
  }

  if (
    statusRaw.includes('FAIL') ||
    statusRaw.includes('ERROR') ||
    statusRaw.includes('CANCEL') ||
    statusRaw.includes('REJECT') ||
    statusRaw.includes('UNSAFE')
  ) {
    const errText =
      data?.error_message ??
      data?.message ??
      raw?.videoInfo?.error_message ??
      raw?.imageInfo?.error_message ??
      raw?.musicInfo?.error_message ??
      payload?.message;
    return {
      status: 'failed',
      providerTaskId: taskId,
      error: sanitizeGommoError(errText) || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại',
      raw: payload,
    };
  }

  const prog = Number(data?.progress ?? raw?.videoInfo?.progress ?? raw?.imageInfo?.progress);
  return {
    status: 'processing',
    providerTaskId: taskId,
    progress: Number.isFinite(prog) && prog > 0 ? Math.min(99, Math.round(prog)) : undefined,
    raw: payload,
  };
}

export const gommoProvider: AiProvider = {
  key: 'gommo',
  name: '79AI · GoMMO (79ai.net)',
  website: 'https://79ai.net',
  tools: TOOLS,
  costUnit: 'credit',
  // Khớp chính xác mốc lẻ nhỏ nhất START 100.000đ + 5% VAT = 105.000đ / 100.000 credit = 1,05đ / credit
  rate: 1.05,

  async cost(tool, input, ctx) {
    const t = tool as GommoToolDef;
    const live = await getLiveCatalog(ctx.config);

    switch (t.key) {
      case 'gemini-omni-1.2': {
        const res = str(input.resolution) || '720p';
        const dur = clampInt(input.duration, 3, 55, 5);
        const perSecFb = res === '4k' ? 720 : res === '1080p' ? 440 : res === '360p' ? 200 : 360;
        return lookupPrice(live, 'gemini-omni-flash-1.2', { mode: 'flash', resolution: res, duration: dur }, perSecFb * dur);
      }

      case 'seedance-2.0-omni': {
        const mode = str(input.engine) === 'business_professional' ? 'business_professional' : 'business_fast';
        const res = str(input.resolution) || '720p';
        const dur = clampInt(input.duration, 4, 15, 5);
        const perSecFb =
          mode === 'business_professional'
            ? res === '4k'
              ? 7600
              : res === '1080p'
                ? 3800
                : 1900
            : res === '4k'
              ? 6160
              : res === '1080p'
                ? 3080
                : 1540;
        let total = lookupPrice(live, 'seedance_20_pro_edit', { mode, resolution: res, duration: dur }, perSecFb * dur);
        if (str(input.video) && input.__sample !== true) {
          const vSec = await resolveMediaSeconds(input, ctx, 'video', 5, 1, 15, 'Video tham chiếu');
          const refBase = lookupPrice(live, 'seedance_20_pro_edit', { mode, resolution: res, duration: Math.max(4, Math.ceil(vSec)) }, perSecFb * Math.ceil(vSec));
          total += Math.ceil(refBase * 0.8);
        }
        return total;
      }

      case 'seedance-2.0': {
        const mode = str(input.engine) === 'professional' ? 'professional' : 'fast';
        const res = str(input.resolution) || '720p';
        const dur = clampInt(input.duration, 4, 15, 5);
        const perSecFb =
          mode === 'professional'
            ? res === '1080p'
              ? 4180
              : res === '720p'
                ? 2090
                : 1254
            : res === '1080p'
              ? 3080
              : res === '720p'
                ? 1540
                : 924;
        return lookupPrice(live, 'seedance_20_pro', { mode, resolution: res, duration: dur }, perSecFb * dur);
      }

      case 'seedance-2.0-mini': {
        const res = str(input.resolution) || '480p';
        const dur = clampInt(input.duration, 4, 15, 5);
        const perSecFb = res === '720p' ? 1300 : 910;
        let total = lookupPrice(live, 'seedance_20_mini', { mode: 'business_mini', resolution: res, duration: dur }, perSecFb * dur);
        if (str(input.video) && input.__sample !== true) {
          const vSec = await resolveMediaSeconds(input, ctx, 'video', 5, 1, 15, 'Video tham chiếu');
          const refBase = lookupPrice(live, 'seedance_20_mini', { mode: 'business_mini', resolution: res, duration: Math.max(4, Math.ceil(vSec)) }, perSecFb * Math.ceil(vSec));
          total += Math.ceil(refBase * 0.8);
        }
        return total;
      }

      case 'wan-3.0-cheap': {
        const res = str(input.resolution) || '480p';
        const dur = clampInt(input.duration, 4, 30, 5);
        const perSecFb = res === '1080p' ? 3300 : res === '720p' ? 1650 : 825;
        let total = lookupPrice(live, 'wan_3_0', { mode: 'cheap', resolution: res, duration: dur }, perSecFb * dur);
        if (str(input.video) && input.__sample !== true) {
          const vSec = await resolveMediaSeconds(input, ctx, 'video', 5, 1, 15, 'Video tham chiếu');
          const refBase = lookupPrice(live, 'wan_3_0', { mode: 'cheap', resolution: res, duration: Math.max(4, Math.ceil(vSec)) }, perSecFb * Math.ceil(vSec));
          total += Math.ceil(refBase * 0.5);
        }
        return total;
      }

      case 'kling-2.5-relax': {
        const mode = ['relax', 'standard', 'professional'].includes(str(input.engine)) ? str(input.engine) : 'relax';
        const dur = str(input.duration) === '10' ? 10 : 5;
        const fb =
          mode === 'professional'
            ? dur === 10
              ? 7000
              : 4000
            : mode === 'standard'
              ? dur === 10
                ? 5000
                : 2500
              : dur === 10
                ? 2000
                : 800;
        return lookupPrice(live, 'kling_video_2_5', { mode, duration: dur }, fb);
      }

      case 'meta-muse-video':
        return lookupPrice(live, 'meta_muse_video', { mode: 'fast', resolution: '720p', duration: 10 }, 1200);

      case 'veo-3.1-lite': {
        const mode = str(input.engine) === 'fast' ? 'fast' : 'lite';
        const res = str(input.resolution) || '720p';
        const fb =
          mode === 'fast'
            ? res === '4k'
              ? 3000
              : res === '1080p'
                ? 1600
                : 1200
            : res === '4k'
              ? 2000
              : res === '1080p'
                ? 1200
                : 800;
        return lookupPrice(live, 'veo_3_1', { mode, resolution: res }, fb);
      }

      case 'kling-lipsync': {
        const perSec = Number(live.get('kling_video_lipsync')?.price) || 500;
        const sec = await resolveMediaSeconds(input, ctx, 'audio', 5, 2, 60, 'File giọng nói');
        return Math.max(2, Math.ceil(sec)) * perSec;
      }

      case 'heygen-video': {
        const res = str(input.resolution) === '768p' ? '768p' : '480p';
        const dur = clampInt(input.duration, 5, 15, 5);
        const perSecFb = res === '768p' ? 1134 : 756;
        return lookupPrice(live, 'heygen_video', { mode: 'official', resolution: res, duration: dur }, perSecFb * dur);
      }

      case 'genjutsu-replace': {
        const res = str(input.resolution) === '1080p' ? '1080p' : '720p';
        const sec = await resolveMediaSeconds(input, ctx, 'video', 5, 4, 15, 'Video gốc');
        const dur = Math.max(4, Math.min(30, Math.ceil(sec)));
        const perSecFb = res === '1080p' ? 4000 : 2000;
        const outCredits = lookupPrice(live, 'genjutsu_lite', { mode: 'hf_mult_replace_object_flash', resolution: res, duration: dur }, perSecFb * dur);
        // pricing1: input_plus_output (input ratio = 0.5 -> tổng cộng 1.5x output credits)
        return Math.ceil(outCredits * 1.5);
      }

      case 'suno-music': {
        const model = str(input.engine) === 'suno-v5.5' ? 'suno-v5.5' : 'suno-v6.0';
        const fb = model === 'suno-v5.5' ? 3000 : 4000;
        return Number(live.get(model)?.price) || fb;
      }

      case 'seedream-5.5': {
        const res = str(input.resolution) || '2k';
        const fb = res === '4k' ? 1200 : res === '1k' ? 400 : 800;
        return lookupPrice(live, 'seedream-5.5', { mode: 'cheap', resolution: res }, fb);
      }

      case 'gpt-image-2.6': {
        const variant = str(input.variant) === 'gpt-image-2.6-sunburst' ? 'gpt-image-2.6-sunburst' : 'gpt-image-2.6-flare';
        const mode = ['low', 'medium', 'high'].includes(str(input.engine)) ? str(input.engine) : 'low';
        const res = str(input.resolution) || '1k';
        const fb =
          mode === 'high'
            ? res === '4k'
              ? 5100
              : res === '2k'
                ? 3300
                : 1800
            : mode === 'medium'
              ? res === '4k'
                ? 1500
                : res === '2k'
                  ? 1200
                  : 600
              : res === '4k'
                ? 900
                : res === '2k'
                  ? 600
                  : 300;
        return lookupPrice(live, variant, { mode, resolution: res }, fb);
      }

      case 'ideogram-4.5': {
        const mode = ['low', 'medium', 'high'].includes(str(input.engine)) ? str(input.engine) : 'low';
        const res = str(input.resolution) === '2k' ? '2k' : '1k';
        const fb =
          mode === 'high'
            ? res === '2k'
              ? 5000
              : 4000
            : mode === 'medium'
              ? res === '2k'
                ? 2000
                : 1600
              : res === '2k'
                ? 1000
                : 800;
        return lookupPrice(live, 'ideogram-4-5', { mode, resolution: res }, fb);
      }

      default:
        return lookupPrice(
          live,
          t.modelId,
          {
            mode: t.defaultMode,
            resolution: str(input.resolution) || undefined,
            duration: str(input.duration) || undefined,
          },
          t.fallbackPrice ?? 2000,
        );
    }
  },

  async submit(tool, input, ctx) {
    const t = tool as GommoToolDef;
    const domain = resolveDomain(ctx.config);

    // 1. Avatar LipSync (`POST /ai/jobs/avatar-lipsync/kling_video_lipsync`)
    if (t.mediaKind === 'avatar') {
      const imgUrlRaw = str(input.image);
      const audUrlRaw = str(input.audio);
      if (!imgUrlRaw) throw new BadRequestException('Vui lòng tải lên ảnh chân dung nhân vật');
      if (!audUrlRaw) throw new BadRequestException('Vui lòng tải lên file giọng nói');
      await resolveMediaSeconds(input, ctx, 'audio', 5, 2, 60, 'File giọng nói');

      const [uploadedImg, audioFile] = await Promise.all([
        uploadImageToGommo(ctx, imgUrlRaw),
        loadInputFile(ctx.readUpload, audUrlRaw),
      ]);
      const form = new FormData();
      form.append('domain', domain);
      form.append('image_url', uploadedImg.url);
      form.append(
        'audio_file',
        new Blob([new Uint8Array(audioFile.data)], { type: audioFile.mimeType || 'audio/mpeg' }),
        audioFile.filename || 'voice.mp3',
      );
      if (str(input.prompt)) form.append('prompt', str(input.prompt));

      const res = await gommoFetch<any>(ctx.config, `/ai/jobs/avatar-lipsync/${encodeURIComponent(t.modelId)}`, {
        multipart: form,
        timeoutMs: 90_000,
      });
      const idBase = str(res?.data?.id_base ?? res?.raw?.videoInfo?.id_base);
      if (!idBase) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ LipSync', res);
      return mapGommoJobStatus(res, `video:${idBase}`, 'video');
    }

    // 2. Music Suno (`POST /ai/jobs/music/{model_id}`)
    if (t.mediaKind === 'music') {
      const modelId = str(input.engine) === 'suno-v5.5' ? 'suno-v5.5' : 'suno-v6.0';
      const title = str(input.title) || 'Bài hát AI';
      const styles = str(input.styles);
      const gender = str(input.gender);
      const payload: Record<string, unknown> = {
        domain,
        name: title,
        prompt: str(input.prompt),
        ...(styles ? { mode: 'custom', styles: styles.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(gender === 'f' || gender === 'm' ? { gender } : {}),
      };
      const res = await gommoFetch<any>(ctx.config, `/ai/jobs/music/${encodeURIComponent(modelId)}`, {
        json: payload,
        timeoutMs: 90_000,
      });
      const idBase = str(res?.data?.id_base ?? res?.raw?.musicInfo?.id_base);
      if (!idBase) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ nhạc', res);
      const projId = str(res?.data?.project_id ?? res?.raw?.musicInfo?.project_id);
      return mapGommoJobStatus(res, projId ? `music:${idBase}:${projId}` : `music:${idBase}`, 'audio');
    }

    // 3. Image AI (`POST /ai/jobs/image/{model_id}`)
    if (t.mediaKind === 'image') {
      const modelId =
        t.key === 'gpt-image-2.6'
          ? str(input.variant) === 'gpt-image-2.6-sunburst'
            ? 'gpt-image-2.6-sunburst'
            : 'gpt-image-2.6-flare'
          : t.modelId;
      const mode =
        t.defaultMode ||
        (t.key === 'seedream-5.5'
          ? 'cheap'
          : ['low', 'medium', 'high'].includes(str(input.engine))
            ? str(input.engine)
            : 'low');
      const rawRefs = Array.isArray(input.images)
        ? input.images.map(str).filter(Boolean)
        : str(input.images)
          ? [str(input.images)]
          : [];
      const uploadedRefs = rawRefs.length
        ? await Promise.all(rawRefs.slice(0, 10).map((u) => uploadImageToGommo(ctx, u)))
        : [];
      const ratio = str(input.aspectRatio) || '1:1';
      const resolution = str(input.resolution) || '1k';
      const payload: Record<string, unknown> = {
        domain,
        prompt: str(input.prompt),
        ratio,
        resolution,
        mode,
        ...(uploadedRefs.length ? { images: uploadedRefs.map((x) => x.url) } : {}),
      };
      const res = await gommoFetch<any>(ctx.config, `/ai/jobs/image/${encodeURIComponent(modelId)}`, {
        json: payload,
        timeoutMs: 90_000,
      });
      const idBase = str(res?.data?.id_base ?? res?.raw?.imageInfo?.id_base);
      if (!idBase) {
        const directFiles = extractResultFiles(res, 'image');
        if (directFiles.length) return { status: 'succeeded', providerTaskId: `image:sync_${Date.now()}`, files: directFiles, raw: res };
        throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ ảnh', res);
      }
      return mapGommoJobStatus(res, `image:${idBase}`, 'image');
    }

    // 4. Video AI (`POST /ai/jobs/video/{model_id}`)
    const modelModeMap: Record<string, string> = {
      'gemini-omni-1.2': 'flash',
      'seedance-2.0-omni': str(input.engine) === 'business_professional' ? 'business_professional' : 'business_fast',
      'seedance-2.0': str(input.engine) === 'professional' ? 'professional' : 'fast',
      'seedance-2.0-mini': 'business_mini',
      'wan-3.0-cheap': 'cheap',
      'kling-2.5-relax': ['relax', 'standard', 'professional'].includes(str(input.engine)) ? str(input.engine) : 'relax',
      'meta-muse-video': 'fast',
      'veo-3.1-lite': str(input.engine) === 'fast' ? 'fast' : 'lite',
      'heygen-video': 'official',
      'genjutsu-replace': 'hf_mult_replace_object_flash',
    };
    const upstreamMode = modelModeMap[t.key] ?? t.defaultMode ?? '';
    const creationMode = t.key === 'genjutsu-replace' ? 'ref' : str(input.mode) || 't2v';

    const rawRefs = Array.isArray(input.images)
      ? input.images.map(str).filter(Boolean)
      : str(input.images)
        ? [str(input.images)]
        : [];
    const startRaw = creationMode === 'i2v' ? str(input.image) : '';
    const endRaw = creationMode === 'i2v' ? str(input.lastFrame) : '';
    const vidRaw = str(input.video);
    const audRaw = str(input.audio);

    if (t.key === 'genjutsu-replace') {
      if (!vidRaw) throw new BadRequestException('Vui lòng tải lên video gốc cần thay vật thể');
      await resolveMediaSeconds(input, ctx, 'video', 5, 4, 15, 'Video gốc');
    }

    const [startImg, endImg, refImgs] = await Promise.all([
      startRaw ? uploadImageToGommo(ctx, startRaw) : Promise.resolve(null),
      endRaw ? uploadImageToGommo(ctx, endRaw) : Promise.resolve(null),
      creationMode === 'ref' && rawRefs.length
        ? Promise.all(rawRefs.slice(0, 10).map((u) => uploadImageToGommo(ctx, u)))
        : Promise.resolve([]),
    ]);

    const useMultipart = Boolean(vidRaw || audRaw);
    let res: any;

    if (useMultipart) {
      const form = new FormData();
      form.append('domain', domain);
      if (str(input.prompt)) form.append('prompt', str(input.prompt));
      if (upstreamMode) form.append('mode', upstreamMode);
      form.append('ratio', t.key === 'genjutsu-replace' ? 'auto' : str(input.aspectRatio) || '16:9');
      if (str(input.resolution)) form.append('resolution', str(input.resolution));
      if (t.key !== 'genjutsu-replace' && str(input.duration)) form.append('duration', str(input.duration));

      refImgs.forEach((img, idx) => {
        form.append(`references[${idx}][url]`, img.url);
        if (img.idBase) form.append(`references[${idx}][id_base]`, img.idBase);
      });
      if (vidRaw) {
        const vf = await loadInputFile(ctx.readUpload, vidRaw);
        form.append('video_files[]', new Blob([new Uint8Array(vf.data)], { type: vf.mimeType || 'video/mp4' }), vf.filename || 'input.mp4');
      }
      if (audRaw) {
        const af = await loadInputFile(ctx.readUpload, audRaw);
        form.append('audio_files[]', new Blob([new Uint8Array(af.data)], { type: af.mimeType || 'audio/mpeg' }), af.filename || 'input.mp3');
      }
      res = await gommoFetch<any>(ctx.config, `/ai/jobs/video/${encodeURIComponent(t.modelId)}`, {
        multipart: form,
        timeoutMs: 120_000,
      });
    } else {
      const params: Record<string, string> = {
        domain,
        prompt: str(input.prompt),
      };
      if (upstreamMode) params.mode = upstreamMode;
      if (str(input.aspectRatio)) params.ratio = str(input.aspectRatio);
      if (str(input.resolution)) params.resolution = str(input.resolution);
      if (str(input.duration)) params.duration = str(input.duration);

      if (startImg) {
        params['images[0][url]'] = startImg.url;
        if (startImg.idBase) params['images[0][id_base]'] = startImg.idBase;
        if (endImg) {
          params['images[1][url]'] = endImg.url;
          if (endImg.idBase) params['images[1][id_base]'] = endImg.idBase;
        }
      }
      refImgs.forEach((img, idx) => {
        params[`references[${idx}][url]`] = img.url;
        if (img.idBase) params[`references[${idx}][id_base]`] = img.idBase;
      });

      res = await gommoFetch<any>(ctx.config, `/ai/jobs/video/${encodeURIComponent(t.modelId)}`, {
        formParams: params,
        timeoutMs: 90_000,
      });
    }

    const idBase = str(res?.data?.id_base ?? res?.raw?.videoInfo?.id_base);
    if (!idBase) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ video', res);
    return mapGommoJobStatus(res, `video:${idBase}`, 'video');
  },

  async poll(tool, id, ctx) {
    const parts = id.split(':');
    const media = parts.length >= 2 ? parts[0] : (tool.output === 'image' ? 'image' : tool.output === 'audio' ? 'music' : 'video');
    const idBase = parts.length >= 2 ? parts[1] : id;
    const projectId = parts.length >= 3 ? parts.slice(2).join(':') : '';

    const formParams: Record<string, string> = { domain: resolveDomain(ctx.config) };
    if (projectId) formParams.project_id = projectId;

    const res = await gommoFetch<any>(ctx.config, `/ai/jobs/${encodeURIComponent(idBase)}?media=${encodeURIComponent(media)}`, {
      formParams,
      timeoutMs: 30_000,
    });
    const outType = media === 'image' ? 'image' : media === 'music' || media === 'audio' ? 'audio' : 'video';
    return mapGommoJobStatus(res, id, outType);
  },

  async balance(ctx) {
    if (!ctx.config.apiKey) return null;
    const body = new URLSearchParams({
      domain: resolveDomain(ctx.config),
      access_token: ctx.config.apiKey.trim(),
    }).toString();
    const res = await fetch('https://api.gommo.net/api/apps/go-mmo/ai/me', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'NovAIStudio/1.0',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const bal = Number(data?.balancesInfo?.domainBalancesInfo?.available ?? data?.balancesInfo?.credits_ai);
    return Number.isFinite(bal) ? { balance: Math.round(bal * 100) / 100, unit: 'credit' } : null;
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    if (!ctx.config.apiKey) return [];
    const live = await getLiveCatalog(ctx.config, true);
    const seen = new Set<string>();
    const out: AiCatalogItem[] = [];
    for (const m of live.values()) {
      const id = str(m.model || m.id_base);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: m.name ? `${m.name} (${id})` : id });
    }
    return out;
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey) return { addedTools: [], removedKeys: [] };
    const live = await getLiveCatalog(ctx.config, true);
    const removedKeys: string[] = [];

    const vidCount = [...live.values()].filter((x) => x.mediaKind === 'video').length;
    const imgCount = [...live.values()].filter((x) => x.mediaKind === 'image').length;
    const musCount = [...live.values()].filter((x) => x.mediaKind === 'music').length;
    const hasLiveModel = (m: string) => live.has(m) || live.has(m.replace(/-/g, '_')) || live.has(m.replace(/_/g, '-'));

    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (t.mediaKind === 'avatar') continue;
      if (t.mediaKind === 'video' && vidCount < 10) continue;
      if (t.mediaKind === 'image' && imgCount < 5) continue;
      if (t.mediaKind === 'music' && musCount < 1) continue;
      if (t.key === 'gpt-image-2.6') {
        if (!hasLiveModel('gpt-image-2.6-flare') && !hasLiveModel('gpt-image-2.6-sunburst')) {
          removedKeys.push(`gommo.${t.key}`);
          TOOLS.splice(i, 1);
        }
        continue;
      }
      if (t.key === 'suno-music') {
        if (!hasLiveModel('suno-v6.0') && !hasLiveModel('suno-v5.5')) {
          removedKeys.push(`gommo.${t.key}`);
          TOOLS.splice(i, 1);
        }
        continue;
      }
      if (t.modelId && !hasLiveModel(t.modelId)) {
        removedKeys.push(`gommo.${t.key}`);
        TOOLS.splice(i, 1);
      }
    }

    const covered = new Set<string>([
      ...TOOLS.map((t) => t.modelId),
      'gemini-omni-flash-1.2',
      'seedance_20_pro_edit',
      'seedance_20_pro',
      'seedance_20_mini',
      'wan_3_0',
      'kling_video_2_5',
      'meta_muse_video',
      'veo_3_1',
      'gpt-image-2.6-flare',
      'gpt-image-2.6-sunburst',
      'suno-v5.5',
      'suno-v6.0',
    ]);
    const usedKeys = new Set(TOOLS.map((t) => t.key));
    const addedTools: AiToolDef[] = [];

    for (const entry of live.values()) {
      const mId = str(entry.model || entry.id_base).trim();
      if (!mId || covered.has(mId)) continue;
      if (entry.mediaKind !== 'video' && entry.mediaKind !== 'image') continue;
      if (entry.status && /disable|inactive|offline|hidden/i.test(entry.status)) continue;

      const priceRows = (entry.prices ?? []).filter((r) => Number(r.price) > 0);
      const flatPrice = Number(entry.price) > 0 ? Number(entry.price) : 0;
      if (!priceRows.length && !flatPrice) continue;

      covered.add(mId);
      if (entry.id_base) covered.add(str(entry.id_base));

      const sortedRows = [...priceRows].sort((a, b) => Number(a.price) - Number(b.price));
      const bestMode = sortedRows[0]?.mode ? String(sortedRows[0].mode) : undefined;
      const fallbackPrice = sortedRows[0]?.price ? Number(sortedRows[0].price) : flatPrice || 2000;

      const baseSlug = mId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
      const toolKey = usedKeys.has(baseSlug) ? `auto-${baseSlug}` : baseSlug;
      usedKeys.add(toolKey);
      const cleanName = sanitizeGommoError(entry.name || mId) || mId;

      if (entry.mediaKind === 'image') {
        const resSet = [...new Set(priceRows.map((r) => str(r.resolution).toLowerCase()).filter(Boolean))];
        const resOpts = (resSet.length ? resSet : ['1k', '2k']).map((r): [string, string] => [r, r.toUpperCase()]);
        const def: GommoToolDef = {
          key: toolKey,
          mediaKind: 'image',
          modelId: mId,
          defaultMode: bestMode,
          fallbackPrice,
          name: cleanName,
          description: `Tạo và chỉnh sửa ảnh AI bằng model ${cleanName}.`,
          category: 'image',
          icon: 'Image',
          output: 'image',
          splitModels: false,
          supportsCost: true,
          unitLabel: 'ảnh',
          pricing: { mode: 'cost', markup: 28 },
          fields: [
            { name: 'prompt', label: 'Mô tả hình ảnh', type: 'textarea', required: true, max: 20_000, placeholder: 'Mô tả chi tiết bức ảnh muốn tạo...' },
            { name: 'images', label: 'Ảnh tham chiếu (tuỳ chọn)', type: 'image', multiple: true, maxFiles: 6, accept: IMG_ACCEPT },
            { name: 'resolution', label: 'Chất lượng', type: 'select', default: resOpts[0][0], options: opts(resOpts) },
            { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', default: '1:1', options: opts([['1:1', '1:1'], ['16:9', '16:9'], ['9:16', '9:16'], ['4:3', '4:3'], ['3:4', '3:4']]) },
          ],
        };
        TOOLS.push(def);
        addedTools.push(def);
      } else {
        const resSet = [...new Set(priceRows.map((r) => str(r.resolution).toLowerCase()).filter(Boolean))];
        const durSet = [...new Set(priceRows.map((r) => Number(r.duration)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
        const resOpts = (resSet.length ? resSet : ['720p', '1080p']).map((r): [string, string] => [r, r.toUpperCase()]);
        const durs = durSet.length ? durSet : [5, 10];
        const defRes = resSet.includes('720p') ? '720p' : resOpts[0][0];
        const defDur = durs.includes(5) ? '5' : String(durs[0]);
        const def: GommoToolDef = {
          key: toolKey,
          mediaKind: 'video',
          modelId: mId,
          defaultMode: bestMode,
          fallbackPrice,
          name: cleanName,
          description: `Tạo video AI bằng model ${cleanName}.`,
          category: 'video',
          icon: 'Video',
          output: 'video',
          splitModels: false,
          supportsCost: true,
          pricing: { mode: 'cost', markup: 28 },
          fields: [
            { name: 'mode', label: 'Chế độ tạo', type: 'select', default: 't2v', options: opts([['t2v', 'Từ văn bản (T2V)'], ['i2v', 'Từ khung hình đầu/cuối (I2V)'], ['ref', 'Ảnh tham chiếu đồng nhất']]) },
            { name: 'prompt', label: 'Mô tả video', type: 'textarea', required: true, max: 20_000, placeholder: 'Mô tả cảnh quay, chuyển động...' },
            { name: 'image', label: 'Ảnh khung đầu (I2V)', type: 'image', accept: IMG_ACCEPT },
            { name: 'lastFrame', label: 'Ảnh khung cuối (tuỳ chọn)', type: 'image', accept: IMG_ACCEPT },
            { name: 'images', label: 'Ảnh tham chiếu (tuỳ chọn)', type: 'image', multiple: true, maxFiles: 6, accept: IMG_ACCEPT },
            { name: 'resolution', label: 'Chất lượng', type: 'select', default: defRes, options: opts(resOpts) },
            { name: 'duration', label: 'Thời lượng', type: 'select', default: defDur, options: durs.map((d) => ({ value: String(d), label: `${d} giây` })) },
            { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', default: '16:9', options: opts([['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']]) },
          ],
        };
        TOOLS.push(def);
        addedTools.push(def);
      }
    }
    return { addedTools, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey) return null;
    const live = await getLiveCatalog(ctx.config, true).catch(() => null);
    if (!live || live.size === 0) return null;
    const down = new Set<string>();
    for (const t of TOOLS) {
      if (t.key === 'gpt-image-2.6') {
        const a = live.get('gpt-image-2.6-flare');
        const b = live.get('gpt-image-2.6-sunburst');
        const aOn = a && (!a.status || a.status.toUpperCase() === 'ON');
        const bOn = b && (!b.status || b.status.toUpperCase() === 'ON');
        if (!aOn && !bOn) down.add(t.key);
        continue;
      }
      if (t.key === 'suno-music') {
        const a = live.get('suno-v6.0');
        const b = live.get('suno-v5.5');
        const aOn = a && (!a.status || a.status.toUpperCase() === 'ON');
        const bOn = b && (!b.status || b.status.toUpperCase() === 'ON');
        if (!aOn && !bOn) down.add(t.key);
        continue;
      }
      const entry = live.get(t.modelId);
      if (!entry || (entry.status && entry.status.toUpperCase() !== 'ON')) {
        down.add(t.key);
      }
    }
    return down;
  },
};
