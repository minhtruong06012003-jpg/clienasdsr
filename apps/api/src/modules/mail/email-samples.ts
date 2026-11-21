/**
 * Dữ liệu mẫu để xem trước / gửi thử mẫu email (không đụng DB).
 */
import { buildOrderVars } from './order-vars.js';

const SAMPLE_ORDER = {
  id: '00000000-0000-0000-0000-000000000001',
  code: 'DH240001',
  status: 'CONFIRMED',
  paymentStatus: 'UNPAID',
  paymentMethod: 'cod',
  shippingMethod: 'Giao hàng tiêu chuẩn',
  currency: 'VND',
  subtotal: 1_290_000,
  discountTotal: 100_000,
  shippingTotal: 30_000,
  taxTotal: 0,
  total: 1_220_000,
  refundedTotal: 0,
  couponCode: 'GIAM100K',
  customerName: 'Nguyễn Văn An',
  customerEmail: 'an.nguyen@example.com',
  customerPhone: '0901 234 567',
  shippingAddress: { fullName: 'Nguyễn Văn An', phone: '0901 234 567', line1: '12 Nguyễn Huệ', ward: 'Phường Bến Nghé', district: 'Quận 1', city: 'TP. Hồ Chí Minh', country: 'Việt Nam' },
  note: 'Giao giờ hành chính, gọi trước khi giao.',
  locale: 'vi',
  history: [{ status: 'PENDING', note: '', at: new Date(Date.now() - 3_600_000).toISOString(), by: 'system' }],
  paidAt: null,
  createdAt: new Date(),
  items: [
    { name: 'Áo thun cotton cao cấp', sku: 'AT-001-L', optionValues: { 'Màu': 'Trắng', 'Size': 'L' }, image: '', price: 250_000, quantity: 2, total: 500_000 },
    { name: 'Quần jeans slim fit', sku: 'QJ-010-32', optionValues: { 'Size': '32' }, image: '', price: 790_000, quantity: 1, total: 790_000 },
  ],
};

/**
 * Biến mẫu theo key mẫu email.
 * `opts.webUrl` là địa chỉ website ĐÃ kèm tiền tố ngôn ngữ của mẫu (vd. https://shop.vn/en) — mọi link mẫu ghép thẳng vào đó.
 */
