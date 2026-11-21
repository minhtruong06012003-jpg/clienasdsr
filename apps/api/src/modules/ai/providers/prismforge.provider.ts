import { createHash } from 'node:crypto';
import sharp from 'sharp';
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
import { pickMessage, providerFetch, str } from './http.js';

/**
 * Prism Forge — https://prismforge.cloud/api-docs (base `https://prismforge.cloud/v1`, header `Authorization: Bearer pf_live_...`).
 *
 * Đồng bộ chuẩn 100% với `GET /v1/models` & giao diện `prismforge.cloud`:
 * - Đủ 20/20 model tạo video (5 dòng Seedance + 15 dòng Cinema/Grok/Veo/Kling/Wan/Vidu/MiniMax/FLUX/LTX/HappyHorse) với đúng từng chế độ
 *   (`t2v` Chữ → Video, `i2v` Ảnh → Video, `flf` Khung đầu – cuối, `ref` Tham chiếu), đúng danh sách độ phân giải, đầy đủ từng giây thời lượng,
 *   đúng khung hình mặc định (tự ẩn khung hình ở chế độ `i2v` trên các model tự lấy tỉ lệ theo ảnh đầu), âm thanh, bản nháp 480p, negative prompt & seed.
 * - Đủ 4 model Tạo ảnh AI (`studio-image`, nhóm `image`) + 4 model Sửa & ghép ảnh AI (`image-edit`, nhóm `chinh-sua-anh-ai`)
 *   (`Seedream 5.5`, `FLUX 3`, `GPT Image 2.6`, `Nano Banana 2.1`) với đúng kích thước mặc định (`2K` trên Seedream 5.5; `1K` trên 3 model còn lại;
 *   `4K` riêng trên Nano Banana 2.1) và đúng giới hạn ảnh tham chiếu (`16` ảnh trên GPT Image 2.6, `10` ảnh trên 3 model còn lại).
 *
 * Bảo vệ chống lệch giá 3 lớp (Zero-Loss Pricing):
 * 1. Đúng thông số & đơn giá gốc từ `GET /v1/models`.
 * 2. Báo giá trực tiếp `POST /v1/quote` trước khi trừ tiền khách (kể cả đơn đính kèm nhiều ảnh hoặc video tham chiếu dài).
 * 3. Chốt chặn `expect` cứng trên `POST /v1/videos` & `POST /v1/images` (lệch dù 1đ nguồn trả `409` ngay, không trừ ví đối tác, tự hoàn tiền khách).
 */

const DEFAULT_BASE_URL = 'https://prismforge.cloud/v1';
const CACHE_TTL_MS = 10 * 60_000;
const UPLOAD_CACHE_TTL_MS = 25 * 60_000;

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));
const secOpts = (secs: number[]): AiFieldOption[] => secs.map((s) => ({ value: String(s), label: `${s} giây` }));

const intRange = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const withDef = <T>(list: T[], def: T): T[] => (list.includes(def) ? [def, ...list.filter((x) => x !== def)] : list);
const durRange = (min: number, max: number, def: number): number[] => withDef(intRange(min, max), def);

const RES_LABELS: Record<string, string> = {
  '360p': '360p (Siêu tiết kiệm)',
  '480p': '480p (Nhanh, tiết kiệm)',
  '540p': '540p (qHD)',
  '720p': '720p (HD)',
  '768p': '768p (HD+)',
  '1080p': '1080p (Full HD)',
  '4k': '4K (Ultra HD)',
};
const resOpts = (list: string[]): AiFieldOption[] => list.map((r) => ({ value: r, label: RES_LABELS[r] ?? r.toUpperCase() }));

const ASPECT_LABELS: Record<string, string> = {
  auto: 'Tự động',
  adaptive: 'Tự động',
  '16:9': '16:9 Ngang (YouTube, Điện ảnh)',
  '9:16': '9:16 Dọc (TikTok, Reels, Shorts)',
  '1:1': '1:1 Vuông',
  '4:3': '4:3 Cổ điển',
  '3:4': '3:4 Chân dung',
  '21:9': '21:9 Màn ảnh rộng',
  '9:21': '9:21 Siêu dọc',
  '2:1': '2:1 Điện ảnh rộng',
  '3:2': '3:2 Ngang máy ảnh',
  '2:3': '2:3 Dọc máy ảnh',
  '5:4': '5:4 Ngang chuẩn',
  '4:5': '4:5 Dọc mạng xã hội',
};
const aspectOpts = (list: string[]): AiFieldOption[] => list.map((a) => ({ value: a, label: ASPECT_LABELS[a] ?? a }));

type VideoModeCode = 't2v' | 'i2v' | 'flf' | 'ref';

const MODE_LABELS: Record<VideoModeCode, string> = {
  t2v: 'Chữ → Video',
  i2v: 'Ảnh → Video',
  flf: 'Khung đầu – cuối',
  ref: 'Tham chiếu',
};

interface VideoModeSpec {
  mode: VideoModeCode;
  label?: string;
  /** Độ phân giải hỗ trợ (`default_resolution` đứng đầu) */
  resolutions: string[];
  /** Danh sách giây hợp lệ (`default_duration` đứng đầu) */
  durations: number[];
  /** Tỉ lệ khung hình (`default_aspect` đứng đầu); `null` = tự lấy theo ảnh đầu, không hiện ô chọn */
  aspects: string[] | null;
  audio: boolean;
  start?: 'required';
  end?: 'optional' | 'required';
  refImages?: number;
  refVideos?: number;
  refAudios?: number;
  refTotal?: number;
  negative?: boolean;
  seed?: boolean;
  draft?: boolean;
  rates: Record<string, number>;
  muteRates?: Record<string, number>;
  draftRate?: number;
}

interface VideoModelSpec {
  id: string;
  label: string;
  fromPrice: number;
  modes: VideoModeSpec[];
}

const SD_ASPECTS = ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const KLING4_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const KLING4_REF_ASPECTS = ['16:9', 'auto', '9:16', '1:1', '4:3', '3:4', '21:9'];
const MINIMAX_T2V_ASPECTS = ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16'];
const MINIMAX_REF_ASPECTS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const GROK_ASPECTS = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
const HAPPY_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5'];

const SEEDANCE_MODELS: VideoModelSpec[] = [
  {
    id: 'seedance-2.5',
    label: 'Seedance 2.5 · Điện ảnh tới 4K, 30s, có tiếng',
    fromPrice: 2500,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p', '1080p', '4k'],
        durations: durRange(4, 30, 5),
        aspects: SD_ASPECTS,
        audio: true,
        draft: true,
        draftRate: 500,
        rates: { '480p': 500, '720p': 1072.6, '1080p': 2639.5, '4k': 3000 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p', '1080p', '4k'],
        durations: durRange(4, 30, 5),
        aspects: null,
        audio: true,
        start: 'required',
        end: 'optional',
        draft: true,
        draftRate: 500,
        rates: { '480p': 500, '720p': 1072.6, '1080p': 2639.5, '4k': 3000 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '480p', '1080p', '4k'],
        durations: durRange(4, 30, 5),
        aspects: SD_ASPECTS,
        audio: true,
        refImages: 30,
        refVideos: 10,
        refAudios: 10,
        refTotal: 50,
        seed: true,
        draft: true,
        draftRate: 500,
        rates: { '480p': 500, '720p': 1072.6, '1080p': 2639.5, '4k': 3000 },
      },
    ],
  },
  {
    id: 'seedance-2.5-flash',
    label: 'Seedance 2.5 Flash · Tới 30s, có tiếng, giá mềm',
    fromPrice: 1700,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 30, 5),
        aspects: SD_ASPECTS,
        audio: true,
        rates: { '480p': 333.3, '720p': 733.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 30, 5),
        aspects: null,
        audio: true,
        start: 'required',
        end: 'optional',
        rates: { '480p': 333.3, '720p': 733.3 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 30, 5),
        aspects: SD_ASPECTS,
        audio: true,
        refImages: 10,
        refVideos: 5,
        refAudios: 5,
        seed: true,
        rates: { '480p': 333.3, '720p': 733.3 },
      },
    ],
  },
  {
    id: 'seedance-2.0',
    label: 'Seedance 2.0 · Tới 15s (1080p ở Ảnh → Video)',
    fromPrice: 1800,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        rates: { '480p': 427, '720p': 912.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p', '1080p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        start: 'required',
        end: 'optional',
        rates: { '480p': 355.2, '720p': 748.3, '1080p': 1682.2 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        refImages: 9,
        refVideos: 3,
        refAudios: 3,
        refTotal: 12,
        rates: { '480p': 427, '720p': 912.6 },
      },
    ],
  },
  {
    id: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast · Nhanh, giá mềm, tới 15s',
    fromPrice: 1500,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        rates: { '480p': 283.7, '720p': 596.7 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        start: 'required',
        end: 'optional',
        rates: { '480p': 283.7, '720p': 596.7 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        refImages: 9,
        refVideos: 3,
        refAudios: 3,
        refTotal: 12,
        rates: { '480p': 283.7, '720p': 596.7 },
      },
    ],
  },
  {
    id: 'seedance-2.0-mini',
    label: 'Seedance 2.0 Mini · Nhẹ & rẻ nhất dòng 2.0',
    fromPrice: 900,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        rates: { '480p': 177.8, '720p': 381.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        start: 'required',
        end: 'optional',
        rates: { '480p': 177.8, '720p': 381.6 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '480p'],
        durations: durRange(4, 15, 5),
        aspects: SD_ASPECTS,
        audio: true,
        refImages: 9,
        refVideos: 3,
        refAudios: 3,
        refTotal: 12,
        rates: { '480p': 177.8, '720p': 381.6 },
      },
    ],
  },
];

