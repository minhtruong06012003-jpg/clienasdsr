import { AiProviderError, type AiCallContext, type AiFieldDef, type AiInput, type AiProvider, type AiToolDef } from '../ai.types.js';
import { getTavtavvideoBridge, sanitizeErrorMessage, type TavtavvideoJobKind } from '../tavtavvideo-bridge.service.js';
import { str } from './http.js';

/**
 * Nguồn `tavtavvideo` — Video AI Studio qua cụm worker Client trực tuyến (kết nối ngược qua `/api/tavtavvideo-worker`).
 * Cung cấp 12 công cụ độc lập theo 4 tính năng × 3 chế độ chất lượng đầu ra (720p HD, 1080p Full HD, 4K Ultra HD):
 *   A. Motion Control 10s (Nhảy & chuyển động theo video mẫu):
 *      - `tavtavvideo.motion-720p`, `tavtavvideo.motion-1080p`, `tavtavvideo.motion-4k`
 *   B. Motion Control 30s (Cắt 3 cảnh chuẩn 10s chạy trên cùng 1 hồ sơ & ghép liền mạch kèm nhạc gốc):
 *      - `tavtavvideo.motion-30s-720p`, `tavtavvideo.motion-30s-1080p`, `tavtavvideo.motion-30s-4k`
 *   C. Ảnh thành Video (Image-to-Video):
 *      - `tavtavvideo.image-to-video-720p`, `tavtavvideo.image-to-video-1080p`, `tavtavvideo.image-to-video-4k`
 *   D. Văn bản thành Video (Text-to-Video):
 *      - `tavtavvideo.text-to-video-720p`, `tavtavvideo.text-to-video-1080p`, `tavtavvideo.text-to-video-4k`
 * Toàn bộ công cụ của `tavtavvideo` dùng cơ chế đặt giá cố định tự do (`mode: 'fixed'`, `supportsCost: false`).
 */

const AUDIO_MODE_OPTIONS = [
  { value: 'sound', label: 'Có âm thanh tự nhiên / Nhạc gốc (Mặc định)' },
  { value: 'none', label: 'Tắt âm thanh (Video không tiếng)' },
];

const MOTION_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · rõ khuôn mặt và trang phục · tối đa 50 MB',
  },
  {
    name: 'video',
    label: 'Video chuyển động mẫu (Tối đa 10s)',
    type: 'video',
    required: true,
    accept: 'video/mp4,video/quicktime',
    help: 'Tải file MP4 / MOV hoặc dán link video trực tiếp (.mp4 / .mov) · gói tối đa 10s (video dài hơn tự động lấy 10s đầu)',
  },
  {
    name: 'backgroundMode',
    label: 'Bối cảnh nền',
    type: 'select',
    required: true,
    default: 'keep_photo_bg',
    options: [
      {
        value: 'keep_photo_bg',
        label: 'Giữ nền của ảnh nhân vật',
        hint: 'Khoá cố định bối cảnh gốc trong ảnh nhân vật xuyên suốt video',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '1:1', label: '1:1 (Vuông · Facebook / Instagram)' },
    ],
  },
  {
    name: 'prompt',
    label: 'Mô tả bổ sung (Không bắt buộc)',
    type: 'textarea',
    max: 2000,
    placeholder: 'Có thể để trống hoặc ghi chú thêm về biểu cảm, ánh sáng, phong cách...',
  },
];

const MOTION_15S_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · rõ khuôn mặt và trang phục · tối đa 50 MB',
  },
  {
    name: 'video',
    label: 'Video chuyển động mẫu (Tối đa 15s)',
    type: 'video',
    required: true,
    accept: 'video/mp4,video/quicktime',
    help: 'Tải file MP4 / MOV hoặc dán link video trực tiếp (.mp4 / .mov) · dựng liền mạch tối đa 15s (video dài hơn tự động lấy 15s đầu)',
  },
  {
    name: 'backgroundMode',
    label: 'Bối cảnh nền',
    type: 'select',
    required: true,
    default: 'keep_photo_bg',
    options: [
      {
        value: 'keep_photo_bg',
        label: 'Giữ nền của ảnh nhân vật',
        hint: 'Khoá cố định bối cảnh gốc trong ảnh nhân vật xuyên suốt video',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '1:1', label: '1:1 (Vuông · Facebook / Instagram)' },
    ],
  },
  {
    name: 'prompt',
    label: 'Mô tả bổ sung (Không bắt buộc)',
    type: 'textarea',
    max: 2000,
    placeholder: 'Có thể để trống hoặc ghi chú thêm về biểu cảm, ánh sáng, phong cách...',
  },
];

const MOTION_GT10S_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · rõ khuôn mặt và trang phục xuyên suốt video · tối đa 50 MB',
  },
  {
    name: 'video',
    label: 'Video chuyển động mẫu (Từ 10s – 30s)',
    type: 'video',
    required: true,
    accept: 'video/mp4,video/quicktime',
    help: 'Từ 10–20s tính giá mốc 10–20s (ghép 2 cảnh) · Từ 20–30s tính giá mốc 20–30s (ghép 3 cảnh) · giữ nguyên nhạc gốc',
  },
  {
    name: 'backgroundMode',
    label: 'Bối cảnh nền',
    type: 'select',
    required: true,
    default: 'keep_photo_bg',
    options: [
      {
        value: 'keep_photo_bg',
        label: 'Giữ nền của ảnh nhân vật',
        hint: 'Khoá cố định bối cảnh gốc trong ảnh nhân vật xuyên suốt video',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '1:1', label: '1:1 (Vuông · Facebook / Instagram)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
  {
    name: 'prompt',
    label: 'Mô tả bổ sung (Không bắt buộc)',
    type: 'textarea',
    max: 2000,
    placeholder: 'Có thể để trống hoặc ghi chú thêm về biểu cảm, ánh sáng, phong cách...',
  },
];

const IMAGE_MODEL_OPTIONS = [
  { value: 'nano_banana', label: 'Nano Banana 2.1 · Tốc độ nhanh, chi tiết cân bằng (Mặc định)' },
  { value: 'nano_banana_pro', label: 'Nano Banana Pro · Chất lượng studio cao nhất' },
  { value: 'nano_banana_lite', label: 'Nano Banana 2 Lite · Siêu tốc độ' },
];

const IMAGE_ASPECT_OPTIONS = [
  { value: '1:1', label: '1:1 (Vuông · Avatar / Bài đăng)' },
  { value: '9:16', label: '9:16 (Dọc · Story / TikTok / Reels)' },
  { value: '16:9', label: '16:9 (Ngang · Banner / YouTube)' },
  { value: '4:3', label: '4:3 (Ngang cổ điển)' },
  { value: '3:4', label: '3:4 (Chân dung tiêu chuẩn)' },
];

const TEXT_TO_IMAGE_FIELDS: AiFieldDef[] = [
  {
    name: 'prompt',
    label: 'Mô tả hình ảnh cần tạo',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Nhập chi tiết chủ thể, bối cảnh, ánh sáng, phong cách nghệ thuật mong muốn...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '1:1',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'model',
    label: 'Mô hình tạo ảnh',
    type: 'select',
    required: true,
    default: 'nano_banana',
    options: IMAGE_MODEL_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt tạo từ 1 đến 4 ảnh cùng lúc',
  },
];

const IMAGE_TO_IMAGE_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh gốc / Tham chiếu chính',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · ảnh nhân vật, sản phẩm hoặc bối cảnh cần chỉnh sửa / phối cảnh · tối đa 50 MB',
  },
  {
    name: 'image2',
    label: 'Ảnh tham chiếu phụ 2 (Không bắt buộc)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'Tuỳ chọn đính kèm thêm ảnh trang phục / sản phẩm / bối cảnh thứ 2 để ghép chung trên Chrome',
  },
  {
    name: 'image3',
    label: 'Ảnh tham chiếu phụ 3 (Không bắt buộc)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'image4',
    label: 'Ảnh tham chiếu phụ 4 (Không bắt buộc)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'prompt',
    label: 'Yêu cầu chỉnh sửa / phối cảnh',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Ví dụ: Giữ nguyên khuôn mặt nhân vật, đổi sang bối cảnh quán cà phê sang trọng ánh nắng chiều...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '1:1',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'model',
    label: 'Mô hình tạo ảnh',
    type: 'select',
    required: true,
    default: 'nano_banana',
    options: IMAGE_MODEL_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt tạo từ 1 đến 4 ảnh cùng lúc',
  },
];

