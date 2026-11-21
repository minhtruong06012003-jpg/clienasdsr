'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, CornerDownRight, ExternalLink, Loader2, MessageSquareReply, MoreHorizontal, Newspaper, Pencil, ShieldAlert, ShieldCheck, Trash, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr, timeAgo } from '@/lib/format';
import { HAS_WEB_URL, siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

type CommentStatus = 'PENDING' | 'APPROVED' | 'SPAM' | 'TRASH';

interface CommentRow {
  id: string;
  postId: string;
  parentId: string | null;
  userId: string | null;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  content: string;
  status: CommentStatus;
  isAdminReply: boolean;
  ip: string | null;
  userAgent: string | null;
  locale: string | null;
  createdAt: string;
  updatedAt: string;
  post: { id: string; allowComments: boolean; translations: { locale: string; title: string; slug: string }[] };
  user: { id: string; name: string; email: string } | null;
  parent: { id: string; authorName: string; content: string; status: CommentStatus } | null;
  _count: { replies: number };
}

type CommentList = Paginated<CommentRow> & { statusCounts: Partial<Record<CommentStatus, number>> };

const STATUS: Record<CommentStatus, { label: string; className: string }> = {
  PENDING: { label: 'Chờ duyệt', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  APPROVED: { label: 'Đã duyệt', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  SPAM: { label: 'Spam', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  TRASH: { label: 'Thùng rác', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
};

const ACTIONS: { status: CommentStatus; label: string; icon: typeof Check; done: string }[] = [
  { status: 'APPROVED', label: 'Duyệt', icon: Check, done: 'Đã duyệt' },
  { status: 'PENDING', label: 'Chuyển về chờ duyệt', icon: Clock, done: 'Đã chuyển về chờ duyệt' },
  { status: 'SPAM', label: 'Đánh dấu spam', icon: ShieldAlert, done: 'Đã đánh dấu spam' },
  { status: 'TRASH', label: 'Chuyển vào thùng rác', icon: Trash, done: 'Đã chuyển vào thùng rác' },
];

/** Chỉ xoá vĩnh viễn được khi đã ở spam / thùng rác (giống WordPress) */
const canDelete = (s: CommentStatus) => s === 'SPAM' || s === 'TRASH';

function CommentStatusBadge({ status }: { status: CommentStatus }) {
  const m = STATUS[status] ?? { label: status, className: '' };
  return <Badge className={cn('border-transparent font-medium', m.className)}>{m.label}</Badge>;
}

/** Avatar chữ cái đầu, màu theo tên */
function Avatar({ name, admin, size = 'size-9' }: { name: string; admin?: boolean; size?: string }) {
  const colors = ['bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300', 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300', 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'];
  const idx = [...name].reduce((s, c) => s + c.charCodeAt(0), 0) % colors.length;
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase', size, admin ? 'bg-primary text-primary-foreground' : colors[idx])} aria-hidden>
      {name.trim().charAt(0) || '?'}
    </span>
  );
}

function PostLinks({ post, locale, defaultLocale, canPosts, className }: { post: CommentRow['post']; locale: string; defaultLocale: string; canPosts: boolean; className?: string }) {
  const tr = pickTr(post.translations, locale);
  const title = tr?.title ?? '(không tiêu đề)';
  return (
    <div className={cn('min-w-0', className)}>
      {canPosts ? (
        <Link href={`/posts/${post.id}`} className="line-clamp-2 text-sm font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
          {title}
        </Link>
      ) : (
        <span className="line-clamp-2 text-sm font-medium">{title}</span>
      )}
      {HAS_WEB_URL && tr?.slug && (
        <a href={siteUrl('post', tr.slug, tr.locale, defaultLocale)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary" onClick={(e) => e.stopPropagation()}>
          <ExternalLink className="size-3" /> Xem trên web
        </a>
      )}
    </div>
  );
}

function CommentsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, defaultLocale } = useListLocale();
  const { params, set, page, limit } = useListParams({ status: 'PENDING', search: '', postId: '', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [viewing, setViewing] = useState<CommentRow | null>(null);
  const status = params.status === 'all' ? '' : params.status;
  const canManage = can('comments.manage');
  const canPosts = can('posts.read');
  const canUsers = can('users.read');

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['comments', params],
    queryFn: () => api.get<CommentList>('/admin/comments', { status, search: params.search, postId: params.postId, order: params.order, page, limit }),
  });
  const counts = list.data?.statusCounts ?? {};
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['comments'] });
    void qc.invalidateQueries({ queryKey: ['admin-badges'] });
  };

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post('/admin/comments/bulk', { ids, action }),
    onSuccess: (_d, { ids, action }) => {
      toast.success(action === 'delete' ? `Đã xoá vĩnh viễn ${ids.length} bình luận` : (ACTIONS.find((a) => a.status === action)?.done ?? 'Đã cập nhật'));
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runBulk = async (ids: string[], action: string) => {
    if (!ids.length) return;
    if (action === 'delete' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} bình luận?`, description: 'Các trả lời của những bình luận này cũng bị xoá và không thể khôi phục.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    bulk.mutate({ ids, action });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: CommentStatus }) => api.patch<CommentRow>(`/admin/comments/${id}`, { status }),
    onSuccess: (data, { status }) => {
      toast.success(ACTIONS.find((a) => a.status === status)?.done ?? 'Đã cập nhật');
      setViewing((v) => (v && v.id === data.id ? { ...v, status: data.status } : v));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async (c: CommentRow) => {
    if (!(await confirm({ title: 'Xoá vĩnh viễn bình luận này?', description: `Bình luận của “${c.authorName}”${c._count.replies ? ` và ${c._count.replies} trả lời` : ''} sẽ bị xoá, không thể khôi phục.`, destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    try {
      await api.delete(`/admin/comments/${c.id}`);
      toast.success('Đã xoá bình luận');
      setViewing((v) => (v?.id === c.id ? null : v));
      setSelected((s) => s.filter((id) => id !== c.id));
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filteredPost = params.postId ? list.data?.data.find((r) => r.postId === params.postId)?.post : undefined;
  const inBin = params.status === 'SPAM' || params.status === 'TRASH';

  const columns: Column<CommentRow>[] = [
    {
      key: 'author',
      header: 'Người gửi',
      cell: (r) => (
        <div className="flex w-52 items-start gap-2.5">
          <Avatar name={r.authorName} admin={r.isAdminReply} />
          <div className="min-w-0 space-y-0.5">
            <div className="line-clamp-1 font-medium">
              {r.user && canUsers ? (
                <Link href={`/users/${r.user.id}`} className="hover:text-primary" onClick={(e) => e.stopPropagation()}>
                  {r.authorName}
                </Link>
              ) : (
                r.authorName
              )}
            </div>
            {r.authorEmail && <div className="truncate text-xs text-muted-foreground">{r.authorEmail}</div>}
            {r.ip && <div className="truncate font-mono text-[11px] text-muted-foreground">{r.ip}</div>}
            {r.isAdminReply && (
              <Badge className="gap-1 border-transparent bg-primary/10 text-[10px] text-primary">
                <ShieldCheck className="size-3" /> Quản trị viên
              </Badge>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'comment',
      header: 'Bình luận',
      cell: (r) => (
        <div className="min-w-64 max-w-md space-y-1">
          {r.parent && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CornerDownRight className="size-3 shrink-0" /> Trả lời <b className="truncate">{r.parent.authorName}</b>
            </div>
          )}
          <p className="line-clamp-3 whitespace-pre-line text-sm">{r.content}</p>
          {r._count.replies > 0 && <div className="text-xs text-muted-foreground">{r._count.replies} trả lời</div>}
        </div>
      ),
    },
    {
      key: 'post',
      header: 'Bài viết',
      cell: (r) => (
        <div className="w-48 space-y-1">
          <PostLinks post={r.post} locale={locale} defaultLocale={defaultLocale} canPosts={canPosts} />
          {!params.postId && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-primary"
              onClick={(e) => {
                e.stopPropagation();
                set({ postId: r.postId });
              }}
            >
              Lọc theo bài viết này
            </button>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Trạng thái', cell: (r) => <CommentStatusBadge status={r.status} /> },
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
          {canManage && r.status !== 'APPROVED' && (
            <Button variant="ghost" size="icon-sm" className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300" title="Duyệt" onClick={() => setStatus.mutate({ id: r.id, status: 'APPROVED' })} disabled={setStatus.isPending}>
              <Check />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" title="Xem & trả lời" onClick={() => setViewing(r)}>
            <MessageSquareReply />
          </Button>
          {canManage && (
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
                {canDelete(r.status) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => void remove(r)}>
                      <Trash2 /> Xoá vĩnh viễn
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Bình luận" description="Duyệt, trả lời và quản lý bình luận của độc giả trên bài viết" breadcrumbs={[{ label: 'Bài viết', href: '/posts' }, { label: 'Bình luận' }]} />
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
            { value: 'SPAM', label: 'Spam', count: counts.SPAM ?? 0 },
            { value: 'TRASH', label: 'Thùng rác', count: counts.TRASH ?? 0 },
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
            params.postId ? (
              <Badge variant="secondary" className="h-8 gap-1.5 pl-2.5 pr-1 text-xs font-normal">
                <Newspaper className="size-3.5" /> Bài viết: <b className="max-w-48 truncate">{filteredPost ? (pickTr(filteredPost.translations, locale)?.title ?? '—') : 'đang lọc'}</b>
                <button type="button" onClick={() => set({ postId: '' })} className="rounded p-0.5 hover:bg-background" aria-label="Bỏ lọc bài viết">
                  <X className="size-3.5" />
                </button>
              </Badge>
            ) : undefined
          }
          bulkActions={
            canManage ? (
              <>
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'APPROVED')} disabled={bulk.isPending}>
                  <Check /> Duyệt
                </Button>
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'PENDING')} disabled={bulk.isPending}>
                  <Clock /> Chờ duyệt
                </Button>
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'SPAM')} disabled={bulk.isPending}>
                  <ShieldAlert /> Spam
                </Button>
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'TRASH')} disabled={bulk.isPending}>
                  <Trash /> Thùng rác
                </Button>
                {inBin && (
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'delete')} disabled={bulk.isPending}>
                    <Trash2 /> Xoá vĩnh viễn
                  </Button>
                )}
              </>
            ) : undefined
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          selectable={canManage}
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={setViewing}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          sort={{ key: 'createdAt', order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ order: s.order })}
          emptyTitle={params.status === 'PENDING' && !params.search && !params.postId ? 'Không có bình luận nào chờ duyệt' : 'Không có bình luận phù hợp'}
          emptyDescription={params.status === 'PENDING' && !params.search && !params.postId ? 'Tuyệt vời! Bạn đã xử lý hết bình luận mới.' : undefined}
        />
      </PageBody>

      {viewing && (
        <CommentDialog
          key={viewing.id}
          comment={viewing}
          locale={locale}
          defaultLocale={defaultLocale}
          canManage={canManage}
          canPosts={canPosts}
          canUsers={canUsers}
          busy={setStatus.isPending}
          onClose={() => setViewing(null)}
          onStatus={(s) => setStatus.mutate({ id: viewing.id, status: s })}
          onDelete={() => void remove(viewing)}
          onSaved={(c) => {
            setViewing(c);
            refresh();
          }}
          onReplied={() => {
            refresh();
          }}
        />
      )}
    </>
  );
}

function CommentDialog({
  comment: c,
  locale,
  defaultLocale,
  canManage,
  canPosts,
  canUsers,
  busy,
  onClose,
  onStatus,
  onDelete,
  onSaved,
  onReplied,
}: {
  comment: CommentRow;
  locale: string;
  defaultLocale: string;
  canManage: boolean;
  canPosts: boolean;
  canUsers: boolean;
  busy: boolean;
  onClose: () => void;
  onStatus: (s: CommentStatus) => void;
  onDelete: () => void;
  onSaved: (c: CommentRow) => void;
  onReplied: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(c.content);
  const [reply, setReply] = useState('');
  const [replied, setReplied] = useState<CommentRow | null>(null);
  const contentChanged = content.trim() !== c.content;

  const save = useMutation({
    mutationFn: () => api.patch<CommentRow>(`/admin/comments/${c.id}`, { content: content.trim() }),
    onSuccess: (data) => {
      toast.success('Đã lưu nội dung');
      setEditing(false);
      onSaved({ ...c, content: data.content, status: data.status, updatedAt: data.updatedAt });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const sendReply = useMutation({
    mutationFn: () => api.post<CommentRow>(`/admin/comments/${c.id}/reply`, { content: reply.trim() }),
    onSuccess: (data) => {
      toast.success(c.status === 'PENDING' ? 'Đã duyệt & gửi trả lời' : 'Đã gửi trả lời');
      setReplied(data);
      setReply('');
      // API duyệt luôn bình luận gốc đang chờ khi quản trị viên trả lời
      if (c.status === 'PENDING') onSaved({ ...c, status: 'APPROVED', _count: { replies: c._count.replies + 1 } });
      else onReplied();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const closed = c.status === 'SPAM' || c.status === 'TRASH';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Bình luận của {c.authorName} <CommentStatusBadge status={c.status} />
            {c.isAdminReply && (
              <Badge className="gap-1 border-transparent bg-primary/10 text-primary">
                <ShieldCheck className="size-3" /> Quản trị viên
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Gửi lúc {formatDate(c.createdAt)} ({timeAgo(c.createdAt)}){c.locale && ` · ngôn ngữ ${c.locale.toUpperCase()}`}
            {c.updatedAt !== c.createdAt && ` · sửa ${timeAgo(c.updatedAt)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
              <Newspaper className="size-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Bài viết{!c.post.allowComments && ' · đã tắt bình luận'}</div>
              <PostLinks post={c.post} locale={locale} defaultLocale={defaultLocale} canPosts={canPosts} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="flex items-start gap-3 text-sm">
              <Avatar name={c.authorName} admin={c.isAdminReply} size="size-10" />
              <div className="min-w-0 space-y-0.5">
                <div className="font-medium">
                  {c.user && canUsers ? (
                    <Link href={`/users/${c.user.id}`} className="hover:text-primary">
                      {c.authorName}
                    </Link>
                  ) : (
                    c.authorName
                  )}
                  {!c.user && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(khách vãng lai)</span>}
                </div>
                {c.authorEmail && (
                  <a href={`mailto:${c.authorEmail}`} className="block truncate text-muted-foreground hover:text-primary">
                    {c.authorEmail}
                  </a>
                )}
                {c.authorUrl && (
                  <a href={c.authorUrl} target="_blank" rel="noreferrer nofollow" className="block truncate text-xs text-muted-foreground hover:text-primary">
                    {c.authorUrl}
                  </a>
                )}
              </div>
            </div>
            <dl className="grid grid-cols-[auto_auto] content-start gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>IP</dt>
              <dd className="text-right font-mono text-foreground">{c.ip ?? '—'}</dd>
              <dt>Trình duyệt</dt>
              <dd className="max-w-48 truncate text-right text-foreground" title={c.userAgent ?? ''}>
                {c.userAgent ? c.userAgent.slice(0, 40) : '—'}
              </dd>
            </dl>
          </div>

          {c.parent && (
            <div className="rounded-lg border border-dashed p-3 text-sm">
              <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                <CornerDownRight className="size-3" /> Trả lời bình luận của <b>{c.parent.authorName}</b>
                {c.parent.status !== 'APPROVED' && <CommentStatusBadge status={c.parent.status} />}
              </div>
              <p className="line-clamp-3 whitespace-pre-line text-muted-foreground">{c.parent.content}</p>
            </div>
          )}

          <div className="space-y-2 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">Nội dung</h4>
              {canManage && !editing && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Sửa
                </Button>
              )}
            </div>
            {editing ? (
              <>
                <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} maxLength={3000} autoFocus />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{content.length}/3000</span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setContent(c.content);
                        setEditing(false);
                      }}
                      disabled={save.isPending}
                    >
                      Huỷ
                    </Button>
                    <Button type="button" size="sm" disabled={!contentChanged || !content.trim() || save.isPending} onClick={() => save.mutate()}>
                      {save.isPending && <Loader2 className="animate-spin" />} Lưu nội dung
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="whitespace-pre-line text-sm leading-relaxed">{c.content}</p>
            )}
          </div>

          {canManage && !c.isAdminReply && (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquareReply className="size-4 text-primary" /> Trả lời với tư cách quản trị viên
              </h4>
              {replied && (
                <div className="whitespace-pre-line rounded-lg border-l-4 border-primary bg-primary/5 p-3 text-sm">
                  <div className="mb-1 text-xs text-muted-foreground">Vừa gửi · {timeAgo(replied.createdAt)}</div>
                  {replied.content}
                </div>
              )}
              {closed ? (
                <p className="text-xs text-muted-foreground">Không thể trả lời bình luận trong spam / thùng rác. Hãy duyệt hoặc chuyển về chờ duyệt trước.</p>
              ) : (
                <>
                  <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={3000} placeholder="Cảm ơn bạn đã quan tâm..." />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Trả lời hiển thị công khai dưới bình luận này với nhãn “Quản trị viên”{c.status === 'PENDING' && '; bình luận gốc sẽ được duyệt luôn'}. {reply.length}/3000</span>
                    <Button type="button" size="sm" disabled={!reply.trim() || sendReply.isPending} onClick={() => sendReply.mutate()}>
                      {sendReply.isPending && <Loader2 className="animate-spin" />} {c.status === 'PENDING' ? 'Duyệt & trả lời' : 'Gửi trả lời'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {canManage && (
          <DialogFooter className="sm:justify-between">
            {canDelete(c.status) ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={onDelete}>
                <Trash2 /> Xoá vĩnh viễn
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap gap-2">
              {ACTIONS.filter((a) => a.status !== c.status).map((a) => (
                <Button key={a.status} type="button" variant={a.status === 'APPROVED' ? 'default' : 'outline'} disabled={busy} onClick={() => onStatus(a.status)}>
                  <a.icon /> {a.status === 'SPAM' ? 'Spam' : a.status === 'TRASH' ? 'Thùng rác' : a.status === 'PENDING' ? 'Chờ duyệt' : a.label}
                </Button>
              ))}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CommentsPage() {
  return (
    <Suspense>
      <CommentsList />
    </Suspense>
  );
}
