import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProviderError, type AiCallContext, type AiFieldOption, type AiInput, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { backgroundState, loadInputFile, sleep, startBackground } from './background.js';
import { joinUrl, pickMessage, str } from './http.js';

/**
 * IMG Studio — https://imgstudio.site/docs/api (base https://imgstudio.site, header Authorization: Bearer img_...).
 * API gốc v1, mọi lệnh tạo đều ĐỒNG BỘ (chờ tới khi xong) và bắt buộc Idempotency-Key:
 * - POST /api/v1/images/generate (JSON) · POST /api/v1/images/edit (multipart) · POST /api/v1/images/upscale (multipart)
 *   · POST /api/v1/videos (multipart, 1–4 phút);
 * - gửi lại CÙNG key khi đang chạy -> 202 { retry_after_ms }; đã xong -> trả lại kết quả cũ, không trừ tiền lần hai;
 * - file kết quả GET /api/v1/images|videos/{id}/file cần Bearer, chỉ lưu ~6 giờ -> adapter tải về luôn (trả `data`).
 * Vì đồng bộ nên chạy nền (background.ts): submit trả `processing` ngay, poll đọc kết quả.
 * Giá: catalog công khai ở trang /pricing (đơn vị VNĐ) -> công cụ dùng pricing `cost` (credits = giá VNĐ × tỉ giá 1 + % lãi).
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

/** Bậc độ phân giải: 4KP = 4K cao cấp (nâng cấp bằng bộ upscale cao cấp, có phụ phí) */
type Res = '1K' | '2K' | '4K' | '4KP';
const RES: Res[] = ['1K', '2K', '4K', '4KP'];
const RES_LABEL: Record<Res, string> = { '1K': '1K', '2K': '2K', '4K': '4K', '4KP': '4K cao cấp' };

/**
 * Model ảnh (catalog trang /pricing, 30/10/2026): [id, tên, nguồn chỉ 1K?, sửa ảnh được?, giá tạo, giá sửa] — giá VNĐ theo 1K/2K/4K/4KP.
 * Model chỉ có nguồn 1K (Muse, nhóm Grok giá rẻ) chỉ nhận 1K và 4KP; gửi 2K/4K bị 400.
 */
type ImageModel = [id: string, name: string, only1k: boolean, edit: boolean, gen: number[], editPrice: number[]];
const IMAGE_MODELS: ImageModel[] = [
  ['flow-nano-banana-2-lite', 'Nano Banana 2 Lite', false, true, [100, 150, 300, 850], [100, 150, 300, 850]],
  ['flow-nano-banana-2', 'Nano Banana 2.1', false, true, [100, 150, 300, 850], [100, 150, 300, 850]],
  ['flow-nano-banana-pro', 'Nano Banana Pro', false, true, [100, 150, 300, 850], [100, 150, 300, 850]],
  ['3a869437-b87a-460b-9fe7-23c27d234f3a', 'Gemini 2.5 Flash Image', false, true, [100, 150, 300, 850], [100, 150, 300, 850]],
  ['c604136c-0756-49a0-a826-cfc72b68cb9a', 'Gemini 3.1 Flash Image', false, true, [150, 200, 350, 900], [150, 200, 350, 900]],
  ['301fed0f-82b9-47f7-b2a0-e710ae5e4d55', 'Gemini 3 Pro Image', false, true, [350, 350, 500, 1050], [350, 350, 500, 1050]],
  ['686ef278-e903-49a0-9e3c-2401fd396d22', 'GPT Image 2', false, true, [150, 150, 300, 850], [250, 250, 400, 950]],
  ['2924ac96-8708-4e2a-8700-df3eebbfa380', 'GPT Image 2 · Chất lượng cao (chậm)', false, true, [150, 150, 300, 850], [200, 200, 350, 900]],
  ['58529d86-ba18-442f-9e14-94595bb78631', 'GPT Image 2.5 Flare', false, true, [150, 200, 350, 900], [250, 250, 400, 950]],
  ['cc0389af-0c32-40b1-b807-a87836898e2a', 'GPT Image 2.5 Flare · Chất lượng cao (chậm)', false, true, [150, 150, 300, 850], [250, 250, 400, 950]],
  ['0927e191-1aef-4c56-a3ac-df0c47d84e80', 'GPT Image 2.5 Sunburst', false, true, [150, 200, 350, 900], [250, 250, 400, 950]],
  ['8e0d1e2f-1f64-4ad0-8d77-0c5350f92e8d', 'GPT Image 2.5 Sunburst · Chất lượng cao (chậm)', false, true, [200, 200, 350, 900], [250, 250, 400, 950]],
  ['4e365439-00de-46ec-ae02-9c9df3280b7a', 'GPT Image 2.5 · Chất lượng cao (chậm)', false, true, [200, 200, 350, 900], [200, 200, 350, 900]],
  ['imgapi-vip-gpt-image-2-5', 'GPT Image 2.5 VIP', false, true, [300, 350, 500, 1050], [300, 350, 500, 1050]],
  ['ef03047d-3ee5-44dd-94a7-bd48749bbaf5', 'Grok Imagine Image', true, false, [200, 200, 350, 900], [250, 250, 400, 950]],
  ['2894b9e2-3f9a-4539-8279-df4901a3e96f', 'Grok Imagine Image Quality', true, true, [550, 550, 700, 1250], [550, 550, 700, 1250]],
  ['kie-grok-imagine-image-2', 'Grok Imagine Image 2.0', false, true, [650, 700, 850, 1400], [650, 700, 850, 1400]],
  ['muse-image', 'Muse Image', true, true, [100, 100, 250, 800], [100, 100, 250, 800]],
  ['kie-qwen-image-2-1', 'Qwen Image 2.1', false, true, [650, 1300, 1450, 2000], [650, 1300, 1450, 2000]],
  ['imgapi-vip-seedream-5-0-pro', 'Seedream 5.0 Pro', false, false, [550, 700, 850, 1400], [550, 700, 850, 1400]],
];
const MODEL = new Map(IMAGE_MODELS.map((m) => [m[0], m]));
const resOf = (m: ImageModel): Res[] => (m[2] ? ['1K', '4KP'] : RES);
/** Lựa chọn độ phân giải theo model (form khách đổi theo model đang chọn) */
const resByModel = (list: ImageModel[]) => ({ field: 'model', map: Object.fromEntries(list.map((m) => [m[0], resOf(m).map((r) => ({ value: r, label: RES_LABEL[r] }))])) });

