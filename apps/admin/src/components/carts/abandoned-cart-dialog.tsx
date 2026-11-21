'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import type { AbandonedCartDetail } from '@cmsnt/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { AbandonedCartStatusBadge } from './abandoned-cart-status';

/** Chi tiết 1 giỏ: sản phẩm (giá hiện tại), link khôi phục, lịch sử nhắc */
export function AbandonedCartDialog({ id, onOpenChange, onRemind, reminding, canRemind }: { id: string | null; onOpenChange: (open: boolean) => void; onRemind: (id: string) => void; reminding: boolean; canRemind: boolean }) {
  const detail = useQuery({
    queryKey: ['abandoned-carts', 'detail', id],
    queryFn: () => api.get<AbandonedCartDetail>(`/admin/abandoned-carts/${id}`),
    enabled: !!id,
  });
  const c = detail.data;

  return (
    <Dialog open={!!id} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Giỏ hàng {c?.email ? `của ${c.email}` : ''}</DialogTitle>
          <DialogDescription>{c ? `Hoạt động lần cuối ${formatDate(c.lastActivityAt)} (${timeAgo(c.lastActivityAt)})` : 'Đang tải...'}</DialogDescription>
        </DialogHeader>
        {!c ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <AbandonedCartStatusBadge status={c.status} />
              {c.user && (
                <Link href={`/users/${c.user.id}`} className="text-primary hover:underline">
                  Thành viên: {c.user.name}
                </Link>
              )}
              {c.convertedOrderCode && <span className="text-muted-foreground">Đơn #{c.convertedOrderCode}</span>}
              <span className="text-muted-foreground">
                Đã nhắc {c.reminderCount} lần{c.lastReminderAt ? ` · lần cuối ${formatDate(c.lastReminderAt)}` : ''}
              </span>
            </div>
            <ul className="divide-y rounded-lg border">
              {c.items.length === 0 && <li className="p-4 text-sm text-muted-foreground">Giỏ trống hoặc sản phẩm đã bị xoá.</li>}
              {c.items.map((l) => (
                <li key={`${l.productId}:${l.variantId}`} className="flex items-center gap-3 p-3">
                  <div className="size-12 shrink-0 overflow-hidden rounded-md bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {l.image && <img src={l.image} alt="" className="size-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${l.productId}`} className="line-clamp-1 text-sm font-medium hover:text-primary">
                      {l.name || '(không tên)'}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {Object.values(l.optionValues).filter(Boolean).join(' / ')}
                      {!l.available && <span className="ml-1 text-red-600 dark:text-red-400">· không còn bán</span>}
                    </p>
                  </div>
                  <div className="text-right text-sm tabular-nums">
                    <div>
                      {l.quantity} × {formatMoney(l.price)}
                    </div>
                    <div className="font-semibold">{formatMoney(l.total)}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end text-sm">
              Tạm tính (giá hiện tại): <span className="ml-2 font-semibold tabular-nums">{formatMoney(c.items.filter((l) => l.available).reduce((s, l) => s + l.total, 0))}</span>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Link khôi phục giỏ (gửi kèm trong email nhắc)</p>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
                <code className="min-w-0 flex-1 truncate text-xs">{c.recoverUrl}</code>
                <Button variant="ghost" size="icon-xs" title="Sao chép" onClick={() => void navigator.clipboard.writeText(c.recoverUrl).then(() => toast.success('Đã sao chép link'))}>
                  <Copy />
                </Button>
                <Button variant="ghost" size="icon-xs" asChild title="Mở link">
                  <a href={c.recoverUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          {c && canRemind && !c.convertedOrderCode && c.email && c.items.length > 0 && (
            <Button onClick={() => onRemind(c.id)} disabled={reminding}>
              {reminding ? <Loader2 className="animate-spin" /> : <Mail />} Gửi email nhắc ngay
            </Button>
          )}
          {c?.convertedOrderCode && (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
              <Check className="size-4" /> Khách đã đặt đơn #{c.convertedOrderCode}
            </span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
