/**
 * Kiểu dùng chung của AI Studio.
 *
 * Mỗi nhà cung cấp AI là một adapter (`AiProvider`, thư mục providers/) khai báo danh sách công cụ (`AiToolDef`):
 * form nhập liệu (`fields`) mà website khách tự dựng giao diện theo, cách tính giá credits, và cách gọi API.
 * Thêm nhà cung cấp mới = viết một file adapter + đăng ký trong providers/index.ts (+ nhóm cài đặt `ai_<key>`).
 */

/** Kiểu ô nhập của form công cụ (website khách render theo kiểu này) */
export type AiFieldType = 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'image' | 'video' | 'audio' | 'file';

export interface AiFieldOption {
  value: string;
  label: string;
  /** Mô tả phụ dưới nhãn; có ở mọi lựa chọn thì web hiện dạng thẻ 2 cột */
  hint?: string;
  /** Ô `picker: 'voice'` — thông tin giọng đọc để lọc / hiển thị trong hộp chọn giọng */
  badge?: string;
  gender?: 'male' | 'female' | 'neutral';
  /** Mã ngôn ngữ ISO (vd 'vi', 'en') */
  langs?: string[];
  /** Phong cách giọng (vd 'narrator', 'warm') */
  tags?: string[];
  /** Ô `picker: 'template'` — nhóm (tab), ảnh bìa và video xem trước của mẫu (vd mẫu dựng video) */
  group?: string;
  image?: string;
  video?: string;
}

/** Một ô nhập trên form công cụ */
export interface AiFieldDef {
  name: string;
  label: string;
  type: AiFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  /** select: danh sách lựa chọn */
  options?: AiFieldOption[];
  /** number: giới hạn; text/textarea: maxLength dùng `max` */
  min?: number;
  max?: number;
  step?: number;
  /** file: cho chọn nhiều file và số file tối đa */
  multiple?: boolean;
  maxFiles?: number;
  /** file: định dạng chấp nhận (vd "image/*") */
  accept?: string;
  /** Chỉ hiện khi một ô khác có giá trị nằm trong danh sách */
  showIf?: { field: string; in: string[] };
  /** Lựa chọn phụ thuộc giá trị ô khác (vd thời lượng theo model): { "<giá trị ô cha>": options } */
  optionsBy?: { field: string; map: Record<string, AiFieldOption[]> };
  /** textarea: nhóm gợi ý bấm nhanh hiện trên ô (vd thể loại nhạc) — bấm thì điền `value` vào ô mô tả */
  suggestions?: { label: string; options: AiFieldOption[] };
  /**
   * select: hộp chọn đặc biệt. 'voice' = danh sách giọng đọc có tìm kiếm, lọc giới tính / ngôn ngữ và nút nghe thử
   * (file mẫu lấy qua GET /public/ai/voice-preview/<mã nhà cung cấp>/<giọng>, mã do providerAlias tạo để khách không thấy tên nhà cung cấp, xem `AiProvider.voicePreview`).
   * 'template' = lưới thẻ mẫu có ảnh bìa + video xem trước, chia tab theo `group` của lựa chọn.
   */
  picker?: 'voice' | 'template';
  /** picker 'voice': mẫu URL file nghe thử, `{value}` thay bằng mã giọng (vd '/api/public/ai/voice-preview/tmc/{value}') */
  preview?: string;
  /** picker 'voice': danh sách đầy đủ mã ngôn ngữ ISO hiển thị ở bộ lọc ngôn ngữ (vd 30 ngôn ngữ đa quốc gia) */
  filterLangs?: string[];
  /** picker 'voice': cho phép khách chọn giọng từ Kho giọng đã nhân bản cá nhân (`uvoice_<id>`) */
  allowClonedVoices?: boolean;
  /** Ô ẩn trên form (giá trị cố định = `default`) — vd ô Model AI của công cụ đã tách theo từng model */
  hidden?: boolean;
}

/** Kiểu kết quả chính của công cụ (website chọn trình xem phù hợp) */
export type AiOutputType = 'image' | 'video' | 'audio' | 'text';

/**
 * Giá credits của công cụ, admin sửa được ở AI Studio › Công cụ:
 * - `fixed`: base + perUnit × số đơn vị (ký tự, giây, ảnh… do adapter đếm qua `units()`);
 * - `per_second`: base + perUnit × số giây thời lượng (admin tự đặt giá mỗi giây ở Sửa công cụ);
 * - `by_resolution`: base + giá tương ứng độ phân giải trong `resolutionPrices` (admin tự đặt ở Sửa công cụ);
 * - `cost`: chi phí nhà cung cấp báo (adapter tính qua `cost()`) × tỉ giá quy đổi của nhà cung cấp, cộng base
 *   (tỉ giá = 1 credit / xu nguồn bằng bao nhiêu credits web, đặt chung cho mỗi nhà cung cấp ở tab Khoá API — `ai_<key>.rate`);
 * - `free`: miễn phí, không trừ credits của khách (bỏ qua mọi ô giá còn lại).
 * Sau đó cộng thêm `markup` % (lãi), rồi mới áp mức tối thiểu `min`.
 */
