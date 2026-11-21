import sharp from 'sharp';
import { AiProviderError, type AiCallContext, type AiFieldOption, type AiInput, type AiOutputFile, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { loadInputFile } from './background.js';
import { guessType, joinUrl, pickMessage, providerFetch, str } from './http.js';

/**
 * Fable Studio (Grok Pool) — https://fablemedical.shop, base `https://fablemedical.shop/v1`, header `Authorization: Bearer fm-...`.
 * Gói thuê theo ngày / luồng (63.000đ/ngày/luồng, không giới hạn số lượt gọi):
 * - 3 model video: `grok-imagine-video-1.5` (480p/720p/1080p, 1–15s, có âm thanh), `grok-imagine-video-1.5-lite`, `grok-imagine-video` (480p/720p).
 * - 2 model ảnh: `grok-imagine-image-2.0` (1k/2k), `grok-imagine-image` (1k) + sửa/ghép tối đa 5 ảnh (`POST /images/edits`).
 * - Xử lý hàng đợi thông minh: khi hết luồng (`HTTP 429`), trả `waitingSlot: true` để hệ thống tự xếp hàng gửi lại sau 15 giây (không tính lỗi, không mất đơn).
 * - File MP4 tải qua `GET /videos/:id/content` kèm Bearer token và lưu thẳng vào ổ cứng máy chủ (tránh link nguồn tự hết hạn sau 1 giờ và nhả luồng ngay).
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

const VIDEO_MODELS: [string, string][] = [
  ['grok-imagine-video-1.5', 'Grok Imagine Video 1.5 · 1080p, có âm thanh'],
  ['grok-imagine-video-1.5-lite', 'Grok Imagine Video 1.5 Lite · Nhanh, tới 1080p'],
  ['grok-imagine-video', 'Grok Imagine Video 1.0 · 720p'],
];

const IMAGE_MODELS: [string, string][] = [
  ['grok-imagine-image-2.0', 'Grok Imagine 2.0 · Ảnh 2K sắc nét'],
  ['grok-imagine-image', 'Grok Imagine 1.0 · Tạo nhanh 1K'],
];

const VIDEO_RATIOS_T2V = opts([
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['3:2', '3:2'],
  ['2:3', '2:3'],
]);

const VIDEO_RATIOS_I2V = opts([
  ['auto', 'Giữ như ảnh'],
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['3:2', '3:2'],
  ['2:3', '2:3'],
]);

const VIDEO_RATIOS_REF = opts([
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
]);

const IMAGE_RATIOS = opts([
  ['1:1', '1:1 Vuông'],
  ['16:9', '16:9 Ngang'],
  ['9:16', '9:16 Dọc (TikTok, Story)'],
  ['4:3', '4:3 Ngang chuẩn'],
  ['3:4', '3:4 Chân dung'],
  ['20:9', '20:9 Điện ảnh siêu rộng'],
  ['9:19.5', '9:19.5 Màn hình điện thoại'],
  ['auto', 'Tự động theo mô tả'],
]);

const VIDEO_RESOLUTIONS_1080 = opts([
  ['720p', '720p'],
  ['1080p', '1080p'],
  ['480p', '480p'],
]);

const VIDEO_RESOLUTIONS_720 = opts([
  ['720p', '720p'],
  ['480p', '480p'],
]);

const VIDEO_DURATIONS = opts([
  ['6', '6s'],
  ['8', '8s'],
  ['10', '10s'],
  ['15', '15s'],
]);

const IMAGE_COUNTS = opts([
  ['1', '1 ảnh'],
  ['2', '2 ảnh'],
  ['4', '4 ảnh'],
]);

const imgCount = (input: AiInput) => Math.max(1, Math.min(4, Number(input.count) || 1));

/** Chuẩn hoá ký hiệu ảnh tham chiếu 0-based `<IMAGE_0>..<IMAGE_4>` cho Grok Imagine (hỗ trợ khách gõ `<IMAGE_1>..` hoặc `Ảnh 1, Ảnh 2`) */
function normalizeRefPrompt(rawPrompt: string, count: number): string {
  let finalPrompt = rawPrompt;
  if (count >= 1 && !/<IMAGE_0>/i.test(finalPrompt) && new RegExp(`<IMAGE_${count}>`, 'i').test(finalPrompt)) {
    finalPrompt = finalPrompt.replace(/<IMAGE_(\d+)>/gi, (m, d) => {
      const n = Number(d);
      return n >= 1 && n <= count ? `<IMAGE_${n - 1}>` : m;
    });
  }
  if (count >= 2 && !/<IMAGE_0>/i.test(finalPrompt)) {
    const ordinals = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'];
    const mapping = Array.from({ length: count }, (_, idx) => `<IMAGE_${idx}> = Image ${idx + 1} (${ordinals[idx] ?? `#${idx + 1}`} image / Ảnh ${idx + 1} / @Image ${idx + 1} / 图${idx + 1} / @图${idx + 1})`).join('; ');
    finalPrompt = `[Reference image order mapping: ${mapping}. Strictly use each <IMAGE_k> according to its assigned role above without swapping.]\n\n${finalPrompt}`;
  }
  return finalPrompt;
}

const TOOLS: AiToolDef[] = [
  {
    key: 'grok-video',
    name: 'Tạo video Grok Imagine',
    category: 'video',
    icon: 'film',
    badge: 'HOT',
    featured: true,
    description: 'Tạo video điện ảnh tới Full HD 1080p dài 6–15 giây có sẵn âm thanh tự nhiên từ mô tả, ảnh khung đầu/cuối hoặc tối đa 5 ảnh tham chiếu (<IMAGE_0>…<IMAGE_4>).',
    output: 'video',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'grok-imagine-video-1.5', options: opts(VIDEO_MODELS) },
      {
        name: 'mode',
        label: 'Chế độ',
        type: 'select',
        required: true,
        optionsBy: {
          field: 'model',
          map: {
            'grok-imagine-video-1.5': opts([
              ['15:t2v', 'Từ mô tả'],
              ['15:i2v', 'Khung hình đầu - cuối'],
              ['15:ref', 'Ảnh tham chiếu'],
            ]),
            'grok-imagine-video-1.5-lite': opts([
              ['lite:t2v', 'Từ mô tả'],
              ['lite:i2v', 'Khung hình đầu - cuối'],
            ]),
            'grok-imagine-video': opts([
              ['10:t2v', 'Từ mô tả'],
              ['10:i2v', 'Khung hình đầu - cuối'],
              ['10:ref', 'Ảnh tham chiếu'],
            ]),
          },
        },
      },
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tối đa 5)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 5,
        accept: 'image/png,image/jpeg,image/webp',
        showIf: { field: 'mode', in: ['15:ref', '10:ref'] },
        help: 'Gọi trong mô tả là <IMAGE_0>, <IMAGE_1>… theo thứ tự (hoặc Ảnh 1, Ảnh 2…). Video theo ảnh tham chiếu hỗ trợ tối đa 720p.',
      },
      {
        name: 'image',
        label: 'Ảnh khung đầu',
        type: 'image',
        required: true,
        accept: 'image/png,image/jpeg,image/webp',
        showIf: { field: 'mode', in: ['15:i2v', 'lite:i2v', '10:i2v'] },
        help: 'Tải ảnh khung hình bắt đầu để biến ảnh tĩnh thành video chuyển động',
      },
      {
        name: 'lastFrame',
        label: 'Ảnh khung cuối (tuỳ chọn)',
        type: 'image',
        accept: 'image/png,image/jpeg,image/webp',
        showIf: { field: 'mode', in: ['15:i2v', 'lite:i2v', '10:i2v'] },
        help: 'Chốt khung hình cuối (không bắt buộc; khi dùng Khung cuối độ phân giải tối đa là 720p)',
      },
      {
        name: 'prompt',
        label: 'Mô tả cảnh & chuyển động (prompt)',
        type: 'textarea',
        required: true,
        placeholder: 'Ví dụ: máy quay lướt chậm quanh chai nước hoa, tia vàng bắn chậm, ánh sáng điện ảnh (chế độ Ảnh tham chiếu gọi <IMAGE_0>, <IMAGE_1>…)',
      },
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        optionsBy: {
          field: 'mode',
          map: {
            '15:t2v': VIDEO_RATIOS_T2V,
            'lite:t2v': VIDEO_RATIOS_T2V,
            '10:t2v': VIDEO_RATIOS_T2V,
            '15:i2v': VIDEO_RATIOS_I2V,
            'lite:i2v': VIDEO_RATIOS_I2V,
            '10:i2v': VIDEO_RATIOS_I2V,
            '15:ref': VIDEO_RATIOS_REF,
            'lite:ref': VIDEO_RATIOS_REF,
            '10:ref': VIDEO_RATIOS_REF,
          },
        },
      },
      {
        name: 'duration',
        label: 'Thời lượng',
        type: 'select',
        required: true,
        default: '6',
        options: VIDEO_DURATIONS,
      },
      {
        name: 'resolution',
        label: 'Độ phân giải',
        type: 'select',
        required: true,
        default: '720p',
        optionsBy: {
          field: 'mode',
          map: {
            '15:t2v': VIDEO_RESOLUTIONS_1080,
            '15:i2v': VIDEO_RESOLUTIONS_1080,
            'lite:t2v': VIDEO_RESOLUTIONS_1080,
            'lite:i2v': VIDEO_RESOLUTIONS_1080,
            '15:ref': VIDEO_RESOLUTIONS_720,
            'lite:ref': VIDEO_RESOLUTIONS_720,
            '10:t2v': VIDEO_RESOLUTIONS_720,
            '10:i2v': VIDEO_RESOLUTIONS_720,
            '10:ref': VIDEO_RESOLUTIONS_720,
          },
        },
      },
    ],
    unitLabel: 'video',
    pricing: { mode: 'fixed', base: 499, min: 499 },
  },
  {
    key: 'grok-image',
    name: 'Tạo ảnh Grok Imagine 2K',
    category: 'image',
    icon: 'image',
    badge: '2K',
    featured: true,
    description: 'Tạo ảnh chất lượng cao độ phân giải tới 2K sắc nét bằng Grok Imagine 2.0, hỗ trợ đa dạng tỉ lệ khung hình.',
    output: 'image',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'grok-imagine-image-2.0', options: opts(IMAGE_MODELS) },
      { name: 'prompt', label: 'Mô tả ảnh (prompt)', type: 'textarea', required: true, placeholder: 'Mô tả chủ thể, bối cảnh, ánh sáng, phong cách nghệ thuật...' },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '1:1', options: IMAGE_RATIOS },
      {
        name: 'resolution',
        label: 'Độ nét',
        type: 'select',
        required: true,
        optionsBy: {
          field: 'model',
          map: {
            'grok-imagine-image-2.0': opts([['2k', '2K Siêu nét'], ['1k', '1K Tiêu chuẩn']]),
            'grok-imagine-image': opts([['1k', '1K Tiêu chuẩn']]),
          },
        },
      },
      { name: 'count', label: 'Số lượng ảnh', type: 'select', required: true, default: '1', options: IMAGE_COUNTS },
    ],
    unitLabel: 'ảnh',
    units: imgCount,
    pricing: { mode: 'fixed', base: 0, perUnit: 250, min: 250 },
  },
  {
    key: 'grok-edit',
    name: 'Sửa & ghép ảnh Grok Imagine 2K',
    category: 'chinh-sua-anh-ai',
    icon: 'wand-sparkles',
    badge: '2K',
    description: 'Tải lên tối đa 5 ảnh để chỉnh sửa chi tiết, đổi nền, thay trang phục hoặc ghép nhiều nhân vật/vật thể (<IMAGE_0>, <IMAGE_1>...) chuẩn độ nét 2K.',
    output: 'image',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'grok-imagine-image-2.0', options: opts(IMAGE_MODELS) },
      {
        name: 'images',
        label: 'Ảnh gốc (tối đa 5 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 5,
        accept: 'image/png,image/jpeg,image/webp',
        help: 'Thứ tự tải lên / mảng URL được giữ cố định từ 1 đến 5: có thể gọi trong mô tả là Ảnh 1, Ảnh 2, Ảnh 3... (Image 1, Image 2...) hoặc <IMAGE_0>, <IMAGE_1>...',
      },
      { name: 'prompt', label: 'Yêu cầu chỉnh sửa / ghép ảnh', type: 'textarea', required: true, placeholder: 'Ví dụ: Đổi nền thành bãi biển lúc hoàng hôn, giữ nguyên nhân vật trong <IMAGE_0>...' },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: 'auto', options: IMAGE_RATIOS },
      {
        name: 'resolution',
        label: 'Độ nét',
        type: 'select',
        required: true,
        optionsBy: {
          field: 'model',
          map: {
            'grok-imagine-image-2.0': opts([['2k', '2K Siêu nét'], ['1k', '1K Tiêu chuẩn']]),
            'grok-imagine-image': opts([['1k', '1K Tiêu chuẩn']]),
          },
        },
      },
    ],
    unitLabel: 'lượt',
    pricing: { mode: 'fixed', base: 300, min: 300 },
  },
  {
    key: 'video-stitch',
    name: 'Ghép Video AI Liền Mạch',
    category: 'video',
    icon: 'film',
    badge: 'MIỄN PHÍ',
    featured: true,
    description: 'Chọn các video đã có hoặc tải từ máy, sắp xếp thứ tự và ghép thành một video hoàn chỉnh ngay trên trình duyệt — miễn phí 0đ.',
    output: 'video',
    splitModels: false,
    unitLabel: 'lượt',
    fields: [
      {
        name: 'aspectRatio',
        label: 'Tỉ lệ khung hình',
        type: 'select',
        required: true,
        default: '9:16',
        options: opts([
          ['9:16', '9:16 Dọc (TikTok, Reels)'],
          ['16:9', '16:9 Ngang (YouTube, PC)'],
          ['1:1', '1:1 Vuông'],
        ]),
      },
      {
        name: 'resolution',
        label: 'Chất lượng xuất',
        type: 'select',
        required: true,
        default: '1080p',
        options: opts([
          ['1080p', 'Full HD 1080p'],
          ['720p', 'HD 720p (Nhanh)'],
        ]),
      },
    ],
    pricing: { mode: 'free' },
  },
];

