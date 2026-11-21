import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AiProviderError, type AiCallContext, type AiFieldOption, type AiInput, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { backgroundState, loadInputFile, startBackground } from './background.js';
import { joinUrl, pickMessage, str } from './http.js';

/**
 * AHiep API — https://api.ahiep.com/huong-dan-tich-hop.html (API tương thích OpenAI, base `https://api.ahiep.com/v1`, header Bearer sk-...).
 * - Chat: POST /chat/completions (ĐỒNG BỘ, có thể vài chục giây) -> chạy nền (startBackground) như IMG Studio / VidGrab.
 * - Ảnh: POST /images/generations, /images/edits (JSON `images: [data URL]`), đồng bộ 20–60 giây/ảnh -> chạy nền, lấy link (`response_format: url`).
 * - Video: POST /videos (bất đồng bộ) -> hỏi GET /videos/{id} tới khi `completed` / `failed`.
 * - Số dư: GET /key/quota (VNĐ, không tốn quota); danh mục model: GET /models.
 *
 * Giá: nguồn tính chat theo token, website bán theo KÝ TỰ để khách dễ hiểu. Admin nhập GIÁ VỐN ở tab Khoá API (nhóm `ai_ahiep`):
 * - `tokenCosts` : đ / 1 triệu token cho từng model chat (đúng bảng giá nguồn); hệ thống đổi ra ký tự theo ~2,5 ký tự / token
 *                  (tính cả ký tự gửi đi lẫn ký tự AI trả về);
 * - `imageCosts` : đ / ảnh cho từng model ảnh;  `videoCostPerVideo`: đ / mỗi video (không phụ thuộc thời lượng).
 * Công cụ dùng pricing `cost` (giá vốn × tỉ giá 1, rồi cộng % lãi + mức tối thiểu ở AI Studio › Công cụ).
 * Chống lỗ: credits trừ TRƯỚC theo độ dài TỐI ĐA (ký tự khách nhập + phần lời nhắc hệ thống + độ dài kết quả tối đa khách chọn),
 * prompt yêu cầu AI viết trong giới hạn đó và kết quả vượt quá xa bị cắt bớt, nên chi phí thật không vượt số đã thu.
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

/** Model chat: [mã model, tên hiển thị, giá vốn mặc định đ / 1 triệu token] — admin sửa giá vốn ở tab Khoá API */
const CHAT_MODELS: [string, string, number][] = [
  ['codex-gpt-6.1-sol', 'GPT 6.1 Sol · đa dụng, khuyên dùng', 8000],
  ['codex-gpt-6-astra', 'GPT 6 Astra · mạnh nhất', 16000],
  ['codex-gpt-6-luna', 'GPT 6 Luna · nhanh, tiết kiệm', 2400],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash · viết, dịch nhanh', 2400],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro · nội dung dài', 8000],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite · nhẹ nhất', 1600],
];
/** Số ký tự trung bình của 1 token (tiếng Việt ~2,5) — đổi giá vốn đ / 1 triệu token ra số ký tự tính tiền */
const CHARS_PER_TOKEN = 2.5;
/** Model cho các công cụ viết / dịch / tóm tắt (ít lựa chọn hơn cho khách dễ chọn) */
const WRITE_MODELS = CHAT_MODELS.filter(([k]) => ['codex-gpt-6.1-sol', 'codex-gpt-6-astra', 'codex-gpt-6-luna', 'gemini-3.8-flash'].includes(k));

/** Khổ ảnh các model Gemini Image (đã bỏ mức 4K theo T-456, chỉ giữ chuẩn 2K sắc nét) */
const GEMINI_IMAGE_SIZES = opts([
  ['1:1', '1:1 (Vuông) 2K'],
  ['16:9', '16:9 (Ngang) 2K'],
  ['2752x1536', '16:9 (Ngang) 2752×1536'],
  ['9:16', '9:16 (Dọc) 2K'],
  ['1536x2752', '9:16 (Dọc) 1536×2752'],
  ['4:3', '4:3 (Ngang) 2K'],
  ['3:4', '3:4 (Dọc) 2K'],
  ['3:2', '3:2 (Ngang) 2K'],
  ['2:3', '2:3 (Dọc) 2K'],
  ['5:4', '5:4 (Ngang) 2K'],
  ['4:5', '4:5 (Dọc) 2K'],
  ['21:9', '21:9 (Màn rộng) 2K'],
]);
/** Khổ ảnh các model GPT Image (nguồn nhận khổ gần nhất trong 3 khổ) */
const GPT_IMAGE_SIZES = opts([['1024x1024', 'Vuông 1024×1024'], ['1536x1024', 'Ngang 1536×1024'], ['1024x1536', 'Dọc 1024×1536']]);
/** Model ảnh: [mã, tên, giá vốn mặc định đ / ảnh, khổ ảnh nhận được] */
const IMAGE_MODELS: [string, string, number, AiFieldOption[]][] = [
  ['gemini-image', 'Gemini Image · 2K, khuyên dùng', 60, GEMINI_IMAGE_SIZES],
  ['gemini-nano-banana-2.1', 'Gemini Nano Banana 2.1 · 2K', 60, GEMINI_IMAGE_SIZES],
  ['gemini-3-pro-image', 'Gemini 3 Pro Image · chi tiết cao', 60, GEMINI_IMAGE_SIZES],
  ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image · nhanh, nét', 60, GEMINI_IMAGE_SIZES],
  ['gemini-3.1-flash-lite-image', 'Gemini 3.1 Flash Lite Image · siêu tốc', 60, GEMINI_IMAGE_SIZES],
  // 2026-11-09 nguồn thêm 4 model GPT Image (GET /models, capability image); giá vốn tạm bằng gpt-image-2, admin sửa ở tab Khoá API
  ['gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst · nhiều chi tiết', 800, GPT_IMAGE_SIZES],
  ['gpt-image-2.6-flare', 'GPT Image 2.6 Flare · tạo, sửa nhanh', 800, GPT_IMAGE_SIZES],
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst · sửa ảnh chính xác', 800, GPT_IMAGE_SIZES],
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare · chất lượng cao, nhanh', 800, GPT_IMAGE_SIZES],
  ['gpt-image-2', 'GPT Image 2 · thế hệ trước', 800, GPT_IMAGE_SIZES],
  ['muse-image', 'Muse Image', 400, opts([['1:1', '1:1 (vuông)'], ['16:9', '16:9 (ngang)'], ['9:16', '9:16 (dọc)'], ['4:3', '4:3 (ngang)'], ['3:4', '3:4 (dọc)']])],
];
/** Giá vốn mặc định video muse-video (đ / mỗi video) */
const VIDEO_COST = 7500;

