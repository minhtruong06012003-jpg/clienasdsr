'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Info, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_TAX_CLASSES, TAX_MODE_LABELS, TAX_MODES, type TaxComputation, type TaxMode, type TaxRateItem } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { MoneyInput, NumberInput } from '@/components/commerce/number-input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

interface Regions {
  countries: { code: string; name: { vi: string; en: string } }[];
  provinces: { code: string; name: { vi: string; en: string } }[];
}

const RATES_KEY = ['tax-rates'];
const ANY = '*';

/** Mô tả ngắn từng chế độ thuế */
const MODE_HELP: Record<TaxMode, string> = {
  flat: 'Như trước đây: một thuế suất cho mọi đơn. Tuỳ chọn “Giá đã gồm thuế” quyết định tách ra hay cộng thêm.',
  none: 'Không tính thuế trên đơn hàng.',
  inclusive: 'Một thuế suất, giá sản phẩm luôn được coi là đã gồm thuế — chỉ tách phần thuế ra để hiển thị.',
  rates: 'Thuế suất theo lớp thuế của sản phẩm và tỉnh/quốc gia giao hàng (bảng bên dưới). Đơn đã tạo không bị tính lại.',
};

/** Cài đặt › Thuế: chế độ tính thuế (nhóm `commerce`) + bảng thuế suất theo vùng (`/admin/tax-rates`) */
export function TaxTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="commerce" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const mode = (TAX_MODES as readonly string[]).includes(v.taxMode) ? (v.taxMode as TaxMode) : 'flat';
        return (
          <>
            <Section title="Cách tính thuế" description="Áp dụng cho báo giá giỏ hàng và đơn hàng mới (cả đơn tạo thủ công). Đơn cũ giữ nguyên số liệu.">
              <Field label="Chế độ" help={MODE_HELP[mode]}>
                <Select value={mode} onValueChange={(taxMode) => set({ taxMode })}>
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {TAX_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {(mode === 'flat' || mode === 'inclusive') && (
                <Field label="Thuế suất chung">
                  <NumberInput value={v.taxRate} onChange={(taxRate) => set({ taxRate: taxRate ?? 0 })} suffix="%" min={0} className="w-32" />
                </Field>
              )}
              {(mode === 'flat' || mode === 'rates') && (
                <SwitchRow label="Giá sản phẩm đã bao gồm thuế" description="Bật: thuế được tách ra từ giá (tổng tiền không đổi). Tắt: thuế cộng thêm vào lúc thanh toán." checked={!!v.pricesIncludeTax} onChange={(pricesIncludeTax) => set({ pricesIncludeTax })} />
              )}
              <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Thuế trên đơn hàng độc lập với thuế suất GTGT trên hoá đơn điện tử (cấu hình ở tab Hoá đơn điện tử và trường “Thuế suất GTGT” của sản phẩm).
              </p>
            </Section>
            {mode === 'rates' && <TaxRatesManager />}
            {mode === 'rates' && <TaxPreview />}
          </>
        );
      }}
    </SettingsGroup>
  );
}

