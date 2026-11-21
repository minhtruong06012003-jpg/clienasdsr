'use client';

/** Đơn hàng › Nạp thẻ cào: header trang + bảng dùng chung (components/commerce/card-topup-logs.tsx) */
import Link from 'next/link';
import { Suspense } from 'react';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { CardTopupLogsView, cardTopupTodaySummary, useCardTopupStats } from '@/components/commerce/card-topup-logs';

function CardTopupsContent() {
  const stats = useCardTopupStats();
  return (
    <>
      <PageHeader
        title="Nạp thẻ cào"
        description={cardTopupTodaySummary(stats.data)}
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Nạp thẻ cào' }]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings?tab=payments">Cấu hình nạp thẻ</Link>
          </Button>
        }
      />
      <PageBody>
        <CardTopupLogsView />
      </PageBody>
    </>
  );
}

export default function CardTopupsPage() {
  return (
    <Suspense>
      <CardTopupsContent />
    </Suspense>
  );
}
