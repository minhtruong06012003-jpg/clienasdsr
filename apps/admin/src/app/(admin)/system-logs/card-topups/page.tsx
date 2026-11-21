'use client';

/** Tab Nhật ký nạp thẻ cào: thẻ thành viên nạp vào ví (dùng chung bảng với Đơn hàng › Nạp thẻ cào) */
import Link from 'next/link';
import { Suspense } from 'react';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { CardTopupLogsView } from '@/components/commerce/card-topup-logs';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

export default function CardTopupLogsPage() {
  const { can } = useAuth();
  return (
    <>
      <SystemLogsHeader
        tab="card-topups"
        actions={
          can('settings.manage') && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings?tab=payments">Cấu hình nạp thẻ</Link>
            </Button>
          )
        }
      />
      <PageBody>
        <Suspense>
          <CardTopupLogsView />
        </Suspense>
      </PageBody>
    </>
  );
}
