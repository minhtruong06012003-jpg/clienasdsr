import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiCatalogItem,
  type AiFieldDef,
  type AiFieldOption,
  type AiInput,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderResult,
  type AiToolDef,
} from '../ai.types.js';
import { loadInputFile } from './background.js';
import { str } from './http.js';

/**
 * AIShop24 Video Studio API — https://aishop24.io.vn (`SV16`, T-425)
 * - Xác thực: `Authorization: Bearer sk-as24-...`
 * - Cổng API chính thức:
 *   + Số dư: `GET /api/v1/balance` -> `{ balance, plan, concurrency, active }`
 *   + Bảng giá live: `GET /api/v1/models` -> `{ models: [{ server: "SS", model, resolution, duration, creditCost, discountedCreditCost }] }`
 *   + Upload tham chiếu R2: `POST /api/v1/reference-uploads` -> `PUT signed.url` -> `POST /api/v1/reference-uploads/verify`
 *   + Tạo video: `POST /api/v1/videos` (kèm `Idempotency-Key`)
 *   + Hỏi tiến độ: `GET /api/v1/videos/:id`
 *   + Huỷ / xoá đơn: `DELETE /api/v1/videos/:id`
 * - Tỉ giá gốc mặc định an toàn: `1 credit = 95đ` (`rate = 95`, `markup = 28%`).
 * - Mọi file video kết quả trả qua `data: Buffer` để hệ thống lưu vào storage nội bộ, tuyệt đối không lộ tên miền hay R2 của nguồn.
 */

const DEFAULT_BASE = 'https://aishop24.io.vn';
const SERVER_CODE = 'SS';
const IMG_ACCEPT = 'image/png,image/jpeg,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime,video/webm';
const AUD_ACCEPT = 'audio/mpeg,audio/wav,audio/mp4,audio/x-m4a';

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

function normalizeBaseUrl(raw?: string): string {
  const s = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  return s || DEFAULT_BASE;
}

function sanitizeAs24Error(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/không đủ credit|insufficient|hết credit|out of credit|cần nâng cấp|gói trả phí còn hạn|eligible/i.test(s)) {
    return 'Máy chủ xử lý đang tạm ngưng nhận đơn để đồng bộ hạn mức, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/401|invalid_key|api key|unauthorized/i.test(s)) {
    return 'Kết nối máy chủ xử lý tạm gián đoạn xác thực, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/429|rate_limit|vượt tốc độ|quá nhiều yêu cầu|concurrency|quá số luồng/i.test(s)) {
    return 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây. Tiền đã được hoàn lại vào ví.';
  }
  if (/policy|unsafe|nsfw|vi phạm|kiểm duyệt|sensitive|người thật/i.test(s)) {
    return 'Nội dung mô tả hoặc tệp tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.';
  }
  return s
    .replace(/(?:https?:\/\/)?[\w.-]*aishop24[\w.-]*\.[a-z.]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\baishop24(?:\.io\.vn)?\b/gi, 'Hệ thống AI')
    .replace(/\bđã hoàn\s+\d+\s*credit\b/gi, 'Tiền đã được hoàn lại vào ví')
    .replace(/\bcredit\b/gi, 'đơn vị')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractErrorMsg(data: any, status: number): string {
  const cand = data?.error?.message ?? data?.error ?? data?.message ?? data?.note ?? data?.rawText;
  if (typeof cand === 'string' && cand.trim()) return sanitizeAs24Error(cand);
  return `Máy chủ xử lý trả lỗi (HTTP ${status})`;
}

async function as24Json<T = any>(
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
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'NovAIStudio/1.0',
        ...(extraHeaders as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AiProviderError('Kết nối máy chủ xử lý tạm gián đoạn, hệ thống sẽ tự thử lại', { error: (err as Error).message }, true);
  }

  if (res.status === 204) return {} as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { rawText: text.slice(0, 500) };
  }

  if (!res.ok) {
    const msg = extractErrorMsg(data, res.status);
    const retryable = res.status === 429 || res.status >= 500;
    throw new AiProviderError(msg, data, retryable);
  }
  return data as T;
}