const IMAGE_TO_VIDEO_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh gốc / Nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · ảnh nhân vật, sản phẩm hoặc bối cảnh cần chuyển thành video · tối đa 50 MB',
  },
  {
    name: 'image2',
    label: 'Ảnh tham chiếu phụ (Không bắt buộc)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'Tuỳ chọn đính kèm thêm ảnh sản phẩm / đạo cụ / bối cảnh thứ 2 để kết hợp trong video',
  },
  {
    name: 'prompt',
    label: 'Mô tả chuyển động & cảnh quay',
    type: 'textarea',
    required: false,
    max: 4000,
    placeholder: 'Ví dụ: Nhân vật mỉm cười tự nhiên, bước đi nhẹ nhàng dưới nắng chiều điện ảnh, máy quay dolly chậm... (để trống = chuyển động tự nhiên)',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
];

const IMAGE_TO_VIDEO_15S_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh gốc / Nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · tạo video liền mạch 15 giây bằng mô hình Omni 1.2 mới nhất · tối đa 50 MB',
  },
  {
    name: 'image2',
    label: 'Ảnh tham chiếu phụ (Không bắt buộc)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'Tuỳ chọn đính kèm thêm ảnh sản phẩm / đạo cụ / bối cảnh thứ 2 để kết hợp trong video 15s',
  },
  {
    name: 'prompt',
    label: 'Mô tả chuyển động & diễn biến 15 giây',
    type: 'textarea',
    required: false,
    max: 4000,
    placeholder: 'Ví dụ: Nhân vật mỉm cười, bước đi tự nhiên dưới nắng chiều, máy quay chuyển động mượt liền mạch 15 giây... (để trống = chuyển động tự nhiên)',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
];

const TEXT_TO_VIDEO_FIELDS: AiFieldDef[] = [
  {
    name: 'prompt',
    label: 'Mô tả cảnh quay video',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Nhập chi tiết bối cảnh, nhân vật, hành động, góc máy quay, ánh sáng và âm thanh mong muốn...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '16:9',
    options: [
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
];

const TEXT_TO_VIDEO_15S_FIELDS: AiFieldDef[] = [
  {
    name: 'prompt',
    label: 'Mô tả cảnh quay video 15 giây',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Nhập chi tiết bối cảnh, nhân vật, diễn biến hành động 15 giây, góc máy quay, ánh sáng và lời thoại / âm thanh mong muốn...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '16:9',
    options: [
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
];

const ECO_TEXT_TO_IMAGE_FIELDS: AiFieldDef[] = [
  {
    name: 'prompt',
    label: 'Mô tả hình ảnh cần tạo',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Nhập chi tiết chủ thể, bối cảnh, ánh sáng, phong cách nghệ thuật mong muốn...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '1:1',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt tạo từ 1 đến 4 ảnh gốc Full-Size 2K trực tiếp trên Chrome',
  },
];

const MULTI_EDIT_IMAGE_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh 1 · Nhân vật / Chủ thể chính',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · ảnh gốc cần chỉnh sửa hoặc giữ khuôn mặt · tối đa 50 MB',
  },
  {
    name: 'image2',
    label: 'Ảnh 2 · Sản phẩm / Trang phục / Bối cảnh (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'image3',
    label: 'Ảnh 3 · Đạo cụ / Phối cảnh phụ (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'image4',
    label: 'Ảnh 4 · Tham chiếu bổ sung (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'prompt',
    label: 'Yêu cầu chỉnh sửa / ghép ảnh',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Ví dụ: Giữ nguyên khuôn mặt người ở Ảnh 1, cầm sản phẩm ở Ảnh 2 đứng trong quán cà phê ở Ảnh 3...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '1:1',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt tạo từ 1 đến 4 ảnh cùng lúc trực tiếp trên Chrome',
  },
];

const VIRTUAL_TRYON_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh người mẫu',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · rõ khuôn mặt và dáng đứng để AI giữ nguyên mặt & vóc dáng',
  },
  {
    name: 'garment',
    label: 'Ảnh trang phục / Phụ kiện',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'Ảnh quần áo trải sàn, treo móc hoặc người mẫu khác đang mặc trang phục cần lấy',
  },
  {
    name: 'outfitPart',
    label: 'Phần trang phục cần thay',
    type: 'select',
    required: true,
    default: 'full',
    options: [
      { value: 'full', label: 'Nguyên bộ trang phục (Full Outfit)' },
      { value: 'top', label: 'Chỉ thay Áo / Khoác trên (Giữ quần/váy cũ)' },
      { value: 'bottom', label: 'Chỉ thay Quần / Chân váy dưới (Giữ áo cũ)' },
      { value: 'dress', label: 'Váy liền / Đầm dạ hội' },
      { value: 'accessory', label: 'Phụ kiện (Túi xách / Mũ / Kính)' },
    ],
  },
  {
    name: 'background',
    label: 'Chế độ bối cảnh nền',
    type: 'select',
    required: true,
    default: 'keep_original',
    options: [
      {
        value: 'keep_original',
        label: 'Giữ nguyên nền gốc của ảnh người mẫu',
        hint: 'Giữ nguyên bối cảnh phòng/ngoại cảnh, góc máy và ánh sáng gốc của ảnh người mẫu trên Chrome',
      },
      {
        value: 'studio',
        label: 'Đổi sang nền Studio thời trang cao cấp',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc toàn thân · TikTok / Lookbook)' },
      { value: '3:4', label: '3:4 (Chân dung thời trang · Shopee / sàn TMĐT)' },
      { value: '1:1', label: '1:1 (Vuông)' },
      { value: '16:9', label: '16:9 (Ngang)' },
    ],
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
  },
  {
    name: 'prompt',
    label: 'Ghi chú bổ sung (Không bắt buộc)',
    type: 'textarea',
    required: false,
    max: 2000,
    placeholder: 'Tuỳ chọn ghi chú thêm về cách sơ vin, xắn tay áo, ánh sáng...',
  },
];

