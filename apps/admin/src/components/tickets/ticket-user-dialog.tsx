'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  ExternalLink,
  Film,
  Globe,
  Loader2,
  LogOut,
  RotateCcw,
  Save,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { TASK_STATUS, ToneBadge } from '@/components/ai/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface TicketUserTarget {
  siteCode: string;
  siteDomain?: string;
  userId: string;
  userName?: string;
  userEmail?: string;
}

interface SiteUserInspection {
  siteCode: string;
  siteDomain: string;
  siteName?: string;
  isFromChildSite: boolean;
  duplicate?: boolean;
  revokedSessions?: number;
  user: {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    status: 'ACTIVE' | 'PENDING' | 'INACTIVE' | 'BANNED';
    walletBalance: number;
    customDiscount: number;
    lastLoginAt: string | null;
    lastLoginIp: string | null;
    lockReason: string | null;
    createdAt: string;
    activeSessions: number;
    role?: { id: string; name: string; slug: string };
  };
  stats: {
    balance: number;
    totalDeposited: number;
    totalWithdrawn: number;
    totalSpent: number;
    totalRefunded: number;
    transactionCount: number;
  };
  recentTransactions: {
    id: string;
    type: string;
    amount: number;
    balanceAfter: number;
    note: string | null;
    createdAt: string;
  }[];
  recentTasks: {
    id: string;
    code: string;
    status: string;
    credits: number;
    refunded: boolean;
    error?: string | null;
    createdAt: string;
    tool?: { name: string } | null;
  }[];
}

const TX_LABELS: Record<string, { label: string; cls: string }> = {
  DEPOSIT: { label: 'Nạp / Cộng', cls: 'text-emerald-600 dark:text-emerald-400' },
  WITHDRAW: { label: 'Trừ tiền', cls: 'text-rose-600 dark:text-rose-400' },
  PAYMENT: { label: 'Dùng AI', cls: 'text-amber-700 dark:text-amber-300' },
  REFUND: { label: 'Hoàn tiền', cls: 'text-sky-600 dark:text-sky-400' },
};

function makeIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `wk-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function fmtVnd(n: number) {
  return `${Math.round(n || 0).toLocaleString('vi-VN')}đ`;
}

export function TicketSiteUserDialog({
  target,
  onClose,
  onChanged,
}: {
  target: TicketUserTarget | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWallet = can('users.wallet');
  const canWrite = can('users.write');
  const canRefundTask = can('ai.tasks.manage');

  const [tab, setTab] = useState<'wallet' | 'profile' | 'tasks'>('wallet');
  const [txType, setTxType] = useState<'deposit' | 'withdraw'>('deposit');
  const [amountRaw, setAmountRaw] = useState('');
  const [txNote, setTxNote] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey());

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'PENDING' | 'INACTIVE' | 'BANNED'>('ACTIVE');
  const [customDiscount, setCustomDiscount] = useState('0');
  const [newPassword, setNewPassword] = useState('');

  const siteCode = target?.siteCode || 'main';
  const userId = target?.userId || '';

  const q = useQuery({
    queryKey: ['admin', 'ticket-site-user', siteCode, userId],
    queryFn: () => api.get<SiteUserInspection>(`/admin/tickets/site-users/${encodeURIComponent(siteCode)}/${encodeURIComponent(userId)}`),
    enabled: !!target && !!userId,
  });

  useEffect(() => {
    setTab('wallet');
    setAmountRaw('');
    setTxNote('');
    setNewPassword('');
    setIdempotencyKey(makeIdempotencyKey());
  }, [siteCode, userId]);

  useEffect(() => {
    if (!q.data?.user) return;
    setName(q.data.user.name || '');
    setPhone(q.data.user.phone || '');
    setStatus(q.data.user.status || 'ACTIVE');
    setCustomDiscount(String(q.data.user.customDiscount ?? 0));
  }, [q.data?.user]);

  const adjustWallet = useMutation({
    mutationFn: () => {
      const cleanAmt = Math.round(Number(amountRaw.replace(/[^\d]/g, '')) || 0);
      if (cleanAmt <= 0) throw new Error('Vui lòng nhập số tiền lớn hơn 0đ');
      return api.post<SiteUserInspection>(
        `/admin/tickets/site-users/${encodeURIComponent(siteCode)}/${encodeURIComponent(userId)}/wallet`,
        {
          type: txType,
          amount: cleanAmt,
          note: txNote.trim() || undefined,
          idempotencyKey,
        },
      );
    },
    onSuccess: (updated) => {
      // Đổi khoá chống trùng MỚI sau khi giao dịch thành công để lượt cộng/trừ tiếp theo hợp lệ, nhưng bấm đúp lúc đang gửi vẫn chung 1 khoá cũ!
      setIdempotencyKey(makeIdempotencyKey());
      setAmountRaw('');
      setTxNote('');
      qc.setQueryData(['admin', 'ticket-site-user', siteCode, userId], updated);
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'ticket'] });
      onChanged?.();
      if (updated.duplicate) {
        toast.info('Lệnh này đã được ghi nhận trước đó — hệ thống tự chặn không cộng/trừ lặp lần 2!');
      } else {
        toast.success(
          `Đã ${txType === 'deposit' ? 'cộng' : 'trừ'} tiền thành công · Số dư mới: ${fmtVnd(updated.user.walletBalance)}`,
        );
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const updateUser = useMutation({
    mutationFn: (extra?: { forceLogout?: boolean }) =>
      api.put<SiteUserInspection>(
        `/admin/tickets/site-users/${encodeURIComponent(siteCode)}/${encodeURIComponent(userId)}`,
        {
          name: name.trim(),
          phone: phone.trim(),
          status,
          customDiscount: Math.max(0, Math.min(100, Number(customDiscount) || 0)),
          ...(newPassword.trim() ? { password: newPassword.trim() } : {}),
          ...(extra?.forceLogout ? { forceLogout: true } : {}),
        },
      ),
    onSuccess: (updated, vars) => {
      setNewPassword('');
      qc.setQueryData(['admin', 'ticket-site-user', siteCode, userId], updated);
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'ticket'] });
      onChanged?.();
      if (vars?.forceLogout) {
        toast.success(`Đã đăng xuất ${updated.revokedSessions ?? 0} phiên thiết bị của thành viên`);
      } else {
        toast.success('Đã lưu thông tin thành viên');
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const cancelTask = useMutation({
    mutationFn: (taskId: string) =>
      api.post(`/admin/tickets/site-users/${encodeURIComponent(siteCode)}/tasks/${encodeURIComponent(taskId)}/cancel`, {}),
    onSuccess: () => {
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'ticket'] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      onChanged?.();
      toast.success('Đã huỷ & hoàn tiền đơn AI cho khách');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d = q.data;
  const parsedAmount = Math.round(Number(amountRaw.replace(/[^\d]/g, '')) || 0);

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 py-3 text-left sm:px-6 sm:py-4">
          <div className="flex flex-wrap items-center gap-2 pr-7">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold',
                siteCode !== 'main'
                  ? 'border-sky-500/40 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              )}
            >
              <Globe className="size-3.5 shrink-0" />
              {siteCode !== 'main'
                ? `Tài khoản độc lập trên Web con: ${d?.siteDomain || target?.siteDomain || siteCode}`
                : `Tài khoản Web mẹ: ${d?.siteDomain || 'nov.ai.vn'}`}
            </span>
            {d?.user && (
              <Badge variant={d.user.status === 'ACTIVE' ? 'default' : 'destructive'} className="text-[11px]">
                {d.user.status === 'ACTIVE' ? 'Hoạt động' : d.user.status === 'BANNED' ? 'Đã khoá' : d.user.status}
              </Badge>
            )}
            {siteCode === 'main' && userId && (
              <Link
                href={`/users/${userId}`}
                onClick={onClose}
                className="ml-auto inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium hover:bg-muted"
              >
                Trang thành viên đầy đủ <ExternalLink className="size-3" />
              </Link>
            )}
          </div>
          <DialogTitle className="mt-1 text-base font-bold break-words">
            {d?.user?.name || target?.userName || 'Thành viên'}{' '}
            <span className="font-normal text-muted-foreground">({d?.user?.email || target?.userEmail})</span>
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            <ShieldCheck className="mr-1 inline size-3.5 text-emerald-600" />
            Cơ chế Email & Ví tiền độc lập 100% theo từng Website — thao tác tại đây chỉ áp dụng đúng trên{' '}
            <b>{d?.siteDomain || target?.siteDomain || 'nov.ai.vn'}</b> (có khoá chống lặp trừ/cộng tiền).
          </p>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={tab === 'wallet' ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setTab('wallet')}
            >
              <Wallet className="mr-1 size-3.5" /> Ví & Cộng / Trừ tiền
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === 'profile' ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setTab('profile')}
            >
              <UserRound className="mr-1 size-3.5" /> Sửa thành viên
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === 'tasks' ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setTab('tasks')}
            >
              <Film className="mr-1 size-3.5" /> Đơn AI ({d?.recentTasks?.length ?? 0})
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Đang tải dữ liệu thành viên...
            </div>
          ) : !d ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Không đọc được thông tin thành viên.</div>
          ) : tab === 'wallet' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-xl border bg-emerald-500/8 p-3">
                  <div className="text-[11px] text-muted-foreground">Số dư hiện tại</div>
                  <div className="mt-0.5 text-base font-bold text-emerald-700 tabular-nums dark:text-emerald-300">
                    {fmtVnd(d.user.walletBalance)}
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">Tổng đã nạp</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtVnd(d.stats.totalDeposited)}</div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">Tổng đã dùng</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtVnd(d.stats.totalSpent)}</div>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">Tổng đã hoàn</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">{fmtVnd(d.stats.totalRefunded)}</div>
                </div>
              </div>

              {canWallet && (
                <div className="space-y-3 rounded-xl border bg-card p-3.5 shadow-2xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={txType === 'deposit' ? 'default' : 'outline'}
                      className={cn('h-8 text-xs', txType === 'deposit' && 'bg-emerald-600 text-white hover:bg-emerald-700')}
                      onClick={() => setTxType('deposit')}
                    >
                      <ArrowUpCircle className="mr-1 size-3.5" /> + Cộng tiền vào ví
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={txType === 'withdraw' ? 'destructive' : 'outline'}
                      className="h-8 text-xs"
                      onClick={() => setTxType('withdraw')}
                    >
                      <ArrowDownCircle className="mr-1 size-3.5" /> - Trừ tiền khỏi ví
                    </Button>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium">Số tiền (VNĐ)</label>
                      <Input
                        inputMode="numeric"
                        placeholder="Ví dụ: 50.000"
                        value={amountRaw}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/[^\d]/g, '');
                          setAmountRaw(digits ? Number(digits).toLocaleString('vi-VN') : '');
                        }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium">Lý do / Ghi chú</label>
                      <Input
                        placeholder={txType === 'deposit' ? 'Hỗ trợ cộng bù đơn lỗi...' : 'Thu hồi cộng nhầm...'}
                        value={txNote}
                        onChange={(e) => setTxNote(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] text-muted-foreground">
                      Khoá chống lặp: <code className="font-mono">{idempotencyKey.slice(0, 8)}</code>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={adjustWallet.isPending || parsedAmount <= 0}
                      variant={txType === 'withdraw' ? 'destructive' : 'default'}
                      onClick={() => adjustWallet.mutate()}
                    >
                      {adjustWallet.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                      {txType === 'deposit'
                        ? `Xác nhận Cộng +${fmtVnd(parsedAmount)}`
                        : `Xác nhận Trừ -${fmtVnd(parsedAmount)}`}
                    </Button>
                  </div>
                </div>
              )}

              <div>
                <div className="mb-2 text-xs font-bold uppercase text-muted-foreground">Biến động số dư gần đây</div>
                {d.recentTransactions.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                    Chưa có giao dịch ví nào.
                  </div>
                ) : (
                  <div className="divide-y rounded-xl border text-xs">
                    {d.recentTransactions.map((tx) => {
                      const meta = TX_LABELS[tx.type] ?? { label: tx.type, cls: 'text-foreground' };
                      return (
                        <div key={tx.id} className="flex items-center justify-between gap-2 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('font-semibold', meta.cls)}>{meta.label}</span>
                              <span className="text-[11px] text-muted-foreground">{formatDate(tx.createdAt)}</span>
                            </div>
                            {tx.note && <div className="truncate text-muted-foreground">{tx.note}</div>}
                          </div>
                          <div className="shrink-0 text-right tabular-nums">
                            <div className={cn('font-bold', tx.amount >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                              {tx.amount >= 0 ? '+' : ''}
                              {fmtVnd(tx.amount)}
                            </div>
                            <div className="text-[11px] text-muted-foreground">Sau: {fmtVnd(tx.balanceAfter)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'profile' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium">Họ tên hiển thị</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Email đăng nhập (độc lập site này)</label>
                  <Input value={d.user.email} disabled className="bg-muted/50" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Số điện thoại</label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Chưa cập nhật" disabled={!canWrite} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Trạng thái tài khoản</label>
                  <Select value={status} onValueChange={(v) => setStatus(v as any)} disabled={!canWrite}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Hoạt động</SelectItem>
                      <SelectItem value="BANNED">Bị khoá (Cấm truy cập)</SelectItem>
                      <SelectItem value="INACTIVE">Ngừng hoạt động</SelectItem>
                      <SelectItem value="PENDING">Chờ duyệt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Ưu đãi giảm giá riêng (%)</label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={customDiscount}
                    onChange={(e) => setCustomDiscount(e.target.value)}
                    disabled={!canWrite}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Đặt mật khẩu mới (bỏ trống nếu giữ nguyên)</label>
                  <Input
                    type="text"
                    placeholder="Nhập tối thiểu 8 ký tự để đổi..."
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={!canWrite}
                  />
                </div>
              </div>

              <div className="rounded-xl border bg-muted/25 p-3 text-xs text-muted-foreground space-y-1">
                <div>Ngày tạo: <b className="text-foreground">{formatDate(d.user.createdAt)}</b></div>
                <div>
                  Đăng nhập gần nhất:{' '}
                  <b className="text-foreground">{d.user.lastLoginAt ? formatDate(d.user.lastLoginAt) : '—'}</b>
                  {d.user.lastLoginIp ? ` · IP: ${d.user.lastLoginIp}` : ''}
                </div>
                <div>Phiên đang đăng nhập: <b className="text-foreground">{d.user.activeSessions} thiết bị</b></div>
              </div>

              {canWrite && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={updateUser.isPending}
                    onClick={() => updateUser.mutate({ forceLogout: true })}
                  >
                    <LogOut className="mr-1.5 size-3.5" /> Đăng xuất mọi thiết bị
                  </Button>
                  <Button type="button" size="sm" disabled={updateUser.isPending} onClick={() => updateUser.mutate(undefined)}>
                    {updateUser.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}
                    Lưu thay đổi thành viên
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {d.recentTasks.length === 0 ? (
                <div className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
                  Thành viên này chưa chạy đơn AI nào trên {d.siteDomain}.
                </div>
              ) : (
                d.recentTasks.map((t) => {
                  const canRefundThis = !t.refunded && t.credits > 0 && ['PENDING', 'PROCESSING', 'SUCCEEDED'].includes(t.status);
                  return (
                    <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-xs">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-bold">#{t.code}</span>
                          <ToneBadge map={TASK_STATUS} value={t.status} />
                          <span className="font-semibold tabular-nums">{fmtVnd(t.credits)}</span>
                          {t.refunded && <Badge variant="secondary" className="text-[10px]">Đã hoàn ví</Badge>}
                        </div>
                        <div className="truncate font-medium">{t.tool?.name || 'Tác vụ AI'}</div>
                        <div className="text-[11px] text-muted-foreground">{formatDate(t.createdAt)}</div>
                        {t.error && <div className="text-[11px] text-rose-600">{t.error}</div>}
                      </div>
                      {canRefundTask && canRefundThis && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2.5 text-xs"
                          disabled={cancelTask.isPending}
                          onClick={() => cancelTask.mutate(t.id)}
                        >
                          <RotateCcw className="mr-1 size-3" /> Hoàn tiền
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
