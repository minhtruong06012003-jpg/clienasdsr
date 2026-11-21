'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Ban, Check, Clock, Loader2, MessageSquareReply, MoreHorizontal, Package, ShieldAlert, Star, ThumbsUp, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SPAM';

interface ReviewRow {
  id: string;
  productId: string;
  orderId: string | null;
  rating: number;
  title: string | null;
  content: string;
  authorName: string;
  authorEmail: string | null;
  status: ReviewStatus;
  isVerified: boolean;
  reply: string | null;
  repliedAt: string | null;
  helpfulCount: number;
  locale: string | null;
  ip: string | null;
  createdAt: string;
  product: { id: string; featuredImage: { url: string; urls: Record<string, string> } | null; translations: { locale: string; name: string; slug: string }[] };
  user: { id: string; name: string; email: string } | null;
}

type ReviewList = Paginated<ReviewRow> & { statusCounts: Partial<Record<ReviewStatus, number>> };

const STATUS: Record<ReviewStatus, { label: string; className: string }> = {
  PENDING: { label: 'Chờ duyệt', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  APPROVED: { label: 'Đã duyệt', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  REJECTED: { label: 'Từ chối', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  SPAM: { label: 'Spam', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

const ACTIONS: { status: ReviewStatus; label: string; icon: typeof Check; done: string }[] = [
  { status: 'APPROVED', label: 'Duyệt', icon: Check, done: 'Đã duyệt' },
  { status: 'REJECTED', label: 'Từ chối', icon: Ban, done: 'Đã từ chối' },
  { status: 'SPAM', label: 'Đánh dấu spam', icon: ShieldAlert, done: 'Đã đánh dấu spam' },
  { status: 'PENDING', label: 'Chuyển về chờ duyệt', icon: Clock, done: 'Đã chuyển về chờ duyệt' },
];

function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const m = STATUS[status] ?? { label: status, className: '' };
  return <Badge className={cn('border-transparent font-medium', m.className)}>{m.label}</Badge>;
}

function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} title={`${value}/5 sao`} aria-label={`${value} trên 5 sao`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn('size-3.5', i <= value ? 'fill-amber-400 text-amber-400' : 'fill-muted text-muted-foreground/30')} />
      ))}
    </span>
  );
}

function ProductThumb({ product, locale, size = 'size-10' }: { product: ReviewRow['product']; locale: string; size?: string }) {
  const img = product.featuredImage;
  return img ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={img.urls.thumb ?? img.url} alt="" className={cn(size, 'shrink-0 rounded-md border object-cover')} />
  ) : (
    <div className={cn(size, 'flex shrink-0 items-center justify-center rounded-md bg-muted')} title={pickTr(product.translations, locale)?.name}>
      <Package className="size-4 text-muted-foreground" />
    </div>
  );
}

function ReviewsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale } = useListLocale();
  const { params, set, page, limit } = useListParams({ status: 'PENDING', rating: '', search: '', productId: '', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [viewing, setViewing] = useState<ReviewRow | null>(null);
  const status = params.status === 'all' ? '' : params.status;
  const canProducts = can('products.read');
  /** link sang trang thành viên / đơn hàng chỉ khi có quyền xem (không thì hiện chữ thường) */
  const canUsers = can('users.read');

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['reviews', params],
    queryFn: () => api.get<ReviewList>('/admin/reviews', { status, rating: params.rating, search: params.search, productId: params.productId, order: params.order, page, limit }),
  });
  const counts = list.data?.statusCounts ?? {};
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['reviews'] });
    void qc.invalidateQueries({ queryKey: ['reviews-pending'] });
  };

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post('/admin/reviews/bulk', { ids, action }),
    onSuccess: (_d, { ids, action }) => {
      toast.success(action === 'delete' ? `Đã xoá ${ids.length} đánh giá` : (ACTIONS.find((a) => a.status === action)?.done ?? 'Đã cập nhật'));
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runBulk = async (ids: string[], action: string) => {
    if (!ids.length) return;
    if (action === 'delete' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} đánh giá?`, description: 'Đánh giá bị xoá không thể khôi phục. Điểm trung bình của sản phẩm sẽ được tính lại.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    bulk.mutate({ ids, action });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReviewStatus }) => api.patch<ReviewRow>(`/admin/reviews/${id}`, { status }),
    onSuccess: (data, { status }) => {
      toast.success(ACTIONS.find((a) => a.status === status)?.done ?? 'Đã cập nhật');
      setViewing((v) => (v && v.id === data.id ? { ...v, status: data.status } : v));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async (r: ReviewRow) => {
    if (!(await confirm({ title: 'Xoá đánh giá này?', description: `Đánh giá ${r.rating} sao của “${r.authorName}” sẽ bị xoá vĩnh viễn.`, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/reviews/${r.id}`);
      toast.success('Đã xoá đánh giá');
      setViewing((v) => (v?.id === r.id ? null : v));
      setSelected((s) => s.filter((id) => id !== r.id));
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filteredProduct = params.productId ? list.data?.data.find((r) => r.productId === params.productId)?.product : undefined;

  const columns: Column<ReviewRow>[] = [
    {
      key: 'product',
      header: 'Sản phẩm',
      cell: (r) => {
        const tr = pickTr(r.product.translations, locale);
        return (
          <div className="flex w-56 items-center gap-2.5">
            <ProductThumb product={r.product} locale={locale} />
            <div className="min-w-0">
              {canProducts ? (
                <Link href={`/products/${r.product.id}`} className="line-clamp-2 text-sm font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
                  {tr?.name ?? '(không tên)'}
                </Link>
              ) : (
                <span className="line-clamp-2 text-sm font-medium">{tr?.name ?? '(không tên)'}</span>
              )}
              {!params.productId && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    set({ productId: r.product.id });
                  }}
                >
                  Lọc theo sản phẩm này
                </button>
              )}
            </div>
          </div>
        );
      },
    },
    {
      key: 'review',
      header: 'Đánh giá',
      cell: (r) => (
        <div className="min-w-64 max-w-md space-y-1">
          <Stars value={r.rating} />
          {r.title && <div className="line-clamp-1 font-medium">{r.title}</div>}
          <p className="line-clamp-2 text-sm text-muted-foreground">{r.content}</p>
          {r.reply && (
            <div className="flex items-center gap-1 text-xs text-primary">
              <MessageSquareReply className="size-3" /> Đã phản hồi
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'author',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="min-w-0 max-w-52 space-y-0.5">
          <div className="line-clamp-1 font-medium">
            {r.user && canUsers ? (
              <Link href={`/users/${r.user.id}`} className="hover:text-primary" onClick={(e) => e.stopPropagation()}>
                {r.authorName}
              </Link>
            ) : (
              r.authorName
            )}
          </div>
          {(r.authorEmail ?? r.user?.email) && <div className="truncate text-xs text-muted-foreground">{r.authorEmail ?? r.user?.email}</div>}
          {r.isVerified && (
            <Badge className="gap-1 border-transparent bg-emerald-50 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              <BadgeCheck className="size-3" /> Đã mua hàng
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Trạng thái', cell: (r) => <ReviewStatusBadge status={r.status} /> },
    {
      key: 'createdAt',
      header: 'Ngày gửi',
      sortable: true,
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-24',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status !== 'APPROVED' && (
            <Button variant="ghost" size="icon-sm" className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300" title="Duyệt" onClick={() => setStatus.mutate({ id: r.id, status: 'APPROVED' })} disabled={setStatus.isPending}>
              <Check />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" title="Xem & trả lời" onClick={() => setViewing(r)}>
            <MessageSquareReply />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Thao tác">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setViewing(r)}>
                <MessageSquareReply /> Xem & trả lời
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {ACTIONS.filter((a) => a.status !== r.status).map((a) => (
                <DropdownMenuItem key={a.status} onClick={() => setStatus.mutate({ id: r.id, status: a.status })}>
                  <a.icon /> {a.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void remove(r)}>
                <Trash2 /> Xoá vĩnh viễn
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Đánh giá sản phẩm" description="Duyệt, phản hồi và quản lý đánh giá của khách hàng" breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Đánh giá' }]} />
      <PageBody className="space-y-4">
        <StatusTabs
          value={params.status}
          onChange={(v) => {
            setSelected([]);
            set({ status: v });
          }}
          options={[
            { value: 'PENDING', label: 'Chờ duyệt', count: counts.PENDING ?? 0, highlight: true },
            { value: 'APPROVED', label: 'Đã duyệt', count: counts.APPROVED ?? 0 },
            { value: 'REJECTED', label: 'Từ chối', count: counts.REJECTED ?? 0 },
            { value: 'SPAM', label: 'Spam', count: counts.SPAM ?? 0 },
            { value: 'all', label: 'Tất cả', count: total },
          ]}
        />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo nội dung, tên, email..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          filters={
            <>
              <Select value={params.rating || 'all'} onValueChange={(v) => set({ rating: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Số sao" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả số sao</SelectItem>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      <span className="inline-flex items-center gap-1">
                        {n} <Star className="size-3.5 fill-amber-400 text-amber-400" />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {params.productId && (
                <Badge variant="secondary" className="h-8 gap-1.5 pl-2.5 pr-1 text-xs font-normal">
                  Sản phẩm: <b className="max-w-48 truncate">{filteredProduct ? (pickTr(filteredProduct.translations, locale)?.name ?? '—') : 'đang lọc'}</b>
                  <button type="button" onClick={() => set({ productId: '' })} className="rounded p-0.5 hover:bg-background" aria-label="Bỏ lọc sản phẩm">
                    <X className="size-3.5" />
                  </button>
                </Badge>
              )}
            </>
          }
          bulkActions={
            <>
              <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'APPROVED')} disabled={bulk.isPending}>
                <Check /> Duyệt
              </Button>
              <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'REJECTED')} disabled={bulk.isPending}>
                Từ chối
              </Button>
              <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'SPAM')} disabled={bulk.isPending}>
                Spam
              </Button>
              <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'delete')} disabled={bulk.isPending}>
                <Trash2 /> Xoá
              </Button>
            </>
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={setViewing}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          sort={{ key: 'createdAt', order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ order: s.order })}
          emptyTitle={params.status === 'PENDING' && !params.search && !params.rating ? 'Không có đánh giá nào chờ duyệt' : 'Không có đánh giá phù hợp'}
          emptyDescription={params.status === 'PENDING' && !params.search && !params.rating ? 'Tuyệt vời! Bạn đã xử lý hết đánh giá mới.' : undefined}
        />
      </PageBody>

      {viewing && (
        <ReviewDialog
          key={viewing.id}
          review={viewing}
          locale={locale}
          canProducts={canProducts}
          canUsers={canUsers}
          canOrders={can('orders.read')}
          busy={setStatus.isPending}
          onClose={() => setViewing(null)}
          onStatus={(s) => setStatus.mutate({ id: viewing.id, status: s })}
          onDelete={() => void remove(viewing)}
          onSaved={(r) => {
            setViewing(r);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ReviewDialog({
  review: r,
  locale,
  canProducts,
  canUsers,
  canOrders,
  busy,
  onClose,
  onStatus,
  onDelete,
  onSaved,
}: {
  review: ReviewRow;
  locale: string;
  canProducts: boolean;
  canUsers: boolean;
  canOrders: boolean;
  busy: boolean;
  onClose: () => void;
  onStatus: (s: ReviewStatus) => void;
  onDelete: () => void;
  onSaved: (r: ReviewRow) => void;
}) {
  const confirm = useConfirm();
  const [reply, setReply] = useState(r.reply ?? '');
  const tr = pickTr(r.product.translations, locale);
  const changed = reply.trim() !== (r.reply ?? '');

  const save = useMutation({
    mutationFn: (body: { reply: string; status?: ReviewStatus }) => api.patch<ReviewRow>(`/admin/reviews/${r.id}`, body),
    onSuccess: (data, body) => {
      toast.success(body.reply ? (body.status === 'APPROVED' ? 'Đã duyệt & lưu phản hồi' : 'Đã lưu phản hồi') : 'Đã xoá phản hồi');
      setReply(data.reply ?? '');
      onSaved({ ...r, status: data.status, reply: data.reply, repliedAt: data.repliedAt });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const removeReply = async () => {
    if (!(await confirm({ title: 'Xoá phản hồi của cửa hàng?', description: 'Phản hồi sẽ không còn hiển thị dưới đánh giá này.', destructive: true, confirmText: 'Xoá phản hồi' }))) return;
    save.mutate({ reply: '' });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Đánh giá của {r.authorName} <ReviewStatusBadge status={r.status} />
          </DialogTitle>
          <DialogDescription>
            Gửi lúc {formatDate(r.createdAt)} ({timeAgo(r.createdAt)})
            {r.locale && ` · ngôn ngữ ${r.locale.toUpperCase()}`}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5">
            <ProductThumb product={r.product} locale={locale} size="size-12" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Sản phẩm</div>
              {canProducts ? (
                <Link href={`/products/${r.product.id}`} className="line-clamp-1 font-medium hover:text-primary">
                  {tr?.name ?? '(không tên)'}
                </Link>
              ) : (
                <span className="line-clamp-1 font-medium">{tr?.name ?? '(không tên)'}</span>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1 text-sm">
              <div className="font-medium">
                {r.user && canUsers ? (
                  <Link href={`/users/${r.user.id}`} className="hover:text-primary">
                    {r.authorName}
                  </Link>
                ) : (
                  r.authorName
                )}
                {!r.user && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(khách vãng lai)</span>}
              </div>
              {(r.authorEmail ?? r.user?.email) && <div className="text-muted-foreground">{r.authorEmail ?? r.user?.email}</div>}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {r.isVerified ? (
                  <Badge className="gap-1 border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    <BadgeCheck className="size-3" /> Đã mua hàng
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Chưa xác minh mua hàng</span>
                )}
                {r.orderId &&
                  (canOrders ? (
                    <Link href={`/orders/${r.orderId}`} className="text-xs text-primary hover:underline">
                      Xem đơn hàng
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">Có đơn hàng đã hoàn thành</span>
                  ))}
              </div>
            </div>
            <dl className="grid grid-cols-[auto_auto] content-start gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Hữu ích</dt>
              <dd className="flex items-center justify-end gap-1 text-foreground">
                <ThumbsUp className="size-3" /> {r.helpfulCount}
              </dd>
              <dt>IP</dt>
              <dd className="text-right font-mono text-foreground">{r.ip ?? '—'}</dd>
            </dl>
          </div>

          <div className="space-y-2 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Stars value={r.rating} className="[&_svg]:size-4" />
              <span className="text-sm font-medium">{r.rating}/5</span>
            </div>
            {r.title && <h3 className="font-semibold">{r.title}</h3>}
            <p className="whitespace-pre-line text-sm leading-relaxed">{r.content}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquareReply className="size-4 text-primary" /> Phản hồi của cửa hàng
              </h4>
              {r.repliedAt && <span className="text-xs text-muted-foreground">Cập nhật {formatDate(r.repliedAt)}</span>}
            </div>
            {r.reply && !changed && <div className="whitespace-pre-line rounded-lg border-l-4 border-primary bg-primary/5 p-3 text-sm">{r.reply}</div>}
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={4} maxLength={3000} placeholder="Cảm ơn bạn đã tin tưởng sản phẩm của shop..." />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Phản hồi hiển thị công khai dưới đánh giá trên website. {reply.length}/3000</span>
              <div className="flex flex-wrap gap-2">
                {r.reply && (
                  <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => void removeReply()} disabled={save.isPending}>
                    Xoá phản hồi
                  </Button>
                )}
                {r.status === 'PENDING' && reply.trim() && (
                  <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate({ reply: reply.trim(), status: 'APPROVED' })}>
                    Duyệt & phản hồi
                  </Button>
                )}
                <Button type="button" size="sm" disabled={!changed || !reply.trim() || save.isPending} onClick={() => save.mutate({ reply: reply.trim() })}>
                  {save.isPending && <Loader2 className="animate-spin" />} {r.reply ? 'Cập nhật phản hồi' : 'Gửi phản hồi'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" className="text-destructive" onClick={onDelete}>
            <Trash2 /> Xoá
          </Button>
          <div className="flex flex-wrap gap-2">
            {ACTIONS.filter((a) => a.status !== r.status && a.status !== 'PENDING').map((a) => (
              <Button key={a.status} type="button" variant={a.status === 'APPROVED' ? 'default' : 'outline'} disabled={busy} onClick={() => onStatus(a.status)}>
                <a.icon /> {a.label === 'Đánh dấu spam' ? 'Spam' : a.label}
              </Button>
            ))}
            {r.status !== 'PENDING' && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => onStatus('PENDING')}>
                <Clock /> Chờ duyệt
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ReviewsPage() {
  return (
    <Suspense>
      <ReviewsList />
    </Suspense>
  );
}