const MOTION_ECO_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh nhân vật',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · rõ khuôn mặt và trang phục · tối đa 50 MB',
  },
  {
    name: 'video',
    label: 'Video chuyển động mẫu (Tự động cắt theo mốc chọn)',
    type: 'video',
    required: true,
    accept: 'video/mp4,video/quicktime',
    help: 'Tải lên video bất kỳ — hệ thống tự động cắt chuẩn theo mốc 5s / 8s / 10s / 15s khách chọn mà không báo lỗi quá thời lượng',
  },
  {
    name: 'maxDuration',
    label: 'Mốc thời lượng xuất video',
    type: 'select',
    required: true,
    default: '10',
    options: [
      { value: '5', label: 'Tối đa 5 giây (Nhanh & tiết kiệm)' },
      { value: '8', label: 'Tối đa 8 giây (Chuẩn câu nhạc ngắn)' },
      { value: '10', label: 'Tối đa 10 giây (Đầy đủ 1 phân cảnh đơn)' },
      { value: '15', label: 'Tối đa 15 giây (Tự nối liền mạch 2 phân cảnh đồng nhất nền)' },
    ],
  },
  {
    name: 'backgroundMode',
    label: 'Bối cảnh nền',
    type: 'select',
    required: true,
    default: 'keep_photo_bg',
    options: [
      {
        value: 'keep_photo_bg',
        label: 'Giữ nền của ảnh nhân vật',
        hint: 'Khoá cố định bối cảnh gốc trong ảnh nhân vật xuyên suốt video',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · TikTok / Reels / Shorts)' },
      { value: '16:9', label: '16:9 (Ngang · YouTube / Điện ảnh)' },
      { value: '1:1', label: '1:1 (Vuông · Facebook / Instagram)' },
    ],
  },
  {
    name: 'audioMode',
    label: 'Âm thanh video',
    type: 'select',
    required: true,
    default: 'sound',
    options: AUDIO_MODE_OPTIONS,
  },
  {
    name: 'prompt',
    label: 'Mô tả bổ sung (Không bắt buộc)',
    type: 'textarea',
    max: 2000,
    placeholder: 'Có thể để trống hoặc ghi chú thêm về biểu cảm, ánh sáng, phong cách...',
  },
];

const IMAGE_CREATE_4K_FIELDS: AiFieldDef[] = [
  {
    name: 'prompt',
    label: 'Mô tả hình ảnh 4K cần tạo',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Nhập chi tiết chủ thể, trang phục, bối cảnh, ánh sáng studio/điện ảnh mong muốn...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình 4K',
    type: 'select',
    required: true,
    default: '9:16',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt tạo từ 1 đến 4 ảnh chuẩn 4K Ultra HD bằng mô hình Nano Banana Pro',
  },
];

const IMAGE_EDIT_4K_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh 1 · Nhân vật / Chủ thể chính',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · ảnh gốc cần chỉnh sửa hoặc giữ khuôn mặt · tối đa 50 MB',
  },
  {
    name: 'image2',
    label: 'Ảnh 2 · Sản phẩm / Trang phục / Bối cảnh (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'image3',
    label: 'Ảnh 3 · Đạo cụ / Phối cảnh phụ (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'image4',
    label: 'Ảnh 4 · Tham chiếu bổ sung (Tuỳ chọn)',
    type: 'image',
    required: false,
    accept: 'image/png,image/jpeg,image/webp',
  },
  {
    name: 'prompt',
    label: 'Yêu cầu ghép & chỉnh sửa ảnh 4K',
    type: 'textarea',
    required: true,
    max: 4000,
    placeholder: 'Ví dụ: Giữ nguyên khuôn mặt người ở Ảnh 1, cầm sản phẩm ở Ảnh 2 trong không gian studio sang trọng...',
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình 4K',
    type: 'select',
    required: true,
    default: '9:16',
    options: IMAGE_ASPECT_OPTIONS,
  },
  {
    name: 'count',
    label: 'Số lượng ảnh',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    help: 'Mỗi lượt ghép từ 1 đến 4 ảnh sắc nét chuẩn 4K Ultra HD',
  },
];

const IMAGE_RESTORE_4K_FIELDS: AiFieldDef[] = [
  {
    name: 'image',
    label: 'Ảnh cần phục hồi / nâng nét lên 4K',
    type: 'image',
    required: true,
    accept: 'image/png,image/jpeg,image/webp',
    help: 'JPG, PNG, WebP · ảnh mờ, vỡ hạt, thiếu nét hoặc độ phân giải thấp cần làm nét lên chuẩn 4K Ultra HD · tối đa 50 MB',
  },
  {
    name: 'restoreMode',
    label: 'Chế độ phục hồi & làm nét',
    type: 'select',
    required: true,
    default: 'faithful',
    options: [
      {
        value: 'faithful',
        label: 'Giữ nguyên bản 100% · Tăng nét & chi tiết 4K (Mặc định)',
        hint: 'Giữ nguyên bố cục, khuôn mặt, màu sắc và vật thể gốc, khử nhiễu & tái tạo chi tiết 4K',
      },
      {
        value: 'portrait_restore',
        label: 'Phục hồi ảnh chân dung / ảnh cũ mờ nhoè',
        hint: 'Tái tạo độ nét mắt, tóc, vân da tự nhiên và khử vết mờ nhoè mà không làm biến dạng mặt',
      },
      {
        value: 'product_sharp',
        label: 'Làm nét ảnh sản phẩm / thời trang chuẩn Studio 4K',
        hint: 'Làm sắc cạnh sản phẩm, chất liệu vải, logo & chữ in cho ảnh bán hàng TMĐT',
      },
    ],
  },
  {
    name: 'aspect',
    label: 'Tỷ lệ khung hình xuất 4K',
    type: 'select',
    required: true,
    default: '9:16',
    options: [
      { value: '9:16', label: '9:16 (Dọc · Ảnh điện thoại / TikTok / Story)' },
      { value: '3:4', label: '3:4 (Chân dung tiêu chuẩn / TMĐT)' },
      { value: '1:1', label: '1:1 (Vuông · Avatar / Sản phẩm)' },
      { value: '4:3', label: '4:3 (Ngang tiêu chuẩn)' },
      { value: '16:9', label: '16:9 (Ngang rộng · Banner / Máy tính)' },
    ],
  },
  {
    name: 'count',
    label: 'Số lượng phương án',
    type: 'number',
    required: false,
    default: 1,
    min: 1,
    max: 4,
    step: 1,
  },
  {
    name: 'prompt',
    label: 'Ghi chú bổ sung (Không bắt buộc)',
    type: 'textarea',
    required: false,
    max: 2000,
    placeholder: 'Có thể để trống hoặc ghi chú thêm chi tiết cần ưu tiên giữ rõ...',
  },
];

function resolutionForToolKey(toolKey: string): '720p' | '1080p' | '4k' {
  if (toolKey.endsWith('-4k')) return '4k';
  if (toolKey.endsWith('-1080p')) return '1080p';
  return '720p';
}

function kindForToolKey(toolKey: string): TavtavvideoJobKind {
  if (toolKey === 'virtual-tryon') return 'virtual_tryon';
  if (toolKey.startsWith('motion-eco')) return 'motion_eco';
  if (
    toolKey === 'image-create-4k' ||
    toolKey === 'image-2k-eco' ||
    toolKey.startsWith('nano-text-to-image') ||
    toolKey === 'text-to-image'
  ) {
    return 'text_to_image';
  }
  if (
    toolKey === 'image-edit-4k' ||
    toolKey === 'image-restore-4k' ||
    toolKey === 'edit-multi-2k' ||
    toolKey.startsWith('nano-image-to-image') ||
    toolKey === 'image-to-image'
  ) {
    return 'image_to_image';
  }
  if (toolKey.startsWith('image-to-video')) return 'image_to_video';
  if (toolKey.startsWith('text-to-video')) return 'text_to_video';
  if (toolKey.startsWith('motion-gt10s') || toolKey.startsWith('motion-30s')) return 'motion_30s';
  if (toolKey.startsWith('motion-15s-') || toolKey === 'motion-15s') return 'motion_15s';
  return 'motion';
}

