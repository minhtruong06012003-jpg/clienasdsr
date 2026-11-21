'use client';

/**
 * Tab "Tồn kho" của trang Kho mã số: bảng thống kê theo sản phẩm / biến thể
 * (còn, đang giữ, đã giao, khoá, thu hồi, sắp hết hạn, hết hạn), tô cảnh báo dòng sắp hết mã,
 * nút "Nhập mã" và "Xem mã" từng dòng.
 */

import Link from 'next/link';
import { AlertTriangle, List, Plus } from 'lucide-react';
import type { DigitalStockRow, DigitalStockSummary } from '@cmsnt/shared';
import { DataTable, type Column } from '@/components/common/data-table';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Row = DigitalStockRow & { id: string };

/** Ô số: 0 thì làm mờ cho dễ nhìn */
function Num({ value, className }: { value: number; className?: string }) {
  return <span className={cn('tabular-nums', value === 0 ? 'text-muted-foreground/60' : className)}>{value.toLocaleString('vi-VN')}</span>;
}

export function StockTab({ summary, loading, error, onRetry, canManage, onImport, onViewCodes }: { summary: DigitalStockSummary | undefined; loading: boolean; /** lỗi tải tồn kho + hàm tải lại (hiện trong bảng) */ error?: unknown; onRetry?: () => void; canManage: boolean; onImport: (productId: string, variantId: string | null) => void; onViewCodes: (productId: string, variantId: string | null) => void }) {
  // DataTable cần id duy nhất -> ghép sản phẩm + biến thể
  const rows: Row[] | undefined = summary?.rows.map((r) => ({ ...r, id: `${r.productId}:${r.variantId ?? ''}` }));

  const columns: Column<Row>[] = [
    {
      key: 'product',
      header: 'Sản phẩm',
      cell: (r) => (
        <div className="min-w-48 max-w-80">
          <Link href={`/products/${r.productId}`} className="line-clamp-1 font-medium hover:text-primary">
            {r.productName}
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {r.variantLabel && <span>{r.variantLabel}</span>}
            {r.sku && <span className="font-mono">{r.sku}</span>}
            {r.lowStock && (
              <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3" /> Sắp hết mã
              </span>
            )}
          </div>
        </div>
      ),
    },
    { key: 'available', header: 'Còn', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.available} className={cn('font-semibold', r.lowStock ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')} /> },
    { key: 'reserved', header: 'Đang giữ', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.reserved} className="text-amber-700 dark:text-amber-400" /> },
    { key: 'sold', header: 'Đã giao', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.sold} /> },
    { key: 'disabled', header: 'Khoá', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.disabled} /> },
    { key: 'revoked', header: 'Thu hồi', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.revoked} className="text-red-600 dark:text-red-400" /> },
    { key: 'expiringSoon', header: 'Sắp hết hạn', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.expiringSoon} className="text-amber-700 dark:text-amber-400" /> },
    { key: 'expired', header: 'Hết hạn', headClassName: 'text-right', className: 'text-right', cell: (r) => <Num value={r.expired} className="text-red-600 dark:text-red-400" /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="xs" onClick={() => onViewCodes(r.productId, r.variantId)}>
            <List /> Xem mã
          </Button>
          {canManage && (
            <Button variant="outline" size="xs" onClick={() => onImport(r.productId, r.variantId)}>
              <Plus /> Nhập mã
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      emptyTitle="Chưa có sản phẩm bán theo kho mã"
      emptyDescription="Bấm “Nhập mã” để chọn sản phẩm và nạp mã đầu tiên — sản phẩm sẽ tự chuyển sang bán theo kho mã."
    />
  );
}
