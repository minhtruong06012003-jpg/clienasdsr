'use client';

/**
 * AI Studio › Ticket hỗ trợ: quản trị viên xem & phản hồi trực tiếp các yêu cầu hỗ trợ của khách hàng.
 * - Lọc nhanh: Tất cả / Chờ phản hồi / Đã phản hồi / Đã đóng + tìm kiếm theo #mã ticket, email/tên khách, tiêu đề, mã đơn AI.
 * - Chi tiết Ticket: hiện tên, email, số dư ví của khách, trạng thái đơn AI liên quan (nếu khách có đính mã đơn),
 *   lịch sử tin nhắn 2 chiều + trả lời trực tiếp + đóng / mở lại ticket.
 */
import Link from 'next/link';
import { useEffect, useState, type ClipboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Film, Globe, ImagePlus, Loader2, LockOpen, MessageSquareText, RotateCcw, Search, Send, Sparkles, X, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { TASK_STATUS, ToneBadge } from '@/components/ai/shared';
import { AdminAiTaskDialog } from '@/components/ai/task-detail-dialog';
import { TicketSiteUserDialog, type TicketUserTarget } from '@/components/tickets/ticket-user-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface AdminTicketAttachment {
  url: string;
  name: string;
  mimeType?: string;
  size?: number;
  kind?: 'image' | 'video';
}

interface AdminTicketMessage {
  id: string;
  body: string;
  isStaff: boolean;
  authorName?: string | null;
  attachments?: AdminTicketAttachment[];
  createdAt: string;
}

interface LinkedTask {
  id: string;
  code: string;
  status: string;
  credits: number;
  refunded: boolean;
  error?: string | null;
  createdAt: string;
  tool?: { name: string } | null;
}

interface AdminTicket {
  id: string;
  rawId?: string;
  code: number;
  siteCode?: string;
  siteDomain?: string;
  isFromChildSite?: boolean;
  subject: string;
  category: string;
  status: string;
  orderCodes?: string | null;
  staffUnread?: boolean;
  lastReplyAt: string;
  createdAt: string;
  user?: {
    id: string;
    name: string;
    email: string;
    walletBalance: number;
  };
  lastMessage?: {
    body: string;
    isStaff: boolean;
  } | null;
  messages?: AdminTicketMessage[];
  linkedTasks?: LinkedTask[];
}

interface AdminTicketSiteSummary {
  code: string;
  domain: string;
  count: number;
  openCount: number;
}

interface AdminTicketList {
  data: AdminTicket[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  counts: { ALL: number; OPEN: number; ANSWERED: number; CLOSED: number };
  unread: number;
  sites?: AdminTicketSiteSummary[];
}

const CATEGORY_LABELS: Record<string, string> = {
  ORDER: 'Đơn hàng / Tác vụ AI',
  PAYMENT: 'Nạp tiền & Thanh toán',
  SERVICE: 'Dịch vụ / Model AI',
  API: 'API & Website con',
  OTHER: 'Khác',
};

const TABS = [
  { value: '', label: 'Tất cả', countKey: 'ALL' as const },
  { value: 'OPEN', label: 'Chờ phản hồi', countKey: 'OPEN' as const },
  { value: 'ANSWERED', label: 'Đã phản hồi', countKey: 'ANSWERED' as const },
  { value: 'CLOSED', label: 'Đã đóng', countKey: 'CLOSED' as const },
];

function fmtVnd(n: number) {
  return `${Math.round(n || 0).toLocaleString('vi-VN')}đ`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'ANSWERED') {
    return <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">Đã phản hồi</Badge>;
  }
  if (status === 'CLOSED') {
    return <Badge variant="secondary">Đã đóng</Badge>;
  }
  return (
    <Badge className="bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300">
      {status === 'CUSTOMER_REPLY' ? 'Khách vừa nhắn' : 'Chờ xử lý'}
    </Badge>
  );
}

export default function AdminTicketsPage() {
  return (
    <>
      <PageHeader
        title="Ticket hỗ trợ"
        description="Tiếp nhận và phản hồi trực tiếp các yêu cầu hỗ trợ kỹ thuật, đơn hàng AI và thanh toán từ khách hàng"
        breadcrumbs={[{ label: 'AI Studio' }, { label: 'Ticket hỗ trợ' }]}
      />
      <PageBody>
        <TicketsBoard />
      </PageBody>
    </>
  );
}

