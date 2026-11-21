'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { PaymentLogsView } from '@/components/commerce/payment-logs';

function PaymentsContent() {
  return (
    <>
      <PageHeader
        title="Giao dịch thanh toán"
        description="Theo dõi thanh toán online qua các cổng và nhật ký webhook"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Giao dịch thanh toán' }]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings?tab=payments">Cấu hình cổng thanh toán</Link>
          </Button>
        }
      />
      <PageBody>
        <PaymentLogsView />
      </PageBody>
    </>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentsContent />
    </Suspense>
  );
}