/** Kiểm tra ảnh upload nội bộ hợp lệ rồi mã hoá Data URI base64 (tự nén nhẹ nếu ảnh > 4MB để tổng JSON body luôn < trần 32MB của Fable — T-507) */
async function toDataUri(ctx: AiCallContext, url: string): Promise<string> {
  const f = await loadInputFile(ctx.readUpload, url);
  let meta: { width?: number; height?: number; format?: string; hasAlpha?: boolean };
  try {
    meta = await sharp(f.data).metadata();
  } catch {
    throw new AiProviderError('Ảnh tải lên bị hỏng hoặc không đúng định dạng ảnh hợp lệ (PNG, JPG, WEBP)');
  }
  if (!meta.width || !meta.height) {
    throw new AiProviderError('Ảnh tải lên không đọc được kích thước hợp lệ');
  }
  if (f.data.length > 4 * 1024 * 1024) {
    const shrunk = await sharp(f.data)
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    return `data:image/jpeg;base64,${shrunk.toString('base64')}`;
  }
  const mime = meta.format === 'png' ? 'image/png' : meta.format === 'webp' ? 'image/webp' : f.mimeType || 'image/jpeg';
  return `data:${mime};base64,${f.data.toString('base64')}`;
}

/** Chuẩn hoá lỗi từ Fable: 429 -> xếp hàng chờ luồng trống; 401/402 -> báo bảo trì ẩn nguồn và tự hoàn tiền */
function mapFableError(err: unknown): never {
  if (err instanceof AiProviderError) {
    const status = Number((err.raw as { status?: unknown } | undefined)?.status ?? 0);
    if (status === 429) {
      throw new AiProviderError('Đang chờ luồng xử lý trống, hệ thống sẽ tự gửi ngay trong giây lát', { waitingSlot: true, retryMs: 15_000, raw: err.raw }, true);
    }
    if (status === 401 || status === 402) {
      throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Tiền đã được hoàn lại.', err.raw, false);
    }
  }
  throw err;
}

