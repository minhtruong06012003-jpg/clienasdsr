'use client';

/** Tab Nhật ký email: dùng lại bảng nhật ký của Cài đặt › Email */
import { Suspense } from 'react';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { EmailLogsTab } from '../../settings/emails/_components/email-logs';

export default function EmailLogsPage() {
  return (
    <>
      <SystemLogsHeader tab="emails" />
      <PageBody>
        <Suspense>
          <EmailLogsTab />
        </Suspense>
      </PageBody>
    </>
  );
}
