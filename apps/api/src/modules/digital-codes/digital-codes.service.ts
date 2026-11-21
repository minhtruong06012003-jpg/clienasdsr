import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  codePreview,
  hasPermission,
  normalizeCodeFields,
  pickText,
  readDigitalSettings,
  splitCodeParts,
  type AdminDigitalCode,
  type AdminOrderCodes,
  type CodeFieldDef,
  type CodeReportStatus,
  type CustomerCode,
  type DigitalImportResult,
  type DigitalSettings,
  type DigitalStockRow,
  type DigitalStockSummary,
  type OrderCodeStatus,
  type OrderCodesView,
  type PurchaseFieldValue,
} from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma, type DigitalCode, type DigitalCodeStatus } from '../../generated/prisma/client.js';
import { paginate, pageArgs } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { frontendLocaleBaseUrl } from '../../common/utils/frontend-url.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MailService } from '../mail/mail.service.js';
import { optionsText } from '../mail/order-vars.js';
import { HooksService } from '../hooks/hooks.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import { decryptCode, deriveCodeKeys, encryptCode, hashCode, normalizeCode, type CodeKeys } from './digital-codes.crypto.js';
import {
  MAX_CODE_LENGTH,
  MAX_IMPORT_CODES,
  type BulkDigitalCodesDto,
  type DigitalCodeQueryDto,
  type ImportDigitalCodesDto,
  type ManualCodeDto,
  type ReplaceCodeDto,
  type ResolveReportDto,
  type RevokeCodeDto,
  type UpdateDigitalCodeDto,
} from './digital-codes.dto.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

/** Trạng thái thanh toán coi là "đã trả tiền" (được giao / xem mã) */
const PAID_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];
/** Đơn đã đóng: không giao thêm mã */
const CLOSED_STATUSES = ['CANCELLED', 'REFUNDED'];
/** Trạng thái đơn còn mở, được phép tự chuyển "Hoàn thành" */
const OPEN_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING'];
/** Mã sắp hết hạn trong khoảng này được đếm vào expiringSoon */
const EXPIRING_SOON_MS = 30 * 86_400_000;
/** Người thực hiện khi hệ thống tự thao tác (tự hoàn thành đơn) */
const SYSTEM_ACTOR = { id: 'system', name: 'Hệ thống', email: '', roleId: '', roleSlug: 'system', permissions: [] } as AuthUser;