const CINEMA_MODELS: VideoModelSpec[] = [
  {
    id: 'kling-4',
    label: 'Kling 4.0 · Chuyển động mạnh, tới 30s (1080p)',
    fromPrice: 1200,
    modes: [
      {
        mode: 't2v',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 30, 5),
        aspects: KLING4_ASPECTS,
        audio: false,
        rates: { '720p': 387.2, '1080p': 579.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 30, 5),
        aspects: null,
        audio: false,
        start: 'required',
        end: 'optional',
        rates: { '720p': 387.2, '1080p': 579.6 },
      },
      {
        mode: 'ref',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 30, 5),
        aspects: KLING4_REF_ASPECTS,
        audio: false,
        refImages: 10,
        refVideos: 5,
        rates: { '720p': 387.2, '1080p': 579.6 },
      },
    ],
  },
  {
    id: 'kling-4-flash',
    label: 'Kling 4.0 Flash · Tạo nhanh, giá mềm, tới 20s',
    fromPrice: 700,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p'],
        durations: durRange(3, 20, 5),
        aspects: KLING4_ASPECTS,
        audio: false,
        rates: { '720p': 231.9 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p'],
        durations: durRange(3, 20, 5),
        aspects: null,
        audio: false,
        start: 'required',
        rates: { '720p': 231.9 },
      },
      {
        mode: 'ref',
        resolutions: ['720p'],
        durations: durRange(3, 20, 5),
        aspects: KLING4_REF_ASPECTS,
        audio: false,
        refImages: 10,
        refVideos: 5,
        rates: { '720p': 231.9 },
      },
    ],
  },
  {
    id: 'kling-3',
    label: 'Kling 3.0 · Có âm thanh, tới 15s (1080p)',
    fromPrice: 700,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '1080p'],
        durations: durRange(3, 15, 5),
        aspects: ['16:9', '9:16', '1:1'],
        audio: true,
        negative: true,
        rates: { '720p': 310.8, '1080p': 414.4 },
        muteRates: { '720p': 207.2, '1080p': 276.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '1080p'],
        durations: durRange(3, 15, 5),
        aspects: null,
        audio: true,
        start: 'required',
        end: 'optional',
        negative: true,
        rates: { '720p': 310.8, '1080p': 414.4 },
        muteRates: { '720p': 207.2, '1080p': 276.3 },
      },
    ],
  },
  {
    id: 'wan-3',
    label: 'Wan 3.0 · Có tiếng, dài tới 30s (1080p)',
    fromPrice: 500,
    modes: [
      {
        mode: 't2v',
        resolutions: ['1080p', '720p', '480p'],
        durations: durRange(2, 30, 5),
        aspects: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
        audio: true,
        seed: true,
        rates: { '480p': 123.3, '720p': 246.7, '1080p': 493.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['1080p', '720p', '480p'],
        durations: durRange(2, 30, 5),
        aspects: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
        audio: true,
        start: 'required',
        end: 'optional',
        seed: true,
        rates: { '480p': 123.3, '720p': 246.7, '1080p': 493.3 },
      },
      {
        mode: 'ref',
        resolutions: ['1080p', '720p', '480p'],
        durations: durRange(2, 30, 5),
        aspects: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
        audio: true,
        refImages: 10,
        refVideos: 5,
        refAudios: 5,
        seed: true,
        rates: { '480p': 123.3, '720p': 246.7, '1080p': 493.3 },
      },
    ],
  },
  {
    id: 'veo-3.1',
    label: 'Google Veo 3.1 · Khớp thoại tự nhiên, tới 4K',
    fromPrice: 2000,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['16:9', '9:16'],
        audio: true,
        negative: true,
        seed: true,
        rates: { '720p': 986.6, '1080p': 986.6, '4k': 1479.9 },
        muteRates: { '720p': 493.3, '1080p': 493.3, '4k': 986.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['auto', '16:9', '9:16'],
        audio: true,
        start: 'required',
        negative: true,
        seed: true,
        rates: { '720p': 986.6, '1080p': 986.6, '4k': 1479.9 },
        muteRates: { '720p': 493.3, '1080p': 493.3, '4k': 986.6 },
      },
      {
        mode: 'flf',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['auto', '16:9', '9:16'],
        audio: true,
        start: 'required',
        end: 'required',
        negative: true,
        seed: true,
        rates: { '720p': 986.6, '1080p': 986.6, '4k': 1479.9 },
        muteRates: { '720p': 493.3, '1080p': 493.3, '4k': 986.6 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8],
        aspects: ['16:9', '9:16'],
        audio: true,
        refImages: 9,
        rates: { '720p': 986.6, '1080p': 986.6, '4k': 1479.9 },
        muteRates: { '720p': 493.3, '1080p': 493.3, '4k': 986.6 },
      },
    ],
  },
  {
    id: 'veo-3.1-fast',
    label: 'Google Veo 3.1 Fast · Nhanh, rẻ một nửa, tới 4K',
    fromPrice: 1000,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['16:9', '9:16'],
        audio: true,
        negative: true,
        seed: true,
        rates: { '720p': 370, '1080p': 370, '4k': 863.3 },
        muteRates: { '720p': 246.7, '1080p': 246.7, '4k': 740 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['auto', '16:9', '9:16'],
        audio: true,
        start: 'required',
        negative: true,
        seed: true,
        rates: { '720p': 370, '1080p': 370, '4k': 863.3 },
        muteRates: { '720p': 246.7, '1080p': 246.7, '4k': 740 },
      },
      {
        mode: 'flf',
        resolutions: ['720p', '1080p', '4k'],
        durations: [8, 4, 6],
        aspects: ['auto', '16:9', '9:16'],
        audio: true,
        start: 'required',
        end: 'required',
        negative: true,
        seed: true,
        rates: { '720p': 370, '1080p': 370, '4k': 863.3 },
        muteRates: { '720p': 246.7, '1080p': 246.7, '4k': 740 },
      },
    ],
  },
  {
    id: 'vidu-q4',
    label: 'Vidu Q4 · Từ ảnh / Tham chiếu nhân vật, tới 16s',
    fromPrice: 400,
    modes: [
      {
        mode: 'i2v',
        resolutions: ['720p', '540p', '1080p'],
        durations: durRange(3, 16, 5),
        aspects: null,
        audio: false,
        start: 'required',
        seed: true,
        rates: { '540p': 77.7, '720p': 164, '1080p': 207.2 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '540p', '1080p'],
        durations: durRange(3, 16, 5),
        aspects: ['16:9', '9:16', '4:3', '3:4', '1:1'],
        audio: true,
        refImages: 12,
        refAudios: 3,
        seed: true,
        rates: { '540p': 77.7, '720p': 164, '1080p': 207.2 },
      },
    ],
  },
  {
    id: 'minimax-h3-max-turbo',
    label: 'MiniMax H3 Max Turbo · Nhanh, siêu rẻ, tới 15s',
    fromPrice: 200,
    modes: [
      {
        mode: 't2v',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: MINIMAX_T2V_ASPECTS,
        audio: false,
        seed: true,
        rates: { '480p': 61.7, '768p': 98.7, '1080p': 197.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: null,
        audio: false,
        start: 'required',
        end: 'optional',
        seed: true,
        rates: { '480p': 61.7, '768p': 98.7, '1080p': 197.3 },
      },
      {
        mode: 'ref',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: MINIMAX_REF_ASPECTS,
        audio: false,
        refImages: 9,
        seed: true,
        rates: { '480p': 61.7, '768p': 98.7, '1080p': 197.3 },
      },
    ],
  },
  {
    id: 'minimax-h3-max',
    label: 'MiniMax H3 Max · Chuyển động tự nhiên, tới 15s',
    fromPrice: 300,
    modes: [
      {
        mode: 't2v',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: MINIMAX_T2V_ASPECTS,
        audio: false,
        seed: true,
        rates: { '480p': 123.3, '768p': 197.3, '1080p': 394.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: null,
        audio: false,
        start: 'required',
        end: 'optional',
        seed: true,
        rates: { '480p': 123.3, '768p': 197.3, '1080p': 394.6 },
      },
      {
        mode: 'ref',
        resolutions: ['768p', '480p', '1080p'],
        durations: durRange(1, 15, 5),
        aspects: MINIMAX_REF_ASPECTS,
        audio: false,
        refImages: 9,
        seed: true,
        rates: { '480p': 123.3, '768p': 197.3, '1080p': 394.6 },
      },
    ],
  },
  {
    id: 'gemini-omni-flash',
    label: 'Gemini Omni Flash 1.2 · Tốc độ cao, tới 4K',
    fromPrice: 300,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '360p', '1080p', '4k'],
        durations: durRange(3, 15, 8),
        aspects: ['16:9', '9:16'],
        audio: false,
        rates: { '360p': 67.3, '720p': 202, '1080p': 303.1, '4k': 606 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '360p', '1080p', '4k'],
        durations: durRange(3, 15, 8),
        aspects: ['16:9', '9:16'],
        audio: false,
        start: 'required',
        end: 'optional',
        rates: { '360p': 67.3, '720p': 202, '1080p': 303.1, '4k': 606 },
      },
      {
        mode: 'ref',
        resolutions: ['720p', '360p', '1080p', '4k'],
        durations: durRange(3, 15, 8),
        aspects: ['16:9', '9:16'],
        audio: false,
        refImages: 10,
        rates: { '360p': 67.3, '720p': 202, '1080p': 303.1, '4k': 606 },
      },
    ],
  },
  {
    id: 'grok-imagine-1.5',
    label: 'Grok Imagine 1.5 · Sáng tạo đa phong cách, tới 15s',
    fromPrice: 300,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p', '1080p'],
        durations: durRange(1, 15, 6),
        aspects: GROK_ASPECTS,
        audio: false,
        rates: { '480p': 197.3, '720p': 345.3, '1080p': 616.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p', '1080p'],
        durations: durRange(1, 15, 6),
        aspects: null,
        audio: false,
        start: 'required',
        rates: { '480p': 197.3, '720p': 345.3, '1080p': 616.6 },
      },
      {
        mode: 'ref',
        resolutions: ['480p', '720p'],
        durations: durRange(1, 15, 8),
        aspects: GROK_ASPECTS,
        audio: false,
        refImages: 7,
        rates: { '480p': 197.3, '720p': 345.3 },
      },
    ],
  },
  {
    id: 'grok-imagine-1.5-lite',
    label: 'Grok Imagine 1.5 Lite · Bản nhẹ siêu rẻ, tới 15s',
    fromPrice: 100,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '480p', '1080p'],
        durations: durRange(1, 15, 6),
        aspects: GROK_ASPECTS,
        audio: false,
        rates: { '480p': 49.3, '720p': 74, '1080p': 345.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '480p', '1080p'],
        durations: durRange(1, 15, 6),
        aspects: null,
        audio: false,
        start: 'required',
        rates: { '480p': 49.3, '720p': 74, '1080p': 345.3 },
      },
    ],
  },
  {
    id: 'flux-3-max',
    label: 'FLUX 3 Max · Hình sắc nét, có tiếng, tới 20s',
    fromPrice: 2100,
    modes: [
      {
        mode: 't2v',
        resolutions: ['720p', '1080p'],
        durations: durRange(5, 20, 5),
        aspects: ['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'],
        audio: true,
        seed: true,
        rates: { '720p': 419.3, '1080p': 715.3 },
      },
      {
        mode: 'i2v',
        resolutions: ['720p', '1080p'],
        durations: durRange(5, 20, 5),
        aspects: ['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'],
        audio: true,
        start: 'required',
        end: 'optional',
        seed: true,
        rates: { '720p': 419.3, '1080p': 715.3 },
      },
    ],
  },
  {
    id: 'ltx-2.5-fast',
    label: 'LTX 2.5 Fast · Có tiếng, góc máy mượt, tới 20s',
    fromPrice: 1400,
    modes: [
      {
        mode: 't2v',
        resolutions: ['1080p', '720p'],
        durations: [6, 8, 10, 12, 14, 16, 18, 20],
        aspects: ['16:9', '9:16'],
        audio: true,
        rates: { '720p': 222, '1080p': 320.6 },
      },
      {
        mode: 'i2v',
        resolutions: ['1080p', '720p'],
        durations: [6, 8, 10, 12, 14, 16, 18, 20],
        aspects: ['auto', '16:9', '9:16'],
        audio: true,
        start: 'required',
        end: 'optional',
        rates: { '720p': 222, '1080p': 320.6 },
      },
    ],
  },
  {
    id: 'happy-horse-1.1',
    label: 'Happy Horse 1.1 · Màu điện ảnh, tới 15s',
    fromPrice: 1100,
    modes: [
      {
        mode: 't2v',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 15, 5),
        aspects: HAPPY_ASPECTS,
        audio: false,
        seed: true,
        rates: { '720p': 345.3, '1080p': 444 },
      },
      {
        mode: 'i2v',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 15, 5),
        aspects: null,
        audio: false,
        start: 'required',
        seed: true,
        rates: { '720p': 345.3, '1080p': 444 },
      },
      {
        mode: 'ref',
        resolutions: ['1080p', '720p'],
        durations: durRange(3, 15, 5),
        aspects: HAPPY_ASPECTS,
        audio: false,
        refImages: 9,
        seed: true,
        rates: { '720p': 345.3, '1080p': 444 },
      },
    ],
  },
];