/** Bảng giá credit chuẩn nhánh SS (fallback tức thời khi mới khởi động hoặc tính ma trận giá mẫu) */
const FALLBACK_COSTS: Record<string, Record<string, number>> = {
  'Seedance 2.5': {
    '5|480p': 46, '8|480p': 52, '10|480p': 65, '12|480p': 78, '15|480p': 98, '20|480p': 124, '30|480p': 175,
    '5|720p': 65, '8|720p': 85, '10|720p': 111, '12|720p': 130, '15|720p': 149, '20|720p': 186, '30|720p': 260,
    '5|1080p': 98, '8|1080p': 130, '10|1080p': 162, '12|1080p': 195, '15|1080p': 227, '20|1080p': 282, '30|1080p': 389,
  },
  'Seedance 2.5 Flash': {
    '5|480p': 39, '8|480p': 50, '10|480p': 59, '12|480p': 72, '15|480p': 89, '20|480p': 111, '30|480p': 156,
    '5|720p': 56, '8|720p': 76, '10|720p': 98, '12|720p': 114, '15|720p': 134, '20|720p': 168, '30|720p': 234,
    '5|1080p': 82, '8|1080p': 108, '10|1080p': 136, '12|1080p': 162, '15|1080p': 195, '20|1080p': 247, '30|1080p': 350,
  },
  'Seedance 2.0 Mini': {
    '5|480p': 26, '8|480p': 39, '10|480p': 46, '12|480p': 59, '15|480p': 72,
    '5|720p': 39, '8|720p': 59, '10|720p': 72, '12|720p': 85, '15|720p': 104,
  },
  'Seedance 2.0': {
    '5|480p': 33, '8|480p': 46, '10|480p': 52, '12|480p': 65, '15|480p': 78,
    '5|720p': 46, '8|720p': 65, '10|720p': 85, '12|720p': 98, '15|720p': 117,
    '5|1080p': 65, '8|1080p': 85, '10|1080p': 111, '12|1080p': 130, '15|1080p': 162,
  },
  'Veo 3.1 Fast': {
    '8|720p': 149, '8|1080p': 195,
  },
};

let livePriceCache: { at: number; map: Record<string, Record<string, number>> } | null = null;

async function getLiveCostMap(cfg: AiProviderConfig, force = false): Promise<Record<string, Record<string, number>>> {
  if (!force && livePriceCache && Date.now() - livePriceCache.at < 120_000) return livePriceCache.map;
  if (!cfg.apiKey?.trim()) return FALLBACK_COSTS;
  try {
    const res = await as24Json<{ models?: any[] }>(cfg, '/api/v1/models', { timeoutMs: 12_000 });
    const next: Record<string, Record<string, number>> = {};
    for (const m of res.models ?? []) {
      if (typeof m?.model !== 'string' || typeof m?.server !== 'string') continue;
      const dur = Number(m.duration);
      const resNum = Number(m.resolution);
      const now = Date.now();
      const promoActive = !m.promotionEndsAt || now < Number(m.promotionEndsAt);
      const cost = Number(promoActive ? (m.discountedCreditCost ?? m.creditCost) : m.creditCost);
      if (!Number.isFinite(dur) || !Number.isFinite(resNum) || !Number.isFinite(cost) || cost <= 0) continue;
      const srvKey = `${m.server}:${m.model}`;
      next[srvKey] ??= {};
      next[srvKey][`${dur}|${resNum}p`] = cost;
      if (m.server === SERVER_CODE) {
        next[m.model] ??= {};
        next[m.model][`${dur}|${resNum}p`] = cost;
      }
    }
    if (Object.keys(next).length > 0) {
      livePriceCache = { at: Date.now(), map: { ...FALLBACK_COSTS, ...next } };
      return livePriceCache.map;
    }
  } catch {
    // dùng bảng giá fallback nếu mạng chập chờn
  }
  return FALLBACK_COSTS;
}

