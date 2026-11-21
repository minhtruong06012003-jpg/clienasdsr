/**
 * Nội dung landing page (trang chủ website khách), admin chỉnh ở menu Nội dung › Trang chủ (nhóm cài đặt `landing`).
 * Dùng chung cho: API (giá trị mặc định của nhóm cài đặt), admin (form chỉnh + nút khôi phục mặc định), web (render + dự phòng).
 *
 * Chữ hiển thị là `LandingText`: chuỗi tiếng Việt hoặc object đa ngôn ngữ { vi, en }. Web chọn theo ngôn ngữ khách,
 * ngôn ngữ chưa nhập thì dịch chữ tiếng Việt qua từ điển website (nên nội dung mặc định vẫn có bản tiếng Anh).
 */

export type LandingText = string | Record<string, string>;

/** Các khối của trang chủ (thứ tự trong mảng `sections` = thứ tự hiển thị) */
export const LANDING_SECTION_KEYS = ['hero', 'platforms', 'stats', 'features', 'steps', 'pricing', 'testimonials', 'faq', 'cta'] as const;
export type LandingSectionKey = (typeof LANDING_SECTION_KEYS)[number];

/** Tên khối hiển thị trong admin */
export const LANDING_SECTION_LABELS: Record<LandingSectionKey, string> = {
  hero: 'Banner đầu trang',
  platforms: 'Nền tảng hỗ trợ',
  stats: 'Số liệu',
  features: 'Tính năng nổi bật',
  steps: 'Các bước sử dụng',
  pricing: 'Bảng giá nổi bật',
  testimonials: 'Đánh giá khách hàng',
  faq: 'Câu hỏi thường gặp',
  cta: 'Kêu gọi đăng ký cuối trang',
};

/**
 * Icon admin được chọn cho thẻ tính năng / bước / số liệu (tên icon lucide).
 * Web và admin tự ánh xạ tên -> component; tên lạ thì dùng icon đầu danh sách.
 */
export const LANDING_ICONS = [
  'zap', 'wallet', 'refresh-cw', 'shield-check', 'code', 'headphones', 'user-plus', 'credit-card', 'mouse-pointer-click', 'rocket',
  'line-chart', 'layers', 'clock', 'badge-check', 'star', 'heart', 'trending-up', 'globe', 'gift', 'lock', 'users', 'thumbs-up', 'sparkles', 'target',
] as const;
export type LandingIcon = (typeof LANDING_ICONS)[number];

export interface LandingLink {
  label: LandingText;
  href: string;
}

export interface LandingCard {
  icon: string;
  title: LandingText;
  desc: LandingText;
}

/** Ô số liệu: `value` có thể chứa biến {orders} {users} {services} — thay bằng số thật của hệ thống */
export interface LandingStat {
  icon: string;
  value: LandingText;
  label: LandingText;
}

export interface LandingTestimonial {
  name: string;
  role: LandingText;
  content: LandingText;
  /** 1–5 sao */
  rating: number;
}

export interface LandingFaq {
  q: LandingText;
  a: LandingText;
}

/** Tiêu đề chung của một khối: dòng nhỏ phía trên, tiêu đề, mô tả */
export interface LandingHeading {
  eyebrow: LandingText;
  title: LandingText;
  desc: LandingText;
}

export interface LandingContent {
  sections: { key: LandingSectionKey; enabled: boolean }[];
  hero: {
    badge: LandingText;
    /** tiêu đề chia 3 phần, phần giữa tô màu gradient */
    titleBefore: LandingText;
    titleHighlight: LandingText;
    titleAfter: LandingText;
    /** mô tả, {name} = tên website */
    desc: LandingText;
    primary: LandingLink;
    secondary: LandingLink;
    /** cam kết ngắn dưới nút (tick xanh) */
    highlights: LandingText[];
    /** hiện thẻ đơn hàng minh hoạ bên phải */
    showVisual: boolean;
  };
  platforms: { title: LandingText };
  stats: { items: LandingStat[] };
  features: LandingHeading & { items: LandingCard[] };
  steps: LandingHeading & { items: LandingCard[] };
  pricing: LandingHeading & { limit: number };
  testimonials: LandingHeading & { items: LandingTestimonial[] };
  faq: LandingHeading & { items: LandingFaq[] };
  cta: { title: LandingText; desc: LandingText; primary: LandingLink; secondary: LandingLink };
}

