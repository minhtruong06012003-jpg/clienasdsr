'use client';

/**
 * Tab Tổng quan của Trung tâm bảo mật: điểm bảo mật (gauge), số liệu 24 giờ,
 * danh sách mục kiểm tra, biểu đồ đăng nhập 14 ngày và các IP đăng nhập sai nhiều nhất.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Globe, Loader2, LogIn, ShieldAlert, ShieldCheck, ShieldOff, UserLock, XCircle } from 'lucide-react';
import type { SecurityCheck, SecurityOverview } from '@cmsnt/shared';
import { Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SECURITY_KEYS, StatCard, ToneBadge, useQuickBlockIp } from './shared';

/** Màu + nhận xét theo mức điểm: ≥80 tốt, 50–79 trung bình, <50 kém */
function scoreLevel(score: number) {
  if (score >= 80) return { stroke: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Tốt', note: 'Website được bảo vệ tốt. Tiếp tục duy trì và xử lý các mục còn cảnh báo (nếu có).' };
  if (score >= 50) return { stroke: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400', label: 'Trung bình', note: 'Còn một số điểm yếu cần xử lý. Ưu tiên các mục màu đỏ bên dưới để tăng điểm.' };
  return { stroke: 'stroke-red-500', text: 'text-red-600 dark:text-red-400', label: 'Cần cải thiện', note: 'Website đang có rủi ro bảo mật đáng kể. Hãy xử lý ngay các mục màu đỏ bên dưới.' };
}

/** Vòng tròn điểm bảo mật tự vẽ bằng SVG (cung 270°, mở ở đáy) */
function ScoreGauge({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75; // 3/4 vòng
  const value = Math.max(0, Math.min(100, score));
  const lv = scoreLevel(value);
  return (
    <div className="relative size-36 shrink-0">
      <svg viewBox="0 0 120 120" className="size-full rotate-[135deg]" aria-hidden>
        {/* nền cung */}
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" strokeLinecap="round" className="stroke-muted" strokeDasharray={`${arc} ${c}`} />
        {/* phần điểm đạt được */}
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" strokeLinecap="round" className={cn(lv.stroke, 'transition-[stroke-dasharray] duration-700')} strokeDasharray={`${(arc * value) / 100} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-4xl font-bold tabular-nums leading-none', lv.text)}>{value}</span>
        <span className="mt-1 text-[11px] text-muted-foreground">/ 100 điểm</span>
      </div>
    </div>
  );
}

/** Icon + màu theo trạng thái mục kiểm tra */
const CHECK_STATUS: Record<SecurityCheck['status'], { icon: typeof CheckCircle2; className: string; label: string }> = {
  ok: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400', label: 'Đạt' },
  warn: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400', label: 'Cảnh báo' },
  error: { icon: XCircle, className: 'text-red-600 dark:text-red-400', label: 'Nguy hiểm' },
};

/** Một dòng trong danh sách mục kiểm tra */
function CheckRow({ check }: { check: SecurityCheck }) {
  const s = CHECK_STATUS[check.status];
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex min-w-0 flex-1 gap-3">
        <s.icon className={cn('mt-0.5 size-5 shrink-0', s.className)} aria-label={s.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium">{check.label}</p>
            <span className="text-[11px] text-muted-foreground">({check.weight} điểm)</span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{check.detail}</p>
          {check.hint && check.status !== 'ok' && <p className="mt-1 text-xs text-foreground/80">Gợi ý: {check.hint}</p>}
        </div>
      </div>
      {check.href && check.status !== 'ok' && (
        <Button asChild size="sm" variant="outline" className="ml-8 self-start sm:ml-0">
          <Link href={check.href}>
            Xử lý <ArrowRight />
          </Link>
        </Button>
      )}
    </li>
  );
}

/** 'YYYY-MM-DD' -> 'dd/MM' (tự tách chuỗi, tránh lệch ngày do múi giờ khi new Date()) */
function dayLabel(date: string, withYear = false) {
  const [y, m, d] = date.split('-');
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

/** Biểu đồ cột chồng 14 ngày: thành công (xanh) + thất bại (đỏ); tooltip qua title */
function DailyChart({ daily }: { daily: SecurityOverview['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.success + d.failed));
  const total = daily.reduce((a, d) => ({ s: a.s + d.success, f: a.f + d.failed }), { s: 0, f: 0 });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-500" /> Thành công ({total.s.toLocaleString('vi-VN')})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-500" /> Thất bại ({total.f.toLocaleString('vi-VN')})
        </span>
        <span className="ml-auto">Cao nhất: {max.toLocaleString('vi-VN')} lượt/ngày</span>
      </div>
      <div className="flex h-40 items-end gap-1 border-b sm:gap-1.5">
        {daily.map((d) => {
          const sum = d.success + d.failed;
          return (
            <div
              key={d.date}
              className="group flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${dayLabel(d.date, true)}\nThành công: ${d.success}\nThất bại: ${d.failed}`}
            >
              {/* cột chồng: phần đỏ ở trên, phần xanh ở dưới */}
              <div className="flex w-full flex-col overflow-hidden rounded-t-sm opacity-90 transition-opacity group-hover:opacity-100" style={{ height: `${(sum / max) * 100}%` }}>
                <div className="bg-red-500" style={{ flexGrow: d.failed }} />
                <div className="bg-emerald-500" style={{ flexGrow: d.success }} />
              </div>
              {sum === 0 && <div className="h-0.5 w-full rounded-full bg-muted" />}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 sm:gap-1.5">
        {daily.map((d, i) => (
          <span key={d.date} className={cn('min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground', i % 2 === 1 && 'max-sm:invisible')}>
            {dayLabel(d.date)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Bảng IP đăng nhập sai nhiều nhất trong 24 giờ, kèm nút chặn nhanh */
function TopFailedIps({ items }: { items: SecurityOverview['topFailedIps'] }) {
  const { block, pendingIp } = useQuickBlockIp();
  if (!items.length) return <EmptyState icon={ShieldCheck} title="Không có IP đáng ngờ" description="24 giờ qua chưa có IP nào đăng nhập sai." />;
  return (
    <div className="-mx-4 -mb-4 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">IP</TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lượt sai</TableHead>
            <TableHead className="pr-4 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={it.ip}>
              <TableCell className="pl-4">
                <Link href={`/security?tab=logins&search=${encodeURIComponent(it.ip)}`} className="font-mono text-sm hover:underline" title="Xem nhật ký của IP này">
                  {it.ip}
                </Link>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{it.count.toLocaleString('vi-VN')}</TableCell>
              <TableCell className="pr-4 text-right">
                {it.blocked ? (
                  <ToneBadge tone="red">
                    <Ban /> Đã chặn
                  </ToneBadge>
                ) : (
                  <Button size="xs" variant="outline" className="text-red-600 hover:text-red-700 dark:text-red-400" disabled={pendingIp === it.ip} onClick={() => block(it.ip)}>
                    {pendingIp === it.ip ? <Loader2 className="animate-spin" /> : <Ban />} Chặn
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Khung xương khi đang tải */
function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export function OverviewTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: SECURITY_KEYS.overview,
    queryFn: () => api.get<SecurityOverview>('/admin/security/overview'),
  });

  if (isLoading) return <OverviewSkeleton />;
  if (error || !data) return <EmptyState icon={ShieldAlert} title="Không tải được dữ liệu bảo mật" description={error ? errorMessage(error) : undefined} />;

  const lv = scoreLevel(data.score);
  const s = data.stats;
  // sắp xếp: nguy hiểm trước, rồi cảnh báo, cuối cùng là đạt
  const order = { error: 0, warn: 1, ok: 2 } as const;
  const checks = [...data.checks].sort((a, b) => order[a.status] - order[b.status]);
  const counts = { ok: 0, warn: 0, error: 0 };
  data.checks.forEach((c) => counts[c.status]++);

  return (
    <div className="space-y-6">
      {/* Thẻ điểm bảo mật */}
      <section className="flex flex-col items-center gap-5 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:gap-8">
        <ScoreGauge score={data.score} />
        <div className="min-w-0 flex-1 space-y-3 text-center sm:text-left">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Điểm bảo mật</p>
            <h2 className={cn('text-2xl font-semibold', lv.text)}>{lv.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{lv.note}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
            <ToneBadge tone="green">
              <CheckCircle2 /> {counts.ok} đạt
            </ToneBadge>
            {counts.warn > 0 && (
              <ToneBadge tone="amber">
                <AlertTriangle /> {counts.warn} cảnh báo
              </ToneBadge>
            )}
            {counts.error > 0 && (
              <ToneBadge tone="red">
                <XCircle /> {counts.error} nguy hiểm
              </ToneBadge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            IP của bạn: <span className="font-mono font-medium text-foreground">{data.yourIp ?? 'không xác định'}</span>
          </p>
        </div>
      </section>

      {/* Hàng thẻ số liệu */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={LogIn} tone="green" label="Đăng nhập thành công 24h" value={s.success24h.toLocaleString('vi-VN')} />
        <StatCard icon={ShieldAlert} tone={s.failed24h > 0 ? 'red' : 'slate'} label="Đăng nhập thất bại 24h" value={s.failed24h.toLocaleString('vi-VN')} />
        <StatCard icon={UserLock} tone={s.lockedUsers > 0 ? 'amber' : 'slate'} label="Tài khoản đang bị khoá" value={s.lockedUsers.toLocaleString('vi-VN')} />
        <StatCard icon={Globe} tone="sky" label="IP đang bị chặn" value={s.blockedIps.toLocaleString('vi-VN')} />
        <StatCard
          icon={ShieldOff}
          tone={s.adminsWithout2fa > 0 ? 'amber' : 'green'}
          highlight={s.adminsWithout2fa > 0}
          label="Quản trị viên chưa bật 2FA"
          value={
            <>
              {s.adminsWithout2fa}
              <span className="text-sm font-normal text-muted-foreground"> / {s.admins}</span>
            </>
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        {/* Mục kiểm tra */}
        <Section title="Mục kiểm tra" description="Mỗi mục đạt được cộng điểm tương ứng vào điểm bảo mật" className="xl:col-span-3">
          {checks.length ? <ul className="divide-y">{checks.map((c) => <CheckRow key={c.key} check={c} />)}</ul> : <p className="text-sm text-muted-foreground">Chưa có mục kiểm tra.</p>}
        </Section>

        <div className="space-y-6 xl:col-span-2">
          <Section title="Đăng nhập 14 ngày qua" description="Rê chuột lên cột để xem chi tiết từng ngày">
            <DailyChart daily={data.daily} />
          </Section>
          <Section title="IP đăng nhập sai nhiều nhất 24h" description="Chặn nhanh trong 24 giờ các IP có dấu hiệu dò mật khẩu">
            <TopFailedIps items={data.topFailedIps} />
          </Section>
        </div>
      </div>
    </div>
  );
}