export interface AiPricing {
  mode?: 'fixed' | 'cost' | 'free' | 'tiers' | 'per_second' | 'per_char' | 'by_resolution';
  base?: number;
  perUnit?: number;
  /** Giá riêng cho từng độ phân giải khi mode = 'by_resolution' (vd { '1080p': 1280, '720p': 720, '480p': 480 }) */
  resolutionPrices?: Record<string, number>;
  /** Giá riêng cho mốc video 10s – 20s (dùng khi mode = 'tiers') */
  tier10to20?: number;
  /** Giá riêng cho mốc video 20s – 30s (dùng khi mode = 'tiers') */
  tier20to30?: number;
  /** Hệ số riêng từng công cụ — KHÔNG còn dùng (giá theo chi phí NCC nhân tỉ giá chung của nhà cung cấp), giữ để đọc dữ liệu cũ */
  multiplier?: number;
  /** % lãi cộng thêm lên giá đã tính (20 = giá × 1,2); bỏ trống = 0 */
  markup?: number;
  /** Mức tối thiểu cho một lần chạy */
  min?: number;
  /** Bật tự custom giá riêng: không bị ghi đè khi nhà cung cấp bật Tự động cập nhật giá hoặc đổi % tăng giá chung (T-370) */
  customPrice?: boolean;
}

/** Định nghĩa một công cụ trong adapter */
export interface AiToolDef {
  /** Khoá cục bộ trong nhà cung cấp (khoá đầy đủ = `<provider>.<key>`) */
  key: string;
  name: string;
  /** Nhóm menu: voice | video | image | audio | text | tools */
  category: string;
  description?: string;
  /** Tên icon lucide */
  icon?: string;
  badge?: string;
  featured?: boolean;
  output: AiOutputType;
  fields: AiFieldDef[];
  /** Giá mặc định (lần đầu thêm vào DB) */
  pricing: AiPricing;
  /**
   * Adapter tính được chi phí nhà cung cấp (`cost()`) cho công cụ này -> admin được chọn "theo chi phí NCC".
   * Bỏ trống = theo giá mặc định (`pricing.mode === 'cost'`).
   */
  supportsCost?: boolean;
  /** Hỗ trợ đặt giá riêng theo 2 mốc thời lượng video 10–20s và 20–30s (`mode: 'tiers'`) */
  supportsDurationTiers?: boolean;
  /** Đơn vị tính giá hiển thị cho khách (vd "1.000 ký tự", "giây", "ảnh") */
  unitLabel?: string;
  /** Số đơn vị chi phí gốc của nhà cung cấp cho 1 `unitLabel` (vd 1.000 credit / 1.000 ký tự, 100 credit / giây) để hiện đơn giá rõ trên website khi dùng mode = 'cost' */
  costPerUnit?: number;
  /** Ghi chú ngắn về công thức tính tiền hiển thị cạnh đơn giá trên trang khách */
  priceHint?: string;
  /** Số đơn vị của một lần chạy (pricing fixed / per_char) — mặc định 1 */
  units?: (input: AiInput) => number;
  /**
   * Form "nhiều cặp" (vd Motion Control: [Ảnh nhân vật + Video mẫu]): các ô file trong `fields` ghép thành một hàng,
   * website cho thêm nhiều hàng, mỗi hàng đủ file gửi thành một tác vụ riêng (các ô còn lại dùng chung).
   * `linkField`: ô video của hàng có thêm ô "Dán link" (TikTok / Douyin / MP4) — máy chủ tải về thành file đầu vào.
   */
  pairs?: { fields: string[]; max?: number; linkField?: string };
  /** Cho khách chọn "Số lượng nhân bản" (mỗi bản một tác vụ) — giá trị là số bản tối đa */
  copies?: number;
  /**
   * Tách ô "Model AI" (select tên `model`) thành từng công cụ con, mỗi model một công cụ (admin đặt giá / bật tắt riêng)
   * và gộp lại thành 1 nhóm model trên website. Mặc định bật; `false` = giữ nguyên (vd công cụ cũ đã tách tay).
   */
  splitModels?: boolean;
  /** Ví dụ đầu ra hiện trên trang công cụ (ảnh trước / sau hoặc một ảnh kết quả) để khách hình dung trước khi tạo */
  samples?: AiSample[];
  /** Ảnh bìa thẻ "Quy trình AI" ở trang tổng quan (đường dẫn trên website, vd '/workflows/upscale.jpg') */
  cover?: string;
}