const ALL_VIDEO_MODELS = [...SEEDANCE_MODELS, ...CINEMA_MODELS];
const VIDEO_MODEL_MAP = new Map<string, VideoModelSpec>(ALL_VIDEO_MODELS.map((m) => [m.id, m]));

const IMG_ACCEPT = 'image/jpeg,image/png,image/webp';
const VID_ACCEPT = 'video/mp4,video/quicktime';
const AUD_ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4';

/** Sinh bộ ô nhập động chuẩn theo từng cặp `<modelId>:<mode>` từ `GET /v1/models` */
function buildVideoFields(models: VideoModelSpec[]): AiFieldDef[] {
  const entries = models.flatMap((m) => m.modes.map((md) => ({ key: `${m.id}:${md.mode}`, m, md })));
  const modesWithStart = entries.filter((e) => !!e.md.start).map((e) => e.key);
  const modesWithEnd = entries.filter((e) => !!e.md.end).map((e) => e.key);
  const modesWithRefImg = entries.filter((e) => (e.md.refImages ?? 0) > 0).map((e) => e.key);
  const modesWithRefVid = entries.filter((e) => (e.md.refVideos ?? 0) > 0).map((e) => e.key);
  const modesWithRefAud = entries.filter((e) => (e.md.refAudios ?? 0) > 0).map((e) => e.key);
  const modesWithAspects = entries.filter((e) => Array.isArray(e.md.aspects) && e.md.aspects.length > 0).map((e) => e.key);
  const modesWithAudio = entries.filter((e) => e.md.audio).map((e) => e.key);
  const modesWithDraft = entries.filter((e) => e.md.draft).map((e) => e.key);
  const modesWithNegative = entries.filter((e) => e.md.negative).map((e) => e.key);
  const modesWithSeed = entries.filter((e) => e.md.seed).map((e) => e.key);

  const maxRefImages = Math.max(0, ...entries.map((e) => e.md.refImages ?? 0));
  const maxRefVideos = Math.max(0, ...entries.map((e) => e.md.refVideos ?? 0));
  const maxRefAudios = Math.max(0, ...entries.map((e) => e.md.refAudios ?? 0));

  const fields: AiFieldDef[] = [
    {
      name: 'model',
      label: 'Model AI',
      type: 'select',
      required: true,
      default: models[0].id,
      options: models.map((m) => ({ value: m.id, label: m.label })),
    },
    {
      name: 'mode',
      label: 'Chế độ đầu vào',
      type: 'select',
      required: true,
      optionsBy: {
        field: 'model',
        map: Object.fromEntries(
          models.map((m) => [
            m.id,
            m.modes.map((md) => ({
              value: `${m.id}:${md.mode}`,
              label: md.label ?? MODE_LABELS[md.mode],
            })),
          ]),
        ),
      },
      help: 'Chọn chế độ tạo video: Chữ → Video, Ảnh → Video, Khung đầu – cuối hoặc Tham chiếu (@Image1, @Video1, @Audio1)',
    },
    {
      name: 'prompt',
      label: 'Mô tả cảnh & chuyển động (prompt)',
      type: 'textarea',
      required: true,
      max: 5000,
      placeholder: 'Mô tả bối cảnh, nhân vật, chuyển động máy quay, ánh sáng... Ở chế độ Tham chiếu có thể gọi @Image1, @Image2, @Video1, @Audio1.',
      help: 'Tối đa 5.000 ký tự (giới hạn từ máy chủ mô hình). Ở chế độ Tham chiếu có thể gọi @Image1, @Video1, @Audio1.',
    },
  ];

  if (modesWithStart.length) {
    fields.push({
      name: 'image',
      label: 'Ảnh khung đầu',
      type: 'image',
      accept: IMG_ACCEPT,
      showIf: { field: 'mode', in: modesWithStart },
      help: 'Tải lên ảnh khung hình mở đầu của video',
    });
  }
  if (modesWithEnd.length) {
    fields.push({
      name: 'lastFrame',
      label: 'Ảnh khung cuối',
      type: 'image',
      accept: IMG_ACCEPT,
      showIf: { field: 'mode', in: modesWithEnd },
      help: 'Chốt khung hình kết thúc (bắt buộc ở chế độ Khung đầu – cuối; tuỳ chọn ở Ảnh → Video)',
    });
  }
  if (modesWithRefImg.length) {
    fields.push({
      name: 'images',
      label: `Ảnh tham chiếu @Image1, @Image2... (tối đa ${maxRefImages} ảnh)`,
      type: 'image',
      multiple: true,
      maxFiles: maxRefImages,
      accept: IMG_ACCEPT,
      showIf: { field: 'mode', in: modesWithRefImg },
      help: 'Thứ tự ảnh #1, #2, #3... tương ứng @Image1, @Image2, @Image3 trong câu mô tả',
    });
  }
  if (modesWithRefVid.length) {
    fields.push({
      name: 'videos',
      label: `Video tham chiếu @Video1... (tối đa ${maxRefVideos} video)`,
      type: 'video',
      multiple: true,
      maxFiles: maxRefVideos,
      accept: VID_ACCEPT,
      showIf: { field: 'mode', in: modesWithRefVid },
      help: 'Tham chiếu chuyển động / góc máy (@Video1...). Hệ thống tự báo giá thời gian thực theo độ dài video tham chiếu đính kèm',
    });
  }
  if (modesWithRefAud.length) {
    fields.push({
      name: 'audios',
      label: `Âm thanh tham chiếu @Audio1... (tối đa ${maxRefAudios} file)`,
      type: 'audio',
      multiple: true,
      maxFiles: maxRefAudios,
      accept: AUD_ACCEPT,
      showIf: { field: 'mode', in: modesWithRefAud },
      help: 'File giọng thoại / nhạc nền MP3, WAV để nhân vật nhép môi hoặc khớp nhịp (@Audio1...)',
    });
  }

  fields.push(
    {
      name: 'resolution',
      label: 'Độ phân giải',
      type: 'select',
      required: true,
      optionsBy: {
        field: 'mode',
        map: Object.fromEntries(entries.map((e) => [e.key, resOpts(e.md.resolutions)])),
      },
    },
    {
      name: 'duration',
      label: 'Thời lượng video',
      type: 'select',
      required: true,
      optionsBy: {
        field: 'mode',
        map: Object.fromEntries(entries.map((e) => [e.key, secOpts(e.md.durations)])),
      },
    },
    {
      name: 'aspect',
      label: 'Tỉ lệ khung hình',
      type: 'select',
      required: true,
      showIf: { field: 'mode', in: modesWithAspects },
      optionsBy: {
        field: 'mode',
        map: Object.fromEntries(entries.filter((e) => e.md.aspects?.length).map((e) => [e.key, aspectOpts(e.md.aspects!)])),
      },
    },
  );

  if (modesWithAudio.length) {
    fields.push({
      name: 'audio',
      label: 'Tạo âm thanh & lời thoại',
      type: 'boolean',
      default: true,
      showIf: { field: 'mode', in: modesWithAudio },
      help: 'Tự sinh tiếng động môi trường và lời thoại theo cảnh (với Veo 3.1 & Kling 3.0, tắt tiếng giúp giảm mạnh chi phí)',
    });
  }
  if (modesWithDraft.length) {
    fields.push({
      name: 'draft',
      label: 'Bản nháp 480p tiết kiệm',
      type: 'boolean',
      default: false,
      showIf: { field: 'mode', in: modesWithDraft },
      help: 'Chạy thử bản nháp 480p với chi phí gốc chỉ 500đ/giây để duyệt chuyển động nhanh',
    });
  }
  if (modesWithNegative.length) {
    fields.push({
      name: 'negative',
      label: 'Không muốn có trong video (tuỳ chọn)',
      type: 'text',
      max: 1500,
      placeholder: 'Ví dụ: mờ, méo, biến dạng, chữ, logo...',
      showIf: { field: 'mode', in: modesWithNegative },
    });
  }
  if (modesWithSeed.length) {
    fields.push({
      name: 'seed',
      label: 'Seed cố định (tuỳ chọn)',
      type: 'text',
      max: 20,
      placeholder: 'Để trống = ngẫu nhiên (nhập số để giữ kết quả đồng nhất)',
      showIf: { field: 'mode', in: modesWithSeed },
    });
  }

  return fields;
}

