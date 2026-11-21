"use client";

/**
 * Provider ngôn ngữ / tiền tệ / múi giờ cho toàn bộ web khách.
 * - Giá trị ban đầu do root layout đọc từ cookie + cài đặt website ở server (HTML render đúng ngay, không nháy).
 * - Đã đăng nhập: lựa chọn lưu trên tài khoản (`PATCH /auth/me` locale/currency/timezone) là nguồn chính,
 *   tự áp dụng khi đăng nhập ở máy khác; cookie chỉ là bản sao để server render.
 * - Đổi ngôn ngữ thì `router.refresh()` để server component (blog, trang CMS, tiêu đề trang) render lại.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ME_KEY, useAuth } from "../auth";
import { useBootstrap } from "../queries";
import type { User } from "../types";
import {
  asLocale,
  BUILT_IN_LOCALES,
  CURRENCY_COOKIE,
  isValidTimeZone,
  LOCALE_COOKIE,
  localeLabel,
  parseCurrencyConfig,
  TIMEZONE_COOKIE,
  type CurrencyConfig,
  type Locale,
  type Prefs,
  type RawCurrencySettings,
} from "./config";
import { createFormatters, type Formatters } from "./formatters";
import { createT, hasMessages, setActiveLocale, setMessages, type TFunction } from "./translate";

export interface LanguageOption {
  code: Locale;
  name: string;
  flag: string;
}

interface I18nContextValue extends Prefs {
  t: TFunction;
  fmt: Formatters;
  /** Ngôn ngữ được chọn (admin đang bật) */
  languages: LanguageOption[];
  /** Tiền tệ được chọn: tiền gốc + tiền tệ admin bật */
  currencies: CurrencyConfig;
  /** Múi giờ mặc định của website (khi khách chưa chọn) */
  siteTimezone: string;
  setLocale: (l: Locale) => Promise<void>;
  setCurrency: (code: string) => Promise<void>;
  /** null = về múi giờ chung của website */
  setTimezone: (tz: string | null) => Promise<void>;
}

/** Export để lib/queries đọc ngôn ngữ mà không ném lỗi khi nằm ngoài provider */
export const I18nContext = createContext<I18nContextValue | null>(null);

/** Ghi cookie 1 năm (đọc lại ở server khi render trang); bọc try/catch để không vỡ app khi Safari bật Chặn tất cả cookie (T-252) */
function writeCookie(name: string, value: string | null) {
  if (typeof document === "undefined") return;
  try {
    document.cookie = value ? `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax` : `${name}=; path=/; max-age=0; samesite=lax`;
  } catch {
    /* Safari bật Chặn tất cả cookie -> giữ nguyên state trong RAM */
  }
}

export interface I18nInitial {
  locale: Locale;
  /** cookie tiền tệ (có thể chưa có / không còn hợp lệ) */
  currency: string | null;
  /** cookie múi giờ */
  timezone: string | null;
  siteTimezone: string;
  currencySettings: RawCurrencySettings | null;
  languages: LanguageOption[] | null;
  /** bản dịch admin lưu cho `locale` (server tải sẵn) */
  messages: Record<string, string>;
}

/** Tải bản dịch admin lưu của một ngôn ngữ (lỗi -> rỗng: dùng từ điển có sẵn / chữ gốc tiếng Việt) */
async function loadMessages(locale: Locale) {
  if (hasMessages(locale)) return;
  const r = await api.get<{ messages?: Record<string, string> }>("/public/web-messages", { locale }).catch(() => null);
  setMessages(locale, r?.messages ?? {});
}