interface ModelSpec {
  key: string;
  serverCode?: string;
  upstreamModel: string;
  name: string;
  description: string;
  durations: number[];
  resolutions: number[];
  defaultOption: string;
  featured?: boolean;
}

const MODEL_SPECS: ModelSpec[] = [
  {
    key: 'seedance-2-5',
    upstreamModel: 'Seedance 2.5',
    name: 'Seedance 2.5 · Tới 30s, kèm ảnh/video/audio tham chiếu',
    description: 'Tạo video Seedance 2.5 độ nét 480p / 720p / 1080p dài tới 30 giây, có âm thanh tự động và hỗ trợ đa tham chiếu (@Image1, @Video1, @Audio1).',
    durations: [5, 8, 10, 12, 15, 20, 30],
    resolutions: [480, 720, 1080],
    defaultOption: '5|720p',
    featured: true,
  },
  {
    key: 'seedance-2-5-flash',
    upstreamModel: 'Seedance 2.5 Flash',
    name: 'Seedance 2.5 Flash · Tới 30s siêu tiết kiệm',
    description: 'Bản tạo nhanh giá siêu tiết kiệm của Seedance 2.5 (480p / 720p / 1080p, dài tới 30 giây, kèm ảnh/video/audio tham chiếu).',
    durations: [5, 8, 10, 12, 15, 20, 30],
    resolutions: [480, 720, 1080],
    defaultOption: '5|720p',
    featured: true,
  },
  {
    key: 'seedance-2-0-mini',
    upstreamModel: 'Seedance 2.0 Mini',
    name: 'Seedance 2.0 Mini · Đa tham chiếu tiết kiệm (480p/720p)',
    description: 'Tạo video Seedance 2.0 Mini giá rẻ (5s–15s, 480p/720p, có âm thanh, ghép nhiều ảnh/video/audio tham chiếu).',
    durations: [5, 8, 10, 12, 15],
    resolutions: [480, 720],
    defaultOption: '5|720p',
  },
  {
    key: 'seedance-2-0',
    upstreamModel: 'Seedance 2.0',
    name: 'Seedance 2.0 · Video 480p – 1080p (tới 15s)',
    description: 'Tạo video Seedance 2.0 từ văn bản hoặc đa tham chiếu tới 15 giây (480p / 720p / 1080p).',
    durations: [5, 8, 10, 12, 15],
    resolutions: [480, 720, 1080],
    defaultOption: '5|720p',
  },
  {
    key: 'veo-3-1-fast',
    upstreamModel: 'Veo 3.1 Fast',
    name: 'Google Veo 3.1 Fast (8s · 720p/1080p)',
    description: 'Tạo video Google Veo 3.1 Fast 8 giây có âm thanh.',
    durations: [8],
    resolutions: [720, 1080],
    defaultOption: '8|720p',
  },
];

