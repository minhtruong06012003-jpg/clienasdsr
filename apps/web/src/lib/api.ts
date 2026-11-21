/**
 * HTTP client cho website khách.
 * - Trình duyệt luôn gọi cùng origin `/api/*` (Next rewrite sang NestJS) nên không cần CORS.
 * - accessToken + refreshToken lưu ở localStorage (frontend khách KHÔNG dùng cookie `cmsnt_rt`, xem docs/api-public.md 7.1).
 * - Gặp 401 khi đang gửi token -> gọi `POST /api/auth/refresh { refreshToken }` (một lần cho mọi request song song),
 *   lưu cặp token mới (refresh token xoay vòng) rồi gọi lại request. Refresh thất bại -> xoá token, báo hết phiên.
 */

import { tNow } from "./i18n/translate";

/** Lỗi API đã chuẩn hoá: `message` luôn là chuỗi dễ đọc (lỗi phía client dịch theo ngôn ngữ đang chọn) */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

const ACCESS_KEY = "smm_access_token";
const REFRESH_KEY = "smm_refresh_token";
const FALLBACK_COOKIES: Record<string, string> = {
  [ACCESS_KEY]: "smm_at_fb",
  [REFRESH_KEY]: "smm_rt_fb",
};

/** Bộ nhớ RAM trong tab hiện tại: luôn hoạt động 100% kể cả khi Safari bật Chặn tất cả cookie / chặn cứng localStorage (T-252) */
const memStorage = new Map<string, string>();

function readFallbackCookie(key: string): string | null {
  const cname = FALLBACK_COOKIES[key];
  if (!cname || typeof document === "undefined") return null;
  try {
    const escaped = cname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function writeFallbackCookie(key: string, value: string | null) {
  const cname = FALLBACK_COOKIES[key];
  if (!cname || typeof document === "undefined") return;
  try {
    const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
    if (value === null) {
      document.cookie = `${cname}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    } else {
      document.cookie = `${cname}=${encodeURIComponent(value)}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
    }
  } catch {
    /* Safari bật Chặn tất cả cookie -> bỏ qua, đã có memStorage giữ phiên trong tab */
  }
}

/** Đọc token an toàn theo thứ tự: localStorage -> RAM -> sessionStorage -> cookie dự phòng (T-252) */
function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(key);
    if (v) {
      memStorage.set(key, v);
      return v;
    }
  } catch {
    /* localStorage bị chặn trên Safari riêng tư / khoá bảo mật */
  }
  const mem = memStorage.get(key);
  if (mem) return mem;
  try {
    const sv = window.sessionStorage.getItem(key);
    if (sv) {
      memStorage.set(key, sv);
      return sv;
    }
  } catch {
    /* bỏ qua */
  }
  const cv = readFallbackCookie(key);
  if (cv) {
    memStorage.set(key, cv);
    return cv;
  }
  return null;
}

function writeStorage(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  if (value === null) memStorage.delete(key);
  else memStorage.set(key, value);

  let localOk = false;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    localOk = true;
  } catch {
    /* Safari chặn localStorage -> dùng tiếp sessionStorage + cookie dự phòng bên dưới */
  }

  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* bỏ qua */
  }

  if (value === null || !localOk) {
    writeFallbackCookie(key, value);
  }
}

/** Danh sách hàm lắng nghe khi token đổi (AuthProvider dùng để cập nhật trạng thái đăng nhập) */
const listeners = new Set<() => void>();

export function onTokensChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn());
}

export function getAccessToken() {
  return readStorage(ACCESS_KEY);
}

export function getRefreshToken() {
  return readStorage(REFRESH_KEY);
}

/** Lưu cặp token sau đăng nhập / refresh */
export function setTokens(accessToken: string, refreshToken?: string | null) {
  writeStorage(ACCESS_KEY, accessToken);
  if (refreshToken) writeStorage(REFRESH_KEY, refreshToken);
  emit();
}

/** Xoá token (đăng xuất / hết phiên) */
export function clearTokens() {
  writeStorage(ACCESS_KEY, null);
  writeStorage(REFRESH_KEY, null);
  emit();
}

/** Hàm gọi khi phiên hết hạn hẳn (refresh thất bại) — AuthProvider đăng ký */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn;
}

