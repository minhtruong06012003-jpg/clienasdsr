'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DEVELOPER_ROLE, hasPermission } from '@cmsnt/shared';
import {
  api,
  ApiError,
  clearAdminSessionStorage,
  getAccessToken,
  getCachedAdminUser,
  getRefreshToken,
  refreshSession,
  setAccessToken,
  setCachedAdminUser,
  setUnauthorizedHandler,
} from './api';
import { stripBasePath } from './site';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  avatar?: { url: string; urls?: Record<string, string> } | null;
  role: { id: string; name: string; slug: string; permissions: string[] };
  twoFactorEnabled?: boolean;
  recoveryCodesLeft?: number;
  /** Cài đặt bắt buộc 2FA với admin nhưng tài khoản chưa bật -> chỉ được vào trang hồ sơ để thiết lập */
  setup2faRequired?: boolean;
  /** Tiến trình API đang chạy ở chế độ website con (TENANT_ROLE=child) */
  isChildSite?: boolean;
}

/** Kết quả đăng nhập bước 1: xong, hoặc cần mã 2FA (challenge sống 5 phút) */
export type LoginOutcome = { ok: true } | { ok: false; requires2fa: true; challenge: string };

export interface Verify2faInput {
  challenge: string;
  code?: string;
  recoveryCode?: string;
  /** tin cậy thiết bị 30 ngày (cookie httpOnly) */
  remember?: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  /** Phiên hợp lệ nhưng tài khoản không có quyền admin.access (vd. khách đã đăng nhập website) -> trang login báo lỗi */
  accessDenied: boolean;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  verify2fa: (input: Verify2faInput) => Promise<{ usedRecovery: boolean; recoveryLeft: number }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permission: string | string[]) => boolean;
  /** Tài khoản vai trò "Nhà phát triển": thấy thêm các mục cấu hình kỹ thuật (NavItem.devOnly, tab cài đặt devOnly) */
  isDeveloper: boolean;
  /** Đang mở trang quản trị của Website con (TENANT_ROLE=child) */
  isChildSite: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function setAdminFlag(on: boolean) {
  const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN ? `; domain=${process.env.NEXT_PUBLIC_COOKIE_DOMAIN}` : '';
  document.cookie = on ? `cmsnt_admin=1; path=/; max-age=${365 * 86400}; samesite=lax${domain}` : `cmsnt_admin=; path=/; max-age=0${domain}`;
}

const canAccessAdmin = (u: CurrentUser) => hasPermission(u.role.permissions, 'admin.access');