/** Thông tin sản phẩm cần cho kho mã (tên, nhãn phần mã, biến thể, hướng dẫn) */
const PRODUCT_INFO_SELECT = {
  id: true,
  type: true,
  sku: true,
  codeDelivery: true,
  codeFields: true,
  codeWarrantyDays: true,
  stockStatus: true,
  stockQuantity: true,
  manageStock: true,
  options: true,
  deletedAt: true,
  translations: { select: { locale: true, name: true, deliveryNote: true } },
  variants: { select: { id: true, sku: true, optionValues: true, stockStatus: true, stockQuantity: true, isActive: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProductSelect;
type ProductInfo = Prisma.ProductGetPayload<{ select: typeof PRODUCT_INFO_SELECT }>;

/** Bản ghi mã kèm mã đơn (cho bản admin) */
type CodeRow = DigitalCode & { order?: { code: string } | null };
type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;
type OrderItemRow = OrderWithItems['items'][number];

/** Ghi chú gắn vào mã không giải mã được (bị chuyển Tạm khoá khi chọn để giao) */
const UNDECRYPTABLE_NOTE = 'Không giải mã được (sai DIGITAL_CODES_KEY?)';
/** Số lần báo lỗi tối đa trong một chuỗi đổi mã (mã gốc + các mã thay thế) */
const MAX_REPORTS = 3;
/** Số bước tối đa đi ngược chuỗi replacesId để tìm mã gốc */
const CHAIN_MAX_DEPTH = 10;
/** Dữ liệu tối thiểu để dựng chuỗi đổi mã */
type ChainRow = { id: string; replacesId: string | null; soldAt: Date | null; reportStatus: string | null };
/** Thông tin chuỗi đổi mã của một mã: soldAt của mã gốc + số lần đã báo lỗi trong cả chuỗi */
type ChainInfo = { rootSoldAt: Date | null; reports: number };

/** Mức tồn trước / sau của một biến thể (null = sản phẩm không biến thể) — dùng để cảnh báo sắp hết */
type StockChange = { variantId: string | null; before: number; after: number };
/** Cảnh báo kho gom lại trong transaction checkout, chờ đơn commit xong (sự kiện order.created) mới gửi */
type PendingAlert = { at: number; items: { productId: string; changes: StockChange[] }[] };
/** Cảnh báo chờ quá lâu (transaction đã rollback, không có order.created) thì bỏ */
const PENDING_ALERT_TTL_MS = 10 * 60_000;

/** Kết quả giao mã cho một đơn */
export interface DeliverResult {
  /** số mã vừa chuyển sang SOLD */
  delivered: number;
  /** số mã còn thiếu sau lần giao này */
  missing: number;
  codeStatus: OrderCodeStatus | null;
}

/** Chọn chữ theo locale từ danh sách bản dịch */
function trOf<T extends { locale: string }>(list: T[], locale: string): T | undefined {
  return list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === 'vi') ?? list[0];
}

/** Nhãn biến thể "Gói: 1 tháng, Máy chủ: Asia" từ optionValues + định nghĩa options của sản phẩm */
export function variantLabelOf(options: unknown, optionValues: unknown, locale = 'vi'): string | null {
  if (!optionValues || typeof optionValues !== 'object' || Array.isArray(optionValues)) return null;
  const defs = (Array.isArray(options) ? options : []) as { key?: string; name?: unknown; values?: { value?: string; label?: unknown }[] }[];
  const parts = Object.entries(optionValues as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const def = defs.find((d) => d?.key === k);
      const name = def ? pickText(def.name as Record<string, string>, locale) || k : k;
      const val = def?.values?.find((x) => x?.value === String(v));
      return `${name}: ${val ? pickText(val.label as Record<string, string>, locale) || String(v) : String(v)}`;
    });
  return parts.length ? parts.join(', ') : null;
}

/** Ô CSV an toàn: chặn chèn công thức Excel (=, +, -, @) */
function csvCell(v: unknown): string {
  let s = v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kho mã số: nhập / mã hoá / giữ / giao / đổi / thu hồi mã; tồn kho sản phẩm = số mã AVAILABLE chưa hết hạn.
 * Module khác dùng: `reserveForOrder` (checkout, admin tạo đơn — chạy trong transaction), `syncStock`, `productStats`.
 * Lắng nghe: order.created / order.paid (giao mã), order.statusChanged / order.refunded (nhả mã giữ), order.itemsChanged (đối soát).
 */
@Injectable()
export class DigitalCodesService {
  private readonly logger = new Logger('DigitalCodes');
  private keysCache: CodeKeys | null = null;
  /** Cảnh báo sắp hết kho theo orderId, gom trong reserveForOrder (transaction chưa commit) — xử lý ở onOrderCreated */
  private readonly pendingAlerts = new Map<string, PendingAlert>();
  /** Mốc lần chạy syncExpired trước (lưu trong bộ nhớ); lần đầu sau khởi động = 30 ngày trước */
  private lastExpiredSync: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly moduleRef: ModuleRef,
    /** tra ngôn ngữ mặc định để gắn tiền tố ngôn ngữ vào link xem mã (tuỳ chọn để test dựng service dễ) */
    private readonly languages?: LanguagesService,
  ) {}

  // ===========================================================================
  // Mã hoá
  // ===========================================================================

  /** Bộ khoá hiện tại (DIGITAL_CODES_KEY hoặc dẫn xuất từ JWT_ACCESS_SECRET), tính 1 lần */
  private get keys(): CodeKeys {
    if (!this.keysCache) {
      const own = this.config.get<string>('DIGITAL_CODES_KEY') ?? process.env.DIGITAL_CODES_KEY ?? '';
      this.keysCache = deriveCodeKeys(own, this.config.get<string>('jwt.accessSecret') ?? '');
    }
    return this.keysCache;
  }

  /** Đang dùng khoá riêng DIGITAL_CODES_KEY hay khoá dẫn xuất từ JWT (Site Health) */
  keySource(): 'env' | 'jwt' {
    return this.keys.source;
  }

  private encrypt(plain: string) {
    return encryptCode(plain, this.keys);
  }

  /** Giải mã; lỗi (đổi khoá) -> chuỗi rỗng + log cảnh báo, không làm sập cả danh sách */
  private decrypt(row: { id: string; content: string }): string {
    const out = decryptCode(row.content, this.keys);
    if (out === null) {
      this.logger.warn(`Không giải mã được mã ${row.id} (khoá DIGITAL_CODES_KEY / JWT_ACCESS_SECRET đã đổi?)`);
      return '';
    }
    return out;
  }

  private hash(normalized: string) {
    return hashCode(normalized, this.keys);
  }

  /** Hash cho mã nhập tay: gắn hậu tố ngẫu nhiên để không đụng unique (productId, contentHash) */
  private manualHash(normalized: string) {
    return `${this.hash(normalized)}:${randomUUID().slice(0, 8)}`;
  }

  private async digitalSettings(): Promise<DigitalSettings> {
    return readDigitalSettings(await this.settings.get('digital'));
  }

  // ===========================================================================
  // Thông tin sản phẩm / trình bày
  // ===========================================================================

  private async productInfos(ids: (string | null | undefined)[], db: Db = this.prisma): Promise<Map<string, ProductInfo>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = await db.product.findMany({ where: { id: { in: uniq } }, select: PRODUCT_INFO_SELECT });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private productName(p: ProductInfo | undefined, locale = 'vi', fallback = '') {
    if (!p) return fallback;
    return trOf(p.translations, locale)?.name ?? fallback ?? p.sku ?? '';
  }

  private variantLabel(p: ProductInfo | undefined, variantId: string | null, locale = 'vi', fallbackValues?: unknown): string | null {
    const v = variantId ? p?.variants.find((x) => x.id === variantId) : undefined;
    if (v) return variantLabelOf(p?.options, v.optionValues, locale) ?? v.sku ?? null;
    if (fallbackValues) return optionsText(fallbackValues) || null;
    return null;
  }

  private codeFieldsOf(p: ProductInfo | undefined): CodeFieldDef[] {
    return normalizeCodeFields(p?.codeFields);
  }

  /** Bản admin (chỉ bản che, không có nội dung) */
  private toAdmin(row: CodeRow, infos: Map<string, ProductInfo>): AdminDigitalCode {
    const p = infos.get(row.productId);
    return {
      id: row.id,
      productId: row.productId,
      productName: this.productName(p, 'vi', row.productId.slice(0, 8)),
      variantId: row.variantId,
      variantLabel: this.variantLabel(p, row.variantId),
      preview: row.preview,
      status: row.status,
      batch: row.batch,
      note: row.note,
      costPrice: row.costPrice == null ? null : Number(row.costPrice),
      expiresAt: iso(row.expiresAt),
      source: row.source,
      orderId: row.orderId,
      orderCode: row.order?.code ?? null,
      orderItemId: row.orderItemId,
      reservedAt: iso(row.reservedAt),
      soldAt: iso(row.soldAt),
      viewedAt: iso(row.viewedAt),
      reportStatus: (row.reportStatus as CodeReportStatus | null) ?? null,
      reportNote: row.reportNote,
      reportedAt: iso(row.reportedAt),
      reportReply: row.reportReply,
      revokedAt: iso(row.revokedAt),
      revokeReason: row.revokeReason,
      replacesId: row.replacesId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async presentAdmin(rows: CodeRow[]): Promise<AdminDigitalCode[]> {
    const infos = await this.productInfos(rows.map((r) => r.productId));
    return rows.map((r) => this.toAdmin(r, infos));
  }

  private async adminById(id: string): Promise<AdminDigitalCode> {
    const row = await this.prisma.digitalCode.findUnique({ where: { id }, include: { order: { select: { code: true } } } });
    if (!row) throw new NotFoundException('Không tìm thấy mã');
    return (await this.presentAdmin([row]))[0];
  }

  /** Bản khách xem (đã giải mã) — module khác sửa được qua filter `digital.customerCode` */
  private async toCustomer(
    row: CodeRow,
    ctx: { orderCode: string; item?: OrderItemRow; info?: ProductInfo; locale: string; settings: DigitalSettings; chain?: ChainInfo },
  ): Promise<CustomerCode> {
    const p = ctx.info;
    const warrantyUntil = this.warrantyUntil(row, p, ctx.chain);
    const revoked = row.status === 'REVOKED';
    const content = revoked ? '' : this.decrypt(row);
    const view: CustomerCode = {
      id: row.id,
      orderCode: ctx.orderCode,
      orderItemId: row.orderItemId,
      productId: row.productId,
      productName: this.productName(p, ctx.locale, ctx.item?.name ?? ''),
      variantLabel: this.variantLabel(p, row.variantId, ctx.locale, ctx.item?.optionValues),
      content,
      parts: revoked ? [] : splitCodeParts(content, this.codeFieldsOf(p), ctx.locale),
      deliveryNote: (p ? trOf(p.translations, ctx.locale)?.deliveryNote : null) || null,
      status: revoked ? 'REVOKED' : 'SOLD',
      revokeReason: row.revokeReason,
      soldAt: iso(row.soldAt),
      expiresAt: iso(row.expiresAt),
      warrantyUntil: iso(warrantyUntil),
      canReport: !revoked && ctx.settings.allowReports && !!warrantyUntil && warrantyUntil.getTime() > Date.now() && !this.reportBlockReason(row, ctx.chain),
      report: row.reportStatus ? { status: row.reportStatus as CodeReportStatus, note: row.reportNote, reply: row.reportReply, reportedAt: iso(row.reportedAt) } : null,
      replacesId: row.replacesId,
    };
    return this.hooks.applyFilters('digital.customerCode', view, { code: { id: row.id, productId: row.productId, variantId: row.variantId, orderId: row.orderId }, orderCode: ctx.orderCode, locale: ctx.locale });
  }

  /**
   * Hạn bảo hành của mã = soldAt của mã GỐC trong chuỗi đổi mã (replacesId) + codeWarrantyDays:
   * mã thay thế không được "gia hạn" bảo hành mỗi lần đổi. Không có chuỗi -> theo soldAt của chính mã.
   */
  private warrantyUntil(row: { soldAt: Date | null }, info: ProductInfo | undefined, chain?: ChainInfo): Date | null {
    const days = info?.codeWarrantyDays ?? null;
    const start = chain?.rootSoldAt ?? row.soldAt;
    return start && days ? new Date(start.getTime() + days * 86_400_000) : null;
  }

  /**
   * Lý do không cho khách báo lỗi (chống spam), null = được báo:
   * - đang có báo lỗi chờ xử lý (OPEN);
   * - cửa hàng đã TỪ CHỐI báo lỗi của mã này (REJECTED) -> chặn hẳn;
   * - cả chuỗi đổi mã đã báo ≥ MAX_REPORTS lần (mỗi mã trong chuỗi có reportStatus tính 1 lần).
   * RESOLVED sau khi đổi mã thì mã cũ đã REVOKED; mã mới (chưa báo) mới được báo tiếp.
   */
  private reportBlockReason(row: { reportStatus: string | null }, chain?: ChainInfo): string | null {
    if (row.reportStatus === 'OPEN') return 'Bạn đã báo lỗi mã này, cửa hàng đang xử lý';
    if (row.reportStatus === 'REJECTED') return 'Cửa hàng đã từ chối báo lỗi của mã này. Vui lòng liên hệ cửa hàng nếu cần hỗ trợ thêm';
    const reports = chain?.reports ?? (row.reportStatus ? 1 : 0);
    if (reports >= MAX_REPORTS) return `Mã này đã được báo lỗi ${reports} lần, vui lòng liên hệ trực tiếp cửa hàng`;
    return null;
  }

  /**
   * Dựng thông tin chuỗi đổi mã cho nhiều mã một lúc: đi ngược replacesId tối đa CHAIN_MAX_DEPTH bước (mỗi bước 1 truy vấn
   * cho cả lô), trả soldAt của mã gốc tìm được + số mã trong chuỗi (kể cả chính nó) từng bị báo lỗi.
   */
  private async chainInfo(rows: ChainRow[]): Promise<Map<string, ChainInfo>> {
    const known = new Map<string, ChainRow>(rows.map((r) => [r.id, r]));
    // id cha không còn tồn tại (đã xoá) -> không truy vấn lại
    const gone = new Set<string>();
    for (let i = 0; i < CHAIN_MAX_DEPTH; i++) {
      const missing = [...new Set([...known.values()].map((r) => r.replacesId).filter((x): x is string => !!x && !known.has(x) && !gone.has(x)))];
      if (!missing.length) break;
      const parents = await this.prisma.digitalCode.findMany({ where: { id: { in: missing } }, select: { id: true, replacesId: true, soldAt: true, reportStatus: true } });
      for (const p of parents) known.set(p.id, p);
      for (const m of missing) if (!known.has(m)) gone.add(m);
    }
    const out = new Map<string, ChainInfo>();
    for (const r of rows) {
      let cur: ChainRow = r;
      let rootSoldAt = r.soldAt;
      let reports = r.reportStatus ? 1 : 0;
      for (let i = 0; i < CHAIN_MAX_DEPTH && cur.replacesId; i++) {
        const parent = known.get(cur.replacesId);
        if (!parent) break;
        cur = parent;
        if (parent.soldAt) rootSoldAt = parent.soldAt;
        if (parent.reportStatus) reports++;
      }
      out.set(r.id, { rootSoldAt, reports });
    }
    return out;
  }

  /** Đánh dấu lần đầu khách xem mã */
  private async markViewed(rows: { id: string; status: DigitalCodeStatus; viewedAt: Date | null }[]) {
    const ids = rows.filter((r) => r.status === 'SOLD' && !r.viewedAt).map((r) => r.id);
    if (ids.length) await this.prisma.digitalCode.updateMany({ where: { id: { in: ids }, viewedAt: null }, data: { viewedAt: new Date() } }).catch(() => undefined);
  }

  // ===========================================================================
  // Tồn kho
  // ===========================================================================

  /**
   * Tính lại tồn kho sản phẩm (và từng biến thể) = số mã AVAILABLE chưa hết hạn; luôn bật manageStock.
   * Giữ nguyên stockStatus BACKORDER (cho đặt trước). Gọi được trong transaction (tx).
   * Có tx -> KHÔNG gửi cảnh báo sắp hết ngay (transaction có thể rollback) mà trả về danh sách thay đổi để người gọi gửi sau commit.
   * @param removed số mã vừa rời kho theo biến thể (key '' = không biến thể) — để phát hiện "vừa vượt ngưỡng sắp hết"
   *                khi stockQuantity đã bị trừ trước đó (checkout trừ kho rồi mới giữ mã).
   * @param only chỉ GHI các biến thể này (id biến thể) — dùng trong transaction checkout: không khoá dòng của biến thể khác
   *             (2 đơn song song khác biến thể cùng sản phẩm khoá chéo nhau -> deadlock); biến thể còn lại đồng bộ sau commit.
   *             Tổng tồn của sản phẩm vẫn tính từ số mã của mọi biến thể.
   */
  async syncStock(productId: string, tx?: Prisma.TransactionClient, removed?: Record<string, number>, only?: Set<string>): Promise<StockChange[] | void> {
    const db: Db = tx ?? this.prisma;
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, type: true, codeDelivery: true, stockStatus: true, stockQuantity: true, manageStock: true, variants: { select: { id: true, stockStatus: true, stockQuantity: true, isActive: true } } },
    });
    if (!product?.codeDelivery) return [];
    const groups = await db.digitalCode.groupBy({
      by: ['variantId'],
      where: { productId, status: 'AVAILABLE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      _count: { _all: true },
    });
    const countOf = (variantId: string | null) => groups.find((g) => g.variantId === variantId)?._count._all ?? 0;
    // còn mã -> tự IN_STOCK kể cả khi admin từng đặt OUT_OF_STOCK tay (tồn kho do kho mã quyết định);
    // muốn tạm ngừng bán sản phẩm kho mã thì chuyển sản phẩm về nháp (hoặc khoá mã), không dùng trạng thái hết hàng
    const statusOf = (current: string, qty: number) => (current === 'BACKORDER' ? 'BACKORDER' : qty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK') as 'IN_STOCK' | 'OUT_OF_STOCK' | 'BACKORDER';
    // mức tồn trước/sau theo biến thể để cảnh báo sắp hết
    const changes: StockChange[] = [];

    if (product.type === 'VARIABLE' && product.variants.length) {
      let total = 0;
      for (const v of product.variants) {
        const qty = countOf(v.id);
        if (v.isActive) total += qty;
        // biến thể không nằm trong `only`: chỉ cộng vào tổng, không ghi (đồng bộ sau commit)
        if (only && !only.has(v.id)) continue;
        const st = statusOf(v.stockStatus, qty);
        if (v.stockQuantity !== qty || v.stockStatus !== st) await db.productVariant.update({ where: { id: v.id }, data: { stockQuantity: qty, stockStatus: st } });
        if (v.isActive) changes.push({ variantId: v.id, before: Math.max(v.stockQuantity, qty + (removed?.[v.id] ?? 0)), after: qty });
      }
      const st = statusOf(product.stockStatus, total);
      if (product.stockQuantity !== total || product.stockStatus !== st || !product.manageStock) await db.product.update({ where: { id: productId }, data: { stockQuantity: total, stockStatus: st, manageStock: true } });
    } else {
      const qty = countOf(null);
      const st = statusOf(product.stockStatus, qty);
      if (product.stockQuantity !== qty || product.stockStatus !== st || !product.manageStock) await db.product.update({ where: { id: productId }, data: { stockQuantity: qty, stockStatus: st, manageStock: true } });
      changes.push({ variantId: null, before: Math.max(product.stockQuantity, qty + (removed?.[''] ?? 0)), after: qty });
    }
    // trong transaction: trả thay đổi cho người gọi, cảnh báo gửi sau khi commit
    if (tx) return changes;
    // ngoài transaction: cảnh báo chạy nền, lỗi chỉ ghi log
    void this.alertLowStock(productId, changes).catch((err: Error) => this.logger.warn(`Không tạo được cảnh báo kho mã: ${err.message}`));
    return changes;
  }

  /**
   * Gom việc cần làm sau khi đơn đang tạo commit (transaction chưa commit): cảnh báo sắp hết kho + đồng bộ tồn kho đủ mọi biến thể
   * (trong transaction chỉ ghi biến thể vừa giữ mã). Dọn luôn các mục quá hạn (transaction đã rollback).
   */
  private queueAlerts(orderId: string, items: { productId: string; changes: StockChange[] }[]) {
    const now = Date.now();
    for (const [k, v] of this.pendingAlerts) if (now - v.at > PENDING_ALERT_TTL_MS) this.pendingAlerts.delete(k);
    if (items.length) this.pendingAlerts.set(orderId, { at: now, items });
  }

  /** Sau khi đơn commit (sự kiện order.created): đồng bộ tồn kho đầy đủ (ngoài transaction) rồi gửi cảnh báo kho đã gom */
  private flushAlerts(orderId: string) {
    const pending = this.pendingAlerts.get(orderId);
    if (!pending) return;
    this.pendingAlerts.delete(orderId);
    if (Date.now() - pending.at > PENDING_ALERT_TTL_MS) return;
    for (const it of pending.items) {
      void (async () => {
        await this.syncStock(it.productId);
        await this.alertLowStock(it.productId, it.changes);
      })().catch((err: Error) => this.logger.warn(`Không đồng bộ / cảnh báo được kho mã ${it.productId}: ${err.message}`));
    }
  }

  /** Thông báo admin khi kho mã vừa giảm xuống ≤ ngưỡng (chỉ lúc vượt ngưỡng, không lặp mỗi đơn) */
  private async alertLowStock(productId: string, changes: StockChange[]) {
    const crossed = changes.filter((c) => c.after < c.before);
    if (!crossed.length) return;
    const { lowStockAlert } = await this.digitalSettings();
    const hits = crossed.filter((c) => c.before > lowStockAlert && c.after <= lowStockAlert);
    if (!hits.length) return;
    const info = (await this.productInfos([productId])).get(productId);
    for (const c of hits) {
      const variant = this.variantLabel(info, c.variantId);
      // ghi Nhật ký lỗi (cảnh báo) để admin biết kho sắp hết / đã hết mã
      this.logger.warn(`Kho mã "${this.productName(info, 'vi', 'Sản phẩm')}${variant ? ` (${variant})` : ''}" ${c.after ? `sắp hết: còn ${c.after} mã` : 'đã hết mã'}`);
    }
  }

  /**
   * Mỗi giờ: đồng bộ tồn kho cho sản phẩm có mã vừa hết hạn (hết hạn không có sự kiện nào báo).
   * Quét mã hết hạn từ mốc lần chạy trước tới nay (không bỏ sót khi cron lỡ vài giờ); lần đầu sau khởi động lùi 30 ngày.
   */
  @Cron('7 * * * *')
  async syncExpired() {
    if (process.env.NODE_ENV === 'test') return;
    const now = new Date();
    const since = this.lastExpiredSync ?? new Date(now.getTime() - 30 * 86_400_000);
    // duyệt theo trang 500 sản phẩm (sắp theo productId) tới khi hết
    for (let skip = 0; ; skip += 500) {
      const rows = await this.prisma.digitalCode.findMany({
        where: { status: 'AVAILABLE', expiresAt: { lte: now, gt: since } },
        distinct: ['productId'],
        select: { productId: true },
        orderBy: { productId: 'asc' },
        skip,
        take: 500,
      });
      for (const r of rows) await this.syncStock(r.productId).catch((err: Error) => this.logger.warn(`Đồng bộ kho mã ${r.productId} lỗi: ${err.message}`));
      if (rows.length < 500) break;
    }
    this.lastExpiredSync = now;
  }

  /**
   * Chọn mã còn trong kho cho sản phẩm/biến thể, khoá dòng (bỏ qua dòng đang bị transaction khác giữ).
   * Thử giải mã từng mã: mã không giải mã được (đổi khoá) -> chuyển Tạm khoá kèm ghi chú, KHÔNG giao (tránh giao mã rỗng),
   * lấy bù mã khác (tối đa vài vòng); ghi log lỗi + thông báo admin.
   */
  private async pickAvailable(tx: Tx, productId: string, variantId: string | null, limit: number): Promise<{ id: string }[]> {
    if (limit <= 0) return [];
    const variantCond = variantId ? Prisma.sql`"variantId" = ${variantId}::uuid` : Prisma.sql`"variantId" IS NULL`;
    const good: { id: string }[] = [];
    let bad = 0;
    for (let round = 0; round < 5 && good.length < limit; round++) {
      const want = limit - good.length;
      const rows = await tx.$queryRaw<{ id: string; content: string; note: string | null }[]>`
        SELECT id, content, note FROM digital_codes
        WHERE "productId" = ${productId}::uuid AND ${variantCond} AND status = 'AVAILABLE' AND ("expiresAt" IS NULL OR "expiresAt" > now())
        ORDER BY "createdAt" ASC, id ASC
        LIMIT ${want}
        FOR UPDATE SKIP LOCKED`;
      let badHere = 0;
      for (const r of rows) {
        if (decryptCode(r.content, this.keys) !== null) good.push({ id: r.id });
        else {
          badHere++;
          await this.disableUndecryptable(tx, r);
        }
      }
      bad += badHere;
      // không có mã hỏng (đã đủ) hoặc kho đã hết -> dừng
      if (!badHere || rows.length < want) break;
    }
    if (bad) this.reportUndecryptable(productId, bad);
    return good;
  }

  /** Chuyển một mã không giải mã được sang Tạm khoá (rời đơn nếu đang giữ), giữ ghi chú cũ */
  private async disableUndecryptable(db: Db, row: { id: string; note: string | null }) {
    await db.digitalCode.update({
      where: { id: row.id },
      data: { status: 'DISABLED', orderId: null, orderItemId: null, reservedAt: null, note: row.note ? `${row.note}\n${UNDECRYPTABLE_NOTE}` : UNDECRYPTABLE_NOTE },
    });
  }

  /** Ghi Nhật ký lỗi khi gặp mã không giải mã được (admin xem mã Tạm khoá ở Kho mã › lọc trạng thái) */
  private reportUndecryptable(productId: string, count: number) {
    this.logger.error(`${count} mã của sản phẩm ${productId} không giải mã được — đã chuyển sang Tạm khoá. Khoá DIGITAL_CODES_KEY / JWT_ACCESS_SECRET đã bị đổi?`);
  }

  /** Thống kê kho của 1 sản phẩm (tab Kho mã trong trang sửa sản phẩm) */
  async productStats(productId: string): Promise<DigitalStockRow[]> {
    return (await this.summary(productId)).rows;
  }

  // ===========================================================================
  // Admin: danh sách / thống kê
  // ===========================================================================

  /**
   * Điều kiện lọc danh sách. `canReveal` = người gọi có quyền digital_codes.reveal: chỉ khi đó mới cho tìm khớp chính xác
   * theo nội dung mã (so HMAC) — người không xem được mã thì không dùng ô tìm kiếm để dò xem một mã có trong kho hay không.
   */
  private listWhere(q: DigitalCodeQueryDto, canReveal = false): Prisma.DigitalCodeWhereInput {
    const where: Prisma.DigitalCodeWhereInput = {};
    if (q.productId) where.productId = q.productId;
    if (q.variantId) where.variantId = q.variantId;
    if (q.status) where.status = q.status as DigitalCodeStatus;
    if (q.batch) where.batch = q.batch;
    if (q.reportStatus) where.reportStatus = q.reportStatus;
    if (q.orderId) where.orderId = q.orderId;
    const s = q.search?.trim();
    if (s) {
      // khớp bản che / lô / ghi chú / mã đơn, hoặc (chỉ khi có quyền xem mã) khớp CHÍNH XÁC nội dung (so HMAC, không cần giải mã)
      const h = canReveal ? this.hash(normalizeCode(s)) : null;
      where.OR = [
        { preview: { contains: s, mode: 'insensitive' } },
        { batch: { contains: s, mode: 'insensitive' } },
        { note: { contains: s, mode: 'insensitive' } },
        { order: { code: { contains: s, mode: 'insensitive' } } },
        ...(h ? [{ contentHash: h }, { contentHash: { startsWith: `${h}:` } }] : []),
        ...(UUID_RE.test(s) ? [{ id: s }] : []),
      ];
    }
    return where;
  }

  /** Danh sách mã (bản che). `user` để biết có được tìm theo nội dung mã hay không */
  async list(q: DigitalCodeQueryDto, user?: Pick<AuthUser, 'permissions'>) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = this.listWhere(q, hasPermission(user?.permissions, 'digital_codes.reveal'));
    const [rows, total] = await Promise.all([
      this.prisma.digitalCode.findMany({ where, skip, take, orderBy: [{ createdAt: q.order === 'asc' ? 'asc' : 'desc' }, { id: 'asc' }], include: { order: { select: { code: true } } } }),
      this.prisma.digitalCode.count({ where }),
    ]);
    return paginate(await this.presentAdmin(rows), total, page, limit);
  }

  /** Thống kê kho theo sản phẩm / biến thể (gồm cả sản phẩm bán theo kho mã chưa có mã nào) */
  async summary(productId?: string): Promise<DigitalStockSummary> {
    const now = new Date();
    const soon = new Date(now.getTime() + EXPIRING_SOON_MS);
    const scope: Prisma.DigitalCodeWhereInput = productId ? { productId } : {};
    const [byStatus, expired, expiring, products, openReports, pendingOrders, settings] = await Promise.all([
      this.prisma.digitalCode.groupBy({ by: ['productId', 'variantId', 'status'], where: scope, _count: { _all: true } }),
      this.prisma.digitalCode.groupBy({ by: ['productId', 'variantId'], where: { ...scope, status: 'AVAILABLE', expiresAt: { lte: now } }, _count: { _all: true } }),
      this.prisma.digitalCode.groupBy({ by: ['productId', 'variantId'], where: { ...scope, status: 'AVAILABLE', expiresAt: { gt: now, lte: soon } }, _count: { _all: true } }),
      this.prisma.product.findMany({ where: { deletedAt: null, codeDelivery: true, ...(productId ? { id: productId } : {}) }, select: { id: true } }),
      this.prisma.digitalCode.count({ where: { ...scope, reportStatus: 'OPEN' } }),
      this.prisma.order.count({
        where: { codeStatus: { in: ['pending', 'partial'] }, paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'REFUNDED'] }, ...(productId ? { items: { some: { productId } } } : {}) },
      }),
      this.digitalSettings(),
    ]);
    const infos = await this.productInfos([...products.map((p) => p.id), ...byStatus.map((g) => g.productId)]);
    const rowMap = new Map<string, DigitalStockRow>();
    const keyOf = (pid: string, vid: string | null) => `${pid}:${vid ?? ''}`;
    const ensure = (pid: string, vid: string | null): DigitalStockRow => {
      const k = keyOf(pid, vid);
      let row = rowMap.get(k);
      if (!row) {
        const info = infos.get(pid);
        const variant = vid ? info?.variants.find((v) => v.id === vid) : undefined;
        row = {
          productId: pid,
          productName: this.productName(info, 'vi', pid.slice(0, 8)),
          sku: variant?.sku ?? info?.sku ?? null,
          variantId: vid,
          variantLabel: this.variantLabel(info, vid),
          available: 0,
          reserved: 0,
          sold: 0,
          disabled: 0,
          revoked: 0,
          expiringSoon: 0,
          expired: 0,
          lowStock: false,
        };
        rowMap.set(k, row);
      }
      return row;
    };
    // sản phẩm bật kho mã: một dòng cho sản phẩm đơn, hoặc mỗi biến thể đang bán
    for (const p of products) {
      const info = infos.get(p.id);
      if (info?.type === 'VARIABLE' && info.variants.length) for (const v of info.variants.filter((x) => x.isActive)) ensure(p.id, v.id);
      else ensure(p.id, null);
    }
    for (const g of byStatus) {
      const row = ensure(g.productId, g.variantId);
      const n = g._count._all;
      if (g.status === 'AVAILABLE') row.available += n;
      else if (g.status === 'RESERVED') row.reserved += n;
      else if (g.status === 'SOLD') row.sold += n;
      else if (g.status === 'DISABLED') row.disabled += n;
      else if (g.status === 'REVOKED') row.revoked += n;
    }
    for (const g of expired) {
      const row = ensure(g.productId, g.variantId);
      row.expired = g._count._all;
      // mã hết hạn không bán được -> không tính vào "còn trong kho"
      row.available = Math.max(0, row.available - g._count._all);
    }
    for (const g of expiring) ensure(g.productId, g.variantId).expiringSoon = g._count._all;
    const rows = [...rowMap.values()];
    // chỉ cảnh báo với sản phẩm đang bán theo kho mã (sản phẩm chỉ có mã giao tay thì không); ngưỡng 0 = chỉ khi hết hẳn
    const codeProductIds = new Set(products.map((p) => p.id));
    for (const r of rows) r.lowStock = codeProductIds.has(r.productId) && r.available <= settings.lowStockAlert;
    rows.sort((a, b) => a.productName.localeCompare(b.productName, 'vi') || (a.variantLabel ?? '').localeCompare(b.variantLabel ?? '', 'vi'));
    const totals = { available: 0, reserved: 0, sold: 0, disabled: 0, revoked: 0 };
    for (const r of rows) {
      totals.available += r.available;
      totals.reserved += r.reserved;
      totals.sold += r.sold;
      totals.disabled += r.disabled;
      totals.revoked += r.revoked;
    }
    return { rows, totals, openReports, pendingOrders };
  }

  /**
   * Các lô nhập (để lọc), mới nhất trước. Sắp xếp + cắt trang ngay trong DB (groupBy orderBy/skip/take) thay vì
   * kéo mọi lô về rồi mới cắt. Mặc định 200 lô/trang, tối đa 500; `search` lọc theo tên lô.
   * Vẫn trả mảng (admin đang đọc dạng mảng).
   */
  async batches(productId?: string, q: { search?: string; page?: number; limit?: number } = {}): Promise<{ batch: string; count: number; createdAt: string }[]> {
    const limit = Math.min(Math.max(1, q.limit ?? 200), 500);
    const page = Math.max(1, q.page ?? 1);
    const search = q.search?.trim();
    const groups = await this.prisma.digitalCode.groupBy({
      by: ['batch'],
      where: { batch: search ? { not: null, contains: search, mode: 'insensitive' } : { not: null }, ...(productId ? { productId } : {}) },
      _count: { _all: true },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'desc' } },
      skip: (page - 1) * limit,
      take: limit,
    });
    return groups.filter((g) => g.batch).map((g) => ({ batch: g.batch!, count: g._count._all, createdAt: (g._min.createdAt ?? new Date(0)).toISOString() }));
  }

  /** Sản phẩm có thể gắn kho mã (chọn khi nhập) — sản phẩm đã bật kho mã lên đầu */
  async products(search?: string) {
    const s = search?.trim();
    const rows = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(s ? { OR: [{ sku: { contains: s, mode: 'insensitive' } }, { translations: { some: { name: { contains: s, mode: 'insensitive' } } } }, { variants: { some: { sku: { contains: s, mode: 'insensitive' } } } }] } : {}),
      },
      select: PRODUCT_INFO_SELECT,
      orderBy: [{ codeDelivery: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
    });
    return rows.map((p) => ({
      id: p.id,
      name: this.productName(p, 'vi', p.sku ?? p.id.slice(0, 8)),
      sku: p.sku,
      type: p.type,
      codeDelivery: p.codeDelivery,
      variants: p.variants.filter((v) => v.isActive).map((v) => ({ id: v.id, label: variantLabelOf(p.options, v.optionValues) ?? v.sku ?? v.id.slice(0, 8), sku: v.sku })),
    }));
  }

  // ===========================================================================
  // Admin: nhập / sửa / hàng loạt / xuất
  // ===========================================================================

  /** Kiểm tra sản phẩm + biến thể hợp lệ cho kho mã */
  private async assertTarget(productId: string, variantId: string | null | undefined): Promise<{ product: ProductInfo; variantId: string | null }> {
    const product = (await this.productInfos([productId])).get(productId);
    if (!product || product.deletedAt) throw new NotFoundException('Không tìm thấy sản phẩm');
    if (product.type === 'VARIABLE') {
      if (!variantId) throw new BadRequestException('Sản phẩm có biến thể: vui lòng chọn biến thể cho mã');
      if (!product.variants.some((v) => v.id === variantId)) throw new BadRequestException('Biến thể không thuộc sản phẩm này');
      return { product, variantId };
    }
    if (variantId) throw new BadRequestException('Sản phẩm không có biến thể, bỏ chọn biến thể');
    return { product, variantId: null };
  }

  async import(dto: ImportDigitalCodesDto, actor: AuthUser): Promise<DigitalImportResult> {
    const { product, variantId } = await this.assertTarget(dto.productId, dto.variantId);
    const raw = [...(dto.text ? dto.text.split(/\r?\n/).filter((l) => l.trim() !== '') : []), ...(dto.codes ?? [])];
    if (!raw.length) throw new BadRequestException('Chưa có mã nào để nhập');
    if (raw.length > MAX_IMPORT_CODES) throw new BadRequestException(`Tối đa ${MAX_IMPORT_CODES.toLocaleString('vi-VN')} mã mỗi lần nhập`);
    const fields = this.codeFieldsOf(product);
    let invalid = 0;
    let duplicates = 0;
    // chuẩn hoá + chống trùng trong chính danh sách nhập
    const seen = new Map<string, string>();
    for (const line of raw) {
      const content = normalizeCode(line);
      if (!content || content.length > MAX_CODE_LENGTH) {
        invalid++;
        continue;
      }
      const h = this.hash(content);
      if (seen.has(h)) duplicates++;
      else seen.set(h, content);
    }
    // trùng với mã đã có trong kho của sản phẩm
    const hashes = [...seen.keys()];
    for (let i = 0; i < hashes.length; i += 1000) {
      const existing = await this.prisma.digitalCode.findMany({ where: { productId: product.id, contentHash: { in: hashes.slice(i, i + 1000) } }, select: { contentHash: true } });
      for (const e of existing) if (seen.delete(e.contentHash)) duplicates++;
    }
    const batch = dto.batch?.trim() || null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const entries = [...seen.entries()];
    let created = 0;
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      const res = await this.prisma.digitalCode.createMany({
        data: chunk.map(([h, content]) => ({
          productId: product.id,
          variantId,
          content: this.encrypt(content),
          contentHash: h,
          preview: codePreview(content, fields),
          batch,
          note: dto.note?.trim() || null,
          costPrice: dto.costPrice ?? null,
          expiresAt,
          source: 'import',
          createdById: actor.id === 'system' ? null : actor.id,
        })),
        // nhập song song cùng mã -> bản sau bị bỏ qua thay vì lỗi cả lô
        skipDuplicates: true,
      });
      created += res.count;
      duplicates += chunk.length - res.count;
    }
    // sản phẩm chưa bật bán theo kho mã -> tự bật (tồn kho do kho mã quản lý)
    if (!product.codeDelivery) await this.prisma.product.update({ where: { id: product.id }, data: { codeDelivery: true, manageStock: true } });
    await this.syncStock(product.id);
    const settings = await this.digitalSettings();
    const fulfilledOrders = created && settings.autoFulfillBackorders ? await this.fulfillBackorders(product.id) : 0;
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.import', entityType: 'product', entityId: product.id, meta: { variantId, created, duplicates, invalid, batch, fulfilledOrders } });
    this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    return { created, duplicates, invalid, fulfilledOrders };
  }

  /** Xem nội dung một mã (ghi nhật ký hoạt động) */
  async reveal(id: string, actor: AuthUser): Promise<{ content: string }> {
    const row = await this.prisma.digitalCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy mã');
    const content = decryptCode(row.content, this.keys);
    if (content === null) throw new ConflictException('Không giải mã được mã này — khoá mã hoá (DIGITAL_CODES_KEY / JWT_ACCESS_SECRET) đã bị đổi');
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.reveal', entityType: 'digital_code', entityId: id, meta: { productId: row.productId, status: row.status, orderId: row.orderId } });
    return { content };
  }

  async update(id: string, dto: UpdateDigitalCodeDto, actor: AuthUser): Promise<AdminDigitalCode> {
    const row = await this.prisma.digitalCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy mã');
    const inStock = row.status === 'AVAILABLE' || row.status === 'DISABLED';
    const data: Prisma.DigitalCodeUpdateInput = {};
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.batch !== undefined) data.batch = dto.batch?.trim() || null;
    if (dto.costPrice !== undefined) data.costPrice = dto.costPrice;
    if (dto.expiresAt !== undefined) data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.status !== undefined && dto.status !== row.status) {
      if (!inStock) throw new BadRequestException('Chỉ khoá / mở khoá được mã còn trong kho');
      data.status = dto.status;
    }
    if (dto.content !== undefined) {
      if (!inStock) throw new BadRequestException('Chỉ sửa nội dung mã chưa giao');
      const content = normalizeCode(dto.content);
      if (!content || content.length > MAX_CODE_LENGTH) throw new BadRequestException('Nội dung mã không hợp lệ');
      const h = this.hash(content);
      if (h !== row.contentHash) {
        const dup = await this.prisma.digitalCode.findFirst({ where: { productId: row.productId, contentHash: h, NOT: { id } }, select: { id: true } });
        if (dup) throw new ConflictException('Mã này đã có trong kho của sản phẩm');
        const info = (await this.productInfos([row.productId])).get(row.productId);
        Object.assign(data, { content: this.encrypt(content), contentHash: h, preview: codePreview(content, this.codeFieldsOf(info)) });
      }
    }
    if (data.status !== undefined || data.content !== undefined) {
      // đổi trạng thái / nội dung: chỉ ghi khi mã VẪN còn trong kho — tránh chen ngang lúc checkout vừa giữ / giao mã này
      const res = await this.prisma.digitalCode.updateMany({ where: { id, status: { in: ['AVAILABLE', 'DISABLED'] } }, data: data as Prisma.DigitalCodeUpdateManyMutationInput });
      if (!res.count) throw new ConflictException('Mã vừa được giữ / giao cho đơn, vui lòng tải lại');
    } else {
      await this.prisma.digitalCode.update({ where: { id }, data });
    }
    if (data.status !== undefined || data.expiresAt !== undefined) {
      await this.syncStock(row.productId);
      if (data.status === 'AVAILABLE' && (await this.digitalSettings()).autoFulfillBackorders) await this.fulfillBackorders(row.productId);
      this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    }
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.update', entityType: 'digital_code', entityId: id, meta: { fields: Object.keys(dto).filter((k) => k !== 'content'), contentChanged: dto.content !== undefined } });
    return this.adminById(id);
  }

  async bulk(dto: BulkDigitalCodesDto, actor: AuthUser): Promise<{ affected: number }> {
    const ids = [...new Set(dto.ids)];
    const rows = await this.prisma.digitalCode.findMany({ where: { id: { in: ids } }, select: { productId: true } });
    const productIds = [...new Set(rows.map((r) => r.productId))];
    let affected = 0;
    switch (dto.action) {
      case 'disable':
        affected = (await this.prisma.digitalCode.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'DISABLED' } })).count;
        break;
      case 'enable':
        affected = (await this.prisma.digitalCode.updateMany({ where: { id: { in: ids }, status: 'DISABLED' }, data: { status: 'AVAILABLE' } })).count;
        break;
      case 'delete':
        // chỉ xoá mã chưa từng giao (không mất lịch sử đơn của khách)
        affected = (await this.prisma.digitalCode.deleteMany({ where: { id: { in: ids }, status: { in: ['AVAILABLE', 'DISABLED'] }, orderId: null, soldAt: null } })).count;
        break;
      case 'setBatch':
        affected = (await this.prisma.digitalCode.updateMany({ where: { id: { in: ids } }, data: { batch: dto.batch?.trim() || null } })).count;
        break;
    }
    if (dto.action !== 'setBatch' && affected) {
      for (const pid of productIds) await this.syncStock(pid);
      if (dto.action === 'enable' && (await this.digitalSettings()).autoFulfillBackorders) for (const pid of productIds) await this.fulfillBackorders(pid);
      this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    }
    this.events.emit('activity', { userId: actor.id, action: `digital_codes.bulk.${dto.action}`, entityType: 'digital_code', entityId: ids[0], meta: { count: ids.length, affected, batch: dto.batch } });
    return { affected };
  }

  /** Xuất CSV (có nội dung đã giải mã) theo bộ lọc danh sách — tối đa 50.000 dòng, ghi nhật ký */
  async exportCsv(q: DigitalCodeQueryDto, actor: AuthUser): Promise<{ filename: string; content: string }> {
    const where = this.listWhere(q, hasPermission(actor.permissions, 'digital_codes.reveal'));
    const rows = await this.prisma.digitalCode.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: { order: { select: { code: true } } }, take: 50_000 });
    const infos = await this.productInfos(rows.map((r) => r.productId));
    const header = ['id', 'Sản phẩm', 'Biến thể', 'Nội dung', 'Trạng thái', 'Lô', 'Mã đơn', 'Ngày bán', 'Hạn dùng', 'Giá vốn', 'Ghi chú'];
    const lines = rows.map((r) => {
      const info = infos.get(r.productId);
      return [
        r.id,
        this.productName(info, 'vi', r.productId),
        this.variantLabel(info, r.variantId) ?? '',
        this.decrypt(r),
        r.status,
        r.batch ?? '',
        r.order?.code ?? '',
        r.soldAt ?? '',
        r.expiresAt ?? '',
        r.costPrice == null ? '' : Number(r.costPrice),
        r.note ?? '',
      ]
        .map(csvCell)
        .join(',');
    });
    this.events.emit('activity', {
      userId: actor.id,
      action: 'digital_codes.export',
      entityType: 'digital_code',
      entityId: 'export',
      meta: { count: rows.length, filter: { productId: q.productId, variantId: q.variantId, status: q.status, batch: q.batch, orderId: q.orderId, search: q.search ? '(có)' : undefined } },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `kho-ma-${stamp}.csv`, content: '﻿' + [header.map(csvCell).join(','), ...lines].join('\n') };
  }

  /**
   * Tính lại bản che (preview) cho mọi mã đã có theo quy tắc che hiện tại (sau khi đổi cách che).
   * Duyệt theo lô 500 dòng (con trỏ id), giải mã rồi codePreview lại; mã không giải mã được (đổi khoá) bị bỏ qua.
   */
  async rebuildPreviews(actor: AuthUser): Promise<{ scanned: number; updated: number; failed: number }> {
    let scanned = 0;
    let updated = 0;
    let failed = 0;
    let cursor: string | undefined;
    const infoCache = new Map<string, ProductInfo | undefined>();
    for (;;) {
      const rows = await this.prisma.digitalCode.findMany({
        select: { id: true, productId: true, content: true, preview: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      scanned += rows.length;
      // nạp thông tin sản phẩm còn thiếu trong bộ nhớ đệm (cần codeFields)
      const missingIds = [...new Set(rows.map((r) => r.productId))].filter((pid) => !infoCache.has(pid));
      if (missingIds.length) {
        const infos = await this.productInfos(missingIds);
        for (const pid of missingIds) infoCache.set(pid, infos.get(pid));
      }
      for (const r of rows) {
        const plain = decryptCode(r.content, this.keys);
        if (plain === null) {
          failed++;
          continue;
        }
        const preview = codePreview(plain, this.codeFieldsOf(infoCache.get(r.productId)));
        if (preview === r.preview) continue;
        await this.prisma.digitalCode.update({ where: { id: r.id }, data: { preview } });
        updated++;
      }
    }
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.rebuildPreviews', entityType: 'digital_code', entityId: 'all', meta: { scanned, updated, failed } });
    return { scanned, updated, failed };
  }

  // ===========================================================================
  // Giữ / giao / nhả mã theo đơn
  // ===========================================================================

  /** Giữ mã cho đơn vừa tạo, chạy TRONG transaction checkout / tạo đơn admin */
  async reserveForOrder(
    tx: Prisma.TransactionClient,
    order: { id: string; items: { id: string; productId: string | null; variantId: string | null; quantity: number; name: string }[] },
  ): Promise<void> {
    const infos = await this.productInfos(order.items.map((i) => i.productId), tx);
    const codeItems = order.items.filter((i) => i.productId && infos.get(i.productId)?.codeDelivery && i.quantity > 0);
    if (!codeItems.length) return;
    const now = new Date();
    const removed = new Map<string, Record<string, number>>();
    for (const item of codeItems) {
      const info = infos.get(item.productId!)!;
      const variant = item.variantId ? info.variants.find((v) => v.id === item.variantId) : undefined;
      const picked = await this.pickAvailable(tx, info.id, item.variantId ?? null, item.quantity);
      if (picked.length < item.quantity) {
        // BACKORDER: cho đặt trước, giao bù khi nhập thêm mã
        const backorder = info.stockStatus === 'BACKORDER' || variant?.stockStatus === 'BACKORDER';
        if (!backorder) throw new BadRequestException(picked.length ? `"${item.name}" chỉ còn ${picked.length} mã trong kho` : `"${item.name}" đã hết mã trong kho`);
      }
      if (picked.length) {
        await tx.digitalCode.updateMany({ where: { id: { in: picked.map((p) => p.id) }, status: 'AVAILABLE' }, data: { status: 'RESERVED', orderId: order.id, orderItemId: item.id, reservedAt: now } });
        const r = removed.get(info.id) ?? {};
        r[item.variantId ?? ''] = (r[item.variantId ?? ''] ?? 0) + picked.length;
        removed.set(info.id, r);
      }
    }
    await tx.order.update({ where: { id: order.id }, data: { codeStatus: 'pending' } });
    // đồng bộ tồn kho trong transaction CHỈ cho biến thể vừa giữ mã (tránh deadlock giữa các đơn song song khác biến thể);
    // đồng bộ đủ mọi biến thể + cảnh báo sắp hết gom lại, chạy khi đơn đã commit (onOrderCreated)
    const alerts: { productId: string; changes: StockChange[] }[] = [];
    for (const pid of new Set(codeItems.map((i) => i.productId!))) {
      const only = new Set(codeItems.filter((i) => i.productId === pid && i.variantId).map((i) => i.variantId!));
      alerts.push({ productId: pid, changes: (await this.syncStock(pid, tx, removed.get(pid), only)) || [] });
    }
    this.queueAlerts(order.id, alerts);
  }

  /**
   * Số mã "đã giao" của một dòng hàng = mã SOLD + mã REVOKED, KHÔNG tính mã thay thế (replacesId) để chuỗi đổi mã chỉ đếm 1 lần.
   * Mã bị thu hồi vẫn tính là đã giao -> hệ thống không tự cấp mã khác; muốn cấp mới admin dùng "Đổi mã".
   */
  private deliveredCount(db: Db, orderItemId: string): Promise<number> {
    return db.digitalCode.count({ where: { orderItemId, status: { in: ['SOLD', 'REVOKED'] }, replacesId: null } });
  }

  /** Trạng thái giao mã của đơn theo số mã đã giao từng dòng */
  private codeStatusOf(lines: { quantity: number; sold: number }[]): OrderCodeStatus | null {
    if (!lines.length) return null;
    const need = lines.reduce((s, l) => s + l.quantity, 0);
    const done = lines.reduce((s, l) => s + Math.min(l.sold, l.quantity), 0);
    return done >= need ? 'delivered' : done > 0 ? 'partial' : 'pending';
  }

  /**
   * Giao mã cho đơn (idempotent, khoá dòng đơn): RESERVED -> SOLD, cấp bù phần thiếu từ kho, cập nhật codeStatus.
   * Đơn chưa thanh toán chỉ giao khi `force`. Sau đó: đồng bộ kho, sự kiện + hook, email (notify), báo thiếu mã, tự hoàn thành đơn.
   * `backfill` = gọi từ giao bù (nhập mã): chỉ báo "thiếu mã" khi đơn MỚI chuyển sang thiếu, không báo lại mỗi lần nhập.
   */
  async deliverForOrder(orderId: string, opts: { force?: boolean; notify?: boolean; actor?: AuthUser; backfill?: boolean } = {}): Promise<DeliverResult> {
    const now = new Date();
    const res = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
      const skip = { order, newIds: [] as string[], missing: 0, codeStatus: (order.codeStatus as OrderCodeStatus | null) ?? null, prevCodeStatus: (order.codeStatus as OrderCodeStatus | null) ?? null, removed: new Map<string, Record<string, number>>() };
      if (CLOSED_STATUSES.includes(order.status)) return skip;
      if (!PAID_STATUSES.includes(order.paymentStatus) && !opts.force) return skip;
      const infos = await this.productInfos(order.items.map((i) => i.productId), tx);
      const lines: { quantity: number; sold: number }[] = [];
      let missing = 0;
      for (const item of order.items) {
        const info = item.productId ? infos.get(item.productId) : undefined;
        // đã giao = SOLD + REVOKED (mã thu hồi không tự cấp lại)
        const soldBefore = await this.deliveredCount(tx, item.id);
        // dòng không bán theo kho mã nhưng có mã giao tay -> vẫn tính vào trạng thái giao mã
        if (!info?.codeDelivery) {
          if (soldBefore) lines.push({ quantity: item.quantity, sold: soldBefore });
          continue;
        }
        let sold = soldBefore;
        // mã giữ đã hết hạn dùng -> không bán: trả về kho (AVAILABLE, syncStock sẽ không tính vì đã hết hạn), cấp mã khác bên dưới
        const expiredHeld = await tx.digitalCode.updateMany({
          where: { orderId, orderItemId: item.id, status: 'RESERVED', expiresAt: { lte: now } },
          data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null },
        });
        if (expiredHeld.count && !skip.removed.has(info.id)) skip.removed.set(info.id, {});
        // mã đã giữ khi đặt hàng -> chuyển sang đã bán
        const held = await tx.digitalCode.findMany({ where: { orderId, orderItemId: item.id, status: 'RESERVED' }, select: { id: true, content: true, note: true }, orderBy: { reservedAt: 'asc' }, take: Math.max(0, item.quantity - sold) });
        // mã giữ không giải mã được (đổi khoá) -> Tạm khoá, rời đơn, không giao; phần thiếu lấy bù từ kho bên dưới
        const reserved = held.filter((r) => decryptCode(r.content, this.keys) !== null);
        if (reserved.length < held.length) {
          for (const r of held) if (!reserved.includes(r)) await this.disableUndecryptable(tx, r);
          this.reportUndecryptable(info.id, held.length - reserved.length);
        }
        if (reserved.length) {
          const ids = reserved.map((r) => r.id);
          // chỉ chuyển mã VẪN đang giữ cho đúng đơn này (admin có thể vừa thu hồi / trả kho mã đó)
          const res = await tx.digitalCode.updateMany({ where: { id: { in: ids }, status: 'RESERVED', orderId }, data: { status: 'SOLD', soldAt: now } });
          const done = res.count === ids.length ? ids : (await tx.digitalCode.findMany({ where: { id: { in: ids }, status: 'SOLD', orderId, soldAt: now }, select: { id: true } })).map((r) => r.id);
          skip.newIds.push(...done);
          sold += done.length;
        }
        // còn thiếu (đặt trước / mã giữ bị nhả) -> lấy thêm từ kho
        const need = item.quantity - sold;
        if (need > 0) {
          const picked = await this.pickAvailable(tx, info.id, item.variantId, need);
          // kho có thể vừa đổi (mã hỏng bị Tạm khoá) -> luôn đồng bộ lại tồn kho sản phẩm này
          if (!skip.removed.has(info.id)) skip.removed.set(info.id, {});
          if (picked.length) {
            const ids = picked.map((p) => p.id);
            await tx.digitalCode.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'SOLD', orderId, orderItemId: item.id, reservedAt: now, soldAt: now } });
            skip.newIds.push(...ids);
            sold += ids.length;
            const r = skip.removed.get(info.id) ?? {};
            r[item.variantId ?? ''] = (r[item.variantId ?? ''] ?? 0) + ids.length;
            skip.removed.set(info.id, r);
          }
        }
        missing += Math.max(0, item.quantity - sold);
        lines.push({ quantity: item.quantity, sold });
      }
      // mã giữ thừa (dòng bị giảm số lượng / xoá) -> trả về kho
      const leftover = await tx.digitalCode.findMany({ where: { orderId, status: 'RESERVED' }, select: { id: true, productId: true } });
      if (leftover.length) {
        await tx.digitalCode.updateMany({ where: { id: { in: leftover.map((l) => l.id) }, status: 'RESERVED', orderId }, data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null } });
        for (const l of leftover) if (!skip.removed.has(l.productId)) skip.removed.set(l.productId, {});
      }
      const codeStatus = this.codeStatusOf(lines);
      if (codeStatus !== order.codeStatus || (codeStatus === 'delivered' && !order.codesDeliveredAt)) {
        await tx.order.update({ where: { id: orderId }, data: { codeStatus, ...(codeStatus === 'delivered' && !order.codesDeliveredAt ? { codesDeliveredAt: now } : {}) } });
      }
      return { ...skip, missing, codeStatus };
    });

    const { order, newIds, missing, codeStatus, prevCodeStatus } = res;
    const productIds = new Set<string>(res.removed.keys());
    if (newIds.length) {
      const sold = await this.prisma.digitalCode.findMany({ where: { id: { in: newIds } }, include: { order: { select: { code: true } } } });
      for (const s of sold) productIds.add(s.productId);
      for (const pid of productIds) await this.syncStock(pid, undefined, res.removed.get(pid)).catch((err: Error) => this.logger.warn(`Đồng bộ kho ${pid} lỗi: ${err.message}`));
      this.events.emit('digital.delivered', { orderId, count: newIds.length });
      this.events.emit('content.changed', { type: 'product', tags: ['products'] });
      await this.hooks.doAction('digital.delivered', order, await this.presentAdmin(sold));
      if (opts.notify) await this.sendCodesMail('digital.delivered', order, sold).catch((err: Error) => this.logger.warn(`Không gửi được email giao mã đơn ${order.code}: ${err.message}`));
      if (opts.actor) this.events.emit('activity', { userId: opts.actor.id, action: 'digital_codes.deliver', entityType: 'order', entityId: orderId, meta: { count: newIds.length, force: !!opts.force } });
    } else {
      for (const pid of productIds) await this.syncStock(pid).catch(() => undefined);
    }
    // báo thiếu mã: giao bù (nhập mã) chỉ báo khi đơn vừa chuyển sang thiếu; đường khác (thanh toán, admin giao) báo như cũ
    const wasMissing = prevCodeStatus === 'pending' || prevCodeStatus === 'partial';
    const shouldWarn = !opts.backfill || !wasMissing;
    if (missing > 0 && shouldWarn && PAID_STATUSES.includes(order.paymentStatus) && !CLOSED_STATUSES.includes(order.status)) {
      this.logger.warn(`Đơn #${order.code} đã thanh toán nhưng thiếu ${missing} mã — nhập thêm mã hoặc giao tay trong chi tiết đơn`);
    }
    await this.maybeAutoComplete(orderId);
    return { delivered: newIds.length, missing, codeStatus };
  }

  /**
   * Tự chuyển đơn sang "Hoàn thành" khi: bật autoCompleteOrders, đơn PAID, không cần giao hàng, đang mở và đã giao đủ mã.
   * Gọi OrdersService.update (lấy lười qua ModuleRef, tránh vòng phụ thuộc) để giữ đúng chuỗi sự kiện / lịch sử / email.
   */
  private async maybeAutoComplete(orderId: string) {
    try {
      const settings = await this.digitalSettings();
      if (!settings.autoCompleteOrders) return;
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, paymentStatus: true, requiresShipping: true, codeStatus: true } });
      if (!order || order.paymentStatus !== 'PAID' || order.requiresShipping || !OPEN_STATUSES.includes(order.status) || order.codeStatus !== 'delivered') return;
      const orders = await this.ordersService();
      await orders.update(orderId, { status: 'COMPLETED', statusNote: 'Tự động hoàn thành: đã giao đủ mã cho đơn hàng ảo' }, SYSTEM_ACTOR, { status: order.status });
    } catch (err) {
      this.logger.warn(`Không tự hoàn thành được đơn ${orderId}: ${(err as Error).message}`);
    }
  }

  /** OrdersService lấy lúc chạy (OrdersService inject DigitalCodesService -> import tĩnh sẽ tạo vòng) */
  private async ordersService(): Promise<OrdersService> {
    const mod = await import('../orders/orders.service.js');
    return this.moduleRef.get(mod.OrdersService, { strict: false });
  }

  /** Nhả mã đang giữ của đơn về kho (huỷ / hoàn tiền). Mã đã bán giữ nguyên. */
  async releaseForOrder(orderId: string): Promise<number> {
    const rows = await this.prisma.digitalCode.findMany({ where: { orderId, status: 'RESERVED' }, select: { id: true, productId: true } });
    // OrdersService đã cộng lại stockQuantity theo số lượng dòng hàng (kể cả mã đã bán) -> luôn tính lại tồn kho
    // cho mọi sản phẩm kho mã của đơn để tồn kho khớp số mã thực còn trong kho
    const items = await this.prisma.orderItem.findMany({ where: { orderId }, select: { productId: true } }).catch(() => [] as { productId: string | null }[]);
    const productIds = new Set([...rows.map((r) => r.productId), ...(items ?? []).map((i) => i.productId).filter((x): x is string => !!x)]);
    const res = rows.length
      ? await this.prisma.digitalCode.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'RESERVED' }, data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null } })
      : { count: 0 };
    // syncStock tự bỏ qua sản phẩm không bán theo kho mã
    for (const pid of productIds) await this.syncStock(pid);
    if (!productIds.size) return 0;
    this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    return res.count;
  }

  /** Giao bù cho các đơn đã thanh toán còn thiếu mã (cũ nhất trước) — sau khi nhập / mở khoá mã */
  async fulfillBackorders(productId?: string): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: { paymentStatus: 'PAID', codeStatus: { in: ['pending', 'partial'] }, status: { notIn: ['CANCELLED', 'REFUNDED'] }, ...(productId ? { items: { some: { productId } } } : {}) },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
      take: 200,
    });
    let fulfilled = 0;
    for (const o of orders) {
      try {
        const r = await this.deliverForOrder(o.id, { notify: true, backfill: true });
        if (r.delivered > 0) fulfilled++;
      } catch (err) {
        this.logger.warn(`Giao bù mã cho đơn ${o.id} lỗi: ${(err as Error).message}`);
      }
    }
    return fulfilled;
  }

  /**
   * Sau khi admin sửa dòng hàng: nhả mã giữ của dòng đã xoá / thừa, giữ thêm cho dòng tăng số lượng (đơn chưa thanh toán),
   * giao bù ngay nếu đơn đã thanh toán.
   */
  async reconcileOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order || CLOSED_STATUSES.includes(order.status)) return;
    if (PAID_STATUSES.includes(order.paymentStatus)) {
      await this.deliverForOrder(orderId, { notify: true });
      return;
    }
    const touched = new Set<string>();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const items = await tx.orderItem.findMany({ where: { orderId } });
      const infos = await this.productInfos(items.map((i) => i.productId), tx);
      const reserved = await tx.digitalCode.findMany({ where: { orderId, status: 'RESERVED' }, select: { id: true, productId: true, variantId: true, orderItemId: true }, orderBy: { reservedAt: 'asc' } });
      const release: string[] = [];
      for (const r of reserved) {
        const item = items.find((i) => i.id === r.orderItemId);
        if (!item || item.productId !== r.productId || (item.variantId ?? null) !== r.variantId || !infos.get(r.productId)?.codeDelivery) release.push(r.id);
      }
      const now = new Date();
      // số mã đã giao từng dòng -> tính codeStatus (đơn chưa thanh toán vẫn có thể đã được admin "Vẫn giao")
      const lines: { quantity: number; sold: number }[] = [];
      for (const item of items) {
        const info = item.productId ? infos.get(item.productId) : undefined;
        if (!info?.codeDelivery) {
          // dòng không bán theo kho mã nhưng có mã giao tay -> vẫn tính vào trạng thái giao mã
          const manual = await this.deliveredCount(tx, item.id);
          if (manual) lines.push({ quantity: item.quantity, sold: manual });
          continue;
        }
        const mine = reserved.filter((r) => r.orderItemId === item.id && !release.includes(r.id));
        const sold = await this.deliveredCount(tx, item.id);
        lines.push({ quantity: item.quantity, sold });
        const extra = mine.length + sold - item.quantity;
        if (extra > 0) release.push(...mine.slice(mine.length - Math.min(extra, mine.length)).map((r) => r.id));
        else if (extra < 0) {
          // giữ thêm (không ném lỗi: admin đã sửa đơn, phần thiếu giao bù sau khi thanh toán / nhập mã)
          const picked = await this.pickAvailable(tx, info.id, item.variantId, -extra);
          if (picked.length) await tx.digitalCode.updateMany({ where: { id: { in: picked.map((p) => p.id) }, status: 'AVAILABLE' }, data: { status: 'RESERVED', orderId, orderItemId: item.id, reservedAt: now } });
          if (picked.length) touched.add(info.id);
        }
      }
      if (release.length) {
        await tx.digitalCode.updateMany({ where: { id: { in: release }, status: 'RESERVED' }, data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null } });
        for (const r of reserved) if (release.includes(r.id)) touched.add(r.productId);
      }
      const codeStatus = this.codeStatusOf(lines);
      if (codeStatus !== order.codeStatus || (codeStatus === 'delivered' && !order.codesDeliveredAt)) {
        await tx.order.update({ where: { id: orderId }, data: { codeStatus, ...(codeStatus === 'delivered' && !order.codesDeliveredAt ? { codesDeliveredAt: now } : {}) } });
      }
    });
    for (const pid of touched) await this.syncStock(pid);
  }

  // ---------------- sự kiện đơn hàng ----------------

  /** Đơn thanh toán (webhook / ví / admin đánh dấu) -> giao mã + email */
  @OnEvent('order.paid', { async: true })
  async onOrderPaid(payload: { order?: { id: string } }) {
    if (!payload?.order?.id) return;
    await this.deliverForOrder(payload.order.id, { notify: true }).catch((err: Error) => this.logger.error(`Không giao được mã cho đơn ${payload.order!.id}: ${err.message}`));
  }

  /**
   * Đơn đã commit: đồng bộ kho + gửi cảnh báo đã gom lúc giữ mã; admin tạo đơn đã thanh toán sẵn (không phát order.paid) -> giao mã luôn.
   * Đơn web trả bằng ví cũng PAID ngay nhưng đã phát order.paid -> giao ở onOrderPaid (không chạy giao 2 lần song song).
   */
  @OnEvent('order.created', { async: true })
  async onOrderCreated(payload: { order?: { id: string; paymentStatus?: string; codeStatus?: string | null; source?: string | null }; source?: string }) {
    const o = payload?.order;
    if (o?.id) this.flushAlerts(o.id);
    if (!o?.id || o.paymentStatus !== 'PAID') return;
    if ((o.source ?? payload.source) !== 'admin') return;
    await this.deliverForOrder(o.id, { notify: true }).catch((err: Error) => this.logger.error(`Không giao được mã cho đơn ${o.id}: ${err.message}`));
  }

  /** Huỷ / hoàn tiền -> nhả mã đang giữ về kho */
  @OnEvent('order.statusChanged', { async: true })
  async onStatusChanged(payload: { order?: { id: string }; to?: string }) {
    if (!payload?.order?.id || !CLOSED_STATUSES.includes(String(payload.to))) return;
    await this.releaseForOrder(payload.order.id).catch((err: Error) => this.logger.error(`Không nhả được mã của đơn ${payload.order!.id}: ${err.message}`));
  }

  /** Hoàn tiền toàn bộ (kể cả khi trạng thái đơn không đổi) -> nhả mã đang giữ */
  @OnEvent('order.refunded', { async: true })
  async onRefunded(payload: { order?: { id: string; paymentStatus?: string } }) {
    if (!payload?.order?.id) return;
    // hoàn tiền một phần có "hoàn kho" -> stockQuantity bị cộng theo số lượng, tính lại theo số mã thực
    if (payload.order.paymentStatus !== 'REFUNDED') return this.syncOrderProducts(payload.order.id);
    await this.releaseForOrder(payload.order.id).catch((err: Error) => this.logger.error(`Không nhả được mã của đơn ${payload.order!.id}: ${err.message}`));
  }

  /** Admin sửa dòng hàng -> đối soát mã giữ / giao */
  @OnEvent('order.itemsChanged', { async: true })
  async onItemsChanged(payload: { order?: { id: string } }) {
    if (!payload?.order?.id) return;
    await this.reconcileOrder(payload.order.id).catch((err: Error) => this.logger.error(`Không đối soát được mã của đơn ${payload.order!.id}: ${err.message}`));
    // OrdersAdminService đã trừ / cộng stockQuantity theo số lượng -> tính lại theo số mã thực
    await this.syncOrderProducts(payload.order.id);
  }

  /** Tính lại tồn kho cho mọi sản phẩm kho mã trong đơn (sau khi module đơn hàng tự cộng / trừ stockQuantity) */
  private async syncOrderProducts(orderId: string) {
    const items = await this.prisma.orderItem.findMany({ where: { orderId }, select: { productId: true } }).catch(() => [] as { productId: string | null }[]);
    for (const pid of new Set(items.map((i) => i.productId).filter((x): x is string => !!x))) await this.syncStock(pid).catch((err: Error) => this.logger.warn(`Đồng bộ kho ${pid} lỗi: ${err.message}`));
  }

  // ===========================================================================
  // Admin: mã của đơn
  // ===========================================================================

  async byOrder(orderId: string): Promise<AdminOrderCodes> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const codes = await this.prisma.digitalCode.findMany({ where: { orderId }, include: { order: { select: { code: true } } }, orderBy: [{ soldAt: 'asc' }, { createdAt: 'asc' }] });
    const infos = await this.productInfos([...order.items.map((i) => i.productId), ...codes.map((c) => c.productId)]);
    return {
      orderId: order.id,
      orderCode: order.code,
      codeStatus: (order.codeStatus as OrderCodeStatus | null) ?? null,
      paid: PAID_STATUSES.includes(order.paymentStatus),
      items: order.items.map((item) => {
        const info = item.productId ? infos.get(item.productId) : undefined;
        // mã của dòng đã bị xoá (orderItemId null) gắn vào dòng cùng sản phẩm / biến thể
        const mine = codes.filter((c) => c.orderItemId === item.id || (!c.orderItemId && c.productId === item.productId && c.variantId === (item.variantId ?? null)));
        return {
          orderItemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.name,
          variantLabel: this.variantLabel(info, item.variantId, 'vi', item.optionValues),
          quantity: item.quantity,
          codeDelivery: !!info?.codeDelivery,
          // cùng quy tắc deliveredCount: SOLD + REVOKED của đúng dòng, không tính mã thay thế
          delivered: codes.filter((c) => c.orderItemId === item.id && (c.status === 'SOLD' || c.status === 'REVOKED') && !c.replacesId).length,
          fields: this.itemFields(item),
          codes: mine.map((c) => this.toAdmin(c, infos)),
        };
      }),
    };
  }

  private itemFields(item: { meta: unknown }): PurchaseFieldValue[] {
    const meta = item.meta as { fields?: unknown } | null;
    return Array.isArray(meta?.fields) ? (meta.fields as PurchaseFieldValue[]).filter((f) => f && typeof f.key === 'string') : [];
  }

  /** Admin bấm "Giao mã ngay" */
  async deliverNow(orderId: string, force: boolean, actor: AuthUser): Promise<AdminOrderCodes> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, paymentStatus: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (CLOSED_STATUSES.includes(order.status)) throw new BadRequestException('Đơn đã huỷ / hoàn tiền, không giao mã');
    if (!PAID_STATUSES.includes(order.paymentStatus) && !force) throw new BadRequestException('Đơn chưa thanh toán. Chọn "Vẫn giao" nếu muốn giao trước khi nhận tiền.');
    const r = await this.deliverForOrder(orderId, { force, notify: true, actor });
    if (!r.delivered && r.missing) throw new BadRequestException(`Kho không đủ mã, còn thiếu ${r.missing} mã`);
    return this.byOrder(orderId);
  }

  /** Admin giao tay nội dung cho một dòng hàng */
  async manual(orderId: string, dto: ManualCodeDto, actor: AuthUser): Promise<AdminOrderCodes> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (CLOSED_STATUSES.includes(order.status)) throw new BadRequestException('Đơn đã huỷ / hoàn tiền');
    const item = order.items.find((i) => i.id === dto.orderItemId);
    if (!item) throw new BadRequestException('Dòng hàng không thuộc đơn này');
    if (!item.productId) throw new BadRequestException('Sản phẩm của dòng hàng đã bị xoá, không gắn được mã');
    const content = normalizeCode(dto.content);
    if (!content) throw new BadRequestException('Nội dung trống');
    const info = (await this.productInfos([item.productId])).get(item.productId);
    const now = new Date();
    const row = await this.prisma.digitalCode.create({
      data: {
        productId: item.productId,
        variantId: item.variantId,
        content: this.encrypt(content),
        contentHash: this.manualHash(content),
        preview: codePreview(content, this.codeFieldsOf(info)),
        note: dto.note?.trim() || null,
        status: 'SOLD',
        source: 'manual',
        orderId,
        orderItemId: item.id,
        reservedAt: now,
        soldAt: now,
        createdById: actor.id,
      },
      include: { order: { select: { code: true } } },
    });
    await this.refreshCodeStatus(orderId);
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.manual', entityType: 'order', entityId: orderId, meta: { orderItemId: item.id, codeId: row.id } });
    this.events.emit('digital.delivered', { orderId, count: 1 });
    await this.hooks.doAction('digital.delivered', order, await this.presentAdmin([row]));
    if (dto.notify !== false) await this.sendCodesMail('digital.delivered', order, [row]).catch((err: Error) => this.logger.warn(`Không gửi được email giao mã đơn ${order.code}: ${err.message}`));
    await this.maybeAutoComplete(orderId);
    return this.byOrder(orderId);
  }

  /** Tính lại codeStatus theo số mã đã giao (SOLD + REVOKED) từng dòng (dòng bán theo kho mã + dòng có mã giao tay) */
  private async refreshCodeStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return;
    const infos = await this.productInfos(order.items.map((i) => i.productId));
    const lines: { quantity: number; sold: number }[] = [];
    for (const item of order.items) {
      const sold = await this.deliveredCount(this.prisma, item.id);
      if (sold || (item.productId && infos.get(item.productId)?.codeDelivery)) lines.push({ quantity: item.quantity, sold });
    }
    const codeStatus = this.codeStatusOf(lines);
    if (codeStatus !== order.codeStatus || (codeStatus === 'delivered' && !order.codesDeliveredAt)) {
      await this.prisma.order.update({ where: { id: orderId }, data: { codeStatus, ...(codeStatus === 'delivered' && !order.codesDeliveredAt ? { codesDeliveredAt: new Date() } : {}) } });
    }
  }

  /** Gửi lại email giao mã (toàn bộ mã đang dùng của đơn) */
  async resend(orderId: string, actor: AuthUser): Promise<{ ok: true }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (!order.customerEmail) throw new BadRequestException('Đơn không có email khách hàng');
    const codes = await this.prisma.digitalCode.findMany({ where: { orderId, status: 'SOLD' }, orderBy: { soldAt: 'asc' } });
    if (!codes.length) throw new BadRequestException('Đơn chưa có mã nào được giao');
    const r = await this.sendCodesMail('digital.delivered', order, codes);
    if (r.status === 'FAILED') throw new BadRequestException(`Gửi email lỗi: ${r.error}`);
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.resend', entityType: 'order', entityId: orderId, meta: { to: order.customerEmail, count: codes.length, status: r.status } });
    return { ok: true };
  }

  /** Đổi mã (bảo hành): mã cũ REVOKED, mã mới lấy từ kho hoặc nhập tay; xử lý luôn báo lỗi đang mở */
  async replace(id: string, dto: ReplaceCodeDto, actor: AuthUser): Promise<AdminDigitalCode> {
    const reason = dto.reason?.trim() || 'Đổi mã bảo hành';
    const manual = dto.content !== undefined ? normalizeCode(dto.content) : null;
    if (manual !== null && !manual) throw new BadRequestException('Nội dung mã thay thế trống');
    const now = new Date();
    const removed: Record<string, number> = {};
    const { oldRow, newId } = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM digital_codes WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Không tìm thấy mã');
      const oldRow = await tx.digitalCode.findUniqueOrThrow({ where: { id } });
      if (oldRow.status !== 'SOLD' || !oldRow.orderId) throw new BadRequestException('Chỉ đổi được mã đã giao cho khách');
      let newId: string;
      if (manual !== null) {
        const info = (await this.productInfos([oldRow.productId], tx)).get(oldRow.productId);
        const created = await tx.digitalCode.create({
          data: {
            productId: oldRow.productId,
            variantId: oldRow.variantId,
            content: this.encrypt(manual),
            contentHash: this.manualHash(manual),
            preview: codePreview(manual, this.codeFieldsOf(info)),
            status: 'SOLD',
            source: 'manual',
            orderId: oldRow.orderId,
            orderItemId: oldRow.orderItemId,
            reservedAt: now,
            soldAt: now,
            replacesId: oldRow.id,
            createdById: actor.id,
          },
        });
        newId = created.id;
      } else {
        const [picked] = await this.pickAvailable(tx, oldRow.productId, oldRow.variantId, 1);
        if (!picked) throw new BadRequestException('Kho đã hết mã cho sản phẩm này — hãy nhập nội dung mã thay thế thủ công');
        await tx.digitalCode.update({ where: { id: picked.id }, data: { status: 'SOLD', orderId: oldRow.orderId, orderItemId: oldRow.orderItemId, reservedAt: now, soldAt: now, replacesId: oldRow.id, source: 'replacement' } });
        removed[oldRow.variantId ?? ''] = 1;
        newId = picked.id;
      }
      await tx.digitalCode.update({
        where: { id },
        data: {
          status: 'REVOKED',
          revokedAt: now,
          revokeReason: reason,
          ...(oldRow.reportStatus === 'OPEN' ? { reportStatus: 'RESOLVED', reportReply: dto.reason?.trim() || 'Đã đổi mã mới' } : {}),
        },
      });
      return { oldRow, newId };
    });
    if (manual === null) await this.syncStock(oldRow.productId, undefined, removed);
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.replace', entityType: 'digital_code', entityId: id, meta: { newId, orderId: oldRow.orderId, manual: manual !== null, reason } });
    if (dto.notify !== false && oldRow.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: oldRow.orderId }, include: { items: true } });
      const fresh = await this.prisma.digitalCode.findUnique({ where: { id: newId } });
      if (order && fresh) await this.sendCodesMail('digital.replaced', order, [fresh], { reason }).catch((err: Error) => this.logger.warn(`Không gửi được email đổi mã đơn ${order.code}: ${err.message}`));
    }
    return this.adminById(newId);
  }

  /**
   * Thu hồi mã của đơn. Chạy trong transaction, khoá dòng mã (SELECT ... FOR UPDATE) để không chen ngang deliverForOrder.
   * - Mã RESERVED (chưa giao) + restock -> trả về kho (AVAILABLE);
   * - Mã SOLD luôn thành REVOKED (khách có thể đã chép / xem mã qua email, không bán lại); RESERVED không restock cũng REVOKED.
   * Sau đó tính lại codeStatus của đơn (mã REVOKED vẫn tính là đã giao — muốn cấp mã mới dùng "Đổi mã").
   */
  async revoke(id: string, dto: RevokeCodeDto, actor: AuthUser): Promise<AdminDigitalCode> {
    const reason = dto.reason?.trim() || null;
    const { row, restock } = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM digital_codes WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Không tìm thấy mã');
      const row = await tx.digitalCode.findUniqueOrThrow({ where: { id } });
      if (row.status !== 'SOLD' && row.status !== 'RESERVED') throw new BadRequestException('Chỉ thu hồi được mã đã giao / đang giữ cho đơn');
      // chỉ mã đang giữ (chưa giao cho khách) mới được trả về kho
      const restock = !!dto.restock && row.status === 'RESERVED';
      if (restock) {
        await tx.digitalCode.update({
          where: { id },
          data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null, soldAt: null, reportStatus: null, reportNote: null, reportedAt: null, reportReply: null, note: reason ? `${row.note ? `${row.note}\n` : ''}Thu hồi về kho: ${reason}` : row.note },
        });
      } else {
        await tx.digitalCode.update({
          where: { id },
          data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason ?? 'Thu hồi', ...(row.reportStatus === 'OPEN' ? { reportStatus: 'RESOLVED', reportReply: reason ?? 'Đã thu hồi mã' } : {}) },
        });
      }
      return { row, restock };
    });
    // mã rời trạng thái giữ -> tính lại tồn kho
    if (row.status === 'RESERVED') {
      await this.syncStock(row.productId);
      if (restock) this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    }
    if (row.orderId) await this.refreshCodeStatus(row.orderId);
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.revoke', entityType: 'digital_code', entityId: id, meta: { orderId: row.orderId, restock, requestedRestock: !!dto.restock, reason } });
    return this.adminById(id);
  }

  /** Xử lý báo lỗi: RESOLVED (đã xử lý ngoài hệ thống) / REJECTED (từ chối + phản hồi) */
  async resolveReport(id: string, dto: ResolveReportDto, actor: AuthUser): Promise<AdminDigitalCode> {
    const row = await this.prisma.digitalCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy mã');
    if (row.reportStatus !== 'OPEN') throw new BadRequestException('Mã này không có báo lỗi đang chờ xử lý');
    await this.prisma.digitalCode.update({ where: { id }, data: { reportStatus: dto.status, reportReply: dto.reply?.trim() || null } });
    this.events.emit('activity', { userId: actor.id, action: 'digital_codes.resolveReport', entityType: 'digital_code', entityId: id, meta: { status: dto.status, orderId: row.orderId } });
    return this.adminById(id);
  }

  // ===========================================================================
  // Email
  // ===========================================================================

  /**
   * Link xem đơn trên web: thành viên -> trang đơn trong tài khoản, khách vãng lai -> tra cứu đơn.
   * Có tiền tố ngôn ngữ theo order.locale (ngôn ngữ mặc định không tiền tố, ngôn ngữ khác /{locale}).
   */
  private async viewUrl(order: { code: string; userId: string | null; locale?: string | null }) {
    const web = await frontendLocaleBaseUrl(this.config, this.settings, { locale: order.locale, languages: this.languages });
    if (!web) return '';
    return order.userId ? `${web}/account/orders/${encodeURIComponent(order.code)}` : `${web}/order-tracking?code=${encodeURIComponent(order.code)}`;
  }

  /**
   * Email mẫu `digital.delivered` / `digital.replaced`: vars `order.*`, `items[{ productName, variantLabel, deliveryNote, codes[{ parts[{label,value}], content }] }]`,
   * `showCodes` (Cài đặt › Kho mã › gửi mã trong email), `viewUrl`. Tắt showCodes -> không giải mã, email chỉ có link xem mã.
   */
  private async sendCodesMail(key: 'digital.delivered' | 'digital.replaced', order: OrderWithItems, codes: DigitalCode[], extra: Record<string, unknown> = {}) {
    if (!order.customerEmail) return { status: 'SKIPPED' as const, logId: null, reason: 'Không có email' };
    const settings = await this.digitalSettings();
    const locale = order.locale ?? undefined;
    const loc = order.locale ?? 'vi';
    const infos = await this.productInfos(codes.map((c) => c.productId));
    const groups = new Map<string, { productName: string; variantLabel: string | null; deliveryNote: string | null; codes: { parts: { label: string; value: string }[]; content: string }[] }>();
    for (const c of codes) {
      const item = order.items.find((i) => i.id === c.orderItemId);
      const info = infos.get(c.productId);
      const key = c.orderItemId ?? `${c.productId}:${c.variantId ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          productName: item?.name ?? this.productName(info, loc),
          variantLabel: this.variantLabel(info, c.variantId, loc, item?.optionValues),
          deliveryNote: (info ? trOf(info.translations, loc)?.deliveryNote : null) || null,
          codes: [],
        };
        groups.set(key, g);
      }
      if (settings.emailCodes) {
        const content = this.decrypt(c);
        g.codes.push({ parts: splitCodeParts(content, this.codeFieldsOf(info), loc).map((p) => ({ label: p.label, value: p.value })), content });
      } else g.codes.push({ parts: [], content: '' });
    }
    return this.mail.sendTemplate({
      key,
      locale,
      to: order.customerEmail,
      vars: { order: await this.mail.orderVars(order, locale), items: [...groups.values()], showCodes: settings.emailCodes, viewUrl: await this.viewUrl(order), count: codes.length, ...extra },
      // email có nội dung mã -> nhật ký email không lưu lại html sau khi gửi xong
      meta: { orderId: order.id, orderCode: order.code, event: key, ...(settings.emailCodes ? { sensitive: true } : {}) },
    });
  }

  // ===========================================================================
  // Khách hàng
  // ===========================================================================

  /** Dựng OrderCodesView cho một đơn (đơn chưa thanh toán -> danh sách mã rỗng) */
  private async orderView(order: OrderWithItems): Promise<OrderCodesView> {
    const settings = await this.digitalSettings();
    const locale = order.locale ?? 'vi';
    const paid = PAID_STATUSES.includes(order.paymentStatus);
    const codes = paid ? await this.prisma.digitalCode.findMany({ where: { orderId: order.id, status: { in: ['SOLD', 'REVOKED'] } }, orderBy: [{ soldAt: 'asc' }, { createdAt: 'asc' }] }) : [];
    const infos = await this.productInfos([...order.items.map((i) => i.productId), ...codes.map((c) => c.productId)]);
    const chains = await this.chainInfo(codes);
    const items: OrderCodesView['items'] = [];
    for (const item of order.items) {
      const info = item.productId ? infos.get(item.productId) : undefined;
      const mine = codes.filter((c) => c.orderItemId === item.id);
      if (!info?.codeDelivery && !mine.length) continue;
      items.push({
        orderItemId: item.id,
        productName: item.name,
        variantLabel: this.variantLabel(info, item.variantId, locale, item.optionValues),
        quantity: item.quantity,
        delivered: mine.filter((c) => c.status === 'SOLD').length,
        codes: await Promise.all(mine.map((c) => this.toCustomer(c, { orderCode: order.code, item, info, locale, settings, chain: chains.get(c.id) }))),
      });
    }
    await this.markViewed(codes);
    return { orderCode: order.code, codeStatus: (order.codeStatus as OrderCodeStatus | null) ?? null, paid, items };
  }

  /** Thành viên: mọi mã của các đơn đã thanh toán, mới nhất trước */
  async myCodes(userId: string): Promise<CustomerCode[]> {
    const settings = await this.digitalSettings();
    const rows = await this.prisma.digitalCode.findMany({
      where: { status: { in: ['SOLD', 'REVOKED'] }, order: { userId, paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } },
      include: { order: { select: { code: true, locale: true } }, orderItem: true },
      orderBy: [{ soldAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const infos = await this.productInfos(rows.map((r) => r.productId));
    const chains = await this.chainInfo(rows);
    const out = await Promise.all(
      rows.map((r) => this.toCustomer(r, { orderCode: r.order?.code ?? '', item: r.orderItem ?? undefined, info: infos.get(r.productId), locale: r.order?.locale ?? 'vi', settings, chain: chains.get(r.id) })),
    );
    await this.markViewed(rows);
    return out;
  }

  /** Thành viên: mã của một đơn */
  async myOrderCodes(userId: string, code: string): Promise<OrderCodesView> {
    const order = await this.prisma.order.findFirst({ where: { userId, code }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return this.orderView(order);
  }

  /** Khách vãng lai: xác thực bằng mã đơn + SĐT đặt hàng (Cài đặt › Kho mã › cho khách vãng lai xem mã) */
  async guestOrderCodes(code: string, phone: string): Promise<OrderCodesView> {
    const order = await this.guestOrder(code, phone);
    return this.orderView(order);
  }

  private async guestOrder(code: string, phone: string) {
    if (!(await this.digitalSettings()).guestAccess) throw new ForbiddenException('Cửa hàng không cho xem mã khi chưa đăng nhập. Vui lòng đăng nhập tài khoản đã đặt hàng.');
    const c = String(code ?? '').trim();
    const p = String(phone ?? '').trim();
    if (!c || !p) throw new NotFoundException('Không tìm thấy đơn hàng');
    // tìm theo mã đơn (duy nhất) rồi so SĐT bằng phép so sánh thời gian hằng — không lộ qua thời gian phản hồi
    // việc mã đơn có tồn tại hay SĐT đúng mấy ký tự; mọi trường hợp sai đều cùng một câu báo
    const order = await this.prisma.order.findUnique({ where: { code: c }, include: { items: true } });
    if (!safeEqual(order?.customerPhone ?? '', p) || !order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return order;
  }

  /** Thành viên báo lỗi mã */
  async reportMine(userId: string, codeId: string, note: string): Promise<CustomerCode> {
    const row = await this.prisma.digitalCode.findUnique({ where: { id: codeId }, include: { order: { select: { userId: true } } } });
    if (!row || !row.order || row.order.userId !== userId) throw new NotFoundException('Không tìm thấy mã');
    return this.report(row.id, note);
  }

  /** Khách vãng lai báo lỗi mã (mã đơn + SĐT) */
  async reportGuest(code: string, phone: string, codeId: string, note: string): Promise<CustomerCode> {
    const order = await this.guestOrder(code, phone);
    const row = await this.prisma.digitalCode.findFirst({ where: { id: codeId, orderId: order.id }, select: { id: true } });
    if (!row) throw new NotFoundException('Không tìm thấy mã');
    return this.report(row.id, note);
  }

  /** Ghi báo lỗi (kiểm tra bảo hành) + thông báo admin + sự kiện / hook / webhook */
  private async report(codeId: string, note: string): Promise<CustomerCode> {
    const settings = await this.digitalSettings();
    if (!settings.allowReports) throw new ForbiddenException('Cửa hàng chưa mở báo lỗi mã');
    const row = await this.prisma.digitalCode.findUnique({ where: { id: codeId }, include: { order: { include: { items: true } } } });
    if (!row?.order) throw new NotFoundException('Không tìm thấy mã');
    const order = row.order;
    if (!PAID_STATUSES.includes(order.paymentStatus)) throw new BadRequestException('Đơn hàng chưa thanh toán');
    if (row.status !== 'SOLD') throw new BadRequestException('Mã này đã bị thu hồi / thay thế');
    // chống spam: đang chờ xử lý / đã bị từ chối / cả chuỗi đổi mã đã báo quá số lần cho phép
    const chain = (await this.chainInfo([row])).get(row.id);
    const blocked = this.reportBlockReason(row, chain);
    if (blocked) throw new BadRequestException(blocked);
    const info = (await this.productInfos([row.productId])).get(row.productId);
    // bảo hành tính từ lúc bán mã GỐC (mã thay thế không gia hạn bảo hành)
    const warrantyUntil = this.warrantyUntil(row, info, chain);
    if (!warrantyUntil) throw new BadRequestException('Sản phẩm này không áp dụng bảo hành / báo lỗi mã');
    if (warrantyUntil.getTime() < Date.now()) throw new BadRequestException('Đã hết thời hạn bảo hành của mã');
    const text = String(note ?? '').trim().slice(0, 2000);
    if (text.length < 3) throw new BadRequestException('Vui lòng mô tả lỗi');
    const updated = await this.prisma.digitalCode.update({ where: { id: codeId }, data: { reportStatus: 'OPEN', reportNote: text, reportedAt: new Date(), reportReply: null } });
    const item = order.items.find((i) => i.id === row.orderItemId);
    const admin = (await this.presentAdmin([{ ...updated, order: { code: order.code } }]))[0];
    this.events.emit('digital.reported', { orderId: order.id, codeId, note: text });
    await this.hooks.doAction('digital.reported', admin, order);
    // chuỗi sau khi báo: thêm 1 lần báo nếu trước đó mã chưa từng có reportStatus
    const after: ChainInfo = { rootSoldAt: chain?.rootSoldAt ?? updated.soldAt, reports: (chain?.reports ?? 0) + (row.reportStatus ? 0 : 1) };
    return this.toCustomer(updated, { orderCode: order.code, item, info, locale: order.locale ?? 'vi', settings, chain: after });
  }
}

/** So sánh hai chuỗi theo thời gian hằng (băm sha256 để hai bên cùng độ dài); chuỗi rỗng bên nào cũng là sai */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length > 0;
}
