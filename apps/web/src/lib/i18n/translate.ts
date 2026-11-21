/**
 * Hàm dịch thuần (dùng được cả client lẫn server component).
 * Quy ước: khoá chính là chuỗi tiếng Việt gốc, biến chèn dạng `{ten}`: t("Còn {n} ngày", { n: 3 }).
 */
import { WEB_MESSAGES_EN, WEB_MESSAGES_ID, WEB_MESSAGES_TH, WEB_MESSAGES_ZH } from "@cmsnt/shared";
import type { Locale } from "./config";

/** Từ điển viết sẵn trong code (tiếng Việt là chữ gốc nên không cần) */
const BUILT_IN: Record<string, Record<string, string>> = {
  en: WEB_MESSAGES_EN,
  id: WEB_MESSAGES_ID,
  zh: WEB_MESSAGES_ZH,
  "zh-cn": WEB_MESSAGES_ZH,
  th: WEB_MESSAGES_TH,
};
/** Bản dịch admin lưu (menu Ngôn ngữ & tiền tệ › Bản dịch website), đã gộp lên từ điển có sẵn */
const merged: Record<string, Record<string, string>> = {};
/** Bản dịch admin đã nạp gần nhất theo ngôn ngữ (để bỏ qua khi nạp lại đúng object cũ) */
const loaded: Record<string, Record<string, string>> = {};

/**
 * Nạp bản dịch admin lưu cho một ngôn ngữ (server: getI18nInitial; client: provider khi đổi ngôn ngữ).
 * Ghi đè lên từ điển có sẵn; ngôn ngữ không có bản nào thì chuỗi chưa dịch hiện tiếng Việt gốc.
 */
export function setMessages(locale: Locale, messages: Record<string, string> | null | undefined) {
  const dict = messages ?? {};
  if (loaded[locale] === dict) return;
  loaded[locale] = dict;
  merged[locale] = { ...BUILT_IN[locale], ...dict };
}

/** Đã nạp bản dịch admin của ngôn ngữ này chưa (client tránh tải lại khi đổi qua đổi lại) */
export function hasMessages(locale: Locale): boolean {
  return locale in loaded;
}

export type TranslateVars = Record<string, string | number | null | undefined>;
export type TFunction = (text: string, vars?: TranslateVars) => string;

/** Thay `{ten}` bằng giá trị tương ứng; biến không có giữ nguyên để dễ phát hiện thiếu */
function interpolate(text: string, vars?: TranslateVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/**
 * Dịch một chuỗi sang `locale`; thiếu bản dịch thì dùng chuỗi gốc tiếng Việt.
 * Ngữ cảnh: khoá dạng `"nav::Dịch vụ"` cho phép dịch khác nhau cùng một chữ (menu "Services" / nhãn "Service");
 * thiếu bản dịch theo ngữ cảnh thì dùng bản dịch thường, cuối cùng là chữ gốc (bỏ tiền tố).
 */
export function translate(locale: Locale, text: string, vars?: TranslateVars): string {
  const dict = merged[locale] ?? BUILT_IN[locale];
  const sep = text.indexOf("::");
  const plain = sep > 0 && /^\w+$/.test(text.slice(0, sep)) ? text.slice(sep + 2) : text;
  return interpolate(dict?.[text] ?? dict?.[plain] ?? plain, vars);
}

/** Tạo hàm t gắn sẵn ngôn ngữ */
export function createT(locale: Locale): TFunction {
  return (text, vars) => translate(locale, text, vars);
}

/**
 * Ngôn ngữ đang dùng cho code ngoài React (lib/api, toast trong QueryCache...). Provider cập nhật ở client;
 * ở server luôn là ngôn ngữ mặc định nên CHỈ dùng `tNow` trong xử lý sự kiện / callback phía trình duyệt.
 */
let activeLocale: Locale = "vi";

export function setActiveLocale(l: Locale) {
  activeLocale = l;
}

/** Dịch theo ngôn ngữ đang chọn, dùng ở nơi không gọi được hook (callback, hàm tiện ích) */
export function tNow(text: string, vars?: TranslateVars): string {
  return translate(activeLocale, text, vars);
}
