import { randomUUID } from 'node:crypto';
import { AiProviderError, type AiCallContext, type AiInput, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { loadInputFile } from './background.js';
import { joinUrl, pickMessage, providerFetch, str } from './http.js';

/**
 * Vimo Video (Motion Studio) — https://vimovideo.com, base https://vimovideo.com/api/v1, header `Authorization: Bearer vimo_live_...`.
 * - Partner API chỉ có workflow `motion_control_v2`: POST /generations (multipart: workflow, option, character_image, motion_video,
 *   orientation, keep_audio) + header Idempotency-Key bắt buộc (gửi lại cùng key + cùng payload không trừ xu lần hai).
 * - Hỏi GET /generations/{id} (pending → queued → processing → completed | failed; failed thì nguồn tự hoàn xu).
 * - Hoàn tất: tải MP4 ở `download_url` bằng chính Bearer token (link không công khai) -> lưu file vào storage của website.
 * - Giá: option = chất lượng × thời lượng (low_10, high_15...), `price_coins` đọc ở GET /workflows (cache 10 phút), tính giá `cost`
 *   = xu × tỉ giá quy đổi (admin chỉnh ở tab Khoá API nhà cung cấp).
 */

const WORKFLOW = 'motion_control_v2';
/** Giá dự phòng (xu Vimo) khi không đọc được bảng giá trực tiếp — theo GET /workflows ngày 2026-11-08 */
const FALLBACK_COINS: Record<string, number> = { low_10: 2500, low_15: 3500, high_10: 5000, high_15: 7000 };

const TOOLS: AiToolDef[] = [
  {
    key: 'motion-v2',
    name: 'Motion control V2',
    category: 'video',
    icon: 'person-standing',
    badge: 'NEW',
    description: 'Nhân vật trong ảnh chuyển động theo video mẫu, chuyển động ổn định, ít lỗi; chọn chất lượng Low / High, 10 hoặc 15 giây.',
    output: 'video',
    fields: [
      { name: 'image', label: 'Ảnh nhân vật', type: 'image', required: true, accept: 'image/png,image/jpeg,image/webp', help: 'JPG, PNG, WebP · tối đa 10 MB' },
      { name: 'video', label: 'Video chuyển động mẫu', type: 'video', required: true, accept: 'video/mp4', help: 'MP4 · tối đa 30 MB' },
      { name: 'quality', label: 'Chất lượng', type: 'select', required: true, default: 'low', options: [{ value: 'low', label: 'Low · tiết kiệm' }, { value: 'high', label: 'High · chất lượng cao' }] },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '10', options: [{ value: '10', label: '10 giây' }, { value: '15', label: '15 giây' }] },
      {
        name: 'orientation',
        label: 'Hướng nhân vật',
        type: 'select',
        default: 'follow_character',
        options: [
          { value: 'follow_character', label: 'Theo ảnh nhân vật' },
          { value: 'follow_motion', label: 'Theo video chuyển động' },
        ],
      },
      { name: 'keepAudio', label: 'Giữ âm thanh gốc', type: 'boolean', default: true },
    ],
    pricing: { mode: 'cost', markup: 35 },
    supportsCost: true,
    unitLabel: 'video',
    units: () => 1,
  },
];

/** Mã option của nguồn từ lựa chọn của khách (vd low_10) */
const optionOf = (input: AiInput) => `${str(input.quality) === 'high' ? 'high' : 'low'}_${str(input.duration) === '15' ? 15 : 10}`;

/**
 * Nguồn giới hạn 1 request/phút cho mỗi khoá, tính CHUNG mọi route (đo 2026-11-09: gọi chi tiết xong thì danh sách, tải đều 429).
 * -> mỗi khoá chỉ gửi 1 request mỗi SLOT_MS; hết lượt thì báo "đang xử lý" để lần hỏi sau thử lại, không gọi nguồn.
 * Trạng thái giữ trong tiến trình: API chạy 1 instance (pm2 novai-api).
 */
const SLOT_MS = 61_000;
const nextSlot = new Map<string, number>();

function takeSlot(ctx: AiCallContext): boolean {
  const key = ctx.config.apiKey;
  if (Date.now() < (nextSlot.get(key) ?? 0)) return false;
  nextSlot.set(key, Date.now() + SLOT_MS);
  return true;
}

/** Nguồn báo 429 -> chờ đúng Retry-After (mặc định 1 phút) mới gọi tiếp */
function holdSlot(ctx: AiCallContext, retryAfterSec?: number) {
  nextSlot.set(ctx.config.apiKey, Date.now() + Math.max(SLOT_MS, (retryAfterSec ?? 0) * 1000 + 1000));
}

