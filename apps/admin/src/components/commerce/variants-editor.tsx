'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ImagePlus, Layers, Plus, Settings2, Tags, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { slugify, type ProductAttribute, type ProductAttributeType, type ProductAttributeValue } from '@cmsnt/shared';
import { I18nInput } from '@/components/common/i18n-input';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { MediaPickerDialog } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { i18n } from '@/lib/format';
import type { I18nText } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useLanguages } from '@/hooks/use-languages';
import { MoneyInput, NumberInput } from './number-input';
import { STOCK_STATUSES } from './utils';

export interface ProductOption {
  key: string;
  name: I18nText;
  values: { value: string; label: I18nText }[];
}

export interface VariantForm {
  id?: string;
  _key: string;
  sku: string;
  optionValues: Record<string, string>;
  price: number | null;
  salePrice: number | null;
  stockQuantity: number | null;
  stockStatus: string;
  imageId: string | null;
  image?: { id?: string; url: string; urls?: Record<string, string> } | null;
  weight: number | null;
  isActive: boolean;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

const sameCombo = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export function variantLabel(options: ProductOption[], values: Record<string, string>, locale: string) {
  return options
    .filter((o) => values[o.key] != null)
    .map((o) => {
      const v = o.values.find((x) => x.value === values[o.key]);
      return v ? i18n(v.label, locale) || v.value : values[o.key];
    })
    .join(' / ');
}

/* ---------------- Thuộc tính dùng chung (Sản phẩm › Thuộc tính) ---------------- */

export const PRODUCT_ATTRIBUTES_KEY = ['product-attributes'];

/** Danh sách thuộc tính dùng chung (cache React Query, dùng ở variants editor + trang quản lý) */
export function useProductAttributes() {
  return useQuery({ queryKey: PRODUCT_ATTRIBUTES_KEY, queryFn: () => api.get<ProductAttribute[]>('/admin/product-attributes'), staleTime: 60_000 });
}

/** Ô nhỏ minh hoạ giá trị: chấm màu (color) / ảnh (image); kiểu khác không hiện gì */
export function AttributeSwatch({ type, value, className }: { type?: ProductAttributeType; value?: Pick<ProductAttributeValue, 'color' | 'image'> | null; className?: string }) {
  if (type === 'color' && value?.color) return <span className={cn('inline-block size-3.5 shrink-0 rounded-full border border-black/10 dark:border-white/20', className)} style={{ background: value.color }} aria-hidden />;
  if (type === 'image' && value?.image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={value.image.thumb ?? value.image.url} alt="" className={cn('size-4 shrink-0 rounded-sm object-cover', className)} />;
  }
  return null;
}

/** Chuyển thuộc tính dùng chung thành option của sản phẩm (key, tên, giá trị) */
const toOption = (a: ProductAttribute, values = a.values): ProductOption => ({ key: a.key, name: a.name ?? {}, values: values.map((v) => ({ value: v.value, label: v.label ?? { vi: v.value } })) });

/** Quản lý thuộc tính (options) của sản phẩm biến thể */
export function OptionsEditor({ value, onChange }: { value: ProductOption[]; onChange: (v: ProductOption[]) => void }) {
  const { defaultLocale } = useLanguages();
  const confirm = useConfirm();
  // thuộc tính dùng chung: chọn nhanh thay vì gõ tay (vẫn cho gõ tay như cũ)
  const shared = useProductAttributes().data ?? [];
  const sharedOf = (key: string) => shared.find((a) => a.key === key);
  const unused = shared.filter((a) => !value.some((o) => o.key === a.key));
  const update = (i: number, patch: Partial<ProductOption>) => onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const setName = (i: number, name: I18nText) => {
    const o = value[i];
    const auto = !o.key || o.key === slugify(i18n(o.name, defaultLocale)).replace(/-/g, '_');
    update(i, { name, ...(auto ? { key: slugify(i18n(name, defaultLocale)).replace(/-/g, '_') } : {}) });
  };

  return (
    <div className="space-y-3">
      {value.map((o, i) => (
        <div key={i} className="rounded-lg border bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_160px_auto]">
            <Field label="Tên thuộc tính">
              <I18nInput value={o.name} onChange={(v) => setName(i, v)} placeholder="Vd: Màu sắc, Kích cỡ" />
            </Field>
            <Field label="Mã" help="Dùng trong biến thể">
              <Input value={o.key} onChange={(e) => update(i, { key: e.target.value })} onBlur={(e) => update(i, { key: slugify(e.target.value).replace(/-/g, '_') })} className="font-mono text-xs" placeholder="color" />
            </Field>
            <div className="flex items-start pt-6">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive"
                aria-label="Xoá thuộc tính"
                onClick={async () => {
                  if (o.values.length && !(await confirm({ title: `Xoá thuộc tính "${i18n(o.name, defaultLocale) || o.key}"?`, description: 'Cần tạo lại biến thể sau khi xoá thuộc tính.', destructive: true, confirmText: 'Xoá' }))) return;
                  onChange(value.filter((_, j) => j !== i));
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <OptionValues option={o} shared={sharedOf(o.key)} onChange={(values) => update(i, { values })} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Tags /> Thêm thuộc tính dùng chung
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Chọn thuộc tính (thêm tất cả giá trị, xoá bớt sau)</DropdownMenuLabel>
            {unused.map((a) => (
              <DropdownMenuItem key={a.id} onClick={() => onChange([...value, toOption(a)])}>
                <span className="flex-1 truncate">{i18n(a.name, defaultLocale) || a.key}</span>
                <span className="flex items-center gap-0.5">
                  {a.values.slice(0, 5).map((v) => (
                    <AttributeSwatch key={v.value} type={a.type} value={v} className="size-3" />
                  ))}
                </span>
                <span className="text-xs text-muted-foreground">{a.values.length}</span>
              </DropdownMenuItem>
            ))}
            {!unused.length && <div className="px-2 py-1.5 text-sm text-muted-foreground">{shared.length ? 'Đã thêm hết thuộc tính dùng chung' : 'Chưa có thuộc tính dùng chung'}</div>}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/products/attributes" target="_blank">
                <Settings2 /> Quản lý thuộc tính
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...value, { key: '', name: {}, values: [] }])}>
          <Plus /> Thuộc tính tự nhập
        </Button>
      </div>
    </div>
  );
}

function OptionValues({ option, shared, onChange }: { option: ProductOption; shared?: ProductAttribute; onChange: (v: ProductOption['values']) => void }) {
  const { defaultLocale } = useLanguages();
  const [input, setInput] = useState('');
  // giá trị của thuộc tính dùng chung chưa có trong sản phẩm -> gợi ý bấm để thêm
  const suggestions = shared ? shared.values.filter((sv) => !option.values.some((v) => v.value === sv.value)) : [];
  const sharedValue = (val: string) => shared?.values.find((x) => x.value === val);
  const add = () => {
    const labels = input.split(',').map((s) => s.trim()).filter(Boolean);
    if (!labels.length) return;
    const next = [...option.values];
    for (const label of labels) {
      const val = slugify(label) || label;
      if (next.some((v) => v.value === val)) continue;
      next.push({ value: val, label: { [defaultLocale]: label } });
    }
    onChange(next);
    setInput('');
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="text-sm font-medium">Giá trị</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {option.values.map((v, i) => (
          <Popover key={`${v.value}-${i}`}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-sm hover:border-primary">
                <AttributeSwatch type={shared?.type} value={sharedValue(v.value)} />
                {i18n(v.label, defaultLocale) || v.value}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Xoá giá trị"
                  className="rounded text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(option.values.filter((_, j) => j !== i));
                  }}
                >
                  <X className="size-3.5" />
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3" align="start">
              <Field label="Nhãn hiển thị">
                <I18nInput value={v.label} onChange={(label) => onChange(option.values.map((x, j) => (j === i ? { ...x, label } : x)))} />
              </Field>
              <Field label="Mã giá trị" help="Đổi mã cần tạo lại biến thể">
                <Input
                  value={v.value}
                  className="font-mono text-xs"
                  onChange={(e) => onChange(option.values.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  onBlur={(e) => onChange(option.values.map((x, j) => (j === i ? { ...x, value: slugify(e.target.value) || e.target.value } : x)))}
                />
              </Field>
            </PopoverContent>
          </Popover>
        ))}
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={option.values.length ? 'Thêm giá trị...' : 'Nhập giá trị, Enter (vd: Đỏ, Xanh)'}
          className="h-7 w-52"
        />
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Từ thuộc tính dùng chung:</span>
          {suggestions.map((sv) => (
            <button
              key={sv.value}
              type="button"
              onClick={() => onChange([...option.values, { value: sv.value, label: sv.label ?? { vi: sv.value } }])}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed px-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
            >
              <Plus className="size-3" />
              <AttributeSwatch type={shared?.type} value={sv} className="size-3" />
              {i18n(sv.label, defaultLocale) || sv.value}
            </button>
          ))}
          {suggestions.length > 1 && (
            <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => onChange([...option.values, ...suggestions.map((sv) => ({ value: sv.value, label: sv.label ?? { vi: sv.value } }))])}>
              Thêm tất cả
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Sinh tổ hợp biến thể từ thuộc tính, giữ lại biến thể cũ trùng tổ hợp */
export function generateVariants(options: ProductOption[], current: VariantForm[], defaults: { price: number | null }) {
  const valid = options.filter((o) => o.key && o.values.length);
  if (!valid.length) return null;
  const combos = valid.reduce<Record<string, string>[]>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.key]: v.value }))), [{}]);
  return combos.map(
    (c) =>
      current.find((v) => sameCombo(v.optionValues, c)) ?? {
        _key: uid(),
        sku: '',
        optionValues: c,
        price: defaults.price,
        salePrice: null,
        stockQuantity: 0,
        stockStatus: 'IN_STOCK',
        imageId: null,
        image: null,
        weight: null,
        isActive: true,
      },
  );
}