function buildFields(spec: ModelSpec): AiFieldDef[] {
  const isSeedance = spec.upstreamModel.startsWith('Seedance');
  const defParsed = /^(\d+)\|(\d+)p?$/i.exec(spec.defaultOption);
  const defDur = defParsed ? defParsed[1] : String(spec.durations[0]);
  const defRes = defParsed ? `${defParsed[2]}p` : `${spec.resolutions[0]}p`;
  const fields: AiFieldDef[] = [
    {
      name: 'prompt',
      label: 'Mô tả video',
      type: 'textarea',
      required: true,
      max: 100_000,
      placeholder: isSeedance
        ? 'Mô tả cảnh quay, chuyển động... Khi tải nhiều ảnh/video/audio tham chiếu có thể gọi @Image1, @Image2, @Video1, @Audio1 trong mô tả.'
        : 'Mô tả cảnh quay, ánh sáng, chuyển động camera...',
    },
    {
      name: 'images',
      label: 'Ảnh tham chiếu (tuỳ chọn)',
      type: 'image',
      multiple: true,
      maxFiles: 10,
      accept: IMG_ACCEPT,
      help: 'Tối đa 10 ảnh JPG/PNG/WebP. Gọi theo thứ tự @Image1, @Image2... trong mô tả.',
    },
  ];
  if (isSeedance) {
    fields.push(
      {
        name: 'video',
        label: 'Video tham chiếu (tuỳ chọn, 2–8 giây)',
        type: 'video',
        accept: VID_ACCEPT,
        help: 'MP4/MOV/WebM dài 2–8 giây (gọi @Video1 trong mô tả nếu cần).',
      },
      {
        name: 'audioFile',
        label: 'Âm thanh tham chiếu (tuỳ chọn, 2–15 giây)',
        type: 'audio',
        accept: AUD_ACCEPT,
        help: 'MP3/WAV/M4A dài 2–15 giây (cần kèm ít nhất 1 ảnh hoặc 1 video tham chiếu).',
      },
    );
  }
  fields.push(
    {
      name: 'resolution',
      label: 'Chất lượng',
      type: 'select',
      required: true,
      default: defRes,
      options: spec.resolutions.map((r) => ({ value: `${r}p`, label: `${r}p${r === 1080 ? ' Full HD' : r === 720 ? ' HD' : ''}` })),
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
      default: '16:9',
      options: opts([
        ['16:9', '16:9 (Ngang)'],
        ['9:16', '9:16 (Dọc Reels/TikTok)'],
        ['1:1', '1:1 (Vuông)'],
        ['21:9', '21:9 (Điện ảnh)'],
      ]),
    },
    {
      name: 'withAudio',
      label: 'Tạo âm thanh tự động',
      type: 'boolean',
      default: true,
    },
  );
  return fields;
}

function parseOption(input: AiInput, spec: ModelSpec): { duration: number; resolution: number; comboKey: string } {
  const fm = /^(\d+)\|(\d+)p?$/i.exec(spec.defaultOption);
  const defDur = fm ? Number(fm[1]) : spec.durations[0];
  const defRes = fm ? Number(fm[2]) : spec.resolutions[0];

  if (input.option) {
    const m = /^(\d+)\|(\d+)p?$/i.exec(String(input.option).trim());
    if (m) return { duration: Number(m[1]), resolution: Number(m[2]), comboKey: `${m[1]}|${m[2]}p` };
  }
  const rawDur = Number(String(input.duration ?? '').replace(/[^\d]/g, ''));
  const duration = spec.durations.includes(rawDur) ? rawDur : defDur;
  const rawRes = Number(String(input.resolution ?? input.quality ?? '').replace(/[^\d]/g, ''));
  const resolution = spec.resolutions.includes(rawRes) ? rawRes : defRes;
  return { duration, resolution, comboKey: `${duration}|${resolution}p` };
}

function normalizePromptTags(prompt: string, imageCount: number): string {
  let out = prompt;
  if (imageCount > 0) {
    out = out.replace(/<IMAGE_(\d+)>/gi, (_m, idxStr) => `@Image${Number(idxStr) + 1}`);
    out = out.replace(/\bImage\s+(\d+)\b/gi, (_m, nStr) => {
      const n = Number(nStr);
      return n >= 1 && n <= imageCount ? `@Image${n}` : _m;
    });
  }
  return out;
}

