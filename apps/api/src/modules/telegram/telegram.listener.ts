import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AI_PROVIDERS } from '../ai/providers/index.js';
import { hideProviderText } from '../ai/ai-public-key.js';
import { isChildSite } from '../../common/utils/tenant.js';
import { esc } from './telegram.api.js';
import { TelegramService } from './telegram.service.js';

const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
const num = (n: number) => Math.round(n).toLocaleString('vi-VN');
const providerName = (key: string) => AI_PROVIDERS.find((p) => p.key === key)?.name ?? key;

/**
 * Lỗi nhà cung cấp kiểu "hết tiền / không đủ credit" (đọc trong lỗi hiện cho khách + phản hồi thô của nhà cung cấp).
 * Khớp thì báo admin ngay, không đợi tới lượt kiểm tra số dư định kỳ.
 */
const OUT_OF_FUNDS = /insufficient|not enough (credit|balance|coin|fund)|out of (credit|balance)|balance (is )?(too )?low|low balance|payment required|quota exceeded|exceeded your (current )?quota|hết (tiền|credit|xu|lượt)|không đủ (số dư|credit|xu|tiền)|số dư không đủ|nạp thêm|"(status|statusCode|code)":\s*402\b/i;

/** Ghép lỗi + phản hồi thô thành chuỗi để dò (cắt ngắn, phản hồi có thể rất dài) */
function errorText(error: string | null | undefined, raw: unknown) {
  let r = '';
  try {
    r = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  } catch {
    // phản hồi không chuyển được thành JSON -> bỏ qua
  }
  return `${error ?? ''} ${r}`.slice(0, 4000);
}

/**
 * Nghe sự kiện trong hệ thống rồi gửi Telegram:
 * - cho khách (bot khách): tác vụ AI xong / lỗi, nạp tiền vào ví, mua gói, hoa hồng & kết quả rút tiền tiếp thị liên kết;
 * - cho quản trị (bot admin): thành viên mới, nạp tiền, mua gói, yêu cầu rút hoa hồng, giao dịch cần hoàn tiền,
 *   tác vụ lỗi, nguồn API báo hết tiền, cảnh báo bảo mật.
 * Mọi handler chạy async và tự nuốt lỗi: Telegram lỗi không được làm hỏng luồng nghiệp vụ.
 */
