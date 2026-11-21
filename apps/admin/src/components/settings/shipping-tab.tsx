'use client';

/**
 * Cài đặt > Vận chuyển gồm 2 khối:
 * - "Vùng & phương thức": vùng vận chuyển + phương thức (đồng giá / miễn phí / theo cân nặng / theo giá / nhận tại cửa hàng /
 *   lấy phí từ hãng vận chuyển) — lưu từng thao tác qua API zones/methods;
 * - "Đơn vị vận chuyển": cấu hình hãng, kho lấy hàng, kiện hàng, tự động hoá (SettingsGroup `shipping`, file shipping-carriers.tsx).
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Globe, Loader2, MapPin, MoreHorizontal, Pencil, Plus, Search, Trash2, Truck, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { I18nInput } from '@/components/common/i18n-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput, NumberInput } from '@/components/commerce/number-input';
import { carrierLabel, useCarriers, type CarrierMeta } from '@/components/commerce/shipments';
import { toNum, toNumOrNull } from '@/components/commerce/utils';
import { api, errorMessage } from '@/lib/api';
import { formatMoney, i18n } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { cn } from '@/lib/utils';
import type { I18nText } from '@/lib/types';
import { ShippingCarriersSettings } from './shipping-carriers';

type TabProps = { onDirtyChange: (d: boolean) => void };

type MethodType = 'FLAT' | 'FREE' | 'WEIGHT' | 'PRICE' | 'PICKUP' | 'CARRIER';

interface ShippingRule {
  upTo: number | null;
  cost: number;
}

/** Điều chỉnh phí hãng: cộng số tiền cố định hoặc % (âm = giảm) */
interface FeeAdjust {
  type: 'fixed' | 'percent';
  value: number;
}

interface ShippingMethod {
  id: string;
  zoneId: string;
  type: MethodType;
  name: I18nText;
  description: I18nText | null;
  cost: unknown;
  minOrderTotal: unknown;
  rules: ShippingRule[];
  isActive: boolean;
  sortOrder: number;
  /** CARRIER: key hãng, null = mọi hãng đã bật */
  carrier?: string | null;
  /** CARRIER: mã dịch vụ, null = mọi dịch vụ hãng trả về */
  carrierService?: string | null;
  feeAdjust?: FeeAdjust | null;
  /** CARRIER: phí dự phòng khi API hãng lỗi */
  fallbackCost?: unknown;
}

interface ShippingZone {
  id: string;
  name: string;
  regions: string[];
  isActive: boolean;
  sortOrder: number;
  methods: ShippingMethod[];
}

interface Regions {
  countries: { code: string; name: I18nText }[];
  provinces: { code: string; name: I18nText; region: 'north' | 'central' | 'south'; country: string }[];
  groups: { key: 'north' | 'central' | 'south'; name: I18nText }[];
}

const METHOD_TYPES: { value: MethodType; label: string; help: string }[] = [
  { value: 'FLAT', label: 'Đồng giá', help: 'Một mức phí cố định cho mọi đơn' },
  { value: 'FREE', label: 'Miễn phí vận chuyển', help: 'Chỉ hiện khi đơn đạt giá trị tối thiểu (để trống = luôn miễn phí)' },
  { value: 'WEIGHT', label: 'Theo cân nặng', help: 'Bảng phí theo tổng cân nặng (gram) của giỏ hàng' },
  { value: 'PRICE', label: 'Theo giá trị đơn', help: 'Bảng phí theo tạm tính của giỏ hàng' },
  { value: 'PICKUP', label: 'Nhận tại cửa hàng', help: 'Khách tự đến lấy, phí 0' },
  { value: 'CARRIER', label: 'Lấy phí từ hãng vận chuyển', help: 'Hỏi API hãng (GHN, GHTK, Viettel Post...) theo địa chỉ và kiện hàng của khách; mỗi dịch vụ hãng trả về là một lựa chọn ở trang thanh toán' },
];

const typeLabel = (t: MethodType) => METHOD_TYPES.find((x) => x.value === t)?.label ?? t;

const ZONES_KEY = ['shipping', 'zones'];

/** Mô tả điều chỉnh phí: "+5.000₫" | "-10%" */
function feeAdjustText(a: FeeAdjust | null | undefined) {
  if (!a || !a.value) return '';
  const sign = a.value > 0 ? '+' : '−';
  return a.type === 'percent' ? `${sign}${Math.abs(a.value)}%` : `${sign}${formatMoney(Math.abs(a.value))}`;
}