/** Danh sách task gần nhất, dùng chung cho mọi đơn đang chờ (1 request phục vụ nhiều đơn) */
let listCache: { key: string; tasks: any[] } | null = null;

/**
 * Đơn đã xong bên nguồn nhưng chưa tải được video (id -> lúc thấy xong). Còn đơn chờ tải thì không lấy lại danh sách,
 * để lượt kế tiếp dành cho việc tải — trước đây danh sách luôn chiếm lượt nên đơn xong không bao giờ tải được.
 * Quá 15 phút thì bỏ ưu tiên (phòng đơn bị huỷ phía website làm kẹt danh sách).
 */
const pendingDownloads = new Map<string, number>();
/** Số đơn đang chờ tới lượt gửi lên nguồn (ưu tiên lượt gửi đơn mới trước khi gọi danh sách hỏi trạng thái) */
let waitingSubmitUntil = 0;

const hasPendingDownload = () => {
  for (const [id, at] of pendingDownloads) if (Date.now() - at > 900_000) pendingDownloads.delete(id);
  return pendingDownloads.size > 0;
};

async function recentTasks(ctx: AiCallContext): Promise<any[] | null> {
  const cached = listCache?.key === ctx.config.apiKey ? listCache.tasks : null;
  if ((cached && hasPendingDownload()) || Date.now() < waitingSubmitUntil || !takeSlot(ctx)) return cached;
  try {
    const res = await providerFetch<any>(ctx.config, '/generations?per_page=50');
    const tasks = Array.isArray(res?.data) ? res.data : [];
    listCache = { key: ctx.config.apiKey, tasks };
    return tasks;
  } catch (err) {
    if (err instanceof AiProviderError && (err.raw as any)?.status === 429) holdSlot(ctx);
    return cached;
  }
}

/** Cache giá option (xu Vimo) 10 phút */
let priceCache: { at: number; base: string; prices: Map<string, number> } | null = null;

async function optionPrices(ctx: AiCallContext, force = false): Promise<Map<string, number>> {
  if (!force && priceCache && priceCache.base === ctx.config.baseUrl && Date.now() - priceCache.at < 300_000) return priceCache.prices;
  try {
    const res = await providerFetch<any>(ctx.config, '/workflows', { timeoutMs: 20_000 });
    const wf = (Array.isArray(res?.data) ? res.data : []).find((w: any) => w?.key === WORKFLOW);
    const prices = new Map<string, number>();
    for (const o of wf?.options ?? []) if (Number(o?.price_coins) > 0) prices.set(String(o.key), Number(o.price_coins));
    if (prices.size) priceCache = { at: Date.now(), base: ctx.config.baseUrl, prices };
  } catch {
    // mất kết nối -> dùng bản cũ / giá dự phòng
  }
  return priceCache?.prices ?? new Map();
}

