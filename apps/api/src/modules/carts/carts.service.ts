import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { normalizePurchaseFields, purchaseFieldsKey, readAbandonedCartSettings, readPurchaseInput, readFeatures, type AbandonedCartDetail, type AbandonedCartRow, type AbandonedCartSettings, type AbandonedCartStats, type AbandonedCartStatus, type CartLine, type PublicCart, type ServerCartItem } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MailService } from '../mail/mail.service.js';
import { CronService } from '../scheduler/cron.service.js';
import { effectivePrice, publishedProductWhere } from '../products/products.presenter.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Cart, Prisma } from '../../generated/prisma/client.js';
import { frontendBaseUrl, frontendLocaleBaseUrl } from '../../common/utils/frontend-url.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { AbandonedCartQueryDto, SyncCartDto } from './carts.dto.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Số giỏ tối đa xử lý mỗi lượt cron (mỗi loại nhắc) */
const BATCH = 50;
/** Giỏ có ít nhất 1 sản phẩm (cột Json khác mảng rỗng) */
const NOT_EMPTY: Prisma.CartWhereInput = { NOT: { items: { equals: [] } } };

/** Khoá gộp dòng: sản phẩm + biến thể + thông tin khách nhập (khác ID game -> 2 dòng khác nhau) */
const keyOf = (i: { productId: string; variantId: string | null; fields?: Record<string, string> }) => `${i.productId}:${i.variantId ?? ''}:${purchaseFieldsKey(i.fields)}`;

/**
 * Đọc `fields` (giá trị khách nhập khi mua) an toàn: tối đa 10 khoá chuỗi, mỗi giá trị ≤ 2000 ký tự; rỗng -> undefined.
 * Dùng chung quy tắc với báo giá (QuoteLine.inputFields) để storefront khớp dòng giỏ với dòng báo giá.
 */
export function readCartFields(raw: unknown): Record<string, string> | undefined {
  return readPurchaseInput(raw);
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Đọc Cart.items (Json) an toàn */
function readItems(raw: unknown): ServerCartItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { productId?: unknown }).productId === 'string')
    .map((x) => {
      const fields = readCartFields(x.fields);
      return { productId: String(x.productId), variantId: typeof x.variantId === 'string' && x.variantId ? x.variantId : null, quantity: Math.max(1, Math.min(999, Math.floor(Number(x.quantity)) || 1)), ...(fields ? { fields } : {}) };
    });
}

/** Gộp trùng dòng (cùng sản phẩm + biến thể) trong 1 giỏ: cộng số lượng */
function dedupe(items: ServerCartItem[]): ServerCartItem[] {
  const map = new Map<string, ServerCartItem>();
  for (const i of items) {
    const k = keyOf(i);
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, quantity: Math.min(999, prev.quantity + i.quantity) } : { ...i });
  }
  return [...map.values()];
}

/**
 * Gộp nhiều giỏ (đăng nhập trên thiết bị mới, giỏ khách + giỏ tài khoản): cùng dòng lấy số lượng LỚN NHẤT
 * (không cộng dồn để đồng bộ lặp lại không nhân đôi số lượng), giữ thứ tự xuất hiện.
 */
function mergeItems(...lists: ServerCartItem[][]): ServerCartItem[] {
  const map = new Map<string, ServerCartItem>();
  for (const list of lists) {
    for (const i of list) {
      const prev = map.get(keyOf(i));
      if (!prev || prev.quantity < i.quantity) map.set(keyOf(i), { ...i });
    }
  }
  return [...map.values()];
}

const sameItems = (a: ServerCartItem[], b: ServerCartItem[]) => a.length === b.length && a.every((x, i) => keyOf(x) === keyOf(b[i]) && x.quantity === b[i].quantity);

const itemCount = (raw: unknown) => readItems(raw).reduce((n, i) => n + i.quantity, 0);

