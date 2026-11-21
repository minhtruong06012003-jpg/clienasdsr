import type { PaymentProvider } from '../payments/payment-provider.interface.js';
import { alnum, header, hmacSha256, safeEqual, type GatewayDeps } from './payment-utils.js';

/**
 * Cổng SePay: hiển thị VietQR vào tài khoản ngân hàng của shop, SePay báo biến động số dư qua webhook để tự xác nhận đơn.
 * Cấu hình: Cài đặt › Cổng thanh toán › SePay (nhóm cài đặt `sepay`). Webhook: /api/payments/webhook/sepay
 */

interface Settings {
  enabled?: boolean;
  bank?: string;
  accountNumber?: string;
  accountName?: string;
  authMode?: 'apikey' | 'hmac' | 'none';
  apiKey?: string;
  hmacSecret?: string;
  qrTemplate?: string;
}

interface SepayPayload {
  id: number;
  gateway: string;
  transactionDate: string;
  accountNumber: string;
  code: string | null;
  content: string;
  transferType: 'in' | 'out';
  transferAmount: number;
  referenceCode?: string;
  description?: string;
}

/**
 * Chế độ "không xác thực" (authMode='none') cho phép BẤT KỲ AI gửi webhook giả để đánh dấu đơn đã thanh toán.
 * Vì vậy nó bị chặn ở MỌI môi trường (kể cả khi NODE_ENV không phải production — tránh triển khai quên đặt NODE_ENV),
 * trừ khi người phát triển chủ động đặt biến môi trường SEPAY_ALLOW_INSECURE_WEBHOOK=1 trên máy dev.
 * KHÔNG BAO GIỜ đặt biến này trên server thật.
 */
const insecureAllowed = () => process.env.SEPAY_ALLOW_INSECURE_WEBHOOK === '1';

export function sepayProvider({ settings }: GatewayDeps): PaymentProvider {
  const cfg = () => settings.get<Settings>('sepay');

  return {
    key: 'sepay',
    // ẩn: website chỉ dùng Web2M — không hiện cho khách / trang Cài đặt, vẫn nhận webhook giao dịch cũ
    hidden: true,
    label: { vi: 'Chuyển khoản ngân hàng / VietQR (tự động xác nhận)', en: 'Bank transfer / VietQR (auto-confirmed)' },
    description: { vi: 'Quét mã QR hoặc chuyển khoản đúng nội dung, đơn hàng được xác nhận tự động.', en: 'Scan the QR code or transfer with the exact content; confirmed automatically.' },

    async isEnabled() {
      return (await cfg()).enabled === true;
    },

    async isConfigured() {
      const s = await cfg();
      // "không xác thực" chỉ dùng khi phát triển (cần SEPAY_ALLOW_INSECURE_WEBHOOK=1): không thì ai cũng giả được webhook
      const authOk = s.authMode === 'none' ? insecureAllowed() : s.authMode === 'hmac' ? !!s.hmacSecret : !!s.apiKey;
      return !!(s.bank && s.accountNumber && authOk);
    },

    /** SePay không cần gọi API khi tạo đơn: hiển thị QR + nội dung chuyển khoản = mã đơn */
    async createPayment({ order, amount }) {
      const s = await cfg();
      const content = alnum(order.code).toUpperCase();
      const params = new URLSearchParams({ acc: s.accountNumber!, bank: s.bank!, amount: String(amount), des: content });
      if (s.qrTemplate) params.set('template', s.qrTemplate);
      const bank = { bankName: s.bank!, accountNumber: s.accountNumber!, accountName: s.accountName ?? '' };
      return { qrImageUrl: `https://qr.sepay.vn/img?${params.toString()}`, bank, transferContent: content, raw: { bank } };
    },

    async handleWebhook({ headers, body, rawBody }) {
      const s = await cfg();
      // xác thực theo kiểu đã chọn khi tạo webhook trên my.sepay.vn
      // authMode='none' bị từ chối ở mọi môi trường, trừ máy dev đã bật SEPAY_ALLOW_INSECURE_WEBHOOK=1 (xem insecureAllowed)
      if (s.authMode === 'none' && !insecureAllowed()) return { valid: false, success: false, note: 'Chế độ không xác thực bị chặn (chỉ cho phép khi đặt SEPAY_ALLOW_INSECURE_WEBHOOK=1 lúc phát triển)', statusCode: 401, response: { success: false } };
      if (s.authMode !== 'none') {
        if (s.authMode === 'hmac') {
          const sig = header(headers, 'x-sepay-signature')?.replace(/^sha256=/, '');
          const ts = header(headers, 'x-sepay-timestamp');
          if (!rawBody || !sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { valid: false, success: false, note: 'Thiếu/hết hạn chữ ký SePay', statusCode: 401, response: { success: false } };
          if (!safeEqual(hmacSha256(s.hmacSecret!, `${ts}.${rawBody.toString('utf8')}`), sig)) return { valid: false, success: false, note: 'Sai chữ ký SePay', statusCode: 401, response: { success: false } };
        } else {
          const auth = header(headers, 'authorization') ?? '';
          const key = auth.replace(/^Apikey\s+/i, '');
          if (!safeEqual(key, s.apiKey)) return { valid: false, success: false, note: 'Sai API Key SePay', statusCode: 401, response: { success: false } };
        }
      }
      const p = body as SepayPayload;
      // SePay yêu cầu trả 200 + {"success": true} kể cả giao dịch không liên quan, nếu không sẽ gửi lại
      const ok = { valid: true, statusCode: 200, response: { success: true } } as const;
      if (!p || p.transferType !== 'in') return { ...ok, success: false, note: 'Giao dịch tiền ra — bỏ qua' };
      if (s.accountNumber && p.accountNumber && alnum(p.accountNumber) !== alnum(s.accountNumber)) return { ...ok, success: false, note: `Tài khoản ${p.accountNumber} không khớp cấu hình` };
      return { ...ok, success: true, transferContent: `${p.code ?? ''} ${p.content ?? ''}`, amount: Number(p.transferAmount), reference: p.referenceCode || String(p.id), txnId: p.id != null ? String(p.id) : undefined };
    },
  };
}