export function sampleVars(key: string, locale: string, opts: { webUrl: string; adminUrl: string; paymentMethodLabels?: Record<string, string> }): Record<string, unknown> {
  const order = buildOrderVars(
    { ...SAMPLE_ORDER, paymentStatus: key === 'order.paid' || key === 'order.refunded' ? 'PAID' : SAMPLE_ORDER.paymentStatus, status: key === 'order.cancelled' ? 'CANCELLED' : key === 'order.refunded' ? 'REFUNDED' : key === 'order.shipping' ? 'SHIPPING' : key === 'order.completed' ? 'COMPLETED' : SAMPLE_ORDER.status, refundedTotal: key === 'order.refunded' ? SAMPLE_ORDER.total : 0 },
    { locale, webUrl: opts.webUrl, adminUrl: opts.adminUrl, paymentMethodLabels: { cod: locale === 'en' ? 'Cash on delivery' : 'Thanh toán khi nhận hàng (COD)', ...(opts.paymentMethodLabels ?? {}) }, isOnlinePayment: key === 'order.placed' },
  );
  const user = { name: 'Nguyễn Văn An', email: 'an.nguyen@example.com' };
  const base: Record<string, unknown> = { order, user };
  switch (key) {
    case 'order.paid':
      return { ...base, payment: { amount: order.total, provider: 'PayOS', reference: 'FT24091234567' } };
    case 'order.payment_needs_refund':
      return { ...base, refund: { reason: locale === 'en' ? 'Payment received for a cancelled order' : 'Nhận thanh toán cho đơn đã huỷ', amount: order.total, provider: 'payos', reference: 'FT24091234567' } };
    case 'order.invoice':
      return { ...base, message: locale === 'en' ? '<p>Here is the order information you requested.</p>' : '<p>Gửi bạn thông tin đơn hàng như đã trao đổi.</p>' };
    case 'download.ready':
      return { ...base, downloads: [{ name: 'Ebook-Huong-dan.pdf', url: `${opts.webUrl}/account#downloads`, expiresAt: new Date(Date.now() + 7 * 86_400_000), limit: 5 }, { name: 'Bo-template.zip', url: `${opts.webUrl}/account#downloads`, expiresAt: null, limit: null }] };
    // kho mã số: dữ liệu mẫu giống shape DigitalCodesService.sendCodesMail
    case 'digital.delivered':
    case 'digital.replaced': {
      const label = (vi: string, en: string) => (locale === 'en' ? en : vi);
      return {
        ...base,
        showCodes: true,
        viewUrl: `${opts.webUrl}/order-tracking?code=${encodeURIComponent(String(order.code ?? ''))}`,
        count: 1,
        reason: key === 'digital.replaced' ? label('Mã cũ báo lỗi đăng nhập', 'Previous code failed to log in') : undefined,
        items: [
          {
            productName: label('Tài khoản Netflix Premium', 'Netflix Premium account'),
            variantLabel: label('Gói: 1 tháng', 'Plan: 1 month'),
            deliveryNote: label('Đăng nhập tại netflix.com, không đổi mật khẩu.', 'Sign in at netflix.com, do not change the password.'),
            codes: [{ content: 'demo@example.com|Pass@123', parts: [{ label: 'Email', value: 'demo@example.com' }, { label: label('Mật khẩu', 'Password'), value: 'Pass@123' }] }],
          },
        ],
      };
    }
    case 'cart.abandoned':
      // giỏ hàng bỏ dở mẫu (giống shape CartsService.sendReminder)
      return {
        ...base,
        reminderNumber: 1,
        cart: {
          customerName: user.name,
          email: user.email,
          items: SAMPLE_ORDER.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total, image: '', optionsText: Object.values(i.optionValues).join(' / '), url: `${opts.webUrl}/products/sample` })),
          itemCount: SAMPLE_ORDER.items.reduce((n, i) => n + i.quantity, 0),
          subtotal: SAMPLE_ORDER.subtotal,
          recoverUrl: `${opts.webUrl}/cart?recover=SAMPLE_TOKEN`,
        },
      };
    case 'auth.verify_email':
      return { ...base, link: `${opts.webUrl}/verify-email?token=SAMPLE_TOKEN`, expiresIn: locale === 'en' ? '24 hours' : '24 giờ' };
    case 'auth.reset_password':
      return { ...base, link: `${opts.webUrl}/reset-password?token=SAMPLE_TOKEN`, expiresIn: locale === 'en' ? '60 minutes' : '60 phút' };
    case 'auth.new_login':
      return {
        ...base,
        login: { time: '04/10/2026 09:30', ip: '203.113.1.25', browser: 'Chrome', os: 'Windows', area: locale === 'en' ? 'Admin panel' : 'Trang quản trị' },
        sessionsUrl: `${opts.webUrl}/account`,
      };
    case 'auth.welcome':
      return { ...base, accountUrl: `${opts.webUrl}/account` };
    case 'comment.admin_notify':
      return { ...base, comment: { authorName: 'Trần Thị Bình', authorEmail: 'binh.tran@example.com', content: locale === 'en' ? 'Great article, thanks for sharing!' : 'Bài viết rất hữu ích, cảm ơn bạn đã chia sẻ!', postTitle: locale === 'en' ? '10 tips for choosing the right size' : '10 mẹo chọn size quần áo chuẩn', pending: true, adminUrl: `${opts.adminUrl}/posts/comments?status=PENDING` } };
    case 'review.admin_notify':
      return { ...base, review: { authorName: 'Trần Thị Bình', rating: 5, title: locale === 'en' ? 'Excellent quality' : 'Chất lượng tuyệt vời', content: locale === 'en' ? 'Fabric is soft and fits perfectly.' : 'Vải mềm, form chuẩn, giao hàng nhanh.', productName: 'Áo thun cotton cao cấp', pending: true, adminUrl: `${opts.adminUrl}/products/reviews?status=PENDING` } };
    case 'layout':
      return { ...base, subject: locale === 'en' ? 'Sample email subject' : 'Tiêu đề email mẫu', body: locale === 'en' ? '<h1 style="margin:0 0 16px;font-size:22px">Sample content</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#374151">The body of each email will be placed here.</p>' : '<h1 style="margin:0 0 16px;font-size:22px">Nội dung mẫu</h1><p style="margin:0;font-size:15px;line-height:1.6;color:#374151">Phần thân của từng email sẽ được chèn tại đây.</p>' };
    default:
      return base;
  }
}
