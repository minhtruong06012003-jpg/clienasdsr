'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Loader2, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { labelRecords, searchRecords, searchTerms, type RecordOption } from './records';

/**
 * Nguồn dữ liệu cho picker: bản ghi của một target, hoặc term của một taxonomy
 * (`labelTaxonomies`: các taxonomy khác cần tra nhãn cho id đã chọn — giá trị có thể trộn nhiều taxonomy).
 */
export type PickerSource = { target: string } | { taxonomy: string; labelTaxonomies?: string[] };

const sourceKey = (s: PickerSource) => ('target' in s ? `t:${s.target}` : `x:${s.taxonomy}`);

function useSearch(source: PickerSource, search: string, locale: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tb-records', sourceKey(source), search, locale],
    queryFn: () => ('target' in source ? searchRecords(source.target, search, locale) : searchTerms(source.taxonomy, search, locale)),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Danh sách kết quả tìm kiếm trong popover */
function ResultList({ source, locale, selected, onToggle, open }: { source: PickerSource; locale: string; selected: string[]; onToggle: (r: RecordOption) => void; open: boolean }) {
  const [q, setQ] = useState('');
  const debounced = useDebounce(q, 300);
  const res = useSearch(source, debounced, locale, open);
  return (
    <div className="flex flex-col">
      <div className="relative border-b p-2">
        <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm..." className="h-8 pl-8" autoFocus />
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {res.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : res.isError ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">{errorMessage(res.error)}</p>
        ) : !res.data?.length ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">Không có kết quả</p>
        ) : (
          res.data.map((r) => {
            const on = selected.includes(r.id);
            return (
              <button key={r.id} type="button" onClick={() => onToggle(r)} className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', on && 'text-primary')}>
                <Check className={cn('size-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.note && <span className="text-[10px] text-muted-foreground">({r.note})</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Lấy nhãn cho id đã lưu (chỉ nguồn target; term thì tải danh sách) */
function useLabels(source: PickerSource, ids: string[], locale: string) {
  const [known, setKnown] = useState<Record<string, string>>({});
  const missing = ids.filter((id) => !known[id]);
  const q = useQuery({
    queryKey: ['tb-record-labels', sourceKey(source), missing.join(','), locale],
    queryFn: async () => {
      if ('target' in source) return labelRecords(source.target, missing, locale);
      const taxes = [...new Set([source.taxonomy, ...(source.labelTaxonomies ?? [])])];
      const all = (await Promise.all(taxes.map((t) => searchTerms(t, '', locale).catch(() => [] as RecordOption[])))).flat();
      return all.filter((r) => missing.includes(r.id));
    },
    enabled: missing.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (q.data?.length) setKnown((k) => ({ ...k, ...Object.fromEntries(q.data.map((r) => [r.id, r.label])) }));
  }, [q.data]);
  return { known, remember: (r: RecordOption) => setKnown((k) => ({ ...k, [r.id]: r.label })) };
}

/** Chọn nhiều bản ghi / term (giá trị = id[]) */
export function RecordMultiPicker({ source, value, onChange, locale, placeholder = 'Chọn...' }: { source: PickerSource; value: string[]; onChange: (ids: string[]) => void; locale: string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const { known, remember } = useLabels(source, value, locale);
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="max-w-full gap-1">
              <span className="truncate">{known[id] ?? id.slice(0, 8)}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Bỏ chọn">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between font-normal text-muted-foreground">
            {placeholder} <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <ResultList
            source={source}
            locale={locale}
            open={open}
            selected={value}
            onToggle={(r) => {
              remember(r);
              onChange(value.includes(r.id) ? value.filter((x) => x !== r.id) : [...value, r.id]);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Chọn một bản ghi (giá trị = id | null) — dùng cho "Xem trước với dữ liệu" */
export function RecordPicker({ source, value, onChange, locale, emptyLabel = 'Mới nhất', className }: { source: PickerSource; value: string | null; onChange: (id: string | null) => void; locale: string; emptyLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const { known, remember } = useLabels(source, value ? [value] : [], locale);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={cn('max-w-56 justify-between gap-1 font-normal', className)}>
          <span className="truncate">{value ? (known[value] ?? 'Đang tải...') : emptyLabel}</span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        {value && (
          <button
            type="button"
            className="w-full border-b px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            ↺ Dùng bản ghi mới nhất
          </button>
        )}
        <ResultList
          source={source}
          locale={locale}
          open={open}
          selected={value ? [value] : []}
          onToggle={(r) => {
            remember(r);
            onChange(r.id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
