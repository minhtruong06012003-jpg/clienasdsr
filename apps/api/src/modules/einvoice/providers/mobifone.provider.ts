import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, extractMessage, httpRequest, joinUrl, pick, str } from './http.js';
import { formatDateVN, roundMoney, vatRateCode } from '../einvoice.calc.js';

/**
 * Adapter MobiFone Invoice (mobifoneinvoice.vn) — nền tảng dựa trên lõi M-Invoice, REST JSON tại domain riêng của khách.
 *
 * Tài liệu ("Tài liệu API tích hợp hệ thống HĐĐT MobiFone v4.7") không công khai; cấu trúc dưới đây theo lõi M-Invoice
 * và PHẢI được kiểm tra lại với tài liệu MobiFone cấp:
 *  - Đăng nhập: `POST /api/Account/Login` {username, password, ma_dvcs} -> {token}; header `Authorization: Bear <token>` (một số bản dùng "Bearer").
 *  - Tạo hoá đơn: `POST /api/Invoice68/Save` {editmode: 1, data: [{inv_*..., details: [{data: [...]}]}]} -> {ok, inv_InvoiceAuth_id, inv_invoiceNumber}
 *  - Ký + gửi CQT: `POST /api/Invoice68/SignHSM` {inv_InvoiceAuth_id}
 *  - File: `GET /api/Invoice68/inHoadon?id=<guid>&type=PDF|XML`
 *  - Trạng thái: `GET /api/Invoice68/GetInvoiceStatus?id=<guid>` (tthdon: 0 nháp, 1 đã ký, 2 chờ CQT, 3 đã cấp mã, 4 từ chối, 5 huỷ)
 *  - Huỷ: `POST /api/Invoice68/DeleteInvoice` (nháp) / lập thông báo huỷ; thay thế/điều chỉnh: `Save` với inv_originalId + loại hoá đơn.
 * providerRef = inv_InvoiceAuth_id (GUID của MobiFone).
 */

const TOKEN_TTL_MS = 50 * 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Mã thuế M-Invoice: "0", "5", "8", "10", "KCT", "KKKNT", "KHAC" */
export function mobifoneTaxCode(rate: VatRate): string {
  return vatRateCode(rate);
}

/** Dựng phần tử `data` của Invoice68/Save. Export để test. */
export function buildMobifoneInvoice(payload: InvoicePayload, cfg: ProviderConfig): Record<string, unknown> {
  const b = payload.buyer;
  const anonymous = !!b.anonymous;
  const money = (v: number) => roundMoney(v, 0);
  const sign = (l: InvoiceLine, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);
  const t = payload.totals;
  const o = payload.original;
  const serial = str(cfg.invoiceSeries).trim() || (/^\d/.test(payload.serial) ? payload.serial : `${/^\d/.exec(payload.templateCode)?.[0] ?? ''}${payload.serial}`);

  const inv: Record<string, unknown> = {
    inv_invoiceSeries: serial,
    inv_invoiceIssuedDate: formatDateVN(payload.invoiceDate),
    inv_currencyCode: payload.currency || 'VND',
    inv_exchangeRate: payload.exchangeRate || 1,
    inv_buyerDisplayName: anonymous ? 'Người mua không lấy hoá đơn' : b.name,
    inv_buyerLegalName: anonymous ? '' : str(b.legalName),
    inv_buyerTaxCode: anonymous ? '' : str(b.taxCode),
    inv_buyerAddressLine: str(b.address),
    inv_buyerEmail: str(b.email),
    inv_buyerPhoneNumber: str(b.phone),
    inv_buyerBankAccount: str(b.bankAccount),
    inv_buyerBankName: str(b.bankName),
    inv_buyerIdNo: anonymous ? '' : str(b.idNumber),
    inv_buyerBudgetCode: str(b.budgetCode),
    inv_buyerNotGetInvoice: anonymous ? 1 : 0,
    inv_paymentMethodName: payload.paymentMethod || 'TM/CK',
    inv_discountAmount: money(t.discountTotal),
    inv_TotalAmountWithoutVat: money(t.subtotal),
    inv_vatAmount: money(t.vatTotal),
    inv_TotalAmount: money(t.total),
    inv_amountInWords: t.totalInWords,
    inv_note: str(payload.note),
    so_benh_an: str(payload.orderCode),
    // Mã tham chiếu phía ta (chống trùng / đối soát)
    inv_partnerCode: payload.id,
    details: [
      {
        data: payload.lines.map((l) => ({
          stt_rec0: String(l.index).padStart(3, '0'),
          inv_itemCode: str(l.sku),
          inv_itemName: l.name,
          inv_unitName: str(l.unit),
          inv_quantity: l.kind === 'discount' ? 0 : l.quantity,
          inv_unitPrice: l.kind === 'discount' ? 0 : roundMoney(l.unitPrice, 2),
          inv_discountAmount: money(l.discount),
          inv_TotalAmountWithoutVat: money(sign(l, l.amount)),
          ma_thue: mobifoneTaxCode(l.vatRate),
          inv_vatAmount: money(sign(l, l.vatAmount)),
          inv_TotalAmount: money(sign(l, l.total)),
          // 1 hàng hoá, 2 khuyến mại, 3 chiết khấu, 4 ghi chú (tham khảo tài liệu M-Invoice)
          tchat: l.kind === 'discount' ? 3 : l.kind === 'note' ? 4 : 1,
          ...(l.adjustment ? { inv_adjustmentType: l.adjustment === 'increase' ? 1 : 2 } : {}),
        })),
      },
    ],
  };
  if (o) {
    // Hoá đơn gốc cho thay thế (tchat 3) / điều chỉnh (tchat 5) — tên trường theo lõi M-Invoice, xác minh
    Object.assign(inv, {
      inv_originalId: str(o.providerRef),
      inv_originalInvoiceNumber: o.invoiceNo,
      inv_originalInvoiceSeries: o.serial,
      inv_originalIssuedDate: formatDateVN(o.issuedAt),
      inv_adjustmentReason: o.reason,
      inv_agreementNo: str(o.agreementNo),
      inv_agreementDate: o.agreementDate ? formatDateVN(o.agreementDate) : '',
      tchat: payload.kind === 'REPLACEMENT' ? 3 : 5,
    });
  }
  return inv;
}

