'use client';

/**
 * Thẻ "Mã đã giao" trong chi tiết đơn hàng (admin):
 * - mỗi dòng hàng: thông tin khách nhập khi mua (fields) + các mã đã giữ / giao (bản che, trạng thái, đã xem, báo lỗi)
 * - hành động từng mã: xem nội dung, đổi mã, thu hồi
 * - hành động đơn: Giao mã ngay (force khi chưa thanh toán), Giao tay cho một dòng, Gửi lại email giao mã
 * Ẩn hẳn nếu đơn không có dòng bán theo kho mã và không có thông tin khách nhập.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, KeyRound, Loader2, MoreHorizontal, PackageCheck, PenLine, RefreshCw, Send, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminDigitalCode, AdminOrderCodes } from '@cmsnt/shared';
import { Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CodeStatusBadge, DIGITAL_QK, invalidateDigital, ManualDeliverDialog, OrderCodeStatusBadge, ReplaceCodeDialog, ReportStatusBadge, RevealCodeDialog, RevokeCodeDialog } from './shared';

type OrderItemCodes = AdminOrderCodes['items'][number];

/**
 * Số mã đã giao của một dòng hàng: ưu tiên `delivered` backend trả về (đếm đúng quy tắc server);
 * chưa có thì tự đếm SOLD + REVOKED không phải mã thay thế (mã đã giao rồi bị thu hồi vẫn tính là đã giao).
 */
function deliveredCount(it: OrderItemCodes): number {
  const fromApi = (it as OrderItemCodes & { delivered?: number }).delivered;
  if (typeof fromApi === 'number') return fromApi;
  return it.codes.filter((c) => c.status === 'SOLD' || (c.status === 'REVOKED' && !c.replacesId)).length;
}

