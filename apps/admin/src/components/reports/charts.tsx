'use client';

import type { ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';
import type { ReportInterval } from './types';

// Bảng màu tách sang chart-colors.ts (không phụ thuộc recharts) để trang khác dùng màu mà không kéo cả recharts vào bundle
import { OTHER_COLOR, SERIES_COLORS, VIZ_CLASS } from './chart-colors';
export { OTHER_COLOR, SERIES_COLORS, VIZ_CLASS };

export const tooltipStyle = { borderRadius: 8, fontSize: 12, background: 'var(--popover)', borderColor: 'var(--border)', color: 'var(--popover-foreground)', boxShadow: '0 4px 12px rgb(0 0 0 / 0.08)' };
export const tooltipCursor = { fill: 'var(--muted)', opacity: 0.5 };
const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 };

/** Vùng chứa biểu đồ: cấp biến màu cho mọi biểu đồ con */
export function VizRoot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(VIZ_CLASS, className)}>{children}</div>;
}

/** Rút gọn số tiền trên trục: 1,2 tỷ · 15tr · 250k */
export function compactMoney(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`;
  if (a >= 1e6) return `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}tr`;
  if (a >= 1e3) return `${(v / 1e3).toLocaleString('vi-VN', { maximumFractionDigits: 0 })}k`;
  return String(v);
}

export const formatCount = (v: number) => v.toLocaleString('vi-VN');

/** Nhãn kỳ ngắn trên trục X */
export function periodTick(period: string, interval: ReportInterval) {
  const [y, m, d] = period.split('-');
  if (interval === 'month') return `${m}/${y}`;
  return `${d}/${m}`;
}

/** Nhãn kỳ đầy đủ trong tooltip */
export function periodLabel(period: string, interval: ReportInterval) {
  const [y, m, d] = period.split('-');
  if (interval === 'month') return `Tháng ${m}/${y}`;
  if (interval === 'week') return `Tuần từ ${d}/${m}/${y}`;
  return `Ngày ${d}/${m}/${y}`;
}

export type ChartKind = 'area' | 'bar';

/**
 * Chuỗi thời gian 1 chỉ số (không dùng 2 trục Y — người dùng chuyển chỉ số bằng toggle).
 * `money` -> trục & tooltip định dạng tiền; ngược lại định dạng số đếm.
 */
export function TimeSeriesChart({
  data,
  xKey,
  yKey,
  name,
  color = SERIES_COLORS[0],
  kind = 'area',
  money = false,
  interval = 'day',
  height = 288,
}: {
  data: object[];
  xKey: string;
  yKey: string;
  name: string;
  color?: string;
  kind?: ChartKind;
  money?: boolean;
  interval?: ReportInterval;
  height?: number;
}) {
  const fmt = money ? (v: number) => formatMoney(v) : formatCount;
  const axisFmt = money ? compactMoney : formatCount;
  const gradientId = `grad-${yKey}`;
  const common = {
    data,
    margin: { left: 0, right: 8, top: 8, bottom: 0 },
  };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
      <XAxis dataKey={xKey} tickFormatter={(v: string) => periodTick(v, interval)} tickLine={false} axisLine={false} minTickGap={24} tick={axisTick} />
      <YAxis tickFormatter={(v: number) => axisFmt(v)} tickLine={false} axisLine={false} width={money ? 52 : 36} tick={axisTick} allowDecimals={false} />
      <Tooltip formatter={(v) => [fmt(Number(v)), name]} labelFormatter={(l) => periodLabel(String(l), interval)} contentStyle={tooltipStyle} cursor={kind === 'bar' ? tooltipCursor : { stroke: 'var(--border)' }} />
    </>
  );
  return (
    <ResponsiveContainer width="100%" height={height}>
      {kind === 'bar' ? (
        <BarChart {...common} barCategoryGap="25%">
          {axes}
          <Bar dataKey={yKey} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} />
        </BarChart>
      ) : (
        <AreaChart {...common}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {axes}
          <Area type="monotone" dataKey={yKey} name={name} stroke={color} fill={`url(#${gradientId})`} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} />
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}

export interface NamedValue {
  name: string;
  value: number;
}

/** Thanh ngang xếp hạng (top sản phẩm...) — 1 chuỗi, 1 màu */
export function RankBarChart({ data, money = false, color = SERIES_COLORS[0], height, name = 'Giá trị' }: { data: NamedValue[]; money?: boolean; color?: string; height?: number; name?: string }) {
  const fmt = money ? (v: number) => formatMoney(v) : formatCount;
  const h = height ?? Math.max(160, data.length * 34 + 24);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
        <XAxis type="number" tickFormatter={(v: number) => (money ? compactMoney(v) : formatCount(v))} tickLine={false} axisLine={false} tick={axisTick} allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={150} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
        <Tooltip formatter={(v) => [fmt(Number(v)), name]} contentStyle={tooltipStyle} cursor={tooltipCursor} />
        <Bar dataKey="value" name={name} fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Gộp các mục từ thứ 6 trở đi thành "Khác" để bảng màu không vượt 5 slot */
export function foldOthers(data: NamedValue[], max = 5): (NamedValue & { color: string })[] {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted.map((d, i) => ({ ...d, color: SERIES_COLORS[i] }));
  const head = sorted.slice(0, max - 1).map((d, i) => ({ ...d, color: SERIES_COLORS[i] }));
  const rest = sorted.slice(max - 1).reduce((s, d) => s + d.value, 0);
  return [...head, { name: 'Khác', value: rest, color: OTHER_COLOR }];
}

/**
 * Biểu đồ tròn (donut) + chú giải có số & tỉ lệ — luôn kèm nhãn để không phụ thuộc màu.
 * `stacked`: luôn xếp chú giải dưới biểu đồ (dùng trong cột hẹp, tránh tên mục bị ép mất).
 */
export function DonutChart({ data, money = false, emptyText = 'Chưa có dữ liệu trong kỳ', centerLabel, stacked = false }: { data: NamedValue[]; money?: boolean; emptyText?: string; centerLabel?: string; stacked?: boolean }) {
  const slices = foldOthers(data);
  const total = slices.reduce((s, d) => s + d.value, 0);
  const fmt = money ? (v: number) => formatMoney(v) : formatCount;
  if (!total) return <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <div className={cn('flex flex-col items-center gap-4', !stacked && 'sm:flex-row')}>
      <div className="relative size-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius={54} outerRadius={82} paddingAngle={slices.length > 1 ? 2 : 0} stroke="var(--card)" strokeWidth={slices.length > 1 ? 2 : 0} isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip formatter={(v, n) => [fmt(Number(v)), String(n)]} contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-lg font-bold tabular-nums">{money ? compactMoney(total) : formatCount(total)}</span>
          {centerLabel && <span className="text-[11px] text-muted-foreground">{centerLabel}</span>}
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="tabular-nums text-muted-foreground">{Math.round((s.value / total) * 1000) / 10}%</span>
            <span className="w-24 text-right tabular-nums">{fmt(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