@Injectable()
export class TelegramListener {
  private readonly logger = new Logger('TelegramListener');
  /** Lần báo "nguồn hết tiền" gần nhất theo nhà cung cấp — mỗi nguồn tối đa 1 tin / 30 phút */
  private readonly fundsAlertAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tg: TelegramService,
  ) {}

  /** Bọc handler: bắt lỗi + ghi log */
  private async safe(name: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Thông báo Telegram "${name}" lỗi: ${(err as Error).message}`);
    }
  }

  private async userLabel(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    return u ? `<b>${esc(u.name)}</b> (${esc(u.email)})` : esc(userId);
  }

  // ---------------- AI Studio ----------------

  @OnEvent('ai.task.succeeded', { async: true })
  onTaskSucceeded(e: { taskId: string; userId: string }) {
    return this.safe('ai.task.succeeded', async () => {
      const t = await this.prisma.aiTask.findUnique({ where: { id: e.taskId }, select: { code: true, credits: true, tool: { select: { name: true } } } });
      if (!t) return;
      const site = await this.tg.siteUrl();
      await this.tg.notifyUser(
        e.userId,
        'taskSucceeded',
        [`✅ <b>${esc(hideProviderText(t.tool.name))}</b> đã hoàn thành`, `Mã tác vụ: <code>${esc(t.code)}</code>${t.credits ? ` · ${vnd(t.credits)}` : ''}`, site ? `\n👉 <a href="${esc(`${site}/history/${t.code}`)}">Xem kết quả</a>` : ''].join('\n'),
      );
    });
  }

  @OnEvent('ai.task.failed', { async: true })
  onTaskFailed(e: { taskId: string; userId: string; error: string }) {
    return this.safe('ai.task.failed', async () => {
      const t = await this.prisma.aiTask.findUnique({ where: { id: e.taskId }, select: { code: true, status: true, provider: true, credits: true, refunded: true, providerData: true, tool: { select: { name: true } } } });
      if (!t) return;
      const raw = t.providerData as { cancelledBy?: string } | null;
      // khách tự huỷ thì không cần báo lại chính họ (admin huỷ thì có cancelledBy -> vẫn báo)
      const selfCancel = t.status === 'CANCELLED' && !raw?.cancelledBy;
      if (!selfCancel) {
        const site = await this.tg.siteUrl();
        await this.tg.notifyUser(
          e.userId,
          'taskFailed',
          [
            `${t.status === 'CANCELLED' ? '🚫' : '❌'} <b>${esc(hideProviderText(t.tool.name))}</b> ${t.status === 'CANCELLED' ? 'đã bị huỷ' : 'không thành công'}`,
            `Mã tác vụ: <code>${esc(t.code)}</code>`,
            // tin gửi khách: che tên nhà cung cấp trong câu lỗi (tin gửi admin bên dưới giữ nguyên để dễ xử lý)
            `Lý do: ${esc(hideProviderText(e.error))}`,
            t.refunded ? `💎 Đã hoàn ${vnd(t.credits)} vào số dư` : '',
            site ? `\n👉 <a href="${esc(`${site}/history/${t.code}`)}">Xem chi tiết</a>` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      if (t.status !== 'FAILED') return;
      if (isChildSite()) {
        await this.tg.notifyAdmin('taskFailed', [`❌ Tác vụ lỗi <code>${esc(t.code)}</code>`, esc(hideProviderText(t.tool.name)), `Khách: ${await this.userLabel(e.userId)}`, `Lỗi: ${esc(hideProviderText(e.error))}`].join('\n'));
        return;
      }
      // nguồn API báo hết tiền -> cảnh báo admin ngay (giới hạn 1 tin / 30 phút mỗi nguồn)
      const text = errorText(e.error, t.providerData);
      if (OUT_OF_FUNDS.test(text) && Date.now() - (this.fundsAlertAt.get(t.provider) ?? 0) > 30 * 60_000) {
        this.fundsAlertAt.set(t.provider, Date.now());
        await this.tg.notifyAdmin('providerError', [`🚨 <b>Nguồn ${esc(providerName(t.provider))} có thể đã hết tiền</b>`, `Tác vụ <code>${esc(t.code)}</code> (${esc(t.tool.name)}) lỗi: ${esc(e.error)}`, '', 'Kiểm tra và nạp thêm ở nhà cung cấp. Gõ /sources để xem số dư các nguồn.'].join('\n'));
        return;
      }
      await this.tg.notifyAdmin('taskFailed', [`❌ Tác vụ lỗi <code>${esc(t.code)}</code>`, `${esc(t.tool.name)} · nguồn ${esc(providerName(t.provider))}`, `Khách: ${await this.userLabel(e.userId)}`, `Lỗi: ${esc(e.error)}`].join('\n'));
    });
  }

  // ---------------- tiền & gói cước ----------------

  @OnEvent('wallet.topup_completed', { async: true })
  onTopup(e: { userId: string; amount: number; transactionId: string }) {
    return this.safe('wallet.topup_completed', async () => {
      const [tx, user] = await Promise.all([
        this.prisma.paymentTransaction.findUnique({ where: { id: e.transactionId }, select: { provider: true, rawRequest: true } }),
        this.prisma.user.findUnique({ where: { id: e.userId }, select: { walletBalance: true } }),
      ]);
      // tiền nạp qua trang thanh toán gói sẽ tự mua gói ngay -> khách chỉ cần tin "đã kích hoạt gói"
      const kind = (tx?.rawRequest as { checkout?: { kind?: string } } | null)?.checkout?.kind;
      const forPlan = kind === 'credit_plan' || kind === 'credit_topup';
      if (!forPlan) await this.tg.notifyUser(e.userId, 'topup', `💰 Đã nạp <b>${vnd(e.amount)}</b> vào ví.\nSố dư ví: <b>${vnd(Number(user?.walletBalance ?? 0))}</b>`);
      await this.tg.notifyAdmin('topup', [`💰 <b>Nạp tiền ${vnd(e.amount)}</b>${tx ? ` qua ${esc(tx.provider.toUpperCase())}` : ''}`, `Khách: ${await this.userLabel(e.userId)}`, forPlan ? 'Thanh toán gói cước' : ''].filter(Boolean).join('\n'));
    });
  }

  @OnEvent('credits.purchased', { async: true })
  onPlanPurchased(e: { userId: string; purchaseId: string; paid: number }) {
    return this.safe('credits.purchased', async () => {
      const p = await this.prisma.creditPurchase.findUnique({ where: { id: e.purchaseId }, select: { code: true, planName: true, credits: true, paid: true, cycle: true, user: { select: { walletBalance: true, planExpiresAt: true } } } });
      if (!p) return;
      // nạp tiền theo số tiền tự do (không gắn gói)
      if (p.cycle === 'topup') {
        await this.tg.notifyUser(e.userId, 'plan', [`🎉 Nạp thành công <b>${vnd(Number(p.paid))}</b>`, `+${vnd(p.credits)} · số dư ${vnd(Number(p.user.walletBalance))}`].join('\n'));
        await this.tg.notifyAdmin('plan', [`💰 <b>Nạp tiền</b> — ${vnd(Number(p.paid))}`, `Khách: ${await this.userLabel(e.userId)}`, `Mã mua: #${p.code} · nhận ${vnd(p.credits)}`].join('\n'));
        return;
      }
      const exp = p.user.planExpiresAt ? p.user.planExpiresAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : null;
      await this.tg.notifyUser(e.userId, 'plan', [`🎉 Đã kích hoạt gói <b>${esc(p.planName)}</b>`, `+${vnd(p.credits)} · số dư ${vnd(Number(p.user.walletBalance))}`, exp ? `Hạn gói: ${exp}` : ''].filter(Boolean).join('\n'));
      await this.tg.notifyAdmin('plan', [`🛒 <b>Mua gói ${esc(p.planName)}</b> — ${vnd(Number(p.paid))}`, `Khách: ${await this.userLabel(e.userId)}`, `Mã mua: #${p.code} · nhận ${vnd(p.credits)}`].join('\n'));
    });
  }

  // ---------------- tiếp thị liên kết ----------------

  @OnEvent('affiliate.commission', { async: true })
  onCommission(e: { userId: string; amount: number; percent: number; fromName: string; deposit: number }) {
    return this.safe('affiliate.commission', () => this.tg.notifyUser(e.userId, 'affiliate', `🎁 Bạn nhận <b>${vnd(e.amount)}</b> hoa hồng (${e.percent}%) từ ${esc(e.fromName)} nạp ${vnd(e.deposit)}.`));
  }

  /** Sự kiện `activity` chung: lọc các thao tác cần báo (rút hoa hồng, giao dịch cần hoàn tiền) */
  @OnEvent('activity', { async: true })
  onActivity(e: { userId?: string | null; action: string; entityId?: string | null; meta?: Record<string, unknown> }) {
    if (!['affiliate.payout_requested', 'affiliate.payout_approved', 'affiliate.payout_rejected', 'payment.needsRefund'].includes(e.action)) return;
    return this.safe(e.action, async () => {
      if (e.action === 'payment.needsRefund') {
        return this.tg.notifyAdmin('needsRefund', [`⚠️ <b>Giao dịch cần hoàn tiền</b>`, `Cổng ${esc(String(e.meta?.provider ?? '').toUpperCase())} · ${vnd(Number(e.meta?.amount ?? 0))}`, 'Tài khoản nạp tiền không còn tồn tại — kiểm tra ở Giao dịch thanh toán.'].join('\n'));
      }
      const p = e.entityId ? await this.prisma.affiliatePayout.findUnique({ where: { id: e.entityId }, select: { code: true, userId: true, amount: true, method: true, adminNote: true } }) : null;
      if (!p) return;
      const method = p.method === 'WALLET' ? 'về ví' : 'về ngân hàng';
      if (e.action === 'affiliate.payout_requested') {
        return this.tg.notifyAdmin('payout', [`💸 <b>Yêu cầu rút hoa hồng ${vnd(Number(p.amount))}</b> ${method}`, `Khách: ${await this.userLabel(p.userId)}`, `Mã yêu cầu: #${p.code} — duyệt ở AI Studio › Tiếp thị liên kết`].join('\n'));
      }
      const ok = e.action === 'affiliate.payout_approved';
      return this.tg.notifyUser(p.userId, 'affiliate', [ok ? `✅ Yêu cầu rút <b>${vnd(Number(p.amount))}</b> ${method} (#${p.code}) đã được duyệt.` : `❌ Yêu cầu rút <b>${vnd(Number(p.amount))}</b> (#${p.code}) bị từ chối, tiền đã trả lại ví hoa hồng.`, p.adminNote ? `Ghi chú: ${esc(p.adminNote)}` : ''].filter(Boolean).join('\n'));
    });
  }

  // ---------------- tài khoản & bảo mật ----------------

  @OnEvent('user.registered', { async: true })
  onRegistered(e: { user: { id: string; name?: string; email?: string }; ref?: string }) {
    return this.safe('user.registered', async () => {
      const total = await this.prisma.user.count({ where: { deletedAt: null } });
      await this.tg.notifyAdmin('newUser', [`👤 <b>Thành viên mới</b>: ${await this.userLabel(e.user.id)}`, e.ref ? `Mã giới thiệu: ${esc(e.ref)}` : '', `Tổng thành viên: ${num(total)}`].filter(Boolean).join('\n'));
    });
  }

  @OnEvent('security.alert', { async: true })
  onSecurity(e: { title: string; body?: string }) {
    return this.safe('security.alert', () => this.tg.notifyAdmin('security', `🛡 <b>${esc(e.title)}</b>${e.body ? `\n${esc(e.body)}` : ''}`));
  }
}
