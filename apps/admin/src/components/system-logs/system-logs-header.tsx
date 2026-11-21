'use client';

/**
 * Khung chung cho trang "Nhật ký hệ thống" (/system-logs/*): tiêu đề + thanh tab dính dưới header.
 * Mỗi tab là một route riêng (giữ bộ lọc của tab trên URL, không lẫn tham số giữa các tab);
 * tab nào người dùng không có quyền thì ẩn.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Bug, CreditCard, Smartphone, FileText, History, Mail, TicketPercent, Wallet, type LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { useAdminBadges } from '@/components/layout/app-sidebar';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export interface SystemLogTab {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** Quyền cần có để thấy tab (mảng = cần một trong các quyền; khớp quyền của API tương ứng) */
  permission: string | string[];
  description: string;
  /** Chỉ vai trò Nhà phát triển thấy (giống mục devOnly của menu) */
  devOnly?: boolean;
  /** Ẩn với mọi vai trò: tính năng không dùng ở website AI (trang vẫn mở được bằng đường dẫn) */
  hidden?: boolean;
}

export const SYSTEM_LOG_TABS: SystemLogTab[] = [
  { key: 'activity', href: '/system-logs/activity', label: 'Hoạt động', icon: FileText, permission: 'activity.read', description: 'Lịch sử thao tác của quản trị viên trên hệ thống (giữ 180 ngày)' },
  { key: 'balance', href: '/system-logs/balance', label: 'Số dư', icon: Wallet, permission: 'users.read', description: 'Mọi biến động số dư ví thành viên: nạp, trừ, thanh toán, hoàn tiền' },
  { key: 'payments', href: '/system-logs/payments', label: 'Thanh toán', icon: CreditCard, permission: 'payments.read', description: 'Giao dịch thanh toán online qua các cổng và callback cổng gửi về' },
  { key: 'card-topups', href: '/system-logs/card-topups', label: 'Nạp thẻ cào', icon: Smartphone, permission: 'payments.read', description: 'Thẻ cào thành viên nạp vào ví: chờ xử lý, thành công, sai mệnh giá, thẻ lỗi', hidden: true },
  { key: 'coupons', href: '/system-logs/coupons', label: 'Mã giảm giá', icon: TicketPercent, permission: 'coupons.manage', description: 'Lịch sử sử dụng mã giảm giá trên đơn hàng', hidden: true },
  { key: 'logins', href: '/system-logs/logins', label: 'Đăng nhập', icon: History, permission: 'settings.security', description: 'Mọi lượt đăng nhập thành công / thất bại vào website và trang quản trị' },
  { key: 'emails', href: '/system-logs/emails', label: 'Email', icon: Mail, permission: ['settings.emails', 'settings.mail'], description: 'Email hệ thống đã gửi, đang chờ hoặc gửi lỗi' },
  { key: 'errors', href: '/system-logs/errors', label: 'Lỗi', icon: Bug, permission: 'logs.read', devOnly: true, description: 'Ghi lại mọi lỗi của API, website và trang quản trị' },
];

/** Các tab người dùng hiện tại được xem */
export function useSystemLogTabs() {
  const { can, isDeveloper } = useAuth();
  return SYSTEM_LOG_TABS.filter((t) => !t.hidden && (Array.isArray(t.permission) ? t.permission.some((p) => can(p)) : can(t.permission)) && (isDeveloper || !t.devOnly));
}

/** Thanh tab dạng gạch chân, cuộn ngang trên điện thoại */
function SystemLogsTabs() {
  const pathname = usePathname();
  const tabs = useSystemLogTabs();
  const newErrors = useAdminBadges().data?.newErrors;
  return (
    <nav className="flex gap-1 overflow-x-auto px-4 md:px-6" aria-label="Các loại nhật ký">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative inline-flex h-10 flex-none items-center gap-1.5 px-3 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="size-4" />
            {t.label}
            {/* tab Lỗi: số lỗi mới chưa xem (cùng số với badge ở menu) */}
            {t.key === 'errors' && !!newErrors && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold tabular-nums text-white">{newErrors > 99 ? '99+' : newErrors}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Header trang của một tab nhật ký: tiêu đề chung, mô tả theo tab, nút hành động riêng của tab */
export function SystemLogsHeader({ tab, actions }: { tab: string; actions?: ReactNode }) {
  const current = SYSTEM_LOG_TABS.find((t) => t.key === tab);
  return (
    <PageHeader title="Nhật ký hệ thống" description={current?.description} breadcrumbs={[{ label: 'Nhật ký hệ thống', href: '/system-logs' }, ...(current ? [{ label: current.label }] : [])]} actions={actions}>
      <SystemLogsTabs />
    </PageHeader>
  );
}
