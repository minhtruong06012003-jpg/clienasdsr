import type { PaymentProvider } from '../payments/payment-provider.interface.js';
import { alnum, hmacSha256, postJson, safeEqual, type GatewayDeps } from './payment-utils.js';

/**
 * Cổng PayOS (payos.vn): tạo link/QR VietQR theo từng đơn, xác nhận tự động qua webhook có chữ ký.
 * Cấu hình: Cài đặt › Cổng thanh toán › PayOS (nhóm cài đặt `payos`). Webhook: /api/payments/webhook/payos
 */

/** Mã BIN (NAPAS) -> tên viết tắt ngân hàng phổ biến */
const BANK_BY_BIN: Record<string, string> = {
  '970436': 'Vietcombank', '970415': 'VietinBank', '970418': 'BIDV', '970405': 'Agribank', '970422': 'MBBank', '970407': 'Techcombank',
  '970416': 'ACB', '970432': 'VPBank', '970423': 'TPBank', '970403': 'Sacombank', '970437': 'HDBank', '970441': 'VIB', '970443': 'SHB',
  '970448': 'OCB', '970426': 'MSB', '970431': 'Eximbank', '970440': 'SeABank', '970449': 'LPBank', '970454': 'VietCapitalBank',
  '970429': 'SCB', '970425': 'ABBANK', '970452': 'KienLongBank', '970428': 'NamABank', '970412': 'PVcomBank', '970409': 'BacABank',
  '970400': 'SaigonBank', '970419': 'NCB', '970406': 'DongABank', '970427': 'VietABank', '970433': 'VietBank', '970438': 'BaoVietBank',
  '970430': 'PGBank', '970414': 'OceanBank', '970439': 'PublicBank', '970434': 'IndovinaBank', '970457': 'Woori', '970424': 'ShinhanBank',
  '963388': 'Timo', '971005': 'ViettelMoney', '971011': 'VNPTMoney', '546034': 'CAKE', '546035': 'Ubank',
};
const BASE = 'https://api-merchant.payos.vn';

interface Settings {
  enabled?: boolean;
  clientId?: string;
  apiKey?: string;
  checksumKey?: string;
  descriptionLength?: number;
  showQr?: boolean;
}

interface PayOSResponse<T> {
  code: string;
  desc: string;
  data: T | null;
  signature?: string;
}

/**
 * Chữ ký dữ liệu PayOS (webhook + response): sắp xếp key, null/undefined -> "", mảng -> JSON đã sort key,
 * ghép key=value bằng &, HMAC-SHA256 hex với checksumKey. (Theo SDK chính thức @payos/node)
 */
export function payosDataSignature(data: Record<string, unknown>, checksumKey: string) {
  const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const str = Object.keys(data)
    .sort()
    .filter((k) => data[k] !== undefined)
    .map((k) => {
      let v = data[k];
      if (Array.isArray(v)) v = JSON.stringify(v.map((x) => (x && typeof x === 'object' ? sortObj(x as Record<string, unknown>) : x)));
      if (v === null || v === undefined || v === 'null' || v === 'undefined') v = '';
      return `${k}=${v}`;
    })
    .join('&');
  return hmacSha256(checksumKey, str);
}

/** Chữ ký khi tạo link: đúng 5 field theo thứ tự alphabet */
export function payosCreateSignature(p: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }, checksumKey: string) {
  return hmacSha256(checksumKey, `amount=${p.amount}&cancelUrl=${p.cancelUrl}&description=${p.description}&orderCode=${p.orderCode}&returnUrl=${p.returnUrl}`);
}