const imageUnits = (input: AiInput) => Math.max(1, Math.min(4, Math.floor(Number(input.count ?? input.n ?? 1) || 1)));

const TOOLS: AiToolDef[] = [
  // =========================================================================
  // 1A. MOTION CONTROL MAX 10S (OMNI 1.2 FLASH · GÓI TỐI ĐA 10S)
  // =========================================================================
  {
    key: 'motion-720p',
    name: 'Motion Control 720p - Tối đa 10s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động theo video mẫu chuẩn xác từng động tác bằng mô hình Omni 1.2 mới nhất (tối đa 10s), giữ nguyên khuôn mặt, trang phục và âm thanh gốc · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: MOTION_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/motion-video.jpg',
    pricing: { mode: 'fixed', base: 999 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'motion-1080p',
    name: 'Motion Control 1080p - Tối đa 10s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động theo video mẫu chuẩn xác từng động tác bằng mô hình Omni 1.2 mới nhất (tối đa 10s), giữ nguyên khuôn mặt, trang phục và âm thanh gốc · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: MOTION_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/motion-image.jpg',
    pricing: { mode: 'fixed', base: 1150 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'motion-4k',
    name: 'Motion Control 4K - Tối đa 10s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động theo video mẫu chuẩn xác từng động tác bằng mô hình Omni 1.2 mới nhất (tối đa 10s), giữ nguyên khuôn mặt, trang phục và âm thanh gốc · nâng cấp siêu nét chuẩn Ultra HD 4K.',
    output: 'video',
    splitModels: false,
    fields: MOTION_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/upscale.jpg',
    pricing: { mode: 'fixed', base: 2499 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },

  // =========================================================================
  // 1B. MOTION CONTROL MAX 15S (OMNI 1.2 FLASH · GÓI TỐI ĐA 15S LIỀN MẠCH)
  // =========================================================================
  {
    key: 'motion-15s-720p',
    name: 'Motion Control 720p - Tối đa 15s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động liền mạch tối đa 15s (1 cảnh duy nhất không cắt ghép) bằng mô hình Omni 1.2 mới nhất, giữ nguyên khuôn mặt, trang phục và âm thanh gốc · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: MOTION_15S_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/motion-video.jpg',
    pricing: { mode: 'fixed', base: 1799 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'motion-15s-1080p',
    name: 'Motion Control 1080p - Tối đa 15s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động liền mạch tối đa 15s (1 cảnh duy nhất không cắt ghép) bằng mô hình Omni 1.2 mới nhất, giữ nguyên khuôn mặt, trang phục và âm thanh gốc · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: MOTION_15S_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/motion-image.jpg',
    pricing: { mode: 'fixed', base: 1999 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'motion-15s-4k',
    name: 'Motion Control 4K - Tối đa 15s',
    category: 'text',
    icon: 'person-standing',
    badge: 'SV8',
    featured: true,
    description:
      'Nhân vật trong ảnh nhảy và chuyển động liền mạch tối đa 15s (1 cảnh duy nhất không cắt ghép) bằng mô hình Omni 1.2 mới nhất, giữ nguyên khuôn mặt, trang phục và âm thanh gốc · nâng cấp siêu nét chuẩn Ultra HD 4K.',
    output: 'video',
    splitModels: false,
    fields: MOTION_15S_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    cover: '/workflows/upscale.jpg',
    pricing: { mode: 'fixed', base: 3999 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },

  // =========================================================================
  // 2. MOTION CONTROL TRÊN 10S (CHỈ 2 MỤC 1080P & 4K · TÍNH GIÁ RIÊNG MỐC 10–20S & 20–30S)
  // =========================================================================
  {
    key: 'motion-gt10s-1080p',
    name: 'Motion Control 1080p - trên 10s',
    category: 'video',
    icon: 'person-standing',
    badge: 'FHD >10S',
    featured: true,
    description:
      'Tạo video nhảy và chuyển động dài trên 10s (tối đa 30s) đồng nhất nhân vật & giữ trọn nhạc gốc · Tính giá riêng theo thời lượng: từ 10–20s (ghép 2 cảnh) và từ 20–30s (ghép 3 cảnh) · chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: MOTION_GT10S_FIELDS,
    pairs: { fields: ['image', 'video'], max: 5, linkField: 'video' },
    copies: 4,
    cover: '/workflows/motion-image.jpg',
    pricing: { mode: 'tiers', base: 4000, tier10to20: 4000, tier20to30: 6000 },
    supportsCost: false,
    supportsDurationTiers: true,
    unitLabel: 'video >10s',
    units: () => 1,
  },
  {
    key: 'motion-gt10s-4k',
    name: 'Motion Control 4K - trên 10s',
    category: 'video',
    icon: 'person-standing',
    badge: '4K >10S',
    featured: true,
    description:
      'Tạo video nhảy và chuyển động dài trên 10s (tối đa 30s) đồng nhất nhân vật & giữ trọn nhạc gốc · Tính giá riêng theo thời lượng: từ 10–20s (ghép 2 cảnh) và từ 20–30s (ghép 3 cảnh) · siêu nét Ultra HD 4K.',
    output: 'video',
    splitModels: false,
    fields: MOTION_GT10S_FIELDS,
    pairs: { fields: ['image', 'video'], max: 5, linkField: 'video' },
    copies: 4,
    cover: '/workflows/upscale.jpg',
    pricing: { mode: 'tiers', base: 12000, tier10to20: 12000, tier20to30: 18000 },
    supportsCost: false,
    supportsDurationTiers: true,
    unitLabel: 'video >10s',
    units: () => 1,
  },

  // =========================================================================
  // 3. ẢNH THÀNH VIDEO (IMAGE-TO-VIDEO)
  // =========================================================================
  {
    key: 'image-to-video-720p',
    name: 'Ảnh thành Video 720p',
    category: 'video',
    icon: 'film',
    badge: 'HD',
    featured: true,
    description:
      'Biến ảnh tĩnh nhân vật, sản phẩm hoặc phong cảnh thành video chuyển động mượt mà kèm âm thanh tự nhiên (Veo 3.1 / Omni) · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: IMAGE_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 2000 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'image-to-video-1080p',
    name: 'Ảnh thành Video 1080p',
    category: 'video',
    icon: 'film',
    badge: 'FHD',
    featured: true,
    description:
      'Biến ảnh tĩnh nhân vật, sản phẩm hoặc phong cảnh thành video chuyển động mượt mà kèm âm thanh tự nhiên · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: IMAGE_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 3500 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'image-to-video-4k',
    name: 'Ảnh thành Video 4K',
    category: 'video',
    icon: 'film',
    badge: '4K',
    featured: true,
    description:
      'Biến ảnh tĩnh nhân vật, sản phẩm hoặc phong cảnh thành video điện ảnh kèm âm thanh tự nhiên · nâng cấp siêu nét chuẩn Ultra HD 4K.',
    output: 'video',
    splitModels: false,
    fields: IMAGE_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 6000 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'image-to-video-15s-720p',
    name: 'Ảnh thành Video 720p - 15s',
    category: 'video',
    icon: 'film',
    badge: 'SV8',
    featured: true,
    description:
      'Biến ảnh tĩnh nhân vật, sản phẩm hoặc phong cảnh thành video chuyển động liền mạch 15 giây kèm âm thanh tự nhiên bằng mô hình Omni 1.2 mới nhất · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: IMAGE_TO_VIDEO_15S_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 999 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'image-to-video-15s-1080p',
    name: 'Ảnh thành Video 1080p - 15s',
    category: 'video',
    icon: 'film',
    badge: 'SV8',
    featured: true,
    description:
      'Biến ảnh tĩnh nhân vật, sản phẩm hoặc phong cảnh thành video chuyển động liền mạch 15 giây kèm âm thanh tự nhiên bằng mô hình Omni 1.2 mới nhất · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: IMAGE_TO_VIDEO_15S_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 1250 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },

  // =========================================================================
  // 4. VĂN BẢN THÀNH VIDEO (TEXT-TO-VIDEO)
  // =========================================================================
  {
    key: 'text-to-video-720p',
    name: 'Văn bản thành Video 720p',
    category: 'video',
    icon: 'clapperboard',
    badge: 'HD',
    featured: true,
    description:
      'Tạo video điện ảnh kèm âm thanh và lời thoại tự nhiên trực tiếp từ mô tả văn bản (Veo 3.1 / Omni) · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: TEXT_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 2000 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'text-to-video-1080p',
    name: 'Văn bản thành Video 1080p',
    category: 'video',
    icon: 'clapperboard',
    badge: 'FHD',
    featured: true,
    description:
      'Tạo video điện ảnh kèm âm thanh và lời thoại tự nhiên trực tiếp từ mô tả văn bản · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: TEXT_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 3500 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'text-to-video-4k',
    name: 'Văn bản thành Video 4K',
    category: 'video',
    icon: 'clapperboard',
    badge: '4K',
    featured: true,
    description:
      'Tạo video điện ảnh kèm âm thanh và lời thoại tự nhiên trực tiếp từ mô tả văn bản · nâng cấp siêu nét chuẩn Ultra HD 4K.',
    output: 'video',
    splitModels: false,
    fields: TEXT_TO_VIDEO_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 6000 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'text-to-video-15s-720p',
    name: 'Văn bản thành Video 720p - 15s',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV8',
    featured: true,
    description:
      'Tạo video điện ảnh liền mạch 15 giây kèm âm thanh và lời thoại tự nhiên trực tiếp từ mô tả văn bản bằng mô hình Omni 1.2 mới nhất · xuất chuẩn HD 720p tốc độ cao.',
    output: 'video',
    splitModels: false,
    fields: TEXT_TO_VIDEO_15S_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 999 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },
  {
    key: 'text-to-video-15s-1080p',
    name: 'Văn bản thành Video 1080p - 15s',
    category: 'video',
    icon: 'clapperboard',
    badge: 'SV8',
    featured: true,
    description:
      'Tạo video điện ảnh liền mạch 15 giây kèm âm thanh và lời thoại tự nhiên trực tiếp từ mô tả văn bản bằng mô hình Omni 1.2 mới nhất · nâng cấp sắc nét chuẩn Full HD 1080p.',
    output: 'video',
    splitModels: false,
    fields: TEXT_TO_VIDEO_15S_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 1250 },
    supportsCost: false,
    unitLabel: 'video',
    units: () => 1,
  },

  // =========================================================================
  // 5. TẠO ẢNH & GHÉP ẢNH AI (NANO BANANA 2.1 / PRO / LITE)
  // =========================================================================
  {
    key: 'nano-text-to-image',
    name: 'Tạo Ảnh AI Nano Banana',
    category: 'image',
    icon: 'sparkles',
    badge: 'AI IMAGE',
    featured: true,
    description:
      'Tạo hình ảnh nghệ thuật, ảnh chân dung, ảnh sản phẩm sắc nét từ mô tả văn bản với bộ ba mô hình Nano Banana 2.1, Nano Banana Pro và Nano Banana 2 Lite.',
    output: 'image',
    splitModels: false,
    fields: TEXT_TO_IMAGE_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 500 },
    supportsCost: false,
    unitLabel: 'ảnh',
    units: imageUnits,
  },
  {
    key: 'nano-image-to-image',
    name: 'Ghép & Chỉnh sửa Ảnh AI Nano Banana',
    category: 'image',
    icon: 'wand-sparkles',
    badge: 'AI EDIT',
    featured: true,
    description:
      'Chỉnh sửa bối cảnh, thay đổi trang phục hoặc ghép nhân vật với sản phẩm giữ nguyên đường nét khuôn mặt tự nhiên bằng Nano Banana 2.1 / Pro.',
    output: 'image',
    splitModels: false,
    fields: IMAGE_TO_IMAGE_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 500 },
    supportsCost: false,
    unitLabel: 'ảnh',
    units: imageUnits,
  },

  // =========================================================================
  // 6. NHÓM A — 5 TÍNH NĂNG MỚI CHẠY 100% TRÊN CHROME, KHÔNG DÙNG GPU LOCAL (MẶC ĐỊNH TẮT ĐỂ ADMIN TEST TỪ TỪ)
  // =========================================================================
  // [A1.1] Tạo Ảnh AI Siêu Nét 2K — Hao tốn Google Flow Credit: 0 credit · 0% GPU Local (100% Chrome Gemini Web Full-Size 2K)
  {
    key: 'image-2k-eco',
    name: 'Tạo Ảnh AI Siêu Nét 2K',
    category: 'image',
    icon: 'sparkles',
    badge: '2K',
    featured: false,
    description:
      'Tạo ảnh chân dung, thời trang, sản phẩm và bối cảnh sắc nét chuẩn Full-Size 2K trực tiếp trên Chrome với chi phí siêu tiết kiệm.',
    output: 'image',
    splitModels: false,
    fields: ECO_TEXT_TO_IMAGE_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 80 },
    supportsCost: false,
    unitLabel: 'ảnh',
    units: imageUnits,
  },
  // [A1.2] Sửa & Ghép Đa Ảnh AI 2K (1–4 ảnh) — Hao tốn Google Flow Credit: 0 credit · 0% GPU Local (100% Chrome Gemini Web)
  {
    key: 'edit-multi-2k',
    name: 'Sửa & Ghép Đa Ảnh AI 2K',
    category: 'image',
    icon: 'wand-sparkles',
    badge: 'MULTI 4 ẢNH',
    featured: false,
    description:
      'Ghép kết hợp tối đa 4 ảnh tham chiếu (nhân vật + sản phẩm + trang phục + bối cảnh) giữ nguyên đường nét khuôn mặt sắc nét chuẩn Full-Size 2K trực tiếp trên Chrome.',
    output: 'image',
    splitModels: false,
    fields: MULTI_EDIT_IMAGE_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 100 },
    supportsCost: false,
    unitLabel: 'ảnh',
    units: imageUnits,
  },
  // [A2] Thay Đồ Ảnh AI (Virtual Try-On) — Hao tốn Google Flow Credit: 0 credit · 0% GPU Local (100% Chrome Gemini Web)
  {
    key: 'virtual-tryon',
    name: 'Thay Đồ Ảnh AI · Giữ Nguyên Mặt & Nền',
    category: 'image',
    icon: 'shirt',
    badge: 'TRY-ON 2K',
    featured: false,
    description:
      'Mặc thử áo, quần, váy hoặc nguyên bộ trang phục lên ảnh người mẫu thật · giữ nguyên khuôn mặt và bối cảnh gốc sắc nét chuẩn Full-Size 2K trực tiếp trên Chrome.',
    output: 'image',
    splitModels: false,
    fields: VIRTUAL_TRYON_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 250 },
    supportsCost: false,
    unitLabel: 'ảnh',
    units: imageUnits,
  },
  // [A4.1] Motion Control Đồng Giá 720p (Tự cắt 5s–15s) — Hao tốn Google Flow Credit: ~20 cr (5s/8s/10s) · ~40 cr (15s = 2 cảnh) · 0% GPU Local (100% Chrome Google Flow)
  {
    key: 'motion-eco-720p',
    name: 'Motion Control Đồng Giá 720p (5s–15s)',
    category: 'video',
    icon: 'person-standing',
    badge: 'ECO HD',
    featured: false,
    description:
      'Nhân vật nhảy & chuyển động theo video mẫu trực tiếp trên Chrome Google Flow với tính năng tự động cắt thời lượng chuẩn 5s / 8s / 10s / 15s và giữ nhạc gốc · HD 720p.',
    output: 'video',
    splitModels: false,
    fields: MOTION_ECO_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    pricing: { mode: 'fixed', base: 1500 },
    supportsCost: false,
    unitLabel: 'video',
    units: (input: AiInput) => (Number(input.maxDuration ?? 10) > 10 ? 2 : 1),
  },
  // [A4.2] Motion Control V2 1080p (Tự cắt 5s–15s) — Hao tốn Google Flow Credit: ~20 cr (5s/8s/10s) · ~40 cr (15s = 2 cảnh, +0 cr upscale 1080p trên Chrome Flow) · 0% GPU Local
  {
    key: 'motion-eco-1080p',
    name: 'Motion Control V2 1080p (5s–15s)',
    category: 'video',
    icon: 'person-standing',
    badge: 'V2 FHD',
    featured: false,
    description:
      'Nhân vật nhảy & chuyển động theo video mẫu tự động cắt 5s / 8s / 10s / 15s và nâng cấp sắc nét chuẩn Full HD 1080p trực tiếp trên Chrome Google Flow.',
    output: 'video',
    splitModels: false,
    fields: MOTION_ECO_FIELDS,
    pairs: { fields: ['image', 'video'], max: 10, linkField: 'video' },
    copies: 4,
    pricing: { mode: 'fixed', base: 2500 },
    supportsCost: false,
    unitLabel: 'video',
    units: (input: AiInput) => (Number(input.maxDuration ?? 10) > 10 ? 2 : 1),
  },

  // =========================================================================
  // 7. NHÓM ẢNH AI 4K ULTRA HD TRÊN GOOGLE FLOW (0 FLOW CREDIT · 0% GPU LOCAL)
  // =========================================================================
  {
    key: 'image-create-4k',
    name: 'Tạo Ảnh AI 4K Ultra HD',
    category: 'image',
    icon: 'sparkles',
    badge: '4K ULTRA',
    featured: false,
    description:
      'Tạo ảnh chân dung, thời trang, sản phẩm và bối cảnh siêu chi tiết chuẩn Ultra HD 4K bằng mô hình Nano Banana Pro trên Google Flow.',
    output: 'image',
    splitModels: false,
    fields: IMAGE_CREATE_4K_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 200 },
    supportsCost: false,
    unitLabel: 'ảnh 4K',
    units: imageUnits,
  },
  {
    key: 'image-edit-4k',
    name: 'Ghép & Chỉnh sửa Ảnh AI 4K',
    category: 'image',
    icon: 'wand-sparkles',
    badge: 'GHÉP 4K',
    featured: false,
    description:
      'Ghép kết hợp tối đa 4 ảnh tham chiếu (nhân vật + sản phẩm + trang phục + bối cảnh) giữ nguyên khuôn mặt sắc nét chuẩn Ultra HD 4K bằng Nano Banana Pro.',
    output: 'image',
    splitModels: false,
    fields: IMAGE_EDIT_4K_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 250 },
    supportsCost: false,
    unitLabel: 'ảnh 4K',
    units: imageUnits,
  },
  {
    key: 'image-restore-4k',
    name: 'Phục hồi & Nâng nét Ảnh AI 4K',
    category: 'image',
    icon: 'wand-sparkles',
    badge: 'NÉT 4K',
    featured: false,
    description:
      'Khử nhiễu, khôi phục độ sắc nét khuôn mặt, chi tiết sản phẩm và nâng cấp độ phân giải ảnh mờ/vỡ hạt lên chuẩn Ultra HD 4K bằng Nano Banana Pro.',
    output: 'image',
    splitModels: false,
    fields: IMAGE_RESTORE_4K_FIELDS,
    copies: 4,
    pricing: { mode: 'fixed', base: 0, perUnit: 250 },
    supportsCost: false,
    unitLabel: 'ảnh 4K',
    units: imageUnits,
  },
];

