import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiFieldDef,
  type AiFieldOption,
  type AiInput,
  type AiProvider,
  type AiProviderResult,
  type AiToolDef,
} from '../ai.types.js';
import { charCount } from '../ai-input.js';
import { guessType, joinUrl, pickMessage, providerFetch, str } from './http.js';

/**
 * Kapend — https://kapend.com (header Authorization: Bearer sk_kp_...; API ảnh/video cần gói Pro trở lên).
 * - Ảnh & Làm nét ảnh 4K: POST /api/image/generate → poll GET /api/generation-jobs/{jobId}
 * - Video: POST /api/video/generate → poll GET /api/generation-jobs/{jobId}
 * - Giọng đọc Đa năng (248 giọng): POST /api/voice/generate → poll GET /api/generation-jobs/{jobId}
 * - Giọng đọc CapCut (145 giọng): POST /api/v1/audio/speech (đồng bộ, trả thẳng file MP3)
 * - Xoá logo (Veo / Flow / NotebookLM): POST /api/v1/remove-logo?upload=1 → PUT file → POST /api/v1/remove-logo → poll GET ?jobId=
 * - Bảng giá & khuyến mãi trực tiếp: GET /api/v1/catalog + GET /api/config/credit-costs + GET /api/config/model-visibility.
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

const KLING_HINT = {
  kling: 'Kling 3.0 / 2.6 Motion Control ở công cụ "Kling Motion Control"; Kling Avatar (ảnh + giọng nói) ở công cụ "Kling Avatar"',
  motion: 'Kling 4.0, 4.0 Omni, 4.0 Omni Flash, 3.0 Omni, 3.0 Omni Edit, 2.6, 2.5 Turbo ở công cụ "Kling AI Video"; Kling Avatar ở công cụ "Kling Avatar"',
  avatar: 'Kling 4.0, 4.0 Omni, 3.0 Omni, 2.6, 2.5 Turbo ở công cụ "Kling AI Video"; Motion Control ở công cụ "Kling Motion Control"',
};

interface ImageServer {
  id: string;
  label: string;
  model?: string;
  mode?: string;
  res?: string[];
  ratios?: string[];
  refs?: number;
  price?: Record<string, number>;
}

interface ImageModel {
  id: string;
  label: string;
  ratios: string[];
  res: string[];
  refs: number;
  servers?: ImageServer[];
  modes?: [string, string][];
  price?: Record<string, number>;
  noLogo?: boolean;
}

const NB_RATIOS = ['9:16', '3:4', '1:1', '4:3', '16:9'];
const GPT26_SUB_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

/**
 * Toàn bộ model tạo ảnh đang hoạt động trên nguồn (đồng bộ live 2026-11-19):
 * - Gỡ VIP 2 đã tắt trên Nano Banana;
 * - Mở đủ VIP 3 / VIP 2 / VIP 1 cho GPT Image 2;
 * - Nâng GPT Image 2.5 -> GPT Image 2.6 (Flare / Tiêu chuẩn / Sunburst, VIP 1 & VIP 2);
 * - Bổ sung Z-Image và Seedream 5.5.
 */
const IMAGE_MODEL_LIST: ImageModel[] = [
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    ratios: NB_RATIOS,
    res: ['1k', '2k', '4k'],
    refs: 8,
    servers: [{ id: 'vip1', label: 'VIP 1 Nhanh', mode: 'vip1', price: { '1k': 120, '2k': 150, '4k': 200 } }],
    noLogo: true,
  },
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2.1',
    ratios: NB_RATIOS,
    res: ['1k', '2k', '4k'],
    refs: 12,
    servers: [{ id: 'vip1', label: 'VIP 1 Nhanh', mode: 'vip1', price: { '1k': 120, '2k': 150, '4k': 200 } }],
    noLogo: true,
  },
  {
    id: 'nano-banana-2-lite',
    label: 'Nano Banana 2 Lite',
    ratios: NB_RATIOS,
    res: ['1k', '2k', '4k'],
    refs: 8,
    servers: [{ id: 'vip1', label: 'VIP 1 Nhanh', mode: 'vip1', price: { '1k': 120, '2k': 130, '4k': 160 } }],
    noLogo: true,
  },
  {
    id: 'z_image',
    label: 'Z-Image',
    ratios: ['9:16', '16:9', '3:4', '1:1', '4:3'],
    res: ['2k', '4k'],
    refs: 0,
    servers: [{ id: 'fast', label: 'Fast', mode: 'fast', price: { '2k': 100, '4k': 400 } }],
  },
  {
    id: 'grok_imagine_2',
    label: 'Grok Imagine 2.0',
    ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
    res: ['1k', '2k'],
    refs: 5,
    price: { '1k': 150, '2k': 150 },
  },
  {
    id: 'grok-image',
    label: 'Grok Image',
    ratios: ['16:9', '9:16', '1:1', '3:2', '2:3'],
    res: ['1k'],
    refs: 2,
    servers: [{ id: 'vip2', label: 'VIP 2', model: 'grok_imagine', price: { '1k': 700 } }],
  },
  {
    id: 'imagegen_2_0',
    label: 'GPT Image 2',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:2', '2:3', '3:4'],
    res: ['1k', '2k', '4k'],
    refs: 8,
    servers: [
      { id: 'vip3_low', label: 'VIP 3 Nhanh · Low (Tiết kiệm)', mode: 'fashion_low', refs: 8, price: { '1k': 300, '2k': 300, '4k': 300 } },
      { id: 'vip3_medium', label: 'VIP 3 Nhanh · Medium', mode: 'fashion_medium', refs: 8, price: { '1k': 800, '2k': 800, '4k': 800 } },
      { id: 'vip3_high', label: 'VIP 3 Nhanh · High', mode: 'fashion_high', refs: 8, price: { '1k': 1500, '2k': 1500, '4k': 1500 } },
      { id: 'vip2_basic', label: 'VIP 2 · Low Basic', mode: 'low_basic', refs: 8, price: { '1k': 672, '2k': 672, '4k': 672 } },
      { id: 'vip1_low', label: 'VIP 1 · Low', mode: 'low', refs: 4, price: { '1k': 672, '2k': 672, '4k': 960 } },
      { id: 'vip1_medium', label: 'VIP 1 · Medium', mode: 'medium', refs: 4, price: { '1k': 1440, '2k': 2160, '4k': 4320 } },
      { id: 'vip1_high', label: 'VIP 1 · High', mode: 'high', refs: 4, price: { '1k': 2880, '2k': 4800, '4k': 6720 } },
    ],
  },
  {
    id: 'gpt-image-2.6',
    label: 'GPT Image 2.6',
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '5:4', '4:5', '3:2', '2:3', '21:9'],
    res: ['1k', '2k', '4k'],
    refs: 16,
    servers: [
      { id: 'flare_vip1', label: 'Flare · VIP 1 (Tiết kiệm)', model: 'gpt-image-2.6-flare', mode: 'medium', ratios: GPT26_SUB_RATIOS, price: { '1k': 576, '2k': 720, '4k': 960 } },
      { id: 'flare_vip2', label: 'Flare · VIP 2', model: 'gpt-image-2.6-flare', mode: 'vip2', ratios: GPT26_SUB_RATIOS, price: { '1k': 576, '2k': 720, '4k': 960 } },
      { id: 'std_vip1', label: 'Tiêu chuẩn · VIP 1', model: 'gpt-image-2.6', mode: 'medium', price: { '1k': 768, '2k': 768, '4k': 768 } },
      { id: 'std_vip2', label: 'Tiêu chuẩn · VIP 2', model: 'gpt-image-2.6', mode: 'vip2', price: { '1k': 768, '2k': 768, '4k': 768 } },
      { id: 'sunburst_vip1', label: 'Sunburst · VIP 1', model: 'gpt-image-2.6-sunburst', mode: 'medium', ratios: GPT26_SUB_RATIOS, price: { '1k': 2160, '2k': 3840, '4k': 7200 } },
      { id: 'sunburst_vip2', label: 'Sunburst · VIP 2', model: 'gpt-image-2.6-sunburst', mode: 'vip2', ratios: GPT26_SUB_RATIOS, price: { '1k': 2160, '2k': 3840, '4k': 7200 } },
    ],
  },
  {
    id: 'seedream_5_5',
    label: 'Seedream 5.5',
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
    res: ['1k', '2k'],
    refs: 4,
    price: { '1k': 600, '2k': 600 },
  },
  { id: 'seedream_4_5_pro', label: 'Seedream 4.5 Pro', ratios: ['1:1', '4:3', '16:9', '2:3', '9:16', '3:4'], res: ['2k', '4k'], refs: 3, price: { '2k': 720, '4k': 1680 } },
  { id: 'seedream_5_lite', label: 'Seedream 5 Lite', ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], res: ['2k', '3k'], refs: 6, price: { '2k': 720, '3k': 960 } },
  { id: 'seedream_5_pro', label: 'Seedream 5 Pro', ratios: ['1:1', '2:3', '3:4', '4:3', '9:16', '16:9'], res: ['1k'], refs: 6, price: { '1k': 1824 } },
  { id: 'flux_2_pro', label: 'Flux 2 Pro', ratios: ['auto', '1:1', '4:3', '16:9', '3:2', '2:3', '9:16', '3:4'], res: ['1k', '2k'], refs: 6, price: { '1k': 720, '2k': 1200 } },
];

const IMAGE_MODELS = new Map<string, ImageModel>([
  ...IMAGE_MODEL_LIST.map((m) => [m.id, m] as const),
  // Tương thích ngược nếu có đơn/link cũ gọi `gpt-image-2.5`
  ['gpt-image-2.5', IMAGE_MODEL_LIST.find((m) => m.id === 'gpt-image-2.6')!],
]);

const MAX_IMAGE_REFS = Math.max(...IMAGE_MODEL_LIST.flatMap((m) => [m.refs, ...(m.servers ?? []).map((s) => s.refs ?? 0)]));

/** 5 chế độ Làm nét ảnh 4K mới (`kapend_upscale_*`, giá gốc chỉ 50–150 credits/ảnh!) */
const IMAGE_UPSCALE_MODELS: { id: string; label: string; hint: string; fallbackCost: number }[] = [
  { id: 'kapend_upscale_fast', label: 'Fast · Siêu tốc tiết kiệm', hint: 'Nhẹ và nhanh nhất, phù hợp làm nét hàng loạt', fallbackCost: 50 },
  { id: 'kapend_upscale_fidelity', label: 'Fidelity · Giữ nguyên mặt & chi tiết gốc', hint: 'Bám sát ảnh gốc nhất, làm nét mà không biến dạng khuôn mặt', fallbackCost: 150 },
  { id: 'kapend_upscale_standard', label: 'Standard · Đa dụng cho ảnh chụp', hint: 'Phóng to đa dụng cho ảnh chụp đời thực và ảnh màn hình', fallbackCost: 150 },
  { id: 'kapend_upscale_sharp', label: 'Ultra Sharp · Siêu nét cạnh & chữ viết', hint: 'Tăng cường độ sắc nét tối đa cho viền cạnh, chữ viết và chi tiết nhỏ', fallbackCost: 150 },
  { id: 'kapend_upscale_art', label: 'Digital Art · Tranh vẽ, Anime & Minh hoạ', hint: 'Tối ưu đường nét sạch và mảng màu phẳng cho tranh kỹ thuật số / anime', fallbackCost: 150 },
];
const IMAGE_UPSCALE_MAP = new Map(IMAGE_UPSCALE_MODELS.map((m) => [m.id, m]));

const RATIO_LABEL: Record<string, string> = { '9:16': '9:16 (dọc)', '16:9': '16:9 (ngang)', '1:1': '1:1 (vuông)' };
const ratioLabel = (r: string) => (r === 'auto' ? 'Tự động' : (RATIO_LABEL[r] ?? r));

