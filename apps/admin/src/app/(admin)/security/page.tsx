'use client';

/**
 * Trang Trung tâm bảo mật (/security): 3 tab Tổng quan, Nhật ký đăng nhập, Danh sách IP.
 * Tab hiện tại lưu trên URL (?tab=) để chia sẻ link / giữ khi tải lại trang.
 */
import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Globe, History, type LucideIcon, ShieldCheck } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OverviewTab } from '@/components/security/overview-tab';
import { LoginAttemptsTab } from '@/components/security/login-attempts-tab';
import { IpRulesTab } from '@/components/security/ip-rules-tab';

const TABS: { key: string; label: string; icon: LucideIcon; component: () => React.JSX.Element }[] = [
  { key: 'overview', label: 'Tổng quan', icon: ShieldCheck, component: OverviewTab },
  { key: 'logins', label: 'Nhật ký đăng nhập', icon: History, component: LoginAttemptsTab },
  { key: 'ips', label: 'Danh sách IP', icon: Globe, component: IpRulesTab },
];

function SecurityTabs() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : TABS[0].key;

  return (
    <>
      <PageHeader title="Trung tâm bảo mật" description="Điểm bảo mật, nhật ký đăng nhập, chặn IP và giới hạn IP vào trang quản trị" />
      <PageBody>
        {/* đổi tab chỉ giữ ?tab= (bỏ các tham số lọc riêng của tab trước) */}
        <Tabs value={tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })} className="gap-6">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
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

export default function SecurityPage() {
  return (
    <Suspense>
      <SecurityTabs />
    </Suspense>
  );
}
