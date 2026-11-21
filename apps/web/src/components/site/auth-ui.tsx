"use client";

/**
 * Các khối giao diện dùng chung cho form đăng nhập / đăng ký theo ảnh mẫu:
 * ô nhập có icon, nút mắt ẩn/hiện mật khẩu, ô tick xanh, nút gradient, đường kẻ "Hoặc ... với",
 * và nút đăng nhập nhanh bằng Google.
 */
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Copy, Check, ExternalLink, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Spinner } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useBootstrap } from "@/lib/queries";
import { readReferral } from "@/lib/referral";
import type { LoginResponse } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { tNow } from "@/lib/i18n/translate";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Nút mắt ở cuối ô mật khẩu */
function EyeButton({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" tabIndex={-1} onClick={onToggle} aria-label={show ? t("Ẩn mật khẩu") : t("Hiện mật khẩu")} className="inline-flex size-9 shrink-0 items-center justify-center text-[#6b6b70] hover:text-[#0a0a0a]">
      {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
    </button>
  );
}

/**
 * Ô nhập kiểu trang đăng nhập: nhãn phía trên, khung có icon trái
 * (`password` = có nút mắt, tự đổi type password/text).
 * Mobile dùng `text-base` (16px) để iOS Safari không tự zoom lệch khung, đồng thời tắt tự viết hoa / tự sửa từ trên mật khẩu & email (T-252).
 */
export function AuthField({ id, label, icon, password, ...props }: InputProps & { id: string; label: string; icon: ReactNode; password?: boolean }) {
  const [show, setShow] = useState(false);
  const rawInput = Boolean(password || props.type === "email");
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13.5px] font-medium text-[#0a0a0a]">
        {label}
      </label>
      <div className="flex h-[46px] items-center rounded-[10px] border border-[#e4e4e7] bg-white pl-3.5 transition focus-within:border-[#111111] focus-within:ring-3 focus-within:ring-[#111111]/12">
        <span className="mr-2.5 text-[#6b6b70] [&_svg]:size-[18px]">{icon}</span>
        <input
          id={id}
          name={props.name ?? id}
          autoCapitalize={props.autoCapitalize ?? (rawInput ? "none" : undefined)}
          autoCorrect={props.autoCorrect ?? (rawInput ? "off" : undefined)}
          spellCheck={props.spellCheck ?? (rawInput ? false : undefined)}
          {...props}
          type={password ? (show ? "text" : "password") : props.type}
          className="h-full min-w-0 flex-1 bg-transparent pr-3 text-base text-[#0a0a0a] outline-none placeholder:text-[#a1a1aa] sm:text-sm"
        />
        {password && <EyeButton show={show} onToggle={() => setShow((v) => !v)} />}
      </div>
    </div>
  );
}

/** Ô nhập kiểu trang đăng ký: icon trái, nhãn nhỏ và ô nhập nằm chung trong khung */
export function AuthInlineField({
  id,
  label,
  icon,
  password,
  showPassword,
  onTogglePassword,
  ...props
}: InputProps & { id: string; label: string; icon: ReactNode; password?: boolean; showPassword?: boolean; onTogglePassword?: () => void }) {
  const [localShow, setLocalShow] = useState(false);
  const show = showPassword !== undefined ? showPassword : localShow;
  const toggle = onTogglePassword ?? (() => setLocalShow((v) => !v));
  const rawInput = Boolean(password || props.type === "email");
  return (
    <label htmlFor={id} className="flex h-[56px] cursor-text items-center rounded-[10px] border border-[#e4e4e7] bg-white pl-3.5 transition focus-within:border-[#111111] focus-within:ring-3 focus-within:ring-[#111111]/12 sm:h-[52px]">
      <span className="mr-3 text-[#52525b] [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="text-[12.5px] leading-tight font-medium text-[#0a0a0a]">{label}</span>
        <input
          id={id}
          name={props.name ?? id}
          autoCapitalize={props.autoCapitalize ?? (rawInput ? "none" : undefined)}
          autoCorrect={props.autoCorrect ?? (rawInput ? "off" : undefined)}
          spellCheck={props.spellCheck ?? (rawInput ? false : undefined)}
          {...props}
          type={password ? (show ? "text" : "password") : props.type}
          className="mt-0.5 w-full bg-transparent pr-3 text-base leading-tight text-[#0a0a0a] outline-none placeholder:text-[#a1a1aa] sm:text-[13px]"
        />
      </span>
      {password && <EyeButton show={show} onToggle={toggle} />}
    </label>
  );
}

/** Ô tick vuông nền xanh */
export function AuthCheckbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#46464b]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 cursor-pointer rounded accent-[#111111]" />
      <span>{children}</span>
    </label>
  );
}