function resolveImage(input: AiInput) {
  const model = IMAGE_MODELS.get(str(input.model));
  if (!model) throw new AiProviderError('Model ảnh này đã ngừng hỗ trợ, vui lòng chọn model khác');
  const server = model.servers?.find((s) => s.id === str(input.server)) ?? model.servers?.[0];
  const res = server?.res ?? model.res;
  const ratios = server?.ratios ?? model.ratios;
  const quality = model.modes?.find(([v]) => v === str(input.mode))?.[0] ?? model.modes?.[0][0];
  return {
    model,
    id: server?.model ?? model.id,
    mode: quality ?? server?.mode,
    resolution: res.includes(str(input.resolution)) ? str(input.resolution) : res[0],
    ratio: ratios.includes(str(input.aspectRatio)) ? str(input.aspectRatio) : ratios[0],
    refs: server?.refs ?? model.refs,
    price: server?.price ?? model.price,
    count: Math.min(4, Math.max(1, Math.floor(Number(input.count) || 1))),
  };
}

/** Danh sách giọng CapCut mặc định dự phòng (sẽ tự động mở rộng lên đủ 145 giọng / 11 ngôn ngữ qua resolveFields từ catalog live) */
const FALLBACK_CAPCUT_VOICES: AiFieldOption[] = [
  { value: 'BV421_vivn_streaming', label: 'Giọng nữ mặc định (BV421)', gender: 'female', langs: ['vi'] },
  { value: 'BV074_streaming', label: 'Cô gái hoạt ngôn (BV074)', gender: 'female', langs: ['vi'] },
  { value: 'BV075_streaming', label: 'Thanh niên tự tin (BV075)', gender: 'male', langs: ['vi'] },
  { value: 'BV560_streaming', label: 'Anh Dũng (BV560)', gender: 'male', langs: ['vi'] },
  { value: 'BV562_streaming', label: 'Chí Mai (BV562)', gender: 'female', langs: ['vi'] },
  { value: 'vi-VN-HoaiMyNeural', label: 'Hoài My', gender: 'female', langs: ['vi'] },
  { value: 'vi-VN-NamMinhNeural', label: 'Nam Minh', gender: 'male', langs: ['vi'] },
];

const FALLBACK_KAPEND_VOICES: AiFieldOption[] = [
  { value: 'Ngọc Huyền', label: 'Ngọc Huyền 5.0', gender: 'female', langs: ['vi'], tags: ['Tuyển chọn'] },
  { value: 'BV421_vivn_streaming', label: 'Giọng nữ CapCut (BV421)', gender: 'female', langs: ['vi'], badge: 'Tiết kiệm', tags: ['CapCut'] },
];

const SAMPLE_TEXT: Record<string, string> = {
  vi: 'Xin chào, đây là giọng đọc mẫu tự nhiên của hệ thống.',
  en: 'Hello, this is a natural AI voice preview.',
  zh: '你好，这是示例语音。',
  ja: 'こんにちは、これはサンプル音声です。',
  ko: '안녕하세요, 샘플 음성입니다.',
  th: 'สวัสดี นี่คือเสียงตัวอย่าง',
  id: 'Halo, ini adalah pratinjau suara AI.',
  es: 'Hola, esta es una muestra de voz.',
  pt: 'Olá, esta é uma amostra de voz.',
  fr: 'Bonjour, ceci est un exemple de voix.',
  ru: 'Здравствуйте, это образец голоса.',
  ar: 'مرحباً، هذا نموذج صوتي.',
};

