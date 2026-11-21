'use client';

/**
 * Nhật ký thanh toán online dùng chung: tab Giao dịch (qua các cổng) + tab Nhật ký webhook (callback cổng gửi về).
 * Hiện ở Đơn hàng › Giao dịch thanh toán và Nhật ký hệ thống › Thanh toán. Tab con + bộ lọc lưu trên URL.
 */
import Link from 'next/link';
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Calendar, Check, CheckCircle2, Copy, ExternalLink, Link2Off, ShieldAlert, ShieldCheck, Trash2, Webhook, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { canConfirmPayment, ConfirmPaymentButton, isWalletTopup, NeedsRefundBadge, providerName, TX_STATUSES, TxStatusBadge, usePaymentProviders, type PaymentProviderInfo, type PaymentTransactionRow } from '@/components/commerce/payments';
import { toNum } from '@/components/commerce/utils';
import { api, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

interface WebhookLog {
  id: string;
  provider: string;
  payload: unknown;
  valid: boolean;
  matched: boolean;
  note: string | null;
  ip: string | null;
  createdAt: string;
}

function ProviderSelect({ value, onChange, providers }: { value: string; onChange: (v: string) => void; providers?: PaymentProviderInfo[] }) {
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger className="w-44">
        <SelectValue placeholder="Cổng thanh toán" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Tất cả cổng</SelectItem>
        {providers?.map((p) => (
          <SelectItem key={p.key} value={p.key}>
            <span className="font-medium">{providerName(p.key, providers)}</span>
            {!p.enabled && <span className="text-xs text-muted-foreground"> (đang tắt)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CopyText({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn('inline-flex items-center gap-1 text-muted-foreground hover:text-foreground', className)}
      title="Sao chép"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          toast.success('Đã sao chép');
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="size-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3" />}
    </button>
  );
}

interface PaymentTransactionsResponse extends Paginated<PaymentTransactionRow> {
  summary?: {
    paidCount: number;
    paidAmount: number;
    receivedAmount: number;
    paidUsdt?: number;
  };
}

const DATE_PRESETS: { value: string; label: string }[] = [
  { value: 'all', label: 'Tất cả thời gian' },
  { value: 'today', label: 'Hôm nay' },
  { value: 'yesterday', label: 'Hôm qua' },
  { value: 'daybefore', label: 'Hôm kia' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
  { value: 'this_month', label: 'Tháng này' },
  { value: 'last_month', label: 'Tháng trước' },
];

/** Lọc nhanh "Cần hoàn tiền": API có needsRefund=1 */
const REFUND_FILTER = 'REFUND';

function TransactionsTab({ params, set, page, limit }: ReturnType<typeof useListParams<Record<string, string>>>) {
  const { can } = useAuth();
  const canConfirm = can('orders.write');
  // xác nhận giao dịch nạp ví: route cần orders.write, cộng tiền vào ví cần thêm users.wallet (API cũng kiểm)
  const canConfirmWallet = canConfirm && can('users.wallet');
  const providers = usePaymentProviders();
  const refundOnly = params.status === REFUND_FILTER;
  const hasActiveFilter = Boolean(params.search || params.purpose || params.provider || params.range || params.from || params.to || params.status);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    queryKey: ['payment-transactions', params.status, params.provider, params.purpose, params.range, params.from, params.to, params.search, page, limit],
    queryFn: () =>
      api.get<PaymentTransactionsResponse>('/admin/payments/transactions', {
        status: refundOnly ? undefined : params.status,
        needsRefund: refundOnly ? '1' : undefined,
        provider: params.provider,
        purpose: params.purpose || undefined,
        range: params.from || params.to ? undefined : params.range || undefined,
        from: params.from || undefined,
        to: params.to || undefined,
        search: params.search,
        page,
        limit,
      }),
  });
  const refundCount = useQuery({
    queryKey: ['payment-transactions', 'refund-count'],
    queryFn: () => api.get<Paginated<PaymentTransactionRow>>('/admin/payments/transactions', { needsRefund: '1', limit: 1 }),
  });
  const rows = list.data?.data;
  const meta = list.data?.meta;
  const summary = list.data?.summary;
  const showUsdtCol = params.provider === 'usdt' || Boolean(rows?.some((r) => r.provider === 'usdt'));

  const columns: Column<PaymentTransactionRow>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'order',
      header: 'Đơn hàng / Nạp ví',
      cell: (r) =>
        r.order ? (
          <div className="min-w-0">
            <Link href={`/orders/${r.order.id}`} className="font-mono font-semibold hover:text-primary">
              #{r.order.code}
            </Link>
            <div className="line-clamp-1 text-xs text-muted-foreground">{r.order.customerName}</div>
          </div>
        ) : isWalletTopup(r) ? (
          // giao dịch nạp ví: không có đơn, hiện "Nạp ví – email" (link tới trang thành viên)
          <div className="min-w-0 text-sm">
            <span className="font-medium text-violet-700 dark:text-violet-300">Nạp ví</span>
            {' – '}
            {r.user ? (
              <Link href={`/users/${r.user.id}`} className="hover:text-primary" title={r.user.name}>
                {r.user.email}
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">(thành viên đã xoá)</span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'provider',
      header: 'Cổng',
      cell: (r) => (
        <Badge variant="outline" className="font-medium">
          {providerName(r.provider, providers.data)}
        </Badge>
      ),
    },
    ...(showUsdtCol
      ? [
          {
            key: 'usdtAmount',
            header: 'Số USDT',
            headClassName: 'text-right',
            className: 'text-right',
            cell: (r: PaymentTransactionRow) =>
              r.provider === 'usdt' && r.usdtAmount != null ? (
                <div className="whitespace-nowrap tabular-nums">
                  <div className="font-semibold text-emerald-700 dark:text-emerald-400">
                    {r.usdtAmount.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(r.usdtAmount) ? 0 : 2, maximumFractionDigits: 2 })} USDT
                  </div>
                  {r.usdtRate ? (
                    <div className="text-[11px] text-muted-foreground">
                      Tỷ giá: {formatMoney(r.usdtRate, 'VND')}
                    </div>
                  ) : null}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    {
      key: 'amount',
      header: 'Số tiền',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => <span className="whitespace-nowrap font-semibold tabular-nums">{formatMoney(toNum(r.amount), r.currency)}</span>,
    },
    {
      key: 'codes',
      header: 'Mã GD cổng / Nội dung CK',
      cell: (r) => (
        <div className="max-w-64 space-y-0.5 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Mã GD:</span>
            <span className="truncate font-mono">{r.providerOrderCode}</span>
            <CopyText text={r.providerOrderCode} />
          </div>
          {r.transferContent && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Nội dung:</span>
              <span className="truncate font-mono font-medium">{r.transferContent}</span>
              <CopyText text={r.transferContent} />
            </div>
          )}
          {r.reference && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Tham chiếu:</span>
              <span className="truncate font-mono">{r.reference}</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="max-w-56 space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            <TxStatusBadge status={r.status} />
            {r.needsRefund && <NeedsRefundBadge />}
          </div>
          {r.note && (
            <p className={cn('line-clamp-2 text-xs', r.needsRefund ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')} title={r.note}>
              {r.note}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'paidAt',
      header: 'Thanh toán lúc',
      cell: (r) =>
        r.paidAt ? (
          <span className="whitespace-nowrap text-xs text-emerald-700 dark:text-emerald-400">{formatDate(r.paidAt)}</span>
        ) : r.expiresAt && r.status === 'PENDING' ? (
          <span className="whitespace-nowrap text-xs text-muted-foreground">Hết hạn {timeAgo(r.expiresAt)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          {(isWalletTopup(r) ? canConfirmWallet : canConfirm) && canConfirmPayment(r, r.order) && <ConfirmPaymentButton tx={r} providerLabel={providerName(r.provider, providers.data)} size="xs" />}
          {r.checkoutUrl && r.status === 'PENDING' && (
            <Button variant="ghost" size="icon-xs" asChild title="Mở trang thanh toán của cổng">
              <a href={r.checkoutUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <StatusTabs
        value={params.status}
        onChange={(v) => set({ status: v })}
        options={[
          { value: '', label: 'Tất cả' },
          ...TX_STATUSES.map((s) => ({ value: s.value, label: s.label })),
          { value: REFUND_FILTER, label: 'Cần hoàn tiền', count: refundCount.data?.meta.total, highlight: true },
        ]}
      />
      {refundOnly && (
        <p className="text-xs text-muted-foreground">
          Giao dịch đã nhận tiền nhưng đơn đã huỷ hoặc khách trả trùng — liên hệ khách để hoàn tiền..
        </p>
      )}
      <ListToolbar
        search={params.search}
        onSearchChange={(v) => set({ search: v })}
        placeholder="Mã đơn, email, mã GD cổng, mã tham chiếu..."
        filters={
          <>
            {/* lọc theo mục đích giao dịch: thanh toán đơn / nạp ví */}
            <Select value={params.purpose || 'all'} onValueChange={(v) => set({ purpose: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Loại giao dịch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="order">Đơn hàng</SelectItem>
                <SelectItem value="wallet">Nạp ví</SelectItem>
              </SelectContent>
            </Select>
            <ProviderSelect value={params.provider} onChange={(v) => set({ provider: v })} providers={providers.data} />
            {/* Lọc nhanh theo mốc thời gian (giờ Việt Nam) */}
            <Select
              value={params.from || params.to ? 'custom' : params.range || 'all'}
              onValueChange={(v) => {
                if (v === 'custom') return;
                set({ range: v === 'all' ? '' : v, from: '', to: '' });
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Thời gian" />
              </SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
                {(params.from || params.to) && <SelectItem value="custom">Tuỳ chọn ngày</SelectItem>}
              </SelectContent>
            </Select>
            {/* Chọn khoảng Từ ngày -> Đến ngày giống CMSNT */}
            <div className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs shadow-xs">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                type="date"
                value={params.from || ''}
                onChange={(e) => set({ from: e.target.value, range: '' })}
                title="Từ ngày"
                className="bg-transparent text-xs outline-none"
              />
              <span className="text-muted-foreground">→</span>
              <input
                type="date"
                value={params.to || ''}
                onChange={(e) => set({ to: e.target.value, range: '' })}
                title="Đến ngày"
                className="bg-transparent text-xs outline-none"
              />
            </div>
            {hasActiveFilter && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => set({ status: '', purpose: '', provider: '', range: '', from: '', to: '', search: '' })}
              >
                <Trash2 className="size-3.5" /> Xoá lọc
              </Button>
            )}
          </>
        }
      />
      {summary && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3.5 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Đã thanh toán:{' '}
              <strong className="font-bold text-red-600 tabular-nums dark:text-red-400">
                {formatMoney(summary.paidAmount, 'VND')}
              </strong>
            </span>
            <span className="text-muted-foreground">|</span>
            <span>
              Thực nhận:{' '}
              <strong className="font-bold text-blue-600 tabular-nums dark:text-blue-400">
                {formatMoney(summary.receivedAmount, 'VND')}
              </strong>
            </span>
            {typeof summary.paidUsdt === 'number' && summary.paidUsdt > 0 && (
              <>
                <span className="text-muted-foreground">|</span>
                <span>
                  Tổng USDT:{' '}
                  <strong className="font-bold text-emerald-700 tabular-nums dark:text-emerald-400">
                    {summary.paidUsdt.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(summary.paidUsdt) ? 0 : 2, maximumFractionDigits: 2 })} USDT
                  </strong>
                </span>
              </>
            )}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {summary.paidCount.toLocaleString('vi-VN')} giao dịch thành công
          </span>
        </div>
      )}
      <DataTable
        columns={columns}
        data={rows}
        meta={meta}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        onPageChange={(p) => set({ page: p })}
        onLimitChange={(l) => set({ limit: l })}
        emptyTitle={refundOnly ? 'Không có giao dịch cần hoàn tiền' : 'Chưa có giao dịch thanh toán'}
        emptyDescription={refundOnly ? 'Không có khoản tiền nào cần hoàn cho khách trong các giao dịch gần đây.' : 'Giao dịch được tạo khi khách chọn thanh toán online (PayOS, SePay, Pay2S...) ở trang đặt hàng.'}
      />
      {summary && (
        <div className="px-1 text-xs sm:text-sm">
          Đã thanh toán:{' '}
          <strong className="font-bold text-red-600 tabular-nums dark:text-red-400">
            {formatMoney(summary.paidAmount, 'VND')}
          </strong>{' '}
          <span className="mx-1 text-muted-foreground">|</span> Thực nhận:{' '}
          <strong className="font-bold text-blue-600 tabular-nums dark:text-blue-400">
            {formatMoney(summary.receivedAmount, 'VND')}
          </strong>
        </div>
      )}
    </div>
  );
}

function LogsTab({ params, set, page, limit }: ReturnType<typeof useListParams<Record<string, string>>>) {
  const providers = usePaymentProviders();
  const [viewing, setViewing] = useState<WebhookLog | null>(null);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    queryKey: ['payment-logs', params.provider, page, limit],
    queryFn: () => api.get<Paginated<WebhookLog>>('/admin/payments/logs', { provider: params.provider, page, limit }),
  });

  const columns: Column<WebhookLog>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt, 'dd/MM/yyyy HH:mm:ss')}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'provider',
      header: 'Cổng',
      cell: (r) => (
        <Badge variant="outline" className="font-medium">
          {providerName(r.provider, providers.data)}
        </Badge>
      ),
    },
    {
      key: 'valid',
      header: 'Xác thực',
      cell: (r) =>
        r.valid ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="size-4" /> Hợp lệ
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
            <ShieldAlert className="size-4" /> Không hợp lệ
          </span>
        ),
    },
    {
      key: 'matched',
      header: 'Khớp đơn',
      cell: (r) =>
        r.matched ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" /> Đã khớp
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Link2Off className="size-4" /> Không khớp
          </span>
        ),
    },
    { key: 'note', header: 'Ghi chú', cell: (r) => <span className="line-clamp-2 max-w-md text-sm">{r.note || '—'}</span> },
    { key: 'ip', header: 'IP', cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.ip ?? '—'}</span> },
  ];

  return (
    <div className="space-y-4">
      <ListToolbar filters={<ProviderSelect value={params.provider} onChange={(v) => set({ provider: v })} providers={providers.data} />} />
      <DataTable
        columns={columns}
        data={list.data?.data}
        meta={list.data?.meta}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        onPageChange={(p) => set({ page: p })}
        onLimitChange={(l) => set({ limit: l })}
        onRowClick={setViewing}
        emptyTitle="Chưa có webhook nào"
        emptyDescription="Mỗi lần cổng thanh toán gọi về website sẽ được ghi lại tại đây để đối soát."
      />

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Webhook className="size-4" /> Webhook {providerName(viewing.provider, providers.data)}
                </DialogTitle>
                <DialogDescription>
                  {formatDate(viewing.createdAt, 'dd/MM/yyyy HH:mm:ss')} · IP {viewing.ip ?? '—'}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge className={cn('border-transparent', viewing.valid ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300')}>
                  {viewing.valid ? <ShieldCheck /> : <XCircle />} {viewing.valid ? 'Chữ ký hợp lệ' : 'Không hợp lệ'}
                </Badge>
                <Badge className={cn('border-transparent', viewing.matched ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400')}>{viewing.matched ? 'Đã khớp giao dịch' : 'Không khớp giao dịch'}</Badge>
                {viewing.note && <span className="text-muted-foreground">{viewing.note}</span>}
              </div>
              <div className="relative min-h-0 flex-1">
                <div className="absolute right-2 top-2">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => void navigator.clipboard.writeText(JSON.stringify(viewing.payload, null, 2)).then(() => toast.success('Đã sao chép payload'))}
                  >
                    <Copy /> Sao chép
                  </Button>
                </div>
                <pre className="max-h-[60vh] overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-100">{JSON.stringify(viewing.payload, null, 2)}</pre>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Thân trang: chọn tab con Giao dịch / Nhật ký webhook rồi hiện bảng tương ứng (cần bọc Suspense ở trang) */
export function PaymentLogsView() {
  const lp = useListParams<Record<string, string>>({ tab: 'transactions', status: '', provider: '', purpose: '', range: '', from: '', to: '', search: '' });
  const tab = lp.params.tab === 'logs' ? 'logs' : 'transactions';
  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => lp.set({ tab: v, status: '', purpose: '', range: '', from: '', to: '', search: '' })}>
        <TabsList>
          <TabsTrigger value="transactions">Giao dịch</TabsTrigger>
          <TabsTrigger value="logs">Nhật ký webhook</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'transactions' ? <TransactionsTab {...lp} /> : <LogsTab {...lp} />}
    </div>
  );
}