async function uploadRefToR2(
  cfg: AiProviderConfig,
  kind: 'images' | 'videos' | 'audios',
  buf: Buffer,
  mime: string,
  name: string,
): Promise<{ key: string; name: string }> {
  const signed = await as24Json<{ key: string; url: string; headers?: Record<string, string> }>(
    cfg,
    '/api/v1/reference-uploads',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, name, mime, size: buf.length }),
      timeoutMs: 45_000,
    },
  );
  if (!signed?.url || !signed?.key) {
    throw new AiProviderError('Không khởi tạo được phiên tải tệp tham chiếu lên máy chủ xử lý');
  }
  const putRes = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers ?? { 'Content-Type': mime },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(120_000),
  });
  if (!putRes.ok) {
    throw new AiProviderError(`Không tải được tệp tham chiếu lên máy chủ xử lý (HTTP ${putRes.status})`, undefined, putRes.status >= 500);
  }
  return { key: signed.key, name };
}

const TOOLS: AiToolDef[] = MODEL_SPECS.map((spec) => ({
  key: spec.key,
  name: spec.name,
  description: spec.description,
  category: 'video',
  icon: 'Film',
  output: 'video',
  featured: spec.featured,
  supportsCost: true,
  supportsDurationTiers: spec.durations.includes(30),
  fields: buildFields(spec),
  pricing: { mode: 'cost', markup: 28 },
}));

