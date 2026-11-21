'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { checkPassword, type PasswordPolicy } from '@cmsnt/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type PolicyView = PasswordPolicy & { description: string };

/** Chính sách mật khẩu hiện hành (GET /auth/password-policy, công khai) — dùng chung cho mọi form đặt mật khẩu */
export function usePasswordPolicy() {
  return useQuery({ queryKey: ['password-policy'], queryFn: () => api.get<PolicyView>('/auth/password-policy'), staleTime: 5 * 60_000, retry: false });
}

/**
 * Gợi ý dưới ô mật khẩu mới: mô tả chính sách (Cài đặt › Bảo mật) và, khi đã gõ,
 * các điều kiện còn thiếu — người dùng biết trước thay vì đợi máy chủ báo lỗi.
 */
export function PasswordPolicyHint({ password, email, name, className }: { password: string; email?: string | null; name?: string | null; className?: string }) {
  const q = usePasswordPolicy();
  if (!q.data) return null;
  const errors = password ? checkPassword(password, q.data, { email, name }) : [];
  return (
    <p className={cn('flex items-start gap-1.5 text-xs', !password ? 'text-muted-foreground' : errors.length ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400', className)}>
      {!password ? <Info className="mt-px size-3.5 shrink-0" /> : errors.length ? <XCircle className="mt-px size-3.5 shrink-0" /> : <CheckCircle2 className="mt-px size-3.5 shrink-0" />}
      <span>{!password ? q.data.description : errors.length ? `Cần: ${errors.join(', ')}` : 'Mật khẩu đạt chính sách bảo mật'}</span>
    </p>
  );
}