export function OrderCodesCard({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canManage = can('digital_codes.manage');
  const canReveal = can('digital_codes.reveal');

  const data = useQuery({ queryKey: [DIGITAL_QK, 'order', orderId], queryFn: () => api.get<AdminOrderCodes>(`/admin/digital-codes/by-order/${orderId}`), retry: false });

  const [reveal, setReveal] = useState<AdminDigitalCode | null>(null);
  const [replace, setReplace] = useState<AdminDigitalCode | null>(null);
  const [revoke, setRevoke] = useState<AdminDigitalCode | null>(null);
  const [manual, setManual] = useState<OrderItemCodes | null>(null);

  /** Giao mã ngay: chuyển mã đang giữ sang đã giao + cấp bù từ kho */
  const deliver = useMutation({
    mutationFn: (force: boolean) => api.post<AdminOrderCodes>(`/admin/digital-codes/by-order/${orderId}/deliver`, { force }),
    onSuccess: (r) => {
      qc.setQueryData([DIGITAL_QK, 'order', orderId], r);
      toast.success(r.codeStatus === 'delivered' ? 'Đã giao đủ mã cho đơn' : 'Đã giao mã còn trong kho, đơn vẫn còn thiếu mã');
      invalidateDigital(qc, orderId);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  /** Gửi lại email giao mã cho khách */
  const resend = useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/admin/digital-codes/by-order/${orderId}/resend`),
    onSuccess: () => toast.success('Đã gửi lại email giao mã'),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d = data.data;
  // ẩn thẻ khi lỗi (vd thiếu quyền) hoặc đơn không có sản phẩm kho mã / thông tin khách nhập
  if (data.isLoading || !d) return null;
  const items = d.items.filter((it) => it.codeDelivery || it.fields.length > 0 || it.codes.length > 0);
  if (!items.length) return null;

  const hasCodeItems = items.some((it) => it.codeDelivery);
  // tổng số mã còn thiếu; = 0 nghĩa là mọi dòng đã đủ -> ẩn nút "Giao mã ngay"
  const missing = items.reduce((s, it) => (it.codeDelivery ? s + Math.max(0, it.quantity - deliveredCount(it)) : s), 0);
  const anySold = items.some((it) => it.codes.some((c) => c.status === 'SOLD'));

  const runDeliver = async () => {
    if (!d.paid) {
      const ok = await confirm({ title: 'Đơn chưa thanh toán', description: 'Bạn vẫn muốn giao mã cho khách ngay bây giờ? Mã sẽ được đánh dấu đã giao và khách xem được.', confirmText: 'Vẫn giao mã', destructive: true });
      if (!ok) return;
    }
    deliver.mutate(!d.paid);
  };

  return (
    <Section
      title={
        <span className="flex flex-wrap items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" /> Mã / tài khoản đã giao
          <OrderCodeStatusBadge status={d.codeStatus} />
        </span>
      }
      description={d.paid ? (missing > 0 ? `Còn thiếu ${missing} mã — nhập thêm mã vào kho hoặc giao tay` : 'Khách xem mã ở trang đơn hàng / tài khoản và trong email') : 'Mã đang được giữ, sẽ giao khi đơn được thanh toán'}
      actions={
        canManage && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasCodeItems && missing > 0 && (
              <Button size="sm" onClick={() => void runDeliver()} disabled={deliver.isPending}>
                {deliver.isPending ? <Loader2 className="animate-spin" /> : <PackageCheck />} Giao mã ngay
              </Button>
            )}
            {anySold && (
              <Button size="sm" variant="outline" onClick={() => resend.mutate()} disabled={resend.isPending}>
                {resend.isPending ? <Loader2 className="animate-spin" /> : <Send />} Gửi lại email
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="-mx-4 -my-4 divide-y">
        {items.map((it) => {
          const sold = deliveredCount(it);
          return (
            <div key={it.orderItemId} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">
                  {it.productName}
                  {it.variantLabel && <span className="font-normal text-muted-foreground"> · {it.variantLabel}</span>}
                </span>
                {it.codeDelivery && (
                  <span className={cn('text-xs tabular-nums', sold < it.quantity ? 'font-medium text-orange-600 dark:text-orange-400' : 'text-muted-foreground')}>
                    Đã giao {sold}/{it.quantity}
                  </span>
                )}
                {canManage && (
                  <Button size="xs" variant="outline" onClick={() => setManual(it)}>
                    <PenLine /> Giao tay
                  </Button>
                )}
              </div>

              {/* Thông tin khách nhập khi mua (ID game, email cần nâng cấp...) */}
              {it.fields.length > 0 && (
                <dl className="grid gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-2.5 text-sm sm:grid-cols-[auto_1fr]">
                  {it.fields.map((f) => (
                    <div key={f.key} className="contents">
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className="break-all font-medium">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {it.codes.length === 0 ? (
                it.codeDelivery && <p className="text-xs text-muted-foreground">Chưa có mã nào được giữ cho dòng hàng này.</p>
              ) : (
                <ul className="space-y-1.5">
                  {it.codes.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                      <span className={cn('min-w-0 flex-1 break-all font-mono text-xs', c.status === 'REVOKED' && 'text-muted-foreground line-through')}>{c.preview}</span>
                      <CodeStatusBadge status={c.status} />
                      {c.source === 'manual' && <Badge variant="outline">Giao tay</Badge>}
                      {c.status === 'SOLD' && (
                        <span className="text-xs text-muted-foreground" title={c.viewedAt ? formatDate(c.viewedAt) : undefined}>
                          {c.viewedAt ? 'Khách đã xem' : 'Chưa xem'}
                        </span>
                      )}
                      <ReportStatusBadge status={c.reportStatus} />
                      {(canReveal || canManage) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label="Thao tác mã">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canReveal && (
                              <DropdownMenuItem onClick={() => setReveal(c)}>
                                <Eye /> Xem nội dung
                              </DropdownMenuItem>
                            )}
                            {canManage && c.status === 'SOLD' && (
                              <DropdownMenuItem onClick={() => setReplace(c)}>
                                <RefreshCw /> Đổi mã mới
                              </DropdownMenuItem>
                            )}
                            {canManage && (c.status === 'SOLD' || c.status === 'RESERVED') && (
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setRevoke(c)}>
                                <Undo2 /> Thu hồi
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {c.reportStatus === 'OPEN' && c.reportNote && <p className="w-full text-xs text-red-600 dark:text-red-400">Khách báo: {c.reportNote}</p>}
                      {c.status === 'REVOKED' && c.revokeReason && <p className="w-full text-xs text-muted-foreground">Lý do thu hồi: {c.revokeReason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <RevealCodeDialog code={reveal} onClose={() => setReveal(null)} />
      <ReplaceCodeDialog code={replace} onClose={() => setReplace(null)} />
      <RevokeCodeDialog code={revoke} onClose={() => setRevoke(null)} />
      <ManualDeliverDialog orderId={orderId} item={manual} onClose={() => setManual(null)} />
    </Section>
  );
}
