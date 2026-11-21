/**
 * HTTP client cho Admin. Gọi /api/* (Next rewrite tới NestJS).
 * - Lưu bền vững access token + refresh token dự phòng + thông tin admin trong localStorage kết hợp cookie httpOnly.
 * - Chỉ đăng xuất khi người dùng bấm Đăng xuất hoặc phiên thật sự bị thu hồi (HTTP 401 sau refresh);
 *   mọi lỗi tạm thời (502/503 khởi động lại API, mất mạng chớp nhoáng...) đều giữ nguyên phiên đăng nhập.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export type AdminRefreshResult = 'ok' | 'invalid' | 'unavailable';

const AT_KEY = 'cmsnt_admin_at';
const RT_KEY = 'cmsnt_admin_rt';
const USER_KEY = 'cmsnt_admin_user';

let memoryAccessToken: string | null = null;
let refreshing: Promise<AdminRefreshResult> | null = null;
let onUnauthorized: (() => void) | null = null;

function readLocal(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, val: string | null) {
  try {
    if (typeof window === 'undefined') return;
    if (val === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

export function getAccessToken(): string | null {
  return memoryAccessToken || readLocal(AT_KEY);
}

export function getRefreshToken(): string | null {
  return readLocal(RT_KEY);
}

export function setAccessToken(token: string | null, refreshToken?: string | null) {
  memoryAccessToken = token;
  writeLocal(AT_KEY, token);
  if (refreshToken !== undefined) {
    if (refreshToken) writeLocal(RT_KEY, refreshToken);
    else if (token === null) writeLocal(RT_KEY, null);
  }
}

export function clearAdminSessionStorage() {
  memoryAccessToken = null;
  writeLocal(AT_KEY, null);
  writeLocal(RT_KEY, null);
  writeLocal(USER_KEY, null);
}

export function getCachedAdminUser<T>(): T | null {
  const raw = readLocal(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setCachedAdminUser(user: unknown | null) {
  writeLocal(USER_KEY, user ? JSON.stringify(user) : null);
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function refreshSession(): Promise<AdminRefreshResult> {
  if (!refreshing) {
    const rt = getRefreshToken();
    refreshing = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-admin-client': '1',
      },
      body: JSON.stringify(rt ? { refreshToken: rt } : {}),
    })
      .then(async (res): Promise<AdminRefreshResult> => {
        if (res.status === 401) return 'invalid';
        if (!res.ok) return 'unavailable';
        const json = (await res.json()) as { accessToken?: string; refreshToken?: string; user?: unknown };
        if (!json?.accessToken) return 'unavailable';
        setAccessToken(json.accessToken, json.refreshToken || undefined);
        if (json.user) setCachedAdminUser(json.user);
        return 'ok';
      })
      .catch((): AdminRefreshResult => 'unavailable')
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(query?: Query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; retry?: boolean; raw?: boolean } = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const token = getAccessToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(opts.query)}`, {
      method,
      credentials: 'include',
      headers: {
        ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path.startsWith('/auth/') ? { 'x-admin-client': '1' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại.');
  }

  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed === 'ok') return request<T>(method, path, body, { ...opts, retry: false });
    if (refreshed === 'unavailable') {
      throw new ApiError(503, 'Máy chủ đang khởi động lại trong giây lát, vui lòng thử lại.');
    }
    clearAdminSessionStorage();
    onUnauthorized?.();
  }
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, res.ok ? 'Máy chủ phản hồi không hợp lệ' : `Máy chủ đang gặp sự cố (${res.status}). Vui lòng thử lại sau.`);
  }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message || res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
  /** GET trả Response thô (HTML, file...) có kèm token — tự xử lý body */
  raw: (path: string, query?: Query) => request<Response>('GET', path, undefined, { query, raw: true }),
  /** Tải file (CSV...) có kèm token */
  download: async (path: string, filename: string) => {
    const res = await request<Response>('GET', path, undefined, { raw: true });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data: { message?: string | string[] } | null = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message || res.statusText || 'Tải file thất bại';
      throw new ApiError(res.status, msg, data);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Có lỗi xảy ra';
}