export class MobifoneProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'mobifone',
    name: 'MobiFone Invoice',
    description: 'Hoá đơn điện tử MobiFone Invoice (lõi M-Invoice) qua REST API tại domain riêng của doanh nghiệp. Ký HSM phía máy chủ.',
    website: 'https://mobifoneinvoice.vn',
    docsUrl: 'https://mobifoneinvoice.vn',
    signing: 'hsm',
    fields: [
      { key: 'baseUrl', label: 'API URL', type: 'url', required: true, placeholder: 'https://tenkhach.mobifoneinvoice.vn', help: 'Domain MobiFone cấp cho doanh nghiệp (sandbox: domain demo MobiFone cấp). Hệ thống tự nối /api/...' },
      { key: 'username', label: 'Tài khoản', type: 'text', required: true },
      { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
      { key: 'maDvcs', label: 'Mã đơn vị cơ sở (ma_dvcs)', type: 'text', default: 'VP', help: 'Mặc định "VP" nếu doanh nghiệp không có nhiều đơn vị.' },
      { key: 'authPrefix', label: 'Tiền tố header Authorization', type: 'select', default: 'Bear', options: [{ value: 'Bear', label: 'Bear (tài liệu M-Invoice)' }, { value: 'Bearer', label: 'Bearer (chuẩn)' }], help: 'Tài liệu M-Invoice ghi "Bear <token>"; đổi sang Bearer nếu máy chủ trả 401.' },
      { key: 'invoiceSeries', label: 'Ký hiệu ghi đè (inv_invoiceSeries)', type: 'text', placeholder: '1C24TAA', help: 'Để trống = ghép mẫu số + ký hiệu trong cài đặt chung.' },
      { key: 'signPath', label: 'Đường dẫn ký', type: 'text', default: '/api/Invoice68/SignHSM', help: 'SignHSM (ký HSM) hoặc SignInvoiceCertFile (chứng thư file) theo cấu hình tài khoản.' },
      { key: 'lookupUrl', label: 'Trang tra cứu cho khách', type: 'url', placeholder: 'https://tenkhach.mobifoneinvoice.vn/tracuu', help: 'Để trống = {API URL}/tracuu.' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Tài liệu API MobiFone không công khai: đường dẫn (/api/Invoice68/Save, SignHSM, inHoadon, GetInvoiceStatus, DeleteInvoice), tên trường inv_* và mã tchat/tthdon CẦN KIỂM TRA LẠI với tài liệu MobiFone cấp (support.minvoice@mobifone.vn).',
      'Huỷ: adapter gọi DeleteInvoice (phù hợp hoá đơn chưa ký). Hoá đơn đã cấp mã cần lập thông báo sai sót 04/SS trên web MobiFone nếu API không hỗ trợ.',
      'Hoá đơn thay thế/điều chỉnh gửi qua Save kèm inv_originalId; đối chiếu mã loại hoá đơn (tchat) với tài liệu.',
    ],
  };

  private cacheKey(cfg: ProviderConfig) {
    return `${str(cfg.baseUrl)}|${str(cfg.username)}|${str(cfg.maDvcs)}`;
  }

  private async getToken(cfg: ProviderConfig, force = false): Promise<string> {
    const key = this.cacheKey(cfg);
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await httpRequest<Record<string, unknown>>(joinUrl(str(cfg.baseUrl), '/api/Account/Login'), {
      method: 'POST',
      body: { username: str(cfg.username), password: str(cfg.password), ma_dvcs: str(cfg.maDvcs, 'VP') },
      timeoutMs: 30_000,
    });
    assertOk(res, 'Đăng nhập MobiFone Invoice');
    const token = str(pick(res.data, 'token') ?? pick(res.data, 'access_token') ?? pick(res.data, 'data.token'));
    if (!token) throw new EInvoiceProviderError(`MobiFone không trả về token: ${extractMessage(res.data) ?? ''}`.trim(), res.data);
    tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  /** Gọi API kèm token; 401 -> login lại 1 lần; kiểm tra `ok === false` / `error` trong body */
  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, method: 'GET' | 'POST', path: string, body: unknown, what: string, binary = false) {
    const url = joinUrl(str(cfg.baseUrl), path);
    const prefix = str(cfg.authPrefix, 'Bear');
    const send = async (force: boolean) => httpRequest<T>(url, { method, headers: { Authorization: `${prefix} ${await this.getToken(cfg, force)}` }, body: method === 'POST' ? body ?? {} : undefined, timeoutMs: 90_000, binary });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    assertOk(res, what);
    if (!binary) {
      const ok = pick(res.data, 'ok');
      const error = pick(res.data, 'error');
      if (ok === false || (typeof error === 'string' && error.trim())) throw new EInvoiceProviderError(`${what} thất bại: ${extractMessage(res.data) ?? str(error) ?? 'không rõ lý do'}`, res.data, false);
    }
    return res;
  }

  private lookupBase(cfg: ProviderConfig) {
    return str(cfg.lookupUrl).trim() || joinUrl(str(cfg.baseUrl), 'tracuu');
  }

  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    tokenCache.delete(this.cacheKey(cfg));
    await this.getToken(cfg, true);
    return { ok: true, message: 'Đăng nhập MobiFone Invoice thành công.', details: { baseUrl: str(cfg.baseUrl), maDvcs: str(cfg.maDvcs, 'VP') } };
  }

  /** Tạo hoá đơn (Save) rồi ký + gửi CQT (SignHSM) */
  private async saveAndSign(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const saved = await this.call(cfg, 'POST', '/api/Invoice68/Save', { editmode: 1, data: [buildMobifoneInvoice(payload, cfg)] }, 'Tạo hoá đơn MobiFone');
    const sd = saved.data;
    const authId = str(pick(sd, 'inv_InvoiceAuth_id') ?? pick(sd, 'data.inv_InvoiceAuth_id') ?? pick(sd, 'data.0.inv_InvoiceAuth_id') ?? pick(sd, 'id'));
    if (!authId) throw new EInvoiceProviderError('MobiFone không trả về inv_InvoiceAuth_id sau khi tạo hoá đơn', sd, true);
    let signData: unknown = null;
    try {
      const signed = await this.call(cfg, 'POST', str(cfg.signPath, '/api/Invoice68/SignHSM'), { inv_InvoiceAuth_id: authId }, 'Ký & gửi CQT hoá đơn MobiFone');
      signData = signed.data;
    } catch (err) {
      // Hoá đơn đã tạo (nháp) nhưng ký lỗi: báo rõ để admin xử lý trên web MobiFone
      throw new EInvoiceProviderError(`${(err as Error).message}. Hoá đơn nháp đã tạo trên MobiFone (id ${authId}).`, (err as EInvoiceProviderError).raw, false);
    }
    const invoiceNo = str(pick(signData, 'inv_invoiceNumber') ?? pick(sd, 'inv_invoiceNumber') ?? pick(sd, 'data.0.inv_invoiceNumber')).replace(/^0+(?=\d)/, '');
    const lookupCode = str(pick(signData, 'inv_invoiceAuth_code') ?? pick(sd, 'inv_invoiceAuth_code') ?? pick(sd, 'data.0.inv_invoiceAuth_code')) || null;
    return {
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: authId,
      invoiceNo: invoiceNo || null,
      serial: str(pick(sd, 'inv_invoiceSeries')) || str(cfg.invoiceSeries) || payload.serial,
      templateCode: payload.templateCode,
      taxAuthorityCode: str(pick(signData, 'mccqt') ?? pick(signData, 'inv_taxAuthorityCode')) || null,
      lookupCode,
      lookupUrl: this.lookupUrl(cfg, { id: payload.id, lookupCode }),
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw: { save: sd, sign: signData },
    };
  }

  issue(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.saveAndSign(cfg, payload);
  }

  replace(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn thay thế');
    return this.saveAndSign(cfg, payload);
  }

  adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn điều chỉnh');
    return this.saveAndSign(cfg, payload);
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const authId = str(ref.providerRef);
    if (!authId) throw new EInvoiceProviderError('Thiếu inv_InvoiceAuth_id (providerRef) để huỷ trên MobiFone');
    const res = await this.call(cfg, 'POST', '/api/Invoice68/DeleteInvoice', { inv_InvoiceAuth_id: authId, reason: str(reason) || 'Huỷ hoá đơn' }, 'Huỷ hoá đơn MobiFone');
    return { ok: true, message: extractMessage(res.data) || 'Đã huỷ hoá đơn trên MobiFone', raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const authId = str(ref.providerRef);
    if (!authId) throw new EInvoiceProviderError('Thiếu inv_InvoiceAuth_id (providerRef) để tra trạng thái trên MobiFone');
    const res = await this.call(cfg, 'GET', `/api/Invoice68/GetInvoiceStatus?id=${encodeURIComponent(authId)}`, undefined, 'Tra trạng thái hoá đơn MobiFone');
    const d = (pick<Record<string, unknown>>(res.data, 'data') ?? res.data) as Record<string, unknown>;
    const first = (Array.isArray(d) ? d[0] : d) as Record<string, unknown>;
    // tthdon: 0 nháp, 1 đã ký, 2 chờ CQT, 3 đã cấp mã, 4 CQT từ chối, 5 huỷ
    const code = Number(first.tthdon ?? first.status ?? first.trang_thai);
    const map: Record<number, SyncResult['status']> = { 0: 'pending', 1: 'pending', 2: 'pending', 3: 'issued', 4: 'rejected', 5: 'cancelled' };
    const invoiceNo = str(first.inv_invoiceNumber ?? first.so_hd).replace(/^0+(?=\d)/, '');
    const lookupCode = str(first.inv_invoiceAuth_code) || ref.lookupCode || null;
    return {
      status: map[code] ?? (invoiceNo ? 'issued' : 'unknown'),
      invoiceNo: invoiceNo || ref.invoiceNo || null,
      serial: str(first.inv_invoiceSeries) || ref.serial || null,
      templateCode: ref.templateCode ?? null,
      taxAuthorityCode: str(first.mccqt ?? first.inv_taxAuthorityCode) || null,
      lookupCode,
      lookupUrl: this.lookupUrl(cfg, { id: ref.id, lookupCode }),
      issuedAt: first.inv_invoiceIssuedDate ? new Date(String(first.inv_invoiceIssuedDate)) : ref.issuedAt ?? null,
      message: str(first.mota ?? first.message) || null,
      raw: res.data,
    };
  }

  private async file(cfg: ProviderConfig, ref: InvoiceRef, kind: 'PDF' | 'XML'): Promise<FileResult> {
    const authId = str(ref.providerRef);
    if (!authId) throw new EInvoiceProviderError('Thiếu inv_InvoiceAuth_id (providerRef) để tải file từ MobiFone');
    const res = await this.call<Record<string, unknown>>(cfg, 'GET', `/api/Invoice68/inHoadon?id=${encodeURIComponent(authId)}&type=${kind}`, undefined, `Tải ${kind} hoá đơn MobiFone`, true);
    const ct = res.headers.get('content-type') ?? '';
    let buf = res.buffer ?? Buffer.alloc(0);
    if (ct.includes('json')) {
      const json = JSON.parse(buf.toString('utf8')) as unknown;
      const content = str(pick(json, 'data') ?? pick(json, 'file') ?? pick(json, 'base64'));
      if (!content) throw new EInvoiceProviderError('MobiFone không trả về nội dung file', json, true);
      buf = kind === 'XML' && content.trimStart().startsWith('<') ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64');
    }
    if (!buf.length) throw new EInvoiceProviderError('MobiFone trả về file rỗng', undefined, true);
    return { buffer: buf, mimeType: kind === 'PDF' ? 'application/pdf' : 'application/xml', fileName: `${str(ref.invoiceNo) || ref.id}.${kind.toLowerCase()}` };
  }

  getPdf(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'PDF');
  }

  getXml(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'XML');
  }

  lookupUrl(cfg: ProviderConfig, ref: Pick<InvoiceRef, 'lookupCode' | 'id'>): string | null {
    const base = this.lookupBase(cfg);
    if (!str(cfg.baseUrl).trim() && !str(cfg.lookupUrl).trim()) return null;
    const code = str(ref.lookupCode);
    return code ? `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : base;
  }
}
