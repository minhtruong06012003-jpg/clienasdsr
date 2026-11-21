'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, Package, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { normalizePurchaseFields, pickText, type PurchaseFieldDef } from '@cmsnt/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type Paginated } from '@/lib/api';
import { formatMoney, pickTr } from '@/lib/format';
import { useDebounce } from '@/hooks/use-debounce';
import { useLanguages } from '@/hooks/use-languages';
import { MoneyInput, NumberInput } from './number-input';
import { toNum } from './utils';

/** Dòng hàng đang soạn (tạo đơn / sửa dòng hàng) */
export interface OrderLine {
  /** khoá cục bộ (React key) */
  key: string;
  /** id OrderItem có sẵn khi sửa đơn */
  id?: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  sku: string | null;
  optionValues: Record<string, string>;
  image: string | null;
  price: number;
  quantity: number;
  /** giá gốc của sản phẩm (để hiện "đã ghi đè") */
  basePrice?: number | null;
  stock?: number | null;
  /** ô thông tin khách cần nhập khi mua (Product.purchaseFields) — admin nhập hộ */
  purchaseFields?: PurchaseFieldDef[];
  /** giá trị đã nhập cho các ô trên, gửi kèm item (`fields`) */
  fields?: Record<string, string>;
}

interface ProductLite {
  id: string;
  type: 'SIMPLE' | 'VARIABLE' | 'DIGITAL';
  sku: string | null;
  price: unknown;
  salePrice: unknown;
  saleStart: string | null;
  saleEnd: string | null;
  status: string;
  manageStock: boolean;
  stockQuantity: number;
  stockStatus: string;
  featuredImage: { url: string; urls: Record<string, string> } | null;
  translations: { locale: string; name: string }[];
  _count?: { variants: number };
  /** JSON gốc các ô khách nhập khi mua (module Kho mã số) */
  purchaseFields?: unknown;
}

interface VariantLite {
  id: string;
  sku: string | null;
  optionValues: Record<string, string>;
  price: unknown;
  salePrice: unknown;
  stockQuantity: number;
  stockStatus: string;
  isActive: boolean;
  image: { url: string; urls: Record<string, string> } | null;
}

export const lineKey = () => Math.random().toString(36).slice(2, 10);

/** Giá đang áp dụng (giá khuyến mãi nếu còn hiệu lực) — giống effectivePrice phía API */
export function effectivePrice(p: { price: unknown; salePrice: unknown; saleStart?: string | null; saleEnd?: string | null }) {
  const price = toNum(p.price);
  const sale = p.salePrice == null || p.salePrice === '' ? null : toNum(p.salePrice);
  const now = Date.now();
  const active = sale != null && sale < price && (!p.saleStart || new Date(p.saleStart).getTime() <= now) && (!p.saleEnd || new Date(p.saleEnd).getTime() >= now);
  return active ? sale! : price;
}

export interface CommerceCalc {
  taxRate?: number;
  pricesIncludeTax?: boolean;
  shippingFlatRate?: number;
  freeShippingThreshold?: number;
}

/** Tính tạm tính / thuế / tổng giống API (OrdersAdminService.totals) */
export function calcTotals(lines: { price: number; quantity: number }[], discount: number, shipping: number, c: CommerceCalc) {
  const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const discountTotal = Math.min(Math.max(0, discount || 0), subtotal);
  const taxRate = Number(c.taxRate) || 0;
  const taxable = subtotal - discountTotal;
  const taxTotal = taxRate ? (c.pricesIncludeTax ? taxable - taxable / (1 + taxRate / 100) : (taxable * taxRate) / 100) : 0;
  const total = taxable + (shipping || 0) + (c.pricesIncludeTax ? 0 : taxTotal);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { subtotal: r(subtotal), discountTotal: r(discountTotal), shippingTotal: r(shipping || 0), taxTotal: r(taxTotal), total: r(total) };
}

