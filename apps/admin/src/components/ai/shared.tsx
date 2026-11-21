'use client';

/** Kiểu dữ liệu + nhãn + component nhỏ dùng chung cho các trang AI Studio (công cụ, tác vụ, gói cước, tiếp thị liên kết) */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/common/empty-state';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/** Danh sách phân trang kèm đếm theo trạng thái (tab lọc) */
export interface PaginatedWithCounts<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts?: Record<string, number>;
}

/** Bảng màu nhãn (kèm biến thể dark) */
export const TONE = {
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
} as const;

/** Nhãn màu theo giá trị (giá trị lạ hiện nguyên văn, màu xám) */
export function ToneBadge({ map, value, className }: { map: Record<string, { label: string; className: string }>; value: string; className?: string }) {
  const m = map[value] ?? { label: value, className: TONE.slate };
  return <Badge className={cn('border-transparent font-medium whitespace-nowrap', m.className, className)}>{m.label}</Badge>;
}

/** Chặn hiển thị khi tài khoản thiếu quyền (mảng = cần ít nhất một quyền) */
export function PermissionGate({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const ok = Array.isArray(permission) ? permission.some((p) => can(p)) : can(permission);
  const label = Array.isArray(permission) ? permission.join(', ') : permission;
  if (!ok) return <EmptyState icon={Lock} title="Bạn không có quyền xem mục này" description={`Tài khoản chưa được cấp quyền “${label}”. Liên hệ quản trị viên để được cấp quyền.`} />;
  return <>{children}</>;
}

/** Trạng thái tác vụ AI */
export const TASK_STATUS: Record<string, { label: string; className: string }> = {
  PENDING: { label: 'Đang chờ', className: TONE.amber },
  PROCESSING: { label: 'Đang xử lý', className: TONE.indigo },
  SUCCEEDED: { label: 'Hoàn thành', className: TONE.emerald },
  FAILED: { label: 'Đã hoàn tiền', className: TONE.amber },
  CANCELLED: { label: 'Đã huỷ', className: TONE.slate },
};

/** Loại biến động số dư (VND) do AI Studio ghi: mua gói nạp tiền, trừ tiền chạy AI, hoàn tiền, tặng, điều chỉnh */
export const CREDIT_TXN: Record<string, { label: string; className: string }> = {
  PURCHASE: { label: 'Mua gói nạp', className: TONE.emerald },
  USAGE: { label: 'Dùng AI', className: TONE.indigo },
  REFUND: { label: 'Hoàn tiền', className: TONE.sky },
  BONUS: { label: 'Tặng', className: TONE.violet },
  ADJUST: { label: 'Điều chỉnh', className: TONE.orange },
};

/** Nhóm công cụ AI (GET /admin/ai/categories) — thứ tự mảng = thứ tự hiển thị trên website khách */
export interface ToolCategory {
  key: string;
  label: string;
  icon: string | null;
  /** Nhóm đang bật (tắt = website khách ẩn nhóm và mọi công cụ trong nhóm) */
  enabled: boolean;
  /** Số công cụ đang thuộc nhóm */
  tools: number;
  /** Thứ tự các nhóm model con do admin kéo thả (T-496) */
  groupOrder?: string[];
}

/** Danh sách nhóm công cụ do admin quản lý (tab Nhóm ở Công cụ AI) */
export function useToolCategories() {
  return useQuery({ queryKey: ['ai-categories'], queryFn: () => api.get<ToolCategory[]>('/admin/ai/categories') });
}

/**
 * Số tiền VND làm tròn, dạng "12.000₫" — dùng cho giá công cụ, tiền trừ của tác vụ, số dư ví...
 * (tên giữ `fmtCredits` từ thời còn đơn vị credits; nay 1 credit cũ = 1đ, số dư chạy AI chính là ví)
 */
export const fmtCredits = (n: number | null | undefined) => formatMoney(Math.round(Number(n) || 0));

/** Số đếm thường (lượt mua, số tác vụ...) có dấu chấm ngăn cách, không kèm đơn vị */
export const fmtCount = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('vi-VN');
