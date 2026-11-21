'use client';

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FormInput, GripVertical, Plus, Trash2, Wand2, X } from 'lucide-react';
import { PURCHASE_FIELD_TYPES, slugify, type PurchaseFieldDef, type PurchaseFieldType } from '@cmsnt/shared';
import { I18nInput } from '@/components/common/i18n-input';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useLanguages } from '@/hooks/use-languages';
import { i18n } from '@/lib/format';
import type { I18nText } from '@/lib/types';
import { cn } from '@/lib/utils';
import { NumberInput } from './number-input';
import { uid } from './variants-editor';
import { FIELD_KEY_RE, fieldKeyFrom } from './code-fields-editor';

/** Tên tiếng Việt của từng loại ô nhập */
export const PURCHASE_FIELD_TYPE_LABELS: Record<PurchaseFieldType, string> = {
  text: 'Văn bản',
  email: 'Email',
  tel: 'Số điện thoại',
  number: 'Số',
  textarea: 'Đoạn văn',
  select: 'Danh sách chọn',
  password: 'Mật khẩu',
};

/** Một ô nhập trong form (thêm _key cho kéo thả; options luôn là mảng để dễ sửa) */
export type PurchaseFieldForm = Omit<PurchaseFieldDef, 'options'> & { _key: string; options: { _key: string; value: string; label: I18nText }[] };

export const toPurchaseFieldForms = (list: PurchaseFieldDef[]): PurchaseFieldForm[] =>
  list.map((f) => ({ ...f, _key: uid(), options: (f.options ?? []).map((o) => ({ ...o, _key: uid() })) }));

const hasText = (t?: I18nText | null) => !!t && Object.values(t).some((x) => !!x?.trim());

/** Chuyển về dạng API (bỏ _key, bỏ dòng trống, options chỉ cho loại select) */
export const fromPurchaseFieldForms = (list: PurchaseFieldForm[]): PurchaseFieldDef[] =>
  list
    .filter((f) => f.key.trim())
    .map((f) => ({
      key: f.key.trim(),
      label: f.label,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(hasText(f.placeholder) ? { placeholder: f.placeholder } : {}),
      ...(hasText(f.help) ? { help: f.help } : {}),
      ...(f.type === 'select' ? { options: f.options.filter((o) => o.value.trim()).map((o) => ({ value: o.value.trim(), label: hasText(o.label) ? o.label : { vi: o.value.trim() } })) } : {}),
      ...(f.maxLength ? { maxLength: f.maxLength } : {}),
    }));

/** Lỗi đầu tiên của danh sách ô nhập, null = hợp lệ */
export function purchaseFieldsError(list: PurchaseFieldForm[]): string | null {
  const keys = new Set<string>();
  for (const f of list) {
    const k = f.key.trim();
    if (!k && !hasText(f.label)) continue;
    if (!FIELD_KEY_RE.test(k)) return `Mã ô "${k || '(trống)'}" không hợp lệ: chỉ chữ thường a-z, số, gạch dưới và bắt đầu bằng chữ`;
    if (keys.has(k)) return `Mã ô "${k}" bị trùng`;
    keys.add(k);
    if (!hasText(f.label)) return `Ô "${k}" chưa có nhãn`;
    if (f.type === 'select' && !f.options.some((o) => o.value.trim())) return `Ô "${k}" là danh sách chọn nhưng chưa có lựa chọn nào`;
  }
  return null;
}

const L = (vi: string, en: string): I18nText => ({ vi, en });

/** Mẫu nhanh: thêm vào cuối danh sách (bỏ qua ô trùng mã) */
const PRESETS: { label: string; fields: PurchaseFieldDef[] }[] = [
  {
    label: 'ID game + Máy chủ',
    fields: [
      { key: 'game_id', label: L('ID nhân vật / ID game', 'Game ID'), type: 'text', required: true, placeholder: L('Vd: 123456789', 'e.g. 123456789'), help: L('Xem trong phần hồ sơ nhân vật trong game', 'Find it in your in-game profile') },
      { key: 'server', label: L('Máy chủ', 'Server'), type: 'text', placeholder: L('Vd: S1, Asia', 'e.g. S1, Asia') },
    ],
  },
  {
    label: 'Email tài khoản cần nâng cấp',
    fields: [{ key: 'account_email', label: L('Email tài khoản cần nâng cấp', 'Account email to upgrade'), type: 'email', required: true, placeholder: L('ban@example.com', 'you@example.com'), help: L('Gói sẽ được kích hoạt cho tài khoản này', 'The plan will be activated for this account') }],
  },
  {
    label: 'Số điện thoại nạp',
    fields: [{ key: 'topup_phone', label: L('Số điện thoại cần nạp', 'Phone number to top up'), type: 'tel', required: true, placeholder: L('09xx xxx xxx', '09xx xxx xxx') }],
  },
];

