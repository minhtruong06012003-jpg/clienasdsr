import { randomUUID } from 'node:crypto';
import type { PaymentProvider, WebhookResult } from '../payments/payment-provider.interface.js';
import { alnum, header, hmacSha256, postJson, safeEqual, type GatewayDeps } from './payment-utils.js';

/**
 * Cổng Pay2S: thanh toán VietQR Napas247 qua Pay2S Collection Link, xác nhận bằng IPN có chữ ký
 * (tuỳ chọn thêm webhook biến động số dư). Cấu hình: Cài đặt › Cổng thanh toán › Pay2S (nhóm `pay2s`).
 * IPN/Webhook: /api/payments/webhook/pay2s
 */

interface Settings {
  enabled?: boolean;
  partnerCode?: string;
  partnerName?: string;
  accessKey?: string;
  secretKey?: string;
  bankAccounts?: string;
  endpoint?: string;
  webhookToken?: string;
}

interface Pay2SCreateResponse {
  resultCode: number;
  message: string;
  payUrl?: string;
  qrList?: { bank_id: string; account_number: string; account_name: string; qrCode: string; qrUrl?: string }[];
}

type Ipn = Record<string, string | number | undefined>;

/** "ACB:12345678" mỗi dòng -> [{ bank_id, account_number }] */
const parseAccounts = (v?: string) =>
  (v ?? '')
    .split(/[\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [bank_id, account_number] = l.split(/[:|\s]+/);
      return { bank_id: bank_id?.toUpperCase(), account_number };
    })
    .filter((a) => a.bank_id && a.account_number);

/** Chuỗi ký tạo thanh toán V1 — thứ tự cố định, bankAccounts là chuỗi literal "Array" (theo tài liệu Pay2S) */
export function pay2sCreateSignature(p: Record<string, string | number>, secretKey: string) {
  const raw = `accessKey=${p.accessKey}&amount=${p.amount}&bankAccounts=Array&ipnUrl=${p.ipnUrl}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&partnerCode=${p.partnerCode}&redirectUrl=${p.redirectUrl}&requestId=${p.requestId}&requestType=${p.requestType}`;
  return hmacSha256(secretKey, raw);
}

/** Chuỗi ký m2signature của IPN */
export function pay2sIpnSignature(d: Ipn, accessKey: string, secretKey: string) {
  const v = (k: string) => (d[k] ?? '').toString();
  const raw = `accessKey=${accessKey}&amount=${v('amount')}&extraData=${v('extraData')}&message=${v('message')}&orderId=${v('orderId')}&orderInfo=${v('orderInfo')}&orderType=${v('orderType')}&partnerCode=${v('partnerCode')}&payType=${v('payType')}&requestId=${v('requestId')}&responseTime=${v('responseTime')}&resultCode=${v('resultCode')}&transId=${v('transId')}`;
  return hmacSha256(secretKey, raw);
}

