import type { PaymentProvider, WebhookPayment } from '../payments/payment-provider.interface.js';
import { alnum, header, safeEqual, type GatewayDeps } from './payment-utils.js';

/**
 * Cổng ngân hàng tự động qua Web2M (api.web2m.com — sPayment): hiển thị VietQR vào tài khoản ngân hàng của shop,
 * Web2M theo dõi biến động số dư và gọi webhook về khi có tiền vào -> khớp theo nội dung chuyển khoản (mã NAPxxxx).
 * Cấu hình: Cài đặt › Cổng thanh toán › Web2M (nhóm `web2m`). Webhook: /api/payments/webhook/web2m
 *
 * Webhook Web2M (api.web2m.com/Home/tailieuwebhook): POST JSON, header `Authorization: Bearer <Access Token>`
 * (Access Token lấy ở trang Cấu hình webhook của Web2M, dán vào Cài đặt), body dạng
 * `{ "status": true, "data": [{ "id": "753632", "type": "IN", "transactionID": "24213", "amount": "100000", "description", "date": "01/04/2024", "bank": "ACB" }] }`
 * (id = mã duy nhất của giao dịch phía Web2M, transactionID = mã giao dịch ngân hàng, amount là chuỗi).
 * Phải trả HTTP 200 + `{ "status": true, "msg": "Ok" }` trong 5 giây, không thì Web2M gửi lại liên tục.
 * Payload vẫn đọc linh hoạt (mảng ở data / transactions / body là mảng). Cách tích hợp theo dự án smm.vin.
 */

interface Settings {
  enabled?: boolean;
  bank?: string;
  accountNumber?: string;
  accountName?: string;
  token?: string;
  qrTemplate?: string;
}

/** Một giao dịch trong payload webhook (tên trường có thể khác nhau giữa các phiên bản Web2M) */
type Txn = Record<string, unknown>;

/** Lấy giá trị đầu tiên có dữ liệu theo danh sách tên trường */
function pick(t: Txn, keys: string[]): unknown {
  for (const k of keys) if (t[k] != null && t[k] !== '') return t[k];
  return undefined;
}

/** Số tiền dạng số hoặc chuỗi ("100000", "100,000", "100.000") -> số nguyên VND */
function toAmount(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v.replace(/[^\d.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '')) || 0;
  return 0;
}

/** Giao dịch tiền vào: theo trường type (IN / credit...), không có type thì xét số tiền > 0 */
function isIncoming(t: Txn) {
  const type = String(pick(t, ['type', 'transferType', 'transactionType']) ?? '').toLowerCase();
  if (type) return ['in', 'credit', 'c', '+', '1', 'income', 'receive'].includes(type);
  return toAmount(pick(t, ['amount', 'transferAmount', 'creditAmount'])) > 0;
}

/** Đọc danh sách giao dịch từ các dạng payload hay gặp */
function parsePayload(body: unknown): Txn[] {
  if (Array.isArray(body)) return body as Txn[];
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of ['data', 'transactions', 'items']) {
    if (Array.isArray(b[k])) return b[k] as Txn[];
    if (b[k] && typeof b[k] === 'object') return [b[k] as Txn];
  }
  return [b];
}

export function web2mProvider({ settings }: GatewayDeps): PaymentProvider {
  const cfg = () => settings.get<Settings>('web2m');
  // Web2M coi webhook thành công khi nhận status = true
  const ack = { statusCode: 200, response: { status: true, msg: 'Ok' } } as const;

  return {
    key: 'web2m',
    label: { vi: 'Chuyển khoản ngân hàng / VietQR (tự động xác nhận)', en: 'Bank transfer / VietQR (auto-confirmed)' },
    description: { vi: 'Quét mã QR hoặc chuyển khoản đúng nội dung, tiền được cộng vào ví tự động.', en: 'Scan the QR code or transfer with the exact content; confirmed automatically.' },

    async isEnabled() {
      return (await cfg()).enabled === true;
    },

    async isConfigured() {
      const s = await cfg();
      return !!(s.bank && s.accountNumber && s.token);
    },

    /** Không cần gọi API Web2M khi tạo giao dịch: hiển thị VietQR + nội dung chuyển khoản = mã nạp ví (NAPxxxx) */
    async createPayment({ order, amount }) {
      const s = await cfg();
      const content = alnum(order.code).toUpperCase();
      const params = new URLSearchParams({ amount: String(amount), addInfo: content });
      if (s.accountName) params.set('accountName', s.accountName);
      // ảnh VietQR công khai của vietqr.io: <mã ngân hàng>-<số tài khoản>-<mẫu>.png
      const qr = `https://img.vietqr.io/image/${encodeURIComponent(s.bank!)}-${encodeURIComponent(s.accountNumber!)}-${s.qrTemplate || 'compact2'}.png?${params.toString()}`;
      const bank = { bankName: s.bank!, accountNumber: s.accountNumber!, accountName: s.accountName ?? '' };
      return { qrImageUrl: qr, bank, transferContent: content, raw: { bank } };
    },

    async handleWebhook({ headers, body, query }) {
      const s = await cfg();
      // Access Token Bearer theo tài liệu Web2M; dự phòng ?token= trên URL nếu không đặt được header
      const token = (header(headers, 'authorization') ?? '').replace(/^Bearer\s+/i, '') || (typeof query.token === 'string' ? query.token : '');
      if (!s.token || !safeEqual(token, s.token)) return { valid: false, success: false, note: 'Sai token webhook Web2M', statusCode: 401, response: { status: false, msg: 'Unauthorized' } };

      const incoming = parsePayload(body).filter((t) => t && typeof t === 'object' && isIncoming(t));
      if (!incoming.length) return { ...ack, valid: true, success: false, note: 'Không có giao dịch tiền vào' };

      // bỏ giao dịch vào tài khoản khác (nếu payload có số tài khoản)
      const mine = incoming.filter((t) => {
        const acc = pick(t, ['accountNumber', 'account_number', 'account']);
        return !acc || !s.accountNumber || alnum(String(acc)) === alnum(s.accountNumber);
      });
      if (!mine.length) return { ...ack, valid: true, success: false, note: 'Tài khoản nhận không khớp cấu hình' };

      const payments: WebhookPayment[] = mine.map((t) => {
        // id = mã duy nhất của giao dịch phía Web2M — chống cộng trùng khi Web2M gửi lại; dự phòng mã ngân hàng
        const id = pick(t, ['id', 'transactionID', 'transactionId', 'transaction_id']);
        // transactionID = mã giao dịch phía ngân hàng — lưu làm reference để đối soát
        const ref = pick(t, ['transactionID', 'transactionId', 'transaction_id', 'id']);
        return {
          transferContent: String(pick(t, ['description', 'content', 'transferContent', 'remark']) ?? ''),
          amount: toAmount(pick(t, ['amount', 'transferAmount', 'creditAmount'])),
          reference: ref != null ? String(ref) : undefined,
          txnId: id != null ? `w2m:${id}` : undefined,
        };
      });
      return { ...ack, valid: true, success: true, payments };
    },
  };
}
