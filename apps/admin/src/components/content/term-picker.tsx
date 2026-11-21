'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { slugify, type TaxonomyView, type TermAdminView } from '@cmsnt/shared';
import { Section } from '@/components/common/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { flattenTerms, termName, typeLabel, useTaxonomyTerms } from '@/hooks/use-content-types';

/**
 * Chọn term của MỘT taxonomy cho bài: dạng cây → checkbox thụt lề; dạng thẻ → ô gõ có gợi ý.
 * Người có quyền entries.taxonomy thêm nhanh term mới ngay tại đây.
 * `value` là danh sách termId của bài (mọi taxonomy) — component chỉ thêm / bớt id thuộc taxonomy này.
 */
export function TermPicker({
  taxonomyKey,
  taxonomy,
  typeKey,
  value,
  onChange,
  locale,
  defaultLocale,
  variant = 'section',
}: {
  taxonomyKey: string;
  /** thông tin taxonomy (null khi không có quyền đọc danh sách taxonomy → coi như dạng cây, nhãn = key) */
  taxonomy: TaxonomyView | null | undefined;
  typeKey: string;
  value: string[];
  onChange: (ids: string[]) => void;
  locale: string;
  defaultLocale: string;
  variant?: 'section' | 'plain';
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const terms = useTaxonomyTerms(taxonomyKey);
  const flat = useMemo(() => flattenTerms(terms.data ?? []), [terms.data]);
  const [input, setInput] = useState('');
  const hierarchical = taxonomy ? taxonomy.hierarchical : true;
  const label = taxonomy ? typeLabel(taxonomy.labels, locale, 'plural', taxonomyKey) : taxonomyKey;
  const canAdd = can('entries.taxonomy');
  const name = (t: TermAdminView) => termName(t, locale) || termName(t, defaultLocale) || '(chưa có tên)';
  const chosen = flat.filter((t) => value.includes(t.id));

  const create = useMutation({
    mutationFn: (n: string) => api.post<TermAdminView>(`/admin/taxonomies/${taxonomyKey}/terms`, { parentId: null, translations: [{ locale: defaultLocale, name: n, slug: slugify(n) }] }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['taxonomy-terms', taxonomyKey] });
      onChange([...value, t.id]);
      setInput('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((x) => x !== id));
  const suggestions = input.trim()
    ? flat.filter((t) => !value.includes(t.id) && name(t).toLowerCase().includes(input.trim().toLowerCase())).slice(0, 6)
    : [];
  const submitInput = () => {
    const q = input.trim();
    if (!q) return;
    const exist = flat.find((t) => name(t).toLowerCase() === q.toLowerCase());
    if (exist) {
      if (!value.includes(exist.id)) onChange([...value, exist.id]);
      setInput('');
    } else if (canAdd) create.mutate(q);
    else toast.error('Bạn không có quyền tạo phân loại mới');
  };

  const body = (
    <div className="space-y-2">
      {terms.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {hierarchical ? (
        <div className="max-h-56 space-y-1.5 overflow-y-auto">
          {!terms.isLoading && !flat.length && <p className="text-sm text-muted-foreground">Chưa có {label.toLowerCase()}</p>}
          {flat.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: t.depth * 18 }}>
              <Checkbox checked={value.includes(t.id)} onCheckedChange={(c) => toggle(t.id, !!c)} />
              {name(t)}
            </label>
          ))}
        </div>
      ) : (
        chosen.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chosen.map((t) => (
              <Badge key={t.id} variant="secondary" className="gap-1">
                {name(t)}
                <button type="button" onClick={() => toggle(t.id, false)} aria-label="Gỡ">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )
      )}
      {(canAdd || !hierarchical) && (
        <div className="relative">
          <div className="flex gap-1.5">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={hierarchical ? `Thêm ${label.toLowerCase()} mới...` : 'Nhập rồi Enter'}
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitInput();
                }
              }}
            />
            {hierarchical && (
              <Button type="button" size="icon-sm" variant="outline" onClick={submitInput} disabled={!input.trim() || create.isPending} title="Thêm">
                {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              </Button>
            )}
          </div>
          {!hierarchical && suggestions.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    toggle(s.id, true);
                    setInput('');
                  }}
                >
                  {name(s)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'plain') {
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold">{label}</p>
        {body}
      </div>
    );
  }
  return (
    <Section
      title={label}
      actions={
        canAdd ? (
          <Link href={`/content/${typeKey}/terms/${taxonomyKey}`} className="text-xs text-primary">
            Quản lý
          </Link>
        ) : undefined
      }
    >
      {body}
    </Section>
  );
}