/**
 * Một ví dụ đầu ra: `compare` = cặp ảnh trước / sau (website có thanh kéo so sánh), `image` = một ảnh kết quả.
 * URL là đường dẫn trên website (vd '/samples/bp/...'), `caption` / `hint` là nhãn và mô tả phụ.
 */
export type AiSample =
  | { type: 'compare'; before: string; after: string; caption?: string; hint?: string }
  | { type: 'image'; url: string; caption?: string; hint?: string };

/** Dữ liệu khách nhập (đã kiểm tra theo `fields`) */
export type AiInput = Record<string, unknown>;

/** Cấu hình nhà cung cấp đọc từ nhóm cài đặt `ai_<key>` */
export interface AiProviderConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  [k: string]: unknown;
}

/** Một file kết quả */
export interface AiOutputFile {
  url: string;
  type: AiOutputType;
  name?: string;
  /** URL gốc ở nhà cung cấp (khi đã sao lưu về máy chủ mình) */
  sourceUrl?: string;
  /** Nội dung file khi nhà cung cấp trả thẳng file (vd TTS đồng bộ) — lưu vào storage rồi bỏ đi, `url` để trống */
  data?: Buffer;
  mimeType?: string;
}

/** Kết quả một lần gửi / hỏi trạng thái tác vụ */
export interface AiProviderResult {
  status: 'processing' | 'succeeded' | 'failed';
  providerTaskId?: string;
  progress?: number;
  files?: AiOutputFile[];
  text?: string;
  /** Lỗi hiện cho khách (ngắn gọn, không lộ chi tiết nội bộ) */
  error?: string;
  /** Phản hồi thô để admin tra lỗi */
  raw?: unknown;
}

/** Một mẫu giọng nhân bản lưu trong Kho giọng cá nhân của thành viên */
export interface AiUserClonedVoice {
  id: string;
  name: string;
  description?: string;
  language: string;
  gender: 'male' | 'female';
  refText: string;
  samplePath: string;
  upstreamVoiceId?: string;
  createdAt: string;
}

/** Ngữ cảnh truyền cho adapter khi gọi API */
export interface AiCallContext {
  config: AiProviderConfig;
  /** ID thành viên đang thực hiện báo giá / chạy tác vụ (nếu có) */
  userId?: string;
  /** Đọc file đầu vào khách đã tải lên (URL nội bộ -> Buffer) khi nhà cung cấp cần upload trực tiếp */
  readUpload: (url: string) => Promise<{ data: Buffer; mimeType: string; filename: string } | null>;
  /** Thời lượng (giây) file khách tải lên, không đọc cả file vào RAM (video lớn); null = chưa có / không đọc được */
  uploadDuration: (url: string) => Promise<number | null>;
  /** Cắt bỏ `trimSec` giây ở cuối video đầu vào (vd loại bỏ frame rác cuối video TikTok/CapCut trước khi gửi Motion Control) -> trả URL công khai mới */
  trimVideoTail?: (url: string, trimSec: number) => Promise<string>;
  /** Tự động nén chuẩn hoá video vượt quá trần dung lượng `maxBytes` (vd trần 30MB tải link ngoại vi của AI DeepCut — T-437) -> trả URL MP4 gọn nhẹ */
  ensureVideoMaxBytes?: (url: string, maxBytes?: number) => Promise<string>;
  /** Chuẩn hoá URL ảnh `.webp` sang `.jpg` / `.png` để tương thích các nguồn không nhận `.webp` (T-417) */
  ensureStandardImage?: (url: string) => Promise<string>;
  /** Tra cứu mẫu giọng nhân bản trong Kho giọng cá nhân của thành viên kèm Buffer WAV chuẩn hoá */
  getUserClonedVoice?: (voiceId: string) => Promise<(AiUserClonedVoice & { audioData: Buffer }) | null>;
  /** Cập nhật mã giọng `upstreamVoiceId` trên nguồn sau khi tự động nạp lại (re-enroll) */
  setUserClonedVoiceUpstream?: (voiceId: string, upstreamVoiceId: string) => Promise<void>;
}