// ---------------- Model Tạo ảnh & Sửa ảnh (`GET /v1/models` -> `image_models`) ----------------

interface ImageModelSpec {
  id: string;
  name: string;
  badge: string;
  genDesc: string;
  editDesc: string;
  sizes: string[];
  maxRefs: number;
  rates: Record<string, number>;
  perRef: number;
}

/** Đúng thứ tự & thông số 4 model ảnh riêng biệt trên `prismforge.cloud/app#bang-gia` & `GET /v1/models` */
const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: 'seedream-5.5',
    name: 'Seedream 5.5',
    badge: 'TOP',
    genDesc: 'Tạo ảnh AI chân thực, sắc nét 1K/2K bằng Seedream 5.5; hỗ trợ đính kèm tối đa 10 ảnh tham chiếu (@Image1...) để giữ đồng nhất nhân vật.',
    editDesc: 'Chỉnh sửa ảnh, thay trang phục/bối cảnh và giữ đồng nhất nhân vật chuẩn xác bằng Seedream 5.5 (nhận tối đa 10 ảnh tham chiếu @Image1...).',
    sizes: ['2K', '1K'],
    maxRefs: 10,
    rates: { '1K': 80, '2K': 100 },
    perRef: 29.6,
  },
  {
    id: 'flux-3',
    name: 'FLUX 3',
    badge: '2K',
    genDesc: 'Tạo ảnh AI độ chi tiết cao, bám sát mô tả cho ảnh sản phẩm, poster và minh hoạ bằng FLUX 3 (1K/2K, hỗ trợ tới 10 ảnh tham chiếu).',
    editDesc: 'Chỉnh sửa & ghép ảnh chi tiết cao bằng FLUX 3 (nhận tối đa 10 ảnh tham chiếu @Image1..., không tính phụ phí ảnh tham chiếu).',
    sizes: ['1K', '2K'],
    maxRefs: 10,
    rates: { '1K': 120, '2K': 480 },
    perRef: 0,
  },
  {
    id: 'gpt-image-2.6',
    name: 'GPT Image 2.6',
    badge: 'MỚI',
    genDesc: 'Tạo ảnh AI hiểu mô tả phức tạp, bố cục chuẩn và viết chữ trong ảnh chính xác bằng GPT Image 2.6 (1K/2K, hỗ trợ tới 16 ảnh tham chiếu).',
    editDesc: 'Chỉnh sửa ảnh & chữ viết trong ảnh chính xác bằng GPT Image 2.6 (nhận tối đa 16 ảnh tham chiếu @Image1, @Image2...).',
    sizes: ['1K', '2K'],
    maxRefs: 16,
    rates: { '1K': 140, '2K': 150 },
    perRef: 29.6,
  },
  {
    id: 'nano-banana-2.1',
    name: 'Nano Banana 2.1',
    badge: '4K',
    genDesc: 'Tạo ảnh AI tốc độ cao, sắc nét tới 4K bằng Nano Banana 2.1 (1K/2K/4K, hỗ trợ tới 10 ảnh tham chiếu).',
    editDesc: 'Sửa ảnh & ghép nhiều ảnh tham chiếu tự nhiên ở độ phân giải tới 4K bằng Nano Banana 2.1 (nhận tối đa 10 ảnh @Image1...).',
    sizes: ['1K', '2K', '4K'],
    maxRefs: 10,
    rates: { '1K': 120, '2K': 170, '4K': 350 },
    perRef: 7.4,
  },
];

/** Đúng 7 tỉ lệ khung hình & thứ tự mặc định `1:1` của `image_models` trong `GET /v1/models` */
const IMAGE_ASPECTS = opts([
  ['1:1', '1:1 Vuông'],
  ['4:3', '4:3 Ngang chuẩn'],
  ['3:4', '3:4 Chân dung'],
  ['16:9', '16:9 Ngang'],
  ['9:16', '9:16 Dọc (Story, TikTok)'],
  ['3:2', '3:2 Máy ảnh ngang'],
  ['2:3', '2:3 Máy ảnh dọc'],
]);

