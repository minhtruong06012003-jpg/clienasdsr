'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Loader2, RotateCw } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-mobile';
import { EmptyState } from './empty-state';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headClassName?: string;
  /** cho phép sắp xếp theo field này (gửi ?sort=key) */
  sortable?: boolean;
  /**
   * Cách hiện cột ở dạng thẻ trên điện thoại (< 768px):
   * 'primary' = phần đầu thẻ (mặc định là cột đầu tiên), 'action' = góc phải thẻ (cạnh menu ⋯),
   * 'hidden' = ẩn, 'wide' = ô "nhãn / giá trị" chiếm trọn chiều ngang thẻ (nội dung dài như giá, công thức),
   * bỏ trống = ô "nhãn / giá trị" nửa thẻ. Cột key 'actions' hoặc tiêu đề rỗng tự coi là 'action'.
   */
  mobile?: 'primary' | 'action' | 'hidden' | 'wide';
}

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  data: T[] | undefined;
  loading?: boolean;
  meta?: Meta;
  onPageChange?: (page: number) => void;
  onLimitChange?: (limit: number) => void;
  selectable?: boolean;
  selected?: string[];
  /** trả false để khoá ô chọn của dòng đó (vd. mục hệ thống không cho thao tác hàng loạt) */
  isRowSelectable?: (row: T) => boolean;
  onSelectedChange?: (ids: string[]) => void;
  sort?: { key: string; order: 'asc' | 'desc' };
  onSortChange?: (sort: { key: string; order: 'asc' | 'desc' }) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onRowClick?: (row: T) => void;
  /** lỗi tải dữ liệu (vd. `q.error`) — khi chưa có dòng nào thì hiện khối lỗi thay cho "Chưa có dữ liệu" */
  error?: unknown;
  /** bấm "Thử lại" trong khối lỗi (vd. `() => void q.refetch()`) */
  onRetry?: () => void;
}

/** Khối báo lỗi tải dữ liệu: thông điệp lỗi + nút "Thử lại" (nếu có onRetry) */
function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Không tải được dữ liệu"
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Thử lại
          </Button>
        )
      }
    />
  );
}