export const tavtavvideoProvider: AiProvider = {
  key: 'tavtavvideo',
  name: 'tavtavvideo',
  website: 'https://nov.ai.vn',
  tools: TOOLS,

  async submit(tool, input: AiInput, ctx: AiCallContext) {
    if (!ctx.config.apiKey) {
      throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau');
    }

    const bridge = getTavtavvideoBridge();
    const resolution = resolutionForToolKey(tool.key);
    const kind = kindForToolKey(tool.key);
    const aspectInput = input.aspect ?? input.ratio ?? input.aspect_ratio;
    const modelInput = input.model ?? input.flow_model ?? input.model_variant;
    const audioInput = input.audioMode ?? input.audio_mode;
    const countInput = input.count ?? input.n;

    const isFlowImage4kTool =
      tool.key === 'image-create-4k' ||
      tool.key === 'image-edit-4k' ||
      tool.key === 'image-restore-4k';

    if (isFlowImage4kTool && !bridge.hasCapableWorker('2.2.0')) {
      throw new AiProviderError(
        'Máy trạm xử lý Ảnh 4K Ultra HD chưa cập nhật lên bản Portable v2.2.0 — vui lòng cập nhật FlowStudio-Client-Portable rồi thử lại',
      );
    }

    if (tool.key === 'image-restore-4k') {
      const imageUrl = str(input.image ?? input.image_url);
      if (!imageUrl) {
        throw new AiProviderError('Vui lòng chọn Ảnh cần phục hồi / nâng nét lên 4K');
      }
      const job = await bridge.enqueueImageRestore4kJob(
        {
          imageUrl,
          restoreMode: input.restoreMode ?? input.restore_mode ?? 'faithful',
          aspect: aspectInput ?? '9:16',
          prompt: input.prompt,
          batchCount: countInput,
        },
        ctx,
      );
      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'image_to_image',
          templateId: job.templateId,
          aspect: job.aspect,
          model: job.flowModel,
          resolution: '4k',
          count: job.batchCount ?? 1,
          estimatedFlowCredits: 0,
        },
      };
    }

    if (kind === 'virtual_tryon') {
      const imageUrl = str(input.image ?? input.image_url);
      const garmentUrl = str(input.garment ?? input.image2 ?? input.garment_url);
      if (!imageUrl || !garmentUrl) {
        throw new AiProviderError('Vui lòng chọn đầy đủ Ảnh người mẫu và Ảnh trang phục cần thay');
      }
      const job = await bridge.enqueueVirtualTryOnJob(
        {
          imageUrl,
          garmentUrl,
          outfitPart: input.outfitPart ?? input.outfit_part ?? 'full',
          backgroundMode: input.background ?? input.backgroundMode ?? 'keep_original',
          aspect: aspectInput ?? '9:16',
          imageResolution: input.resolution ?? '2k',
          prompt: input.prompt,
          batchCount: countInput,
        },
        ctx,
      );
      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'virtual_tryon',
          outfitPart: job.outfitPart,
          backgroundMode: job.backgroundMode,
          resolution: job.imageUpscaleRes ?? '2k',
          count: job.batchCount ?? 1,
          estimatedFlowCredits: 0,
        },
      };
    }

    if (kind === 'text_to_image') {
      const promptText = str(input.prompt);
      if (!promptText) {
        throw new AiProviderError('Vui lòng nhập nội dung mô tả hình ảnh cần tạo');
      }
      const is4kCreate = tool.key === 'image-create-4k';
      const defaultRes = is4kCreate ? '4k' : tool.key === 'image-2k-eco' ? '2k' : '1k';
      const job = await bridge.enqueueTextToImageJob(
        {
          prompt: promptText,
          aspect: aspectInput,
          model: is4kCreate ? 'nano_banana_pro' : modelInput,
          batchCount: countInput,
          imageResolution: is4kCreate ? '4k' : (input.resolution ?? defaultRes),
        },
        ctx,
      );

      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'text_to_image',
          aspect: job.aspect,
          model: job.flowModel,
          resolution: job.imageUpscaleRes ?? defaultRes,
          count: job.batchCount ?? 1,
          estimatedFlowCredits: 0,
        },
      };
    }

    if (kind === 'image_to_image') {
      const imageUrl = str(input.image ?? input.image_url);
      if (!imageUrl) {
        throw new AiProviderError('Vui lòng chọn Ảnh gốc / Tham chiếu chính đầu vào');
      }
      const promptText = str(input.prompt);
      if (!promptText) {
        throw new AiProviderError('Vui lòng nhập yêu cầu chỉnh sửa hoặc phối cảnh hình ảnh');
      }
      const extras = [
        str(input.image2 ?? input.extra_image_url),
        str(input.image3),
        str(input.image4),
      ].filter((u): u is string => Boolean(u));
      const is4kEdit = tool.key === 'image-edit-4k';
      const defaultRes = is4kEdit ? '4k' : tool.key === 'edit-multi-2k' ? '2k' : '1k';
      const job = await bridge.enqueueImageToImageJob(
        {
          imageUrl,
          extraImageUrls: extras.length > 0 ? extras : undefined,
          prompt: promptText,
          aspect: aspectInput,
          model: is4kEdit ? 'nano_banana_pro' : modelInput,
          batchCount: countInput,
          imageResolution: is4kEdit ? '4k' : (input.resolution ?? defaultRes),
        },
        ctx,
      );

      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'image_to_image',
          aspect: job.aspect,
          model: job.flowModel,
          resolution: job.imageUpscaleRes ?? defaultRes,
          refImagesCount: 1 + extras.length,
          count: job.batchCount ?? 1,
          estimatedFlowCredits: 0,
        },
      };
    }

    if (kind === 'text_to_video') {
      const promptText = str(input.prompt);
      if (!promptText) {
        throw new AiProviderError('Vui lòng nhập nội dung mô tả cảnh quay video');
      }
      const is15sVideo = tool.key.includes('-15s-');
      const job = await bridge.enqueueTextToVideoJob(
        {
          prompt: promptText,
          aspect: aspectInput,
          resolution,
          model: is15sVideo ? 'omni_flash' : 'veo_fast',
          audioMode: audioInput,
          durationSec: is15sVideo ? 15 : 8,
        },
        ctx,
      );

      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'text_to_video',
          durationSec: is15sVideo ? 15 : 8,
          resolution: job.resolution,
          aspect: job.aspect,
          model: job.flowModel,
          audioMode: job.audioMode,
          estimatedFlowCredits: is15sVideo ? 60 : 20,
        },
      };
    }

    if (kind === 'image_to_video') {
      const imageUrl = str(input.image ?? input.image_url);
      if (!imageUrl) {
        throw new AiProviderError('Vui lòng chọn Ảnh gốc / Nhân vật đầu vào');
      }
      const extraImage2 = str(input.image2 ?? input.extra_image_url);
      const is15sVideo = tool.key.includes('-15s-');
      const job = await bridge.enqueueImageToVideoJob(
        {
          imageUrl,
          extraImageUrls: extraImage2 ? [extraImage2] : undefined,
          prompt: input.prompt,
          aspect: aspectInput,
          resolution,
          model: is15sVideo ? 'omni_flash' : 'veo_fast',
          audioMode: audioInput,
          durationSec: is15sVideo ? 15 : 8,
        },
        ctx,
      );

      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'image_to_video',
          durationSec: is15sVideo ? 15 : 8,
          resolution: job.resolution,
          aspect: job.aspect,
          model: job.flowModel,
          audioMode: job.audioMode,
          estimatedFlowCredits: is15sVideo ? 60 : 20,
        },
      };
    }

    if (kind === 'motion_eco') {
      if (!bridge.hasCapableWorker('2.1.0')) {
        throw new AiProviderError(
          'Máy trạm xử lý Motion tự cắt 5s–15s chưa cập nhật lên bản Portable v2.1.0 — vui lòng mở FlowStudio-Client-Portable rồi thử lại',
        );
      }
      const imageUrl = str(input.image ?? input.image_url);
      const videoUrl = str(input.video ?? input.video_url);
      if (!imageUrl || !videoUrl) {
        throw new AiProviderError('Vui lòng chọn đầy đủ Ảnh nhân vật và Video chuyển động mẫu');
      }
      const maxDuration = input.maxDuration ?? input.max_duration ?? '10';
      const job = await bridge.enqueueMotionEcoJob(
        {
          imageUrl,
          videoUrl,
          maxDurationSec: maxDuration,
          backgroundMode: 'keep_photo_bg',
          aspect: aspectInput,
          resolution,
          audioMode: audioInput,
          prompt: input.prompt,
        },
        ctx,
      );
      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'motion_eco',
          maxDurationSec: job.maxDurationSec ?? 10,
          sceneTotal: job.sceneTotal ?? 1,
          resolution: job.resolution,
          aspect: job.aspect,
          backgroundMode: job.backgroundMode,
          audioMode: job.audioMode,
          estimatedFlowCredits: (job.maxDurationSec ?? 10) > 10 ? 40 : 20,
        },
      };
    }

    const imageUrl = str(input.image ?? input.image_url);
    const videoUrl = str(input.video ?? input.video_url);
    if (!imageUrl || !videoUrl) {
      throw new AiProviderError('Vui lòng chọn đầy đủ Ảnh nhân vật và Video chuyển động mẫu');
    }

    const durationRaw = String(input.durationMode ?? input.duration_mode ?? input.duration ?? '').trim().toLowerCase();
    const isMotion30s = kind === 'motion_30s' || durationRaw === '30s' || durationRaw === '30';

    if (isMotion30s) {
      const durSec = await ctx.uploadDuration(videoUrl).catch(() => null);
      if (durSec !== null && Number.isFinite(durSec)) {
        if (durSec <= 10.0) {
          throw new AiProviderError(
            `Video mẫu dài ${durSec.toFixed(1)}s (từ 10s trở xuống) — vui lòng chuyển sang mục Motion Control max 10s để có giá rẻ hơn`,
          );
        }
        if (durSec > 30.4) {
          throw new AiProviderError(
            `Video mẫu dài ${durSec.toFixed(1)}s — mục trên 10s chỉ hỗ trợ video từ 10s đến tối đa 30s`,
          );
        }
      }
      const job = await bridge.enqueueMotion30sJob(
        {
          imageUrl,
          videoUrl,
          templateId: 'motion_dance_sync',
          backgroundMode: 'keep_photo_bg',
          aspect: aspectInput,
          resolution,
          prompt: input.prompt,
          audioMode: audioInput,
        },
        ctx,
      );

      return {
        status: 'processing',
        providerTaskId: String(job.jobId),
        progress: job.percent,
        raw: {
          jobId: job.jobId,
          jobKind: 'motion_30s',
          sceneTotal: job.sceneTotal ?? 3,
          resolution: job.resolution,
          aspect: job.aspect,
          templateId: job.templateId,
          backgroundMode: job.backgroundMode,
          audioMode: job.audioMode,
        },
      };
    }

    const isMotion15s = kind === 'motion_15s' || durationRaw === '15s' || durationRaw === '15';
    const job = await bridge.enqueueMotionJob(
      {
        imageUrl,
        videoUrl,
        templateId: 'motion_dance_sync',
        backgroundMode: 'keep_photo_bg',
        aspect: aspectInput,
        resolution,
        prompt: input.prompt,
        maxSingleSec: isMotion15s ? 15 : 10,
        audioMode: audioInput,
      },
      ctx,
    );

    return {
      status: 'processing',
      providerTaskId: String(job.jobId),
      progress: job.percent,
      raw: {
        jobId: job.jobId,
        jobKind: isMotion15s ? 'motion_15s' : 'motion',
        maxSingleSec: isMotion15s ? 15 : 10,
        resolution: job.resolution,
        aspect: job.aspect,
        templateId: job.templateId,
        backgroundMode: job.backgroundMode,
      },
    };
  },

  async poll(_tool, providerTaskId: string) {
    const bridge = getTavtavvideoBridge();
    const job = bridge.getJob(providerTaskId);
    if (!job) {
      return {
        status: 'failed',
        providerTaskId,
        error: 'Không tìm thấy tiến trình xử lý, tiền đã được hoàn lại',
      };
    }

    if (
      job.status === 'completed' &&
      (job.jobKind === 'text_to_image' ||
        job.jobKind === 'image_to_image' ||
        job.jobKind === 'virtual_tryon')
    ) {
      const urls = job.outputUrls?.length ? job.outputUrls : job.outputUrl ? [job.outputUrl] : [];
      if (urls.length > 0) {
        const is4kOut = job.imageUpscaleRes === '4k';
        const prefix =
          job.jobKind === 'virtual_tryon'
            ? 'tryon'
            : job.templateId === 'image_restore_4k'
              ? 'restore4k'
              : job.jobKind === 'image_to_image'
                ? is4kOut
                  ? 'edit4k'
                  : 'i2i'
                : is4kOut
                  ? 'img4k'
                  : 't2i';
        return {
          status: 'succeeded',
          providerTaskId,
          progress: 100,
          files: urls.map((url, idx) => {
            const mimeType = job.outputMimes?.[idx] || 'image/png';
            const ext = mimeType.includes('webp') ? 'webp' : mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
            return {
              url,
              type: 'image' as const,
              name: `${prefix}_${job.jobId}_${idx + 1}.${ext}`,
              mimeType,
            };
          }),
          raw: {
            jobId: job.jobId,
            jobKind: job.jobKind,
            count: urls.length,
            flowCreditsUsed: job.flowCreditsUsed ?? 0,
            finishedAt: job.finishedAt ?? null,
          },
        };
      }
    }

    if (job.status === 'completed' && job.outputUrl) {
      const prefix =
        job.jobKind === 'text_to_video'
          ? (job.maxDurationSec ?? 8) >= 15
            ? 't2v15s'
            : 't2v'
          : job.jobKind === 'image_to_video'
            ? (job.maxDurationSec ?? 8) >= 15
              ? 'i2v15s'
              : 'i2v'
            : job.jobKind === 'motion_eco'
              ? 'motion_eco'
              : job.jobKind === 'motion_30s'
                ? 'motion30s'
                : job.jobKind === 'motion_15s'
                  ? 'motion15s'
                  : 'motion';
      return {
        status: 'succeeded',
        providerTaskId,
        progress: 100,
        files: [
          {
            url: job.outputUrl,
            type: 'video',
            name: `${prefix}_${job.jobId}_${job.resolution}.mp4`,
            mimeType: 'video/mp4',
          },
        ],
        raw: {
          jobId: job.jobId,
          jobKind: job.jobKind ?? 'motion',
          sceneTotal: job.sceneTotal ?? 1,
          resolution: job.resolution,
          flowCreditsUsed: job.flowCreditsUsed ?? null,
          finishedAt: job.finishedAt ?? null,
        },
      };
    }

    if (job.status === 'failed' || job.status === 'canceled') {
      const isImg =
        job.jobKind === 'text_to_image' ||
        job.jobKind === 'image_to_image' ||
        job.jobKind === 'virtual_tryon';
      return {
        status: 'failed',
        providerTaskId,
        error: job.errorMessage
          ? sanitizeErrorMessage(job.errorMessage, job.jobKind)
          : isImg
            ? 'Tạo hình ảnh không thành công, tiền đã được hoàn lại'
            : 'Tạo video không thành công, tiền đã được hoàn lại',
        raw: {
          jobId: job.jobId,
          jobKind: job.jobKind ?? 'motion',
          status: job.status,
          finishedAt: job.finishedAt ?? null,
        },
      };
    }

    return {
      status: 'processing',
      providerTaskId,
      progress: Math.min(99, Math.max(2, job.percent || 2)),
      raw: {
        jobId: job.jobId,
        jobKind: job.jobKind ?? 'motion',
        sceneTotal: job.sceneTotal ?? 1,
        status: job.status,
        percent: job.percent,
        message: job.message,
      },
    };
  },

  async balance(ctx: AiCallContext) {
    if (!ctx.config.apiKey) {
      throw new AiProviderError('Chưa nhập Khoá API kết nối cho nguồn tavtavvideo');
    }
    const summary = getTavtavvideoBridge().getHealthSummary();
    if (summary.online_devices <= 0) {
      throw new AiProviderError('Chưa có máy trạm Client nào kết nối vào /api/tavtavvideo-worker (kiểm tra lại Khoá API hoặc mở ứng dụng Client)');
    }
    return {
      balance: summary.max_parallel || summary.online_devices,
      unit: `luồng online (${summary.online_devices} máy trạm)`,
    };
  },
};
