import type { PaymentTransaction } from '../../generated/prisma/client.js';
import type { PaymentProvider } from '../payments/payment-provider.interface.js';
import { postJson, safeEqual, type GatewayDeps } from './payment-utils.js';

/**
 * Cổng USDT qua hệ thống USDT Gateway (dự án gateway_blockchain, API tương thích NTPAY).
 * Luồng nâng cấp:
 * - Tạo hoá đơn `POST {endpoint}/api/AddInvoice` -> đọc luôn danh sách ví / mạng lưới (`.net-option`: TRC20, BEP20, Binance Pay...)
 *   kèm mã QR & địa chỉ ví từ `url_payment` để khách chọn mạng và quét mã trực tiếp ngay trên website mà không bị localStorage cũ nhảy cóc.
 * - Khi trang web khách poll trạng thái kèm `walletId`, server tự ping `/payment/TX.../check` trên gateway để kích hoạt quét on-chain tức thì,
 *   đồng thời đối chiếu `GetInvoiceStatus`.
 */

interface Settings {
  enabled?: boolean;
  endpoint?: string;
  merchantId?: string;
  apiKey?: string;
  rate?: number;
  minUsdt?: number;
}

interface GatewayResponse<T> {
  status: 'success' | 'error';
  msg?: string;
  data?: T;
}

interface InvoiceStatus {
  trans_id: string;
  request_id: string;
  amount: string;
  received: string;
  status: 'waiting' | 'completed' | 'expired' | string;
  from_address?: string | null;
  transaction_id?: string | null;
}

export interface UsdtNetworkItem {
  walletId: string;
  network: string;
  label: string;
  kind: 'chain' | 'binance' | string;
  address: string;
  memo: string;
  qr: string;
  payUri: string;
}

export interface UsdtInvoiceInfo {
  transId: string;
  amount: number;
  payAmount: string;
  rate: number;
  currency: 'USDT';
  networks?: UsdtNetworkItem[];
}

const EPS = 0.0005;

const DEFAULT_PUBLIC_NETWORKS = [
  { walletId: '4', network: 'TRON', label: 'Tron (TRC20)', kind: 'chain' },
  { walletId: '5', network: 'BSC', label: 'BNB Smart Chain (BEP20)', kind: 'chain' },
];

let cachedPublicNetworks: { walletId: string; network: string; label: string; kind: string }[] | null = null;

function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Đọc danh sách các mạng lưới / ví USDT đang mở trên hoá đơn của USDT Gateway */
async function fetchInvoiceNetworks(urlPayment: string): Promise<UsdtNetworkItem[]> {
  const res = await fetch(urlPayment, {
    headers: { Accept: 'text/html', 'User-Agent': 'NovAI-GatewayClient/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out: UsdtNetworkItem[] = [];
  const btnRegex = /<button\b[^>]*class="[^"]*\bnet-option\b[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = btnRegex.exec(html)) !== null) {
    const tag = match[0];
    const attrs: Record<string, string> = {};
    const attrRegex = /(data-[a-z0-9-]+)="([^"]*)"/gi;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(tag)) !== null) {
      attrs[am[1].toLowerCase()] = decodeHtmlAttr(am[2]);
    }
    const network = attrs['data-network'] || '';
    const label = attrs['data-label'] || network;
    if (!network && !label) continue;
    out.push({
      walletId: attrs['data-wallet'] || network,
      network: network || label,
      label,
      kind: attrs['data-kind'] || 'chain',
      address: attrs['data-address'] || '',
      memo: attrs['data-memo'] || '',
      qr: attrs['data-qr'] || '',
      payUri: attrs['data-pay-uri'] || '',
    });
  }
  if (out.length > 0) {
    cachedPublicNetworks = out.map((x) => ({
      walletId: x.walletId,
      network: x.network,
      label: x.label,
      kind: x.kind,
    }));
  }
  return out;
}