/** Bảng thuế suất: thêm / sửa / xoá lưu ngay (không phụ thuộc nút Lưu của nhóm cài đặt) */
function TaxRatesManager() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<TaxRateItem | 'new' | null>(null);
  const rates = useQuery({ queryKey: RATES_KEY, queryFn: () => api.get<TaxRateItem[]>('/admin/tax-rates') });
  const regions = useRegions();

  const remove = async (r: TaxRateItem) => {
    if (!(await confirm({ title: `Xoá thuế suất "${r.name}"?`, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/tax-rates/${r.id}`);
      toast.success('Đã xoá thuế suất');
      void qc.invalidateQueries({ queryKey: RATES_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Section
      title="Bảng thuế suất"
      description="Mỗi sản phẩm dùng mức khớp nhất với lớp thuế của nó và địa chỉ giao: tỉnh > quốc gia > mọi nơi (*); cùng mức thì ưu tiên cao hơn thắng."
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> Thêm thuế suất
        </Button>
      }
    >
      {rates.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !rates.data?.length ? (
        <EmptyState title="Chưa có thuế suất" description="Vd: “VAT 10%” lớp standard cho mọi nơi, thêm mức riêng cho từng tỉnh nếu cần." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="text-xs">Tên</TableHead>
                <TableHead className="text-xs">Lớp thuế</TableHead>
                <TableHead className="text-xs">Vùng</TableHead>
                <TableHead className="text-right text-xs">Thuế suất</TableHead>
                <TableHead className="text-xs">Phí ship</TableHead>
                <TableHead className="text-right text-xs">Ưu tiên</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.data.map((r) => (
                <TableRow key={r.id} className={cn(!r.isActive && 'opacity-60')}>
                  <TableCell className="font-medium">
                    {r.name}
                    {!r.isActive && <Badge variant="outline" className="ml-2">Tắt</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">{r.taxClass}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{regionLabel(r, regions.data)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.rate}%</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.shipping ? 'Có' : 'Không'}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{r.priority}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Sửa" onClick={() => setEditing(r)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Xoá" onClick={() => remove(r)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <TaxRateDialog editing={editing} regions={regions.data} onClose={() => setEditing(null)} />
    </Section>
  );
}

function useRegions() {
  return useQuery({ queryKey: ['shipping-regions-all'], queryFn: () => api.get<Regions>('/admin/shipping/regions'), staleTime: Infinity });
}

function regionLabel(r: Pick<TaxRateItem, 'country' | 'province'>, regions?: Regions) {
  if (r.country === ANY) return 'Mọi nơi';
  const c = regions?.countries.find((x) => x.code === r.country)?.name.vi ?? r.country;
  if (r.province === ANY) return c;
  const p = regions?.provinces.find((x) => x.code === r.province)?.name.vi ?? r.province;
  return `${p}, ${c}`;
}

/** Ô chọn quốc gia + tỉnh (tỉnh chỉ có với VN) */
function RegionSelect({ country, province, regions, onChange }: { country: string; province: string; regions?: Regions; onChange: (v: { country: string; province: string }) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Quốc gia">
        <Select value={country} onValueChange={(c) => onChange({ country: c, province: ANY })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Mọi nơi (*)</SelectItem>
            {regions?.countries.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name.vi} ({c.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Tỉnh / thành">
        <Select value={province} onValueChange={(p) => onChange({ country, province: p })} disabled={country !== 'VN'}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Tất cả (*)</SelectItem>
            {regions?.provinces.map((p) => (
              <SelectItem key={p.code} value={p.code}>
                {p.name.vi}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

interface RateForm {
  name: string;
  taxClass: string;
  country: string;
  province: string;
  rate: number | null;
  shipping: boolean;
  priority: number | null;
  isActive: boolean;
}

const EMPTY_RATE: RateForm = { name: '', taxClass: 'standard', country: ANY, province: ANY, rate: 10, shipping: false, priority: 0, isActive: true };

function TaxRateDialog({ editing, regions, onClose }: { editing: TaxRateItem | 'new' | null; regions?: Regions; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<RateForm>(EMPTY_RATE);
  const rate = editing && editing !== 'new' ? editing : null;
  const classes = useQuery({ queryKey: ['tax-classes'], queryFn: () => api.get<string[]>('/admin/tax-rates/classes'), enabled: !!editing });
  const classOptions = useMemo(() => [...new Set([...DEFAULT_TAX_CLASSES.map((c) => c.key), ...(classes.data ?? [])])], [classes.data]);

  useEffect(() => {
    if (!editing) return;
    setForm(rate ? { name: rate.name, taxClass: rate.taxClass, country: rate.country, province: rate.province, rate: rate.rate, shipping: rate.shipping, priority: rate.priority, isActive: rate.isActive } : EMPTY_RATE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = useMutation({
    mutationFn: () => {
      if (!form.name.trim()) throw new Error('Vui lòng nhập tên thuế suất');
      if (form.rate == null) throw new Error('Vui lòng nhập thuế suất');
      const body = { ...form, name: form.name.trim(), taxClass: form.taxClass.trim().toLowerCase() || 'standard', rate: form.rate, priority: form.priority ?? 0 };
      return rate ? api.patch(`/admin/tax-rates/${rate.id}`, body) : api.post('/admin/tax-rates', body);
    },
    onSuccess: () => {
      toast.success(rate ? 'Đã lưu thuế suất' : 'Đã thêm thuế suất');
      void qc.invalidateQueries({ queryKey: RATES_KEY });
      void qc.invalidateQueries({ queryKey: ['tax-classes'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rate ? 'Sửa thuế suất' : 'Thêm thuế suất'}</DialogTitle>
          <DialogDescription>Lớp thuế “standard” áp cho sản phẩm chưa chọn lớp thuế.</DialogDescription>
        </DialogHeader>
        <form
          id="tax-rate-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Tên" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Vd: VAT 10%" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Lớp thuế" help="Chọn hoặc gõ lớp mới (a-z, 0-9, _ -)">
              <Input value={form.taxClass} onChange={(e) => setForm({ ...form, taxClass: e.target.value })} list="tax-class-options" className="font-mono text-sm" />
              <datalist id="tax-class-options">
                {classOptions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Thuế suất" required>
              <NumberInput value={form.rate} onChange={(r) => setForm({ ...form, rate: r })} suffix="%" min={0} step={0.5} />
            </Field>
          </div>
          <RegionSelect country={form.country} province={form.province} regions={regions} onChange={(r) => setForm({ ...form, ...r })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ưu tiên" help="Cùng độ cụ thể vùng: số lớn hơn thắng">
              <NumberInput value={form.priority} onChange={(priority) => setForm({ ...form, priority })} integer />
            </Field>
            <div className="space-y-3 pt-6">
              <label className="flex items-center justify-between gap-2 text-sm">
                Tính thuế cả phí vận chuyển
                <Switch checked={form.shipping} onCheckedChange={(shipping) => setForm({ ...form, shipping })} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                Đang dùng
                <Switch checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} />
              </label>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="tax-rate-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Thử tính: một dòng hàng giả định theo lớp thuế + địa chỉ (dùng cài đặt ĐÃ LƯU) */
function TaxPreview() {
  const regions = useRegions();
  const [input, setInput] = useState({ taxClass: 'standard', country: 'VN', province: ANY, amount: 1_000_000 as number | null, shipping: 30_000 as number | null });
  const run = useMutation({
    mutationFn: () => api.post<TaxComputation>('/admin/tax-rates/preview', { taxClass: input.taxClass, country: input.country === ANY ? undefined : input.country, province: input.province === ANY ? undefined : input.province, amount: input.amount ?? 0, shipping: input.shipping ?? 0 }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const res = run.data;
  return (
    <Section title="Thử tính thuế" description="Kiểm tra mức thuế sẽ áp cho một sản phẩm theo địa chỉ giao (dùng cài đặt đã lưu)">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Lớp thuế">
          <Input value={input.taxClass} onChange={(e) => setInput({ ...input, taxClass: e.target.value })} className="font-mono text-sm" />
        </Field>
        <Field label="Thành tiền hàng">
          <MoneyInput value={input.amount} onChange={(amount) => setInput({ ...input, amount })} />
        </Field>
        <Field label="Phí vận chuyển">
          <MoneyInput value={input.shipping} onChange={(shipping) => setInput({ ...input, shipping })} />
        </Field>
      </div>
      <RegionSelect country={input.country} province={input.province} regions={regions.data} onChange={(r) => setInput({ ...input, ...r })} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <Calculator />} Tính thử
        </Button>
        {res && (
          <div className="text-sm">
            Thuế: <span className="font-semibold tabular-nums">{Math.round(res.taxTotal).toLocaleString('vi-VN')}</span>
            {res.shippingTax > 0 && <span className="text-muted-foreground"> (gồm {Math.round(res.shippingTax).toLocaleString('vi-VN')} trên phí ship)</span>}
            <span className="text-muted-foreground"> · {res.inclusive ? 'đã gồm trong giá' : 'cộng thêm'}</span>
            {res.breakdown.map((b) => (
              <Badge key={b.rateId ?? b.name} variant="secondary" className="ml-2">
                {b.name} · {b.rate}%
              </Badge>
            ))}
            {!res.breakdown.length && <span className="ml-2 text-amber-600 dark:text-amber-400">Không có thuế suất nào khớp</span>}
          </div>
        )}
      </div>
    </Section>
  );
}