function buildStandaloneImageTool(m: ImageModelSpec, isEdit: boolean): AiToolDef {
  const sizeOptions = m.sizes.map((s) => ({
    value: s,
    label: s === '4K' ? '4K (≈ 4096px)' : s === '2K' ? '2K (≈ 2048px)' : '1K (≈ 1024px)',
  }));

  return {
    key: isEdit ? `edit-${m.id}` : `img-${m.id}`,
    name: isEdit ? `${m.name} · Sửa & ghép ảnh AI` : `${m.name} · Tạo ảnh AI`,
    category: isEdit ? 'chinh-sua-anh-ai' : 'image',
    icon: isEdit ? 'wand-sparkles' : 'sparkles',
    badge: m.badge,
    description: isEdit ? m.editDesc : m.genDesc,
    output: 'image',
    splitModels: false,
    supportsCost: true,
    unitLabel: 'ảnh',
    fields: isEdit
      ? [
          {
            name: 'images',
            label: `Ảnh cần sửa / ghép @Image1, @Image2... (tối đa ${m.maxRefs} ảnh)`,
            type: 'image',
            required: true,
            multiple: true,
            maxFiles: m.maxRefs,
            accept: IMG_ACCEPT,
            help: `Tải lên 1–${m.maxRefs} ảnh. Gọi ảnh thứ 1 là @Image1, ảnh thứ 2 là @Image2... trong mô tả.`,
          },
          {
            name: 'prompt',
            label: 'Yêu cầu chỉnh sửa / ghép ảnh (prompt)',
            type: 'textarea',
            required: true,
            max: 5000,
            placeholder: 'Ví dụ: Giữ nguyên khuôn mặt @Image1, mặc bộ trang phục ở @Image2, đặt trong bối cảnh quán cà phê nắng sớm...',
          },
          {
            name: 'size',
            label: 'Kích thước',
            type: 'select',
            required: true,
            default: m.sizes[0],
            options: sizeOptions,
          },
          { name: 'aspect', label: 'Khung hình', type: 'select', required: true, default: '1:1', options: IMAGE_ASPECTS },
        ]
      : [
          {
            name: 'prompt',
            label: 'Mô tả ảnh (prompt)',
            type: 'textarea',
            required: true,
            max: 5000,
            placeholder: 'Mô tả bức ảnh muốn tạo. Nếu đính kèm ảnh tham chiếu bên dưới, có thể gọi @Image1, @Image2... trong mô tả.',
          },
          {
            name: 'images',
            label: `Ảnh tham chiếu @Image1, @Image2... (tuỳ chọn, tối đa ${m.maxRefs} ảnh)`,
            type: 'image',
            multiple: true,
            maxFiles: m.maxRefs,
            accept: IMG_ACCEPT,
            help: `Bỏ trống để tạo ảnh mới từ văn bản; hoặc tải kèm 1–${m.maxRefs} ảnh tham chiếu (@Image1, @Image2...).`,
          },
          {
            name: 'size',
            label: 'Kích thước',
            type: 'select',
            required: true,
            default: m.sizes[0],
            options: sizeOptions,
          },
          { name: 'aspect', label: 'Khung hình', type: 'select', required: true, default: '1:1', options: IMAGE_ASPECTS },
        ],
    pricing: { mode: 'cost', markup: 35 },
  };
}

function resolveImageTool(toolKey: string): { spec: ImageModelSpec; isEdit: boolean } | null {
  if (toolKey.startsWith('img-')) {
    const spec = IMAGE_MODELS.find((m) => m.id === toolKey.slice(4));
    return spec ? { spec, isEdit: false } : null;
  }
  if (toolKey.startsWith('edit-')) {
    const spec = IMAGE_MODELS.find((m) => m.id === toolKey.slice(5));
    return spec ? { spec, isEdit: true } : null;
  }
  return null;
}

const isImageTool = (key: string) => resolveImageTool(key) !== null;

const TOOLS: AiToolDef[] = [
  {
    key: 'seedance-video',
    name: 'Tạo video Seedance 2.5',
    category: 'video',
    icon: 'film',
    badge: '2.5 HOT',
    featured: true,
    description:
      'Tạo video điện ảnh dài tới 30 giây có sẵn âm thanh, lời thoại tự nhiên bằng Seedance 2.5 & 2.5 Flash. Hỗ trợ Chữ → Video, Ảnh → Video và Tham chiếu đồng thời nhiều ảnh (@Image1), video (@Video1), âm thanh (@Audio1).',
    output: 'video',
    supportsCost: true,
    supportsDurationTiers: true,
    unitLabel: 'giây',
    units: (input) => Math.max(4, Math.min(30, Number(input.duration) || 5)),
    fields: buildVideoFields(SEEDANCE_MODELS),
    pricing: { mode: 'cost', markup: 35 },
  },
  {
    key: 'cinema-video',
    name: 'Tạo video AI Điện Ảnh',
    category: 'video',
    icon: 'clapperboard',
    badge: '4K · 30S',
    description:
      'Tổng hợp 15 mô hình tạo video thế hệ mới: Kling 4.0 (30s), Wan 3.0 (30s), Google Veo 3.1 (4K), Vidu Q4, Grok Imagine 1.5, MiniMax H3 Max, Gemini Omni Flash 1.2, FLUX 3 Max, LTX 2.5 Fast, Happy Horse 1.1.',
    output: 'video',
    supportsCost: true,
    supportsDurationTiers: true,
    unitLabel: 'giây',
    units: (input) => Math.max(1, Math.min(30, Number(input.duration) || 5)),
    fields: buildVideoFields(CINEMA_MODELS),
    pricing: { mode: 'cost', markup: 35 },
  },
  ...IMAGE_MODELS.map((m) => buildStandaloneImageTool(m, false)),
  ...IMAGE_MODELS.map((m) => buildStandaloneImageTool(m, true)),
];

// ---------------- URL & chuẩn hoá kết nối ----------------

function v1Base(config: AiProviderConfig): string {
  const raw = (config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
}

function siteOrigin(config: AiProviderConfig): string {
  return v1Base(config).replace(/\/v1$/i, '');
}

function pfUrl(config: AiProviderConfig, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean.startsWith('/v1/') || clean.startsWith('/api/')) {
    return `${siteOrigin(config)}${clean}`;
  }
  return `${v1Base(config)}${clean}`;
}

const keyHash = (config: AiProviderConfig) => createHash('sha1').update(`${v1Base(config)}|${config.apiKey || ''}`).digest('hex').slice(0, 12);

const scrubMsg = (msg: string | undefined | null): string =>
  (msg ?? '')
    .replace(/(?:https?:\/\/)?[\w.-]*prismforge[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/prism\s*forge|prismforge/gi, 'Hệ thống AI')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** Chuẩn hoá lỗi từ Prism Forge: 429 -> xếp hàng chờ luồng trống; 409 -> lệch giá expect (không trừ tiền nguồn, hoàn tiền khách); 401/402/403 -> bảo trì */
function mapPfError(err: unknown): never {
  if (err instanceof AiProviderError) {
    const status = Number((err.raw as { status?: unknown } | undefined)?.status ?? 0);
    if (status === 429) {
      throw new AiProviderError('Đang chờ luồng xử lý trống, hệ thống sẽ tự gửi ngay trong giây lát', { waitingSlot: true, retryMs: 15_000, raw: err.raw }, true);
    }
    if (status === 409) {
      quoteCache.clear();
      throw new AiProviderError('Bảng giá mô hình vừa cập nhật tức thời, vui lòng bấm Tạo lại (tiền đã được hoàn lại 100%)', err.raw, false);
    }
    if (status === 401 || status === 402 || status === 403) {
      throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Tiền đã được hoàn lại.', err.raw, false);
    }
    if (
      status >= 500 ||
      status === 0 ||
      /cloudflare|tunnel|unable to reach|bad gateway|gateway time-?out|service temporarily unavailable|fetch failed|timed?\s*out/i.test(err.message)
    ) {
      throw new AiProviderError('Máy chủ xử lý đang bận tạm thời, hệ thống sẽ tự thử lại ngay', err.raw, true);
    }
    throw new AiProviderError(scrubMsg(err.message) || 'Yêu cầu chưa hợp lệ, tiền đã được hoàn lại', err.raw, err.retryable);
  }
  throw err;
}

// ---------------- Upload file tham chiếu (`/v1/uploads`) + bộ nhớ đệm ----------------

const uploadIdCache = new Map<string, { id: string; exp: number }>();

function pruneMap<V extends { exp: number }>(map: Map<string, V>, max = 600) {
  if (map.size <= max) return;
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.exp <= now) map.delete(k);
  }
  while (map.size > max) {
    const first = map.keys().next().value;
    if (!first) break;
    map.delete(first);
  }
}

async function uploadMedia(ctx: AiCallContext, url: string, indexHint = 1, bypassCache = false): Promise<string> {
  const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
  const ck = `${keyHash(cfg)}:${url}`;
  if (!bypassCache) {
    const hit = uploadIdCache.get(ck);
    if (hit && hit.exp > Date.now()) return hit.id;
  }

  const loaded = await loadInputFile(ctx.readUpload, url);
  let data = loaded.data;
  let filename = loaded.filename || `file_${indexHint}`;
  const mime = (loaded.mimeType || '').toLowerCase();

  if (mime.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif|tiff?)$/i.test(filename)) {
    try {
      const meta = await sharp(data).metadata();
      const supportedFmt = meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp';
      const needsRotate = typeof meta.orientation === 'number' && meta.orientation !== 1;
      const tooLarge = data.length > 8 * 1024 * 1024 || (meta.width ?? 0) > 3072 || (meta.height ?? 0) > 3072;
      if (!supportedFmt || needsRotate || tooLarge) {
        const keepPng = meta.format === 'png' && !!meta.hasAlpha;
        const img = sharp(data).rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true });
        data = await (keepPng ? img.png() : img.jpeg({ quality: 92 })).toBuffer();
        filename = `image_${indexHint}.${keepPng ? 'png' : 'jpg'}`;
      } else {
        const ext = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpg';
        filename = `image_${indexHint}.${ext}`;
      }
    } catch {
      if (!/\.(jpe?g|png|webp)$/i.test(filename)) filename = `image_${indexHint}.jpg`;
    }
  }

  let res: Response;
  let text = '';
  try {
    res = await fetch(pfUrl(cfg, '/uploads'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(filename),
      },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(120_000),
    });
    text = await res.text();
  } catch (e) {
    throw new AiProviderError('Không tải được file tham chiếu lên máy chủ xử lý, hệ thống sẽ thử lại', { error: (e as Error).message }, true);
  }

  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { body: text.slice(0, 1000) };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Tiền đã được hoàn lại.', { status: res.status, data: json }, false);
    }
    const msg = scrubMsg(pickMessage(json)) || `Tải file tham chiếu lỗi (HTTP ${res.status})`;
    throw new AiProviderError(msg, { status: res.status, data: json }, res.status >= 500 || res.status === 429);
  }
  const id = str(json?.id ?? json?.upload?.id ?? json?.data?.id);
  if (!id) throw new AiProviderError('Máy chủ xử lý không trả mã file tham chiếu', json);
  pruneMap(uploadIdCache);
  uploadIdCache.set(ck, { id, exp: Date.now() + UPLOAD_CACHE_TTL_MS });
  return id;
}