/** Model video (catalog /pricing): [id, tên, thời lượng cho chọn]; IMG Studio tự ép về bậc hợp lệ gần nhất */
const VIDEO_MODELS: [string, string, number[]][] = [
  ['flow-veo-3.1-fast', 'Google Veo 3.1 Fast', [4, 6, 8]],
  ['flow-omni-flash', 'Gemini Omni Flash', [4, 6, 8, 10]],
  ['muse-video', 'Muse Video', [6, 10]],
];
const VIDEO_PRICE = 1500;
const UPSCALE_PRICE = 600;

const RATIOS = opts([
  ['1:1', '1:1 (vuông)'],
  ['9:16', '9:16 (dọc)'],
  ['3:4', '3:4 (dọc)'],
  ['2:3', '2:3 (dọc)'],
  ['16:9', '16:9 (ngang)'],
  ['4:3', '4:3 (ngang)'],
  ['3:2', '3:2 (ngang)'],
]);
const QUALITY = opts([
  ['standard', 'Tiêu chuẩn'],
  ['high', 'Cao'],
]);
const IMG = 'image/png,image/jpeg,image/webp';
const RES_HELP = '4K cao cấp: nâng lên đúng 4K bằng bộ upscale cao cấp (không dùng được với nền trong suốt).';

const editModels = IMAGE_MODELS.filter((m) => m[3]);

