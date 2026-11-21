'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { AlertTriangle, Lock, LineChart } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RankBarChart, TimeSeriesChart, formatCount, periodLabel, periodTick, tooltipCursor, tooltipStyle, type ChartKind, type NamedValue } from './charts';
import type { ReportInterval } from './types';

/** Props chung của mọi tab báo cáo website */
export interface SiteTabProps {
  from: string;
  to: string;
  interval: ReportInterval;
  /** cập nhật tham số trên URL (interval, tab...) */
  setParams: (patch: Partial<Record<string, string | number | undefined>>) => void;
}

/** Tiền tố khoá React Query của báo cáo website */
export const SITE_KEY = 'site-reports';

export const num = (v: number | null | undefined) => (v ?? 0).toLocaleString('vi-VN');
/** Phần trăm (API trả 0–100) -> "12,3%" */
export const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`);
/** Tỉ lệ a/b dạng phần trăm */
export const ratio = (a: number, b: number) => (b ? `${(Math.round((a / b) * 1000) / 10).toLocaleString('vi-VN')}%` : '—');

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Thời lượng (giây) -> "2 phút 05 giây" / "45 giây" / "1 giờ 02 phút" */
export function formatDuration(sec: number | null | undefined) {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s < 60) return `${s} giây`;
  if (s < 3600) return `${Math.floor(s / 60)} phút ${pad2(s % 60)} giây`;
  return `${Math.floor(s / 3600)} giờ ${pad2(Math.floor((s % 3600) / 60))} phút`;
}

export const intervalWord = (i: ReportInterval) => (i === 'day' ? 'ngày' : i === 'week' ? 'tuần' : 'tháng');

// ------------------------------------------------------------------ Nhãn tiếng Việt

export const CHANNEL_LABELS: Record<string, string> = {
  direct: 'Trực tiếp',
  search: 'Tìm kiếm',
  social: 'Mạng xã hội',
  referral: 'Website giới thiệu',
  campaign: 'Chiến dịch',
  email: 'Email',
};

const DEVICE_LABELS: Record<string, string> = { desktop: 'Máy tính', mobile: 'Điện thoại', tablet: 'Máy tính bảng', bot: 'Bot', other: 'Khác', unknown: 'Không rõ' };
export const deviceLabel = (d: string | null | undefined) => (d ? (DEVICE_LABELS[d.toLowerCase()] ?? d) : 'Không rõ');

const MEDIA_TYPE_LABELS: Record<string, string> = { image: 'Hình ảnh', video: 'Video', audio: 'Âm thanh', document: 'Tài liệu', application: 'Tài liệu', text: 'Văn bản', other: 'Khác' };
export const mediaTypeLabel = (t: string) => MEDIA_TYPE_LABELS[t.toLowerCase()] ?? t;

/** Mã quốc gia ISO (VN) -> "Việt Nam"; giữ nguyên nếu không phải mã 2 ký tự */
export function countryName(code: string | null | undefined) {
  if (!code) return 'Không rõ';
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames(['vi'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Mã ngôn ngữ (vi, en-US) -> tên tiếng Việt */
export function localeName(code: string | null | undefined) {
  if (!code) return 'Không rõ';
  try {
    return new Intl.DisplayNames(['vi'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ------------------------------------------------------------------ Khung hiển thị

export function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('h-64 w-full', className)} />;
}

/** Ghi chú khi không có dữ liệu trong thẻ */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('py-10 text-center text-sm text-muted-foreground', className)}>{children}</p>;
}

/** Lỗi khi tải báo cáo: 403 -> thông báo thiếu quyền, còn lại -> nội dung lỗi */
export function QueryError({ error }: { error: unknown }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return <EmptyState icon={forbidden ? Lock : AlertTriangle} title={forbidden ? 'Bạn không có quyền xem báo cáo' : 'Không tải được báo cáo'} description={forbidden ? 'Cần quyền “reports.view”.' : errorMessage(error)} />;
}

/** Website chưa có lượt truy cập nào -> hướng dẫn kiểm tra cài đặt thống kê */
export function NoTrafficNote() {
  return (
    <EmptyState
      icon={LineChart}
      title="Chưa có lượt truy cập nào được ghi nhận"
      description="Thống kê bắt đầu từ khi website có người xem; kiểm tra Cài đặt › Thống kê truy cập."
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings?tab=analytics">Mở Cài đặt › Thống kê truy cập</Link>
        </Button>
      }
    />
  );
}

/** Thẻ có tiêu đề + mô tả + nội dung (dùng cho các khối biểu đồ/bảng nhỏ) */
export function ReportCard({ title, description, actions, children, className, contentClassName }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; contentClassName?: string }) {
  return (
    <Card className={className}>
      <CardHeader className={cn(actions && 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between')}>
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

/** Thẻ xếp hạng (thanh ngang) top N mục */
export function RankCard({ title, description, data, name, loading, emptyText = 'Chưa có dữ liệu trong kỳ', limit = 10, className }: { title: string; description?: ReactNode; data: NamedValue[] | undefined; name: string; loading?: boolean; emptyText?: string; limit?: number; className?: string }) {
  const rows = (data ?? []).filter((d) => d.value > 0).slice(0, limit);
  return (
    <ReportCard title={title} description={description} className={className}>
      {loading ? <ChartSkeleton className="h-48" /> : rows.length ? <RankBarChart data={rows} name={name} /> : <Note>{emptyText}</Note>}
    </ReportCard>
  );
}

/** Thanh tỉ lệ nhỏ trong bảng/danh sách (màu chuỗi 1) */
export function ShareBar({ value, max, color = 'var(--viz-1)', className }: { value: number; max: number; color?: string; className?: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

/** Chấm xanh nhấp nháy báo "đang online" */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
    </span>
  );
}

// ------------------------------------------------------------------ Bộ chọn

export function IntervalToggle({ value, onChange }: { value: ReportInterval; onChange: (v: ReportInterval) => void }) {
  return (
    <ToggleGroup type="single" size="sm" variant="outline" value={value} onValueChange={(v) => v && onChange(v as ReportInterval)} aria-label="Nhóm theo">
      <ToggleGroupItem value="day">Ngày</ToggleGroupItem>
      <ToggleGroupItem value="week">Tuần</ToggleGroupItem>
      <ToggleGroupItem value="month">Tháng</ToggleGroupItem>
    </ToggleGroup>
  );
}

export interface MetricDef {
  key: string;
  label: string;
  color: string;
}

/** Nút chọn chỉ số (kèm ô màu của chuỗi) */
export function MetricToggle({ metrics, value, onChange }: { metrics: readonly MetricDef[]; value: string; onChange: (v: string) => void }) {
  return (
    <ToggleGroup type="single" size="sm" variant="outline" value={value} onValueChange={(v) => v && onChange(v)} aria-label="Chỉ số" className="flex-wrap">
      {metrics.map((x) => (
        <ToggleGroupItem key={x.key} value={x.key}>
          <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: x.color }} aria-hidden />
          {x.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Thẻ biểu đồ chuỗi thời gian 1 chỉ số: chọn chỉ số + nhóm theo ngày/tuần/tháng + kiểu vùng/cột.
 * `totals` (tuỳ chọn) hiện tổng trong kỳ của chỉ số đang chọn ở mô tả.
 */
export function SeriesCard({
  title,
  description,
  metrics,
  data,
  interval,
  dataInterval,
  onInterval,
  loading,
  defaultKind = 'area',
  empty,
}: {
  title: (metric: MetricDef) => ReactNode;
  description?: ReactNode;
  metrics: readonly MetricDef[];
  data: object[] | undefined;
  interval: ReportInterval;
  /** interval thực tế API trả về (để định dạng nhãn trục) */
  dataInterval?: ReportInterval;
  onInterval: (v: ReportInterval) => void;
  loading?: boolean;
  defaultKind?: ChartKind;
  /** nội dung thay biểu đồ khi rỗng */
  empty?: ReactNode;
}) {
  const [metric, setMetric] = useState(metrics[0].key);
  const [kind, setKind] = useState<ChartKind>(defaultKind);
  const m = metrics.find((x) => x.key === metric) ?? metrics[0];
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">{title(m)}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {metrics.length > 1 && <MetricToggle metrics={metrics} value={m.key} onChange={setMetric} />}
          <IntervalToggle value={interval} onChange={onInterval} />
          <ToggleGroup type="single" size="sm" variant="outline" value={kind} onValueChange={(v) => v && setKind(v as ChartKind)} aria-label="Kiểu biểu đồ">
            <ToggleGroupItem value="area">Vùng</ToggleGroupItem>
            <ToggleGroupItem value="bar">Cột</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !data ? (
          <Skeleton className="h-72 w-full" />
        ) : empty ? (
          empty
        ) : (
          <TimeSeriesChart data={data} xKey="period" yKey={m.key} name={m.label} color={m.color} kind={kind} interval={dataInterval ?? interval} />
        )}
      </CardContent>
    </Card>
  );
}

/** Biểu đồ cột nhiều chuỗi theo kỳ (nhóm hoặc chồng) + chú giải */
export function MultiBarChart({ data, series, interval, stacked = false, height = 260 }: { data: object[]; series: readonly MetricDef[]; interval: ReportInterval; stacked?: boolean; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barCategoryGap="20%">
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis dataKey="period" tickFormatter={(v: string) => periodTick(v, interval)} tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
        <Tooltip formatter={(v, n) => [formatCount(Number(v)), String(n)]} labelFormatter={(l) => periodLabel(String(l), interval)} contentStyle={tooltipStyle} cursor={tooltipCursor} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={stacked ? 'a' : undefined} radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : undefined} maxBarSize={stacked ? 40 : 18} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Dòng số liệu trong thẻ tóm tắt: nhãn bên trái, giá trị (và phụ chú) bên phải */
export function StatRow({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-right">
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        <span className="font-semibold tabular-nums">{value}</span>
      </span>
    </div>
  );
}
