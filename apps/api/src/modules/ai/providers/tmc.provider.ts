import { AiProviderError, type AiCallContext, type AiFieldDef, type AiFieldOption, type AiInput, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { randomUUID } from 'node:crypto';
import { backgroundState, loadInputFile, startBackground } from './background.js';
import { guessType, joinUrl, pickMessage, providerFetch, str } from './http.js';
import { TMC_KLING1K, TMC_MODELS, type TmcModel, type TmcOption } from './tmc.data.js';
import { TMC_VOICES_ELEVEN, TMC_VOICES_MINIMAX } from './tmc.voices.js';

/**
 * TMC Video AI — https://tmcvideoai.net (API v1, header Authorization: Bearer tmc_live_...).
 * Endpoint: GET /me (số dư xu), GET /models (model + giá xu), POST /upload, POST /jobs, GET /jobs/{jobId}.
 * Tiện ích đồng bộ (không tính xu): POST /tools/tiktok-download { urls } (50 lượt/ngày, GET /tools/tiktok-quota xem lượt còn),
 * POST /tools/remove-ai-label (body binary + header x-file-name, x-device-profile -> trả thẳng file đã gỡ nhãn AI).
 * Đơn vị tính phía nhà cung cấp là "xu" -> công cụ dùng pricing mode `cost` (credits = xu × tỉ giá quy đổi của nhà cung cấp, mặc định 2000).
 *
 * Lưu ý: TMC chưa có tài liệu API công khai; định dạng body POST /jobs lấy theo Studio web của họ
 * (object payload { mode, modelId, prompt, durationSec, resolution, ratio, inputImageUrl, ... }).
 */

// ---------------- dựng form từ danh sách model ----------------

const modelsOf = (...modes: string[]) => TMC_MODELS.filter((m) => modes.includes(m.mode));

/** Khoá một lựa chọn giá: "<giây>|<độ phân giải>" (thiếu thì để trống) */
const optKey = (o: { durationSec?: number | null; resolution?: string | null }) => `${o.durationSec ?? ''}|${o.resolution ?? ''}`;
const optLabel = (o: TmcOption) => [o.durationSec ? `${o.durationSec} giây` : '', o.resolution ?? ''].filter(Boolean).join(' · ') || 'Mặc định';

const modelField = (models: TmcModel[], label = 'Model AI'): AiFieldDef => ({
  name: 'model',
  label,
  type: 'select',
  required: true,
  default: models[0]?.modelId,
  options: models.map((m) => ({ value: m.modelId, label: m.label })),
});

/** Ô "Thời lượng / chất lượng" phụ thuộc model (chỉ thêm khi có model nhiều lựa chọn) */
function optionField(models: TmcModel[], label = 'Thời lượng / chất lượng'): AiFieldDef[] {
  if (!models.some((m) => m.options.length > 1 || m.options.some((o) => o.durationSec || o.resolution))) return [];
  const map: Record<string, AiFieldOption[]> = {};
  for (const m of models) map[m.modelId] = m.options.map((o) => ({ value: optKey(o), label: optLabel(o) }));
  return [{ name: 'option', label, type: 'select', required: true, optionsBy: { field: 'model', map } }];
}

/** Ô tỉ lệ khung hình (chỉ model có ratios) */
function ratioField(models: TmcModel[]): AiFieldDef[] {
  const withRatio = models.filter((m) => m.ratios.length);
  if (!withRatio.length) return [];
  const map: Record<string, AiFieldOption[]> = {};
  for (const m of withRatio) map[m.modelId] = m.ratios.map((r) => ({ value: r, label: r === 'adaptive' ? 'Tự động' : r }));
  return [{ name: 'ratio', label: 'Tỉ lệ khung hình', type: 'select', required: true, showIf: { field: 'model', in: withRatio.map((m) => m.modelId) }, optionsBy: { field: 'model', map } }];
}

const prompt = (required: boolean, label = 'Mô tả (prompt)', placeholder = 'Mô tả chi tiết nội dung bạn muốn tạo...'): AiFieldDef => ({ name: 'prompt', label, type: 'textarea', required, placeholder });
const image = (name = 'image', label = 'Ảnh đầu vào', required = true): AiFieldDef => ({ name, label, type: 'image', required, accept: 'image/png,image/jpeg,image/webp' });
const video = (name = 'video', label = 'Video mẫu', help?: string): AiFieldDef => ({ name, label, type: 'video', required: true, accept: 'video/mp4,video/quicktime', help });

/** Thể loại nhạc gợi ý của công cụ Tạo nhạc (giống Studio TMC): bấm chip thì điền mô tả thể loại vào ô prompt */
const MUSIC_GENRES: NonNullable<AiFieldDef['suggestions']> = {
  label: 'Thể loại nhạc gợi ý',
  options: [
    { label: 'Ballad', value: 'Nhạc ballad nhẹ nhàng, sâu lắng, giai điệu chậm, piano và guitar, giọng hát giàu cảm xúc' },
    { label: 'Pop', value: 'Nhạc pop sôi động, giai điệu bắt tai, tiết tấu vui tươi, phần điệp khúc dễ nhớ' },
    { label: 'Acoustic', value: 'Nhạc acoustic mộc mạc, guitar thùng, không khí ấm áp, giọng hát nhẹ nhàng' },
    { label: 'Rap / Hip-hop', value: 'Nhạc rap / hip-hop, beat mạnh, nhịp trống rõ, flow nhanh, phong cách đường phố' },
    { label: 'EDM', value: 'Nhạc EDM sôi động, nhịp điện tử mạnh, đoạn drop bùng nổ, phù hợp sàn nhảy' },
    { label: 'Lo-fi', value: 'Nhạc lo-fi chill, tiết tấu chậm, âm thanh ấm, thư giãn, phù hợp học bài và làm việc' },
    { label: 'Bolero', value: 'Nhạc bolero trữ tình Việt Nam, tiết tấu chậm, guitar phím lõm, giọng hát mùi mẫn, da diết' },
  ],
};

/** Định nghĩa công cụ: key cục bộ + mode TMC */
interface TmcTool extends AiToolDef {
  mode: string;
  /** Quy trình dựng sẵn: dựng payload như công cụ Studio này (vd 'image-upscale', 'motion-control') */
  as?: string;
}

const i2v = modelsOf('image-to-video');
const grok = i2v.filter((m) => m.modelId === 'grok-video-1.5');
const framesModels = i2v.filter((m) => m.modelId === 'kling-2.6' || m.modelId === 'kling-3.0' || m.modelId === 'kling-4.0');
// văn bản -> video: các model text-to-video + MiniMax H3 (từ mô tả)
// lọc trùng theo modelId (vae-h3t có cả ở text-to-video lẫn h3-studio) -> giữ bản đầu tiên, tránh option trùng ở form
const t2v = [...modelsOf('text-to-video'), ...modelsOf('h3-studio').filter((m) => m.modelId === 'vae-h3t')].filter(
  (m, i, arr) => arr.findIndex((x) => x.modelId === m.modelId) === i,
);
// Motion Control làm theo Studio TMC: giữ đúng thứ tự Studio (vae-m6, kling-bot-4, vae-m13, vae-m12),
// model có 1080p / 2K / 4K thì bỏ mức 720p, xếp lựa chọn theo 576p -> 720p -> 1080p -> 2K -> 4K rồi theo thời lượng
const MC_RES_ORDER: Record<string, number> = { '576p': 0, '720p': 1, '1080p': 2, '2K': 3, '4K': 4 };
const MOTION_LABELS: Record<string, string> = {
  'vae-m6': 'VAE motion control (Giá rẻ chất lượng 720p)',
  'kling-bot-4': 'VAE Motion Control 1080p (Chất lượng cao - Tạo lâu)',
  'vae-m13': 'VAE motion control 8 (Khuyên dùng - Tạo video nét)',
  'vae-m12': 'VAE motion control 7',
};
const motion = modelsOf('motion-control').map((m) => ({
  ...m,
  label: MOTION_LABELS[m.modelId] ?? m.label,
  options: [...m.options].sort(
    (x, y) => (MC_RES_ORDER[x.resolution ?? ''] ?? 9) - (MC_RES_ORDER[y.resolution ?? ''] ?? 9) || (x.durationSec ?? 0) - (y.durationSec ?? 0),
  ),
}));
const t2i = modelsOf('text-to-image');
const tts = modelsOf('text-to-speech');
const music = modelsOf('text-to-music');
const talk = modelsOf('talking-photo');
const enhance = modelsOf('video-enhance');
const body = modelsOf('body-edit');
const outfit = modelsOf('video-outfit');
// MiniMax H3 Studio: 3 chế độ (từ mô tả / 1 ảnh / nhiều ảnh), video có tiếng tới 30 giây
const h3 = modelsOf('h3-studio');
const h3WithImage = h3.filter((m) => m.modelId !== 'vae-h3t').map((m) => m.modelId);
// làm nét ảnh: Studio TMC chỉ dùng các model ảnh Pro (Nano Pro, Seedream 5); thiếu thì dùng hết model ảnh
const proImage = t2i.filter((m) => m.modelId === 'img-nano-pro' || m.modelId === 'img-seedream5');
// giữ đầy đủ mức chất lượng 1K -> 2K -> 4K theo đúng thứ tự của Studio TMC
const upscale = (proImage.length ? proImage : t2i).map((m) => ({ ...m, options: [...m.options] }));

/** Ô "Model AI" cố định của quy trình dựng sẵn (ẩn trên form, chỉ đúng một model) */
const fixedModel = (m: TmcModel | undefined): AiFieldDef => ({ ...modelField(m ? [m] : []), default: m?.modelId, hidden: true });
/** Model chỉ giữ các lựa chọn giá có độ phân giải `res` */
const onlyRes = (m: TmcModel | undefined, res: string): TmcModel | undefined => (m ? { ...m, options: m.options.filter((o) => o.resolution === res) } : undefined);

// Quy trình AI dựng sẵn (thẻ "Quy trình AI" ở trang tổng quan): chốt sẵn model + chất lượng, khách chỉ tải ảnh / video lên
const wfUpscale = onlyRes(upscale.find((m) => m.modelId === 'img-nano-pro') ?? upscale[0], '4K');
const wfMotion1080 = onlyRes(motion.find((m) => m.modelId === 'vae-m13'), '1080p');
const wfMotionVideo = motion.find((m) => m.modelId === 'vae-m6');

// Kling đồng giá 1 xu (mode kling-1k) — lọc đúng mode kling-1k vì kling-bot-2 / kling-bot-4 còn nằm ở image-to-video / motion-control
const kling1k = (ids: string[]) => ids.map((id) => TMC_MODELS.find((m) => m.mode === 'kling-1k' && m.modelId === id)).filter((m): m is TmcModel => !!m);
const k1kMotion = kling1k(TMC_KLING1K.motion);
const k1kI2v = kling1k(TMC_KLING1K.i2v);
const k1kFrames = kling1k(TMC_KLING1K.frames);
const K1K_NOTE = 'Đồng giá rẻ, xử lý theo hàng đợi nên đông đơn sẽ chờ lâu hơn bản thường một chút.';

/** Bộ phận trang phục cần thay (Thay đồ ảnh) — value gửi kèm `outfitPart`, label ghép vào prompt */
const OUTFIT_PARTS: AiFieldOption[] = [
  { value: 'full', label: 'Nguyên bộ (cả set / đầm)' },
  { value: 'top', label: 'Áo' },
  { value: 'bottom', label: 'Quần / váy' },
  { value: 'outer', label: 'Áo khoác' },
  { value: 'shoes', label: 'Giày dép' },
  { value: 'accessory', label: 'Phụ kiện (túi, mũ, kính...)' },
];
/** Bối cảnh sau khi thay đồ */
const OUTFIT_BGS: AiFieldOption[] = [
  { value: 'Giữ nguyên bối cảnh gốc', label: 'Giữ nguyên bối cảnh gốc' },
  { value: 'Đổi sang phông nền studio trắng tinh tế', label: 'Studio nền trắng' },
  { value: 'Đổi bối cảnh sang đường phố thời trang ngoài trời', label: 'Đường phố thời trang' },
  { value: 'Đổi bối cảnh sang quán cà phê sang trọng ánh sáng ấm', label: 'Quán cà phê' },
];
/** Kiểu ảnh sản phẩm: value là câu mở đầu prompt (giống Studio TMC) */
const PRODUCT_STYLES: AiFieldOption[] = [
  { value: 'Ảnh chụp sản phẩm thương mại chuyên nghiệp, đặt sản phẩm', label: 'Chỉ sản phẩm' },
  { value: 'Người mẫu nữ trẻ đẹp Việt Nam cầm và giới thiệu sản phẩm', label: 'Người mẫu nữ cầm sản phẩm' },
  { value: 'Người mẫu nam lịch lãm cầm và giới thiệu sản phẩm', label: 'Người mẫu nam cầm sản phẩm' },
  { value: 'Cận cảnh bàn tay thon đẹp đang cầm sản phẩm', label: 'Cận cảnh tay cầm' },
];
const PRODUCT_SCENES: AiFieldOption[] = [
  { value: 'trên bục đá cẩm thạch trắng trong studio cao cấp, ánh sáng thương mại sắc nét', label: 'Bục đá cẩm thạch studio' },
  { value: 'trên mặt bàn gỗ tự nhiên cạnh cây xanh, nắng sớm dịu nhẹ', label: 'Bàn gỗ & cây xanh' },
  { value: 'giữa không gian phòng khách hiện đại sang trọng', label: 'Phòng khách hiện đại' },
  { value: 'trên nền màu pastel tối giản với bóng đổ mềm', label: 'Nền pastel tối giản' },
  { value: 'ngoài bãi biển đầy nắng, nước trong xanh', label: 'Bãi biển mùa hè' },
];

/** Giọng đọc theo model: MiniMax dùng giọng MiniMax; ElevenLabs và "Giọng Việt tự nhiên" dùng giọng ElevenLabs */
const voiceMap = Object.fromEntries(tts.map((m) => [m.modelId, m.modelId.startsWith('vae-voice-mm') ? TMC_VOICES_MINIMAX : TMC_VOICES_ELEVEN]));

/** Tên + ghi chú model giọng đọc như Studio TMC (web hiện dạng thẻ: tên đậm + ghi chú nhỏ) */
const TTS_NOTES: Record<string, { label?: string; hint: string }> = {
  'vae-voice-vn': { hint: 'Tối ưu đọc tiếng Việt tự nhiên, giá rẻ — khuyên dùng' },
  'vae-voice-el3': { label: 'ElevenLabs v3 (Giọng AI cao cấp)', hint: 'Biểu cảm, truyền cảm nhất' },
  'vae-voice-elm2': { label: 'ElevenLabs Multilingual v2', hint: 'Đa ngôn ngữ, đọc ổn định' },
  'vae-voice-elt25': { label: 'ElevenLabs Turbo v2.5 (Siêu nhanh)', hint: 'Trả kết quả nhanh, giá rẻ' },
  'vae-voice-mmhd': { hint: 'Hơn 300 giọng, chất lượng cao' },
  'vae-voice-mmturbo': { hint: 'Hơn 300 giọng, nhanh và rẻ' },
};
/** Ô chọn model giọng đọc: "Giọng Việt tự nhiên" lên đầu (mặc định), mỗi model kèm ghi chú */
const ttsModelField: AiFieldDef = (() => {
  const list = [...tts].sort((a, b) => Number(b.modelId === 'vae-voice-vn') - Number(a.modelId === 'vae-voice-vn'));
  return {
    ...modelField(list, 'Mô hình AI'),
    options: list.map((m) => ({ value: m.modelId, label: TTS_NOTES[m.modelId]?.label ?? m.label, hint: TTS_NOTES[m.modelId]?.hint ?? m.label })),
  };
})();

/** Mã giọng hợp lệ (để API chỉ tải hộ file nghe thử của giọng có thật) */
const VOICE_IDS = new Set([...TMC_VOICES_ELEVEN, ...TMC_VOICES_MINIMAX].map((v) => v.value));

const TOOLS: TmcTool[] = [
  {
    key: 'grok-video',
    mode: 'image-to-video',
    name: 'Grok Video · Grok Imagine Video 1.5',
    category: 'video',
    icon: 'flame',
    badge: 'HOT',
    featured: true,
    description: 'Tạo video 1080p siêu nét tốc độ cao từ ảnh và câu lệnh mô tả chuyển động bằng Grok Imagine Video 1.5 (6s / 10s / 15s).',
    output: 'video',
    splitModels: false,
    fields: [
      fixedModel(grok[0]),
      image('image', 'Ảnh đầu vào'),
      prompt(true, 'Mô tả chuyển động (Prompt)', 'Vd: nhân vật mỉm cười tự nhiên, bước đi nhẹ nhàng, máy quay tiến chậm điện ảnh...'),
      ...optionField(grok, 'Thời lượng / chất lượng'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'image-to-video',
    mode: 'image-to-video',
    name: 'Ảnh thành video',
    category: 'video',
    icon: 'clapperboard',
    badge: 'HOT',
    featured: true,
    description: 'Biến một bức ảnh thành video chuyển động bằng Grok Video 1.5, Kling 2.6 Pro, Kling 3.0 Siêu Nét / Master, Kling 4.0, VAE H3.',
    output: 'video',
    fields: [
      modelField(i2v),
      image('image', 'Ảnh khung đầu'),
      { ...image('endImage', 'Ảnh khung cuối (tuỳ chọn)', false), showIf: { field: 'model', in: framesModels.map((m) => m.modelId) } },
      prompt(false, 'Mô tả chuyển động', 'Vd: camera tiến chậm, nhân vật mỉm cười và vẫy tay'),
      ...optionField(i2v),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'text-to-video',
    mode: 'text-to-video',
    name: 'Văn bản thành video',
    category: 'video',
    icon: 'film',
    featured: true,
    description: 'Tạo video từ mô tả bằng Veo3, Wan 3.0, MiniMax H3.',
    output: 'video',
    fields: [modelField(t2v), prompt(true), ...ratioField(t2v), ...optionField(t2v)],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'motion-control',
    mode: 'motion-control',
    name: 'Motion Control — Điều khiển chuyển động',
    category: 'video',
    icon: 'person-standing',
    badge: 'HOT',
    description: 'Ghép các cặp [Ảnh nhân vật + Video mẫu chuyển động] theo từng hàng ô vuông để chạy nhiều cặp cùng lúc.',
    output: 'video',
    fields: [
      modelField(motion),
      ...optionField(motion),
      ...ratioField(motion).map((f) => ({ ...f, required: true, default: '9:16' })),
      image('image', 'Ảnh nhân vật'),
      video('video', 'Video mẫu', 'Tải file MP4/MOV hoặc dán link TikTok / Douyin / MP4'),
      prompt(false, 'Mô tả bổ sung (Không bắt buộc)', 'Có thể để trống hoặc ghi chú thêm về biểu cảm, bối cảnh...'),
    ],
    // mỗi cặp [ảnh + video] là một video riêng; ô video có thêm ô dán link
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 20,
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'video-outfit',
    mode: 'video-outfit',
    name: 'Thay trang phục video',
    category: 'video',
    icon: 'shirt',
    description: 'Thay quần áo cho người trong video theo ảnh trang phục.',
    output: 'video',
    fields: [modelField(outfit), image('image', 'Ảnh trang phục'), video('video', 'Video gốc', 'MP4/MOV tối đa 50MB'), prompt(false), ...optionField(outfit)],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'h3-studio',
    mode: 'h3-studio',
    name: 'MiniMax H3 Studio',
    category: 'video',
    icon: 'video',
    badge: 'NEW',
    description: 'Dựng video có tiếng & lời thoại dài tới 30 giây — từ mô tả, từ 1 ảnh hoặc ghép nhiều ảnh nhân vật.',
    output: 'video',
    fields: [
      { ...modelField(h3, 'Chế độ'), default: 'vae-h3i' },
      { ...image('image', 'Ảnh nhân vật / cảnh gốc'), showIf: { field: 'model', in: h3WithImage } },
      { name: 'refs', label: 'Ảnh tham chiếu nhân vật / bối cảnh phụ', type: 'image', multiple: true, maxFiles: 4, accept: 'image/png,image/jpeg,image/webp', showIf: { field: 'model', in: ['vae-h3r'] } },
      prompt(true, 'Kịch bản chuyển động & lời thoại', 'Mô tả cảnh quay, hành động và lời thoại nhân vật nói trong video...'),
      ...ratioField(h3),
      ...optionField(h3),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'first-last-frame',
    mode: 'image-to-video',
    name: 'Khung đầu – khung cuối',
    category: 'video',
    icon: 'images',
    badge: 'NEW',
    description: 'Chọn ảnh mở đầu và ảnh kết thúc — AI tự nội suy chuyển động mượt mà nối liền 2 khoảnh khắc.',
    output: 'video',
    fields: [
      modelField(framesModels),
      image('image', 'Ảnh khung đầu'),
      image('endImage', 'Ảnh khung cuối'),
      prompt(false, 'Mô tả chuyển cảnh', 'Để trống AI tự nội suy, hoặc mô tả cách chuyển từ khung đầu sang khung cuối...'),
      ...optionField(framesModels),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'talking-photo',
    mode: 'talking-photo',
    name: 'Ảnh biết nói',
    category: 'video',
    icon: 'message-circle-heart',
    description: 'Ghép giọng nói vào ảnh chân dung, khẩu hình khớp lời.',
    output: 'video',
    fields: [modelField(talk), image('image', 'Ảnh chân dung'), { name: 'audio', label: 'File giọng nói', type: 'audio', required: true, accept: 'audio/mpeg,audio/wav,audio/mp4', help: 'MP3/WAV/M4A, nên dưới 30 giây' }],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'video-enhance',
    mode: 'video-enhance',
    name: 'Làm nét video 4K',
    category: 'tools',
    icon: 'sparkles',
    description: 'Tăng độ nét, nâng cấp chất lượng video lên 4K.',
    output: 'video',
    fields: [modelField(enhance), video('video', 'Video cần làm nét', 'MP4/MOV tối đa 50MB')],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'text-to-image',
    mode: 'text-to-image',
    name: 'Tạo ảnh AI',
    category: 'image',
    icon: 'image',
    featured: true,
    description: 'Tạo ảnh chất lượng cao bằng Nano Pro, Nano 2, Seedream 5.',
    output: 'image',
    fields: [
      modelField(t2i),
      prompt(true),
      { name: 'refs', label: 'Ảnh tham chiếu (tuỳ chọn)', type: 'image', multiple: true, maxFiles: 4, accept: 'image/png,image/jpeg,image/webp' },
      ...ratioField(t2i),
      ...optionField(t2i, 'Độ phân giải'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'body-edit',
    mode: 'body-edit',
    name: 'Chỉnh dáng người AI',
    category: 'image',
    icon: 'scan-face',
    description: 'Chỉnh vóc dáng thon gọn, tăng vòng 1, vòng 3, eo thon S-Line tự nhiên — giữ nguyên mặt, trang phục và nền.',
    output: 'image',
    // làm theo Studio TMC: 5 kiểu chỉnh dạng thẻ có mô tả + ô yêu cầu chi tiết (gửi kèm prompt)
    fields: [
      modelField(body),
      {
        name: 'bodyType',
        label: 'Kiểu chỉnh vóc dáng',
        type: 'select',
        required: true,
        default: 'waist',
        help: 'Giữ nguyên mặt & nền',
        options: [
          { value: 'waist', label: 'Eo thon gọn', hint: 'Thắt đáy lưng ong tự nhiên' },
          { value: 'bust', label: 'Tăng vòng 1', hint: 'Đầy đặn, cân đối' },
          { value: 'hips', label: 'Tăng vòng 3', hint: 'Hông nở, tôn dáng' },
          { value: 'slim', label: 'Thon gọn toàn thân', hint: 'Giảm mỡ & kéo dài chân' },
          { value: 'sline', label: 'Dáng S-Line', hint: 'Đồng hồ cát hoàn hảo' },
        ],
      },
      image('image', 'Ảnh nhân vật cần chỉnh vóc dáng'),
      prompt(false, 'Yêu cầu chỉnh dáng chi tiết', 'Chọn kiểu chỉnh dáng ở trên hoặc ghi thêm yêu cầu chi tiết...'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'kol-image',
    mode: 'text-to-image',
    name: 'Ảnh KOL AI',
    category: 'image',
    icon: 'camera',
    description: 'Tạo bộ ảnh người mẫu / KOL ảo đăng mạng xã hội, giữ đồng nhất khuôn mặt nếu tải kèm ảnh mặt mẫu.',
    output: 'image',
    fields: [
      modelField(t2i),
      image('image', 'Ảnh khuôn mặt mẫu (tuỳ chọn, để giữ đúng nét mặt)', false),
      prompt(true, 'Bối cảnh & trang phục của KOL', 'Vd: cô gái Việt 22 tuổi mặc váy trắng, đứng ở quán cà phê ven hồ, ánh nắng chiều'),
      ...ratioField(t2i),
      ...optionField(t2i, 'Độ phân giải'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'image-outfit',
    mode: 'text-to-image',
    name: 'Thay đồ ảnh',
    category: 'image',
    icon: 'shirt',
    description: 'Ghép trang phục, phụ kiện lên ảnh người mẫu tự nhiên như chụp thật — giữ nguyên khuôn mặt & dáng đứng.',
    output: 'image',
    fields: [
      modelField(t2i),
      image('image', 'Ảnh người mẫu (cần thay đồ)'),
      image('garment', 'Ảnh bộ trang phục / quần áo mẫu'),
      { name: 'outfitPart', label: 'Bộ phận cần thay', type: 'select', required: true, default: 'full', options: OUTFIT_PARTS },
      { name: 'background', label: 'Bối cảnh', type: 'select', required: true, default: OUTFIT_BGS[0].value, options: OUTFIT_BGS },
      prompt(false, 'Ghi chú thêm (tuỳ chọn)', 'Có thể để trống — hệ thống tự ghép theo bộ phận & bối cảnh đã chọn'),
      ...ratioField(t2i),
      ...optionField(t2i, 'Độ phân giải'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'product-image',
    mode: 'text-to-image',
    name: 'Ảnh sản phẩm AI',
    category: 'image',
    icon: 'shopping-bag',
    description: 'Đặt sản phẩm vào bối cảnh thương mại đẹp mắt hoặc ghép người mẫu cầm sản phẩm — giữ nguyên logo & chữ.',
    output: 'image',
    fields: [
      modelField(t2i),
      image('image', 'Ảnh sản phẩm gốc'),
      { name: 'refs', label: 'Ảnh người mẫu / bối cảnh mẫu (tuỳ chọn)', type: 'image', multiple: true, maxFiles: 3, accept: 'image/png,image/jpeg,image/webp' },
      { name: 'productStyle', label: 'Kiểu ảnh', type: 'select', required: true, default: PRODUCT_STYLES[0].value, options: PRODUCT_STYLES },
      { name: 'productScene', label: 'Bối cảnh', type: 'select', required: true, default: PRODUCT_SCENES[0].value, options: PRODUCT_SCENES },
      prompt(false, 'Mô tả thêm góc chụp / đạo cụ (tuỳ chọn)', 'Để trống dùng thiết lập ở trên, hoặc mô tả thêm đạo cụ xung quanh sản phẩm...'),
      ...ratioField(t2i),
      ...optionField(t2i, 'Độ phân giải'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'image-upscale',
    mode: 'text-to-image',
    name: 'Làm nét ảnh 4K',
    category: 'tools',
    icon: 'monitor-up',
    description: 'Phóng to độ phân giải 1K/2K/4K, phục hồi chi tiết da, tóc và chữ sắc nét — giữ nguyên bố cục gốc.',
    output: 'image',
    fields: [
      modelField(upscale),
      image('image', 'Ảnh cần làm nét'),
      prompt(false, 'Ghi chú làm nét (tuỳ chọn)', 'Mặc định giữ nguyên 100% chi tiết gốc và nâng cấp độ nét 4K Ultra HD...'),
      ...optionField(upscale, 'Độ phân giải'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'text-to-speech',
    mode: 'text-to-speech',
    name: 'Chuyển văn bản thành giọng nói',
    category: 'voice',
    icon: 'mic',
    featured: true,
    description: 'Chuyển văn bản thành giọng đọc AI tiếng Việt truyền cảm (ElevenLabs / MiniMax) — bấm ▶ để nghe thử từng giọng.',
    output: 'audio',
    fields: [
      ttsModelField,
      { name: 'text', label: 'Văn bản', type: 'textarea', required: true, max: 5000, placeholder: 'Nhập nội dung cần đọc...' },
      { name: 'voice', label: 'Giọng đọc', type: 'select', picker: 'voice', preview: '/api/public/ai/voice-preview/tmc/{value}', required: true, optionsBy: { field: 'model', map: voiceMap } },
      {
        name: 'speed',
        label: 'Tốc độ',
        type: 'select',
        default: '1',
        options: [
          { value: '0.8', label: 'Chậm (0.8x)' },
          { value: '1', label: 'Bình thường' },
          { value: '1.2', label: 'Nhanh (1.2x)' },
        ],
      },
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'text-to-music',
    mode: 'text-to-music',
    name: 'Sáng tác nhạc AI',
    category: 'audio',
    icon: 'music',
    badge: 'NEW',
    description: 'Tạo bài hát hoặc nhạc nền từ mô tả.',
    output: 'audio',
    fields: [modelField(music), { ...prompt(true, 'Mô tả giai điệu, thể loại hoặc lời bài hát', 'Bấm chọn Thể loại nhạc gợi ý ở trên hoặc nhập chủ đề, lời bài hát...'), suggestions: MUSIC_GENRES }, { name: 'instrumental', label: 'Chỉ nhạc nền (không lời)', type: 'boolean', default: false }],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  // ---- quy trình AI dựng sẵn: model + chất lượng chốt sẵn, form chỉ còn ô tải file ----
  {
    key: 'wf-upscale-ultra',
    as: 'image-upscale',
    mode: 'text-to-image',
    name: 'Ultra Fast Upscale 4K',
    category: 'workflow',
    icon: 'monitor-up',
    badge: 'HOT',
    description: 'Up ảnh lên 4K Ultra HD siêu nhanh — phục hồi chi tiết da, tóc, chữ, giữ nguyên bố cục gốc.',
    output: 'image',
    fields: [fixedModel(wfUpscale), image('image', 'Ảnh cần làm nét'), ...optionField(wfUpscale ? [wfUpscale] : [], 'Độ phân giải').map((f) => ({ ...f, default: '|4K', hidden: true }))],
    splitModels: false,
    cover: '/workflows/upscale.jpg',
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'wf-motion-image-1080p',
    as: 'motion-control',
    mode: 'motion-control',
    name: 'Motion Control nền ảnh (1080P)',
    category: 'workflow',
    icon: 'person-standing',
    badge: 'HOT',
    description: 'Nhân vật trong ảnh nhảy / tạo dáng theo video mẫu, giữ nguyên bối cảnh của ảnh — xuất video 1080P.',
    output: 'video',
    fields: [
      fixedModel(wfMotion1080),
      ...optionField(wfMotion1080 ? [wfMotion1080] : [], 'Thời lượng'),
      ...ratioField(wfMotion1080 ? [wfMotion1080] : []).map((f) => ({ ...f, default: '9:16' })),
      image('image', 'Ảnh nhân vật'),
      video('video', 'Video mẫu chuyển động', 'Tải file MP4/MOV hoặc dán link TikTok / Douyin / MP4'),
      prompt(false, 'Mô tả bổ sung (Không bắt buộc)', 'Có thể để trống hoặc ghi chú thêm về biểu cảm...'),
    ],
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    splitModels: false,
    cover: '/workflows/motion-image.jpg',
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'wf-motion-video-v1',
    as: 'motion-control',
    mode: 'motion-control',
    name: 'Motion Control nền Video V1',
    category: 'workflow',
    icon: 'clapperboard',
    description: 'Thay nhân vật trong video mẫu bằng người trong ảnh — giữ nguyên chuyển động và bối cảnh của video.',
    output: 'video',
    fields: [
      fixedModel(wfMotionVideo),
      ...optionField(wfMotionVideo ? [wfMotionVideo] : [], 'Thời lượng'),
      image('image', 'Ảnh nhân vật'),
      video('video', 'Video mẫu (nền + chuyển động)', 'Tải file MP4/MOV hoặc dán link TikTok / Douyin / MP4'),
      prompt(false, 'Mô tả bổ sung (Không bắt buộc)', 'Có thể để trống hoặc ghi chú thêm về biểu cảm...'),
    ],
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    splitModels: false,
    cover: '/workflows/motion-video.jpg',
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  // ---- Kling đồng giá (mode kling-1k): 1 xu / đơn, tách theo model như các công cụ khác ----
  {
    key: 'kling1k-motion',
    mode: 'kling-1k',
    name: 'Kling Motion Control đồng giá',
    category: 'video',
    icon: 'person-standing',
    badge: 'GIÁ RẺ',
    description: `Sao chép chuyển động từ video mẫu sang ảnh nhân vật bằng Kling Motion 2.6 / 3.0. Video mẫu dài hơn giới hạn sẽ tự cắt. ${K1K_NOTE}`,
    output: 'video',
    fields: [
      modelField(k1kMotion),
      ...optionField(k1kMotion, 'Thời lượng / chất lượng').map((f) => ({ ...f, hidden: true })),
      image('image', 'Ảnh nhân vật'),
      video('video', 'Video mẫu chuyển động', 'Tải file MP4/MOV hoặc dán link TikTok / Douyin / MP4'),
      prompt(false, 'Mô tả bổ sung (Không bắt buộc)', 'Có thể để trống hoặc ghi chú thêm về biểu cảm...'),
    ],
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'kling1k-i2v',
    mode: 'kling-1k',
    name: 'Kling ảnh thành video đồng giá',
    category: 'video',
    icon: 'clapperboard',
    badge: 'GIÁ RẺ',
    description: `Biến ảnh thành video bằng Kling 3.0 / 4.0 với giá rẻ. ${K1K_NOTE}`,
    output: 'video',
    fields: [
      modelField(k1kI2v),
      ...optionField(k1kI2v, 'Thời lượng / chất lượng').map((f) => ({ ...f, hidden: true })),
      image('image', 'Ảnh khung đầu'),
      prompt(false, 'Mô tả chuyển động', 'Vd: camera tiến chậm, nhân vật mỉm cười và vẫy tay'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  {
    key: 'kling1k-frames',
    mode: 'kling-1k',
    name: 'Kling khung đầu – cuối đồng giá',
    category: 'video',
    icon: 'images',
    badge: 'GIÁ RẺ',
    description: `Chọn ảnh mở đầu và ảnh kết thúc — Kling Start & End tự nối chuyển động giữa 2 khoảnh khắc. ${K1K_NOTE}`,
    output: 'video',
    fields: [
      modelField(k1kFrames),
      ...optionField(k1kFrames, 'Thời lượng'),
      image('image', 'Ảnh khung đầu'),
      image('endImage', 'Ảnh khung cuối'),
      prompt(false, 'Mô tả chuyển cảnh', 'Để trống AI tự nội suy, hoặc mô tả cách chuyển từ khung đầu sang khung cuối...'),
    ],
    pricing: { mode: 'cost', multiplier: 2000 },
  },
  // ---- tiện ích /tools/* của TMC: API đồng bộ, không tính xu -> giá cố định (admin chỉnh ở AI Studio › Công cụ) ----
  {
    key: 'tiktok-download',
    mode: 'tiktok-download',
    name: 'Tải video TikTok / Douyin không logo',
    category: 'tools',
    icon: 'download',
    description: 'Dán link TikTok hoặc Douyin để tải video gốc không logo, không watermark.',
    output: 'video',
    fields: [{ name: 'url', label: 'Link video TikTok / Douyin', type: 'text', required: true, max: 1000, placeholder: 'https://www.tiktok.com/@.../video/...' }],
    pricing: { mode: 'fixed', base: 500 },
  },
  {
    key: 'remove-ai-label',
    mode: 'remove-ai-label',
    name: 'Gỡ nhãn AI & giả lập thiết bị thật',
    category: 'tools',
    icon: 'shield-check',
    badge: 'NEW',
    description: 'Gỡ dấu hiệu nội dung AI trong video / ảnh và gắn thông tin như quay chụp từ điện thoại, máy ảnh thật.',
    output: 'video',
    fields: [
      { name: 'file', label: 'Video hoặc ảnh cần gỡ nhãn', type: 'file', required: true, accept: 'video/mp4,video/quicktime,image/jpeg,image/png,image/webp', help: 'MP4/MOV hoặc JPG/PNG/WEBP' },
      {
        name: 'device',
        label: 'Giả lập thiết bị',
        type: 'select',
        required: true,
        default: 'iphone-15-pro',
        options: [
          { value: 'iphone-15-pro', label: 'iPhone 15 Pro' },
          { value: 'iphone-14', label: 'iPhone 14' },
          { value: 'samsung-s24-ultra', label: 'Samsung Galaxy S24 Ultra' },
          { value: 'sony-a7-iv', label: 'Sony A7 IV' },
          { value: 'dji-osmo-pocket-3', label: 'DJI Osmo Pocket 3' },
        ],
      },
    ],
    pricing: { mode: 'fixed', base: 1000 },
  },
];

/** Các công cụ chạy bằng API đồng bộ /tools/* (chạy nền, không qua /jobs) */
const SYNC_TOOLS = new Set(['tiktok-download', 'remove-ai-label']);

// ---------------- gọi API ----------------

/** Cache GET /models 10 phút (giá xu dùng để tính credits) */
let modelsCache: { at: number; base: string; models: TmcModel[] } | null = null;

async function liveModels(ctx: AiCallContext): Promise<TmcModel[]> {
  if (modelsCache && modelsCache.base === ctx.config.baseUrl && Date.now() - modelsCache.at < 600_000) return modelsCache.models;
  try {
    const res = await providerFetch<{ ok: boolean; data?: { models?: TmcModel[] } }>(ctx.config, '/models', { timeoutMs: 20_000 });
    const models = res?.data?.models;
    if (Array.isArray(models) && models.length) {
      modelsCache = { at: Date.now(), base: ctx.config.baseUrl, models };
      return models;
    }
  } catch {
    // mất kết nối -> dùng bảng giá tĩnh
  }
  return TMC_MODELS;
}

/**
 * Model theo mã (ưu tiên đúng mode): tìm trong bảng giá trực tiếp, không có thì trong bảng tĩnh —
 * GET /models có lúc tạm ẩn model đang quá tải (vd vae-m9 / vae-m11) dù /jobs vẫn nhận.
 */
function findModel(models: TmcModel[], modelId: string, mode: string, anyMode = false): TmcModel | undefined {
  for (const list of [models, TMC_MODELS]) {
    const m = list.find((x) => x.modelId === modelId && (x.mode === mode || anyMode)) ?? list.find((x) => x.modelId === modelId);
    if (m) return m;
  }
  return undefined;
}

/** Lựa chọn giá khớp input: theo ô "option" hoặc lựa chọn đầu tiên của model */
function pickOption(model: TmcModel, input: AiInput): TmcOption | null {
  const key = str(input.option);
  if (!key) return model.options[0] ?? null;
  return model.options.find((o) => optKey(o) === key) ?? null;
}

/** Bỏ envelope { ok, data } của TMC, ném lỗi khi ok = false */
function unwrap<T>(res: any): T {
  if (res && res.ok === false) throw new AiProviderError(String(res.error || res.message || 'TMC báo lỗi'), res, false);
  return (res?.data ?? res) as T;
}

/** Dựng payload gửi POST /jobs từ input của khách */
function buildPayload(tool: TmcTool, input: AiInput, model: TmcModel, opt: TmcOption | null) {
  // mode lấy theo model thật (vd MiniMax H3 nằm ở mode h3-studio dù công cụ là text-to-video)
  const p: Record<string, unknown> = { mode: model.mode || tool.mode, modelId: model.modelId };
  if (input.prompt) p.prompt = str(input.prompt);
  if (opt?.durationSec) p.durationSec = opt.durationSec;
  if (opt?.resolution) p.resolution = opt.resolution;
  if (input.ratio) p.ratio = str(input.ratio);
  if (input.image) p.inputImageUrl = str(input.image);
  if (Array.isArray(input.refs) && input.refs.length) p.imageUrls = input.refs;
  if (input.video) {
    // Studio TMC gửi cùng một URL cho cả 3 tên field video
    p.drivingVideoUrl = p.videoUrl = p.inputVideoUrl = str(input.video);
  }
  if (input.audio) {
    p.audioUrl = p.inputAudioUrl = str(input.audio);
    p.drivingVideoUrl = str(input.audio);
  }
  if (tool.mode === 'video-outfit' && input.image) p.garmentImageUrl = str(input.image);
  if (input.bodyType) p.bodyType = str(input.bodyType);
  if (tool.mode === 'text-to-speech') {
    p.prompt = str(input.text);
    p.voice = p.voiceId = str(input.voice);
    p.speed = Number(input.speed ?? 1);
  }
  if (tool.mode === 'text-to-music') p.instrumental = input.instrumental === true;
  studioExtras(tool, input, p);
  return p;
}

/**
 * Tải một file đầu vào lên TMC: POST /upload (body binary + header x-file-name) -> mã `tmc://upload/<id>`.
 * Nhóm kling-1k chỉ nhận file đã tải lên TMC, không tự tải link ngoài như các model khác.
 */
async function uploadToTmc(ctx: AiCallContext, url: string, modelId?: string): Promise<string> {
  let effectiveUrl = url;
  if (/\.(mp4|mov|webm)(\?|$)/i.test(effectiveUrl) && ctx.ensureVideoMaxBytes) {
    effectiveUrl = await ctx.ensureVideoMaxBytes(effectiveUrl, 45 * 1024 * 1024);
  }
  let src = await loadInputFile(ctx.readUpload, effectiveUrl);
  if (src.mimeType.startsWith('video/') && src.data.length > 46 * 1024 * 1024 && ctx.ensureVideoMaxBytes) {
    effectiveUrl = await ctx.ensureVideoMaxBytes(url, 45 * 1024 * 1024);
    src = await loadInputFile(ctx.readUpload, effectiveUrl);
  }
  // tên file chỉ giữ ký tự ASCII an toàn (header HTTP không nhận ký tự tiếng Việt)
  const filename = src.filename.replace(/[^\w.-]+/g, '_').slice(-100) || 'file';
  let lastStatus = 0;
  let lastJson: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(joinUrl(ctx.config.baseUrl, '/upload'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.config.apiKey}`,
          'Content-Type': src.mimeType,
          'x-file-name': filename,
          ...(modelId ? { 'x-model-id': modelId } : {}),
        },
        body: new Uint8Array(src.data),
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2_000));
        continue;
      }
      throw new AiProviderError(
        'Kết nối tới máy chủ xử lý AI tạm thời gián đoạn — tiền đã được hoàn lại vào ví',
        { error: (err as Error).message },
        true,
      );
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      lastStatus = res.status;
      lastJson = json;
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2_000));
        continue;
      }
      const msg =
        pickMessage(json) ||
        (transient
          ? `Máy chủ tiếp nhận file phía nguồn đang bận tạm thời (HTTP ${res.status}) — tiền đã được hoàn lại`
          : `Tải file đầu vào không hợp lệ (HTTP ${res.status}) — tiền đã được hoàn lại`);
      throw new AiProviderError(msg, { status: res.status, data: json }, transient);
    }
    const link = str(json?.data?.publicUrl ?? json?.data?.fileUrl);
    const id = link.split('?')[0].split('/').filter(Boolean).pop();
    if (!id) {
      throw new AiProviderError('Nhà cung cấp không trả mã file đã tải lên — tiền đã được hoàn lại', json, true);
    }
    return `tmc://upload/${id}`;
  }
  throw new AiProviderError(`Máy chủ tiếp nhận file phía nguồn đang bận tạm thời (HTTP ${lastStatus}) — tiền đã được hoàn lại`, { status: lastStatus, data: lastJson }, true);
}

/** kling-1k / kling-bot-*: thay link ảnh / video trong payload bằng mã file đã tải lên TMC (tải song song) */
async function uploadKling1kInputs(ctx: AiCallContext, p: Record<string, unknown>, modelId?: string) {
  const keys = ['inputImageUrl', 'endImageUrl', 'drivingVideoUrl'].filter((k) => typeof p[k] === 'string' && p[k]);
  const refs = await Promise.all(keys.map((k) => uploadToTmc(ctx, p[k] as string, modelId)));
  keys.forEach((k, i) => (p[k] = refs[i]));
  // các tên field video phụ của Studio không dùng cho kling-1k
  delete p.videoUrl;
  delete p.inputVideoUrl;
  delete p.imageUrls;
}

/** Nối prompt mẫu với ghi chú thêm của khách (nếu có) */
const withNote = (base: string, input: AiInput) => (str(input.prompt) ? `${base} ${str(input.prompt)}` : base);

/**
 * Các công cụ Studio dùng chung mode TMC (image-to-video / text-to-image) nhưng khác cách dựng prompt và ảnh,
 * làm theo đúng Studio web của TMC (field `studioTool` báo công cụ gốc).
 */
function studioExtras(tool: TmcTool, input: AiInput, p: Record<string, unknown>) {
  const img = str(input.image);
  const refs = Array.isArray(input.refs) ? (input.refs as string[]) : [];
  // quy trình dựng sẵn gửi như công cụ Studio gốc của nó
  const studioKey = tool.as ?? tool.key;
  switch (studioKey) {
    case 'image-to-video': {
      const end = str(input.endImage);
      if (end) {
        p.studioTool = 'first-last-frame';
        p.endImageUrl = p.secondImageUrl = end;
        p.imageUrls = [end];
        p.prompt = str(input.prompt) || 'Chuyển cảnh điện ảnh mượt mà và tự nhiên từ khung hình mở đầu sang khung hình kết thúc.';
      } else {
        p.studioTool = studioKey;
      }
      break;
    }
    case 'grok-video':
    case 'motion-control':
      p.studioTool = studioKey;
      break;
    case 'first-last-frame': {
      const end = str(input.endImage);
      p.studioTool = tool.key;
      p.endImageUrl = p.secondImageUrl = end;
      p.imageUrls = [end];
      p.prompt = str(input.prompt) || 'Chuyển cảnh điện ảnh mượt mà và tự nhiên từ khung hình mở đầu sang khung hình kết thúc.';
      break;
    }
    case 'kol-image':
      p.studioTool = tool.key;
      if (img) p.imageUrls = [img];
      break;
    case 'image-outfit': {
      const garment = str(input.garment);
      const part = OUTFIT_PARTS.find((o) => o.value === str(input.outfitPart)) ?? OUTFIT_PARTS[0];
      p.studioTool = tool.key;
      p.garmentImageUrl = p.secondImageUrl = garment;
      p.imageUrls = [img, garment].filter(Boolean);
      p.outfitPart = part.value;
      p.prompt = withNote(
        `Thay trang phục của người mẫu trong ảnh 1 bằng bộ đồ trong ảnh 2 (${part.label}). ${str(input.background) || OUTFIT_BGS[0].value}. Giữ nguyên 100% khuôn mặt, vóc dáng và thần thái tự nhiên.`,
        input,
      );
      break;
    }
    case 'product-image':
      p.studioTool = tool.key;
      p.imageUrls = [img, ...refs].filter(Boolean);
      p.prompt = withNote(
        `${str(input.productStyle) || PRODUCT_STYLES[0].value} ${str(input.productScene) || PRODUCT_SCENES[0].value}. Giữ nguyên 100% thiết kế, hình dáng, màu sắc và chữ/logo trên sản phẩm gốc.`,
        input,
      );
      break;
    case 'image-upscale':
      p.studioTool = studioKey;
      p.imageUrls = [img];
      p.prompt = str(input.prompt) || 'Làm nét ảnh chất lượng 4K Ultra HD, phục hồi chi tiết sắc nét hoàn hảo, giữ nguyên 100% khuôn mặt, đường nét, màu sắc và bố cục gốc.';
      // giữ tỉ lệ ảnh gốc
      p.ratio = 'adaptive';
      break;
    case 'kling1k-frames': {
      // Start & End (kling-1k): ảnh cuối gửi qua endImageUrl
      const end = str(input.endImage);
      p.endImageUrl = end;
      p.prompt = str(input.prompt) || 'Chuyển cảnh điện ảnh mượt mà và tự nhiên từ khung hình mở đầu sang khung hình kết thúc.';
      break;
    }
    case 'h3-studio':
      p.studioTool = tool.key;
      // chế độ "Từ mô tả" không nhận ảnh; "Nhiều ảnh" gửi ảnh tham chiếu qua imageUrls
      if (p.modelId === 'vae-h3t') delete p.inputImageUrl;
      if (p.modelId !== 'vae-h3r') delete p.imageUrls;
      break;
  }
}

/** Chuẩn hoá một job TMC thành kết quả chung */
function toResult(job: any, tool: AiToolDef): AiProviderResult {
  const status = String(job?.status ?? '').toLowerCase();
  const id = job?.jobId ?? job?.id;
  if (status === 'done' || status === 'completed' || status === 'success') {
    const urls: string[] = [job.outputUrl, job.publicUrl, job.resultUrl, ...(Array.isArray(job.outputUrls) ? job.outputUrls : [])].filter((u): u is string => typeof u === 'string' && !!u);
    if (!urls.length) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả, tiền đã được hoàn lại', raw: job };
    const fallback = tool.output === 'text' ? 'image' : tool.output;
    return { status: 'succeeded', providerTaskId: id, files: [...new Set(urls)].map((url) => ({ url, type: guessType(url, fallback) })), raw: job };
  }
  if (status === 'failed' || status === 'expired' || status === 'cancelled') {
    const err = String(job?.error ?? '').replace(/\(Đã hoàn xu\)/gi, '').trim();
    return { status: 'failed', providerTaskId: id, error: err ? `${err} — tiền đã được hoàn lại` : undefined, raw: job };
  }
  return { status: 'processing', providerTaskId: id, progress: Number(job?.progress) || undefined, raw: job };
}

// ---------------- tiện ích /tools/* (đồng bộ) ----------------

/** File kết quả tự tải về tối đa (lớn hơn thì trả link để khách tải thẳng) */
const MAX_RESULT_BYTES = 300 * 1024 * 1024;

/** Đọc phản hồi lỗi JSON { ok:false, error } của /tools/* thành AiProviderError (401 không lộ chi tiết) */
async function toolError(res: Response): Promise<AiProviderError> {
  const text = await res.text().catch(() => '');
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { body: text.slice(0, 2000) };
  }
  if (res.status === 401) return new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.', { status: res.status, data });
  // hết 50 lượt/ngày của TMC -> báo khách thử lại ngày mai
  if (res.status === 429) return new AiProviderError('Công cụ đã hết lượt dùng hôm nay, vui lòng thử lại vào ngày mai. Credits đã được hoàn lại.', { status: res.status, data });
  return new AiProviderError(`${pickMessage(data) || `Nhà cung cấp AI báo lỗi HTTP ${res.status}`} — tiền đã được hoàn lại`, { status: res.status, data });
}

/**
 * Tìm link video không logo trong phản hồi /tools/tiktok-download (TMC chưa công bố định dạng):
 * duyệt mọi chuỗi http(s), bỏ link gốc khách dán và ảnh bìa / avatar / nhạc, ưu tiên khoá có chữ nowm / hd / download / video / play.
 */
function findVideoLink(data: unknown, input: string): string | null {
  const found: { url: string; score: number }[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string') {
      if (!/^https?:\/\//i.test(v) || v === input || /cover|thumb|avatar|music|image|origin_?url|source/i.test(key)) return;
      const score = /no_?w(ater)?m(ark)?|nowm/i.test(key) ? 5 : /hd/i.test(key) ? 4 : /download/i.test(key) ? 3 : /video|play|mp4/i.test(key) ? 2 : /url|link/i.test(key) ? 1 : 0;
      found.push({ url: v, score });
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(data, '');
  found.sort((a, b) => b.score - a.score);
  return found[0]?.url ?? null;
}

/** Tải video TikTok / Douyin không logo: POST /tools/tiktok-download -> tải file về lưu storage mình (link TikTok sống ngắn) */
async function runTiktokDownload(ctx: AiCallContext, url: string, id: string): Promise<AiProviderResult> {
  const data = unwrap<any>(await providerFetch(ctx.config, '/tools/tiktok-download', { json: { urls: [url] }, timeoutMs: 120_000 }));
  // phản hồi theo lô: lấy kết quả đầu tiên; mục lỗi riêng thì báo lỗi đó
  const item = Array.isArray(data?.results) ? data.results[0] : Array.isArray(data) ? data[0] : data;
  if (item && (item.ok === false || item.success === false)) {
    return { status: 'failed', providerTaskId: id, error: `${pickMessage(item) || 'Không tải được video từ link này'} — tiền đã được hoàn lại`, raw: data };
  }
  const link = findVideoLink(item, url);
  if (!link) return { status: 'failed', providerTaskId: id, error: 'Không lấy được link video không logo, tiền đã được hoàn lại', raw: data };
  const name = typeof item?.title === 'string' && item.title ? item.title.slice(0, 120) : undefined;
  try {
    const res = await fetch(link, { signal: AbortSignal.timeout(10 * 60_000) });
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (res.ok && !mime.includes('json') && !mime.includes('html')) {
      // file quá lớn -> trả link để hệ thống tự sao lưu / khách tải thẳng
      if (Number(res.headers.get('content-length') || 0) > MAX_RESULT_BYTES) return { status: 'succeeded', providerTaskId: id, files: [{ url: link, type: 'video', name }], raw: data };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1024) return { status: 'succeeded', providerTaskId: id, files: [{ url: '', type: 'video', name, data: buf, mimeType: mime.startsWith('video/') ? mime : 'video/mp4', sourceUrl: link }], raw: data };
    }
  } catch {
    // tải hộ không được -> trả link gốc để hệ thống tải lại khi lưu kết quả
  }
  return { status: 'succeeded', providerTaskId: id, files: [{ url: link, type: 'video', name }], raw: data };
}

/** Gỡ nhãn AI: POST /tools/remove-ai-label, body là binary file gốc, server trả thẳng binary file đã xử lý */
async function runRemoveAiLabel(ctx: AiCallContext, input: AiInput, id: string): Promise<AiProviderResult> {
  const src = await loadInputFile(ctx.readUpload, str(input.file));
  const mime = src.mimeType.startsWith('video/') || src.mimeType.startsWith('image/') ? src.mimeType : 'video/mp4';
  // tên file chỉ giữ ký tự ASCII an toàn (header HTTP không nhận ký tự tiếng Việt)
  const filename = src.filename.replace(/[^\w.-]+/g, '_').slice(-100) || (mime.startsWith('image/') ? 'image.jpg' : 'video.mp4');
  let res: Response;
  try {
    res = await fetch(joinUrl(ctx.config.baseUrl, '/tools/remove-ai-label'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.config.apiKey}`, 'Content-Type': mime, 'x-file-name': filename, 'x-device-profile': str(input.device) || 'iphone-15-pro' },
      body: new Uint8Array(src.data),
      // video lớn xử lý có thể mất vài phút
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (err) {
    // quá giờ / mất kết nối: không gửi lại (TMC có thể đã xử lý), báo lỗi để hoàn credits
    throw new AiProviderError('Nhà cung cấp AI phản hồi quá lâu, tiền đã được hoàn lại', { error: (err as Error).message });
  }
  if (!res.ok) throw await toolError(res);
  const outMime = (res.headers.get('content-type') || '').split(';')[0].trim();
  // 200 nhưng trả JSON: có thể là { ok:false } hoặc link file kết quả
  if (outMime.includes('json')) {
    const json: any = await res.json().catch(() => null);
    const data = unwrap<any>(json);
    const link = [data?.outputUrl, data?.url, data?.downloadUrl, data?.fileUrl].find((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!link) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả, tiền đã được hoàn lại', raw: json };
    return { status: 'succeeded', providerTaskId: id, files: [{ url: link, type: guessType(link, mime.startsWith('image/') ? 'image' : 'video') }], raw: json };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp trả file rỗng, tiền đã được hoàn lại' };
  const finalMime = outMime.startsWith('video/') || outMime.startsWith('image/') ? outMime : mime;
  return { status: 'succeeded', providerTaskId: id, files: [{ url: '', type: finalMime.startsWith('image/') ? 'image' : 'video', name: src.filename.slice(0, 120), data: buf, mimeType: finalMime }] };
}

const MIME_EXT: Record<string, { type: 'image' | 'video' | 'audio'; ext: string }> = {
  'video/mp4': { type: 'video', ext: 'mp4' },
  'video/quicktime': { type: 'video', ext: 'mov' },
  'video/webm': { type: 'video', ext: 'webm' },
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/png': { type: 'image', ext: 'png' },
  'image/webp': { type: 'image', ext: 'webp' },
  'audio/mpeg': { type: 'audio', ext: 'mp3' },
  'audio/mp3': { type: 'audio', ext: 'mp3' },
  'audio/wav': { type: 'audio', ext: 'wav' },
  'audio/x-wav': { type: 'audio', ext: 'wav' },
  'audio/mp4': { type: 'audio', ext: 'm4a' },
};

/**
 * Khắc phục lỗi phía TMC: nhiều job (`grok-video-1.5`, `kling-2.6`, `img-seedream5`, `vae-*`) đã xuất xong file
 * tại `<origin>/files/<jobId>` và ghi `doneAt > 0` nhưng `/api/v1/jobs/<jobId>` vẫn giữ `status: "processing", outputUrl: null`.
 * Gọi thẳng GET `/files/<jobId>` kèm Bearer key để tải binary về lưu vào storage hệ thống.
 */
async function tryFetchCompletedFile(ctx: AiCallContext, id: string, job: any, tool: AiToolDef): Promise<AiProviderResult | null> {
  try {
    const origin = new URL(ctx.config.baseUrl).origin;
    const fileUrl = `${origin}/files/${encodeURIComponent(id)}`;
    const res = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${ctx.config.apiKey}` },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime || mime.includes('json') || mime.includes('html') || mime.includes('text')) return null;
    if (Number(res.headers.get('content-length') || 0) > MAX_RESULT_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512 || buf.length > MAX_RESULT_BYTES) return null;
    const mapped = MIME_EXT[mime];
    const fallbackType: 'image' | 'video' | 'audio' =
      mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : tool.output === 'text' ? 'image' : tool.output;
    const ext = mapped?.ext ?? (fallbackType === 'video' ? 'mp4' : fallbackType === 'audio' ? 'mp3' : 'jpg');
    return {
      status: 'succeeded',
      providerTaskId: id,
      files: [
        {
          url: '',
          type: mapped?.type ?? fallbackType,
          name: `tmc-${id}.${ext}`,
          data: buf,
          mimeType: mime,
        },
      ],
      raw: { ...(job && typeof job === 'object' ? job : {}), recoveredViaFilesApi: true },
    };
  } catch {
    return null;
  }
}

export const tmcProvider: AiProvider = {
  key: 'tmc',
  // tỉ giá quy đổi mặc định: 1 xu = 2000 credits web (admin đổi ở tab Khoá API nhà cung cấp)
  costUnit: 'xu',
  rate: 2000,
  name: 'TMC Video AI',
  website: 'https://tmcvideoai.net',
  // file nghe thử công khai của TMC (API tải hộ qua /public/ai/voice-preview/tmc/<giọng>)
  voicePreview: (voice) => (VOICE_IDS.has(voice) ? `https://tmcvideoai.net/voice-preview/${voice}.mp3` : null),
  tools: TOOLS,

  /** Giá xu của lựa chọn khách chọn (theo bảng giá trực tiếp của TMC) */
  async cost(tool, input, ctx) {
    const models = await liveModels(ctx);
    const t = tool as TmcTool;
    const model = findModel(models, str(input.model), t.mode);
    if (!model) return null;
    return pickOption(model, input)?.xu ?? null;
  },

  async submit(tool, input, ctx) {
    const t = tool as TmcTool;
    // tiện ích đồng bộ /tools/*: chạy nền, trả processing ngay để request của khách không bị treo
    if (SYNC_TOOLS.has(t.key)) {
      if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
      const id = `tmc-tool-${randomUUID()}`;
      if (t.key === 'tiktok-download') {
        const url = str(input.url);
        if (!/^https?:\/\/\S*(tiktok\.com|douyin\.com|iesdouyin\.com)\S*$/i.test(url)) throw new AiProviderError('Link không hợp lệ, vui lòng dán link video TikTok hoặc Douyin');
        startBackground(id, () => runTiktokDownload(ctx, url, id), 20_000);
      } else {
        startBackground(id, () => runRemoveAiLabel(ctx, input, id), 60_000);
      }
      return { status: 'processing', providerTaskId: id };
    }
    const models = await liveModels(ctx);
    const model = findModel(models, str(input.model), t.mode, t.key === 'text-to-video');
    if (!model) throw new AiProviderError('Model này hiện không còn khả dụng, vui lòng chọn model khác');
    if ((model.modelId === 'grok-video-1.5' || (t.mode === 'image-to-video' && model.modelId === 'vae-h3i')) && !str(input.prompt)) {
      throw new AiProviderError('Model này yêu cầu nhập mô tả chuyển động (Prompt)');
    }
    const payload = buildPayload(t, input, model, pickOption(model, input));
    if (model.mode === 'kling-1k' || model.modelId.startsWith('kling-bot-')) await uploadKling1kInputs(ctx, payload, model.modelId);
    const data = unwrap<any>(await providerFetch(ctx.config, '/jobs', { json: payload }));
    // phản hồi có thể là job hoặc danh sách job (khi gửi theo lô)
    const job = Array.isArray(data?.jobs) ? data.jobs[0] : Array.isArray(data) ? data[0] : data?.job ?? data;
    if (!job?.jobId && !job?.id) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', data);
    return toResult(job, tool);
  },

  async poll(tool, id, ctx) {
    // tác vụ tiện ích chạy nền trong API (mã do mình đặt)
    if (id.startsWith('tmc-tool-')) return backgroundState(id);
    const job = unwrap<any>(await providerFetch(ctx.config, `/jobs/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }));
    const res = toResult(job, tool);
    const rawStatus = String(job?.status ?? '').toLowerCase();
    if (
      (res.status === 'processing' && Number(job?.doneAt) > 0) ||
      ((rawStatus === 'done' || rawStatus === 'completed' || rawStatus === 'success') && res.status === 'failed')
    ) {
      const recovered = await tryFetchCompletedFile(ctx, id, job, tool);
      if (recovered) return recovered;
    }
    return res;
  },

  async balance(ctx) {
    const me = unwrap<{ balanceXu?: number; coinsXu?: number }>(await providerFetch(ctx.config, '/me', { timeoutMs: 20_000 }));
    return { balance: Number(me.balanceXu ?? me.coinsXu ?? 0), unit: 'xu' };
  },

  /** Danh mục model từ GET /models (cần khoá): mã = `<mode>/<modelId>` vì một model có thể ở nhiều chế độ */
  async catalog(ctx) {
    const res = unwrap<{ models?: TmcModel[] }>(await providerFetch(ctx.config, '/models', { timeoutMs: 20_000 }));
    if (!Array.isArray(res?.models)) throw new Error('TMC trả danh sách model không đúng định dạng');
    return res.models.map((m) => ({ id: `${m.mode}/${m.modelId}`, label: `${m.label} (${m.mode})` }));
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    const res = unwrap<{ models?: TmcModel[] }>(await providerFetch(ctx.config, '/models', { timeoutMs: 18_000 }).catch(() => null));
    const list = Array.isArray(res?.models) ? res.models : [];
    const liveIds = new Set(list.map((m) => str(m?.modelId)).filter(Boolean));
    if (liveIds.size < 15) return { addedTools: [], removedKeys: [] };

    const removedKeys: string[] = [];
    const updatedSplits: string[] = [];
    for (let i = TOOLS.length - 1; i >= 0; i--) {
      const t = TOOLS[i];
      if (SYNC_TOOLS.has(t.key)) continue;
      const mf = t.fields.find((f) => f.name === 'model');
      if (!mf) continue;
      if (Array.isArray(mf.options) && mf.options.length > 0) {
        const kept = mf.options.filter((o) => liveIds.has(String(o.value)));
        const dropped = mf.options.filter((o) => !liveIds.has(String(o.value)));
        if (!kept.length) {
          removedKeys.push(`tmc.${t.key}`);
          for (const d of dropped) removedKeys.push(`tmc.${t.key}~${d.value}`);
          TOOLS.splice(i, 1);
        } else if (dropped.length > 0) {
          mf.options = kept;
          if (!kept.some((o) => o.value === mf.default)) mf.default = kept[0].value;
          for (const d of dropped) removedKeys.push(`tmc.${t.key}~${d.value}`);
          if (t.splitModels !== false) updatedSplits.push(`tmc.${t.key}`);
        }
      } else if (mf.default && !liveIds.has(String(mf.default))) {
        removedKeys.push(`tmc.${t.key}`);
        TOOLS.splice(i, 1);
      }
    }
    return { addedTools: [], updatedSplits, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    try {
      const res = unwrap<{ models?: (TmcModel & { maintenance?: boolean; enabled?: boolean; status?: string })[] }>(
        await providerFetch(ctx.config, '/models', { timeoutMs: 15_000 }),
      );
      const list = Array.isArray(res?.models) ? res.models : [];
      if (list.length < 10) return null;
      const healthyIds = new Set<string>();
      for (const m of list) {
        const id = str(m?.modelId);
        if (!id) continue;
        const st = str(m?.status).toLowerCase();
        const isMaint =
          m?.maintenance === true ||
          m?.enabled === false ||
          /maint|off|down|disable/i.test(st) ||
          (Array.isArray(m?.options) && m.options.length === 0);
        if (!isMaint) healthyIds.add(id);
      }
      const down = new Set<string>();
      for (const t of TOOLS) {
        if (SYNC_TOOLS.has(t.key)) continue;
        const mf = t.fields.find((f) => f.name === 'model');
        if (!mf) continue;
        if (Array.isArray(mf.options) && mf.options.length > 0) {
          for (const o of mf.options) {
            if (!healthyIds.has(String(o.value))) down.add(`${t.key}~${o.value}`);
          }
        } else if (mf.default && !healthyIds.has(String(mf.default))) {
          down.add(t.key);
        }
      }
      return down;
    } catch {
      return null;
    }
  },
};
