/**
 * Chuỗi giao diện cố định (nút, nhãn, thông báo) hiển thị ở website khách.
 * Bản mặc định khai báo ở đây; admin dịch/ghi đè và thêm khoá riêng tại Ngôn ngữ → Bản dịch giao diện,
 * lưu trong bảng Setting (khoá `uiStrings`) nên thêm ngôn ngữ mới KHÔNG cần sửa code.
 */

/** Mô tả một chuỗi có sẵn: nhóm + chú thích để admin biết chuỗi xuất hiện ở đâu */
export interface UiStringDef {
  key: string;
  group: string;
  description: string;
}

/** Khoá do admin tự thêm (cho frontend riêng của từng dự án dùng) */
export interface UiStringCustomKey {
  key: string;
  description?: string;
}

/** Dữ liệu lưu trong Setting `uiStrings` */
export interface UiStringsStore {
  custom: UiStringCustomKey[];
  /** values[locale][key] = bản dịch admin nhập */
  values: Record<string, Record<string, string>>;
}

/** Danh sách chuỗi có sẵn của các block (thứ tự = thứ tự hiển thị trong admin) */
export const UI_STRING_DEFS: UiStringDef[] = [
  { key: 'yes', group: 'Chung', description: 'Giá trị Có (trường bật/tắt)' },
  { key: 'no', group: 'Chung', description: 'Giá trị Không (trường bật/tắt)' },
  { key: 'viewAll', group: 'Chung', description: 'Nút xem tất cả dưới danh sách' },
  { key: 'readMore', group: 'Chung', description: 'Link đọc tiếp bài viết' },
  { key: 'error', group: 'Chung', description: 'Thông báo lỗi chung' },
  { key: 'noResults', group: 'Chung', description: 'Danh sách nội dung rỗng' },
  { key: 'addToCart', group: 'Cửa hàng', description: 'Nút thêm vào giỏ' },
  { key: 'outOfStock', group: 'Cửa hàng', description: 'Nhãn hết hàng trên thẻ sản phẩm' },
  { key: 'sale', group: 'Cửa hàng', description: 'Nhãn giảm giá' },
  { key: 'from', group: 'Cửa hàng', description: 'Tiền tố giá khi sản phẩm có nhiều mức giá' },
  { key: 'products', group: 'Cửa hàng', description: 'Đơn vị đếm sản phẩm trong danh mục' },
  { key: 'noProducts', group: 'Cửa hàng', description: 'Danh sách sản phẩm rỗng' },
  { key: 'minRead', group: 'Bài viết', description: 'Đơn vị thời gian đọc' },
  { key: 'noPosts', group: 'Bài viết', description: 'Danh sách bài viết rỗng' },
  { key: 'submit', group: 'Biểu mẫu', description: 'Nút gửi biểu mẫu' },
  { key: 'sending', group: 'Biểu mẫu', description: 'Trạng thái đang gửi' },
  { key: 'required', group: 'Biểu mẫu', description: 'Nhãn trường bắt buộc' },
  { key: 'selectOption', group: 'Biểu mẫu', description: 'Lựa chọn trống của ô chọn' },
  { key: 'captchaRequired', group: 'Biểu mẫu', description: 'Nhắc xác minh captcha' },
  { key: 'captchaLoadError', group: 'Biểu mẫu', description: 'Lỗi tải captcha' },
];

