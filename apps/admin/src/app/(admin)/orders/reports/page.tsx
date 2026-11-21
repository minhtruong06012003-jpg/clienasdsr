'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageBody } from '@/components/common/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/** Đổi đường dẫn cũ /orders/reports sang /reports/sales, giữ nguyên query string (khoảng thời gian, tab...) */
function RedirectToSales() {
  const router = useRouter();
  const sp = useSearchParams();
  useEffect(() => {
    const s = sp.toString();
    router.replace(`/reports/sales${s ? `?${s}` : ''}`);
  }, [router, sp]);
  return null;
}

/** Báo cáo bán hàng đã chuyển sang /reports/sales — trang này chỉ còn chuyển hướng cho link/bookmark cũ */
export default function LegacySalesReportsPage() {
  return (
    <PageBody>
      <Skeleton className="h-8 w-80" />
      <Skeleton className="h-80 rounded-xl" />
      <Suspense>
        <RedirectToSales />
      </Suspense>
    </PageBody>
  );
}
