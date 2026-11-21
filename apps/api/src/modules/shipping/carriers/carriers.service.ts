import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service.js';
import type { Order, OrderItem, Prisma, Shipment, ShippingMethod } from '../../../generated/prisma/client.js';
import { SettingsService } from '../../settings/settings.service.js';
import { JobsService } from '../../scheduler/jobs.service.js';
import { HooksService } from '../../hooks/hooks.service.js';
import { STORAGE, type StorageDriver } from '../../media/storage.service.js';
import { pageArgs, paginate } from '../../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../../common/decorators/current-user.decorator.js';
import { VN_PROVINCES } from '../regions.js';
import { CarrierRegistry } from './registry.js';
import { ShippingLocationsService } from './locations.service.js';
import { ShippingCarrierError, type CarrierAddress, type CarrierConfig, type NormalizedShipmentStatus, type Parcel, type RateQuote, type RateRequest, type ShipmentEvent, type ShipmentRef, type ShippingCarrier, type WebhookEvent } from './carrier.interface.js';
import type { CancelShipmentDto, CreateShipmentDto, ManualShipmentDto, ParcelOverrideDto, RateOrderDto, ShipmentQueryDto, TestCarrierDto } from './carriers.dto.js';

/** Cài đặt nhóm `shipping` (settings.defaults.ts) */
export interface ShippingCarrierSettings {
  environment: 'sandbox' | 'production';
  carriers: Record<string, Record<string, unknown> & { enabled?: boolean }>;
  pickup: { name: string; phone: string; line1: string; provinceCode: string; provinceName: string; districtCode: string; districtName: string; wardCode: string; wardName: string; email?: string };
  defaultWeight: number;
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  codForUnpaid: boolean;
  insureByOrderValue: boolean;
  allowInspection: 'allow' | 'deny' | 'try';
  autoCreateShipment: 'manual' | 'confirmed' | 'paid';
  syncOrderStatus: boolean;
  rateCacheMinutes: number;
  feeRounding: number;
  webhookSecret: string;
}

/** Địa chỉ giao hàng lưu trên đơn (Order.shippingAddress) + mã đã chọn ở checkout */
export interface OrderAddress {
  fullName?: string;
  phone?: string;
  line1?: string;
  line2?: string | null;
  ward?: string | null;
  district?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  districtCode?: string | null;
  wardCode?: string | null;
  email?: string | null;
}

/** Đầu vào báo giá từ giỏ hàng (checkout) hoặc đơn hàng */
export interface CarrierQuoteInput {
  to: OrderAddress;
  subtotal: number;
  /** gram */
  weight: number;
  items: { name: string; quantity: number; weight?: number; price?: number; sku?: string | null }[];
  /** phương thức thanh toán của đơn để tính COD */
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  overrides?: ParcelOverrideDto;
  /** chỉ hãng này */
  carrier?: string | null;
  service?: string | null;
}

type Actor = Pick<AuthUser, 'id' | 'name'> | { id: 'system'; name: string };
const SYSTEM: Actor = { id: 'system', name: 'Hệ thống' };
const ACTIVE_STATUSES: Shipment['status'][] = ['PENDING', 'PICKING', 'PICKED', 'DELIVERING', 'RETURNING'];
/** Trường vận đơn trả cho khách */
export const SHIPMENT_CUSTOMER_SELECT = { id: true, carrier: true, serviceName: true, trackingCode: true, trackingUrl: true, status: true, statusMessage: true, expectedDeliveryAt: true, deliveredAt: true, events: true, createdAt: true } as const;

/**
 * Tích hợp đơn vị vận chuyển: báo giá thật ở checkout (có cache), tạo / theo dõi / huỷ vận đơn, in nhãn,
 * nhận webhook, đồng bộ định kỳ, tự tạo vận đơn và cập nhật trạng thái đơn hàng.
 */
