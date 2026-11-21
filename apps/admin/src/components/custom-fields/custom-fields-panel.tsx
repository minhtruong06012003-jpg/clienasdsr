'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fieldGroupApplies, type CustomFieldContext, type CustomFieldEntity, type FieldGroupDef } from '@cmsnt/shared';
import { Section } from '@/components/common/field';
import { api } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';
import { CustomFieldsForm } from './field-input';

type Values = Record<string, unknown>;

/** Nhóm trường đang bật của một loại nội dung (cache 1 phút; làm mới khi trang Trường tuỳ chỉnh lưu) */
export function useFieldGroups(entity: CustomFieldEntity) {
  return useQuery({ queryKey: ['custom-field-groups', entity], queryFn: () => api.get<FieldGroupDef[]>('/admin/custom-fields/active', { entity }), staleTime: 60_000 });
}

export interface CustomFieldsPanelProps {
  entity: CustomFieldEntity;
  /** giá trị hiện tại { key: value } của bản ghi */
  value: Values | null | undefined;
  onChange: (next: Values) => void;
  /** ngữ cảnh để lọc nhóm theo rules (template, danh mục, loại sản phẩm, vai trò) */
  context?: CustomFieldContext;
  /** ngôn ngữ đang soạn (trường i18n hiển thị bản này) */
  locale?: string;
  /** chỉ hiện nhóm ở vị trí này; bỏ trống = tất cả */
  placement?: 'main' | 'sidebar';
  /** 'section' = thẻ Section (mặc định); 'plain' = tiêu đề đơn giản (dùng trong panel/sheet hẹp) */
  variant?: 'section' | 'plain';
  disabled?: boolean;
}

/**
 * Panel trường tuỳ chỉnh gắn vào trang soạn thảo: tự tải nhóm theo entity, lọc theo rules + placement,
 * render mỗi nhóm thành một Section. Không có nhóm nào áp dụng -> không render gì.
 */
export function CustomFieldsPanel({ entity, value, onChange, context, locale, placement, variant = 'section', disabled }: CustomFieldsPanelProps) {
  const { defaultLocale } = useLanguages();
  const groups = useFieldGroups(entity);
  const active = locale ?? defaultLocale;
  const list = useMemo(() => (groups.data ?? []).filter((g) => (!placement || (g.placement ?? 'main') === placement) && fieldGroupApplies(g.rules, context)), [groups.data, placement, context]);
  if (!list.length) return null;
  const values = value ?? {};
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  const compact = variant === 'plain';
  return (
    <>
      {list.map((g) =>
        variant === 'section' ? (
          <Section key={g.key} title={g.name} description={g.description ?? undefined}>
            <CustomFieldsForm fields={g.fields} values={values} onChange={set} locale={active} defaultLocale={defaultLocale} disabled={disabled} compact={placement === 'sidebar'} />
          </Section>
        ) : (
          <div key={g.key} className="space-y-3">
            <div>
              <p className="text-sm font-semibold">{g.name}</p>
              {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
            </div>
            <CustomFieldsForm fields={g.fields} values={values} onChange={set} locale={active} defaultLocale={defaultLocale} disabled={disabled} compact={compact} />
          </div>
        ),
      )}
    </>
  );
}

/** Có nhóm nào áp dụng không (để trang soạn thảo quyết định hiện tab / khu vực) */
export function useHasFieldGroups(entity: CustomFieldEntity, context?: CustomFieldContext, placement?: 'main' | 'sidebar') {
  const groups = useFieldGroups(entity);
  return useMemo(() => (groups.data ?? []).some((g) => (!placement || (g.placement ?? 'main') === placement) && fieldGroupApplies(g.rules, context)), [groups.data, context, placement]);
}
