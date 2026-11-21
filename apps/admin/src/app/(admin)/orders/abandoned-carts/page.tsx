'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Mail, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { ABANDONED_CART_STATUS_LABELS, type AbandonedCartRow, type AbandonedCartStats, type AbandonedCartStatus } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { AbandonedCartStatusBadge } from '@/components/carts/abandoned-cart-status';
import { AbandonedCartDialog } from '@/components/carts/abandoned-cart-dialog';
import { AbandonedCartSettingsDialog } from '@/components/carts/abandoned-cart-settings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';

const STATUS_ORDER: AbandonedCartStatus[] = ['abandoned', 'active', 'recovered', 'converted', 'expired'];

/** Thẻ số liệu nhỏ */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AbandonedCartsContent() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRemind = can('orders.write');
  const { params, set, page, limit } = useListParams<Record<string, string>>({ status: '', search: '', days: '30' });
  const [viewing, setViewing] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const confirm = useConfirm();
  // id các giỏ đang tích chọn để gửi email nhắc hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['abandoned-carts', 'list', params.status, params.search, page, limit],
    queryFn: () => api.get<Paginated<AbandonedCartRow>>('/admin/abandoned-carts', { status: params.status, search: params.search, page, limit }),
  });
  const stats = useQuery({
    queryKey: ['abandoned-carts', 'stats', params.days],
    queryFn: () => api.get<AbandonedCartStats>('/admin/abandoned-carts/stats', { days: params.days || '30' }),
  });

  const remind = useMutation({
    mutationFn: (id: string) => api.post<{ status: string; reason?: string }>(`/admin/abandoned-carts/${id}/remind`),
    onSuccess: (r) => {
      if (r.status === 'SENT') toast.success('Đã gửi email nhắc');
      else toast.warning(`Email chưa được gửi: ${r.reason ?? r.status} (đã ghi nhật ký email)`);
      void qc.invalidateQueries({ queryKey: ['abandoned-carts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /**
   * Gửi email nhắc hàng loạt: gọi endpoint nhắc đơn lẻ cho từng giỏ.
   * Giỏ đã thành đơn / trống / chưa có email bị server từ chối và được gộp vào thông báo lỗi;
   * email chưa gửi được (bị bỏ qua) cũng tính là lỗi để toast phản ánh đúng số đã gửi.
   */
  const bulkRemind = async () => {
    const ids = [...selected];
    if (!(await confirm({ title: `Gửi email nhắc cho ${ids.length} giỏ hàng?`, description: 'Mỗi khách sẽ nhận một email kèm link khôi phục giỏ.', confirmText: 'Gửi' }))) return;
    await bulk.run({
      ids,
      action: async (id) => {
        const r = await api.post<{ status: string; reason?: string }>(`/admin/abandoned-carts/${id}/remind`);
        if (r.status !== 'SENT') throw new Error(`Email chưa được gửi: ${r.reason ?? r.status}`);
      },
      doneLabel: 'Đã gửi nhắc',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['abandoned-carts'] });
      },
    });
  };

  const s = stats.data;
  const columns: Column<AbandonedCartRow>[] = [
    {
      key: 'email',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.email}</div>
          {r.user && <div className="truncate text-xs text-muted-foreground">Thành viên: {r.user.name}</div>}
        </div>
      ),
    },
    {
      key: 'subtotal',
      header: 'Giá trị',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap tabular-nums">
          <div className="font-semibold">{formatMoney(r.subtotal)}</div>
          <div className="text-xs text-muted-foreground">{r.itemCount} sản phẩm</div>
        </div>
      ),
    },
    {
      key: 'lastActivityAt',
      header: 'Hoạt động cuối',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.lastActivityAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.lastActivityAt)}</div>
        </div>
      ),
    },
    {
      key: 'reminderCount',
      header: 'Đã nhắc',
      cell: (r) =>
        r.reminderCount ? (
          <div className="whitespace-nowrap text-xs">
            <div className="font-medium">{r.reminderCount} lần</div>
            {r.lastReminderAt && <div className="text-muted-foreground">{timeAgo(r.lastReminderAt)}</div>}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="space-y-1">
          <AbandonedCartStatusBadge status={r.status} />
          {r.convertedOrderCode && (
            <Link href={`/orders?search=${encodeURIComponent(r.convertedOrderCode)}`} onClick={(e) => e.stopPropagation()} className="block font-mono text-xs text-primary hover:underline">
              #{r.convertedOrderCode}
            </Link>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) =>
        canRemind && !r.convertedOrderCode && r.itemCount > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={remind.isPending && remind.variables === r.id}
            onClick={(e) => {
              e.stopPropagation();
              remind.mutate(r.id);
            }}
          >
            {remind.isPending && remind.variables === r.id ? <Loader2 className="animate-spin" /> : <Mail />} Nhắc
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Giỏ hàng bỏ dở"
        description="Khách đã để lại email (hoặc đăng nhập) nhưng chưa đặt hàng — gửi email nhắc kèm link khôi phục giỏ"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Giỏ hàng bỏ dở' }]}
        actions={
          can('settings.manage') ? (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 /> Cài đặt nhắc
            </Button>
          ) : undefined
        }
      />
      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            {s && (
              <Badge variant="outline" className={s.settings.enabled ? 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400' : 'text-muted-foreground'}>
                Nhắc tự động: {s.settings.enabled ? `bật (sau ${s.settings.firstDelayHours}h${s.settings.secondDelayHours > s.settings.firstDelayHours ? ` và ${s.settings.secondDelayHours}h` : ''})` : 'đang tắt'}
              </Badge>
            )}
          </div>
          <Select value={params.days || '30'} onValueChange={(v) => set({ days: v })}>
            <SelectTrigger className="w-40" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 ngày qua</SelectItem>
              <SelectItem value="30">30 ngày qua</SelectItem>
              <SelectItem value="90">90 ngày qua</SelectItem>
              <SelectItem value="365">12 tháng qua</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Giỏ có email" value={s ? String(s.total) : '…'} hint={s ? `${s.converted} giỏ đã thành đơn` : undefined} />
          <Stat label="Đang bỏ dở" value={s ? String(s.abandoned) : '…'} hint={s ? formatMoney(s.abandonedValue) : undefined} />
          <Stat label="Đã gửi nhắc" value={s ? String(s.reminded) : '…'} />
          <Stat label="Tỉ lệ khôi phục" value={s ? `${Math.round(s.recoveryRate * 1000) / 10}%` : '…'} hint={s ? `${s.recovered} giỏ · ${formatMoney(s.recoveredValue)}` : undefined} />
        </div>

        <StatusTabs value={params.status} onChange={(v) => set({ status: v })} options={[{ value: '', label: 'Tất cả' }, ...STATUS_ORDER.map((st) => ({ value: st, label: ABANDONED_CART_STATUS_LABELS[st] }))]} />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Email, tên thành viên, mã đơn..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            canRemind && (
              <Button size="sm" variant="outline" disabled={bulk.pending} onClick={bulkRemind}>
                {bulk.pending ? <Loader2 className="animate-spin" /> : <Mail />} Gửi nhắc
              </Button>
            )
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          // chỉ cho tích chọn khi có quyền gửi nhắc (thao tác hàng loạt duy nhất)
          selectable={canRemind}
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          onRowClick={(r) => setViewing(r.id)}
          emptyTitle="Chưa có giỏ hàng nào"
          emptyDescription="Giỏ được ghi nhận khi khách nhập email ở trang thanh toán hoặc thành viên đăng nhập rồi thêm sản phẩm vào giỏ."
        />
      </PageBody>

      <AbandonedCartDialog id={viewing} onOpenChange={(o) => !o && setViewing(null)} onRemind={(id) => remind.mutate(id)} reminding={remind.isPending} canRemind={canRemind} />
      <AbandonedCartSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} value={s?.settings} />
    </>
  );
}

export default function AbandonedCartsPage() {
  return (
    <Suspense>
      <AbandonedCartsContent />
    </Suspense>
  );
}
