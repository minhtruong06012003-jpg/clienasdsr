/**
 * Danh mục vùng dùng cho vận chuyển: 63 tỉnh/thành Việt Nam (mã ISO 3166-2:VN) + vài quốc gia phổ biến.
 * Mã vùng trong ShippingZone.regions: "VN-HN" (tỉnh/thành), "VN" (quốc gia), "*" (mọi nơi).
 */

export type I18nName = { vi: string; en: string };

export interface Province {
  code: string;
  name: I18nName;
  /** nhóm miền: north | central | south */
  region: 'north' | 'central' | 'south';
  country: 'VN';
}

export interface Country {
  code: string;
  name: I18nName;
}

export const REGION_GROUPS: { key: Province['region']; name: I18nName }[] = [
  { key: 'north', name: { vi: 'Miền Bắc', en: 'Northern Vietnam' } },
  { key: 'central', name: { vi: 'Miền Trung', en: 'Central Vietnam' } },
  { key: 'south', name: { vi: 'Miền Nam', en: 'Southern Vietnam' } },
];

const p = (code: string, vi: string, en: string, region: Province['region']): Province => ({ code: `VN-${code}`, name: { vi, en }, region, country: 'VN' });

export const VN_PROVINCES: Province[] = [
  // ---- Miền Bắc ----
  p('HN', 'Hà Nội', 'Ha Noi', 'north'),
  p('HP', 'Hải Phòng', 'Hai Phong', 'north'),
  p('54', 'Bắc Giang', 'Bac Giang', 'north'),
  p('53', 'Bắc Kạn', 'Bac Kan', 'north'),
  p('56', 'Bắc Ninh', 'Bac Ninh', 'north'),
  p('04', 'Cao Bằng', 'Cao Bang', 'north'),
  p('71', 'Điện Biên', 'Dien Bien', 'north'),
  p('03', 'Hà Giang', 'Ha Giang', 'north'),
  p('63', 'Hà Nam', 'Ha Nam', 'north'),
  p('61', 'Hải Dương', 'Hai Duong', 'north'),
  p('14', 'Hoà Bình', 'Hoa Binh', 'north'),
  p('66', 'Hưng Yên', 'Hung Yen', 'north'),
  p('01', 'Lai Châu', 'Lai Chau', 'north'),
  p('09', 'Lạng Sơn', 'Lang Son', 'north'),
  p('02', 'Lào Cai', 'Lao Cai', 'north'),
  p('67', 'Nam Định', 'Nam Dinh', 'north'),
  p('18', 'Ninh Bình', 'Ninh Binh', 'north'),
  p('68', 'Phú Thọ', 'Phu Tho', 'north'),
  p('13', 'Quảng Ninh', 'Quang Ninh', 'north'),
  p('05', 'Sơn La', 'Son La', 'north'),
  p('20', 'Thái Bình', 'Thai Binh', 'north'),
  p('69', 'Thái Nguyên', 'Thai Nguyen', 'north'),
  p('07', 'Tuyên Quang', 'Tuyen Quang', 'north'),
  p('70', 'Vĩnh Phúc', 'Vinh Phuc', 'north'),
  p('06', 'Yên Bái', 'Yen Bai', 'north'),
  // ---- Miền Trung ----
  p('21', 'Thanh Hoá', 'Thanh Hoa', 'central'),
  p('22', 'Nghệ An', 'Nghe An', 'central'),
  p('23', 'Hà Tĩnh', 'Ha Tinh', 'central'),
  p('24', 'Quảng Bình', 'Quang Binh', 'central'),
  p('25', 'Quảng Trị', 'Quang Tri', 'central'),
  p('26', 'Thừa Thiên Huế', 'Thua Thien Hue', 'central'),
  p('DN', 'Đà Nẵng', 'Da Nang', 'central'),
  p('27', 'Quảng Nam', 'Quang Nam', 'central'),
  p('29', 'Quảng Ngãi', 'Quang Ngai', 'central'),
  p('31', 'Bình Định', 'Binh Dinh', 'central'),
  p('32', 'Phú Yên', 'Phu Yen', 'central'),
  p('34', 'Khánh Hoà', 'Khanh Hoa', 'central'),
  p('36', 'Ninh Thuận', 'Ninh Thuan', 'central'),
  p('40', 'Bình Thuận', 'Binh Thuan', 'central'),
  p('28', 'Kon Tum', 'Kon Tum', 'central'),
  p('30', 'Gia Lai', 'Gia Lai', 'central'),
  p('33', 'Đắk Lắk', 'Dak Lak', 'central'),
  p('72', 'Đắk Nông', 'Dak Nong', 'central'),
  p('35', 'Lâm Đồng', 'Lam Dong', 'central'),
  // ---- Miền Nam ----
  p('SG', 'TP. Hồ Chí Minh', 'Ho Chi Minh City', 'south'),
  p('43', 'Bà Rịa - Vũng Tàu', 'Ba Ria - Vung Tau', 'south'),
  p('57', 'Bình Dương', 'Binh Duong', 'south'),
  p('58', 'Bình Phước', 'Binh Phuoc', 'south'),
  p('39', 'Đồng Nai', 'Dong Nai', 'south'),
  p('37', 'Tây Ninh', 'Tay Ninh', 'south'),
  p('41', 'Long An', 'Long An', 'south'),
  p('46', 'Tiền Giang', 'Tien Giang', 'south'),
  p('50', 'Bến Tre', 'Ben Tre', 'south'),
  p('51', 'Trà Vinh', 'Tra Vinh', 'south'),
  p('49', 'Vĩnh Long', 'Vinh Long', 'south'),
  p('45', 'Đồng Tháp', 'Dong Thap', 'south'),
  p('44', 'An Giang', 'An Giang', 'south'),
  p('47', 'Kiên Giang', 'Kien Giang', 'south'),
  p('CT', 'Cần Thơ', 'Can Tho', 'south'),
  p('73', 'Hậu Giang', 'Hau Giang', 'south'),
  p('52', 'Sóc Trăng', 'Soc Trang', 'south'),
  p('55', 'Bạc Liêu', 'Bac Lieu', 'south'),
  p('59', 'Cà Mau', 'Ca Mau', 'south'),
];