export const LANDING_DEFAULTS: LandingContent = {
  sections: LANDING_SECTION_KEYS.map((key) => ({ key, enabled: true })),
  hero: {
    badge: 'Hệ thống SMM tự động 24/7',
    titleBefore: 'Tăng tương tác',
    titleHighlight: 'mạng xã hội',
    titleAfter: 'nhanh, rẻ và an toàn',
    desc: '{name} cung cấp like, follow, view, comment, share… cho Facebook, TikTok, Instagram, YouTube, Telegram và nhiều nền tảng khác. Đặt đơn trong vài giây, theo dõi trạng thái realtime, bảo hành rõ ràng.',
    primary: { label: 'Bắt đầu ngay', href: '/register' },
    secondary: { label: 'Bảng giá', href: '/services' },
    highlights: ['Không cần mật khẩu', 'Hoàn tiền tự động', 'Chạy ngay sau khi đặt'],
    showVisual: true,
  },
  platforms: { title: 'Hỗ trợ đầy đủ các nền tảng phổ biến' },
  stats: {
    items: [
      { icon: 'line-chart', value: '{orders}+', label: 'Đơn hàng đã xử lý' },
      { icon: 'user-plus', value: '{users}+', label: 'Khách hàng tin dùng' },
      { icon: 'layers', value: '{services}+', label: 'Dịch vụ đang mở bán' },
      { icon: 'clock', value: '24/7', label: 'Hệ thống hoạt động' },
    ],
  },
  features: {
    eyebrow: 'Vì sao chọn chúng tôi',
    title: 'Mọi thứ bạn cần để phát triển kênh',
    desc: 'Từ cá nhân xây kênh đến agency chạy hàng nghìn đơn mỗi ngày.',
    items: [
      { icon: 'zap', title: 'Tự động & tức thì', desc: 'Đơn được gửi xử lý ngay sau khi đặt, không cần chờ duyệt thủ công.' },
      { icon: 'wallet', title: 'Giá cạnh tranh', desc: 'Giá tốt từ nhiều nhà cung cấp, giảm thêm theo cấp bậc thành viên.' },
      { icon: 'refresh-cw', title: 'Bảo hành & hoàn tiền', desc: 'Dịch vụ có bảo hành được yêu cầu bảo hành một chạm; đơn thiếu tự hoàn tiền.' },
      { icon: 'shield-check', title: 'An toàn tuyệt đối', desc: 'Chỉ cần link công khai, không bao giờ hỏi mật khẩu tài khoản của bạn.' },
      { icon: 'code', title: 'API cho đại lý', desc: 'Chuẩn SMM API v2, kết nối panel của bạn chỉ trong vài phút.' },
      { icon: 'headphones', title: 'Hỗ trợ tận tâm', desc: 'Ticket hỗ trợ phản hồi nhanh, đội ngũ am hiểu từng nền tảng.' },
    ],
  },
  steps: {
    eyebrow: 'Bắt đầu dễ dàng',
    title: '4 bước để có tương tác đầu tiên',
    desc: '',
    items: [
      { icon: 'user-plus', title: 'Tạo tài khoản', desc: 'Đăng ký miễn phí chỉ với email trong 30 giây.' },
      { icon: 'credit-card', title: 'Nạp tiền', desc: 'Chuyển khoản QR, tiền tự động cộng vào số dư.' },
      { icon: 'mouse-pointer-click', title: 'Chọn dịch vụ', desc: 'Chọn nền tảng, dịch vụ, dán link và số lượng.' },
      { icon: 'rocket', title: 'Theo dõi kết quả', desc: 'Đơn chạy tự động, theo dõi tiến độ ngay trên bảng điều khiển.' },
    ],
  },
  pricing: {
    eyebrow: 'Bảng giá',
    title: 'Giá tốt cho mọi nhu cầu',
    desc: 'Giá tính trên 1.000 lượt. Đăng nhập để xem giá đã giảm theo cấp bậc của bạn.',
    limit: 6,
  },
  testimonials: {
    eyebrow: 'Khách hàng nói gì',
    title: 'Được tin dùng bởi hàng nghìn nhà sáng tạo',
    desc: 'Cá nhân, shop online và agency đang dùng hệ thống mỗi ngày.',
    items: [
      { name: 'Minh Anh', role: 'Chủ shop thời trang', content: 'Đơn chạy rất nhanh, follow lên đều và tự nhiên. Hỗ trợ trả lời ticket chỉ vài phút.', rating: 5 },
      { name: 'Quốc Huy', role: 'TikToker', content: 'Giá rẻ hơn nhiều nơi mình từng dùng, lại có bảo hành rõ ràng nên rất yên tâm.', rating: 5 },
      { name: 'Thu Trang', role: 'Agency marketing', content: 'Kết nối API vào panel riêng rất dễ, đơn tự động đồng bộ trạng thái, tiết kiệm nhiều thời gian.', rating: 5 },
    ],
  },
  faq: {
    eyebrow: 'Hỏi đáp',
    title: 'Câu hỏi thường gặp',
    desc: '',
    items: [
      { q: 'Dịch vụ có an toàn cho tài khoản của tôi không?', a: 'Có. Chúng tôi chỉ cần đường dẫn công khai (link bài viết, link kênh…), không bao giờ yêu cầu mật khẩu. Tương tác được phân phối từ từ để trông tự nhiên.' },
      { q: 'Bao lâu thì đơn hàng bắt đầu chạy?', a: 'Phần lớn dịch vụ bắt đầu trong vài phút sau khi đặt. Thời gian trung bình của từng dịch vụ được hiển thị ngay ở form đặt đơn.' },
      { q: 'Nếu đơn chạy không đủ thì sao?', a: 'Đơn chạy không đủ (Hoàn tiền một phần) hoặc bị huỷ sẽ được hoàn tiền tự động phần chưa chạy vào số dư của bạn.' },
      { q: 'Bảo hành hoạt động như thế nào?', a: 'Với dịch vụ có nhãn Bảo hành, nếu số lượng bị tụt trong thời gian bảo hành, bạn bấm nút Bảo hành ở Lịch sử đơn để hệ thống chạy bù.' },
      { q: 'Tôi có thể nạp tiền bằng cách nào?', a: 'Chuyển khoản ngân hàng qua mã QR (tự động cộng tiền sau vài giây).' },
      { q: 'Có API cho đại lý không?', a: 'Có. Chúng tôi hỗ trợ chuẩn SMM API v2 phổ biến, bạn tạo API key trong mục API của tài khoản.' },
    ],
  },
  cta: {
    title: 'Sẵn sàng bùng nổ tương tác?',
    desc: 'Tạo tài khoản miễn phí và đặt đơn đầu tiên chỉ trong một phút.',
    primary: { label: 'Đăng ký ngay', href: '/register' },
    secondary: { label: 'Xem dịch vụ', href: '/services' },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Gộp nội dung admin lưu lên mặc định theo từng khối (cài đặt chỉ gộp nông ở cấp nhóm).
 * Khối thiếu trong `sections` (vd khối mới thêm sau này) được nối vào cuối, khoá lạ bị bỏ.
 */
export function normalizeLanding(raw: unknown): LandingContent {
  const src = isObj(raw) ? raw : {};
  const out = { ...LANDING_DEFAULTS } as Record<string, unknown>;
  for (const key of LANDING_SECTION_KEYS) {
    const v = src[key];
    if (isObj(v)) out[key] = { ...(LANDING_DEFAULTS[key] as object), ...v };
  }
  const saved = Array.isArray(src.sections) ? src.sections : [];
  const seen = new Set<string>();
  const sections: LandingContent['sections'] = [];
  for (const s of saved) {
    if (!isObj(s) || !LANDING_SECTION_KEYS.includes(s.key as LandingSectionKey) || seen.has(String(s.key))) continue;
    seen.add(String(s.key));
    sections.push({ key: s.key as LandingSectionKey, enabled: s.enabled !== false });
  }
  for (const key of LANDING_SECTION_KEYS) if (!seen.has(key)) sections.push({ key, enabled: true });
  out.sections = sections;
  return out as unknown as LandingContent;
}
