import { ForbiddenException, GoneException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { STORAGE, type StorageDriver } from '../media/storage.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { OrderDownload, Prisma } from '../../generated/prisma/client.js';

/** Quyền tải file trả về cho khách / admin (không lộ mediaId, url gốc) */
export interface OrderDownloadDto {
  id: string;
  name: string;
  orderId: string;
  orderCode: string;
  productName: string | null;
  productId: string | null;
  downloadLimit: number | null;
  downloadCount: number;
  /** số lượt còn lại (null = không giới hạn) */
  remaining: number | null;
  expiresAt: string | null;
  expired: boolean;
  /** còn tải được không (chưa hết hạn, chưa hết lượt) */
  available: boolean;
  /** link tải công khai theo token */
  url: string;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
}

export interface RegrantOptions {
  /** gia hạn: số ngày kể từ bây giờ; null = vĩnh viễn; undefined = theo cấu hình file của sản phẩm */
  expiryDays?: number | null;
  /** đặt lại số lượt đã tải về 0 */
  resetCount?: boolean;
  /** đổi giới hạn lượt tải; null = không giới hạn; undefined = giữ nguyên */
  downloadLimit?: number | null;
}

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

/**
 * Trạng thái đơn đã đóng: huỷ / hoàn tiền. Đơn ở trạng thái này KHÔNG được tải file nữa
 * dù paymentStatus vẫn còn PAID (vd admin huỷ đơn đã thanh toán, hoàn tiền thủ công ngoài cổng).
 */
const CLOSED_ORDER_STATUSES = ['CANCELLED', 'REFUNDED'] as const;

/** Đơn còn được tải file: đã thanh toán và chưa bị huỷ / hoàn tiền */
const canDownload = (o: { paymentStatus: string; status: string }) => o.paymentStatus === 'PAID' && !(CLOSED_ORDER_STATUSES as readonly string[]).includes(o.status);

@Injectable()
export class DownloadsService {
  private readonly logger = new Logger('Downloads');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly settings: SettingsService,
  ) {}

  // ---------------- cấp quyền tải ----------------

  /** Webhook thanh toán / admin đánh dấu đã thanh toán -> cấp file cho sản phẩm số trong đơn */
  @OnEvent('order.paid', { async: true })
  async onOrderPaid(payload: { order?: { id: string } }) {
    if (!payload?.order?.id) return;
    try {
      await this.grantForOrder(payload.order.id, { notify: true });
    } catch (err) {
      this.logger.error(`Không cấp được file tải về cho đơn ${payload.order.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Tạo OrderDownload cho mọi file của sản phẩm số trong đơn (bỏ qua file đã cấp).
   * Trả về danh sách vừa tạo. `notify` -> gửi email "download.ready" nếu có file mới.
   */
  async grantForOrder(orderId: string, opts: { notify?: boolean } = {}) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const productIds = [...new Set(order.items.map((i) => i.productId).filter((x): x is string => !!x))];
    if (!productIds.length) return [];
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds }, type: 'DIGITAL' }, include: { downloads: { orderBy: { sortOrder: 'asc' } } } });
    if (!products.length) return [];
    const existing = await this.prisma.orderDownload.findMany({ where: { orderId }, select: { productDownloadId: true, orderItemId: true } });
    const has = new Set(existing.map((e) => `${e.orderItemId ?? ''}:${e.productDownloadId ?? ''}`));
    const base = order.paidAt ?? new Date();
    const created: OrderDownload[] = [];
    for (const item of order.items) {
      const product = products.find((p) => p.id === item.productId);
      if (!product) continue;
      for (const d of product.downloads) {
        if (has.has(`${item.id}:${d.id}`)) continue;
        const row = await this.prisma.orderDownload.create({
          data: {
            orderId,
            orderItemId: item.id,
            productDownloadId: d.id,
            name: d.name,
            mediaId: d.mediaId,
            url: d.url,
            downloadLimit: d.downloadLimit,
            expiresAt: d.expiryDays ? new Date(base.getTime() + d.expiryDays * 86_400_000) : null,
            token: randomBytes(32).toString('hex'),
          },
        });
        created.push(row);
        has.add(`${item.id}:${d.id}`);
      }
    }
    if (created.length) {
      this.events.emit('order.downloadsGranted', { orderId, count: created.length });
      await this.hooks.doAction('order.downloadsGranted', order, created);
      if (opts.notify) await this.notify(order, created).catch((err) => this.logger.warn(`Không gửi được email file tải về cho đơn ${order.code}: ${(err as Error).message}`));
    }
    return created;
  }

  /** Email mẫu `download.ready` (Cài đặt › Email): vars `order.*` + `downloads[{ name, productName, url, expiresAt, limit }]` */
  private async notify(order: OrderWithItems, downloads: OrderDownload[]) {
    const to = order.customerEmail;
    if (!to) return;
    const list = await this.present(downloads, order);
    const locale = order.locale ?? undefined;
    await this.mail.sendTemplate({
      key: 'download.ready',
      locale,
      to,
      vars: {
        order: await this.mail.orderVars(order, locale),
        downloads: list.map((d) => ({ name: d.name, productName: d.productName, url: d.url, expiresAt: d.expiresAt, limit: d.downloadLimit })),
        // link trang tài khoản trên frontend riêng; chưa cấu hình địa chỉ website thì để trống (không ghép link tương đối)
        // có tiền tố ngôn ngữ theo order.locale (mặc định không tiền tố, ngôn ngữ khác /{locale})
        accountUrl: await this.mail.frontendLink('/account#downloads', order.locale),
      },
      meta: { orderId: order.id, orderCode: order.code, event: 'download.ready' },
    });
  }

  // ---------------- danh sách ----------------

  private downloadUrl(token: string) {
    return `${this.config.get<string>('apiPublicUrl')}/api/public/downloads/${token}`;
  }

  /** Chuẩn hoá bản ghi + tên sản phẩm (từ OrderItem) + thông tin file (từ Media) */
  private async present(rows: OrderDownload[], order?: { id: string; code: string }): Promise<OrderDownloadDto[]> {
    if (!rows.length) return [];
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const orders = order && orderIds.length === 1 && orderIds[0] === order.id ? [order] : await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true } });
    const items = await this.prisma.orderItem.findMany({ where: { id: { in: rows.map((r) => r.orderItemId).filter((x): x is string => !!x) } }, select: { id: true, name: true, productId: true } });
    const media = await this.prisma.media.findMany({ where: { id: { in: rows.map((r) => r.mediaId).filter((x): x is string => !!x) } }, select: { id: true, originalName: true, size: true, mimeType: true } });
    const now = Date.now();
    return rows.map((r) => {
      const item = items.find((i) => i.id === r.orderItemId);
      const m = media.find((x) => x.id === r.mediaId);
      const expired = !!r.expiresAt && r.expiresAt.getTime() < now;
      const remaining = r.downloadLimit == null ? null : Math.max(0, r.downloadLimit - r.downloadCount);
      return {
        id: r.id,
        name: r.name,
        orderId: r.orderId,
        orderCode: orders.find((o) => o.id === r.orderId)?.code ?? '',
        productName: item?.name ?? null,
        productId: item?.productId ?? null,
        downloadLimit: r.downloadLimit,
        downloadCount: r.downloadCount,
        remaining,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        expired,
        available: !expired && (remaining == null || remaining > 0),
        url: this.downloadUrl(r.token),
        fileName: m?.originalName ?? null,
        fileSize: m?.size ?? null,
        mimeType: m?.mimeType ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Admin: file đã cấp của một đơn */
  async listForOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, code: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const rows = await this.prisma.orderDownload.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    return this.present(rows, order);
  }

  /** Thành viên: file của mọi đơn đã thanh toán */
  async myDownloads(userId: string) {
    // chỉ đơn đã thanh toán và chưa huỷ / hoàn tiền
    const rows = await this.prisma.orderDownload.findMany({ where: { order: { userId, paymentStatus: 'PAID', status: { notIn: [...CLOSED_ORDER_STATUSES] } } }, orderBy: [{ createdAt: 'desc' }] });
    return this.present(rows);
  }

  /** Thành viên: file của một đơn */
  async myOrderDownloads(userId: string, code: string) {
    const order = await this.prisma.order.findFirst({ where: { userId, code }, select: { id: true, code: true, paymentStatus: true, status: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (!canDownload(order)) return [];
    return this.present(await this.prisma.orderDownload.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } }), order);
  }

  /** Khách vãng lai: xác thực bằng mã đơn + SĐT như tra cứu đơn */
  async guestDownloads(code: string, phone: string) {
    const order = await this.prisma.order.findFirst({ where: { code, customerPhone: phone }, select: { id: true, code: true, paymentStatus: true, status: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (!canDownload(order)) return [];
    return this.present(await this.prisma.orderDownload.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } }), order);
  }

  // ---------------- tải file ----------------

  /**
   * Kiểm tra token, hạn, lượt rồi tăng downloadCount (nguyên tử, không vượt giới hạn khi tải song song).
   * Trả về file (buffer) hoặc URL ngoài để redirect.
   */
  async consume(token: string): Promise<{ kind: 'file'; buffer: Buffer; filename: string; mimeType: string } | { kind: 'redirect'; url: string }> {
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new NotFoundException('Liên kết tải không hợp lệ');
    const row = await this.prisma.orderDownload.findUnique({ where: { token }, include: { order: { select: { paymentStatus: true, status: true } } } });
    if (!row) throw new NotFoundException('Liên kết tải không hợp lệ');
    // đã thanh toán VÀ đơn chưa bị huỷ / hoàn tiền (paymentStatus có thể vẫn PAID sau khi admin huỷ đơn)
    if (!canDownload(row.order)) throw new ForbiddenException('Đơn hàng chưa thanh toán, đã huỷ hoặc đã hoàn tiền');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) throw new GoneException('Liên kết tải đã hết hạn');
    const claimed = await this.prisma.$executeRaw`UPDATE order_downloads SET "downloadCount" = "downloadCount" + 1 WHERE id = ${row.id}::uuid AND ("downloadLimit" IS NULL OR "downloadCount" < "downloadLimit")`;
    if (!claimed) throw new GoneException('Đã hết lượt tải cho file này');
    this.events.emit('order.downloaded', { orderId: row.orderId, downloadId: row.id });

    if (row.mediaId) {
      const media = await this.prisma.media.findUnique({ where: { id: row.mediaId } });
      if (!media) throw new NotFoundException('File không còn tồn tại');
      const buffer = await this.storage.get(media.path).catch(() => null);
      if (!buffer) throw new NotFoundException('File không còn tồn tại');
      return { kind: 'file', buffer, filename: media.originalName || media.filename, mimeType: media.mimeType };
    }
    if (row.url) return { kind: 'redirect', url: row.url };
    throw new NotFoundException('File không còn tồn tại');
  }

  // ---------------- admin ----------------

  /** Cấp lại / gia hạn: tạo file còn thiếu, gia hạn, đặt lại lượt theo tuỳ chọn */
  async regrant(orderId: string, opts: RegrantOptions, actorId?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, code: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    await this.grantForOrder(orderId);
    const rows = await this.prisma.orderDownload.findMany({ where: { orderId } });
    const sources = await this.prisma.productDownload.findMany({ where: { id: { in: rows.map((r) => r.productDownloadId).filter((x): x is string => !!x) } } });
    const now = Date.now();
    for (const r of rows) {
      const src = sources.find((s) => s.id === r.productDownloadId);
      const data: Prisma.OrderDownloadUpdateInput = {};
      if (opts.expiryDays === null) data.expiresAt = null;
      else if (typeof opts.expiryDays === 'number') data.expiresAt = new Date(now + opts.expiryDays * 86_400_000);
      else data.expiresAt = src?.expiryDays ? new Date(now + src.expiryDays * 86_400_000) : null;
      if (opts.resetCount !== false) data.downloadCount = 0;
      if (opts.downloadLimit !== undefined) data.downloadLimit = opts.downloadLimit;
      await this.prisma.orderDownload.update({ where: { id: r.id }, data });
    }
    if (actorId) this.events.emit('activity', { userId: actorId, action: 'order.downloads.regrant', entityType: 'order', entityId: orderId, meta: opts });
    return this.listForOrder(orderId);
  }
}
