import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, extractMessage, httpRequest, joinUrl, pick, str } from './http.js';
import { formatDateVN, roundMoney } from '../einvoice.calc.js';

/**
 * Adapter MISA meInvoice (meinvoice.vn) — Integration API (JSON, MISA ký HSM phía máy chủ).
 * Tài liệu: https://doc.meinvoice.vn/itg/ và https://doc.meinvoice.vn/api/.
 *
 *  - Token: `POST /api/integration/auth/token` {appid, taxcode, username, password} -> {Success, Data: <JWT>}; header `Authorization: Bearer`.
 *  - Phát hành: `POST /api/integration/invoice` (hoặc đường dẫn cấu hình, vd `/api/integration/invoice/publishhsm`) body {SignType, InvoiceData[]}.
 *    RefID = payload.id (chống trùng — MISA báo InvoiceDuplicated nếu gửi lại).
 *  - Tải PDF/XML: `POST /api/integration/invoice/Download?downloadDataType=pdf|xml` body [TransactionID].
 *  - Huỷ: `POST /api/integration/invoice/cancel` {TransactionID, InvSeries, CancelReason}.
 *  - Đồng bộ: `POST /api/v3/itg/invoicepublished/invoicestatus` body [TransactionID] -> SendTaxStatus, InvCode (mã CQT).
 * Mã tra cứu cho khách = TransactionID (nhập tại meinvoice.vn/tra-cuu).
 */

const DEFAULT_URLS = { sandbox: 'https://testapi.meinvoice.vn', production: 'https://api.meinvoice.vn' } as const;
const LOOKUP_URLS = { sandbox: 'https://www.test.meinvoice.vn/tra-cuu', production: 'https://www.meinvoice.vn/tra-cuu' } as const;
/** JWT của MISA sống khá lâu; giữ 50 phút rồi xin token mới */
const TOKEN_TTL_MS = 50 * 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function baseUrlOf(cfg: ProviderConfig): string {
  const custom = cfg.environment === 'production' ? str(cfg.productionUrl) : str(cfg.sandboxUrl);
  return (custom.trim() || DEFAULT_URLS[cfg.environment]).replace(/\/+$/, '');
}

/** Tên thuế suất theo MISA: "0%", "5%", "8%", "10%", "KCT", "KKKNT", "KHAC" */
export function misaVatRateName(rate: VatRate): string {
  if (rate === -1) return 'KCT';
  if (rate === -2) return 'KKKNT';
  if (rate === -3) return 'KHAC';
  return `${rate}%`;
}

/**
 * Ký hiệu đầy đủ theo MISA gồm cả số mẫu (vd "1C24TAA").
 * Nếu ký hiệu cấu hình đã có chữ số đầu thì dùng nguyên; nếu chỉ "C24TAA" và mẫu số bắt đầu bằng chữ số -> ghép.
 */
export function misaInvSeries(payload: { templateCode: string; serial: string }, override?: unknown): string {
  const o = str(override).trim();
  if (o) return o;
  const serial = str(payload.serial).trim();
  const tpl = str(payload.templateCode).trim();
  if (/^\d/.test(serial)) return serial;
  const digit = /^\d/.exec(tpl)?.[0];
  return digit ? `${digit}${serial}` : serial;
}

/** ItemType MISA: 1 hàng hoá/dịch vụ, 2 khuyến mại, 3 chiết khấu, 4 ghi chú */
function itemTypeOf(line: InvoiceLine): number {
  if (line.kind === 'discount') return 3;
  if (line.kind === 'note') return 4;
  return 1;
}

