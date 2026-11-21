"use client";

/**
 * Form đăng ký: `POST /api/auth/register?locale=<ngôn ngữ đang chọn> { email, password, name, phone?, _captcha?, referralCode? }`.
 * - Có captcha khi `bootstrap.captcha.on` chứa "register" (dùng useCaptcha của @cmsnt/blocks/client).
 * - Có nút đăng ký nhanh bằng Google (SocialLogin).
 * - API trả token -> đăng nhập luôn; trả `requiresVerification` -> báo kiểm tra email.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Lock, Mail, MailCheck, Phone, Sparkles, UserPlus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useCaptcha } from "@cmsnt/blocks/client";
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "@cmsnt/shared";
import { Button } from "@/components/ui/button";
import { AuthTitle } from "@/components/site/auth-shell";
import { AuthCheckbox, AuthDivider, AuthError, AuthInlineField, AuthSubmit, SocialLogin } from "@/components/site/auth-ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { safeNext } from "@/lib/nav";
import { useBootstrap } from "@/lib/queries";
import { readReferral, saveReferral } from "@/lib/referral";
import type { AuthResult, LoginResponse, RegisterResponse } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { status, signIn } = useAuth();
  const boot = useBootstrap();
  const { t, locale } = useI18n();
  const captcha = useCaptcha(boot.data?.captcha ?? null, "register", { required: t("Vui lòng xác minh bạn không phải robot"), loadError: t("Không tải được captcha") });
  // gợi ý chính sách mật khẩu (độ dài, ký tự bắt buộc...)
  const policy = useQuery({
    queryKey: ["public", "password-policy"],
    queryFn: () => api.get<Partial<PasswordPolicy> & { description?: string }>("/auth/password-policy", undefined, { auth: false }),
    staleTime: 10 * 60_000,
    retry: false,
    meta: { silentError: true },
  });

  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "", confirm: "" });
  const [showPw, setShowPw] = useState(false);
  const [copiedPw, setCopiedPw] = useState(false);
  const [agree, setAgree] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  /** Sinh mật khẩu mạnh chuẩn 12 ký tự (chữ hoa + chữ thường + chữ số + ký tự đặc biệt, loại bỏ ký tự dễ nhầm I/l/1/O/0) */
  const generateStrongPassword = () => {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const digits = "23456789";
    const symbols = "@#$%&*!?";
    const all = upper + lower + digits + symbols;
    const rand = (pool: string, idx: number, bytes: Uint32Array) => pool[bytes[idx] % pool.length];
    const bytes = new Uint32Array(16);
    crypto.getRandomValues(bytes);
    const chars = [
      rand(upper, 0, bytes),
      rand(upper, 1, bytes),
      rand(lower, 2, bytes),
      rand(lower, 3, bytes),
      rand(digits, 4, bytes),
      rand(digits, 5, bytes),
      rand(symbols, 6, bytes),
      ...Array.from({ length: 5 }, (_, i) => rand(all, 7 + i, bytes)),
    ];
    // xáo trộn Fisher-Yates bằng nguồn ngẫu nhiên crypto
    const shuffleBytes = new Uint32Array(chars.length);
    crypto.getRandomValues(shuffleBytes);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = shuffleBytes[i] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join("");
    setForm((f) => ({ ...f, password: pw, confirm: pw }));
    setShowPw(true);
    navigator.clipboard
      ?.writeText(pw)
      .then(() => {
        setCopiedPw(true);
        setTimeout(() => setCopiedPw(false), 2500);
        toast.success(t("Đã điền & sao chép mật khẩu mạnh 12 ký tự"));
      })
      .catch(() => {
        toast.success(t("Đã điền mật khẩu mạnh 12 ký tự"));
      });
  };

  useEffect(() => {
    if (status === "authenticated") router.replace(next);
  }, [status, next, router]);

  // link giới thiệu dạng /register?ref=CODE
  useEffect(() => {
    const ref = params.get("ref");
    if (ref) saveReferral(ref);
  }, [params]);

  // chính sách mật khẩu từ API (chưa tải xong thì dùng mặc định: 8 ký tự, chữ cái + số + ký tự đặc biệt)
  const pwPolicy: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY, ...policy.data };
  const minLength = pwPolicy.minLength || 8;

  /** Thang đo độ mạnh mật khẩu (0..4) khuyến nghị chuẩn ≥ 12 ký tự */
  const pwStrength = (() => {
    const pw = form.password;
    if (!pw) return { score: 0, label: "", color: "bg-zinc-200", textColor: "text-[#6b6b70]" };
    let variety = 0;
    if (/[a-z]/.test(pw)) variety++;
    if (/[A-Z]/.test(pw)) variety++;
    if (/\d/.test(pw)) variety++;
    if (/[^\p{L}\p{N}\s]/u.test(pw)) variety++;
    if (pw.length < minLength) return { score: 1, label: t("Quá ngắn"), color: "bg-rose-500", textColor: "text-rose-600" };
    if (pw.length >= 12 && variety >= 3) return { score: 4, label: t("Rất mạnh · An toàn cao"), color: "bg-emerald-500", textColor: "text-emerald-600" };
    if (pw.length >= 10 && variety >= 2) return { score: 3, label: t("Khá tốt (nên từ 12 ký tự)"), color: "bg-sky-500", textColor: "text-sky-600" };
    return { score: 2, label: t("Trung bình (khuyên dùng ≥ 12 ký tự đủ chữ hoa, số, ký tự đặc biệt)"), color: "bg-amber-500", textColor: "text-amber-600" };
  })();

  /** Các điều kiện ký tự mật khẩu chưa đạt (đã dịch) — API vẫn kiểm tra lại đầy đủ khi gửi */
  const passwordIssues = (pw: string) => {
    const issues: string[] = [];
    if (pw.length < minLength) issues.push(t("tối thiểu {n} ký tự", { n: minLength }));
    if (pwPolicy.requireUppercase && !/[A-Z]/.test(pw)) issues.push(t("có chữ in hoa"));
    if (pwPolicy.requireLowercase && !/[a-z]/.test(pw)) issues.push(t("có chữ thường"));
    if (pwPolicy.requireNumber && !/\d/.test(pw)) issues.push(t("có chữ số"));
    if (pwPolicy.requireSymbol && !/[^\p{L}\p{N}\s]/u.test(pw)) issues.push(t("có ký tự đặc biệt"));
    return issues;
  };
  // dòng gợi ý dưới ô mật khẩu: liệt kê toàn bộ yêu cầu
  const passwordHint = passwordIssues("").join(", ");

  /** Đăng ký / đăng nhập bằng Google: vào luôn, trừ khi tài khoản bật 2FA thì chuyển sang trang đăng nhập */
  const googleResult = (res: LoginResponse) => {
    if ("requires2fa" in res && res.requires2fa) {
      toast.info(t("Tài khoản đã bật xác thực hai lớp, vui lòng đăng nhập để nhập mã"));
      router.push("/login");
      return;
    }
    signIn(res as AuthResult);
    toast.success(t("Đăng nhập thành công!"));
    router.replace(next);
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // họ và tên bắt buộc (API giới hạn 120 ký tự); đăng nhập chỉ dùng email
    if (!form.name.trim()) return setError(t("Vui lòng nhập họ và tên"));
    const issues = passwordIssues(form.password);
    if (issues.length) return setError(`${t("Mật khẩu chưa đạt yêu cầu")}: ${issues.join(", ")}`);
    if (form.password !== form.confirm) return setError(t("Mật khẩu nhập lại không khớp"));
    if (!agree) return setError(t("Bạn cần đồng ý với điều khoản dịch vụ"));
    if (boot.data?.settings?.account?.allowRegistration === false) return setError(t("Website đang tạm khoá đăng ký tài khoản mới"));
    setLoading(true);
    try {
      let token: string | undefined;
      try {
        token = await captcha.getToken();
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
      const body = {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(token ? { _captcha: token } : {}),
        ...(readReferral() ? { referralCode: readReferral() } : {}),
      };
      const res = await api.post<RegisterResponse>("/auth/register", body, { auth: false, query: { locale } });
      if ("requiresVerification" in res && res.requiresVerification) {
        setVerifyMessage(res.message || t("Vui lòng kiểm tra email để xác minh tài khoản."));
        return;
      }
      signIn(res as AuthResult);
      toast.success(t("Tạo tài khoản thành công!"));
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
      captcha.reset();
    } finally {
      setLoading(false);
    }
  };

  // đăng ký xong nhưng cần xác minh email
  if (verifyMessage) {
    return (
      <div className="text-center">
        <span className="mx-auto mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
          <MailCheck className="size-7" />
        </span>
        <AuthTitle title={t("Kiểm tra hộp thư của bạn")} description={verifyMessage} />
        <p className="text-sm text-muted-foreground">
          {t("Đã gửi tới")} <b className="text-foreground">{form.email}</b>. {t("Không thấy email? Hãy xem thư mục Spam hoặc")}{" "}
          <ResendLink email={form.email} />.
        </p>
        <Button asChild variant="outline" className="mt-6" size="lg">
          <Link href="/login">{t("Về trang đăng nhập")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      <AuthTitle title={t("Đăng ký tài khoản")} description={t("Vui lòng điền đầy đủ thông tin để tạo tài khoản")} />
      <form onSubmit={submit} className="space-y-3">
        {/* họ và tên hiển thị; đăng nhập dùng email nên không còn tên tài khoản */}
        <AuthInlineField
          id="name"
          label={t("Họ và tên")}
          icon={<UserRound fill="currentColor" />}
          autoComplete="name"
          placeholder={t("Nhập họ và tên của bạn")}
          value={form.name}
          onChange={set("name")}
          required
          maxLength={120}
        />
        <AuthInlineField id="email" label={t("Email")} icon={<Mail />} type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={t("Nhập email của bạn")} value={form.email} onChange={set("email")} required />
        <AuthInlineField id="phone" label={t("Số điện thoại")} icon={<Phone fill="currentColor" />} type="tel" autoComplete="tel" placeholder={t("Nhập số điện thoại của bạn")} value={form.phone} onChange={set("phone")} />
        <AuthInlineField
          id="password"
          label={t("Mật khẩu")}
          icon={<Lock fill="currentColor" />}
          password
          showPassword={showPw}
          onTogglePassword={() => setShowPw((v) => !v)}
          autoComplete="new-password"
          placeholder={t("Nhập mật khẩu (khuyên dùng từ 12 ký tự)")}
          title={policy.data?.description}
          value={form.password}
          onChange={set("password")}
          required
          minLength={minLength}
          maxLength={128}
        />
        <div className="-mt-1 space-y-1.5 rounded-xl border border-[#ececee] bg-[#fafafa] px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="text-[#52525b]">
              {t("Mật khẩu cần")}: {passwordHint} · <strong className="font-semibold text-[#111111]">{t("Khuyên dùng ≥ 12 ký tự")}</strong>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={generateStrongPassword}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20"
              >
                <Sparkles className="size-3" />
                {t("Gợi ý mật khẩu mạnh (12 ký tự)")}
              </button>
              {form.password.length >= 8 && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(form.password).then(() => {
                      setCopiedPw(true);
                      setTimeout(() => setCopiedPw(false), 2000);
                      toast.success(t("Đã sao chép mật khẩu"));
                    });
                  }}
                  title={t("Sao chép mật khẩu")}
                  className="inline-flex items-center gap-1 rounded-md border border-[#e4e4e7] bg-white px-1.5 py-0.5 text-[11px] font-medium text-[#52525b] hover:text-[#111111]"
                >
                  {copiedPw ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
                </button>
              )}
            </div>
          </div>
          {form.password.length > 0 && (
            <div className="space-y-1">
              <div className="grid grid-cols-4 gap-1">
                {[1, 2, 3, 4].map((step) => (
                  <span key={step} className={`h-1 rounded-full transition-colors ${step <= pwStrength.score ? pwStrength.color : "bg-[#e4e4e7]"}`} />
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className={`font-medium ${pwStrength.textColor}`}>{pwStrength.label}</span>
                <span className="text-[#71717a] tabular-nums">{form.password.length} {t("ký tự")}</span>
              </div>
            </div>
          )}
        </div>
        <AuthInlineField
          id="confirm"
          label={t("Nhập lại mật khẩu")}
          icon={<Lock fill="currentColor" />}
          password
          showPassword={showPw}
          onTogglePassword={() => setShowPw((v) => !v)}
          autoComplete="new-password"
          placeholder={t("Nhập lại mật khẩu")}
          value={form.confirm}
          onChange={set("confirm")}
          required
        />
        {captcha.widget}
        <div className="pt-1">
          <AuthCheckbox checked={agree} onChange={setAgree}>
            {t("Tôi đồng ý với các")}{" "}
            <Link href="/p/dieu-khoan" className="font-medium text-[#111111] underline-offset-2 hover:underline" target="_blank">
              {t("điều khoản & chính sách")}
            </Link>
          </AuthCheckbox>
        </div>
        {error && <AuthError>{error}</AuthError>}
        <div className="pt-1">
          <AuthSubmit loading={loading}>
            {!loading && <UserPlus />} {t("Đăng ký")}
          </AuthSubmit>
        </div>
      </form>
      <AuthDivider>{t("Hoặc đăng ký với")}</AuthDivider>
      <SocialLogin onResult={googleResult} />
      <p className="mt-6 text-center text-[13px] text-[#6b6b70]">
        {t("Đã có tài khoản?")}{" "}
        <Link href={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-[#111111] hover:underline">
          {t("Đăng nhập ngay")}
        </Link>
      </p>
    </div>
  );
}

/** Gửi lại email xác minh (`POST /api/auth/resend-verification`) */
export function ResendLink({ email }: { email: string }) {
  const { t, locale } = useI18n();
  const [sending, setSending] = useState(false);
  return (
    <button
      type="button"
      className="font-medium text-primary hover:underline disabled:opacity-50"
      disabled={sending || !email}
      onClick={async () => {
        setSending(true);
        try {
          await api.post("/auth/resend-verification", { email }, { auth: false, query: { locale } });
          toast.success(t("Đã gửi lại email xác minh"));
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setSending(false);
        }
      }}
    >
      {t("gửi lại email")}
    </button>
  );
}
