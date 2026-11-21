'use client';

/**
 * Thành phần dùng chung cho module Vận đơn / đơn vị vận chuyển:
 * kiểu dữ liệu (khớp API /admin/shipments, /admin/shipping/carriers), nhãn & badge trạng thái,
 * hook tải meta hãng, mở nhãn in (PDF hoặc URL hãng) kèm token.
 */

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Address } from './utils';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu — hãng vận chuyển (GET /admin/shipping/carriers)
// ---------------------------------------------------------------------------

export type CarrierEnvironment = 'sandbox' | 'production';

export interface CarrierField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select' | 'boolean' | 'number' | 'textarea';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: unknown;
  /** chỉ hiện ở môi trường này */
  env?: CarrierEnvironment;
}

export interface CarrierCapabilities {
  rates: boolean;
  services?: boolean;
  leadtime?: boolean;
  create: boolean;
  track: boolean;
  cancel: boolean;
  label: boolean;
  webhook: boolean;
  locations: boolean;
  testConnection: boolean;
}

export interface CarrierMeta {
  key: string;
  name: string;
  description: string;
  website?: string;
  docsUrl?: string;
  logo?: string;
  fields: CarrierField[];
  capabilities: CarrierCapabilities;
  /** 3 = tỉnh/quận/phường, 2 = tỉnh/phường (sau sáp nhập) */
  addressLevels?: 2 | 3;
  notes?: string[];
  /** đã bật trong cài đặt */
  enabled: boolean;
  /** đã điền đủ field bắt buộc */
  configured: boolean;
  /** nhãn các field bắt buộc còn thiếu */
  missing: string[];
}

export interface CarriersResponse {
  environment: CarrierEnvironment;
  /** gốc URL webhook: `${webhookBase}/${key}?key=${webhookSecret}` */
  webhookBase: string;
  carriers: CarrierMeta[];
}

/** Thống kê danh mục địa chỉ đã đồng bộ (GET /admin/shipping/locations/stats) */
export interface LocationStats {
  provinces: number;
  districts: number;
  wards: number;
  updatedAt: string | null;
  /** hãng đã có mã địa chỉ */
  carriers: string[];
}

/** Một đơn vị địa chỉ (GET /admin/shipping/locations?parent=) */
export interface LocationRow {
  code: string;
  name: string;
  /** 1 tỉnh, 2 quận/huyện, 3 phường/xã */
  level: number;
  parentCode: string | null;
  hasChildren: boolean;
}

// ---------------------------------------------------------------------------
// Kiểu dữ liệu — vận đơn (GET /admin/shipments)
// ---------------------------------------------------------------------------

export type ShipmentStatus = 'PENDING' | 'PICKING' | 'PICKED' | 'DELIVERING' | 'DELIVERED' | 'RETURNING' | 'RETURNED' | 'CANCELLED' | 'FAILED';

/** Địa chỉ đã chuẩn hoá gửi hãng (kho lấy hàng / người nhận) */
export interface CarrierAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  provinceCode?: string | null;
  provinceName?: string | null;
  districtCode?: string | null;
  districtName?: string | null;
  wardCode?: string | null;
  wardName?: string | null;
  email?: string | null;
  country?: string | null;
}

export interface ShipmentEvent {
  status: string;
  statusCode?: string | null;
  message?: string | null;
  location?: string | null;
  at: string;
  /** system | carrier | webhook | manual */
  source?: string | null;
}

export interface ShipmentOrderRef {
  id: string;
  code: string;
  customerName: string;
  customerPhone: string;
  total: unknown;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
}

/** Hãng/dịch vụ khách chọn lúc đặt hàng (Order.shippingMeta) */
export interface OrderShippingMeta {
  carrier: string;
  carrierName?: string | null;
  service?: string | null;
  serviceName?: string | null;
  quotedFee?: unknown;
  estimatedDays?: number | null;
  expectedDeliveryAt?: string | null;
}

/** Một dòng vận đơn */
export interface ShipmentRow {
  id: string;
  orderId: string;
  carrier: string;
  carrierName: string;
  service: string;
  serviceName: string | null;
  trackingCode: string | null;
  carrierOrderId: string | null;
  status: ShipmentStatus;
  statusCode: string | null;
  statusMessage: string | null;
  fee: unknown;
  codAmount: unknown;
  insuranceValue: unknown;
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  note: string | null;
  payer: 'shop' | 'customer' | string | null;
  pickup: CarrierAddress | null;
  recipient: CarrierAddress | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  labelPath: string | null;
  expectedDeliveryAt: string | null;
  pickedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  lastSyncAt: string | null;
  errorMessage: string | null;
  events: ShipmentEvent[] | null;
  meta?: unknown;
  createdAt: string;
  updatedAt?: string;
  order: ShipmentOrderRef | null;
}