export function payosProvider({ settings, prisma }: GatewayDeps): PaymentProvider {
  const cfg = () => settings.get<Settings>('payos');
  const auth = (s: Settings) => ({ 'x-client-id': s.clientId!, 'x-api-key': s.apiKey! });

  return {
    key: 'payos',
    // ẩn: website chỉ dùng Web2M — không hiện cho khách / trang Cài đặt, vẫn nhận webhook giao dịch cũ
    hidden: true,
    label: { vi: 'Thanh toán QR / chuyển khoản (PayOS)', en: 'QR / bank transfer (PayOS)' },
    description: { vi: 'Quét mã VietQR bằng app ngân hàng, xác nhận tự động trong vài giây.', en: 'Scan VietQR with your banking app, confirmed automatically.' },

    async isEnabled() {
      return (await cfg()).enabled === true;
    },

    async isConfigured() {
      const s = await cfg();
      return !!(s.clientId && s.apiKey && s.checksumKey);
    },

    async createPayment({ order, transaction, amount, returnUrl, cancelUrl }) {
      const s = await cfg();
      const orderCode = Number(transaction.providerOrderCode);
      // tài khoản ngân hàng không liên kết qua payOS chỉ nhận mô tả tối đa 9 ký tự
      const description = alnum(order.code).slice(-Math.min(Math.max(Number(s.descriptionLength) || 25, 6), 25));
      const expiredAt = transaction.expiresAt ? Math.floor(transaction.expiresAt.getTime() / 1000) : undefined;
      const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, select: { name: true, quantity: true, price: true } });
      const body = {
        orderCode,
        amount,
        description,
        cancelUrl,
        returnUrl,
        expiredAt,
        buyerName: order.customerName,
        buyerPhone: order.customerPhone || undefined,
        buyerEmail: order.customerEmail ?? undefined,
        // nạp ví qua cổng không có dòng hàng (đơn ảo) -> gửi một dòng "nạp tiền" bằng đúng số tiền
        items: items.length
          ? items.map((i) => ({ name: i.name.slice(0, 200), quantity: i.quantity, price: Math.round(Number(i.price)) }))
          : [{ name: `Nap tien ${description}`.slice(0, 200), quantity: 1, price: amount }],
        signature: payosCreateSignature({ amount, cancelUrl, description, orderCode, returnUrl }, s.checksumKey!),
      };
      const res = await postJson<PayOSResponse<{ checkoutUrl: string; qrCode: string; paymentLinkId: string; bin: string; accountNumber: string; accountName: string; description: string }>>(
        `${BASE}/v2/payment-requests`,
        body,
        auth(s),
      );
      if (res.code !== '00' || !res.data) throw new Error(`PayOS: ${res.code} ${res.desc}`);
      const d = res.data;
      const qrImageUrl =
        s.showQr !== false
          ? `https://img.vietqr.io/image/${d.bin}-${d.accountNumber}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(d.description)}&accountName=${encodeURIComponent(d.accountName)}`
          : undefined;
      return {
        checkoutUrl: d.checkoutUrl,
        qrData: d.qrCode,
        qrImageUrl,
        bank: { bankName: BANK_BY_BIN[d.bin] ?? d.bin, accountNumber: d.accountNumber, accountName: d.accountName },
        transferContent: d.description,
        reference: d.paymentLinkId,
        raw: { paymentLinkId: d.paymentLinkId },
      };
    },

    async handleWebhook({ body }) {
      const s = await cfg();
      const payload = body as { code?: string; success?: boolean; data?: Record<string, unknown>; signature?: string };
      if (!payload?.data || !payload.signature || !s.checksumKey) return { valid: false, success: false, note: 'Thiếu dữ liệu / chữ ký', statusCode: 400, response: { success: false } };
      const valid = safeEqual(payosDataSignature(payload.data, s.checksumKey), payload.signature);
      if (!valid) return { valid: false, success: false, note: 'Sai chữ ký PayOS', statusCode: 400, response: { success: false } };
      const d = payload.data;
      const success = payload.code === '00' && (d.code === undefined || d.code === '00');
      // luôn trả 2xx cho chữ ký hợp lệ (kể cả webhook kiểm tra khi khai báo URL)
      return {
        valid: true,
        success,
        providerOrderCode: String(d.orderCode),
        amount: Number(d.amount),
        reference: String(d.reference ?? d.paymentLinkId ?? ''),
        txnId: d.reference ? String(d.reference) : `${d.paymentLinkId ?? ''}:${d.orderCode}`,
        statusCode: 200,
        response: { success: true },
      };
    },

    async fetchStatus(tx) {
      const s = await cfg();
      const res = await postJson<PayOSResponse<{ status: string; amountPaid: number; amount: number }>>(`${BASE}/v2/payment-requests/${tx.providerOrderCode}`, null, auth(s), 'GET');
      const status = res.data?.status;
      if (status === 'PAID' && Number(res.data?.amountPaid) >= Number(tx.amount)) return 'PAID';
      if (status === 'CANCELLED') return 'CANCELLED';
      if (status === 'EXPIRED') return 'EXPIRED';
      if (status === 'FAILED') return 'FAILED';
      return 'PENDING';
    },

    async cancel(tx) {
      const s = await cfg();
      await postJson(`${BASE}/v2/payment-requests/${tx.providerOrderCode}/cancel`, { cancellationReason: 'Hết hạn hoặc tạo giao dịch mới' }, auth(s));
    },
  };
}
