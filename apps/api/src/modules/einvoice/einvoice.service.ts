import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { EInvoice, Order, OrderItem, Prisma } from '../../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';
import { JobsService } from '../scheduler/jobs.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { MailService } from '../mail/mail.service.js';
import { addressLines } from '../mail/order-vars.js';
import { STORAGE, type StorageDriver } from '../media/storage.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { EInvoiceProviderRegistry } from './providers/registry.js';
import { EInvoiceProviderError, type EInvoiceProvider, type InvoiceBuyer, type InvoiceLine, type InvoicePayload, type InvoiceRef, type InvoiceSeller, type IssueResult, type ProviderConfig } from './providers/provider.interface.js';
import { buildLines, isValidTaxCode, roundMoney, summarize, vatPercent } from './einvoice.calc.js';
import { normalizeInvoiceRequest, type InvoiceRequest } from './einvoice.request.js';
import { renderInvoiceHtml } from './einvoice.print.js';
import { toCsv } from '../products/products-csv.service.js';
import type { AdjustEInvoiceDto, BulkIssueDto, CancelEInvoiceDto, CreateEInvoiceDto, EInvoiceQueryDto, InvoiceBuyerDto, InvoiceLineInputDto, InvoiceRequestDto, ManualResultDto, PreviewEInvoiceDto, ReplaceEInvoiceDto, SendEInvoiceEmailDto, TestConnectionDto, UpdateEInvoiceDto } from './einvoice.dto.js';

/** Cài đặt nhóm `einvoice` (xem settings.defaults.ts) */
export interface EInvoiceSettings {
  provider: string;
  environment: 'sandbox' | 'production';
  autoIssue: 'manual' | 'paid' | 'completed';
  autoIssueOnlyWhenRequested: boolean;
  autoIssueDelayMinutes: number;
  autoCancelOnRefund: boolean;
  sendEmailToBuyer: boolean;
  defaultVatRate: number;
  pricesIncludeVat: boolean;
  templateCode: string;
  serial: string;
  shippingAsLine: boolean;
  shippingLineName: string;
  defaultUnit: string;
  discountMode: 'perLine' | 'separate';
  paymentMethodMap: Record<string, string>;
  seller: InvoiceSeller;
  providers: Record<string, Record<string, unknown>>;
}


type OrderWithItems = Order & { items: OrderItem[] };
type Actor = Pick<AuthUser, 'id' | 'name'> | { id: 'system'; name: string };

const SYSTEM: Actor = { id: 'system', name: 'Hệ thống' };
/** Trạng thái khách nhìn thấy (ẩn nháp / lỗi nội bộ) */
const CUSTOMER_VISIBLE: EInvoice['status'][] = ['ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED'];
/** Trường trả về cho storefront (không lộ request/response NCC) */
const CUSTOMER_SELECT = { id: true, status: true, kind: true, invoiceNo: true, serial: true, templateCode: true, taxAuthorityCode: true, lookupCode: true, lookupUrl: true, issuedAt: true, cancelledAt: true, total: true, currency: true, pdfPath: true, buyer: true, provider: true } as const;

/**
 * Nghiệp vụ hoá đơn điện tử: lập nháp từ đơn hàng, phát hành qua adapter NCC, huỷ/thay thế/điều chỉnh,
 * đồng bộ trạng thái, tải PDF/XML, gửi email cho khách, tự động xuất theo sự kiện đơn hàng (qua hàng đợi job).
 */
@Injectable()
export class EInvoiceService implements OnModuleInit {
  private readonly logger = new Logger('EInvoice');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly registry: EInvoiceProviderRegistry,
    private readonly jobs: JobsService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly mail: MailService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  onModuleInit() {
    // Job nền: phát hành / đồng bộ / tải file / gửi email — thử lại theo backoff của JobsService
    this.jobs.register<{ invoiceId: string }>('einvoice.issue', (p) => this.issue(p.invoiceId, SYSTEM, { viaJob: true }));
    this.jobs.register<{ invoiceId: string }>('einvoice.sync', (p) => this.sync(p.invoiceId, SYSTEM));
    this.jobs.register<{ invoiceId: string }>('einvoice.download', (p) => this.getFile(p.invoiceId, 'pdf').then(() => undefined));
    this.jobs.register<{ invoiceId: string; to?: string }>('einvoice.email', (p) => this.sendEmail(p.invoiceId, { to: p.to, attachPdf: true }, SYSTEM));
  }

  // ---------------------------------------------------------------------------
  // Cài đặt & nhà cung cấp
  // ---------------------------------------------------------------------------

  async settings(): Promise<EInvoiceSettings> {
    const s = await this.settingsService.get<Partial<EInvoiceSettings>>('einvoice');
    return {
      provider: s.provider || 'none',
      environment: s.environment === 'production' ? 'production' : 'sandbox',
      autoIssue: (s.autoIssue as EInvoiceSettings['autoIssue']) || 'manual',
      autoIssueOnlyWhenRequested: s.autoIssueOnlyWhenRequested !== false,
      autoIssueDelayMinutes: Number(s.autoIssueDelayMinutes ?? 0) || 0,
      autoCancelOnRefund: !!s.autoCancelOnRefund,
      sendEmailToBuyer: s.sendEmailToBuyer !== false,
      defaultVatRate: Number(s.defaultVatRate ?? 10),
      pricesIncludeVat: s.pricesIncludeVat !== false,
      templateCode: String(s.templateCode ?? '1'),
      serial: String(s.serial ?? ''),
      shippingAsLine: s.shippingAsLine !== false,
      shippingLineName: String(s.shippingLineName || 'Phí vận chuyển'),
      defaultUnit: String(s.defaultUnit || 'Cái'),
      discountMode: s.discountMode === 'separate' ? 'separate' : 'perLine',
      paymentMethodMap: (s.paymentMethodMap as Record<string, string>) ?? { default: 'TM/CK' },
      seller: { name: '', taxCode: '', address: '', ...(s.seller ?? {}) } as InvoiceSeller,
      providers: (s.providers as Record<string, Record<string, unknown>>) ?? {},
    };
  }

  /** Meta các adapter (admin render form) + nhà cung cấp đang chọn */
  async providers() {
    const s = await this.settings();
    return { active: s.provider, environment: s.environment, providers: this.registry.list() };
  }

  /** Adapter + cấu hình đang dùng; ném lỗi rõ ràng nếu chưa cấu hình */
  private async activeProvider(settings?: EInvoiceSettings): Promise<{ key: string; provider: EInvoiceProvider; cfg: ProviderConfig; settings: EInvoiceSettings }> {
    const s = settings ?? (await this.settings());
    if (!s.provider || s.provider === 'none') throw new BadRequestException('Chưa chọn nhà cung cấp hoá đơn điện tử (Cài đặt › Hoá đơn điện tử)');
    const provider = this.registry.get(s.provider);
    if (!provider) throw new BadRequestException(`Nhà cung cấp "${s.provider}" không tồn tại`);
    const cfg = this.registry.buildConfig(s.provider, s)!;
    const missing = this.registry.missingFields(s.provider, cfg);
    if (missing.length) throw new BadRequestException(`Thiếu cấu hình nhà cung cấp: ${missing.join(', ')}`);
    return { key: s.provider, provider, cfg, settings: s };
  }

