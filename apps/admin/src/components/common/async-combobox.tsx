'use client';

import { useId, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, Loader2 } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';

/** Số dòng tối đa lấy về mỗi lần tìm (gợi ý cho các hàm fetchOptions) */
export const COMBOBOX_LIMIT = 20;

export interface AsyncComboboxProps<T> {
  /** giá trị đang chọn (id / key); null/'' = chưa chọn */
  value: string | null | undefined;
  /** chọn mục mới (null = bỏ chọn); kèm bản ghi vừa chọn để trang dùng thêm nếu cần */
  onChange: (value: string | null, item: T | null) => void;
  /** khoá gốc cho React Query (vd. ['pages', 'combobox']) — khác nhau giữa các nguồn dữ liệu */
  queryKey: readonly unknown[];
  /** gọi API danh sách với từ khoá tìm kiếm (server lọc) — nên giới hạn ~COMBOBOX_LIMIT dòng */
  fetchOptions: (search: string) => Promise<T[]>;
  /**
   * Lấy bản ghi của giá trị đang chọn để hiện đúng nhãn khi nó không nằm trong trang kết quả
   * (vd. GET /admin/pages/:id). Trả null nếu không còn tồn tại.
   */
  fetchSelected?: (value: string) => Promise<T | null>;
  getValue: (item: T) => string;
  getLabel: (item: T) => string;
  /** nội dung một dòng trong danh sách (mặc định = nhãn) */
  renderOption?: (item: T) => ReactNode;
  /** ẩn bớt mục khỏi danh sách (vd. không cho chọn chính trang đang sửa làm trang cha) */
  filterOption?: (item: T) => boolean;
  /** có giá trị -> thêm dòng "không chọn" đầu danh sách, đồng thời là nhãn hiển thị khi chưa chọn */
  noneLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Ô chọn có tìm kiếm phía server (thay cho <Select> nạp sẵn 200 dòng bị cắt bớt):
 * mở ra -> gọi API với từ khoá (debounce 300ms), hiện tối đa ~20 kết quả.
 * Giá trị đang chọn luôn hiện đúng nhãn nhờ nhớ mục vừa chọn hoặc gọi `fetchSelected`.
 */
export function AsyncCombobox<T>({
  value,
  onChange,
  queryKey,
  fetchOptions,
  fetchSelected,
  getValue,
  getLabel,
  renderOption,
  filterOption,
  noneLabel,
  placeholder = 'Chọn…',
  searchPlaceholder = 'Gõ để tìm…',
  emptyText = 'Không tìm thấy kết quả',
  className,
  disabled,
}: AsyncComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const term = useDebounce(search.trim(), 300);
  // mục người dùng vừa chọn — hiện nhãn ngay, không cần gọi lại API
  const [picked, setPicked] = useState<T | null>(null);
  // id danh sách kết quả cho thuộc tính aria-controls của nút mở
  const listId = useId();

  // danh sách gợi ý: chỉ tải khi đang mở, giữ kết quả cũ trong lúc gõ để không nháy
  const options = useQuery({
    queryKey: [...queryKey, 'combobox-options', term],
    queryFn: () => fetchOptions(term),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const items = (options.data ?? []).filter((it) => !filterOption || filterOption(it));

  // tìm nhãn của giá trị đang chọn: mục vừa chọn -> trong kết quả đang có -> gọi fetchSelected
  const known = value ? ((picked && getValue(picked) === value ? picked : null) ?? options.data?.find((it) => getValue(it) === value) ?? null) : null;
  const selected = useQuery({
    queryKey: [...queryKey, 'combobox-selected', value],
    queryFn: () => fetchSelected!(value!),
    enabled: !!value && !known && !!fetchSelected,
    staleTime: 60_000,
  });
  const current = known ?? selected.data ?? null;

  // chữ hiển thị trên nút
  let label: ReactNode;
  if (!value) label = <span className="text-muted-foreground">{noneLabel ?? placeholder}</span>;
  else if (current) label = getLabel(current);
  else if (selected.isLoading) label = <span className="text-muted-foreground">Đang tải…</span>;
  else label = <span className="text-muted-foreground">{fetchSelected ? `${value} (không tồn tại)` : value}</span>;

  const choose = (item: T | null) => {
    setPicked(item);
    onChange(item ? getValue(item) : null, item);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* nút mở có giao diện giống SelectTrigger để đồng bộ với các ô chọn khác */}
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-left text-sm whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50',
            className,
          )}
        >
          <span className="line-clamp-1 min-w-0 flex-1">{label}</span>
          <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        {/* shouldFilter=false: server đã lọc theo từ khoá, cmdk không lọc lại */}
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
          <CommandList id={listId}>
            {options.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : options.isError ? (
              <p className="py-6 text-center text-sm text-destructive">Không tải được danh sách</p>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {noneLabel && !term && (
                    <CommandItem value="__none__" data-checked={!value} onSelect={() => choose(null)}>
                      {noneLabel}
                    </CommandItem>
                  )}
                  {items.map((it) => {
                    const v = getValue(it);
                    return (
                      <CommandItem key={v} value={v} data-checked={v === value} onSelect={() => choose(it)}>
                        <span className="min-w-0 flex-1 truncate">{renderOption ? renderOption(it) : getLabel(it)}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
