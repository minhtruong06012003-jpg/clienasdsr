/**
 * Mẫu email mặc định (vi + en). Nội dung `html` là PHẦN THÂN; khi gửi được bọc trong mẫu bố cục `layout`
 * (logo, tên site, màu thương hiệu, footer liên hệ). Mẫu nào tự chứa `<html`/`<body` thì không bọc.
 * Cú pháp: xem template-engine.ts ({{a.b}}, {{{html}}}, {{#each}}, {{#if}}, {{money x}}, {{date x}}).
 */

export type EmailTemplateGroup = 'order' | 'account' | 'other';

export interface EmailTemplateVar {
  name: string;
  label: string;
}

export interface EmailTemplateDef {
  key: string;
  name: string;
  description: string;
  group: EmailTemplateGroup;
  /** người nhận chính */
  audience: 'customer' | 'admin';
  vars: EmailTemplateVar[];
  locales: Record<string, { subject: string; html: string }>;
}

export const LAYOUT_KEY = 'layout';

export const EMAIL_TEMPLATE_GROUPS: Record<EmailTemplateGroup, string> = {
  order: 'Đơn hàng',
  account: 'Tài khoản',
  other: 'Khác',
};

// ---------------------------------------------------------------------------
// Biến dùng chung
// ---------------------------------------------------------------------------

export const SITE_VARS: EmailTemplateVar[] = [
  { name: 'site.name', label: 'Tên website' },
  { name: 'site.url', label: 'URL website' },
  { name: 'site.logoUrl', label: 'URL logo' },
  { name: 'site.primaryColor', label: 'Màu thương hiệu' },
  { name: 'site.email', label: 'Email liên hệ' },
  { name: 'site.phone', label: 'Số điện thoại' },
  { name: 'site.address', label: 'Địa chỉ' },
  { name: 'site.companyName', label: 'Tên công ty' },
  { name: 'adminUrl', label: 'URL trang quản trị' },
  { name: 'webUrl', label: 'URL storefront' },
  { name: 'year', label: 'Năm hiện tại' },
];

export const ORDER_VARS: EmailTemplateVar[] = [
  { name: 'order.code', label: 'Mã đơn' },
  { name: 'order.statusLabel', label: 'Trạng thái đơn' },
  { name: 'order.paymentStatusLabel', label: 'Trạng thái thanh toán' },
  { name: 'order.paymentMethodLabel', label: 'Phương thức thanh toán' },
  { name: 'order.shippingMethod', label: 'Phương thức vận chuyển' },
  { name: 'order.customerName', label: 'Tên khách' },
  { name: 'order.customerEmail', label: 'Email khách' },
  { name: 'order.customerPhone', label: 'SĐT khách' },
  { name: 'order.items', label: 'Danh sách sản phẩm (each: this.name, this.sku, this.quantity, this.price, this.total, this.optionsText, this.image)' },
  { name: 'order.itemCount', label: 'Tổng số lượng' },
  { name: 'order.subtotal', label: 'Tạm tính' },
  { name: 'order.discountTotal', label: 'Giảm giá' },
  { name: 'order.shippingTotal', label: 'Phí vận chuyển' },
  { name: 'order.taxTotal', label: 'Thuế' },
  { name: 'order.total', label: 'Tổng cộng' },
  { name: 'order.couponCode', label: 'Mã giảm giá' },
  { name: 'order.note', label: 'Ghi chú của khách' },
  { name: 'order.shippingAddress', label: 'Địa chỉ giao hàng (1 dòng)' },
  { name: 'order.createdAt', label: 'Ngày đặt (dùng {{date order.createdAt}})' },
  { name: 'order.trackingUrl', label: 'Link theo dõi đơn' },
  { name: 'order.payUrl', label: 'Link thanh toán (nếu đơn online chưa trả)' },
  { name: 'order.adminUrl', label: 'Link đơn trong trang quản trị' },
];

const USER_VARS: EmailTemplateVar[] = [
  { name: 'user.name', label: 'Tên người dùng' },
  { name: 'user.email', label: 'Email người dùng' },
];

// ---------------------------------------------------------------------------
// Mảnh HTML dùng lại
// ---------------------------------------------------------------------------

const L = (locale: string, vi: string, en: string) => (locale === 'en' ? en : vi);

