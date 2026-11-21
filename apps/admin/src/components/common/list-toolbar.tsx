'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

/** Thanh công cụ danh sách: ô tìm kiếm (debounce) + bộ lọc + thao tác hàng loạt */
export function ListToolbar({
  search,
  onSearchChange,
  placeholder = 'Tìm kiếm...',
  filters,
  bulkActions,
  selectedCount = 0,
  onClearSelection,
}: {
  search?: string;
  onSearchChange?: (v: string) => void;
  placeholder?: string;
  filters?: ReactNode;
  bulkActions?: ReactNode;
  selectedCount?: number;
  /** có truyền thì hiện nút ✕ cạnh "Đã chọn N" để bỏ chọn tất cả */
  onClearSelection?: () => void;
}) {
  const [value, setValue] = useState(search ?? '');
  const debounced = useDebounce(value, 400);
  const isMobile = useIsMobile();
  // điện thoại: bộ lọc gập sau nút "Lọc" để danh sách hiện ngay trên màn hình đầu
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (debounced !== (search ?? '')) onSearchChange?.(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const collapsible = isMobile && !!filters;
  const bulkBar = selectedCount > 0 && bulkActions && (
    <div
      // data-bulk-bar: globals.css chừa khoảng trống đáy trang khi thanh nổi đang hiện để không che dòng cuối / phân trang
      data-bulk-bar=""
      role="toolbar"
      aria-label="Thao tác hàng loạt"
      className={cn(
        // thanh nổi ở đáy màn hình (mọi kích thước), không đẩy bảng xuống khi vừa tích chọn
        'fixed z-30 flex items-center gap-2 rounded-xl border bg-card px-2 py-2 shadow-lg animate-in fade-in-0 slide-in-from-bottom-4',
        isMobile
          ? // điện thoại: giãn ngang, luôn trong tầm ngón cái; nhiều nút thì xuống dòng để nút nào cũng thấy ngay (không phải vuốt ngang)
            'inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] flex-wrap justify-center gap-1.5'
          : // máy tính: căn giữa vùng nội dung (bên phải sidebar)
            'bottom-6 left-[calc(50%+var(--bulk-bar-offset,0px))] max-w-[calc(100vw-2rem)] -translate-x-1/2',
      )}
    >
      <span className="whitespace-nowrap px-1 text-xs font-medium">Đã chọn {selectedCount}</span>
      {onClearSelection && (
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClearSelection} aria-label="Bỏ chọn tất cả" title="Bỏ chọn tất cả">
          <X />
        </Button>
      )}
      {/* vạch ngăn giữa số đã chọn và các nút (điện thoại xuống dòng nên bỏ) */}
      {!isMobile && <div className="h-5 w-px shrink-0 bg-border" />}
      {bulkActions}
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {onSearchChange && (
        <div className={cn('relative w-full sm:w-72', collapsible && 'w-auto min-w-0 flex-1')}>
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="pl-8 pr-8" />
          {value && (
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setValue('')} aria-label="Xoá tìm kiếm">
              <X className="size-4" />
            </button>
          )}
        </div>
      )}
      {collapsible ? (
        <>
          <Button type="button" variant={filtersOpen ? 'secondary' : 'outline'} onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} className={cn(!onSearchChange && 'w-full')}>
            <SlidersHorizontal /> Lọc
          </Button>
          {/* ô lọc giãn hết chiều ngang thay vì độ rộng cố định của máy tính */}
          {filtersOpen && <div className="grid w-full grid-cols-1 gap-2 min-[420px]:grid-cols-2 [&_[data-slot=select-trigger]]:w-full">{filters}</div>}
        </>
      ) : (
        filters
      )}
      {bulkBar}
    </div>
  );
}

/** Tab trạng thái dạng pill: Tất cả | Đã xuất bản | Bản nháp ... */
export function StatusTabs({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; count?: number; highlight?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <Button key={o.value} type="button" size="sm" variant={value === o.value ? 'secondary' : 'ghost'} onClick={() => onChange(o.value)} className={value === o.value ? 'font-semibold' : 'text-muted-foreground'}>
          {o.label}
          {o.count != null && <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', o.highlight && o.count > 0 ? 'bg-amber-500 font-semibold text-white' : 'bg-background')}>{o.count}</span>}
        </Button>
      ))}
    </div>
  );
}