const TOOLS: AiToolDef[] = [
  {
    key: 'image',
    name: 'Tạo ảnh AI',
    category: 'image',
    icon: 'image',
    description: 'Tạo ảnh từ mô tả với hơn 20 model: Nano Banana, GPT Image 2.5, Gemini, Grok, Seedream, Qwen...',
    output: 'image',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'flow-nano-banana-pro', options: IMAGE_MODELS.map((m) => ({ value: m[0], label: m[1] })) },
      { name: 'prompt', label: 'Mô tả (prompt)', type: 'textarea', required: true, placeholder: 'Mô tả chủ thể, bối cảnh, ánh sáng, phong cách...' },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '1:1', options: RATIOS },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, help: RES_HELP, optionsBy: resByModel(IMAGE_MODELS) },
      { name: 'quality', label: 'Chất lượng', type: 'select', default: 'standard', options: QUALITY },
      { name: 'transparent', label: 'Nền trong suốt', type: 'boolean', default: false, help: 'Chỉ một số model hỗ trợ' },
    ],
    pricing: { mode: 'cost', markup: 50 },
  },
  {
    key: 'edit',
    name: 'Sửa ảnh AI',
    category: 'image',
    icon: 'wand-sparkles',
    description: 'Tải ảnh lên và mô tả thay đổi: đổi nền, thêm/bớt chi tiết, đổi phong cách, ghép ảnh.',
    output: 'image',
    fields: [
      { name: 'images', label: 'Ảnh gốc (tối đa 3 ảnh)', type: 'image', required: true, multiple: true, maxFiles: 3, accept: IMG, help: 'Tổng dung lượng tối đa 9,5MB' },
      { name: 'prompt', label: 'Mô tả thay đổi', type: 'textarea', required: true, placeholder: 'Ví dụ: đổi nền thành bãi biển lúc hoàng hôn' },
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'flow-nano-banana-pro', options: editModels.map((m) => ({ value: m[0], label: m[1] })) },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: 'auto', options: [{ value: 'auto', label: 'Giữ như ảnh gốc' }, ...RATIOS] },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', required: true, help: RES_HELP, optionsBy: resByModel(editModels) },
      { name: 'quality', label: 'Chất lượng', type: 'select', default: 'standard', options: QUALITY },
      { name: 'transparent', label: 'Nền trong suốt', type: 'boolean', default: false, help: 'Chỉ một số model hỗ trợ' },
    ],
    pricing: { mode: 'cost', markup: 50 },
  },
  {
    key: 'video',
    name: 'Tạo video AI',
    category: 'video',
    icon: 'clapperboard',
    description: 'Tạo video từ mô tả hoặc từ ảnh bằng Google Veo 3.1 Fast, Gemini Omni Flash, Muse Video.',
    output: 'video',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: VIDEO_MODELS[0][0], options: VIDEO_MODELS.map(([value, label]) => ({ value, label })) },
      { name: 'prompt', label: 'Mô tả (prompt)', type: 'textarea', placeholder: 'Mô tả cảnh quay, chuyển động camera... (có thể bỏ trống khi tạo từ ảnh)' },
      { name: 'image', label: 'Ảnh bắt đầu (tuỳ chọn)', type: 'image', accept: IMG, help: 'Tạo video từ ảnh, tối đa 9,5MB' },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, optionsBy: { field: 'model', map: Object.fromEntries(VIDEO_MODELS.map(([k, , d]) => [k, d.map((s) => ({ value: String(s), label: `${s} giây` }))])) } },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '16:9', options: opts([['16:9', '16:9 (ngang)'], ['9:16', '9:16 (dọc)']]) },
    ],
    pricing: { mode: 'cost', markup: 50 },
  },
  {
    key: 'upscale',
    name: 'Nâng cấp ảnh lên 4K',
    category: 'image',
    icon: 'monitor-up',
    description: 'Phóng to ảnh lên chuẩn 4K (diện tích 3840×2160) mà vẫn sắc nét.',
    output: 'image',
    fields: [{ name: 'image', label: 'Ảnh cần nâng cấp', type: 'image', required: true, accept: IMG, help: 'Tối đa 15MB, chưa hỗ trợ ảnh nền trong suốt' }],
    pricing: { mode: 'cost', markup: 50 },
  },
];

// ---------------- giá ----------------

interface Catalog {
  images: Map<string, { gen: Record<string, number>; edit: Record<string, number> }>;
  video: Map<string, number>;
  upscale: number;
}
let catalogCache: { at: number; data: Catalog } | null = null;

/**
 * Đọc catalog JSON thô mà trang /pricing nhúng trong dữ liệu Next.js (`{"catalog":{images,videos,upscale...}}`).
 * Lỗi mạng / đổi cấu trúc thì ném lỗi.
 */