/** Báo cho USDT Gateway biết khách đang chuyển vào các wallet_id nào để quét on-chain tức thì (kể cả khi khách đã đóng tab trình duyệt) */
async function pingGatewayWallets(urlPayment: string, walletIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(walletIds.map((w) => w.trim()).filter(Boolean))];
  if (!uniqueIds.length) return;
  const pageRes = await fetch(urlPayment, {
    headers: { Accept: 'text/html', 'User-Agent': 'NovAI-GatewayClient/1.0' },
    signal: AbortSignal.timeout(6000),
  });
  if (!pageRes.ok) return;
  const setCookies = typeof pageRes.headers.getSetCookie === 'function' ? pageRes.headers.getSetCookie() : [];
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const html = await pageRes.text();
  const csrfMatch = /csrf\s*:\s*"([^"]+)"/.exec(html);
  const checkMatch = /checkUrl\s*:\s*"([^"]+)"/.exec(html);
  const csrf = csrfMatch?.[1] ?? '';
  const checkUrl = checkMatch?.[1]?.replace(/\\\//g, '/') ?? `${urlPayment.replace(/\/+$/, '')}/check`;
  if (!csrf || !checkUrl) return;
  for (const wid of uniqueIds) {
    const body = new URLSearchParams({ _token: csrf, wallet_id: wid });
    await fetch(checkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(6000),
    }).catch(() => undefined);
  }
}

export function usdtInfo(tx: Pick<PaymentTransaction, 'rawResponse'>): UsdtInvoiceInfo | null {
  const raw = tx.rawResponse as { usdt?: UsdtInvoiceInfo } | null;
  return raw?.usdt?.transId ? raw.usdt : null;
}

export const vndToUsdt = (vnd: number, rate: number) => Math.ceil((vnd / rate) * 100 - 1e-9) / 100;

export function usdtToVnd(received: number, info: Pick<UsdtInvoiceInfo, 'amount' | 'rate'>, txAmount: number) {
  if (received + EPS >= info.amount) return txAmount;
  return Math.floor(received * info.rate);
}