export const COUNTRIES: Country[] = [
  { code: 'VN', name: { vi: 'Việt Nam', en: 'Vietnam' } },
  { code: 'US', name: { vi: 'Hoa Kỳ', en: 'United States' } },
  { code: 'JP', name: { vi: 'Nhật Bản', en: 'Japan' } },
  { code: 'KR', name: { vi: 'Hàn Quốc', en: 'South Korea' } },
  { code: 'CN', name: { vi: 'Trung Quốc', en: 'China' } },
  { code: 'TW', name: { vi: 'Đài Loan', en: 'Taiwan' } },
  { code: 'HK', name: { vi: 'Hồng Kông', en: 'Hong Kong' } },
  { code: 'SG', name: { vi: 'Singapore', en: 'Singapore' } },
  { code: 'TH', name: { vi: 'Thái Lan', en: 'Thailand' } },
  { code: 'MY', name: { vi: 'Malaysia', en: 'Malaysia' } },
  { code: 'ID', name: { vi: 'Indonesia', en: 'Indonesia' } },
  { code: 'PH', name: { vi: 'Philippines', en: 'Philippines' } },
  { code: 'AU', name: { vi: 'Úc', en: 'Australia' } },
  { code: 'GB', name: { vi: 'Anh', en: 'United Kingdom' } },
  { code: 'DE', name: { vi: 'Đức', en: 'Germany' } },
  { code: 'FR', name: { vi: 'Pháp', en: 'France' } },
  { code: 'CA', name: { vi: 'Canada', en: 'Canada' } },
];

export const PROVINCE_MAP = new Map(VN_PROVINCES.map((x) => [x.code, x]));
export const COUNTRY_MAP = new Map(COUNTRIES.map((x) => [x.code, x]));

/** Tên tỉnh/thành theo locale (fallback tiếng Việt) */
export function provinceName(code: string | null | undefined, locale = 'vi') {
  const x = code ? PROVINCE_MAP.get(code) : undefined;
  return x ? (x.name[locale as keyof I18nName] ?? x.name.vi) : null;
}