async function fetchPricingRaw(ctx: AiCallContext): Promise<any> {
  const res = await fetch(joinUrl(ctx.config.baseUrl, '/pricing'), { signal: AbortSignal.timeout(15_000) });
  const html = (await res.text()).replace(/\\"/g, '"');
  const at = html.indexOf('{"catalog":');
  if (!res.ok || at < 0) throw new Error(`Không đọc được bảng giá IMG Studio (HTTP ${res.status})`);
  // cắt đúng object catalog bằng cách đếm ngoặc
  const start = html.indexOf('{', at + 1);
  let depth = 0;
  let end = start;
  for (; end < html.length; end++) {
    if (html[end] === '{') depth++;
    else if (html[end] === '}' && --depth === 0) break;
  }
  return JSON.parse(html.slice(start, end + 1));
}

/** Bảng giá trực tiếp từ catalog trang /pricing. Cache 10 phút; lỗi / đổi cấu trúc thì trả null -> dùng bảng giá cố định trong code. */
async function liveCatalog(ctx: AiCallContext): Promise<Catalog | null> {
  if (catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.data;
  try {
    const raw = await fetchPricingRaw(ctx);
    const data: Catalog = {
      images: new Map((raw.images ?? []).map((m: any) => [String(m.id), { gen: m.price_by_resolution ?? {}, edit: m.price_edit_by_resolution ?? m.price_by_resolution ?? {} }])),
      video: new Map((raw.videos ?? []).map((v: any) => [String(v.id), Number(v.price_vnd)])),
      upscale: Number(raw.upscale?.price_vnd) || UPSCALE_PRICE,
    };
    catalogCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

// ---------------- số dư ----------------

/**
 * Số dư đọc chính bằng GET /api/v1/balance (xem `balance()` bên dưới); ngoài ra mọi phản hồi tạo ảnh / video
 * đều kèm `balance_vnd` -> nhớ lại số dư gần nhất làm dự phòng khi endpoint số dư lỗi.
 * Lưu thêm ra file tạm để khởi động lại API (deploy) vẫn còn số dư cũ.
 */
const BALANCE_FILE = join(tmpdir(), 'novai-imgstudio-balance.json');
let lastBalance: { balance: number; at: number } | null = null;

/** Ghi nhớ `balance_vnd` trong phản hồi của IMG Studio (nếu có) */
function rememberBalance(data: any) {
  const b = data?.balance_vnd;
  if (typeof b !== 'number' || !Number.isFinite(b)) return;
  lastBalance = { balance: b, at: Date.now() };
  try {
    writeFileSync(BALANCE_FILE, JSON.stringify(lastBalance));
  } catch {
    /* không ghi được file tạm thì chỉ giữ trong bộ nhớ */
  }
}

/** Số dư đã nhớ (bộ nhớ trước, rồi tới file tạm) */
function rememberedBalance() {
  if (lastBalance) return lastBalance;
  try {
    const v = JSON.parse(readFileSync(BALANCE_FILE, 'utf8'));
    if (typeof v?.balance === 'number') lastBalance = { balance: v.balance, at: Number(v.at) || 0 };
  } catch {
    /* chưa có file */
  }
  return lastBalance;
}

// ---------------- gọi API ----------------

/** Một lần gọi API: trả mã HTTP + JSON (không ném lỗi theo mã HTTP, người gọi tự xử lý 202 / 4xx / 5xx) */
async function rawCall(ctx: AiCallContext, path: string, key: string, body: () => string | FormData, timeoutMs: number) {
  const b = body();
  const res = await fetch(joinUrl(ctx.config.baseUrl, path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.config.apiKey}`, Accept: 'application/json', 'Idempotency-Key': key, ...(typeof b === 'string' ? { 'Content-Type': 'application/json' } : {}) },
    body: b,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { body: text.slice(0, 2000) };
  }
  rememberBalance(data);
  return { status: res.status, data };
}

/** Thông báo lỗi cho khách theo mã HTTP (tài liệu mục 7) */
function errorOf(status: number, data: any): string {
  if (status === 401 || status === 402 || status === 403) return 'Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.';
  if (status === 413) return 'Tổng dung lượng ảnh vượt 9,5MB, vui lòng giảm kích thước ảnh';
  return pickMessage(data) || `Nhà cung cấp báo lỗi HTTP ${status}`;
}

/**
 * Gọi lệnh tạo đồng bộ tới khi có kết quả, giữ nguyên Idempotency-Key cho mọi lần thử lại:
 * 202 (đang xử lý) -> chờ retry_after_ms; 429 / 5xx / mất kết nối / quá giờ -> thử lại có giãn cách (không bị tính tiền 2 lần).
 * 400/401/402/403/404/409/410/413 -> lỗi luôn.
 */
async function callUntilDone(ctx: AiCallContext, path: string, key: string, body: () => string | FormData, timeoutMs: number, deadlineMs: number) {
  const until = Date.now() + deadlineMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    let r: { status: number; data: any } | null = null;
    try {
      r = await rawCall(ctx, path, key, body, timeoutMs);
    } catch {
      r = null; // mất kết nối / quá giờ: phía IMG Studio vẫn có thể đang chạy -> hỏi lại bằng cùng key
    }
    if (r && r.status >= 200 && r.status < 300 && r.status !== 202) return r.data;
    const retryable = !r || r.status === 202 || r.status === 429 || r.status >= 500;
    if (!retryable) throw new AiProviderError(errorOf(r!.status, r!.data), { status: r!.status, data: r!.data });
    if (Date.now() > until) throw new AiProviderError('Nhà cung cấp xử lý quá lâu, tiền đã được hoàn lại', r ?? { timeout: true });
    const wait = r?.status === 202 ? Number(r.data?.retry_after_ms) || 2500 : Math.min(60_000, 3000 * 2 ** Math.min(attempt, 5));
    await sleep(wait);
  }
}

/** Tải file kết quả (cần Bearer) -> nội dung để lưu vào storage của mình */
async function download(ctx: AiCallContext, url: string, fallbackMime: string) {
  const res = await fetch(joinUrl(ctx.config.baseUrl, url), { headers: { Authorization: `Bearer ${ctx.config.apiKey}` }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new AiProviderError('Không tải được file kết quả từ nhà cung cấp', { status: res.status, url });
  const mimeType = (res.headers.get('content-type') || fallbackMime).split(';')[0].trim();
  return { data: Buffer.from(await res.arrayBuffer()), mimeType };
}

/** Kết quả ảnh: một ảnh, hoặc danh sách `images` (krea-2-turbo luôn 4 ảnh) */
async function imageResult(ctx: AiCallContext, id: string, res: any): Promise<AiProviderResult> {
  const list: any[] = Array.isArray(res?.images) && res.images.length ? res.images : [res];
  const files = [];
  for (const img of list.filter((i) => i?.url && (i.status ?? 'completed') === 'completed')) {
    // url tuyệt đối có chữ ký (upscale) hoặc đường dẫn tương đối /api/v1/images/{id}/file
    const f = await download(ctx, img.url, 'image/webp');
    files.push({ url: '', type: 'image' as const, data: f.data, mimeType: f.mimeType });
  }
  if (!files.length) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả ảnh kết quả', raw: res };
  return { status: 'succeeded', providerTaskId: id, files, raw: res };
}

/** Kiểm tra độ phân giải với danh sách model thật của tài khoản (GET /api/v1/providers) trước khi tạo */
async function checkModel(ctx: AiCallContext, modelId: string, resolution: string, edit: boolean) {
  const res = await fetch(joinUrl(ctx.config.baseUrl, '/api/v1/providers'), { headers: { Authorization: `Bearer ${ctx.config.apiKey}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  const data: any = res?.ok ? await res.json().catch(() => null) : null;
  // không đọc được danh sách -> để IMG Studio tự kiểm tra khi tạo
  if (!Array.isArray(data?.providers)) return;
  const p = data.providers.find((x: any) => x.id === modelId);
  if (!p) throw new AiProviderError('Model này hiện không khả dụng, vui lòng chọn model khác');
  if (edit && p.supports_edit === false) throw new AiProviderError('Model này không hỗ trợ sửa ảnh, vui lòng chọn model khác');
  if (Array.isArray(p.resolutions) && !p.resolutions.includes(resolution)) throw new AiProviderError(`Model này chỉ hỗ trợ độ phân giải: ${p.resolutions.map((x: string) => RES_LABEL[x as Res] ?? x).join(', ')}`);
}

export const imgstudioProvider: AiProvider = {
  key: 'imgstudio',
  // chi phí NCC đã là VNĐ nên tỉ giá mặc định 1 (1 credit web ≈ 1đ); lãi đặt ở % lãi từng công cụ (mặc định 50%)
  costUnit: 'VNĐ',
  rate: 1,
  name: 'IMG Studio',
  website: 'https://imgstudio.site',
  tools: TOOLS,

  /** Chi phí (VNĐ) theo catalog trực tiếp, không có thì theo bảng giá trong code */
  async cost(tool, input, ctx) {
    const live = await liveCatalog(ctx);
    if (tool.key === 'video') return live?.video.get(str(input.model)) ?? VIDEO_PRICE;
    if (tool.key === 'upscale') return live?.upscale ?? UPSCALE_PRICE;
    const m = MODEL.get(str(input.model));
    const res = str(input.resolution) as Res;
    if (!m || !RES.includes(res)) return null;
    const edit = tool.key === 'edit';
    const livePrice = live?.images.get(m[0])?.[edit ? 'edit' : 'gen']?.[res];
    return typeof livePrice === 'number' ? livePrice : (edit ? m[5] : m[4])[RES.indexOf(res)];
  },

  async submit(tool, input: AiInput, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
    // mỗi tác vụ một Idempotency-Key, dùng luôn làm mã theo dõi
    const key = `nov-${tool.key}-${randomUUID()}`;
    const resolution = str(input.resolution) || '1K';
    const background = input.transparent === true ? 'transparent' : 'opaque';
    if (background === 'transparent' && resolution === '4KP') throw new AiProviderError('4K cao cấp không dùng được với nền trong suốt');

    let run: () => Promise<AiProviderResult>;
    let estimate = 60_000;
    switch (tool.key) {
      case 'image': {
        await checkModel(ctx, str(input.model), resolution, false);
        const json = JSON.stringify({ prompt: str(input.prompt), provider_id: str(input.model), aspect_ratio: str(input.aspectRatio) || '1:1', resolution, quality: str(input.quality) || 'standard', background });
        run = async () => imageResult(ctx, key, await callUntilDone(ctx, '/api/v1/images/generate', key, () => json, 330_000, 20 * 60_000));
        break;
      }
      case 'edit': {
        await checkModel(ctx, str(input.model), resolution, true);
        const images = (Array.isArray(input.images) ? input.images : [input.images]).map(str).filter(Boolean);
        if (!images.length) throw new AiProviderError('Vui lòng tải lên ảnh gốc');
        run = async () => {
          // đọc ảnh một lần, mỗi lần gửi lại dựng FormData mới (body multipart không dùng lại được)
          const files = await Promise.all(images.map((u) => loadInputFile(ctx.readUpload, u)));
          const rawPrompt = str(input.prompt);
          const ordinals = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH'];
          const editPrompt =
            files.length >= 2
              ? `[Attached reference images in strict 1-to-${files.length} order: ${files
                  .map((_, idx) => `File #${idx + 1} (image_${idx + 1}) = Image ${idx + 1} / ${ordinals[idx] ?? `#${idx + 1}`} image / Ảnh ${idx + 1} / @Image ${idx + 1}`)
                  .join('; ')}. Strictly follow each image's exact assigned role without swapping.]\n\n${rawPrompt}`
              : rawPrompt;
          const form = () => {
            const f = new FormData();
            for (const [idx, x] of files.entries()) {
              const ext = x.mimeType === 'image/png' ? 'png' : x.mimeType === 'image/webp' ? 'webp' : 'jpg';
              f.append('images', new Blob([new Uint8Array(x.data)], { type: x.mimeType }), `image_${idx + 1}.${ext}`);
            }
            f.append('prompt', editPrompt);
            f.append('provider_id', str(input.model));
            f.append('aspect_ratio', str(input.aspectRatio) || 'auto');
            f.append('resolution', resolution);
            f.append('quality', str(input.quality) || 'standard');
            f.append('background', background);
            return f;
          };
          return imageResult(ctx, key, await callUntilDone(ctx, '/api/v1/images/edit', key, form, 330_000, 20 * 60_000));
        };
        break;
      }
      case 'upscale': {
        const url = str(input.image);
        run = async () => {
          const file = await loadInputFile(ctx.readUpload, url);
          const form = () => {
            const f = new FormData();
            f.append('image', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename);
            return f;
          };
          const res = await callUntilDone(ctx, '/api/v1/images/upscale', key, form, 330_000, 20 * 60_000);
          // tải theo id (cần Bearer) thay vì signed URL chỉ sống ~10 phút
          return imageResult(ctx, key, { ...res, url: res?.id ? `/api/v1/images/${res.id}/file` : res?.url });
        };
        break;
      }
      case 'video': {
        const prompt = str(input.prompt);
        const image = str(input.image);
        if (!prompt && !image) throw new AiProviderError('Vui lòng nhập mô tả hoặc tải lên ảnh bắt đầu');
        estimate = 150_000;
        run = async () => {
          const file = image ? await loadInputFile(ctx.readUpload, image) : null;
          const form = () => {
            const f = new FormData();
            if (prompt) f.append('prompt', prompt);
            f.append('model', str(input.model));
            f.append('duration', str(input.duration));
            f.append('aspect_ratio', str(input.aspectRatio) || '16:9');
            if (file) f.append('image', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename);
            return f;
          };
          const res = await callUntilDone(ctx, '/api/v1/videos', key, form, 660_000, 30 * 60_000);
          if (!res?.url) return { status: 'failed', providerTaskId: key, error: pickMessage(res) || 'Nhà cung cấp không trả video kết quả', raw: res };
          const f = await download(ctx, res.url, 'video/mp4');
          return { status: 'succeeded', providerTaskId: key, files: [{ url: '', type: 'video', data: f.data, mimeType: f.mimeType }], raw: res };
        };
        break;
      }
      default:
        throw new AiProviderError('Công cụ không được hỗ trợ');
    }
    startBackground(key, () => run(), estimate);
    return { status: 'processing', providerTaskId: key };
  },

  async poll(_tool, id) {
    return backgroundState(id);
  },

  /**
   * Số dư ví IMG Studio (VNĐ): GET /api/v1/balance (mục 3.9 tài liệu, chỉ đọc, không tốn phí, không cần Idempotency-Key)
   * -> { object: 'balance', balance_vnd, currency: 'VND' }. Gọi lỗi (mạng / IMG Studio trục trặc) thì dùng
   * `balance_vnd` của lần tạo ảnh / video gần nhất; key sai (401/403) thì báo lỗi ngay để admin sửa key.
   */
  async balance(ctx) {
    const res = await fetch(joinUrl(ctx.config.baseUrl, '/api/v1/balance'), { headers: { Authorization: `Bearer ${ctx.config.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const data: any = res ? await res.json().catch(() => null) : null;
    if (res?.ok) {
      const b = Number(data?.balance_vnd);
      if (Number.isFinite(b)) {
        rememberBalance({ balance_vnd: b }); // cập nhật luôn số dư đã nhớ cho lần dự phòng sau
        return { balance: b, unit: 'VNĐ' };
      }
    }
    if (res && (res.status === 401 || res.status === 403)) throw new Error(pickMessage(data) || `IMG Studio từ chối API key (HTTP ${res.status})`);
    const last = rememberedBalance();
    if (!last) throw new Error(res ? pickMessage(data) || `IMG Studio trả lỗi HTTP ${res.status} khi đọc số dư` : 'Không kết nối được IMG Studio để đọc số dư');
    return { balance: last.balance, unit: 'VNĐ' };
  },

  /** Danh mục model ảnh + video từ catalog trang /pricing */
  async catalog(ctx) {
    const raw = await fetchPricingRaw(ctx);
    if (!Array.isArray(raw?.images) || !Array.isArray(raw?.videos)) throw new Error('Bảng giá IMG Studio không đúng định dạng');
    return [
      ...raw.images.map((m: any) => ({ id: String(m.id), label: `${m.name || m.id} (ảnh)` })),
      ...raw.videos.map((v: any) => ({ id: `video:${v.id}`, label: `${v.name || v.id} (video)` })),
    ];
  },

  async discoverTools(ctx) {
    const raw = await fetchPricingRaw(ctx).catch(() => null);
    if (!raw) return { addedTools: [], updatedSplits: [], removedKeys: [] };
    const updatedSplits: string[] = [];
    const removedKeys: string[] = [];

    // Lấy danh sách providers live thực tế của tài khoản để đồng bộ cả model mới thêm lẫn model đã xoá khỏi nguồn
    let liveProviderMap: Map<string, { supports_edit?: boolean }> | null = null;
    if (ctx.config.apiKey?.trim()) {
      const pRes = await fetch(joinUrl(ctx.config.baseUrl, '/api/v1/providers'), {
        headers: { Authorization: `Bearer ${ctx.config.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const pData: any = pRes?.ok ? await pRes.json().catch(() => null) : null;
      if (Array.isArray(pData?.providers) && pData.providers.length >= 8) {
        liveProviderMap = new Map(pData.providers.map((p: any) => [str(p?.id).trim(), { supports_edit: p?.supports_edit }]));
      }
    }

    if (Array.isArray(raw.images)) {
      let imgMutated = false;
      const pricingImgIds = new Set<string>(raw.images.map((m: any) => str(m?.id).trim()).filter(Boolean));
      const authoritativeIds: Map<string, { supports_edit?: boolean }> | null =
        liveProviderMap ?? (pricingImgIds.size >= 8 ? new Map([...pricingImgIds].map((id): [string, { supports_edit?: boolean }] => [id, {}])) : null);

      if (authoritativeIds) {
        for (let i = IMAGE_MODELS.length - 1; i >= 0; i--) {
          const [mId] = IMAGE_MODELS[i];
          if (!authoritativeIds.has(mId)) {
            IMAGE_MODELS.splice(i, 1);
            MODEL.delete(mId);
            removedKeys.push(`imgstudio.image~${mId}`, `imgstudio.edit~${mId}`);
            imgMutated = true;
          } else {
            const pInfo = authoritativeIds.get(mId);
            if (pInfo?.supports_edit === false && IMAGE_MODELS[i][3]) {
              IMAGE_MODELS[i] = [IMAGE_MODELS[i][0], IMAGE_MODELS[i][1], IMAGE_MODELS[i][2], false, IMAGE_MODELS[i][4], IMAGE_MODELS[i][5]];
              MODEL.set(mId, IMAGE_MODELS[i]);
              removedKeys.push(`imgstudio.edit~${mId}`);
              imgMutated = true;
            }
          }
        }
      }

      for (const m of raw.images) {
        const id = str(m?.id).trim();
        if (!id || MODEL.has(id)) continue;
        if (liveProviderMap && !liveProviderMap.has(id)) continue;
        const cleanName = str(m?.name || id)
          .replace(/\s*\([KN]\)\s*/gi, '')
          .trim();
        const genByRes = m?.price_by_resolution ?? {};
        const editByRes = m?.price_edit_by_resolution ?? genByRes;
        const only1k = Boolean(genByRes['1K']) && !genByRes['2K'] && !genByRes['4K'];
        const canEdit = m?.supports_edit !== false && liveProviderMap?.get(id)?.supports_edit !== false;
        const g1 = Number(genByRes['1K']) || 150;
        const g2 = Number(genByRes['2K']) || g1;
        const g4 = Number(genByRes['4K']) || g2 + 150;
        const g4p = Number(genByRes['4KP']) || g4 + 550;
        const e1 = Number(editByRes['1K']) || g1;
        const e2 = Number(editByRes['2K']) || g2;
        const e4 = Number(editByRes['4K']) || g4;
        const e4p = Number(editByRes['4KP']) || g4p;
        const entry: ImageModel = [id, cleanName || id, only1k, canEdit, [g1, g2, g4, g4p], [e1, e2, e4, e4p]];
        IMAGE_MODELS.push(entry);
        MODEL.set(id, entry);
        imgMutated = true;
      }
      if (imgMutated && IMAGE_MODELS.length > 0) {
        const nextEditModels = IMAGE_MODELS.filter((m) => m[3]);
        const imgTool = TOOLS.find((t) => t.key === 'image');
        if (imgTool) {
          imgTool.fields = imgTool.fields.map((f) =>
            f.name === 'model'
              ? { ...f, default: IMAGE_MODELS[0][0], options: IMAGE_MODELS.map((m) => ({ value: m[0], label: m[1] })) }
              : f.name === 'resolution'
                ? { ...f, optionsBy: resByModel(IMAGE_MODELS) }
                : f,
          );
          updatedSplits.push('imgstudio.image');
        }
        const edTool = TOOLS.find((t) => t.key === 'edit');
        if (edTool && nextEditModels.length > 0) {
          edTool.fields = edTool.fields.map((f) =>
            f.name === 'model'
              ? { ...f, default: nextEditModels[0][0], options: nextEditModels.map((m) => ({ value: m[0], label: m[1] })) }
              : f.name === 'resolution'
                ? { ...f, optionsBy: resByModel(nextEditModels) }
                : f,
          );
          updatedSplits.push('imgstudio.edit');
        }
      }
    }

    if (Array.isArray(raw.videos) && raw.videos.length >= 1) {
      let vidMutated = false;
      const liveVidIds = new Set(raw.videos.map((v: any) => str(v?.id).trim()).filter(Boolean));
      for (let i = VIDEO_MODELS.length - 1; i >= 0; i--) {
        const [vId] = VIDEO_MODELS[i];
        if (!liveVidIds.has(vId)) {
          VIDEO_MODELS.splice(i, 1);
          removedKeys.push(`imgstudio.video~${vId}`);
          vidMutated = true;
        }
      }
      const seenVid = new Set(VIDEO_MODELS.map((v) => v[0]));
      for (const v of raw.videos) {
        const id = str(v?.id).trim();
        if (!id || seenVid.has(id)) continue;
        const cleanName = str(v?.name || id).replace(/\s*\([KN]\)\s*/gi, '').trim();
        const durs = Array.isArray(v?.durations)
          ? v.durations.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
          : [5, 10];
        VIDEO_MODELS.push([id, cleanName || id, durs.length ? durs : [5, 10]]);
        seenVid.add(id);
        vidMutated = true;
      }
      if (vidMutated && VIDEO_MODELS.length > 0) {
        const vidTool = TOOLS.find((t) => t.key === 'video');
        if (vidTool) {
          vidTool.fields = vidTool.fields.map((f) =>
            f.name === 'model'
              ? { ...f, default: VIDEO_MODELS[0][0], options: VIDEO_MODELS.map(([value, label]) => ({ value, label })) }
              : f.name === 'duration'
                ? {
                    ...f,
                    optionsBy: {
                      field: 'model',
                      map: Object.fromEntries(VIDEO_MODELS.map(([k, , d]) => [k, d.map((s) => ({ value: String(s), label: `${s} giây` }))])),
                    },
                  }
                : f,
          );
          updatedSplits.push('imgstudio.video');
        }
      }
    }

    return { addedTools: [], updatedSplits, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    try {
      const [provRes, catRes] = await Promise.all([
        fetch(joinUrl(ctx.config.baseUrl, '/api/v1/providers'), {
          headers: { Authorization: `Bearer ${ctx.config.apiKey}` },
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null),
        fetch(joinUrl(ctx.config.baseUrl, '/api/v1/catalog'), { signal: AbortSignal.timeout(12_000) }).catch(() => null),
      ]);
      if (provRes?.status === 503 || catRes?.status === 503) return 'ALL';
      const provData: any = provRes?.ok ? await provRes.json().catch(() => null) : null;
      const catData: any = catRes?.ok ? await catRes.json().catch(() => null) : null;
      if (!Array.isArray(provData?.providers) && !Array.isArray(catData?.images)) return null;

      const down = new Set<string>();
      if (Array.isArray(provData?.providers) && provData.providers.length >= 3) {
        const activeImg = new Map<string, { canEdit: boolean }>();
        for (const p of provData.providers) {
          const id = str(p?.id).trim();
          if (!id) continue;
          const st = str(p?.status).toLowerCase();
          const isMaint = p?.maintenance === true || p?.enabled === false || p?.available === false || /maint|off|down|disable/i.test(st);
          if (!isMaint) activeImg.set(id, { canEdit: p?.supports_edit !== false });
        }
        for (const [mId, , , canEdit] of IMAGE_MODELS) {
          const live = activeImg.get(mId);
          if (!live) {
            down.add(`image~${mId}`);
            if (canEdit) down.add(`edit~${mId}`);
          } else if (canEdit && !live.canEdit) {
            down.add(`edit~${mId}`);
          }
        }
      }
      if (Array.isArray(catData?.videos) && catData.videos.length >= 1) {
        const activeVid = new Set<string>();
        for (const v of catData.videos) {
          const id = str(v?.id).trim();
          const st = str(v?.status).toLowerCase();
          if (id && v?.maintenance !== true && v?.enabled !== false && !/maint|off|down|disable/i.test(st)) {
            activeVid.add(id);
          }
        }
        for (const [vId] of VIDEO_MODELS) {
          if (!activeVid.has(vId)) down.add(`video~${vId}`);
        }
      }
      return down;
    } catch {
      return null;
    }
  },
};
