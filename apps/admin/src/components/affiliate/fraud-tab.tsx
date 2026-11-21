'use client';

/**
 * Tab "Lọc Aff 2 nick" (T-431): Rà soát & lọc tự động các cặp khách hàng dùng chính mình tạo 2 tài khoản
 * để tự ăn hoa hồng (trùng IP phiên đăng nhập / OAuth / chạy AI, trùng STK ngân hàng, trùng họ tên, trùng gốc email, nick mồi tạo sát giờ).
 */
import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Search, ShieldAlert, ShieldCheck, Unlink, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

interface SelfRefFlag {
  code: string;
  label: string;
  severity: 'high' | 'medium';
}

interface SelfRefItem {
  child: {
    id: string;
    name: string;
    email: string;
    createdAt: string;
    walletBalance: number;
    totalDeposited: number;
  };
  referrer: {
    id: string;
    name: string;
    email: string;
    referralCode: string | null;
    createdAt: string;
    affiliateBalance: number;
    aiTaskCount: number;
  };
  earnedFromChild: number;
  riskScore: number;
  suspicious: boolean;
  flags: SelfRefFlag[];
}

interface SelfRefAuditResponse {
  totalPairs: number;
  suspiciousCount: number;
  items: SelfRefItem[];
}

export function FraudAuditTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [mode, setMode] = useState<'suspicious' | 'all'>('suspicious');
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['affiliate-self-referrals', mode, search],
    queryFn: () =>
      api.get<SelfRefAuditResponse>('/admin/affiliate/self-referrals', {
        mode,
        search: search.trim() || undefined,
      }),
  });

  const unlink = useMutation({
    mutationFn: (vars: { childId: string; revokeEarned: boolean }) =>
      api.post<{ ok: boolean; revokedAmount: number }>(`/admin/affiliate/self-referrals/${vars.childId}/unlink`, {
        revokeEarned: vars.revokeEarned,
      }),
    onSuccess: (res) => {
      toast.success(
        res.revokedAmount > 0
          ? `Đã gỡ liên kết Aff & thu hồi ${formatMoney(res.revokedAmount)} hoa hồng tự giới thiệu`
          : 'Đã gỡ liên kết giới thiệu giữa 2 tài khoản',
      );
      void qc.invalidateQueries({ queryKey: ['affiliate-self-referrals'] });
      void qc.invalidateQueries({ queryKey: ['affiliate-stats'] });
      void qc.invalidateQueries({ queryKey: ['affiliate-transactions'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const handleUnlink = async (it: SelfRefItem, revokeEarned: boolean) => {
    const ok = await confirm({
      title: revokeEarned ? 'Gỡ Aff & Thu hồi hoa hồng cặp 2 nick này?' : 'Gỡ liên kết giới thiệu cặp 2 nick này?',
      description: revokeEarned
        ? `Hệ thống sẽ ngắt vĩnh viễn liên kết giới thiệu từ "${it.referrer.email}" sang "${it.child.email}" và thu hồi phần hoa hồng đã cộng (${formatMoney(it.earnedFromChild)}) trong ví hoa hồng.`
        : `Hệ thống sẽ ngắt liên kết giới thiệu từ "${it.referrer.email}" sang "${it.child.email}" để các lần nạp sau không phát sinh hoa hồng nữa.`,
      confirmText: revokeEarned ? 'Gỡ & Thu hồi' : 'Gỡ liên kết',
      destructive: true,
    });
    if (!ok) return;
    unlink.mutate({ childId: it.child.id, revokeEarned });
  };

  const items = q.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Cơ chế lọc tự động chống Aff 2 nick:</span> Hệ thống đối chiếu chéo{' '}
        <b>IP đăng nhập / Google OAuth / IP chạy AI</b>, <b>Số tài khoản ngân hàng rút tiền</b>, <b>Telegram ID</b>,{' '}
        <b>Họ tên trùng khớp</b>, <b>Email seri cùng gốc</b> và <b>Nick mồi 0 lượt dùng AI tạo sát giờ</b> — đồng thời tự động chặn cộng hoa hồng mới ngay lúc nạp tiền khi phát hiện trùng thiết bị / danh tính.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={mode === 'suspicious' ? 'default' : 'outline'}
            onClick={() => setMode('suspicious')}
          >
            <ShieldAlert className="size-3.5" />
            Nghi vấn Aff 2 nick ({q.data?.suspiciousCount ?? 0})
          </Button>
          <Button
            size="sm"
            variant={mode === 'all' ? 'default' : 'outline'}
            onClick={() => setMode('all')}
          >
            Tất cả cặp giới thiệu ({q.data?.totalPairs ?? 0})
          </Button>
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-72">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm email, họ tên, IP..."
              className="h-9 pl-8 text-xs"
            />
          </div>
          <Button size="icon" variant="outline" className="size-9" onClick={() => void q.refetch()} title="Quét lại">
            <RotateCcw className={cn('size-4', q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <Card className="py-0">
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin" /> Đang quét chéo dữ liệu IP, phiên OAuth & danh tính...
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-sm text-muted-foreground">
              <ShieldCheck className="size-8 text-emerald-500 opacity-80" />
              <p>{mode === 'suspicious' ? 'Hiện chưa phát hiện cặp tài khoản nào nghi vấn Aff 2 nick.' : 'Chưa có cặp giới thiệu nào.'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/35 hover:bg-muted/35">
                    <TableHead className="pl-4 text-xs">Nick giới thiệu (Nhận HH)</TableHead>
                    <TableHead className="text-xs">Nick được giới thiệu (Nạp tiền)</TableHead>
                    <TableHead className="text-xs">Dấu hiệu trùng / Nghi vấn</TableHead>
                    <TableHead className="text-right text-xs">Đã nạp / HH phát sinh</TableHead>
                    <TableHead className="pr-4 text-right text-xs">Xử lý</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.child.id} className="align-middle">
                      <TableCell className="py-3 pl-4 text-xs">
                        <Link href={`/users/${it.referrer.id}`} className="font-semibold text-foreground hover:text-primary hover:underline">
                          {it.referrer.name || '—'}
                        </Link>
                        <div className="text-muted-foreground">{it.referrer.email}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                          Tạo: {formatDate(it.referrer.createdAt, 'dd/MM HH:mm')} · {it.referrer.aiTaskCount} đơn AI · Ví HH:{' '}
                          <b className="text-foreground">{formatMoney(it.referrer.affiliateBalance)}</b>
                        </div>
                      </TableCell>

                      <TableCell className="py-3 text-xs">
                        <Link href={`/users/${it.child.id}`} className="font-semibold text-foreground hover:text-primary hover:underline">
                          {it.child.name || '—'}
                        </Link>
                        <div className="text-muted-foreground">{it.child.email}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                          Tạo: {formatDate(it.child.createdAt, 'dd/MM HH:mm')} · Ví: <b className="text-foreground">{formatMoney(it.child.walletBalance)}</b>
                        </div>
                      </TableCell>

                      <TableCell className="py-3">
                        {it.flags.length > 0 ? (
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {it.flags.map((f, idx) => (
                              <Badge
                                key={`${f.code}-${idx}`}
                                variant="outline"
                                className={cn(
                                  'text-[11px] font-medium whitespace-normal',
                                  f.severity === 'high'
                                    ? 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300'
                                    : 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300',
                                )}
                              >
                                {f.label}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">Hợp lệ (khác IP & danh tính)</span>
                        )}
                      </TableCell>

                      <TableCell className="py-3 text-right text-xs whitespace-nowrap tabular-nums">
                        <div>Nạp: <b>{formatMoney(it.child.totalDeposited)}</b></div>
                        <div className={cn('mt-0.5 font-semibold', it.earnedFromChild > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                          HH: {formatMoney(it.earnedFromChild)}
                        </div>
                      </TableCell>

                      <TableCell className="py-3 pr-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {it.earnedFromChild > 0 ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2.5 text-xs"
                              disabled={unlink.isPending}
                              onClick={() => void handleUnlink(it, true)}
                            >
                              <Undo2 className="size-3.5" /> Gỡ &amp; Thu hồi HH
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              disabled={unlink.isPending}
                              onClick={() => void handleUnlink(it, false)}
                            >
                              <Unlink className="size-3.5" /> Gỡ liên kết Aff
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