/** Nút gửi form gradient xanh */
export function AuthSubmit({ loading, disabled, children }: { loading?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-[#111111] hover:bg-[#27272a] text-[15px] font-semibold text-white shadow-[0_10px_22px_-10px_rgb(0_0_0/0.35)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70 [&_svg]:size-[18px]"
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** Thông báo lỗi dưới form */
export function AuthError({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-[#fdecec] px-3 py-2 text-sm text-[#d93036]">{children}</p>;
}

/** Đường kẻ ngang có chữ ở giữa ("Hoặc đăng nhập với") */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-[#a1a1aa]">
      <span className="h-px flex-1 bg-[#ececee]" />
      {children}
      <span className="h-px flex-1 bg-[#ececee]" />
    </div>
  );
}

/* ---------- Đăng nhập nhanh bằng Google ---------- */

type GoogleId = {
  initialize: (o: {
    client_id: string;
    callback: (r: { credential?: string }) => void;
    ux_mode?: string;
    use_fedcm_for_prompt?: boolean;
  }) => void;
  renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
  prompt?: () => void;
};
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

/** Nạp script Google Identity Services 1 lần (lỗi mạng thì cho phép thử nạp lại) */
let gsiPromise: Promise<void> | null = null;
function loadGsi() {
  if (typeof window !== "undefined" && window.google?.accounts?.id) return Promise.resolve();
  gsiPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing && window.google?.accounts?.id) {
      resolve();
      return;
    }
    if (existing) existing.remove();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsiPromise = null;
      reject(new Error(tNow("Không tải được khung đăng nhập Google")));
    };
    document.head.appendChild(s);
  });
  return gsiPromise;
}

/** Nhận diện trình duyệt nhúng trong ứng dụng (Zalo, Facebook, Messenger, TikTok, Instagram...) nơi Google chặn OAuth (403 disallowed_useragent) */
function detectInAppBrowser(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent || "";
  if (/Zalo/i.test(ua)) return "Zalo";
  if (/FBAN|FBAV|FBIOS|FB_IAB|Messenger/i.test(ua)) return "Facebook / Messenger";
  if (/BytedanceWebview|TikTok|musical_ly/i.test(ua)) return "TikTok";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/Barcelona|Threads/i.test(ua)) return "Threads";
  if (/\bLine\//i.test(ua)) return "LINE";
  return null;
}

const socialBtn =
  "inline-flex h-[44px] w-full flex-1 items-center justify-center gap-2 overflow-hidden rounded-[10px] border border-[#dadce0] bg-white px-4 text-[14px] font-medium text-[#1f1f1f] transition hover:border-[#c4c7c5] hover:bg-[#f8fafd]";

/**
 * Nút đăng nhập Google chuẩn hiển thị trực tiếp (opacity 100%, không còn lớp phủ mờ 0.01 bị Safari / WebKit chặn cảm ứng — T-252):
 * - Hiển thị nút chính chủ của Google căn giữa tự co giãn theo khung, chạm 1 phát ăn ngay trên iPhone / iPad / Mac Safari.
 * - Phát hiện trình duyệt nhúng (Zalo / Facebook / TikTok) trên iPhone và hướng dẫn mở bằng Safari kèm nút sao chép link 1 chạm.
 */
