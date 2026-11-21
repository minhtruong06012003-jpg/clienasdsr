'use client';

/**
 * Phần dùng chung cho Trung tâm bảo mật: khoá query React Query, hook chặn IP nhanh,
 * thẻ số liệu và badge màu theo quy ước dark mode của dự án.
 */
import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Khoá query gốc — invalidate theo tiền tố để làm mới mọi biến thể (lọc, trang...) */
export const SECURITY_KEYS = {
  overview: ['security', 'overview'] as const,
  loginAttempts: ['security', 'login-attempts'] as const,
  ipRules: ['security', 'ip-rules'] as const,
};

/** Kết quả POST /admin/security/ip-rules */
export interface AddIpRulesResult {
  added: string[];
  errors: { value: string; message: string }[];
}

/** Lựa chọn thời hạn chặn IP (phút); 'forever' = vĩnh viễn (không gửi durationMinutes) */
export const DURATION_OPTIONS: { value: string; label: string }[] = [
  { value: '60', label: '1 giờ' },
  { value: '1440', label: '24 giờ' },
  { value: '10080', label: '7 ngày' },
  { value: '43200', label: '30 ngày' },
  { value: 'forever', label: 'Vĩnh viễn' },
];

/** Bảng màu badge/hộp theo tông (nền nhạt + chữ đậm, có biến thể dark) */
export const TONE = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
} as const;
export type Tone = keyof typeof TONE;

/** Hộp cảnh báo vàng dùng lại nhiều chỗ */
export const WARN_BOX = 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200';

/** Làm mới mọi dữ liệu bảo mật liên quan tới IP (tổng quan + danh sách quy tắc) */
export function useInvalidateSecurity() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: SECURITY_KEYS.overview });
    qc.invalidateQueries({ queryKey: SECURITY_KEYS.ipRules });
  };
}

/**
 * Hook chặn nhanh một IP (mặc định 24 giờ) có hộp xác nhận.
 * Dùng ở bảng "IP đăng nhập sai nhiều nhất" và nhật ký đăng nhập.
 */
export function useQuickBlockIp() {
  const confirm = useConfirm();
  const invalidate = useInvalidateSecurity();
  const mutation = useMutation({
    mutationFn: (ip: string) => api.post<AddIpRulesResult>('/admin/security/ip-rules', { type: 'block', value: ip, durationMinutes: 1440, note: 'Chặn nhanh từ Trung tâm bảo mật' }),
    onSuccess: (res, ip) => {
      if (res.added.length) toast.success(`Đã chặn ${ip} trong 24 giờ`);
      else toast.error(res.errors[0]?.message ?? 'Không chặn được IP');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  /** hỏi xác nhận rồi mới gọi API */
  const block = async (ip: string) => {
    const ok = await confirm({
      title: `Chặn IP ${ip}?`,
      description: 'IP này sẽ không truy cập được website và trang quản trị trong 24 giờ. Bạn có thể gỡ chặn bất kỳ lúc nào ở tab Danh sách IP.',
      confirmText: 'Chặn 24 giờ',
      destructive: true,
    });
    if (ok) mutation.mutate(ip);
  };
  return { block, pendingIp: mutation.isPending ? mutation.variables : undefined };
}

/** Thẻ số liệu nhỏ: icon tròn màu + giá trị lớn + nhãn + chú thích phụ */
export function StatCard({ icon: Icon, label, value, sub, tone = 'slate', highlight }: { icon: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; highlight?: boolean }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border bg-card p-4', highlight && 'border-amber-200 dark:border-amber-900')}>
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', TONE[tone])}>
        <Icon className="size-4.5" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums leading-tight">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
        {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

/** Badge màu theo tông */
export function ToneBadge({ tone, children, className, title }: { tone: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium [&>svg]:size-3', TONE[tone], className)}>
      {children}
    </span>
  );
}