/** Chi tiết vận đơn (GET /admin/shipments/:id) */
export interface ShipmentDetail extends ShipmentRow {
  capabilities: CarrierCapabilities | null;
  order: (ShipmentOrderRef & { shippingAddress: Address | null; shippingMeta: OrderShippingMeta | null; customerEmail?: string | null }) | null;
}

/** Vận đơn gắn trong chi tiết đơn hàng (GET /admin/orders/:id → shipments) — không có carrierName */
export type OrderShipment = Omit<ShipmentRow, 'carrierName' | 'order'> & { carrierName?: string };

export interface ShipmentStats {
  counts: Partial<Record<ShipmentStatus, number>>;
  /** số vận đơn đang xử lý (chưa giao xong / huỷ) */
  active: number;
}

/** Báo giá một dịch vụ (POST /admin/shipping/rates → quotes[]) */
export interface RateQuote {
  carrier: string;
  serviceCode: string;
  serviceName: string;
  fee: number;
  breakdown?: { base?: number; insurance?: number; cod?: number; remote?: number; other?: number };
  estimatedDays?: number | null;
  expectedDeliveryAt?: string | null;
}

export interface RatesResponse {
  quotes: RateQuote[];
  /** lỗi theo hãng: { ghn: 'Token sai' } */
  errors: Record<string, string>;
  parcel: { weight: number; length: number; width: number; height: number; value: number; codAmount: number; items: { name: string; quantity: number; weight?: number }[] };
  recipient: CarrierAddress;
  existing: OrderShipment[];
}

// ---------------------------------------------------------------------------
// Nhãn & badge
// ---------------------------------------------------------------------------

