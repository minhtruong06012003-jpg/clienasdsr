"use client";

/**
 * Hook React Query cho dữ liệu dùng nhiều nơi.
 * Quy ước key: dữ liệu công khai bắt đầu bằng "public" (giữ lại khi đăng xuất), dữ liệu riêng của khách thì không.
 */
import { useContext, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
import { SITE_NAME } from "./site";
import { I18nContext } from "./i18n/provider";
import { buildCategories, DEFAULT_CATEGORIES, findCategory, type AiCategoryRaw } from "./ai";
import type { AiTool, Bootstrap, CreditPlanList, CreditSummary, MediaRef, WalletSummary } from "./types";

/** Ngôn ngữ đang chọn nếu nằm trong I18nProvider (không ném lỗi: provider tự gọi useBootstrap với locale riêng) */
function useLocaleOr(fallback: string) {
  return useContext(I18nContext)?.locale ?? fallback;
}

/** Cấu hình chung của website (tên, captcha, cài đặt SMM...) theo ngôn ngữ đang chọn */
export function useBootstrap(localeArg?: string) {
  const ctxLocale = useLocaleOr("vi");
  const locale = localeArg ?? ctxLocale;
  return useQuery({
    queryKey: ["public", "bootstrap", locale],
    queryFn: () => api.get<Bootstrap>("/public/bootstrap", { locale }, { auth: false }),
    // đổi ngôn ngữ: giữ dữ liệu cũ trong lúc tải bản mới để giao diện không nháy trống
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: 1,
    meta: { silentError: true },
  });
}

/** Tên website: ưu tiên cài đặt trong admin, tiếp theo theo domain thực tế của trang để web con không bao giờ dính tên web nguồn (T-372) */
export function useSiteName() {
  const locale = useLocaleOr("vi");
  const { data } = useBootstrap();
  const raw = data?.settings?.general?.siteName;
  const name = typeof raw === "string" ? raw : raw?.[locale] || raw?.vi || (raw ? Object.values(raw)[0] : "");
  if (name) return name;
  if (typeof window !== "undefined" && window.location.hostname) {
    const host = window.location.hostname.replace(/^www\./i, "").trim();
    if (host && !/^nov\.ai\.vn$/i.test(host) && host !== "localhost" && host !== "127.0.0.1") return host;
  }
  return SITE_NAME;
}

/** Logo đã upload ở Cài đặt › Chung (`logoDark` = bản cho giao diện tối, có thể trống); null nếu chưa upload */
export function useSiteLogo(): { light: MediaRef | null; dark: MediaRef | null } {
  const { data } = useBootstrap();
  const g = data?.settings?.general;
  return { light: g?.logo?.url ? g.logo : null, dark: g?.logoDark?.url ? g.logoDark : null };
}

/** Ví của khách (API có sẵn) — nguồn số dư dự phòng khi API SMM chưa có */
export function useWallet(enabled = true) {
  return useQuery({
    queryKey: ["wallet", "summary"],
    queryFn: () => api.get<WalletSummary>("/account/wallet"),
    enabled,
    retry: false,
    meta: { silentError: true },
  });
}

/** Số dư ví hiện tại: ưu tiên API ví, dự phòng walletBalance trong /auth/me */
export function useBalance() {
  const { status, user } = useAuth();
  const authed = status === "authenticated";
  const wallet = useWallet(authed);
  const balance = wallet.data?.balance ?? (user?.walletBalance !== undefined ? Number(user.walletBalance) : undefined);
  return { balance, isLoading: wallet.isLoading && balance === undefined, refetch: wallet.refetch };
}

/** Số dư ví (VND, trường `credits`), gói cũ đang dùng, giảm giá của khách — làm mới khi chạy công cụ / nạp tiền (invalidate ["credits"]) */
export function useCredits(enabled = true) {
  return useQuery({
    queryKey: ["credits", "summary"],
    queryFn: () => api.get<CreditSummary>("/account/credits"),
    enabled,
    staleTime: 15_000,
    retry: false,
    meta: { silentError: true },
  });
}

/** Gói nạp tiền + cấu hình nạp tự do; đã đăng nhập thì kèm giá sau giảm giá riêng */
export function usePlans() {
  const { status } = useAuth();
  const authed = status === "authenticated";
  return useQuery({
    queryKey: authed ? ["plans", "member"] : ["public", "plans"],
    queryFn: () => api.get<CreditPlanList>("/public/plans", undefined, { auth: authed }),
    enabled: status !== "loading",
    staleTime: 60_000,
    meta: { silentError: true },
  });
}

/**
 * Nhóm công cụ AI theo thứ tự admin xếp (GET /public/ai/categories). Trả về `list` (nhóm hiển thị) và `of(key)`
 * (tìm nhóm của một công cụ). Chưa tải xong -> dùng nhóm mặc định để menu không bị trống.
 */
export function useCategories(initial?: AiCategoryRaw[]) {
  const q = useQuery({
    queryKey: ["public", "ai", "categories"],
    queryFn: () => api.get<AiCategoryRaw[]>("/public/ai/categories", undefined, { auth: false }),
    initialData: initial,
    staleTime: 5 * 60_000,
    meta: { silentError: true },
  });
  return useMemo(() => {
    const list = buildCategories(q.data ?? DEFAULT_CATEGORIES);
    return { list, of: (key: string) => findCategory(list, key) };
  }, [q.data]);
}

/** Danh mục công cụ AI đang bật (menu, dashboard, trang chủ) */
export function useAiTools(initial?: AiTool[]) {
  return useQuery({
    queryKey: ["public", "ai", "tools"],
    queryFn: () => api.get<AiTool[]>("/public/ai/tools", undefined, { auth: false }),
    initialData: initial,
    staleTime: 5 * 60_000,
    meta: { silentError: true },
  });
}
