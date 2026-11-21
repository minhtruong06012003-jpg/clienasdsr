import { Module } from '@nestjs/common';
import { OrderNotificationService } from './order-notification.service.js';

/**
 * Email tự động theo sự kiện: thông báo đơn hàng (orderNotification).
 * Cấu hình ở Cài đặt › Thông báo email; nội dung email ở Cài đặt › Mẫu email.
 * HooksService, MailService, SettingsService đều từ module Global.
 */
@Module({ providers: [OrderNotificationService] })
export class EmailNotificationsModule {}
