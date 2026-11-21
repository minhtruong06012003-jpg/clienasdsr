'use client';

/**
 * Cài đặt > Vận chuyển > Đơn vị vận chuyển (nhóm cài đặt `shipping`):
 * - môi trường sandbox/production;
 * - từng hãng: bật/tắt, form field động theo meta, kiểm tra kết nối, URL webhook, đồng bộ danh mục địa chỉ;
 * - kho lấy hàng (chọn tỉnh → quận → phường từ danh mục đã đồng bộ);
 * - kiện hàng mặc định, COD, bảo hiểm, xem hàng, tự tạo vận đơn, đồng bộ trạng thái, cache phí, làm tròn, webhook secret.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, ExternalLink, Eye, EyeOff, Info, Loader2, MapPinned, PlugZap, RefreshCw, Wand2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Field, Section } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '@/components/commerce/number-input';
import { copyText, INSPECTION_OPTIONS, useCarriers, type CarrierEnvironment, type CarrierField, type CarrierMeta, type LocationRow, type LocationStats } from '@/components/commerce/shipments';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SwitchRow } from './inputs';
import { SettingsGroup, type SetValues, type Values } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

const AUTO_CREATE_OPTIONS = [
  { value: 'manual', label: 'Không tự động', desc: 'Nhân viên bấm “Tạo vận đơn” trong chi tiết đơn hàng' },
  { value: 'confirmed', label: 'Khi đơn được xác nhận', desc: 'Tạo vận đơn theo hãng/dịch vụ khách đã chọn ngay khi đơn chuyển “Đã xác nhận”' },
  { value: 'paid', label: 'Khi đơn đã thanh toán', desc: 'Chỉ tạo sau khi nhận được tiền (đơn COD vẫn cần tạo tay hoặc chọn “Khi xác nhận”)' },
];

const FEE_ROUNDING_OPTIONS = [
  { value: 0, label: 'Không làm tròn' },
  { value: 100, label: 'Làm tròn trăm (100₫)' },
  { value: 500, label: 'Làm tròn 500₫' },
  { value: 1000, label: 'Làm tròn nghìn (1.000₫)' },
];

/** Thống kê danh mục địa chỉ đã đồng bộ */
function useLocationStats() {
  return useQuery({ queryKey: ['shipping-location-stats'], queryFn: () => api.get<LocationStats>('/admin/shipping/locations/stats'), staleTime: 60_000 });
}

/** Ô nhập cho một field cấu hình hãng (theo meta.fields) */
function CarrierFieldInput({ field, value, onChange, disabled }: { field: CarrierField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [show, setShow] = useState(false);
  const str = value == null ? '' : String(value);
  switch (field.type) {
    case 'boolean':
      return (
        <label className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3', disabled && 'cursor-not-allowed opacity-60')}>
          <span className="text-sm">
            <span className="font-medium">{field.label}</span>
            {field.help && <span className="block text-xs text-muted-foreground">{field.help}</span>}
          </span>
          <Switch checked={value == null ? !!field.default : !!value} onCheckedChange={onChange} disabled={disabled} />
        </label>
      );
    case 'select':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <Select value={str || String(field.default ?? '')} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={field.placeholder ?? 'Chọn...'} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );
    case 'textarea':
      return (
        <Field label={field.label} required={field.required} help={field.help} className="sm:col-span-2">
          <Textarea value={str} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} rows={4} className="font-mono text-xs" spellCheck={false} disabled={disabled} />
        </Field>
      );
    case 'password':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <div className="relative">
            <Input type={show ? 'text' : 'password'} value={str} onChange={(e) => onChange(e.target.value.trim())} placeholder={field.placeholder} autoComplete="new-password" spellCheck={false} className="pr-9 font-mono text-sm" disabled={disabled} />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ẩn' : 'Hiện'}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
      );
    case 'number':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <Input type="number" value={str} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} placeholder={field.placeholder ?? (field.default != null ? String(field.default) : undefined)} disabled={disabled} />
        </Field>
      );
    default:
      return (
        <Field label={field.label} required={field.required} help={field.help} className={field.type === 'url' ? 'sm:col-span-2' : undefined}>
          <Input type={field.type === 'url' ? 'url' : 'text'} value={str} onChange={(e) => onChange(e.target.value.trim())} placeholder={field.placeholder ?? (field.default != null ? String(field.default) : undefined)} autoComplete="off" spellCheck={false} className="font-mono text-sm" disabled={disabled} />
        </Field>
      );
  }
}