/** Mô tả ngắn phí của method để hiện trong danh sách */
function costText(m: ShippingMethod, carriers?: CarrierMeta[]) {
  switch (m.type) {
    case 'FLAT':
      return formatMoney(toNum(m.cost));
    case 'FREE':
      return toNumOrNull(m.minOrderTotal) != null ? `Miễn phí từ ${formatMoney(toNum(m.minOrderTotal))}` : 'Miễn phí';
    case 'PICKUP':
      return 'Miễn phí';
    case 'CARRIER': {
      const parts = [`Theo ${m.carrier ? carrierLabel(m.carrier, carriers) : 'mọi hãng đã bật'}${m.carrierService ? ` (${m.carrierService})` : ''}`];
      const adj = feeAdjustText(m.feeAdjust);
      if (adj) parts.push(adj);
      if (toNumOrNull(m.fallbackCost) != null) parts.push(`dự phòng ${formatMoney(toNum(m.fallbackCost))}`);
      return parts.join(' · ');
    }
    case 'WEIGHT':
    case 'PRICE': {
      const rules = Array.isArray(m.rules) ? m.rules : [];
      if (!rules.length) return formatMoney(toNum(m.cost));
      const costs = rules.map((r) => toNum(r.cost));
      const min = Math.min(...costs);
      const max = Math.max(...costs);
      return min === max ? formatMoney(min) : `${formatMoney(min)} – ${formatMoney(max)} (${rules.length} mức)`;
    }
  }
}

type ShippingSection = 'zones' | 'carriers';

const SECTIONS: { key: ShippingSection; label: string; desc: string }[] = [
  { key: 'zones', label: 'Vùng & phương thức', desc: 'Phí ship khách thấy theo địa chỉ' },
  { key: 'carriers', label: 'Đơn vị vận chuyển', desc: 'Kết nối hãng, kho lấy hàng, vận đơn' },
];

