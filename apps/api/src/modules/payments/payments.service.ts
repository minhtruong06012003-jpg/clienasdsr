import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomInt } from 'node:crypto';
import { hasPermission, slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { frontendUrl } from '../../common/utils/frontend-url.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Order, PaymentTransaction, Prisma } from '../../generated/prisma/client.js';
import type { PaymentProvider, WebhookInput, WebhookPayment, WebhookResult } from './payment-provider.interface.js';

/** Khoá phương thức thanh toán bằng ví (lưu vào orders.paymentMethod) */
export const WALLET_METHOD = 'wallet';

interface CommerceSettings {
  paymentMethods?: { key: string; enabled: boolean; label: Record<string, string>; description?: Record<string, string> }[];
  /** Cho khách thanh toán bằng số dư ví (mặc định bật) */
  walletPaymentEnabled?: boolean;
  paymentExpireMinutes?: number;
  autoCancelUnpaidMinutes?: number;
  autoConfirmPaidOrders?: boolean;
}

/** Nhóm cài đặt `wallet`: khách tự nạp tiền vào ví qua cổng thanh toán */
export interface WalletTopupSettings {
  topupEnabled?: boolean;
  /** Khoá cổng được dùng để nạp; rỗng = mọi cổng đang bật */
  topupProviders?: string[];
  topupMin?: number;
  topupMax?: number;
}

/** purpose của PaymentTransaction: thanh toán đơn hàng / nạp ví */
export const PURPOSE_ORDER = 'order';
export const PURPOSE_WALLET = 'wallet';
/** Số giao dịch nạp ví đang chờ thanh toán tối đa của một khách */
export const MAX_PENDING_TOPUPS = 3;
/** Cửa sổ thời gian tìm giao dịch theo nội dung chuyển khoản (ngày) */
export const TRANSFER_MATCH_DAYS = 60;
/** Thông báo lỗi khi chưa cấu hình địa chỉ website (cần cho returnUrl của cổng) */
export const NO_FRONTEND_URL = 'Chưa cấu hình địa chỉ website (WEB_URL hoặc Cài đặt › Chung › Địa chỉ website)';

/** Chuẩn hoá nội dung chuyển khoản để so khớp: chữ hoa, bỏ mọi ký tự không phải A-Z0-9 (cột transferContentNorm) */
export function normalizeTransferContent(v: string | null | undefined): string | null {
  if (!v) return null;
  const n = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n || null;
}

/** webhookData dạng object (null / mảng -> {}) */
function wdObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Các mã giao dịch phụ (bí danh) đã gắn với giao dịch — xem paidAgain() */
function wdAliases(v: unknown): string[] {
  const a = wdObject(v).txnAliases;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * webhookData khi đánh dấu PAID: dữ liệu mới (payload cổng / { manual }) + GIỮ LẠI bí danh mã giao dịch và các khoản nhận
 * thiếu đã ghi trước đó (cần cho chống trùng sau khi xác nhận tay).
 */
export function mergeWebhookData(prev: unknown, data: unknown, source: string): object {
  const old = wdObject(prev);
  const base = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : data !== undefined ? { payload: data } : { source };
  return {
    ...base,
    ...(Array.isArray(old.txnAliases) ? { txnAliases: old.txnAliases } : {}),
    ...(Array.isArray(old.underpayments) ? { underpayments: old.underpayments } : {}),
  };
}

/** Ký tự mã nạp ví (bỏ ký tự dễ nhầm 0/O, 1/I/L) */
const TOPUP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const t = (v: Record<string, string> | undefined, locale: string) => (v ? (v[locale] ?? v.vi ?? Object.values(v)[0] ?? '') : '');
/** Định dạng tiền VND cho ghi chú */
const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  private providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly languages: LanguagesService,
    private readonly wallet: WalletService,
  ) {}

  // ---------------- đăng ký cổng ----------------

  /** Đăng ký cổng thanh toán (module payment-gateways gọi lúc khởi động) */
  register(provider: PaymentProvider) {
    this.providers.set(provider.key, provider);
  }

  /** Cổng đang bật trong Cài đặt và đã cấu hình đủ -> khách mới thấy & thanh toán được */
  private async active(key: string) {
    const p = this.providers.get(key);
    // cổng ẩn (PayOS / SePay / Pay2S) coi như tắt dù cài đặt cũ còn bật
    if (!p || p.hidden || !(await p.isEnabled())) return null;
    return (await p.isConfigured()) ? p : null;
  }

  /** Cổng nhận webhook bằng GET (dữ liệu trên query string) */
  acceptsGet(key: string) {
    return this.providers.get(key)?.acceptsGet === true;
  }

  isOnline(key: string) {
    return this.providers.has(key);
  }

  /** Phương thức thanh toán khách thấy ở trang checkout (offline trong Cài đặt + cổng online đang bật) */
  async methods(locale = 'vi') {
    const commerce = await this.settings.get<CommerceSettings>('commerce');
    const offline = (commerce.paymentMethods ?? [])
      .filter((m) => m.enabled && !this.providers.has(m.key))
      .map((m) => ({ key: m.key, type: 'offline' as const, label: t(m.label, locale), description: t(m.description, locale) }));
    const online = [];
    for (const p of this.providers.values()) {
      if (await this.active(p.key)) online.push({ key: p.key, type: 'online' as const, label: t(p.label, locale), description: t(p.description, locale) });
    }
    // ví: trừ số dư ngay khi đặt hàng; storefront chỉ hiện khi khách đã đăng nhập và đủ tiền
    const wallet =
      commerce.walletPaymentEnabled === false
        ? []
        : [{ key: WALLET_METHOD, type: 'wallet' as const, label: locale === 'en' ? 'Wallet balance' : 'Số dư ví', description: locale === 'en' ? 'Pay instantly with your wallet balance.' : 'Thanh toán ngay bằng số dư trong ví của bạn.' }];
    return [...online, ...wallet, ...offline];
  }

  /** Thanh toán bằng ví = trừ số dư ngay trong checkout, không qua cổng */
  isWallet(key: string) {
    return key === WALLET_METHOD;
  }

  async isValidMethod(key: string) {
    return (await this.methods()).some((m) => m.key === key);
  }

  // ---------------- tạo thanh toán ----------------

  private async findOrder(code: string, auth: { user?: AuthUser; phone?: string }) {
    const order = await this.prisma.order.findUnique({ where: { code } });
    const owner = !!order && ((auth.user && order.userId === auth.user.id) || (auth.phone && order.customerPhone === auth.phone.trim()));
    // cùng một thông báo cho mã không tồn tại và sai SĐT -> không dò được mã đơn
    if (!order || !owner) throw new NotFoundException('Không tìm thấy đơn hàng hoặc số điện thoại không đúng');
    return order;
  }

  /** Mã số duy nhất gửi sang cổng (PayOS yêu cầu số nguyên ≤ 9007199254740991) */
  private async uniqueNumericCode(provider: string) {
    for (;;) {
      const code = `${Date.now() % 1e11}${randomInt(100, 999)}`;
      if (!(await this.prisma.paymentTransaction.findUnique({ where: { provider_providerOrderCode: { provider, providerOrderCode: code } } }))) return code;
    }
  }

  /** URL cổng gọi về (IPN / webhook) */
  private webhookBase() {
    return `${this.config.get<string>('apiPublicUrl') ?? ''}/api/payments/webhook`;
  }

  /** returnUrl / cancelUrl của đơn trên website khách; chưa cấu hình địa chỉ website -> 400 (cổng bắt buộc có URL tuyệt đối) */
  private async urls(order: Order) {
    // tiền tố ngôn ngữ theo ngôn ngữ đặt đơn (mặc định không tiền tố, ngôn ngữ khác /{locale})
    const returnUrl = await frontendUrl(this.config, this.settings, `/order-success?code=${encodeURIComponent(order.code)}`, { locale: order.locale, languages: this.languages });
    if (!returnUrl) throw new BadRequestException(NO_FRONTEND_URL);
    return { returnUrl, cancelUrl: `${returnUrl}&cancelled=1`, webhookBase: this.webhookBase() };
  }

  /** Khoá theo đơn trong tiến trình: 2 lần bấm "Thanh toán" song song không tạo 2 giao dịch */
  private locks = new Map<string, Promise<unknown>>();

  async start(order: Order) {
    const prev = this.locks.get(order.id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.startUnlocked(order.id));
    this.locks.set(order.id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(order.id) === run) this.locks.delete(order.id);
    }
  }

  private async startUnlocked(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.paymentStatus === 'PAID') throw new BadRequestException('Đơn hàng đã được thanh toán');
    if (['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(order.status)) throw new BadRequestException('Đơn hàng không ở trạng thái chờ thanh toán');
    // các cổng VN chỉ nhận VND — không gửi số tiền của tiền tệ khác sang cổng
    if ((order.currency || 'VND').toUpperCase() !== 'VND') throw new BadRequestException('Cổng thanh toán online chỉ hỗ trợ đơn hàng bằng VND');
    const provider = await this.active(order.paymentMethod);
    if (!provider) throw new BadRequestException('Phương thức thanh toán online hiện không khả dụng');
    const commerce = await this.settings.get<CommerceSettings>('commerce');
    const amount = Math.round(Number(order.total));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Số tiền thanh toán không hợp lệ');

    // dùng lại giao dịch đang chờ còn hạn (tránh tạo nhiều link / nhiều mã chuyển khoản)
    const pending = await this.prisma.paymentTransaction.findFirst({
      where: { orderId: order.id, provider: provider.key, status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    });
    if (pending && Number(pending.amount) === amount && (pending.checkoutUrl || pending.qrData || pending.transferContent)) return this.present(pending);

    // kiểm tra địa chỉ website trước khi tạo giao dịch (thiếu cấu hình -> báo lỗi rõ, không tạo dòng FAILED)
    const { returnUrl, cancelUrl, webhookBase } = await this.urls(order);
    if (pending) await this.expire(pending, 'Tạo giao dịch mới');
    const providerOrderCode = await this.uniqueNumericCode(provider.key);
    const expireMinutes = Math.max(5, Number(commerce.paymentExpireMinutes) || 30);
    let tx = await this.prisma.paymentTransaction.create({
      data: { orderId: order.id, provider: provider.key, amount, currency: 'VND', providerOrderCode, expiresAt: new Date(Date.now() + expireMinutes * 60_000) },
    });
    try {
      const res = await provider.createPayment({
        order,
        transaction: tx,
        amount,
        description: slugify(order.code).toUpperCase().replace(/-/g, '').slice(0, 25),
        returnUrl,
        cancelUrl,
        webhookUrl: `${webhookBase}/${provider.key}`,
        locale: order.locale ?? 'vi',
      });
      tx = await this.prisma.paymentTransaction.update({
        where: { id: tx.id },
        data: {
          checkoutUrl: res.checkoutUrl,
          qrData: res.qrData ?? res.qrImageUrl,
          transferContent: res.transferContent,
          // bản chuẩn hoá để webhook biến động số dư tra nhanh (xem findTransaction)
          transferContentNorm: normalizeTransferContent(res.transferContent),
          reference: res.reference,
          expiresAt: res.expiresAt ?? tx.expiresAt,
          // luôn lưu bank + ảnh QR để trang trạng thái hiển thị lại được
          rawResponse: { ...((res.raw as object) ?? {}), bank: res.bank ?? null, qrImageUrl: res.qrImageUrl ?? null } as object,
        },
      });
      return this.present(tx);
    } catch (err) {
      await this.prisma.paymentTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', rawResponse: { error: (err as Error).message } } });
      this.logger.error(`Tạo thanh toán ${provider.key} cho đơn ${order.code} lỗi: ${(err as Error).message}`);
      throw new BadRequestException('Không tạo được giao dịch thanh toán, vui lòng thử lại hoặc chọn phương thức khác');
    }
  }

  private present(tx: PaymentTransaction) {
    const raw = (tx.rawResponse ?? {}) as {
      bank?: unknown;
      qrImageUrl?: string | null;
      usdt?: { payAmount?: string; amount?: number; rate?: number; currency?: string; networks?: unknown[] };
    };
    const qrIsImage = !!tx.qrData && /^(https?:|data:image\/)/.test(tx.qrData);
    return {
      id: tx.id,
      provider: tx.provider,
      status: tx.status,
      amount: Number(tx.amount),
      checkoutUrl: tx.checkoutUrl,
      qrData: tx.qrData,
      transferContent: tx.transferContent,
      bank: raw.bank ?? null,
      qrImageUrl: raw.qrImageUrl ?? (qrIsImage ? tx.qrData : null),
      // cổng USDT: số USDT phải chuyển (đã cộng phần lẻ phân biệt hoá đơn) + tỉ giá đã chốt + danh sách ví/mạng lưới
      usdt: raw.usdt
        ? {
            amount: raw.usdt.payAmount ?? String(raw.usdt.amount ?? ''),
            currency: raw.usdt.currency ?? 'USDT',
            rate: Number(raw.usdt.rate) || 0,
            networks: Array.isArray(raw.usdt.networks) ? raw.usdt.networks : [],
          }
        : null,
      expiresAt: tx.expiresAt,
      paidAt: tx.paidAt,
      needsRefund: tx.needsRefund,
      note: tx.note,
      serverNow: new Date(),
    };
  }

  /** Khách bấm "Thanh toán" / "Thanh toán lại" */
  async pay(code: string, auth: { user?: AuthUser; phone?: string }) {
    return this.start(await this.findOrder(code, auth));
  }

  /** Trạng thái thanh toán của đơn (trang order-success hỏi định kỳ) */
  async status(code: string, auth: { user?: AuthUser; phone?: string }) {
    const order = await this.findOrder(code, auth);
    let tx = await this.prisma.paymentTransaction.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    if (tx) tx = await this.refreshPending(tx);
    const fresh = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    return {
      code: fresh.code,
      paymentMethod: fresh.paymentMethod,
      paymentStatus: fresh.paymentStatus,
      orderStatus: fresh.status,
      total: Number(fresh.total),
      online: this.providers.has(fresh.paymentMethod),
      serverNow: new Date(),
      transaction: tx ? this.present(tx) : null,
    };
  }

  /**
   * Giao dịch đang chờ: hết hạn -> EXPIRED; còn hạn mà webhook chưa tới -> hỏi thẳng cổng (nếu cổng hỗ trợ fetchStatus).
   * Dùng chung cho trang trạng thái đơn và trang nạp ví của khách.
   */
  private async refreshPending(tx: PaymentTransaction, walletId?: string) {
    if (tx.status !== 'PENDING') return tx;
    const provider = this.providers.get(tx.provider);
    if (provider?.fetchStatus) {
      const s = await provider.fetchStatus(tx, walletId).catch(() => 'PENDING' as const);
      if (s === 'PAID') {
        await this.markPaid(tx, { amount: Number(tx.amount), source: 'fetchStatus', txnId: `status:${tx.providerOrderCode}` });
        return this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      }
      if (s !== 'PENDING') {
        await this.prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: 'PENDING' }, data: { status: s } });
        return this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      }
    }
    if (tx.expiresAt && tx.expiresAt < new Date()) return this.expire(tx, 'Hết hạn');
    return this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
  }

  private async expire(tx: PaymentTransaction, note: string) {
    const provider = this.providers.get(tx.provider);
    await provider?.cancel?.(tx).catch(() => undefined);
    await this.prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: 'PENDING' }, data: { status: 'EXPIRED', note } });
    return this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
  }

  /** Đơn bị huỷ: huỷ mọi link / QR còn hiệu lực để khách không trả tiền cho đơn đã huỷ */
  async cancelPendingForOrder(orderId: string, note = 'Đơn hàng đã huỷ') {
    const pending = await this.prisma.paymentTransaction.findMany({ where: { orderId, status: 'PENDING' } });
    for (const tx of pending) {
      await this.providers.get(tx.provider)?.cancel?.(tx).catch(() => undefined);
      await this.prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: 'PENDING' }, data: { status: 'CANCELLED', note } });
    }
  }

  // ---------------- khách nạp tiền vào ví qua cổng ----------------

  /** Đọc + chuẩn hoá nhóm cài đặt `wallet` (giới hạn số tiền luôn hợp lệ) */
  private async topupSettings() {
    const s = await this.settings.get<WalletTopupSettings>('wallet');
    const min = Math.max(1000, Math.round(Number(s.topupMin) || 10_000));
    const max = Math.max(min, Math.round(Number(s.topupMax) || 50_000_000));
    // bỏ khoá cổng ẩn / không còn đăng ký (vd cài đặt cũ chỉ tick SePay): không thì danh sách chỉ còn cổng ẩn -> khách không có cổng nào
    const providers = Array.isArray(s.topupProviders) ? s.topupProviders.filter((x): x is string => typeof x === 'string' && !!x && this.providers.has(x) && !this.providers.get(x)!.hidden) : [];
    return { enabled: s.topupEnabled === true, providers, min, max };
  }

  /** Cổng dùng được để nạp ví: đang bật + đủ cấu hình + nằm trong danh sách cho phép (rỗng = mọi cổng) */
  private async topupGateways(allowed: string[]) {
    const out: PaymentProvider[] = [];
    for (const p of this.providers.values()) {
      if (allowed.length && !allowed.includes(p.key)) continue;
      if (await this.active(p.key)) out.push(p);
    }
    return out;
  }

  /** Cấu hình nạp ví cho website khách dựng form: bật/tắt, hạn mức, các cổng dùng được */
  async topupOptions(locale = 'vi') {
    const s = await this.topupSettings();
    const gateways = s.enabled ? await this.topupGateways(s.providers) : [];
    return {
      enabled: s.enabled && gateways.length > 0,
      min: s.min,
      max: s.max,
      providers: gateways.map((p) => ({ key: p.key, label: t(p.label, locale), description: t(p.description, locale) })),
    };
  }

  /**
   * Cổng dùng được ở trang thanh toán gói cước: không phụ thuộc công tắc "cho khách tự nạp ví" (website chỉ bán gói,
   * không có trang nạp tiền riêng) nhưng vẫn theo danh sách cổng cho phép và hạn mức trong nhóm cài đặt `wallet`.
   */
  async planCheckoutOptions(locale = 'vi') {
    const usdtProv = this.providers.get('usdt');
    const [s, usdtCfg, usdtNetworks] = await Promise.all([
      this.topupSettings(),
      this.settings.get<{ rate?: number; minUsdt?: number }>('usdt').catch(() => ({ rate: 26000, minUsdt: 1 })),
      usdtProv?.publicNetworks?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    const gateways = await this.topupGateways(s.providers);
    return {
      enabled: gateways.length > 0,
      min: s.min,
      max: s.max,
      usdtRate: Math.max(1, Number(usdtCfg?.rate) || 26000),
      minUsdt: Math.max(1, Number(usdtCfg?.minUsdt) || 1),
      usdtNetworks,
      providers: gateways.map((p) => ({ key: p.key, label: t(p.label, locale), description: t(p.description, locale) })),
    };
  }

  /** Mã nạp ví duy nhất `NAP` + 8 ký tự — dùng làm nội dung chuyển khoản (SePay) / mô tả gửi cổng */
  private async uniqueTopupCode() {
    for (;;) {
      let code = 'NAP';
      for (let i = 0; i < 8; i++) code += TOPUP_ALPHABET[randomInt(TOPUP_ALPHABET.length)];
      if (!(await this.prisma.paymentTransaction.findFirst({ where: { transferContentNorm: code }, select: { id: true } }))) return code;
    }
  }

  /** Dữ liệu giao dịch nạp ví trả cho khách (không lộ cờ nội bộ needsRefund) */
  private presentTopup(tx: PaymentTransaction) {
    const { needsRefund: _n, ...rest } = this.present(tx);
    return { ...rest, purpose: PURPOSE_WALLET, createdAt: tx.createdAt };
  }

  /**
   * Khách tạo giao dịch nạp ví: kiểm tra cài đặt / hạn mức / cổng, giới hạn MAX_PENDING_TOPUPS giao dịch chờ
   * (khoá dòng user để 2 request song song không cùng vượt), rồi gọi cổng như thanh toán đơn hàng.
   * Đang có giao dịch chờ cùng cổng + cùng số tiền còn hạn -> trả lại giao dịch đó (không tạo thêm mã chuyển khoản).
   * `extra` (tuỳ chọn, vd trang thanh toán gói cước):
   * - `checkout`: việc cần làm sau khi tiền vào ví, lưu ở `rawRequest.checkout` (module khác nghe sự kiện `wallet.topup_completed` để xử lý);
   * - `returnPath`: trang quay về từ cổng thay cho `/account/wallet` (tự nối `topup=<id>`).
   */
  async createTopup(
    user: AuthUser,
    dto: { amount: number; provider: string },
    requestLocale?: string | null,
    extra?: { checkout?: Record<string, unknown>; returnPath?: string; replacePending?: boolean },
  ) {
    const s = await this.topupSettings();
    // thanh toán gói cước (có `extra.checkout`) luôn được tạo; chỉ nạp ví tự do mới cần bật công tắc nạp ví
    if (!s.enabled && !extra?.checkout) throw new BadRequestException('Chức năng nạp tiền qua cổng thanh toán đang tắt');
    const amount = Math.round(Number(dto.amount));
    // hạn mức tối đa chỉ áp cho nạp ví tự do; giá gói cước (vd gói năm) có thể vượt mức nạp tối đa
    if (!Number.isFinite(amount) || amount < s.min || (amount > s.max && !extra?.checkout)) throw new BadRequestException(`Số tiền nạp phải từ ${vnd(s.min)} đến ${vnd(s.max)}`);
    if (s.providers.length && !s.providers.includes(dto.provider)) throw new BadRequestException('Cổng thanh toán này không được dùng để thanh toán');
    const provider = await this.active(dto.provider);
    if (!provider) throw new BadRequestException('Cổng thanh toán hiện không khả dụng');
    // hạn mức riêng của cổng (vd USDT tối thiểu 1 USDT quy ra VND)
    const providerMin = (await provider.minAmount?.()) ?? 0;
    if (amount < providerMin) throw new BadRequestException(`Cổng ${t(provider.label, 'vi')} chỉ nhận thanh toán từ ${vnd(providerMin)} trở lên`);
    const owner = await this.prisma.user.findFirst({ where: { id: user.id, deletedAt: null }, select: { id: true, name: true, email: true, phone: true, locale: true } });
    if (!owner) throw new NotFoundException('Không tìm thấy tài khoản');
    // cổng cần returnUrl tuyệt đối -> báo lỗi cấu hình trước khi tạo giao dịch
    if (!(await frontendUrl(this.config, this.settings, '/account/wallet'))) throw new BadRequestException(NO_FRONTEND_URL);

    const commerce = await this.settings.get<CommerceSettings>('commerce');
    const expireMinutes = Math.max(5, Number(commerce.paymentExpireMinutes) || 30);

    // Chế độ tự hiện QR trực tiếp trên trang Nạp tiền (Web2M): cập nhật trực tiếp giao dịch PENDING hiện có (giữ nguyên mã NAPxxxx, không đẻ thêm dòng mới)
    if (extra?.replacePending && provider.key === 'web2m') {
      const existingPending = await this.prisma.paymentTransaction.findFirst({
        where: { purpose: PURPOSE_WALLET, userId: owner.id, provider: provider.key, status: 'PENDING', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (existingPending && existingPending.transferContent) {
        const checkout = extra?.checkout ?? null;
        if (Number(existingPending.amount) === amount && (existingPending.qrData || existingPending.checkoutUrl)) {
          const updatedSame = await this.prisma.paymentTransaction.update({
            where: { id: existingPending.id },
            data: { rawRequest: { checkout } as object },
          });
          return this.presentTopup(updatedSame);
        }
        const backReuse = extra?.returnPath ?? '/account/wallet';
        const returnUrlReuse = await frontendUrl(
          this.config,
          this.settings,
          `${backReuse}${backReuse.includes('?') ? '&' : '?'}topup=${existingPending.id}`,
          { locale: requestLocale || owner.locale, languages: this.languages },
        );
        if (returnUrlReuse) {
          const pseudoReuse = {
            id: existingPending.id,
            code: existingPending.transferContent,
            userId: owner.id,
            customerName: owner.name,
            customerPhone: owner.phone ?? '',
            customerEmail: owner.email,
            locale: owner.locale ?? 'vi',
            currency: 'VND',
            total: amount,
          } as unknown as Order;
          const resReuse = await provider.createPayment({
            order: pseudoReuse,
            transaction: existingPending,
            amount,
            description: existingPending.transferContent,
            returnUrl: returnUrlReuse,
            cancelUrl: `${returnUrlReuse}&cancelled=1`,
            webhookUrl: `${this.webhookBase()}/${provider.key}`,
            locale: owner.locale ?? 'vi',
          });
          const updated = await this.prisma.paymentTransaction.update({
            where: { id: existingPending.id },
            data: {
              amount,
              qrData: resReuse.qrData ?? resReuse.qrImageUrl,
              expiresAt: new Date(Date.now() + expireMinutes * 60_000),
              rawRequest: { checkout } as object,
              rawResponse: { ...((resReuse.raw as object) ?? {}), bank: resReuse.bank ?? null, qrImageUrl: resReuse.qrImageUrl ?? null } as object,
            },
          });
          return this.presentTopup(updated);
        }
      }
    }

    const reuse = await this.prisma.paymentTransaction.findFirst({
      where: { purpose: PURPOSE_WALLET, userId: owner.id, provider: provider.key, status: 'PENDING', amount, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const reuseHasUsdtNets =
      provider.key !== 'usdt' ||
      Array.isArray((reuse?.rawResponse as { usdt?: { networks?: unknown[] } } | null)?.usdt?.networks);
    if (reuse && reuseHasUsdtNets && (reuse.checkoutUrl || reuse.qrData || reuse.transferContent)) {
      // dùng lại mã chờ: ghi đè việc cần làm sau thanh toán theo yêu cầu mới nhất (vd khách đổi gói / chu kỳ)
      const checkout = extra?.checkout ?? null;
      const updated = await this.prisma.paymentTransaction.update({ where: { id: reuse.id }, data: { rawRequest: { checkout } as object } });
      return this.presentTopup(updated);
    }

    const providerOrderCode = await this.uniqueNumericCode(provider.key);
    const code = await this.uniqueTopupCode();
    let tx = await this.prisma.$transaction(async (db) => {
      // khoá dòng user: nếu đang có từ MAX_PENDING_TOPUPS đơn chờ trở lên thì tự đóng bớt đơn chờ cũ nhất thay vì chặn khách nạp tiền
      await db.$queryRaw`SELECT id FROM users WHERE id = ${owner.id}::uuid FOR UPDATE`;
      const pendingRows = await db.paymentTransaction.findMany({
        where: { purpose: PURPOSE_WALLET, userId: owner.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (pendingRows.length >= MAX_PENDING_TOPUPS) {
        const overflowIds = pendingRows.slice(0, pendingRows.length - MAX_PENDING_TOPUPS + 1).map((r) => r.id);
        await db.paymentTransaction.updateMany({
          where: { id: { in: overflowIds }, status: 'PENDING' },
          data: { status: 'EXPIRED', note: 'Tự đóng đơn chờ cũ khi tạo đơn nạp mới' },
        });
      }
      return db.paymentTransaction.create({
        data: {
          purpose: PURPOSE_WALLET,
          userId: owner.id,
          orderId: null,
          provider: provider.key,
          amount,
          currency: 'VND',
          providerOrderCode,
          transferContent: code,
          transferContentNorm: normalizeTransferContent(code),
          expiresAt: new Date(Date.now() + expireMinutes * 60_000),
          ...(extra?.checkout ? { rawRequest: { checkout: extra.checkout } as object } : {}),
        },
      });
    });
    // trang quay về theo ngôn ngữ khách đang xem (query ?locale=) → ngôn ngữ lưu trong tài khoản → mặc định
    const back = extra?.returnPath ?? '/account/wallet';
    const returnUrl = await frontendUrl(this.config, this.settings, `${back}${back.includes('?') ? '&' : '?'}topup=${tx.id}`, { locale: requestLocale || owner.locale, languages: this.languages });
    if (!returnUrl) throw new BadRequestException(NO_FRONTEND_URL);
    // các cổng đọc thông tin "đơn" (mã, tên / SĐT / email người mua): dựng đơn ảo từ giao dịch nạp ví
    const pseudoOrder = {
      id: tx.id,
      code,
      userId: owner.id,
      customerName: owner.name,
      customerPhone: owner.phone ?? '',
      customerEmail: owner.email,
      locale: owner.locale ?? 'vi',
      currency: 'VND',
      total: amount,
    } as unknown as Order;
    try {
      const res = await provider.createPayment({
        order: pseudoOrder,
        transaction: tx,
        amount,
        description: code,
        returnUrl,
        cancelUrl: `${returnUrl}&cancelled=1`,
        webhookUrl: `${this.webhookBase()}/${provider.key}`,
        locale: owner.locale ?? 'vi',
      });
      const content = res.transferContent ?? code;
      tx = await this.prisma.paymentTransaction.update({
        where: { id: tx.id },
        data: {
          checkoutUrl: res.checkoutUrl,
          qrData: res.qrData ?? res.qrImageUrl,
          transferContent: content,
          transferContentNorm: normalizeTransferContent(content),
          reference: res.reference,
          expiresAt: res.expiresAt ?? tx.expiresAt,
          rawResponse: { ...((res.raw as object) ?? {}), bank: res.bank ?? null, qrImageUrl: res.qrImageUrl ?? null } as object,
        },
      });
      return this.presentTopup(tx);
    } catch (err) {
      await this.prisma.paymentTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', rawResponse: { error: (err as Error).message } } });
      this.logger.error(`Tạo nạp ví ${provider.key} cho ${owner.email} lỗi: ${(err as Error).message}`);
      throw new BadRequestException('Không tạo được giao dịch nạp tiền, vui lòng thử lại hoặc chọn cổng khác');
    }
  }

  /** Lịch sử nạp ví qua cổng của chính khách (mới nhất trước) */
  async myTopups(userId: string, q: { page?: number; limit?: number; status?: string }) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.PaymentTransactionWhereInput = { purpose: PURPOSE_WALLET, userId };
    if (q.status) where.status = q.status as Prisma.PaymentTransactionWhereInput['status'];
    const [rows, total] = await Promise.all([
      this.prisma.paymentTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.paymentTransaction.count({ where }),
    ]);
    return paginate(
      rows.map((r) => this.presentTopup(r)),
      total,
      page,
      limit,
    );
  }

  /** Chi tiết một giao dịch nạp ví của chính khách (trang quay về từ cổng hỏi định kỳ) — tự hỏi cổng nếu webhook chưa tới */
  async myTopup(userId: string, id: string, walletId?: string) {
    const tx = await this.prisma.paymentTransaction.findFirst({ where: { id, userId, purpose: PURPOSE_WALLET } });
    if (!tx) throw new NotFoundException('Không tìm thấy giao dịch nạp tiền');
    return this.presentTopup(await this.refreshPending(tx, walletId));
  }

  // ---------------- webhook ----------------

  async webhook(providerKey: string, input: WebhookInput) {
    const provider = this.providers.get(providerKey);
    if (!provider) throw new NotFoundException('Cổng thanh toán không tồn tại');
    let result: WebhookResult;
    try {
      result = await provider.handleWebhook(input);
    } catch (err) {
      result = { valid: false, success: false, note: (err as Error).message, statusCode: 400, response: { success: false } };
    }
    const notes: string[] = [];
    let matched = false;
    if (result.valid && result.success) {
      const payments: WebhookPayment[] = result.payments ?? [
        { providerOrderCode: result.providerOrderCode, transferContent: result.transferContent, amount: result.amount ?? Number.NaN, reference: result.reference, txnId: result.txnId },
      ];
      for (const pay of payments) {
        const tx = await this.findTransaction(providerKey, pay.providerOrderCode, pay.transferContent);
        if (!tx) {
          notes.push(`Không tìm thấy giao dịch (${pay.providerOrderCode ?? pay.transferContent?.slice(0, 60) ?? '?'})`);
          continue;
        }
        matched = true;
        const r = await this.markPaid(tx, { amount: pay.amount, reference: pay.reference, txnId: pay.txnId, data: input.body, source: 'webhook' });
        notes.push(r.note);
      }
    } else if (result.note) notes.push(result.note);

    // request sai chữ ký không lưu payload (chống làm phình DB); payload hợp lệ cắt ngắn nếu quá lớn
    // callback GET (USDT Gateway) chỉ có dữ liệu trên query string; bỏ khoá bí mật cổng gửi kèm trước khi lưu log
    const bodyEmpty = !input.body || (typeof input.body === 'object' && !Array.isArray(input.body) && !Object.keys(input.body as object).length);
    const source = bodyEmpty && Object.keys(input.query ?? {}).length ? input.query : input.body;
    const redacted = source && typeof source === 'object' && !Array.isArray(source) ? Object.fromEntries(Object.entries(source as Record<string, unknown>).filter(([k]) => !/^(api_?key|secret|token)$/i.test(k))) : source;
    const raw = result.valid ? JSON.stringify(redacted ?? {}) : '{}';
    const payload = raw.length > 20_000 ? { truncated: true, preview: raw.slice(0, 20_000) } : JSON.parse(raw);
    await this.prisma.paymentWebhookLog.create({ data: { provider: providerKey, payload, valid: result.valid, matched, note: notes.join(' | ').slice(0, 1000) || null, ip: input.ip } });
    return { statusCode: result.statusCode ?? (result.valid ? 200 : 401), body: result.response ?? { success: result.valid } };
  }

  private async findTransaction(provider: string, providerOrderCode?: string, transferContent?: string) {
    if (providerOrderCode) {
      const tx = await this.prisma.paymentTransaction.findUnique({ where: { provider_providerOrderCode: { provider, providerOrderCode } } });
      if (tx) return tx;
    }
    const normalized = normalizeTransferContent(transferContent) ?? '';
    if (normalized.length < 6) return null;
    // nội dung CK có thể bị ngân hàng thêm ký tự: tìm giao dịch có nội dung (đã chuẩn hoá sẵn ở cột transferContentNorm)
    // nằm trong chuỗi nhận được — không còn regexp_replace từng dòng. Chỉ xét giao dịch tạo trong TRANSFER_MATCH_DAYS ngày gần đây.
    // Ưu tiên nội dung dài nhất (tránh mã ngắn là tiền tố của mã khác), rồi giao dịch đang chờ, rồi mới nhất.
    const since = new Date(Date.now() - TRANSFER_MATCH_DAYS * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM payment_transactions
      WHERE provider = ${provider}
        AND "createdAt" >= ${since}
        AND "transferContentNorm" IS NOT NULL
        AND length("transferContentNorm") >= 6
        AND position("transferContentNorm" in ${normalized}) > 0
      ORDER BY length("transferContentNorm") DESC,
        CASE status WHEN 'PENDING' THEN 0 WHEN 'EXPIRED' THEN 1 WHEN 'FAILED' THEN 2 WHEN 'PAID' THEN 3 ELSE 4 END,
        "createdAt" DESC
      LIMIT 1`;
    return rows[0] ? this.prisma.paymentTransaction.findUnique({ where: { id: rows[0].id } }) : null;
  }

  /**
   * Ghi nhận tiền đã vào — an toàn với webhook gửi lặp / song song:
   * - chống trùng theo mã giao dịch phía cổng (providerTxnId, unique) và theo trạng thái giao dịch;
   * - đơn hàng: khoá dòng đơn (FOR UPDATE) để không chạy chen với huỷ đơn; đơn đã huỷ hoặc đã thanh toán bằng giao dịch
   *   khác -> vẫn ghi nhận tiền nhưng đánh dấu "cần hoàn tiền";
   * - nhận THỪA tiền (đơn hàng): đơn vẫn được ghi nhận đã thanh toán, giao dịch ghi chú "Nhận thừa …đ" + needsRefund
   *   để admin thấy ở bộ lọc "Cần hoàn tiền" và trả lại phần thừa;
   * - nạp ví (purpose = wallet): cộng ví đúng một lần trong cùng transaction — xem markWalletPaid().
   * Kết quả `ok = true` khi tiền đã được ghi nhận cho đơn / cộng vào ví.
   */
  async markPaid(tx: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown; source: string }): Promise<{ note: string; ok?: boolean }> {
    if (!Number.isFinite(opts.amount) || opts.amount <= 0) return { note: 'Số tiền không hợp lệ trong dữ liệu cổng gửi về' };
    if (opts.txnId && (await this.prisma.paymentTransaction.findUnique({ where: { provider_providerTxnId: { provider: tx.provider, providerTxnId: opts.txnId } } }))) {
      return { note: 'Giao dịch đã được xử lý trước đó (webhook gửi lại)' };
    }
    // giao dịch đã PAID nhận thêm thông báo với mã khác: phân biệt "cùng lần chuyển tiền báo từ nguồn khác"
    // (polling vs webhook, IPN vs webhook số dư) với "khách trả thêm một khoản thật" -> xem paidAgain()
    if (tx.status === 'PAID' && opts.txnId && opts.txnId !== tx.providerTxnId) return this.paidAgain(tx, opts);
    // admin xác nhận tay (source = manual) đã tự kiểm tra số tiền -> không chặn "nhận thiếu"
    // giao dịch chưa PAID đã từng nhận thông báo này (vd khoản nhận thiếu, cổng gửi lại) -> bỏ qua
    if (opts.source !== 'manual' && tx.status !== 'PAID' && opts.txnId && wdAliases(tx.webhookData).includes(opts.txnId)) return { note: 'Đã ghi nhận trước đó (thông báo gửi lại)' };
    const flexBankWallet = tx.purpose === PURPOSE_WALLET && tx.provider === 'web2m' && opts.amount >= 1000;
    if (opts.source !== 'manual' && !flexBankWallet && opts.amount + 0.5 < Number(tx.amount)) {
      // ghi lại khoản trả thiếu (không ghi đè, không đụng giao dịch đã PAID) để admin đối soát / xác nhận thủ công.
      // Mã giao dịch lưu vào bí danh (txnAliases): sau khi admin xác nhận tay, thông báo lặp / từ nguồn khác của CÙNG lần
      // chuyển tiền này không bị coi là khoản tiền mới (chống cộng ví / ghi nhận hai lần)
      const prev = wdObject(tx.webhookData) as { underpayments?: unknown[]; txnAliases?: unknown[] };
      const aliases = wdAliases(tx.webhookData);
      await this.prisma.paymentTransaction.updateMany({
        where: { id: tx.id, status: { not: 'PAID' } },
        data: {
          note: `Nhận thiếu tiền: ${opts.amount.toLocaleString('vi-VN')}đ / ${Number(tx.amount).toLocaleString('vi-VN')}đ — kiểm tra và xác nhận thủ công`,
          webhookData: {
            ...prev,
            underpayments: [...(prev.underpayments ?? []), { amount: opts.amount, txnId: opts.txnId ?? null, reference: opts.reference ?? null, at: new Date().toISOString() }],
            ...(opts.txnId ? { txnAliases: [...aliases, opts.txnId].slice(-20) } : {}),
          } as object,
        },
      });
      this.logger.warn(`Giao dịch ${tx.id} nhận thiếu tiền: ${opts.amount}/${Number(tx.amount)}`);
      return { note: `Số tiền nhận (${opts.amount}) nhỏ hơn số tiền cần thanh toán (${Number(tx.amount)})` };
    }
    if (tx.purpose === PURPOSE_WALLET) return this.markWalletPaid(tx, opts);
    if (!tx.orderId) return { note: 'Giao dịch không gắn với đơn hàng nào' };
    const orderId = tx.orderId;

    // nhận thừa: phần chênh lệch cần hoàn lại cho khách (đơn vẫn được ghi nhận đã thanh toán)
    const over = opts.amount > Number(tx.amount) + 0.5 ? opts.amount - Number(tx.amount) : 0;
    const overNote = over ? `Nhận thừa ${vnd(over)} (nhận ${vnd(opts.amount)} / cần ${vnd(Number(tx.amount))}) — cần hoàn phần thừa cho khách` : undefined;
    const commerce = await this.settings.get<CommerceSettings>('commerce');
    let outcome: { kind: 'paid' | 'refund' | 'dup'; order?: Order & { items: unknown[] }; reason?: string };
    try {
      outcome = await this.prisma.$transaction(async (db) => {
        // khoá đơn hàng: huỷ đơn / webhook khác phải chờ giao dịch này xong
        await db.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
        const closed = ['CANCELLED', 'REFUNDED'].includes(order.status);
        const alreadyPaid = order.paymentStatus === 'PAID';
        const reason = closed ? 'Nhận tiền sau khi đơn đã huỷ — cần hoàn tiền cho khách' : alreadyPaid ? 'Đơn đã được thanh toán bằng giao dịch khác — khách trả trùng, cần hoàn tiền' : undefined;

        const claimed = await db.paymentTransaction.updateMany({
          where: { id: tx.id, status: { in: ['PENDING', 'EXPIRED', 'FAILED', 'CANCELLED'] } },
          data: {
            status: 'PAID',
            paidAt: new Date(),
            reference: opts.reference ?? tx.reference,
            providerTxnId: opts.txnId ?? null,
            needsRefund: !!reason || !!overNote,
            note: reason ? `${reason}${over ? ` (đã nhận ${vnd(opts.amount)})` : ''}` : (overNote ?? null),
            webhookData: mergeWebhookData(tx.webhookData, opts.data, opts.source),
          },
        });
        if (!claimed.count) return { kind: 'dup' as const };

        const history = [...((order.history as object[]) ?? [])];
        // ghi số tiền THỰC NHẬN (có thể lớn hơn số tiền giao dịch khi khách chuyển thừa)
        const money = `${vnd(over ? opts.amount : Number(tx.amount))} qua ${tx.provider.toUpperCase()}${opts.reference ? ` (mã GD: ${opts.reference})` : ''}`;
        if (reason) {
          history.push({ status: order.status, note: `${reason}: ${money}`, at: new Date().toISOString(), by: 'system' });
          const updated = await db.order.update({ where: { id: order.id }, data: { history }, include: { items: true } });
          return { kind: 'refund' as const, order: updated, reason };
        }
        history.push({ status: order.status, note: `Đã thanh toán ${money}${overNote ? ` · ${overNote}` : ''}`, at: new Date().toISOString(), by: 'system' });
        const confirm = commerce.autoConfirmPaidOrders !== false && order.status === 'PENDING';
        if (confirm) history.push({ status: 'CONFIRMED', note: 'Tự động xác nhận sau khi thanh toán', at: new Date().toISOString(), by: 'system' });
        const updated = await db.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'PAID', paidAt: new Date(), history, ...(confirm ? { status: 'CONFIRMED' } : {}) },
          include: { items: true },
        });
        return { kind: 'paid' as const, order: updated };
      });
    } catch (err) {
      // trùng providerTxnId (2 webhook song song cùng mã giao dịch) -> đã có request khác xử lý
      if ((err as { code?: string }).code === 'P2002') return { note: 'Giao dịch đã được xử lý trước đó (webhook gửi lại)' };
      throw err;
    }

    if (outcome.kind === 'dup') return this.afterDuplicate(tx, opts);
    if (outcome.kind === 'refund') {
      this.logger.warn(`Đơn ${outcome.order!.code}: ${outcome.reason}`);
      this.events.emit('order.paymentNeedsRefund', { order: outcome.order, transactionId: tx.id, reason: outcome.reason });
      await this.hooks.doAction('order.paymentNeedsRefund', outcome.order, tx, outcome.reason);
      this.events.emit('activity', { userId: null, action: 'payment.needsRefund', entityType: 'order', entityId: orderId, meta: { provider: tx.provider, amount: opts.amount, reason: outcome.reason } });
      return { note: outcome.reason! };
    }
    if (overNote) {
      // nhận thừa: báo admin như các trường hợp cần hoàn tiền khác (đơn vẫn được xử lý bình thường)
      this.logger.warn(`Đơn ${outcome.order!.code}: ${overNote}`);
      this.events.emit('order.paymentNeedsRefund', { order: outcome.order, transactionId: tx.id, reason: overNote });
      this.events.emit('activity', { userId: null, action: 'payment.overpaid', entityType: 'order', entityId: orderId, meta: { provider: tx.provider, amount: opts.amount, expected: Number(tx.amount), over } });
    }
    this.events.emit('order.paid', { order: outcome.order, transactionId: tx.id });
    await this.hooks.doAction('order.paid', outcome.order, tx);
    this.events.emit('activity', { userId: null, action: 'order.paid', entityType: 'order', entityId: orderId, meta: { provider: tx.provider, amount: opts.amount } });
    return { note: overNote ? `Đã ghi nhận thanh toán · ${overNote}` : 'Đã ghi nhận thanh toán', ok: true };
  }

  /** Giao dịch vừa bị request khác "giành" trước (tx truyền vào đã cũ): đọc lại để phân loại đúng trùng lặp / trả thêm */
  private async afterDuplicate(tx: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown }) {
    const fresh = await this.prisma.paymentTransaction.findUnique({ where: { id: tx.id } });
    if (fresh?.status === 'PAID' && opts.txnId && opts.txnId !== fresh.providerTxnId) return this.paidAgain(fresh, opts);
    return { note: 'Đã ghi nhận trước đó' };
  }

  /**
   * Nạp ví qua cổng đã nhận tiền: trong MỘT transaction "giành" giao dịch (PENDING/EXPIRED/FAILED/CANCELLED -> PAID,
   * có điều kiện + providerTxnId unique) rồi cộng ví qua WalletService.apply -> webhook gửi lặp / song song chỉ cộng một lần.
   * Số tiền cộng = số tiền THỰC NHẬN: khách chuyển thừa thì tiền vẫn là của khách và nằm trong ví (không cần hoàn tay),
   * giao dịch ghi chú "Nhận thừa …" để admin đối soát. Chủ ví không còn tồn tại -> không cộng, đánh dấu cần hoàn tiền.
   */
  private async markWalletPaid(tx: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown; source: string }): Promise<{ note: string; ok?: boolean }> {
    const expected = Number(tx.amount);
    const useActual = opts.amount > expected + 0.5 || opts.source === 'manual' || tx.provider === 'web2m';
    const credit = Math.round((useActual ? opts.amount : expected) * 100) / 100;
    const overNote = opts.amount > expected + 0.5 ? `Nhận thừa ${vnd(opts.amount - expected)} (nhận ${vnd(opts.amount)} / yêu cầu ${vnd(expected)}) — đã cộng đúng số tiền thực nhận vào ví` : null;
    let result: { kind: 'credited' | 'dup' | 'orphan'; walletTxn?: Awaited<ReturnType<WalletService['apply']>> };
    try {
      result = await this.prisma.$transaction(async (db) => {
        const owner = tx.userId ? await db.user.findFirst({ where: { id: tx.userId, deletedAt: null }, select: { id: true } }) : null;
        const orphanNote = 'Nhận tiền nạp ví nhưng tài khoản không còn tồn tại — cần hoàn tiền cho khách';
        const claimed = await db.paymentTransaction.updateMany({
          where: { id: tx.id, status: { in: ['PENDING', 'EXPIRED', 'FAILED', 'CANCELLED'] } },
          data: {
            status: 'PAID',
            paidAt: new Date(),
            reference: opts.reference ?? tx.reference,
            providerTxnId: opts.txnId ?? null,
            needsRefund: !owner,
            note: !owner ? orphanNote : overNote,
            webhookData: mergeWebhookData(tx.webhookData, opts.data, opts.source),
          },
        });
        if (!claimed.count) return { kind: 'dup' as const };
        if (!owner) return { kind: 'orphan' as const };
        const walletTxn = await this.wallet.apply(db, {
          userId: owner.id,
          type: 'DEPOSIT',
          amount: credit,
          note: `Nạp tiền qua ${tx.provider.toUpperCase()}${tx.transferContent ? ` (${tx.transferContent})` : ''}${opts.reference ? ` — mã GD ${opts.reference}` : ''}`,
          meta: { source: 'gateway', provider: tx.provider, transactionId: tx.id },
        });
        return { kind: 'credited' as const, walletTxn };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { note: 'Giao dịch đã được xử lý trước đó (webhook gửi lại)' };
      throw err;
    }
    if (result.kind === 'dup') return this.afterDuplicate(tx, opts);
    if (result.kind === 'orphan') {
      this.logger.warn(`Giao dịch nạp ví ${tx.id}: tài khoản không còn tồn tại — cần hoàn tiền`);
      this.events.emit('activity', { userId: null, action: 'payment.needsRefund', entityType: 'payment', entityId: tx.id, meta: { provider: tx.provider, amount: opts.amount, purpose: PURPOSE_WALLET } });
      return { note: 'Tài khoản nạp tiền không còn tồn tại — cần hoàn tiền cho khách' };
    }
    const w = result.walletTxn!;
    await this.wallet.afterChange(w);
    const payload = { userId: w.userId, amount: Number(w.amount), transactionId: tx.id };
    this.events.emit('wallet.topup_completed', payload);
    await this.hooks.doAction('wallet.topup_completed', payload);
    return { note: overNote ? `Đã cộng ${vnd(credit)} vào ví · ${overNote}` : `Đã cộng ${vnd(credit)} vào ví`, ok: true };
  }

  /**
   * Nguồn của mã giao dịch (txnId) — mỗi nguồn có không gian mã riêng:
   * - `status:<mã cổng>`: do PaymentsService tự đặt khi hỏi trạng thái cổng (fetchStatus) — KHÔNG phải mã ngân hàng;
   * - `ipn:<transId>` / `bank:<id>`: Pay2S (IPN của Collection Link / webhook biến động số dư) — cùng một lần
   *   chuyển khoản có thể được báo bởi CẢ HAI nguồn với hai mã khác nhau;
   * - còn lại (`raw`): mã thật của cổng/ngân hàng (PayOS `reference`, SePay `id`...).
   */
  private txnSource(txnId: string | null | undefined): string {
    const m = /^([a-z]+):/.exec(txnId ?? '');
    return m ? m[1] : 'raw';
  }

  /**
   * Giao dịch đã PAID lại nhận thông báo tiền vào với txnId khác mã đã lưu. Quy tắc:
   * - txnId đã từng thấy (mã chính hoặc bí danh) -> gửi lại, bỏ qua;
   * - txnId từ polling (`status:`) -> chỉ báo "link đã thanh toán", không phải khoản tiền mới -> bỏ qua;
   * - cùng số tiền và đến từ NGUỒN CHƯA TỪNG THẤY trên giao dịch này -> cùng một lần chuyển tiền được báo
   *   từ kênh khác (vd polling rồi webhook, IPN rồi webhook số dư) -> ghi thêm bí danh, KHÔNG tạo khoản trả thêm;
   * - còn lại (cùng nguồn nhưng mã khác = hai giao dịch ngân hàng thật khác nhau, hoặc số tiền khác) -> khách trả trùng.
   */
  private async paidAgain(tx: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown }) {
    const txnId = opts.txnId!;
    const cur = (await this.prisma.paymentTransaction.findUnique({ where: { id: tx.id } })) ?? tx;
    const wd = cur.webhookData && typeof cur.webhookData === 'object' && !Array.isArray(cur.webhookData) ? (cur.webhookData as Record<string, unknown>) : {};
    const aliases = Array.isArray(wd.txnAliases) ? (wd.txnAliases as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const seen = [cur.providerTxnId, ...aliases].filter((x): x is string => !!x);
    const dupNote = { note: 'Cùng lần thanh toán đã ghi nhận (thông báo lặp từ nguồn khác)' };
    if (seen.includes(txnId)) return dupNote;
    const src = this.txnSource(txnId);
    if (src === 'status') return dupNote;
    // giao dịch được admin xác nhận tay mà chưa khớp thông báo thật nào: thông báo thật ĐẦU TIÊN có số tiền ≤ số đã xác nhận
    // (hoặc trùng một khoản nhận thiếu đã ghi) chính là lần chuyển tiền admin đã xác nhận -> chỉ gắn mã, không ghi nhận thêm
    if (wd.manual === true && !wd.manualMatched) {
      const confirmed = Number(wd.manualAmount ?? cur.amount);
      const unders = Array.isArray(wd.underpayments) ? (wd.underpayments as { amount?: unknown }[]).map((u) => Number(u?.amount)) : [];
      if (opts.amount <= confirmed + 0.5 || unders.some((a) => Math.abs(a - opts.amount) <= 0.5)) {
        await this.prisma.paymentTransaction.update({ where: { id: cur.id }, data: { webhookData: { ...wd, manualMatched: true, txnAliases: [...aliases, txnId].slice(-20) } as object } });
        if (!cur.providerTxnId) {
          await this.prisma.paymentTransaction
            .updateMany({ where: { id: cur.id, providerTxnId: null }, data: { providerTxnId: txnId, ...(opts.reference && !cur.reference ? { reference: opts.reference } : {}) } })
            .catch(() => undefined); // trùng unique -> bí danh vẫn đủ chống trùng
        }
        this.logger.log(`Giao dịch ${cur.id}: ${txnId} khớp lần xác nhận thủ công — không ghi nhận thêm`);
        return { note: 'Khớp với lần xác nhận thủ công trước đó — không ghi nhận thêm' };
      }
    }
    const sameAmount = Math.abs(opts.amount - Number(cur.amount)) <= 0.5;
    const sourceSeen = seen.some((id) => this.txnSource(id) === src);
    // giao dịch chỉ mới được xác nhận bằng polling (mã tạm `status:` mang số tiền yêu cầu, không phải số tiền thực nhận):
    // thông báo đầu tiên từ nguồn thật chính là lần chuyển tiền đó, kể cả khi số tiền lớn hơn (khách chuyển thừa)
    const placeholderOnly = seen.every((id) => this.txnSource(id) === 'status');
    const latePolled = placeholderOnly && !sourceSeen && opts.amount > Number(cur.amount) + 0.5;
    if ((!sameAmount && !latePolled) || sourceSeen) return this.recordExtraPayment(cur, opts);

    // cùng một lần chuyển tiền: lưu bí danh để lần sau (gửi lại / khoản khác cùng nguồn) so khớp được
    await this.prisma.paymentTransaction.update({ where: { id: cur.id }, data: { webhookData: { ...wd, txnAliases: [...aliases, txnId].slice(-20) } as object } });
    // mã đang lưu là mã tạm của polling -> thay bằng mã thật để chỉ mục unique chặn luôn các lần gửi lại sau
    if (this.txnSource(cur.providerTxnId) === 'status') {
      await this.prisma.paymentTransaction
        .updateMany({ where: { id: cur.id, providerTxnId: cur.providerTxnId }, data: { providerTxnId: txnId, ...(opts.reference ? { reference: opts.reference } : {}) } })
        .catch(() => undefined); // trùng unique (đã có bản ghi khác giữ mã này) -> giữ nguyên, bí danh vẫn đủ để chống trùng
    }
    if (latePolled) return this.recordLateOverpayment(cur, opts);
    this.logger.log(`Giao dịch ${cur.id}: ${txnId} là cùng lần thanh toán với ${cur.providerTxnId ?? '?'} (báo từ nguồn khác) — bỏ qua`);
    return dupNote;
  }

  /**
   * Polling đã ghi nhận đủ số tiền yêu cầu, webhook thật tới sau báo số tiền LỚN hơn (khách chuyển thừa):
   * - nạp ví: cộng thêm phần chênh lệch vào ví (giao dịch con `<mã>:over`, chống trùng bằng providerTxnId);
   * - đơn hàng: đánh dấu giao dịch cần hoàn phần thừa.
   */
  private async recordLateOverpayment(cur: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown }) {
    const over = Math.round((opts.amount - Number(cur.amount)) * 100) / 100;
    if (cur.purpose === PURPOSE_WALLET) return this.recordExtraPayment(cur, { ...opts, amount: over, txnId: `${opts.txnId}:over` });
    const note = `Nhận thừa ${vnd(over)} (nhận ${vnd(opts.amount)} / cần ${vnd(Number(cur.amount))}) — cần hoàn phần thừa cho khách`;
    await this.prisma.paymentTransaction.update({ where: { id: cur.id }, data: { needsRefund: true, note: cur.note ? `${cur.note} · ${note}` : note } });
    this.logger.warn(`Giao dịch ${cur.id}: ${note}`);
    return { note };
  }

  /**
   * Lưu khoản tiền nhận thêm thành giao dịch riêng.
   * - Đơn hàng: đánh dấu cần hoàn tiền & báo admin.
   * - Nạp ví: khách chuyển lại lần nữa cùng nội dung -> tạo giao dịch nạp ví mới và cộng tiếp vào ví (tiền vẫn là của khách).
   */
  private async recordExtraPayment(tx: PaymentTransaction, opts: { amount: number; reference?: string; txnId?: string; data?: unknown }) {
    const providerOrderCode = `${tx.providerOrderCode}-dup-${opts.txnId}`.slice(0, 190);
    if (tx.purpose === PURPOSE_WALLET) {
      try {
        const extra = await this.prisma.paymentTransaction.create({
          data: { purpose: PURPOSE_WALLET, userId: tx.userId, orderId: null, provider: tx.provider, amount: opts.amount, providerOrderCode, providerTxnId: opts.txnId, reference: opts.reference, note: 'Khách chuyển thêm cùng nội dung nạp ví' },
        });
        return this.markWalletPaid(extra, { ...opts, source: 'extra' });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') return { note: 'Giao dịch đã được xử lý trước đó (webhook gửi lại)' };
        throw err;
      }
    }
    if (!tx.orderId) return { note: 'Giao dịch không gắn với đơn hàng nào' };
    const reason = 'Khách thanh toán trùng (đã nhận tiền cho đơn này trước đó) — cần hoàn tiền';
    try {
      const extra = await this.prisma.paymentTransaction.create({
        data: {
          orderId: tx.orderId,
          provider: tx.provider,
          amount: opts.amount,
          providerOrderCode,
          providerTxnId: opts.txnId,
          reference: opts.reference,
          status: 'PAID',
          paidAt: new Date(),
          needsRefund: true,
          note: reason,
          webhookData: (opts.data ?? {}) as object,
        },
      });
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: tx.orderId }, include: { items: true } });
      const history = [...((order.history as object[]) ?? []), { status: order.status, note: `${reason}: ${opts.amount.toLocaleString('vi-VN')}đ qua ${tx.provider.toUpperCase()}${opts.reference ? ` (mã GD: ${opts.reference})` : ''}`, at: new Date().toISOString(), by: 'system' }];
      const updated = await this.prisma.order.update({ where: { id: order.id }, data: { history }, include: { items: true } });
      this.events.emit('order.paymentNeedsRefund', { order: updated, transactionId: extra.id, reason });
      await this.hooks.doAction('order.paymentNeedsRefund', updated, extra, reason);
      return { note: reason };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { note: 'Giao dịch đã được xử lý trước đó (webhook gửi lại)' };
      throw err;
    }
  }

  // ---------------- định kỳ: hết hạn giao dịch, huỷ đơn chưa thanh toán ----------------

  private pollingPending = false;

  /**
   * Quét ngầm mỗi 20 giây cho các giao dịch đang chờ (đặc biệt là cổng USDT / Crypto):
   * kể cả khi khách quét mã QR xong rồi tắt hẳn trình duyệt hoặc chuyển sang app ví trên điện thoại,
   * server vẫn tự động kích hoạt quét on-chain mọi mạng (TRC20, BEP20...) và cộng tiền tự động ngay khi giao dịch lên chuỗi.
   */
  @Cron('*/20 * * * * *')
  async pollPendingGateways() {
    if (process.env.NODE_ENV === 'test' || process.env.PORT === '4318' || this.pollingPending) return;
    const pollableKeys = [...this.providers.values()].filter((p) => !!p.fetchStatus && !p.hidden).map((p) => p.key);
    if (!pollableKeys.length) return;
    this.pollingPending = true;
    try {
      const pending = await this.prisma.paymentTransaction.findMany({
        where: {
          status: 'PENDING',
          provider: { in: pollableKeys },
          createdAt: { gt: new Date(Date.now() - 45 * 60_000) },
        },
        orderBy: { createdAt: 'desc' },
        take: 15,
      });
      for (const tx of pending) {
        await this.refreshPending(tx).catch((err: Error) =>
          this.logger.warn(`Quét ngầm trạng thái giao dịch ${tx.id} (${tx.provider}) lỗi: ${err.message}`),
        );
      }
    } finally {
      this.pollingPending = false;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep() {
    if (process.env.NODE_ENV === 'test' || process.env.PORT === '4318') return;
    // Trước khi đánh dấu EXPIRED cho các cổng có fetchStatus (vd USDT), kiểm tra trạng thái cổng lần cuối để không bỏ sót khoản khách vừa chuyển sát giờ
    const pollableKeys = [...this.providers.values()].filter((p) => !!p.fetchStatus && !p.hidden).map((p) => p.key);
    if (pollableKeys.length) {
      const expiringPollable = await this.prisma.paymentTransaction.findMany({
        where: { status: 'PENDING', provider: { in: pollableKeys }, expiresAt: { lt: new Date() } },
        take: 25,
      });
      for (const tx of expiringPollable) {
        await this.refreshPending(tx).catch(() => undefined);
      }
    }
    await this.prisma.paymentTransaction.updateMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } });
    const commerce = await this.settings.get<CommerceSettings>('commerce');
    const minutes = Number(commerce.autoCancelUnpaidMinutes) || 0;
    if (!minutes) return;
    const stale = await this.prisma.order.findMany({
      where: {
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: { in: [...this.providers.keys()] },
        createdAt: { lt: new Date(Date.now() - minutes * 60_000) },
        // khách đang có QR / link còn hạn -> chưa huỷ
        payments: { none: { status: 'PENDING', expiresAt: { gt: new Date() } } },
      },
      select: { id: true },
      take: 50,
    });
    for (const o of stale) this.events.emit('order.autoCancel', { orderId: o.id });
  }

  // ---------------- admin ----------------

  /** Khoảng thời gian lọc giao dịch theo múi giờ Việt Nam (UTC+7) */
  private vnDateRange(q: { range?: string; from?: string; to?: string }): Prisma.DateTimeFilter | undefined {
    const VN = 7 * 3_600_000;
    const vnStart = (year: number, month0: number, day: number) => new Date(Date.UTC(year, month0, day) - VN);
    if (q.from || q.to) {
      const f: Prisma.DateTimeFilter = {};
      if (q.from) {
        const d = new Date(`${q.from}T00:00:00.000+07:00`);
        if (!Number.isNaN(d.getTime())) f.gte = d;
      }
      if (q.to) {
        const d = new Date(`${q.to}T23:59:59.999+07:00`);
        if (!Number.isNaN(d.getTime())) f.lte = d;
      }
      return Object.keys(f).length ? f : undefined;
    }
    if (!q.range) return undefined;
    const nowVn = new Date(Date.now() + VN);
    const y = nowVn.getUTCFullYear();
    const m = nowVn.getUTCMonth();
    const d = nowVn.getUTCDate();
    switch (q.range) {
      case 'today':
        return { gte: vnStart(y, m, d), lt: vnStart(y, m, d + 1) };
      case 'yesterday':
        return { gte: vnStart(y, m, d - 1), lt: vnStart(y, m, d) };
      case 'daybefore':
        return { gte: vnStart(y, m, d - 2), lt: vnStart(y, m, d - 1) };
      case '7d':
        return { gte: vnStart(y, m, d - 6), lt: vnStart(y, m, d + 1) };
      case '30d':
        return { gte: vnStart(y, m, d - 29), lt: vnStart(y, m, d + 1) };
      case 'this_month':
        return { gte: vnStart(y, m, 1), lt: vnStart(y, m + 1, 1) };
      case 'last_month':
        return { gte: vnStart(y, m - 1, 1), lt: vnStart(y, m, 1) };
      default:
        return undefined;
    }
  }

  /** Admin: danh sách giao dịch (thanh toán đơn + nạp ví) kèm tổng tiền đã thanh toán theo bộ lọc hiện tại */
  async transactions(q: { page?: number; limit?: number; status?: string; provider?: string; search?: string; orderId?: string; userId?: string; needsRefund?: string; purpose?: string; range?: string; from?: string; to?: string }) {
    const { skip, take, page, limit } = pageArgs(q);
    const baseWhere: Prisma.PaymentTransactionWhereInput = {};
    if (q.provider) baseWhere.provider = q.provider;
    if (q.orderId) baseWhere.orderId = q.orderId;
    if (q.userId) baseWhere.userId = q.userId;
    if (q.purpose) baseWhere.purpose = q.purpose;
    if (q.needsRefund === '1') baseWhere.needsRefund = true;
    const createdAt = this.vnDateRange(q);
    if (createdAt) baseWhere.createdAt = createdAt;
    if (q.search) {
      baseWhere.OR = [
        { order: { code: { contains: q.search, mode: 'insensitive' } } },
        { user: { email: { contains: q.search, mode: 'insensitive' } } },
        { user: { name: { contains: q.search, mode: 'insensitive' } } },
        { transferContent: { contains: q.search, mode: 'insensitive' } },
        { reference: { contains: q.search } },
        { providerOrderCode: { contains: q.search } },
        { providerTxnId: { contains: q.search } },
      ];
    }
    const where: Prisma.PaymentTransactionWhereInput = q.status
      ? { ...baseWhere, status: q.status as Prisma.PaymentTransactionWhereInput['status'] }
      : baseWhere;
    const paidWhere: Prisma.PaymentTransactionWhereInput = { ...baseWhere, status: 'PAID' };
    const [rawRows, total, paidAgg, paidUsdtRows] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        omit: { rawRequest: true },
        include: { order: { select: { id: true, code: true, customerName: true, status: true, paymentStatus: true } }, user: { select: { id: true, email: true, name: true } } },
      }),
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.aggregate({ where: paidWhere, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.paymentTransaction.findMany({
        where: { ...paidWhere, provider: 'usdt' },
        select: { amount: true, rawResponse: true },
      }),
    ]);

    const extractUsdt = (r: { provider: string; amount: unknown; rawResponse: unknown; webhookData?: unknown }) => {
      if (r.provider !== 'usdt') return { usdtAmount: null, usdtRate: null };
      const raw = (r.rawResponse ?? null) as { usdt?: { amount?: unknown; payAmount?: unknown; rate?: unknown } } | null;
      const u = raw?.usdt;
      const amt = Number(u?.payAmount ?? u?.amount);
      const rate = Number(u?.rate);
      return {
        usdtAmount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : null,
        usdtRate: Number.isFinite(rate) && rate > 0 ? rate : null,
      };
    };

    const data = rawRows.map((r) => {
      const { rawResponse: _rr, webhookData: _wd, ...clean } = r;
      const { usdtAmount, usdtRate } = extractUsdt(r);
      return {
        ...clean,
        usdtAmount,
        usdtRate,
      };
    });

    let paidUsdt = 0;
    for (const r of paidUsdtRows) {
      const { usdtAmount } = extractUsdt({ provider: 'usdt', amount: r.amount, rawResponse: r.rawResponse });
      if (usdtAmount !== null) paidUsdt += usdtAmount;
    }
    paidUsdt = Math.round(paidUsdt * 100) / 100;

    const paidAmount = Number(paidAgg._sum.amount ?? 0);
    return {
      ...paginate(data, total, page, limit),
      summary: {
        paidCount: paidAgg._count._all,
        paidAmount,
        receivedAmount: paidAmount,
        paidUsdt,
      },
    };
  }

  async webhookLogs(q: { page?: number; limit?: number; provider?: string }) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = q.provider ? { provider: q.provider } : {};
    const [data, total] = await Promise.all([
      this.prisma.paymentWebhookLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.paymentWebhookLog.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  /**
   * Admin xác nhận thủ công một giao dịch (vd khách chuyển khoản sai nội dung).
   * - Đơn hàng: ghi nhận đúng số tiền giao dịch (tham số amount bị bỏ qua).
   * - Nạp ví: cộng `amount` (số tiền admin thực nhận, mặc định = số tiền giao dịch) vào ví khách.
   */
  async confirmManually(id: string, actor: AuthUser, reference?: string, amount?: number, bankTxnId?: string) {
    const tx = await this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id }, include: { order: { select: { status: true, paymentStatus: true } } } });
    // mã giao dịch ngân hàng (tuỳ chọn): lưu làm providerTxnId -> webhook của chính lần chuyển đó tới sau bị chặn trùng
    const txnId = bankTxnId?.trim() || undefined;
    if (txnId) {
      const used = await this.prisma.paymentTransaction.findUnique({ where: { provider_providerTxnId: { provider: tx.provider, providerTxnId: txnId } }, select: { id: true } });
      if (used) throw new BadRequestException('Mã giao dịch ngân hàng này đã được ghi nhận cho giao dịch khác');
    }
    if (tx.purpose === PURPOSE_WALLET) {
      // cộng tiền vào ví cần quyền điều chỉnh ví (route chỉ yêu cầu orders.write)
      if (!hasPermission(actor.permissions, 'users.wallet')) throw new ForbiddenException('Bạn không có quyền cộng tiền vào ví thành viên');
      if (tx.status === 'PAID') throw new BadRequestException('Giao dịch nạp ví đã được ghi nhận trước đó');
      const credit = amount ?? Number(tx.amount);
      if (!Number.isFinite(credit) || credit <= 0) throw new BadRequestException('Số tiền không hợp lệ');
      const r = await this.markPaid(tx, { amount: credit, reference, txnId, data: { manual: true, by: actor.id, manualAmount: credit }, source: 'manual' });
      if (!r.ok) throw new BadRequestException(r.note);
      this.events.emit('activity', { userId: actor.id, action: 'payment.confirm', entityType: 'user', entityId: tx.userId, meta: { transactionId: id, purpose: PURPOSE_WALLET, amount: credit } });
      return r;
    }
    if (!tx.order) throw new BadRequestException('Giao dịch không gắn với đơn hàng nào');
    if (tx.order.paymentStatus === 'PAID') throw new BadRequestException('Đơn hàng đã được thanh toán bằng giao dịch khác');
    if (['CANCELLED', 'REFUNDED'].includes(tx.order.status)) throw new BadRequestException('Đơn hàng đã huỷ / hoàn tiền');
    const r = await this.markPaid(tx, { amount: Number(tx.amount), reference, txnId, data: { manual: true, by: actor.id, manualAmount: Number(tx.amount) }, source: 'manual' });
    if (!r.ok) throw new BadRequestException(r.note);
    this.events.emit('activity', { userId: actor.id, action: 'payment.confirm', entityType: 'order', entityId: tx.orderId, meta: { transactionId: id } });
    return r;
  }

  /** Danh sách cổng cho admin (bỏ cổng ẩn): trạng thái bật / đủ cấu hình + URL webhook để khai báo ở trang quản trị của cổng */
  async providerList() {
    const api = (this.config.get<string>('apiPublicUrl') ?? '').replace(/\/$/, '');
    return Promise.all(
      [...this.providers.values()].filter((p) => !p.hidden).map(async (p) => ({
        key: p.key,
        label: p.label,
        enabled: await p.isEnabled(),
        configured: await p.isConfigured(),
        webhookUrl: `${api}/api/payments/webhook/${p.key}`,
      })),
    );
  }

  // ---------------- hoàn tiền qua cổng ----------------

  /** Cổng có hỗ trợ hoàn tiền tự động (provider khai báo `refund`); bật/tắt được kiểm lại khi thực hiện hoàn */
  supportsRefund(providerKey: string) {
    return !!this.providers.get(providerKey)?.refund;
  }

  /** Giao dịch đã PAID mới nhất của đơn (để hoàn tiền qua cổng) */
  paidTransaction(orderId: string) {
    return this.prisma.paymentTransaction.findFirst({ where: { orderId, status: 'PAID' }, orderBy: { paidAt: 'desc' } });
  }

  /**
   * Gọi cổng hoàn tiền cho một giao dịch đã PAID. Không ghi DB — OrdersAdminService tạo bản ghi Refund.
   * Ném 400 khi cổng không hỗ trợ / không cấu hình / lỗi từ cổng.
   */
  async refund(order: Order, tx: PaymentTransaction, amount: number, reason?: string) {
    const provider = this.providers.get(tx.provider);
    if (!provider?.refund || !(await provider.isEnabled())) throw new BadRequestException(`Cổng ${tx.provider.toUpperCase()} không hỗ trợ hoàn tiền tự động, hãy hoàn thủ công`);
    if (tx.status !== 'PAID') throw new BadRequestException('Giao dịch chưa thanh toán thành công, không thể hoàn tiền qua cổng');
    try {
      return await provider.refund({ order, transaction: tx, amount, reason });
    } catch (err) {
      this.logger.error(`Hoàn tiền ${tx.provider} cho đơn ${order.code} lỗi: ${(err as Error).message}`);
      throw new BadRequestException(`Cổng thanh toán từ chối hoàn tiền: ${(err as Error).message}`);
    }
  }
}