export function usdtProvider({ settings, prisma }: GatewayDeps): PaymentProvider {
  const cfg = () => settings.get<Settings>('usdt');
  const base = (s: Settings) => (s.endpoint ?? '').trim().replace(/\/+$/, '');
  const rateOf = (s: Settings) => Number(s.rate) || 0;

  async function invoiceStatus(s: Settings, transId: string) {
    const res = await postJson<GatewayResponse<InvoiceStatus>>(`${base(s)}/api/GetInvoiceStatus`, {
      merchant_id: s.merchantId,
      api_key: s.apiKey,
      trans_id: transId,
    });
    if (res.status !== 'success' || !res.data) throw new Error(`USDT Gateway: ${res.msg ?? 'không đọc được trạng thái hoá đơn'}`);
    return res.data;
  }

  return {
    key: 'usdt',
    label: { vi: 'Thanh toán bằng USDT (Crypto)', en: 'Pay with USDT (Crypto)' },
    description: {
      vi: 'Chuyển USDT qua TRC20, BEP20, Binance Pay... — số dư được cộng tự động khi giao dịch xác nhận trên blockchain.',
      en: 'Send USDT via TRC20, BEP20, Binance Pay... — credited automatically once confirmed on-chain.',
    },
    acceptsGet: true,

    async isEnabled() {
      return (await cfg()).enabled === true;
    },

    async isConfigured() {
      const s = await cfg();
      return !!(base(s) && s.merchantId && s.apiKey && rateOf(s) > 0);
    },

    async minAmount() {
      const s = await cfg();
      return Math.ceil(Math.max(1, Number(s.minUsdt) || 1) * rateOf(s));
    },

    async publicNetworks() {
      if (cachedPublicNetworks?.length) return cachedPublicNetworks;
      const latest = await prisma.paymentTransaction.findFirst({
        where: { provider: 'usdt', checkoutUrl: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { checkoutUrl: true, rawResponse: true },
      });
      const stored = (latest?.rawResponse as { usdt?: { networks?: UsdtNetworkItem[] } } | null)?.usdt?.networks;
      if (Array.isArray(stored) && stored.length > 0) {
        cachedPublicNetworks = stored.map((x) => ({
          walletId: x.walletId,
          network: x.network,
          label: x.label,
          kind: x.kind,
        }));
        return cachedPublicNetworks;
      }
      if (latest?.checkoutUrl) {
        const fetched = await fetchInvoiceNetworks(latest.checkoutUrl).catch(() => []);
        if (fetched.length > 0) {
          return fetched.map((x) => ({
            walletId: x.walletId,
            network: x.network,
            label: x.label,
            kind: x.kind,
          }));
        }
      }
      return DEFAULT_PUBLIC_NETWORKS;
    },

    async createPayment({ order, transaction, amount, returnUrl, cancelUrl, webhookUrl }) {
      const s = await cfg();
      const rate = rateOf(s);
      const usdt = vndToUsdt(amount, rate);
      const res = await postJson<
        GatewayResponse<{ trans_id: string; request_id: string; amount: string; status: string; url_payment: string }>
      >(`${base(s)}/api/AddInvoice`, {
        merchant_id: s.merchantId,
        api_key: s.apiKey,
        name: `Nap tien ${order.code}`,
        description: `Nap ${amount} VND (${usdt} USDT, ti gia ${rate})`,
        amount: usdt,
        request_id: transaction.providerOrderCode,
        callback_url: webhookUrl,
        success_url: returnUrl,
        cancel_url: cancelUrl,
      });
      if (res.status !== 'success' || !res.data?.url_payment) {
        throw new Error(`USDT Gateway: ${res.msg ?? 'tạo hoá đơn thất bại'}`);
      }
      const d = res.data;
      const networks = await fetchInvoiceNetworks(d.url_payment).catch(() => []);
      const info: UsdtInvoiceInfo = {
        transId: d.trans_id,
        amount: usdt,
        payAmount: d.amount,
        rate,
        currency: 'USDT',
        networks,
      };
      return { checkoutUrl: d.url_payment, reference: d.trans_id, raw: { usdt: info } };
    },

    async handleWebhook({ query, body }) {
      const s = await cfg();
      const p = { ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}), ...query } as Record<string, unknown>;
      const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : p[k] != null ? String(p[k]) : '');
      const ok = (note?: string, success = false) => ({ valid: true, success, note, statusCode: 200, response: { status: 'success', msg: 'OK' } });

      if (!s.merchantId || !s.apiKey || !safeEqual(str('merchant_id'), s.merchantId) || !safeEqual(str('api_key'), s.apiKey)) {
        return { valid: false, success: false, note: 'Sai merchant_id / api_key callback USDT', statusCode: 401, response: { status: 'error', msg: 'Unauthorized' } };
      }
      const requestId = str('request_id');
      const transId = str('trans_id');
      if (str('status') !== 'completed') return ok(`Hoá đơn ${transId || requestId} ${str('status') || 'không rõ trạng thái'}`);

      const tx = requestId ? await prisma.paymentTransaction.findUnique({ where: { provider_providerOrderCode: { provider: 'usdt', providerOrderCode: requestId } } }) : null;
      const info = tx ? usdtInfo(tx) : null;
      if (!tx || !info) return ok(`Không tìm thấy giao dịch request_id=${requestId}`);
      if (info.transId !== transId) return ok(`trans_id ${transId} không khớp hoá đơn đã tạo (${info.transId})`);

      const inv = await invoiceStatus(s, info.transId);
      if (inv.status !== 'completed') return ok(`Gateway báo hoá đơn ${info.transId} đang ${inv.status}`);
      const received = Number(inv.received);
      return {
        ...ok(undefined, true),
        providerOrderCode: requestId,
        amount: usdtToVnd(received, info, Number(tx.amount)),
        reference: inv.transaction_id || info.transId,
        txnId: `usdt:${info.transId}`,
      };
    },

    async fetchStatus(tx, walletId) {
      const info = usdtInfo(tx);
      if (!info) return 'PENDING';
      if (tx.checkoutUrl) {
        // Nếu khách đang chọn 1 mạng cụ thể thì quét mạng đó trước; nếu chạy ngầm từ cron server (không có walletId)
        // thì tự động kích hoạt quét toàn bộ các mạng on-chain (TRC20, BEP20...) của hoá đơn để khách đóng tab vẫn tự vào tiền!
        const chainIds = (info.networks ?? [])
          .filter((n) => !n.kind || n.kind === 'chain')
          .map((n) => n.walletId)
          .filter(Boolean);
        const targets = walletId ? [walletId, ...chainIds] : chainIds.length ? chainIds : DEFAULT_PUBLIC_NETWORKS.map((n) => n.walletId);
        await pingGatewayWallets(tx.checkoutUrl, targets).catch(() => undefined);
      }
      const inv = await invoiceStatus(await cfg(), info.transId);
      if (inv.status === 'completed' && Number(inv.received) + EPS >= info.amount) return 'PAID';
      if (inv.status === 'expired') return 'EXPIRED';
      return 'PENDING';
    },
  };
}
