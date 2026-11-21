import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { isValidTimezone, localDay, zonedDayStart } from '../reports/reports.util.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { CardTopup, Prisma } from '../../generated/prisma/client.js';
import type { CardCallbackInput, CardProviderConfig, CardResult } from './card-provider.interface.js';
import { CARD_PROVIDERS, findCardProvider } from './providers/index.js';
import { cardCallbackLogPayload } from './card-callback-log.js';
import type { AdminCardTopupQuery, ApproveCardDto, CardTopupQuery, SubmitCardDto } from './card-topup.dto.js';

/** Một nhà mạng / loại thẻ admin cho phép nạp */
export interface TelcoSetting {
  /** Mã gửi sang nhà cung cấp (VIETTEL, MOBIFONE...) */
  code: string;
  name: string;
  enabled: boolean;
  /** Chiết khấu riêng (%) — để trống dùng chiết khấu chung */
  discount?: number | null;
  /** Độ dài serial / mã thẻ hợp lệ, phân tách dấu phẩy (vd "11,14"); để trống = không kiểm */
  serialLength?: string;
  pinLength?: string;
}

/** Nhóm cài đặt `card_topup` (Cài đặt › Cổng thanh toán › Nạp thẻ cào) */
export interface CardTopupSettings {
  enabled?: boolean;
  /** Khoá nhà cung cấp trong CARD_PROVIDERS */
  provider?: string;
  /** Tên miền + cách gửi — chỉ dùng cho nhà cung cấp "tuỳ chỉnh" */
  domain?: string;
  method?: 'GET' | 'POST';
  partnerId?: string;
  partnerKey?: string;
  /** discount = cộng mệnh giá trừ chiết khấu của shop; provider = cộng đúng số tiền nhà cung cấp trả */
  creditMode?: 'discount' | 'provider';
  /** Chiết khấu chung (%) */
  discount?: number;
  /** Phạt (%) thêm khi thẻ sai mệnh giá (chỉ áp với creditMode=discount) */
  wrongValuePenalty?: number;
  telcos?: TelcoSetting[];
  /** Các mệnh giá cho phép */
  amounts?: number[];
  /** Số thẻ đang chờ tối đa của một thành viên */
  maxPending?: number;
  /** Số thẻ lỗi tối đa trong ngày — vượt thì khoá chức năng tới hết ngày (0 = không giới hạn) */
  dailyFailLimit?: number;
  /** Lưu ý hiển thị cho khách (HTML) */
  notice?: string;
}

/** Làm tròn xuống đồng, không âm */
const round0 = (n: number) => Math.max(0, Math.floor(n));
const clampPct = (n: unknown, fallback = 0) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
};
/** Chỉ giữ chữ + số (khách hay dán kèm khoảng trắng / gạch) */
const cleanCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
/** Che mã thẻ khi trả cho khách: chỉ hiện 4 số cuối */
const maskPin = (pin: string) => (pin.length <= 4 ? '****' : `${'*'.repeat(Math.min(8, pin.length - 4))}${pin.slice(-4)}`);

@Injectable()
export class CardTopupService {
  private readonly logger = new Logger('CardTopup');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  // ---------------- cấu hình ----------------

  private cfg() {
    return this.settings.get<CardTopupSettings>('card_topup');
  }

  private connection(s: CardTopupSettings): CardProviderConfig {
    return { partnerId: s.partnerId ?? '', partnerKey: s.partnerKey ?? '', domain: s.domain, method: s.method };
  }

  /** Đủ thông tin kết nối nhà cung cấp chưa */
  private isConfigured(s: CardTopupSettings) {
    const p = findCardProvider(s.provider);
    return !!(p && s.partnerId && s.partnerKey && (!p.needsDomain || s.domain));
  }

  private telcos(s: CardTopupSettings) {
    return (s.telcos ?? []).filter((t) => t.enabled && t.code);
  }

  /** Chiết khấu thực tế của một nhà mạng (%) */
  private discountOf(s: CardTopupSettings, telco: string) {
    const t = (s.telcos ?? []).find((x) => x.code === telco);
    return t?.discount != null && `${t.discount}` !== '' ? clampPct(t.discount) : clampPct(s.discount);
  }

