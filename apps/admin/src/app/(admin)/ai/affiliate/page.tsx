'use client';

/**
 * Tiếp thị liên kết (/ai/affiliate): Tổng quan, Yêu cầu rút tiền, Lịch sử hoa hồng, Cài đặt.
 * Tab hiện tại lưu trên URL (?tab=) để chia sẻ link / giữ khi tải lại trang (như Trung tâm bảo mật).
 */
import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BarChart3, HandCoins, History, type LucideIcon, Settings, ShieldAlert } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PermissionGate } from '@/components/ai/shared';
import { OverviewTab } from '@/components/affiliate/overview-tab';
import { PayoutsTab } from '@/components/affiliate/payouts-tab';
import { TransactionsTab } from '@/components/affiliate/transactions-tab';
import { FraudAuditTab } from '@/components/affiliate/fraud-tab';
import { AffiliateSettingsTab } from '@/components/affiliate/settings-tab';

const TABS: { key: string; label: string; icon: LucideIcon; component: () => React.JSX.Element }[] = [
  { key: 'overview', label: 'Tổng quan', icon: BarChart3, component: OverviewTab },
  { key: 'payouts', label: 'Yêu cầu rút tiền', icon: HandCoins, component: PayoutsTab },
  { key: 'transactions', label: 'Lịch sử hoa hồng', icon: History, component: TransactionsTab },
  { key: 'fraud', label: 'Lọc Aff 2 nick', icon: ShieldAlert, component: FraudAuditTab },
  { key: 'settings', label: 'Cài đặt', icon: Settings, component: AffiliateSettingsTab },
];

function AffiliateTabs() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : TABS[0].key;

  return (
    <>
      <PageHeader title="Tiếp thị liên kết" description="Hoa hồng giới thiệu bạn bè, ví hoa hồng của khách và yêu cầu rút tiền" breadcrumbs={[{ label: 'AI Studio' }, { label: 'Tiếp thị liên kết' }]} />
      <PageBody>
        <PermissionGate permission="affiliate.manage">
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
        </PermissionGate>
      </PageBody>
    </>
  );
}

export default function AffiliatePage() {
  return (
    <Suspense>
      <AffiliateTabs />
    </Suspense>
  );
}
