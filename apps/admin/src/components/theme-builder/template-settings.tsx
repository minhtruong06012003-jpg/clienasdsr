'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TemplateConditions, TemplateKind } from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useContentTypeOptions } from '@/components/builder/fields';
import { api } from '@/lib/api';
import { RecordMultiPicker } from './record-picker';
import { targetHasRecords } from './records';

/** Một đối tượng áp dụng (GET /admin/theme-templates/targets) */
export interface TargetOption {
  value: string;
  label: string;
  group?: string;
}

/** Danh sách đối tượng áp dụng theo loại mẫu (không truyền kind = tất cả, dùng để tra nhãn) */
export function useTemplateTargets(kind?: TemplateKind | null) {
  return useQuery({
    queryKey: ['theme-template-targets', kind ?? 'all'],
    queryFn: () => api.get<TargetOption[]>('/admin/theme-templates/targets', kind ? { kind } : undefined),
    staleTime: 60_000,
  });
}

/** Nhãn của target (lùi về giá trị gốc nếu API chưa trả) */
export function targetLabel(targets: TargetOption[] | undefined, value: string) {
  if (value === '*') return targets?.find((t) => t.value === '*')?.label ?? 'Toàn website';
  return targets?.find((t) => t.value === value)?.label ?? value;
}

/** Ô chọn target, nhóm theo `group` */
export function TargetSelect({ kind, value, onChange }: { kind: TemplateKind; value: string; onChange: (v: string) => void }) {
  const { data, isLoading } = useTemplateTargets(kind);
  const groups = new Map<string, TargetOption[]>();
  for (const t of data ?? []) groups.set(t.group ?? '', [...(groups.get(t.group ?? '') ?? []), t]);
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={isLoading}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={isLoading ? 'Đang tải...' : 'Chọn đối tượng...'} />
      </SelectTrigger>
      <SelectContent>
        {[...groups.entries()].map(([g, items]) => (
          <SelectGroup key={g || '_'}>
            {g && <SelectLabel>{g}</SelectLabel>}
            {items.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Có cho đặt điều kiện "chỉ áp cho / loại trừ bản ghi" không (trang blog/sản phẩm tổng không có bản ghi để chọn) */
export function supportsIdConditions(kind: TemplateKind, target: string) {
  if (!targetHasRecords(target)) return false;
  if (kind === 'archive' && (target === 'post' || target === 'product')) return false;
  if (kind === 'search' || kind === 'not_found') return false;
  return true;
}

/** Điều kiện "thuộc phân loại" chỉ có nghĩa với bản ghi đơn lẻ (single / header / footer khi xem bài) */
export function supportsTermConditions(kind: TemplateKind, target: string) {
  if (kind === 'archive' || kind === 'search' || kind === 'not_found') return false;
  return target === 'post' || target === 'product' || target.startsWith('entry:');
}

/** Tóm tắt điều kiện cho danh sách */
export function conditionsSummary(c: TemplateConditions | null | undefined) {
  const parts: string[] = [];
  if (c?.ids?.length) parts.push(`chỉ ${c.ids.length} bản ghi`);
  if (c?.termIds?.length) parts.push(`thuộc ${c.termIds.length} phân loại`);
  if (c?.excludeIds?.length) parts.push(`trừ ${c.excludeIds.length} bản ghi`);
  return parts.join(' · ');
}

/** Chọn term cho điều kiện "thuộc phân loại" theo target */
function TermConditionPicker({ target, value, onChange, locale }: { target: string; value: string[]; onChange: (v: string[]) => void; locale: string }) {
  const types = useContentTypeOptions();
  const typeKey = target.startsWith('entry:') ? target.slice(6) : null;
  const taxes = typeKey ? (types.data?.find((t) => t.key === typeKey)?.taxonomies ?? []) : [];
  const [tax, setTax] = useState<string | null>(null);
  const activeTax = tax ?? taxes[0] ?? null;

  if (target === 'post') return <RecordMultiPicker source={{ target: 'post_category' }} value={value} onChange={onChange} locale={locale} placeholder="Chọn chuyên mục..." />;
  if (target === 'product') return <RecordMultiPicker source={{ target: 'product_category' }} value={value} onChange={onChange} locale={locale} placeholder="Chọn danh mục..." />;
  if (!taxes.length) return <p className="text-xs text-muted-foreground">Loại nội dung này chưa gắn phân loại nào.</p>;
  return (
    <div className="space-y-2">
      {taxes.length > 1 && (
        <Select value={activeTax ?? undefined} onValueChange={setTax}>
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {taxes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {activeTax && <RecordMultiPicker source={{ taxonomy: activeTax, labelTaxonomies: taxes }} value={value} onChange={onChange} locale={locale} placeholder="Chọn mục phân loại..." />}
    </div>
  );
}

/** Form điều kiện áp dụng của mẫu (chỉ áp cho / thuộc phân loại / loại trừ) */
export function ConditionsEditor({ kind, target, value, onChange, locale }: { kind: TemplateKind; target: string; value: TemplateConditions; onChange: (v: TemplateConditions) => void; locale: string }) {
  const idsOk = supportsIdConditions(kind, target);
  const termsOk = supportsTermConditions(kind, target);
  if (!idsOk && !termsOk) return <p className="text-xs text-muted-foreground">Mẫu áp dụng cho toàn bộ đối tượng đã chọn.</p>;
  const set = (patch: Partial<TemplateConditions>) => {
    const next = { ...value, ...patch };
    // bỏ mảng rỗng cho gọn dữ liệu
    for (const k of ['ids', 'termIds', 'excludeIds'] as const) if (!next[k]?.length) delete next[k];
    onChange(next);
  };
  return (
    <div className="space-y-4">
      {idsOk && (
        <Field label="Chỉ áp cho" help="Để trống = mọi bản ghi của đối tượng. Chọn bản ghi cụ thể sẽ được ưu tiên hơn mẫu chung.">
          <RecordMultiPicker source={{ target }} value={value.ids ?? []} onChange={(ids) => set({ ids })} locale={locale} placeholder="Chọn bản ghi..." />
        </Field>
      )}
      {termsOk && (
        <Field label="Thuộc phân loại" help="Chỉ áp cho bản ghi thuộc một trong các chuyên mục / danh mục / mục phân loại này">
          <TermConditionPicker target={target} value={value.termIds ?? []} onChange={(termIds) => set({ termIds })} locale={locale} />
        </Field>
      )}
      {idsOk && (
        <Field label="Loại trừ" help="Không áp mẫu cho các bản ghi này">
          <RecordMultiPicker source={{ target }} value={value.excludeIds ?? []} onChange={(excludeIds) => set({ excludeIds })} locale={locale} placeholder="Chọn bản ghi loại trừ..." />
        </Field>
      )}
    </div>
  );
}