function capcutSpeech(ctx: AiCallContext, text: string, voice: string, speed: number, timeoutMs: number) {
  const cleanVoice = voice.startsWith('capcut:') ? voice.slice(7) : voice;
  return fetch(joinUrl(ctx.config.baseUrl, '/api/v1/audio/speech'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'capcut-tts', input: text, voice: cleanVoice, response_format: 'mp3', speed }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function ttsVoice(input: AiInput): string {
  return str(input.voice).trim() || str(input.speaker).trim() || 'BV421_vivn_streaming';
}

interface VideoModel {
  id: string;
  label: string;
  qualities: string[];
  durations: number[];
  ratios: string[];
  images: number;
  video?: boolean;
  audios?: number;
  variants?: string[];
  servers?: VideoServer[];
}

interface VideoServer {
  id: string;
  label: string;
  qualities: string[];
  durations: number[];
  ratios: string[];
  images: number;
  video?: boolean;
  audios?: number;
}

const AUTO = 'auto:';
const QUAL_ORDER = ['360p', '480p', '720p', '1080p', '2K', '4K'];

function withServers(id: string, label: string, servers: VideoServer[]): VideoModel {
  const union = <T>(fn: (s: VideoServer) => T[]) => [...new Set(servers.flatMap(fn))];
  return {
    id,
    label,
    qualities: union((s) => s.qualities).sort((a, b) => QUAL_ORDER.indexOf(a) - QUAL_ORDER.indexOf(b)),
    durations: union((s) => s.durations).sort((a, b) => a - b),
    ratios: union((s) => s.ratios),
    images: Math.max(...servers.map((s) => s.images)),
    video: servers.some((s) => s.video),
    audios: Math.max(0, ...servers.map((s) => s.audios ?? 0)),
    variants: servers.map((s) => s.id),
    servers,
  };
}

const R6 = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];
const R5 = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const SD_R6 = ['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'];
const SD25_SEC = [5, 8, 10, 15, 20, 25, 30];
const SEC_3_TO_15 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Công cụ "Seedance Video" — giữ duy nhất máy chủ VIP 2 (siêu tiết kiệm) cho Seedance 2.5 theo yêu cầu Admin */
const SEEDANCE_MODELS: VideoModel[] = [
  withServers('seedance_2_5', 'Seedance 2.5', [
    { id: 'seedance_25_vip2', label: 'VIP 2 (Siêu tiết kiệm)', qualities: ['480p', '720p', '1080p'], durations: [5, 10, 15, 30], ratios: SD_R6, images: 24, audios: 3 },
  ]),
  { id: 'seedance_25_flash', label: 'Seedance 2.5 Flash', qualities: ['480p', '720p', '1080p'], durations: [5, 8, 10, 12, 15, 30], ratios: SD_R6, images: 30, video: true, audios: 3 },
  withServers('seedance_2_0_fast', 'Seedance 2.0 Fast', [
    { id: 'seedance_2_0_fast_vip3', label: 'VIP 3', qualities: ['480p', '720p'], durations: [5, 8, 10, 15], ratios: R6, images: 5 },
  ]),
  { id: 'seedance_2_0_mini', label: 'Seedance 2.0 Mini', qualities: ['480p', '720p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: R6, images: 5 },
  { id: 'seedance_2_0', label: 'Seedance 2.0', qualities: ['480p', '720p'], durations: [5, 8, 10, 15], ratios: R6, images: 5 },
];
const NEEDS_IMAGE = ['seedance_2_0_mini'];

/** Công cụ "Kling AI Video" — bổ sung Kling 4.0 Omni Flash & 4.0 Flash, gỡ VIP 2 đã tắt và khoá _silent_ đã ngưng */
const KLING_MODELS: VideoModel[] = [
  { id: 'kling_video_4_0_omni_flash', label: 'Kling 4.0 Omni Flash', qualities: ['720p'], durations: [3, 5, 8, 10, 15, 20], ratios: ['16:9', '9:16', '1:1', '21:9'], images: 10, video: true },
  { id: 'kling_video_4_0_flash', label: 'Kling 4.0 Flash', qualities: ['720p'], durations: [3, 5, 8, 10, 15, 20], ratios: ['16:9', '9:16', '1:1', '21:9'], images: 1 },
  { id: 'kling_video_4_0', label: 'Kling 4.0', qualities: ['720p', '1080p'], durations: [3, 5, 8, 10, 15, 20, 25, 30], ratios: ['16:9', '9:16', '1:1', '21:9'], images: 10 },
  { id: 'kling_video_4_0_omni', label: 'Kling 4.0 Omni', qualities: ['720p', '1080p'], durations: [3, 5, 8, 10, 15, 20, 25, 30], ratios: ['16:9', '9:16', '1:1', '21:9'], images: 10, video: true },
  { id: 'kling_video_3_0_omni', label: 'Kling 3.0 Omni', qualities: ['720p', '1080p'], durations: [3, 5, 6, 7, 8, 10, 12, 15], ratios: ['16:9', '9:16', '1:1'], images: 7 },
  { id: 'kling_video_3_0_omni_edit', label: 'Kling 3.0 Omni Edit', qualities: ['720p', '1080p'], durations: [3, 5, 6, 7, 8, 10, 12, 15], ratios: ['16:9', '9:16', '1:1'], images: 4, video: true },
  { id: 'kling_video_2_6', label: 'Kling 2.6', qualities: ['720p', '1080p'], durations: [5, 10], ratios: ['16:9', '9:16', '1:1'], images: 1 },
  { id: 'kling_video_2_5', label: 'Kling 2.5 Turbo', qualities: ['720p', '1080p'], durations: [5, 10], ratios: ['16:9', '9:16', '1:1'], images: 1 },
];
const VIDEO_FOLLOWS_REF_DURATION = ['kling_video_4_0_omni', 'veo_omniv3', 'veo_omni12'];
const NEEDS_VIDEO = ['kling_video_3_0_omni_edit'];

/** Công cụ "Tạo video đa model" — tách rõ máy chủ VIP 1/2/3 cho Omni 1.1 & 1.2 Flash, bổ sung MiniMax H3, cập nhật Grok Video v3 & Wan 3.0 */
const MULTI_MODELS: VideoModel[] = [
  withServers('veo_omni', 'Google Omni 1.1 Flash', [
    { id: 'veo_omni', label: 'VIP 1 (Nhanh)', qualities: ['360p', '720p', '1080p', '4K'], durations: [4, 6, 8, 10], ratios: ['16:9', '9:16'], images: 7, video: true },
    { id: 'veo_omniv2', label: 'VIP 3 (Tiết kiệm 720p)', qualities: ['720p', '1080p', '4K'], durations: SEC_3_TO_15, ratios: ['16:9', '9:16'], images: 3 },
    { id: 'veo_omniv3', label: 'VIP 2 (10 ảnh + Video ref)', qualities: ['720p', '1080p', '4K'], durations: SEC_3_TO_15, ratios: ['16:9', '9:16'], images: 10, video: true },
  ]),
  withServers('veo_omni12', 'Google Omni 1.2 Flash', [
    { id: 'veo_omni12_vip1', label: 'VIP 1 (2 ảnh khung đầu-cuối ≤ 10s)', qualities: ['360p', '720p', '1080p', '4K'], durations: SEC_3_TO_15, ratios: ['16:9', '9:16'], images: 10, video: true },
    { id: 'veo_omni12', label: 'VIP 2 (Đầy đủ 3–15s)', qualities: ['720p', '1080p', '4K'], durations: SEC_3_TO_15, ratios: ['16:9', '9:16'], images: 10, video: true },
  ]),
  { id: 'veo_3_1', label: 'Google VEO 3.1', qualities: ['720p', '1080p', '4K'], durations: [8], ratios: ['16:9', '9:16'], images: 2 },
  { id: 'grok_video_15', label: 'Grok Video 1.5', qualities: ['480p', '720p', '1080p'], durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'], images: 14 },
  { id: 'grok_videov3', label: 'Grok Video v3', qualities: ['480p', '720p'], durations: [6, 10, 15], ratios: ['9:16', '16:9', '1:1'], images: 5 },
  { id: 'minimax_h3', label: 'MiniMax H3', qualities: ['720p', '2K'], durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], images: 9, video: true, audios: 1 },
  withServers('wan_3_0', 'Wan 3.0', [
    { id: 'wan_3_0_vip2', label: 'VIP 2 (Tiết kiệm)', qualities: ['480p', '720p', '1080p'], durations: [5, 10, 15, 30], ratios: R5, images: 10, video: true, audios: 5 },
    { id: 'wan_3_0', label: 'VIP 1', qualities: ['480p', '720p', '1080p'], durations: [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30], ratios: R5, images: 10, video: true },
  ]),
];
const VEO31 = 'veo_3_1';

const MODELS_BY_TOOL: Record<string, VideoModel[]> = { video: MULTI_MODELS, seedance: SEEDANCE_MODELS, kling: KLING_MODELS };

/** Nâng cấp video Topaz — gỡ 3 model Topaz cũ đã ngừng hoạt động, đặt Topaz Upscale MaxX làm mặc định */
const TOPAZ_MODELS: [string, string, string[], [string, string][], 'block5' | 'sec', number][] = [
  [
    'topaz_upscale_maxx',
    'Topaz Upscale MaxX',
    ['1080p', '2K', '4K'],
    [
      ['standard', 'Tiêu chuẩn (nhanh nhất)'],
      ['pro', 'Nâng cao (nét, ổn định)'],
      ['ultra_hd', 'Siêu nét (chi tiết nhất, chậm hơn)'],
    ],
    'sec',
    300,
  ],
  ['topaz_upscale_max', 'Topaz Upscale Max', ['4K'], [], 'sec', 40],
];
const TOPAZ_PRICE_BY_MODE = ['topaz_upscale_maxx'];
const TOPAZ = new Map(TOPAZ_MODELS.map((m) => [m[0], m]));

const RATIOS = opts([
  ['9:16', '9:16 (dọc)'],
  ['16:9', '16:9 (ngang)'],
  ['1:1', '1:1 (vuông)'],
  ['3:4', '3:4'],
  ['4:3', '4:3'],
]);

const videoCount = (input: AiInput) => Math.min(4, Math.max(1, Math.floor(Number(input.count) || 1)));
const VIDEO_COUNT_FIELD: AiFieldDef = {
  name: 'count',
  label: 'Số lượng video',
  type: 'select',
  default: '1',
  options: opts([['1', '×1'], ['2', '×2'], ['3', '×3'], ['4', '×4']]),
  help: 'Tạo 1–4 video cùng lúc, giá nhân theo số video',
};

function videoFields(models: VideoModel[], defaultModel: string, extra: AiFieldDef[] = []): AiFieldDef[] {
  const hasServers = models.some((m) => !!m.servers?.length);
  type Src = { key: string; qualities: string[]; durations: number[]; ratios: string[]; video?: boolean; audios?: number };
  const srcs: Src[] = hasServers
    ? models.flatMap((m) =>
        m.servers?.length
          ? m.servers.map((sv) => ({ ...sv, key: sv.id }))
          : [{ ...m, key: AUTO + m.id }],
      )
    : models.map((m) => ({ ...m, key: m.id }));
  const parent = hasServers ? 'server' : 'model';
  const by = <T>(fn: (x: Src) => T[], label: (x: T) => string) =>
    Object.fromEntries(srcs.map((x) => [x.key, fn(x).map((v) => ({ value: String(v), label: label(v) }))]));
  const withVideo = srcs.filter((x) => x.video).map((x) => x.key);
  const withAudios = srcs.filter((x) => (x.audios ?? 0) > 0).map((x) => x.key);
  const maxImages = Math.max(...models.map((m) => m.images));
  const maxAudios = Math.max(0, ...models.map((m) => m.audios ?? 0));
  const server: AiFieldDef = {
    name: 'server',
    label: 'Máy chủ',
    type: 'select',
    required: true,
    help: 'Mặc định đã chọn sẵn máy chủ tối ưu & giá tốt nhất; có thể chuyển máy chủ VIP khác nếu cần thêm ảnh/video tham chiếu',
    optionsBy: {
      field: 'model',
      map: Object.fromEntries(
        models.map((m) => [
          m.id,
          m.servers?.length
            ? m.servers.map((sv) => ({ value: sv.id, label: sv.label }))
            : [{ value: AUTO + m.id, label: 'Mặc định' }],
        ]),
      ),
    },
  };
  return [
    { name: 'model', label: 'Model AI', type: 'select', required: true, default: defaultModel, options: models.map((m) => ({ value: m.id, label: m.label })) },
    ...(hasServers ? [server] : []),
    { name: 'prompt', label: 'Mô tả (prompt)', type: 'textarea', required: true, placeholder: 'Mô tả cảnh quay, chuyển động camera, ánh sáng...' },
    {
      name: 'images',
      label: 'Ảnh khung đầu / tham chiếu (tuỳ chọn)',
      type: 'image',
      multiple: true,
      maxFiles: maxImages,
      accept: 'image/png,image/jpeg,image/webp',
      help: 'Tải lên ảnh khung đầu hoặc ảnh nhân vật / bối cảnh tham chiếu (PNG, JPG, WEBP)',
    },
    ...(withVideo.length
      ? [{ name: 'video', label: 'Video tham chiếu', type: 'video', accept: 'video/mp4,video/quicktime', showIf: { field: parent, in: withVideo } } as AiFieldDef]
      : []),
    ...(withAudios.length
      ? [
          {
            name: 'audios',
            label: 'Âm thanh tham chiếu (tuỳ chọn)',
            type: 'audio',
            multiple: maxAudios > 1,
            maxFiles: maxAudios,
            accept: 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a',
            showIf: { field: parent, in: withAudios },
          } as AiFieldDef,
        ]
      : []),
    { name: 'quality', label: 'Chất lượng', type: 'select', required: true, default: '720p', optionsBy: { field: parent, map: by((x) => x.qualities, (x) => x) } },
    { name: 'duration', label: 'Thời lượng', type: 'select', required: true, optionsBy: { field: parent, map: by((x) => x.durations, (x) => `${x} giây`) } },
    { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, optionsBy: { field: parent, map: by((x) => x.ratios, (x) => RATIO_LABEL[x] ?? x) } },
    VIDEO_COUNT_FIELD,
    ...extra,
  ];
}

const TOOLS: AiToolDef[] = [
  {
    key: 'image',
    name: 'Tạo ảnh đa model',
    category: 'image',
    icon: 'images',
    description: 'Nano Banana, Z-Image, GPT Image 2 / 2.6, Seedream 5.5, Grok Imagine 2.0, Flux 2 Pro trong một công cụ.',
    output: 'image',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'nano-banana-pro', options: IMAGE_MODEL_LIST.map((m) => ({ value: m.id, label: m.label })) },
      {
        name: 'server',
        label: 'Máy chủ / Chế độ',
        type: 'select',
        showIf: { field: 'model', in: IMAGE_MODEL_LIST.filter((m) => m.servers && m.servers.length > 1).map((m) => m.id) },
        optionsBy: {
          field: 'model',
          map: Object.fromEntries(IMAGE_MODEL_LIST.filter((m) => m.servers).map((m) => [m.id, m.servers!.map((s) => ({ value: s.id, label: s.label }))])),
        },
      },
      { name: 'prompt', label: 'Mô tả (prompt)', type: 'textarea', required: true, placeholder: 'Mô tả chi tiết bức ảnh bạn muốn tạo...' },
      {
        name: 'refs',
        label: 'Ảnh tham chiếu (tuỳ chọn)',
        type: 'image',
        multiple: true,
        maxFiles: MAX_IMAGE_REFS,
        accept: 'image/png,image/jpeg,image/webp',
        showIf: { field: 'model', in: IMAGE_MODEL_LIST.filter((m) => m.refs > 0).map((m) => m.id) },
        help: 'Số ảnh tối đa tuỳ model: Nano Banana 2.1 tới 12 ảnh, GPT Image 2.6 tới 16 ảnh, GPT Image 2 tới 8 ảnh',
      },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, optionsBy: { field: 'model', map: Object.fromEntries(IMAGE_MODEL_LIST.map((m) => [m.id, m.ratios.map((r) => ({ value: r, label: ratioLabel(r) }))])) } },
      { name: 'resolution', label: 'Độ phân giải', type: 'select', optionsBy: { field: 'model', map: Object.fromEntries(IMAGE_MODEL_LIST.map((m) => [m.id, m.res.map((r) => ({ value: r, label: r.toUpperCase() }))])) } },
      { name: 'count', label: 'Số lượng ảnh', type: 'select', default: '1', options: opts([['1', '×1'], ['2', '×2'], ['3', '×3'], ['4', '×4']]), help: 'Tạo 1–4 ảnh cùng lúc, giá nhân theo số ảnh' },
      { name: 'removeLogo', label: 'Xoá logo', type: 'boolean', default: false, showIf: { field: 'model', in: IMAGE_MODEL_LIST.filter((m) => m.noLogo).map((m) => m.id) }, help: 'Tự xoá logo / watermark trên ảnh kết quả (không tính thêm)' },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
    unitLabel: 'ảnh',
    units: (input) => Math.min(4, Math.max(1, Math.floor(Number(input.count) || 1))),
  },
  {
    key: 'upscale-image',
    name: 'Làm nét ảnh 4K AI',
    category: 'chinh-sua-anh-ai',
    icon: 'sparkles',
    badge: 'NEW',
    description: 'Phóng to và khôi phục độ sắc nét ảnh lên chuẩn 2K / 4K Ultra HD với 5 chế độ chuyên biệt (Giữ khuôn mặt, Siêu tốc, Đa dụng, Chữ sắc nét, Anime).',
    output: 'image',
    fields: [
      {
        name: 'model',
        label: 'Model AI',
        type: 'select',
        required: true,
        default: 'kapend_upscale_fast',
        options: IMAGE_UPSCALE_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
      },
      {
        name: 'image',
        label: 'Ảnh gốc cần làm nét',
        type: 'image',
        required: true,
        accept: 'image/png,image/jpeg,image/webp',
        help: 'Tải lên ảnh mờ, vỡ hạt hoặc độ phân giải thấp (PNG, JPG, WEBP) — giữ nguyên 100% bố cục và tỉ lệ ảnh gốc',
      },
      {
        name: 'resolution',
        label: 'Độ phân giải xuất ảnh',
        type: 'select',
        required: true,
        default: '4k',
        options: opts([
          ['4k', '4K Ultra HD (Nét gấp 4×)'],
          ['2k', '2K QHD (Nét gấp 2×)'],
        ]),
      },
    ],
    pricing: { mode: 'cost', markup: 38, min: 100 },
    supportsCost: true,
    unitLabel: 'ảnh',
    units: () => 1,
  },
  {
    key: 'video',
    name: 'Tạo video đa model',
    category: 'video',
    icon: 'video',
    featured: true,
    description: 'Google Omni 1.1 & 1.2 Flash, VEO 3.1, Grok Video 1.5 / v3, MiniMax H3, Wan 3.0 — từ mô tả, ảnh hoặc video tham chiếu.',
    output: 'video',
    fields: [
      ...videoFields(MULTI_MODELS, MULTI_MODELS[0].id),
      { name: 'mode', label: 'Mức chất lượng VEO', type: 'select', default: 'lite', showIf: { field: 'model', in: [VEO31] }, options: opts([['lite', 'Lite (tiết kiệm)'], ['fast', 'Fast'], ['quality', 'Quality (cao nhất)']]) },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
    unitLabel: 'giây',
    units: (input) => (Number(input.duration) || 5) * videoCount(input),
  },
  {
    key: 'seedance',
    name: 'Seedance Video',
    category: 'video',
    icon: 'film',
    badge: 'NEW',
    featured: true,
    description: 'Seedance 2.5 (VIP 2 siêu tiết kiệm), Seedance 2.5 Flash, 2.0 Fast, 2.0 Mini, 2.0 — từ mô tả, ảnh, âm thanh hoặc video tham chiếu.',
    output: 'video',
    fields: videoFields(SEEDANCE_MODELS, 'seedance_2_5', [
      { name: 'audio', label: 'Tạo kèm âm thanh', type: 'boolean', default: true },
    ]),
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
    unitLabel: 'giây',
    units: (input) => (Number(input.duration) || 5) * videoCount(input),
  },
  {
    key: 'kling',
    name: 'Kling AI Video',
    category: 'video',
    icon: 'clapperboard',
    badge: 'NEW',
    description: 'Kling 4.0 Omni Flash, 4.0 Flash, 4.0, 4.0 Omni, 3.0 Omni, 3.0 Omni Edit, 2.6, 2.5 Turbo — từ mô tả, ảnh hoặc video tham chiếu.',
    output: 'video',
    fields: videoFields(KLING_MODELS, KLING_MODELS[0].id).map((f) =>
      f.name === 'video'
        ? { ...f, help: '3.0 Omni Edit: bắt buộc (video cần chỉnh). 4.0 Omni / Omni Flash: tuỳ chọn 3–30 giây (thời lượng kết quả lấy theo video)' }
        : f.name === 'model'
          ? { ...f, help: KLING_HINT.kling }
          : f,
    ),
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
    unitLabel: 'giây',
    units: (input) => (Number(input.duration) || 5) * videoCount(input),
  },
  {
    key: 'avatar',
    name: 'Kling Avatar',
    category: 'video',
    icon: 'user-round',
    badge: 'NEW',
    description: 'Ảnh khuôn mặt + file giọng nói → video người nói khớp khẩu hình tự nhiên (tối đa 120 giây).',
    output: 'video',
    fields: [
      { name: 'image', label: 'Ảnh khuôn mặt', type: 'image', required: true, accept: 'image/png,image/jpeg,image/webp', help: KLING_HINT.avatar },
      { name: 'audio', label: 'File giọng nói', type: 'audio', required: true, accept: 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a', help: 'MP3 / WAV / M4A, tối đa 120 giây — thời lượng video = độ dài giọng' },
      { name: 'quality', label: 'Chất lượng', type: 'select', default: '720p', options: opts([['720p', '720p'], ['1080p', '1080p']]) },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: RATIOS.slice(0, 3) },
      VIDEO_COUNT_FIELD,
      { name: 'prompt', label: 'Mô tả thêm (tuỳ chọn)', type: 'textarea', placeholder: 'Biểu cảm, cử chỉ, phong cách...' },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
  },
  {
    key: 'motion',
    name: 'Kling Motion Control',
    category: 'video',
    icon: 'person-standing',
    description: 'Nhân vật trong ảnh chuyển động theo video mẫu (Kling 3.0 & 2.6).',
    output: 'video',
    fields: [
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'kling_video_motion_3', options: opts([['kling_video_motion_3', 'Kling 3.0 - Motion Control'], ['kling_video_motion', 'Kling 2.6 - Motion Control']]), help: KLING_HINT.motion },
      { name: 'image', label: 'Ảnh nhân vật', type: 'image', required: true, accept: 'image/png,image/jpeg,image/webp' },
      { name: 'video', label: 'Video chuyển động mẫu', type: 'video', required: true, accept: 'video/mp4,video/quicktime', help: 'Video 720p trở lên, tối đa 30 giây — thời lượng & tỉ lệ lấy theo video' },
      { name: 'quality', label: 'Chất lượng', type: 'select', default: '720p', options: opts([['720p', '720p'], ['1080p', '1080p']]) },
      { name: 'prompt', label: 'Mô tả thêm (tuỳ chọn)', type: 'textarea' },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
  },
  {
    key: 'upscale-video',
    name: 'Nâng cấp video Topaz',
    category: 'voice',
    icon: 'monitor-up',
    description: 'Làm nét, khử nhiễu, nâng video lên 1080p / 2K / 4K bằng Topaz AI (Upscale MaxX tới 5 phút & Upscale Max).',
    output: 'video',
    fields: [
      { name: 'video', label: 'Video cần nâng cấp', type: 'video', required: true, accept: 'video/mp4,video/quicktime', help: 'Upscale MaxX nhận video tới 5 phút (nguồn ≤ 1080p); Upscale Max nhận video tối đa 40 giây' },
      { name: 'model', label: 'Model AI', type: 'select', required: true, default: 'topaz_upscale_maxx', options: TOPAZ_MODELS.map(([v, l]) => ({ value: v, label: l })) },
      {
        name: 'engine',
        label: 'Chế độ xử lý',
        type: 'select',
        required: true,
        showIf: { field: 'model', in: TOPAZ_MODELS.filter((m) => m[3].length).map((m) => m[0]) },
        optionsBy: { field: 'model', map: Object.fromEntries(TOPAZ_MODELS.map(([v, , , e]) => [v, opts(e)])) },
        help: 'Cả 3 chế độ Tiêu chuẩn / Nâng cao / Siêu nét của Topaz MaxX đều đồng giá theo giây',
      },
      { name: 'quality', label: 'Độ phân giải đích', type: 'select', required: true, optionsBy: { field: 'model', map: Object.fromEntries(TOPAZ_MODELS.map(([v, , q]) => [v, q.map((x) => ({ value: x, label: x }))])) } },
    ],
    pricing: { mode: 'cost', markup: 38 },
    supportsCost: true,
  },
  {
    key: 'voice',
    name: 'Giọng đọc AI Đa năng (248 giọng)',
    category: 'giong-noi-ai',
    icon: 'mic',
    badge: 'NEW',
    splitModels: false,
    description: 'Kho 248 giọng đọc AI chọn lọc (56 giọng Việt truyền cảm + 12 ngôn ngữ), hỗ trợ kịch bản dài tới 100.000 ký tự và chèn nhịp nghỉ [delay=1.5s].',
    output: 'audio',
    fields: [
      {
        name: 'voice',
        label: 'Giọng đọc AI',
        type: 'select',
        picker: 'voice',
        preview: '/api/public/ai/voice-preview/kapend/{value}',
        required: true,
        default: FALLBACK_KAPEND_VOICES[0].value,
        options: FALLBACK_KAPEND_VOICES,
      },
      {
        name: 'text',
        label: 'Văn bản cần đọc',
        type: 'textarea',
        required: true,
        max: 100_000,
        placeholder: 'Nhập hoặc dán kịch bản cần đọc (có thể chèn [delay=1.5s] để ngắt nghỉ)...',
        help: 'Hỗ trợ tới 100.000 ký tự (riêng nhóm giọng CapCut giới hạn 5.000 ký tự mỗi lượt).',
      },
      {
        name: 'speed',
        label: 'Tốc độ đọc',
        type: 'number',
        default: 1,
        min: 0.5,
        max: 2.0,
        step: 0.05,
        help: '0.5 = chậm, 1.0 = tự nhiên, 2.0 = nhanh tối đa',
      },
    ],
    pricing: { mode: 'cost', markup: 38, min: 100 },
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    costPerUnit: 200,
    units: (input) => Math.max(0, charCount(input, 'text')) / 1000,
  },
  {
    key: 'tts',
    name: 'Giọng đọc CapCut Đa Ngôn Ngữ',
    category: 'giong-noi-ai',
    icon: 'audio-lines',
    splitModels: false,
    description: 'Trọn bộ 145 giọng đọc CapCut quen thuộc (Tiếng Việt, Anh, Trung, Nhật, Thái, Indonesia...), trả file MP3 tức thì.',
    output: 'audio',
    fields: [
      {
        name: 'speaker',
        label: 'Giọng đọc CapCut',
        type: 'select',
        picker: 'voice',
        preview: '/api/public/ai/voice-preview/kapend/{value}',
        required: true,
        default: FALLBACK_CAPCUT_VOICES[0].value,
        options: FALLBACK_CAPCUT_VOICES,
      },
      { name: 'text', label: 'Văn bản', type: 'textarea', required: true, max: 5000, placeholder: 'Nhập nội dung cần đọc (tối đa 5.000 ký tự)...' },
      { name: 'voice', label: 'Mã giọng khác (không bắt buộc)', type: 'text', max: 80, placeholder: 'vd BV421_vivn_streaming', help: 'Bỏ trống để dùng giọng đã chọn ở trên' },
      { name: 'speed', label: 'Tốc độ', type: 'number', default: 1, min: 0.7, max: 1.5, step: 0.1, help: '0.7 = chậm, 1 = tự nhiên, 1.5 = nhanh' },
    ],
    pricing: { mode: 'per_char', base: 0, perUnit: 150, min: 100 },
    supportsCost: true,
    unitLabel: '1.000 ký tự',
    units: (input) => Math.max(0, charCount(input, 'text')) / 1000,
  },
  {
    key: 'remove-logo',
    name: 'Xoá logo Veo / Flow / NotebookLM',
    category: 'cong-cu-mien-phi',
    icon: 'eraser',
    description: 'Tự động nhận diện và xoá sạch logo / watermark của Google Veo, Flow & NotebookLM trên ảnh hoặc video giữ nguyên chất lượng.',
    output: 'video',
    fields: [
      {
        name: 'file',
        label: 'Ảnh hoặc video cần xoá logo',
        type: 'file',
        required: true,
        accept: 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm',
        help: 'Chuyên nhận diện watermark của Veo / Flow / NotebookLM · Ảnh ≤ 20MB, video ≤ 200MB',
      },
    ],
    pricing: { mode: 'free', min: 0 },
    supportsCost: true,
  },
];

const LOGO = 'logo:';
const JOB_SEP = ',';

const ERRORS: Record<string, string> = {
  plan_required: 'Tài khoản nguồn chưa đủ gói để dùng tính năng này',
  not_enough_credits: 'Hệ thống tạm hết hạn mức xử lý, vui lòng thử lại sau ít phút',
  blocked_content: 'Nội dung mô tả hoặc hình ảnh chứa yếu tố bị bộ lọc kiểm duyệt từ chối, vui lòng điều chỉnh lại',
  safety_filter: 'Nội dung bị bộ lọc an toàn từ chối, vui lòng điều chỉnh lại mô tả hoặc ảnh đầu vào',
  nsfw_detected: 'Nội dung nhạy cảm bị từ chối xử lý, vui lòng điều chỉnh lại',
  content_generation_failed: 'Máy chủ AI không tạo được kết quả ở lượt này, vui lòng thử lại — tiền đã được hoàn lại',
  omni_vip1_out_of_resources: 'Máy chủ VIP 1 đang quá tải tài nguyên tạm thời, vui lòng chọn máy chủ VIP 2 / VIP 3 hoặc thử lại sau ít phút — tiền đã được hoàn lại',
  out_of_resources: 'Máy chủ xử lý đang quá tải tạm thời, vui lòng chọn máy chủ khác hoặc thử lại sau ít phút — tiền đã được hoàn lại',
  upstream_busy: 'Máy chủ AI đang bận tạm thời, vui lòng thử lại sau ít phút — tiền đã được hoàn lại',
  invalid_model: 'Model không hợp lệ',
  model_disabled: 'Model đang tạm bảo trì ở máy chủ nguồn, vui lòng chọn model hoặc máy chủ khác',
  invalid_duration: 'Thời lượng không hợp lệ với chế độ / máy chủ của model này',
  invalid_aspect_ratio: 'Tỉ lệ khung hình không được hỗ trợ trên model / máy chủ này',
  invalid_quality: 'Độ phân giải không được hỗ trợ trên chế độ này, vui lòng chọn độ phân giải thấp hơn',
  audio_too_long: 'File âm thanh vượt quá độ dài tối đa cho phép (120 giây)',
  video_too_long: 'Video đầu vào vượt quá thời lượng tối đa của model này',
  stream_limit_exceeded: 'Hệ thống đang xử lý tối đa số luồng, vui lòng thử lại sau ít giây',
  watermark_not_detected: 'Không phát hiện logo Veo / Flow / NotebookLM trong file này',
  upscale_requires_image: 'Vui lòng tải lên ảnh gốc cần làm nét',
  voice_not_found: 'Giọng đọc đã chọn không hợp lệ, vui lòng chọn giọng khác',
  missing_text: 'Vui lòng nhập nội dung văn bản cần đọc',
};

function normalizeKapendError(rawErr: unknown, fallbackJob?: unknown): string | undefined {
  const s = typeof rawErr === 'string' ? rawErr.trim() : '';
  if (s && ERRORS[s]) return ERRORS[s];
  if (s && /_out_of_resources$/i.test(s)) {
    return 'Máy chủ đã chọn đang quá tải tài nguyên tạm thời, vui lòng chọn máy chủ VIP khác hoặc thử lại sau ít phút — tiền đã được hoàn lại';
  }
  const msg = s || pickMessage(fallbackJob);
  if (!msg) return undefined;
  if (/content generation failed/i.test(msg)) {
    return 'Máy chủ AI không tạo được kết quả ở lượt này (có thể do ảnh/mô tả vướng bộ lọc hoặc nghẽn luồng), vui lòng thử lại — tiền đã được hoàn lại';
  }
  if (/out[_\s-]*of[_\s-]*resources/i.test(msg)) {
    return 'Máy chủ xử lý đang quá tải tài nguyên tạm thời, vui lòng chọn máy chủ VIP khác hoặc thử lại sau ít phút — tiền đã được hoàn lại';
  }
  if (/fl mode supports up to 10 seconds/i.test(msg)) {
    return 'Máy chủ VIP 1 ở chế độ 2 ảnh (Khung đầu – Khung cuối) chỉ hỗ trợ tối đa 10 giây. Hãy chọn ≤ 10s hoặc chuyển sang VIP 2.';
  }
  return msg.replace(/\bkapend(?:\.com)?\b/gi, 'Hệ thống AI');
}

async function call<T = any>(ctx: AiCallContext, path: string, json?: unknown, timeoutMs?: number): Promise<T> {
  try {
    // Các endpoint tạo ảnh/video/giọng nói có thể chạy đồng bộ 35–110 giây trước khi trả kết quả -> nâng timeout mặc định POST lên 120s (`T-329`)
    const effectiveTimeout = timeoutMs ?? (json !== undefined ? 120_000 : 45_000);
    return await providerFetch<T>(ctx.config, path, json === undefined ? { timeoutMs: effectiveTimeout } : { json, timeoutMs: effectiveTimeout });
  } catch (err) {
    if (err instanceof AiProviderError) {
      const errData = (err.raw as { data?: { error?: string; message?: string } } | undefined)?.data;
      const code = errData?.error;
      const mapped = normalizeKapendError(code, errData);
      if (mapped) {
        throw new AiProviderError(mapped, err.raw, code === 'stream_limit_exceeded' || code === 'not_enough_credits');
      }
    }
    throw err;
  }
}

interface DiscountRule {
  media: 'image' | 'video';
  modelId: string;
  modes?: string[];
  percent: number;
  startsAt?: number | null;
  endsAt?: number | null;
  enabled?: boolean;
}

interface CatalogVoiceItem {
  id: string;
  name: string;
  server?: string;
  gender?: 'male' | 'female' | 'neutral';
  lang?: string;
  x2?: boolean;
  pricePer1k?: number;
  maxChars?: number;
}

interface CatalogEntry {
  type: 'image' | 'video' | 'voice';
  id: string;
  label?: string;
  prices?: {
    mode?: string;
    resolution?: string;
    quality?: string;
    duration?: number;
    credits?: number;
    perSecCredits?: number;
  }[];
  voices?: CatalogVoiceItem[];
}

interface KapendCatalogState {
  at: number;
  base: string;
  costs: Record<string, number>;
  disabled: Set<string>;
  references: Record<string, { images?: boolean; videos?: boolean; audios?: boolean }>;
  discounts: DiscountRule[];
  itemsById: Map<string, CatalogEntry>;
  kapendVoiceOptions: AiFieldOption[];
  capcutVoiceOptions: AiFieldOption[];
  voiceMetaById: Map<string, CatalogVoiceItem>;
}

let catalogCache: KapendCatalogState | null = null;
const globalVoiceMeta = new Map<string, CatalogVoiceItem>();

const SERVER_GROUP_LABEL: Record<string, string> = {
  tuyen_chon: 'Tuyển chọn',
  vbee: 'Studio Pro',
  basic: 'Giọng Cơ Bản',
  foreign: 'Ngoại ngữ',
  capcut: 'CapCut',
};

function applyDiscount(baseCredits: number, rules: DiscountRule[], media: 'image' | 'video', modelId: string, mode?: string): number {
  const clean = Math.max(0, Math.floor(baseCredits || 0));
  if (clean <= 0 || !rules.length) return clean;
  const now = Date.now();
  let bestPct = 0;
  for (const r of rules) {
    if (r.enabled === false) continue;
    const pct = Math.max(0, Math.min(90, Math.floor(Number(r.percent) || 0)));
    if (pct <= 0) continue;
    if (typeof r.startsAt === 'number' && Number.isFinite(r.startsAt) && now < r.startsAt) continue;
    if (typeof r.endsAt === 'number' && Number.isFinite(r.endsAt) && now >= r.endsAt) continue;
    if (r.media !== media) continue;
    const normRuleId = r.modelId === 'imagegen_2_0_fashion' ? 'imagegen_2_0' : r.modelId;
    if (normRuleId !== modelId) continue;
    if (r.modelId === 'imagegen_2_0_fashion' && mode && !mode.startsWith('fashion_')) continue;
    if (Array.isArray(r.modes) && r.modes.length > 0 && mode && !r.modes.includes(mode)) continue;
    if (pct > bestPct) bestPct = pct;
  }
  return bestPct > 0 ? Math.max(0, Math.floor((clean * (100 - bestPct)) / 100)) : clean;
}

async function catalog(ctx: AiCallContext, force = false): Promise<KapendCatalogState> {
  if (!force && catalogCache && catalogCache.base === ctx.config.baseUrl && Date.now() - catalogCache.at < 600_000) {
    return catalogCache;
  }
  try {
    const [costs, vis, v1Cat] = await Promise.all([
      providerFetch<Record<string, number>>(ctx.config, '/api/config/credit-costs', { timeoutMs: 20_000 }).catch(() => ({} as Record<string, number>)),
      providerFetch<{
        items?: { id: string; enabled: boolean }[];
        references?: Record<string, { images?: boolean; videos?: boolean; audios?: boolean }>;
      }>(ctx.config, '/api/config/model-visibility', { timeoutMs: 20_000 }).catch(() => ({
        items: [] as { id: string; enabled: boolean }[],
        references: {} as Record<string, { images?: boolean; videos?: boolean; audios?: boolean }>,
      })),
      providerFetch<{
        items?: CatalogEntry[];
        image?: CatalogEntry[];
        video?: CatalogEntry[];
        voice?: CatalogEntry[];
        discounts?: DiscountRule[];
      }>(ctx.config, '/api/v1/catalog', { timeoutMs: 25_000 }).catch(() => ({
        items: [],
        image: [],
        video: [],
        voice: [],
        discounts: [],
      })),
    ]);

    const disabled = new Set((vis?.items ?? []).filter((i) => i.enabled === false).map((i) => i.id));
    const references = vis?.references && typeof vis.references === 'object' ? vis.references : {};
    const discounts = Array.isArray(v1Cat?.discounts) ? v1Cat.discounts : [];
    const itemsById = new Map<string, CatalogEntry>();
    for (const item of [...(v1Cat?.items ?? []), ...(v1Cat?.image ?? []), ...(v1Cat?.video ?? []), ...(v1Cat?.voice ?? [])]) {
      if (item?.id) itemsById.set(item.id, item);
    }

    const voiceMetaById = new Map<string, CatalogVoiceItem>();
    const kapendVoiceEntry = itemsById.get('kapend-voice');
    const kapendVoiceOptions: AiFieldOption[] = [];
    for (const v of kapendVoiceEntry?.voices ?? []) {
      if (!v?.id || !v?.name) continue;
      voiceMetaById.set(v.id, v);
      globalVoiceMeta.set(v.id, v);
      const groupTag = v.server ? (SERVER_GROUP_LABEL[v.server] ?? v.server) : undefined;
      const badge = v.pricePer1k === 0 ? 'Miễn phí gốc' : v.x2 ? 'Cao cấp ×2' : undefined;
      kapendVoiceOptions.push({
        value: v.id,
        label: v.name,
        gender: v.gender === 'male' ? 'male' : v.gender === 'female' ? 'female' : 'neutral',
        langs: [str(v.lang || 'vi').toLowerCase()],
        ...(groupTag ? { tags: [groupTag] } : {}),
        ...(badge ? { badge } : {}),
      });
    }

    const capcutEntry = itemsById.get('capcut-tts');
    const capcutVoiceOptions: AiFieldOption[] = [];
    const rawCapcut = capcutEntry?.voices?.length
      ? capcutEntry.voices
      : (kapendVoiceEntry?.voices ?? []).filter((v) => v.server === 'capcut');
    for (const v of rawCapcut) {
      if (!v?.id || !v?.name) continue;
      const cleanId = v.id.startsWith('capcut:') ? v.id.slice(7) : v.id;
      voiceMetaById.set(cleanId, v);
      globalVoiceMeta.set(cleanId, v);
      capcutVoiceOptions.push({
        value: cleanId,
        label: v.name,
        gender: v.gender === 'male' ? 'male' : v.gender === 'female' ? 'female' : 'neutral',
        langs: [str(v.lang || 'vi').toLowerCase()],
      });
    }

    catalogCache = {
      at: Date.now(),
      base: ctx.config.baseUrl,
      costs: costs ?? {},
      disabled,
      references,
      discounts,
      itemsById,
      kapendVoiceOptions: kapendVoiceOptions.length ? kapendVoiceOptions : FALLBACK_KAPEND_VOICES,
      capcutVoiceOptions: capcutVoiceOptions.length ? capcutVoiceOptions : FALLBACK_CAPCUT_VOICES,
      voiceMetaById,
    };
  } catch (err) {
    if (!catalogCache) throw err;
  }
  return catalogCache!;
}

function imagePrice(input: AiInput, cat: KapendCatalogState): number | null {
  const img = resolveImage(input);
  const res = img.resolution.toLowerCase();
  const mode = img.mode ?? '';

  // 1) Ưu tiên bảng giá chuẩn trực tiếp từ `/api/v1/catalog` (giá trong v1/catalog đã trừ khuyến mãi)
  const catItem = cat.itemsById.get(img.id);
  if (catItem?.prices?.length) {
    const matched =
      catItem.prices.find((p) => (!mode || p.mode === mode) && (!p.resolution || p.resolution.toLowerCase() === res)) ??
      catItem.prices.find((p) => !p.mode && (!p.resolution || p.resolution.toLowerCase() === res));
    if (matched && typeof matched.credits === 'number') {
      return matched.credits * img.count;
    }
  }

  // 2) Dự phòng từ `/api/config/credit-costs` hoặc `IMAGE_MODEL_LIST`
  const key = `image_${img.id.replace(/[-.]/g, '_')}`;
  const keys = mode && mode !== 'vip1' ? [`${key}_${res}_${mode}`, `${key}_${mode}`] : [`${key}_${res}`, `${key}_flat`];
  const found = keys.find((k) => typeof cat.costs[k] === 'number');
  const rawOne = found ? cat.costs[found] : img.price?.[res];
  if (rawOne == null) return null;
  return applyDiscount(rawOne, cat.discounts, 'image', img.id, mode) * img.count;
}

function upscaleImagePrice(input: AiInput, cat: KapendCatalogState): number | null {
  const modelId = str(input.model) || 'kapend_upscale_fast';
  const spec = IMAGE_UPSCALE_MAP.get(modelId);
  if (!spec) throw new BadRequestException('Chế độ làm nét ảnh không hợp lệ');
  const res = str(input.resolution).toLowerCase() === '2k' ? '2k' : '4k';
  const catItem = cat.itemsById.get(modelId);
  const matched = catItem?.prices?.find((p) => !p.resolution || p.resolution.toLowerCase() === res);
  if (typeof matched?.credits === 'number') return matched.credits;
  return applyDiscount(spec.fallbackCost, cat.discounts, 'image', modelId);
}

const kling26CreditCostMode = (quality: string) => (quality === '1080p' ? 'professional' : 'standard');
const kling26CatalogMode = (quality: string) => (quality === '1080p' ? 'vip2' : 'vip1');
const omniV2Mode = (imagesCount: number, hasVideo = false) =>
  hasVideo ? 'v2v' : imagesCount > 1 ? 'r2v' : imagesCount === 1 ? 'i2v' : 't2v';

function lookupVideoPrice(variant: string, input: AiInput, duration: number, cat: KapendCatalogState): number | undefined {
  const qRaw = str(input.quality);
  const qLower = qRaw.toLowerCase();
  const imgsCount = Array.isArray(input.images) ? input.images.length : 0;
  const mode =
    variant === VEO31
      ? str(input.mode) || 'lite'
      : variant === 'kling_video_2_6'
        ? kling26CatalogMode(qRaw)
        : variant === 'veo_omniv2'
          ? omniV2Mode(imgsCount, Boolean(input.video))
          : undefined;

  // 1) Ưu tiên bảng giá chuẩn trực tiếp từ `/api/v1/catalog` (giá trong v1/catalog đã áp sẵn khuyến mãi)
  const catItem = cat.itemsById.get(variant);
  if (catItem?.prices?.length) {
    const hit = catItem.prices.find(
      (p) =>
        (!mode || !p.mode || p.mode === mode) &&
        (!p.quality || p.quality.toLowerCase() === qLower) &&
        (p.duration === undefined || p.duration === duration),
    );
    if (hit && typeof hit.credits === 'number') {
      return hit.credits;
    }
  }

  // 2) Dự phòng từ `/api/config/credit-costs`
  const keys =
    variant === 'kling_video_2_6'
      ? [`video_kling_video_2_6_${kling26CreditCostMode(qLower)}_${duration}s`, `video_kling_video_2_6_${kling26CatalogMode(qLower)}_${duration}s`]
      : variant === VEO31
        ? [`video_veo_3_1_${mode}_${qLower}_${duration}s`, `video_veo_3_1_${qLower}_${duration}s`]
        : variant === 'veo_omniv2'
          ? [`video_veo_omniv2_${mode}_${qLower}_${duration}s`, `video_veo_omniv2_${qLower}_${duration}s`]
          : [`video_${variant.replace(/[-.]/g, '_')}_${qLower}_${duration}s`];

  const found = keys.map((k) => cat.costs[k]).find((v) => typeof v === 'number');
  if (found !== undefined) {
    return applyDiscount(found, cat.discounts, 'video', variant, mode);
  }
  return undefined;
}

async function uploadSeconds(ctx: AiCallContext, url: unknown, fallbackExternalSec?: number): Promise<number | null> {
  if (!url) return null;
  const rawUrl = str(url).trim();
  if (!rawUrl) return null;
  const sec = await ctx.uploadDuration(rawUrl);
  if (sec !== null && Number.isFinite(sec) && sec > 0) {
    return Math.ceil(sec);
  }
  if (/^https?:\/\//i.test(rawUrl) && fallbackExternalSec && fallbackExternalSec > 0) {
    return Math.ceil(fallbackExternalSec);
  }
  throw new BadRequestException('Không đọc được độ dài file, vui lòng dùng MP4 / MOV (video) hoặc MP3 / WAV / M4A (âm thanh)');
}

async function resolveVideo(tool: AiToolDef, input: AiInput, ctx: AiCallContext) {
  const model = MODELS_BY_TOOL[tool.key]?.find((m) => m.id === str(input.model));
  if (!model) throw new BadRequestException('Model không hợp lệ');
  const picked = model.servers?.find((sv) => sv.id === str(input.server));
  const limit = picked ?? model;
  const name = picked ? `${model.label} ${picked.label}` : model.label;
  const images = Array.isArray(input.images) ? input.images.length : 0;
  const audios = Array.isArray(input.audios) ? input.audios.length : input.audios ? 1 : 0;

  if (images > limit.images) throw new BadRequestException(limit.images ? `${name} nhận tối đa ${limit.images} ảnh` : `${name} không nhận ảnh`);
  if (input.video && !limit.video) throw new BadRequestException(`${name} không nhận video tham chiếu`);
  if (audios > (limit.audios ?? 0)) throw new BadRequestException(`${name} không nhận âm thanh tham chiếu vượt giới hạn`);

  if (model.id === 'grok_video_15' && images >= 2 && str(input.quality) === '1080p') {
    throw new BadRequestException('Ảnh tham chiếu nhiều tấm chỉ tạo được tối đa 720p. Hãy chọn 720p hoặc 480p, hoặc chỉ dùng 1 ảnh làm khung đầu.');
  }
  if (model.id === 'grok_videov3' && images >= 2 && Number(input.duration) > 10) {
    throw new BadRequestException('Grok Video v3 khi tải từ 2 ảnh tham chiếu trở lên chỉ hỗ trợ thời lượng tối đa 10 giây (6s hoặc 10s).');
  }

  const reqDur = Number(input.duration) || 0;
  const reqQuality = str(input.quality);
  const hasVideoRef = Boolean(input.video);
  const isOmni11Vip1V2vInvalid = hasVideoRef && (reqQuality === '360p' || reqQuality === '4K');
  const isOmni12Vip1Invalid = (dur: number) =>
    ((images === 2 || hasVideoRef) && dur > 10) || (hasVideoRef && reqQuality === '4K');

  if (model.id === 'veo_omni' && hasVideoRef && input.__sample !== true) {
    if (reqQuality === '360p') {
      throw new BadRequestException(
        'Google Omni 1.1 Flash khi kèm video tham chiếu chỉ hỗ trợ chất lượng 720p, 1080p hoặc 4K, không hỗ trợ 360p. Vui lòng chọn từ 720p trở lên.',
      );
    }
  }

  const cat = await catalog(ctx);
  const isSample = input.__sample === true;
  // T-417: Nếu khách chọn VIP 1 nhưng cấu hình rơi vào tổ hợp chỉ VIP 2 mới hỗ trợ (vd 4K kèm video tham chiếu hoặc >10s), tự động chuyển tiếp mượt sang VIP 2 không báo lỗi
  const autoUpgradeOmniVip2 =
    !isSample &&
    ((picked?.id === 'veo_omni' && isOmni11Vip1V2vInvalid) ||
      (picked?.id === 'veo_omni12_vip1' && isOmni12Vip1Invalid(reqDur)));
  const effectivePicked = autoUpgradeOmniVip2 ? undefined : picked;
  const candidates =
    effectivePicked && !(isSample && cat.disabled.has(effectivePicked.id))
      ? [effectivePicked.id]
      : (model.variants ?? [model.id]);
  const quality = str(input.quality);

  for (const variant of candidates) {
    if (cat.disabled.has(variant)) continue;
    const refRule = cat.references[variant];
    if (input.video && refRule?.videos === false) continue;
    if (audios > 0 && refRule?.audios === false) continue;
    if (images > 0 && refRule?.images === false) continue;

    const sv = model.servers?.find((x) => x.id === variant);
    const allowedDurations = sv?.durations ?? model.durations;
    let duration = Number(input.duration) || allowedDurations[0];
    if (sv && isSample && !sv.durations.includes(duration)) {
      duration = sv.durations[0];
    }
    if (input.video && !isSample) {
      const sec = (await uploadSeconds(ctx, input.video, Number(input.duration) || 10))!;
      const refCap =
        variant === 'wan_3_0'
          ? { min: 1, max: 30 }
          : variant.startsWith('kling_video_4_0')
            ? { min: 3, max: 30 }
            : variant === 'minimax_h3'
              ? { min: 2, max: 15 }
              : variant === 'veo_omni' || variant === 'veo_omni12_vip1'
                ? { min: 3, max: 10 }
                : { min: 2, max: 15 };
      if (sec < refCap.min || sec > refCap.max) {
        if (!effectivePicked || variant !== effectivePicked.id) continue;
        throw new BadRequestException(`Video tham chiếu của ${name} phải có độ dài từ ${refCap.min}–${refCap.max} giây`);
      }
      if (VIDEO_FOLLOWS_REF_DURATION.includes(variant)) {
        // Làm tròn lên mốc thời lượng gần nhất được model hỗ trợ (vd 7s trên Kling 4.0 Omni -> mốc 8s) khớp chuẩn nguồn
        duration = allowedDurations.find((d) => d >= sec) ?? allowedDurations[allowedDurations.length - 1];
      }
    }

    if (sv && (!effectivePicked || variant !== effectivePicked.id)) {
      if (
        !sv.qualities.includes(quality) ||
        !sv.durations.includes(duration) ||
        images > sv.images ||
        (input.video && !sv.video) ||
        audios > (sv.audios ?? 0) ||
        (variant === 'veo_omni' && !isSample && isOmni11Vip1V2vInvalid) ||
        (variant === 'veo_omni12_vip1' && !isSample && isOmni12Vip1Invalid(duration))
      ) {
        continue;
      }
    }

    const price = lookupVideoPrice(variant, input, duration, cat);
    if (price !== undefined) return { model, variant, duration, price, reason: '' };
  }

  const reason =
    picked && cat.disabled.has(picked.id)
      ? `Máy chủ ${picked.label} của ${model.label} đang tạm ngưng, vui lòng chọn máy chủ khác hoặc "Tự động"`
      : picked && input.video && cat.references[picked.id]?.videos === false
        ? `Máy chủ ${picked.label} đang tạm khoá video tham chiếu, vui lòng bỏ video tham chiếu hoặc chọn máy chủ khác`
        : 'Model này hiện tạm ngưng hoặc không hỗ trợ lựa chọn này, vui lòng chọn model / máy chủ khác';
  return { model, variant: null, duration: Number(input.duration) || model.durations[0], price: null, reason };
}

function jobIdOf(res: any): string {
  const id = res?.jobId ?? res?.data?.jobId ?? res?.id ?? res?.data?.id;
  if (!id) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', res);
  return String(id);
}

/**
 * Xử lý linh hoạt phản hồi tạo/làm nét ảnh từ nguồn:
 * - Một số model siêu tốc (`kapend_upscale_fast`, `kapend_upscale_*`...) trả thẳng mảng `images` hoàn chỉnh ngay lập tức không qua `jobId` bất đồng bộ;
 * - Nếu chưa có file ngay thì lấy `jobId` để hỏi trạng thái nền như bình thường.
 */
function submitImageOrImmediate(res: any, tool: AiToolDef, prefix: string): AiProviderResult {
  const payload = res?.data && typeof res.data === 'object' ? res.data : res;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
  const immediateUrls = [
    ...new Set([
      ...arr(payload?.images),
      ...arr(payload?.resultUrls),
      ...arr(payload?.result),
      ...(typeof payload?.url === 'string' && payload.url.trim() ? [payload.url.trim()] : []),
    ]),
  ];
  if (immediateUrls.length > 0) {
    const syncId = String(
      payload?.jobId ??
        payload?.id ??
        (Array.isArray(payload?.savedImageIds) && payload.savedImageIds[0] ? payload.savedImageIds[0] : `${prefix}_${Date.now()}`),
    );
    return toResult({ ...payload, status: 'completed', images: immediateUrls }, tool, syncId);
  }
  if (typeof payload?.failedCount === 'number' && payload.failedCount > 0 && !payload?.jobId && !payload?.id) {
    throw new AiProviderError('Xử lý ảnh không thành công, tiền đã được hoàn lại vào ví', res);
  }
  return toResult({ status: 'queued' }, tool, jobIdOf(res));
}

function toResult(job: any, tool: AiToolDef, id: string): AiProviderResult {
  const status = String(job?.status ?? '').toLowerCase();
  if (status === 'completed' || status === 'succeeded' || status === 'done') {
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    const nested = job?.result && typeof job.result === 'object' && !Array.isArray(job.result) ? (job.result as Record<string, unknown>) : null;
    const urls: string[] = [
      ...new Set(
        [
          ...arr(job?.result),
          ...arr(job?.resultUrls),
          ...arr(job?.images),
          ...arr(job?.videos),
          ...arr(nested?.resultUrls),
          ...arr(nested?.images),
          ...arr(nested?.videos),
          ...arr(nested?.audios),
          nested?.audioUrl,
          nested?.url,
          job?.audioUrl,
          job?.url,
        ].filter((u): u is string => typeof u === 'string' && !!u.trim()),
      ),
    ];
    if (!urls.length) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả', raw: job };
    const fallback =
      tool.output === 'audio'
        ? 'audio'
        : job.kind === 'image' || job.type === 'image'
          ? 'image'
          : tool.output === 'text'
            ? 'image'
            : tool.output;
    return { status: 'succeeded', providerTaskId: id, files: urls.map((url) => ({ url, type: guessType(url, fallback as 'image') })), raw: job };
  }
  if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error') {
    return { status: 'failed', providerTaskId: id, error: normalizeKapendError(job?.error, job), raw: job };
  }
  return { status: 'processing', providerTaskId: id, raw: job };
}

async function submitVideos(ctx: AiCallContext, tool: AiToolDef, body: Record<string, unknown>, count: number): Promise<AiProviderResult> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      ids.push(jobIdOf(await call(ctx, '/api/video/generate', { ...body, batchCount: 1 })));
    } catch (err) {
      if (!ids.length) throw err;
      break;
    }
  }
  return toResult({ status: 'queued' }, tool, ids.join(JOB_SEP));
}