/** Dựng 1 phần tử InvoiceData cho MISA từ payload chuẩn. Export để test. */
export function buildMisaInvoice(payload: InvoicePayload, cfg: ProviderConfig): Record<string, unknown> {
  const b = payload.buyer;
  const anonymous = !!b.anonymous;
  const money = (v: number) => roundMoney(v, 0);
  const sign = (l: InvoiceLine, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);

  const detail = payload.lines.map((l) => ({
    ItemType: itemTypeOf(l),
    LineNumber: l.index,
    ItemCode: l.sku || undefined,
    ItemName: l.name,
    UnitName: l.unit || undefined,
    Quantity: l.kind === 'discount' ? undefined : l.quantity,
    UnitPrice: l.kind === 'discount' ? undefined : roundMoney(l.unitPrice, 2),
    DiscountRate: 0,
    DiscountAmountOC: money(l.discount),
    // AmountOC = thành tiền trước chiết khấu; AmountWithoutVATOC = sau chiết khấu (chưa VAT)
    AmountOC: money(sign(l, l.amount + l.discount)),
    AmountWithoutVATOC: money(sign(l, l.amount)),
    VATRateName: misaVatRateName(l.vatRate),
    VATAmountOC: money(sign(l, l.vatAmount)),
  }));

  const t = payload.totals;
  const inv: Record<string, unknown> = {
    RefID: payload.id,
    InvSeries: misaInvSeries(payload, cfg.invSeries),
    InvDate: formatDateVN(payload.invoiceDate),
    CurrencyCode: payload.currency || 'VND',
    ExchangeRate: payload.exchangeRate || 1,
    PaymentMethodName: payload.paymentMethod || 'TM/CK',
    BuyerLegalName: anonymous ? undefined : b.legalName || undefined,
    BuyerTaxCode: anonymous ? undefined : b.taxCode || undefined,
    BuyerAddress: b.address || undefined,
    BuyerCode: undefined,
    BuyerFullName: anonymous ? 'Người mua không lấy hoá đơn' : b.name,
    BuyerEmail: b.email || undefined,
    BuyerPhoneNumber: b.phone || undefined,
    BuyerBankAccount: b.bankAccount || undefined,
    BuyerBankName: b.bankName || undefined,
    BuyerIdentificationNumber: anonymous ? undefined : b.idNumber || undefined,
    BuyerBudgetUnitCode: b.budgetCode || undefined,
    IsBuyerNotGetInvoice: anonymous || undefined,
    TotalAmountWithoutVATOC: money(t.subtotal),
    TotalVATAmountOC: money(t.vatTotal),
    TotalDiscountAmountOC: money(t.discountTotal),
    TotalAmountOC: money(t.total),
    TotalAmountInWords: t.totalInWords,
    InvoiceNote: payload.note || undefined,
    OriginalInvoiceDetail: detail,
    TaxRateInfo: t.breakdown.map((br) => ({ VATRateName: misaVatRateName(br.vatRate), AmountWithoutVATOC: money(br.amount), VATAmountOC: money(br.vatAmount) })),
    OptionUserDefined: { MainCurrency: payload.currency || 'VND', AmountDecimalDigits: '0', QuantityDecimalDigits: '2', UnitPriceDecimalDigits: '2' },
  };

  // Hoá đơn thay thế (ReferenceType 1) / điều chỉnh (ReferenceType 2): tham chiếu hoá đơn gốc
  const o = payload.original;
  if (payload.kind !== 'ORIGINAL' && o) {
    Object.assign(inv, {
      ReferenceType: payload.kind === 'REPLACEMENT' ? 1 : 2,
      OriginalInvNo: o.invoiceNo,
      OriginalInvSeries: misaInvSeries({ templateCode: o.templateCode, serial: o.serial }),
      OriginalInvTemplateNo: o.templateCode,
      OriginalInvDate: formatDateVN(o.issuedAt),
      OriginalInvTransactionID: o.providerRef || undefined,
      OriginalInvTaxAuthorityCode: o.taxAuthorityCode || undefined,
      [payload.kind === 'REPLACEMENT' ? 'ReplaceReason' : 'AdjustmentReason']: o.reason,
      AgreementNo: o.agreementNo || undefined,
      AgreementDate: o.agreementDate ? formatDateVN(o.agreementDate) : undefined,
    });
  }
  return inv;
}