  /** URL callback khai báo bên nhà cung cấp */
  callbackUrl(providerKey: string) {
    const api = (this.config.get<string>('apiPublicUrl') ?? '').replace(/\/$/, '');
    return `${api}/api/card-topup/callback/${providerKey}`;
  }

  /** Admin: danh sách nhà cung cấp hỗ trợ + trạng thái cấu hình */
  async providers() {
    const s = await this.cfg();
    return {
      enabled: s.enabled === true,
      configured: this.isConfigured(s),
      active: s.provider ?? null,
      providers: CARD_PROVIDERS.map((p) => ({ key: p.key, label: p.label, website: p.website, needsDomain: !!p.needsDomain, callbackUrl: this.callbackUrl(p.key) })),
    };
  }

  /** Storefront: cấu hình hiển thị form nạp thẻ (không lộ khoá) */
  async publicConfig() {
    const s = await this.cfg();
    const enabled = s.enabled === true && this.isConfigured(s);
    return {
      enabled,
      creditMode: s.creditMode ?? 'discount',
      telcos: enabled ? this.telcos(s).map((t) => ({ code: t.code, name: t.name, discount: (s.creditMode ?? 'discount') === 'discount' ? this.discountOf(s, t.code) : null })) : [],
      amounts: enabled ? (s.amounts ?? []).filter((a) => Number(a) > 0).sort((a, b) => a - b) : [],
      wrongValuePenalty: clampPct(s.wrongValuePenalty),
      notice: s.notice ?? '',
    };
  }

  // ---------------- khách gửi thẻ ----------------

