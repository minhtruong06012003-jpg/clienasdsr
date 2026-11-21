'use client';

import { useMemo, useState } from 'react';
import type { HoursReport } from './site-types';
import { num } from './site-common';

/** dow 0 = Thứ Hai … 6 = Chủ nhật (theo hợp đồng API) */
export const DOW_LABELS = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const DOW_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Độ đậm ô: 0 -> chỉ nền xám; >0 -> màu chuỗi 1 với độ mờ tăng dần theo giá trị (thang tuần tự 1 màu) */
const intensity = (v: number, max: number) => (v > 0 && max > 0 ? 0.15 + 0.85 * (v / max) : 0);

/** Mô tả 1 ô cho tooltip / trình đọc màn hình */
const cellLabel = (dow: number, hour: number, v: number) => `${DOW_LABELS[dow]}, ${pad2(hour)}:00–${pad2(hour)}:59: ${num(v)} lượt xem`;

/**
 * Heatmap lượt xem theo thứ trong tuần × giờ (7×24) vẽ bằng grid div.
 * Màn hẹp: cuộn ngang (giữ ô đủ lớn để đọc được).
 */
export function HoursHeatmap({ data }: { data: HoursReport['data'] }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; v: number } | null>(null);
  const { grid, max, peak } = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    let mx = 0;
    let pk: { dow: number; hour: number; v: number } | null = null;
    for (const d of data) {
      if (d.dow < 0 || d.dow > 6 || d.hour < 0 || d.hour > 23) continue;
      g[d.dow][d.hour] += d.pageviews;
    }
    g.forEach((row, dow) =>
      row.forEach((v, hour) => {
        if (v > mx) {
          mx = v;
          pk = { dow, hour, v };
        }
      }),
    );
    return { grid: g, max: mx, peak: pk as { dow: number; hour: number; v: number } | null };
  }, [data]);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[600px] gap-[3px]" style={{ gridTemplateColumns: '2rem repeat(24, minmax(0, 1fr))' }} role="group" aria-label="Lượt xem theo thứ và giờ" onMouseLeave={() => setHover(null)}>
          {/* hàng nhãn giờ */}
          <span />
          {HOURS.map((h) => (
            <span key={h} className="text-center text-[10px] tabular-nums text-muted-foreground">
              {h % 3 === 0 ? pad2(h) : ''}
            </span>
          ))}
          {grid.map((row, dow) => (
            <div key={dow} className="contents">
              <span className="flex items-center text-xs text-muted-foreground" title={DOW_LABELS[dow]}>
                {DOW_SHORT[dow]}
              </span>
              {row.map((v, hour) => (
                <div
                  key={hour}
                  role="img"
                  title={cellLabel(dow, hour, v)}
                  aria-label={cellLabel(dow, hour, v)}
                  onMouseEnter={() => setHover({ dow, hour, v })}
                  className="relative aspect-square min-h-4 overflow-hidden rounded-[3px] bg-muted hover:ring-2 hover:ring-ring/60"
                >
                  {v > 0 && <span className="absolute inset-0" style={{ background: 'var(--viz-1)', opacity: intensity(v, max) }} />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-h-4">{hover ? cellLabel(hover.dow, hover.hour, hover.v) : peak ? `Cao điểm: ${DOW_LABELS[peak.dow]} lúc ${pad2(peak.hour)}:00 (${num(peak.v)} lượt xem)` : 'Chưa có lượt xem trong kỳ'}</span>
        {/* chú giải thang màu */}
        <span className="inline-flex items-center gap-1.5">
          Ít
          <span className="inline-flex gap-[3px]">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <span key={t} className="relative size-3 overflow-hidden rounded-[3px] bg-muted">
                {t > 0 && <span className="absolute inset-0" style={{ background: 'var(--viz-1)', opacity: 0.15 + 0.85 * t }} />}
              </span>
            ))}
          </span>
          Nhiều{max > 0 && <span className="tabular-nums">(tối đa {num(max)})</span>}
        </span>
      </div>
    </div>
  );
}