const asUrls = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .map(str)
    .filter(Boolean)
    .slice(0, max);

function normalizeMentions(rawPrompt: string, imgCount = 0): string {
  let p = rawPrompt.trim();
  if (imgCount > 0 && /<IMAGE_\d+>/i.test(p)) {
    const zeroBased = /<IMAGE_0>/i.test(p);
    p = p.replace(/<IMAGE_(\d+)>/gi, (_m, d) => {
      const idx = zeroBased ? Number(d) + 1 : Number(d);
      return `@Image${Math.max(1, idx)}`;
    });
  }
  p = p
    .replace(/@image\s*(\d+)/gi, '@Image$1')
    .replace(/@video\s*(\d+)/gi, '@Video$1')
    .replace(/@audio\s*(\d+)/gi, '@Audio$1');
  return p;
}

/** Giải mã chế độ video thực tế của model từ `input.mode` (`<modelId>:<mode>` hoặc `t2v`/`i2v`/`flf`/`ref`) + file đính kèm */
function resolveVideoMode(spec: VideoModelSpec, input: AiInput): VideoModeSpec {
  const raw = str(input.mode).trim();
  const suffix = (raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw).toLowerCase();

  const hasRefs =
    (Array.isArray(input.images) ? input.images.length > 0 : !!str(input.images)) ||
    (Array.isArray(input.videos) ? input.videos.length > 0 : !!str(input.videos)) ||
    (Array.isArray(input.audios) ? input.audios.length > 0 : !!str(input.audios));
  const hasStart = !!str(input.image);
  const hasEnd = !!str(input.lastFrame);

  if (suffix === 'ref' || ((!suffix || suffix === 'auto' || suffix === 't2v') && hasRefs)) {
    const refMode = spec.modes.find((m) => m.mode === 'ref');
    if (refMode) return refMode;
  }
  if (suffix === 'flf' || ((!suffix || suffix === 'auto' || suffix === 't2v') && hasStart && hasEnd && spec.modes.some((m) => m.mode === 'flf'))) {
    const flfMode = spec.modes.find((m) => m.mode === 'flf');
    if (flfMode) return flfMode;
  }
  if (suffix === 'i2v' || ((!suffix || suffix === 'auto' || suffix === 't2v') && (hasStart || hasEnd))) {
    const i2vMode = spec.modes.find((m) => m.mode === 'i2v');
    if (i2vMode) return i2vMode;
  }

  return spec.modes.find((m) => m.mode === suffix) ?? spec.modes[0];
}

// ---------------- Báo giá trực tiếp (`/v1/quote`) + công thức chuẩn `/v1/models` ----------------

const quoteCache = new Map<string, { price: number; exp: number }>();
const round100 = (n: number) => Math.ceil(n / 100 - 1e-9) * 100;

/**
 * Công thức tính giá ngoại tuyến khớp 100% `price()` và `/v1/models` của Prism Forge
 * (chỉ dùng cho bảng mẫu Admin `__sample` hoặc xem nhanh giá trên form trước khi khách tải ảnh lên).
 */
async function offlineModelCost(tool: AiToolDef, input: AiInput, ctx: AiCallContext): Promise<number | null> {
  const imgMeta = resolveImageTool(tool.key);
  if (imgMeta) {
    const { spec, isEdit } = imgMeta;
    const size = spec.sizes.includes(str(input.size)) ? str(input.size) : spec.sizes[0];
    const base = spec.rates[size] ?? spec.rates['2K'] ?? 150;
    const uploadedRefs = asUrls(input.images, spec.maxRefs).length;
    const refs = isEdit ? Math.max(1, uploadedRefs) : uploadedRefs;
    return Math.max(80, Math.ceil((base + refs * spec.perRef) / 10 - 1e-9) * 10);
  }

  const spec = VIDEO_MODEL_MAP.get(str(input.model)) ?? SEEDANCE_MODELS[0];
  const md = resolveVideoMode(spec, input);

  const res = md.resolutions.includes(str(input.resolution)) ? str(input.resolution) : md.resolutions[0];
  const minDur = Math.min(...md.durations);
  const maxDur = Math.max(...md.durations);
  let dur = Number(input.duration) || md.durations[0] || 5;
  if (!md.durations.includes(dur)) {
    dur = Math.max(minDur, Math.min(maxDur, Math.round(dur)));
    if (!md.durations.includes(dur)) {
      dur = md.durations.reduce((a, b) => (Math.abs(b - dur) < Math.abs(a - dur) ? b : a), md.durations[0]);
    }
  }

  const draft = !!md.draft && (input.draft === true || input.draft === 'true');
  const muted = md.audio && (input.audio === false || input.audio === 'false');

  let perSec =
    draft && md.draftRate
      ? md.draftRate
      : muted && md.muteRates?.[res] != null
        ? md.muteRates[res]
        : md.rates[res] ?? Object.values(md.rates)[0] ?? 500;

  let secs = dur;
  const refVidUrls = md.mode === 'ref' ? asUrls(input.videos, Math.max(1, md.refVideos || 0)) : [];
  if (md.mode === 'ref' && refVidUrls.length > 0) {
    const durs = await Promise.all(refVidUrls.map((u) => ctx.uploadDuration(u).catch(() => null)));
    const vs = durs.reduce<number>((sum, d) => sum + Math.max(1, Math.ceil(Number(d) || 5)), 0);
    secs += vs;
    perSec *= 0.65;
  }

  return Math.max(100, round100(perSec * secs));
}

