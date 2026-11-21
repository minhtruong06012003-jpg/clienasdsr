/**
 * Font chữ cho website khách (Cài đặt › Font chữ, lưu ở `appearance.fontFamily`).
 * Chỉ gồm font Google Fonts có bộ ký tự tiếng Việt; dùng chung cho admin (ô chọn + xem trước) và web (nạp font).
 */
export interface SiteFont {
  /** Tên font đúng như trên Google Fonts (cũng là giá trị lưu trong cài đặt) */
  name: string;
  /** Các độ đậm cần nạp (font không có đủ 400–800 thì khai báo ít hơn, Google trả lỗi nếu xin độ đậm không có) */
  weights: number[];
  /** Kiểu chữ dự phòng khi font chưa tải xong */
  fallback: 'sans-serif' | 'serif';
}

/** Font mặc định của website (web nạp sẵn bằng next/font, không cần tải thêm).
 * Be Vietnam Pro: thiết kế riêng cho tiếng Việt (dấu chồng rõ, không dính dòng), dáng hình học hiện đại hợp giao diện AI, chữ tiếng Anh cũng đẹp */
export const DEFAULT_SITE_FONT = 'Be Vietnam Pro';

const SANS = [400, 500, 600, 700, 800];

export const SITE_FONTS: SiteFont[] = [
  { name: 'Be Vietnam Pro', weights: SANS, fallback: 'sans-serif' },
  { name: 'Inter', weights: SANS, fallback: 'sans-serif' },
  { name: 'Roboto', weights: SANS, fallback: 'sans-serif' },
  { name: 'Open Sans', weights: SANS, fallback: 'sans-serif' },
  { name: 'Montserrat', weights: SANS, fallback: 'sans-serif' },
  { name: 'Nunito', weights: SANS, fallback: 'sans-serif' },
  { name: 'Mulish', weights: SANS, fallback: 'sans-serif' },
  { name: 'Plus Jakarta Sans', weights: SANS, fallback: 'sans-serif' },
  { name: 'Lexend', weights: SANS, fallback: 'sans-serif' },
  { name: 'Noto Sans', weights: SANS, fallback: 'sans-serif' },
  { name: 'Source Sans 3', weights: SANS, fallback: 'sans-serif' },
  { name: 'Work Sans', weights: SANS, fallback: 'sans-serif' },
  { name: 'Raleway', weights: SANS, fallback: 'sans-serif' },
  { name: 'Quicksand', weights: [400, 500, 600, 700], fallback: 'sans-serif' },
  { name: 'Josefin Sans', weights: [400, 500, 600, 700], fallback: 'sans-serif' },
  { name: 'Lora', weights: [400, 500, 600, 700], fallback: 'serif' },
  { name: 'Playfair Display', weights: SANS, fallback: 'serif' },
  { name: 'Merriweather', weights: [400, 700], fallback: 'serif' },
];

/** Tìm font trong danh sách hỗ trợ (giá trị lạ / chưa chọn -> undefined) */
export function findSiteFont(name: unknown): SiteFont | undefined {
  return typeof name === 'string' ? SITE_FONTS.find((f) => f.name === name) : undefined;
}

/** Link CSS Google Fonts của font (đủ độ đậm, có chữ tiếng Việt, display=swap để không chặn hiển thị chữ) */
export function googleFontHref(font: SiteFont): string {
  return `https://fonts.googleapis.com/css2?family=${font.name.replace(/ /g, '+')}:wght@${font.weights.join(';')}&display=swap`;
}

/** Chuỗi font-family CSS: font đã chọn rồi tới font hệ thống cùng kiểu */
export function siteFontStack(font: SiteFont): string {
  return font.fallback === 'serif' ? `'${font.name}', Georgia, 'Times New Roman', serif` : `'${font.name}', system-ui, -apple-system, 'Segoe UI', sans-serif`;
}