@Injectable()
export class ShippingCarriersService implements OnModuleInit {
  private readonly logger = new Logger('ShippingCarriers');
  /** cache báo giá: key -> { at, quotes } */
  private rateCache = new Map<string, { at: number; quotes: RateQuote[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly registry: CarrierRegistry,
    private readonly locations: ShippingLocationsService,
    private readonly jobs: JobsService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  onModuleInit() {
    this.jobs.register<{ shipmentId: string }>('shipment.sync', (p) => this.sync(p.shipmentId, SYSTEM, { viaJob: true }));
    this.jobs.register<{ orderId: string; carrier?: string; service?: string }>('shipment.create', (p) => this.autoCreate(p.orderId, p.carrier, p.service));
    this.jobs.register<{ carrier: string }>('shipping.locations.sync', (p) => this.syncLocations(p.carrier));
  }

  // ---------------------------------------------------------------------------
  // Cài đặt & hãng
  // ---------------------------------------------------------------------------

  async settings(): Promise<ShippingCarrierSettings> {
    const s = await this.settingsService.get<Partial<ShippingCarrierSettings>>('shipping');
    return {
      environment: s.environment === 'production' ? 'production' : 'sandbox',
      carriers: (s.carriers as ShippingCarrierSettings['carriers']) ?? {},
      pickup: { name: '', phone: '', line1: '', provinceCode: '', provinceName: '', districtCode: '', districtName: '', wardCode: '', wardName: '', ...(s.pickup ?? {}) },
      defaultWeight: Number(s.defaultWeight ?? 500) || 500,
      defaultLength: Number(s.defaultLength ?? 20) || 20,
      defaultWidth: Number(s.defaultWidth ?? 15) || 15,
      defaultHeight: Number(s.defaultHeight ?? 10) || 10,
      codForUnpaid: s.codForUnpaid !== false,
      insureByOrderValue: s.insureByOrderValue !== false,
      allowInspection: (s.allowInspection as ShippingCarrierSettings['allowInspection']) ?? 'allow',
      autoCreateShipment: (s.autoCreateShipment as ShippingCarrierSettings['autoCreateShipment']) ?? 'manual',
      syncOrderStatus: s.syncOrderStatus !== false,
      rateCacheMinutes: Number(s.rateCacheMinutes ?? 10),
      feeRounding: Number(s.feeRounding ?? 0) || 0,
      webhookSecret: String(s.webhookSecret ?? ''),
    };
  }

  /** Meta mọi hãng + hãng nào đã bật/cấu hình đủ */
  async carriers() {
    const s = await this.settings();
    const list = this.registry.list().map((meta) => {
      const cfg = this.registry.buildConfig(meta.key, s)!;
      const missing = this.registry.missingFields(meta.key, cfg);
      return { ...meta, enabled: !!s.carriers[meta.key]?.enabled, configured: missing.length === 0, missing };
    });
    return { environment: s.environment, carriers: list, webhookBase: `${process.env.API_PUBLIC_URL ?? ''}/api/public/shipping/webhook` };
  }

  /** Hãng đã bật & đủ cấu hình */
  async enabledCarriers(s?: ShippingCarrierSettings): Promise<{ key: string; carrier: ShippingCarrier; cfg: CarrierConfig }[]> {
    const st = s ?? (await this.settings());
    const out: { key: string; carrier: ShippingCarrier; cfg: CarrierConfig }[] = [];
    for (const [key, raw] of Object.entries(st.carriers)) {
      if (!raw?.enabled) continue;
      const carrier = this.registry.get(key);
      if (!carrier) continue;
      const cfg = this.registry.buildConfig(key, st)!;
      if (this.registry.missingFields(key, cfg).length) continue;
      out.push({ key, carrier, cfg });
    }
    return out;
  }

  private async carrierFor(key: string, s?: ShippingCarrierSettings) {
    const st = s ?? (await this.settings());
    const carrier = this.registry.get(key);
    if (!carrier) throw new BadRequestException(`Hãng vận chuyển "${key}" không tồn tại`);
    const cfg = this.registry.buildConfig(key, st)!;
    const missing = this.registry.missingFields(key, cfg);
    if (missing.length) throw new BadRequestException(`${carrier.meta.name}: thiếu cấu hình ${missing.join(', ')}`);
    return { key, carrier, cfg, settings: st };
  }

  async testConnection(dto: TestCarrierDto) {
    const carrier = this.registry.get(dto.carrier);
    if (!carrier) throw new BadRequestException('Hãng không tồn tại');
    const s = await this.settings();
    const cfg = this.registry.buildConfig(dto.carrier, { environment: dto.environment ?? s.environment, carriers: dto.config ? { [dto.carrier]: dto.config } : s.carriers })!;
    const missing = this.registry.missingFields(dto.carrier, cfg);
    if (missing.length) return { ok: false, message: `Thiếu: ${missing.join(', ')}` };
    try {
      return await carrier.testConnection(cfg);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Đồng bộ danh mục địa chỉ từ hãng (chạy nền) */
  async syncLocations(carrierKey: string) {
    const { carrier, cfg } = await this.carrierFor(carrierKey);
    const counts = await this.locations.syncFromCarrier(carrierKey, carrier, cfg);
    this.logger.log(`Đã đồng bộ địa chỉ từ ${carrier.meta.name}: ${counts.provinces} tỉnh, ${counts.districts} quận/huyện, ${counts.wards} phường/xã`);
    return counts;
  }

  enqueueSyncLocations(carrierKey: string) {
    return this.jobs.enqueue('shipping.locations.sync', { carrier: carrierKey }, { dedupeKey: `shipping.locations.sync:${carrierKey}`, maxAttempts: 1 });
  }

  // ---------------------------------------------------------------------------
  // Dựng địa chỉ & kiện hàng
  // ---------------------------------------------------------------------------

  /** Địa chỉ kho lấy hàng từ cài đặt (đã gắn mã các hãng) */
  async pickupAddress(s?: ShippingCarrierSettings): Promise<CarrierAddress> {
    const st = s ?? (await this.settings());
    const p = st.pickup;
    if (!p.name || !p.phone || !p.line1 || !p.provinceCode) throw new BadRequestException('Chưa khai báo địa chỉ kho lấy hàng (Cài đặt › Vận chuyển › Đơn vị vận chuyển)');
    return this.locations.enrich({ name: p.name, phone: p.phone, line1: p.line1, provinceCode: p.provinceCode, provinceName: p.provinceName, districtCode: p.districtCode || null, districtName: p.districtName || null, wardCode: p.wardCode || null, wardName: p.wardName || null, email: p.email ?? null, country: 'VN' });
  }

  /** Địa chỉ người nhận từ địa chỉ trên đơn / checkout */
  async recipientAddress(a: OrderAddress, fallback?: { name?: string; phone?: string; email?: string | null }): Promise<CarrierAddress> {
    const provinceName = a.city || (a.province ? VN_PROVINCES.find((p) => p.code === a.province)?.name.vi : '') || '';
    return this.locations.enrich({
      name: a.fullName || fallback?.name || '',
      phone: a.phone || fallback?.phone || '',
      line1: a.line1 || '',
      line2: a.line2 ?? null,
      provinceCode: a.province || null,
      provinceName,
      districtCode: a.districtCode || null,
      districtName: a.district || null,
      wardCode: a.wardCode || null,
      wardName: a.ward || null,
      email: a.email ?? fallback?.email ?? null,
      country: a.country || 'VN',
    });
  }

  /** Kiện hàng: cân nặng từ sản phẩm (gram), thiếu thì dùng mặc định; COD khi đơn chưa trả & thanh toán COD */
  buildParcel(input: CarrierQuoteInput, s: ShippingCarrierSettings): Parcel {
    const o = input.overrides ?? {};
    const weight = o.weight ?? (input.weight > 0 ? input.weight : s.defaultWeight);
    const unpaid = !input.paymentStatus || input.paymentStatus === 'UNPAID';
    const cod = o.codAmount ?? (s.codForUnpaid && unpaid && (input.paymentMethod ?? 'cod') === 'cod' ? input.subtotal : 0);
    const value = o.insuranceValue ?? (s.insureByOrderValue ? input.subtotal : 0);
    return {
      weight: Math.max(1, Math.round(weight)),
      length: o.length ?? s.defaultLength,
      width: o.width ?? s.defaultWidth,
      height: o.height ?? s.defaultHeight,
      value: Math.round(value),
      codAmount: Math.round(cod),
      items: input.items.map((it) => ({ name: it.name, quantity: it.quantity, weight: it.weight && it.quantity ? Math.round(it.weight / it.quantity) : undefined, price: it.price, sku: it.sku })),
    };
  }

  // ---------------------------------------------------------------------------
  // Báo giá
  // ---------------------------------------------------------------------------

  /**
   * Báo giá từ các hãng đã bật (song song, có cache theo địa chỉ + kiện). Lỗi 1 hãng không chặn hãng khác.
   * Trả về mảng quote + danh sách lỗi theo hãng (admin xem).
   */
  async quote(input: CarrierQuoteInput): Promise<{ quotes: RateQuote[]; errors: Record<string, string> }> {
    const s = await this.settings();
    const carriers = (await this.enabledCarriers(s)).filter((c) => !input.carrier || c.key === input.carrier);
    const errors: Record<string, string> = {};
    if (!carriers.length) return { quotes: [], errors };
    // chưa chọn tỉnh thì chưa báo giá được
    if (!input.to.province && !input.to.city) return { quotes: [], errors };
    const [from, to] = await Promise.all([this.pickupAddress(s).catch((e) => ((errors._pickup = (e as Error).message), null)), this.recipientAddress(input.to)]);
    if (!from) return { quotes: [], errors };
    const parcel = this.buildParcel(input, s);
    const ttl = Math.max(0, s.rateCacheMinutes) * 60_000;
    const results = await Promise.all(
      carriers.map(async ({ key, carrier, cfg }) => {
        if (!carrier.meta.capabilities.rates) return [];
        const req: RateRequest = { from, to, parcel, service: input.service ?? null };
        const cacheKey = `${key}:${s.environment}:${createHash('sha1').update(JSON.stringify({ to: [to.provinceCode, to.districtCode, to.wardCode, to.districtName, to.wardName], parcel, service: req.service })).digest('hex')}`;
        const hit = this.rateCache.get(cacheKey);
        if (hit && ttl > 0 && Date.now() - hit.at < ttl) return hit.quotes;
        try {
          const quotes = (await carrier.getRates(cfg, req)).map((q) => ({ ...q, carrier: key, fee: this.roundFee(q.fee, s.feeRounding) }));
          if (ttl > 0) this.rateCache.set(cacheKey, { at: Date.now(), quotes });
          if (this.rateCache.size > 2000) this.rateCache.clear();
          return quotes;
        } catch (err) {
          errors[key] = (err as Error).message;
          this.logger.warn(`Báo giá ${key} lỗi: ${(err as Error).message}`);
          return [];
        }
      }),
    );
    return { quotes: results.flat(), errors };
  }

  private roundFee(fee: number, rounding: number) {
    if (!rounding || rounding <= 1) return Math.round(fee);
    return Math.ceil(fee / rounding) * rounding;
  }

  /** Áp điều chỉnh phí của phương thức CARRIER ({ type, value }) */
  applyFeeAdjust(fee: number, m: Pick<ShippingMethod, 'feeAdjust'>): number {
    const adj = m.feeAdjust as { type?: string; value?: number } | null;
    if (!adj || !adj.value) return fee;
    const v = Number(adj.value) || 0;
    return Math.max(0, Math.round(adj.type === 'percent' ? fee * (1 + v / 100) : fee + v));
  }

  /** Báo giá cho một đơn hàng đã có (admin chọn hãng/dịch vụ trước khi tạo vận đơn) */
  async quoteOrder(dto: RateOrderDto) {
    const order = await this.loadOrder(dto.orderId);
    const input = this.inputFromOrder(order, dto);
    input.carrier = dto.carrier ?? null;
    const res = await this.quote(input);
    const s = await this.settings();
    return { ...res, parcel: this.buildParcel(input, s), recipient: await this.recipientAddress(input.to), existing: await this.prisma.shipment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } }) };
  }

  private inputFromOrder(order: Order & { items: OrderItem[] }, overrides?: ParcelOverrideDto): CarrierQuoteInput {
    const addr = (order.shippingAddress ?? {}) as OrderAddress;
    return {
      to: { ...addr, email: order.customerEmail },
      subtotal: Number(order.subtotal) - Number(order.discountTotal) + Number(order.taxTotal),
      weight: 0,
      items: order.items.map((it) => ({ name: it.name, quantity: it.quantity, price: Number(it.price), sku: it.sku })),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Vận đơn
  // ---------------------------------------------------------------------------

  private async loadOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: { select: { weight: true, length: true, width: true, height: true } }, variant: { select: { weight: true } } } } } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return order;
  }

  /** Tổng cân nặng (gram) của đơn từ sản phẩm */
  private orderWeight(order: Awaited<ReturnType<ShippingCarriersService['loadOrder']>>): number {
    return order.items.reduce((s, it) => s + Number(it.variant?.weight ?? it.product?.weight ?? 0) * 1000 * it.quantity, 0);
  }

  /** Tạo vận đơn cho đơn hàng qua API hãng */
  async create(dto: CreateShipmentDto, actor: Actor) {
    const order = await this.loadOrder(dto.orderId);
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) throw new BadRequestException('Đơn đã huỷ / hoàn tiền, không tạo vận đơn');
    const active = await this.prisma.shipment.findFirst({ where: { orderId: order.id, status: { in: ACTIVE_STATUSES } }, select: { id: true, trackingCode: true } });
    if (active) throw new BadRequestException(`Đơn đã có vận đơn đang hoạt động${active.trackingCode ? ` (${active.trackingCode})` : ''}. Huỷ vận đơn cũ trước.`);
    const s = await this.settings();
    const { carrier, cfg } = await this.carrierFor(dto.carrier, s);
    const input = this.inputFromOrder(order, dto);
    input.weight = this.orderWeight(order);
    const [from, to] = await Promise.all([this.pickupAddress(s), this.recipientAddress(input.to, { name: order.customerName, phone: order.customerPhone, email: order.customerEmail })]);
    if (!to.phone || !to.line1) throw new BadRequestException('Địa chỉ giao hàng thiếu số điện thoại hoặc địa chỉ');
    const parcel = this.buildParcel(input, s);
    // tạo bản ghi trước để có id gửi hãng (idempotent)
    const shipment = await this.prisma.shipment.create({
      data: {
        orderId: order.id,
        carrier: dto.carrier,
        service: dto.service,
        status: 'PENDING',
        fee: 0,
        codAmount: parcel.codAmount,
        insuranceValue: parcel.value,
        weight: parcel.weight,
        length: parcel.length,
        width: parcel.width,
        height: parcel.height,
        note: dto.note ?? null,
        payer: dto.payer ?? 'shop',
        pickup: from as unknown as Prisma.InputJsonValue,
        recipient: to as unknown as Prisma.InputJsonValue,
        createdById: actor.id === 'system' ? null : actor.id,
        events: [{ status: 'PENDING', message: `Tạo vận đơn bởi ${actor.name}`, at: new Date().toISOString(), source: 'system' }] as unknown as Prisma.InputJsonValue,
      },
    });
    try {
      const req = { from, to, parcel, service: dto.service, orderCode: order.code, note: dto.note ?? order.note ?? null, allowInspection: dto.allowInspection ?? s.allowInspection, pickupMode: dto.pickupMode ?? 'pickup', pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : null, payer: dto.payer ?? 'shop', shipmentId: shipment.id };
      const filtered = await this.hooks.applyFilters('shipment.beforeCreate', req, order);
      const res = dto.trackingCode && dto.carrier === 'manual' ? { trackingCode: dto.trackingCode, fee: 0, status: 'PENDING' as const, raw: { manual: true } } : await carrier.createShipment(cfg, filtered);
      const ref: ShipmentRef = { id: shipment.id, trackingCode: res.trackingCode, carrierOrderId: res.carrierOrderId };
      const trackingUrl = res.trackingUrl ?? carrier.trackingUrl?.(cfg, ref) ?? null;
      const updated = await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          trackingCode: dto.trackingCode ?? res.trackingCode ?? null,
          carrierOrderId: res.carrierOrderId ?? null,
          serviceName: res.serviceName ?? null,
          fee: res.fee ?? 0,
          status: res.status ?? 'PENDING',
          expectedDeliveryAt: res.expectedDeliveryAt ?? null,
          labelUrl: res.labelUrl ?? null,
          trackingUrl,
          meta: { createResult: this.safeJson(res.raw) } as Prisma.InputJsonValue,
          events: [...(shipment.events as object[]), { status: res.status ?? 'PENDING', message: res.trackingCode ? `Hãng đã nhận, mã vận đơn ${res.trackingCode}` : 'Đã tạo, chờ mã vận đơn', at: new Date().toISOString(), source: 'system' }] as unknown as Prisma.InputJsonValue,
        },
      });
      await this.afterCreated(updated, order, actor);
      return this.get(shipment.id);
    } catch (err) {
      const e = err as Error & { raw?: unknown };
      await this.prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'FAILED', errorMessage: e.message.slice(0, 1000), meta: { error: this.safeJson(e.raw) } as Prisma.InputJsonValue, events: [...(shipment.events as object[]), { status: 'FAILED', message: e.message, at: new Date().toISOString(), source: 'system' }] as unknown as Prisma.InputJsonValue } });
      this.events.emit('shipment.failed', { shipmentId: shipment.id, orderId: order.id, error: e.message });
      throw new BadRequestException(e.message);
    }
  }

  private async afterCreated(sh: Shipment, order: Order, actor: Actor) {
    // ghi vào lịch sử đơn + cập nhật shippingMeta
    await this.appendOrderHistory(order.id, `Tạo vận đơn ${this.registry.get(sh.carrier)?.meta.name ?? sh.carrier}${sh.trackingCode ? ` · ${sh.trackingCode}` : ''}${sh.fee ? ` · phí ${Number(sh.fee).toLocaleString('vi-VN')}đ` : ''}`, actor);
    this.events.emit('activity', { userId: actor.id === 'system' ? null : actor.id, action: 'shipment.create', entityType: 'order', entityId: order.id, meta: { shipmentId: sh.id, carrier: sh.carrier, trackingCode: sh.trackingCode } });
    this.events.emit('shipment.created', { shipment: sh, order });
    await this.hooks.doAction('shipment.created', sh, order);
    // hãng không webhook -> hẹn đồng bộ
    const carrier = this.registry.get(sh.carrier);
    if (carrier?.meta.capabilities.track) await this.jobs.enqueue('shipment.sync', { shipmentId: sh.id }, { dedupeKey: `shipment.sync:${sh.id}`, runAt: new Date(Date.now() + 30 * 60_000), maxAttempts: 3 });
  }

  /** Nhập tay mã vận đơn / trạng thái */
  async manual(id: string, dto: ManualShipmentDto, actor: Actor) {
    const sh = await this.find(id);
    const data: Prisma.ShipmentUpdateInput = {};
    if (dto.trackingCode !== undefined) data.trackingCode = dto.trackingCode || null;
    if (dto.trackingUrl !== undefined) data.trackingUrl = dto.trackingUrl || null;
    if (dto.fee !== undefined) data.fee = dto.fee;
    if (!dto.trackingUrl && dto.trackingCode) {
      const carrier = this.registry.get(sh.carrier);
      const s = await this.settings();
      const cfg = this.registry.buildConfig(sh.carrier, s);
      if (carrier?.trackingUrl && cfg) data.trackingUrl = carrier.trackingUrl(cfg, { id, trackingCode: dto.trackingCode }) ?? sh.trackingUrl;
    }
    await this.prisma.shipment.update({ where: { id }, data });
    if (dto.status && dto.status !== sh.status) await this.applyStatus(id, { status: dto.status, message: dto.message ?? `Cập nhật tay bởi ${actor.name}`, at: new Date() }, 'system', actor);
    return this.get(id);
  }

  /** Đồng bộ trạng thái từ hãng */
  async sync(id: string, actor: Actor, opts: { viaJob?: boolean } = {}) {
    const sh = await this.find(id);
    if (!ACTIVE_STATUSES.includes(sh.status)) return opts.viaJob ? { skipped: true } : this.get(id);
    const { carrier, cfg } = await this.carrierFor(sh.carrier);
    if (!carrier.meta.capabilities.track) throw new BadRequestException(`${carrier.meta.name} không hỗ trợ tra cứu tự động`);
    try {
      const r = await carrier.track(cfg, this.refOf(sh));
      const data: Prisma.ShipmentUpdateInput = { lastSyncAt: new Date(), statusCode: r.statusCode ?? sh.statusCode, statusMessage: r.message ?? sh.statusMessage, expectedDeliveryAt: r.expectedDeliveryAt ?? sh.expectedDeliveryAt, meta: { ...((sh.meta as object) ?? {}), lastTrack: this.safeJson(r.raw) } as Prisma.InputJsonValue };
      if (r.fee != null && r.fee > 0) data.fee = r.fee;
      // gộp hành trình hãng trả về (bỏ trùng theo at + statusCode)
      const existing = (sh.events as { at: string; statusCode?: string | null }[]) ?? [];
      const seen = new Set(existing.map((e) => `${e.at}|${e.statusCode ?? ''}`));
      const merged = [...existing];
      for (const ev of r.events) {
        const k = `${ev.at.toISOString()}|${ev.statusCode ?? ''}`;
        if (!seen.has(k)) merged.push({ ...ev, at: ev.at.toISOString(), source: 'sync' } as never);
      }
      data.events = merged as unknown as Prisma.InputJsonValue;
      await this.prisma.shipment.update({ where: { id }, data });
      if (r.status !== sh.status) await this.applyStatus(id, { status: r.status, statusCode: r.statusCode, message: r.message, at: new Date() }, 'sync', actor, { codCollected: r.codCollected ?? null, skipEvent: true });
      // vẫn đang giao -> hẹn lần sau
      if (ACTIVE_STATUSES.includes(r.status)) await this.jobs.enqueue('shipment.sync', { shipmentId: id }, { dedupeKey: `shipment.sync:${id}`, runAt: new Date(Date.now() + 60 * 60_000), maxAttempts: 3 });
      return this.get(id);
    } catch (err) {
      await this.prisma.shipment.update({ where: { id }, data: { lastSyncAt: new Date(), errorMessage: (err as Error).message.slice(0, 500) } });
      if (err instanceof ShippingCarrierError && err.retryable && opts.viaJob) throw err;
      if (opts.viaJob) return { failed: true, error: (err as Error).message };
      throw new BadRequestException((err as Error).message);
    }
  }

  async cancel(id: string, dto: CancelShipmentDto, actor: Actor) {
    const sh = await this.find(id);
    if (!['PENDING', 'PICKING', 'FAILED', 'PICKED'].includes(sh.status)) throw new BadRequestException('Chỉ huỷ được vận đơn chưa giao');
    let raw: unknown = null;
    if (!dto.localOnly && sh.status !== 'FAILED' && sh.trackingCode) {
      const { carrier, cfg } = await this.carrierFor(sh.carrier);
      try {
        const res = await carrier.cancel(cfg, this.refOf(sh), dto.reason);
        raw = res.raw;
        if (!res.ok) throw new ShippingCarrierError(res.message || 'Hãng từ chối huỷ', res.raw);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
    }
    await this.prisma.shipment.update({ where: { id }, data: { cancelledAt: new Date(), meta: { ...((sh.meta as object) ?? {}), cancelResult: this.safeJson(raw) } as Prisma.InputJsonValue } });
    await this.applyStatus(id, { status: 'CANCELLED', message: dto.reason ? `Huỷ: ${dto.reason}` : `Huỷ bởi ${actor.name}`, at: new Date() }, 'system', actor);
    return this.get(id);
  }

  /** Nhãn / phiếu giao: hãng trả URL hoặc file (lưu storage) */
  async label(id: string): Promise<{ url?: string | null; buffer?: Buffer; mimeType?: string; fileName?: string }> {
    const sh = await this.find(id);
    if (sh.labelPath) {
      try {
        return { buffer: await this.storage.get(sh.labelPath), mimeType: 'application/pdf', fileName: `van-don-${sh.trackingCode ?? sh.id.slice(0, 8)}.pdf` };
      } catch {
        /* tải lại */
      }
    }
    const { carrier, cfg } = await this.carrierFor(sh.carrier);
    if (!carrier.getLabel) {
      if (sh.labelUrl) return { url: sh.labelUrl };
      throw new BadRequestException(`${carrier.meta.name} không hỗ trợ in nhãn qua API`);
    }
    try {
      const r = await carrier.getLabel(cfg, this.refOf(sh));
      if (r.buffer) {
        const buffer = Buffer.isBuffer(r.buffer) ? r.buffer : Buffer.from(r.buffer);
        const key = `shipments/${sh.createdAt.getFullYear()}/${sh.id}.pdf`;
        await this.storage.put(key, buffer, r.mimeType ?? 'application/pdf');
        await this.prisma.shipment.update({ where: { id }, data: { labelPath: key } });
        return { buffer, mimeType: r.mimeType ?? 'application/pdf', fileName: r.fileName ?? `van-don-${sh.trackingCode ?? sh.id.slice(0, 8)}.pdf` };
      }
      if (r.url) {
        await this.prisma.shipment.update({ where: { id }, data: { labelUrl: r.url } });
        return { url: r.url };
      }
      throw new ShippingCarrierError('Hãng không trả về nhãn');
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Áp trạng thái mới: ghi hành trình, mốc thời gian, cập nhật đơn hàng (SHIPPING / COMPLETED), phát sự kiện.
   */
  private async applyStatus(id: string, ev: { status: NormalizedShipmentStatus; statusCode?: string | null; message?: string | null; location?: string | null; at: Date }, source: 'webhook' | 'sync' | 'system', actor: Actor, opts: { codCollected?: number | null; skipEvent?: boolean } = {}) {
    const sh = await this.prisma.shipment.findUnique({ where: { id }, include: { order: true } });
    if (!sh) return;
    const now = ev.at ?? new Date();
    const data: Prisma.ShipmentUpdateInput = { status: ev.status, statusCode: ev.statusCode ?? sh.statusCode, statusMessage: ev.message ?? sh.statusMessage };
    if (ev.status === 'PICKED' && !sh.pickedAt) data.pickedAt = now;
    if (ev.status === 'DELIVERED' && !sh.deliveredAt) data.deliveredAt = now;
    if (ev.status === 'CANCELLED' && !sh.cancelledAt) data.cancelledAt = now;
    if (!opts.skipEvent) data.events = [...((sh.events as object[]) ?? []), { status: ev.status, statusCode: ev.statusCode ?? null, message: ev.message ?? null, location: ev.location ?? null, at: now.toISOString(), source }] as unknown as Prisma.InputJsonValue;
    const updated = await this.prisma.shipment.update({ where: { id }, data });
    const s = await this.settings();
    // cập nhật trạng thái đơn hàng theo vận đơn
    if (s.syncOrderStatus && sh.order && !['CANCELLED', 'REFUNDED'].includes(sh.order.status)) {
      const map: Partial<Record<NormalizedShipmentStatus, Order['status']>> = { PICKED: 'SHIPPING', DELIVERING: 'SHIPPING', DELIVERED: 'COMPLETED' };
      const next = map[ev.status];
      if (next && next !== sh.order.status && !(next === 'SHIPPING' && sh.order.status === 'COMPLETED')) {
        const label = ev.status === 'DELIVERED' ? 'Giao hàng thành công' : 'Hãng vận chuyển đã lấy hàng / đang giao';
        await this.setOrderStatus(sh.order, next, `${label}${ev.message ? ` — ${ev.message}` : ''}`, actor);
        // giao thành công + COD -> ghi nhận đã thu tiền hộ (chờ hãng đối soát), chỉ đánh dấu trong lịch sử
        if (ev.status === 'DELIVERED' && Number(sh.codAmount) > 0 && sh.order.paymentStatus === 'UNPAID') await this.appendOrderHistory(sh.order.id, `Hãng đã thu hộ COD ${Number(opts.codCollected ?? sh.codAmount).toLocaleString('vi-VN')}đ (chờ đối soát)`, SYSTEM);
      }
      if (ev.status === 'RETURNED') await this.appendOrderHistory(sh.order.id, `Vận đơn hoàn về kho${ev.message ? ` — ${ev.message}` : ''}`, SYSTEM);
    }
    this.events.emit('shipment.statusChanged', { shipment: updated, from: sh.status, to: ev.status, source });
    await this.hooks.doAction('shipment.statusChanged', updated, sh.status, ev.status);
    if (ev.status === 'DELIVERED') {
      this.events.emit('shipment.delivered', { shipment: updated });
      await this.hooks.doAction('shipment.delivered', updated);
    }
    if (ev.status === 'RETURNED' || ev.status === 'FAILED') this.logger.warn(`Vận đơn ${sh.trackingCode ?? ''} ${ev.status === 'RETURNED' ? 'đã hoàn về' : 'thất bại'}${sh.order ? ` (đơn #${sh.order.code})` : ''}${ev.message ? `: ${ev.message}` : ''}`);
  }

  /** Đổi trạng thái đơn + lịch sử + sự kiện (không qua OrdersService để tránh vòng phụ thuộc) */
  private async setOrderStatus(order: Order, status: Order['status'], note: string, actor: Actor) {
    const history = [...((order.history as object[]) ?? []), { status, note, at: new Date().toISOString(), by: actor.id === 'system' ? 'system' : actor.name }];
    const updated = await this.prisma.order.update({ where: { id: order.id }, data: { status, history: history as unknown as Prisma.InputJsonValue } });
    this.events.emit('order.statusChanged', { order: updated, from: order.status, to: status });
    await this.hooks.doAction('order.statusChanged', updated, order.status);
  }

  private async appendOrderHistory(orderId: string, note: string, actor: Actor) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, history: true } });
    if (!order) return;
    const history = [...((order.history as object[]) ?? []), { status: order.status, note, at: new Date().toISOString(), by: actor.id === 'system' ? 'system' : actor.name }];
    await this.prisma.order.update({ where: { id: orderId }, data: { history: history as unknown as Prisma.InputJsonValue } });
  }

  // ---------------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------------

  /** Nhận webhook của hãng: xác minh (adapter), tìm vận đơn theo mã, áp trạng thái */
  async handleWebhook(carrierKey: string, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string; query?: Record<string, unknown> }) {
    const s = await this.settings();
    // BẮT BUỘC có khoá: phần lớn hãng (GHN, GHTK, SuperShip…) không ký webhook, thiếu khoá thì ai biết mã vận đơn
    // cũng giả được trạng thái "đã giao" (đơn COD thành hoàn tất, tự xuất hoá đơn…). Khoá lấy từ ?key= hoặc header x-webhook-key.
    if (!s.webhookSecret) throw new BadRequestException('Chưa cấu hình chuỗi bí mật webhook (Cài đặt › Vận chuyển › Tự động hoá)');
    const headerKey = input.headers['x-webhook-key'];
    const given = String((Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? input.query?.key ?? '');
    if (!safeEqual(given, s.webhookSecret)) throw new BadRequestException('Sai khoá webhook');
    const carrier = this.registry.get(carrierKey);
    if (!carrier?.parseWebhook) throw new NotFoundException('Hãng không hỗ trợ webhook');
    const cfg = this.registry.buildConfig(carrierKey, s)!;
    const events = await carrier.parseWebhook(cfg, input);
    if (!events) throw new BadRequestException('Webhook không hợp lệ');
    let applied = 0;
    for (const ev of events) {
      const sh = await this.findByWebhook(carrierKey, ev);
      if (!sh) {
        this.logger.warn(`Webhook ${carrierKey}: không tìm thấy vận đơn ${ev.trackingCode ?? ev.carrierOrderId ?? ev.shipmentId}`);
        continue;
      }
      const data: Prisma.ShipmentUpdateInput = { lastSyncAt: new Date(), meta: { ...((sh.meta as object) ?? {}), lastWebhook: this.safeJson(ev.raw) } as Prisma.InputJsonValue };
      if (ev.fee != null && ev.fee > 0) data.fee = ev.fee;
      await this.prisma.shipment.update({ where: { id: sh.id }, data });
      if (ev.status !== sh.status || ev.statusCode !== sh.statusCode) {
        await this.applyStatus(sh.id, { status: ev.status, statusCode: ev.statusCode, message: ev.message, location: ev.location, at: ev.at ?? new Date() }, 'webhook', SYSTEM, { codCollected: ev.codCollected ?? null });
        applied++;
      }
    }
    return { ok: true, received: events.length, applied };
  }

  private findByWebhook(carrier: string, ev: WebhookEvent) {
    const or: Prisma.ShipmentWhereInput[] = [];
    if (ev.shipmentId) or.push({ id: ev.shipmentId });
    if (ev.trackingCode) or.push({ trackingCode: ev.trackingCode });
    if (ev.carrierOrderId) or.push({ carrierOrderId: ev.carrierOrderId });
    if (!or.length) return null;
    return this.prisma.shipment.findFirst({ where: { carrier, OR: or }, orderBy: { createdAt: 'desc' } });
  }

  // ---------------------------------------------------------------------------
  // Tự động theo sự kiện đơn hàng & cron
  // ---------------------------------------------------------------------------

  @OnEvent('order.paid', { async: true })
  async onOrderPaid(e: { order: Order }) {
    await this.maybeAutoCreate(e.order, 'paid').catch((err) => this.logger.warn(`Tự tạo vận đơn (paid) lỗi: ${(err as Error).message}`));
  }

  @OnEvent('order.statusChanged', { async: true })
  async onOrderStatusChanged(e: { order: Order; from: string; to: string }) {
    if (e.to === 'CONFIRMED') await this.maybeAutoCreate(e.order, 'confirmed').catch((err) => this.logger.warn(`Tự tạo vận đơn (confirmed) lỗi: ${(err as Error).message}`));
    // đơn huỷ -> huỷ vận đơn chưa giao
    if (e.to === 'CANCELLED') {
      const active = await this.prisma.shipment.findMany({ where: { orderId: e.order.id, status: { in: ['PENDING', 'PICKING'] } }, select: { id: true } });
      for (const sh of active) await this.cancel(sh.id, { reason: 'Đơn hàng bị huỷ' }, SYSTEM).catch((err) => this.logger.warn(`Huỷ vận đơn ${sh.id} lỗi: ${(err as Error).message}`));
    }
  }

  private async maybeAutoCreate(order: Order, trigger: 'paid' | 'confirmed') {
    const s = await this.settings();
    if (s.autoCreateShipment !== trigger) return;
    const meta = order.shippingMeta as { carrier?: string; service?: string } | null;
    if (!meta?.carrier || !meta.service) return; // chỉ tự tạo khi khách đã chọn dịch vụ của hãng ở checkout
    await this.jobs.enqueue('shipment.create', { orderId: order.id, carrier: meta.carrier, service: meta.service }, { dedupeKey: `shipment.create:${order.id}`, maxAttempts: 2, runAt: new Date(Date.now() + 60_000) });
  }

  private async autoCreate(orderId: string, carrier?: string, service?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, shippingMeta: true } });
    if (!order || ['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(order.status)) return { skipped: true };
    const meta = order.shippingMeta as { carrier?: string; service?: string } | null;
    const c = carrier ?? meta?.carrier;
    const sv = service ?? meta?.service;
    if (!c || !sv) return { skipped: 'Không có hãng/dịch vụ' };
    const exists = await this.prisma.shipment.findFirst({ where: { orderId, status: { in: ACTIVE_STATUSES } }, select: { id: true } });
    if (exists) return { skipped: 'Đã có vận đơn' };
    try {
      await this.create({ orderId, carrier: c, service: sv }, SYSTEM);
    } catch (err) {
      this.logger.error(`Tự tạo vận đơn cho đơn ${orderId} thất bại: ${(err as Error).message}`);
      return { failed: true, error: (err as Error).message };
    }
    return { ok: true };
  }

  /** Vận đơn đang giao lâu không đồng bộ -> hẹn sync (dự phòng khi hãng không webhook) */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async requeueStale() {
    if (process.env.NODE_ENV === 'test') return;
    const stale = await this.prisma.shipment.findMany({ where: { status: { in: ACTIVE_STATUSES }, trackingCode: { not: null }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - 2 * 60 * 60_000) } }] }, select: { id: true, carrier: true }, take: 100 });
    for (const sh of stale) {
      if (!this.registry.get(sh.carrier)?.meta.capabilities.track) continue;
      await this.jobs.enqueue('shipment.sync', { shipmentId: sh.id }, { dedupeKey: `shipment.sync:${sh.id}`, maxAttempts: 3 });
    }
  }

  // ---------------------------------------------------------------------------
  // Truy vấn
  // ---------------------------------------------------------------------------

  async list(q: ShipmentQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.ShipmentWhereInput = {};
    if (q.status && q.status !== 'all') where.status = q.status === 'active' ? { in: ACTIVE_STATUSES } : (q.status as Shipment['status']);
    if (q.carrier) where.carrier = q.carrier;
    if (q.orderId) where.orderId = q.orderId;
    if (q.from || q.to) where.createdAt = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    if (q.search) {
      const s = q.search.trim();
      where.OR = [{ trackingCode: { contains: s, mode: 'insensitive' } }, { carrierOrderId: { contains: s, mode: 'insensitive' } }, { order: { code: { contains: s, mode: 'insensitive' } } }, { order: { customerName: { contains: s, mode: 'insensitive' } } }, { order: { customerPhone: { contains: s } } }];
    }
    const [data, total] = await Promise.all([
      this.prisma.shipment.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { order: { select: { id: true, code: true, customerName: true, customerPhone: true, total: true, status: true, paymentStatus: true, paymentMethod: true } } } }),
      this.prisma.shipment.count({ where }),
    ]);
    return paginate(data.map((d) => ({ ...d, carrierName: this.registry.get(d.carrier)?.meta.name ?? d.carrier })), total, page, limit);
  }

  async stats() {
    const rows = await this.prisma.shipment.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    return { counts, active: ACTIVE_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0) };
  }

  async get(id: string) {
    const sh = await this.prisma.shipment.findUnique({ where: { id }, include: { order: { select: { id: true, code: true, customerName: true, customerPhone: true, customerEmail: true, total: true, status: true, paymentStatus: true, paymentMethod: true, shippingAddress: true, shippingMeta: true } } } });
    if (!sh) throw new NotFoundException('Không tìm thấy vận đơn');
    const carrier = this.registry.get(sh.carrier);
    return { ...sh, carrierName: carrier?.meta.name ?? sh.carrier, capabilities: carrier?.meta.capabilities ?? null };
  }

  forOrder(orderId: string) {
    return this.prisma.shipment.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } }).then((rows) => rows.map((r) => ({ ...r, carrierName: this.registry.get(r.carrier)?.meta.name ?? r.carrier })));
  }

  /** Vận đơn khách nhìn thấy */
  async forCustomerOrder(orderId: string) {
    const rows = await this.prisma.shipment.findMany({ where: { orderId, status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: SHIPMENT_CUSTOMER_SELECT });
    return rows.map((r) => ({ ...r, carrierName: this.registry.get(r.carrier)?.meta.name ?? r.carrier }));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async find(id: string) {
    const sh = await this.prisma.shipment.findUnique({ where: { id } });
    if (!sh) throw new NotFoundException('Không tìm thấy vận đơn');
    return sh;
  }

  private refOf(sh: Shipment): ShipmentRef {
    return { id: sh.id, trackingCode: sh.trackingCode, carrierOrderId: sh.carrierOrderId, meta: (sh.meta as Record<string, unknown>) ?? {} };
  }

  private safeJson(v: unknown): unknown {
    if (v === undefined || v === null) return null;
    try {
      const s = JSON.stringify(v, (_k, val) => (Buffer.isBuffer(val) ? `<buffer ${val.length}b>` : typeof val === 'string' && val.length > 20_000 ? `${val.slice(0, 20_000)}…` : val));
      return s.length > 100_000 ? { truncated: s.slice(0, 100_000) } : JSON.parse(s);
    } catch {
      return { unserializable: String(v).slice(0, 1000) };
    }
  }
}

export type { ShipmentEvent };

/** So sánh chuỗi bí mật không lộ thời gian (băm trước để 2 buffer cùng độ dài) */
function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