export const aishop24Provider: AiProvider = {
  key: 'aishop24',
  name: 'AIShop24 Studio (aishop24.io.vn)',
  website: 'https://aishop24.io.vn',
  costUnit: 'credit',
  rate: 95,
  tools: TOOLS,

  async balance(ctx) {
    const res = await as24Json<{ balance?: number; plan?: string; concurrency?: number; active?: number }>(ctx.config, '/api/v1/balance', {
      timeoutMs: 15_000,
    });
    const bal = Number(res?.balance);
    if (!Number.isFinite(bal)) return null;
    return {
      balance: bal,
      unit: 'credit',
    };
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    const map = await getLiveCostMap(ctx.config);
    return Object.keys(map)
      .filter((k) => k.includes(':'))
      .map((m) => ({ id: m, label: m }));
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const map = await getLiveCostMap(ctx.config, true);
    const livePairKeys = new Set(Object.keys(map).filter((k) => k.includes(':')));
    const removedKeys: string[] = [];

    if (livePairKeys.size >= 10) {
      for (let i = MODEL_SPECS.length - 1; i >= 0; i--) {
        const s = MODEL_SPECS[i];
        const srvModel = `${s.serverCode ?? SERVER_CODE}:${s.upstreamModel}`;
        if (!livePairKeys.has(srvModel)) {
          MODEL_SPECS.splice(i, 1);
          const tIdx = TOOLS.findIndex((t) => t.key === s.key);
          if (tIdx >= 0) TOOLS.splice(tIdx, 1);
          removedKeys.push(`aishop24.${s.key}`);
        }
      }
    }

    const covered = new Set(MODEL_SPECS.map((s) => `${s.serverCode ?? SERVER_CODE}:${s.upstreamModel}`));
    const usedKeys = new Set(TOOLS.map((t) => t.key));
    const addedTools: AiToolDef[] = [];

    for (const [srvModel, combos] of Object.entries(map)) {
      if (!srvModel.includes(':') || covered.has(srvModel)) continue;
      const [srv, rawModel] = srvModel.split(':', 2);
      // Bỏ qua cụm PX (bán lại nguồn khác với mã hash nội bộ dài) để tránh rác trùng lặp
      if (srv === 'PX') continue;
      const comboKeys = Object.keys(combos);
      if (!comboKeys.length) continue;

      const durs = [...new Set(comboKeys.map((c) => Number(c.split('|')[0])).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
      const ress = [...new Set(comboKeys.map((c) => Number((c.split('|')[1] || '').replace(/p$/i, ''))).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
      if (!durs.length || !ress.length) continue;

      const strippedModel = rawModel.replace(/-[0-9a-f]{8,}$/i, '');
      const baseSlug = `${srv === SERVER_CODE ? '' : `${srv.toLowerCase()}-`}${strippedModel}`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const toolKey = usedKeys.has(baseSlug) ? `auto-${baseSlug}` : baseSlug;
      usedKeys.add(toolKey);
      covered.add(srvModel);

      const prettyLabel = strippedModel
        .replace(/_/g, ' ')
        .replace(/\bs2\b/gi, 'S2')
        .replace(/\bseedance\s*25\b/gi, 'Seedance 2.5')
        .replace(/\bminimax\s*h3\b/gi, 'MiniMax H3')
        .replace(/\bomni\s*flash\b/gi, 'Omni Flash')
        .replace(/\bmotion\s*control\b/gi, 'Motion Control')
        .replace(/\bwan\b/gi, 'Wan')
        .replace(/\b\w/g, (ch) => ch.toUpperCase());

      const defRes = ress.includes(720) ? 720 : ress[0];
      const defDur = durs.includes(5) ? 5 : durs[0];
      const defCombo = combos[`${defDur}|${defRes}p`] ? `${defDur}|${defRes}p` : comboKeys[0];

      const spec: ModelSpec = {
        key: toolKey,
        serverCode: srv,
        upstreamModel: rawModel,
        name: `${prettyLabel} (${ress.map((r) => `${r}p`).join('/')} · ${durs.map((d) => `${d}s`).join('/')})`,
        description: `Tạo video AI bằng model ${prettyLabel}.`,
        durations: durs,
        resolutions: ress,
        defaultOption: defCombo,
      };
      MODEL_SPECS.push(spec);
      const def: AiToolDef = {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        category: 'video',
        icon: 'Film',
        output: 'video',
        supportsCost: true,
        supportsDurationTiers: spec.durations.includes(30),
        fields: buildFields(spec),
        pricing: { mode: 'cost', markup: 28 },
      };
      TOOLS.push(def);
      addedTools.push(def);
    }
    return { addedTools, removedKeys };
  },

  async maintenanceCheck(ctx): Promise<Set<string> | 'ALL' | null> {
    try {
      const base = normalizeBaseUrl(ctx.config.baseUrl);
      const capRes = await fetch(`${base}/api/provider-capabilities`, {
        headers: { Accept: 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!capRes.ok) return null;
      const cap = (await capRes.json()) as { servers?: any[] };
      const servers = Array.isArray(cap.servers) ? cap.servers : [];
      if (!servers.length) return null;
      const maintSet = new Set<string>();
      for (const spec of MODEL_SPECS) {
        const srvCode = spec.serverCode ?? SERVER_CODE;
        const ss = servers.find((s) => s?.code === srvCode);
        if (!ss || ss.maintenance === true || ss.enabled === false) {
          maintSet.add(spec.key);
          continue;
        }
        const found = (ss.models ?? []).find((m: any) => m?.model === spec.upstreamModel);
        if (!found || found.maintenance === true || found.enabled === false) {
          maintSet.add(spec.key);
        }
      }
      return maintSet;
    } catch {
      return null;
    }
  },

  async cost(tool, input, ctx) {
    const spec = MODEL_SPECS.find((s) => s.key === tool.key);
    if (!spec) return null;
    const { comboKey } = parseOption(input, spec);
    const map = await getLiveCostMap(ctx.config, Boolean(input.__fresh));
    const srvModel = `${spec.serverCode ?? SERVER_CODE}:${spec.upstreamModel}`;
    const c = map[srvModel]?.[comboKey] ?? map[spec.upstreamModel]?.[comboKey] ?? FALLBACK_COSTS[spec.upstreamModel]?.[comboKey];
    return typeof c === 'number' && c > 0 ? c : null;
  },

  async submit(tool, input: AiInput, ctx: AiCallContext): Promise<AiProviderResult> {
    const spec = MODEL_SPECS.find((s) => s.key === tool.key);
    if (!spec) throw new BadRequestException(`Không tìm thấy cấu hình model ${tool.key}`);

    const rawPrompt = str(input.prompt).trim();
    if (!rawPrompt) throw new BadRequestException('Vui lòng nhập mô tả video');

    const imgUrls = (Array.isArray(input.images) ? input.images : input.images ? [input.images] : [])
      .map((x) => str(x).trim())
      .filter(Boolean);
    const vidUrl = str(input.video).trim();
    const audUrl = str(input.audioFile).trim();

    if (audUrl && imgUrls.length === 0 && !vidUrl) {
      throw new BadRequestException('Âm thanh tham chiếu cần kèm ít nhất 1 ảnh hoặc 1 video tham chiếu');
    }

    let preparedVidUrl = vidUrl;
    if (preparedVidUrl) {
      const dur = await ctx.uploadDuration(preparedVidUrl);
      if (dur !== null && dur < 2) {
        throw new BadRequestException('Video tham chiếu cần dài tối thiểu 2 giây');
      }
      if (dur !== null && dur > 8.2 && ctx.trimVideoTail) {
        preparedVidUrl = await ctx.trimVideoTail(preparedVidUrl, Math.max(0.5, dur - 8));
      }
      if (ctx.ensureVideoMaxBytes) {
        preparedVidUrl = await ctx.ensureVideoMaxBytes(preparedVidUrl, 45 * 1024 * 1024);
      }
    }
    if (audUrl) {
      const adur = await ctx.uploadDuration(audUrl);
      if (adur !== null && (adur < 2 || adur > 15.5)) {
        throw new BadRequestException('Âm thanh tham chiếu cần có độ dài từ 2 đến 15 giây');
      }
    }

    const { duration, resolution } = parseOption(input, spec);
    const ratio = str(input.aspectRatio || '16:9');
    const audio = input.withAudio !== false && input.withAudio !== 'false';
    const hasMedia = imgUrls.length > 0 || Boolean(preparedVidUrl) || Boolean(audUrl);
    const prompt = normalizePromptTags(rawPrompt, imgUrls.length);

    const payload: Record<string, unknown> = {
      server: spec.serverCode ?? SERVER_CODE,
      model: spec.upstreamModel,
      mode: hasMedia ? 'reference' : 'text',
      prompt,
      duration,
      resolution,
      ratio,
      audio,
    };

    if (hasMedia) {
      const references: { images: { key: string; name: string }[]; videos: { key: string; name: string }[]; audios: { key: string; name: string }[] } = {
        images: [],
        videos: [],
        audios: [],
      };
      for (let i = 0; i < imgUrls.length; i++) {
        const imgUrl = ctx.ensureStandardImage ? await ctx.ensureStandardImage(imgUrls[i]) : imgUrls[i];
        const loaded = await loadInputFile(ctx.readUpload, imgUrl);
        const ext = loaded.mimeType === 'image/png' ? 'png' : loaded.mimeType === 'image/webp' ? 'webp' : 'jpg';
        const mime = loaded.mimeType === 'image/png' || loaded.mimeType === 'image/webp' ? loaded.mimeType : 'image/jpeg';
        references.images.push(await uploadRefToR2(ctx.config, 'images', loaded.data, mime, `image${i + 1}.${ext}`));
      }
      if (preparedVidUrl) {
        const loadedVid = await loadInputFile(ctx.readUpload, preparedVidUrl);
        const ext = loadedVid.mimeType === 'video/webm' ? 'webm' : loadedVid.mimeType === 'video/quicktime' ? 'mov' : 'mp4';
        const mime = loadedVid.mimeType === 'video/webm' || loadedVid.mimeType === 'video/quicktime' ? loadedVid.mimeType : 'video/mp4';
        references.videos.push(await uploadRefToR2(ctx.config, 'videos', loadedVid.data, mime, `video1.${ext}`));
      }
      if (audUrl) {
        const loadedAud = await loadInputFile(ctx.readUpload, audUrl);
        const ext = loadedAud.mimeType.includes('wav') ? 'wav' : loadedAud.mimeType.includes('mp4') || loadedAud.mimeType.includes('m4a') ? 'm4a' : 'mp3';
        const mime = ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
        references.audios.push(await uploadRefToR2(ctx.config, 'audios', loadedAud.data, mime, `audio1.${ext}`));
      }
      await as24Json(ctx.config, '/api/v1/reference-uploads/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(references),
        timeoutMs: 30_000,
      });
      payload.r2References = references;
    }

    const created = await as24Json<any>(ctx.config, '/api/v1/videos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    });

    const job = created?.video ?? created?.job ?? created;
    const jobId = str(job?.id).trim();
    if (!jobId) throw new AiProviderError('Máy chủ xử lý không trả về mã tác vụ hợp lệ', created);
    return { status: 'processing', providerTaskId: jobId, progress: 5, raw: created };
  },

  async poll(_tool, providerTaskId, ctx): Promise<AiProviderResult> {
    const res = await as24Json<any>(ctx.config, `/api/v1/videos/${encodeURIComponent(providerTaskId)}`, { timeoutMs: 30_000 });
    const job = res?.video ?? res?.job ?? res;
    const state = String(job?.state ?? job?.status ?? '').toUpperCase();

    if (state === 'DONE' || state === 'SUCCEEDED' || state === 'COMPLETED') {
      const rawUrl = str(job?.downloadUrl || job?.videoUrl || job?.resultUrl || `/media/${providerTaskId}.mp4`).trim();
      const base = normalizeBaseUrl(ctx.config.baseUrl);
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${base}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      const dl = await fetch(fullUrl, {
        headers: {
          Authorization: `Bearer ${(ctx.config.apiKey || '').trim()}`,
          'User-Agent': 'NovAIStudio/1.0',
        },
        signal: AbortSignal.timeout(120_000),
      });
      if (!dl.ok) {
        throw new AiProviderError(`Không tải được video kết quả từ nguồn (HTTP ${dl.status})`, job, dl.status >= 500);
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      return {
        status: 'succeeded',
        progress: 100,
        files: [{ url: '', type: 'video', name: 'seedance.mp4', data: buf, mimeType: 'video/mp4' }],
        raw: job,
      };
    }

    if (state === 'ERROR' || state === 'FAILED' || state === 'CANCELLED') {
      const err = sanitizeAs24Error(job?.error?.message || job?.error || job?.note || 'Tác vụ xử lý không thành công');
      return { status: 'failed', error: err || 'Tác vụ xử lý không thành công, tiền đã được hoàn lại vào ví.', raw: job };
    }

    const p = Number(job?.progress);
    const progress = Number.isFinite(p) && p > 0 ? Math.min(99, Math.max(5, Math.round(p))) : 25;
    return { status: 'processing', progress, raw: job };
  },

  async cancel(_tool, providerTaskId, ctx) {
    const base = normalizeBaseUrl(ctx.config.baseUrl);
    const apiKey = (ctx.config.apiKey || '').trim();
    const url = `${base}/api/v1/videos/${encodeURIComponent(providerTaskId)}`;
    try {
      const del = await fetch(url, {
        method: 'DELETE',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'NovAIStudio/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (del.ok) {
        return { ok: true, httpStatus: del.status, upstreamStatus: 'cancelled', note: 'Đã gọi huỷ/xoá đơn trên nguồn thành công' };
      }
      const stRes = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'NovAIStudio/1.0' },
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
      const stJson = stRes ? await stRes.json().catch(() => null) : null;
      const upstreamState = String((stJson?.video ?? stJson?.job ?? stJson)?.state ?? del.status);
      return {
        ok: false,
        httpStatus: del.status,
        upstreamStatus: upstreamState,
        note: `Nguồn phản hồi HTTP ${del.status} khi huỷ · Trạng thái nguồn: ${upstreamState}`,
      };
    } catch (err) {
      return { ok: false, upstreamStatus: 'error', note: `Không kết nối được nguồn khi gọi huỷ: ${(err as Error).message.slice(0, 120)}` };
    }
  },
};