/** Kiểm tra khổ ảnh có phải mức 4K riêng của Gemini trên AHiep (`gemini_image_price_4k = 500đ/ảnh`) hay không */
function isGemini4kSize(model: string, rawSize: string): boolean {
  if (!model.startsWith('gemini-')) return false;
  const s = rawSize.trim().toLowerCase();
  if (!s) return false;
  if (s === '3840x2160' || s === '2160x3840' || s === '4k') return true;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(s);
  return m ? Math.max(Number(m[1]), Number(m[2])) > 2752 : false;
}

/** Giá vốn mặc định — dùng cho settings.defaults.ts và khi admin để trống */
export const AHIEP_DEFAULT_COSTS = {
  tokenCosts: Object.fromEntries(CHAT_MODELS.map(([k, , c]) => [k, c])) as Record<string, number>,
  imageCosts: {
    ...(Object.fromEntries(IMAGE_MODELS.map(([k, , c]) => [k, c])) as Record<string, number>),
    'gemini-image-4k': 500,
  } as Record<string, number>,
  videoCostPerVideo: VIDEO_COST,
};

/** Độ dài kết quả tối đa (ký tự) khách chọn — dùng cả để báo giá trước và để dặn AI */
const LENGTHS: Record<string, { label: string; chars: number }> = {
  short: { label: 'Ngắn (~1.500 ký tự)', chars: 1500 },
  medium: { label: 'Vừa (~4.000 ký tự)', chars: 4000 },
  long: { label: 'Dài (~8.000 ký tự)', chars: 8000 },
  xlong: { label: 'Rất dài (~15.000 ký tự)', chars: 15000 },
};
const LENGTH_FIELD = (def: string) => ({
  name: 'length',
  label: 'Độ dài kết quả tối đa',
  type: 'select' as const,
  required: true,
  default: def,
  options: Object.entries(LENGTHS).map(([value, l]) => ({ value, label: l.label })),
  help: 'Giá tính theo số ký tự bạn nhập + độ dài tối đa của kết quả',
});
/** Số ký tự lời nhắc hệ thống (system prompt + khung yêu cầu) cộng vào mỗi lần gọi */
const OVERHEAD = 400;

const LANGS = opts([
  ['Tiếng Việt', 'Tiếng Việt'],
  ['Tiếng Anh', 'Tiếng Anh'],
  ['Tiếng Trung (giản thể)', 'Tiếng Trung'],
  ['Tiếng Nhật', 'Tiếng Nhật'],
  ['Tiếng Hàn', 'Tiếng Hàn'],
  ['Tiếng Thái', 'Tiếng Thái'],
  ['Tiếng Pháp', 'Tiếng Pháp'],
  ['Tiếng Đức', 'Tiếng Đức'],
  ['Tiếng Tây Ban Nha', 'Tiếng Tây Ban Nha'],
  ['Tiếng Nga', 'Tiếng Nga'],
  ['Tiếng Indonesia', 'Tiếng Indonesia'],
]);

const IMG = 'image/png,image/jpeg,image/webp';
const sizeByModel = { field: 'model', map: Object.fromEntries(IMAGE_MODELS.map(([k, , , s]) => [k, s])) };
const modelField = (list: [string, string, ...unknown[]][]) => ({
  name: 'model',
  label: 'Model AI',
  type: 'select' as const,
  required: true,
  default: list[0][0],
  options: list.map(([value, label]) => ({ value, label })),
});

/** Chữ Hán / Kana / Hangul: dịch sang tiếng Việt dài ra nhiều (1 chữ ~ 3–4 ký tự Latin) */
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/g;

/** Số ký tự kết quả tối đa dự kiến của một lần chạy (dùng để báo giá + dặn AI + cắt khi vượt quá xa) */
function maxOutputChars(tool: AiToolDef, input: AiInput): number {
  if (tool.key === 'translate') {
    // bản dịch dài hơn bản gốc: chữ Latin ×1,5; chữ CJK ×4 (an toàn cho chiều CJK -> Việt)
    const text = str(input.text);
    const cjk = (text.match(CJK) ?? []).length;
    return Math.ceil((text.length - cjk) * 1.5 + cjk * 4) + 200;
  }
  return LENGTHS[str(input.length)]?.chars ?? LENGTHS.medium.chars;
}

/**
 * Tổng ký tự khách nhập vào các ô chữ của công cụ. Chữ CJK tốn ~1 token / chữ (chữ Latin / tiếng Việt ~2,5 ký tự / token)
 * nên mỗi chữ CJK tính thành 2,5 ký tự để giá vốn theo ký tự không bị hụt.
 */
const inputChars = (tool: AiToolDef, input: AiInput) =>
  tool.fields
    .filter((f) => f.type === 'text' || f.type === 'textarea')
    .reduce((n, f) => {
      const s = str(input[f.name]);
      return n + s.length + (s.match(CJK) ?? []).length * 1.5;
    }, 0);

/** Số ký tự tính tiền = ký tự gửi đi (kèm lời nhắc hệ thống) + ký tự kết quả tối đa */
const billedChars = (tool: AiToolDef, input: AiInput) => inputChars(tool, input) + OVERHEAD + maxOutputChars(tool, input);

