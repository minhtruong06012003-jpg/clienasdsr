/**
 * Bộ định dạng tiền / số / thời gian theo lựa chọn của khách (ngôn ngữ, tiền tệ, múi giờ).
 * Dùng qua hook `useI18n().fmt` ở client hoặc `getServerI18n().fmt` ở server component.
 */
import { intlLocale, type CurrencyConfig, type CurrencyDef, type Prefs } from "./config";
import { createT, type TFunction } from "./translate";
import { toNumber } from "../format";

export interface Formatters {
  /** Tiền tệ đang hiển thị */
  currency: CurrencyDef;
  /** Tiền gốc của website (số dư, giá lưu theo tiền này) */
  base: CurrencyDef;
  /** Đổi số tiền gốc sang tiền tệ hiển thị (số) */
  convert: (v: unknown) => number;
  /** Đổi số tiền theo tiền tệ hiển thị về tiền gốc (khi khách nhập theo tiền hiển thị) */
  toBase: (v: unknown) => number;
  /** Số tiền (theo tiền gốc) -> chuỗi theo tiền tệ hiển thị, vd 125.000 ₫ hoặc $4.81 */
  money: (v: unknown) => string;
  /** Giá lẻ (vd giá /1000 rất nhỏ khi đổi ra USD) — tự tăng số chữ số lẻ để không thành 0 */
  price: (v: unknown) => string;
  /** Định dạng theo tiền gốc, không quy đổi (số tiền thật khi chuyển khoản / nạp qua cổng) */
  moneyBase: (v: unknown) => string;
  /** Số nguyên có phân cách hàng nghìn theo ngôn ngữ */
  num: (v: unknown) => string;
  /** Ngày giờ đầy đủ theo múi giờ khách: 22/10/2026 14:05 */
  dateTime: (v: string | Date | null | undefined) => string;
  /** Chỉ ngày: 22/10/2026 */
  dateOnly: (v: string | Date | null | undefined) => string;
  /** Chỉ giờ: 14:05 */
  timeOnly: (v: string | Date | null | undefined) => string;
  /** Thời gian tương đối: "5 phút trước" / "5 minutes ago" */
  timeAgo: (v: string | Date | null | undefined) => string;
  /** Thời gian trung bình của dịch vụ (API trả số phút hoặc chuỗi mô tả) */
  averageTime: (v: string | number | null | undefined) => string | null;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Tạo bộ định dạng cho một lựa chọn hiển thị */
export function createFormatters(prefs: Prefs, currencies: CurrencyConfig, t: TFunction = createT(prefs.locale)): Formatters {
  const intl = intlLocale(prefs.locale);
  const base = currencies.base;
  const currency = currencies.list.find((c) => c.code === prefs.currency) ?? base;
  const tz = prefs.timezone;

  // Intl ném lỗi nếu mã tiền tệ lạ -> dự phòng hiển thị số + mã
  const currencyFormat = (code: string, min: number, max: number) => {
    // VND: dùng ký hiệu "đ" gọn sắc nét thay vì U+20AB (₫) vốn bị dính gạch chân thành khối vuông trên Windows
    if (code === "VND") {
      const nf = new Intl.NumberFormat(intl, { minimumFractionDigits: min, maximumFractionDigits: max });
      return { format: (n: number) => `${nf.format(n)}đ` };
    }
    try {
      // USD luôn theo kiểu Mỹ ($3.81) cho dễ đọc, kể cả khi giao diện tiếng Việt (tránh "3,81 US$")
      return new Intl.NumberFormat(code === "USD" ? "en-US" : intl, { style: "currency", currency: code, minimumFractionDigits: min, maximumFractionDigits: max });
    } catch {
      const nf = new Intl.NumberFormat(intl, { minimumFractionDigits: min, maximumFractionDigits: max });
      return { format: (n: number) => `${nf.format(n)} ${code}` };
    }
  };
  const moneyFmt = currencyFormat(currency.code, currency.decimals, currency.decimals);
  const baseFmt = currencyFormat(base.code, 0, Math.max(base.decimals, 0));
  const numberFmt = new Intl.NumberFormat(intl);
  const dtFmt = new Intl.DateTimeFormat(intl, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  const dFmt = new Intl.DateTimeFormat(intl, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz });
  const tFmt = new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  const rtf = new Intl.RelativeTimeFormat(intl, { numeric: "always" });

  const convert = (v: unknown) => toNumber(v) / currency.rate;
  const toBase = (v: unknown) => toNumber(v) * currency.rate;

  const dateOnly = (v: string | Date | null | undefined) => {
    const d = toDate(v);
    return d ? dFmt.format(d) : "—";
  };

  return {
    currency,
    base,
    convert,
    toBase,
    money: (v) => moneyFmt.format(convert(v)),
    price: (v) => {
      const n = convert(v);
      if (n === 0 || Number.isInteger(n)) return moneyFmt.format(n);
      // đủ chữ số lẻ để thấy ~3 chữ số có nghĩa (giá 0,0005 $ không bị làm tròn thành 0)
      const digits = Math.min(8, Math.max(currency.decimals, Math.ceil(-Math.log10(Math.abs(n))) + 2, currency.decimals === 0 ? 2 : 0));
      return currencyFormat(currency.code, Math.min(currency.decimals, digits), digits).format(n);
    },
    moneyBase: (v) => baseFmt.format(toNumber(v)),
    num: (v) => numberFmt.format(toNumber(v)),
    dateTime: (v) => {
      const d = toDate(v);
      return d ? dtFmt.format(d) : "—";
    },
    dateOnly,
    timeOnly: (v) => {
      const d = toDate(v);
      return d ? tFmt.format(d) : "—";
    },
    timeAgo: (v) => {
      const d = toDate(v);
      if (!d) return "—";
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return t("vừa xong");
      if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
      if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
      if (diff < 86400 * 30) return rtf.format(-Math.floor(diff / 86400), "day");
      return dateOnly(d);
    },
    averageTime: (v) => {
      if (v === null || v === undefined || v === "") return null;
      if (typeof v === "string" && !/^\d+$/.test(v.trim())) return v;
      const minutes = toNumber(v);
      if (minutes <= 0) return null;
      if (minutes < 60) return t("{n} phút", { n: minutes });
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (h < 24) return m ? t("{h} giờ {m} phút", { h, m }) : t("{h} giờ", { h });
      const days = Math.floor(h / 24);
      const hh = h % 24;
      return hh ? t("{d} ngày {h} giờ", { d: days, h: hh }) : t("{d} ngày", { d: days });
    },
  };
}