export function defaultShipping(subtotal: number, c: CommerceCalc) {
  let s = subtotal > 0 ? Number(c.shippingFlatRate) || 0 : 0;
  if (c.freeShippingThreshold && subtotal >= Number(c.freeShippingThreshold)) s = 0;
  return s;
}

function Thumb({ src }: { src: string | null }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" className="size-10 shrink-0 rounded-md border object-cover" /> : <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"><Package className="size-4 text-muted-foreground" /></div>;
}

/** Hộp thoại chọn phân loại cho sản phẩm có biến thể */
function VariantPicker({ product, onPick, onClose }: { product: ProductLite; onPick: (v: VariantLite) => void; onClose: () => void }) {
  const { defaultLocale } = useLanguages();
  const detail = useQuery({ queryKey: ['product', product.id], queryFn: () => api.get<{ variants: VariantLite[]; manageStock: boolean }>(`/admin/products/${product.id}`) });
  const name = pickTr(product.translations, defaultLocale)?.name ?? '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chọn phân loại</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="max-h-96 divide-y overflow-y-auto rounded-lg border">
            {(detail.data?.variants ?? []).map((v) => {
              const out = v.stockStatus === 'OUT_OF_STOCK' || !v.isActive;
              return (
                <button key={v.id} type="button" disabled={out} onClick={() => onPick(v)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
                  <Thumb src={v.image?.urls.thumb ?? v.image?.url ?? product.featuredImage?.urls.thumb ?? null} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{Object.values(v.optionValues ?? {}).join(' / ') || 'Mặc định'}</span>
                    <span className="text-xs text-muted-foreground">
                      {v.sku || '—'}
                      {detail.data?.manageStock && ` · Tồn: ${v.stockQuantity}`}
                      {!v.isActive && ' · Đã tắt'}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatMoney(effectivePrice(v))}</span>
                </button>
              );
            })}
            {detail.data && !detail.data.variants.length && <p className="p-3 text-center text-sm text-muted-foreground">Sản phẩm chưa có biến thể</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Soạn dòng hàng: tìm sản phẩm (tên / SKU) để thêm, chọn phân loại, sửa số lượng / đơn giá, thêm dòng tuỳ ý.
 * Dùng cho trang Tạo đơn và hộp thoại Sửa dòng hàng.
 */
export function OrderLineEditor({ value, onChange, currency = 'VND', disabled }: { value: OrderLine[]; onChange: (lines: OrderLine[]) => void; currency?: string; disabled?: boolean }) {
  const { defaultLocale } = useLanguages();
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState<ProductLite | null>(null);
  const q = useDebounce(search.trim(), 300);

  const results = useQuery({
    queryKey: ['products', 'order-picker', q],
    queryFn: () => api.get<Paginated<ProductLite>>('/admin/products', { search: q, limit: 10 }),
    enabled: focused || !!q,
    placeholderData: keepPreviousData,
  });
  const name = (p: ProductLite) => pickTr(p.translations, defaultLocale)?.name ?? '(chưa có tên)';
  const money = (v: number) => formatMoney(v, currency);

  const update = (key: string, patch: Partial<OrderLine>) => onChange(value.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => onChange(value.filter((l) => l.key !== key));
  const push = (line: OrderLine) => {
    // cùng sản phẩm / phân loại -> tăng số lượng thay vì thêm dòng
    // sản phẩm có ô thông tin khách nhập -> mỗi lần thêm là một dòng riêng (mỗi dòng có thông tin khác nhau)
    const same = line.purchaseFields?.length ? undefined : value.find((l) => l.productId && l.productId === line.productId && (l.variantId ?? null) === (line.variantId ?? null) && !l.purchaseFields?.length);
    if (same) update(same.key, { quantity: same.quantity + 1 });
    else onChange([...value, line]);
  };
  /** Ô khách nhập của sản phẩm (nếu có) để admin nhập hộ ở dòng hàng */
  const purchaseOf = (p: ProductLite): Partial<OrderLine> => {
    const purchaseFields = normalizePurchaseFields(p.purchaseFields);
    return purchaseFields.length ? { purchaseFields, fields: {} } : {};
  };
  const addProduct = (p: ProductLite) => {
    setSearch('');
    if (p.type === 'VARIABLE') return setPicking(p);
    if (p.stockStatus === 'OUT_OF_STOCK') toast.warning(`"${name(p)}" đang hết hàng — API sẽ từ chối nếu kho không đủ`);
    const price = effectivePrice(p);
    push({ key: lineKey(), productId: p.id, variantId: null, name: name(p), sku: p.sku, optionValues: {}, image: p.featuredImage?.urls.thumb ?? p.featuredImage?.url ?? null, price, quantity: 1, basePrice: price, stock: p.manageStock ? p.stockQuantity : null, ...purchaseOf(p) });
  };
  const addVariant = (p: ProductLite, v: VariantLite) => {
    const price = effectivePrice(v);
    push({ key: lineKey(), productId: p.id, variantId: v.id, name: name(p), sku: v.sku ?? p.sku, optionValues: v.optionValues ?? {}, image: v.image?.urls.thumb ?? v.image?.url ?? p.featuredImage?.urls.thumb ?? null, price, quantity: 1, basePrice: price, stock: p.manageStock ? v.stockQuantity : null, ...purchaseOf(p) });
    setPicking(null);
  };
  const addCustom = () => onChange([...value, { key: lineKey(), productId: null, variantId: null, name: '', sku: null, optionValues: {}, image: null, price: 0, quantity: 1 }]);

  const subtotal = value.reduce((s, l) => s + l.price * l.quantity, 0);

  return (
    <div className="space-y-3">
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-64 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Tìm sản phẩm theo tên hoặc SKU để thêm vào đơn..." className="pl-8" />
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
                    <button key={p.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => addProduct(p)} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                      <Thumb src={p.featuredImage?.urls.thumb ?? p.featuredImage?.url ?? null} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1 font-medium">{name(p)}</span>
                        <span className="text-xs text-muted-foreground">
                          {p.sku || '—'}
                          {p.type === 'VARIABLE' && ` · ${p._count?.variants ?? 0} phân loại`}
                          {p.manageStock && p.type !== 'VARIABLE' && ` · Tồn: ${p.stockQuantity}`}
                          {p.status !== 'PUBLISHED' && ' · Chưa xuất bản'}
                        </span>
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{p.type === 'VARIABLE' ? 'Chọn phân loại' : money(effectivePrice(p))}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <Button type="button" variant="outline" onClick={addCustom}>
            <Plus /> Dòng tuỳ ý
          </Button>
        </div>
      )}

      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có sản phẩm nào trong đơn. Tìm sản phẩm ở trên hoặc thêm dòng tuỳ ý.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Sản phẩm</th>
                <th className="w-36 px-2 py-2 text-right font-medium">Đơn giá</th>
                <th className="w-24 px-2 py-2 text-right font-medium">SL</th>
                <th className="w-32 px-3 py-2 text-right font-medium">Thành tiền</th>
                {!disabled && <th className="w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {value.map((l) => (
                <tr key={l.key}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <Thumb src={l.image} />
                      <div className="min-w-0 flex-1">
                        {l.productId ? (
                          <div className="line-clamp-2 font-medium">{l.name}</div>
                        ) : (
                          <Input value={l.name} disabled={disabled} onChange={(e) => update(l.key, { name: e.target.value })} placeholder="Tên dòng tuỳ ý (vd: Phí lắp đặt)" className="h-8" />
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {Object.entries(l.optionValues ?? {}).map(([k, v]) => (
                            <Badge key={k} variant="outline" className="font-normal">
                              {k}: {v}
                            </Badge>
                          ))}
                          {l.sku && <span className="font-mono">SKU: {l.sku}</span>}
                          {l.stock != null && <span>Tồn: {l.stock}</span>}
                          {!l.productId && <Badge variant="secondary" className="font-normal">Tuỳ ý</Badge>}
                          {l.basePrice != null && l.price !== l.basePrice && <span className="text-amber-600 dark:text-amber-400">Giá gốc {money(l.basePrice)}</span>}
                        </div>
                        {/* Thông tin khách cần nhập khi mua (chỉ dòng mới): admin nhập hộ, gửi kèm item.fields */}
                        {!l.id && !!l.purchaseFields?.length && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {l.purchaseFields.map((f) => {
                              const label = pickText(f.label, defaultLocale) || f.key;
                              const val = l.fields?.[f.key] ?? '';
                              const set = (v: string) => update(l.key, { fields: { ...(l.fields ?? {}), [f.key]: v } });
                              return (
                                <label key={f.key} className="space-y-0.5 text-xs">
                                  <span className="text-muted-foreground">
                                    {label} {f.required && <span className="text-destructive">*</span>}
                                  </span>
                                  {f.type === 'select' ? (
                                    <select value={val} disabled={disabled} onChange={(e) => set(e.target.value)} className="h-8 w-full rounded-md border bg-transparent px-2 text-sm dark:bg-input/30">
                                      <option value="">— Chọn —</option>
                                      {(f.options ?? []).map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {pickText(o.label, defaultLocale) || o.value}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <Input
                                      value={val}
                                      disabled={disabled}
                                      onChange={(e) => set(e.target.value)}
                                      type={f.type === 'textarea' || f.type === 'password' ? 'text' : f.type}
                                      maxLength={f.maxLength}
                                      placeholder={pickText(f.placeholder, defaultLocale)}
                                      className="h-8"
                                    />
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <MoneyInput value={l.price} disabled={disabled} onChange={(v) => update(l.key, { price: v ?? 0 })} suffix={currency === 'VND' ? '₫' : currency} />
                  </td>
                  <td className="px-2 py-2">
                    <NumberInput value={l.quantity} disabled={disabled} integer min={1} onChange={(v) => update(l.key, { quantity: Math.max(1, v ?? 1) })} />
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{money(l.price * l.quantity)}</td>
                  {!disabled && (
                    <td className="px-1 py-2">
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => remove(l.key)} aria-label="Xoá dòng">
                        <Trash2 />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/30">
                <td colSpan={3} className="px-3 py-2 text-right text-muted-foreground">
                  Tạm tính ({value.reduce((s, l) => s + l.quantity, 0)} sản phẩm)
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(subtotal)}</td>
                {!disabled && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {picking && <VariantPicker product={picking} onPick={(v) => addVariant(picking, v)} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** Giá trị ô khách nhập đã điền (bỏ ô trống) -> `{ fields }`; không có gì -> {} */
function fieldsPayload(l: OrderLine): { fields?: Record<string, string> } {
  const entries = Object.entries(l.fields ?? {})
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v);
  return entries.length ? { fields: Object.fromEntries(entries) } : {};
}

/** Chuyển dòng soạn thành payload API (tạo đơn / sửa dòng hàng) */
export function linesToPayload(lines: OrderLine[]) {
  for (const l of lines) {
    if (!l.productId && !l.name.trim()) throw new Error('Dòng tuỳ ý cần có tên');
    if (l.quantity < 1) throw new Error('Số lượng phải lớn hơn 0');
    if (l.price < 0) throw new Error('Đơn giá không hợp lệ');
  }
  return lines.map((l) =>
    l.id
      ? { id: l.id, quantity: l.quantity, price: l.price }
      : l.productId
        ? { productId: l.productId, variantId: l.variantId ?? undefined, quantity: l.quantity, price: l.price, ...fieldsPayload(l) }
        : { name: l.name.trim(), sku: l.sku ?? undefined, price: l.price, quantity: l.quantity },
  );
}