/** Nút bấm (bảng để tương thích Outlook) */
const button = (text: string, urlVar: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td align="center" bgcolor="{{site.primaryColor}}" style="border-radius:8px;background:{{site.primaryColor}}"><a href="{{${urlVar}}}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${text}</a></td></tr></table>`;

const h1 = (text: string) => `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827">${text}</h1>`;
const p = (text: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">${text}</p>`;
const muted = (text: string) => `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#6b7280">${text}</p>`;
const box = (inner: string) => `<div style="margin:20px 0;padding:16px 18px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;font-size:14px;line-height:1.6;color:#374151">${inner}</div>`;

/** Bảng sản phẩm + tổng tiền của đơn */
const orderTable = (locale: string) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;border-collapse:collapse;font-size:14px">
  <thead>
    <tr style="background:#f3f4f6">
      <th align="left" style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">${L(locale, 'Sản phẩm', 'Product')}</th>
      <th align="center" style="padding:10px 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">${L(locale, 'SL', 'Qty')}</th>
      <th align="right" style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">${L(locale, 'Thành tiền', 'Total')}</th>
    </tr>
  </thead>
  <tbody>
    {{#each order.items}}
    <tr>
      <td style="padding:12px;border-bottom:1px solid #e5e7eb;color:#111827">
        {{#if this.image}}<img src="{{this.image}}" width="48" height="48" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:10px;border:1px solid #e5e7eb">{{/if}}
        <span style="vertical-align:middle"><strong>{{this.name}}</strong>{{#if this.optionsText}}<br><span style="font-size:12px;color:#6b7280">{{this.optionsText}}</span>{{/if}}{{#if this.sku}}<br><span style="font-size:12px;color:#9ca3af">SKU: {{this.sku}}</span>{{/if}}</span>
      </td>
      <td align="center" style="padding:12px 8px;border-bottom:1px solid #e5e7eb;color:#374151">{{this.quantity}}</td>
      <td align="right" style="padding:12px;border-bottom:1px solid #e5e7eb;color:#111827;white-space:nowrap">{{money this.total}}</td>
    </tr>
    {{/each}}
  </tbody>
  <tfoot>
    <tr><td colspan="2" align="right" style="padding:8px 12px 4px;color:#6b7280">${L(locale, 'Tạm tính', 'Subtotal')}</td><td align="right" style="padding:8px 12px 4px;color:#374151;white-space:nowrap">{{money order.subtotal}}</td></tr>
    {{#if order.discountTotal}}<tr><td colspan="2" align="right" style="padding:4px 12px;color:#6b7280">${L(locale, 'Giảm giá', 'Discount')}{{#if order.couponCode}} ({{order.couponCode}}){{/if}}</td><td align="right" style="padding:4px 12px;color:#059669;white-space:nowrap">-{{money order.discountTotal}}</td></tr>{{/if}}
    <tr><td colspan="2" align="right" style="padding:4px 12px;color:#6b7280">${L(locale, 'Phí vận chuyển', 'Shipping')}</td><td align="right" style="padding:4px 12px;color:#374151;white-space:nowrap">{{money order.shippingTotal}}</td></tr>
    {{#if order.taxTotal}}<tr><td colspan="2" align="right" style="padding:4px 12px;color:#6b7280">${L(locale, 'Thuế', 'Tax')}</td><td align="right" style="padding:4px 12px;color:#374151;white-space:nowrap">{{money order.taxTotal}}</td></tr>{{/if}}
    <tr><td colspan="2" align="right" style="padding:10px 12px;border-top:2px solid #e5e7eb;font-size:16px;font-weight:700;color:#111827">${L(locale, 'Tổng cộng', 'Total')}</td><td align="right" style="padding:10px 12px;border-top:2px solid #e5e7eb;font-size:16px;font-weight:700;color:{{site.primaryColor}};white-space:nowrap">{{money order.total}}</td></tr>
  </tfoot>
</table>`;

/** Thông tin giao hàng + thanh toán */
const orderInfo = (locale: string) =>
  box(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px">
  <tr><td valign="top" width="50%" style="padding:0 8px 8px 0"><strong style="display:block;font-size:12px;text-transform:uppercase;color:#6b7280;margin-bottom:4px">${L(locale, 'Giao tới', 'Ship to')}</strong>{{#each order.shippingAddressLines}}{{this}}<br>{{/each}}</td>
  <td valign="top" width="50%" style="padding:0 0 8px 8px"><strong style="display:block;font-size:12px;text-transform:uppercase;color:#6b7280;margin-bottom:4px">${L(locale, 'Thanh toán', 'Payment')}</strong>{{order.paymentMethodLabel}}<br><span style="color:#6b7280">{{order.paymentStatusLabel}}</span>{{#if order.shippingMethod}}<br><strong style="display:block;font-size:12px;text-transform:uppercase;color:#6b7280;margin:10px 0 4px">${L(locale, 'Vận chuyển', 'Shipping')}</strong>{{order.shippingMethod}}{{/if}}</td></tr>
  {{#if order.note}}<tr><td colspan="2" style="padding-top:8px;border-top:1px dashed #e5e7eb"><strong style="font-size:12px;text-transform:uppercase;color:#6b7280">${L(locale, 'Ghi chú', 'Note')}:</strong> {{order.note}}</td></tr>{{/if}}
</table>`,
  );

const orderMeta = (locale: string) => muted(`${L(locale, 'Mã đơn', 'Order')} <strong>#{{order.code}}</strong> · {{date order.createdAt}} · {{order.statusLabel}}`);

const adminOrderButton = (locale: string) => button(L(locale, 'Xem đơn trong trang quản trị', 'Open order in admin'), 'order.adminUrl');
const trackButton = (locale: string) => `{{#if order.trackingUrl}}${button(L(locale, 'Theo dõi đơn hàng', 'Track your order'), 'order.trackingUrl')}{{/if}}`;

/** Thân email đơn hàng gửi khách: mở đầu + bảng + thông tin + nút */
const customerOrderBody = (locale: string, title: string, intro: string, extra = '') =>
  `${h1(title)}${p(intro)}${orderMeta(locale)}${extra}${orderTable(locale)}${orderInfo(locale)}{{#if order.payUrl}}${button(L(locale, 'Thanh toán ngay', 'Pay now'), 'order.payUrl')}{{/if}}${trackButton(locale)}${muted(L(locale, 'Cần hỗ trợ? Liên hệ {{site.email}} hoặc {{site.phone}}.', 'Need help? Contact {{site.email}} or {{site.phone}}.'))}`;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const LAYOUT_HTML = `<!DOCTYPE html>
<html lang="{{locale}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>{{subject}}</title>
<style>
  body{margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%}
  img{border:0;outline:none;text-decoration:none}
  a{color:{{site.primaryColor}}}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .content{padding:24px 18px!important}
    .header{padding:20px 18px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{{subject}}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" class="container" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <tr>
        <td class="header" align="center" style="padding:28px 32px;background:{{site.primaryColor}}">
          <a href="{{site.url}}" style="text-decoration:none;color:#ffffff">
            {{#if site.logoUrl}}<img src="{{site.logoUrl}}" alt="{{site.name}}" height="44" style="height:44px;max-width:220px;object-fit:contain">{{else}}<span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.02em">{{site.name}}</span>{{/if}}
          </a>
        </td>
      </tr>
      <tr>
        <td class="content" style="padding:32px">
          {{{body}}}
        </td>
      </tr>
      <tr>
        <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;text-align:center">
          <strong style="color:#374151">{{#if site.companyName}}{{site.companyName}}{{else}}{{site.name}}{{/if}}</strong><br>
          {{#if site.address}}{{site.address}}<br>{{/if}}
          {{#if site.phone}}{{site.phone}} · {{/if}}{{#if site.email}}<a href="mailto:{{site.email}}" style="color:#6b7280">{{site.email}}</a>{{/if}}<br>
          <a href="{{site.url}}" style="color:#6b7280">{{site.url}}</a><br>
          <span style="color:#9ca3af">© {{year}} {{site.name}}</span>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Danh sách mẫu
// ---------------------------------------------------------------------------

const ORDER_STATUS_VARS = [...ORDER_VARS, ...SITE_VARS];

/**
 * Thân email giao mã / đổi mã (kho mã số): mỗi sản phẩm một khối, liệt kê từng mã (theo phần có nhãn) + hướng dẫn sử dụng.
 * showCodes = false -> không có nội dung mã, chỉ nút xem mã trên website.
 */
const digitalCodesBody = (locale: string, replaced: boolean) => {
  const title = replaced ? L(locale, 'Mã thay thế của bạn', 'Your replacement code') : L(locale, 'Mã sản phẩm của bạn đã sẵn sàng', 'Your codes are ready');
  const intro = replaced
    ? L(locale, 'Xin chào <strong>{{order.customerName}}</strong>, cửa hàng đã đổi mã mới cho đơn <strong>#{{order.code}}</strong>.{{#if reason}} Lý do: {{reason}}.{{/if}}', 'Hi <strong>{{order.customerName}}</strong>, we have issued a new code for order <strong>#{{order.code}}</strong>.{{#if reason}} Reason: {{reason}}.{{/if}}')
    : L(locale, 'Xin chào <strong>{{order.customerName}}</strong>, cảm ơn bạn đã mua hàng. Dưới đây là mã / tài khoản của đơn <strong>#{{order.code}}</strong>.', 'Hi <strong>{{order.customerName}}</strong>, thank you for your purchase. Here are the codes / accounts for order <strong>#{{order.code}}</strong>.');
  const codeBlock = `{{#each this.codes}}<div style="margin:8px 0;padding:10px 12px;background:#ffffff;border:1px dashed #d1d5db;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:14px;color:#111827;word-break:break-all">{{#each this.parts}}{{#if this.label}}<span style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280">{{this.label}}:</span> {{/if}}<strong>{{this.value}}</strong><br>{{/each}}</div>{{/each}}`;
  const items = `{{#each items}}${box(
    `<strong style="font-size:15px;color:#111827">{{this.productName}}</strong>{{#if this.variantLabel}}<br><span style="font-size:12px;color:#6b7280">{{this.variantLabel}}</span>{{/if}}{{#if showCodes}}${codeBlock}{{/if}}{{#if this.deliveryNote}}<div style="margin-top:8px;font-size:13px;color:#374151;white-space:pre-line"><strong>${L(locale, 'Hướng dẫn sử dụng', 'How to use')}:</strong><br>{{this.deliveryNote}}</div>{{/if}}`,
  )}{{/each}}`;
  return `${h1(title)}${p(intro)}${orderMeta(locale)}{{#unless showCodes}}${p(L(locale, 'Vì lý do bảo mật, mã không được gửi trong email. Bấm nút bên dưới để xem mã trên website.', 'For security, codes are not included in this email. Use the button below to view them on our website.'))}{{/unless}}${items}{{#if viewUrl}}${button(L(locale, 'Xem mã trên website', 'View codes online'), 'viewUrl')}{{/if}}${muted(L(locale, 'Vui lòng không chia sẻ mã cho người khác. Mã lỗi? Báo lỗi ngay tại trang đơn hàng trong thời gian bảo hành, hoặc liên hệ {{site.email}} / {{site.phone}}.', 'Please keep your codes private. Code not working? Report it on the order page within the warranty period, or contact {{site.email}} / {{site.phone}}.'))}`;
};

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: LAYOUT_KEY,
    name: 'Bố cục chung',
    description: 'Khung bọc mọi email: logo, màu thương hiệu, footer liên hệ. Phần thân của từng mẫu được chèn tại {{{body}}}.',
    group: 'other',
    audience: 'customer',
    vars: [{ name: 'body', label: 'Thân email (dùng {{{body}}})' }, { name: 'subject', label: 'Tiêu đề email' }, { name: 'locale', label: 'Ngôn ngữ' }, ...SITE_VARS],
    locales: {
      vi: { subject: '{{subject}}', html: LAYOUT_HTML },
      en: { subject: '{{subject}}', html: LAYOUT_HTML },
    },
  },

  // ---------------- Đơn hàng ----------------
  {
    key: 'order.placed',
    name: 'Xác nhận đặt hàng',
    description: 'Gửi khách ngay sau khi đặt hàng thành công: danh sách sản phẩm, tổng tiền, địa chỉ, phương thức thanh toán, link theo dõi.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: {
        subject: '[{{site.name}}] Đã nhận đơn hàng #{{order.code}}',
        html: customerOrderBody(
          'vi',
          'Cảm ơn bạn đã đặt hàng!',
          'Xin chào <strong>{{order.customerName}}</strong>, chúng tôi đã nhận được đơn hàng của bạn và sẽ xử lý trong thời gian sớm nhất. Thông tin chi tiết bên dưới.',
          `{{#if order.payUrl}}${box('<strong>Đơn hàng chưa được thanh toán.</strong> Vui lòng hoàn tất thanh toán để chúng tôi xử lý đơn.')}{{/if}}`,
        ),
      },
      en: {
        subject: '[{{site.name}}] Order #{{order.code}} received',
        html: customerOrderBody(
          'en',
          'Thank you for your order!',
          'Hi <strong>{{order.customerName}}</strong>, we have received your order and will process it shortly. Details are below.',
          `{{#if order.payUrl}}${box('<strong>This order is not paid yet.</strong> Please complete the payment so we can process it.')}{{/if}}`,
        ),
      },
    },
  },
  {
    key: 'order.admin_new',
    name: 'Đơn hàng mới (admin)',
    description: 'Thông báo cho quản trị viên khi có đơn hàng mới.',
    group: 'order',
    audience: 'admin',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: {
        subject: '[Đơn mới] #{{order.code}} – {{order.customerName}} – {{money order.total}}',
        html: `${h1('Có đơn hàng mới #{{order.code}}')}${p('Khách <strong>{{order.customerName}}</strong> ({{order.customerPhone}}{{#if order.customerEmail}}, {{order.customerEmail}}{{/if}}) vừa đặt {{order.itemCount}} sản phẩm, tổng <strong>{{money order.total}}</strong>.')}${orderMeta('vi')}${orderTable('vi')}${orderInfo('vi')}${adminOrderButton('vi')}`,
      },
      en: {
        subject: '[New order] #{{order.code}} – {{order.customerName}} – {{money order.total}}',
        html: `${h1('New order #{{order.code}}')}${p('<strong>{{order.customerName}}</strong> ({{order.customerPhone}}{{#if order.customerEmail}}, {{order.customerEmail}}{{/if}}) just placed an order of {{order.itemCount}} item(s), total <strong>{{money order.total}}</strong>.')}${orderMeta('en')}${orderTable('en')}${orderInfo('en')}${adminOrderButton('en')}`,
      },
    },
  },
  {
    key: 'order.confirmed',
    name: 'Đơn hàng đã xác nhận',
    description: 'Gửi khách khi đơn chuyển sang trạng thái Đã xác nhận / Đang xử lý.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: { subject: '[{{site.name}}] Đơn hàng #{{order.code}} đã được xác nhận', html: customerOrderBody('vi', 'Đơn hàng đã được xác nhận', 'Xin chào <strong>{{order.customerName}}</strong>, đơn hàng <strong>#{{order.code}}</strong> của bạn đã được xác nhận và đang được chuẩn bị.') },
      en: { subject: '[{{site.name}}] Order #{{order.code}} confirmed', html: customerOrderBody('en', 'Your order is confirmed', 'Hi <strong>{{order.customerName}}</strong>, your order <strong>#{{order.code}}</strong> has been confirmed and is being prepared.') },
    },
  },
  {
    key: 'order.paid',
    name: 'Đã nhận thanh toán',
    description: 'Gửi khách khi thanh toán online được ghi nhận.',
    group: 'order',
    audience: 'customer',
    vars: [...ORDER_STATUS_VARS, { name: 'payment.amount', label: 'Số tiền đã trả' }, { name: 'payment.provider', label: 'Cổng thanh toán' }, { name: 'payment.reference', label: 'Mã giao dịch' }],
    locales: {
      vi: { subject: '[{{site.name}}] Đã nhận thanh toán đơn #{{order.code}}', html: customerOrderBody('vi', 'Thanh toán thành công', 'Xin chào <strong>{{order.customerName}}</strong>, chúng tôi đã nhận được thanh toán <strong>{{money payment.amount}}</strong>{{#if payment.provider}} qua {{payment.provider}}{{/if}}{{#if payment.reference}} (mã GD {{payment.reference}}){{/if}} cho đơn hàng <strong>#{{order.code}}</strong>. Đơn hàng đang được xử lý.') },
      en: { subject: '[{{site.name}}] Payment received for order #{{order.code}}', html: customerOrderBody('en', 'Payment received', 'Hi <strong>{{order.customerName}}</strong>, we have received your payment of <strong>{{money payment.amount}}</strong>{{#if payment.provider}} via {{payment.provider}}{{/if}}{{#if payment.reference}} (ref {{payment.reference}}){{/if}} for order <strong>#{{order.code}}</strong>. Your order is now being processed.') },
    },
  },
  {
    key: 'order.shipping',
    name: 'Đơn hàng đang giao',
    description: 'Gửi khách khi đơn chuyển sang Đang giao hàng.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: { subject: '[{{site.name}}] Đơn hàng #{{order.code}} đang được giao', html: customerOrderBody('vi', 'Đơn hàng đang trên đường đến bạn', 'Xin chào <strong>{{order.customerName}}</strong>, đơn hàng <strong>#{{order.code}}</strong> đã được bàn giao cho đơn vị vận chuyển{{#if order.shippingMethod}} ({{order.shippingMethod}}){{/if}}. Vui lòng giữ máy để nhận hàng.') },
      en: { subject: '[{{site.name}}] Order #{{order.code}} is on its way', html: customerOrderBody('en', 'Your order is on its way', 'Hi <strong>{{order.customerName}}</strong>, order <strong>#{{order.code}}</strong> has been handed to the carrier{{#if order.shippingMethod}} ({{order.shippingMethod}}){{/if}}. Please keep your phone reachable.') },
    },
  },
  {
    key: 'order.completed',
    name: 'Đơn hàng hoàn thành',
    description: 'Gửi khách khi đơn hoàn thành.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: { subject: '[{{site.name}}] Đơn hàng #{{order.code}} đã hoàn thành', html: customerOrderBody('vi', 'Đơn hàng đã hoàn thành', 'Xin chào <strong>{{order.customerName}}</strong>, đơn hàng <strong>#{{order.code}}</strong> đã giao thành công. Cảm ơn bạn đã tin tưởng {{site.name}} — rất mong nhận được đánh giá của bạn về sản phẩm!') },
      en: { subject: '[{{site.name}}] Order #{{order.code}} completed', html: customerOrderBody('en', 'Order completed', 'Hi <strong>{{order.customerName}}</strong>, order <strong>#{{order.code}}</strong> has been delivered. Thank you for shopping with {{site.name}} — we would love to hear your review!') },
    },
  },
  {
    key: 'order.cancelled',
    name: 'Đơn hàng đã huỷ',
    description: 'Gửi khách khi đơn bị huỷ.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: { subject: '[{{site.name}}] Đơn hàng #{{order.code}} đã bị huỷ', html: `${h1('Đơn hàng đã bị huỷ')}${p('Xin chào <strong>{{order.customerName}}</strong>, đơn hàng <strong>#{{order.code}}</strong> đã bị huỷ. Nếu bạn đã thanh toán, chúng tôi sẽ liên hệ để hoàn tiền trong thời gian sớm nhất.')}${orderMeta('vi')}${orderTable('vi')}${muted('Nếu đây là nhầm lẫn, vui lòng liên hệ {{site.email}} hoặc {{site.phone}}.')}` },
      en: { subject: '[{{site.name}}] Order #{{order.code}} cancelled', html: `${h1('Order cancelled')}${p('Hi <strong>{{order.customerName}}</strong>, order <strong>#{{order.code}}</strong> has been cancelled. If you have already paid, we will contact you about the refund shortly.')}${orderMeta('en')}${orderTable('en')}${muted('If this is a mistake, please contact {{site.email}} or {{site.phone}}.')}` },
    },
  },
  {
    key: 'order.refunded',
    name: 'Đơn hàng đã hoàn tiền',
    description: 'Gửi khách khi đơn được hoàn tiền.',
    group: 'order',
    audience: 'customer',
    vars: ORDER_STATUS_VARS,
    locales: {
      vi: { subject: '[{{site.name}}] Đơn hàng #{{order.code}} đã được hoàn tiền', html: `${h1('Đã hoàn tiền')}${p('Xin chào <strong>{{order.customerName}}</strong>, đơn hàng <strong>#{{order.code}}</strong> đã được hoàn tiền{{#if order.refundedTotal}} với số tiền <strong>{{money order.refundedTotal}}</strong>{{/if}}. Tuỳ ngân hàng, tiền có thể mất vài ngày làm việc để về tài khoản.')}${orderMeta('vi')}${orderTable('vi')}${muted('Cần hỗ trợ? Liên hệ {{site.email}} hoặc {{site.phone}}.')}` },
      en: { subject: '[{{site.name}}] Order #{{order.code}} refunded', html: `${h1('Refund issued')}${p('Hi <strong>{{order.customerName}}</strong>, order <strong>#{{order.code}}</strong> has been refunded{{#if order.refundedTotal}} for <strong>{{money order.refundedTotal}}</strong>{{/if}}. Depending on your bank it may take a few business days to appear.')}${orderMeta('en')}${orderTable('en')}${muted('Need help? Contact {{site.email}} or {{site.phone}}.')}` },
    },
  },
  {
    key: 'order.payment_needs_refund',
    name: 'Cần hoàn tiền (admin)',
    description: 'Báo quản trị viên khi nhận thanh toán bất thường (trả thừa, trả cho đơn đã huỷ...) cần hoàn tiền thủ công.',
    group: 'order',
    audience: 'admin',
    vars: [...ORDER_STATUS_VARS, { name: 'refund.reason', label: 'Lý do' }, { name: 'refund.amount', label: 'Số tiền' }, { name: 'refund.provider', label: 'Cổng thanh toán' }, { name: 'refund.reference', label: 'Mã giao dịch' }],
    locales: {
      vi: { subject: '[Cần hoàn tiền] Đơn #{{order.code}} – {{money refund.amount}}', html: `${h1('Cần hoàn tiền cho khách')}${box('<strong>{{refund.reason}}</strong><br>Số tiền: <strong>{{money refund.amount}}</strong> qua {{upper refund.provider}}{{#if refund.reference}} (mã GD {{refund.reference}}){{/if}}')}${orderMeta('vi')}${orderTable('vi')}${orderInfo('vi')}${adminOrderButton('vi')}` },
      en: { subject: '[Refund needed] Order #{{order.code}} – {{money refund.amount}}', html: `${h1('Refund required')}${box('<strong>{{refund.reason}}</strong><br>Amount: <strong>{{money refund.amount}}</strong> via {{upper refund.provider}}{{#if refund.reference}} (ref {{refund.reference}}){{/if}}')}${orderMeta('en')}${orderTable('en')}${orderInfo('en')}${adminOrderButton('en')}` },
    },
  },
  {
    key: 'order.invoice',
    name: 'Gửi thông tin đơn hàng / hoá đơn',
    description: 'Quản trị viên gửi lại chi tiết đơn hàng cho khách theo yêu cầu.',
    group: 'order',
    audience: 'customer',
    vars: [...ORDER_STATUS_VARS, { name: 'message', label: 'Lời nhắn thêm của admin (tuỳ chọn)' }],
    locales: {
      vi: { subject: '[{{site.name}}] Thông tin đơn hàng #{{order.code}}', html: customerOrderBody('vi', 'Thông tin đơn hàng #{{order.code}}', 'Xin chào <strong>{{order.customerName}}</strong>, theo yêu cầu, chúng tôi gửi bạn chi tiết đơn hàng bên dưới.', `{{#if message}}${box('{{{message}}}')}{{/if}}`) },
      en: { subject: '[{{site.name}}] Order #{{order.code}} details', html: customerOrderBody('en', 'Order #{{order.code}} details', 'Hi <strong>{{order.customerName}}</strong>, as requested, here are the details of your order.', `{{#if message}}${box('{{{message}}}')}{{/if}}`) },
    },
  },
  {
    key: 'einvoice.issued',
    name: 'Hoá đơn điện tử đã phát hành',
    description: 'Gửi khách link tra cứu / file PDF hoá đơn điện tử sau khi phát hành thành công.',
    group: 'order',
    audience: 'customer',
    vars: [
      ...ORDER_STATUS_VARS,
      { name: 'invoice.invoiceNo', label: 'Số hoá đơn' },
      { name: 'invoice.serial', label: 'Ký hiệu' },
      { name: 'invoice.templateCode', label: 'Mẫu số' },
      { name: 'invoice.taxAuthorityCode', label: 'Mã cơ quan thuế' },
      { name: 'invoice.lookupCode', label: 'Mã tra cứu' },
      { name: 'invoice.lookupUrl', label: 'Link tra cứu' },
      { name: 'invoice.total', label: 'Tổng tiền trên hoá đơn' },
      { name: 'invoice.issuedAt', label: 'Ngày phát hành' },
      { name: 'invoice.buyerName', label: 'Tên người mua / đơn vị' },
      { name: 'invoice.buyerTaxCode', label: 'MST người mua' },
      { name: 'invoice.providerName', label: 'Nhà cung cấp HĐĐT' },
    ],
    locales: {
      vi: {
        subject: '[{{site.name}}] Hoá đơn điện tử {{invoice.serial}} - {{invoice.invoiceNo}} cho đơn #{{order.code}}',
        html: `${h1('Hoá đơn điện tử của bạn')}${p('Xin chào <strong>{{order.customerName}}</strong>, hoá đơn điện tử cho đơn hàng <strong>#{{order.code}}</strong> đã được phát hành. Thông tin hoá đơn:')}${box(
          '<strong>Số hoá đơn:</strong> {{invoice.invoiceNo}}<br/><strong>Ký hiệu:</strong> {{invoice.serial}} · <strong>Mẫu số:</strong> {{invoice.templateCode}}<br/>{{#if invoice.taxAuthorityCode}}<strong>Mã CQT:</strong> {{invoice.taxAuthorityCode}}<br/>{{/if}}<strong>Ngày phát hành:</strong> {{date invoice.issuedAt}}<br/><strong>Người mua:</strong> {{invoice.buyerName}}{{#if invoice.buyerTaxCode}} · MST {{invoice.buyerTaxCode}}{{/if}}<br/><strong>Tổng tiền:</strong> {{money invoice.total}}{{#if invoice.lookupCode}}<br/><strong>Mã tra cứu:</strong> {{invoice.lookupCode}}{{/if}}',
        )}{{#if invoice.lookupUrl}}${button('Tra cứu hoá đơn', 'invoice.lookupUrl')}{{/if}}${muted('File PDF hoá đơn (nếu có) được đính kèm email này. Cần hỗ trợ? Liên hệ {{site.email}} hoặc {{site.phone}}.')}`,
      },
      en: {
        subject: '[{{site.name}}] E-invoice {{invoice.serial}} - {{invoice.invoiceNo}} for order #{{order.code}}',
        html: `${h1('Your e-invoice')}${p('Hi <strong>{{order.customerName}}</strong>, the electronic invoice for order <strong>#{{order.code}}</strong> has been issued:')}${box(
          '<strong>Invoice no.:</strong> {{invoice.invoiceNo}}<br/><strong>Serial:</strong> {{invoice.serial}} · <strong>Form:</strong> {{invoice.templateCode}}<br/>{{#if invoice.taxAuthorityCode}}<strong>Tax authority code:</strong> {{invoice.taxAuthorityCode}}<br/>{{/if}}<strong>Issued at:</strong> {{date invoice.issuedAt}}<br/><strong>Buyer:</strong> {{invoice.buyerName}}{{#if invoice.buyerTaxCode}} · Tax ID {{invoice.buyerTaxCode}}{{/if}}<br/><strong>Total:</strong> {{money invoice.total}}{{#if invoice.lookupCode}}<br/><strong>Lookup code:</strong> {{invoice.lookupCode}}{{/if}}',
        )}{{#if invoice.lookupUrl}}${button('Look up invoice', 'invoice.lookupUrl')}{{/if}}${muted('The invoice PDF (if available) is attached. Need help? Contact {{site.email}} or {{site.phone}}.')}`,
      },
    },
  },
  {
    key: 'download.ready',
    name: 'Sản phẩm số sẵn sàng tải',
    description: 'Gửi khách link tải sản phẩm số sau khi thanh toán.',
    group: 'order',
    audience: 'customer',
    vars: [...ORDER_STATUS_VARS, { name: 'downloads', label: 'Danh sách file (each: this.name, this.url, this.expiresAt, this.limit)' }],
    locales: {
      vi: {
        subject: '[{{site.name}}] Link tải sản phẩm cho đơn #{{order.code}}',
        html: `${h1('Sản phẩm của bạn đã sẵn sàng')}${p('Xin chào <strong>{{order.customerName}}</strong>, cảm ơn bạn đã mua hàng. Bạn có thể tải sản phẩm số của đơn <strong>#{{order.code}}</strong> qua các liên kết bên dưới.')}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;font-size:14px">{{#each downloads}}<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb"><strong>{{this.name}}</strong>{{#if this.expiresAt}}<br><span style="font-size:12px;color:#6b7280">Hết hạn: {{date this.expiresAt}}</span>{{/if}}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #e5e7eb"><a href="{{this.url}}" style="display:inline-block;padding:8px 16px;background:{{site.primaryColor}};color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Tải xuống</a></td></tr>{{/each}}</table>${muted('Vui lòng không chia sẻ liên kết tải cho người khác. Liên kết có thể có giới hạn số lần tải hoặc thời hạn.')}${trackButton('vi')}`,
      },
      en: {
        subject: '[{{site.name}}] Your downloads for order #{{order.code}}',
        html: `${h1('Your files are ready')}${p('Hi <strong>{{order.customerName}}</strong>, thank you for your purchase. You can download the digital products of order <strong>#{{order.code}}</strong> using the links below.')}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;font-size:14px">{{#each downloads}}<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb"><strong>{{this.name}}</strong>{{#if this.expiresAt}}<br><span style="font-size:12px;color:#6b7280">Expires: {{date this.expiresAt}}</span>{{/if}}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #e5e7eb"><a href="{{this.url}}" style="display:inline-block;padding:8px 16px;background:{{site.primaryColor}};color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Download</a></td></tr>{{/each}}</table>${muted('Please do not share download links. Links may be limited by download count or expiry date.')}${trackButton('en')}`,
      },
    },
  },

  // ---------------- Kho mã số (modules/digital-codes) ----------------
  {
    key: 'digital.delivered',
    name: 'Giao mã / tài khoản',
    description: 'Gửi khách mã (key, tài khoản, thẻ...) sau khi đơn thanh toán, khi giao bù / giao tay, hoặc admin gửi lại. Tắt "Gửi mã trong email" (Cài đặt › Kho mã) thì email chỉ có link xem mã.',
    group: 'order',
    audience: 'customer',
    vars: [
      ...ORDER_STATUS_VARS,
      { name: 'items', label: 'Sản phẩm (each: this.productName, this.variantLabel, this.deliveryNote, this.codes — each code: this.content, this.parts[label,value])' },
      { name: 'showCodes', label: 'Có hiện nội dung mã trong email không' },
      { name: 'viewUrl', label: 'Link xem mã trên website' },
      { name: 'count', label: 'Số mã trong email' },
    ],
    locales: Object.fromEntries((['vi', 'en'] as const).map((locale) => [locale, { subject: L(locale, '[{{site.name}}] Mã sản phẩm của đơn #{{order.code}}', '[{{site.name}}] Your codes for order #{{order.code}}'), html: digitalCodesBody(locale, false) }])),
  },
  {
    key: 'digital.replaced',
    name: 'Đổi mã bảo hành',
    description: 'Gửi khách mã mới khi admin đổi mã lỗi (bảo hành).',
    group: 'order',
    audience: 'customer',
    vars: [
      ...ORDER_STATUS_VARS,
      { name: 'items', label: 'Mã mới (each: this.productName, this.variantLabel, this.deliveryNote, this.codes — each code: this.content, this.parts[label,value])' },
      { name: 'reason', label: 'Lý do đổi mã' },
      { name: 'showCodes', label: 'Có hiện nội dung mã trong email không' },
      { name: 'viewUrl', label: 'Link xem mã trên website' },
    ],
    locales: Object.fromEntries((['vi', 'en'] as const).map((locale) => [locale, { subject: L(locale, '[{{site.name}}] Mã thay thế cho đơn #{{order.code}}', '[{{site.name}}] Replacement code for order #{{order.code}}'), html: digitalCodesBody(locale, true) }])),
  },

  // ---------------- Giỏ hàng bỏ dở (modules/carts) ----------------
  {
    key: 'cart.abandoned',
    name: 'Nhắc giỏ hàng bỏ dở',
    description: 'Gửi khách đã để lại email nhưng chưa đặt hàng (tự động theo Cài đặt › Bán hàng › Nhắc giỏ bỏ dở, hoặc gửi thủ công ở Đơn hàng › Giỏ hàng bỏ dở). Có link khôi phục giỏ.',
    group: 'order',
    audience: 'customer',
    vars: [
      { name: 'cart.customerName', label: 'Tên khách (nếu có tài khoản)' },
      { name: 'cart.email', label: 'Email khách' },
      { name: 'cart.items', label: 'Sản phẩm trong giỏ (each: this.name, this.quantity, this.price, this.total, this.optionsText, this.image, this.url)' },
      { name: 'cart.itemCount', label: 'Tổng số lượng' },
      { name: 'cart.subtotal', label: 'Tạm tính (dùng {{money cart.subtotal}})' },
      { name: 'cart.recoverUrl', label: 'Link khôi phục giỏ hàng' },
      { name: 'reminderNumber', label: 'Lần nhắc (1, 2...)' },
      ...SITE_VARS,
    ],
    locales: Object.fromEntries(
      (['vi', 'en'] as const).map((locale) => [
        locale,
        {
          subject: L(locale, '[{{site.name}}] Bạn còn {{cart.itemCount}} sản phẩm trong giỏ hàng', '[{{site.name}}] You left {{cart.itemCount}} item(s) in your cart'),
          html: `${h1(L(locale, 'Bạn quên gì đó trong giỏ hàng?', 'Did you forget something?'))}${p(
            L(
              locale,
              'Xin chào{{#if cart.customerName}} <strong>{{cart.customerName}}</strong>{{/if}}, các sản phẩm bạn chọn vẫn đang chờ trong giỏ hàng. Hoàn tất đơn hàng trước khi hết hàng nhé!',
              'Hi{{#if cart.customerName}} <strong>{{cart.customerName}}</strong>{{/if}}, the items you picked are still waiting in your cart. Complete your order before they sell out!',
            ),
          )}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;border-collapse:collapse;font-size:14px">
  <tbody>
    {{#each cart.items}}
    <tr>
      <td style="padding:12px;border-bottom:1px solid #e5e7eb;color:#111827">
        {{#if this.image}}<img src="{{this.image}}" width="56" height="56" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:10px;border:1px solid #e5e7eb">{{/if}}
        <span style="vertical-align:middle"><a href="{{this.url}}" style="color:#111827;text-decoration:none"><strong>{{this.name}}</strong></a>{{#if this.optionsText}}<br><span style="font-size:12px;color:#6b7280">{{this.optionsText}}</span>{{/if}}<br><span style="font-size:12px;color:#6b7280">${L(locale, 'SL', 'Qty')}: {{this.quantity}} × {{money this.price}}</span></span>
      </td>
      <td align="right" style="padding:12px;border-bottom:1px solid #e5e7eb;color:#111827;white-space:nowrap">{{money this.total}}</td>
    </tr>
    {{/each}}
  </tbody>
  <tfoot>
    <tr><td align="right" style="padding:10px 12px;font-size:16px;font-weight:700;color:#111827">${L(locale, 'Tạm tính', 'Subtotal')}</td><td align="right" style="padding:10px 12px;font-size:16px;font-weight:700;color:{{site.primaryColor}};white-space:nowrap">{{money cart.subtotal}}</td></tr>
  </tfoot>
</table>${button(L(locale, 'Quay lại giỏ hàng', 'Return to your cart'), 'cart.recoverUrl')}${muted(
            L(
              locale,
              'Giá và tình trạng còn hàng có thể thay đổi. Nếu bạn đã đặt hàng, vui lòng bỏ qua email này. Cần hỗ trợ? Liên hệ {{site.email}} hoặc {{site.phone}}.',
              'Prices and availability may change. If you have already ordered, please ignore this email. Need help? Contact {{site.email}} or {{site.phone}}.',
            ),
          )}`,
        },
      ]),
    ),
  },

  // ---------------- Tài khoản ----------------
  {
    key: 'auth.verify_email',
    name: 'Xác minh email',
    description: 'Gửi link kích hoạt tài khoản khi đăng ký (nếu bật yêu cầu xác minh email).',
    group: 'account',
    audience: 'customer',
    vars: [...USER_VARS, { name: 'link', label: 'Link xác minh' }, { name: 'expiresIn', label: 'Thời hạn link (vd. 24 giờ)' }, ...SITE_VARS],
    locales: {
      vi: { subject: '[{{site.name}}] Xác minh địa chỉ email của bạn', html: `${h1('Xác minh địa chỉ email')}${p('Xin chào <strong>{{user.name}}</strong>, cảm ơn bạn đã đăng ký tài khoản tại {{site.name}}. Nhấn nút bên dưới để kích hoạt tài khoản.')}${button('Kích hoạt tài khoản', 'link')}${muted('Liên kết có hiệu lực trong {{expiresIn}}. Nếu nút không hoạt động, sao chép địa chỉ sau vào trình duyệt:<br><a href="{{link}}" style="word-break:break-all">{{link}}</a>')}${muted('Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.')}` },
      en: { subject: '[{{site.name}}] Verify your email address', html: `${h1('Verify your email')}${p('Hi <strong>{{user.name}}</strong>, thanks for signing up at {{site.name}}. Click the button below to activate your account.')}${button('Activate account', 'link')}${muted('This link is valid for {{expiresIn}}. If the button does not work, copy this address into your browser:<br><a href="{{link}}" style="word-break:break-all">{{link}}</a>')}${muted('If you did not create an account, you can safely ignore this email.')}` },
    },
  },
  {
    key: 'auth.reset_password',
    name: 'Đặt lại mật khẩu',
    description: 'Gửi link đặt lại mật khẩu khi người dùng quên mật khẩu.',
    group: 'account',
    audience: 'customer',
    vars: [...USER_VARS, { name: 'link', label: 'Link đặt lại mật khẩu' }, { name: 'expiresIn', label: 'Thời hạn link (vd. 60 phút)' }, ...SITE_VARS],
    locales: {
      vi: { subject: '[{{site.name}}] Đặt lại mật khẩu', html: `${h1('Đặt lại mật khẩu')}${p('Xin chào <strong>{{user.name}}</strong>, chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản {{user.email}}. Nhấn nút bên dưới để tạo mật khẩu mới.')}${button('Đặt lại mật khẩu', 'link')}${muted('Liên kết có hiệu lực trong {{expiresIn}}. Nếu nút không hoạt động, sao chép địa chỉ sau vào trình duyệt:<br><a href="{{link}}" style="word-break:break-all">{{link}}</a>')}${muted('Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này — mật khẩu của bạn vẫn an toàn.')}` },
      en: { subject: '[{{site.name}}] Reset your password', html: `${h1('Reset your password')}${p('Hi <strong>{{user.name}}</strong>, we received a request to reset the password for {{user.email}}. Click the button below to choose a new password.')}${button('Reset password', 'link')}${muted('This link is valid for {{expiresIn}}. If the button does not work, copy this address into your browser:<br><a href="{{link}}" style="word-break:break-all">{{link}}</a>')}${muted('If you did not request a password reset, you can ignore this email — your password stays the same.')}` },
    },
  },
  {
    key: 'auth.new_login',
    name: 'Cảnh báo đăng nhập từ thiết bị mới',
    description: 'Gửi khi tài khoản đăng nhập từ trình duyệt / thiết bị chưa từng dùng (Cài đặt › Bảo mật › Cảnh báo).',
    group: 'account',
    audience: 'customer',
    vars: [
      ...USER_VARS,
      { name: 'login.time', label: 'Thời điểm đăng nhập' },
      { name: 'login.ip', label: 'Địa chỉ IP' },
      { name: 'login.browser', label: 'Trình duyệt' },
      { name: 'login.os', label: 'Hệ điều hành' },
      { name: 'login.area', label: 'Nơi đăng nhập (Website / Trang quản trị)' },
      { name: 'sessionsUrl', label: 'Link quản lý phiên đăng nhập' },
      ...SITE_VARS,
    ],
    locales: {
      vi: { subject: '[{{site.name}}] Đăng nhập mới từ {{login.browser}} trên {{login.os}}', html: `${h1('Đăng nhập từ thiết bị mới')}${p('Xin chào <strong>{{user.name}}</strong>, tài khoản {{user.email}} vừa được đăng nhập từ một thiết bị chưa từng dùng:')}${p('<strong>Thời điểm:</strong> {{login.time}}<br><strong>Thiết bị:</strong> {{login.browser}} trên {{login.os}}<br><strong>Địa chỉ IP:</strong> {{login.ip}}<br><strong>Nơi đăng nhập:</strong> {{login.area}}')}${p('Nếu đó là bạn, không cần làm gì thêm. Nếu <strong>không phải bạn</strong>, hãy đổi mật khẩu ngay và đăng xuất các thiết bị lạ.')}{{#if sessionsUrl}}${button('Xem các phiên đăng nhập', 'sessionsUrl')}{{/if}}${muted('Email tự động để bảo vệ tài khoản của bạn.')}` },
      en: { subject: '[{{site.name}}] New sign-in from {{login.browser}} on {{login.os}}', html: `${h1('New device sign-in')}${p('Hi <strong>{{user.name}}</strong>, your account {{user.email}} was just signed in from a device it has not used before:')}${p('<strong>Time:</strong> {{login.time}}<br><strong>Device:</strong> {{login.browser}} on {{login.os}}<br><strong>IP address:</strong> {{login.ip}}<br><strong>Signed in to:</strong> {{login.area}}')}${p('If this was you, there is nothing to do. If it <strong>was not you</strong>, change your password right away and sign out unknown devices.')}{{#if sessionsUrl}}${button('Review sign-in sessions', 'sessionsUrl')}{{/if}}${muted('This is an automatic email to protect your account.')}` },
    },
  },
  {
    key: 'auth.welcome',
    name: 'Chào mừng thành viên mới',
    description: 'Gửi sau khi đăng ký thành công (hoặc sau khi xác minh email).',
    group: 'account',
    audience: 'customer',
    vars: [...USER_VARS, { name: 'accountUrl', label: 'Link trang tài khoản' }, ...SITE_VARS],
    locales: {
      vi: { subject: 'Chào mừng bạn đến với {{site.name}}!', html: `${h1('Chào mừng {{user.name}}!')}${p('Tài khoản của bạn tại {{site.name}} đã sẵn sàng. Bạn có thể theo dõi đơn hàng, lưu địa chỉ giao hàng và nhận ưu đãi dành riêng cho thành viên.')}{{#if accountUrl}}${button('Vào trang tài khoản', 'accountUrl')}{{/if}}${muted('Cần hỗ trợ? Liên hệ {{site.email}} hoặc {{site.phone}}.')}` },
      en: { subject: 'Welcome to {{site.name}}!', html: `${h1('Welcome, {{user.name}}!')}${p('Your account at {{site.name}} is ready. You can track orders, save shipping addresses and receive member-only offers.')}{{#if accountUrl}}${button('Go to my account', 'accountUrl')}{{/if}}${muted('Need help? Contact {{site.email}} or {{site.phone}}.')}` },
    },
  },

  // ---------------- Khác ----------------
  {
    key: 'comment.admin_notify',
    name: 'Bình luận mới (admin)',
    description: 'Báo quản trị viên khi có bình luận mới trên bài viết.',
    group: 'other',
    audience: 'admin',
    vars: [{ name: 'comment.authorName', label: 'Tên người bình luận' }, { name: 'comment.authorEmail', label: 'Email người bình luận' }, { name: 'comment.content', label: 'Nội dung' }, { name: 'comment.postTitle', label: 'Tiêu đề bài viết' }, { name: 'comment.pending', label: 'Đang chờ duyệt (true/false)' }, { name: 'comment.adminUrl', label: 'Link duyệt trong quản trị' }, ...SITE_VARS],
    locales: {
      vi: { subject: '[Bình luận mới] {{comment.postTitle}}', html: `${h1('Bình luận mới')}${p('<strong>{{comment.authorName}}</strong>{{#if comment.authorEmail}} ({{comment.authorEmail}}){{/if}} vừa bình luận bài viết <strong>{{comment.postTitle}}</strong>{{#if comment.pending}} — <span style="color:#d97706">đang chờ duyệt</span>{{/if}}:')}<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid {{site.primaryColor}};background:#f9fafb;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#374151;white-space:pre-line">{{comment.content}}</blockquote>{{#if comment.adminUrl}}${button('Xem / duyệt bình luận', 'comment.adminUrl')}{{/if}}` },
      en: { subject: '[New comment] {{comment.postTitle}}', html: `${h1('New comment')}${p('<strong>{{comment.authorName}}</strong>{{#if comment.authorEmail}} ({{comment.authorEmail}}){{/if}} commented on <strong>{{comment.postTitle}}</strong>{{#if comment.pending}} — <span style="color:#d97706">awaiting approval</span>{{/if}}:')}<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid {{site.primaryColor}};background:#f9fafb;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#374151;white-space:pre-line">{{comment.content}}</blockquote>{{#if comment.adminUrl}}${button('Review comment', 'comment.adminUrl')}{{/if}}` },
    },
  },
  {
    key: 'review.admin_notify',
    name: 'Đánh giá sản phẩm mới (admin)',
    description: 'Báo quản trị viên khi có đánh giá sản phẩm mới.',
    group: 'other',
    audience: 'admin',
    vars: [{ name: 'review.authorName', label: 'Tên người đánh giá' }, { name: 'review.rating', label: 'Số sao' }, { name: 'review.title', label: 'Tiêu đề đánh giá' }, { name: 'review.content', label: 'Nội dung' }, { name: 'review.productName', label: 'Tên sản phẩm' }, { name: 'review.pending', label: 'Đang chờ duyệt (true/false)' }, { name: 'review.adminUrl', label: 'Link duyệt trong quản trị' }, ...SITE_VARS],
    locales: {
      vi: { subject: '[Đánh giá mới] {{review.rating}}★ – {{review.productName}}', html: `${h1('Đánh giá sản phẩm mới')}${p('<strong>{{review.authorName}}</strong> vừa đánh giá <strong>{{review.rating}}/5 sao</strong> cho sản phẩm <strong>{{review.productName}}</strong>{{#if review.pending}} — <span style="color:#d97706">đang chờ duyệt</span>{{/if}}.')}<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid {{site.primaryColor}};background:#f9fafb;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#374151;white-space:pre-line">{{#if review.title}}<strong>{{review.title}}</strong><br>{{/if}}{{review.content}}</blockquote>{{#if review.adminUrl}}${button('Xem / duyệt đánh giá', 'review.adminUrl')}{{/if}}` },
      en: { subject: '[New review] {{review.rating}}★ – {{review.productName}}', html: `${h1('New product review')}${p('<strong>{{review.authorName}}</strong> rated <strong>{{review.productName}}</strong> <strong>{{review.rating}}/5</strong>{{#if review.pending}} — <span style="color:#d97706">awaiting approval</span>{{/if}}.')}<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid {{site.primaryColor}};background:#f9fafb;border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:#374151;white-space:pre-line">{{#if review.title}}<strong>{{review.title}}</strong><br>{{/if}}{{review.content}}</blockquote>{{#if review.adminUrl}}${button('Review it', 'review.adminUrl')}{{/if}}` },
    },
  },
];

export const EMAIL_TEMPLATE_MAP: Record<string, EmailTemplateDef> = Object.fromEntries(EMAIL_TEMPLATES.map((t) => [t.key, t]));

/** Mẫu mặc định theo locale (fallback: vi → bản đầu tiên) */
export function defaultTemplate(key: string, locale: string): { subject: string; html: string } | null {
  const def = EMAIL_TEMPLATE_MAP[key];
  if (!def) return null;
  return def.locales[locale] ?? def.locales.vi ?? Object.values(def.locales)[0] ?? null;
}