/** Tab Vận chuyển: chuyển giữa khối "Vùng & phương thức" và "Đơn vị vận chuyển" (giữ trên URL `?section=`) */
export function ShippingTab({ onDirtyChange }: TabProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const confirm = useConfirm();
  const section: ShippingSection = sp.get('section') === 'carriers' ? 'carriers' : 'zones';
  // chỉ khối Đơn vị vận chuyển có form cần lưu -> theo dõi dirty để hỏi trước khi chuyển khối
  const [dirty, setDirty] = useState(false);
  const onDirty = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  const go = async (key: ShippingSection) => {
    if (key === section) return;
    if (dirty && !(await confirm({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi trong mục Đơn vị vận chuyển chưa được lưu sẽ bị mất.', confirmText: 'Bỏ thay đổi', destructive: true }))) return;
    setDirty(false);
    onDirtyChange(false);
    const next = new URLSearchParams(sp.toString());
    if (key === 'zones') next.delete('section');
    else next.set('section', key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-5">
      <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
        {SECTIONS.map((s) => (
          <button key={s.key} type="button" onClick={() => void go(s.key)} className={cn('rounded-md px-3 py-1.5 text-left text-sm transition', section === s.key ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {s.label}
            <span className="ml-1.5 hidden text-xs font-normal text-muted-foreground sm:inline">— {s.desc}</span>
          </button>
        ))}
      </div>
      {section === 'carriers' ? <ShippingCarriersSettings key="carriers" onDirtyChange={onDirty} /> : <ZonesSection />}
    </div>
  );
}

/** Khối Vùng & phương thức (giống WooCommerce): mỗi thao tác lưu ngay qua API */
function ZonesSection() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canEdit = can('settings.shipping');
  const carriers = useCarriers(canEdit);
  const zones = useQuery({ queryKey: ZONES_KEY, queryFn: () => api.get<ShippingZone[]>('/admin/shipping/zones') });
  const regions = useQuery({ queryKey: ['shipping', 'regions'], queryFn: () => api.get<Regions>('/admin/shipping/regions'), staleTime: Infinity });
  const [zoneDialog, setZoneDialog] = useState<ShippingZone | 'new' | null>(null);
  const [methodDialog, setMethodDialog] = useState<{ zone: ShippingZone; method: ShippingMethod | null } | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ZONES_KEY });

  const quick = useMutation({
    mutationFn: () => api.post('/admin/shipping/zones/quick-setup', {}),
    onSuccess: () => {
      toast.success('Đã tạo vùng "Toàn quốc" từ phí đồng giá hiện tại');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleZone = useMutation({
    mutationFn: (z: ShippingZone) => api.patch(`/admin/shipping/zones/${z.id}`, { isActive: !z.isActive }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleMethod = useMutation({
    mutationFn: (m: ShippingMethod) => api.patch(`/admin/shipping/methods/${m.id}`, { ...methodBody(m), isActive: !m.isActive }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reorderZones = useMutation({
    mutationFn: (ids: string[]) => api.post('/admin/shipping/zones/reorder', { ids }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reorderMethods = useMutation({
    mutationFn: (ids: string[]) => api.post('/admin/shipping/methods/reorder', { ids }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const moveZone = (i: number, dir: -1 | 1) => {
    const list = [...(zones.data ?? [])];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    reorderZones.mutate(list.map((z) => z.id));
  };
  const moveMethod = (zone: ShippingZone, i: number, dir: -1 | 1) => {
    const list = [...zone.methods];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    reorderMethods.mutate(list.map((m) => m.id));
  };

  const removeZone = async (z: ShippingZone) => {
    if (!(await confirm({ title: `Xoá vùng "${z.name}"?`, description: z.methods.length ? `${z.methods.length} phương thức trong vùng sẽ bị xoá theo.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/shipping/zones/${z.id}`);
      toast.success('Đã xoá vùng vận chuyển');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const removeMethod = async (m: ShippingMethod) => {
    if (!(await confirm({ title: `Xoá phương thức "${i18n(m.name)}"?`, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/shipping/methods/${m.id}`);
      toast.success('Đã xoá phương thức');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const regionLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of regions.data?.countries ?? []) map.set(c.code, i18n(c.name));
    for (const p of regions.data?.provinces ?? []) map.set(p.code, i18n(p.name));
    map.set('*', 'Mọi nơi');
    return (code: string) => map.get(code) ?? code;
  }, [regions.data]);

  const regionsText = (z: ShippingZone) => {
    if (z.regions.includes('*')) return 'Mọi nơi (các vùng còn lại)';
    const names = z.regions.map(regionLabel);
    if (names.length <= 4) return names.join(', ');
    return `${names.slice(0, 4).join(', ')} +${names.length - 4} vùng khác`;
  };

  if (zones.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  const list = zones.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Vùng vận chuyển</h3>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Khách ở địa chỉ nào sẽ thấy các phương thức của vùng khớp địa chỉ đó: ưu tiên vùng có tỉnh/thành, rồi tới quốc gia, cuối cùng là vùng “Mọi nơi”. Khi chưa có vùng nào, website dùng phí đồng giá trong tab{' '}
            <strong>Bán hàng</strong>.
          </p>
        </div>
        {canEdit && list.length > 0 && (
          <Button onClick={() => setZoneDialog('new')}>
            <Plus /> Thêm vùng
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="Chưa có vùng vận chuyển"
          description="Website đang dùng phí đồng giá và ngưỡng miễn phí trong tab Bán hàng. Thiết lập nhanh để chuyển sang vùng + phương thức, hoặc tự thêm vùng."
          action={
            canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => quick.mutate()} disabled={quick.isPending}>
                  {quick.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />} Thiết lập nhanh (Toàn quốc)
                </Button>
                <Button variant="outline" onClick={() => setZoneDialog('new')}>
                  <Plus /> Thêm vùng
                </Button>
              </div>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {list.map((z, i) => (
            <section key={z.id} className={cn('rounded-xl border bg-card', !z.isActive && 'opacity-70')}>
              <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                {canEdit && (
                  <div className="flex flex-col">
                    <Button variant="ghost" size="icon-xs" aria-label="Lên" disabled={i === 0 || reorderZones.isPending} onClick={() => moveZone(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label="Xuống" disabled={i === list.length - 1 || reorderZones.isPending} onClick={() => moveZone(i, 1)}>
                      <ArrowDown />
                    </Button>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="font-semibold hover:text-primary" onClick={() => canEdit && setZoneDialog(z)}>
                      {z.name}
                    </button>
                    <Badge variant="outline" className="font-normal">
                      {z.regions.includes('*') ? <Globe className="size-3" /> : <MapPin className="size-3" />} {z.regions.includes('*') ? 'Mọi nơi' : `${z.regions.length} vùng`}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {z.methods.length} phương thức
                    </Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{regionsText(z)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch size="sm" checked={z.isActive} disabled={!canEdit || toggleZone.isPending} onCheckedChange={() => toggleZone.mutate(z)} aria-label="Bật/tắt vùng" />
                  {canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setZoneDialog(z)}>
                          <Pencil /> Sửa vùng
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMethodDialog({ zone: z, method: null })}>
                          <Plus /> Thêm phương thức
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => removeZone(z)}>
                          <Trash2 /> Xoá vùng
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              <div className="divide-y">
                {z.methods.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Chưa có phương thức — khách ở vùng này sẽ không đặt hàng được.</p>}
                {z.methods.map((m, mi) => (
                  <div key={m.id} className={cn('flex items-center gap-2 px-4 py-2.5', !m.isActive && 'opacity-60')}>
                    {canEdit && (
                      <div className="flex flex-col">
                        <Button variant="ghost" size="icon-xs" aria-label="Lên" disabled={mi === 0 || reorderMethods.isPending} onClick={() => moveMethod(z, mi, -1)}>
                          <ArrowUp />
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label="Xuống" disabled={mi === z.methods.length - 1 || reorderMethods.isPending} onClick={() => moveMethod(z, mi, 1)}>
                          <ArrowDown />
                        </Button>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <button type="button" className="text-sm font-medium hover:text-primary" onClick={() => canEdit && setMethodDialog({ zone: z, method: m })}>
                        {i18n(m.name) || typeLabel(m.type)}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {typeLabel(m.type)} · {costText(m, carriers.data?.carriers)}
                        {m.description && i18n(m.description) ? ` · ${i18n(m.description)}` : ''}
                      </div>
                    </div>
                    <Switch size="sm" checked={m.isActive} disabled={!canEdit || toggleMethod.isPending} onCheckedChange={() => toggleMethod.mutate(m)} aria-label="Bật/tắt phương thức" />
                    {canEdit && (
                      <>
                        <Button variant="ghost" size="icon-sm" aria-label="Sửa" onClick={() => setMethodDialog({ zone: z, method: m })}>
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label="Xoá" onClick={() => removeMethod(m)}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <div className="px-4 py-2">
                    <Button variant="ghost" size="sm" onClick={() => setMethodDialog({ zone: z, method: null })}>
                      <Plus /> Thêm phương thức
                    </Button>
                  </div>
                )}
              </div>
            </section>
          ))}
          <p className="text-xs text-muted-foreground">Phí đồng giá và ngưỡng miễn phí trong tab Bán hàng chỉ còn dùng khi không có vùng nào được bật.</p>
        </div>
      )}

      <ZoneDialog editing={zoneDialog} regions={regions.data} onClose={() => setZoneDialog(null)} />
      <MethodDialog editing={methodDialog} carriers={carriers.data?.carriers} onClose={() => setMethodDialog(null)} />
    </div>
  );
}

// ---------------- dialog vùng ----------------

type ZoneMode = 'everywhere' | 'country' | 'provinces';

function ZoneDialog({ editing, regions, onClose }: { editing: ShippingZone | 'new' | null; regions: Regions | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const zone = editing && editing !== 'new' ? editing : null;
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ZoneMode>('country');
  const [selected, setSelected] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>(['VN']);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!editing) return;
    if (zone) {
      setName(zone.name);
      const provinces = zone.regions.filter((r) => r.includes('-'));
      const cs = zone.regions.filter((r) => !r.includes('-') && r !== '*');
      if (zone.regions.includes('*')) setMode('everywhere');
      else if (provinces.length) setMode('provinces');
      else setMode('country');
      setSelected(provinces);
      setCountries(cs.length ? cs : ['VN']);
    } else {
      setName('');
      setMode('country');
      setSelected([]);
      setCountries(['VN']);
    }
    setSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const provinces = regions?.provinces ?? [];
  const q = search.trim().toLowerCase();
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .toLowerCase();
  const visible = q ? provinces.filter((p) => normalize(i18n(p.name)).includes(normalize(q)) || i18n(p.name, 'en').toLowerCase().includes(q) || p.code.toLowerCase().includes(q)) : provinces;
  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]));
  const toggleGroup = (key: string, on: boolean) => {
    const codes = provinces.filter((p) => p.region === key).map((p) => p.code);
    setSelected((s) => (on ? [...new Set([...s, ...codes])] : s.filter((x) => !codes.includes(x))));
  };

  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('Vui lòng nhập tên vùng');
      let list: string[];
      if (mode === 'everywhere') list = ['*'];
      else if (mode === 'country') {
        if (!countries.length) throw new Error('Vui lòng chọn ít nhất một quốc gia');
        list = countries;
      } else {
        if (!selected.length) throw new Error('Vui lòng chọn ít nhất một tỉnh/thành');
        list = selected;
      }
      const body = { name: name.trim(), regions: list };
      return zone ? api.patch(`/admin/shipping/zones/${zone.id}`, body) : api.post('/admin/shipping/zones', body);
    },
    onSuccess: () => {
      toast.success(zone ? 'Đã lưu vùng' : 'Đã thêm vùng. Hãy thêm phương thức vận chuyển cho vùng này.');
      void qc.invalidateQueries({ queryKey: ZONES_KEY });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{zone ? `Sửa vùng "${zone.name}"` : 'Thêm vùng vận chuyển'}</DialogTitle>
          <DialogDescription>Một địa chỉ chỉ thuộc về một vùng: vùng có tỉnh/thành được ưu tiên hơn vùng theo quốc gia và vùng “Mọi nơi”.</DialogDescription>
        </DialogHeader>
        <form
          id="zone-form"
          className="max-h-[65vh] space-y-4 overflow-y-auto px-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Tên vùng" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Nội thành Hà Nội, Toàn quốc, Quốc tế" autoFocus />
          </Field>
          <Field label="Phạm vi">
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  { value: 'provinces', label: 'Chọn tỉnh/thành', desc: 'Một hoặc nhiều tỉnh/thành Việt Nam' },
                  { value: 'country', label: 'Theo quốc gia', desc: 'Toàn quốc hoặc các nước khác' },
                  { value: 'everywhere', label: 'Mọi nơi', desc: 'Các địa chỉ không khớp vùng nào khác' },
                ] as { value: ZoneMode; label: string; desc: string }[]
              ).map((o) => (
                <label key={o.value} className={cn('flex cursor-pointer gap-2 rounded-lg border p-3 text-sm', mode === o.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50')}>
                  <input type="radio" name="zone-mode" className="mt-0.5 accent-primary" checked={mode === o.value} onChange={() => setMode(o.value)} />
                  <span>
                    <span className="block font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          {mode === 'country' && (
            <Field label="Quốc gia" help="Chọn “Việt Nam” để tạo vùng toàn quốc">
              <div className="flex flex-wrap gap-2">
                {(regions?.countries ?? []).map((c) => {
                  const on = countries.includes(c.code);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setCountries((s) => (on ? s.filter((x) => x !== c.code) : [...s, c.code]))}
                      className={cn('rounded-full border px-3 py-1 text-xs', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                    >
                      {i18n(c.name)}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          {mode === 'provinces' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>
                  Tỉnh/thành <span className="text-xs font-normal text-muted-foreground">— đã chọn {selected.length}</span>
                </Label>
                <div className="flex gap-1">
                  {(regions?.groups ?? []).map((g) => {
                    const codes = provinces.filter((p) => p.region === g.key).map((p) => p.code);
                    const all = codes.length > 0 && codes.every((c) => selected.includes(c));
                    return (
                      <Button key={g.key} type="button" size="sm" variant={all ? 'secondary' : 'outline'} onClick={() => toggleGroup(g.key, !all)}>
                        {all ? 'Bỏ ' : ''}
                        {i18n(g.name)}
                      </Button>
                    );
                  })}
                  {selected.length > 0 && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>
                      <X /> Bỏ chọn
                    </Button>
                  )}
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm tỉnh/thành..." className="pl-8" />
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border p-2">
                {(regions?.groups ?? []).map((g) => {
                  const items = visible.filter((p) => p.region === g.key);
                  if (!items.length) return null;
                  return (
                    <div key={g.key} className="mb-2">
                      <p className="px-1 py-1 text-xs font-semibold uppercase text-muted-foreground">{i18n(g.name)}</p>
                      <div className="grid gap-1 sm:grid-cols-3">
                        {items.map((p) => (
                          <label key={p.code} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
                            <Checkbox checked={selected.includes(p.code)} onCheckedChange={() => toggle(p.code)} />
                            <span className="truncate">{i18n(p.name)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {visible.length === 0 && <p className="p-3 text-center text-sm text-muted-foreground">Không tìm thấy tỉnh/thành</p>}
              </div>
            </div>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="zone-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- dialog phương thức ----------------

interface MethodForm {
  type: MethodType;
  name: I18nText;
  description: I18nText;
  cost: number | null;
  minOrderTotal: number | null;
  rules: { upTo: number | null; cost: number | null }[];
  isActive: boolean;
  /** CARRIER: '' = mọi hãng đã bật */
  carrier: string;
  carrierService: string;
  feeAdjustType: 'fixed' | 'percent';
  feeAdjustValue: number | null;
  fallbackCost: number | null;
}

/** Các trường riêng của loại CARRIER (gửi null cho loại khác để xoá cấu hình cũ) */
const carrierFields = (m: Pick<ShippingMethod, 'type' | 'carrier' | 'carrierService' | 'feeAdjust' | 'fallbackCost'>) =>
  m.type === 'CARRIER'
    ? { carrier: m.carrier || null, carrierService: m.carrierService || null, feeAdjust: m.feeAdjust && m.feeAdjust.value ? m.feeAdjust : null, fallbackCost: toNumOrNull(m.fallbackCost) }
    : { carrier: null, carrierService: null, feeAdjust: null, fallbackCost: null };

const methodBody = (m: ShippingMethod) => ({
  type: m.type,
  name: m.name,
  description: m.description ?? undefined,
  cost: toNum(m.cost),
  minOrderTotal: toNumOrNull(m.minOrderTotal),
  rules: Array.isArray(m.rules) ? m.rules.map((r) => ({ upTo: r.upTo == null ? null : toNum(r.upTo), cost: toNum(r.cost) })) : [],
  isActive: m.isActive,
  ...carrierFields(m),
});

const DEFAULT_NAMES: Record<MethodType, I18nText> = {
  FLAT: { vi: 'Giao hàng tiêu chuẩn', en: 'Standard shipping' },
  FREE: { vi: 'Miễn phí vận chuyển', en: 'Free shipping' },
  WEIGHT: { vi: 'Giao hàng theo cân nặng', en: 'Shipping by weight' },
  PRICE: { vi: 'Giao hàng tiêu chuẩn', en: 'Standard shipping' },
  PICKUP: { vi: 'Nhận tại cửa hàng', en: 'Store pickup' },
  CARRIER: { vi: 'Giao hàng qua đơn vị vận chuyển', en: 'Carrier shipping' },
};

const emptyMethod = (): MethodForm => ({ type: 'FLAT', name: { ...DEFAULT_NAMES.FLAT }, description: {}, cost: null, minOrderTotal: null, rules: [{ upTo: null, cost: null }], isActive: true, carrier: '', carrierService: '', feeAdjustType: 'fixed', feeAdjustValue: null, fallbackCost: null });

function MethodDialog({ editing, carriers, onClose }: { editing: { zone: ShippingZone; method: ShippingMethod | null } | null; carriers: CarrierMeta[] | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const { defaultLocale } = useLanguages();
  const method = editing?.method ?? null;
  const [form, setForm] = useState<MethodForm>(emptyMethod);
  const up = (patch: Partial<MethodForm>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!editing) return;
    setForm(
      method
        ? {
            type: method.type,
            name: method.name ?? {},
            description: method.description ?? {},
            cost: toNumOrNull(method.cost),
            minOrderTotal: toNumOrNull(method.minOrderTotal),
            rules: Array.isArray(method.rules) && method.rules.length ? method.rules.map((r) => ({ upTo: r.upTo == null ? null : toNum(r.upTo), cost: toNum(r.cost) })) : [{ upTo: null, cost: null }],
            isActive: method.isActive,
            carrier: method.carrier ?? '',
            carrierService: method.carrierService ?? '',
            feeAdjustType: method.feeAdjust?.type ?? 'fixed',
            feeAdjustValue: method.feeAdjust?.value ?? null,
            fallbackCost: toNumOrNull(method.fallbackCost),
          }
        : emptyMethod(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // hãng đã bật để chọn cho loại CARRIER (hãng đang chọn nhưng đã tắt vẫn giữ trong danh sách)
  const enabledCarriers = (carriers ?? []).filter((c) => c.enabled || c.key === form.carrier);

  const changeType = (type: MethodType) => {
    // đổi loại: gợi ý tên mặc định nếu tên đang là tên mặc định của loại cũ (hoặc trống)
    const cur = form.name[defaultLocale] ?? '';
    const isDefault = !cur || Object.values(DEFAULT_NAMES).some((n) => n[defaultLocale] === cur);
    up({ type, name: isDefault ? { ...DEFAULT_NAMES[type] } : form.name });
  };

  const setRule = (i: number, patch: Partial<{ upTo: number | null; cost: number | null }>) => up({ rules: form.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const hasTable = form.type === 'WEIGHT' || form.type === 'PRICE';

  const save = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('Thiếu vùng');
      if (!Object.values(form.name).some((v) => v?.trim())) throw new Error('Vui lòng nhập tên phương thức');
      const rules = hasTable ? form.rules.filter((r) => r.cost != null || r.upTo != null).map((r) => ({ upTo: r.upTo, cost: r.cost ?? 0 })) : [];
      if (hasTable && !rules.length) throw new Error('Vui lòng thêm ít nhất một mức phí');
      if (hasTable && rules.filter((r) => r.upTo == null).length > 1) throw new Error('Chỉ được một dòng "còn lại" (để trống ngưỡng)');
      const body = {
        type: form.type,
        name: form.name,
        description: Object.values(form.description).some(Boolean) ? form.description : null,
        cost: form.type === 'FLAT' ? (form.cost ?? 0) : 0,
        minOrderTotal: form.type === 'FREE' ? form.minOrderTotal : null,
        rules,
        isActive: form.isActive,
        ...carrierFields({
          type: form.type,
          carrier: form.carrier.trim() || null,
          carrierService: form.carrierService.trim() || null,
          feeAdjust: form.feeAdjustValue ? { type: form.feeAdjustType, value: form.feeAdjustValue } : null,
          fallbackCost: form.fallbackCost,
        }),
      };
      return method ? api.patch(`/admin/shipping/methods/${method.id}`, body) : api.post(`/admin/shipping/zones/${editing.zone.id}/methods`, body);
    },
    onSuccess: () => {
      toast.success(method ? 'Đã lưu phương thức' : 'Đã thêm phương thức');
      void qc.invalidateQueries({ queryKey: ZONES_KEY });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const typeInfo = METHOD_TYPES.find((t) => t.value === form.type);
  const unit = form.type === 'WEIGHT' ? 'g' : '₫';

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{method ? 'Sửa phương thức vận chuyển' : 'Thêm phương thức vận chuyển'}</DialogTitle>
          <DialogDescription>Vùng: {editing?.zone.name}</DialogDescription>
        </DialogHeader>
        <form
          id="method-form"
          className="grid max-h-[65vh] gap-4 overflow-y-auto px-0.5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Loại" help={typeInfo?.help} className="sm:col-span-2">
            <Select value={form.type} onValueChange={(v) => changeType(v as MethodType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHOD_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Tên hiển thị" required className="sm:col-span-2">
            <I18nInput value={form.name} onChange={(name) => up({ name })} placeholder="VD: Giao hàng tiêu chuẩn" />
          </Field>
          <Field label="Mô tả" help="Hiện dưới tên phương thức ở trang thanh toán (vd: giao trong 2–3 ngày)" className="sm:col-span-2">
            <I18nInput value={form.description} onChange={(description) => up({ description })} />
          </Field>
          {form.type === 'FLAT' && (
            <Field label="Phí vận chuyển" required>
              <MoneyInput value={form.cost} onChange={(cost) => up({ cost })} />
            </Field>
          )}
          {form.type === 'FREE' && (
            <Field label="Miễn phí từ" help="Để trống = luôn miễn phí. Chưa đạt ngưỡng thì phương thức này bị ẩn.">
              <MoneyInput value={form.minOrderTotal} onChange={(minOrderTotal) => up({ minOrderTotal })} placeholder="Không yêu cầu" />
            </Field>
          )}
          {form.type === 'CARRIER' && (
            <>
              {carriers && !enabledCarriers.length && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300 sm:col-span-2">
                  Chưa bật hãng vận chuyển nào — hãy bật ở khối <strong>Đơn vị vận chuyển</strong> (cùng tab này), nếu không khách sẽ không thấy phương thức.
                </p>
              )}
              <Field label="Hãng vận chuyển" help="“Mọi hãng đã bật” gom dịch vụ của tất cả hãng vào một phương thức.">
                <Select value={form.carrier || '__all'} onValueChange={(v) => up({ carrier: v === '__all' ? '' : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">Mọi hãng đã bật</SelectItem>
                    {enabledCarriers.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.name}
                        {!c.enabled && <span className="ml-1 text-xs text-muted-foreground">(đang tắt)</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Mã dịch vụ" help="Bỏ trống = mọi dịch vụ hãng trả về (nhanh, tiêu chuẩn...). Điền mã để chỉ hiện một dịch vụ, vd GHN: 53320 (tiêu chuẩn).">
                <Input value={form.carrierService} onChange={(e) => up({ carrierService: e.target.value })} placeholder="Mọi dịch vụ" className="font-mono" spellCheck={false} />
              </Field>
              <Field label="Điều chỉnh phí" help="Cộng/trừ vào phí hãng báo trước khi hiện cho khách (số âm = giảm, vd shop bù một phần phí).">
                <div className="flex gap-2">
                  <Select value={form.feeAdjustType} onValueChange={(v) => up({ feeAdjustType: v as FeeAdjust['type'] })}>
                    <SelectTrigger className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Số tiền</SelectItem>
                      <SelectItem value="percent">Phần trăm</SelectItem>
                    </SelectContent>
                  </Select>
                  {form.feeAdjustType === 'percent' ? (
                    <NumberInput value={form.feeAdjustValue} onChange={(feeAdjustValue) => up({ feeAdjustValue })} suffix="%" placeholder="0" className="flex-1" />
                  ) : (
                    <MoneyInput value={form.feeAdjustValue} onChange={(feeAdjustValue) => up({ feeAdjustValue })} placeholder="0" className="flex-1" />
                  )}
                </div>
              </Field>
              <Field label="Phí dự phòng khi API lỗi" help="Hãng không phản hồi / lỗi thì hiện mức phí này để khách vẫn đặt được. Bỏ trống = ẩn phương thức khi lỗi.">
                <MoneyInput value={form.fallbackCost} onChange={(fallbackCost) => up({ fallbackCost })} placeholder="Ẩn khi lỗi" />
              </Field>
            </>
          )}
          {hasTable && (
            <div className="space-y-2 sm:col-span-2">
              <Label>{form.type === 'WEIGHT' ? 'Bảng phí theo cân nặng (gram)' : 'Bảng phí theo giá trị đơn'}</Label>
              <p className="text-xs text-muted-foreground">
                Mỗi dòng: {form.type === 'WEIGHT' ? 'tổng cân nặng' : 'tạm tính'} <strong>đến</strong> ngưỡng → phí. Để trống ngưỡng cho dòng cuối = “phần còn lại”.
                {form.type === 'WEIGHT' && ' Cân nặng sản phẩm nhập theo kg trong trang sản phẩm (1 kg = 1000 g).'}
              </p>
              <div className="space-y-2">
                {form.rules.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">Đến</span>
                    {form.type === 'WEIGHT' ? (
                      <NumberInput value={r.upTo} onChange={(upTo) => setRule(i, { upTo })} min={0} suffix={unit} placeholder="còn lại" className="flex-1" />
                    ) : (
                      <MoneyInput value={r.upTo} onChange={(upTo) => setRule(i, { upTo })} placeholder="còn lại" className="flex-1" />
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">→ phí</span>
                    <MoneyInput value={r.cost} onChange={(cost) => setRule(i, { cost })} className="flex-1" />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Xoá dòng" disabled={form.rules.length <= 1} onClick={() => up({ rules: form.rules.filter((_, j) => j !== i) })}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => up({ rules: [...form.rules, { upTo: null, cost: null }] })}>
                <Plus /> Thêm mức
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
            <div>
              <Label>Kích hoạt</Label>
              <p className="text-xs text-muted-foreground">Tắt để tạm ẩn phương thức này khỏi trang thanh toán</p>
            </div>
            <Switch checked={form.isActive} onCheckedChange={(isActive) => up({ isActive })} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="method-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