export function pay2sProvider({ settings }: GatewayDeps): PaymentProvider {
  const cfg = () => settings.get<Settings>('pay2s');
  const base = (s: Settings) => (s.endpoint || 'https://payment.pay2s.vn').replace(/\/$/, '');
  const ack: Pick<WebhookResult, 'statusCode' | 'response'> = { statusCode: 200, response: { success: true } };

  return {
    key: 'pay2s',
    // ẩn: website chỉ dùng Web2M — không hiện cho khách / trang Cài đặt, vẫn nhận webhook giao dịch cũ
    hidden: true,
    label: { vi: 'Thanh toán VietQR (Pay2S)', en: 'VietQR payment (Pay2S)' },
    description: { vi: 'Quét mã QR Napas247 bằng app ngân hàng, xác nhận tự động.', en: 'Scan Napas247 QR with your banking app, confirmed automatically.' },

    async isEnabled() {
      return (await cfg()).enabled === true;
    },

    async isConfigured() {
      const s = await cfg();
      return !!(s.partnerCode && s.accessKey && s.secretKey && parseAccounts(s.bankAccounts).length);
    },

    async createPayment({ order, transaction, amount, returnUrl, webhookUrl }) {
      const s = await cfg();
      // orderInfo = nội dung chuyển khoản: 10–32 ký tự chữ/số, không trùng giữa các lần thanh toán
      const orderInfo = `${alnum(order.code)}${transaction.providerOrderCode.slice(-6)}`.toUpperCase().slice(0, 32);
      const p = {
        accessKey: s.accessKey!,
        partnerCode: s.partnerCode!,
        requestId: transaction.id,
        amount,
        orderId: transaction.providerOrderCode,
        orderInfo,
        redirectUrl: returnUrl,
        ipnUrl: webhookUrl,
        requestType: 'pay2s',
      };
      const body = { ...p, partnerName: s.partnerName || undefined, orderType: 'pay2s', bankAccounts: parseAccounts(s.bankAccounts), signature: pay2sCreateSignature(p, s.secretKey!) };
      const res = await postJson<Pay2SCreateResponse>(`${base(s)}/v1/gateway/api/create`, body);
      if (Number(res.resultCode) !== 0) throw new Error(`Pay2S: ${res.resultCode} ${res.message}`);
      const qr = res.qrList?.[0];
      const bank = qr ? { bankName: qr.bank_id, accountNumber: qr.account_number, accountName: qr.account_name } : undefined;
      return { checkoutUrl: res.payUrl, qrImageUrl: qr?.qrCode, bank, transferContent: orderInfo, raw: { payUrl: res.payUrl, bank } };
    },

    async handleWebhook({ headers, body }) {
      const s = await cfg();
      const b = body as Record<string, unknown>;

      // (1) IPN của Collection Link: có m2signature
      if (b && typeof b === 'object' && 'm2signature' in b) {
        const d = b as Ipn;
        if (!safeEqual(pay2sIpnSignature(d, s.accessKey ?? '', s.secretKey ?? ''), String(d.m2signature))) {
          return { valid: false, success: false, note: 'Sai chữ ký IPN Pay2S', statusCode: 400, response: { success: false } };
        }
        if (String(d.partnerCode) !== s.partnerCode) return { valid: false, success: false, note: 'partnerCode không khớp', statusCode: 400, response: { success: false } };
        return {
          ...ack,
          valid: true,
          success: Number(d.resultCode) === 0,
          providerOrderCode: String(d.orderId),
          amount: Number(d.amount),
          reference: d.transId ? String(d.transId) : undefined,
          txnId: d.transId ? `ipn:${d.transId}` : undefined,
          note: String(d.message ?? ''),
        };
      }

      // (2) Webhook biến động số dư: Authorization: Bearer <token>
      const token = (header(headers, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!s.webhookToken || !safeEqual(token, s.webhookToken)) return { valid: false, success: false, note: 'Sai token webhook Pay2S', statusCode: 401, response: { success: false } };
      const list = (Array.isArray(b?.transactions) ? b.transactions : [b]) as { transferType?: string; content?: string; transferAmount?: number; id?: number; transactionNumber?: string }[];
      // một webhook có thể chứa nhiều giao dịch: xử lý tất cả giao dịch tiền vào
      const incoming = list.filter((t) => t && String(t.transferType).toUpperCase() === 'IN');
      if (!incoming.length) return { ...ack, valid: true, success: false, note: 'Không có giao dịch tiền vào' };
      return {
        ...ack,
        valid: true,
        success: true,
        payments: incoming.map((t) => ({
          transferContent: t.content ?? '',
          amount: Number(t.transferAmount),
          reference: String(t.transactionNumber ?? t.id ?? ''),
          txnId: t.id != null ? `bank:${t.id}` : t.transactionNumber ? `bank:${t.transactionNumber}` : undefined,
        })),
      };
    },

    async cancel(tx) {
      const s = await cfg();
      const requestId = randomUUID();
      const p = { accessKey: s.accessKey!, orderId: tx.providerOrderCode, partnerCode: s.partnerCode!, requestId, requestType: 'cancel' };
      const signature = hmacSha256(s.secretKey!, `accessKey=${p.accessKey}&orderId=${p.orderId}&partnerCode=${p.partnerCode}&requestId=${p.requestId}&requestType=cancel`);
      await postJson(`${base(s)}/v1/gateway/api/cancel`, { ...p, signature });
    },
  };
}
