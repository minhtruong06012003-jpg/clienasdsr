'use client';

import { SERIES_COLORS, TimeSeriesChart, VizRoot } from '@/components/reports/charts';

/**
 * Biểu đồ doanh thu / số đơn theo ngày trên Tổng quan.
 * Tách riêng để trang dashboard nạp động (next/dynamic, ssr:false) — recharts chỉ tải khi cần vẽ.
 */
export default function SalesChart({ data, metric }: { data: object[]; metric: 'revenue' | 'orders' }) {
  return (
    <VizRoot className="h-full">
      <TimeSeriesChart
        data={data}
        xKey="date"
        yKey={metric}
        name={metric === 'revenue' ? 'Doanh thu' : 'Đơn hàng'}
        color={metric === 'revenue' ? SERIES_COLORS[0] : SERIES_COLORS[1]}
        money={metric === 'revenue'}
        kind={metric === 'revenue' ? 'area' : 'bar'}
        interval="day"
        height={288}
      />
    </VizRoot>
  );
}
