"use client";

/**
 * Trạng thái đăng nhập của khách.
 * - Token lưu ở localStorage (lib/api.ts); provider đọc `/auth/me` khi có token.
 * - Đồng bộ giữa các tab qua sự kiện `storage` (đăng xuất ở tab này -> tab khác cũng thoát).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, clearTokens, getAccessToken, getRefreshToken, onTokensChange, setSessionExpiredHandler, setTokens } from "./api";
import type { AuthResult, User } from "./types";

type AuthStatus = "loading" | "authenticated" | "guest";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Lưu token + user sau đăng nhập / đăng ký / xác minh email */
  signIn: (result: AuthResult) => void;
  /** Đăng xuất: thu hồi refresh token phía API rồi xoá token cục bộ */
  signOut: () => Promise<void>;
  /** Tải lại thông tin tài khoản (sau khi sửa hồ sơ, bật 2FA...) */
  reloadUser: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const ME_KEY = ["auth", "me"] as const;
const CACHED_USER_KEY = "smm_cached_user";
let memCachedUser: User | undefined;

function readCachedUser(): User | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CACHED_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as User;
      memCachedUser = parsed;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  if (memCachedUser) return memCachedUser;
  try {
    const sraw = window.sessionStorage.getItem(CACHED_USER_KEY);
    if (sraw) {
      const parsed = JSON.parse(sraw) as User;
      memCachedUser = parsed;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function writeCachedUser(user: User | null) {
  memCachedUser = user ?? undefined;
  if (typeof window === "undefined") return;
  try {
    if (!user) window.localStorage.removeItem(CACHED_USER_KEY);
    else window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
  try {
    if (!user) window.sessionStorage.removeItem(CACHED_USER_KEY);
    else window.sessionStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // hasToken = null khi chưa đọc được storage (lần render đầu / SSR) -> trạng thái "loading"
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  // giữ user trực tiếp trong state ngay lúc signIn() để router.replace('/dashboard') trên Safari không bao giờ bị hụt nhịp về /login (T-252)
  const [sessionUser, setSessionUser] = useState<User | null>(null);

  useEffect(() => {
    const sync = () => {
      const present = !!getAccessToken() || !!getRefreshToken();
      setHasToken(present);
      if (!present) setSessionUser(null);
      else setSessionUser((prev) => prev ?? readCachedUser() ?? null);
    };
    sync();
    const off = onTokensChange(sync);
    // tab khác đăng nhập / đăng xuất
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("smm_")) sync();
    };
    // iOS Safari vuốt Back/Forward phục hồi trang từ BFCache mà không mount lại -> đồng bộ lại token ngay (T-252)
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  // phiên hết hạn hẳn (refresh thất bại): xoá cache dữ liệu riêng của khách
  useEffect(() => {
    setSessionExpiredHandler(() => {
      writeCachedUser(null);
      setSessionUser(null);
      setHasToken(false);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "public" });
    });
    return () => setSessionExpiredHandler(null);
  }, [qc]);

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      const u = await api.get<User>("/auth/me");
      writeCachedUser(u);
      setSessionUser(u);
      return u;
    },
    enabled: hasToken === true,
    placeholderData: () => (hasToken ? readCachedUser() : undefined),
    staleTime: 60_000,
    // API đang khởi động lại (lỗi mạng / 5xx) -> thử lại nhiều lần thay vì hiển thị như chưa đăng nhập;
    // 401 là phiên hỏng thật (đã refresh thất bại) -> không thử lại
    retry: (count, err) => count < 12 && !(err instanceof ApiError && err.status === 401),
    retryDelay: (attempt) => Math.min(1500 * (attempt + 1), 5000),
  });

  // token hỏng hẳn (/auth/me 401 sau khi refresh thất bại) -> coi như khách
  useEffect(() => {
    if (me.isError && !getAccessToken() && !getRefreshToken()) {
      writeCachedUser(null);
      setSessionUser(null);
      setHasToken(false);
    }
  }, [me.isError]);

  const signIn = useCallback(
    (result: AuthResult) => {
      writeCachedUser(result.user);
      setSessionUser(result.user);
      setHasToken(true);
      qc.setQueryData(ME_KEY, result.user);
      setTokens(result.accessToken, result.refreshToken);
    },
    [qc],
  );

  const signOut = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) await api.post("/auth/logout", { refreshToken }).catch(() => undefined);
    writeCachedUser(null);
    setSessionUser(null);
    setHasToken(false);
    clearTokens();
    // xoá mọi dữ liệu riêng (đơn, ví...) khỏi cache, giữ dữ liệu công khai
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "public" });
  }, [qc]);

  const value = useMemo<AuthContextValue>(() => {
    const resolvedUser = hasToken === true ? (me.data ?? sessionUser ?? readCachedUser() ?? null) : null;
    let status: AuthStatus = "loading";
    if (hasToken === false) status = "guest";
    else if (hasToken === true) {
      if (resolvedUser) status = "authenticated";
      else if (me.isError) status = getAccessToken() || getRefreshToken() ? "authenticated" : "guest";
    }
    return { status, user: resolvedUser, signIn, signOut, reloadUser: () => me.refetch() };
  }, [hasToken, me, sessionUser, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth phải nằm trong AuthProvider");
  return ctx;
}