function TicketsBoard() {
  const { user } = useAuth();
  const isChildSite = !!user?.isChildSite;
  const [status, setStatus] = useState('');
  const [site, setSite] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inspectUser, setInspectUser] = useState<TicketUserTarget | null>(null);

  const q = useQuery({
    queryKey: ['admin', 'tickets', { status, site, search, page }],
    queryFn: () =>
      api.get<AdminTicketList>('/admin/tickets', {
        status: status || undefined,
        site: !isChildSite && site !== 'all' ? site : undefined,
        search: search.trim() || undefined,
        page,
        limit: 25,
      }),
    refetchInterval: 15_000,
  });

  const counts = q.data?.counts ?? { ALL: 0, OPEN: 0, ANSWERED: 0, CLOSED: 0 };
  const sites = q.data?.sites ?? [];

  const columns: Column<AdminTicket>[] = [
    {
      key: 'code',
      header: 'Mã / Web',
      cell: (r) => (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
            <span>#{r.code}</span>
            {r.staffUnread && <span className="size-2 rounded-full bg-rose-500" title="Chưa đọc" />}
          </div>
          {!isChildSite && r.siteDomain && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
                r.isFromChildSite
                  ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                  : 'border-border bg-muted/50 text-muted-foreground',
              )}
            >
              <Globe className="size-2.5 shrink-0" />
              {r.siteDomain}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'subject',
      header: 'Yêu cầu hỗ trợ',
      mobile: 'primary',
      className: 'min-w-[240px] whitespace-normal',
      cell: (r) => (
        <div className="max-w-md space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{r.subject}</span>
            {r.staffUnread && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                <Sparkles className="size-2.5" /> Mới
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              {CATEGORY_LABELS[r.category] ?? r.category}
            </Badge>
            {r.orderCodes && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
                Đơn: {r.orderCodes}
              </span>
            )}
          </div>
          {r.lastMessage && (
            <div className="line-clamp-1 text-xs text-muted-foreground">
              <b>{r.lastMessage.isStaff ? 'Admin:' : 'Khách:'}</b> {r.lastMessage.body}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'user',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="text-xs">
          {r.user?.id ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setInspectUser({
                  siteCode: r.isFromChildSite ? r.siteCode || 'main' : 'main',
                  siteDomain: r.siteDomain,
                  userId: r.user!.id,
                  userName: r.user!.name,
                  userEmail: r.user!.email,
                });
              }}
              className="text-left font-semibold hover:text-primary hover:underline"
              title="Bấm để mở Sửa thành viên & Cộng / Trừ tiền ví ngay tại đây"
            >
              {r.user.name || '—'}
            </button>
          ) : (
            <div className="font-semibold">{r.user?.name || '—'}</div>
          )}
          <div className="text-muted-foreground">{r.user?.email}</div>
          <div className="mt-0.5 font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
            Ví: {fmtVnd(r.user?.walletBalance ?? 0)}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'updatedAt',
      header: 'Cập nhật cuối',
      cell: (r) => <span className="text-xs whitespace-nowrap tabular-nums">{formatDate(r.lastReplyAt || r.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <div className="flex justify-end">
          <Button size="sm" variant={r.staffUnread ? 'default' : 'outline'} onClick={(e) => (e.stopPropagation(), setOpenId(r.id))}>
            <MessageSquareText className="size-3.5" /> Xem & trả lời
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((tab) => {
            const active = status === tab.value;
            return (
              <Button
                key={tab.value}
                size="sm"
                variant={active ? 'default' : 'outline'}
                onClick={() => {
                  setStatus(tab.value);
                  setPage(1);
                }}
              >
                {tab.label} ({counts[tab.countKey] ?? 0})
              </Button>
            );
          })}
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {!isChildSite && sites.length > 1 && (
            <Select
              value={site}
              onValueChange={(v) => {
                setSite(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-[210px] text-xs">
                <SelectValue placeholder="Tất cả website" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  Tất cả website ({sites.reduce((s, x) => s + x.count, 0)})
                </SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.code === 'main' ? `${s.domain} (Web chính)` : s.domain} ({s.count}
                    {s.openCount > 0 ? ` · ${s.openCount} chờ` : ''})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="relative min-w-0 flex-1 sm:w-64">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Tìm #mã, email, mã đơn, domain..."
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="icon" onClick={() => void q.refetch()} title="Làm mới">
            <RotateCcw className={cn('size-4', q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={q.data?.data ?? []}
        loading={q.isLoading}
        onRowClick={(r) => setOpenId(r.id)}
        emptyTitle="Chưa có ticket hỗ trợ nào"
        meta={q.data?.meta}
        onPageChange={setPage}
      />

      <AdminTicketDialog
        ticketId={openId}
        paused={!!inspectUser}
        onClose={() => setOpenId(null)}
        onInspectUser={(u) => setInspectUser(u)}
      />
      <TicketSiteUserDialog target={inspectUser} onClose={() => setInspectUser(null)} />
    </div>
  );
}

function AdminTicketDialog({
  ticketId,
  paused,
  onClose,
  onInspectUser,
}: {
  ticketId: string | null;
  paused?: boolean;
  onClose: () => void;
  onInspectUser: (u: TicketUserTarget) => void;
}) {
  const qc = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [attachments, setAttachments] = useState<AdminTicketAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);

  useEffect(() => {
    setReplyText('');
    setAttachments([]);
    setUploading(false);
  }, [ticketId]);

  const uploadFiles = async (fileList: File[]) => {
    const allowed = fileList.filter((f) => /^(image|video)\//i.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f.name));
    if (!allowed.length) return;
    if (attachments.length + allowed.length > 6) {
      toast.error('Mỗi tin nhắn đính kèm tối đa 6 ảnh/video');
      return;
    }
    setUploading(true);
    try {
      const uploaded: AdminTicketAttachment[] = [];
      for (const file of allowed) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await api.upload<AdminTicketAttachment>('/account/ai/uploads?ticket=1', fd);
        uploaded.push(res);
      }
      setAttachments((prev) => [...prev, ...uploaded].slice(0, 6));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file' && /^(image|video)\//i.test(it.type))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  const q = useQuery({
    queryKey: ['admin', 'ticket', ticketId],
    queryFn: () => api.get<AdminTicket>(`/admin/tickets/${ticketId}`),
    enabled: !!ticketId,
    refetchInterval: 8_000,
  });

  const reply = useMutation({
    mutationFn: () =>
      api.post<AdminTicket>(`/admin/tickets/${ticketId}/reply`, {
        message: replyText.trim(),
        attachments,
      }),
    onSuccess: (updated) => {
      setReplyText('');
      setAttachments([]);
      qc.setQueryData(['admin', 'ticket', ticketId], updated);
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      toast.success('Đã gửi phản hồi cho khách');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setStatus = useMutation({
    mutationFn: (nextStatus: 'OPEN' | 'CLOSED') => api.put<AdminTicket>(`/admin/tickets/${ticketId}/status`, { status: nextStatus }),
    onSuccess: (updated) => {
      qc.setQueryData(['admin', 'ticket', ticketId], updated);
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      toast.success(updated.status === 'CLOSED' ? 'Đã đóng ticket' : 'Đã mở lại ticket');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const refundTask = useMutation({
    mutationFn: (taskId: string) => api.post(`/admin/tickets/${ticketId}/refund-task/${taskId}`, {}),
    onSuccess: (updated) => {
      if (updated) qc.setQueryData(['admin', 'ticket', ticketId], updated);
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      toast.success('Đã hoàn tiền & tự gửi thông báo cho khách');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const quickNotifyRefund = useMutation({
    mutationFn: () =>
      api.post<AdminTicket>(`/admin/tickets/${ticketId}/reply`, {
        message: 'Đơn hàng của sếp đã được hoàn tiền rồi ạ',
        attachments: [],
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['admin', 'ticket', ticketId], updated);
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      toast.success('Đã gửi thông báo hoàn tiền cho khách');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const tk = q.data;
  const alreadyNotifiedRefund = (tk?.messages ?? []).some((m) => m.isStaff && /đã được hoàn tiền/i.test(m.body));

  return (
    <>
      <Dialog open={!!ticketId && !previewTaskId && !paused} onOpenChange={(v) => !v && !previewTaskId && !paused && onClose()}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="min-w-0 border-b px-3.5 py-3 text-left sm:px-6 sm:py-4">
          {tk ? (
            <div className="flex min-w-0 flex-col gap-2 pr-7 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-bold">#{tk.code}</span>
                  {tk.siteDomain && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-semibold',
                        tk.isFromChildSite
                          ? 'border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                          : 'border-border bg-muted/60 text-muted-foreground',
                      )}
                    >
                      <Globe className="size-3 shrink-0" />
                      {tk.isFromChildSite ? `Web con: ${tk.siteDomain}` : tk.siteDomain}
                    </span>
                  )}
                  <StatusBadge status={tk.status} />
                  <Badge variant="outline" className="max-w-full truncate">{CATEGORY_LABELS[tk.category] ?? tk.category}</Badge>
                </div>
                <DialogTitle className="text-base font-bold break-words">{tk.subject}</DialogTitle>
                {tk.user && (
                  <div className="text-xs leading-relaxed text-muted-foreground break-words">
                    Khách:{' '}
                    <button
                      type="button"
                      onClick={() =>
                        onInspectUser({
                          siteCode: tk.isFromChildSite ? tk.siteCode || 'main' : 'main',
                          siteDomain: tk.siteDomain,
                          userId: tk.user!.id,
                          userName: tk.user!.name,
                          userEmail: tk.user!.email,
                        })
                      }
                      className="font-bold text-primary underline underline-offset-2 hover:opacity-80"
                      title="Bấm để mở Sửa thành viên & Cộng / Trừ tiền ví ngay"
                    >
                      {tk.user.name}
                    </button>{' '}
                    (<span className="break-all">{tk.user.email}</span>) · Số dư ví:{' '}
                    <button
                      type="button"
                      onClick={() =>
                        onInspectUser({
                          siteCode: tk.isFromChildSite ? tk.siteCode || 'main' : 'main',
                          siteDomain: tk.siteDomain,
                          userId: tk.user!.id,
                          userName: tk.user!.name,
                          userEmail: tk.user!.email,
                        })
                      }
                      className="font-bold text-emerald-600 underline decoration-dotted underline-offset-2 hover:opacity-80 dark:text-emerald-400"
                      title="Bấm để Cộng / Trừ tiền hoặc xem lịch sử ví"
                    >
                      {fmtVnd(tk.user.walletBalance)} ✎
                    </button>
                  </div>
                )}
              </div>

              <div className="shrink-0 self-start">
                {tk.status === 'CLOSED' ? (
                  <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate('OPEN')}>
                    <LockOpen className="size-3.5" /> Mở lại
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate('CLOSED')}>
                    <XCircle className="size-3.5" /> Đóng ticket
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <DialogTitle>Chi tiết Ticket</DialogTitle>
          )}
        </DialogHeader>

        {/* Nếu có mã đơn AI liên quan -> bấm mã đơn mở chi tiết hoặc hoàn tiền 1 chạm tự báo khách (T-202, T-203 & T-409) */}
        {tk?.linkedTasks && tk.linkedTasks.length > 0 && (
          <div className="min-w-0 border-b bg-amber-500/[0.06] px-3.5 py-2.5 text-xs sm:px-6">
            <div className="font-semibold text-foreground">Tác vụ AI đính kèm (bấm mã đơn để xem chi tiết):</div>
            <div className="mt-1.5 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
              {tk.linkedTasks.map((tItem) => {
                const canRefundNow =
                  !tItem.refunded && tItem.credits > 0 && ['PENDING', 'PROCESSING', 'SUCCEEDED'].includes(tItem.status);
                return (
                  <div
                    key={tItem.id}
                    onClick={() => {
                      if (!tk.isFromChildSite) setPreviewTaskId(tItem.id);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !tk.isFromChildSite) {
                        e.preventDefault();
                        setPreviewTaskId(tItem.id);
                      }
                    }}
                    title={`Bấm để xem chi tiết tác vụ #${tItem.code}`}
                    className="group w-full min-w-0 max-w-full cursor-pointer overflow-hidden rounded-lg border bg-card px-2.5 py-1.5 text-left transition hover:border-primary hover:bg-primary/5 sm:w-auto"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono font-bold text-primary group-hover:underline">
                        #{tItem.code}
                      </span>
                      <span className="min-w-0 break-words">· {tItem.tool?.name ?? 'AI'} ·</span>
                      <ToneBadge map={TASK_STATUS} value={tItem.status} />
                      <span className="font-semibold tabular-nums">· {fmtVnd(tItem.credits)}</span>
                      {canRefundNow && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={refundTask.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            refundTask.mutate(tItem.id);
                          }}
                          className="ml-1 h-6 gap-1 rounded-md px-2 text-[11px] font-semibold"
                        >
                          {refundTask.isPending ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                          Hoàn tiền
                        </Button>
                      )}
                      {tItem.refunded && !alreadyNotifiedRefund && tk.status !== 'CLOSED' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={quickNotifyRefund.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            quickNotifyRefund.mutate();
                          }}
                          className="ml-1 h-6 gap-1 rounded-md border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                        >
                          {quickNotifyRefund.isPending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                          Báo đã hoàn tiền
                        </Button>
                      )}
                    </div>
                    {tItem.error && <div className="mt-0.5 text-[11px] leading-snug text-destructive break-words whitespace-normal">Lỗi: {tItem.error}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="min-h-[200px] min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto bg-muted/25 p-3 sm:p-6">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            (tk?.messages ?? []).map((m) => (
              <div key={m.id} className={cn('flex min-w-0 flex-col', m.isStaff ? 'items-end' : 'items-start')}>
                <div className="mb-1 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] text-muted-foreground">
                  {m.isStaff ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3 shrink-0" /> {m.authorName || 'Quản trị viên'}
                    </span>
                  ) : (
                    <span className="font-semibold text-foreground">{m.authorName || tk?.user?.name || 'Khách hàng'}</span>
                  )}
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Clock className="size-3 shrink-0" />
                    {formatDate(m.createdAt)}
                  </span>
                </div>
                <div
                  className={cn(
                    'max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap shadow-2xs sm:max-w-[85%] sm:px-4',
                    m.isStaff ? 'bg-primary text-primary-foreground' : 'border bg-card text-foreground',
                  )}
                >
                  {m.body ? <div>{m.body}</div> : null}
                  {m.attachments && m.attachments.length > 0 && (
                    <div className={cn('grid gap-2', m.body && 'mt-2')}>
                      {m.attachments.map((att, idx) => {
                        const isVid =
                          att.kind === 'video' ||
                          att.mimeType?.startsWith('video/') ||
                          /\.(mp4|webm|mov)(\?|$)/i.test(att.url);
                        return isVid ? (
                          <div key={`${att.url}-${idx}`} className="overflow-hidden rounded-xl border border-black/20 bg-black">
                            <video
                              src={att.url}
                              controls
                              playsInline
                              preload="metadata"
                              className="max-h-80 w-full object-contain"
                            />
                          </div>
                        ) : (
                          <a
                            key={`${att.url}-${idx}`}
                            href={att.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block overflow-hidden rounded-xl border border-black/15 bg-black/10"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={att.url} alt={att.name || ''} className="max-h-80 w-full object-contain" />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if ((!replyText.trim() && attachments.length === 0) || uploading) return;
            reply.mutate();
          }}
          className="min-w-0 space-y-2.5 border-t bg-card p-3 sm:px-6 sm:py-4"
        >
          {(attachments.length > 0 || uploading) && (
            <div className="flex flex-wrap items-center gap-2">
              {attachments.map((att, idx) => {
                const isVid =
                  att.kind === 'video' ||
                  att.mimeType?.startsWith('video/') ||
                  /\.(mp4|webm|mov)(\?|$)/i.test(att.url);
                return (
                  <div key={`${att.url}-${idx}`} className="group relative overflow-hidden rounded-xl border bg-muted/40">
                    {isVid ? (
                      <div className="relative flex h-16 w-24 items-center justify-center bg-black text-white">
                        <video src={att.url} muted preload="metadata" className="h-full w-full object-cover opacity-80" />
                        <Film className="absolute size-5 drop-shadow" />
                      </div>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={att.url} alt={att.name || ''} className="h-16 w-20 object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/75 text-white hover:bg-destructive"
                      aria-label="Gỡ tệp đính kèm"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
              {uploading && (
                <div className="inline-flex h-16 items-center gap-1.5 rounded-xl border border-dashed px-3 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Đang tải ảnh/video…
                </div>
              )}
            </div>
          )}

          <div className="flex min-w-0 items-end gap-2">
            <label
              title="Đính kèm ảnh hoặc video (hoặc dán Ctrl+V trực tiếp vào ô nhập)"
              className={cn(
                'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-medium transition hover:bg-muted',
                uploading && 'pointer-events-none opacity-60',
              )}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4 text-primary" />}
              <span className="hidden sm:inline">Ảnh / Video</span>
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void uploadFiles(files);
                }}
              />
            </label>
            <textarea
              rows={2}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onPaste={handlePaste}
              placeholder="Nhập câu trả lời hoặc dán ảnh (Ctrl+V) / đính kèm video..."
              className="min-h-[44px] min-w-0 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-base outline-none focus:border-primary sm:px-3.5 sm:py-2.5 sm:text-sm"
            />
            <Button
              type="submit"
              disabled={reply.isPending || uploading || (!replyText.trim() && attachments.length === 0)}
              className="h-11 shrink-0 px-3 font-semibold sm:px-5"
            >
              {reply.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              <span className="sm:hidden">Gửi</span>
              <span className="hidden sm:inline">Gửi trả lời</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <AdminAiTaskDialog
      id={previewTaskId}
      onClose={() => {
        setPreviewTaskId(null);
        void q.refetch();
        void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
        void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      }}
      backLabel="Quay lại Ticket"
    />
    </>
  );
}
