'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate, Pencil, ShieldCheck, User } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/field';
import { StatusTabs } from '@/components/common/list-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { EmailLogsTab } from './_components/email-logs';
import { GROUP_ORDER, type EmailTemplateList, type EmailTemplateListItem } from './_components/types';

/** Mẫu email: danh sách theo nhóm + bật/tắt nhanh; tab Nhật ký email */
export default function EmailTemplatesPage() {
  return (
    <Suspense>
      <EmailsContent />
    </Suspense>
  );
}

function EmailsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = sp.get('tab') === 'logs' ? 'logs' : 'templates';

  return (
    <>
      <PageHeader title="Mẫu email" description="Nội dung email hệ thống gửi cho khách hàng và quản trị viên" breadcrumbs={[{ label: 'Cài đặt', href: '/settings' }, { label: 'Mẫu email' }]}>
        <div className="px-4 pb-2 md:px-6">
          <StatusTabs
            value={tab}
            onChange={(v) => router.replace(v === 'logs' ? `${pathname}?tab=logs` : pathname, { scroll: false })}
            options={[
              { value: 'templates', label: 'Mẫu email' },
              { value: 'logs', label: 'Nhật ký email' },
            ]}
          />
        </div>
      </PageHeader>
      <PageBody>{tab === 'logs' ? <EmailLogsTab /> : <TemplatesTab />}</PageBody>
    </>
  );
}

function TemplatesTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['email-templates'], queryFn: () => api.get<EmailTemplateList>('/admin/email-templates') });

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => api.patch(`/admin/email-templates/${key}/enabled`, { enabled }),
    onMutate: async ({ key, enabled }) => {
      await qc.cancelQueries({ queryKey: ['email-templates'] });
      const prev = qc.getQueryData<EmailTemplateList>(['email-templates']);
      if (prev) qc.setQueryData<EmailTemplateList>(['email-templates'], { ...prev, data: prev.data.map((t) => (t.key === key ? { ...t, enabled } : t)) });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['email-templates'], ctx.prev);
      toast.error(errorMessage(e));
    },
    onSuccess: (_d, v) => toast.success(v.enabled ? 'Đã bật mẫu email' : 'Đã tắt mẫu email — hệ thống sẽ không gửi email này'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['email-templates'] }),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    );
  }
  if (!q.data) return <p className="text-sm text-destructive">{q.error ? errorMessage(q.error) : 'Không tải được danh sách mẫu'}</p>;

  const { data, groups, locales } = q.data;
  const manage = can('settings.emails');

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Mỗi mẫu có bản riêng cho từng ngôn ngữ ({locales.map((l) => l.toUpperCase()).join(', ')}). Tắt một mẫu thì hệ thống bỏ qua không gửi email đó. Mẫu <strong>Bố cục chung</strong> bọc mọi email (logo, màu thương hiệu, footer).
        {' '}
        <Link href="?tab=logs" className="text-primary hover:underline">
          Xem nhật ký email
        </Link>
        .
      </p>
      {GROUP_ORDER.map((g) => {
        const items = data.filter((t) => t.group === g);
        if (!items.length) return null;
        return (
          <Section key={g} title={groups[g]} description={`${items.length} mẫu`} className="overflow-hidden">
            <ul className="-m-4 divide-y">
              {items.map((t) => (
                <TemplateRow key={t.key} item={t} locales={locales} canManage={manage} onToggle={(enabled) => toggle.mutate({ key: t.key, enabled })} />
              ))}
            </ul>
          </Section>
        );
      })}
    </div>
  );
}

function TemplateRow({ item, locales, canManage, onToggle }: { item: EmailTemplateListItem; locales: string[]; canManage: boolean; onToggle: (enabled: boolean) => void }) {
  const href = `/settings/emails/${encodeURIComponent(item.key)}`;
  return (
    <li className={cn('flex flex-wrap items-center gap-3 px-4 py-3 transition hover:bg-muted/40', !item.enabled && 'opacity-70')}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{item.key === 'layout' ? <LayoutTemplate className="size-4" /> : item.audience === 'admin' ? <ShieldCheck className="size-4" /> : <User className="size-4" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="text-sm font-medium hover:underline">
            {item.name}
          </Link>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.key}</code>
          <Badge variant="outline" className="text-[11px] font-normal">
            {item.audience === 'admin' ? 'Gửi admin' : 'Gửi khách'}
          </Badge>
          {item.customized && <Badge className="border-transparent bg-amber-100 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Đã tuỳ chỉnh</Badge>}
          {!item.enabled && <Badge variant="secondary" className="text-[11px] font-normal">Đang tắt</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
        {locales.length > 1 && (
          <div className="mt-1 flex items-center gap-1.5">
            {locales.map((l) => {
              const s = item.locales[l];
              return (
                <Link key={l} href={`${href}?locale=${l}`} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] uppercase hover:bg-muted', s?.customized ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')} title={s?.customized ? 'Đã tuỳ chỉnh' : 'Dùng mặc định'}>
                  <span className={cn('size-1.5 rounded-full', s?.customized ? 'bg-amber-500' : 'bg-muted-foreground/30')} />
                  {l}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        {item.key !== 'layout' && <Switch checked={item.enabled} onCheckedChange={onToggle} disabled={!canManage} aria-label={`Bật/tắt mẫu ${item.name}`} />}
        <Button variant="outline" size="sm" asChild>
          <Link href={href}>
            <Pencil /> {canManage ? 'Chỉnh sửa' : 'Xem'}
          </Link>
        </Button>
      </div>
    </li>
  );
}
