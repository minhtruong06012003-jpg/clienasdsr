'use client';

/** Tab Nhật ký thanh toán: giao dịch qua cổng online + callback cổng gửi về (dùng chung với Đơn hàng › Giao dịch thanh toán) */
import Link from 'next/link';
import { Suspense } from 'react';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { PaymentLogsView } from '@/components/commerce/payment-logs';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

export default function PaymentLogsPage() {
  const { can } = useAuth();
  return (
    <>
      <SystemLogsHeader
        tab="payments"
        actions={
          can('settings.manage') && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings?tab=payments">Cấu hình cổng thanh toán</Link>
            </Button>
          )
        }
      />
      <PageBody>
        <Suspense>
          <PaymentLogsView />
        </Suspense>
      </PageBody>
    </>
  );
}
