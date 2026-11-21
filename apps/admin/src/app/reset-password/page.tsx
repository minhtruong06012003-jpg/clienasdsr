'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { AuthShell, FormAlert } from '@/components/auth/auth-shell';
import { passwordStrength } from '@/components/users/password-strength';
import { usePasswordPolicy } from '@/components/users/password-policy-hint';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const strength = passwordStrength(password);
  // mô tả chính sách mật khẩu hiện hành (Cài đặt › Bảo mật)
  const policy = usePasswordPolicy();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v: typeof errors = {};
    if (password.length < 8) v.password = 'Mật khẩu cần ít nhất 8 ký tự';
    else if (password.length > 128) v.password = 'Mật khẩu tối đa 128 ký tự';
    if (!v.password && confirm !== password) v.confirm = 'Mật khẩu nhập lại không khớp';
    setErrors(v);
    if (v.password || v.confirm) return;
    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      router.replace('/login?reset=1');
    } catch (err) {
      setErrors({ form: err instanceof ApiError && err.status === 429 ? 'Bạn thử quá nhiều lần. Vui lòng đợi 1 phút.' : errorMessage(err) });
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-6">
        <FormAlert>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>Liên kết đặt lại mật khẩu không hợp lệ. Hãy mở đúng link trong email hoặc yêu cầu link mới.</span>
        </FormAlert>
        <Button asChild variant="outline" className="h-10 w-full">
          <Link href="/login">
            <ArrowLeft /> Về trang đăng nhập
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="size-5" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">Đặt mật khẩu mới</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">Mật khẩu mới sẽ áp dụng ngay; mọi phiên đăng nhập cũ trên các thiết bị khác sẽ bị đăng xuất.</p>
      </div>

      {errors.form && (
        <FormAlert>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {errors.form}{' '}
            <Link href="/login" className="font-medium underline underline-offset-2">
              Yêu cầu link mới
            </Link>
          </span>
        </FormAlert>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="password">Mật khẩu mới</Label>
          <InputGroup className="h-10">
            <InputGroupAddon>
              <Lock />
            </InputGroupAddon>
            <InputGroupInput
              id="password"
              autoFocus
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setErrors({});
              }}
              aria-invalid={!!errors.password}
              aria-describedby="password-hint"
              disabled={submitting}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={show}>
                {show ? <EyeOff /> : <Eye />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {password && (
            <div className="flex items-center gap-2" aria-hidden>
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={cn('h-1 flex-1 rounded-full', i <= strength.score ? strength.color : 'bg-muted')} />
                ))}
              </div>
              <span className="w-16 text-right text-xs text-muted-foreground">{strength.label}</span>
            </div>
          )}
          <p id="password-hint" className={cn('text-xs', errors.password ? 'text-destructive' : 'text-muted-foreground')}>
            {errors.password ?? policy.data?.description ?? 'Tối thiểu 8 ký tự, nên kết hợp chữ hoa, chữ thường, số và ký tự đặc biệt.'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Nhập lại mật khẩu</Label>
          <InputGroup className="h-10">
            <InputGroupAddon>
              <Lock />
            </InputGroupAddon>
            <InputGroupInput
              id="confirm"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setErrors({});
              }}
              aria-invalid={!!errors.confirm}
              disabled={submitting}
            />
          </InputGroup>
          {errors.confirm && <p className="text-xs text-destructive">{errors.confirm}</p>}
        </div>

        <Button type="submit" className="h-10 w-full" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {submitting ? 'Đang lưu…' : 'Lưu mật khẩu mới'}
        </Button>
        <Button asChild variant="ghost" className="h-10 w-full">
          <Link href="/login">
            <ArrowLeft /> Quay lại đăng nhập
          </Link>
        </Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}
