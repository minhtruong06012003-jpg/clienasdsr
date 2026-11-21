'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePageMeta, type Crumb } from '@/components/layout/app-topbar';
import { cn } from '@/lib/utils';

export type { Crumb };

/**
 * Điện thoại: ẩn header trang khi cuộn xuống (nhường chỗ cho nội dung), hiện lại ngay khi cuộn lên
 * để luôn với tới nút Lưu/Xuất bản. Từ md trở lên header luôn dính, hook trả về false.
 */
function useHideOnScrollDown() {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    last.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - last.current;
      // bỏ qua rung nhẹ (< 8px) để header không nhấp nháy khi ngón tay dừng
      if (Math.abs(delta) < 8) return;
      last.current = y;
      // gần đầu trang luôn hiện; chỉ ẩn khi đang ở khổ điện thoại
      setHidden(mql.matches && delta > 0 && y > 120);
    };
    const onMql = () => !mql.matches && setHidden(false);
    window.addEventListener('scroll', onScroll, { passive: true });
    mql.addEventListener('change', onMql);
    return () => {
      window.removeEventListener('scroll', onScroll);
      mql.removeEventListener('change', onMql);
    };
  }, []);
  return hidden;
}

/**
 * Tiêu đề trang (dính ngay dưới topbar): tiêu đề + mô tả + nút hành động.
 * Breadcrumb không vẽ ở đây mà đẩy lên topbar toàn cục (AppTopbar) qua usePageMeta.
 * Điện thoại: nút hành động xuống dòng riêng dưới tiêu đề (không ép tiêu đề thành "Chào b…"),
 * header tự ẩn khi cuộn xuống và hiện lại khi cuộn lên.
 */
export function PageHeader({ title, description, breadcrumbs, actions, children }: { title: ReactNode; description?: ReactNode; breadcrumbs?: Crumb[]; actions?: ReactNode; children?: ReactNode }) {
  usePageMeta({ title: typeof title === 'string' ? title : undefined, breadcrumbs });
  const hidden = useHideOnScrollDown();
  return (
    <div
      className={cn(
        'sticky top-14 z-20 border-b bg-background/95 backdrop-blur transition-transform duration-200 supports-[backdrop-filter]:bg-background/80',
        // trượt lên nấp sau topbar (z-30) — chỉ xảy ra ở khổ điện thoại
        hidden && '-translate-y-[calc(100%+3.5rem)]',
      )}
    >
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:px-6">
        {/* basis 12rem: khi không đủ chỗ thì cụm nút tự xuống dòng thay vì bóp tiêu đề */}
        <div className="min-w-0 flex-[1_1_12rem]">
          <h1 className="truncate text-lg font-semibold leading-tight tracking-tight md:text-xl">{title}</h1>
          {description && <p className="truncate text-xs text-muted-foreground md:text-sm">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Vùng nội dung chính của trang */
export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex-1 space-y-6 p-4 md:p-6 ${className}`}>{children}</div>;
}