/** Dựng payload chuẩn 100% theo `GET /v1/models` dùng chung cho cả `POST /v1/quote` và `POST /v1/videos` */
async function buildVideoPayload(input: AiInput, ctx: AiCallContext, uploadFiles: boolean) {
  const spec = VIDEO_MODEL_MAP.get(str(input.model)) ?? SEEDANCE_MODELS[0];
  const md = resolveVideoMode(spec, input);

  const rawRefImgs = (Array.isArray(input.images) ? input.images : input.images ? [input.images] : []).map(str).filter(Boolean);
  const rawRefVids = (Array.isArray(input.videos) ? input.videos : input.videos ? [input.videos] : []).map(str).filter(Boolean);
  const rawRefAuds = (Array.isArray(input.audios) ? input.audios : input.audios ? [input.audios] : []).map(str).filter(Boolean);

  if (md.mode === 'ref') {
    if (md.refImages && rawRefImgs.length > md.refImages) {
      throw new AiProviderError(`Mô hình này nhận tối đa ${md.refImages} ảnh tham chiếu`);
    }
    if (md.refVideos && rawRefVids.length > md.refVideos) {
      throw new AiProviderError(`Mô hình này nhận tối đa ${md.refVideos} video tham chiếu`);
    }
    if (md.refAudios && rawRefAuds.length > md.refAudios) {
      throw new AiProviderError(`Mô hình này nhận tối đa ${md.refAudios} file âm thanh tham chiếu`);
    }
    if (md.refTotal && rawRefImgs.length + rawRefVids.length + rawRefAuds.length > md.refTotal) {
      throw new AiProviderError(`Mô hình này nhận tối đa tổng cộng ${md.refTotal} file tham chiếu`);
    }
  }

  const refImgUrls = md.mode === 'ref' && md.refImages ? rawRefImgs.slice(0, md.refImages) : [];
  const refVidUrls = md.mode === 'ref' && md.refVideos ? rawRefVids.slice(0, md.refVideos) : [];
  const refAudUrls = md.mode === 'ref' && md.refAudios ? rawRefAuds.slice(0, md.refAudios) : [];

  const startUrl = md.mode === 'i2v' || md.mode === 'flf' ? str(input.image) || (md.mode === 'i2v' ? str(input.lastFrame) : '') : '';
  const endUrl = (md.mode === 'flf' || (md.mode === 'i2v' && md.end)) && str(input.image) && str(input.lastFrame) ? str(input.lastFrame) : '';

  const missingRequiredFiles =
    (md.start === 'required' && !startUrl) ||
    (md.end === 'required' && !endUrl) ||
    (md.mode === 'ref' && !refImgUrls.length && !refVidUrls.length && !refAudUrls.length);

  const resolution = md.resolutions.includes(str(input.resolution)) ? str(input.resolution) : md.resolutions[0];

  let duration = Number(input.duration) || md.durations[0] || 5;
  if (!md.durations.includes(duration)) {
    duration = md.durations.reduce((a, b) => (Math.abs(b - duration) < Math.abs(a - duration) ? b : a), md.durations[0]);
  }

  const rawAspect = str(input.aspect);
  const aspect = md.aspects?.length ? (md.aspects.includes(rawAspect) ? rawAspect : md.aspects[0]) : undefined;
  const draft = !!md.draft && (input.draft === true || input.draft === 'true');
  const audio = md.audio ? input.audio !== false && input.audio !== 'false' : undefined;
  const prompt = normalizeMentions(str(input.prompt) || 'Cảnh quay điện ảnh chuyển động mượt mà', refImgUrls.length);
  const negative = md.negative ? str(input.negative).trim().slice(0, 1500) : '';
  const rawSeed = md.seed ? str(input.seed).trim() : '';
  const seed = rawSeed && /^\d+$/.test(rawSeed) ? Number(rawSeed) : undefined;

  const payload: Record<string, unknown> = {
    model: spec.id,
    mode: md.mode,
    prompt,
    ...(draft ? { draft: true } : { resolution }),
    duration,
    ...(aspect ? { aspect } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(negative ? { negative } : {}),
    ...(seed !== undefined && Number.isSafeInteger(seed) ? { seed } : {}),
  };

  if (!uploadFiles) {
    return {
      spec,
      md,
      payload,
      missingRequiredFiles,
      hasFiles: !!(startUrl || endUrl || refImgUrls.length || refVidUrls.length || refAudUrls.length),
    };
  }

  if (md.mode === 'ref' && (refImgUrls.length || refVidUrls.length || refAudUrls.length)) {
    if (refImgUrls.length) payload.images = await Promise.all(refImgUrls.map((u, i) => uploadMedia(ctx, u, i + 1)));
    if (refVidUrls.length) payload.videos = await Promise.all(refVidUrls.map((u, i) => uploadMedia(ctx, u, i + 1)));
    if (refAudUrls.length) payload.audios = await Promise.all(refAudUrls.map((u, i) => uploadMedia(ctx, u, i + 1)));
  } else if (startUrl) {
    const [startId, endId] = await Promise.all([
      uploadMedia(ctx, startUrl, 1),
      endUrl ? uploadMedia(ctx, endUrl, 2) : Promise.resolve(''),
    ]);
    payload.start = startId;
    if (endId) payload.end = endId;
  }

  return {
    spec,
    md,
    payload,
    missingRequiredFiles,
    hasFiles: !!(payload.start || payload.images || payload.videos || payload.audios),
  };
}

/** Gọi `POST /v1/quote` lấy giá VNĐ chính xác tuyệt đối từ máy chủ Prism Forge (có thử lại 1 lần nếu nghẽn mạng thoáng qua) */
async function fetchAuthoritativeQuote(cfg: AiProviderConfig, cacheKey: string, quoteBody: Record<string, unknown>): Promise<number> {
  const hit = quoteCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.price;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const q = await providerFetch<any>(cfg, '/quote', { json: quoteBody, timeoutMs: 20_000 });
      const price = Number(q?.price ?? q?.cost ?? q?.total ?? q?.amount);
      if (Number.isFinite(price) && price > 0) {
        pruneMap(quoteCache);
        quoteCache.set(cacheKey, { price, exp: Date.now() + CACHE_TTL_MS });
        return price;
      }
      lastErr = new AiProviderError('Phản hồi báo giá từ nguồn không hợp lệ', q);
    } catch (e) {
      lastErr = e;
      if (e instanceof AiProviderError && !e.retryable) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiProviderError('Không lấy được báo giá chính xác từ máy chủ xử lý, vui lòng thử lại sau giây lát');
}

async function downloadResultFile(ctx: AiCallContext, kind: 'video' | 'image', rawId: string, hintUrl?: string): Promise<AiOutputFile> {
  const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
  const primaryPath = kind === 'image' ? `/images/${encodeURIComponent(rawId)}/file` : `/videos/${encodeURIComponent(rawId)}/file`;
  const candidates = [pfUrl(cfg, primaryPath)];
  if (hintUrl) {
    const resolved = pfUrl(cfg, hintUrl);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }

  const originHost = (() => {
    try {
      return new URL(siteOrigin(cfg)).hostname.toLowerCase();
    } catch {
      return 'prismforge.cloud';
    }
  })();

  let lastStatus = 0;
  for (const target of candidates) {
    let sameHost = false;
    try {
      sameHost = new URL(target).hostname.toLowerCase() === originHost;
    } catch {
      sameHost = true;
    }
    const res = await fetch(target, {
      headers: sameHost ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(180_000),
    }).catch((e: Error) => {
      throw new AiProviderError('Không tải được file kết quả, hệ thống sẽ tự thử lại', { error: e.message }, true);
    });
    lastStatus = res.status;
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) continue;
    const ct = (res.headers.get('content-type') || (kind === 'image' ? 'image/png' : 'video/mp4')).split(';')[0].trim();
    return { url: '', type: kind, data: buf, mimeType: ct };
  }

  throw new AiProviderError(
    `Không tải được file kết quả (HTTP ${lastStatus || 'timeout'})`,
    { id: rawId, status: lastStatus },
    lastStatus === 0 || lastStatus >= 500 || lastStatus === 429,
  );
}