/**
 * Giỏ hàng lưu máy chủ + nhắc giỏ bỏ dở.
 *  - Storefront đồng bộ giỏ qua PUT /public/cart/:token (token uuid trình duyệt tự sinh); đăng nhập -> giỏ gắn userId,
 *    mỗi tài khoản giữ 1 giỏ "chính" (giỏ khác của cùng tài khoản được gộp vào rồi xoá).
 *  - Đơn mới (`order.created`) -> đánh dấu giỏ cùng userId/email hoạt động trong 24h là đã thành đơn.
 *  - Cron 15 phút gửi email `cart.abandoned` theo settings commerce.abandonedCart (lần 1, lần 2).
 */
@Injectable()
export class CartsService implements OnModuleInit {
  private readonly logger = new Logger('Carts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly cron: CronService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // mỗi 15 phút: đọc cài đặt lúc chạy nên bật/tắt có hiệu lực ngay
    this.cron.add('abandoned-reminders', '*/15 * * * *', () => this.runReminders(), 'carts');
  }

  // ---------------------------------------------------------------- dữ liệu sản phẩm

  /** Gắn tên, slug, ảnh, giá hiện tại cho từng dòng; dòng có sản phẩm đã xoá hẳn bị bỏ */
  async enrich(items: ServerCartItem[], localeInput?: string | null): Promise<CartLine[]> {
    if (!items.length) return [];
    const [locale, fallback] = await Promise.all([this.languages.resolve(localeInput ?? undefined), this.languages.defaultLocale()]);
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.productId))] }, deletedAt: null },
      include: { translations: { select: { locale: true, name: true, slug: true } }, variants: true },
    });
    const published = new Set((await this.prisma.product.findMany({ where: { id: { in: products.map((p) => p.id) }, ...publishedProductWhere() }, select: { id: true } })).map((p) => p.id));
    const media = await this.media.findMany([...products.map((p) => p.featuredImageId), ...products.flatMap((p) => p.variants.map((v) => v.imageId))]);
    const lines: CartLine[] = [];
    for (const item of items) {
      const p = products.find((x) => x.id === item.productId);
      if (!p) continue;
      const tr = p.translations.find((t) => t.locale === locale) ?? p.translations.find((t) => t.locale === fallback) ?? p.translations[0];
      const variant = item.variantId ? p.variants.find((v) => v.id === item.variantId) : null;
      const price = variant ? effectivePrice({ price: variant.price, salePrice: variant.salePrice }).finalPrice : effectivePrice(p).finalPrice;
      const img = media.get(variant?.imageId ?? p.featuredImageId ?? '') ?? media.get(p.featuredImageId ?? '');
      const available = published.has(p.id) && (p.type !== 'VARIABLE' || (!!variant && variant.isActive)) && (variant?.stockStatus ?? p.stockStatus) !== 'OUT_OF_STOCK';
      lines.push({
        productId: p.id,
        variantId: variant?.id ?? null,
        quantity: item.quantity,
        // giữ thông tin khách đã nhập (ID game, email...) để checkout gửi lại
        ...(item.fields ? { fields: item.fields } : {}),
        name: tr?.name ?? '',
        slug: tr?.slug ?? '',
        image: img?.urls?.thumb ?? img?.url ?? null,
        price,
        total: round(price * item.quantity),
        optionValues: ((variant?.optionValues as Record<string, string>) ?? {}) as Record<string, string>,
        available,
      });
    }
    return lines;
  }

  private subtotal(lines: CartLine[]) {
    return round(lines.filter((l) => l.available).reduce((s, l) => s + l.total, 0));
  }

  private toServer(lines: CartLine[]): ServerCartItem[] {
    return lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, ...(l.fields ? { fields: l.fields } : {}) }));
  }

  /** Khoá các ô nhập kiểu `password` theo sản phẩm (Product.purchaseFields) — productId -> tập khoá */
  private async passwordKeys(productIds: string[]): Promise<Map<string, Set<string>>> {
    const ids = [...new Set(productIds)];
    const map = new Map<string, Set<string>>();
    if (!ids.length) return map;
    const rows = await this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, purchaseFields: true } });
    for (const r of rows) {
      const keys = normalizePurchaseFields(r.purchaseFields).filter((f) => f.type === 'password').map((f) => f.key);
      if (keys.length) map.set(r.id, new Set(keys));
    }
    return map;
  }

  /**
   * Bỏ giá trị các ô `password` khỏi dòng giỏ trước khi lưu Cart.items: KHÔNG lưu mật khẩu khách nhập (vd mật khẩu tài khoản game
   * cần nạp) trên máy chủ — giỏ chỉ là bản nháp, link khôi phục / email nhắc giỏ không cần tới nó. Khách nhập lại khi thanh toán
   * (trình duyệt vẫn giữ trong giỏ cục bộ; phản hồi sync trả lại giá trị khách vừa gửi).
   */
  private stripSecrets(items: ServerCartItem[], pw: Map<string, Set<string>>): ServerCartItem[] {
    return items.map((i) => {
      const keys = pw.get(i.productId);
      if (!keys || !i.fields) return i;
      const { fields, ...rest } = i;
      const kept = Object.fromEntries(Object.entries(fields).filter(([k]) => !keys.has(k)));
      return Object.keys(kept).length ? { ...rest, fields: kept } : rest;
    });
  }

  private emptyCart(token: string): PublicCart {
    return { token, items: [], subtotal: 0, email: null, merged: false };
  }

  // ---------------------------------------------------------------- storefront

  /** GET /public/cart/:token — dùng khi khôi phục giỏ từ link email (?recover=) */
  async get(token: string, user?: AuthUser): Promise<PublicCart> {
    const cart = await this.prisma.cart.findUnique({ where: { token } });
    if (!cart || cart.convertedOrderCode) return this.emptyCart(token);
    const lines = await this.enrich(readItems(cart.items), cart.locale);
    // giỏ của tài khoản khác: vẫn trả sản phẩm (link khôi phục) nhưng không lộ email
    const ownEmail = !cart.userId || cart.userId === user?.id;
    return { token: cart.token, items: lines, subtotal: this.subtotal(lines), email: ownEmail ? cart.email : null, merged: false };
  }

  /**
   * PUT /public/cart/:token — ghi giỏ từ trình duyệt.
   *  - `merge: true` (lúc tải trang / vừa đăng nhập): gộp với giỏ đang lưu thay vì ghi đè.
   *  - Đăng nhập: dùng giỏ chính của tài khoản (gộp giỏ khách + giỏ khác của tài khoản vào đó, xoá bản thừa).
   *  - Token thuộc giỏ đã thành đơn / của tài khoản khác -> cấp token mới (client lưu `token` trả về).
   */
  async sync(token: string, dto: SyncCartDto, user?: AuthUser): Promise<PublicCart> {
    const body = dedupe(readItems(dto.items));
    const email = dto.email?.trim().toLowerCase() || null;
    let current = await this.prisma.cart.findUnique({ where: { token } });
    let freshToken = token;
    // không dùng lại giỏ đã thành đơn hoặc giỏ của tài khoản khác
    if (current && (current.convertedOrderCode || (current.userId && current.userId !== user?.id))) {
      current = null;
      freshToken = randomUUID();
    }

    let target: Cart | null = current;
    const absorb: Cart[] = [];
    if (user) {
      const own = await this.prisma.cart.findMany({ where: { userId: user.id, convertedOrderCode: null }, orderBy: { lastActivityAt: 'desc' }, take: 10 });
      if (current?.userId === user.id) target = current;
      else if (own.length) {
        target = own[0];
        if (current) absorb.push(current); // giỏ khách vừa đăng nhập
      }
      absorb.push(...own.filter((c) => c.id !== target?.id && c.id !== current?.id));
    }

    const storedRaw = target ? readItems(target.items) : [];
    const absorbRaw = absorb.map((c) => readItems(c.items));
    // ô mật khẩu: bỏ khỏi mọi bản sẽ lưu (kể cả dữ liệu cũ đã lỡ lưu) rồi mới gộp, để khoá dòng khớp nhau
    const pw = await this.passwordKeys([...body, ...storedRaw, ...absorbRaw.flat()].map((i) => i.productId));
    const safeBody = dedupe(this.stripSecrets(body, pw));
    const stored = this.stripSecrets(storedRaw, pw);
    const shouldMerge = !!target && (dto.merge || target.token !== freshToken || absorb.length > 0);
    const wanted = shouldMerge ? mergeItems(stored, ...absorbRaw.map((l) => this.stripSecrets(l, pw)), safeBody) : safeBody;

    // giỏ trống, chưa có trên máy chủ -> không tạo bản ghi rác
    if (!target && !wanted.length && !email) return this.emptyCart(freshToken);

    const locale = dto.locale || target?.locale || null;
    const lines = await this.enrich(wanted, locale);
    const items = this.toServer(lines);
    const data = {
      items: items as unknown as Prisma.InputJsonValue,
      subtotal: this.subtotal(lines),
      locale,
      email: email ?? target?.email ?? user?.email?.toLowerCase() ?? null,
      lastActivityAt: new Date(),
      ...(user ? { userId: user.id } : {}),
    };

    const saved = await this.prisma.$transaction(async (tx) => {
      if (absorb.length) await tx.cart.deleteMany({ where: { id: { in: absorb.map((c) => c.id) }, convertedOrderCode: null } });
      return target ? tx.cart.update({ where: { id: target.id }, data }) : tx.cart.create({ data: { ...data, token: freshToken } });
    });

    // trả lại cho trình duyệt đúng giá trị khách vừa gửi (gồm ô mật khẩu) cho các dòng khớp — máy chủ chỉ không LƯU chúng
    const sent = new Map(body.map((b) => [keyOf(this.stripSecrets([b], pw)[0]), b]));
    const out = lines.map((l) => {
      const b = sent.get(keyOf(l));
      return b?.fields ? { ...l, fields: b.fields } : l;
    });
    return { token: saved.token, items: out, subtotal: Number(saved.subtotal), email: saved.email, merged: !sameItems(items, safeBody) };
  }

  // ---------------------------------------------------------------- thành đơn

  /** Đơn mới -> giỏ cùng tài khoản hoặc email hoạt động trong 24h coi như đã thành đơn (không nhắc nữa) */
  @OnEvent('order.created', { async: true })
  async onOrderCreated(payload: { order?: { code?: string; userId?: string | null; customerEmail?: string | null } }) {
    const order = payload?.order;
    if (!order?.code) return;
    const or: Prisma.CartWhereInput[] = [];
    if (order.userId) or.push({ userId: order.userId });
    if (order.customerEmail?.trim()) or.push({ email: { equals: order.customerEmail.trim(), mode: 'insensitive' } });
    if (!or.length) return;
    try {
      await this.prisma.cart.updateMany({ where: { convertedOrderCode: null, lastActivityAt: { gte: new Date(Date.now() - DAY) }, OR: or }, data: { convertedOrderCode: order.code } });
    } catch (err) {
      this.logger.warn(`Không đánh dấu được giỏ thành đơn ${order.code}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- nhắc giỏ bỏ dở

  async abandonedSettings(): Promise<AbandonedCartSettings> {
    const commerce = await this.settings.get<Record<string, unknown>>('commerce');
    return readAbandonedCartSettings(commerce.abandonedCart);
  }

  /**
   * URL storefront (không có / cuối) + tiền tố ngôn ngữ (ngôn ngữ mặc định không có tiền tố).
   * Chưa cấu hình địa chỉ website (WEB_URL / Cài đặt › Chung) -> null: không ghép link tương đối vào email.
   */
  private async storefrontBase(locale: string): Promise<string | null> {
    // dùng helper chung để giỏ hàng / đơn hàng / email cùng một quy ước tiền tố ngôn ngữ
    return (await frontendLocaleBaseUrl(this.config, this.settings, { locale, languages: this.languages })) || null;
  }

  /** Link khôi phục giỏ (admin xem ở chi tiết giỏ); chuỗi rỗng khi chưa cấu hình địa chỉ website */
  async recoverUrl(cart: Pick<Cart, 'token' | 'locale'>) {
    const locale = await this.languages.resolve(cart.locale ?? undefined);
    const base = await this.storefrontBase(locale);
    return base ? `${base}/cart?recover=${encodeURIComponent(cart.token)}` : '';
  }

  /** Gửi email nhắc cho 1 giỏ (không kiểm tra lịch) */
  private async sendReminder(cart: Cart & { user?: { name: string } | null }, reminderNumber: number) {
    if (!cart.email) throw new BadRequestException('Giỏ hàng chưa có email');
    const locale = await this.languages.resolve(cart.locale ?? undefined);
    const lines = (await this.enrich(readItems(cart.items), locale)).filter((l) => l.available);
    if (!lines.length) return { status: 'SKIPPED' as const, logId: null, reason: 'Giỏ không còn sản phẩm đang bán' };
    const base = await this.storefrontBase(locale);
    // email nhắc giỏ chỉ có ý nghĩa khi có link khôi phục -> chưa cấu hình địa chỉ website thì không gửi
    if (!base) return { status: 'SKIPPED' as const, logId: null, reason: 'Chưa cấu hình địa chỉ website (WEB_URL hoặc Cài đặt › Chung › Địa chỉ website)' };
    const user = cart.user ?? (cart.userId ? await this.prisma.user.findUnique({ where: { id: cart.userId }, select: { name: true } }) : null);
    return this.mail.sendTemplate({
      key: 'cart.abandoned',
      locale,
      to: cart.email,
      vars: {
        cart: {
          customerName: user?.name ?? '',
          email: cart.email,
          items: lines.map((l) => ({ name: l.name, quantity: l.quantity, price: l.price, total: l.total, image: l.image ?? '', optionsText: Object.values(l.optionValues).filter(Boolean).join(' / '), url: `${base}/products/${l.slug}` })),
          itemCount: lines.reduce((n, l) => n + l.quantity, 0),
          subtotal: this.subtotal(lines),
          recoverUrl: `${base}/cart?recover=${encodeURIComponent(cart.token)}`,
        },
        reminderNumber,
      },
      meta: { cartId: cart.id, reminderNumber },
    });
  }

  /**
   * Cron: gửi nhắc lần 1 (sau firstDelayHours không hoạt động) và lần 2 (sau secondDelayHours).
   * Mỗi giỏ được "giữ chỗ" bằng updateMany có điều kiện reminderCount -> nhiều tiến trình API chạy song song không gửi trùng.
   */
  async runReminders() {
    const s = await this.abandonedSettings();
    if (!s.enabled) return { sent: 0 };
    if (!readFeatures(await this.settings.get('features')).shop) return { sent: 0 };
    // chưa có địa chỉ website: không "giữ chỗ" (tăng reminderCount) cho giỏ nào vì email sẽ bị bỏ qua
    if (!(await frontendBaseUrl(this.config, this.settings))) {
      this.logger.warn('Bỏ qua nhắc giỏ hàng: chưa cấu hình địa chỉ website (WEB_URL hoặc Cài đặt › Chung › Địa chỉ website)');
      return { sent: 0 };
    }
    const now = Date.now();
    const minActivity = new Date(now - s.maxAgeDays * DAY);
    const rounds: { count: number; delayH: number; gapH: number }[] = [{ count: 0, delayH: s.firstDelayHours, gapH: 0 }];
    if (s.secondDelayHours > s.firstDelayHours) rounds.push({ count: 1, delayH: s.secondDelayHours, gapH: s.secondDelayHours - s.firstDelayHours });
    let sent = 0;
    const remindedEmails = new Set<string>();
    for (const r of rounds) {
      const carts = await this.prisma.cart.findMany({
        where: {
          ...NOT_EMPTY,
          convertedOrderCode: null,
          email: { not: null },
          reminderCount: r.count,
          lastActivityAt: { lte: new Date(now - r.delayH * HOUR), gte: minActivity },
          ...(r.gapH ? { OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: new Date(now - r.gapH * HOUR) } }] } : {}),
        },
        include: { user: { select: { name: true } } },
        orderBy: { lastActivityAt: 'asc' },
        take: BATCH,
      });
      for (const cart of carts) {
        // chống lạm dụng: PUT /public/cart cho khách tự nhập email -> mỗi địa chỉ chỉ nhận nhắc cho MỘT giỏ trong cửa sổ maxAgeDays
        // (bỏ qua nếu email đã được nhắc ở giỏ khác, đã nhắc trong lượt chạy này, hoặc có giỏ mới hơn cùng email)
        const emailKey = cart.email!.toLowerCase();
        if (remindedEmails.has(emailKey)) continue;
        const sibling = await this.prisma.cart.findFirst({
          where: {
            id: { not: cart.id },
            email: { equals: cart.email!, mode: 'insensitive' },
            OR: [{ lastReminderAt: { gte: minActivity } }, { lastActivityAt: { gt: cart.lastActivityAt }, convertedOrderCode: null }],
          },
          select: { id: true },
        });
        if (sibling) continue;
        remindedEmails.add(emailKey);
        const claimed = await this.prisma.cart.updateMany({ where: { id: cart.id, reminderCount: r.count, convertedOrderCode: null }, data: { reminderCount: r.count + 1, lastReminderAt: new Date() } });
        if (!claimed.count) continue;
        try {
          const res = await this.sendReminder(cart, r.count + 1);
          // QUEUED = đã vào hàng chờ gửi (worker gửi nền)
          if (res.status === 'SENT' || res.status === 'QUEUED') sent += 1;
        } catch (err) {
          this.logger.warn(`Nhắc giỏ ${cart.id} lỗi: ${(err as Error).message}`);
        }
      }
    }
    if (sent) this.logger.log(`Đã gửi ${sent} email nhắc giỏ hàng bỏ dở`);
    return { sent };
  }

  // ---------------------------------------------------------------- admin

  private statusOf(c: Pick<Cart, 'convertedOrderCode' | 'reminderCount' | 'lastActivityAt'>, s: AbandonedCartSettings, now = Date.now()): AbandonedCartStatus {
    if (c.convertedOrderCode) return c.reminderCount > 0 ? 'recovered' : 'converted';
    const idle = now - c.lastActivityAt.getTime();
    if (idle > s.maxAgeDays * DAY) return 'expired';
    if (idle < s.firstDelayHours * HOUR) return 'active';
    return 'abandoned';
  }

  private statusWhere(status: string | undefined, s: AbandonedCartSettings): Prisma.CartWhereInput {
    const now = Date.now();
    const firstCut = new Date(now - s.firstDelayHours * HOUR);
    const maxCut = new Date(now - s.maxAgeDays * DAY);
    switch (status) {
      case 'active':
        return { ...NOT_EMPTY, convertedOrderCode: null, lastActivityAt: { gt: firstCut } };
      case 'abandoned':
        return { ...NOT_EMPTY, convertedOrderCode: null, lastActivityAt: { lte: firstCut, gte: maxCut } };
      case 'expired':
        return { ...NOT_EMPTY, convertedOrderCode: null, lastActivityAt: { lt: maxCut } };
      case 'recovered':
        return { convertedOrderCode: { not: null }, reminderCount: { gt: 0 } };
      case 'converted':
        return { convertedOrderCode: { not: null }, reminderCount: 0 };
      default:
        return { OR: [NOT_EMPTY, { convertedOrderCode: { not: null } }] };
    }
  }

  private present(c: Cart & { user?: { id: string; name: string; email: string } | null }, s: AbandonedCartSettings): AbandonedCartRow {
    return {
      id: c.id,
      token: c.token,
      email: c.email,
      locale: c.locale,
      user: c.user ?? null,
      itemCount: itemCount(c.items),
      subtotal: Number(c.subtotal),
      lastActivityAt: c.lastActivityAt.toISOString(),
      reminderCount: c.reminderCount,
      lastReminderAt: c.lastReminderAt?.toISOString() ?? null,
      convertedOrderCode: c.convertedOrderCode,
      status: this.statusOf(c, s),
      createdAt: c.createdAt.toISOString(),
    };
  }

  /** Danh sách giỏ có email (khách để lại email ở checkout hoặc thành viên đăng nhập) */
  async list(q: AbandonedCartQueryDto) {
    const s = await this.abandonedSettings();
    const { skip, take, page, limit } = pageArgs(q);
    const and: Prisma.CartWhereInput[] = [{ email: { not: null } }, this.statusWhere(q.status, s)];
    const search = q.search?.trim();
    if (search) and.push({ OR: [{ email: { contains: search, mode: 'insensitive' } }, { convertedOrderCode: { contains: search, mode: 'insensitive' } }, { user: { name: { contains: search, mode: 'insensitive' } } }] });
    const where: Prisma.CartWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.cart.findMany({ where, skip, take, orderBy: { lastActivityAt: 'desc' }, include: { user: { select: { id: true, name: true, email: true } } } }),
      this.prisma.cart.count({ where }),
    ]);
    return paginate(
      rows.map((r) => this.present(r, s)),
      total,
      page,
      limit,
    );
  }

  async detail(id: string): Promise<AbandonedCartDetail> {
    const cart = await this.prisma.cart.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true } } } });
    if (!cart) throw new NotFoundException('Không tìm thấy giỏ hàng');
    const s = await this.abandonedSettings();
    return { ...this.present(cart, s), items: await this.enrich(readItems(cart.items), cart.locale), recoverUrl: await this.recoverUrl(cart) };
  }

  /** Gửi nhắc thủ công (không theo lịch, vẫn tăng số lần đã nhắc) */
  async remindNow(id: string) {
    const cart = await this.prisma.cart.findUnique({ where: { id }, include: { user: { select: { name: true } } } });
    if (!cart) throw new NotFoundException('Không tìm thấy giỏ hàng');
    if (cart.convertedOrderCode) throw new BadRequestException(`Giỏ đã thành đơn #${cart.convertedOrderCode}`);
    if (!cart.email) throw new BadRequestException('Giỏ hàng chưa có email');
    if (!readItems(cart.items).length) throw new BadRequestException('Giỏ hàng trống');
    const res = await this.sendReminder(cart, cart.reminderCount + 1);
    if (res.status === 'FAILED') throw new BadRequestException(`Gửi email thất bại: ${res.error}`);
    if (res.status === 'SKIPPED' && !res.logId) throw new BadRequestException(res.reason);
    await this.prisma.cart.update({ where: { id }, data: { reminderCount: { increment: 1 }, lastReminderAt: new Date() } });
    return { status: res.status, reason: res.status === 'SKIPPED' ? res.reason : undefined };
  }

  /** Thống kê trong N ngày gần nhất (theo thời điểm tạo giỏ) */
  async stats(days = 30): Promise<AbandonedCartStats> {
    const s = await this.abandonedSettings();
    const since = new Date(Date.now() - days * DAY);
    const base: Prisma.CartWhereInput = { email: { not: null }, createdAt: { gte: since } };
    const firstCut = new Date(Date.now() - s.firstDelayHours * HOUR);
    const [total, abandoned, reminded, recovered, converted] = await Promise.all([
      this.prisma.cart.count({ where: { AND: [base, { OR: [NOT_EMPTY, { convertedOrderCode: { not: null } }] }] } }),
      this.prisma.cart.aggregate({ where: { AND: [base, NOT_EMPTY, { convertedOrderCode: null, lastActivityAt: { lte: firstCut } }] }, _count: true, _sum: { subtotal: true } }),
      this.prisma.cart.count({ where: { ...base, reminderCount: { gt: 0 } } }),
      this.prisma.cart.aggregate({ where: { ...base, reminderCount: { gt: 0 }, convertedOrderCode: { not: null } }, _count: true, _sum: { subtotal: true } }),
      this.prisma.cart.count({ where: { ...base, convertedOrderCode: { not: null } } }),
    ]);
    return {
      days,
      total,
      abandoned: abandoned._count,
      abandonedValue: Number(abandoned._sum.subtotal ?? 0),
      reminded,
      recovered: recovered._count,
      recoveredValue: Number(recovered._sum.subtotal ?? 0),
      recoveryRate: reminded ? recovered._count / reminded : 0,
      converted,
      settings: s,
    };
  }
}
