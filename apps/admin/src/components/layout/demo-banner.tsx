'use client';

import Link from 'next/link';
import { Eye } from 'lucide-react';
import { useDemoMode } from '@/hooks/use-demo-mode';

/** Thanh báo chế độ demo đang bật, đặt ngay dưới topbar của trang quản trị */
export function DemoBanner() {
  const { enabled, message, exempt } = useDemoMode();
  if (!enabled) return null;
  return (
    <div role="status" className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
      <Eye className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {exempt ? (
          <>
            Chế độ demo đang bật — người xem không thể thêm, sửa, xoá. Bạn là Nhà phát triển nên vẫn thao tác được.{' '}
            <Link href="/settings?tab=demo" className="font-medium underline underline-offset-2">
              Tắt chế độ demo
            </Link>
          </>
        ) : (
          message
        )}
      </span>
    </div>
  );
}
