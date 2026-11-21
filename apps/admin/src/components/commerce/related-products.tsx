'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, Package, Search, X } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, type Paginated } from '@/lib/api';
import { formatMoney, pickTr } from '@/lib/format';
import { useDebounce } from '@/hooks/use-debounce';
import { useLanguages } from '@/hooks/use-languages';
import { toNum } from './utils';

interface ProductLite {
  id: string;
  sku: string | null;
  price: unknown;
  status: string;
  featuredImage: { url: string; urls: Record<string, string> } | null;
  translations: { locale: string; name: string }[];
}

function Thumb({ p }: { p: ProductLite }) {
  // eslint-disable-next-line @next/next/no-img-element
  return p.featuredImage ? <img src={p.featuredImage.urls.thumb ?? p.featuredImage.url} alt="" className="size-9 shrink-0 rounded-md border object-cover" /> : <div className="size-9 shrink-0 rounded-md bg-muted" />;
}

/** Chọn sản phẩm liên quan / bán kèm (lưu danh sách id) */
export function RelatedProducts({ value, onChange, excludeId }: { value: string[]; onChange: (ids: string[]) => void; excludeId?: string }) {
  const { defaultLocale } = useLanguages();
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const q = useDebounce(search.trim(), 300);
  const [cache, setCache] = useState<Record<string, ProductLite>>({});

  const selected = useQuery({
    queryKey: ['products', 'by-ids', value.join(',')],
    queryFn: () => api.get<Paginated<ProductLite>>('/admin/products', { ids: value.join(','), limit: 100 }),
    enabled: value.some((id) => !cache[id]),
    placeholderData: keepPreviousData,
  });
  const results = useQuery({
    queryKey: ['products', 'picker', q, value.join(','), excludeId],
    queryFn: () => api.get<Paginated<ProductLite>>('/admin/products', { search: q, limit: 8, exclude: [...value, excludeId].filter(Boolean).join(',') }),
    enabled: focused || !!q,
    placeholderData: keepPreviousData,
  });

  const byId = { ...Object.fromEntries((selected.data?.data ?? []).map((p) => [p.id, p])), ...cache };
  const name = (p: ProductLite) => pickTr(p.translations, defaultLocale)?.name ?? '(chưa có tên)';

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Tìm sản phẩm theo tên hoặc SKU để thêm..." className="pl-8" />
        {(focused || q) && (
          <div className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
            {results.isLoading ? (
              <div className="flex justify-center p-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : !results.data?.data.length ? (
              <p className="p-3 text-center text-sm text-muted-foreground">Không tìm thấy sản phẩm</p>
            ) : (
              results.data.data.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setCache((c) => ({ ...c, [p.id]: p }));
                    onChange([...value, p.id]);
                    setSearch('');
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <Thumb p={p} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 font-medium">{name(p)}</span>
                    <span className="text-xs text-muted-foreground">{p.sku || '—'}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatMoney(toNum(p.price))}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {value.length === 0 ? (
        <EmptyState icon={Package} title="Chưa chọn sản phẩm liên quan" description="Để trống: website tự gợi ý sản phẩm cùng danh mục." />
      ) : (
        <div className="divide-y rounded-lg border">
          {value.map((id) => {
            const p = byId[id];
            return (
              <div key={id} className="flex items-center gap-3 px-3 py-2">
                {p ? <Thumb p={p} /> : <div className="size-9 shrink-0 animate-pulse rounded-md bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-sm font-medium">{p ? name(p) : selected.isLoading ? 'Đang tải...' : 'Sản phẩm không tồn tại'}</div>
                  {p && <div className="text-xs text-muted-foreground">{p.sku || '—'} · {formatMoney(toNum(p.price))}</div>}
                </div>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Gỡ">
                  <X />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