const SETUP_2FA_PATH = '/profile';

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  const acceptUser = useCallback((u: CurrentUser): boolean => {
    if (!canAccessAdmin(u)) {
      clearAdminSessionStorage();
      setUser(null);
      setAdminFlag(false);
      setAccessDenied(true);
      return false;
    }
    setAccessDenied(false);
    setUser(u);
    setCachedAdminUser(u);
    setAdminFlag(true);
    return true;
  }, []);

  const refreshUser = useCallback(async () => {
    const fresh = await api.get<CurrentUser>('/auth/me');
    acceptUser(fresh);
  }, [acceptUser]);

  useEffect(() => {
    let cancelled = false;

    setUnauthorizedHandler(() => {
      if (cancelled) return;
      clearAdminSessionStorage();
      setAdminFlag(false);
      setUser(null);
      router.replace(`/login?next=${encodeURIComponent(stripBasePath(window.location.pathname))}`);
    });

    // Đồng bộ giữa các tab admin: tab khác bấm Đăng xuất thì thoát cùng, tab khác đăng nhập/làm mới thì nhận ngay
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'cmsnt_admin_user') {
        const nextUser = getCachedAdminUser<CurrentUser>();
        if (!nextUser && !getAccessToken() && !getRefreshToken()) {
          setAdminFlag(false);
          setUser(null);
        } else if (nextUser && canAccessAdmin(nextUser)) {
          setUser(nextUser);
        }
      }
    };
    window.addEventListener('storage', onStorage);

    const bootstrap = async () => {
      const cached = getCachedAdminUser<CurrentUser>();
      const hasSavedToken = !!getAccessToken() || !!getRefreshToken();
      if (cached && hasSavedToken && canAccessAdmin(cached)) {
        acceptUser(cached);
        setLoading(false);
        // Làm mới ngầm ở nền: nếu API đang restart (unavailable) thì giữ nguyên phiên; chỉ thoát khi 401 thật sự (invalid)
        const status = await refreshSession();
        if (cancelled) return;
        if (status === 'invalid') {
          clearAdminSessionStorage();
          setAdminFlag(false);
          setUser(null);
          return;
        }
        if (status === 'ok') {
          await refreshUser().catch((err) => {
            if (err instanceof ApiError && err.status === 401) {
              clearAdminSessionStorage();
              setAdminFlag(false);
              setUser(null);
            }
          });
        }
        return;
      }

      // Chưa có bản lưu localStorage (vd phiên cookie sẵn có trước bản cập nhật): thử khôi phục và tự retry nếu API đang restart
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        const status = await refreshSession();
        if (cancelled) return;
        if (status === 'ok') {
          try {
            await refreshUser();
          } catch {
            /* nếu /auth/me nghẽn mạng tạm thời thì thử lấy user vừa lưu từ /auth/refresh */
            const fromRefresh = getCachedAdminUser<CurrentUser>();
            if (fromRefresh) acceptUser(fromRefresh);
          }
          break;
        }
        if (status === 'invalid') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!cancelled) setLoading(false);
    };

    void bootstrap();

    // Gia hạn ngầm mỗi 30 phút (token sống 30 ngày / 365 ngày nên hoàn toàn không lo rớt phiên)
    const t = setInterval(() => void refreshSession(), 30 * 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      clearInterval(t);
    };
  }, [acceptUser, refreshUser, router]);

  useEffect(() => {
    if (!user?.setup2faRequired || pathname.startsWith(SETUP_2FA_PATH) || pathname.startsWith('/login')) return;
    router.replace(`${SETUP_2FA_PATH}?tab=security&required=1`);
  }, [user?.setup2faRequired, pathname, router]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginOutcome> => {
      const res = await api.post<{ accessToken: string; refreshToken?: string; user: CurrentUser } | { requires2fa: true; challenge: string }>('/auth/admin/login', { email, password });
      if ('requires2fa' in res) return { ok: false, requires2fa: true, challenge: res.challenge };
      setAccessToken(res.accessToken, res.refreshToken ?? null);
      if (!acceptUser(res.user)) throw new Error('Tài khoản không có quyền truy cập trang quản trị');
      return { ok: true };
    },
    [acceptUser],
  );

  const verify2fa = useCallback(
    async (input: Verify2faInput) => {
      const res = await api.post<{ accessToken: string; refreshToken?: string; user: CurrentUser; usedRecovery: boolean; recoveryLeft: number }>('/auth/2fa/verify', { ...input, target: 'admin' });
      setAccessToken(res.accessToken, res.refreshToken ?? null);
      if (!acceptUser(res.user)) throw new Error('Tài khoản không có quyền truy cập trang quản trị');
      return { usedRecovery: res.usedRecovery, recoveryLeft: res.recoveryLeft };
    },
    [acceptUser],
  );

  const logout = useCallback(async () => {
    const rt = getRefreshToken();
    await api.post('/auth/logout', rt ? { refreshToken: rt } : {}).catch(() => undefined);
    clearAdminSessionStorage();
    setAdminFlag(false);
    setUser(null);
    router.replace('/login');
  }, [router]);

  const can = useCallback((p: string | string[]) => hasPermission(user?.role.permissions, p), [user]);

  const isDeveloper = user?.role.slug === DEVELOPER_ROLE;
  const isChildSite = user?.isChildSite ?? user?.role.slug === 'collaborator';

  const value = useMemo(
    () => ({ user, loading, accessDenied, login, verify2fa, logout, refreshUser, can, isDeveloper, isChildSite }),
    [user, loading, accessDenied, login, verify2fa, logout, refreshUser, can, isDeveloper, isChildSite],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải nằm trong AuthProvider');
  return ctx;
}