async function pollVideos(ctx: AiCallContext, tool: AiToolDef, id: string): Promise<AiProviderResult> {
  const results = await Promise.all(
    id.split(JOB_SEP).map(async (one) => {
      const res = await call<{ data?: unknown }>(ctx, `/api/generation-jobs/${encodeURIComponent(one)}`);
      return toResult(res?.data ?? res, tool, one);
    }),
  );
  const raw = results.map((r) => r.raw);
  if (results.some((r) => r.status === 'processing')) {
    const progress =
      results.reduce((sum, r) => sum + (r.status === 'processing' ? Number((r.raw as { progress?: unknown } | undefined)?.progress) || 0 : 100), 0) /
      results.length;
    return { status: 'processing', providerTaskId: id, progress: Math.round(progress), raw };
  }
  const files = results.flatMap((r) => r.files ?? []);
  if (!files.length) return { status: 'failed', providerTaskId: id, error: results.find((r) => r.error)?.error, raw };
  return { status: 'succeeded', providerTaskId: id, files, raw };
}

export const kapendProvider: AiProvider = {
  key: 'kapend',
  costUnit: 'credit Kapend',
  // Gói tháng Pro..Obsidian: 1 credit = 1.00 VNĐ; nạp lẻ pack: 1.20 VNĐ
  rate: 1,
  name: 'Kapend',
  website: 'https://kapend.com',
  tools: TOOLS,

  async resolveFields(tool, ctx) {
    if (tool.key !== 'voice' && tool.key !== 'tts') return tool.fields;
    const cat = await catalog(ctx).catch(() => null);
    if (!cat) return tool.fields;
    if (tool.key === 'voice' && cat.kapendVoiceOptions.length) {
      return tool.fields.map((f) =>
        f.name === 'voice' ? { ...f, default: cat.kapendVoiceOptions[0].value, options: cat.kapendVoiceOptions } : f,
      );
    }
    if (tool.key === 'tts' && cat.capcutVoiceOptions.length) {
      return tool.fields.map((f) =>
        f.name === 'speaker' ? { ...f, default: cat.capcutVoiceOptions[0].value, options: cat.capcutVoiceOptions } : f,
      );
    }
    return tool.fields;
  },

  async cost(tool, input, ctx) {
    if (tool.key === 'tts' || tool.key === 'remove-logo') return 0;

    const cat = await catalog(ctx);
    if (tool.key === 'voice') {
      const isSample = input.__sample === true;
      const len = isSample && !str(input.text).trim() ? 1000 : str(input.text).trim().length;
      if (len <= 0) return 0;
      const vid = str(input.voice).trim();
      const vMeta = cat.voiceMetaById.get(vid) ?? globalVoiceMeta.get(vid);
      if (vMeta?.server === 'capcut' || vMeta?.pricePer1k === 0) return 0;
      const per1k = typeof vMeta?.pricePer1k === 'number' ? vMeta.pricePer1k : vMeta?.x2 ? 400 : 200;
      // Nguồn tính tròn theo bậc 100 ký tự (`stepChars: 100`)
      const blocks100 = Math.max(1, Math.ceil(len / 100));
      return Math.ceil((blocks100 * per1k) / 10);
    }

    if (tool.key === 'upscale-image') {
      return upscaleImagePrice(input, cat);
    }

    const q = str(input.quality).toLowerCase() || '720p';
    if (tool.key === 'avatar' || tool.key === 'motion') {
      const model = tool.key === 'avatar' ? 'kling_avatar' : str(input.model);
      const catItem = cat.itemsById.get(model);
      const hit = catItem?.prices?.find((p) => p.quality?.toLowerCase() === q);
      const catPrice = hit?.perSecCredits ?? hit?.credits;
      const fromCatalog = typeof catPrice === 'number';
      const rawPerSec = fromCatalog ? catPrice : cat.costs[`video_${model}_${q}_per_sec`];
      if (typeof rawPerSec !== 'number') return null;
      const sec =
        typeof input.__sampleSec === 'number' && input.__sampleSec > 0
          ? input.__sampleSec
          : ((await uploadSeconds(ctx, tool.key === 'avatar' ? input.audio : input.video, 10)) ?? 10);
      const max = tool.key === 'avatar' ? 120 : 30;
      if (sec > max) throw new BadRequestException(`File dài tối đa ${max} giây`);
      const perSec = fromCatalog ? rawPerSec : applyDiscount(rawPerSec, cat.discounts, 'video', model);
      return perSec * sec * (tool.key === 'avatar' ? videoCount(input) : 1);
    }

    if (tool.key === 'upscale-video') {
      const m = TOPAZ.get(str(input.model)) ?? TOPAZ.get('topaz_upscale_maxx')!;
      const engine = m[3].length ? str(input.engine) || m[3][0][0] : '';
      const catItem = cat.itemsById.get(m[0]);
      const hit = catItem?.prices?.find((p) => (!engine || !p.mode || p.mode === engine) && p.quality?.toLowerCase() === q);
      const catPrice = hit?.perSecCredits ?? hit?.credits;
      const fromCatalog = typeof catPrice === 'number';
      const modePrefix = TOPAZ_PRICE_BY_MODE.includes(m[0]) && engine ? `${engine}_` : '';
      const rawPerSec = fromCatalog ? catPrice : cat.costs[`video_${m[0]}_${modePrefix}${q}_per_sec`];
      if (typeof rawPerSec !== 'number') return null;
      const sec =
        typeof input.__sampleSec === 'number' && input.__sampleSec > 0
          ? input.__sampleSec
          : ((await uploadSeconds(ctx, input.video, 10)) ?? 10);
      if (m[5] && sec > m[5]) throw new BadRequestException(`${m[1]} nhận video gốc tối đa ${m[5]} giây`);
      const perSec = fromCatalog ? rawPerSec : applyDiscount(rawPerSec, cat.discounts, 'video', m[0], engine || undefined);
      return perSec * (m[4] === 'block5' ? Math.ceil(sec / 5) * 5 : sec);
    }

    if (tool.key === 'image') return imagePrice(input, cat);

    if (MODELS_BY_TOOL[tool.key]) {
      const { price, reason } = await resolveVideo(tool, input, ctx);
      if (price == null) throw new BadRequestException(reason);
      return price * videoCount(input);
    }
    return null;
  },

  async submit(tool, input: AiInput, ctx) {
    switch (tool.key) {
      case 'image': {
        const img = resolveImage(input);
        const refs = Array.isArray(input.refs) ? input.refs.map(String) : [];
        if (refs.length > img.refs) throw new AiProviderError(`${img.model.label} nhận tối đa ${img.refs} ảnh tham chiếu`);
        const body = {
          prompt: str(input.prompt),
          model: img.id,
          ...(img.mode ? { mode: img.mode } : {}),
          aspectRatio: img.ratio,
          resolution: img.resolution,
          refImageUrls: refs.length ? refs : undefined,
          batchCount: img.count,
          ...(img.model.noLogo && input.removeLogo === true ? { removeWatermark: true } : {}),
        };
        const res = await call(ctx, '/api/image/generate', body);
        return submitImageOrImmediate(res, tool, 'img');
      }
      case 'upscale-image': {
        const modelId = str(input.model) || 'kapend_upscale_fast';
        if (!IMAGE_UPSCALE_MAP.has(modelId)) throw new AiProviderError('Chế độ làm nét ảnh không hợp lệ');
        const imgUrl = str(input.image).trim();
        if (!imgUrl) throw new BadRequestException('Vui lòng tải lên ảnh gốc cần làm nét');
        const resolution = str(input.resolution).toLowerCase() === '2k' ? '2k' : '4k';
        const res = await call(ctx, '/api/image/generate', {
          model: modelId,
          aspectRatio: 'auto',
          resolution,
          refImageUrls: [imgUrl],
          batchCount: 1,
        });
        return submitImageOrImmediate(res, tool, 'upscale');
      }
      case 'video':
      case 'seedance':
      case 'kling': {
        const { model, variant, duration, reason } = await resolveVideo(tool, input, ctx);
        if (!variant) throw new AiProviderError(reason);
        const images = Array.isArray(input.images) ? input.images.map(String) : [];
        const audios = Array.isArray(input.audios) ? input.audios.map(String) : input.audios ? [String(input.audios)] : [];
        if (NEEDS_IMAGE.includes(model.id) && !images.length) throw new AiProviderError(`${model.label} cần ít nhất 1 ảnh tham chiếu`);
        if (NEEDS_VIDEO.includes(model.id) && !input.video) throw new AiProviderError(`${model.label} cần video tham chiếu (video cần chỉnh)`);
        const quality = str(input.quality);
        const body: Record<string, unknown> = {
          prompt: str(input.prompt),
          model: variant,
          quality,
          duration,
          aspectRatio: str(input.aspectRatio) || undefined,
          ...(images.length ? { startImageUrls: images } : {}),
          ...(input.video ? { videoRefUrls: [str(input.video)] } : {}),
          ...(audios.length ? { audioUrls: audios } : {}),
          ...(variant === 'kling_video_2_6' ? { mode: kling26CatalogMode(quality) } : {}),
          ...(variant === VEO31 ? { mode: str(input.mode) || 'lite' } : {}),
          ...(variant === 'veo_omniv2' ? { mode: omniV2Mode(images.length, Boolean(input.video)) } : {}),
          ...(tool.key === 'seedance' ? { generateAudio: input.audio !== false } : {}),
        };
        return submitVideos(ctx, tool, body, videoCount(input));
      }
      case 'avatar': {
        const audioSec = await uploadSeconds(ctx, input.audio, 10);
        if (audioSec && audioSec > 120) throw new AiProviderError('File giọng nói vượt quá giới hạn 120 giây của Kling Avatar — tiền đã được hoàn lại');
        const body = {
          model: 'kling_avatar',
          quality: str(input.quality) || '720p',
          aspectRatio: str(input.aspectRatio) || undefined,
          ...(input.prompt ? { prompt: str(input.prompt) } : {}),
          startImageUrls: [str(input.image)],
          audioUrls: [str(input.audio)],
        };
        return submitVideos(ctx, tool, body, videoCount(input));
      }
      case 'motion':
      case 'upscale-video': {
        const motion = tool.key === 'motion';
        const topaz = TOPAZ.get(str(input.model)) ?? TOPAZ.get('topaz_upscale_maxx')!;
        const engine = str(input.engine) || topaz[3][0]?.[0];
        const vidSec = await uploadSeconds(ctx, input.video, 10).catch(() => null);
        if (motion && vidSec && vidSec > 30) {
          throw new AiProviderError('Video chuyển động mẫu của Kling Motion Control tối đa 30 giây — tiền đã được hoàn lại');
        }
        const body: Record<string, unknown> = {
          model: motion ? str(input.model) : topaz[0],
          quality: str(input.quality) || undefined,
          ...(input.prompt ? { prompt: str(input.prompt) } : {}),
          ...(motion
            ? {
                startImageUrls: [str(input.image)],
                refVideoUrl: str(input.video),
                ...(vidSec && vidSec > 0 ? { motionVideoSeconds: vidSec } : {}),
              }
            : { ...(engine ? { mode: engine } : {}), refVideoUrl: str(input.video) }),
        };
        const res = await call(ctx, '/api/video/generate', body);
        return toResult({ status: 'queued' }, tool, jobIdOf(res));
      }
      case 'voice': {
        const text = str(input.text).trim();
        if (!text) throw new BadRequestException('Vui lòng nhập nội dung văn bản cần đọc');
        const voice = str(input.voice).trim() || FALLBACK_KAPEND_VOICES[0].value;
        const speed = Math.min(2.0, Math.max(0.5, Number(input.speed) || 1));
        const vMeta = globalVoiceMeta.get(voice);
        if (vMeta?.maxChars && text.length > vMeta.maxChars) {
          throw new BadRequestException(`Giọng đọc này giới hạn tối đa ${vMeta.maxChars.toLocaleString('vi-VN')} ký tự mỗi lượt`);
        }
        const res = await call(ctx, '/api/voice/generate', { text, voice, speed });
        if (res?.audioUrl || res?.url || (Array.isArray(res?.result) && res.result.length)) {
          return toResult({ status: 'completed', ...res }, tool, res?.jobId || `voice_${Date.now()}`);
        }
        return toResult({ status: 'queued' }, tool, jobIdOf(res));
      }
      case 'tts': {
        let res: Response;
        try {
          res = await capcutSpeech(ctx, str(input.text), ttsVoice(input), Number(input.speed) || 1, 120_000);
        } catch (err) {
          const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
          throw new AiProviderError(
            timedOut ? 'Nhà cung cấp AI phản hồi quá lâu, tiền đã được hoàn lại' : 'Không kết nối được nhà cung cấp AI, hệ thống sẽ thử lại',
            { error: (err as Error).message },
            !timedOut,
          );
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new AiProviderError(ERRORS[data?.error] ?? pickMessage(data) ?? `Nhà cung cấp AI báo lỗi HTTP ${res.status}`, data, res.status >= 500);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: 'succeeded', files: [{ url: '', type: 'audio', data: buf, mimeType: 'audio/mpeg', name: 'giong-doc.mp3' }] };
      }
      case 'remove-logo': {
        const file = await ctx.readUpload(str(input.file));
        if (!file) throw new AiProviderError('Không đọc được file đã tải lên, vui lòng tải lại');
        const slot = await call<{ uploadUrl: string; sourceUrl: string }>(ctx, '/api/v1/remove-logo?upload=1', {
          originalName: file.filename,
          mimeType: file.mimeType,
          fileSize: file.data.length,
        });
        const put = await fetch(slot.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.mimeType },
          body: new Uint8Array(file.data),
          signal: AbortSignal.timeout(300_000),
        });
        if (!put.ok) throw new AiProviderError('Tải file lên nhà cung cấp thất bại, hệ thống sẽ thử lại', { status: put.status }, true);
        const job = await call(ctx, '/api/v1/remove-logo', {
          sourceUrl: slot.sourceUrl,
          originalName: file.filename,
          mimeType: file.mimeType,
        });
        return { status: 'processing', providerTaskId: `${LOGO}${jobIdOf(job)}`, raw: job };
      }
    }
    throw new AiProviderError('Công cụ không được hỗ trợ');
  },

  async poll(tool, id, ctx) {
    if (id.startsWith(LOGO)) {
      const job = await call(ctx, `/api/v1/remove-logo?jobId=${encodeURIComponent(id.slice(LOGO.length))}`);
      return toResult(job, tool, id);
    }
    if (id.includes(JOB_SEP)) return pollVideos(ctx, tool, id);
    const res = await call<{ data?: unknown }>(ctx, `/api/generation-jobs/${encodeURIComponent(id)}`);
    return toResult(res?.data ?? res, tool, id);
  },

  async voiceSample(voice, ctx) {
    if (!voice) return null;
    const cat = await catalog(ctx).catch(() => null);
    const meta = cat?.voiceMetaById.get(voice) ?? globalVoiceMeta.get(voice);
    const lang = str(meta?.lang || 'vi').toLowerCase();
    const sampleText = SAMPLE_TEXT[lang] ?? SAMPLE_TEXT.vi;

    // 1) Giọng thuộc CapCut (0đ, đồng bộ)
    if (!meta || meta.server === 'capcut' || voice.startsWith('BV') || voice.startsWith('ICL_') || voice.startsWith('capcut:')) {
      const res = await capcutSpeech(ctx, sampleText, voice, 1, 45_000);
      if (res.ok) return { data: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
    }

    // 2) Giọng thuộc Kapend Voice (async job, chỉ tạo đúng 1 lần rồi lưu đĩa)
    if (!ctx.config.apiKey || !meta) return null;
    const created = await call(ctx, '/api/voice/generate', { text: sampleText, voice, speed: 1 });
    const jobId = jobIdOf(created);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const polled = await call<any>(ctx, `/api/generation-jobs/${encodeURIComponent(jobId)}`).catch(() => null);
      const d = polled?.data ?? polled;
      const st = str(d?.status).toLowerCase();
      const audioUrl = str(d?.result?.[0] ?? d?.audioUrl ?? d?.url).trim();
      if ((st === 'completed' || st === 'succeeded') && audioUrl) {
        const dl = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
        if (dl.ok) return { data: Buffer.from(await dl.arrayBuffer()), mimeType: dl.headers.get('content-type') || 'audio/mpeg' };
      }
      if (st === 'failed' || st === 'cancelled') break;
    }
    return null;
  },

  async balance(ctx) {
    const res = await call<any>(ctx, `/api/account/credits/${encodeURIComponent(ctx.config.apiKey)}`);
    const d = res?.data ?? res;
    const n = Number(d?.credits ?? d?.balance ?? d?.availableCredits ?? d?.total ?? NaN);
    return Number.isFinite(n) ? { balance: n, unit: 'credits' } : null;
  },

  async catalog(ctx) {
    type RawItem = { id: string; type?: string; label?: string };
    const [vis, v1Cat] = await Promise.all([
      providerFetch<{ items?: { id: string; type?: string; enabled?: boolean }[] }>(ctx.config, '/api/config/model-visibility', { timeoutMs: 20_000 }),
      providerFetch<{ items?: RawItem[]; image?: RawItem[]; video?: RawItem[]; voice?: RawItem[] }>(ctx.config, '/api/v1/catalog', { timeoutMs: 20_000 }).catch(() => ({
        items: [],
        image: [],
        video: [],
        voice: [],
      })),
    ]);
    const disabled = new Set((vis?.items ?? []).filter((i) => i.enabled === false).map((i) => i.id));
    const map = new Map<string, string>();
    for (const i of vis?.items ?? []) {
      if (i.enabled !== false) map.set(i.id, i.type ? `${i.id} (${i.type})` : i.id);
    }
    const entries: [RawItem[], string][] = [
      [v1Cat?.items ?? [], 'ai'],
      [v1Cat?.image ?? [], 'image'],
      [v1Cat?.video ?? [], 'video'],
      [v1Cat?.voice ?? [], 'voice'],
    ];
    for (const [list, fallbackType] of entries) {
      for (const i of list) {
        if (i?.id && !disabled.has(i.id)) map.set(i.id, i.label ? `${i.label} · ${i.id} (${i.type ?? fallbackType})` : i.id);
      }
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  },

  async discoverTools(ctx) {
    if (!ctx.config.apiKey?.trim()) return { addedTools: [], removedKeys: [] };
    type RawCat = { items?: { id: string }[]; image?: { id: string }[]; video?: { id: string }[]; voice?: { id: string }[] };
    const cat = await providerFetch<RawCat>(ctx.config, '/api/v1/catalog', { timeoutMs: 18_000 }).catch(() => null);
    if (!cat) return { addedTools: [], removedKeys: [] };
    const liveIds = new Set<string>();
    for (const arr of [cat.items, cat.image, cat.video, cat.voice]) {
      for (const item of arr ?? []) {
        if (item?.id) liveIds.add(String(item.id));
      }
    }
    if (liveIds.size < 20) return { addedTools: [], removedKeys: [] };

    const removedKeys: string[] = [];
    const updatedSplits: string[] = [];

    const isModelAlive = (toolKey: string, mId: string): boolean => {
      if (liveIds.has(mId)) return true;
      if (toolKey === 'image') {
        const im = IMAGE_MODELS.get(mId);
        if (im?.servers?.some((s) => liveIds.has(s.model ?? s.id) || liveIds.has(`${mId}_${s.id}`))) return true;
      }
      const vmList = MODELS_BY_TOOL[toolKey];
      if (vmList) {
        const vm = vmList.find((x) => x.id === mId);
        if (vm?.servers?.some((s) => liveIds.has(s.id))) return true;
      }
      return false;
    };

    for (const t of TOOLS) {
      if (!['image', 'video', 'seedance', 'kling', 'upscale-video', 'upscale-image'].includes(t.key)) continue;
      const mf = t.fields.find((f) => f.name === 'model' && Array.isArray(f.options) && f.options.length > 0);
      if (!mf?.options) continue;
      const kept = mf.options.filter((o) => isModelAlive(t.key, String(o.value)));
      const dropped = mf.options.filter((o) => !isModelAlive(t.key, String(o.value)));
      if (dropped.length > 0 && kept.length > 0) {
        mf.options = kept;
        if (!kept.some((o) => o.value === mf.default)) mf.default = kept[0].value;
        for (const d of dropped) removedKeys.push(`kapend.${t.key}~${d.value}`);
        updatedSplits.push(`kapend.${t.key}`);
      }
    }
    return { addedTools: [], updatedSplits, removedKeys };
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey) return null;
    const vis = await providerFetch<{ items?: { id: string; enabled?: boolean }[] }>(
      ctx.config,
      '/api/config/model-visibility',
      { timeoutMs: 15_000 },
    ).catch(() => null);
    if (!vis?.items?.length) return null;
    const disabled = new Set(vis.items.filter((i) => i.enabled === false).map((i) => i.id));
    const down = new Set<string>();
    for (const t of TOOLS) {
      const mf = t.fields.find((f) => f.name === 'model' && f.options?.length);
      if (!mf?.options) {
        if (disabled.has(t.key)) down.add(t.key);
        continue;
      }
      const sf = t.fields.find((f) => f.name === 'server' && f.optionsBy?.field === 'model');
      for (const mOpt of mf.options) {
        const mId = String(mOpt.value);
        const srvOpts = sf?.optionsBy?.map[mId];
        let isDown = false;
        if (t.key === 'image') {
          isDown = disabled.has(mId) && (!srvOpts?.length || srvOpts.every((s) => disabled.has(`${mId}_${s.value}`)));
        } else if (srvOpts?.length) {
          isDown = srvOpts.every((s) => disabled.has(String(s.value)));
        } else {
          isDown = disabled.has(mId);
        }
        if (isDown) down.add(`${t.key}~${mId}`);
      }
    }
    return down;
  },
};