/** Dòng "khả năng" của hãng dạng chip nhỏ */
function CapabilityChips({ meta }: { meta: CarrierMeta }) {
  const c = meta.capabilities;
  const chips = [
    c.rates && 'Báo giá',
    c.create && 'Tạo đơn',
    c.track && 'Tra cứu',
    c.cancel && 'Huỷ',
    c.label && 'In nhãn',
    c.webhook && 'Webhook',
    c.locations && 'Danh mục địa chỉ',
    meta.addressLevels === 2 && 'Địa chỉ 2 cấp',
  ].filter(Boolean) as string[];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((x) => (
        <Badge key={x} variant="outline" className="font-normal text-muted-foreground">
          {x}
        </Badge>
      ))}
    </div>
  );
}

/** Thẻ cấu hình một hãng: bật/tắt, form, kiểm tra kết nối, webhook, đồng bộ địa chỉ */
function CarrierCard({
  meta,
  environment,
  config,
  onChange,
  webhookBase,
  webhookSecret,
  locStats,
  canEdit,
}: {
  meta: CarrierMeta;
  environment: CarrierEnvironment;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  webhookBase: string;
  webhookSecret: string;
  locStats: LocationStats | undefined;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const enabled = !!config.enabled;
  const [open, setOpen] = useState(enabled);
  // lọc field theo môi trường (field có env chỉ hiện ở môi trường đó)
  const fields = meta.fields.filter((f) => !f.env || f.env === environment);
  const missing = fields.filter((f) => f.required && (config[f.key] == null || config[f.key] === ''));

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; details?: Record<string, unknown> }>('/admin/shipping/carriers/test', { carrier: meta.key, config: { ...config, environment }, environment }),
    onSuccess: (r) => (r.ok ? toast.success(r.message || 'Kết nối thành công') : toast.error(r.message || 'Kết nối thất bại')),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ queued: boolean }>('/admin/shipping/locations/sync', { carrier: meta.key }),
    onSuccess: () => {
      toast.success(`Đã xếp hàng đồng bộ danh mục địa chỉ ${meta.name}. Chạy nền vài phút — sẽ có thông báo ở chuông khi xong.`);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['shipping-location-stats'] }), 15_000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const result = test.data;
  const webhookUrl = `${webhookBase}/${meta.key}${webhookSecret ? `?key=${encodeURIComponent(webhookSecret)}` : ''}`;
  const synced = locStats?.carriers.includes(meta.key);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-xl border bg-card', !enabled && 'opacity-80')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        {meta.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.logo} alt="" className="size-9 shrink-0 rounded-md border bg-white object-contain p-1" />
        ) : (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase text-muted-foreground">{meta.key.slice(0, 3)}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CollapsibleTrigger className="text-left font-semibold hover:text-primary">{meta.name}</CollapsibleTrigger>
            {enabled && missing.length === 0 && (
              <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <CheckCircle2 /> Sẵn sàng
              </Badge>
            )}
            {enabled && missing.length > 0 && (
              <Badge className="border-transparent bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                <AlertTriangle /> Thiếu {missing.length} thông tin
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            disabled={!canEdit}
            onCheckedChange={(v) => {
              onChange({ ...config, enabled: v });
              if (v) setOpen(true);
            }}
            aria-label={`Bật/tắt ${meta.name}`}
          />
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Mở rộng">
              <ChevronDown className={cn('transition', open && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
        </div>
      </div>

      <CollapsibleContent>
        <div className="space-y-4 border-t px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CapabilityChips meta={meta} />
            <div className="flex items-center gap-3 text-xs">
              {meta.website && (
                <a href={meta.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Website <ExternalLink className="size-3" />
                </a>
              )}
              {meta.docsUrl && (
                <a href={meta.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Tài liệu API <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>

          {meta.notes && meta.notes.length > 0 && (
            <ul className="space-y-1 rounded-lg border bg-muted/40 p-3 text-xs">
              {meta.notes.map((n, i) => (
                <li key={i} className="flex gap-1.5">
                  <Info className="mt-0.5 size-3 shrink-0 text-sky-600 dark:text-sky-400" />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}

          {fields.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => (
                <CarrierFieldInput key={f.key} field={f} value={config[f.key]} onChange={(v) => onChange({ ...config, [f.key]: v })} disabled={!canEdit} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Hãng này không cần cấu hình thêm.</p>
          )}
          {missing.length > 0 && enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Chưa điền: {missing.map((f) => f.label).join(', ')} — hãng sẽ không báo giá / tạo vận đơn được cho tới khi điền đủ.</p>}

          {(meta.capabilities.testConnection || meta.capabilities.locations) && (
            <div className="flex flex-wrap items-center gap-3">
              {meta.capabilities.testConnection && canEdit && (
                <Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Kiểm tra kết nối
                </Button>
              )}
              {meta.capabilities.locations && canEdit && (
                <Button type="button" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()} title="Tải danh mục tỉnh / quận / phường của hãng để ánh xạ địa chỉ">
                  {sync.isPending ? <Loader2 className="animate-spin" /> : <MapPinned />} {synced ? 'Đồng bộ lại địa chỉ' : 'Đồng bộ địa chỉ'}
                </Button>
              )}
              {result && (
                <span className={cn('inline-flex items-center gap-1 text-xs', result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                  {result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {result.message}
                </span>
              )}
              {meta.capabilities.testConnection && !result && <span className="text-xs text-muted-foreground">Kiểm tra dùng cấu hình đang nhập (chưa cần lưu).</span>}
            </div>
          )}
          {meta.capabilities.locations && (
            <p className="text-xs text-muted-foreground">
              {synced ? (
                <>
                  Đã có mã địa chỉ của {meta.name} trong danh mục ({locStats?.provinces ?? 0} tỉnh · {locStats?.districts ?? 0} quận/huyện · {locStats?.wards ?? 0} phường/xã
                  {locStats?.updatedAt ? `, cập nhật ${timeAgo(locStats.updatedAt)}` : ''}).
                </>
              ) : (
                <>Chưa đồng bộ danh mục địa chỉ của {meta.name} — cần đồng bộ để ánh xạ tỉnh/quận/phường của khách sang mã hãng khi báo giá và tạo vận đơn.</>
              )}
            </p>
          )}
          {result?.ok && result.details && Object.keys(result.details).length > 0 && <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(result.details, null, 2)}</pre>}

          {meta.capabilities.webhook && (
            <Field label="URL webhook" help={webhookSecret ? `Dán URL này vào cài đặt webhook trên cổng ${meta.name} để hệ thống nhận cập nhật trạng thái tự động.` : 'Hãy tạo “Chuỗi bí mật webhook” ở phần Tự động hoá bên dưới rồi lưu, URL sẽ kèm ?key= để chống giả mạo.'}>
              <div className="flex items-stretch overflow-hidden rounded-lg border">
                <Input readOnly value={webhookUrl} className="rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="ghost" size="sm" className="rounded-none border-l" onClick={() => copyText(webhookUrl, 'Đã sao chép URL webhook')} aria-label="Sao chép URL webhook">
                  <Copy />
                </Button>
              </div>
            </Field>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Kho lấy hàng: chọn tỉnh → quận → phường từ danh mục đã đồng bộ
// ---------------------------------------------------------------------------

interface PickupAddress {
  name?: string;
  phone?: string;
  email?: string;
  line1?: string;
  provinceCode?: string;
  provinceName?: string;
  districtCode?: string;
  districtName?: string;
  wardCode?: string;
  wardName?: string;
}

/** Danh sách con của một mã địa chỉ (parent trống = tỉnh) */
function useLocations(parent: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['shipping-locations', parent ?? ''],
    queryFn: () => api.get<LocationRow[]>('/admin/shipping/locations', { parent: parent || undefined }),
    staleTime: 10 * 60_000,
    enabled,
  });
}

/** Select địa chỉ một cấp */
function LocationSelect({ label, value, rows, loading, onChange, disabled, placeholder }: { label: string; value: string; rows: LocationRow[] | undefined; loading: boolean; onChange: (row: LocationRow | null) => void; disabled?: boolean; placeholder: string }) {
  return (
    <Field label={label}>
      <Select value={value || '__none'} onValueChange={(v) => onChange(v === '__none' ? null : rows?.find((r) => r.code === v) ?? null)} disabled={disabled || loading}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={loading ? 'Đang tải...' : placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">
            <span className="text-muted-foreground">{placeholder}</span>
          </SelectItem>
          {rows?.map((r) => (
            <SelectItem key={r.code} value={r.code}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function PickupForm({ value, onChange, canEdit, hasLocations }: { value: PickupAddress; onChange: (v: PickupAddress) => void; canEdit: boolean; hasLocations: boolean }) {
  // nhập tay tên tỉnh/quận/phường khi chưa đồng bộ danh mục (hoặc người dùng muốn)
  const [manual, setManual] = useState(!hasLocations);
  useEffect(() => {
    if (!hasLocations) setManual(true);
  }, [hasLocations]);

  const provinces = useLocations(undefined, !manual);
  const provinceChildren = useLocations(value.provinceCode, !manual && !!value.provinceCode);
  // hãng 2 cấp: con của tỉnh là phường (level 3) -> bỏ bước quận
  const childLevel = provinceChildren.data?.[0]?.level;
  const twoLevel = childLevel === 3;
  const districts = twoLevel ? undefined : provinceChildren.data;
  const wardsOfDistrict = useLocations(value.districtCode, !manual && !twoLevel && !!value.districtCode);
  const wards = twoLevel ? provinceChildren.data : wardsOfDistrict.data;

  const set = (p: Partial<PickupAddress>) => onChange({ ...value, ...p });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tên kho / người gửi" required>
          <Input value={value.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="VD: Kho Hà Nội — Shop ABC" disabled={!canEdit} />
        </Field>
        <Field label="Số điện thoại" required>
          <Input value={value.phone ?? ''} onChange={(e) => set({ phone: e.target.value.trim() })} placeholder="09xxxxxxxx" inputMode="tel" disabled={!canEdit} />
        </Field>
        <Field label="Địa chỉ (số nhà, đường)" required className="sm:col-span-2">
          <Input value={value.line1 ?? ''} onChange={(e) => set({ line1: e.target.value })} placeholder="VD: 123 Nguyễn Trãi" disabled={!canEdit} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {hasLocations ? 'Chọn từ danh mục địa chỉ đã đồng bộ để hãng nhận đúng mã tỉnh/quận/phường.' : 'Chưa có danh mục địa chỉ — hãy đồng bộ địa chỉ ở một hãng có hỗ trợ (GHN, Viettel Post...) hoặc nhập tên tay.'}
        </p>
        {hasLocations && (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch size="sm" checked={manual} onCheckedChange={setManual} disabled={!canEdit} /> Nhập tay
          </label>
        )}
      </div>

      {manual ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Tỉnh / Thành phố" required>
            <Input value={value.provinceName ?? ''} onChange={(e) => set({ provinceName: e.target.value, provinceCode: '' })} placeholder="Hà Nội" disabled={!canEdit} />
          </Field>
          <Field label="Quận / Huyện">
            <Input value={value.districtName ?? ''} onChange={(e) => set({ districtName: e.target.value, districtCode: '' })} placeholder="Thanh Xuân" disabled={!canEdit} />
          </Field>
          <Field label="Phường / Xã">
            <Input value={value.wardName ?? ''} onChange={(e) => set({ wardName: e.target.value, wardCode: '' })} placeholder="Khương Trung" disabled={!canEdit} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <LocationSelect
            label="Tỉnh / Thành phố"
            placeholder="Chọn tỉnh/thành"
            value={value.provinceCode ?? ''}
            rows={provinces.data}
            loading={provinces.isLoading}
            disabled={!canEdit}
            onChange={(r) => set({ provinceCode: r?.code ?? '', provinceName: r?.name ?? '', districtCode: '', districtName: '', wardCode: '', wardName: '' })}
          />
          {!twoLevel && (
            <LocationSelect
              label="Quận / Huyện"
              placeholder={value.provinceCode ? 'Chọn quận/huyện' : 'Chọn tỉnh trước'}
              value={value.districtCode ?? ''}
              rows={districts}
              loading={provinceChildren.isLoading}
              disabled={!canEdit || !value.provinceCode}
              onChange={(r) => set({ districtCode: r?.code ?? '', districtName: r?.name ?? '', wardCode: '', wardName: '' })}
            />
          )}
          <LocationSelect
            label="Phường / Xã"
            placeholder={twoLevel ? (value.provinceCode ? 'Chọn phường/xã' : 'Chọn tỉnh trước') : value.districtCode ? 'Chọn phường/xã' : 'Chọn quận trước'}
            value={value.wardCode ?? ''}
            rows={wards}
            loading={twoLevel ? provinceChildren.isLoading : wardsOfDistrict.isLoading}
            disabled={!canEdit || (twoLevel ? !value.provinceCode : !value.districtCode)}
            onChange={(r) => set({ wardCode: r?.code ?? '', wardName: r?.name ?? '' })}
          />
        </div>
      )}
      {(value.provinceName || value.districtName || value.wardName) && (
        <p className="text-xs text-muted-foreground">
          Địa chỉ gửi hãng: <span className="text-foreground">{[value.line1, value.wardName, value.districtName, value.provinceName].filter(Boolean).join(', ')}</span>
        </p>
      )}
      <Field label="Email liên hệ (tuỳ chọn)">
        <Input type="email" value={value.email ?? ''} onChange={(e) => set({ email: e.target.value.trim() })} placeholder="kho@shop.vn" disabled={!canEdit} className="sm:max-w-sm" />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Khối cài đặt chính
// ---------------------------------------------------------------------------

/** Tạo chuỗi bí mật ngẫu nhiên (hex 32 ký tự) */
function randomSecret() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function CarriersSettingsBody({ v, set }: { v: Values; set: SetValues }) {
  const { can } = useAuth();
  const canEdit = can('settings.shipping');
  const carriers = useCarriers();
  const locStats = useLocationStats();
  const environment: CarrierEnvironment = v.environment === 'production' ? 'production' : 'sandbox';
  const configs = (v.carriers as Record<string, Record<string, unknown>>) ?? {};
  const pickup = (v.pickup as PickupAddress) ?? {};
  const webhookSecret: string = v.webhookSecret ?? '';
  const enabledCount = Object.values(configs).filter((c) => c?.enabled).length;
  const hasLocations = (locStats.data?.provinces ?? 0) > 0;

  return (
    <>
      <Section title="Đơn vị vận chuyển" description="Kết nối API các hãng để báo giá phí ship theo địa chỉ khách, tạo vận đơn, in nhãn và theo dõi hành trình. Bật hãng rồi điền thông tin do hãng cấp; thử ở môi trường thử nghiệm trước.">
        <div className="grid gap-4 md:grid-cols-[240px_1fr] md:items-start">
          <Field label="Môi trường" help={environment === 'production' ? 'Vận đơn tạo ra là thật, có tính phí với hãng.' : 'Dùng tài khoản test của hãng; vận đơn không được giao thật.'}>
            <Select value={environment} onValueChange={(environment) => set({ environment })} disabled={!canEdit}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">Thử nghiệm (sandbox)</SelectItem>
                <SelectItem value="production">Chính thức (production)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p>
              Đang bật <strong className="text-foreground">{enabledCount}</strong> / {carriers.data?.carriers.length ?? 0} hãng. Khách sẽ thấy các dịch vụ của hãng đã bật khi vùng vận chuyển có phương thức loại <strong className="text-foreground">“Lấy phí từ hãng vận chuyển”</strong>.
            </p>
            {environment === 'production' && enabledCount > 0 && <p className="mt-1 text-amber-600 dark:text-amber-400">Môi trường chính thức: tạo vận đơn sẽ phát sinh phí thật với hãng.</p>}
          </div>
        </div>

        {carriers.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : carriers.error ? (
          <p className="text-sm text-destructive">Không tải được danh sách hãng: {errorMessage(carriers.error)}</p>
        ) : (
          <div className="space-y-3">
            {carriers.data?.carriers.map((meta) => (
              <CarrierCard
                key={meta.key}
                meta={meta}
                environment={environment}
                config={configs[meta.key] ?? {}}
                onChange={(c) => set({ carriers: { ...configs, [meta.key]: c } })}
                webhookBase={carriers.data?.webhookBase ?? ''}
                webhookSecret={webhookSecret}
                locStats={locStats.data}
                canEdit={canEdit}
              />
            ))}
          </div>
        )}

        {/* thống kê danh mục địa chỉ dùng chung */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <MapPinned className="size-3.5" />
          {locStats.data && hasLocations ? (
            <span>
              Danh mục địa chỉ: {locStats.data.provinces} tỉnh/thành · {locStats.data.districts} quận/huyện · {locStats.data.wards} phường/xã
              {locStats.data.updatedAt && ` · cập nhật ${formatDate(locStats.data.updatedAt)}`}
              {locStats.data.carriers.length > 0 && ` · mã hãng: ${locStats.data.carriers.join(', ')}`}
            </span>
          ) : (
            <span>Chưa có danh mục địa chỉ. Bấm “Đồng bộ địa chỉ” ở hãng có hỗ trợ để tải tỉnh/quận/phường.</span>
          )}
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Tải lại thống kê" onClick={() => void locStats.refetch()}>
            <RefreshCw className={cn(locStats.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </Section>

      <Section title="Kho lấy hàng" description="Địa chỉ shipper tới lấy hàng, in trên nhãn là người gửi. Hãng tính phí theo khoảng cách từ đây tới người nhận.">
        <PickupForm value={pickup} onChange={(pickup) => set({ pickup })} canEdit={canEdit} hasLocations={hasLocations} />
      </Section>

      <Section title="Kiện hàng & tuỳ chọn giao" description="Áp dụng khi sản phẩm chưa khai cân nặng / kích thước, và làm mặc định cho mỗi vận đơn (có thể sửa khi tạo).">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Cân nặng mặc định" help="Mỗi sản phẩm chưa khai cân nặng">
            <NumberInput value={v.defaultWeight ?? null} onChange={(defaultWeight) => set({ defaultWeight: defaultWeight ?? 500 })} min={1} integer suffix="g" disabled={!canEdit} />
          </Field>
          <Field label="Dài">
            <NumberInput value={v.defaultLength ?? null} onChange={(defaultLength) => set({ defaultLength: defaultLength ?? 20 })} min={1} integer suffix="cm" disabled={!canEdit} />
          </Field>
          <Field label="Rộng">
            <NumberInput value={v.defaultWidth ?? null} onChange={(defaultWidth) => set({ defaultWidth: defaultWidth ?? 15 })} min={1} integer suffix="cm" disabled={!canEdit} />
          </Field>
          <Field label="Cao">
            <NumberInput value={v.defaultHeight ?? null} onChange={(defaultHeight) => set({ defaultHeight: defaultHeight ?? 10 })} min={1} integer suffix="cm" disabled={!canEdit} />
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <SwitchRow label="Thu hộ COD khi đơn chưa thanh toán" description="Đơn COD chưa trả tiền: hãng thu đủ tổng đơn từ khách rồi chuyển lại shop. Tắt nếu bạn tự thu." checked={v.codForUnpaid !== false} onChange={(codForUnpaid) => set({ codForUnpaid })} disabled={!canEdit} />
          <SwitchRow label="Khai giá / bảo hiểm theo giá trị đơn" description="Gửi giá trị hàng cho hãng để được bồi thường khi mất / hỏng (hãng có thể thu thêm phí bảo hiểm)." checked={v.insureByOrderValue !== false} onChange={(insureByOrderValue) => set({ insureByOrderValue })} disabled={!canEdit} />
        </div>
        <Field label="Cho khách xem hàng khi nhận">
          <div className="grid gap-2 md:grid-cols-3">
            {INSPECTION_OPTIONS.map((o) => {
              const active = (v.allowInspection ?? 'allow') === o.value;
              return (
                <button key={o.value} type="button" disabled={!canEdit} onClick={() => set({ allowInspection: o.value })} className={cn('rounded-lg border p-3 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed', active && 'border-primary bg-primary/5 ring-1 ring-primary')}>
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.desc}</span>
                </button>
              );
            })}
          </div>
        </Field>
      </Section>

      <Section title="Tự động hoá & webhook" description="Tự tạo vận đơn, đồng bộ trạng thái đơn hàng theo hành trình, cache báo giá và bảo mật webhook.">
        <Field label="Tự tạo vận đơn">
          <div className="grid gap-2 md:grid-cols-3">
            {AUTO_CREATE_OPTIONS.map((o) => {
              const active = (v.autoCreateShipment ?? 'manual') === o.value;
              return (
                <button key={o.value} type="button" disabled={!canEdit} onClick={() => set({ autoCreateShipment: o.value })} className={cn('rounded-lg border p-3 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed', active && 'border-primary bg-primary/5 ring-1 ring-primary')}>
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.desc}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <SwitchRow label="Đồng bộ trạng thái đơn hàng theo vận đơn" description="Hãng báo “Đang giao” → đơn chuyển Đang giao; “Đã giao” → Hoàn thành; hoàn hàng → ghi lịch sử. Tắt nếu muốn tự chuyển trạng thái tay." checked={v.syncOrderStatus !== false} onChange={(syncOrderStatus) => set({ syncOrderStatus })} disabled={!canEdit} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cache báo giá" help="Phí hãng trả về được lưu tạm để trang thanh toán không gọi API liên tục. 0 = luôn hỏi hãng.">
            <NumberInput value={v.rateCacheMinutes ?? null} onChange={(rateCacheMinutes) => set({ rateCacheMinutes: rateCacheMinutes ?? 0 })} min={0} integer suffix="phút" disabled={!canEdit} />
          </Field>
          <Field label="Làm tròn phí hiện cho khách" help="Phí hãng thường lẻ (vd 31.350₫); làm tròn lên cho đẹp. Phí trả hãng vẫn theo thực tế.">
            <Select value={String(v.feeRounding ?? 0)} onValueChange={(feeRounding) => set({ feeRounding: Number(feeRounding) })} disabled={!canEdit}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEE_ROUNDING_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field
          label="Chuỗi bí mật webhook"
          help="Bắt buộc để nhận webhook: thêm vào URL webhook (?key=...) để hệ thống từ chối các gọi giả mạo. Đổi chuỗi này thì phải cập nhật lại URL webhook trên cổng của từng hãng."
          action={
            canEdit && (
              <Button type="button" variant="ghost" size="xs" onClick={() => set({ webhookSecret: randomSecret() })}>
                <Wand2 /> Tạo ngẫu nhiên
              </Button>
            )
          }
        >
          <Input value={webhookSecret} onChange={(e) => set({ webhookSecret: e.target.value.trim() })} placeholder="Bắt buộc — để trống thì mọi webhook của hãng bị từ chối" className="font-mono text-sm" spellCheck={false} autoComplete="off" disabled={!canEdit} />
        </Field>
      </Section>
    </>
  );
}

/** Khối cài đặt đơn vị vận chuyển (SettingsGroup riêng, nhúng vào tab Vận chuyển) */
export function ShippingCarriersSettings({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="shipping" onDirtyChange={onDirtyChange}>
      {(v, set) => <CarriersSettingsBody v={v} set={set} />}
    </SettingsGroup>
  );
}