/** Giá vốn từ cấu hình admin (số dương), thiếu thì lấy mặc định */
const costOf = (map: unknown, key: string, fallback: number) => {
  const v = Number((map as Record<string, unknown> | undefined)?.[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** units() của công cụ chữ: số nghìn ký tự tính tiền (hiện giá cho khách khi admin chuyển sang giá cố định / 1.000 ký tự) */
const textUnits = (key: string) => (input: AiInput) => billedChars(TOOLS.find((t) => t.key === key)!, input) / 1000;

const TEXT_PRICING = { mode: 'cost' as const, markup: 100, min: 100 };

const TOOLS: AiToolDef[] = [
  {
    key: 'chat',
    name: 'Hỏi đáp AI',
    category: 'text',
    icon: 'message-square',
    description: 'Hỏi bất cứ điều gì: giải thích, lên ý tưởng, viết code, phân tích số liệu... Trả lời bằng tiếng Việt.',
    output: 'text',
    fields: [
      modelField(CHAT_MODELS),
      { name: 'prompt', label: 'Câu hỏi / yêu cầu', type: 'textarea', required: true, max: 20000, placeholder: 'Ví dụ: Lập kế hoạch marketing 30 ngày cho quán cà phê mới mở' },
      { name: 'system', label: 'Vai trò của AI (tuỳ chọn)', type: 'text', max: 1000, placeholder: 'Ví dụ: Bạn là chuyên gia tài chính cá nhân' },
      LENGTH_FIELD('medium'),
    ],
    pricing: TEXT_PRICING,
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    units: textUnits('chat'),
  },
  {
    key: 'write',
    name: 'Viết nội dung AI',
    category: 'text',
    icon: 'pen-line',
    description: 'Viết bài blog chuẩn SEO, bài quảng cáo Facebook, mô tả sản phẩm, email, kịch bản video TikTok...',
    output: 'text',
    fields: [
      modelField(WRITE_MODELS),
      {
        name: 'kind',
        label: 'Loại nội dung',
        type: 'select',
        required: true,
        default: 'blog',
        options: opts([
          ['blog', 'Bài blog / bài viết chuẩn SEO'],
          ['facebook', 'Bài đăng Facebook / quảng cáo'],
          ['product', 'Mô tả sản phẩm'],
          ['email', 'Email marketing'],
          ['script', 'Kịch bản video ngắn (TikTok, Reels)'],
          ['other', 'Khác (theo yêu cầu)'],
        ]),
      },
      { name: 'topic', label: 'Chủ đề / thông tin', type: 'textarea', required: true, max: 5000, placeholder: 'Ví dụ: Giới thiệu máy lọc không khí X, giá 3,5 triệu, lọc bụi mịn PM2.5, bảo hành 2 năm' },
      { name: 'tone', label: 'Giọng văn', type: 'select', default: 'friendly', options: opts([['friendly', 'Thân thiện'], ['professional', 'Chuyên nghiệp'], ['persuasive', 'Thuyết phục, bán hàng'], ['funny', 'Hài hước'], ['emotional', 'Cảm xúc']]) },
      { name: 'language', label: 'Ngôn ngữ', type: 'select', default: 'Tiếng Việt', options: LANGS },
      LENGTH_FIELD('medium'),
    ],
    pricing: TEXT_PRICING,
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    units: textUnits('write'),
  },
  {
    key: 'translate',
    name: 'Dịch văn bản AI',
    category: 'text',
    icon: 'languages',
    description: 'Dịch văn bản tự nhiên như người bản xứ, giữ nguyên định dạng và thuật ngữ.',
    output: 'text',
    fields: [
      modelField(WRITE_MODELS),
      { name: 'text', label: 'Văn bản cần dịch', type: 'textarea', required: true, max: 30000, placeholder: 'Dán văn bản cần dịch...' },
      { name: 'targetLang', label: 'Dịch sang', type: 'select', required: true, default: 'Tiếng Việt', options: LANGS },
      { name: 'tone', label: 'Phong cách dịch', type: 'select', default: 'natural', options: opts([['natural', 'Tự nhiên'], ['formal', 'Trang trọng'], ['concise', 'Ngắn gọn']]) },
    ],
    pricing: TEXT_PRICING,
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    units: textUnits('translate'),
  },
  {
    key: 'summarize',
    name: 'Tóm tắt văn bản AI',
    category: 'text',
    icon: 'list',
    description: 'Tóm tắt bài viết, tài liệu, biên bản họp thành các ý chính dễ đọc.',
    output: 'text',
    fields: [
      modelField(WRITE_MODELS),
      { name: 'text', label: 'Văn bản cần tóm tắt', type: 'textarea', required: true, max: 60000, placeholder: 'Dán văn bản cần tóm tắt...' },
      { name: 'style', label: 'Kiểu tóm tắt', type: 'select', default: 'bullets', options: opts([['bullets', 'Gạch đầu dòng ý chính'], ['paragraph', 'Đoạn văn ngắn'], ['actions', 'Ý chính + việc cần làm']]) },
      LENGTH_FIELD('short'),
    ],
    pricing: TEXT_PRICING,
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    units: textUnits('summarize'),
  },
  {
    key: 'image',
    name: 'Tạo ảnh AI 2K (Gemini, GPT Image)',
    category: 'image',
    icon: 'image',
    description: 'Tạo ảnh từ mô tả tiếng Việt bằng Gemini Image (2K), GPT Image 2.6 / 2.5 (Sunburst, Flare), GPT Image 2, Muse Image.',
    output: 'image',
    fields: [
      modelField(IMAGE_MODELS),
      { name: 'prompt', label: 'Mô tả (prompt)', type: 'textarea', required: true, placeholder: 'Mô tả chủ thể, bối cảnh, ánh sáng, phong cách...' },
      { name: 'size', label: 'Khổ ảnh', type: 'select', required: true, optionsBy: sizeByModel },
      { name: 'n', label: 'Số ảnh', type: 'select', required: true, default: '1', options: opts([['1', '1 ảnh'], ['2', '2 ảnh'], ['3', '3 ảnh'], ['4', '4 ảnh']]) },
    ],
    pricing: { mode: 'cost', markup: 50 },
    supportsCost: true,
    unitLabel: 'ảnh',
    units: (input) => Math.max(1, Number(input.n) || 1),
  },
  {
    key: 'edit',
    name: 'Sửa & ghép ảnh AI',
    category: 'image',
    icon: 'wand-sparkles',
    description: 'Tải ảnh lên và mô tả thay đổi: đổi nền, thay trang phục, ghép người ở ảnh 1 với đồ ở ảnh 2...',
    output: 'image',
    fields: [
      {
        name: 'images',
        label: 'Ảnh tham chiếu (tối đa 4 ảnh)',
        type: 'image',
        required: true,
        multiple: true,
        maxFiles: 4,
        accept: IMG,
        help: 'Thứ tự tải lên / mảng URL được giữ cố định từ 1 đến 4 (gọi trong mô tả là Ảnh 1, Ảnh 2, Ảnh 3... hoặc Image 1, Image 2, Image 3)',
      },
      { name: 'prompt', label: 'Mô tả thay đổi', type: 'textarea', required: true, placeholder: 'Ví dụ: người ở ảnh 1 mặc chiếc áo ở ảnh 2, nền studio trắng' },
      modelField(IMAGE_MODELS),
      { name: 'size', label: 'Khổ ảnh', type: 'select', required: true, optionsBy: sizeByModel },
    ],
    pricing: { mode: 'cost', markup: 50 },
    supportsCost: true,
    unitLabel: 'ảnh',
  },
  {
    key: 'video',
    name: 'Tạo video AI Muse',
    category: 'video',
    icon: 'clapperboard',
    description: 'Tạo video từ mô tả, từ 1 ảnh khởi đầu hoặc kết hợp tối đa 4 ảnh tham chiếu.',
    output: 'video',
    splitModels: false,
    fields: [
      { name: 'prompt', label: 'Mô tả cảnh, chuyển động', type: 'textarea', required: true, placeholder: 'Ví dụ: chú mèo đội mũ phi công lái máy bay giấy bay qua thành phố, camera bám theo' },
      { name: 'image', label: 'Ảnh khởi đầu / tham chiếu (tuỳ chọn, tối đa 4 ảnh)', type: 'image', multiple: true, maxFiles: 4, accept: IMG, help: 'Tải 1 ảnh làm khung đầu, hoặc 2–4 ảnh để ghép nhân vật / trang phục / sản phẩm / bối cảnh tham chiếu' },
      { name: 'duration', label: 'Thời lượng', type: 'select', required: true, default: '5', options: opts([['5', '5s'], ['6', '6s'], ['8', '8s'], ['10', '10s']]) },
      { name: 'size', label: 'Khung hình', type: 'select', required: true, default: '16:9', options: opts([['16:9', '16:9 (Ngang)'], ['9:16', '9:16 (Dọc)'], ['1:1', '1:1 (Vuông)']]) },
    ],
    pricing: { mode: 'cost', markup: 50 },
    supportsCost: true,
    unitLabel: 'video',
    units: () => 1,
  },
];

/** Gọi API AHiep (JSON hoặc FormData multipart), lỗi chuyển thành AiProviderError theo bảng mã lỗi mục 13 của tài liệu */
async function call(ctx: AiCallContext, path: string, body?: unknown, timeoutMs = 330_000): Promise<any> {
  if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const method = body === undefined ? 'GET' : 'POST';
  const isForm = body instanceof FormData;
  let res: Response;
  let data: any = null;
  try {
    res = await fetch(joinUrl(ctx.config.baseUrl, path), {
      method,
      headers: {
        Authorization: `Bearer ${ctx.config.apiKey}`,
        Accept: 'application/json',
        'X-UI-Lang': 'vi',
        ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      // tài liệu khuyên timeout client >= 300 giây (ảnh 2K, câu trả lời dài)
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { body: text.slice(0, 2000) };
    }
  } catch (err) {
    // POST quá giờ: nguồn có thể đã xử lý (đã tính tiền) -> không tự gửi lại, báo lỗi để hoàn credits
    if (method === 'POST') throw new AiProviderError('Nhà cung cấp AI phản hồi quá lâu, tiền đã được hoàn lại', { error: (err as Error).message });
    throw new AiProviderError('Không kết nối được nhà cung cấp AI, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
  }
  if (res.ok) return data;
  const code = String(data?.error?.code ?? data?.code ?? '');
  // khoá sai / hết số dư / key không được dùng model / hết hạn mức kỳ: lỗi phía website -> không lộ chi tiết cho khách
  if ([401, 402, 403].includes(res.status) || /quota_exceeded|insufficient_balance|service_disabled/.test(code)) {
    throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.', { status: res.status, data });
  }
  const retryable = res.status === 429 || res.status >= 500;
  throw new AiProviderError(retryable ? 'Máy chủ AI đang bận, vui lòng thử lại sau. Credits đã được hoàn lại.' : pickMessage(data) || `Nhà cung cấp AI báo lỗi HTTP ${res.status}`, { status: res.status, data }, retryable);
}

/** Gọi lại khi lỗi tạm thời (429 / 5xx) tối đa 3 lần, giãn cách tăng dần — FormData nhận hàm tạo mới mỗi lượt */
async function callRetry(ctx: AiCallContext, path: string, body: unknown | (() => FormData)) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(ctx, path, typeof body === 'function' ? (body as () => FormData)() : body);
    } catch (err) {
      if (!(err instanceof AiProviderError) || !err.retryable || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
}

const TONES: Record<string, string> = {
  friendly: 'thân thiện, gần gũi',
  professional: 'chuyên nghiệp, đáng tin cậy',
  persuasive: 'thuyết phục, kêu gọi hành động',
  funny: 'hài hước, dí dỏm',
  emotional: 'giàu cảm xúc',
  natural: 'tự nhiên như người bản xứ',
  formal: 'trang trọng',
  concise: 'ngắn gọn',
};
const KINDS: Record<string, string> = {
  blog: 'một bài blog chuẩn SEO có tiêu đề, các đề mục (##) và kết luận',
  facebook: 'một bài đăng Facebook / quảng cáo có câu mở đầu thu hút, emoji vừa phải và lời kêu gọi hành động',
  product: 'một bài mô tả sản phẩm nêu bật lợi ích, thông số và lời kêu gọi mua hàng',
  email: 'một email marketing có tiêu đề email, lời chào, nội dung chính và lời kêu gọi hành động',
  script: 'một kịch bản video ngắn 30–60 giây chia theo cảnh, có lời thoại và gợi ý hình ảnh',
  other: 'nội dung theo đúng yêu cầu',
};
const SUMMARY: Record<string, string> = {
  bullets: 'các gạch đầu dòng ý chính',
  paragraph: 'một đoạn văn ngắn mạch lạc',
  actions: 'các ý chính, sau đó là danh sách việc cần làm (nếu có)',
};

/** Dựng messages gửi /chat/completions theo từng công cụ; luôn dặn giới hạn độ dài để chi phí không vượt số đã thu */
function messagesOf(tool: AiToolDef, input: AiInput): { role: string; content: string }[] {
  const max = maxOutputChars(tool, input);
  const limit = `Câu trả lời KHÔNG được dài quá ${max.toLocaleString('vi-VN')} ký tự.`;
  switch (tool.key) {
    case 'write':
      return [
        { role: 'system', content: `Bạn là chuyên gia viết nội dung marketing. Chỉ trả về nội dung hoàn chỉnh, không giải thích thêm. ${limit}` },
        { role: 'user', content: `Viết ${KINDS[str(input.kind)] ?? KINDS.other} bằng ${str(input.language) || 'Tiếng Việt'}, giọng văn ${TONES[str(input.tone)] ?? TONES.friendly}.\n\nChủ đề / thông tin:\n${str(input.topic)}` },
      ];
    case 'translate':
      return [
        { role: 'system', content: `Bạn là dịch giả chuyên nghiệp. Dịch chính xác, ${TONES[str(input.tone)] ?? TONES.natural}, giữ nguyên định dạng (xuống dòng, gạch đầu dòng, markdown), tên riêng và số liệu. Chỉ trả về bản dịch, không giải thích.` },
        { role: 'user', content: `Dịch văn bản sau sang ${str(input.targetLang) || 'Tiếng Việt'}:\n\n${str(input.text)}` },
      ];
    case 'summarize':
      return [
        { role: 'system', content: `Bạn là trợ lý tóm tắt tài liệu. Trả lời bằng ngôn ngữ của văn bản gốc (mặc định tiếng Việt). ${limit}` },
        { role: 'user', content: `Tóm tắt văn bản sau thành ${SUMMARY[str(input.style)] ?? SUMMARY.bullets}:\n\n${str(input.text)}` },
      ];
    default:
      return [
        { role: 'system', content: `${str(input.system) || 'Bạn là trợ lý AI hữu ích.'} Trả lời bằng tiếng Việt trừ khi người dùng yêu cầu ngôn ngữ khác. ${limit}` },
        { role: 'user', content: str(input.prompt) },
      ];
  }
}

/** Cắt kết quả vượt quá xa độ dài đã thu tiền (AI không tuân giới hạn) tại chỗ xuống dòng / hết câu gần nhất */
function capText(text: string, max: number) {
  const hard = Math.ceil(max * 1.3);
  if (text.length <= hard) return text;
  const cut = text.slice(0, hard);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(at > hard * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()}\n\n…`;
}

/** Cạnh dài tối đa của ảnh tham chiếu gửi nguồn */
const REF_MAX_SIDE = 2048;
const ORDINALS_EN = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH'];

/**
 * Ảnh tham chiếu khách tải lên -> data URL (dùng cho video 1 ảnh).
 * Thu về cạnh dài tối đa 2048px, xoay theo EXIF.
 */
async function toDataUrls(ctx: AiCallContext, urls: string[]) {
  const files = await Promise.all(urls.map((u) => loadInputFile(ctx.readUpload, u)));
  return Promise.all(
    files.map(async (f) => {
      try {
        const png = f.mimeType === 'image/png';
        const img = sharp(f.data).rotate().resize({ width: REF_MAX_SIDE, height: REF_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
        const data = await (png ? img.png() : img.jpeg({ quality: 90 })).toBuffer();
        return `data:${png ? 'image/png' : 'image/jpeg'};base64,${data.toString('base64')}`;
      } catch {
        return `data:${f.mimeType};base64,${f.data.toString('base64')}`;
      }
    }),
  );
}

/**
 * Chuẩn bị các file ảnh tham chiếu cho `POST /images/edits` (multipart/form-data):
 * - Giữ nguyên thứ tự mảng khách gửi (`1 -> N`), xoay theo EXIF, thu về <= 2048px.
 * - Khi gửi từ 2 ảnh trở lên: phía nguồn tải song song các ảnh qua nhiều proxy IPv6 lên Google Labs / Codex nên
 *   thứ tự media hoàn tất trên nguồn bị ngẫu nhiên mỗi lượt gọi. Do đó gắn một dải tiêu đề nhỏ bên ngoài cạnh trên
 *   của từng ảnh (`IMAGE 1 / ANH 1`, `IMAGE 2 / ANH 2`..., không che bất kỳ pixel nào của ảnh gốc) kèm chỉ dẫn
 *   hệ thống để AI luôn đọc đúng vai trò từng ảnh 1, 2, 3 tuyệt đối 100% và không vẽ dải tiêu đề vào ảnh kết quả.
 */
async function prepareEditRefFiles(ctx: AiCallContext, urls: string[]) {
  const loaded = await Promise.all(urls.map((u) => loadInputFile(ctx.readUpload, u)));
  const multi = loaded.length >= 2;
  return Promise.all(
    loaded.map(async (f, idx) => {
      try {
        if (!multi) {
          const meta = await sharp(f.data).metadata();
          const stats = meta.hasAlpha ? await sharp(f.data).stats() : null;
          const keepPng = f.mimeType === 'image/png' && stats !== null && !stats.isOpaque;
          const img = sharp(f.data).rotate().resize({ width: REF_MAX_SIDE, height: REF_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
          const data = await (keepPng ? img.png() : img.jpeg({ quality: 92 })).toBuffer();
          return { data, mimeType: keepPng ? 'image/png' : 'image/jpeg', filename: `image_1.${keepPng ? 'png' : 'jpg'}` };
        }
        const clean = await sharp(f.data)
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .resize({ width: REF_MAX_SIDE, height: REF_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
        const meta = await sharp(clean).metadata();
        const w = meta.width ?? 1024;
        const h = meta.height ?? 1024;
        const barH = Math.max(40, Math.round(Math.min(w, h) * 0.052));
        const fontSize = Math.round(barH * 0.62);
        const svg = `<svg width="${w}" height="${barH}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${barH}" fill="#111827"/><text x="${Math.round(w / 2)}" y="${Math.round(barH * 0.74)}" font-family="Arial, DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle">IMAGE ${idx + 1} / ANH ${idx + 1}</text></svg>`;
        const data = await sharp({ create: { width: w, height: h + barH, channels: 3, background: { r: 17, g: 24, b: 39 } } })
          .composite([
            { input: Buffer.from(svg), left: 0, top: 0 },
            { input: clean, left: 0, top: barH },
          ])
          .jpeg({ quality: 92 })
          .toBuffer();
        return { data, mimeType: 'image/jpeg', filename: `image_${idx + 1}.jpg` };
      } catch {
        const ext = f.mimeType === 'image/png' ? 'png' : f.mimeType === 'image/webp' ? 'webp' : 'jpg';
        return { data: f.data, mimeType: f.mimeType || 'image/jpeg', filename: `image_${idx + 1}.${ext}` };
      }
    }),
  );
}

/**
 * Chuẩn bị `image_url` cho POST /videos (muse-video chỉ đọc 1 trường `image_url`):
 * - 1 ảnh: giữ nguyên ảnh gốc thu về <= 2048px như cũ.
 * - 2–4 ảnh: ghép bảng tham chiếu sắc nét theo đúng tỉ lệ khung hình đích (contain, không cắt mất chi tiết).
 */
async function videoRefDataUrl(ctx: AiCallContext, urls: string[], size: string): Promise<string> {
  if (urls.length <= 1) return (await toDataUrls(ctx, urls))[0];
  try {
    const files = await Promise.all(urls.slice(0, 4).map((u) => loadInputFile(ctx.readUpload, u)));
    const [canvasW, canvasH] = size === '9:16' ? [1080, 1920] : size === '1:1' ? [1440, 1440] : [1920, 1080];
    const n = files.length;
    const cols = n === 2 ? 2 : n === 3 && size === '16:9' ? 3 : 2;
    const rows = Math.ceil(n / cols);
    const gap = 12;
    const cellW = Math.floor((canvasW - gap * (cols + 1)) / cols);
    const cellH = Math.floor((canvasH - gap * (rows + 1)) / rows);
    const bg = { r: 18, g: 20, b: 24, alpha: 1 };

    const layers = await Promise.all(
      files.map(async (f, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        // Nếu hàng cuối chỉ có 1 ảnh trên lưới 2 cột (n = 3, dọc/vuông), căn giữa hàng dưới
        const singleLastRow = n === 3 && cols === 2 && row === 1;
        const left = singleLastRow ? Math.floor((canvasW - cellW) / 2) : gap + col * (cellW + gap);
        const top = gap + row * (cellH + gap);
        const input = await sharp(f.data)
          .rotate()
          .resize({ width: cellW, height: cellH, fit: 'contain', background: bg })
          .png()
          .toBuffer();
        return { input, left, top };
      }),
    );

    const out = await sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 18, g: 20, b: 24 } },
    })
      .composite(layers)
      .jpeg({ quality: 92 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString('base64')}`;
  } catch {
    return (await toDataUrls(ctx, [urls[0]]))[0];
  }
}

/** Phản hồi ảnh `{ data: [{ url | b64_json }] }` -> file kết quả (luôn đọc data.length, không giả định bằng n) */
function imageFiles(res: any) {
  const list: any[] = Array.isArray(res?.data) ? res.data : [];
  return list
    .map((x) => {
      if (typeof x?.url === 'string' && x.url) return { url: x.url, type: 'image' as const };
      if (typeof x?.b64_json === 'string' && x.b64_json) return { url: '', type: 'image' as const, data: Buffer.from(x.b64_json, 'base64'), mimeType: 'image/png' };
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/** Bỏ nội dung base64 dài khỏi phản hồi trước khi lưu vào providerData */
const slim = (res: any) => (Array.isArray(res?.data) ? { ...res, data: res.data.map((x: any) => ({ url: x?.url, revised_prompt: x?.revised_prompt })) } : res);

/** Video: thời gian chờ ngắn (90s) phòng trường hợp nguồn báo failed tạm rồi tự tạo lại lượt khác */
const FAIL_GRACE_MS = 90_000;
/** Mã tác vụ video -> thời điểm lần đầu thấy failed (dự phòng khi nguồn không trả updated_at) */
const failedSince = new Map<string, number>();
/** Đếm số lần liên tiếp nguồn trả 404 (chờ đồng bộ cụm worker hoặc worker nguồn mất phiên) */
const notFoundCount = new Map<string, number>();

export const ahiepProvider: AiProvider = {
  key: 'ahiep',
  name: 'AHiep API (api.ahiep.com)',
  website: 'https://api.ahiep.com',
  tools: TOOLS,
  // giá vốn nhập thẳng bằng đồng (đ / 1 triệu token, đ / ảnh, đ / video) nên tỉ giá = 1
  costUnit: 'đ giá vốn',
  rate: 1,

  /** Giá vốn (đ) của một lần chạy theo bảng giá vốn admin nhập ở tab Khoá API */
  async cost(tool, input, ctx) {
    const c = ctx.config;
    if (tool.output === 'text') {
      const model = str(input.model) || CHAT_MODELS[0][0];
      // số token ước tính = ký tự tính tiền ÷ 2,5; giá vốn = token × (đ / 1 triệu token)
      const tokens = billedChars(tool, input) / CHARS_PER_TOKEN;
      return (tokens / 1_000_000) * costOf(c.tokenCosts, model, AHIEP_DEFAULT_COSTS.tokenCosts[model] ?? 16000);
    }
    if (tool.key === 'image' || tool.key === 'edit') {
      const model = str(input.model) || IMAGE_MODELS[0][0];
      const unitCost = costOf(c.imageCosts, model, AHIEP_DEFAULT_COSTS.imageCosts[model] ?? 1000);
      return (tool.key === 'image' ? Math.max(1, Number(input.n) || 1) : 1) * unitCost;
    }
    // video tính giá cố định mỗi video, không nhân theo số giây
    if (tool.key === 'video') return costOf({ v: c.videoCostPerVideo }, 'v', VIDEO_COST);
    return null;
  },

  async submit(tool, input, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
    const model = str(input.model);

    // video: bất đồng bộ phía nguồn -> lưu id rồi để cron hỏi trạng thái
    if (tool.key === 'video') {
      // trả lời câu hỏi Muse (replyTo = id video bị từ chối, server tự gắn): Muse làm tiếp cùng cuộc trò chuyện, trả task mới
      const replyTo = str(input.replyTo);
      const rawImgs = input.image ?? input.images;
      const urls = (Array.isArray(rawImgs) ? rawImgs : [rawImgs]).map(str).filter(Boolean).slice(0, 4);
      const size = str(input.size) || '16:9';
      const rawPrompt = str(input.prompt);
      const finalPrompt =
        urls.length > 1
          ? `${rawPrompt}\n\n[Ảnh đính kèm ghép ${urls.length} ảnh tham chiếu theo thứ tự Ảnh 1 đến Ảnh ${urls.length} (từ trái sang phải, trên xuống dưới). Hãy dùng các nhân vật/trang phục/sản phẩm/bối cảnh này làm tham chiếu để tạo một cảnh video liền mạch toàn khung hình, không chia khung hay hiện đường viền ghép ảnh.]`
          : rawPrompt;
      const res = replyTo
        ? await call(ctx, `/videos/${encodeURIComponent(replyTo)}/reply`, { message: rawPrompt }, 120_000)
        : await call(
            ctx,
            '/videos',
            {
              model: 'muse-video',
              prompt: finalPrompt,
              duration: Number(input.duration) || 5,
              size,
              ...(urls.length ? { image_url: await videoRefDataUrl(ctx, urls, size) } : {}),
            },
            120_000,
          );
      const id = str(res?.id ?? res?.data?.id);
      if (!id) throw new AiProviderError('Nhà cung cấp AI không trả mã tác vụ video', res);
      return { status: 'processing', providerTaskId: `video:${id}`, raw: res };
    }

    // chat / ảnh: request đồng bộ (20 giây – vài phút) -> chạy nền, trả `processing` ngay
    const job = `ahiep-${randomUUID()}`;
    if (tool.output === 'text') {
      const max = maxOutputChars(tool, input);
      const chatModel = model || CHAT_MODELS[0][0];
      startBackground(
        job,
        async () => {
          // reasoning_effort chỉ có tác dụng với model codex-* (mục 4 tài liệu), model khác không gửi
          const res = await callRetry(ctx, '/chat/completions', { model: chatModel, messages: messagesOf(tool, input), ...(chatModel.startsWith('codex-') ? { reasoning_effort: 'low' } : {}) });
          const text = str(res?.choices?.[0]?.message?.content);
          if (!text) return { status: 'failed', providerTaskId: job, error: 'AI không trả lời được yêu cầu này, tiền đã được hoàn lại', raw: res };
          // lưu kèm số ký tự / token thật để admin đối chiếu giá vốn
          return { status: 'succeeded', providerTaskId: job, text: capText(text, max), raw: { model: res?.model, usage: res?.usage, outputChars: text.length, maxChars: max } } satisfies AiProviderResult;
        },
        tool.key === 'translate' || tool.key === 'summarize' ? 40_000 : 25_000,
      );
      return { status: 'processing', providerTaskId: job };
    }

    const rawSize = str(input.size);
    const size = rawSize === '3840x2160' ? '2752x1536' : rawSize === '2160x3840' ? '1536x2752' : rawSize;
    const base = { model: model || IMAGE_MODELS[0][0], prompt: str(input.prompt), response_format: 'url', ...(size ? { size } : {}) };
    startBackground(
      job,
      async () => {
        let res: any;
        if (tool.key === 'edit') {
          const urls = (Array.isArray(input.images) ? input.images : [input.images]).map(str).filter(Boolean);
          if (!urls.length) throw new AiProviderError('Vui lòng tải lên ảnh tham chiếu');
          const refFiles = await prepareEditRefFiles(ctx, urls);
          const rawPrompt = str(input.prompt);
          const editPrompt =
            refFiles.length >= 2
              ? `[Reference image identification: Because reference images may arrive in any upload order, each reference image carries a dark top header bar showing its exact index (${refFiles
                  .map((_, idx) => `"IMAGE ${idx + 1} / ANH ${idx + 1}" = Image ${idx + 1} (${ORDINALS_EN[idx] ?? `#${idx + 1}`} image / Ảnh ${idx + 1} / @Image ${idx + 1})`)
                  .join('; ')}). Always read that top header bar to identify which image is FIRST/1, SECOND/2, THIRD/3, etc., and never swap their roles. Do NOT include any top header bar or label text in the generated output image.]\n\n${rawPrompt}`
              : rawPrompt;
          res = await callRetry(ctx, '/images/edits', () => {
            const form = new FormData();
            form.append('model', base.model);
            form.append('prompt', editPrompt);
            form.append('n', '1');
            form.append('response_format', 'url');
            if (size) form.append('size', size);
            for (const f of refFiles) {
              form.append('image', new Blob([new Uint8Array(f.data)], { type: f.mimeType }), f.filename);
            }
            return form;
          });
        } else {
          // khách trả tiền theo số ảnh: nguồn có thể trả ít ảnh hơn n -> gọi bù phần còn thiếu (tối đa 2 lượt) để khách nhận đủ
          const want = Math.min(4, Math.max(1, Number(input.n) || 1));
          const got: ReturnType<typeof imageFiles> = [];
          for (let round = 0; got.length < want && round < 3; round++) {
            try {
              res = await callRetry(ctx, '/images/generations', { ...base, n: want - got.length });
            } catch (err) {
              // lượt đầu lỗi thì báo lỗi (hoàn tiền); lượt gọi bù lỗi thì giữ số ảnh đã có
              if (!got.length) throw err;
              break;
            }
            got.push(...imageFiles(res));
          }
          if (got.length) return { status: 'succeeded', providerTaskId: job, files: got.slice(0, want), raw: { ...slim(res), images: got.length, requested: want } } satisfies AiProviderResult;
        }
        const files = imageFiles(res);
        if (!files.length) return { status: 'failed', providerTaskId: job, error: 'AI không tạo được ảnh cho mô tả này, tiền đã được hoàn lại', raw: slim(res) };
        return { status: 'succeeded', providerTaskId: job, files, raw: slim(res) } satisfies AiProviderResult;
      },
      45_000,
    );
    return { status: 'processing', providerTaskId: job };
  },

  async poll(_tool, id, ctx) {
    if (!id.startsWith('video:')) return backgroundState(id);
    let res: any;
    try {
      res = await call(ctx, `/videos/${encodeURIComponent(id.slice(6))}`);
      notFoundCount.delete(id);
    } catch (err) {
      const e = err as AiProviderError;
      const st = Number((e?.raw as { status?: unknown } | undefined)?.status ?? 0);
      if (e instanceof AiProviderError && (st === 404 || /không tìm thấy tác vụ|not found/i.test(e.message))) {
        const cnt = (notFoundCount.get(id) ?? 0) + 1;
        notFoundCount.set(id, cnt);
        if (notFoundCount.size > 2000) notFoundCount.delete(notFoundCount.keys().next().value!);
        // Cho phép tối đa 3 lần hỏi lại (~30s) phòng trường hợp cụm worker nguồn đồng bộ trễ ngay sau khi tạo
        if (cnt <= 3) return { status: 'processing', providerTaskId: id, raw: e.raw };
        notFoundCount.delete(id);
        failedSince.delete(id);
        return {
          status: 'failed',
          providerTaskId: id,
          error: 'Máy chủ xử lý video bị gián đoạn nên tác vụ đã được huỷ, tiền đã được hoàn lại',
          raw: e.raw,
        };
      }
      throw err;
    }
    const status = str(res?.status).toLowerCase();
    if (status === 'completed' || status === 'succeeded') {
      failedSince.delete(id);
      const url = str(res?.url ?? res?.video_url ?? res?.data?.url ?? res?.output?.url);
      if (!url) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp AI không trả file video, tiền đã được hoàn lại', raw: res };
      return { status: 'succeeded', providerTaskId: id, files: [{ url, type: 'video' }], raw: res };
    }
    // Muse trả lời bằng chữ (hỏi lại / đưa lựa chọn) thay vì làm video: chốt lỗi ngay để khách đọc câu hỏi và trả lời (không chờ nguồn tự làm lại)
    if (status === 'failed' && res?.can_reply === true && str(res?.muse_reply)) {
      failedSince.delete(id);
      return { status: 'failed', providerTaskId: id, error: 'Muse chưa làm video mà hỏi lại bạn. Đọc câu hỏi bên dưới và trả lời để Muse làm tiếp. Tiền lượt này đã được hoàn lại', raw: res };
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const rawMsg = pickMessage(res?.error && typeof res.error === 'object' ? res.error : res) ?? '';
      // Nguồn đã chốt dừng thử lại (vd "Tác vụ đã hết thời gian chờ; ngừng thử lại", "等待超时", elapsed >= 580s) hoặc từ chối nội dung -> chốt lỗi & hoàn tiền ngay lập tức
      const isTerminal =
        status === 'cancelled' ||
        Number(res?.elapsed) >= 580 ||
        /ngừng thử lại|hết thời gian chờ|timed?\s*out|vi phạm|từ chối|không hợp lệ|policy|moderation|blocked|等待超时|都在忙|停止重试|超时|违规|敏感/i.test(rawMsg);
      if (!isTerminal) {
        const now = Date.now();
        for (const [k, t] of failedSince) if (now - t > 2 * 3_600_000) failedSince.delete(k);
        // Ưu tiên mốc updated_at của nguồn để khi API khởi động lại không bị đếm lại từ đầu làm treo đơn hàng chục phút
        const upstreamUpdatedMs = Number(res?.updated_at) > 1_000_000_000 ? Number(res.updated_at) * 1000 : 0;
        const since = upstreamUpdatedMs > 0 ? Math.min(now, upstreamUpdatedMs) : (failedSince.get(id) ?? now);
        failedSince.set(id, since);
        if (now - since < FAIL_GRACE_MS) return { status: 'processing', providerTaskId: id, raw: res };
      }
      failedSince.delete(id);
      if (/所有\s*Muse\s*账号都在忙|等待超时|请稍后重试|都在忙|超时/i.test(rawMsg)) {
        return {
          status: 'failed',
          providerTaskId: id,
          error: 'Hệ thống tạo video đang quá tải tạm thời, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.',
          raw: res,
        };
      }
      if (/[\u4e00-\u9fff]/.test(rawMsg)) {
        const viErr = /敏感|违规|审核|安全|禁止|色情|政治|不当|拦截/.test(rawMsg)
          ? 'Nội dung mô tả hoặc ảnh tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.'
          : 'Hệ thống tạo video gặp gián đoạn tạm thời, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
        return { status: 'failed', providerTaskId: id, error: viErr, raw: res };
      }
      return { status: 'failed', providerTaskId: id, error: rawMsg ? `${rawMsg}. Tiền đã được hoàn lại` : 'Tạo video thất bại, tiền đã được hoàn lại', raw: res };
    }
    return { status: 'processing', providerTaskId: id, progress: Number(res?.progress) || undefined, raw: res };
  },

  /** Số dư (VNĐ) của key — GET /key/quota, không tốn quota */
  async balance(ctx) {
    const q = await call(ctx, '/key/quota').catch(() => null);
    const b = Number(q?.balance);
    return Number.isFinite(b) ? { balance: b, unit: 'đ' } : null;
  },

  /** Danh mục model key được dùng — GET /models (bot admin báo khi nguồn thêm / gỡ model) */
  async catalog(ctx) {
    const res = await call(ctx, '/models');
    const list: any[] = Array.isArray(res?.data) ? res.data : [];
    return list.map((m) => ({ id: String(m?.id ?? ''), label: String(m?.id ?? '') })).filter((m) => m.id);
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const res = await call(ctx, '/models').catch(() => null);
    const list: any[] = Array.isArray(res?.data) ? res.data : [];
    const liveIds = new Set(list.map((m) => String(m?.id ?? '').trim()).filter(Boolean));
    if (liveIds.size < 20) return { addedTools: [], removedKeys: [] };

    const removedKeys: string[] = [];
    const updatedSplits: string[] = [];
    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (t.key === 'video') {
        if (!liveIds.has('muse-video')) {
          removedKeys.push('ahiep.video');
          TOOLS.splice(i, 1);
        }
        continue;
      }
      const mf = t.fields.find((f) => f.name === 'model' && Array.isArray(f.options) && f.options.length > 0);
      if (!mf?.options) continue;
      const kept = mf.options.filter((o) => liveIds.has(String(o.value)));
      const dropped = mf.options.filter((o) => !liveIds.has(String(o.value)));
      if (!kept.length) {
        removedKeys.push(`ahiep.${t.key}`);
        for (const d of dropped) removedKeys.push(`ahiep.${t.key}~${d.value}`);
        TOOLS.splice(i, 1);
      } else if (dropped.length > 0) {
        mf.options = kept;
        if (!kept.some((o) => o.value === mf.default)) mf.default = kept[0].value;
        for (const d of dropped) removedKeys.push(`ahiep.${t.key}~${d.value}`);
        updatedSplits.push(`ahiep.${t.key}`);
      }
    }
    return { addedTools: [], updatedSplits, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const res = await call(ctx, '/models').catch(() => null);
    const list: any[] = Array.isArray(res?.data) ? res.data : [];
    if (!list.length) return null;

    const activeIds = new Set<string>();
    const maintIds = new Set<string>();
    for (const m of list) {
      const id = String(m?.id ?? '').trim();
      if (!id) continue;
      const st = String(m?.status ?? m?.state ?? '').toLowerCase();
      if (m?.maintenance === true || m?.enabled === false || m?.active === false || /maint|disable|offline|down/.test(st)) {
        maintIds.add(id);
      } else {
        activeIds.add(id);
      }
    }
    if (activeIds.size + maintIds.size < 10) return null;

    const down = new Set<string>();
    for (const t of TOOLS) {
      if (t.key === 'video') {
        if (!activeIds.has('muse-video') || maintIds.has('muse-video')) down.add('video');
        continue;
      }
      const mf = t.fields.find((f) => f.name === 'model' && Array.isArray(f.options) && f.options.length > 0);
      if (!mf?.options?.length) continue;
      let aliveCount = 0;
      for (const opt of mf.options) {
        const val = String(opt.value);
        if (!activeIds.has(val) || maintIds.has(val)) {
          down.add(`${t.key}~${val}`);
        } else {
          aliveCount++;
        }
      }
      if (aliveCount === 0) down.add(t.key);
    }
    return down;
  },
};