/** Adapter của một nhà cung cấp AI */
export interface AiProvider {
  /** Khoá nhà cung cấp (vd tmc) — nhóm cài đặt là `ai_<key>` */
  key: string;
  name: string;
  website?: string;
  tools: AiToolDef[];
  /** Tên đơn vị chi phí phía nhà cung cấp (vd 'credit SangTao', 'xu') — hiện ở ô tỉ giá quy đổi */
  costUnit?: string;
  /** Tỉ giá quy đổi mặc định: 1 đơn vị nguồn = bao nhiêu credits web; admin đổi ở tab Khoá API (`ai_<key>.rate`) */
  rate?: number;
  /** Bổ sung / cập nhật động danh sách lựa chọn cho các ô form từ API nhà cung cấp (vd danh sách giọng đọc, có cache) */
  resolveFields?: (tool: AiToolDef, ctx: AiCallContext) => Promise<AiFieldDef[]>;
  /** Tự động phát hiện & đấu nối động các model / sản phẩm mới nhà cung cấp vừa mở trên API + gỡ các sản phẩm đã ngừng hẳn trên nguồn (T-473 & T-474) */
  discoverTools?: (ctx: AiCallContext) => Promise<{
    addedTools: AiToolDef[];
    updatedSplits?: string[];
    removedKeys?: string[];
  }>;
  /** Chi phí phía nhà cung cấp của một lần chạy (dùng cho pricing mode `cost`) */
  cost?: (tool: AiToolDef, input: AiInput, ctx: AiCallContext) => Promise<number | null>;
  /** Gửi tác vụ */
  submit: (tool: AiToolDef, input: AiInput, ctx: AiCallContext) => Promise<AiProviderResult>;
  /** Hỏi trạng thái tác vụ đang xử lý */
  poll?: (tool: AiToolDef, providerTaskId: string, ctx: AiCallContext) => Promise<AiProviderResult>;
  /** Huỷ tác vụ đang chạy bên phía nhà cung cấp khi Admin / hệ thống huỷ hoàn tiền (T-427 & T-429) */
  cancel?: (
    tool: AiToolDef,
    providerTaskId: string,
    ctx: AiCallContext,
  ) => Promise<{ ok: boolean; httpStatus?: number; upstreamStatus?: string; note: string; raw?: unknown }>;
  /** Số dư tài khoản ở nhà cung cấp (trang admin) */
  balance?: (ctx: AiCallContext) => Promise<{ balance: number; unit: string } | null>;
  /** URL file nghe thử của một giọng đọc (null = giọng không tồn tại); API tải hộ để không lộ nhà cung cấp */
  voicePreview?: (voice: string) => string | null;
  /**
   * Tạo file nghe thử bằng chính API nhà cung cấp (khi nhà cung cấp không có file mẫu công khai, vd giọng CapCut của Kapend).
   * null = giọng không có trong danh sách. API lưu file lên storage nên mỗi giọng chỉ tạo (và tốn phí) một lần.
   */
  voiceSample?: (voice: string, ctx: AiCallContext) => Promise<{ data: Buffer; mimeType: string } | null>;
  /**
   * Danh mục model / workflow nhà cung cấp đang bán, đọc trực tiếp từ API (không cache, lỗi thì ném).
   * Bot admin so với lần đọc trước để báo khi nguồn thêm model mới hoặc gỡ model (xem ProviderCatalogMonitor).
   */
  catalog?: (ctx: AiCallContext) => Promise<AiCatalogItem[]>;
  /**
   * Danh sách mã cục bộ (`<tool.key>` hoặc `<tool.key>~<modelId>`) đang bị nguồn tạm khoá / bảo trì, hoặc `'ALL'` nếu cả nguồn đang bảo trì.
   * Trả `null` khi lỗi mạng tạm thời để giữ nguyên trạng thái hiện tại.
   */
  maintenanceCheck?: (ctx: AiCallContext) => Promise<Set<string> | 'ALL' | null>;
}

/** Một model / workflow trong danh mục của nhà cung cấp */
export interface AiCatalogItem {
  /** Mã ổn định phía nhà cung cấp (dùng để so sánh giữa các lần đọc) */
  id: string;
  /** Tên hiển thị trong tin báo */
  label: string;
}

/**
 * Công cụ admin đã xoá nhưng phải giữ dòng (còn tác vụ cũ trỏ tới, hoặc adapter còn khai báo nên lần đồng bộ sau sẽ tạo lại):
 * đánh dấu `options.deleted = true`, luôn tắt và ẩn khỏi admin.
 */
export const isDeletedTool = (options: unknown) => !!options && typeof options === 'object' && (options as Record<string, unknown>).deleted === true;

/** Công cụ / model đang bật chế độ bảo trì (admin gạt tay `maintenance` hoặc tự động theo nguồn `autoMaintenance`) */
export const isMaintenanceTool = (options: unknown) => {
  if (!options || typeof options !== 'object') return false;
  const o = options as Record<string, unknown>;
  return o.maintenance === true || o.autoMaintenance === true;
};

/** Lỗi gọi API nhà cung cấp, `message` đã an toàn để hiện cho khách */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
    /** true = lỗi tạm thời (mạng, 5xx) — hỏi lại sau thay vì đánh lỗi tác vụ */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