export function I18nProvider({ initial, children }: { initial: I18nInitial; children: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { status, user } = useAuth();
  // bản dịch server gửi kèm (đổi ngôn ngữ + router.refresh thì server gửi bản mới) — nạp trước khi dựng hàm t
  setMessages(initial.locale, initial.messages);
  const [locale, setLocaleState] = useState<Locale>(initial.locale);
  // bootstrap (tên site, menu, cổng nạp...) tải theo ngôn ngữ đang chọn
  const { data: boot } = useBootstrap(locale);

  // cài đặt website: ưu tiên bootstrap mới nhất ở client, chưa có thì dùng bản server gửi kèm
  const currencies = useMemo(() => parseCurrencyConfig((boot?.settings?.currency as RawCurrencySettings | undefined) ?? initial.currencySettings), [boot, initial.currencySettings]);
  const siteTimezone = useMemo(() => {
    const tz = (boot?.settings?.general as { timezone?: string } | undefined)?.timezone ?? initial.siteTimezone;
    return isValidTimeZone(tz) ? tz : initial.siteTimezone;
  }, [boot, initial.siteTimezone]);
  const languages = useMemo<LanguageOption[]>(() => {
    const enabled = boot?.languages?.filter((l) => l.enabled !== false) ?? null;
    if (!enabled) return initial.languages ?? BUILT_IN_LOCALES.map((code) => ({ code, ...localeLabel(code) }));
    const list = enabled.flatMap((l) => {
      const code = asLocale(l.code);
      return code ? [{ code, name: l.nativeName || l.name || localeLabel(code).name, flag: l.flag || localeLabel(code).flag }] : [];
    });
    return list.length ? list : [{ code: "vi", ...localeLabel("vi") }];
  }, [boot, initial.languages]);

  const [currencyChoice, setCurrencyChoice] = useState<string | null>(initial.currency);
  const [tzChoice, setTzChoice] = useState<string | null>(isValidTimeZone(initial.timezone) ? initial.timezone : null);

  // lựa chọn không còn hợp lệ (admin tắt tiền tệ) -> rơi về tiền gốc
  const currency = currencyChoice && currencies.list.some((c) => c.code === currencyChoice) ? currencyChoice : currencies.base.code;
  const timezone = tzChoice ?? siteTimezone;

  // áp lựa chọn đã lưu trên tài khoản khi vừa đăng nhập / tải xong /auth/me;
  // tài khoản chưa từng chọn (null) mà trình duyệt đang có lựa chọn -> lưu lựa chọn đó lên tài khoản (không làm mất)
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "authenticated" || !user || appliedFor.current === user.id) return;
    appliedFor.current = user.id;
    const push: Partial<Pick<User, "locale" | "currency" | "timezone">> = {};
    const l = asLocale(user.locale);
    if (l && l !== locale && languages.some((x) => x.code === l)) {
      // tải bản dịch trước rồi mới đổi để không hiện chữ gốc thoáng qua
      void loadMessages(l).then(() => {
        setLocaleState(l);
        writeCookie(LOCALE_COOKIE, l);
        router.refresh();
      });
    } else if (!l && locale !== initial.locale) push.locale = locale;
    if (user.currency) {
      setCurrencyChoice(user.currency);
      writeCookie(CURRENCY_COOKIE, user.currency);
    } else if (user.currency === null && currencyChoice) push.currency = currencyChoice;
    if (isValidTimeZone(user.timezone)) {
      setTzChoice(user.timezone);
      writeCookie(TIMEZONE_COOKIE, user.timezone);
    } else if (user.timezone === null && tzChoice) push.timezone = tzChoice;
    if (Object.keys(push).length) {
      api.patch<User>("/auth/me", push).then(
        (u) => qc.setQueryData(ME_KEY, u),
        () => undefined,
      );
    }
    // chỉ chạy khi đổi tài khoản; các lựa chọn hiện tại đọc lúc đó là đủ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, user]);
  useEffect(() => {
    if (status === "guest") appliedFor.current = null;
  }, [status]);

  // ngôn ngữ cho code ngoài React (thông báo lỗi trong lib/api, toast của QueryCache) — gán ngay khi render; thuộc tính lang của <html> cập nhật sau
  setActiveLocale(locale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  /** Lưu lựa chọn lên tài khoản (khi đã đăng nhập); lỗi thì vẫn giữ lựa chọn ở trình duyệt */
  const saveToAccount = useCallback(
    async (patch: Partial<Pick<User, "locale" | "currency" | "timezone">>) => {
      if (status !== "authenticated") return;
      const u = await api.patch<User>("/auth/me", patch);
      qc.setQueryData(ME_KEY, u);
    },
    [status, qc],
  );

  const setLocale = useCallback(
    async (l: Locale) => {
      await loadMessages(l);
      setLocaleState(l);
      writeCookie(LOCALE_COOKIE, l);
      router.refresh();
      await saveToAccount({ locale: l });
    },
    [router, saveToAccount],
  );

  const setCurrency = useCallback(
    async (code: string) => {
      const value = code === currencies.base.code ? null : code;
      setCurrencyChoice(value);
      writeCookie(CURRENCY_COOKIE, value);
      await saveToAccount({ currency: value });
    },
    [currencies.base.code, saveToAccount],
  );

  const setTimezone = useCallback(
    async (tz: string | null) => {
      const value = tz && isValidTimeZone(tz) ? tz : null;
      setTzChoice(value);
      writeCookie(TIMEZONE_COOKIE, value);
      await saveToAccount({ timezone: value });
    },
    [saveToAccount],
  );

  const value = useMemo<I18nContextValue>(() => {
    const t = createT(locale);
    const prefs: Prefs = { locale, currency, timezone };
    return { ...prefs, t, fmt: createFormatters(prefs, currencies, t), languages, currencies, siteTimezone, setLocale, setCurrency, setTimezone };
  }, [locale, currency, timezone, currencies, languages, siteTimezone, setLocale, setCurrency, setTimezone]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Toàn bộ ngữ cảnh: t, fmt, lựa chọn hiện tại và hàm đổi */
export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n phải nằm trong I18nProvider");
  return ctx;
}

/** Rút gọn: chỉ lấy hàm dịch */
export function useT(): TFunction {
  return useI18n().t;
}

/** Rút gọn: chỉ lấy bộ định dạng tiền / số / thời gian */
export function useFmt(): Formatters {
  return useI18n().fmt;
}