function SortableField({ row, onChange, onRemove }: { row: PurchaseFieldForm; onChange: (patch: Partial<PurchaseFieldForm>) => void; onRemove: () => void }) {
  const { defaultLocale } = useLanguages();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row._key });
  /** Đổi nhãn: tự sinh mã nếu mã đang trống hoặc khớp nhãn cũ */
  const setLabel = (label: I18nText) => {
    const auto = !row.key || row.key === fieldKeyFrom(i18n(row.label, defaultLocale));
    onChange({ label, ...(auto ? { key: fieldKeyFrom(i18n(label, defaultLocale)) } : {}) });
  };
  const setOption = (key: string, patch: Partial<PurchaseFieldForm['options'][number]>) => onChange({ options: row.options.map((o) => (o._key === key ? { ...o, ...patch } : o)) });

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('flex items-start gap-2 rounded-lg border bg-card p-3', isDragging && 'z-10 shadow-lg')}>
      <button type="button" className="mt-7 cursor-grab touch-none text-muted-foreground hover:text-foreground" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Nhãn" required>
            <I18nInput value={row.label} onChange={setLabel} placeholder="Vd: ID game" />
          </Field>
          <Field label="Mã ô">
            <Input
              value={row.key}
              onChange={(e) => onChange({ key: e.target.value })}
              onBlur={(e) => onChange({ key: fieldKeyFrom(e.target.value) })}
              className={cn('font-mono text-xs', row.key && !FIELD_KEY_RE.test(row.key) && 'border-destructive')}
              placeholder="game_id"
            />
          </Field>
          <Field label="Loại">
            <Select value={row.type} onValueChange={(type) => onChange({ type: type as PurchaseFieldType })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PURCHASE_FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PURCHASE_FIELD_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px]">
          <Field label="Chữ mờ (placeholder)">
            <I18nInput value={row.placeholder} onChange={(placeholder) => onChange({ placeholder })} placeholder="Vd: 123456789" />
          </Field>
          <Field label="Gợi ý dưới ô">
            <I18nInput value={row.help} onChange={(help) => onChange({ help })} placeholder="Vd: Xem trong hồ sơ nhân vật" />
          </Field>
          <Field label="Tối đa (ký tự)">
            <NumberInput value={row.maxLength ?? null} onChange={(v) => onChange({ maxLength: v ? Math.min(2000, Math.max(1, Math.floor(v))) : undefined })} integer min={1} placeholder={row.type === 'textarea' ? '1000' : '255'} />
          </Field>
        </div>
        {row.type === 'select' && (
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <p className="text-xs font-medium">Các lựa chọn</p>
            {row.options.map((o) => (
              <div key={o._key} className="grid items-start gap-2 sm:grid-cols-[140px_1fr_auto]">
                <Input value={o.value} onChange={(e) => setOption(o._key, { value: e.target.value })} onBlur={(e) => setOption(o._key, { value: e.target.value.trim() || slugify(i18n(o.label, defaultLocale)) })} placeholder="Giá trị (vd: s1)" className="font-mono text-xs" />
                <I18nInput value={o.label} onChange={(label) => setOption(o._key, { label })} placeholder="Nhãn hiển thị (vd: Máy chủ 1)" />
                <Button type="button" variant="ghost" size="icon-sm" className="mt-1 text-muted-foreground hover:text-destructive" onClick={() => onChange({ options: row.options.filter((x) => x._key !== o._key) })} aria-label="Xoá lựa chọn">
                  <X />
                </Button>
              </div>
            ))}
            {row.options.length < 50 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ options: [...row.options, { _key: uid(), value: '', label: {} }] })}>
                <Plus /> Thêm lựa chọn
              </Button>
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={!!row.required} onCheckedChange={(required) => onChange({ required })} /> Bắt buộc nhập
        </label>
      </div>
      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label="Xoá ô nhập">
        <Trash2 />
      </Button>
    </div>
  );
}

/**
 * Trình sửa "Thông tin khách cần nhập khi mua" (Product.purchaseFields): ID game, email cần nâng cấp,
 * số điện thoại nạp... Hiện ở trang sản phẩm / giỏ hàng; giá trị lưu vào dòng đơn hàng. Tối đa 10 ô.
 */
export function PurchaseFieldsEditor({ value, onChange }: { value: PurchaseFieldForm[]; onChange: (v: PurchaseFieldForm[]) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(value, value.findIndex((f) => f._key === active.id), value.findIndex((f) => f._key === over.id)));
  };
  const add = () => onChange([...value, { _key: uid(), key: '', label: {}, type: 'text', options: [] }]);
  /** Thêm mẫu: bỏ qua ô đã có cùng mã */
  const addPreset = (fields: PurchaseFieldDef[]) => {
    const fresh = toPurchaseFieldForms(fields.filter((f) => !value.some((v) => v.key === f.key)));
    onChange([...value, ...fresh].slice(0, 10));
  };
  const err = purchaseFieldsError(value);

  const presetMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Wand2 /> Mẫu nhanh
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Thêm vào danh sách</DropdownMenuLabel>
        {PRESETS.map((p) => (
          <DropdownMenuItem key={p.label} onClick={() => addPreset(p.fields)}>
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <EmptyState
          icon={FormInput}
          title="Không cần khách nhập thêm"
          description="Thêm ô nếu cần thông tin để giao hàng: ID game, máy chủ, email tài khoản cần nâng cấp, số điện thoại nạp..."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {presetMenu}
              <Button type="button" size="sm" variant="ghost" onClick={add}>
                <Plus /> Thêm ô
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={value.map((f) => f._key)} strategy={verticalListSortingStrategy}>
              {value.map((row) => (
                <SortableField key={row._key} row={row} onChange={(patch) => onChange(value.map((f) => (f._key === row._key ? { ...f, ...patch } : f)))} onRemove={() => onChange(value.filter((f) => f._key !== row._key))} />
              ))}
            </SortableContext>
          </DndContext>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex flex-wrap gap-2">
            {value.length < 10 && (
              <Button type="button" size="sm" variant="outline" onClick={add}>
                <Plus /> Thêm ô
              </Button>
            )}
            {value.length < 10 && presetMenu}
          </div>
        </>
      )}
    </div>
  );
}
