'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Clock, CreditCard, ExternalLink, Loader2, Mail, MapPin, MoreHorizontal, Package, Pencil, Phone, Printer, RotateCcw, Send, StickyNote, TicketPercent, Truck, User, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { StatusBadge, STATUS_LABELS } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { OrderInvoice, type InvoiceOrder, type StoreInfo } from '@/components/commerce/order-invoice';
import { formatAddress, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, toNum, type Address } from '@/components/commerce/utils';
import { canConfirmPayment, ConfirmPaymentButton, NeedsRefundBadge, providerLabel, providerName, TxStatusBadge, usePaymentProviders, type PaymentTransactionRow } from '@/components/commerce/payments';
import { EditDetailsDialog, EditItemsDialog, LOCKED_STATUSES, openInvoice, RefundDialog, ResendEmailDialog, SOURCE_LABELS, type AdminOrder } from '@/components/commerce/order-dialogs';
import { RefundsSection } from '@/components/commerce/order-refunds';
import { OrderDownloadsSection } from '@/components/commerce/order-downloads';
import { OrderEInvoicesSection } from '@/components/commerce/order-einvoices';
import { OrderCodesCard } from '@/components/digital-codes/order-codes-card';
import { invalidateDigital } from '@/components/digital-codes/shared';
import { OrderShipmentsSection } from '@/components/commerce/order-shipments';
import type { InvoiceRequest, OrderEInvoice } from '@/components/commerce/einvoice';
import type { OrderShipment, OrderShippingMeta } from '@/components/commerce/shipments';
import { api, ApiError, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface OrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  sku: string | null;
  optionValues: Record<string, string> | null;
  image: string | null;
  price: unknown;
  quantity: number;
  total: unknown;
}

interface OrderDetail extends InvoiceOrder, AdminOrder {
  id: string;
  status: string;
  shippingMethod: string | null;
  adminNote: string | null;
  paidAt?: string | null;
  locale: string | null;
  ip: string | null;
  updatedAt: string;
  history: { status: string; note?: string; at: string; by?: string }[] | null;
  user: { id: string; name: string; email: string } | null;
  items: OrderItem[];
  /** Yêu cầu xuất hoá đơn điện tử của khách lúc đặt hàng */
  invoiceRequest?: InvoiceRequest | null;
  /** Hoá đơn điện tử đã lập cho đơn */
  eInvoices?: OrderEInvoice[];
  /** Vận đơn đã tạo qua đơn vị vận chuyển */
  shipments?: OrderShipment[];
  /** Hãng / dịch vụ khách chọn ở trang thanh toán (phí lấy từ API hãng) */
  shippingMeta?: OrderShippingMeta | null;
  /** false = đơn toàn hàng ảo / kho mã: không cần địa chỉ giao hàng, không vận đơn */
  requiresShipping?: boolean;
}

type DialogKind = 'items' | 'details' | 'refund' | 'email' | null;

interface Bootstrap {
  settings: { general?: { siteName?: Record<string, string> }; contact?: StoreInfo; commerce?: { pricesIncludeTax?: boolean } };
}