/** Tải file MP4 kết quả qua `/videos/:id/content` (yêu cầu Bearer token, trả 302 redirect sang file thật) */
async function downloadVideoContent(ctx: AiCallContext, id: string): Promise<AiOutputFile> {
  const contentUrl = joinUrl(ctx.config.baseUrl || 'https://fablemedical.shop/v1', `/videos/${encodeURIComponent(id)}/content`);
  const res = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${ctx.config.apiKey}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  }).catch((e: Error) => {
    throw new AiProviderError('Không tải được file video kết quả, hệ thống sẽ thử lại', { error: e.message }, true);
  });
  if (!res.ok) {
    throw new AiProviderError(`Không tải được video kết quả (HTTP ${res.status})`, { status: res.status }, res.status >= 500 || res.status === 429);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new AiProviderError('File video kết quả rỗng', { id }, true);
  return { url: '', type: 'video', data: buf, mimeType: res.headers.get('content-type') || 'video/mp4' };
}

export const fableProvider: AiProvider = {
  key: 'fable',
  name: 'Fable Studio (Grok Pool)',
  website: 'https://fablemedical.shop',
  tools: TOOLS,

  async submit(tool, input, ctx) {
    if (tool.key === 'video-stitch') {
      return { status: 'succeeded', providerTaskId: `stitch:${Date.now()}`, text: 'Ghép video trên trình duyệt hoàn tất' };
    }
    const cfg = { ...ctx.config, baseUrl: ctx.config.baseUrl || 'https://fablemedical.shop/v1' };
    try {
      if (tool.key === 'grok-video') {
        const requestedModel = VIDEO_MODELS.some(([k]) => k === str(input.model)) ? str(input.model) : 'grok-imagine-video-1.5';
        const seconds = String(Math.max(1, Math.min(15, Number(input.duration) || 6)));
        const rawRes = str(input.resolution) || '720p';
        const aspectRatio = str(input.aspectRatio) || '16:9';
        const modeRaw = str(input.mode);
        const modeKind = modeRaw.endsWith(':ref') || modeRaw === 'ref' ? 'ref' : modeRaw.endsWith(':i2v') || modeRaw === 'i2v' ? 'i2v' : 't2v';
        const rawRefList = Array.isArray(input.images) ? input.images.map(str).filter(Boolean) : str(input.images) ? [str(input.images)] : [];

        // Chế độ Ảnh tham chiếu (tối đa 5 ảnh, gọi <IMAGE_0>..<IMAGE_4>, độ phân giải tối đa 720p)
        if (modeKind === 'ref' || rawRefList.length > 0) {
          if (!rawRefList.length) throw new AiProviderError('Vui lòng tải lên ít nhất 1 ảnh tham chiếu');
          const refUris = await Promise.all(rawRefList.slice(0, 5).map((u) => toDataUri(ctx, u)));
          // Bản 1.5-lite không nhận reference_images và bản 1.0 giới hạn tối đa 10s (gửi > 10s trả HTTP 400) -> tự nâng sang 1.5 (cùng luồng trọn gói không giới hạn)
          const model =
            requestedModel === 'grok-imagine-video-1.5-lite' || (requestedModel === 'grok-imagine-video' && Number(seconds) > 10)
              ? 'grok-imagine-video-1.5'
              : requestedModel;
          const resolution = rawRes === '1080p' ? '720p' : rawRes;
          const finalPrompt = normalizeRefPrompt(str(input.prompt), refUris.length);
          const res = await providerFetch<any>(
            cfg,
            '/videos',
            {
              json: {
                model,
                prompt: finalPrompt,
                seconds,
                extra_body: {
                  resolution,
                  ...(aspectRatio && aspectRatio !== 'auto' ? { aspect_ratio: aspectRatio } : { aspect_ratio: '16:9' }),
                  reference_images: refUris.map((url) => ({ url })),
                },
              },
              timeoutMs: 90_000,
            },
          );
          const id = str(res?.id ?? res?.data?.id);
          if (!id) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ video', res);
          return { status: 'processing', providerTaskId: id, progress: Number(res?.progress) || 5, raw: res };
        }

        // Chế độ Khung hình đầu - cuối (Khung đầu + tuỳ chọn Khung cuối) hoặc Từ mô tả (t2v)
        const [rawImgUri, rawLastUri] = await Promise.all([
          str(input.image) ? toDataUri(ctx, str(input.image)) : Promise.resolve(''),
          str(input.lastFrame) ? toDataUri(ctx, str(input.lastFrame)) : Promise.resolve(''),
        ]);
        const imgUri = rawImgUri || rawLastUri;
        const lastUri = rawImgUri && rawLastUri ? rawLastUri : '';
        // Bản 1.0 / 1.5-lite trả 400 nếu có last_frame, và bản 1.0 giới hạn tối đa 10s -> tự nâng sang 1.5 (cùng luồng trọn gói); có last_frame hoặc khách chọn bản 1.0 thì giữ trần 720p
        const needUpgrade15 =
          (lastUri && requestedModel !== 'grok-imagine-video-1.5') ||
          (requestedModel === 'grok-imagine-video' && Number(seconds) > 10);
        const model = needUpgrade15 ? 'grok-imagine-video-1.5' : requestedModel;
        const resolution = (requestedModel === 'grok-imagine-video' || lastUri) && rawRes === '1080p' ? '720p' : rawRes;
        const res = await providerFetch<any>(
          cfg,
          '/videos',
          {
            json: {
              model,
              prompt: str(input.prompt),
              seconds,
              ...(imgUri ? { image: { url: imgUri } } : {}),
              extra_body: {
                resolution,
                ...(aspectRatio && aspectRatio !== 'auto' ? { aspect_ratio: aspectRatio } : {}),
                ...(lastUri ? { last_frame: { url: lastUri } } : {}),
              },
            },
            timeoutMs: 90_000,
          },
        );
        const id = str(res?.id ?? res?.data?.id);
        if (!id) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ video', res);
        return { status: 'processing', providerTaskId: id, progress: Number(res?.progress) || 5, raw: res };
      }

      if (tool.key === 'grok-image') {
        const model = IMAGE_MODELS.some(([k]) => k === str(input.model)) ? str(input.model) : 'grok-imagine-image-2.0';
        const isV1 = model === 'grok-imagine-image';
        const resolution = str(input.resolution).toLowerCase() === '1k' ? '1k' : '2k';
        const n = imgCount(input);
        const res = await providerFetch<any>(
          cfg,
          '/images/generations',
          {
            json: {
              model,
              prompt: str(input.prompt),
              n,
              aspect_ratio: str(input.aspectRatio) || '1:1',
              ...(isV1 ? {} : { quality: 'medium', resolution }),
            },
            timeoutMs: 150_000,
          },
        );
        const list = Array.isArray(res?.data) ? res.data : [];
        const files: AiOutputFile[] = list
          .map((item: any) => str(item?.url))
          .filter(Boolean)
          .map((url: string) => ({ url, type: guessType(url, 'image') }));
        if (!files.length) throw new AiProviderError('Nhà cung cấp không trả file ảnh kết quả', res);
        return { status: 'succeeded', files, raw: res };
      }

      if (tool.key === 'grok-edit') {
        const model = IMAGE_MODELS.some(([k]) => k === str(input.model)) ? str(input.model) : 'grok-imagine-image-2.0';
        const resolution = model === 'grok-imagine-image' ? '1k' : str(input.resolution).toLowerCase() === '1k' ? '1k' : '2k';
        const rawList = Array.isArray(input.images) ? input.images.map(str).filter(Boolean) : str(input.images) ? [str(input.images)] : [];
        if (!rawList.length) throw new AiProviderError('Vui lòng tải lên ít nhất 1 ảnh gốc');
        const loaded = await Promise.all(rawList.slice(0, 5).map((u) => loadInputFile(ctx.readUpload, u)));
        const prepared = await Promise.all(
          loaded.map(async (f, idx) => {
            let meta: { width?: number; height?: number; format?: string };
            try {
              meta = await sharp(f.data).metadata();
            } catch {
              throw new AiProviderError('Ảnh gốc tải lên bị hỏng hoặc không đúng định dạng ảnh hợp lệ (PNG, JPG, WEBP)');
            }
            if (!meta.width || !meta.height) {
              throw new AiProviderError('Ảnh gốc tải lên không đọc được kích thước hợp lệ');
            }
            if (f.data.length > 4 * 1024 * 1024) {
              const shrunk = await sharp(f.data)
                .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 92 })
                .toBuffer();
              return { data: shrunk, mimeType: 'image/jpeg', filename: `image_${idx + 1}.jpg` };
            }
            const ext = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
            return { data: f.data, mimeType, filename: `image_${idx + 1}.${ext}` };
          }),
        );
        // Grok Imagine định danh từng ảnh đính kèm bằng token 0-based `<IMAGE_0>`, `<IMAGE_1>`, `<IMAGE_2>`...
        // Tự động chuẩn hoá khi khách viết theo thứ tự tự nhiên 1-based (`Ảnh 1, 2, 3` / `Image 1, 2, 3` / `FIRST, SECOND, THIRD` / `<IMAGE_1>..<IMAGE_N>`)
        let finalPrompt = str(input.prompt);
        if (prepared.length >= 2) {
          if (!/<IMAGE_0>/i.test(finalPrompt) && new RegExp(`<IMAGE_${prepared.length}>`, 'i').test(finalPrompt)) {
            finalPrompt = finalPrompt.replace(/<IMAGE_(\d+)>/gi, (m, d) => {
              const n = Number(d);
              return n >= 1 && n <= prepared.length ? `<IMAGE_${n - 1}>` : m;
            });
          }
          if (!/<IMAGE_0>/i.test(finalPrompt)) {
            const ordinals = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'];
            const mapping = prepared
              .map((_, idx) => `<IMAGE_${idx}> = Image ${idx + 1} (${ordinals[idx] ?? `#${idx + 1}`} image / Ảnh ${idx + 1} / @Image ${idx + 1})`)
              .join('; ');
            finalPrompt = `[Reference image order mapping: ${mapping}. Strictly use each <IMAGE_k> according to its assigned role above without swapping.]\n\n${finalPrompt}`;
          }
        }
        const form = new FormData();
        form.set('model', model);
        form.set('prompt', finalPrompt);
        if (model !== 'grok-imagine-image') {
          form.set('resolution', resolution);
          form.set('quality', 'medium');
        }
        if (str(input.aspectRatio) && str(input.aspectRatio) !== 'auto') form.set('aspect_ratio', str(input.aspectRatio));
        for (const f of prepared) {
          form.append('image', new Blob([new Uint8Array(f.data)], { type: f.mimeType }), f.filename);
        }
        const res = await providerFetch<any>(cfg, '/images/edits', { form, timeoutMs: 150_000 });
        const list = Array.isArray(res?.data) ? res.data : [];
        const files: AiOutputFile[] = list
          .map((item: any) => str(item?.url))
          .filter(Boolean)
          .map((url: string) => ({ url, type: guessType(url, 'image') }));
        if (!files.length) throw new AiProviderError('Nhà cung cấp không trả file ảnh đã chỉnh sửa', res);
        return { status: 'succeeded', files, raw: res };
      }

      throw new AiProviderError('Công cụ không được hỗ trợ');
    } catch (err) {
      mapFableError(err);
    }
  },

  async poll(_tool, id, ctx): Promise<AiProviderResult> {
    const cfg = { ...ctx.config, baseUrl: ctx.config.baseUrl || 'https://fablemedical.shop/v1' };
    let job: any;
    try {
      job = await providerFetch<any>(cfg, `/videos/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
    } catch (err) {
      mapFableError(err);
    }
    const status = str(job?.status).toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      return { status: 'failed', providerTaskId: id, error: pickMessage(job) || 'Không tạo được video, tiền đã được hoàn lại', raw: job };
    }
    if (!['completed', 'complete', 'succeeded', 'done'].includes(status)) {
      return { status: 'processing', providerTaskId: id, progress: Number(job?.progress) || undefined, raw: job };
    }
    const directUrl = str(job?.url ?? job?.video_url ?? job?.output?.url);
    const file = directUrl && /^https?:\/\//i.test(directUrl) && !directUrl.includes('/v1/videos/')
      ? { url: directUrl, type: 'video' as const }
      : await downloadVideoContent({ ...ctx, config: cfg }, id);
    return { status: 'succeeded', providerTaskId: id, files: [file], raw: job };
  },

  async catalog(ctx) {
    const cfg = { ...ctx.config, baseUrl: ctx.config.baseUrl || 'https://fablemedical.shop/v1' };
    const res = await providerFetch<any>(cfg, '/models', { timeoutMs: 20_000 });
    const list = Array.isArray(res?.data) ? res.data : [];
    return list.map((m: any) => ({ id: str(m?.id), label: str(m?.id) })).filter((x: { id: string }) => !!x.id);
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const cfg = { ...ctx.config, baseUrl: ctx.config.baseUrl || 'https://fablemedical.shop/v1' };
    const res = await providerFetch<any>(cfg, '/models', { timeoutMs: 15_000 }).catch(() => null);
    const list = Array.isArray(res?.data) ? res.data : [];
    const liveIds = new Set(list.map((m: any) => str(m?.id).trim()).filter(Boolean));
    if (liveIds.size < 2) return { addedTools: [], removedKeys: [] };

    const removedKeys: string[] = [];
    const updatedSplits: string[] = [];
    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (t.key === 'video-stitch') continue;
      const mf = t.fields.find((f) => f.name === 'model' && Array.isArray(f.options) && f.options.length > 0);
      if (!mf?.options) continue;
      const kept = mf.options.filter((o) => liveIds.has(String(o.value)));
      const dropped = mf.options.filter((o) => !liveIds.has(String(o.value)));
      if (!kept.length) {
        removedKeys.push(`fable.${t.key}`);
        for (const d of dropped) removedKeys.push(`fable.${t.key}~${d.value}`);
        TOOLS.splice(i, 1);
      } else if (dropped.length > 0) {
        mf.options = kept;
        if (!kept.some((o) => o.value === mf.default)) mf.default = kept[0].value;
        for (const d of dropped) removedKeys.push(`fable.${t.key}~${d.value}`);
        updatedSplits.push(`fable.${t.key}`);
      }
    }
    return { addedTools: [], updatedSplits, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey) return null;
    const cfg = { ...ctx.config, baseUrl: ctx.config.baseUrl || 'https://fablemedical.shop/v1' };
    try {
      const res = await providerFetch<any>(cfg, '/models', { timeoutMs: 15_000 });
      const list = Array.isArray(res?.data) ? res.data : [];
      if (!list.length) return null;
      const activeIds = new Set(list.map((m: any) => str(m?.id)).filter(Boolean));
      const down = new Set<string>();
      for (const [mId] of VIDEO_MODELS) if (!activeIds.has(mId)) down.add(`grok-video~${mId}`);
      for (const [mId] of IMAGE_MODELS) {
        if (!activeIds.has(mId)) {
          down.add(`grok-image~${mId}`);
          down.add(`grok-edit~${mId}`);
        }
      }
      return down;
    } catch (err) {
      const status = Number(((err as AiProviderError)?.raw as { status?: unknown } | undefined)?.status ?? 0);
      if (status === 402 || status === 401) return 'ALL';
      return null;
    }
  },
};
