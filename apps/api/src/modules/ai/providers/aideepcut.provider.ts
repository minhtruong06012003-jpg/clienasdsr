import AdmZip from 'adm-zip';
import { AiProviderError, type AiCallContext, type AiInput, type AiOutputFile, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { guessType, pickMessage, providerFetch, str } from './http.js';
import { DEEPCUT_MODELS } from './aideepcut.catalog.js';
import { extractTikTokMedia } from '../tiktok-downloader.controller.js';

/**
 * AI DeepCut — https://aideepcut.com/api (base https://aideepcut.com/api/v1, Bearer adc_live_... / adc_test_...).
 * Chạy model (workflow `comfy_*` / `rh_*` / `mage_*`, danh mục ở aideepcut.catalog.ts): POST /tasks/create { workflowId, inputs } → poll GET /tasks/{id}
 *   (QUEUED → RUNNING → SUCCESS | FAILED | CANCELLED).
 * - `inputs` theo tên ô (`fieldName`) của workflow: prompt, text, duration, aspect_ratio, resolution, image, additional_images, video, audio, voice...
 * - Danh sách workflow + giá gốc (`costCredits`) công khai ở GET https://aideepcut.com/api/workflows
 *   → công cụ tính giá `cost` = costCredits × tỉ giá quy đổi (`ai_aideepcut.rate` ở tab Khoá API nhà cung cấp).
 * Key sandbox (adc_test_) kiểm tra schema và trả kết quả mẫu ngay — dùng để thử tích hợp không tốn phí.
 */

/** Công cụ = một model AI DeepCut: mã workflow + giá dự phòng (credit DeepCut) */
interface DeepcutTool extends AiToolDef {
  workflowId: string;
  /** Giá credit DeepCut khi không tải được bảng giá trực tiếp */
  fallbackCost: number;
  /** Giá credit DeepCut theo từng độ phân giải (nếu workflow chia giá theo resolution) */
  resolutionCosts?: Record<string, number>;
}

const TIKTOK_DOWNLOAD_TOOL: DeepcutTool = {
  key: 'tiktok-download',
  workflowId: '',
  fallbackCost: 0,
  name: 'Tải Video TikTok Không Logo',
  category: 'video',
  icon: 'download',
  badge: 'MIỄN PHÍ',
  description: 'Bóc tách video MP4 chuẩn HD sạch 100% watermark & tải nhạc MP3 gốc hoàn toàn miễn phí.',
  output: 'video',
  fields: [
    {
      name: 'url',
      label: 'Dán liên kết TikTok (Hỗ trợ link vt.tiktok.com & tiktok.com)',
      type: 'text',
      required: true,
      max: 1000,
      placeholder: 'Dán link TikTok (vt.tiktok.com / tiktok.com/@user/video/...) hoặc văn bản chia sẻ từ app...',
    },
  ],
  pricing: { mode: 'free' },
};

const TOOLS: DeepcutTool[] = [
  ...DEEPCUT_MODELS.map((m) => ({
    ...m,
    badge: 'SV4',
    pricing: { mode: 'cost' as const, multiplier: 12.5, markup: 38 },
  })),
  TIKTOK_DOWNLOAD_TOOL,
];

/**
 * `inputs` gửi nguồn: đúng tên ô của workflow, bỏ ô để trống (nếu ô có `default` dạng chuỗi thì điền mặc định, vd `text` của Motion 20s).
 * Hỗ trợ `image2` / ô nhiều ảnh `images` (ảnh tham chiếu thêm cho workflow RunningHub `rh_*`) → gom sang mảng `additional_images` theo chuẩn Studio nguồn.
 */
function inputsOf(tool: DeepcutTool, input: AiInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extraImages: string[] = [];
  for (const f of tool.fields) {
    // ô nhiều ảnh (`images`: @Image 3 – @Image 8 của Minimax H3) -> giữ thứ tự, gom vào additional_images
    if (f.multiple) {
      const list = (Array.isArray(input[f.name]) ? (input[f.name] as unknown[]) : [input[f.name]]).map(str).filter(Boolean);
      if (list.length) extraImages.push(...list);
      continue;
    }
    const val = str(input[f.name]) || (typeof f.default === 'string' ? f.default.trim() : '');
    if (!val) continue;
    if (f.name === 'image2' || f.name === 'image3') {
      extraImages.push(val);
      continue;
    }
    out[f.name] = val;
  }
  if (extraImages.length > 0) {
    if (!out.image) {
      out.image = extraImages.shift();
    }
    if (extraImages.length > 0) {
      out.additional_images = extraImages;
    }
  }
  return out;
}

/** Cache giá workflow (credit DeepCut) từ danh sách công khai 10 phút */
let costCache: { at: number; base: string; costs: Map<string, number> } | null = null;

async function workflowCosts(ctx: AiCallContext): Promise<Map<string, number>> {
  if (costCache && costCache.base === ctx.config.baseUrl && Date.now() - costCache.at < 600_000) return costCache.costs;
  try {
    // danh sách công khai nằm ở <origin>/api/workflows, không phải /api/v1
    const res = await fetch(`${new URL(ctx.config.baseUrl).origin}/api/workflows`, { signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as { workflows?: { id?: string; webappId?: string; costCredits?: number }[] };
    const costs = new Map<string, number>();
    for (const w of data?.workflows ?? []) if (Number(w.costCredits) > 0) costs.set(String(w.webappId ?? w.id), Number(w.costCredits));
    if (costs.size) costCache = { at: Date.now(), base: ctx.config.baseUrl, costs };
  } catch {
    // mất kết nối -> dùng bản cũ / giá dự phòng trong code
  }
  return costCache?.costs ?? new Map();
}

/** Đuôi file ảnh / video / âm thanh trong zip kết quả -> loại file + MIME */
const ZIP_MEDIA: Record<string, { type: 'image' | 'video' | 'audio'; mime: string }> = {
  png: { type: 'image', mime: 'image/png' },
  jpg: { type: 'image', mime: 'image/jpeg' },
  jpeg: { type: 'image', mime: 'image/jpeg' },
  webp: { type: 'image', mime: 'image/webp' },
  mp4: { type: 'video', mime: 'video/mp4' },
  webm: { type: 'video', mime: 'video/webm' },
  mov: { type: 'video', mime: 'video/quicktime' },
  mp3: { type: 'audio', mime: 'audio/mpeg' },
  wav: { type: 'audio', mime: 'audio/wav' },
  m4a: { type: 'audio', mime: 'audio/mp4' },
};
/** Trần dung lượng zip kết quả tải về (giữ cả file trong RAM) */
const ZIP_MAX_BYTES = 300 * 1024 * 1024;

/**
 * Tải zip kết quả và trả nội dung từng file ảnh / video bên trong (`data` → AiFilesService.mirror lưu vào storage).
 */
async function unzipMedia(url: string): Promise<AiOutputFile[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Không tải được file zip kết quả (HTTP ${res.status})`);
  if (Number(res.headers.get('content-length') || 0) > ZIP_MAX_BYTES) throw new Error('File zip kết quả quá lớn');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > ZIP_MAX_BYTES) throw new Error('File zip kết quả quá lớn');
  const out: AiOutputFile[] = [];
  for (const e of new AdmZip(buf).getEntries()) {
    const name = e.entryName.split('/').pop() ?? '';
    const media = ZIP_MEDIA[name.split('.').pop()?.toLowerCase() ?? ''];
    if (e.isDirectory || !media || name.startsWith('.') || e.entryName.startsWith('__MACOSX/')) continue;
    out.push({ url: '', type: media.type, name, data: e.getData(), mimeType: media.mime });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function normalizeUrl(raw: string, origin: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return `${origin}${trimmed}`;
  return trimmed;
}

/** Chuẩn hoá tác vụ trả về từ /tasks/create hoặc /tasks/{id} */
async function toResult(task: any, tool: AiToolDef, id: string, baseUrl: string): Promise<AiProviderResult> {
  const status = String(task?.status ?? '').toUpperCase();
  if (status === 'SUCCESS' || status === 'COMPLETED') {
    const origin = new URL(baseUrl).origin;
    const rawUrls: unknown[] = [
      task?.cleanedOutputUrl,
      task?.outputUrl,
      task?.fileUrl,
      task?.resultUrl,
      ...(Array.isArray(task?.outputUrls) ? task.outputUrls : []),
      ...(Array.isArray(task?.fileUrls) ? task.fileUrls : []),
      ...(Array.isArray(task?.resultUrls) ? task.resultUrls : []),
    ];
    const urls = rawUrls
      .filter((u): u is string => typeof u === 'string' && !!u.trim())
      .map((u) => normalizeUrl(u, origin))
      .filter(Boolean);
    if (!urls.length) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả', raw: task };
    const unique = [...new Set(urls)];
    if (tool.output === 'text') {
      const txt = unique.find((u) => /\.txt(\?|$)/i.test(u)) ?? unique[0];
      const text = await fetch(txt, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      if (text.trim()) return { status: 'succeeded', providerTaskId: id, text: text.trim(), raw: task };
    }
    const fallbackType: 'image' | 'video' | 'audio' =
      tool.output === 'video' ? 'video' : tool.output === 'audio' ? 'audio' : 'image';
    const files: AiOutputFile[] = [];
    for (const url of unique) {
      if (tool.output !== 'text' && /\.(txt|json|log)(\?|$)/i.test(url)) continue;
      if (/\.zip(\?|$)/i.test(url)) files.push(...(await unzipMedia(url)));
      else files.push({ url, type: guessType(url, fallbackType) });
    }
    if (!files.length) return { status: 'failed', providerTaskId: id, error: 'Không đọc được file kết quả của nhà cung cấp', raw: task };
    return { status: 'succeeded', providerTaskId: id, files, raw: task };
  }
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'ERROR') {
    const rawMsg = String(task?.errorMessage ?? task?.error ?? pickMessage(task) ?? '');
    const cleanErr = /maxContentLength size of \d+ exceeded/i.test(rawMsg)
      ? 'Video đầu vào vượt quá giới hạn dung lượng 30MB của máy chủ xử lý — hệ thống đã hoàn tiền, vui lòng tạo lại'
      : rawMsg || undefined;
    return {
      status: 'failed',
      providerTaskId: id,
      error: cleanErr,
      raw: task,
    };
  }
  return { status: 'processing', providerTaskId: id, progress: Number(task?.progress) || undefined, raw: task };
}

const call = async <T = any>(ctx: AiCallContext, path: string, json?: unknown): Promise<T> => {
  const res = await providerFetch<any>(ctx.config, path, json === undefined ? {} : { json });
  if (res && res.ok === false) throw new AiProviderError(String(res.error || res.message || 'AI DeepCut báo lỗi'), res);
  return res as T;
};

/**
 * Điều phối gọi AI DeepCut để tránh xung đột ghi file JSON phía nguồn khi khách chạy Tạo hàng loạt:
 * - Xếp hàng tuần tự `POST /tasks/create` (cách nhau tối thiểu 1,2s) và nhường lượt cho lần tạo đang bay.
 * - Giới hạn tối đa 4 lượt hỏi `GET /tasks/{id}` song song tới DeepCut.
 * - Cho phép hỏi lại tối đa 3 lần (~30s) nếu vừa tạo xong mà nguồn trả tạm 404.
 */
const SUBMIT_GAP_MS = 1200;
const MAX_CONCURRENT_POLLS = 4;
let submitChain: Promise<void> = Promise.resolve();
let lastSubmitDoneAt = 0;
let activeSubmits = 0;
let activePolls = 0;
const pollWaiters: (() => void)[] = [];
const notFoundCount = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withSerializedSubmit<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = submitChain;
  submitChain = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  activeSubmits++;
  try {
    const waitGap = SUBMIT_GAP_MS - (Date.now() - lastSubmitDoneAt);
    if (waitGap > 0) await sleep(waitGap);
    // chờ nhanh tối đa 1,5s cho các lượt GET /tasks đang bay hoàn tất trước khi ghi task mới bên nguồn
    const waitDeadline = Date.now() + 1500;
    while (activePolls > 0 && Date.now() < waitDeadline) await sleep(60);
    return await fn();
  } finally {
    lastSubmitDoneAt = Date.now();
    activeSubmits--;
    release();
  }
}

async function withThrottledPoll<T>(fn: () => Promise<T>): Promise<T> {
  const waitSubmitDeadline = Date.now() + 3000;
  while (activeSubmits > 0 && Date.now() < waitSubmitDeadline) await sleep(80);
  if (activePolls < MAX_CONCURRENT_POLLS) {
    activePolls++;
  } else {
    await new Promise<void>((r) => pollWaiters.push(r));
  }
  try {
    return await fn();
  } finally {
    const next = pollWaiters.shift();
    if (next) next();
    else activePolls--;
  }
}

export const aideepcutProvider: AiProvider = {
  key: 'aideepcut',
  costUnit: 'credit DeepCut',
  rate: 12.5,
  name: 'AI DeepCut',
  website: 'https://aideepcut.com',
  tools: TOOLS,

  /** Giá workflow (credit DeepCut gốc): ưu tiên bảng giá theo độ phân giải nếu có (vd Minimax H3: 1080p=1280, 720p=720, 480p=480), sau đó tới danh sách công khai / dự phòng */
  async cost(tool, input, ctx) {
    if (tool.key === 'tiktok-download') return 0;
    const t = tool as DeepcutTool;
    if (t.resolutionCosts) {
      const defRes = String(t.fields.find((f) => f.name === 'resolution')?.default ?? '480p').toLowerCase();
      const res = (str(input.resolution) || defRes).toLowerCase();
      if (typeof t.resolutionCosts[res] === 'number') return t.resolutionCosts[res];
    }
    return (await workflowCosts(ctx)).get(t.workflowId) ?? t.fallbackCost;
  },

  async submit(tool, input: AiInput, ctx) {
    if (tool.key === 'tiktok-download') {
      const item = await extractTikTokMedia(str(input.url)).catch((err: Error) => {
        throw new AiProviderError(err.message || 'Không thể lấy video TikTok');
      });
      const files: AiOutputFile[] = [
        { url: item.hdUrl, type: 'video', name: `TikTok_Clean_HD_${item.id}.mp4` },
        ...(item.musicUrl ? [{ url: item.musicUrl, type: 'audio' as const, name: `TikTok_Audio_${item.id}.mp3` }] : []),
      ];
      return { status: 'succeeded', providerTaskId: item.id, files, raw: { id: item.id, title: item.title, author: item.authorName } };
    }
    const t = tool as DeepcutTool;
    const inputs = inputsOf(t, input);
    if (ctx.ensureStandardImage) {
      if (typeof inputs.image === 'string' && /\.webp(\?|$)/i.test(inputs.image)) {
        inputs.image = await ctx.ensureStandardImage(inputs.image);
      }
      if (Array.isArray(inputs.additional_images)) {
        inputs.additional_images = await Promise.all(
          inputs.additional_images.map((u) => (typeof u === 'string' && /\.webp(\?|$)/i.test(u) ? ctx.ensureStandardImage!(u) : Promise.resolve(u))),
        );
      }
    }
    const isMotion = t.key.startsWith('motion') || /motion/i.test(t.workflowId);
    if (isMotion && typeof inputs.video === 'string' && inputs.video && ctx.trimVideoTail) {
      inputs.video = await ctx.trimVideoTail(inputs.video, 0.3);
    }
    // T-437: AI DeepCut giới hạn cứng 30MB (31.457.280 bytes) khi tải URL ngoại vi -> tự động nén mọi video > 25MB xuống chuẩn HD MP4 gọn nhẹ
    if (typeof inputs.video === 'string' && inputs.video && ctx.ensureVideoMaxBytes) {
      inputs.video = await ctx.ensureVideoMaxBytes(inputs.video, 25 * 1024 * 1024);
    }
    // T-507: Xác thực nhanh các tệp đầu vào nội bộ trước khi gửi sang nguồn để không vướng lỗi tải URL ngoại vi HTTP 404 nếu tệp lịch sử quá 24h đã bị xoá
    const localCheckUrls: string[] = [];
    for (const val of Object.values(inputs)) {
      if (typeof val === 'string' && val.includes('/uploads/ai/')) localCheckUrls.push(val);
      else if (Array.isArray(val)) {
        for (const u of val) if (typeof u === 'string' && u.includes('/uploads/ai/')) localCheckUrls.push(u);
      }
    }
    for (const u of localCheckUrls) {
      await ctx.readUpload(u);
    }
    const payload = { workflowId: t.workflowId, inputs };
    const res = await withSerializedSubmit(() => call(ctx, '/tasks/create', payload));
    if (!res?.taskId) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', res);
    notFoundCount.delete(res.taskId);
    return toResult(res, tool, res.taskId, ctx.config.baseUrl);
  },

  async poll(tool, id, ctx) {
    let res: any;
    try {
      res = await withThrottledPoll(() => call(ctx, `/tasks/${encodeURIComponent(id)}`));
      notFoundCount.delete(id);
    } catch (err) {
      const e = err as AiProviderError;
      const st = Number((e?.raw as { status?: unknown } | undefined)?.status ?? 0);
      if (e instanceof AiProviderError && (st === 404 || /không tìm thấy tác vụ|not found/i.test(e.message))) {
        const cnt = (notFoundCount.get(id) ?? 0) + 1;
        notFoundCount.set(id, cnt);
        if (notFoundCount.size > 2000) notFoundCount.delete(notFoundCount.keys().next().value!);
        if (cnt <= 3) return { status: 'processing', providerTaskId: id, raw: e.raw };
        notFoundCount.delete(id);
        return {
          status: 'failed',
          providerTaskId: id,
          error: 'Máy chủ xử lý video bị nghẽn lúc khởi tạo tác vụ nên đơn đã được huỷ, tiền đã được hoàn lại 100% — vui lòng bấm tạo lại',
          raw: e.raw,
        };
      }
      throw err;
    }
    return toResult(res?.task ?? res, tool, id, ctx.config.baseUrl);
  },

  async balance(ctx) {
    const res = await call<{ user?: { credits?: number } }>(ctx, '/user/me');
    return { balance: Number(res?.user?.credits ?? 0), unit: 'credit DeepCut' };
  },

  /** Danh mục workflow công khai (bỏ bản nháp), tên ưu tiên tên tuỳ chỉnh tiếng Việt */
  async catalog(ctx) {
    const res = await fetch(`${new URL(ctx.config.baseUrl).origin}/api/workflows`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`AI DeepCut HTTP ${res.status}`);
    const data = (await res.json()) as { workflows?: { id?: string; webappId?: string; name?: string; customName?: string; isDraft?: boolean }[] };
    if (!Array.isArray(data?.workflows)) throw new Error('AI DeepCut trả danh sách workflow không đúng định dạng');
    return data.workflows.filter((w) => !w.isDraft).map((w) => {
      const id = String(w.webappId ?? w.id);
      return { id, label: `${w.customName || w.name || id} (#${id})` };
    });
  },

  async discoverTools(ctx) {
    try {
      const res = await fetch(`${new URL(ctx.config.baseUrl).origin}/api/workflows`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { addedTools: [], removedKeys: [] };
      const data = (await res.json()) as { workflows?: { id?: string; webappId?: string; isDraft?: boolean }[] };
      if (!Array.isArray(data?.workflows)) return { addedTools: [], removedKeys: [] };
      const liveIds = new Set<string>();
      for (const w of data.workflows) {
        if (w?.isDraft) continue;
        if (w?.id) liveIds.add(String(w.id));
        if (w?.webappId) liveIds.add(String(w.webappId));
      }
      if (liveIds.size < 5) return { addedTools: [], removedKeys: [] };
      const removedKeys: string[] = [];
      for (let i = TOOLS.length - 1; i >= 0; i--) {
        const t = TOOLS[i];
        if (!t.workflowId) continue;
        if (!liveIds.has(t.workflowId)) {
          removedKeys.push(`aideepcut.${t.key}`);
          TOOLS.splice(i, 1);
        }
      }
      return { addedTools: [], removedKeys };
    } catch {
      return { addedTools: [], removedKeys: [] };
    }
  },

  async maintenanceCheck(ctx) {
    try {
      const res = await fetch(`${new URL(ctx.config.baseUrl).origin}/api/workflows`, { signal: AbortSignal.timeout(12_000) });
      if (res.status === 503) return 'ALL';
      if (!res.ok) return null;
      const data = (await res.json()) as {
        workflows?: { id?: string; webappId?: string; isDraft?: boolean; isActive?: boolean; maintenance?: boolean; status?: string }[];
      };
      if (!Array.isArray(data?.workflows) || data.workflows.length < 3) return null;
      const activeIds = new Set<string>();
      const maintIds = new Set<string>();
      for (const w of data.workflows) {
        const st = String(w?.status ?? 'active').toLowerCase();
        const isMaint = w?.isDraft === true || w?.isActive === false || w?.maintenance === true || /maint|off|disable|down|pause/i.test(st);
        const ids = [w?.id ? String(w.id) : '', w?.webappId ? String(w.webappId) : ''].filter(Boolean);
        for (const id of ids) {
          if (isMaint) maintIds.add(id);
          else activeIds.add(id);
        }
      }
      const down = new Set<string>();
      for (const t of TOOLS) {
        if (!t.workflowId) continue;
        if (maintIds.has(t.workflowId) || !activeIds.has(t.workflowId)) {
          down.add(t.key);
        }
      }
      return down;
    } catch {
      return null;
    }
  },
};
