'use client';

import { useState } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Copy, GripVertical, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, I18N_CAPABLE_TYPES, toCustomFieldKey, type CustomFieldDef, type CustomFieldType } from '@cmsnt/shared';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/common/field';
import { cn } from '@/lib/utils';
import { typeLabel, useContentTypes, useTaxonomies } from '@/hooks/use-content-types';

/** Trường trong trình dựng có thêm _key (id tạm cho React/dnd) và cờ khoá mã */
export interface BuilderField extends CustomFieldDef {
  _key: string;
  /** true = người dùng đã sửa key thủ công, không tự sinh từ nhãn nữa */
  _keyLocked?: boolean;
  fields?: BuilderField[];
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Nhóm loại trường trong menu "Thêm trường" */
const TYPE_GROUPS: { label: string; types: CustomFieldType[] }[] = [
  { label: 'Cơ bản', types: ['text', 'textarea', 'richtext', 'number', 'boolean', 'select', 'multiselect', 'date', 'datetime', 'color'] },
  { label: 'Media & liên kết', types: ['image', 'gallery', 'file', 'url', 'email', 'link'] },
  { label: 'Quan hệ', types: ['products', 'posts', 'pages', 'post_category', 'product_category', 'entries', 'terms'] },
  { label: 'Nâng cao', types: ['repeater', 'json'] },
];

export function toBuilderFields(defs: CustomFieldDef[] | undefined): BuilderField[] {
  return (defs ?? []).map((d) => ({ ...d, _key: uid(), _keyLocked: true, fields: d.fields ? toBuilderFields(d.fields) : undefined }));
}

/** Bỏ các khoá tạm trước khi gửi API */
export function fromBuilderFields(list: BuilderField[]): CustomFieldDef[] {
  return list.map(({ _key, _keyLocked, fields, ...d }) => ({ ...d, ...(fields ? { fields: fromBuilderFields(fields) } : {}) }));
}

export function newBuilderField(type: CustomFieldType): BuilderField {
  const base: BuilderField = { _key: uid(), key: '', label: '', type };
  if (type === 'select' || type === 'multiselect') base.options = [{ value: 'option_1', label: 'Lựa chọn 1' }];
  if (type === 'repeater') base.fields = [newBuilderField('text')];
  if (type === 'boolean') base.default = false;
  return base;
}

/**
 * Trình dựng danh sách trường: kéo thả sắp xếp, mở từng trường để sửa thuộc tính.
 * `nested` = đang dựng trường con của repeater (không cho lồng repeater, bỏ width).
 */
export function FieldBuilder({ value, onChange, nested, siblingsForShowIf }: { value: BuilderField[]; onChange: (v: BuilderField[]) => void; nested?: boolean; siblingsForShowIf?: BuilderField[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = value.map((f) => f._key);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(value, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };
  const add = (type: CustomFieldType) => {
    const f = newBuilderField(type);
    onChange([...value, f]);
    setOpenKey(f._key);
  };
  const keys = new Set(value.map((f) => f.key).filter(Boolean));
  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {value.map((f, i) => (
              <FieldRow
                key={f._key}
                field={f}
                open={openKey === f._key}
                duplicateKey={!!f.key && value.some((x) => x !== f && x.key === f.key)}
                onToggle={() => setOpenKey(openKey === f._key ? null : f._key)}
                onChange={(patch) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
                onRemove={() => onChange(value.filter((_, j) => j !== i))}
                onDuplicate={() => {
                  const copy: BuilderField = { ...structuredClone(f), _key: uid(), key: uniqueKey(`${f.key || 'field'}_copy`, keys), _keyLocked: true };
                  onChange([...value.slice(0, i + 1), copy, ...value.slice(i + 1)]);
                }}
                nested={nested}
                siblings={siblingsForShowIf ?? value}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!value.length && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa có trường nào. Bấm “Thêm trường” để bắt đầu.</p>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className={cn(!nested && 'w-full')}>
            <Plus /> Thêm trường
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
          {TYPE_GROUPS.map((g, gi) => (
            <div key={g.label}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs text-muted-foreground">{g.label}</DropdownMenuLabel>
              {g.types
                .filter((t) => !(nested && t === 'repeater'))
                .map((t) => (
                  <DropdownMenuItem key={t} onClick={() => add(t)}>
                    {CUSTOM_FIELD_TYPE_LABELS[t]}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{t}</span>
                  </DropdownMenuItem>
                ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function uniqueKey(base: string, taken: Set<string>) {
  let k = base;
  let i = 2;
  while (taken.has(k)) k = `${base}_${i++}`;
  return k;
}

function FieldRow({ field: f, open, duplicateKey, onToggle, onChange, onRemove, onDuplicate, nested, siblings }: { field: BuilderField; open: boolean; duplicateKey: boolean; onToggle: () => void; onChange: (patch: Partial<BuilderField>) => void; onRemove: () => void; onDuplicate: () => void; nested?: boolean; siblings: BuilderField[] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: f._key });
  const invalid = !f.label.trim() || !f.key || duplicateKey || (f.type === 'terms' && !f.taxonomy);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('rounded-lg border bg-card', isDragging && 'z-10 shadow-lg', invalid && 'border-amber-400')}>
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button type="button" className="cursor-grab p-1 text-muted-foreground" {...attributes} {...listeners} aria-label="Kéo để sắp xếp">
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{f.label || <span className="italic text-muted-foreground">Chưa đặt nhãn</span>}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{f.key || '—'}{duplicateKey && <span className="ml-1 text-amber-600 dark:text-amber-400">(trùng mã)</span>}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {f.required && <Badge variant="outline" className="h-5 text-[10px]">Bắt buộc</Badge>}
            {f.i18n && <Badge variant="outline" className="h-5 text-[10px]">Đa ngôn ngữ</Badge>}
            {f.public === false && <Badge variant="secondary" className="h-5 text-[10px]">Nội bộ</Badge>}
            <Badge variant="secondary" className="h-5 text-[10px]">{CUSTOM_FIELD_TYPE_LABELS[f.type]}</Badge>
          </span>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDuplicate} title="Nhân bản">
          <Copy />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} title="Xoá trường" className="text-destructive">
          <Trash2 />
        </Button>
      </div>
      {open && (
        <div className="space-y-4 border-t p-3">
          {/* key theo loại để state nháp (danh sách lựa chọn) khởi tạo lại khi đổi loại trường */}
          <FieldSettings key={f.type} field={f} onChange={onChange} nested={nested} siblings={siblings} />
        </div>
      )}
    </div>
  );
}

/** Thuộc tính chi tiết của một trường */
function FieldSettings({ field: f, onChange, nested, siblings }: { field: BuilderField; onChange: (patch: Partial<BuilderField>) => void; nested?: boolean; siblings: BuilderField[] }) {
  const canI18n = I18N_CAPABLE_TYPES.includes(f.type);
  const isSelect = f.type === 'select' || f.type === 'multiselect';
  const isNum = f.type === 'number';
  const isTextLike = f.type === 'text' || f.type === 'textarea' || f.type === 'richtext' || f.type === 'url' || f.type === 'email';
  const optionsText = (f.options ?? []).map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`)).join('\n');
  const [optDraft, setOptDraft] = useState(optionsText);
  const parseOptions = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [v, ...rest] = line.split('|');
        const value = v.trim();
        return { value, label: rest.join('|').trim() || value };
      });
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nhãn" required>
          <Input value={f.label} autoFocus={!f.label} onChange={(e) => onChange({ label: e.target.value, ...(f._keyLocked ? {} : { key: toCustomFieldKey(e.target.value) }) })} placeholder="VD: Thời lượng" />
        </Field>
        <Field
          label="Mã trường (key)"
          help="Dùng trong API/theme: customFields.<key>"
          action={
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange({ _keyLocked: !f._keyLocked, ...(f._keyLocked ? { key: toCustomFieldKey(f.label) } : {}) })} title={f._keyLocked ? 'Đang nhập tay — bấm để tự sinh từ nhãn' : 'Đang tự sinh từ nhãn — bấm để nhập tay'}>
              {f._keyLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
              {f._keyLocked ? 'Nhập tay' : 'Tự sinh'}
            </button>
          }
        >
          <Input value={f.key} className="font-mono text-xs" onChange={(e) => onChange({ key: toCustomFieldKey(e.target.value.replace(/\s/g, '_')) || e.target.value.toLowerCase(), _keyLocked: true })} placeholder="thoi_luong" />
        </Field>
        <Field label="Loại trường">
          <Select value={f.type} onValueChange={(t) => onChange({ ...newBuilderField(t as CustomFieldType), _key: f._key, key: f.key, label: f.label, help: f.help, required: f.required, public: f.public, width: f.width, _keyLocked: f._keyLocked })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_FIELD_TYPES.filter((t) => !(nested && t === 'repeater')).map((t) => (
                <SelectItem key={t} value={t}>
                  {CUSTOM_FIELD_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {!nested && (
          <Field label="Độ rộng trong form">
            <Select value={f.width ?? 'full'} onValueChange={(w) => onChange({ width: w === 'half' ? 'half' : undefined })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Cả hàng</SelectItem>
                <SelectItem value="half">Nửa hàng</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Hướng dẫn (hiện dưới ô nhập)">
          <Input value={f.help ?? ''} onChange={(e) => onChange({ help: e.target.value || undefined })} />
        </Field>
        {(isTextLike || isNum) && (
          <Field label="Gợi ý (placeholder)">
            <Input value={f.placeholder ?? ''} onChange={(e) => onChange({ placeholder: e.target.value || undefined })} />
          </Field>
        )}
      </div>

      {(f.type === 'entries' || f.type === 'terms') && <RelationSource field={f} onChange={onChange} />}
      {isSelect && (
        <Field label="Danh sách lựa chọn" help="Mỗi dòng một lựa chọn: giá_trị | Nhãn hiển thị (bỏ phần nhãn nếu giống giá trị)">
          <Textarea value={optDraft} rows={4} className="font-mono text-xs" onChange={(e) => setOptDraft(e.target.value)} onBlur={() => onChange({ options: parseOptions(optDraft) })} placeholder={'beginner | Cơ bản\nadvanced | Nâng cao'} />
        </Field>
      )}
      {isNum && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Nhỏ nhất">
            <Input type="number" value={f.min ?? ''} onChange={(e) => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
          <Field label="Lớn nhất">
            <Input type="number" value={f.max ?? ''} onChange={(e) => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
          <Field label="Bước nhảy">
            <Input type="number" value={f.step ?? ''} onChange={(e) => onChange({ step: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="1" />
          </Field>
        </div>
      )}
      {(f.type === 'textarea' || f.type === 'richtext') && (
        <Field label="Số dòng hiển thị">
          <Input type="number" min={2} max={40} value={f.rows ?? ''} onChange={(e) => onChange({ rows: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={f.type === 'richtext' ? '6' : '3'} />
        </Field>
      )}
      {(f.type === 'text' || f.type === 'textarea') && (
        <Field label="Độ dài tối đa (ký tự)">
          <Input type="number" min={1} value={f.max ?? ''} onChange={(e) => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="Không giới hạn" />
        </Field>
      )}
      {(f.type === 'text' || f.type === 'textarea' || f.type === 'number' || f.type === 'select' || f.type === 'url' || f.type === 'email' || f.type === 'color') && (
        <Field label="Giá trị mặc định" help="Dùng khi bản ghi chưa nhập giá trị">
          {f.type === 'select' ? (
            <Select value={f.default == null || f.default === '' ? '__none__' : String(f.default)} onValueChange={(v) => onChange({ default: v === '__none__' ? undefined : v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Không —</SelectItem>
                {(f.options ?? []).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input type={f.type === 'number' ? 'number' : 'text'} value={f.default == null ? '' : String(f.default)} onChange={(e) => onChange({ default: e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value })} />
          )}
        </Field>
      )}
      {f.type === 'boolean' && (
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <Label className="text-sm">Mặc định bật</Label>
          <Switch checked={!!f.default} onCheckedChange={(v) => onChange({ default: v })} />
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
          Bắt buộc nhập
          <Switch checked={!!f.required} onCheckedChange={(v) => onChange({ required: v || undefined })} />
        </label>
        {canI18n && (
          <label className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm" title="Mỗi ngôn ngữ một giá trị riêng">
            Đa ngôn ngữ
            <Switch checked={!!f.i18n} onCheckedChange={(v) => onChange({ i18n: v || undefined })} />
          </label>
        )}
        <label className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm" title="Tắt = chỉ nhân viên thấy trong admin, không trả ra API public / website">
          Hiển thị trên website
          <Switch checked={f.public !== false} onCheckedChange={(v) => onChange({ public: v ? undefined : false })} />
        </label>
      </div>

      {siblings.length > 1 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">Chỉ hiện khi</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr]">
            <Select value={f.showIf?.field ?? '__none__'} onValueChange={(v) => onChange({ showIf: v === '__none__' ? undefined : { field: v, equals: f.showIf?.equals ?? true } })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Trường khác" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Luôn hiện —</SelectItem>
                {siblings
                  .filter((s) => s._key !== f._key && s.key)
                  .map((s) => (
                    <SelectItem key={s._key} value={s.key}>
                      {s.label || s.key}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="self-center text-center text-xs text-muted-foreground">bằng</span>
            <ShowIfValue field={f} siblings={siblings} onChange={(equals) => f.showIf && onChange({ showIf: { ...f.showIf, equals } })} />
          </div>
        </div>
      )}

      {f.type === 'repeater' && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Trường con của mỗi mục</p>
            <Select value={f.itemLabelField ?? '__none__'} onValueChange={(v) => onChange({ itemLabelField: v === '__none__' ? undefined : v })}>
              <SelectTrigger className="h-8 w-48 text-xs">
                <SelectValue placeholder="Nhãn mục lấy từ..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Nhãn mục: Mục 1, 2, 3...</SelectItem>
                {(f.fields ?? [])
                  .filter((s) => s.key)
                  .map((s) => (
                    <SelectItem key={s._key} value={s.key}>
                      Nhãn mục: {s.label || s.key}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <FieldBuilder value={f.fields ?? []} onChange={(fields) => onChange({ fields })} nested />
          <Field label="Số mục tối đa" className="mt-3">
            <Input type="number" min={1} value={f.max ?? ''} onChange={(e) => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="Không giới hạn" className="w-40" />
          </Field>
        </div>
      )}
    </>
  );
}

/**
 * Nguồn dữ liệu của trường quan hệ tuỳ biến: `entries` chọn loại nội dung, `terms` chọn taxonomy.
 * Danh sách taxonomy cần quyền content_types.manage; không có thì lấy key taxonomy từ các loại nội dung.
 */
function RelationSource({ field: f, onChange }: { field: BuilderField; onChange: (patch: Partial<BuilderField>) => void }) {
  const types = useContentTypes();
  const taxonomies = useTaxonomies();
  if (f.type === 'entries') {
    return (
      <Field label="Chọn bài của loại nội dung" help="Bỏ trống = cho chọn bài của mọi loại nội dung">
        <Select value={f.contentType || '__all__'} onValueChange={(v) => onChange({ contentType: v === '__all__' ? undefined : v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">— Mọi loại nội dung —</SelectItem>
            {types.data?.map((t) => (
              <SelectItem key={t.key} value={t.key}>
                {typeLabel(t.labels, 'vi', 'plural', t.key)} <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }
  const options = taxonomies.data?.length
    ? taxonomies.data.map((t) => ({ key: t.key, label: typeLabel(t.labels, 'vi', 'plural', t.key) }))
    : [...new Set((types.data ?? []).flatMap((t) => t.taxonomies))].map((k) => ({ key: k, label: k }));
  return (
    <Field label="Chọn phân loại của taxonomy" required help="Trường terms cần chọn một taxonomy">
      <Select value={f.taxonomy || ''} onValueChange={(v) => onChange({ taxonomy: v || undefined })}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Chọn taxonomy..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {t.label} <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Ô nhập giá trị so sánh cho showIf: boolean -> bật/tắt, select -> chọn, còn lại nhập chuỗi */
function ShowIfValue({ field: f, siblings, onChange }: { field: BuilderField; siblings: BuilderField[]; onChange: (equals: unknown) => void }) {
  const target = siblings.find((s) => s.key === f.showIf?.field);
  if (!f.showIf || !target) return <Input disabled placeholder="—" />;
  if (target.type === 'boolean') {
    return (
      <Select value={f.showIf.equals === false ? 'false' : 'true'} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Bật</SelectItem>
          <SelectItem value="false">Tắt</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (target.type === 'select' && target.options?.length) {
    return (
      <Select value={String(f.showIf.equals ?? '')} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Chọn giá trị" />
        </SelectTrigger>
        <SelectContent>
          {target.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return <Input value={String(f.showIf.equals ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="giá trị" />;
}