export function SocialLogin({ onResult, rememberMe = true }: { onResult: (res: LoginResponse) => void; /** ô "Ghi nhớ đăng nhập" của form */ rememberMe?: boolean }) {
  const boot = useBootstrap();
  const { t, locale } = useI18n();
  const google = boot.data?.auth?.google;
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnHostRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [gsiReady, setGsiReady] = useState(false);
  const [gsiFailed, setGsiFailed] = useState(false);
  const [inAppName, setInAppName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // giữ callback mới nhất để script Google luôn gọi đúng hàm hiện tại
  const resultRef = useRef(onResult);
  const rememberRef = useRef(rememberMe);
  useEffect(() => {
    resultRef.current = onResult;
    rememberRef.current = rememberMe;
  }, [onResult, rememberMe]);

  useEffect(() => {
    setInAppName(detectInAppBrowser());
  }, []);

  const mountGoogleButton = useCallback(() => {
    if (!google?.enabled || !google.clientId || !btnHostRef.current) return;
    const host = btnHostRef.current;
    const containerW = wrapRef.current?.clientWidth || host.clientWidth || 320;
    const targetW = Math.max(200, Math.min(400, Math.floor(containerW)));
    setGsiFailed(false);
    loadGsi()
      .then(() => {
        const gid = window.google?.accounts?.id;
        if (!gid || !btnHostRef.current) return;
        gid.initialize({
          client_id: google.clientId,
          ux_mode: "popup",
          use_fedcm_for_prompt: false,
          callback: async ({ credential }) => {
            if (!credential) return;
            setBusy(true);
            try {
              const referralCode = readReferral();
              resultRef.current(
                await api.post<LoginResponse>(
                  "/auth/google",
                  { idToken: credential, rememberMe: rememberRef.current, ...(referralCode ? { referralCode } : {}) },
                  { auth: false },
                ),
              );
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          },
        });
        btnHostRef.current.innerHTML = "";
        gid.renderButton(btnHostRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "center",
          width: targetW,
          locale,
        });
        setGsiReady(true);
      })
      .catch(() => {
        setGsiReady(false);
        setGsiFailed(true);
      });
  }, [google?.enabled, google?.clientId, locale]);

  useEffect(() => {
    if (!google?.enabled || !google.clientId) return;
    mountGoogleButton();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    let lastW = wrap.clientWidth;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver((entries) => {
      const nextW = Math.floor(entries[0]?.contentRect.width ?? wrap.clientWidth);
      if (!nextW || Math.abs(nextW - lastW) < 16) return;
      lastW = nextW;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => mountGoogleButton(), 120);
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [google?.enabled, google?.clientId, mountGoogleButton]);

  const handleFallbackClick = () => {
    if (!google?.enabled) {
      toast.info(t("Website chưa bật đăng nhập bằng Google"));
      return;
    }
    if (inAppName) {
      toast.info(t("Hãy bấm ⋯ góc màn hình chọn 'Mở bằng trình duyệt / Safari' để đăng nhập bằng Google"));
      return;
    }
    if (gsiFailed) {
      mountGoogleButton();
      toast.error(t("Trình duyệt đang chặn khung Google (AdBlock / chặn theo dõi). Vui lòng tắt chặn trên trang này hoặc đăng nhập bằng Email & mật khẩu."));
      return;
    }
    mountGoogleButton();
  };

  const copyCleanUrl = async () => {
    try {
      const u = new URL(window.location.href);
      for (const k of ["fbclid", "zarsrc", "utm_source", "utm_medium", "utm_campaign"]) u.searchParams.delete(k);
      await navigator.clipboard.writeText(u.toString());
      setCopied(true);
      toast.success(t("Đã sao chép đường dẫn! Hãy mở trình duyệt Safari và dán vào thanh địa chỉ."));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.info(window.location.origin + window.location.pathname);
    }
  };

  return (
    <div ref={wrapRef} className="w-full space-y-2.5">
      {inAppName && google?.enabled && (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50/90 p-3 text-[12.5px] leading-relaxed text-amber-950">
          <div className="flex items-start gap-2">
            <ExternalLink className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {t("Bạn đang mở web trong {app} — Google chặn đăng nhập nhanh ở trình duyệt nhúng.", { app: inAppName })}
              </p>
              <p className="mt-0.5 text-amber-900/85">
                {t("Hãy bấm menu ⋯ ở góc màn hình chọn Mở bằng trình duyệt / Safari, hoặc đăng nhập bằng Email & mật khẩu ở trên.")}
              </p>
              <button
                type="button"
                onClick={copyCleanUrl}
                className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 text-[12px] font-semibold text-amber-950 shadow-2xs transition hover:bg-amber-100/60"
              >
                {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
                {copied ? t("Đã sao chép link") : t("Sao chép link để mở Safari")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative flex min-h-[44px] w-full items-center justify-center">
        {/* Khung nút Google chính chủ hiển thị rõ 100% để Safari iOS/macOS không chặn sự kiện chạm */}
        {google?.enabled && !inAppName && (
          <div
            ref={btnHostRef}
            className={gsiReady && !busy ? "flex min-h-[44px] w-full items-center justify-center" : "pointer-events-none absolute inset-0 overflow-hidden opacity-0"}
          />
        )}

        {/* Nút hiển thị khi đang tải script Google, đang xác thực token, hoặc trong trình duyệt nhúng / bị chặn script */}
        {(!google?.enabled || inAppName || !gsiReady || busy) && (
          <button type="button" disabled={busy} className={socialBtn} onClick={handleFallbackClick}>
            {busy ? <Spinner /> : <GoogleColorIcon className="size-[18px]" />}
            <span>{busy ? t("Đang đăng nhập với Google...") : t("Tiếp tục với Google")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Chữ G nhiều màu của Google */
function GoogleColorIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z" />
    </svg>
  );
}
