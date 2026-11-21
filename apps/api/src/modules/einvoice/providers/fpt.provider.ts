import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, extractMessage, httpRequest, joinUrl, pick, str } from './http.js';
import { formatDateVN, roundMoney, vatRateCode } from '../einvoice.calc.js';

/**
 * Adapter FPT eInvoice (einvoice.fpt.com.vn) — REST JSON, Bearer token (client credentials).
 *
 * Tài liệu API của FPT KHÔNG công khai (cấp khi ký hợp đồng). Cấu trúc dưới đây theo kiến thức tốt nhất
 * và PHẢI được kiểm tra lại với tài liệu FPT cấp cho doanh nghiệp:
 *  - Token: `POST /api/integration/gen-token` {username, password} -> access_token
 *  - Phát hành: `POST /api/invoice/issue` (sid = payload.id, form/serial, buyer, items[], totals)
 *  - Thay thế / điều chỉnh: `POST /api/invoice/replace` / `/api/invoice/adjust`
 *  - Huỷ: `POST /api/invoice/{sid}/cancel`; PDF/XML: `GET /api/invoice/{sid}/pdf|xml`; trạng thái: `GET /api/invoice/{sid}/status`
 * Tra cứu công khai: https://tracuu.einvoice.fpt.com.vn (mã tra cứu + MST người bán).
 */

const DEFAULT_URLS = { sandbox: 'https://uat-api.einvoice.fpt.com.vn', production: 'https://api.einvoice.fpt.com.vn' } as const;
const LOOKUP_URL = 'https://tracuu.einvoice.fpt.com.vn';
const TOKEN_TTL_MS = 50 * 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function baseUrlOf(cfg: ProviderConfig): string {
  const custom = cfg.environment === 'production' ? str(cfg.productionUrl) : str(cfg.sandboxUrl);
  return (custom.trim() || DEFAULT_URLS[cfg.environment]).replace(/\/+$/, '');
}

/** Thuế suất gửi FPT: số phần trăm cho 0/5/8/10, mã chữ (KCT/KKKNT/KHAC) cho nhóm đặc biệt */
export function fptVatRate(rate: VatRate): number | string {
  return rate >= 0 ? rate : vatRateCode(rate);
}

/** Dựng body phát hành cho FPT. Export để test. */
export function buildFptInvoice(payload: InvoicePayload, cfg: ProviderConfig): Record<string, unknown> {
  const b = payload.buyer;
  const s = payload.seller;
  const anonymous = !!b.anonymous;
  const money = (v: number) => roundMoney(v, 0);
  const sign = (l: InvoiceLine, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);
  const t = payload.totals;
  const o = payload.original;

  const body: Record<string, unknown> = {
    sid: payload.id,
    // 1 gốc | 3 thay thế | 5 điều chỉnh (theo mã nghiệp vụ CQT)
    type: payload.kind === 'REPLACEMENT' ? 3 : payload.kind === 'ADJUSTMENT' ? 5 : 1,
    form: str(cfg.form).trim() || payload.templateCode,
    serial: str(cfg.serial).trim() || payload.serial,
    date: formatDateVN(payload.invoiceDate),
    currency: payload.currency || 'VND',
    exchangeRate: payload.exchangeRate || 1,
    paymentMethod: payload.paymentMethod || 'TM/CK',
    note: str(payload.note) || undefined,
    orderCode: str(payload.orderCode) || undefined,
    seller: { name: s.name, taxCode: s.taxCode, address: s.address, phone: s.phone, email: s.email, bankAccount: s.bankAccount, bankName: s.bankName },
    buyer: {
      name: anonymous ? 'Người mua không lấy hoá đơn' : b.name,
      legalName: anonymous ? undefined : b.legalName || undefined,
      taxCode: anonymous ? undefined : b.taxCode || undefined,
      address: b.address || undefined,
      email: b.email || undefined,
      phone: b.phone || undefined,
      idNumber: anonymous ? undefined : b.idNumber || undefined,
      bankAccount: b.bankAccount || undefined,
      bankName: b.bankName || undefined,
      budgetCode: b.budgetCode || undefined,
      notGetInvoice: anonymous,
    },
    items: payload.lines.map((l) => ({
      line: l.index,
      kind: l.kind,
      code: l.sku || undefined,
      name: l.name,
      unit: l.unit || undefined,
      quantity: l.kind === 'discount' ? undefined : l.quantity,
      price: l.kind === 'discount' ? undefined : roundMoney(l.unitPrice, 2),
      discount: money(l.discount),
      amount: money(sign(l, l.amount)),
      vatRate: fptVatRate(l.vatRate),
      vatAmount: money(sign(l, l.vatAmount)),
      total: money(sign(l, l.total)),
      ...(l.adjustment ? { adjustment: l.adjustment } : {}),
    })),
    vat: t.breakdown.map((br) => ({ vatRate: fptVatRate(br.vatRate), amount: money(br.amount), vatAmount: money(br.vatAmount) })),
    total: { subtotal: money(t.subtotal), discount: money(t.discountTotal), vat: money(t.vatTotal), amount: money(t.total), inWords: t.totalInWords },
  };
  if (o) {
    body.original = {
      sid: str(o.providerRef) || undefined,
      invoiceNo: o.invoiceNo,
      form: o.templateCode,
      serial: o.serial,
      date: formatDateVN(o.issuedAt),
      taxAuthorityCode: o.taxAuthorityCode || undefined,
      reason: o.reason,
      agreementNo: o.agreementNo || undefined,
      agreementDate: o.agreementDate ? formatDateVN(o.agreementDate) : undefined,
    };
  }
  return body;
}