  /** Kiểm tra kết nối với cấu hình thử (chưa lưu) hoặc cấu hình đã lưu */
  async testConnection(dto: TestConnectionDto) {
    const provider = this.registry.get(dto.provider);
    if (!provider) throw new BadRequestException('Nhà cung cấp không tồn tại');
    const s = await this.settings();
    const cfg = this.registry.buildConfig(dto.provider, { environment: dto.environment ?? s.environment, providers: dto.config ? { [dto.provider]: dto.config } : s.providers })!;
    const missing = this.registry.missingFields(dto.provider, cfg);
    if (missing.length) return { ok: false, message: `Thiếu: ${missing.join(', ')}` };
    try {
      return await provider.testConnection(cfg);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Dựng dữ liệu hoá đơn từ đơn hàng
  // ---------------------------------------------------------------------------

  /** Người mua: ưu tiên thông tin khách yêu cầu xuất HĐ, không có thì lấy từ đơn */
  buyerFromOrder(order: Order, override?: InvoiceBuyerDto | null): InvoiceBuyer {
    const req = (order.invoiceRequest as InvoiceRequest | null) ?? null;
    const addr = addressLines((order.shippingAddress ?? {}) as Parameters<typeof addressLines>[0]).join(', ');
    let buyer: InvoiceBuyer;
    if (req?.requested) {
      const company = req.type === 'company';
      buyer = {
        name: company ? order.customerName : req.name || order.customerName,
        legalName: company ? req.name : undefined,
        taxCode: req.taxCode?.trim() || undefined,
        address: req.address?.trim() || addr,
        email: req.email?.trim() || order.customerEmail || undefined,
        phone: order.customerPhone,
        idNumber: req.idNumber?.trim() || undefined,
      };
    } else {
      buyer = { name: order.customerName, address: addr, email: order.customerEmail || undefined, phone: order.customerPhone };
    }
    if (override) {
      for (const [k, v] of Object.entries(override)) if (v !== undefined) (buyer as unknown as Record<string, unknown>)[k] = v === '' ? undefined : v;
    }
    return buyer;
  }

  /** Dòng hàng chuẩn hoá từ đơn hàng theo cài đặt VAT */
  async linesFromOrder(order: OrderWithItems, s?: EInvoiceSettings): Promise<InvoiceLine[]> {
    const st = s ?? (await this.settings());
    const commerce = await this.settingsService.get<{ decimals?: number }>('commerce');
    // thuế suất riêng theo sản phẩm (Product.vatRate), null = mặc định
    const productIds = [...new Set(order.items.map((it) => it.productId).filter((x): x is string => !!x))];
    const products = productIds.length ? await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, vatRate: true } }) : [];
    const vatByProduct = new Map(products.map((p) => [p.id, p.vatRate]));
    return buildLines({
      items: order.items.map((it) => ({ name: it.name, sku: it.sku, quantity: it.quantity, price: Number(it.price), vatRate: it.productId ? (vatByProduct.get(it.productId) ?? null) : null })),
      discountTotal: Number(order.discountTotal),
      shippingTotal: Number(order.shippingTotal),
      shippingAsLine: st.shippingAsLine,
      shippingLineName: st.shippingLineName,
      defaultVatRate: st.defaultVatRate,
      defaultUnit: st.defaultUnit,
      pricesIncludeVat: st.pricesIncludeVat,
      discountMode: st.discountMode,
      decimals: Number(commerce.decimals ?? 0),
    });
  }

  /** Dòng hàng admin nhập tay (đơn giá CHƯA VAT); hoá đơn điều chỉnh giảm -> số âm */
  linesFromInput(items: InvoiceLineInputDto[], s: EInvoiceSettings, decimals = 0): InvoiceLine[] {
    return items.map((it, i) => {
      const sign = it.adjustment === 'decrease' ? -1 : 1;
      const pct = vatPercent(it.vatRate) / 100;
      const discount = Math.max(0, it.discount ?? 0);
      const amountRaw = (it.unitPrice * it.quantity - discount) * sign;
      const amount = roundMoney(amountRaw, decimals);
      const vatAmount = roundMoney(amountRaw * pct, decimals);
      return {
        index: i + 1,
        kind: it.kind ?? 'product',
        name: it.name,
        sku: it.sku || undefined,
        unit: it.unit || s.defaultUnit,
        quantity: it.quantity,
        unitPrice: roundMoney(it.unitPrice, Math.max(decimals, 2)),
        discount: roundMoney(discount, decimals),
        amount,
        vatRate: it.vatRate,
        vatAmount,
        total: roundMoney(amount + vatAmount, decimals),
        adjustment: it.adjustment,
      };
    });
  }

  /** Hình thức thanh toán ghi trên HĐ theo map cài đặt */
  paymentMethodLabel(orderMethod: string | null | undefined, s: EInvoiceSettings): string {
    const map = s.paymentMethodMap ?? {};
    return map[orderMethod ?? ''] || map.default || 'TM/CK';
  }

  private async loadOrder(orderId: string): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return order;
  }

  /** Xem trước dữ liệu hoá đơn sẽ lập từ đơn (không lưu) */
  async preview(dto: PreviewEInvoiceDto) {
    const s = await this.settings();
    const order = await this.loadOrder(dto.orderId);
    const lines = await this.linesFromOrder(order, s);
    const totals = summarize(lines, 0, order.currency);
    return { buyer: this.buyerFromOrder(order, dto.buyer), seller: s.seller, lines, totals, paymentMethod: this.paymentMethodLabel(order.paymentMethod, s), templateCode: s.templateCode, serial: s.serial, provider: s.provider, warnings: this.validateBuyer(this.buyerFromOrder(order, dto.buyer)) };
  }

  /** Cảnh báo dữ liệu người mua (không chặn, trừ khi phát hành) */
  private validateBuyer(buyer: InvoiceBuyer): string[] {
    const w: string[] = [];
    if (buyer.taxCode && !isValidTaxCode(buyer.taxCode)) w.push('Mã số thuế không đúng định dạng (10 số hoặc 10 số-3 số)');
    if (buyer.legalName && !buyer.taxCode) w.push('Người mua là đơn vị nhưng chưa có mã số thuế');
    if (!buyer.name && !buyer.legalName && !buyer.anonymous) w.push('Thiếu tên người mua');
    return w;
  }

  // ---------------------------------------------------------------------------
  // CRUD nháp
  // ---------------------------------------------------------------------------

  /** Lập hoá đơn nháp (từ đơn hàng hoặc tự nhập dòng hàng) */
  async create(dto: CreateEInvoiceDto, actor: Actor) {
    const s = await this.settings();
    if (!dto.orderId && !dto.items?.length) throw new BadRequestException('Cần chọn đơn hàng hoặc nhập dòng hàng');
    const order = dto.orderId ? await this.loadOrder(dto.orderId) : null;
    if (order) {
      const existing = await this.prisma.eInvoice.findFirst({ where: { orderId: order.id, kind: 'ORIGINAL', status: { in: ['DRAFT', 'QUEUED', 'ISSUING', 'ISSUED'] } }, select: { id: true, status: true } });
      if (existing) throw new BadRequestException(`Đơn hàng đã có hoá đơn (${existing.status}). Hãy huỷ hoặc lập hoá đơn thay thế.`);
    }
    const commerce = await this.settingsService.get<{ decimals?: number }>('commerce');
    const decimals = Number(commerce.decimals ?? 0);
    const lines = dto.items?.length ? this.linesFromInput(dto.items, s, decimals) : await this.linesFromOrder(order!, s);
    const currency = order?.currency ?? 'VND';
    const totals = summarize(lines, decimals, currency);
    const buyer = order ? this.buyerFromOrder(order, dto.buyer) : ({ name: '', ...(dto.buyer ?? {}) } as InvoiceBuyer);
    const invoice = await this.prisma.eInvoice.create({
      data: {
        orderId: order?.id ?? null,
        provider: s.provider,
        kind: 'ORIGINAL',
        status: 'DRAFT',
        templateCode: dto.templateCode ?? s.templateCode,
        serial: dto.serial ?? s.serial,
        seller: s.seller as unknown as Prisma.InputJsonValue,
        buyer: buyer as unknown as Prisma.InputJsonValue,
        items: lines as unknown as Prisma.InputJsonValue,
        currency,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        vatTotal: totals.vatTotal,
        total: totals.total,
        paymentMethod: dto.paymentMethod ?? this.paymentMethodLabel(order?.paymentMethod, s),
        note: dto.note ?? null,
        invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : new Date(),
        createdById: actor.id === 'system' ? null : actor.id,
      },
    });
    await this.log(invoice.id, 'create', 'ok', `Lập nháp bởi ${actor.name}`, null, null, actor);
    this.activity(actor, 'einvoice.create', invoice.id, { orderId: order?.id, orderCode: order?.code });
    if (dto.issueNow) return this.issue(invoice.id, actor);
    return this.get(invoice.id);
  }

  /** Sửa nháp (buyer, dòng hàng, ghi chú...) — chỉ khi DRAFT / FAILED */
  async update(id: string, dto: UpdateEInvoiceDto, actor: Actor) {
    const inv = await this.find(id);
    if (!['DRAFT', 'FAILED'].includes(inv.status)) throw new BadRequestException('Chỉ sửa được hoá đơn nháp hoặc phát hành lỗi');
    const s = await this.settings();
    const data: Prisma.EInvoiceUpdateInput = {};
    if (dto.buyer) data.buyer = { ...(inv.buyer as object), ...Object.fromEntries(Object.entries(dto.buyer).filter(([, v]) => v !== undefined)) } as Prisma.InputJsonValue;
    if (dto.items) {
      const lines = this.linesFromInput(dto.items, s);
      const totals = summarize(lines, 0, inv.currency);
      Object.assign(data, { items: lines as unknown as Prisma.InputJsonValue, subtotal: totals.subtotal, discountTotal: totals.discountTotal, vatTotal: totals.vatTotal, total: totals.total });
    }
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.paymentMethod !== undefined) data.paymentMethod = dto.paymentMethod;
    if (dto.invoiceDate) data.invoiceDate = new Date(dto.invoiceDate);
    if (dto.templateCode !== undefined) data.templateCode = dto.templateCode;
    if (dto.serial !== undefined) data.serial = dto.serial;
    // sửa xong thì trở về nháp sạch
    data.status = 'DRAFT';
    data.errorMessage = null;
    await this.prisma.eInvoice.update({ where: { id }, data });
    await this.log(id, 'update', 'ok', `Sửa nháp bởi ${actor.name}`, dto as object, null, actor);
    return this.get(id);
  }

  /** Xoá nháp / hoá đơn lỗi chưa từng phát hành */
  async remove(id: string, actor: Actor) {
    const inv = await this.find(id);
    if (!['DRAFT', 'FAILED', 'QUEUED'].includes(inv.status) || inv.invoiceNo) throw new BadRequestException('Chỉ xoá được hoá đơn nháp chưa phát hành');
    await this.prisma.eInvoice.delete({ where: { id } });
    this.activity(actor, 'einvoice.delete', id, { orderId: inv.orderId });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Phát hành
  // ---------------------------------------------------------------------------

  /** Chuyển bản ghi DB -> InvoicePayload gửi adapter */
  private async toPayload(inv: EInvoice & { original?: EInvoice | null }, order: Order | null, s: EInvoiceSettings): Promise<InvoicePayload> {
    const lines = inv.items as unknown as InvoiceLine[];
    const totals = summarize(lines, 0, inv.currency);
    const suffix = inv.kind === 'REPLACEMENT' ? '-TT' : inv.kind === 'ADJUSTMENT' ? '-DC' : '';
    const original = inv.original;
    const payload: InvoicePayload = {
      id: inv.id,
      refCode: `${order?.code ?? inv.id.slice(0, 8).toUpperCase()}${suffix}${inv.attempts > 0 ? `-${inv.attempts + 1}` : ''}`,
      orderCode: order?.code ?? null,
      kind: inv.kind,
      templateCode: inv.templateCode || s.templateCode,
      serial: inv.serial || s.serial,
      invoiceDate: inv.invoiceDate,
      currency: inv.currency,
      exchangeRate: Number(inv.exchangeRate ?? 1),
      paymentMethod: inv.paymentMethod || 'TM/CK',
      seller: (Object.keys(inv.seller as object).length ? inv.seller : s.seller) as unknown as InvoiceSeller,
      buyer: inv.buyer as unknown as InvoiceBuyer,
      lines,
      totals,
      note: inv.note,
      original: original
        ? { invoiceNo: original.invoiceNo ?? '', serial: original.serial ?? '', templateCode: original.templateCode ?? '', issuedAt: original.issuedAt ?? original.invoiceDate, providerRef: original.providerRef, taxAuthorityCode: original.taxAuthorityCode, reason: inv.reason ?? '' }
        : null,
    };
    // module khác có thể chỉnh payload trước khi gửi NCC qua filter `einvoice.beforeIssue` (vd thêm trường riêng, đổi tên hàng)
    return this.hooks.applyFilters<InvoicePayload>('einvoice.beforeIssue', payload, inv, order);
  }

  /**
   * Phát hành hoá đơn (gốc / thay thế / điều chỉnh) qua adapter.
   * `viaJob` = chạy trong hàng đợi: lỗi tạm thời sẽ ném ra để job thử lại; lỗi dữ liệu thì ghi FAILED và dừng.
   */
  async issue(id: string, actor: Actor, opts: { viaJob?: boolean } = {}) {
    const inv = await this.prisma.eInvoice.findUnique({ where: { id }, include: { original: true, order: { include: { items: true } } } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    if (!['DRAFT', 'FAILED', 'QUEUED'].includes(inv.status)) {
      if (opts.viaJob) return { skipped: true, status: inv.status };
      throw new BadRequestException(`Hoá đơn đang ở trạng thái ${inv.status}, không thể phát hành`);
    }
    const s = await this.settings();
    if (inv.provider !== s.provider && inv.provider !== 'none') this.logger.warn(`Hoá đơn ${id} lập cho NCC ${inv.provider} nhưng đang dùng ${s.provider}`);
    const { provider, cfg, key } = await this.activeProvider(s);
    const buyer = inv.buyer as unknown as InvoiceBuyer;
    const problems = this.validateBuyer(buyer);
    if (buyer.taxCode && !isValidTaxCode(buyer.taxCode)) throw new BadRequestException(problems.join('; '));
    if (!s.seller?.taxCode || !s.seller?.name) throw new BadRequestException('Chưa nhập thông tin người bán (tên, MST) ở Cài đặt › Hoá đơn điện tử');
    if (!inv.serial && !s.serial && key !== 'manual') throw new BadRequestException('Chưa nhập ký hiệu hoá đơn (vd C25TAA)');

    // đánh dấu đang gửi để tránh gửi trùng khi nhiều job song song
    const claimed = await this.prisma.eInvoice.updateMany({ where: { id, status: { in: ['DRAFT', 'FAILED', 'QUEUED'] } }, data: { status: 'ISSUING', provider: key, errorMessage: null } });
    if (!claimed.count) return { skipped: true };

    const payload = await this.toPayload(inv, inv.order, s);
    try {
      let result: IssueResult;
      if (inv.kind === 'REPLACEMENT') {
        if (!provider.replace) throw new EInvoiceProviderError(`${provider.meta.name} không hỗ trợ hoá đơn thay thế qua API`);
        result = await provider.replace(cfg, payload);
      } else if (inv.kind === 'ADJUSTMENT') {
        if (!provider.adjust) throw new EInvoiceProviderError(`${provider.meta.name} không hỗ trợ hoá đơn điều chỉnh qua API`);
        result = await provider.adjust(cfg, payload);
      } else result = await provider.issue(cfg, payload);

      const issued = result.status === 'issued';
      const ref: InvoiceRef = { id, providerRef: result.providerRef, invoiceNo: result.invoiceNo, serial: result.serial ?? payload.serial, templateCode: result.templateCode ?? payload.templateCode, lookupCode: result.lookupCode, issuedAt: result.issuedAt ?? new Date() };
      const lookupUrl = result.lookupUrl ?? provider.lookupUrl?.(cfg, ref) ?? null;
      const updated = await this.prisma.eInvoice.update({
        where: { id },
        data: {
          status: issued ? 'ISSUED' : 'ISSUING',
          providerRef: result.providerRef,
          invoiceNo: result.invoiceNo ?? null,
          serial: result.serial ?? payload.serial,
          templateCode: result.templateCode ?? payload.templateCode,
          taxAuthorityCode: result.taxAuthorityCode ?? null,
          lookupCode: result.lookupCode ?? null,
          lookupUrl,
          issuedAt: issued ? (result.issuedAt ?? new Date()) : null,
          seller: payload.seller as unknown as Prisma.InputJsonValue,
          attempts: { increment: 1 },
          errorMessage: null,
          meta: { ...((inv.meta as object) ?? {}), issueResult: this.safeJson(result.raw), pdfUrl: result.pdfUrl ?? undefined, xmlUrl: result.xmlUrl ?? undefined } as Prisma.InputJsonValue,
        },
      });
      await this.log(id, inv.kind === 'ORIGINAL' ? 'issue' : inv.kind === 'REPLACEMENT' ? 'replace' : 'adjust', 'ok', issued ? `Phát hành thành công: ${result.serial ?? ''} ${result.invoiceNo ?? ''}`.trim() : 'NCC đã nhận, đang chờ ký / cấp mã', this.safeJson(payload), this.safeJson(result.raw), actor);
      if (issued) await this.afterIssued(updated, actor);
      // NCC nhận nhưng chưa cấp số -> hẹn đồng bộ (chỉ khi adapter hỗ trợ sync; NCC nhập tay thì chờ admin điền)
      else if (provider.sync) await this.jobs.enqueue('einvoice.sync', { invoiceId: id }, { runAt: new Date(Date.now() + 60_000), maxAttempts: 10, dedupeKey: `einvoice.sync:${id}` });
      return this.get(id);
    } catch (err) {
      const e = err as Error & { retryable?: boolean; raw?: unknown };
      const retryable = e instanceof EInvoiceProviderError ? e.retryable : false;
      await this.prisma.eInvoice.update({ where: { id }, data: { status: 'FAILED', errorMessage: e.message.slice(0, 1000), attempts: { increment: 1 } } });
      await this.log(id, 'issue', 'error', e.message, this.safeJson(payload), this.safeJson(e.raw), actor);
      this.events.emit('einvoice.failed', { invoiceId: id, orderId: inv.orderId, error: e.message });
      await this.hooks.doAction('einvoice.failed', { id, orderId: inv.orderId, error: e.message });
      this.logger.warn(`Phát hành hoá đơn ${id} lỗi: ${e.message}`);
      if (opts.viaJob && retryable) throw e; // để job thử lại
      if (opts.viaJob) return { failed: true, error: e.message };
      throw new BadRequestException(e.message);
    }
  }

  /** Sau khi có số HĐ: cập nhật hoá đơn gốc (thay thế/điều chỉnh), gửi email, tải PDF, phát sự kiện */
  private async afterIssued(inv: EInvoice, actor: Actor) {
    if (inv.originalId && inv.kind === 'REPLACEMENT') await this.prisma.eInvoice.update({ where: { id: inv.originalId }, data: { status: 'REPLACED' } }).catch(() => undefined);
    if (inv.originalId && inv.kind === 'ADJUSTMENT') await this.prisma.eInvoice.update({ where: { id: inv.originalId }, data: { status: 'ADJUSTED' } }).catch(() => undefined);
    const s = await this.settings();
    const provider = this.registry.get(inv.provider);
    if (provider?.getPdf) await this.jobs.enqueue('einvoice.download', { invoiceId: inv.id }, { dedupeKey: `einvoice.download:${inv.id}`, maxAttempts: 5, runAt: new Date(Date.now() + 15_000) });
    if (s.sendEmailToBuyer) {
      const buyer = inv.buyer as unknown as InvoiceBuyer;
      if (buyer.email) await this.jobs.enqueue('einvoice.email', { invoiceId: inv.id }, { dedupeKey: `einvoice.email:${inv.id}`, maxAttempts: 3, runAt: new Date(Date.now() + 30_000) });
    }
    this.activity(actor, 'einvoice.issue', inv.id, { orderId: inv.orderId, invoiceNo: inv.invoiceNo, serial: inv.serial });
    this.events.emit('einvoice.issued', { invoice: inv });
    await this.hooks.doAction('einvoice.issued', inv);
  }

  /** Xếp hàng phát hành (job chạy nền) */
  async enqueueIssue(id: string, delayMinutes = 0) {
    await this.prisma.eInvoice.updateMany({ where: { id, status: { in: ['DRAFT', 'FAILED'] } }, data: { status: 'QUEUED' } });
    return this.jobs.enqueue('einvoice.issue', { invoiceId: id }, { dedupeKey: `einvoice.issue:${id}`, maxAttempts: 3, runAt: new Date(Date.now() + delayMinutes * 60_000) });
  }

  /** Tạo nháp (nếu chưa có) rồi xếp hàng phát hành cho đơn — dùng cho tự động xuất và phát hành hàng loạt */
  async queueForOrder(orderId: string, actor: Actor, delayMinutes = 0): Promise<{ invoiceId: string; created: boolean } | { skipped: string }> {
    const existing = await this.prisma.eInvoice.findFirst({ where: { orderId, kind: 'ORIGINAL', status: { in: ['DRAFT', 'QUEUED', 'ISSUING', 'ISSUED', 'FAILED'] } }, select: { id: true, status: true } });
    if (existing) {
      if (['ISSUED', 'ISSUING', 'QUEUED'].includes(existing.status)) return { skipped: `Đơn đã có hoá đơn (${existing.status})` };
      await this.enqueueIssue(existing.id, delayMinutes);
      return { invoiceId: existing.id, created: false };
    }
    const s = await this.settings();
    if (!s.provider || s.provider === 'none') return { skipped: 'Chưa cấu hình nhà cung cấp HĐĐT' };
    const order = await this.loadOrder(orderId);
    if (!order.items.length) return { skipped: 'Đơn không có sản phẩm' };
    const draft = (await this.create({ orderId }, actor)) as { id: string };
    await this.enqueueIssue(draft.id, delayMinutes);
    return { invoiceId: draft.id, created: true };
  }

  /** Phát hành hàng loạt theo danh sách đơn */
  async bulkIssue(dto: BulkIssueDto, actor: Actor) {
    const results: Record<string, unknown>[] = [];
    for (const orderId of dto.orderIds) {
      try {
        results.push({ orderId, ...(await this.queueForOrder(orderId, actor)) });
      } catch (err) {
        results.push({ orderId, error: (err as Error).message });
      }
    }
    return { results, queued: results.filter((r) => r.invoiceId).length };
  }

  // ---------------------------------------------------------------------------
  // Huỷ / thay thế / điều chỉnh
  // ---------------------------------------------------------------------------

  async cancel(id: string, dto: CancelEInvoiceDto, actor: Actor) {
    const inv = await this.find(id);
    if (!['ISSUED', 'ISSUING', 'ADJUSTED'].includes(inv.status)) throw new BadRequestException('Chỉ huỷ được hoá đơn đã phát hành');
    let raw: unknown = null;
    if (!dto.localOnly) {
      const { provider, cfg } = await this.activeProviderFor(inv.provider);
      try {
        const res = await provider.cancel(cfg, this.refOf(inv), dto.reason);
        raw = res.raw;
        if (!res.ok) throw new EInvoiceProviderError(res.message || 'Nhà cung cấp từ chối huỷ', res.raw);
      } catch (err) {
        await this.log(id, 'cancel', 'error', (err as Error).message, { reason: dto.reason }, this.safeJson((err as EInvoiceProviderError).raw), actor);
        throw new BadRequestException((err as Error).message);
      }
    }
    const updated = await this.prisma.eInvoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason } });
    await this.log(id, 'cancel', 'ok', `${dto.localOnly ? 'Đánh dấu huỷ (không gọi NCC)' : 'Đã huỷ'} — ${dto.reason}`, { reason: dto.reason, localOnly: !!dto.localOnly }, this.safeJson(raw), actor);
    this.activity(actor, 'einvoice.cancel', id, { orderId: inv.orderId, reason: dto.reason });
    this.events.emit('einvoice.cancelled', { invoice: updated, reason: dto.reason });
    await this.hooks.doAction('einvoice.cancelled', updated, dto.reason);
    return this.get(id);
  }

  /** Lập hoá đơn thay thế cho hoá đơn đã phát hành (hoặc đã huỷ) */
  async replace(id: string, dto: ReplaceEInvoiceDto, actor: Actor) {
    const orig = await this.find(id);
    if (!['ISSUED', 'CANCELLED', 'ADJUSTED'].includes(orig.status) || !orig.invoiceNo) throw new BadRequestException('Chỉ thay thế được hoá đơn đã có số');
    const dup = await this.prisma.eInvoice.findFirst({ where: { originalId: id, kind: 'REPLACEMENT', status: { in: ['DRAFT', 'QUEUED', 'ISSUING', 'ISSUED'] } }, select: { id: true } });
    if (dup) throw new BadRequestException('Hoá đơn này đã có hoá đơn thay thế');
    const s = await this.settings();
    const lines = dto.items?.length ? this.linesFromInput(dto.items, s) : (orig.items as unknown as InvoiceLine[]);
    const totals = summarize(lines, 0, orig.currency);
    const buyer = { ...(orig.buyer as object), ...Object.fromEntries(Object.entries(dto.buyer ?? {}).filter(([, v]) => v !== undefined)) };
    const inv = await this.prisma.eInvoice.create({
      data: {
        orderId: orig.orderId,
        provider: s.provider,
        kind: 'REPLACEMENT',
        status: 'DRAFT',
        originalId: orig.id,
        reason: dto.reason,
        templateCode: orig.templateCode ?? s.templateCode,
        serial: orig.serial ?? s.serial,
        seller: s.seller as unknown as Prisma.InputJsonValue,
        buyer: buyer as Prisma.InputJsonValue,
        items: lines as unknown as Prisma.InputJsonValue,
        currency: orig.currency,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        vatTotal: totals.vatTotal,
        total: totals.total,
        paymentMethod: orig.paymentMethod,
        note: dto.note ?? orig.note,
        createdById: actor.id === 'system' ? null : actor.id,
      },
    });
    await this.log(inv.id, 'create', 'ok', `Lập hoá đơn thay thế cho ${orig.serial ?? ''} ${orig.invoiceNo} — ${dto.reason}`, null, null, actor);
    if (dto.issueNow) return this.issue(inv.id, actor);
    return this.get(inv.id);
  }

  /** Lập hoá đơn điều chỉnh (tăng/giảm) cho hoá đơn đã phát hành */
  async adjust(id: string, dto: AdjustEInvoiceDto, actor: Actor) {
    const orig = await this.find(id);
    if (!['ISSUED', 'ADJUSTED'].includes(orig.status) || !orig.invoiceNo) throw new BadRequestException('Chỉ điều chỉnh được hoá đơn đã phát hành');
    const s = await this.settings();
    const lines = this.linesFromInput(dto.items.map((l) => ({ ...l, adjustment: l.adjustment ?? 'increase' })), s);
    const totals = summarize(lines, 0, orig.currency);
    const inv = await this.prisma.eInvoice.create({
      data: {
        orderId: orig.orderId,
        provider: s.provider,
        kind: 'ADJUSTMENT',
        status: 'DRAFT',
        originalId: orig.id,
        reason: dto.reason,
        templateCode: orig.templateCode ?? s.templateCode,
        serial: orig.serial ?? s.serial,
        seller: s.seller as unknown as Prisma.InputJsonValue,
        buyer: orig.buyer as Prisma.InputJsonValue,
        items: lines as unknown as Prisma.InputJsonValue,
        currency: orig.currency,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        vatTotal: totals.vatTotal,
        total: totals.total,
        paymentMethod: orig.paymentMethod,
        note: dto.note ?? null,
        createdById: actor.id === 'system' ? null : actor.id,
      },
    });
    await this.log(inv.id, 'create', 'ok', `Lập hoá đơn điều chỉnh cho ${orig.serial ?? ''} ${orig.invoiceNo} — ${dto.reason}`, null, null, actor);
    if (dto.issueNow) return this.issue(inv.id, actor);
    return this.get(inv.id);
  }

  // ---------------------------------------------------------------------------
  // Đồng bộ / nhập tay / file / email
  // ---------------------------------------------------------------------------

  /** Lấy trạng thái mới nhất từ NCC (số HĐ, mã CQT, đã huỷ...) */
  async sync(id: string, actor: Actor) {
    const inv = await this.find(id);
    if (!inv.providerRef) throw new BadRequestException('Hoá đơn chưa gửi nhà cung cấp');
    const { provider, cfg } = await this.activeProviderFor(inv.provider);
    if (!provider.sync) throw new BadRequestException(`${provider.meta.name} không hỗ trợ đồng bộ trạng thái`);
    try {
      const r = await provider.sync(cfg, this.refOf(inv));
      const data: Prisma.EInvoiceUpdateInput = {};
      if (r.invoiceNo) data.invoiceNo = r.invoiceNo;
      if (r.serial) data.serial = r.serial;
      if (r.templateCode) data.templateCode = r.templateCode;
      if (r.taxAuthorityCode) data.taxAuthorityCode = r.taxAuthorityCode;
      if (r.lookupCode) data.lookupCode = r.lookupCode;
      const ref = { ...this.refOf(inv), invoiceNo: r.invoiceNo ?? inv.invoiceNo, lookupCode: r.lookupCode ?? inv.lookupCode };
      const lookupUrl = r.lookupUrl ?? provider.lookupUrl?.(cfg, ref) ?? inv.lookupUrl;
      if (lookupUrl) data.lookupUrl = lookupUrl;
      let becameIssued = false;
      if (r.status === 'issued' && inv.status === 'ISSUING') {
        data.status = 'ISSUED';
        data.issuedAt = r.issuedAt ?? new Date();
        becameIssued = true;
      } else if (r.status === 'cancelled' && inv.status !== 'CANCELLED') {
        data.status = 'CANCELLED';
        data.cancelledAt = new Date();
        data.cancelReason = r.message ?? 'Huỷ trên hệ thống nhà cung cấp';
      } else if (r.status === 'rejected') {
        data.status = 'FAILED';
        data.errorMessage = r.message ?? 'Cơ quan thuế / NCC từ chối hoá đơn';
      }
      const updated = await this.prisma.eInvoice.update({ where: { id }, data });
      await this.log(id, 'sync', 'ok', `Đồng bộ: ${r.status}${r.message ? ` — ${r.message}` : ''}`, null, this.safeJson(r.raw), actor);
      if (becameIssued) await this.afterIssued(updated, actor);
      // vẫn đang chờ -> hẹn sync lại
      if (r.status === 'pending' && updated.status === 'ISSUING') await this.jobs.enqueue('einvoice.sync', { invoiceId: id }, { runAt: new Date(Date.now() + 2 * 60_000), maxAttempts: 10, dedupeKey: `einvoice.sync:${id}` });
      return this.get(id);
    } catch (err) {
      await this.log(id, 'sync', 'error', (err as Error).message, null, this.safeJson((err as EInvoiceProviderError).raw), actor);
      throw err instanceof EInvoiceProviderError && !err.retryable ? new BadRequestException(err.message) : err;
    }
  }

  /** Nhập tay kết quả phát hành (NCC "manual" hoặc khi NCC trả pending mà admin đã thấy số trên cổng) */
  async setManualResult(id: string, dto: ManualResultDto, actor: Actor) {
    const inv = await this.find(id);
    if (!['DRAFT', 'QUEUED', 'ISSUING', 'FAILED'].includes(inv.status)) throw new BadRequestException('Hoá đơn đã có kết quả phát hành');
    const s = await this.settings();
    // link tra cứu: admin nhập, không thì để adapter dựng từ mã tra cứu (vd NCC nhập tay có lookupBaseUrl)
    let lookupUrl = dto.lookupUrl ?? null;
    if (!lookupUrl) {
      const providerKey = inv.provider === 'none' ? s.provider : inv.provider;
      const adapter = this.registry.get(providerKey);
      const cfg = this.registry.buildConfig(providerKey, s);
      if (adapter?.lookupUrl && cfg) lookupUrl = adapter.lookupUrl(cfg, { ...this.refOf(inv), invoiceNo: dto.invoiceNo, serial: dto.serial ?? inv.serial ?? s.serial, lookupCode: dto.lookupCode ?? null });
    }
    const updated = await this.prisma.eInvoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        provider: inv.provider === 'none' ? s.provider : inv.provider,
        providerRef: inv.providerRef ?? `manual:${id}`,
        invoiceNo: dto.invoiceNo,
        serial: dto.serial ?? inv.serial ?? s.serial,
        templateCode: dto.templateCode ?? inv.templateCode ?? s.templateCode,
        taxAuthorityCode: dto.taxAuthorityCode ?? null,
        lookupCode: dto.lookupCode ?? null,
        lookupUrl,
        issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : new Date(),
        seller: (Object.keys(inv.seller as object).length ? inv.seller : (s.seller as unknown)) as Prisma.InputJsonValue,
        errorMessage: null,
      },
    });
    await this.log(id, 'issue', 'ok', `Nhập tay số hoá đơn ${dto.serial ?? ''} ${dto.invoiceNo} bởi ${actor.name}`, dto as object, null, actor);
    await this.afterIssued(updated, actor);
    return this.get(id);
  }

  /** Lấy PDF/XML: ưu tiên file đã lưu trong storage, chưa có thì tải từ NCC và lưu lại */
  async getFile(id: string, type: 'pdf' | 'xml'): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const inv = await this.find(id);
    const path = type === 'pdf' ? inv.pdfPath : inv.xmlPath;
    const fileName = `HD-${inv.serial ?? ''}-${inv.invoiceNo ?? inv.id.slice(0, 8)}.${type}`.replace(/\s+/g, '');
    const mimeType = type === 'pdf' ? 'application/pdf' : 'application/xml';
    if (path) {
      let buffer: Buffer | null = null;
      try {
        buffer = await this.storage.get(path);
      } catch {
        /* file mất -> tải lại */
      }
      if (buffer) {
        // Bản cũ lưu ở `einvoices/...` nằm trong vùng /uploads phục vụ công khai -> chuyển sang `private/...`
        // (không phục vụ tĩnh) để ai đoán được đường dẫn cũng không tải được hoá đơn của người khác
        if (!path.startsWith('private/')) await this.moveToPrivate(id, type, path, buffer, mimeType, inv.createdAt);
        return { buffer, mimeType, fileName };
      }
    }
    if (!inv.providerRef) throw new BadRequestException('Hoá đơn chưa phát hành');
    const { provider, cfg } = await this.activeProviderFor(inv.provider);
    const fn = type === 'pdf' ? provider.getPdf : provider.getXml;
    if (!fn) throw new BadRequestException(`${provider.meta.name} không hỗ trợ tải ${type.toUpperCase()} qua API`);
    try {
      const file = await fn.call(provider, cfg, this.refOf(inv));
      const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
      // Lưu dưới `private/` — thư mục không được phục vụ tĩnh qua /uploads, chỉ đọc qua API có kiểm quyền
      const key = this.privateKey(inv.id, type, inv.createdAt);
      await this.storage.put(key, buffer, file.mimeType);
      await this.prisma.eInvoice.update({ where: { id }, data: type === 'pdf' ? { pdfPath: key } : { xmlPath: key } });
      await this.log(id, 'download', 'ok', `Đã tải ${type.toUpperCase()} (${buffer.length} bytes)`, null, null, SYSTEM);
      return { buffer, mimeType: file.mimeType, fileName: file.fileName ?? fileName };
    } catch (err) {
      await this.log(id, 'download', 'error', (err as Error).message, null, this.safeJson((err as EInvoiceProviderError).raw), SYSTEM);
      throw err instanceof EInvoiceProviderError && !err.retryable ? new BadRequestException(err.message) : err;
    }
  }

  /** Key lưu file hoá đơn trong storage: luôn nằm dưới `private/` (không công khai) */
  private privateKey(id: string, type: 'pdf' | 'xml', createdAt: Date) {
    return `private/einvoices/${createdAt.getFullYear()}/${id}.${type}`;
  }

  /**
   * Di chuyển file hoá đơn lưu theo đường dẫn cũ (công khai) sang key private:
   * ghi bản mới -> cập nhật pdfPath/xmlPath -> xoá file cũ. Lỗi ở bất kỳ bước nào chỉ ghi log,
   * không làm hỏng việc trả file cho người đang tải (lần sau sẽ thử lại).
   */
  private async moveToPrivate(id: string, type: 'pdf' | 'xml', oldPath: string, buffer: Buffer, mimeType: string, createdAt: Date) {
    const key = this.privateKey(id, type, createdAt);
    try {
      await this.storage.put(key, buffer, mimeType);
      await this.prisma.eInvoice.update({ where: { id }, data: type === 'pdf' ? { pdfPath: key } : { xmlPath: key } });
    } catch (e) {
      this.logger.warn(`Không chuyển được ${type.toUpperCase()} hoá đơn ${id} sang thư mục private: ${(e as Error).message}`);
      return;
    }
    try {
      await this.storage.delete(oldPath);
    } catch {
      /* xoá file cũ lỗi (đã mất, quyền...) thì bỏ qua — DB đã trỏ sang key private */
    }
  }

  /** Gửi email hoá đơn cho khách (mẫu `einvoice.issued`, đính kèm PDF nếu có) */
  async sendEmail(id: string, dto: SendEInvoiceEmailDto, actor: Actor) {
    const inv = await this.prisma.eInvoice.findUnique({ where: { id }, include: { order: { include: { items: true } } } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    if (inv.status !== 'ISSUED' && inv.status !== 'ADJUSTED') throw new BadRequestException('Hoá đơn chưa phát hành');
    const buyer = inv.buyer as unknown as InvoiceBuyer;
    const to = dto.to || buyer.email || inv.order?.customerEmail;
    if (!to) throw new BadRequestException('Không có email người nhận');
    let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
    if (dto.attachPdf !== false) {
      try {
        const f = await this.getFile(id, 'pdf');
        attachments = [{ filename: f.fileName, content: f.buffer, contentType: 'application/pdf' }];
      } catch {
        /* không có PDF thì gửi link tra cứu */
      }
    }
    const provider = this.registry.get(inv.provider);
    const locale = inv.order?.locale ?? undefined;
    const vars = {
      order: inv.order ? await this.mail.orderVars(inv.order, locale) : { code: '', customerName: buyer.name },
      invoice: { invoiceNo: inv.invoiceNo, serial: inv.serial, templateCode: inv.templateCode, taxAuthorityCode: inv.taxAuthorityCode, lookupCode: inv.lookupCode, lookupUrl: inv.lookupUrl, total: Number(inv.total), issuedAt: inv.issuedAt, buyerName: buyer.legalName || buyer.name, buyerTaxCode: buyer.taxCode ?? '', providerName: provider?.meta.name ?? inv.provider },
    };
    // gửi ngay: đã chạy trong job einvoice.email (có thử lại riêng) và cần biết kết quả để ghi emailSentAt
    const res = await this.mail.sendTemplate({ key: 'einvoice.issued', locale, to, vars, attachments, meta: { einvoiceId: id, orderId: inv.orderId }, immediate: true });
    if (res.status === 'SENT') await this.prisma.eInvoice.update({ where: { id }, data: { emailSentAt: new Date() } });
    await this.log(id, 'email', res.status === 'FAILED' ? 'error' : 'ok', res.status === 'SENT' ? `Đã gửi email tới ${to}` : res.status === 'SKIPPED' ? `Bỏ qua: ${res.reason}` : res.status === 'QUEUED' ? `Đã xếp hàng gửi tới ${to}` : `Lỗi: ${res.error}`, { to, attachPdf: !!attachments }, null, actor);
    if (res.status === 'FAILED') throw new BadRequestException(res.error);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Bản thể hiện HTML & bảng kê CSV
  // ---------------------------------------------------------------------------

  /** HTML bản thể hiện hoá đơn để in / lưu PDF từ trình duyệt */
  async printHtml(id: string): Promise<string> {
    const inv = await this.prisma.eInvoice.findUnique({ where: { id }, include: { original: { select: { invoiceNo: true, serial: true, templateCode: true, issuedAt: true } } } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    const general = await this.settingsService.get<{ siteName?: Record<string, string> | string }>('general');
    const siteName = typeof general.siteName === 'string' ? general.siteName : general.siteName?.vi ?? Object.values(general.siteName ?? {})[0] ?? '';
    const provider = this.registry.get(inv.provider);
    return renderInvoiceHtml(inv, { siteName, providerName: provider?.meta.name, hasOfficialPdf: !!inv.pdfPath, original: inv.original });
  }

  /** Thành viên xem bản thể hiện hoá đơn của chính mình */
  async customerPrintHtml(userId: string, id: string): Promise<string> {
    const inv = await this.prisma.eInvoice.findFirst({ where: { id, order: { userId }, status: { in: CUSTOMER_VISIBLE } }, select: { id: true } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    return this.printHtml(id);
  }

  /** Bảng kê hoá đơn (CSV, có BOM cho Excel) theo bộ lọc danh sách — dùng cho kế toán kê khai thuế */
  async exportCsv(q: EInvoiceQueryDto): Promise<{ filename: string; content: string }> {
    const all: Record<string, unknown>[] = [];
    let page = 1;
    // lấy tối đa 10.000 dòng theo trang để không quá tải
    while (page <= 50) {
      const res = await this.list({ ...q, page, limit: 200 });
      all.push(...(res.data as Record<string, unknown>[]));
      if (page >= res.meta.totalPages) break;
      page++;
    }
    const header = ['Số HĐ', 'Ký hiệu', 'Mẫu số', 'Loại', 'Trạng thái', 'Ngày lập', 'Ngày phát hành', 'Mã CQT', 'Mã tra cứu', 'Mã đơn hàng', 'Tên người mua', 'Đơn vị', 'MST người mua', 'Địa chỉ', 'Email', 'Tiền hàng chưa thuế', 'Tiền thuế', 'Tổng thanh toán', 'Tiền tệ', 'Hình thức TT', 'NCC', 'Lý do huỷ / thay thế', 'Ghi chú'];
    const kind: Record<string, string> = { ORIGINAL: 'Gốc', REPLACEMENT: 'Thay thế', ADJUSTMENT: 'Điều chỉnh' };
    const status: Record<string, string> = { DRAFT: 'Nháp', QUEUED: 'Chờ phát hành', ISSUING: 'Đang phát hành', ISSUED: 'Đã phát hành', CANCELLED: 'Đã huỷ', REPLACED: 'Đã bị thay thế', ADJUSTED: 'Đã điều chỉnh', FAILED: 'Lỗi' };
    const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('vi-VN') : '');
    const rows = all.map((r) => {
      const b = (r.buyer ?? {}) as InvoiceBuyer;
      const o = (r.order ?? null) as { code?: string } | null;
      return [r.invoiceNo, r.serial, r.templateCode, kind[String(r.kind)] ?? r.kind, status[String(r.status)] ?? r.status, fmt(r.invoiceDate), fmt(r.issuedAt), r.taxAuthorityCode, r.lookupCode, o?.code, b.name, b.legalName, b.taxCode, b.address, b.email, Number(r.subtotal ?? 0), Number(r.vatTotal ?? 0), Number(r.total ?? 0), r.currency, r.paymentMethod, this.registry.get(String(r.provider))?.meta.name ?? r.provider, r.cancelReason || r.reason, r.note];
    });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return { filename: `bang-ke-hoa-don-${stamp}.csv`, content: toCsv([header, ...rows]) };
  }

  // ---------------------------------------------------------------------------
  // Truy vấn
  // ---------------------------------------------------------------------------

  async list(q: EInvoiceQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.EInvoiceWhereInput = {};
    if (q.status && q.status !== 'all') where.status = q.status === 'needsAction' ? { in: ['DRAFT', 'FAILED'] } : (q.status as EInvoice['status']);
    if (q.provider) where.provider = q.provider;
    if (q.orderId) where.orderId = q.orderId;
    if (q.kind) where.kind = q.kind as EInvoice['kind'];
    if (q.from || q.to) where.createdAt = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    if (q.search) {
      const s = q.search.trim();
      where.OR = [{ invoiceNo: { contains: s, mode: 'insensitive' } }, { taxAuthorityCode: { contains: s, mode: 'insensitive' } }, { lookupCode: { contains: s, mode: 'insensitive' } }, { order: { code: { contains: s, mode: 'insensitive' } } }, { buyer: { path: ['taxCode'], string_contains: s } }, { buyer: { path: ['name'], string_contains: s } }, { buyer: { path: ['legalName'], string_contains: s } }];
    }
    const [data, total] = await Promise.all([
      this.prisma.eInvoice.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { order: { select: { id: true, code: true, customerName: true, total: true, status: true, paymentStatus: true } } } }),
      this.prisma.eInvoice.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  /** Thống kê nhanh cho trang danh sách / dashboard */
  async stats() {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [byStatus, month] = await Promise.all([
      this.prisma.eInvoice.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.eInvoice.aggregate({ where: { status: { in: ['ISSUED', 'ADJUSTED'] }, issuedAt: { gte: monthStart } }, _count: { _all: true }, _sum: { total: true, vatTotal: true } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
    return { counts, needsAction: (counts.DRAFT ?? 0) + (counts.FAILED ?? 0), month: { count: month._count._all, total: Number(month._sum.total ?? 0), vat: Number(month._sum.vatTotal ?? 0) } };
  }

  async get(id: string) {
    const inv = await this.prisma.eInvoice.findUnique({
      where: { id },
      include: {
        order: { select: { id: true, code: true, customerName: true, customerEmail: true, customerPhone: true, total: true, status: true, paymentStatus: true, paymentMethod: true, invoiceRequest: true, createdAt: true } },
        original: { select: { id: true, invoiceNo: true, serial: true, templateCode: true, status: true, issuedAt: true } },
        derived: { select: { id: true, kind: true, invoiceNo: true, serial: true, status: true, issuedAt: true, total: true, reason: true }, orderBy: { createdAt: 'desc' } },
        logs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    const provider = this.registry.get(inv.provider);
    const actorIds = [...new Set(inv.logs.map((l) => l.actorId).filter((x): x is string => !!x))];
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u.name]));
    return { ...inv, providerName: provider?.meta.name ?? inv.provider, capabilities: provider?.meta.capabilities ?? null, logs: inv.logs.map((l) => ({ ...l, actorName: l.actorId ? byId.get(l.actorId) ?? null : 'Hệ thống' })) };
  }

  /** Hoá đơn của một đơn (admin: mọi trạng thái) */
  forOrder(orderId: string) {
    return this.prisma.eInvoice.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' }, select: { ...CUSTOMER_SELECT, errorMessage: true, reason: true, originalId: true, createdAt: true } });
  }

  /** Hoá đơn khách nhìn thấy trên storefront/tài khoản */
  async forCustomerOrder(orderId: string) {
    const rows = await this.prisma.eInvoice.findMany({ where: { orderId, status: { in: CUSTOMER_VISIBLE } }, orderBy: { createdAt: 'desc' }, select: CUSTOMER_SELECT });
    return rows.map((r) => this.toCustomerView(r));
  }

  /** Thành viên tải PDF hoá đơn của chính mình */
  async customerFile(userId: string, id: string, type: 'pdf' | 'xml') {
    const inv = await this.prisma.eInvoice.findFirst({ where: { id, order: { userId }, status: { in: CUSTOMER_VISIBLE } }, select: { id: true } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    return this.getFile(id, type);
  }

  /** Danh sách hoá đơn của thành viên */
  async customerList(userId: string, q: { page?: number; limit?: number }) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.EInvoiceWhereInput = { order: { userId }, status: { in: CUSTOMER_VISIBLE } };
    const [rows, total] = await Promise.all([
      this.prisma.eInvoice.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, select: { ...CUSTOMER_SELECT, order: { select: { code: true, createdAt: true } } } }),
      this.prisma.eInvoice.count({ where }),
    ]);
    return paginate(rows.map((r) => ({ ...this.toCustomerView(r), order: r.order })), total, page, limit);
  }

  private toCustomerView<T extends { pdfPath?: string | null; buyer?: unknown; provider?: string; total?: unknown }>(r: T) {
    const { pdfPath, buyer, provider, ...rest } = r;
    const b = (buyer ?? {}) as InvoiceBuyer;
    return { ...rest, total: Number(r.total ?? 0), hasPdf: !!pdfPath, providerName: this.registry.get(provider ?? '')?.meta.name ?? provider, buyer: { name: b.legalName || b.name, taxCode: b.taxCode ?? null, address: b.address ?? null, email: b.email ?? null } };
  }

  /** Khách cập nhật thông tin xuất HĐ cho đơn của mình (trước khi phát hành) */
  async updateInvoiceRequest(orderId: string, dto: InvoiceRequestDto) {
    const issued = await this.prisma.eInvoice.findFirst({ where: { orderId, status: { in: ['QUEUED', 'ISSUING', 'ISSUED'] } }, select: { id: true } });
    if (issued) throw new BadRequestException('Hoá đơn đã được phát hành, vui lòng liên hệ cửa hàng để điều chỉnh');
    const req = this.normalizeInvoiceRequest(dto);
    await this.prisma.order.update({ where: { id: orderId }, data: { invoiceRequest: req as unknown as Prisma.InputJsonValue } });
    // đồng bộ vào nháp đang chờ (nếu có)
    const draft = await this.prisma.eInvoice.findFirst({ where: { orderId, status: { in: ['DRAFT', 'FAILED'] } } });
    if (draft) {
      const order = await this.loadOrder(orderId);
      await this.prisma.eInvoice.update({ where: { id: draft.id }, data: { buyer: this.buyerFromOrder(order) as unknown as Prisma.InputJsonValue } });
    }
    return req;
  }

  /** Thành viên cập nhật yêu cầu xuất HĐ cho đơn của chính mình */
  async updateInvoiceRequestForUser(userId: string, orderId: string, dto: InvoiceRequestDto) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return this.updateInvoiceRequest(orderId, dto);
  }

  /** Chuẩn hoá & kiểm tra yêu cầu xuất HĐ (dùng chung với checkout) */
  normalizeInvoiceRequest(dto: InvoiceRequestDto | null | undefined, requireTaxCode = true): InvoiceRequest | null {
    return normalizeInvoiceRequest(dto, requireTaxCode);
  }

  // ---------------------------------------------------------------------------
  // Tự động theo sự kiện đơn hàng
  // ---------------------------------------------------------------------------

  @OnEvent('order.paid', { async: true })
  async onOrderPaid(e: { order: Order }) {
    await this.maybeAutoIssue(e.order, 'paid').catch((err) => this.logger.warn(`Tự động xuất HĐ (paid) lỗi: ${(err as Error).message}`));
  }

  @OnEvent('order.statusChanged', { async: true })
  async onOrderStatusChanged(e: { order: Order; from: string; to: string }) {
    if (e.to === 'COMPLETED') await this.maybeAutoIssue(e.order, 'completed').catch((err) => this.logger.warn(`Tự động xuất HĐ (completed) lỗi: ${(err as Error).message}`));
    if (e.to === 'CANCELLED' || e.to === 'REFUNDED') await this.maybeAutoCancel(e.order, `Đơn hàng ${e.to === 'CANCELLED' ? 'bị huỷ' : 'được hoàn tiền'}`).catch((err) => this.logger.warn(`Tự động huỷ HĐ lỗi: ${(err as Error).message}`));
  }

  @OnEvent('order.refunded', { async: true })
  async onOrderRefunded(e: { order: Order }) {
    if (e.order.paymentStatus === 'REFUNDED') await this.maybeAutoCancel(e.order, 'Đơn hàng được hoàn tiền toàn bộ').catch((err) => this.logger.warn(`Tự động huỷ HĐ lỗi: ${(err as Error).message}`));
  }

  private async maybeAutoIssue(order: Order, trigger: 'paid' | 'completed') {
    const s = await this.settings();
    if (s.autoIssue !== trigger || !s.provider || s.provider === 'none') return;
    const req = order.invoiceRequest as InvoiceRequest | null;
    if (s.autoIssueOnlyWhenRequested && !req?.requested) return;
    if (order.paymentStatus !== 'PAID' && trigger === 'completed' && order.paymentMethod !== 'cod') return;
    const r = await this.queueForOrder(order.id, SYSTEM, s.autoIssueDelayMinutes);
    if ('invoiceId' in r) this.logger.log(`Đã xếp hàng phát hành HĐ cho đơn ${order.code} (${trigger})`);
  }

  private async maybeAutoCancel(order: Order, reason: string) {
    const s = await this.settings();
    if (!s.autoCancelOnRefund) return;
    const issued = await this.prisma.eInvoice.findMany({ where: { orderId: order.id, status: 'ISSUED' }, select: { id: true } });
    for (const inv of issued) await this.cancel(inv.id, { reason }, SYSTEM).catch((err) => this.logger.warn(`Huỷ HĐ ${inv.id} lỗi: ${(err as Error).message}`));
    // nháp chưa phát hành thì xoá luôn
    await this.prisma.eInvoice.deleteMany({ where: { orderId: order.id, status: { in: ['DRAFT', 'QUEUED'] }, invoiceNo: null } });
  }

  /** Hoá đơn treo ISSUING quá 5 phút -> hẹn đồng bộ lại (NCC có thể chậm cấp mã) */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async requeueStuck() {
    if (process.env.NODE_ENV === 'test') return;
    const stuck = await this.prisma.eInvoice.findMany({ where: { status: 'ISSUING', providerRef: { not: null }, updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, select: { id: true, provider: true }, take: 50 });
    for (const inv of stuck) {
      if (!this.registry.get(inv.provider)?.sync) continue;
      await this.jobs.enqueue('einvoice.sync', { invoiceId: inv.id }, { dedupeKey: `einvoice.sync:${inv.id}`, maxAttempts: 10 });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async find(id: string) {
    const inv = await this.prisma.eInvoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException('Không tìm thấy hoá đơn');
    return inv;
  }

  private refOf(inv: EInvoice): InvoiceRef {
    return { id: inv.id, providerRef: inv.providerRef, invoiceNo: inv.invoiceNo, serial: inv.serial, templateCode: inv.templateCode, lookupCode: inv.lookupCode, issuedAt: inv.issuedAt, meta: (inv.meta as Record<string, unknown>) ?? {} };
  }

  /** Adapter theo key đã lưu trên hoá đơn (có thể khác NCC đang chọn khi đã đổi NCC) */
  private async activeProviderFor(key: string) {
    const s = await this.settings();
    if (!key || key === s.provider || key === 'none') return this.activeProvider(s);
    const provider = this.registry.get(key);
    if (!provider) throw new BadRequestException(`Nhà cung cấp "${key}" của hoá đơn này không còn khả dụng`);
    const cfg = this.registry.buildConfig(key, s)!;
    return { key, provider, cfg, settings: s };
  }

  private async log(invoiceId: string, action: string, status: 'ok' | 'error', message: string | null, request: unknown, response: unknown, actor: Actor) {
    await this.prisma.eInvoiceLog
      .create({ data: { invoiceId, action, status, message: message?.slice(0, 2000) ?? null, request: (request ?? undefined) as Prisma.InputJsonValue | undefined, response: (response ?? undefined) as Prisma.InputJsonValue | undefined, actorId: actor.id === 'system' ? null : actor.id } })
      .catch((err) => this.logger.warn(`Ghi log HĐ lỗi: ${(err as Error).message}`));
  }

  private activity(actor: Actor, action: string, entityId: string, meta: Record<string, unknown>) {
    this.events.emit('activity', { userId: actor.id === 'system' ? null : actor.id, action, entityType: 'einvoice', entityId, meta });
  }

  /** Cắt gọn dữ liệu thô để ghi JSON (tránh Buffer, vòng lặp, quá lớn) */
  private safeJson(v: unknown): unknown {
    if (v === undefined || v === null) return null;
    try {
      const s = JSON.stringify(v, (_k, val) => (Buffer.isBuffer(val) ? `<buffer ${val.length}b>` : typeof val === 'string' && val.length > 20_000 ? `${val.slice(0, 20_000)}…` : val));
      return s.length > 200_000 ? { truncated: s.slice(0, 200_000) } : JSON.parse(s);
    } catch {
      return { unserializable: String(v).slice(0, 1000) };
    }
  }
}