/**
 * Kết quả làm mới phiên:
 * - "ok": đã có access token mới;
 * - "invalid": không có refresh token hoặc API trả 400/401/403 (hết hạn, bị thu hồi) -> phải đăng nhập lại;
 * - "unavailable": không gọi được API (đang khởi động lại, 502/503, mất mạng) -> phiên CHƯA chắc đã hết,
 *   giữ nguyên token để lần sau thử lại, không đăng xuất khách.
 */
export type RefreshResult = "ok" | "invalid" | "unavailable";

let refreshing: Promise<RefreshResult> | null = null;

/**
 * Làm mới access token bằng refresh token (single-flight: nhiều request 401 cùng lúc chỉ refresh một lần).
 * `usedAccess` = access token request vừa gửi: nếu tab khác đã refresh xong (token trong storage đã đổi) thì
 * dùng luôn token mới thay vì refresh thêm lần nữa (refresh token xoay vòng, gửi token cũ sẽ bị từ chối).
 */
export async function refreshSession(usedAccess?: string | null): Promise<RefreshResult> {
  const current = getAccessToken();
  if (usedAccess && current && current !== usedAccess) return "ok";
  if (!refreshing) {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return "invalid";
    refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res): Promise<RefreshResult> => {
        if (res.status === 401) return "invalid";
        if (!res.ok) return "unavailable";
        const json = (await res.json()) as { accessToken?: string; refreshToken?: string };
        if (!json.accessToken) return "unavailable";
        setTokens(json.accessToken, json.refreshToken || undefined);
        return "ok";
      })
      .catch((): RefreshResult => "unavailable")
      .finally(() => {
        // nhả khoá ở tick sau để các request đang chờ cùng nhận kết quả
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

/** Dựng query string, bỏ qua giá trị rỗng */
export function qs(query?: Query) {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Chuẩn hoá `message: string | string[]` của NestJS thành một chuỗi */
function pickMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const d = data as { message?: unknown; error?: unknown };
    if (Array.isArray(d.message)) return d.message.filter(Boolean).join(". ");
    if (typeof d.message === "string" && d.message) return d.message;
    if (typeof d.error === "string" && d.error) return d.error;
  }
  if (status === 404) return tNow("Không tìm thấy dữ liệu hoặc chức năng chưa sẵn sàng");
  if (status === 429) return tNow("Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút");
  if (status === 413) return tNow("File quá lớn, vượt dung lượng cho phép");
  if (status >= 500) return tNow("Máy chủ đang gặp sự cố ({status}). Vui lòng thử lại sau.", { status });
  return tNow("Yêu cầu thất bại ({status})", { status });
}

/** Đường dẫn auth không được tự refresh khi 401 (sai mật khẩu, refresh token hỏng...) */
const NO_REFRESH = ["/auth/login", "/auth/refresh", "/auth/register", "/auth/2fa/verify", "/auth/google", "/auth/logout"];

interface RequestOptions {
  query?: Query;
  /** false = không gửi Bearer (gọi public ẩn danh) */
  auth?: boolean;
  /** nội bộ: đã thử lại sau refresh */
  retried?: boolean;
  /** nội bộ: số lần đã thử lại khi gặp lỗi cổng 502/503/504 tạm thời */
  gatewayRetries?: number;
  /** nội bộ: mã định danh duy nhất cho mỗi lần bấm POST chống nhân đôi khi proxy_next_upstream hoặc refresh token (T-422) */
  requestId?: string;
  signal?: AbortSignal;
}

/** Chỉ tự động thử lại khi gặp 502/503/504 đối với các lời gọi đọc dữ liệu / báo giá / tạo link tải an toàn (idempotent) */
function isSafeGatewayRetry(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m === "POST" && (/\/quote(?:\?|$)/.test(path) || path === "/account/ai/tasks/download-links")) return true;
  return false;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const token = opts.auth === false ? null : getAccessToken();
  // FormData (tải file) gửi nguyên văn để trình duyệt tự đặt content-type multipart kèm boundary
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const gwTries = opts.gatewayRetries ?? 0;
  const reqId =
    opts.requestId ??
    (method.toUpperCase() === "POST"
      ? typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      : undefined);
  const nextOpts: RequestOptions = reqId ? { ...opts, requestId: reqId } : opts;
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(opts.query)}`, {
      method,
      headers: {
        ...(body === undefined || isForm ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(reqId ? { "x-request-id": reqId } : {}),
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    if (gwTries < 2 && isSafeGatewayRetry(method, path)) {
      await sleepAbortable(gwTries === 0 ? 700 : 1600, opts.signal);
      return request<T>(method, path, body, { ...nextOpts, gatewayRetries: gwTries + 1 });
    }
    throw new ApiError(0, tNow("Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại"));
  }

  // Gặp 502 / 503 / 504 thoáng qua (vd tiến trình đang cuộn bản cập nhật) -> tự thử lại mượt mà trước khi hiện lỗi
  if ((res.status === 502 || res.status === 503 || res.status === 504) && gwTries < 2 && isSafeGatewayRetry(method, path)) {
    await sleepAbortable(gwTries === 0 ? 700 : 1600, opts.signal);
    return request<T>(method, path, body, { ...nextOpts, gatewayRetries: gwTries + 1 });
  }

  // 401 khi đang gửi token -> refresh rồi thử lại đúng một lần
  if (res.status === 401 && token && !opts.retried && !NO_REFRESH.some((p) => path.startsWith(p))) {
    const result = await refreshSession(token);
    if (result === "ok") return request<T>(method, path, body, { ...nextOpts, retried: true });
    // API tạm thời không phản hồi (đang khởi động lại...) -> báo lỗi nhưng giữ phiên, chỉ đăng xuất khi token thật sự hỏng
    if (result === "unavailable") throw new ApiError(0, tNow("Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại"));
    clearTokens();
    onSessionExpired?.();
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // proxy trả HTML (502/503/404 của Next) -> báo lỗi dễ hiểu thay vì lỗi parse JSON
      if (!res.ok) throw new ApiError(res.status, pickMessage(null, res.status));
      throw new ApiError(res.status, tNow("Máy chủ phản hồi không hợp lệ"));
    }
  }
  if (!res.ok) throw new ApiError(res.status, pickMessage(data, res.status), data);
  return data as T;
}

/**
 * Tải file lên kèm tiến độ (0–1) — dùng XMLHttpRequest vì fetch chưa báo được tiến độ gửi (video lớn tới 1GB tải lâu).
 * Gặp 401 thì refresh token rồi gửi lại một lần như `request`.
 */
function upload<T>(path: string, form: FormData, onProgress?: (ratio: number) => void, retried = false): Promise<T> {
  const token = getAccessToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, tNow("Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại")));
    xhr.onload = async () => {
      if (xhr.status === 401 && token && !retried) {
        const result = await refreshSession(token);
        if (result === "ok") return upload<T>(path, form, onProgress, true).then(resolve, reject);
        if (result !== "unavailable") {
          clearTokens();
          onSessionExpired?.();
        }
      }
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // Nginx trả trang HTML (vd 413 file quá lớn)
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, pickMessage(data, xhr.status), data));
    };
    xhr.send(form);
  });
}

/** Bộ hàm gọi API dùng trong toàn bộ website */
export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, "query">) => request<T>("GET", path, undefined, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body ?? {}, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
  upload,
};

/** Lấy thông báo lỗi để hiện cho khách từ mọi kiểu lỗi */
export function errorMessage(err: unknown, fallback = tNow("Đã có lỗi xảy ra, vui lòng thử lại")): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** API trả 404 = chức năng chưa có / đã tắt (dùng để hiện trạng thái rỗng thay vì lỗi đỏ) */
export function isNotFound(err: unknown) {
  return err instanceof ApiError && err.status === 404;
}

/** Lấy tên file từ header content-disposition (`attachment; filename="..."`) */
function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!m) return fallback;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Tải file cần đăng nhập (vd CSV đơn hàng): gọi GET kèm Bearer, 401 thì refresh token rồi thử lại một lần,
 * nhận blob rồi kích hoạt tải xuống bằng thẻ <a download>. Lỗi ném ApiError (message tiếng Việt) như `api.get`.
 */
export async function downloadFile(path: string, query?: Query, fallbackName = "download", retried = false): Promise<void> {
  const token = getAccessToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(query)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, tNow("Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại"));
  }
  if (res.status === 401 && token && !retried) {
    const result = await refreshSession(token);
    if (result === "ok") return downloadFile(path, query, fallbackName, true);
    if (result === "unavailable") throw new ApiError(0, tNow("Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại"));
    clearTokens();
    onSessionExpired?.();
  }
  if (!res.ok) {
    // lỗi API trả JSON { message } -> dùng chung cách chuẩn hoá thông báo
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, pickMessage(data, res.status), data);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFrom(res.headers.get("content-disposition"), fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // thu hồi URL sau khi trình duyệt đã bắt đầu tải
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
