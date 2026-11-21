'use client';

/** Tab Tổng quan: số liệu hoa hồng / rút tiền + top người giới thiệu (GET /admin/affiliate/stats) */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Clock, Coins, Gift, Landmark, Undo2, Users, Wallet } from 'lucide-react';
import { KpiCard } from '@/components/reports/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { UserCell, type AffiliateStats } from './shared';

const num = (n: number) => n.toLocaleString('vi-VN');

export function OverviewTab() {
  const q = useQuery({ queryKey: ['affiliate-stats'], queryFn: () => api.get<AffiliateStats>('/admin/affiliate/stats') });
  const d = q.data;
  const loading = q.isLoading;
  if (q.error)
    return (
      <EmptyState
        title="Không tải được số liệu"
        description={errorMessage(q.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            Thử lại
          </Button>
        }
      />
    );

  return (
    <div className="space-y-6">
      {d && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={d.settings.enabled ? 'default' : 'secondary'}>{d.settings.enabled ? 'Đang bật' : 'Đang tắt'}</Badge>
          <span>
            Hoa hồng <b className="text-foreground">{d.settings.commission}%</b> mỗi lần nạp · rút tối thiểu <b className="text-foreground">{formatMoney(d.settings.minPayout)}</b>
          </span>
          <Link href="?tab=settings" className="text-primary hover:underline">
            Đổi cài đặt
          </Link>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Hoa hồng đã trả" icon={Gift} loading={loading} value={formatMoney(d?.commissionTotal)} hint={d ? `30 ngày qua ${formatMoney(d.commission30d)}` : undefined} />
        <KpiCard title="Đã thu hồi" icon={Undo2} loading={loading} value={formatMoney(d?.revokedTotal)} hint="do rút lại tiền nạp" />
        <KpiCard title="Số dư hoa hồng của khách" icon={Coins} loading={loading} value={formatMoney(d?.outstanding)} hint="chưa rút, đang nằm trong ví hoa hồng" />
        <KpiCard
          title="Yêu cầu rút chờ duyệt"
          icon={Clock}
          loading={loading}
          value={<span className={d && d.pendingCount > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}>{num(d?.pendingCount ?? 0)}</span>}
          hint={
            <Link href="?tab=payouts" className="hover:text-primary">
              {formatMoney(d?.pendingAmount ?? 0)} · xem danh sách
            </Link>
          }
        />
        <KpiCard title="Đã rút vào ví" icon={Wallet} loading={loading} value={formatMoney(d?.paidToWallet)} />
        <KpiCard title="Đã rút về ngân hàng" icon={Landmark} loading={loading} value={formatMoney(d?.paidToBank)} />
        <KpiCard title="Người được giới thiệu" icon={Users} loading={loading} value={num(d?.referred ?? 0)} />
        <KpiCard title="Người giới thiệu" icon={Banknote} loading={loading} value={num(d?.referrers ?? 0)} hint="có ít nhất 1 người đăng ký qua link" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top người giới thiệu</CardTitle>
        </CardHeader>
        <CardContent>
          {!d?.top.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{loading ? 'Đang tải...' : 'Chưa có hoa hồng nào được trả.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Khách</TableHead>
                    <TableHead>Mã</TableHead>
                    <TableHead className="text-right">Người giới thiệu</TableHead>
                    <TableHead className="text-right">Hoa hồng ròng</TableHead>
                    <TableHead className="text-right">Số dư hoa hồng</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.top.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <UserCell user={u} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{u.referralCode ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(u.referrals)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(u.earned)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(u.affiliateBalance)}</TableCell>
                      <TableCell className="text-right">
                        <Link href={`?tab=transactions&userId=${u.id}`} className="text-xs text-primary hover:underline">
                          Lịch sử
                        </Link>
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