/** Bảng dữ liệu chung: chọn nhiều, sắp xếp, phân trang server-side */
export function DataTable<T extends { id: string }>({
  columns,
  data,
  loading,
  meta,
  onPageChange,
  onLimitChange,
  selectable,
  selected = [],
  isRowSelectable,
  onSelectedChange,
  sort,
  onSortChange,
  emptyTitle = 'Chưa có dữ liệu',
  emptyDescription,
  emptyAction,
  onRowClick,
  error,
  onRetry,
}: DataTableProps<T>) {
  const rows = data ?? [];
  // "chọn tất cả" chỉ tính các dòng được phép chọn
  const canSelect = (r: T) => !isRowSelectable || isRowSelectable(r);
  const selectableRows = rows.filter(canSelect);
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.includes(r.id));
  const toggleAll = () =>
    onSelectedChange?.(allSelected ? selected.filter((id) => !selectableRows.some((r) => r.id === id)) : [...new Set([...selected, ...selectableRows.map((r) => r.id)])]);
  const toggle = (id: string) => onSelectedChange?.(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const isMobile = useIsMobile();
  // nội dung khi bảng trống: có lỗi tải thì báo lỗi + nút thử lại, không thì "Chưa có dữ liệu"
  const empty = error ? <ErrorState error={error} onRetry={onRetry} /> : <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;

  return (
    <div className="space-y-3">
      {isMobile ? (
        <MobileCards
          columns={columns}
          rows={rows}
          loading={loading}
          selectable={selectable}
          selected={selected}
          allSelected={allSelected}
          toggle={toggle}
          toggleAll={toggleAll}
          canSelect={canSelect}
          sort={sort}
          onSortChange={onSortChange}
          onRowClick={onRowClick}
          empty={empty}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table style={{ minWidth: `${Math.max(680, (columns.length + (selectable ? 1 : 0)) * 105)}px` }}>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {selectable && (
                    <TableHead className="w-10">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Chọn tất cả" />
                    </TableHead>
                  )}
                  {columns.map((c) => (
                    <TableHead key={c.key} className={cn('whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground', c.headClassName)}>
                      {c.sortable && onSortChange ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => onSortChange({ key: c.key, order: sort?.key === c.key && sort.order === 'desc' ? 'asc' : 'desc' })}
                        >
                          {c.header}
                          {sort?.key === c.key && (sort.order === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      ) : (
                        c.header
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + (selectable ? 1 : 0)} className="h-40 text-center">
                      <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns.length + (selectable ? 1 : 0)} className="p-6">
                      {empty}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id} data-state={selected.includes(row.id) ? 'selected' : undefined} className={cn(onRowClick && 'cursor-pointer')} onClick={() => onRowClick?.(row)}>
                      {selectable && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={selected.includes(row.id)} disabled={!canSelect(row)} onCheckedChange={() => toggle(row.id)} aria-label="Chọn" />
                        </TableCell>
                      )}
                      {columns.map((c) => (
                        <TableCell key={c.key} className={c.className}>
                          {c.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {meta && meta.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div>
            Hiển thị {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} / {meta.total.toLocaleString('vi-VN')}
            {selected.length > 0 && <span className="ml-2 font-medium text-foreground">· Đã chọn {selected.length}</span>}
          </div>
          <div className="flex items-center gap-2">
            {onLimitChange && (
              <Select value={String(meta.limit)} onValueChange={(v) => onLimitChange(Number(v))}>
                <SelectTrigger size="sm" className="w-[90px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} / trang
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="icon-sm" disabled={meta.page <= 1} onClick={() => onPageChange?.(meta.page - 1)} aria-label="Trang trước">
              <ChevronLeft />
            </Button>
            <span className="min-w-16 text-center">
              {meta.page} / {meta.totalPages}
            </span>
            <Button variant="outline" size="icon-sm" disabled={meta.page >= meta.totalPages} onClick={() => onPageChange?.(meta.page + 1)} aria-label="Trang sau">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Cột thao tác (menu ⋯, nút sửa/xoá): đặt ở góc phải thẻ thay vì thành một dòng "nhãn: giá trị" */
function isActionColumn<T>(c: Column<T>) {
  return c.mobile === 'action' || c.key === 'actions' || c.header === '' || c.header == null;
}

/**
 * Bảng ở dạng thẻ cho điện thoại: mỗi dòng là một thẻ, cột chính ở đầu thẻ,
 * các cột còn lại thành cặp "nhãn: giá trị" — không phải cuộn ngang bảng rộng 1000px+.
 */
function MobileCards<T extends { id: string }>({
  columns,
  rows,
  loading,
  selectable,
  selected,
  allSelected,
  toggle,
  toggleAll,
  canSelect,
  sort,
  onSortChange,
  onRowClick,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  selectable?: boolean;
  selected: string[];
  allSelected: boolean;
  toggle: (id: string) => void;
  toggleAll: () => void;
  canSelect: (row: T) => boolean;
  sort?: { key: string; order: 'asc' | 'desc' };
  onSortChange?: (sort: { key: string; order: 'asc' | 'desc' }) => void;
  onRowClick?: (row: T) => void;
  empty: ReactNode;
}) {
  const visible = columns.filter((c) => c.mobile !== 'hidden');
  const actions = visible.filter(isActionColumn);
  const rest = visible.filter((c) => !isActionColumn(c));
  const primary = rest.find((c) => c.mobile === 'primary') ?? rest[0];
  const details = rest.filter((c) => c !== primary);
  const sortable = onSortChange ? columns.filter((c) => c.sortable) : [];
  const sortValue = sort ? `${sort.key}:${sort.order}` : '';

  return (
    <div className="space-y-2">
      {/* chọn tất cả + sắp xếp (thay cho tiêu đề cột bấm được trên máy tính) */}
      {(selectable || sortable.length > 0) && rows.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          {selectable ? (
            <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Chọn tất cả" />
              Chọn tất cả
            </label>
          ) : (
            <span />
          )}
          {sortable.length > 0 && (
            <Select
              value={sortValue}
              onValueChange={(v) => {
                const [key, order] = v.split(':');
                onSortChange?.({ key, order: order as 'asc' | 'desc' });
              }}
            >
              <SelectTrigger size="sm" className="max-w-[60%]">
                <SelectValue placeholder="Sắp xếp" />
              </SelectTrigger>
              <SelectContent align="end">
                {sortable.flatMap((c) => {
                  const label = typeof c.header === 'string' ? c.header : c.key;
                  return [
                    <SelectItem key={`${c.key}:desc`} value={`${c.key}:desc`}>
                      {label} ↓
                    </SelectItem>,
                    <SelectItem key={`${c.key}:asc`} value={`${c.key}:asc`}>
                      {label} ↑
                    </SelectItem>,
                  ];
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-xl border bg-card">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-card p-4">{empty}</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const isSel = selected.includes(row.id);
            return (
              <li
                key={row.id}
                data-state={isSel ? 'selected' : undefined}
                className={cn('flex gap-3 rounded-xl border bg-card p-3 transition-colors data-[state=selected]:border-primary/40 data-[state=selected]:bg-primary/5', onRowClick && 'cursor-pointer active:bg-muted/60')}
                onClick={() => onRowClick?.(row)}
              >
                {selectable && (
                  // vùng bấm rộng hơn ô checkbox 16px cho dễ chạm
                  <div className="-my-1 -ml-1 flex items-start p-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isSel} disabled={!canSelect(row)} onCheckedChange={() => toggle(row.id)} aria-label="Chọn" />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  {primary && <div className="min-w-0 text-sm [overflow-wrap:anywhere] [&_.whitespace-nowrap]:whitespace-normal [&_[class*=min-w-]]:min-w-0">{primary.cell(row)}</div>}
                  {details.length > 0 && (
                    // lưới 2 cột "nhãn trên – giá trị dưới": thẻ thấp bằng nửa so với mỗi cột một dòng;
                    // grid-flow-row-dense lấp ô nửa thẻ còn trống khi có ô 'wide' chen giữa
                    <dl className="grid grid-flow-row-dense grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      {details.map((c) => (
                        <div key={c.key} className={cn('min-w-0', c.mobile === 'wide' && 'col-span-2')}>
                          <dt className="truncate text-[11px] leading-4 text-muted-foreground">{c.header}</dt>
                          {/* chuỗi dài (mã, đường dẫn) được ngắt dòng; bỏ độ rộng tối thiểu và whitespace-nowrap vốn dành cho cột bảng
                              (nếu giữ nowrap, chữ tràn sang ô bên cạnh và đè lên nhau) */}
                          <dd className="min-w-0 [overflow-wrap:anywhere] [&_.flex]:flex-wrap [&_.whitespace-nowrap]:whitespace-normal [&_[class*=min-w-]]:min-w-0 [&.whitespace-nowrap]:whitespace-normal">{c.cell(row)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                {actions.length > 0 && (
                  <div className="-mr-1 -mt-1 flex shrink-0 items-start gap-1" onClick={(e) => e.stopPropagation()}>
                    {actions.map((c) => (
                      <div key={c.key}>{c.cell(row)}</div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
