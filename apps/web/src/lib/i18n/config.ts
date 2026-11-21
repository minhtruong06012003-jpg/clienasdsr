/**
 * Cấu hình đa ngôn ngữ / đa tiền tệ / múi giờ dùng chung cho client và server component.
 * - Ngôn ngữ: chuỗi gốc viết tiếng Việt trong code; tiếng Anh và tiếng Indonesia có từ điển sẵn (@cmsnt/shared WEB_MESSAGES_EN / WEB_MESSAGES_ID),
 *   ngôn ngữ khác admin thêm + dịch ở menu Ngôn ngữ & tiền tệ (tải qua /public/web-messages, xem translate.ts).
 * - Tiền tệ: mọi số tiền API trả về theo tiền gốc của website (VND); chỉ QUY ĐỔI khi hiển thị theo tỷ giá admin đặt.
 * - Múi giờ: thời gian hiển thị theo múi giờ khách chọn, mặc định theo múi giờ chung của website.
 */

/** Ngôn ngữ có bản dịch viết sẵn trong code (dùng khi chưa tải được danh sách ngôn ngữ admin bật) */
export const BUILT_IN_LOCALES = ["vi", "en", "id", "zh-cn", "th"] as const;
/** Mã ngôn ngữ (vi, en, ja, zh-cn...) — admin thêm ngôn ngữ mới ở menu Ngôn ngữ & tiền tệ */
export type Locale = string;
export const DEFAULT_LOCALE: Locale = "vi";

/** Tên + cờ dự phòng khi bootstrap chưa tải xong */
export const LOCALE_LABELS: Record<string, { name: string; flag: string }> = {
  vi: { name: "Tiếng Việt", flag: "🇻🇳" },
  en: { name: "English", flag: "🇬🇧" },
  id: { name: "Bahasa Indonesia", flag: "🇮🇩" },
  zh: { name: "简体中文", flag: "🇨🇳" },
  "zh-cn": { name: "简体中文", flag: "🇨🇳" },
  th: { name: "ภาษาไทย", flag: "🇹🇭" },
};

/** Tên + cờ dự phòng của một ngôn ngữ (ngôn ngữ admin thêm mà chưa đặt tên / cờ) */
export function localeLabel(code: Locale): { name: string; flag: string } {
  return LOCALE_LABELS[code] ?? { name: code.toUpperCase(), flag: "🌐" };
}

/** Locale dùng cho Intl (định dạng số, ngày) theo ngôn ngữ giao diện; trình duyệt không hỗ trợ mã đó thì dùng en-US */
export function intlLocale(locale: Locale): string {
  const tag =
    locale === "vi"
      ? "vi-VN"
      : locale === "en"
        ? "en-US"
        : locale === "id"
          ? "id-ID"
          : locale === "zh" || locale === "zh-cn"
            ? "zh-CN"
            : locale === "th"
              ? "th-TH"
              : locale;
  try {
    return Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : "en-US";
  } catch {
    return "en-US";
  }
}

/** Cookie lưu lựa chọn của khách (đọc ở server để HTML render đúng ngay từ đầu, không nháy) */
export const LOCALE_COOKIE = "smm_locale";
export const CURRENCY_COOKIE = "smm_currency";
export const TIMEZONE_COOKIE = "smm_tz";

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

/** Một tiền tệ hiển thị: rate = số tiền gốc cho 1 đơn vị (vd USD: 26000 nghĩa là 1 USD = 26.000 ₫) */
export interface CurrencyDef {
  code: string;
  name?: string;
  rate: number;
  decimals: number;
}

/** Cấu hình tiền tệ lấy từ cài đặt nhóm `currency` (bootstrap) */
export interface CurrencyConfig {
  /** tiền gốc của website (đơn vị lưu số dư, giá) */
  base: CurrencyDef;
  /** tiền gốc + các tiền tệ admin bật */
  list: CurrencyDef[];
}

/** Dạng thô nhóm cài đặt `currency` trong bootstrap */
export interface RawCurrencySettings {
  currency?: string;
  decimals?: number;
  /** tỉ giá 1 USD = ? tiền gốc của giá dịch vụ — tiền tệ hiển thị USD luôn dùng tỉ giá này cho khớp giá */
  usdRate?: number | string;
  currencies?: { code?: string; name?: string; rate?: number | string; decimals?: number | string; enabled?: boolean }[];
}

/** Chuẩn hoá cài đặt tiền tệ: bỏ dòng sai mã / tỷ giá <= 0 / đang tắt, bỏ trùng tiền gốc */
export function parseCurrencyConfig(raw: RawCurrencySettings | null | undefined): CurrencyConfig {
  const baseCode = (raw?.currency || "VND").toUpperCase();
  const base: CurrencyDef = { code: baseCode, rate: 1, decimals: Number.isFinite(Number(raw?.decimals)) ? Number(raw?.decimals) : 0 };
  const extra: CurrencyDef[] = [];
  const usdRate = Number(raw?.usdRate);
  for (const c of raw?.currencies ?? []) {
    const code = String(c.code ?? "").toUpperCase();
    const rate = code === "USD" && usdRate > 0 ? usdRate : Number(c.rate);
    if (!/^[A-Z]{3}$/.test(code) || code === baseCode || c.enabled === false || !(rate > 0)) continue;
    if (extra.some((e) => e.code === code)) continue;
    const decimals = Number(c.decimals);
    extra.push({ code, name: c.name, rate, decimals: Number.isFinite(decimals) ? Math.min(Math.max(decimals, 0), 8) : 2 });
  }
  return { base, list: [base, ...extra] };
}

/** Mã ngôn ngữ đúng định dạng (khớp LOCALE_CODE_PATTERN ở @cmsnt/shared), sai -> null; còn bật hay không do nơi gọi đối chiếu danh sách */
export function asLocale(v: string | null | undefined): Locale | null {
  const code = String(v ?? "").trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/.test(code) ? code : null;
}

/** Múi giờ IANA hợp lệ (Intl ném RangeError với tên lạ) */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Lựa chọn hiển thị hiện tại */
export interface Prefs {
  locale: Locale;
  currency: string;
  timezone: string;
}

/** Tên tiền tệ theo ngôn ngữ giao diện (vd "Đồng Việt Nam" / "Vietnamese Dong"); trình duyệt không hỗ trợ -> mã */
export function currencyName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}