export const SHIPMENT_STATUSES: { value: ShipmentStatus; label: string; className: string }[] = [
  { value: 'PENDING', label: 'Chờ lấy hàng', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  { value: 'PICKING', label: 'Đang lấy hàng', className: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  { value: 'PICKED', label: 'Đã lấy hàng', className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' },
  { value: 'DELIVERING', label: 'Đang giao', className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
  { value: 'DELIVERED', label: 'Đã giao', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  { value: 'RETURNING', label: 'Đang hoàn', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  { value: 'RETURNED', label: 'Đã hoàn', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  { value: 'CANCELLED', label: 'Đã huỷ', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  { value: 'FAILED', label: 'Lỗi', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
];

export const SHIPMENT_STATUS_LABEL: Record<string, string> = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s.value, s.label]));

/** Trạng thái còn "sống": chưa giao xong / chưa huỷ — đơn đang có vận đơn này thì không tạo thêm */
export const ACTIVE_SHIPMENT_STATUSES: ShipmentStatus[] = ['PENDING', 'PICKING', 'PICKED', 'DELIVERING', 'RETURNING'];
/** Trạng thái cho phép huỷ vận đơn (hãng thường chỉ cho huỷ trước khi giao) */
export const CANCELLABLE_SHIPMENT_STATUSES: ShipmentStatus[] = ['PENDING', 'PICKING', 'PICKED', 'FAILED'];
/** Trạng thái kết thúc — không đồng bộ nữa */
export const FINAL_SHIPMENT_STATUSES: ShipmentStatus[] = ['DELIVERED', 'RETURNED', 'CANCELLED'];

export function ShipmentStatusBadge({ status, className }: { status: string; className?: string }) {
  const m = SHIPMENT_STATUSES.find((s) => s.value === status);
  return <Badge className={cn('border-transparent font-medium', m?.className ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', className)}>{m?.label ?? status}</Badge>;
}

export const PAYER_LABEL: Record<string, string> = { shop: 'Shop trả', customer: 'Người nhận trả' };
export const INSPECTION_OPTIONS: { value: 'allow' | 'deny' | 'try'; label: string; desc: string }[] = [
  { value: 'allow', label: 'Cho xem hàng', desc: 'Khách được mở kiểm tra trước khi nhận' },
  { value: 'deny', label: 'Không cho xem', desc: 'Khách chỉ được nhận, không mở hàng' },
  { value: 'try', label: 'Cho thử hàng', desc: 'Khách được thử (quần áo, giày dép...)' },
];

/** Tên hãng theo key (fallback key) */
export function carrierLabel(key: string | null | undefined, carriers?: CarrierMeta[]) {
  if (!key) return '—';
  return carriers?.find((c) => c.key === key)?.name ?? key;
}

/** Hãng + dịch vụ: "GHN · Nhanh" */
export function carrierServiceText(sh: { carrier: string; carrierName?: string | null; serviceName?: string | null; service?: string | null }, carriers?: CarrierMeta[]) {
  const name = sh.carrierName || carrierLabel(sh.carrier, carriers);
  const svc = sh.serviceName || sh.service;
  return svc ? `${name} · ${svc}` : name;
}

/** Kích thước / cân nặng kiện: "500 g · 20×15×10 cm" */
export function parcelText(p: { weight?: number | null; length?: number | null; width?: number | null; height?: number | null }) {
  const parts: string[] = [];
  if (p.weight) parts.push(p.weight >= 1000 ? `${(p.weight / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kg` : `${p.weight} g`);
  if (p.length && p.width && p.height) parts.push(`${p.length}×${p.width}×${p.height} cm`);
  return parts.join(' · ') || '—';
}

/** Địa chỉ hãng -> một dòng */
export function carrierAddressText(a: CarrierAddress | null | undefined) {
  if (!a) return '';
  return [a.line1, a.line2, a.wardName, a.districtName, a.provinceName].filter(Boolean).join(', ');
}

/** Số ngày dự kiến giao: "2–3 ngày" | "1 ngày" */
export function estimatedDaysText(d: number | null | undefined) {
  if (d == null) return null;
  return d <= 1 ? 'Giao trong ngày / 1 ngày' : `~${d} ngày`;
}

/** Phí + COD ngắn gọn cho danh sách */
export function feeCodText(sh: { fee: unknown; codAmount: unknown }, currency = 'VND') {
  const fee = Number(sh.fee ?? 0) || 0;
  const cod = Number(sh.codAmount ?? 0) || 0;
  return { fee: formatMoney(fee, currency), cod: cod > 0 ? formatMoney(cod, currency) : null };
}

// ---------------------------------------------------------------------------
// Hook & hành động
// ---------------------------------------------------------------------------

/**
 * Meta các hãng vận chuyển (cache 5 phút). API yêu cầu quyền `settings.manage`,
 * nên nơi gọi truyền `enabled = can('settings.manage')`; khi không có meta, UI dùng `carrierName` trong dữ liệu vận đơn.
 */
export function useCarriers(enabled = true) {
  return useQuery({ queryKey: ['shipping-carriers'], queryFn: () => api.get<CarriersResponse>('/admin/shipping/carriers'), staleTime: 5 * 60_000, enabled });
}

/** Vận đơn còn đồng bộ được: chưa kết thúc và hãng có API tra cứu (không rõ meta thì coi hãng API đều tra cứu được, trừ manual) */
export function canTrack(sh: { carrier: string; status: ShipmentStatus }, caps?: CarrierCapabilities | null) {
  if (FINAL_SHIPMENT_STATUSES.includes(sh.status)) return false;
  return caps ? caps.track : sh.carrier !== 'manual';
}

/** Vận đơn có nhãn in được: hãng hỗ trợ nhãn hoặc đã có file/URL nhãn */
export function hasLabel(sh: { labelUrl?: string | null; labelPath?: string | null; carrier: string; trackingCode?: string | null; status?: string }, caps?: CarrierCapabilities | null) {
  if (sh.labelUrl || sh.labelPath) return true;
  if (!caps?.label) return false;
  // chưa có mã vận đơn hoặc đã huỷ / lỗi thì hãng không trả nhãn
  if (!sh.trackingCode) return false;
  return !['CANCELLED', 'FAILED'].includes(sh.status ?? '');
}

/**
 * Mở nhãn / phiếu giao ở tab mới. API trả PDF (fetch blob kèm token) hoặc JSON `{ url }` khi hãng cung cấp link.
 * Mở tab ngay trong sự kiện click để không bị chặn popup.
 */
export async function openShipmentLabel(id: string) {
  const w = window.open('', '_blank');
  try {
    const res = await api.raw(`/admin/shipments/${id}/label`, { inline: 'json' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data as { message?: string } | null)?.message || 'Không tải được nhãn');
    }
    if (!w) throw new Error('Trình duyệt chặn mở tab mới');
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const { url } = (await res.json()) as { url?: string };
      if (!url) throw new Error('Hãng không trả về link nhãn');
      w.location.href = url;
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    w.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    w?.close();
    toast.error(errorMessage(e));
  }
}

/** Sao chép văn bản + toast */
export function copyText(text: string, msg = 'Đã sao chép') {
  void navigator.clipboard.writeText(text).then(() => toast.success(msg)).catch(() => toast.error('Không sao chép được'));
}
