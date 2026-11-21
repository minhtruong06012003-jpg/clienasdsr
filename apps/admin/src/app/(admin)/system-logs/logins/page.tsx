'use client';

/** Tab Nhật ký đăng nhập: dùng lại bảng của Trung tâm bảo mật */
import { Suspense } from 'react';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { LoginAttemptsTab } from '@/components/security/login-attempts-tab';

export default function LoginLogsPage() {
  return (
    <>
      <SystemLogsHeader tab="logins" />
      <PageBody>
        <Suspense>
          <LoginAttemptsTab />
        </Suspense>
      </PageBody>
    </>
  );
}