function VariantImage({ value, onChange }: { value: VariantForm['image']; onChange: (m: { id: string; url: string; urls?: Record<string, string> } | null) => void }) {
  const [open, setOpen] = useState(false);
  const src = value?.urls?.thumb ?? value?.url;
  return (
    <>
      {src ? (
        <div className="group relative size-10 overflow-hidden rounded-md border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" className="size-full object-cover" />
          <button type="button" className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 group-hover:opacity-100" onClick={() => onChange(null)} aria-label="Gỡ ảnh">
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex size-10 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:border-primary hover:text-primary" aria-label="Chọn ảnh">
          <ImagePlus className="size-4" />
        </button>
      )}
      <MediaPickerDialog open={open} onOpenChange={setOpen} onSelect={(items) => items[0] && onChange({ id: items[0].id, url: items[0].url, urls: items[0].urls })} />
    </>
  );
}

/**
 * Bảng biến thể: SKU, giá, tồn kho, ảnh, bật/tắt.
 * `readOnlyStock`: sản phẩm bán theo kho mã — tồn kho từng biến thể = số mã còn trong kho, không sửa tay.
 */
export function VariantsTable({ options, value, onChange, manageStock, defaultPrice, readOnlyStock }: { options: ProductOption[]; value: VariantForm[]; onChange: (v: VariantForm[]) => void; manageStock: boolean; defaultPrice: number | null; readOnlyStock?: boolean }) {
  const { defaultLocale } = useLanguages();
  const confirm = useConfirm();
  const [bulkPrice, setBulkPrice] = useState<number | null>(null);
  const [bulkStock, setBulkStock] = useState<number | null>(null);
  const update = (key: string, patch: Partial<VariantForm>) => onChange(value.map((v) => (v._key === key ? { ...v, ...patch } : v)));

  const generate = async () => {
    const next = generateVariants(options, value, { price: defaultPrice });
    if (!next) return toast.error('Thêm ít nhất một thuộc tính có giá trị trước khi tạo biến thể');
    const kept = next.filter((v) => value.includes(v)).length;
    const removed = value.length - kept;
    if (removed > 0 && !(await confirm({ title: 'Tạo lại biến thể?', description: `${removed} biến thể không còn khớp thuộc tính sẽ bị xoá khi lưu.`, confirmText: 'Tạo lại' }))) return;
    onChange(next);
    toast.success(`Đã tạo ${next.length - kept} biến thể mới, giữ ${kept} biến thể cũ`);
  };

  const validKeys = new Set(options.map((o) => o.key));
  const isStale = (v: VariantForm) => Object.entries(v.optionValues).some(([k, val]) => !validKeys.has(k) || !options.find((o) => o.key === k)?.values.some((x) => x.value === val)) || options.some((o) => o.values.length && v.optionValues[o.key] == null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={generate}>
          <Wand2 /> Tạo biến thể
        </Button>
        {value.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1">
            <span className="text-xs text-muted-foreground">Áp dụng tất cả:</span>
            <MoneyInput value={bulkPrice} onChange={setBulkPrice} placeholder="Giá" className="w-32 [&_input]:h-7" />
            {manageStock && !readOnlyStock && <NumberInput value={bulkStock} onChange={setBulkStock} placeholder="Tồn kho" integer min={0} className="w-24 [&_input]:h-7" />}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={bulkPrice == null && bulkStock == null}
              onClick={() => {
                onChange(value.map((v) => ({ ...v, ...(bulkPrice != null ? { price: bulkPrice } : {}), ...(bulkStock != null && manageStock && !readOnlyStock ? { stockQuantity: bulkStock } : {}) })));
                setBulkPrice(null);
                setBulkStock(null);
              }}
            >
              Áp dụng
            </Button>
          </div>
        )}
      </div>
      {value.length === 0 ? (
        <EmptyState icon={Layers} title="Chưa có biến thể" description="Khai báo thuộc tính ở trên rồi bấm “Tạo biến thể” để sinh tất cả tổ hợp." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-12" />
                <TableHead className="min-w-28 text-xs">Biến thể</TableHead>
                <TableHead className="min-w-28 text-xs">SKU</TableHead>
                <TableHead className="min-w-28 text-xs">Giá</TableHead>
                <TableHead className="min-w-28 text-xs">Giá KM</TableHead>
                <TableHead className={cn('text-xs', manageStock ? 'min-w-20' : 'min-w-32')}>{manageStock ? (readOnlyStock ? 'Tồn kho (kho mã)' : 'Tồn kho') : 'Trạng thái kho'}</TableHead>
                <TableHead className="w-12 text-xs">Bật</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.map((v) => {
                const invalidSale = v.salePrice != null && v.price != null && v.salePrice >= v.price;
                return (
                  <TableRow key={v._key} className={cn(!v.isActive && 'opacity-60')}>
                    <TableCell>
                      <VariantImage value={v.image} onChange={(m) => update(v._key, { imageId: m?.id ?? null, image: m })} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{variantLabel(options, v.optionValues, defaultLocale) || '—'}</div>
                      {isStale(v) && <div className="text-xs text-amber-600 dark:text-amber-400">Không khớp thuộc tính</div>}
                    </TableCell>
                    <TableCell>
                      <Input value={v.sku} onChange={(e) => update(v._key, { sku: e.target.value })} className="h-8 font-mono text-xs" placeholder="SKU" />
                    </TableCell>
                    <TableCell>
                      <MoneyInput value={v.price} onChange={(price) => update(v._key, { price })} className="[&_input]:h-8" />
                    </TableCell>
                    <TableCell>
                      <MoneyInput value={v.salePrice} onChange={(salePrice) => update(v._key, { salePrice })} className={cn('[&_input]:h-8', invalidSale && '[&_input]:border-destructive')} />
                    </TableCell>
                    <TableCell>
                      {manageStock ? (
                        <NumberInput value={v.stockQuantity} onChange={(stockQuantity) => update(v._key, { stockQuantity })} integer className="[&_input]:h-8" disabled={readOnlyStock} />
                      ) : (
                        <Select value={v.stockStatus} onValueChange={(stockStatus) => update(v._key, { stockStatus })}>
                          <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STOCK_STATUSES.map((s) => (
                              <SelectItem key={s.value} value={s.value}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch checked={v.isActive} onCheckedChange={(isActive) => update(v._key, { isActive })} aria-label="Bật biến thể" />
                    </TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => onChange(value.filter((x) => x._key !== v._key))} aria-label="Xoá biến thể">
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {value.length > 0 && <p className="text-xs text-muted-foreground">{value.length} biến thể · {value.filter((v) => v.isActive).length} đang bán</p>}
    </div>
  );
}