export const prismforgeProvider: AiProvider = {
  key: 'prismforge',
  name: 'Prism Forge · Seedance 2.5',
  website: 'https://prismforge.cloud',
  costUnit: 'VNĐ',
  rate: 1,
  tools: TOOLS,

  async cost(tool, input, ctx) {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    const isSample = input.__sample === true;
    if (!cfg.apiKey) return offlineModelCost(tool, input, ctx);

    try {
      const imgMeta = resolveImageTool(tool.key);
      if (imgMeta) {
        const { spec, isEdit } = imgMeta;
        const size = spec.sizes.includes(str(input.size)) ? str(input.size) : spec.sizes[0];
        const aspect = str(input.aspect) || '1:1';
        const allRefs = isSample ? [] : (Array.isArray(input.images) ? input.images : input.images ? [input.images] : []).map(str).filter(Boolean);
        if (allRefs.length > spec.maxRefs) {
          throw new AiProviderError(`Mô hình ${spec.name} chỉ nhận tối đa ${spec.maxRefs} ảnh tham chiếu`);
        }
        // Ở bảng giá mẫu (`__sample`) hoặc công cụ Sửa & ghép ảnh chưa tải ảnh lên: báo giá chuẩn theo bảng giá `/v1/models`
        if (isSample || (isEdit && allRefs.length === 0)) {
          return offlineModelCost(tool, input, ctx);
        }
        const images = allRefs.length ? await Promise.all(allRefs.map((u, i) => uploadMedia(ctx, u, i + 1))) : undefined;
        const quoteBody: Record<string, unknown> = {
          model: spec.id,
          prompt: 'quote',
          size,
          aspect,
          ...(images?.length ? { images } : {}),
        };
        const cacheKey = `${keyHash(cfg)}:img:${spec.id}|${size}|${aspect}|${(images ?? []).join(',')}`;
        return await fetchAuthoritativeQuote(cfg, cacheKey, quoteBody);
      }

      const { payload, missingRequiredFiles, hasFiles } = await buildVideoPayload(input, ctx, !isSample);
      // Khi khách mới đổi sang chế độ Ảnh → Video / Khung đầu – cuối / Tham chiếu mà chưa tải file (hoặc bảng mẫu Admin): tính bằng công thức chuẩn `/v1/models`
      if (isSample || missingRequiredFiles) {
        return offlineModelCost(tool, input, ctx);
      }
      const cacheKey = hasFiles
        ? `${keyHash(cfg)}:vidf:${JSON.stringify({ ...payload, prompt: '', negative: '', seed: undefined })}`
        : `${keyHash(cfg)}:vid:${payload.model}|${payload.mode}|${payload.resolution ?? 'draft'}|${payload.duration}|${payload.audio ?? ''}|${payload.draft ?? ''}`;
      return await fetchAuthoritativeQuote(cfg, cacheKey, { ...payload, prompt: 'quote' });
    } catch (err) {
      if (isSample) return offlineModelCost(tool, input, ctx);
      const status = Number(((err as AiProviderError | undefined)?.raw as { status?: unknown } | undefined)?.status ?? 0);
      const msg = String((err as Error | undefined)?.message ?? '');
      const isTransient =
        (err instanceof AiProviderError && err.retryable) ||
        status >= 500 ||
        status === 429 ||
        /cloudflare|tunnel|unable to reach|bad gateway|gateway time-?out|service temporarily unavailable|fetch failed|timed?\s*out/i.test(msg);
      if (isTransient) {
        const fallback = await offlineModelCost(tool, input, ctx).catch(() => null);
        if (fallback !== null && Number.isFinite(fallback) && fallback > 0) return fallback;
      }
      mapPfError(err);
    }
  },

  async submit(tool, input, ctx) {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    if (!cfg.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');

    try {
      const imgMeta = resolveImageTool(tool.key);
      if (imgMeta) {
        const { spec, isEdit } = imgMeta;
        const size = spec.sizes.includes(str(input.size)) ? str(input.size) : spec.sizes[0];
        const aspect = str(input.aspect) || '1:1';
        const allRefs = (Array.isArray(input.images) ? input.images : input.images ? [input.images] : []).map(str).filter(Boolean);
        if (isEdit && allRefs.length === 0) {
          throw new AiProviderError('Vui lòng tải lên ít nhất 1 ảnh cần sửa hoặc ghép');
        }
        if (allRefs.length > spec.maxRefs) {
          throw new AiProviderError(`Mô hình ${spec.name} chỉ nhận tối đa ${spec.maxRefs} ảnh tham chiếu`);
        }
        const images = allRefs.length ? await Promise.all(allRefs.map((u, i) => uploadMedia(ctx, u, i + 1))) : undefined;
        const prompt = normalizeMentions(str(input.prompt), allRefs.length);
        const cacheKey = `${keyHash(cfg)}:img:${spec.id}|${size}|${aspect}|${(images ?? []).join(',')}`;
        const expectedPrice = await fetchAuthoritativeQuote(cfg, cacheKey, {
          model: spec.id,
          prompt: 'quote',
          size,
          aspect,
          ...(images?.length ? { images } : {}),
        });

        const res = await providerFetch<any>(
          cfg,
          '/images',
          {
            json: {
              model: spec.id,
              prompt,
              size,
              aspect,
              expect: expectedPrice,
              ...(images?.length ? { images } : {}),
            },
            timeoutMs: 90_000,
          },
        );
        const imgObj = res?.image && typeof res.image === 'object' ? res.image : res;
        const id = str(imgObj?.id ?? res?.id);
        if (!id) throw new AiProviderError('Máy chủ xử lý không trả mã tác vụ ảnh', res);
        const st = str(imgObj?.status).toLowerCase();
        if (st === 'done' || st === 'completed' || st === 'succeeded') {
          const file = await downloadResultFile(ctx, 'image', id, str(imgObj?.image_url ?? imgObj?.url));
          return { status: 'succeeded', providerTaskId: `img:${id}`, files: [file], raw: res };
        }
        return { status: 'processing', providerTaskId: `img:${id}`, progress: Number(imgObj?.progress) || 10, raw: res };
      }

      const { md, payload, missingRequiredFiles, hasFiles } = await buildVideoPayload(input, ctx, true);
      if (missingRequiredFiles) {
        if (md.mode === 'flf') {
          throw new AiProviderError('Chế độ Khung đầu – cuối yêu cầu tải lên đủ cả Ảnh khung đầu và Ảnh khung cuối');
        }
        if (md.mode === 'i2v') {
          throw new AiProviderError('Chế độ Ảnh → Video yêu cầu tải lên Ảnh khung đầu');
        }
        throw new AiProviderError('Chế độ Tham chiếu yêu cầu tải lên ít nhất 1 ảnh, video hoặc âm thanh tham chiếu');
      }

      const cacheKey = hasFiles
        ? `${keyHash(cfg)}:vidf:${JSON.stringify({ ...payload, prompt: '', negative: '', seed: undefined })}`
        : `${keyHash(cfg)}:vid:${payload.model}|${payload.mode}|${payload.resolution ?? 'draft'}|${payload.duration}|${payload.audio ?? ''}|${payload.draft ?? ''}`;
      const expectedPrice = await fetchAuthoritativeQuote(cfg, cacheKey, { ...payload, prompt: 'quote' });

      const res = await providerFetch<any>(cfg, '/videos', { json: { ...payload, expect: expectedPrice }, timeoutMs: 90_000 });
      const vidObj = res?.video && typeof res.video === 'object' ? res.video : res?.job && typeof res.job === 'object' ? res.job : res;
      const id = str(vidObj?.id ?? res?.id);
      if (!id) throw new AiProviderError('Máy chủ xử lý không trả mã tác vụ video', res);
      return { status: 'processing', providerTaskId: `vid:${id}`, progress: Number(vidObj?.progress) || 5, raw: res };
    } catch (err) {
      mapPfError(err);
    }
  },

  async poll(tool, providerTaskId, ctx): Promise<AiProviderResult> {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    const isImg = providerTaskId.startsWith('img:') || isImageTool(tool.key);
    const rawId = providerTaskId.replace(/^(?:vid|img):/, '');
    const path = isImg ? `/images/${encodeURIComponent(rawId)}` : `/videos/${encodeURIComponent(rawId)}`;

    let res: any;
    try {
      res = await providerFetch<any>(cfg, path, { timeoutMs: 30_000 });
    } catch (err) {
      mapPfError(err);
    }

    const item = isImg
      ? res?.image && typeof res.image === 'object'
        ? res.image
        : res
      : res?.video && typeof res.video === 'object'
        ? res.video
        : res?.job && typeof res.job === 'object'
          ? res.job
          : res;

    const status = str(item?.status).toLowerCase();
    if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      const msg = scrubMsg(pickMessage(item) || str(item?.error)) || (isImg ? 'Không tạo được ảnh, tiền đã được hoàn lại' : 'Không tạo được video, tiền đã được hoàn lại');
      return { status: 'failed', providerTaskId, error: msg, raw: res };
    }
    if (!['done', 'completed', 'complete', 'succeeded'].includes(status)) {
      const fallbackProg = status === 'running' ? 35 : 10;
      return { status: 'processing', providerTaskId, progress: Number(item?.progress) || fallbackProg, raw: res };
    }

    const hintUrl = isImg ? str(item?.image_url ?? item?.url) : str(item?.video_url ?? item?.url);
    const file = await downloadResultFile(ctx, isImg ? 'image' : 'video', rawId, hintUrl);
    return { status: 'succeeded', providerTaskId, files: [file], raw: res };
  },

  async balance(ctx) {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    if (!cfg.apiKey) return null;
    const res = await providerFetch<any>(cfg, '/me', { timeoutMs: 15_000 });
    const raw = res?.balance ?? res?.user?.balance ?? res?.balance_vnd ?? res?.data?.balance;
    const balance = Number(raw);
    return Number.isFinite(balance) ? { balance, unit: 'VNĐ' } : null;
  },

  async catalog(ctx): Promise<AiCatalogItem[]> {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    if (cfg.apiKey) {
      const res = await providerFetch<any>(cfg, '/models', { timeoutMs: 20_000 });
      const vids = Array.isArray(res?.models) ? res.models : Array.isArray(res?.data) ? res.data : [];
      const imgs = Array.isArray(res?.image_models) ? res.image_models : [];
      return [...vids, ...imgs]
        .map((m: any) => ({ id: str(m?.id), label: str(m?.name || m?.label || m?.id) }))
        .filter((x) => !!x.id);
    }
    const res = await fetch(`${siteOrigin(cfg)}/api/site`, {
      headers: { Accept: 'application/json', 'User-Agent': 'NovAIStudio/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new AiProviderError(`Không đọc được danh mục model (HTTP ${res.status})`);
    const data: any = await res.json();
    const list = Array.isArray(data?.models) ? data.models : [];
    return list.map((m: any) => ({ id: str(m?.id), label: str(m?.name || m?.id) })).filter((x: AiCatalogItem) => !!x.id);
  },

  async maintenanceCheck(ctx) {
    const cfg = { ...ctx.config, baseUrl: v1Base(ctx.config) };
    if (!cfg.apiKey?.trim()) return null;
    const res = await providerFetch<any>(cfg, '/models', { timeoutMs: 12_000 }).catch(() => null);
    if (!res) return null;
    const vids = Array.isArray(res?.models) ? res.models : Array.isArray(res?.data) ? res.data : [];
    const imgs = Array.isArray(res?.image_models) ? res.image_models : [];
    const all = [...vids, ...imgs];
    if (!all.length) return null;
    const downIds = new Set<string>();
    for (const m of all) {
      const id = str(m?.id);
      if (!id) continue;
      const st = str(m?.status || m?.state).toLowerCase();
      if (m?.maintenance === true || m?.enabled === false || m?.available === false || /maint|disable|offline|down/.test(st)) {
        downIds.add(id);
      }
    }
    const down = new Set<string>();
    for (const t of TOOLS) {
      const imgMeta = resolveImageTool(t.key);
      if (imgMeta && downIds.has(imgMeta.spec.id)) {
        down.add(t.key);
      }
      const mf = t.fields.find((f) => f.name === 'model' && Array.isArray(f.options));
      if (mf?.options?.length) {
        for (const opt of mf.options) {
          if (downIds.has(String(opt.value))) down.add(`${t.key}~${opt.value}`);
        }
      }
    }
    return down;
  },
};
