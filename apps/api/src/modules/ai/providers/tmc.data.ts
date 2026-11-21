/**
 * Dữ liệu tĩnh của TMC Video AI, trích từ GET /models và https://tmcvideoai.net/voices_db.json (28/10/2026).
 * Form công cụ dựng từ đây; GIÁ thật luôn lấy trực tiếp từ GET /models lúc chạy (xem tmc.provider.ts).
 * Nhà cung cấp thêm model mới: chạy lại GET /models rồi cập nhật TMC_MODELS.
 */

/** Một lựa chọn giá của model: thời lượng (giây) × độ phân giải -> số xu */
export interface TmcOption {
  durationSec?: number | null;
  resolution?: string | null;
  xu: number;
}
export interface TmcModel {
  mode: string;
  modelId: string;
  label: string;
  resolutions?: string[];
  ratios: string[];
  options: TmcOption[];
}

export const TMC_MODELS: TmcModel[] = [
  {
    mode: 'image-to-video',
    modelId: 'grok-video-1.5',
    label: 'Grok Video · Grok Imagine Video 1.5',
    resolutions: ['1080p'],
    ratios: [],
    options: [
      { durationSec: 6, resolution: '1080p', xu: 0.9 },
      { durationSec: 10, resolution: '1080p', xu: 1 },
      { durationSec: 15, resolution: '1080p', xu: 1.2 },
    ],
  },
  {
    mode: 'image-to-video',
    modelId: 'kling-2.6',
    label: 'Kling 2.6 Pro',
    resolutions: ['720p', '1080p'],
    ratios: [],
    options: [
      { durationSec: 5, resolution: '720p', xu: 0.75 },
      { durationSec: 10, resolution: '720p', xu: 1.2 },
      { durationSec: 5, resolution: '1080p', xu: 1.2 },
    ],
  },
  {
    mode: 'image-to-video',
    modelId: 'kling-bot-2',
    label: 'Kling 3.0 Siêu Nét',
    resolutions: ['1080p'],
    ratios: [],
    options: [{ durationSec: 8, resolution: '1080p', xu: 1.2 }],
  },
  {
    mode: 'image-to-video',
    modelId: 'vae-h3i',
    label: 'VAE H3 · Ảnh thành video (Có tiếng)',
    resolutions: ['540p', '720p'],
    ratios: [],
    options: [
      { durationSec: 10, resolution: '540p', xu: 1.5 },
      { durationSec: 20, resolution: '540p', xu: 2.25 },
      { durationSec: 30, resolution: '540p', xu: 3.75 },
      { durationSec: 10, resolution: '720p', xu: 2.25 },
      { durationSec: 15, resolution: '720p', xu: 3 },
    ],
  },
  {
    mode: 'image-to-video',
    modelId: 'kling-3.0',
    label: 'Kling 3.0 Master',
    resolutions: ['720p', '1080p'],
    ratios: [],
    options: [
      { durationSec: 5, resolution: '720p', xu: 1.05 },
      { durationSec: 10, resolution: '720p', xu: 2.1 },
      { durationSec: 5, resolution: '1080p', xu: 1.8 },
    ],
  },
  {
    mode: 'image-to-video',
    modelId: 'kling-4.0',
    label: 'Kling 4.0',
    resolutions: [],
    ratios: [],
    options: [{ durationSec: 5, xu: 1.2 }],
  },
  {
    mode: 'motion-control',
    modelId: 'vae-m6',
    label: 'VAE motion control (Giá rẻ chất lượng 720p)',
    resolutions: ['720p'],
    ratios: [],
    options: [{ durationSec: 13, resolution: '720p', xu: 1.5 }],
  },
  {
    mode: 'motion-control',
    modelId: 'kling-bot-4',
    label: 'VAE Motion Control 1080p (Chất lượng cao - Tạo lâu)',
    resolutions: ['1080p'],
    ratios: [],
    options: [{ durationSec: 8, resolution: '1080p', xu: 1.2 }],
  },
  {
    mode: 'motion-control',
    modelId: 'vae-m13',
    label: 'VAE motion control 8 (Khuyên dùng - Tạo video nét)',
    resolutions: ['720p', '1080p', '2K'],
    ratios: ['9:16', '16:9'],
    options: [
      { durationSec: 10, resolution: '720p', xu: 2.15 },
      { durationSec: 15, resolution: '720p', xu: 3.15 },
      { durationSec: 20, resolution: '720p', xu: 3.65 },
      { durationSec: 10, resolution: '1080p', xu: 2.65 },
      { durationSec: 15, resolution: '1080p', xu: 4.15 },
      { durationSec: 20, resolution: '1080p', xu: 5.15 },
      { durationSec: 10, resolution: '2K', xu: 3.65 },
      { durationSec: 15, resolution: '2K', xu: 5.65 },
      { durationSec: 20, resolution: '2K', xu: 7.65 },
    ],
  },
  {
    mode: 'motion-control',
    modelId: 'vae-m12',
    label: 'VAE motion control 7',
    resolutions: ['576p', '720p', '1080p', '2K'],
    ratios: ['9:16', '16:9'],
    options: [
      { durationSec: 10, resolution: '576p', xu: 1.5 },
      { durationSec: 15, resolution: '576p', xu: 2.25 },
      { durationSec: 20, resolution: '576p', xu: 3 },
      { durationSec: 30, resolution: '576p', xu: 6 },
      { durationSec: 40, resolution: '576p', xu: 9 },
      { durationSec: 10, resolution: '720p', xu: 2.25 },
      { durationSec: 15, resolution: '720p', xu: 3.75 },
      { durationSec: 20, resolution: '720p', xu: 5.25 },
      { durationSec: 10, resolution: '1080p', xu: 4.5 },
      { durationSec: 15, resolution: '1080p', xu: 9 },
      { durationSec: 20, resolution: '1080p', xu: 13.5 },
      { durationSec: 10, resolution: '2K', xu: 6.75 },
      { durationSec: 15, resolution: '2K', xu: 13.5 },
    ],
  },
  {
    mode: 'video-enhance',
    modelId: 'videosr-4k',
    label: 'Làm nét video',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.3,
      },
    ],
  },
  {
    mode: 'text-to-image',
    modelId: 'img-nano-pro',
    label: 'Nano Pro',
    resolutions: ['1K', '2K', '4K'],
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', 'adaptive'],
    options: [
      {
        resolution: '1K',
        xu: 0.15,
      },
      {
        resolution: '2K',
        xu: 0.3,
      },
      {
        resolution: '4K',
        xu: 0.45,
      },
    ],
  },
  {
    mode: 'text-to-image',
    modelId: 'img-nano2',
    label: 'Nano 2',
    resolutions: ['1K', '2K', '4K'],
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', 'adaptive'],
    options: [
      {
        resolution: '1K',
        xu: 0.15,
      },
      {
        resolution: '2K',
        xu: 0.3,
      },
      {
        resolution: '4K',
        xu: 0.3,
      },
    ],
  },
  {
    mode: 'text-to-image',
    modelId: 'img-seedream5',
    label: 'Seedream 5.0',
    resolutions: ['2K'],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', 'adaptive'],
    options: [
      {
        resolution: '2K',
        xu: 0.15,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-vn',
    label: 'Giọng Việt tự nhiên',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.3,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-el3',
    label: 'ElevenLabs V3',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.45,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-elm2',
    label: 'ElevenLabs Multilingual V2',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.45,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-elt25',
    label: 'ElevenLabs Turbo V2.5',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.3,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-mmhd',
    label: 'MiniMax Speech 2.8 HD',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.45,
      },
    ],
  },
  {
    mode: 'text-to-speech',
    modelId: 'vae-voice-mmturbo',
    label: 'MiniMax Speech 2.8 Turbo',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.3,
      },
    ],
  },
  {
    mode: 'text-to-music',
    modelId: 'vae-music1',
    label: 'Suno Music V1 · Bài hát có lời ~3 phút',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 1.5,
      },
    ],
  },
  {
    mode: 'text-to-music',
    modelId: 'vae-music26',
    label: 'MiniMax Music 2.6 · Nhạc + ca từ Việt',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 1.2,
      },
    ],
  },
  {
    mode: 'text-to-music',
    modelId: 'vae-music-lyria',
    label: 'Google Lyria 2 · Nhạc giai điệu chất lượng cao',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.75,
      },
    ],
  },
  {
    mode: 'talking-photo',
    modelId: 'vae-tk1',
    label: 'VAE Talk 1',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 1.5,
      },
    ],
  },
  {
    mode: 'talking-photo',
    modelId: 'vae-tk2',
    label: 'VAE Talk 2',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 3,
      },
    ],
  },
  {
    mode: 'h3-studio',
    modelId: 'vae-h3t',
    label: 'VAE H3 · Từ mô tả',
    resolutions: ['540p', '720p'],
    ratios: ['9:16', '16:9', '1:1'],
    options: [
      {
        durationSec: 10,
        resolution: '540p',
        xu: 1.5,
      },
      {
        durationSec: 20,
        resolution: '540p',
        xu: 2.25,
      },
      {
        durationSec: 30,
        resolution: '540p',
        xu: 3.75,
      },
      {
        durationSec: 10,
        resolution: '720p',
        xu: 2.25,
      },
      {
        durationSec: 15,
        resolution: '720p',
        xu: 3,
      },
    ],
  },
  {
    mode: 'h3-studio',
    modelId: 'vae-h3i',
    label: 'VAE H3 · Ảnh thành video',
    resolutions: ['540p', '720p'],
    ratios: [],
    options: [
      {
        durationSec: 10,
        resolution: '540p',
        xu: 1.5,
      },
      {
        durationSec: 20,
        resolution: '540p',
        xu: 2.25,
      },
      {
        durationSec: 30,
        resolution: '540p',
        xu: 3.75,
      },
      {
        durationSec: 10,
        resolution: '720p',
        xu: 2.25,
      },
      {
        durationSec: 15,
        resolution: '720p',
        xu: 3,
      },
    ],
  },
  {
    mode: 'h3-studio',
    modelId: 'vae-h3r',
    label: 'VAE H3 · Nhiều ảnh thành video',
    resolutions: ['540p', '720p'],
    ratios: [],
    options: [
      {
        durationSec: 10,
        resolution: '540p',
        xu: 1.5,
      },
      {
        durationSec: 20,
        resolution: '540p',
        xu: 2.25,
      },
      {
        durationSec: 30,
        resolution: '540p',
        xu: 3.75,
      },
      {
        durationSec: 10,
        resolution: '720p',
        xu: 2.25,
      },
      {
        durationSec: 15,
        resolution: '720p',
        xu: 3,
      },
    ],
  },
  {
    mode: 'body-edit',
    modelId: 'img-body1',
    label: 'Chỉnh dáng người AI',
    resolutions: [],
    ratios: [],
    options: [
      {
        xu: 0.75,
      },
    ],
  },
  {
    mode: 'video-outfit',
    modelId: 'vae-vo1',
    label: 'AI thay đổi trang phục cho video',
    resolutions: [],
    ratios: [],
    options: [
      {
        durationSec: 10,
        xu: 3,
      },
      {
        durationSec: 20,
        xu: 4.5,
      },
    ],
  },
  {
    mode: 'text-to-video',
    modelId: 'vae-tv9',
    label: 'VAE Veo3 · Cân bằng, ổn định',
    ratios: ['16:9', '9:16'],
    options: [
      {
        durationSec: 8,
        resolution: null,
        xu: 0.75,
      },
    ],
  },
  {
    mode: 'text-to-video',
    modelId: 'vae-tv10',
    label: 'Wan 3.0 · Chuyển động tự nhiên',
    ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
    options: [
      {
        durationSec: 6,
        resolution: '720p',
        xu: 1.5,
      },
      {
        durationSec: 6,
        resolution: '480p',
        xu: 0.9,
      },
      {
        durationSec: 12,
        resolution: '480p',
        xu: 1.65,
      },
    ],
  },
  {
    mode: 'text-to-video',
    modelId: 'vae-tv11',
    label: 'Google Omni Flash · Tốc độ nhanh, chi tiết rõ',
    ratios: ['16:9', '9:16'],
    options: [
      {
        durationSec: 5,
        resolution: null,
        xu: 0.9,
      },
    ],
  },
  {
    mode: 'text-to-video',
    modelId: 'vae-h3t',
    label: 'VAE H3 · Từ mô tả (Có tiếng 10s - 30s)',
    ratios: ['9:16', '16:9', '1:1'],
    options: [
      {
        durationSec: 10,
        resolution: '720p',
        xu: 2.25,
      },
      {
        durationSec: 15,
        resolution: '720p',
        xu: 3,
      },
      {
        durationSec: 10,
        resolution: '540p',
        xu: 1.5,
      },
      {
        durationSec: 20,
        resolution: '540p',
        xu: 2.25,
      },
      {
        durationSec: 30,
        resolution: '540p',
        xu: 3.75,
      },
    ],
  },
  // ---- nhóm "kling-1k": đồng giá 1 xu / đơn, xử lý theo hàng đợi tuần tự (GET /models 07/11/2026) ----
  // Motion Control: 1 ảnh + 1 video mẫu (video dài hơn giới hạn thì TMC tự cắt)
  { mode: 'kling-1k', modelId: 'kling-bot-1', label: 'Motion 2.6 · 720p · Tối đa 13s', ratios: [], options: [{ durationSec: 13, resolution: '720p', xu: 1 }] },
  { mode: 'kling-1k', modelId: 'kling-bot-4', label: 'Motion 2.6 · 1080p · Tối đa 8s', ratios: [], options: [{ durationSec: 8, resolution: '1080p', xu: 1 }] },
  { mode: 'kling-1k', modelId: 'kling-bot-5', label: 'Motion 3.0 · 720p · Tối đa 7s', ratios: [], options: [{ durationSec: 7, resolution: '720p', xu: 1 }] },
  { mode: 'kling-1k', modelId: 'kling-bot-6', label: 'Motion 3.0 · 1080p · Tối đa 5s', ratios: [], options: [{ durationSec: 5, resolution: '1080p', xu: 1 }] },
  // Ảnh thành video: 1 ảnh + mô tả
  { mode: 'kling-1k', modelId: 'kling-bot-2', label: 'Kling 3.0 · 1080p · 8s', ratios: [], options: [{ durationSec: 8, resolution: '1080p', xu: 1 }] },
  { mode: 'kling-1k', modelId: 'kling-bot-7', label: 'Kling 4.0 · 720p · 6s', ratios: [], options: [{ durationSec: 6, resolution: '720p', xu: 1 }] },
  { mode: 'kling-1k', modelId: 'kling-bot-8', label: 'Kling 4.0 · 1080p · 4s', ratios: [], options: [{ durationSec: 4, resolution: '1080p', xu: 1 }] },
  // Khung đầu – khung cuối: 2 ảnh + mô tả, chọn thời lượng
  { mode: 'kling-1k', modelId: 'kling-bot-3', label: 'Start & End 3.0 · 1080p · 3s–8s', ratios: [], options: [3, 4, 5, 6, 7, 8].map((d) => ({ durationSec: d, resolution: '1080p', xu: 1 })) },
  { mode: 'kling-1k', modelId: 'kling-bot-10', label: 'Start & End 4.0 · 1080p · 3s–4s', ratios: [], options: [3, 4].map((d) => ({ durationSec: d, resolution: '1080p', xu: 1 })) },
  { mode: 'kling-1k', modelId: 'kling-bot-9', label: 'Start & End 4.0 · 720p · 3s–4s', ratios: [], options: [3, 4].map((d) => ({ durationSec: d, resolution: '720p', xu: 1 })) },
];

/** Mã model nhóm kling-1k theo loại (khớp `klingSub` của GET /models) */
export const TMC_KLING1K = {
  motion: ['kling-bot-1', 'kling-bot-4', 'kling-bot-5', 'kling-bot-6'],
  i2v: ['kling-bot-2', 'kling-bot-7', 'kling-bot-8'],
  frames: ['kling-bot-3', 'kling-bot-10', 'kling-bot-9'],
};