export class FptProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'fpt',
    name: 'FPT eInvoice',
    description: 'Hoá đơn điện tử FPT.eInvoice qua REST API (tài liệu đối tác). Ký HSM / FPT CA Cloud phía máy chủ.',
    website: 'https://einvoice.fpt.com.vn',
    docsUrl: 'https://einvoice.fpt.com.vn',
    signing: 'hsm',
    fields: [
      { key: 'clientId', label: 'Client ID / tài khoản API', type: 'text', required: true, help: 'Do FPT cấp khi đăng ký tích hợp.' },
      { key: 'clientSecret', label: 'Client Secret / mật khẩu API', type: 'password', required: true },
      { key: 'tokenPath', label: 'Đường dẫn lấy token', type: 'text', default: '/api/integration/gen-token', help: 'Đối chiếu với tài liệu FPT (một số bản dùng /api/auth/token).' },
      { key: 'form', label: 'Mẫu số ghi đè (form)', type: 'text', placeholder: '1', help: 'Để trống = dùng mẫu số trong cài đặt chung.' },
      { key: 'serial', label: 'Ký hiệu ghi đè (serial)', type: 'text', placeholder: 'C24TAA', help: 'Để trống = dùng ký hiệu trong cài đặt chung.' },
      { key: 'sandboxUrl', label: 'API URL (sandbox/UAT)', type: 'url', env: 'sandbox', default: DEFAULT_URLS.sandbox },
      { key: 'productionUrl', label: 'API URL (production)', type: 'url', env: 'production', default: DEFAULT_URLS.production },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Tài liệu API FPT không công khai: base URL, đường dẫn (/api/invoice/issue, /{sid}/pdf...), tên trường và mã trạng thái CẦN KIỂM TRA LẠI với tài liệu FPT cấp (customersupport@fpt.com).',
      'sid = id hoá đơn trong hệ thống (chống trùng).',
      'Tra cứu công khai tại tracuu.einvoice.fpt.com.vn: khách nhập mã tra cứu + MST người bán.',
    ],
  };

  private cacheKey(cfg: ProviderConfig) {
    return `${baseUrlOf(cfg)}|${str(cfg.clientId)}`;
  }

  /** Lấy Bearer token (cache 50 phút) */
  private async getToken(cfg: ProviderConfig, force = false): Promise<string> {
    const key = this.cacheKey(cfg);
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await httpRequest<Record<string, unknown>>(joinUrl(baseUrlOf(cfg), str(cfg.tokenPath, '/api/integration/gen-token')), {
      method: 'POST',
      body: { username: str(cfg.clientId), password: str(cfg.clientSecret), client_id: str(cfg.clientId), client_secret: str(cfg.clientSecret), grant_type: 'client_credentials' },
      timeoutMs: 30_000,
    });
    assertOk(res, 'Lấy token FPT');
    const token = str(pick(res.data, 'access_token') ?? pick(res.data, 'token') ?? pick(res.data, 'data.access_token') ?? pick(res.data, 'data.token'));
    if (!token) throw new EInvoiceProviderError(`FPT không trả về access_token: ${extractMessage(res.data) ?? ''}`.trim(), res.data);
    const expiresIn = Number(pick(res.data, 'expires_in'));
    tokenCache.set(key, { token, expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 60 ? (expiresIn - 60) * 1000 : TOKEN_TTL_MS) });
    return token;
  }

  /** Gọi API kèm Bearer; 401 -> xin token mới và thử lại 1 lần; kiểm tra success/errorCode trong body */
  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, method: 'GET' | 'POST', path: string, body: unknown, what: string, binary = false) {
    const url = joinUrl(baseUrlOf(cfg), path);
    const send = async (force: boolean) => httpRequest<T>(url, { method, headers: { Authorization: `Bearer ${await this.getToken(cfg, force)}` }, body: method === 'POST' ? body ?? {} : undefined, timeoutMs: 90_000, binary });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    assertOk(res, what);
    if (!binary) {
      const success = pick(res.data, 'success') ?? pick(res.data, 'Success');
      const errorCode = str(pick(res.data, 'errorCode') ?? pick(res.data, 'error_code'));
      if (success === false || (errorCode && errorCode !== '0' && errorCode !== 'null')) throw new EInvoiceProviderError(`${what} thất bại: ${extractMessage(res.data) ?? errorCode}`, res.data, false);
    }
    return res;
  }

  /** Dữ liệu chính của response (FPT có thể bọc trong data/result) */
  private dataOf(data: unknown): Record<string, unknown> {
    const inner = pick(data, 'data') ?? pick(data, 'result') ?? data;
    return (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
  }

  private toIssueResult(data: unknown, payload: InvoicePayload, cfg: ProviderConfig): IssueResult {
    const d = this.dataOf(data);
    const invoiceNo = str(d.invoiceNo ?? d.number ?? d.no).trim();
    const lookupCode = str(d.lookupCode ?? d.searchCode ?? d.secretCode) || null;
    return {
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: str(d.sid ?? d.id) || payload.id,
      invoiceNo: invoiceNo || null,
      serial: str(d.serial) || str(cfg.serial) || payload.serial,
      templateCode: str(d.form) || str(cfg.form) || payload.templateCode,
      taxAuthorityCode: str(d.taxAuthorityCode ?? d.taxCode ?? d.mccqt) || null,
      lookupCode,
      lookupUrl: LOOKUP_URL,
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      pdfUrl: str(d.pdfUrl) || null,
      xmlUrl: str(d.xmlUrl) || null,
      raw: data,
    };
  }

  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    tokenCache.delete(this.cacheKey(cfg));
    await this.getToken(cfg, true);
    return { ok: true, message: 'Lấy token FPT eInvoice thành công.', details: { baseUrl: baseUrlOf(cfg) } };
  }

  async issue(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const res = await this.call(cfg, 'POST', '/api/invoice/issue', buildFptInvoice(payload, cfg), 'Phát hành hoá đơn FPT');
    return this.toIssueResult(res.data, payload, cfg);
  }

  async replace(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn thay thế');
    const res = await this.call(cfg, 'POST', '/api/invoice/replace', buildFptInvoice(payload, cfg), 'Lập hoá đơn thay thế FPT');
    return this.toIssueResult(res.data, payload, cfg);
  }

  async adjust(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn điều chỉnh');
    const res = await this.call(cfg, 'POST', '/api/invoice/adjust', buildFptInvoice(payload, cfg), 'Lập hoá đơn điều chỉnh FPT');
    return this.toIssueResult(res.data, payload, cfg);
  }

  private sid(ref: InvoiceRef) {
    return encodeURIComponent(str(ref.providerRef) || ref.id);
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const res = await this.call(cfg, 'POST', `/api/invoice/${this.sid(ref)}/cancel`, { reason: str(reason) || 'Huỷ hoá đơn' }, 'Huỷ hoá đơn FPT');
    return { ok: true, message: extractMessage(res.data) || 'Đã huỷ hoá đơn trên FPT', raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const res = await this.call(cfg, 'GET', `/api/invoice/${this.sid(ref)}/status`, undefined, 'Tra trạng thái hoá đơn FPT');
    const d = this.dataOf(res.data);
    const s = str(d.status ?? d.state).toLowerCase();
    // Map trạng thái dạng chữ/số về trạng thái chung (mã số theo kiến thức: 0 nháp, 1 đã ký, 2 chờ CQT, 3 đã cấp mã, 4 từ chối, 5 huỷ)
    let status: SyncResult['status'] = 'unknown';
    if (/cancel|huỷ|huy|^5$/.test(s)) status = 'cancelled';
    else if (/replaced|thay thế|^7$/.test(s)) status = 'replaced';
    else if (/adjusted|điều chỉnh|^6$/.test(s)) status = 'adjusted';
    else if (/reject|từ chối|^4$/.test(s)) status = 'rejected';
    else if (/issued|accepted|success|đã cấp|^3$/.test(s) || str(d.taxAuthorityCode ?? d.taxCode)) status = 'issued';
    else if (/pending|wait|draft|signed|^[012]$/.test(s)) status = 'pending';
    const invoiceNo = str(d.invoiceNo ?? d.number ?? d.no);
    if (status === 'unknown' && invoiceNo) status = 'issued';
    return {
      status,
      invoiceNo: invoiceNo || ref.invoiceNo || null,
      serial: str(d.serial) || ref.serial || null,
      templateCode: str(d.form) || ref.templateCode || null,
      taxAuthorityCode: str(d.taxAuthorityCode ?? d.taxCode ?? d.mccqt) || null,
      lookupCode: str(d.lookupCode ?? d.searchCode) || ref.lookupCode || null,
      lookupUrl: LOOKUP_URL,
      issuedAt: d.issuedAt || d.date ? new Date(String(d.issuedAt ?? d.date)) : ref.issuedAt ?? null,
      message: extractMessage(res.data),
      raw: res.data,
    };
  }

  private async file(cfg: ProviderConfig, ref: InvoiceRef, kind: 'pdf' | 'xml'): Promise<FileResult> {
    const res = await this.call<Record<string, unknown>>(cfg, 'GET', `/api/invoice/${this.sid(ref)}/${kind}`, undefined, `Tải ${kind.toUpperCase()} hoá đơn FPT`, true);
    const ct = res.headers.get('content-type') ?? '';
    let buf = res.buffer ?? Buffer.alloc(0);
    const mime = kind === 'pdf' ? 'application/pdf' : 'application/xml';
    const name = `${str(ref.invoiceNo) || ref.id}.${kind}`;
    if (ct.includes('json')) {
      // { data: "<base64>" } hoặc { data: { content } }
      const json = JSON.parse(buf.toString('utf8')) as unknown;
      const d = pick(json, 'data') ?? pick(json, 'result') ?? pick(json, 'content');
      const content = typeof d === 'string' ? d : str(pick(d, 'content') ?? pick(d, 'base64') ?? pick(d, 'file'));
      if (!content) throw new EInvoiceProviderError('FPT không trả về nội dung file', json, true);
      buf = kind === 'xml' && content.trimStart().startsWith('<') ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64');
    }
    if (!buf.length) throw new EInvoiceProviderError('FPT trả về file rỗng', undefined, true);
    return { buffer: buf, mimeType: mime, fileName: name };
  }

  getPdf(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'pdf');
  }

  getXml(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'xml');
  }

  lookupUrl(): string | null {
    // Khách nhập mã tra cứu + MST người bán tại cổng tra cứu FPT
    return LOOKUP_URL;
  }
}
