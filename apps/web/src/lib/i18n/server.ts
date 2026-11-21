/**
 * Đa ngôn ngữ cho server component (root layout, blog, trang CMS, metadata).
 * Lựa chọn lấy từ cookie (provider phía client ghi), cài đặt tiền tệ / múi giờ lấy từ bootstrap (cache 60 giây),
 * bản dịch admin lưu của ngôn ngữ đang chọn lấy từ /public/web-messages (cache 60 giây) rồi gửi kèm cho client.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { serverGet } from "../server-api";
import type { Bootstrap } from "../types";
import { asLocale, CURRENCY_COOKIE, DEFAULT_LOCALE, DEFAULT_TIMEZONE, isValidTimeZone, LOCALE_COOKIE, localeLabel, parseCurrencyConfig, TIMEZONE_COOKIE, type RawCurrencySettings } from "./config";
import { createFormatters } from "./formatters";
import type { I18nInitial, LanguageOption } from "./provider";
import { createT, setMessages } from "./translate";

/** Đọc lựa chọn + cài đặt một lần cho mỗi request (cache theo request của React) */
export const getI18nInitial = cache(async (): Promise<I18nInitial> => {
  const store = await cookies();
  const boot = await serverGet<Bootstrap>("/public/bootstrap");
  const settings = boot.data?.settings;
  const siteTz = (settings?.general as { timezone?: string } | undefined)?.timezone;
  const languages: LanguageOption[] | null = boot.data?.languages
    ? boot.data.languages
        .filter((l) => l.enabled !== false)
        .flatMap((l) => {
          const code = asLocale(l.code);
          return code ? [{ code, name: l.nativeName || l.name || localeLabel(code).name, flag: l.flag || localeLabel(code).flag }] : [];
        })
    : null;
  // ngôn ngữ: cookie -> ngôn ngữ mặc định admin đặt (nếu có từ điển) -> tiếng Việt
  const cookieLocale = asLocale(store.get(LOCALE_COOKIE)?.value);
  const allowed = (l: string | null) => !!l && (!languages || languages.length === 0 || languages.some((x) => x.code === l));
  const adminDefault = asLocale(boot.data?.defaultLocale);
  const locale = cookieLocale && allowed(cookieLocale) ? cookieLocale : adminDefault && allowed(adminDefault) ? adminDefault : DEFAULT_LOCALE;
  // bản dịch admin lưu cho ngôn ngữ này (lỗi mạng -> dùng từ điển có sẵn / chữ gốc)
  const msg = await serverGet<{ messages?: Record<string, string> }>(`/public/web-messages?locale=${encodeURIComponent(locale)}`);
  const messages = msg.data?.messages ?? {};
  setMessages(locale, messages);
  return {
    locale,
    messages,
    currency: store.get(CURRENCY_COOKIE)?.value ?? null,
    timezone: store.get(TIMEZONE_COOKIE)?.value ?? null,
    siteTimezone: isValidTimeZone(siteTz) ? siteTz : DEFAULT_TIMEZONE,
    currencySettings: (settings?.currency as RawCurrencySettings | undefined) ?? null,
    languages: languages && languages.length ? languages : null,
  };
});

/** t + fmt cho server component, cùng lựa chọn với client */
export async function getServerI18n() {
  const init = await getI18nInitial();
  const currencies = parseCurrencyConfig(init.currencySettings);
  const currency = init.currency && currencies.list.some((c) => c.code === init.currency) ? init.currency : currencies.base.code;
  const timezone = isValidTimeZone(init.timezone) ? init.timezone : init.siteTimezone;
  const t = createT(init.locale);
  return { locale: init.locale, t, fmt: createFormatters({ locale: init.locale, currency, timezone }, currencies, t) };
}
