'use client';

/** /system-logs: chuyển tới tab nhật ký đầu tiên mà người dùng có quyền xem */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageBody } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { SystemLogsHeader, useSystemLogTabs } from '@/components/system-logs/system-logs-header';
import { useAuth } from '@/lib/auth';

export default function SystemLogsIndex() {
  const router = useRouter();
  const { user } = useAuth();
  const tabs = useSystemLogTabs();
  const first = tabs[0]?.href;
  useEffect(() => {
    if (first) router.replace(first);
  }, [first, router]);
  // chờ tải xong thông tin quyền; không có tab nào thì báo không đủ quyền
  if (!user || first) return null;
  return (
    <>
      <SystemLogsHeader tab="" />
      <PageBody>
        <EmptyState title="Bạn không có quyền xem nhật ký nào" />
      </PageBody>
    </>
  );
}
