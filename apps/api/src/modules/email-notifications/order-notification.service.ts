import { Injectable, OnModuleInit } from '@nestjs/common';
import { HooksService } from '../hooks/hooks.service.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Trạng thái đơn -> key mẫu email gửi khách */
const STATUS_TEMPLATE: Record<string, string> = {
  CONFIRMED: 'order.confirmed',
  PROCESSING: 'order.confirmed',
  SHIPPING: 'order.shipping',
  COMPLETED: 'order.completed',
  CANCELLED: 'order.cancelled',
  REFUNDED: 'order.refunded',
};

/** Nhóm cài đặt `orderNotification` (Cài đặt › Thông báo email) */
interface Settings {
  enabled?: boolean;
  adminEmails?: string;
  sendCustomerEmail?: boolean;
  notifyStatusChange?: boolean;
}

/**
 * Email thông báo đơn hàng: báo cửa hàng khi có đơn mới / đã thanh toán / cần hoàn tiền,
 * gửi khách email xác nhận và cập nhật trạng thái. Nội dung email chỉnh tại Cài đặt › Mẫu email.
 * Nghe hook `order.*` do lõi phát (priority 10, chạy trước webhooks).
 */
@Injectable()
export class OrderNotificationService implements OnModuleInit {
  constructor(
    private readonly hooks: HooksService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
  ) {}

  /** Cấu hình hiện tại; null khi module đang tắt */
  private async config() {
    const s = await this.settings.get<Settings>('orderNotification');
    return s.enabled === false ? null : s;
  }

  /** Email nhận thông báo: cấu hình riêng của module, nếu trống dùng Cài đặt › Bán hàng */
  private async adminEmails(fromModule?: string) {
    const commerce = await this.settings.get<{ orderNotifyEmails?: string[] }>('commerce');
    return (fromModule?.trim() ? fromModule.split(',') : (commerce.orderNotifyEmails ?? [])).map((e) => e.trim()).filter(Boolean);
  }

  onModuleInit() {
    const customerLocale = (order: { locale?: string | null }) => order.locale ?? undefined;
    const meta = (order: { id: string; code: string }) => ({ orderId: order.id, orderCode: order.code });
    const source = 'order-notification';

    // đơn mới: báo cửa hàng + email xác nhận cho khách
    this.hooks.addAction(
      'order.created',
      async (order: any) => {
        const s = await this.config();
        if (!s) return;
        const admins = await this.adminEmails(s.adminEmails);
        if (admins.length) {
          await this.mail.sendTemplate({ key: 'order.admin_new', to: admins, replyTo: order.customerEmail ?? undefined, vars: { order: await this.mail.orderVars(order) }, meta: meta(order) });
        }
        if (s.sendCustomerEmail !== false && order.customerEmail) {
          await this.mail.sendTemplate({ key: 'order.placed', locale: customerLocale(order), to: order.customerEmail, vars: { order: await this.mail.orderVars(order, customerLocale(order)) }, meta: meta(order) });
        }
      },
      10,
      source,
    );

    // đã thanh toán: admin dùng lại mẫu "đơn mới" nhưng tiêu đề nêu rõ đã thanh toán; khách nhận mẫu order.paid
    this.hooks.addAction(
      'order.paid',
      async (order: any, tx: any) => {
        const s = await this.config();
        if (!s) return;
        const payment = { amount: Number(tx?.amount ?? order.total), provider: String(tx?.provider ?? '').toUpperCase(), reference: tx?.reference ?? '' };
        const admins = await this.adminEmails(s.adminEmails);
        if (admins.length) {
          const vars = { order: await this.mail.orderVars(order), payment };
          await this.mail.sendTemplate({ key: 'order.admin_new', to: admins, vars, meta: { ...meta(order), event: 'paid' }, template: { subject: `[Đã thanh toán] Đơn #${order.code} – {{money payment.amount}} qua {{payment.provider}}` } });
        }
        if (s.sendCustomerEmail !== false && order.customerEmail) {
          await this.mail.sendTemplate({ key: 'order.paid', locale: customerLocale(order), to: order.customerEmail, vars: { order: await this.mail.orderVars(order, customerLocale(order)), payment }, meta: meta(order) });
        }
      },
      10,
      source,
    );

    // tiền vào cho đơn đã huỷ / trả thừa... -> báo admin hoàn tiền thủ công
    this.hooks.addAction(
      'order.paymentNeedsRefund',
      async (order: any, tx: any, reason: string) => {
        const s = await this.config();
        if (!s) return;
        const admins = await this.adminEmails(s.adminEmails);
        if (!admins.length) return;
        await this.mail.sendTemplate({
          key: 'order.payment_needs_refund',
          to: admins,
          vars: { order: await this.mail.orderVars(order), refund: { reason, amount: Number(tx?.amount ?? 0), provider: String(tx?.provider ?? ''), reference: tx?.reference ?? '' } },
          meta: { ...meta(order), transactionId: tx?.id },
        });
      },
      10,
      source,
    );

    // đổi trạng thái đơn -> email cập nhật cho khách
    this.hooks.addAction(
      'order.statusChanged',
      async (order: any, from?: string) => {
        const s = await this.config();
        if (!s || s.notifyStatusChange === false || !order.customerEmail) return;
        const key = STATUS_TEMPLATE[order.status];
        if (!key) return;
        // PROCESSING sau CONFIRMED dùng chung mẫu "đã xác nhận" -> không gửi lặp
        if (order.status === 'PROCESSING' && from === 'CONFIRMED') return;
        await this.mail.sendTemplate({ key, locale: customerLocale(order), to: order.customerEmail, vars: { order: await this.mail.orderVars(order, customerLocale(order)) }, meta: { ...meta(order), from } });
      },
      10,
      source,
    );
  }
}
