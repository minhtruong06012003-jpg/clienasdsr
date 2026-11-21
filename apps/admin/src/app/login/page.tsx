'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, MailCheck, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { AuthShell, FormAlert, useSiteBrand } from '@/components/auth/auth-shell';
import { useAuth } from '@/lib/auth';
import { api, ApiError, errorMessage } from '@/lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LAST_EMAIL_KEY = 'cmsnt-admin-last-email';

/** Chỉ chấp nhận đường dẫn nội bộ (chống open redirect: //evil.com, /\evil.com, https://...) */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f]/.test(raw)) return '/dashboard';
  return raw;
}

function readLastEmail() {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Thông báo lỗi dễ hiểu cho người dùng */
function friendlyError(err: unknown) {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Bạn thử quá nhiều lần. Vui lòng đợi khoảng 1 phút rồi thử lại.';
    if (err.status >= 500) return 'Máy chủ đang gặp sự cố. Vui lòng thử lại sau ít phút.';
    return err.message;
  }
  if (err instanceof TypeError) return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  return errorMessage(err);
}

type Mode = 'login' | 'forgot' | 'sent' | '2fa';

function LoginForm() {
  const { login, verify2fa, user, loading, accessDenied } = useAuth();
  const { siteName } = useSiteBrand();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // bước 2: xác thực 2 lớp
  const [challenge, setChallenge] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [remember, setRemember] = useState(false);
  const otpRef = useRef<HTMLInputElement>(null);

  // đã đăng nhập -> chuyển thẳng vào trang cần tới
  useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [loading, user, next, router]);

  // nhớ email lần trước -> chỉ cần nhập mật khẩu
  useEffect(() => {
    if (loading || user) return;
    const last = readLastEmail();
    if (last) {
      setEmail(last);
      passwordRef.current?.focus();
    } else emailRef.current?.focus();
  }, [loading, user]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setErrors({});
    setTimeout(() => emailRef.current?.focus(), 0);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    const v: typeof errors = {};
    if (!email.trim()) v.email = 'Vui lòng nhập email';
    else if (!EMAIL_RE.test(email.trim())) v.email = 'Email không đúng định dạng';
    if (!password) v.password = 'Vui lòng nhập mật khẩu';
    setErrors(v);
    if (v.email) return emailRef.current?.focus();
    if (v.password) return passwordRef.current?.focus();

    setSubmitting(true);
    try {
      const outcome = await login(email.trim(), password);
      try {
        localStorage.setItem(LAST_EMAIL_KEY, email.trim().toLowerCase());
      } catch {
        /* trình duyệt chặn storage -> bỏ qua */
      }
      if (!outcome.ok) {
        // tài khoản bật 2FA: chưa có token, chuyển sang bước nhập mã
        setChallenge(outcome.challenge);
        setPassword('');
        setOtp('');
        setUseRecovery(false);
        setErrors({});
        setMode('2fa');
        setSubmitting(false);
        setTimeout(() => otpRef.current?.focus(), 0);
        return;
      }
      toast.success('Đăng nhập thành công');
      router.replace(next);
    } catch (err) {
      setErrors({ form: friendlyError(err) });
      setPassword('');
      passwordRef.current?.focus();
      setSubmitting(false);
    }
  }

  async function onVerify2fa(e: FormEvent) {
    e.preventDefault();
    const value = otp.trim();
    if (!challenge) return switchMode('login');
    if (!value) {
      setErrors({ form: useRecovery ? 'Vui lòng nhập mã dự phòng' : 'Vui lòng nhập mã 6 số từ ứng dụng xác thực' });
      return otpRef.current?.focus();
    }
    setSubmitting(true);
    try {
      const res = await verify2fa(useRecovery ? { challenge, recoveryCode: value, remember } : { challenge, code: value, remember });
      if (res.usedRecovery) toast.warning(`Đã dùng 1 mã dự phòng — còn ${res.recoveryLeft} mã. Hãy tạo bộ mã mới trong Hồ sơ > Bảo mật.`);
      else toast.success('Đăng nhập thành công');
      router.replace(next);
    } catch (err) {
      const msg = friendlyError(err);
      // challenge hết hạn (5 phút) -> quay lại nhập mật khẩu
      if (err instanceof ApiError && err.status === 401 && /hết hạn|đăng nhập lại/i.test(msg)) {
        setChallenge(null);
        setMode('login');
        setErrors({ form: msg });
        setTimeout(() => passwordRef.current?.focus(), 0);
      } else {
        setErrors({ form: msg });
        setOtp('');
        otpRef.current?.focus();
      }
      setSubmitting(false);
    }
  }

  async function onForgot(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setErrors({ email: email.trim() ? 'Email không đúng định dạng' : 'Vui lòng nhập email' });
      return emailRef.current?.focus();
    }
    setSubmitting(true);
    try {
      await api.post('/auth/forgot-password', { email: email.trim(), target: 'admin' });
      setErrors({});
      setMode('sent');
    } catch (err) {
      setErrors({ form: friendlyError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  // đang khôi phục phiên / đang chuyển trang -> không nháy form
  if (loading || user) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="size-6 animate-spin" />
        {user ? 'Đang chuyển tới trang quản trị…' : 'Đang kiểm tra phiên đăng nhập…'}
      </div>
    );
  }

  if (mode === 'sent') {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400">
          <MailCheck className="size-7" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Kiểm tra hộp thư</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Nếu <span className="font-medium text-foreground">{email.trim()}</span> là tài khoản trong hệ thống, link đặt lại mật khẩu đã được gửi tới email này (hiệu lực 60 phút). Hãy kiểm tra cả thư mục Spam.
          </p>
        </div>
        <Button variant="outline" className="h-10 w-full" onClick={() => switchMode('login')}>
          <ArrowLeft /> Quay lại đăng nhập
        </Button>
      </div>
    );
  }

  if (mode === '2fa') {
    return (
      <div className="space-y-7">
        <div className="space-y-2">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="size-6" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Xác thực 2 bước</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {useRecovery ? (
              <>Nhập một trong các mã dự phòng bạn đã lưu khi bật xác thực 2 bước. Mỗi mã chỉ dùng được một lần.</>
            ) : (
              <>
                Mở ứng dụng xác thực (Google Authenticator, Authy…) và nhập mã 6 số cho tài khoản <span className="font-medium text-foreground">{email.trim()}</span>.
              </>
            )}
          </p>
        </div>

        {errors.form && (
          <FormAlert>
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{errors.form}</span>
          </FormAlert>
        )}

        <form onSubmit={onVerify2fa} noValidate className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="otp">{useRecovery ? 'Mã dự phòng' : 'Mã xác thực'}</Label>
            <InputGroup className="h-11">
              <InputGroupAddon>
                <KeyRound />
              </InputGroupAddon>
              <InputGroupInput
                ref={otpRef}
                id="otp"
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={useRecovery ? 'xxxxx-xxxxx' : '123 456'}
                maxLength={useRecovery ? 12 : 7}
                value={otp}
                onChange={(e) => {
                  const v = e.target.value;
                  setOtp(useRecovery ? v.toLowerCase() : v.replace(/[^\d]/g, '').slice(0, 6));
                  if (errors.form) setErrors({});
                }}
                className={useRecovery ? 'font-mono tracking-wide' : 'font-mono text-lg tracking-[0.35em]'}
                disabled={submitting}
              />
            </InputGroup>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} disabled={submitting} />
            Tin cậy thiết bị này trong 30 ngày
          </label>

          <Button type="submit" className="h-10 w-full text-sm" disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            {submitting ? 'Đang xác minh…' : 'Xác nhận'}
          </Button>

          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              className="rounded-sm font-medium text-primary hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setOtp('');
                setErrors({});
                setTimeout(() => otpRef.current?.focus(), 0);
              }}
              disabled={submitting}
            >
              {useRecovery ? 'Dùng mã từ ứng dụng xác thực' : 'Không có điện thoại? Dùng mã dự phòng'}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setChallenge(null);
                switchMode('login');
              }}
              disabled={submitting}
            >
              <ArrowLeft className="size-3.5" /> Quay lại
            </button>
          </div>
        </form>
      </div>
    );
  }

  const forgot = mode === 'forgot';

  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">{forgot ? 'Quên mật khẩu' : 'Đăng nhập quản trị'}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {forgot
            ? 'Nhập email tài khoản quản trị, chúng tôi sẽ gửi link để đặt mật khẩu mới.'
            : `Chào mừng trở lại! Đăng nhập để quản lý ${siteName || 'website'}.`}
        </p>
      </div>

      {params.get('reset') === '1' && !forgot && !errors.form && (
        <FormAlert tone="success">
          <MailCheck className="mt-0.5 size-4 shrink-0" />
          <span>Đã đặt mật khẩu mới. Hãy đăng nhập bằng mật khẩu vừa tạo.</span>
        </FormAlert>
      )}

      {/* đang có phiên (vd. đăng nhập website) nhưng tài khoản không có quyền quản trị */}
      {accessDenied && !forgot && !errors.form && (
        <FormAlert>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>Tài khoản đang đăng nhập không có quyền truy cập trang quản trị. Vui lòng đăng nhập bằng tài khoản quản trị.</span>
        </FormAlert>
      )}

      {errors.form && (
        <FormAlert>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{errors.form}</span>
        </FormAlert>
      )}

      <form onSubmit={forgot ? onForgot : onLogin} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <InputGroup className="h-10">
            <InputGroupAddon>
              <Mail />
            </InputGroupAddon>
            <InputGroupInput
              ref={emailRef}
              id="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="admin@domain.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email || errors.form) setErrors({});
              }}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
              disabled={submitting}
            />
          </InputGroup>
          {errors.email && (
            <p id="email-error" className="text-xs text-destructive">
              {errors.email}
            </p>
          )}
        </div>

        {!forgot && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Mật khẩu</Label>
              <button type="button" onClick={() => switchMode('forgot')} className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                Quên mật khẩu?
              </button>
            </div>
            <InputGroup className="h-10">
              <InputGroupAddon>
                <Lock />
              </InputGroupAddon>
              <InputGroupInput
                ref={passwordRef}
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password || errors.form) setErrors({});
                }}
                onKeyDown={onKey}
                onKeyUp={onKey}
                onBlur={() => setCapsLock(false)}
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : capsLock ? 'caps-warning' : undefined}
                disabled={submitting}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={showPassword} title={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
                  {showPassword ? <EyeOff /> : <Eye />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {errors.password ? (
              <p id="password-error" className="text-xs text-destructive">
                {errors.password}
              </p>
            ) : (
              capsLock && (
                <p id="caps-warning" className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <TriangleAlert className="size-3.5" /> Caps Lock đang bật
                </p>
              )
            )}
          </div>
        )}

        <Button type="submit" className="h-10 w-full text-sm" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {forgot ? (submitting ? 'Đang gửi…' : 'Gửi link đặt lại mật khẩu') : submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </Button>

        {forgot && (
          <Button type="button" variant="ghost" className="h-10 w-full" onClick={() => switchMode('login')} disabled={submitting}>
            <ArrowLeft /> Quay lại đăng nhập
          </Button>
        )}
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