export class MisaProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'misa',
    name: 'MISA meInvoice',
    description: 'Hoá đơn điện tử MISA meInvoice qua Integration API (JSON). MISA ký bằng HSM/MISA eSign trên cloud, phù hợp phát hành tự động.',
    website: 'https://www.meinvoice.vn',
    docsUrl: 'https://doc.meinvoice.vn/itg/',
    signing: 'hsm',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', required: true, help: 'Mã ứng dụng tích hợp do MISA cấp cho đối tác.' },
      { key: 'taxCode', label: 'Mã số thuế đơn vị', type: 'text', required: true, placeholder: '0101234567' },
      { key: 'username', label: 'Tài khoản meInvoice', type: 'text', required: true },
      { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
      { key: 'signType', label: 'Kiểu ký (SignType)', type: 'select', default: '2', options: [{ value: '2', label: '2 — HSM (ký ngay)' }, { value: '3', label: '3 — HSM bất đồng bộ' }, { value: '5', label: '5 — Hoá đơn máy tính tiền' }, { value: '4', label: '4 — Vé không mã, không ký' }], help: 'SignType 1 (USB token) cần MISA SignedService ở máy khách — không hỗ trợ ở đây.' },
      { key: 'publishPath', label: 'Đường dẫn API phát hành', type: 'text', default: '/api/integration/invoice', help: 'Mặc định /api/integration/invoice; một số tài khoản dùng /api/integration/invoice/publishhsm.' },
      { key: 'invSeries', label: 'Ký hiệu ghi đè (InvSeries)', type: 'text', placeholder: '1C24TAA', help: 'Để trống = ghép mẫu số + ký hiệu trong cài đặt chung (vd 1 + C24TAA).' },
      { key: 'sandboxUrl', label: 'API URL (sandbox)', type: 'url', env: 'sandbox', default: DEFAULT_URLS.sandbox },
      { key: 'productionUrl', label: 'API URL (production)', type: 'url', env: 'production', default: DEFAULT_URLS.production },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Cần đăng ký App ID tích hợp với MISA; tài khoản meInvoice phải có quyền phát hành và ký hiệu đã có thông báo phát hành.',
      'Tên trường tham chiếu hoá đơn gốc (OriginalInvNo, ReferenceType, AdjustmentReason...) theo bản tài liệu 2025 — đối chiếu lại nếu MISA báo RequireInfo_*.',
      'Kiểm tra trạng thái CQT dùng API v3 /api/v3/itg/invoicepublished/invoicestatus với cùng token (header CompanyTaxCode).',
    ],
  };

  // ---------------------------------------------------------------------------
  // Token
  // ---------------------------------------------------------------------------
  private cacheKey(cfg: ProviderConfig) {
    return `${baseUrlOf(cfg)}|${str(cfg.taxCode)}|${str(cfg.username)}`;
  }

  private async getToken(cfg: ProviderConfig, force = false): Promise<string> {
    const key = this.cacheKey(cfg);
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await httpRequest<Record<string, unknown>>(joinUrl(baseUrlOf(cfg), '/api/integration/auth/token'), {
      method: 'POST',
      body: { appid: str(cfg.appId), taxcode: str(cfg.taxCode), username: str(cfg.username), password: str(cfg.password) },
      timeoutMs: 30_000,
    });
    assertOk(res, 'Lấy token MISA');
    const ok = pick(res.data, 'Success') ?? pick(res.data, 'success');
    const token = str(pick(res.data, 'Data') ?? pick(res.data, 'data'));
    if (ok === false || !token) {
      const code = str(pick(res.data, 'ErrorCode') ?? pick(res.data, 'errorCode'));
      const human: Record<string, string> = { InvalidAppID: 'App ID không hợp lệ', InactiveAppID: 'App ID chưa được kích hoạt', UnAuthorize: 'Sai tài khoản/mật khẩu hoặc không có quyền' };
      throw new EInvoiceProviderError(`Đăng nhập MISA thất bại: ${human[code] ?? code ?? extractMessage(res.data) ?? 'không rõ lý do'}`, res.data);
    }
    tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  /** Gọi API MISA kèm Bearer token; 401 -> lấy token mới và thử lại 1 lần */
  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, path: string, body: unknown, what: string, extraHeaders: Record<string, string> = {}) {
    const url = joinUrl(baseUrlOf(cfg), path);
    const send = async (force: boolean) => httpRequest<T>(url, { method: 'POST', headers: { Authorization: `Bearer ${await this.getToken(cfg, force)}`, ...extraHeaders }, body, timeoutMs: 90_000 });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    assertOk(res, what);
    return res;
  }

  /** Ném lỗi nếu response báo thất bại ở lớp ngoài (success=false / errorCode) */
  private assertSuccess(data: unknown, what: string) {
    const success = pick(data, 'success') ?? pick(data, 'Success');
    const errorCode = str(pick(data, 'errorCode') ?? pick(data, 'ErrorCode'));
    if (success === false || (errorCode && errorCode !== 'null')) {
      const desc = str(pick(data, 'descriptionErrorCode') ?? pick(data, 'DescriptionErrorCode')) || extractMessage(data) || errorCode;
      throw new EInvoiceProviderError(`${what} thất bại: ${desc}${errorCode && desc !== errorCode ? ` (${errorCode})` : ''}`, data, false);
    }
  }

  private lookupBase(cfg: ProviderConfig) {
    return LOOKUP_URLS[cfg.environment];
  }

  /** Response phát hành -> IssueResult (kiểm tra cả ErrorCode từng phần tử) */
  private toIssueResult(data: Record<string, unknown>, payload: InvoicePayload, cfg: ProviderConfig): IssueResult {
    this.assertSuccess(data, 'Phát hành hoá đơn MISA');
    const list = (pick<Record<string, unknown>[]>(data, 'createInvoiceResult') ?? pick<Record<string, unknown>[]>(data, 'CreateInvoiceResult') ?? []) as Record<string, unknown>[];
    const item = list.find((i) => str(i.RefID) === payload.id) ?? list[0];
    if (!item) throw new EInvoiceProviderError('MISA không trả về kết quả hoá đơn (createInvoiceResult rỗng)', data, true);
    const itemErr = str(item.ErrorCode);
    if (itemErr) throw new EInvoiceProviderError(`MISA từ chối hoá đơn: ${itemErr}`, data, false);
    const transactionId = str(item.TransactionID);
    if (!transactionId) throw new EInvoiceProviderError('MISA không trả về TransactionID', data, true);
    const invoiceNo = str(item.InvNo).trim();
    const publish = (pick<Record<string, unknown>[]>(data, 'publishInvoiceResult') ?? []) as Record<string, unknown>[];
    const pub = publish.find((p) => str(p.TransactionID) === transactionId || str(p.RefID) === payload.id);
    return {
      // SignType 3 (bất đồng bộ) có thể chưa có số -> pending để job sync lấy lại
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: transactionId,
      invoiceNo: invoiceNo || null,
      serial: str(item.InvSeries) || misaInvSeries(payload, cfg.invSeries),
      templateCode: str(item.InvTemplateNo) || payload.templateCode,
      taxAuthorityCode: str(pub?.InvCode ?? item.InvCode) || null,
      lookupCode: transactionId,
      lookupUrl: `${this.lookupBase(cfg)}?code=${encodeURIComponent(transactionId)}`,
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw: data,
    };
  }

  // ---------------------------------------------------------------------------
  // EInvoiceProvider
  // ---------------------------------------------------------------------------
  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    tokenCache.delete(this.cacheKey(cfg));
    const token = await this.getToken(cfg, true);
    // Lấy danh sách ký hiệu để xác nhận tài khoản có quyền và hiển thị cho admin đối chiếu
    let series: unknown = undefined;
    try {
      const res = await httpRequest(joinUrl(baseUrlOf(cfg), '/api/integration/invoice/invseries'), { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30_000 });
      if (res.ok) series = pick(res.data, 'Data') ?? pick(res.data, 'data') ?? res.data;
    } catch {
      // không bắt buộc
    }
    return { ok: true, message: 'Đăng nhập MISA meInvoice thành công.', details: { baseUrl: baseUrlOf(cfg), taxCode: str(cfg.taxCode), invSeries: series } };
  }

  private async publish(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const body = { SignType: Number(cfg.signType ?? 2), InvoiceData: [buildMisaInvoice(payload, cfg)], PublishInvoiceData: null };
    const res = await this.call(cfg, str(cfg.publishPath, '/api/integration/invoice'), body, 'Phát hành hoá đơn MISA');
    return this.toIssueResult(res.data, payload, cfg);
  }

  issue(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.publish(cfg, payload);
  }

  replace(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn thay thế');
    return this.publish(cfg, payload);
  }

  adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn điều chỉnh');
    return this.publish(cfg, payload);
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const transactionId = str(ref.providerRef);
    if (!transactionId) throw new EInvoiceProviderError('Thiếu TransactionID (providerRef) để huỷ trên MISA');
    const invSeries = str(ref.serial) ? misaInvSeries({ templateCode: str(ref.templateCode), serial: str(ref.serial) }, cfg.invSeries) : str(cfg.invSeries);
    const res = await this.call(cfg, '/api/integration/invoice/cancel', { TransactionID: transactionId, InvSeries: invSeries, CancelReason: str(reason) || 'Huỷ hoá đơn' }, 'Huỷ hoá đơn MISA');
    this.assertSuccess(res.data, 'Huỷ hoá đơn MISA');
    return { ok: true, message: extractMessage(res.data) || 'Đã huỷ hoá đơn trên MISA', raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const transactionId = str(ref.providerRef);
    if (!transactionId) throw new EInvoiceProviderError('Thiếu TransactionID (providerRef) để tra trạng thái trên MISA');
    const series = str(ref.serial) || str(cfg.invSeries);
    const withCode = /^\d?C/i.test(series);
    // HĐ có mã dùng đường dẫn /code/itg/..., HĐ không mã dùng /itg/...
    const path = withCode ? '/api/v3/code/itg/invoicepublished/invoicestatus' : '/api/v3/itg/invoicepublished/invoicestatus';
    const res = await this.call(cfg, path, [transactionId], 'Tra trạng thái hoá đơn MISA', { CompanyTaxCode: str(cfg.taxCode) });
    this.assertSuccess(res.data, 'Tra trạng thái hoá đơn MISA');
    const list = (pick<Record<string, unknown>[]>(res.data, 'Data') ?? pick<Record<string, unknown>[]>(res.data, 'data') ?? (Array.isArray(res.data) ? res.data : [])) as Record<string, unknown>[];
    const it = list.find((i) => str(i.TransactionID) === transactionId) ?? list[0];
    if (!it) return { status: 'unknown', message: 'MISA không trả về trạng thái cho TransactionID này', raw: res.data };
    const sendTax = Number(it.SendTaxStatus);
    const deleted = it.IsDelete === true || it.IsDeleted === true;
    let status: SyncResult['status'];
    if (deleted) status = 'cancelled';
    else if (withCode) {
      // HĐ có mã: 0 chờ cấp mã | 1 lỗi | 2 đã cấp mã | 3 từ chối | 4 lỗi
      status = sendTax === 2 ? 'issued' : sendTax === 3 ? 'rejected' : sendTax === 0 ? 'pending' : 'unknown';
    } else {
      // HĐ không mã: 0 chưa gửi | 1 đã gửi | 2 CQT chấp nhận | 3 từ chối | 4 lỗi
      status = sendTax === 2 || sendTax === 1 ? 'issued' : sendTax === 3 ? 'rejected' : sendTax === 0 ? 'pending' : 'unknown';
    }
    const invDate = str(it.InvDate);
    return {
      status,
      invoiceNo: str(it.InvNo) || ref.invoiceNo || null,
      serial: str(it.InvSeries) || ref.serial || null,
      templateCode: str(it.InvTemplateNo) || ref.templateCode || null,
      taxAuthorityCode: str(it.InvCode ?? it.TaxAuthorityCode) || null,
      lookupCode: transactionId,
      lookupUrl: `${this.lookupBase(cfg)}?code=${encodeURIComponent(transactionId)}`,
      issuedAt: invDate ? new Date(invDate) : null,
      message: str(it.DeletedReason) || str(it.Message) || null,
      raw: res.data,
    };
  }

  /** Tải PDF/XML qua /invoice/Download */
  private async download(cfg: ProviderConfig, ref: InvoiceRef, type: 'pdf' | 'xml'): Promise<FileResult> {
    const transactionId = str(ref.providerRef);
    if (!transactionId) throw new EInvoiceProviderError('Thiếu TransactionID (providerRef) để tải file từ MISA');
    const series = str(ref.serial) || str(cfg.invSeries);
    const withCode = /^\d?C/i.test(series);
    const res = await this.call(cfg, `/api/integration/invoice/Download?invoiceWithCode=${withCode}&invoiceCalcu=false&downloadDataType=${type}`, [transactionId], `Tải ${type.toUpperCase()} hoá đơn MISA`);
    this.assertSuccess(res.data, `Tải ${type.toUpperCase()} hoá đơn MISA`);
    const list = (pick<Record<string, unknown>[]>(res.data, 'data') ?? pick<Record<string, unknown>[]>(res.data, 'Data') ?? []) as Record<string, unknown>[];
    const it = list.find((i) => str(i.TransactionID) === transactionId) ?? list[0];
    if (!it || str(it.ErrorCode)) throw new EInvoiceProviderError(`MISA không trả về file: ${str(it?.ErrorCode) || 'danh sách rỗng'}`, res.data, !it);
    const content = str(it.data ?? it.Data);
    if (!content) throw new EInvoiceProviderError('Nội dung file từ MISA rỗng', res.data, true);
    const name = `${str(ref.invoiceNo) || transactionId}.${type}`;
    if (type === 'xml') return { buffer: content.trimStart().startsWith('<') ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64'), mimeType: 'application/xml', fileName: name };
    return { buffer: Buffer.from(content, 'base64'), mimeType: 'application/pdf', fileName: name };
  }

  getPdf(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.download(cfg, ref, 'pdf');
  }

  getXml(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.download(cfg, ref, 'xml');
  }

  lookupUrl(cfg: ProviderConfig, ref: InvoiceRef): string | null {
    const code = str(ref.lookupCode) || str(ref.providerRef);
    return code ? `${this.lookupBase(cfg)}?code=${encodeURIComponent(code)}` : this.lookupBase(cfg);
  }
}