/** Bản dịch có sẵn trong code (ngôn ngữ khác do admin tự dịch) */
export const DEFAULT_UI_STRINGS: Record<string, Record<string, string>> = {
  vi: {
    yes: 'Có',
    no: 'Không',
    viewAll: 'Xem tất cả',
    addToCart: 'Thêm vào giỏ',
    outOfStock: 'Hết hàng',
    sale: 'Giảm',
    readMore: 'Đọc tiếp',
    minRead: 'phút đọc',
    products: 'sản phẩm',
    noProducts: 'Chưa có sản phẩm',
    noPosts: 'Chưa có bài viết',
    noResults: 'Chưa có nội dung phù hợp',
    sending: 'Đang gửi...',
    submit: 'Gửi',
    required: 'Bắt buộc',
    selectOption: '-- Chọn --',
    error: 'Có lỗi xảy ra, vui lòng thử lại.',
    from: 'Từ',
    captchaRequired: 'Vui lòng xác minh bạn không phải robot.',
    captchaLoadError: 'Không tải được captcha, vui lòng tải lại trang.',
  },
  en: {
    yes: 'Yes',
    no: 'No',
    viewAll: 'View all',
    addToCart: 'Add to cart',
    outOfStock: 'Out of stock',
    sale: 'Sale',
    readMore: 'Read more',
    minRead: 'min read',
    products: 'products',
    noProducts: 'No products yet',
    noPosts: 'No posts yet',
    noResults: 'Nothing found',
    sending: 'Sending...',
    submit: 'Submit',
    required: 'Required',
    selectOption: '-- Select --',
    error: 'Something went wrong, please try again.',
    from: 'From',
    captchaRequired: 'Please verify that you are not a robot.',
    captchaLoadError: 'Could not load the captcha, please reload the page.',
  },
  id: {
    yes: 'Ya',
    no: 'Tidak',
    viewAll: 'Lihat semua',
    addToCart: 'Tambah ke keranjang',
    outOfStock: 'Stok habis',
    sale: 'Diskon',
    readMore: 'Baca selengkapnya',
    minRead: 'menit baca',
    products: 'produk',
    noProducts: 'Belum ada produk',
    noPosts: 'Belum ada artikel',
    noResults: 'Tidak ada konten yang cocok',
    sending: 'Mengirim...',
    submit: 'Kirim',
    required: 'Wajib diisi',
    selectOption: '-- Pilih --',
    error: 'Terjadi kesalahan, silakan coba lagi.',
    from: 'Mulai',
    captchaRequired: 'Harap verifikasi bahwa Anda bukan robot.',
    captchaLoadError: 'Gagal memuat captcha, silakan muat ulang halaman.',
  },
  zh: {
    yes: '是',
    no: '否',
    viewAll: '查看全部',
    addToCart: '加入购物车',
    outOfStock: '缺货',
    sale: '优惠',
    readMore: '阅读全文',
    minRead: '分钟阅读',
    products: '件商品',
    noProducts: '暂无商品',
    noPosts: '暂无文章',
    noResults: '暂无匹配内容',
    sending: '发送中...',
    submit: '提交',
    required: '必填',
    selectOption: '-- 请选择 --',
    error: '发生错误，请重试。',
    from: '起',
    captchaRequired: '请完成人机验证。',
    captchaLoadError: '验证码加载失败，请刷新页面重试。',
  },
  th: {
    yes: 'ใช่',
    no: 'ไม่',
    viewAll: 'ดูทั้งหมด',
    addToCart: 'เพิ่มลงตะกร้า',
    outOfStock: 'สินค้าหมด',
    sale: 'ลดราคา',
    readMore: 'อ่านเพิ่มเติม',
    minRead: 'นาทีในการอ่าน',
    products: 'รายการ',
    noProducts: 'ยังไม่มีสินค้า',
    noPosts: 'ยังไม่มีบทความ',
    noResults: 'ไม่พบเนื้อหาที่ตรงกัน',
    sending: 'กำลังส่ง...',
    submit: 'ส่ง',
    required: 'จำเป็น',
    selectOption: '-- เลือก --',
    error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง',
    from: 'เริ่มต้น',
    captchaRequired: 'กรุณายืนยันว่าคุณไม่ใช่บอท',
    captchaLoadError: 'โหลด Captcha ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ',
  },
};
DEFAULT_UI_STRINGS['zh-cn'] = DEFAULT_UI_STRINGS.zh;

/** Khoá hợp lệ: chữ, số, dấu chấm, gạch dưới, gạch ngang (vd: header.hotline, footer_copyright) */
export const UI_STRING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;

/** Chuẩn hoá dữ liệu đọc từ DB (có thể rỗng / sai kiểu) thành UiStringsStore an toàn */
export function normalizeUiStrings(raw: unknown): UiStringsStore {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UiStringsStore>;
  const custom = Array.isArray(r.custom) ? r.custom.filter((c): c is UiStringCustomKey => !!c && typeof c.key === 'string') : [];
  const values: Record<string, Record<string, string>> = {};
  if (r.values && typeof r.values === 'object') {
    for (const [locale, dict] of Object.entries(r.values)) {
      if (!dict || typeof dict !== 'object') continue;
      values[locale] = Object.fromEntries(Object.entries(dict).filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>;
    }
  }
  return { custom, values };
}

/**
 * Ghép bảng chuỗi hoàn chỉnh cho một ngôn ngữ.
 * Thứ tự ưu tiên mỗi khoá: bản admin dịch cho locale → bản có sẵn của locale
 * → tiếng Anh (admin sửa / có sẵn) → ngôn ngữ mặc định (admin sửa / có sẵn).
 * Ngôn ngữ mới chưa dịch sẽ hiện tiếng Anh thay vì để trống.
 */
export function resolveUiStrings(locale: string, defaultLocale: string, store?: UiStringsStore | null): Record<string, string> {
  const s = store ?? { custom: [], values: {} };
  const keys = [...UI_STRING_DEFS.map((d) => d.key), ...s.custom.map((c) => c.key)];
  const chain = [s.values[locale], DEFAULT_UI_STRINGS[locale], s.values.en, DEFAULT_UI_STRINGS.en, s.values[defaultLocale], DEFAULT_UI_STRINGS[defaultLocale]];
  const out: Record<string, string> = {};
  for (const key of keys) {
    for (const dict of chain) {
      const v = dict?.[key];
      if (v) {
        out[key] = v;
        break;
      }
    }
    // khoá riêng chưa có bản dịch nào: trả chuỗi rỗng để frontend tự xử lý
    out[key] ??= '';
  }
  return out;
}