const NEXT_STEP: Record<string, string> = { PENDING: 'CONFIRMED', CONFIRMED: 'PROCESSING', PROCESSING: 'SHIPPING', SHIPPING: 'COMPLETED' };
/** Đơn đã huỷ / hoàn tiền: kho và mã giảm giá đã được hoàn -> không thể mở lại (API chặn) */
const CLOSED = ['CANCELLED', 'REFUNDED'];
const ADDRESS_FIELDS: { key: keyof Address; label: string; full?: boolean }[] = [
  { key: 'fullName', label: 'Người nhận' },
  { key: 'phone', label: 'Điện thoại' },
  { key: 'line1', label: 'Địa chỉ', full: true },
  { key: 'line2', label: 'Địa chỉ bổ sung', full: true },
  { key: 'ward', label: 'Phường / Xã' },
  { key: 'district', label: 'Quận / Huyện' },
  { key: 'city', label: 'Tỉnh / Thành phố' },
  { key: 'country', label: 'Quốc gia' },
];

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canWrite = can('orders.write');

  const order = useQuery({ queryKey: ['order', id], queryFn: () => api.get<OrderDetail>(`/admin/orders/${id}`) });
  const canPayments = can('payments.read');
  const txs = useQuery({
    queryKey: ['payment-transactions', 'order', id],
    queryFn: () => api.get<Paginated<PaymentTransactionRow>>('/admin/payments/transactions', { orderId: id, limit: 20 }),
    enabled: canPayments,
  });
  const providers = usePaymentProviders(canPayments);
  const boot = useQuery({ queryKey: ['public-bootstrap'], queryFn: () => api.get<Bootstrap>('/public/bootstrap'), staleTime: 10 * 60_000 });

  /**
   * Lựa chọn admin đang sửa (null = chưa sửa -> luôn hiển thị theo dữ liệu server). Nhờ vậy khi đơn đổi ở nơi khác
   * (webhook thanh toán, xác nhận thủ công, tải lại) form tự theo dữ liệu mới, còn lựa chọn đang sửa thì giữ nguyên.
   */
  const [statusDraft, setStatusDraft] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [paymentDraft, setPaymentDraft] = useState<string | null>(null);
  const [adminNote, setAdminNote] = useState('');
  const [address, setAddress] = useState<Address | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const o = order.data;
  const resetDrafts = () => {
    setStatusDraft(null);
    setPaymentDraft(null);
  };
  // chỉ đồng bộ form khi mở đơn khác (không ghi đè ghi chú / lựa chọn đang sửa mỗi khi dữ liệu tải lại)
  const oid = o?.id;
  useEffect(() => {
    const d = qc.getQueryData<OrderDetail>(['order', id]);
    if (!oid || !d) return;
    setStatusDraft(null);
    setPaymentDraft(null);
    setAdminNote(d.adminNote ?? '');
  }, [oid, id, qc]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<OrderDetail>(`/admin/orders/${id}`, body),
    onSuccess: (data, body) => {
      qc.setQueryData<OrderDetail>(['order', id], (old) => (old ? { ...old, ...data, user: old.user } : data));
      void qc.invalidateQueries({ queryKey: ['orders'] });
      // lựa chọn đã gửi thì bỏ bản nháp (form hiển thị lại theo server); lựa chọn chưa gửi giữ nguyên
      if ('status' in body) {
        setStatusNote('');
        setStatusDraft(null);
      }
      if ('paymentStatus' in body) setPaymentDraft(null);
      if ('adminNote' in body) setAdminNote(data.adminNote ?? '');
      if ('shippingAddress' in body) setAddress(null);
      // đổi trạng thái / thanh toán có thể giữ, giao hoặc thu hồi mã (backend xử lý bất đồng bộ qua event)
      // -> làm mới thẻ "Mã đã giao" ngay và thêm một lần sau ~1,5 giây
      invalidateDigital(qc, id);
      setTimeout(() => invalidateDigital(qc, id), 1500);
      toast.success('Đã cập nhật đơn hàng');
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.status === 409) {
        // trạng thái đơn vừa bị người khác đổi -> tải lại và đồng bộ lựa chọn theo dữ liệu mới
        toast.error('Trạng thái đơn vừa được thay đổi bởi người khác. Đã tải lại dữ liệu mới nhất, vui lòng kiểm tra rồi thao tác lại.');
        await order.refetch();
        resetDrafts();
        void qc.invalidateQueries({ queryKey: ['orders'] });
        return;
      }
      toast.error(errorMessage(e));
    },
  });

  if (order.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!o) {
    return (
      <>
        <PageHeader title="Không tìm thấy đơn hàng" breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }]} />
        <PageBody>
          <p className="text-sm text-muted-foreground">{order.error ? errorMessage(order.error) : 'Đơn hàng không tồn tại hoặc đã bị xoá.'}</p>
        </PageBody>
      </>
    );
  }

  const money = (v: unknown) => formatMoney(toNum(v), o.currency);
  const store: StoreInfo = { ...boot.data?.settings.contact, siteName: boot.data?.settings.general?.siteName, pricesIncludeTax: boot.data?.settings.commerce?.pricesIncludeTax };
  const history = [...(o.history ?? [])].reverse();
  const next = NEXT_STEP[o.status];
  const status = statusDraft ?? o.status;
  const paymentStatus = paymentDraft ?? o.paymentStatus;
  const statusChanged = status !== o.status;
  const isClosed = CLOSED.includes(o.status);
  const isLocked = LOCKED_STATUSES.includes(o.status);
  /** còn tiền để hoàn: đã thanh toán (hoặc hoàn một phần) và chưa hoàn hết */
  const canRefund = ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) && toNum(o.total) - toNum(o.refundedTotal) > 0.001;
  /** chỉ khi admin chủ động chọn trạng thái thanh toán khác dữ liệu hiện tại */
  const paymentChanged = paymentDraft != null && paymentDraft !== o.paymentStatus;
  const setStatus = (v: string) => setStatusDraft(v === o.status ? null : v);
  const setPaymentStatus = (v: string) => setPaymentDraft(v === o.paymentStatus ? null : v);

  /** @param withPayment false cho nút "bước tiếp theo": chỉ đổi trạng thái đơn, không gửi kèm trạng thái thanh toán */
  const submitStatus = async (target = status, withPayment = true) => {
    const body: Record<string, unknown> = {};
    if (target !== o.status) {
      if (isClosed && !CLOSED.includes(target)) {
        toast.error('Đơn đã huỷ / hoàn tiền không thể mở lại. Hãy tạo đơn mới.');
        return;
      }
      if (CLOSED.includes(target) && !isClosed) {
        const ok = await confirm({ title: `Chuyển đơn sang "${STATUS_LABELS[target]}"?`, description: 'Số lượng sản phẩm trong đơn sẽ được hoàn lại kho.', destructive: true, confirmText: 'Xác nhận' });
        if (!ok) return;
      }
      body.status = target;
      body.statusNote = statusNote.trim() || undefined;
    }
    if (withPayment && paymentChanged) body.paymentStatus = paymentDraft;
    if (!Object.keys(body).length) return;
    patch.mutate(body);
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Đơn hàng <span className="font-mono">#{o.code}</span>
            <StatusBadge status={o.status} />
          </span>
        }
        description={`Đặt lúc ${formatDate(o.createdAt)} · ${timeAgo(o.createdAt)}`}
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: `#${o.code}` }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void openInvoice(o.id, true)}>
              <Printer /> In hoá đơn
            </Button>
            {canWrite && (
              <>
                <Button variant="outline" size="sm" onClick={() => setDialog('email')} disabled={!o.customerEmail} title={o.customerEmail ? undefined : 'Đơn không có email khách'}>
                  <Send /> Gửi lại email
                </Button>
                {canRefund && (
                  <Button variant="outline" size="sm" onClick={() => setDialog('refund')}>
                    <RotateCcw /> Hoàn tiền
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="Thao tác khác">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDialog('items')} disabled={isLocked}>
                      <Package /> Sửa dòng hàng
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog('details')}>
                      <UserCog /> Sửa thông tin khách / thanh toán
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void openInvoice(o.id, false)}>
                      <Printer /> Xem hoá đơn (tab mới)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => window.print()}>
                      <Printer /> In nhanh (trang này)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        }
      />
      <PageBody>
        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-6">
            <Section
              title={`Sản phẩm (${o.items.length})`}
              actions={
                <div className="flex items-center gap-2">
                  <StatusBadge status={o.paymentStatus} />
                  {canWrite && !isLocked && (
                    <Button variant="ghost" size="sm" onClick={() => setDialog('items')}>
                      <Pencil /> Sửa dòng hàng
                    </Button>
                  )}
                </div>
              }
            >
              <div className="-mx-4 -mt-4 divide-y">
                {o.items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 px-4 py-3">
                    {it.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.image} alt="" className="size-14 shrink-0 rounded-md border object-cover" />
                    ) : (
                      <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Package className="size-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {it.productId ? (
                        <Link href={`/products/${it.productId}`} className="line-clamp-2 font-medium hover:text-primary">
                          {it.name}
                        </Link>
                      ) : (
                        <span className="line-clamp-2 font-medium">{it.name}</span>
                      )}
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {Object.entries(it.optionValues ?? {}).map(([k, v]) => (
                          <Badge key={k} variant="outline" className="font-normal">
                            {k}: {v}
                          </Badge>
                        ))}
                        {it.sku && <span className="font-mono">SKU: {it.sku}</span>}
                      </div>
                    </div>
                    <div className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                      {money(it.price)} × {it.quantity}
                    </div>
                    <div className="w-28 whitespace-nowrap text-right font-medium tabular-nums">{money(it.total)}</div>
                  </div>
                ))}
              </div>
              <dl className="ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 border-t pt-4 text-sm">
                <dt className="text-muted-foreground">Tạm tính</dt>
                <dd className="text-right tabular-nums">{money(o.subtotal)}</dd>
                {toNum(o.discountTotal) > 0 && (
                  <>
                    <dt className="flex items-center gap-1.5 text-muted-foreground">
                      Giảm giá
                      {o.couponCode && (
                        <Badge variant="secondary" className="gap-1 font-mono">
                          <TicketPercent /> {o.couponCode}
                        </Badge>
                      )}
                    </dt>
                    <dd className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">-{money(o.discountTotal)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Phí vận chuyển{o.shippingMethodName ? ` (${o.shippingMethodName})` : ''}</dt>
                <dd className="text-right tabular-nums">{toNum(o.shippingTotal) > 0 ? money(o.shippingTotal) : 'Miễn phí'}</dd>
                {toNum(o.taxTotal) > 0 && (
                  <>
                    <dt className="text-muted-foreground">Thuế{store.pricesIncludeTax ? ' (đã gồm trong giá)' : ''}</dt>
                    <dd className="text-right tabular-nums">{money(o.taxTotal)}</dd>
                  </>
                )}
                <dt className="border-t pt-2 font-semibold">Tổng cộng</dt>
                <dd className="border-t pt-2 text-right text-lg font-bold tabular-nums">{money(o.total)}</dd>
                {toNum(o.refundedTotal) > 0 && (
                  <>
                    <dt className="text-muted-foreground">Đã hoàn tiền</dt>
                    <dd className="text-right tabular-nums text-red-600 dark:text-red-400">-{money(o.refundedTotal)}</dd>
                  </>
                )}
                <dt className="text-xs text-muted-foreground">Thanh toán</dt>
                <dd className="text-right text-xs text-muted-foreground">{PAYMENT_METHODS[o.paymentMethod] ?? providerLabel(o.paymentMethod, providers.data)}</dd>
              </dl>
            </Section>

            {canPayments && (txs.data?.data.length || o.paidAt || !(o.paymentMethod in PAYMENT_METHODS)) ? (
              <Section
                title="Thanh toán online"
                description={o.paidAt ? `Đã thanh toán lúc ${formatDate(o.paidAt)}` : 'Các giao dịch tạo qua cổng thanh toán cho đơn này'}
                actions={
                  <div className="flex items-center gap-2">
                    {o.paidAt && <StatusBadge status="PAID" />}
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/orders/payments?search=${encodeURIComponent(o.code)}`}>Xem tất cả</Link>
                    </Button>
                  </div>
                }
              >
                {txs.isLoading ? (
                  <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                ) : !txs.data?.data.length ? (
                  <p className="text-sm text-muted-foreground">{o.paidAt ? 'Đơn được đánh dấu đã thanh toán, không có giao dịch online.' : 'Khách chưa tạo giao dịch thanh toán online nào.'}</p>
                ) : (
                  <div className="-mx-4 -my-4 divide-y">
                    {txs.data.data.map((t) => (
                      <div key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                          <CreditCard className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{providerName(t.provider, providers.data)}</span>
                            <TxStatusBadge status={t.status} />
                            {t.needsRefund && <NeedsRefundBadge />}
                            <span className="font-semibold tabular-nums">{formatMoney(toNum(t.amount), t.currency)}</span>
                          </div>
                          {t.note && <p className={cn('text-xs', t.needsRefund ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>{t.note}</p>}
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            <span>
                              Mã GD: <span className="font-mono text-foreground">{t.providerOrderCode}</span>
                            </span>
                            {t.reference && (
                              <span>
                                Tham chiếu: <span className="font-mono text-foreground">{t.reference}</span>
                              </span>
                            )}
                            {t.transferContent && (
                              <span>
                                Nội dung CK: <span className="font-mono text-foreground">{t.transferContent}</span>
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                            <span>Tạo lúc {formatDate(t.createdAt)}</span>
                            {t.paidAt && <span className="text-emerald-700 dark:text-emerald-400">Thanh toán lúc {formatDate(t.paidAt)}</span>}
                            {!t.paidAt && t.expiresAt && <span>{t.status === 'PENDING' ? 'Hết hạn' : 'Hạn'} {formatDate(t.expiresAt)}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {t.checkoutUrl && t.status === 'PENDING' && (
                            <Button variant="ghost" size="icon-sm" asChild title="Mở link thanh toán">
                              <a href={t.checkoutUrl} target="_blank" rel="noreferrer">
                                <ExternalLink />
                              </a>
                            </Button>
                          )}
                          {canWrite && canConfirmPayment(t, o) && <ConfirmPaymentButton tx={{ ...t, order: t.order ?? { id: o.id, code: o.code, customerName: o.customerName, status: o.status, paymentStatus: o.paymentStatus } }} providerLabel={providerName(t.provider, providers.data)} />}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            ) : null}

            {/* Mã / tài khoản đã giao (sản phẩm bán theo kho mã) */}
            <OrderCodesCard orderId={o.id} />

            <OrderDownloadsSection orderId={o.id} paid={o.paymentStatus === 'PAID'} hasDigital={!!(o as { hasDigital?: boolean }).hasDigital} />

            <RefundsSection
              order={o}
              actions={
                canWrite && canRefund ? (
                  <Button variant="outline" size="sm" onClick={() => setDialog('refund')}>
                    <RotateCcw /> Hoàn tiền
                  </Button>
                ) : undefined
              }
            />

            {o.note && (
              <Section title="Ghi chú của khách">
                <p className="whitespace-pre-line text-sm">{o.note}</p>
              </Section>
            )}

            <Section title="Lịch sử đơn hàng">
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">Chưa có lịch sử</p>
              ) : (
                <ol className="relative space-y-5 border-l pl-6">
                  {history.map((h, i) => (
                    <li key={i} className="relative">
                      <span className={cn('absolute -left-[31px] flex size-4 items-center justify-center rounded-full border-2 border-background', i === 0 ? 'bg-primary' : 'bg-muted-foreground/40')}>
                        {i === 0 && <Check className="size-2.5 text-primary-foreground" />}
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={h.status} />
                        <span className="text-xs text-muted-foreground">
                          {formatDate(h.at)}
                          {h.by && ` · ${h.by}`}
                        </span>
                      </div>
                      {h.note && <p className="mt-1 text-sm">{h.note}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>

          <div className="space-y-6">
            {canWrite && (
              <Section title="Xử lý đơn hàng">
                {next && (
                  <Button className="w-full" onClick={() => submitStatus(next, false)} disabled={patch.isPending}>
                    {patch.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                    Chuyển sang “{STATUS_LABELS[next]}”
                  </Button>
                )}
                <Field label="Trạng thái đơn" help={isClosed ? 'Đơn đã huỷ / hoàn tiền: kho và mã giảm giá đã được hoàn nên không thể mở lại. Chỉ có thể chuyển giữa “Đã huỷ” và “Hoàn tiền”; cần bán lại hãy tạo đơn mới.' : undefined}>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORDER_STATUSES.map((s) => (
                        <SelectItem key={s.value} value={s.value} disabled={isClosed && !CLOSED.includes(s.value) && s.value !== o.status}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Ghi chú thay đổi" help="Lưu vào lịch sử đơn hàng">
                  <Textarea value={statusNote} onChange={(e) => setStatusNote(e.target.value)} rows={2} placeholder="Vd: Đã gọi xác nhận với khách" />
                </Field>
                <Field label="Trạng thái thanh toán">
                  <Select value={paymentStatus} onValueChange={setPaymentStatus}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_STATUSES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button variant={next ? 'outline' : 'default'} className="w-full" disabled={(!statusChanged && !paymentChanged) || patch.isPending} onClick={() => submitStatus()}>
                  Lưu trạng thái
                </Button>
              </Section>
            )}

            <Section
              title="Khách hàng"
              actions={
                canWrite && (
                  <Button variant="ghost" size="icon-sm" onClick={() => setDialog('details')} aria-label="Sửa thông tin khách">
                    <Pencil />
                  </Button>
                )
              }
            >
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <User className="size-4 text-muted-foreground" />
                  {o.customerName}
                </div>
                <a href={`tel:${o.customerPhone}`} className="flex items-center gap-2 hover:text-primary">
                  <Phone className="size-4 text-muted-foreground" />
                  {o.customerPhone}
                </a>
                {o.customerEmail && (
                  <a href={`mailto:${o.customerEmail}`} className="flex items-center gap-2 break-all hover:text-primary">
                    <Mail className="size-4 text-muted-foreground" />
                    {o.customerEmail}
                  </a>
                )}
                {o.billingAddress && formatAddress(o.billingAddress) && (
                  <div className="border-t pt-2 text-xs text-muted-foreground">
                    Địa chỉ thanh toán: <span className="text-foreground">{o.billingAddress.fullName ? `${o.billingAddress.fullName} · ` : ''}{formatAddress(o.billingAddress)}</span>
                  </div>
                )}
                <div className="border-t pt-2 text-xs text-muted-foreground">
                  {o.user ? (
                    <>
                      Thành viên:{' '}
                      <Link href={`/users/${o.user.id}`} className="text-primary hover:underline">
                        {o.user.name}
                      </Link>
                    </>
                  ) : (
                    'Khách vãng lai (không đăng nhập)'
                  )}
                </div>
              </div>
            </Section>

            {o.requiresShipping !== false && (
            <Section
              title="Địa chỉ giao hàng"
              actions={
                canWrite &&
                !address && (
                  <Button variant="ghost" size="icon-sm" onClick={() => setAddress({ ...(o.shippingAddress ?? {}) })} aria-label="Sửa địa chỉ">
                    <Pencil />
                  </Button>
                )
              }
            >
              {address ? (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!address.fullName?.trim() || !address.phone?.trim() || !address.line1?.trim()) return toast.error('Vui lòng nhập người nhận, điện thoại và địa chỉ');
                    patch.mutate({ shippingAddress: address });
                  }}
                >
                  <div className="grid grid-cols-2 gap-3">
                    {ADDRESS_FIELDS.map((f) => (
                      <Field key={f.key} label={f.label} className={f.full ? 'col-span-2' : undefined}>
                        <Input value={address[f.key] ?? ''} onChange={(e) => setAddress({ ...address, [f.key]: e.target.value })} />
                      </Field>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setAddress(null)}>
                      Huỷ
                    </Button>
                    <Button type="submit" size="sm" disabled={patch.isPending}>
                      {patch.isPending && <Loader2 className="animate-spin" />}
                      Lưu địa chỉ
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex gap-2 text-sm">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="font-medium">
                      {o.shippingAddress?.fullName || o.customerName}
                      {o.shippingAddress?.phone && <span className="font-normal text-muted-foreground"> · {o.shippingAddress.phone}</span>}
                    </div>
                    <div className="text-muted-foreground">{formatAddress(o.shippingAddress) || '—'}</div>
                  </div>
                </div>
              )}
            </Section>
            )}

            {/* Vận chuyển: hãng khách chọn + vận đơn đã tạo + nút tạo vận đơn (ẩn với đơn không cần giao hàng) */}
            {o.requiresShipping !== false && <OrderShipmentsSection order={o} shipments={o.shipments} shippingMeta={o.shippingMeta} onChanged={() => void qc.invalidateQueries({ queryKey: ['order', id] })} />}

            {/* Hoá đơn điện tử của đơn (yêu cầu của khách + danh sách HĐ) */}
            <OrderEInvoicesSection orderId={o.id} currency={o.currency} invoiceRequest={o.invoiceRequest} eInvoices={o.eInvoices} />

            <Section title="Ghi chú nội bộ" description="Chỉ quản trị viên nhìn thấy">
              <Textarea value={adminNote} onChange={(e) => setAdminNote(e.target.value)} rows={4} disabled={!canWrite} placeholder="Ghi chú cho nhân viên xử lý đơn..." />
              {canWrite && (
                <Button size="sm" variant="outline" className="w-full" disabled={adminNote === (o.adminNote ?? '') || patch.isPending} onClick={() => patch.mutate({ adminNote })}>
                  <StickyNote /> Lưu ghi chú
                </Button>
              )}
            </Section>

            <Section title="Thông tin khác">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Nguồn</dt>
                <dd className="text-right">{SOURCE_LABELS[o.source] ?? o.source}</dd>
                {o.createdBy && (
                  <>
                    <dt className="text-muted-foreground">Người tạo</dt>
                    <dd className="text-right">
                      <Link href={`/users/${o.createdBy.id}`} className="text-primary hover:underline">
                        {o.createdBy.name}
                      </Link>
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Vận chuyển</dt>
                <dd className="flex items-center justify-end gap-1 text-right">
                  <Truck className="size-3 text-muted-foreground" />
                  {o.shippingMethodName ?? '—'}
                </dd>
                <dt className="text-muted-foreground">Ngôn ngữ</dt>
                <dd className="text-right uppercase">{o.locale ?? '—'}</dd>
                <dt className="text-muted-foreground">Địa chỉ IP</dt>
                <dd className="text-right font-mono text-xs">{o.ip ?? '—'}</dd>
                <dt className="text-muted-foreground">Cập nhật</dt>
                <dd className="flex items-center justify-end gap-1 text-right text-xs">
                  <Clock className="size-3" />
                  {timeAgo(o.updatedAt)}
                </dd>
              </dl>
            </Section>
          </div>
        </div>
      </PageBody>
      <OrderInvoice order={o} store={store} />
      {dialog === 'items' && <EditItemsDialog order={o} onClose={() => setDialog(null)} />}
      {dialog === 'details' && <EditDetailsDialog order={o} onClose={() => setDialog(null)} />}
      {dialog === 'refund' && <RefundDialog order={o} onClose={() => setDialog(null)} />}
      {dialog === 'email' && <ResendEmailDialog order={o} onClose={() => setDialog(null)} />}
    </>
  );
}
