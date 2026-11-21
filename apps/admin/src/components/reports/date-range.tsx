'use client';

import { CalendarRange } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useListParams } from '@/hooks/use-list-params';
import type { ReportInterval } from './types';

export const RANGE_PRESETS = [
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: 'month', label: 'Tháng này' },
  { key: 'last_month', label: 'Tháng trước' },
  { key: 'quarter', label: 'Quý này' },
  { key: 'year', label: 'Năm nay' },
  { key: 'custom', label: 'Tuỳ chỉnh' },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]['key'];

const pad = (n: number) => String(n).padStart(2, '0');
/** Date -> YYYY-MM-DD theo giờ máy người dùng */
export const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Khoảng ngày (bao gồm 2 đầu) của một preset, tính theo lịch máy người dùng */
export function presetRange(key: RangePreset, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = toDay(now);
  const daysAgo = (n: number) => toDay(new Date(y, m, now.getDate() - n));
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: daysAgo(6), to: today };
    case 'month':
      return { from: toDay(new Date(y, m, 1)), to: today };
    case 'last_month':
      return { from: toDay(new Date(y, m - 1, 1)), to: toDay(new Date(y, m, 0)) };
    case 'quarter':
      return { from: toDay(new Date(y, Math.floor(m / 3) * 3, 1)), to: today };
    case 'year':
      return { from: toDay(new Date(y, 0, 1)), to: today };
    case '30d':
    case 'custom':
    default:
      return { from: daysAgo(29), to: today };
  }
}

/** Gợi ý interval phù hợp với độ dài khoảng (ngắn: ngày, vừa: tuần, dài: tháng) */
export function suggestInterval(from: string, to: string): ReportInterval {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  return days <= 62 ? 'day' : days <= 200 ? 'week' : 'month';
}

const fmt = (day: string) => (day ? day.split('-').reverse().join('/') : '');

/**
 * Trạng thái bộ lọc báo cáo lưu trên URL: range (preset), from/to (khi tuỳ chỉnh), interval, tab.
 * Trả về from/to đã quy ra YYYY-MM-DD để gửi API.
 * `defaultTab`: tab mặc định khi URL chưa có `tab` (báo cáo bán hàng: `products`, báo cáo website: `overview`).
 */
export function useReportRange(defaultTab = 'products') {
  const { params, set } = useListParams({ range: '30d', from: '', to: '', interval: '', tab: defaultTab });
  const preset = (RANGE_PRESETS.some((p) => p.key === params.range) ? params.range : '30d') as RangePreset;
  const base = presetRange(preset);
  const from = preset === 'custom' && params.from ? params.from : base.from;
  const to = preset === 'custom' && params.to ? params.to : base.to;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const interval: ReportInterval = params.interval === 'day' || params.interval === 'week' || params.interval === 'month' ? params.interval : suggestInterval(lo, hi);
  return {
    params,
    set,
    preset,
    from: lo,
    to: hi,
    interval,
    tab: params.tab || defaultTab,
    label: lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`,
    presetLabel: RANGE_PRESETS.find((p) => p.key === preset)?.label ?? '',
  };
}

/** Bộ chọn khoảng thời gian: preset + từ/đến khi tuỳ chỉnh */
export function DateRangePicker({ range }: { range: ReturnType<typeof useReportRange> }) {
  const { preset, from, to, set, label } = range;
  const choose = (key: string) => {
    if (!key) return;
    if (key === 'custom') set({ range: 'custom', from, to });
    else set({ range: key, from: undefined, to: undefined });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* màn rộng: dãy nút; màn hẹp: select cho gọn */}
      <ToggleGroup type="single" size="sm" variant="outline" value={preset} onValueChange={choose} className="hidden flex-wrap md:flex">
        {RANGE_PRESETS.map((p) => (
          <ToggleGroupItem key={p.key} value={p.key} className="px-3">
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Select value={preset} onValueChange={choose}>
        <SelectTrigger size="sm" className="w-40 md:hidden" aria-label="Khoảng thời gian">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((p) => (
            <SelectItem key={p.key} value={p.key}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && set({ range: 'custom', from: e.target.value, to })} className="h-8 w-36 text-xs" aria-label="Từ ngày" />
          <span className="text-xs text-muted-foreground">đến</span>
          <Input type="date" value={to} min={from} onChange={(e) => e.target.value && set({ range: 'custom', from, to: e.target.value })} className="h-8 w-36 text-xs" aria-label="Đến ngày" />
        </div>
      )}
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarRange className="size-3.5" /> {label}
      </span>
    </div>
  );
}
