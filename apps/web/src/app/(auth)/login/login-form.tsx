"use client";

/**
 * Form đăng nhập 2 bước:
 * 1. email + mật khẩu → `POST /api/auth/login` (trường `email`)
 * 2. nếu `requires2fa` → nhập mã TOTP (hoặc mã dự phòng) → `POST /api/auth/2fa/verify { challenge, code | recoveryCode }`
 * Có thêm đăng nhập Google (SocialLogin) — cùng luồng xử lý 2FA.
 * Có captcha ở bước 1 khi `bootstrap.captcha.on` chứa "login" (Cài đặt › Bảo mật).
 * Thành công: lưu token rồi chuyển về `?next=` (chỉ đường dẫn nội bộ) hoặc /dashboard.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, KeyRound, Lock, Mail, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useCaptcha } from "@cmsnt/blocks/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthTitle } from "@/components/site/auth-shell";
import { AuthCheckbox, AuthDivider, AuthError, AuthField, AuthSubmit, SocialLogin } from "@/components/site/auth-ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { safeNext } from "@/lib/nav";
import { useBootstrap } from "@/lib/queries";
import type { AuthResult, LoginResponse } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";

/** Khoá localStorage lưu email khi tick "Ghi nhớ đăng nhập" */
const REMEMBER_KEY = "auth.rememberEmail";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { status, signIn } = useAuth();
  const { t } = useI18n();
  const boot = useBootstrap();
  // captcha đăng nhập: chỉ hiện khi admin bật phạm vi "login"
  const captcha = useCaptcha(boot.data?.captcha ?? null, "login", { required: t("Vui lòng xác minh bạn không phải robot"), loadError: t("Không tải được captcha") });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Ghi nhớ đăng nhập": phiên dài ngày + lưu email để lần sau điền sẵn; bỏ tick -> phiên ngắn (API gửi `rememberMe: false`,
  // hết hạn sau ~24 giờ không hoạt động) và không lưu email
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) setEmail(saved);
    } catch {
      /* trình duyệt chặn storage -> bỏ qua */
    }
  }, []);

  // đã đăng nhập sẵn -> vào thẳng trang đích
  useEffect(() => {
    if (status === "authenticated") router.replace(next);
  }, [status, next, router]);

  /** Lưu phiên và chuyển trang */
  const finish = (res: AuthResult) => {
    try {
      if (remember && email.trim()) localStorage.setItem(REMEMBER_KEY, email.trim());
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* bỏ qua */
    }
    signIn(res);
    toast.success(res.user?.name ? t("Chào mừng {name} quay lại!", { name: res.user.name }) : t("Chào mừng bạn quay lại!"));
    router.replace(next);
  };

  /** Kết quả đăng nhập (mật khẩu hoặc Google): cần 2FA thì sang bước 2, không thì vào luôn */
  const handleResult = (res: LoginResponse) => {
    if ("requires2fa" in res && res.requires2fa) {
      setChallenge(res.challenge);
      setCode("");
      setError(null);
    } else finish(res as AuthResult);
  };

  const submitPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    // Dự phòng iCloud Keychain / trình lưu mật khẩu Safari tự điền vào DOM mà chưa kịp bắn onChange (T-252)
    const domEmail = (formEl.elements.namedItem("email") as HTMLInputElement | null)?.value ?? "";
    const domPassword = (formEl.elements.namedItem("password") as HTMLInputElement | null)?.value ?? "";
    const cleanEmail = (email || domEmail).replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    const actualPassword = password || domPassword;
    if (cleanEmail !== email) setEmail(cleanEmail);
    if (!password && actualPassword) setPassword(actualPassword);

    setLoading(true);
    try {
      let token: string | undefined;
      try {
        token = await captcha.getToken();
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
      const body = { email: cleanEmail, password: actualPassword, rememberMe: remember, ...(token ? { _captcha: token } : {}) };
      handleResult(await api.post<LoginResponse>("/auth/login", body, { auth: false }));
    } catch (err) {
      setError(errorMessage(err));
      // token captcha chỉ dùng được 1 lần -> làm mới để thử lại
      captcha.reset();
    } finally {
      setLoading(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setLoading(true);
    try {
      // gửi lại lựa chọn "Ghi nhớ đăng nhập" của bước 1 (challenge không mang theo)
      const base = { challenge, target: "site", rememberMe: remember };
      const body = useRecovery ? { ...base, recoveryCode: code.trim() } : { ...base, code: code.replace(/\s/g, "") };
      const res = await api.post<AuthResult>("/auth/2fa/verify", body, { auth: false });
      finish(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // bước 2: xác thực hai lớp
  if (challenge) {
    return (
      <div>
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </span>
        <AuthTitle title={t("Xác thực hai lớp")} description={useRecovery ? t("Nhập một mã dự phòng bạn đã lưu khi bật 2FA.") : t("Mở ứng dụng xác thực (Google Authenticator, Authy…) và nhập mã 6 số.")} />
        <form onSubmit={submitCode} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">{useRecovery ? t("Mã dự phòng") : t("Mã xác thực")}</Label>
            <Input
              id="code"
              autoFocus
              autoComplete="one-time-code"
              inputMode={useRecovery ? "text" : "numeric"}
              placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-12 rounded-[10px] bg-white text-center font-mono text-lg tracking-[0.3em]"
              required
            />
          </div>
          {error && <AuthError>{error}</AuthError>}
          <AuthSubmit loading={loading} disabled={!code.trim()}>
            {!loading && <KeyRound />} {t("Xác nhận")}
          </AuthSubmit>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => (setChallenge(null), setError(null))}>
              <ArrowLeft className="size-4" /> {t("Quay lại")}
            </button>
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => (setUseRecovery((v) => !v), setCode(""), setError(null))}>
              {useRecovery ? t("Dùng mã từ ứng dụng") : t("Dùng mã dự phòng")}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div>
      <AuthTitle title={t("Chào mừng trở lại!")} description={t("Đăng nhập để tiếp tục sử dụng dịch vụ")} />
      <form onSubmit={submitPassword} className="space-y-4">
        <AuthField id="email" label={t("Email")} icon={<Mail />} type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={t("Nhập email của bạn")} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <AuthField id="password" label={t("Mật khẩu")} icon={<Lock />} password autoComplete="current-password" placeholder={t("Nhập mật khẩu của bạn")} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="flex items-center justify-between">
          <AuthCheckbox checked={remember} onChange={setRemember}>
            {t("Ghi nhớ đăng nhập")}
          </AuthCheckbox>
          <Link href="/forgot-password" className="text-[13px] font-medium text-[#111111] hover:underline">
            {t("Quên mật khẩu?")}
          </Link>
        </div>
        {captcha.widget}
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit loading={loading}>
          {t("Đăng nhập")} {!loading && <ArrowRight />}
        </AuthSubmit>
      </form>
      <AuthDivider>{t("Hoặc đăng nhập với")}</AuthDivider>
      <SocialLogin onResult={handleResult} rememberMe={remember} />
      <p className="mt-7 text-center text-[13px] text-[#6b6b70]">
        {t("Chưa có tài khoản?")}{" "}
        <Link href={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-[#111111] hover:underline">
          {t("Đăng ký ngay")}
        </Link>
      </p>
    </div>
  );
}
