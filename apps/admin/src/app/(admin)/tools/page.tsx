'use client';

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Database, Eraser, FileJson, ListChecks, type LucideIcon } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BackupTab } from '@/components/tools/backup-tab';
import { HealthTab } from '@/components/tools/health-tab';
import { JobsTab } from '@/components/tools/jobs-tab';
import { CacheTab } from '@/components/tools/cache-tab';
import { ExportImportTab } from '@/components/tools/export-import-tab';

const TABS: { key: string; label: string; icon: LucideIcon; component: () => React.JSX.Element }[] = [
  { key: 'backup', label: 'Sao lưu', icon: Database, component: BackupTab },
  { key: 'health', label: 'Site Health', icon: Activity, component: HealthTab },
  { key: 'jobs', label: 'Tác vụ nền', icon: ListChecks, component: JobsTab },
  { key: 'cache', label: 'Cache', icon: Eraser, component: CacheTab },
  { key: 'export', label: 'Xuất / nhập cấu hình', icon: FileJson, component: ExportImportTab },
];

function ToolsTabs() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : TABS[0].key;

  return (
    <>
      <PageHeader title="Công cụ" description="Sao lưu, kiểm tra hệ thống, tác vụ nền, cache, xuất / nhập cấu hình" />
      <PageBody>
        <Tabs value={tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })} className="gap-6">
          {/* điện thoại: 5 tab không vừa một hàng → chọn công cụ bằng ô chọn */}
          <Select value={tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })}>
            <SelectTrigger className="h-10 w-full md:hidden" aria-label="Chọn công cụ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABS.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  <t.icon /> {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TabsList variant="line" className="hidden w-full justify-start overflow-x-auto md:flex">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="flex-none px-3">
                <t.icon data-icon="inline-start" /> {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map((t) => (
            <TabsContent key={t.key} value={t.key}>
              {tab === t.key && <t.component />}
            </TabsContent>
          ))}
        </Tabs>
      </PageBody>
    </>
  );
}

export default function ToolsPage() {
  return (
    <Suspense>
      <ToolsTabs />
    </Suspense>
  );
}