/** Trạng thái task của nguồn -> kết quả chung; completed thì tải MP4 (cần Bearer) về để lưu */
async function toResult(task: any, ctx: AiCallContext, id: string): Promise<AiProviderResult> {
  const status = str(task?.status).toLowerCase();
  if (status === 'completed') {
    // route /generations/{id}/download của nguồn đang 404 -> chờ tới khi task có download_url
    const url = str(task?.download_url);
    if (!url) return { status: 'processing', providerTaskId: id, progress: 99, raw: task };
    if (!pendingDownloads.has(id)) pendingDownloads.set(id, Date.now());
    // tải cũng tốn 1 lượt của giới hạn chung
    if (!takeSlot(ctx)) return { status: 'processing', providerTaskId: id, progress: 99, raw: { ...task, waitingSlot: true } };
    let res: Response;
    try {
      res = await fetch(joinUrl(ctx.config.baseUrl, url), { headers: { Authorization: `Bearer ${ctx.config.apiKey}` }, signal: AbortSignal.timeout(180_000) });
    } catch (err) {
      // lỗi mạng khi tải -> hỏi lại lần sau
      throw new AiProviderError('Không tải được video kết quả, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
    }
    if (res.status === 429) holdSlot(ctx, Number(res.headers.get('retry-after')) || undefined);
    if (!res.ok) throw new AiProviderError('Không tải được video kết quả, hệ thống sẽ thử lại', { status: res.status, task }, res.status >= 500 || res.status === 429 || res.status === 404);
    const data = Buffer.from(await res.arrayBuffer());
    pendingDownloads.delete(id);
    return { status: 'succeeded', providerTaskId: id, files: [{ url: '', type: 'video', name: `${id}.mp4`, data, mimeType: 'video/mp4' }], raw: task };
  }
  if (status === 'failed') {
    const msg = str(task?.error_message ?? task?.error?.message ?? task?.error) || pickMessage(task);
    return { status: 'failed', providerTaskId: id, error: msg ? `${msg}. Tiền đã được hoàn lại` : 'Tạo video thất bại, tiền đã được hoàn lại', raw: task };
  }
  return { status: 'processing', providerTaskId: id, progress: Number(task?.progress_percent ?? task?.progress) || undefined, raw: task };
}

export const vimoProvider: AiProvider = {
  key: 'vimo',
  name: 'Vimo Video (vimovideo.com)',
  website: 'https://vimovideo.com',
  tools: TOOLS,
  // tỉ giá mặc định 1 xu Vimo = 1đ; admin đổi theo giá nạp xu thật ở tab Khoá API nhà cung cấp
  costUnit: 'xu Vimo',
  rate: 1,

  async cost(_tool, input, ctx) {
    const option = optionOf(input);
    return (await optionPrices(ctx, Boolean(input.__fresh))).get(option) ?? FALLBACK_COINS[option] ?? null;
  },

  async submit(_tool, input, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
    // Vimo giới hạn cứng 1 request/phút mỗi API key: nếu vừa gọi xong thì xếp hàng chờ tới lượt thay vì đâm vào lỗi 429
    if (!takeSlot(ctx)) {
      const waitMs = Math.max(5_000, (nextSlot.get(ctx.config.apiKey) ?? Date.now() + 15_000) - Date.now());
      waitingSubmitUntil = Math.max(waitingSubmitUntil, Date.now() + waitMs + 15_000);
      throw new AiProviderError('Đang xếp hàng gửi sang nhà cung cấp, hệ thống sẽ tự gửi trong giây lát', { waitingSlot: true, retryMs: waitMs }, true);
    }
    waitingSubmitUntil = 0;
    const [image, video] = await Promise.all([loadInputFile(ctx.readUpload, str(input.image)), loadInputFile(ctx.readUpload, str(input.video))]);
    const form = new FormData();
    form.set('workflow', WORKFLOW);
    form.set('option', optionOf(input));
    form.set('orientation', str(input.orientation) === 'follow_motion' ? 'follow_motion' : 'follow_character');
    form.set('keep_audio', input.keepAudio === false ? '0' : '1');
    form.set('character_image', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.filename || 'character.png');
    form.set('motion_video', new Blob([new Uint8Array(video.data)], { type: video.mimeType }), video.filename || 'motion.mp4');
    let res: any;
    try {
      res = await providerFetch<any>(ctx.config, '/generations', {
        form,
        headers: { Authorization: `Bearer ${ctx.config.apiKey}`, 'Idempotency-Key': `novai-${randomUUID()}` },
        timeoutMs: 180_000,
      });
    } catch (err) {
      if (err instanceof AiProviderError && (err.raw as any)?.status === 429) {
        holdSlot(ctx);
        waitingSubmitUntil = Math.max(waitingSubmitUntil, Date.now() + SLOT_MS + 15_000);
      }
      throw err;
    }
    const id = str(res?.data?.id);
    if (!id) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', res);
    return toResult(res.data, ctx, id);
  },

  async poll(_tool, id, ctx) {
    // GET /generations/{id} của nguồn đang trả 404 cho cả task vừa tạo (2026-11-08, mọi route có tham số đều 404)
    // -> đọc trạng thái từ danh sách (chạy đúng), 1 lần gọi/phút dùng chung cho mọi đơn; chưa thấy thì hỏi lại lần sau
    const task = (await recentTasks(ctx))?.find((t: any) => str(t?.id) === id);
    if (!task) return { status: 'processing', providerTaskId: id, raw: { notFound: true } };
    return toResult(task, ctx, id);
  },

  /** Số dư = xu thường + xu khuyến mãi (GET /account) */
  async balance(ctx) {
    const res = await providerFetch<any>(ctx.config, '/account');
    return { balance: Number(res?.data?.coin_balance ?? 0) + Number(res?.data?.promotional_coin_balance ?? 0), unit: 'xu Vimo' };
  },

  /** Danh mục option đang bán của workflow (bot admin báo khi nguồn thêm / gỡ option) */
  async catalog(ctx) {
    const res = await providerFetch<any>(ctx.config, '/workflows', { timeoutMs: 20_000 });
    return (Array.isArray(res?.data) ? res.data : []).flatMap((w: any) =>
      (w?.options ?? []).map((o: any) => ({ id: `${w.key}:${o.key}`, label: `${w.name ?? w.key} · ${o.label ?? o.key} (${o.price_coins ?? '?'} xu)` })),
    );
  },
};