  async submit(user: AuthUser, dto: SubmitCardDto, ip?: string) {
    const s = await this.cfg();
    const provider = findCardProvider(s.provider);
    if (s.enabled !== true || !provider || !this.isConfigured(s)) throw new BadRequestException('Chức năng nạp thẻ đang bảo trì');

    const telco = this.telcos(s).find((t) => t.code.toUpperCase() === dto.telco.toUpperCase());
    if (!telco) throw new BadRequestException('Loại thẻ không được hỗ trợ');
    const amount = Number(dto.amount);
    if (!(s.amounts ?? []).map(Number).includes(amount)) throw new BadRequestException('Mệnh giá không hợp lệ');

    const serial = cleanCode(dto.serial);
    const pin = cleanCode(dto.pin);
    if (!/^[A-Z0-9]{6,30}$/.test(serial)) throw new BadRequestException('Serial thẻ không hợp lệ');
    if (!/^[A-Z0-9]{6,30}$/.test(pin)) throw new BadRequestException('Mã thẻ không hợp lệ');
    const lens = (v?: string) => (v ?? '').split(/[,\s]+/).map(Number).filter((n) => n > 0);
    if (lens(telco.serialLength).length && !lens(telco.serialLength).includes(serial.length)) throw new BadRequestException(`Serial ${telco.name} phải có ${lens(telco.serialLength).join(' hoặc ')} ký tự`);
    if (lens(telco.pinLength).length && !lens(telco.pinLength).includes(pin.length)) throw new BadRequestException(`Mã thẻ ${telco.name} phải có ${lens(telco.pinLength).join(' hoặc ')} ký tự`);

    // Kiểm tra trùng thẻ + giới hạn rồi tạo bản ghi trong CÙNG transaction có khoá advisory (theo thẻ và theo thành viên):
    // hai request song song (bấm 2 lần, gửi từ 2 tab / 2 tài khoản) không thể cùng lọt qua kiểm tra rồi gửi thẻ hai lần.
    const maxPending = Number(s.maxPending) || 5;
    const failLimit = Number(s.dailyFailLimit) || 0;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`card:${serial}:${pin}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`card-user:${user.id}`}))`;

      // thẻ đã gửi (đang chờ / đã cộng) thì không nhận lại
      const dup = await tx.cardTopup.findFirst({ where: { serial, pin, status: { in: ['PENDING', 'SUCCESS', 'WRONG_VALUE'] } }, select: { id: true } });
      if (dup) throw new BadRequestException('Thẻ này đã được gửi trước đó');

      const pending = await tx.cardTopup.count({ where: { userId: user.id, status: 'PENDING' } });
      if (pending >= maxPending) throw new BadRequestException(`Bạn đang có ${pending} thẻ chờ xử lý, vui lòng đợi kết quả trước khi nạp thêm`);

      // đếm thẻ lỗi trong 24 giờ gần nhất (không phụ thuộc múi giờ máy chủ)
      if (failLimit > 0) {
        const failed = await tx.cardTopup.count({ where: { userId: user.id, status: 'FAILED', systemError: false, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } });
        if (failed >= failLimit) throw new BadRequestException('Bạn đã nạp sai quá nhiều thẻ trong 24 giờ qua, vui lòng thử lại sau');
      }

      // tạo bản ghi TRƯỚC khi gửi để callback về sớm vẫn tìm thấy
      return tx.cardTopup.create({
        data: {
          code: `NT${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`,
          userId: user.id,
          provider: provider.key,
          telco: telco.code,
          serial,
          pin,
          declaredValue: amount,
          discount: this.discountOf(s, telco.code),
          ip: ip ?? null,
        },
      });
    });

    let result: CardResult;
    try {
      result = await provider.submit(this.connection(s), { code: row.code, telco: telco.code, serial, pin, amount });
    } catch (e) {
      // không rõ nhà cung cấp đã nhận thẻ hay chưa → giữ chờ, callback hoặc cron kiểm tra sẽ chốt kết quả
      this.logger.warn(`Gửi thẻ ${row.code} lỗi: ${(e as Error).message}`);
      await this.prisma.cardTopup.update({ where: { id: row.id }, data: { message: 'Chưa nhận được phản hồi từ nhà cung cấp, hệ thống sẽ tự kiểm tra lại' } });
      return { item: this.forCustomer({ ...row, message: null }), message: 'Đã gửi thẻ, vui lòng chờ xử lý trong giây lát' };
    }

    // nhà cung cấp không nhận yêu cầu (bảo trì / sai cấu hình): bỏ bản ghi để khách gửi lại sau, không tính là thẻ lỗi
    if (result.rejected) {
      await this.prisma.cardTopup.deleteMany({ where: { id: row.id, status: 'PENDING' } });
      this.logger.warn(`Nhà cung cấp ${provider.key} từ chối thẻ ${row.code}: ${result.message ?? ''}`);
      throw new BadRequestException(`Hệ thống nạp thẻ tạm thời không nhận thẻ${result.message ? ` (${result.message})` : ''}, vui lòng thử lại sau`);
    }

    if (result.status === 'PENDING') {
      const updated = await this.prisma.cardTopup.update({ where: { id: row.id }, data: { providerRef: result.providerRef ?? null } });
      this.events.emit('card_topup.submitted', { id: row.id, userId: user.id, telco: telco.code, amount });
      return { item: this.forCustomer(updated), message: 'Đã gửi thẻ, vui lòng chờ xử lý trong giây lát' };
    }
    const done = await this.finalize(row.id, result);
    const after = await this.prisma.cardTopup.findUniqueOrThrow({ where: { id: row.id } });
    if (result.status === 'FAILED') throw new BadRequestException(result.message || 'Thẻ không hợp lệ hoặc đã được sử dụng');
    return { item: this.forCustomer(after), message: done ? `Nạp thẻ thành công, đã cộng ${Number(after.credited).toLocaleString('vi-VN')}đ vào ví` : 'Thẻ đã được xử lý' };
  }

  /** Lịch sử nạp thẻ của chính thành viên (mã thẻ đã che) */
  async mine(userId: string, q: CardTopupQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.CardTopupWhereInput = { userId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.prisma.cardTopup.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.cardTopup.count({ where })]);
    return paginate(rows.map((r) => this.forCustomer(r)), total, page, limit);
  }

  private forCustomer(r: CardTopup) {
    return {
      id: r.id,
      code: r.code,
      telco: r.telco,
      serial: r.serial,
      pin: maskPin(r.pin),
      declaredValue: r.declaredValue,
      realValue: r.realValue,
      credited: Number(r.credited),
      status: r.status,
      message: r.message,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  // ---------------- chốt kết quả + cộng ví ----------------

  /** Số tiền cộng ví theo cấu hình hiện tại */
  private creditFor(s: CardTopupSettings, row: CardTopup, r: CardResult) {
    if (r.status !== 'SUCCESS' && r.status !== 'WRONG_VALUE') return 0;
    // chế độ "đúng số tiền nhà cung cấp trả" chỉ dùng khi có số tiền đó; duyệt tay thì tính theo chiết khấu
    if ((s.creditMode ?? 'discount') === 'provider' && r.providerAmount != null) return round0(r.providerAmount);
    const base = r.status === 'SUCCESS' ? (r.realValue ?? row.declaredValue) : (r.realValue ?? 0);
    let credit = base * (1 - Number(row.discount) / 100);
    if (r.status === 'WRONG_VALUE') credit *= 1 - clampPct(s.wrongValuePenalty) / 100;
    return round0(credit);
  }

  /**
   * Chốt kết quả cho thẻ đang PENDING. Chỉ chuyển trạng thái khi còn PENDING (updateMany có điều kiện) nên callback
   * gửi lặp / cron chạy song song không thể cộng ví hai lần. Trả về giao dịch ví (nếu có cộng tiền).
   */
  private async finalize(id: string, r: CardResult, opts: { credited?: number; reviewerId?: string } = {}) {
    if (r.status === 'PENDING') return null;
    const s = await this.cfg();
    const row = await this.prisma.cardTopup.findUnique({ where: { id } });
    if (!row || row.status !== 'PENDING') return null;
    // sai mệnh giá mà nhà cung cấp không báo mệnh giá thật / số tiền: không tự chốt 0đ, giữ chờ để admin duyệt tay
    if (r.status === 'WRONG_VALUE' && opts.credited == null && !r.realValue && r.providerAmount == null) {
      await this.prisma.cardTopup.updateMany({ where: { id, status: 'PENDING' }, data: { message: 'Sai mệnh giá — nhà cung cấp không báo mệnh giá thật, chờ admin duyệt', providerRef: r.providerRef ?? row.providerRef } });
      return null;
    }
    const credited = opts.credited ?? this.creditFor(s, row, r);
    /** Chủ ví đã bị xoá (deletedAt) lúc có kết quả: thẻ vẫn được chốt (không treo PENDING mãi) nhưng không cộng ví */
    let orphan = false;
    const txn = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.cardTopup.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: r.status as 'SUCCESS' | 'WRONG_VALUE' | 'FAILED',
          realValue: r.realValue ?? null,
          providerAmount: r.providerAmount ?? null,
          providerRef: r.providerRef ?? row.providerRef,
          // nhà cung cấp chưa từng nhận thẻ: lỗi phía hệ thống, không tính vào giới hạn thẻ lỗi của khách
          systemError: r.status === 'FAILED' && !!r.rejected,
          message: r.status === 'FAILED' && r.rejected ? 'Nhà cung cấp chưa nhận được thẻ, vui lòng gửi lại' : (r.message ?? null),
          credited,
          completedAt: new Date(),
          reviewedById: opts.reviewerId ?? null,
        },
      });
      if (!upd.count || credited <= 0) return null;
      // phòng thủ: tài khoản đã xoá thì wallet.apply sẽ ném NotFound -> rollback, thẻ kẹt PENDING; thay vào đó ghi chú để xử lý tay
      const owner = await tx.user.findFirst({ where: { id: row.userId, deletedAt: null }, select: { id: true } });
      if (!owner) {
        orphan = true;
        await tx.cardTopup.update({ where: { id }, data: { credited: 0, message: 'Chủ tài khoản đã xoá — cần xử lý tay' } });
        return null;
      }
      const label = (s.telcos ?? []).find((t) => t.code === row.telco)?.name ?? row.telco;
      const w = await this.wallet.apply(tx, {
        userId: row.userId,
        type: 'DEPOSIT',
        amount: credited,
        note: `Nạp thẻ ${label} ${row.declaredValue.toLocaleString('vi-VN')}đ — serial ${row.serial}${r.status === 'WRONG_VALUE' ? ' (sai mệnh giá)' : ''}`,
        createdById: opts.reviewerId ?? null,
        meta: { source: 'card_topup', cardTopupId: id, code: row.code },
      });
      await tx.cardTopup.update({ where: { id }, data: { walletTxnId: w.id } });
      return w;
    });
    if (orphan) {
      this.logger.warn(`Thẻ ${row.code}: chủ tài khoản đã xoá — không cộng ví ${credited}đ, cần xử lý tay`);
      return null;
    }
    if (txn) await this.wallet.afterChange(txn, opts.reviewerId ? ({ id: opts.reviewerId } as AuthUser) : undefined);
    this.events.emit('card_topup.completed', { id, userId: row.userId, status: r.status, credited });
    return txn;
  }

  // ---------------- callback nhà cung cấp ----------------

  async callback(providerKey: string, input: CardCallbackInput & { ip?: string }) {
    const provider = findCardProvider(providerKey);
    // request không hợp lệ / nhà cung cấp lạ: lưu payload rỗng; hợp lệ: che mã thẻ/serial + cắt ngắn ≤ 20KB
    const log = (valid: boolean, matched: boolean, note: string) =>
      this.prisma.paymentWebhookLog
        .create({ data: { provider: `card_${providerKey}`.slice(0, 60), payload: cardCallbackLogPayload(input, valid), valid, matched, note: note.slice(0, 1000), ip: input.ip ?? null } })
        .catch(() => undefined);
    if (!provider) {
      await log(false, false, 'Nhà cung cấp không tồn tại');
      return { statusCode: 404, body: { status: false, message: 'unknown provider' } };
    }
    const s = await this.cfg();
    const r = provider.parseCallback(this.connection(s), input);
    if (!r.valid) {
      await log(false, false, r.message ?? 'Callback không hợp lệ');
      return { statusCode: 401, body: { status: false, message: r.message } };
    }
    const row = await this.prisma.cardTopup.findUnique({ where: { code: r.code! } });
    if (!row || row.provider !== provider.key) {
      await log(true, false, `Không tìm thấy thẻ ${r.code}`);
      return { statusCode: 200, body: { status: false, message: 'request_id not found' } };
    }
    if (row.serial !== cleanCode(r.serial ?? '') || row.pin !== cleanCode(r.pin ?? '')) {
      await log(true, false, `Serial/mã thẻ không khớp ${row.code}`);
      return { statusCode: 200, body: { status: false, message: 'card mismatch' } };
    }
    if (row.status !== 'PENDING') {
      await log(true, true, `Thẻ ${row.code} đã xử lý trước đó (${row.status})`);
      return { statusCode: 200, body: { status: true, message: 'already processed' } };
    }
    if (r.status === 'PENDING') {
      await log(true, true, `Thẻ ${row.code} vẫn đang chờ`);
      return { statusCode: 200, body: { status: true } };
    }
    await this.finalize(row.id, r);
    await log(true, true, `Thẻ ${row.code}: ${r.status}${r.message ? ` — ${r.message}` : ''}`);
    return { statusCode: 200, body: { status: true } };
  }

  // ---------------- cron: hỏi lại thẻ chưa có callback ----------------

  /** Mỗi 5 phút hỏi lại tối đa 30 thẻ chờ > 3 phút (trong 48 giờ gần nhất); sau đó để admin duyệt tay */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep() {
    if (process.env.NODE_ENV === 'test') return;
    const s = await this.cfg();
    if (!this.isConfigured(s)) return;
    const now = Date.now();
    const rows = await this.prisma.cardTopup.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now - 3 * 60_000), gt: new Date(now - 48 * 3600_000) },
        OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now - 5 * 60_000) } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 30,
    });
    for (const row of rows) await this.checkOne(row, s).catch((e) => this.logger.warn(`Kiểm tra thẻ ${row.code} lỗi: ${(e as Error).message}`));
  }

  private async checkOne(row: CardTopup, s: CardTopupSettings) {
    const provider = findCardProvider(row.provider);
    if (!provider?.check) return null;
    await this.prisma.cardTopup.update({ where: { id: row.id }, data: { checkedAt: new Date() } });
    const r = await provider.check(this.connection(s), { code: row.code, telco: row.telco, serial: row.serial, pin: row.pin, amount: row.declaredValue });
    await this.finalize(row.id, r);
    return r;
  }

  // ---------------- admin ----------------

  async list(q: AdminCardTopupQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const where: Prisma.CardTopupWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.telco ? { telco: q.telco } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { serial: { contains: search.toUpperCase() } },
              { pin: { contains: search.toUpperCase() } },
              { user: { email: { contains: search, mode: 'insensitive' } } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.cardTopup.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { user: { select: { id: true, name: true, email: true } }, reviewedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.cardTopup.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  /** Thống kê nhanh: số thẻ theo trạng thái + tổng cộng ví hôm nay */
  async stats() {
    // "hôm nay" theo múi giờ website (Cài đặt › Chung), không theo múi giờ máy chủ
    const general = await this.settings.get<{ timezone?: string }>('general');
    const tz = isValidTimezone(general.timezone) ? general.timezone : 'Asia/Ho_Chi_Minh';
    const startOfDay = zonedDayStart(localDay(new Date(), tz), tz);
    const [byStatus, today] = await Promise.all([
      this.prisma.cardTopup.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.cardTopup.aggregate({ where: { completedAt: { gte: startOfDay }, status: { in: ['SUCCESS', 'WRONG_VALUE'] } }, _sum: { credited: true, declaredValue: true }, _count: { _all: true } }),
    ]);
    const count = (st: string) => byStatus.find((b) => b.status === st)?._count._all ?? 0;
    return {
      pending: count('PENDING'),
      success: count('SUCCESS'),
      wrongValue: count('WRONG_VALUE'),
      failed: count('FAILED'),
      today: { cards: today._count._all, declared: Number(today._sum.declaredValue ?? 0), credited: Number(today._sum.credited ?? 0) },
    };
  }

  private async pendingRow(id: string) {
    const row = await this.prisma.cardTopup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy thẻ');
    if (row.status !== 'PENDING') throw new BadRequestException('Thẻ đã có kết quả, không thể xử lý lại');
    return row;
  }

  /** Admin bấm "Kiểm tra lại" — hỏi trạng thái từ nhà cung cấp ngay */
  async recheck(id: string) {
    const row = await this.pendingRow(id);
    const r = await this.checkOne(row, await this.cfg()).catch((e: Error) => {
      throw new BadRequestException(`Không hỏi được nhà cung cấp: ${e.message}`);
    });
    if (!r) throw new BadRequestException('Nhà cung cấp này không hỗ trợ kiểm tra trạng thái');
    return { status: r.status, message: r.message ?? null };
  }

  /** Admin duyệt tay: chốt thành công và cộng ví (số tiền admin nhập hoặc tính theo cấu hình) */
  async approve(id: string, dto: ApproveCardDto, actor: AuthUser) {
    const row = await this.pendingRow(id);
    const realValue = dto.realValue ?? row.declaredValue;
    const status = realValue === row.declaredValue ? 'SUCCESS' : 'WRONG_VALUE';
    const r: CardResult = { status, realValue, message: dto.note?.trim() || 'Admin duyệt thủ công' };
    const txn = await this.finalize(row.id, r, { credited: dto.credited, reviewerId: actor.id });
    this.events.emit('activity', { userId: actor.id, action: 'card_topup.approve', entityType: 'user', entityId: row.userId, meta: { code: row.code, realValue, credited: txn ? Number(txn.amount) : 0 } });
    return this.prisma.cardTopup.findUniqueOrThrow({ where: { id } });
  }

  /** Admin từ chối: đánh dấu thẻ lỗi, không cộng ví */
  async reject(id: string, reason: string | undefined, actor: AuthUser) {
    const row = await this.pendingRow(id);
    await this.finalize(row.id, { status: 'FAILED', message: reason?.trim() || 'Admin từ chối thẻ' }, { reviewerId: actor.id });
    this.events.emit('activity', { userId: actor.id, action: 'card_topup.reject', entityType: 'user', entityId: row.userId, meta: { code: row.code } });
    return this.prisma.cardTopup.findUniqueOrThrow({ where: { id } });
  }
}

