import AdmZip from 'adm-zip';
import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, basicAuth, extractMessage, httpRequest, joinUrl, pick, str } from './http.js';
import { roundMoney } from '../einvoice.calc.js';

/**
 * Adapter Viettel S-Invoice (vinvoice.viettel.vn) — REST JSON theo tài liệu "V2.0 SInvoice: Tài liệu mô tả webservice".
 *
 * Luồng:
 *  - Xác thực: `POST auth/login` lấy access_token (gửi lại qua header `Cookie: access_token=...`), hoặc Basic Auth.
 *    Token được cache trong bộ nhớ theo (baseUrl + username) có hạn; hết hạn (Viettel trả 500 "GENERAL") -> login lại và thử lại 1 lần.
 *  - Phát hành / thay thế / điều chỉnh: `POST InvoiceAPI/InvoiceWS/createInvoice/{supplierTaxCode}` với `adjustmentType` 1/3/5.
 *  - Huỷ: `POST InvoiceAPI/InvoiceWS/cancelTransactionInvoice` (form-urlencoded).
 *  - PDF/ZIP(XML): `POST InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile` (trả base64 `fileToBytes`).
 *  - Đồng bộ: `POST InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid` (số HĐ, reservationCode, codeOfTax).
 *
 * Quy ước dữ liệu Viettel: thời gian = epoch milliseconds; thuế suất `taxPercentage` số (-2 = không chịu thuế, -1 = không kê khai);
 * `invoiceNo` trả về đã gồm ký hiệu (vd "C24TAA123"); `reservationCode` = mã tra cứu cho khách.
 */

/** URL mặc định theo môi trường (hệ demo cũ vẫn phổ biến; hệ 2.0 demo cấp theo tài khoản — nhập lại nếu Viettel cấp URL khác) */
const DEFAULT_URLS = {
  sandbox: 'https://demo-sinvoice.viettel.vn:8443',
  production: 'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api',
} as const;

/** Thời gian giữ token trong cache (Viettel không trả expires_in rõ ràng, giữ 50 phút rồi login lại) */
const TOKEN_TTL_MS = 50 * 60_000;

/** Cache token theo baseUrl + username (dùng chung giữa các lần gọi, không lưu mật khẩu) */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Lấy base URL theo môi trường cấu hình */
function baseUrlOf(cfg: ProviderConfig): string {
  const custom = cfg.environment === 'production' ? str(cfg.productionUrl) : str(cfg.sandboxUrl);
  return (custom.trim() || DEFAULT_URLS[cfg.environment]).replace(/\/+$/, '');
}

/** Body form-urlencoded (bỏ qua giá trị null/undefined) */
function formBody(fields: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

/**
 * Map thuế suất nội bộ -> `taxPercentage` của Viettel.
 * Nội bộ: -1 = KCT, -2 = KKKNT, -3 = khác. Viettel: -2 = không chịu thuế, -1 = không kê khai (ngược với mã nội bộ).
 */
export function viettelTaxPercentage(rate: VatRate): number | null {
  if (rate === -1) return -2;
  if (rate === -2) return -1;
  if (rate === -3) return null;
  return rate;
}

/** transactionUuid phải 10–36 ký tự: dùng id EInvoice, đệm thêm refCode nếu quá ngắn, cắt nếu quá dài */
export function viettelTransactionUuid(payload: InvoicePayload): string {
  let v = String(payload.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (v.length < 10) v = `${v}_${String(payload.refCode ?? '').replace(/[^a-zA-Z0-9_-]/g, '')}`.padEnd(10, '0');
  return v.slice(0, 36);
}

/**
 * Số hoá đơn theo định dạng Viettel (ký hiệu + số, vd "C24TAA123").
 * Hoá đơn phát hành qua adapter này đã lưu `invoiceNo` đúng định dạng; hoá đơn nhập tay có thể chỉ có phần số -> ghép với ký hiệu.
 */
export function viettelInvoiceNo(ref: { invoiceNo?: string | null; serial?: string | null }): string {
  const no = str(ref.invoiceNo).trim();
  if (!no) return '';
  if (/^[A-Za-z]/.test(no)) return no;
  return `${str(ref.serial).trim()}${no.replace(/^0+/, '') || '0'}`;
}

/** `selection` của dòng theo loại dòng: 1 hàng hoá | 2 ghi chú | 3 chiết khấu */
function selectionOf(line: InvoiceLine): number {
  if (line.kind === 'note') return 2;
  if (line.kind === 'discount') return 3;
  return 1;
}

/**
 * Dựng body `createInvoice` từ payload chuẩn. Export để test và tái sử dụng.
 * - `adjustmentType`: 1 gốc | 3 thay thế | 5 điều chỉnh (kèm thông tin hoá đơn gốc).
 * - Dòng điều chỉnh / chiết khấu: Viettel nhận số dương + `isIncreaseItem` (true tăng / false giảm).
 */
export function buildViettelBody(payload: InvoicePayload, cfg: ProviderConfig): Record<string, unknown> {
  const isAdjust = payload.kind === 'ADJUSTMENT';
  const isReplace = payload.kind === 'REPLACEMENT';
  const buyer = payload.buyer;
  const original = payload.original;

  // Thông tin chung
  const generalInvoiceInfo: Record<string, unknown> = {
    invoiceType: str(cfg.invoiceType, '1'),
    templateCode: payload.templateCode,
    invoiceSeries: payload.serial,
    invoiceIssuedDate: payload.invoiceDate.getTime(),
    currencyCode: payload.currency || 'VND',
    exchangeRate: payload.exchangeRate || 1,
    adjustmentType: isReplace ? '3' : isAdjust ? '5' : '1',
    paymentStatus: true,
    cusGetInvoiceRight: true,
    transactionUuid: viettelTransactionUuid(payload),
    validation: 1,
  };
  // Hoá đơn thay thế / điều chỉnh: tham chiếu hoá đơn gốc
  if ((isAdjust || isReplace) && original) {
    const agreementDate = original.agreementDate ?? new Date();
    Object.assign(generalInvoiceInfo, {
      // điều chỉnh tiền (1); điều chỉnh thông tin (2) chưa hỗ trợ vì payload luôn có dòng tiền
      adjustmentInvoiceType: isAdjust ? '1' : undefined,
      originalInvoiceId: viettelInvoiceNo({ invoiceNo: original.invoiceNo, serial: original.serial }),
      originalInvoiceIssueDate: original.issuedAt.getTime(),
      additionalReferenceDesc: (original.agreementNo || `Biên bản thoả thuận ${isReplace ? 'thay thế' : 'điều chỉnh'} hoá đơn`).slice(0, 225),
      additionalReferenceDate: agreementDate.getTime(),
      // 1 = hoá đơn TT78 đã có trên hệ thống Viettel (bắt buộc kèm originalTemplateCode)
      originalInvoiceType: '1',
      originalTemplateCode: original.templateCode || payload.templateCode,
      adjustedNote: original.reason.slice(0, 255),
    });
  }

  // Người mua
  const anonymous = !!buyer.anonymous;
  const buyerInfo: Record<string, unknown> = {
    buyerName: anonymous ? 'Người mua không lấy hoá đơn' : buyer.name,
    buyerLegalName: anonymous ? undefined : buyer.legalName || undefined,
    buyerTaxCode: anonymous ? undefined : buyer.taxCode || undefined,
    buyerAddressLine: buyer.address || undefined,
    buyerEmail: buyer.email || undefined,
    buyerPhoneNumber: buyer.phone || undefined,
    buyerBankAccount: buyer.bankAccount || undefined,
    buyerBankName: buyer.bankName || undefined,
    // 1 = CCCD/CMND — chỉ truyền khi có số giấy tờ (Viettel bắt buộc buyerIdNo khi có buyerIdType)
    buyerIdType: buyer.idNumber ? '1' : undefined,
    buyerIdNo: buyer.idNumber || undefined,
    buyerNotGetInvoice: anonymous ? 1 : 0,
  };

  // Dòng hàng
  const itemInfo = payload.lines.map((l) => {
    const negative = l.amount < 0;
    const abs = (v: number) => roundMoney(Math.abs(v), 2);
    const item: Record<string, unknown> = {
      lineNumber: l.index,
      selection: selectionOf(l),
      itemCode: l.sku || undefined,
      itemName: l.name,
      unitName: l.unit || undefined,
      unitPrice: l.kind === 'discount' ? undefined : abs(l.unitPrice),
      quantity: l.kind === 'discount' ? undefined : l.quantity,
      itemTotalAmountWithoutTax: abs(l.amount),
      taxPercentage: viettelTaxPercentage(l.vatRate),
      taxAmount: abs(l.vatAmount),
      itemTotalAmountWithTax: abs(l.total),
      discount: 0,
      itemDiscount: abs(l.discount),
    };
    // Dòng giảm (chiết khấu riêng / điều chỉnh giảm) -> isIncreaseItem = false; điều chỉnh tăng -> true
    if (l.adjustment) item.isIncreaseItem = l.adjustment === 'increase';
    else if (l.kind === 'discount' || negative) item.isIncreaseItem = false;
    return item;
  });

  // Tổng hợp theo thuế suất
  const taxBreakdowns = payload.totals.breakdown.map((b) => ({
    taxPercentage: viettelTaxPercentage(b.vatRate),
    taxableAmount: roundMoney(Math.abs(b.amount), 2),
    taxAmount: roundMoney(Math.abs(b.vatAmount), 2),
  }));

  const t = payload.totals;
  const summarizeInfo: Record<string, unknown> = {
    totalAmountWithoutTax: roundMoney(Math.abs(t.subtotal), 2),
    totalTaxAmount: roundMoney(Math.abs(t.vatTotal), 2),
    totalAmountWithTax: roundMoney(Math.abs(t.total), 2),
    totalAmountWithTaxInWords: t.totalInWords,
    discountAmount: roundMoney(Math.abs(t.discountTotal), 2),
    // Dấu của tổng (hoá đơn điều chỉnh giảm -> false)
    isTotalAmountPos: t.total >= 0,
    isTotalTaxAmountPos: t.vatTotal >= 0,
    isTotalAmtWithoutTaxPos: t.subtotal >= 0,
    isDiscountAmtPos: true,
  };

  return {
    generalInvoiceInfo,
    buyerInfo,
    sellerInfo: {},
    payments: [{ paymentMethodName: payload.paymentMethod || 'TM/CK' }],
    itemInfo,
    taxBreakdowns,
    summarizeInfo,
    metadata: [],
  };
}

export class ViettelProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'viettel',
    name: 'Viettel S-Invoice',
    description: 'Hoá đơn điện tử Viettel (S-Invoice / vInvoice). Kết nối REST, ký bằng chứng thư HSM/CloudCA cấu hình trên hệ thống Viettel.',
    website: 'https://vinvoice.viettel.vn',
    docsUrl: 'https://www.s-invoice.vn/p/tai-ve.html',
    signing: 'hsm',
    fields: [
      { key: 'username', label: 'Tài khoản API', type: 'text', required: true, placeholder: '0100109106-712', help: 'Thường là MST hoặc MST-đuôi do Viettel cấp; tài khoản phải được bật quyền kết nối API và whitelist IP máy chủ.' },
      { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
      { key: 'supplierTaxCode', label: 'Mã số thuế đơn vị phát hành', type: 'text', required: true, placeholder: '0100109106 hoặc 0100109106-001', help: 'MST doanh nghiệp/chi nhánh đã đăng ký trên S-Invoice.' },
      { key: 'authMode', label: 'Cách xác thực', type: 'select', default: 'token', options: [{ value: 'token', label: 'Token (auth/login, khuyên dùng)' }, { value: 'basic', label: 'Basic Auth mỗi request' }] },
      { key: 'invoiceType', label: 'Loại hoá đơn (invoiceType)', type: 'text', default: '1', help: '1 = GTGT, 2 = bán hàng... theo mẫu đã đăng ký.' },
      { key: 'sandboxUrl', label: 'API URL (sandbox)', type: 'url', env: 'sandbox', default: DEFAULT_URLS.sandbox, help: 'Hệ demo cũ dùng mặc định; hệ 2.0 demo nhập URL Viettel cấp.' },
      { key: 'productionUrl', label: 'API URL (production)', type: 'url', env: 'production', default: DEFAULT_URLS.production },
      { key: 'lookupUrl', label: 'Trang tra cứu cho khách', type: 'url', default: 'https://vinvoice.viettel.vn/tra-cuu', help: 'Khách nhập mã tra cứu (reservationCode) tại trang này.' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Mẫu số (vd 1/001) và ký hiệu (vd C24TAA) lấy từ cài đặt chung của hoá đơn điện tử — phải trùng với thông báo phát hành đã đăng ký trên Viettel.',
      'Phải whitelist IP public của máy chủ trong web quản trị Viettel, nếu không API trả 500 "Request Fail".',
      'Hoá đơn có mã CQT: mã CQT (codeOfTax) thường có sau 30–90 giây — hệ thống sẽ đồng bộ lại tự động.',
      'Chỉ hỗ trợ ký HSM/CloudCA (ký hoàn toàn phía máy chủ); không hỗ trợ USB token.',
    ],
  };

  // ---------------------------------------------------------------------------
  // Xác thực
  // ---------------------------------------------------------------------------
  private cacheKey(cfg: ProviderConfig) {
    return `${baseUrlOf(cfg)}|${str(cfg.username)}`;
  }

  /** Đăng nhập lấy access_token (không cache ở đây — hàm `authHeaders` lo cache) */
  private async login(cfg: ProviderConfig): Promise<string> {
    const res = await httpRequest<Record<string, unknown>>(joinUrl(baseUrlOf(cfg), 'auth/login'), {
      method: 'POST',
      body: { username: str(cfg.username), password: str(cfg.password) },
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const msg = extractMessage(res.data) || `HTTP ${res.status}`;
      throw new EInvoiceProviderError(`Đăng nhập Viettel thất bại: ${msg}`, { status: res.status, body: res.data }, res.status >= 500);
    }
    const token = str(pick(res.data, 'access_token') ?? pick(res.data, 'token'));
    if (!token) throw new EInvoiceProviderError('Viettel không trả về access_token khi đăng nhập', res.data);
    tokenCache.set(this.cacheKey(cfg), { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  /** Header xác thực theo cấu hình: Cookie access_token (có cache) hoặc Basic Auth */
  private async authHeaders(cfg: ProviderConfig, forceLogin = false): Promise<Record<string, string>> {
    if (str(cfg.authMode, 'token') === 'basic') return { Authorization: basicAuth(str(cfg.username), str(cfg.password)) };
    const cached = tokenCache.get(this.cacheKey(cfg));
    const token = !forceLogin && cached && cached.expiresAt > Date.now() ? cached.token : await this.login(cfg);
    return { Cookie: `access_token=${token}` };
  }

  /** Response báo token hết hạn (Viettel trả 500 kèm message "GENERAL" hoặc 401) */
  private isTokenExpired(res: { status: number; data: unknown }): boolean {
    if (res.status === 401) return true;
    const msg = extractMessage(res.data) ?? '';
    return res.status === 500 && /^GENERAL$/i.test(msg.trim());
  }

  /**
   * Gọi API Viettel: tự gắn header xác thực; nếu token hết hạn thì login lại và thử lại 1 lần.
   * `form` = true gửi application/x-www-form-urlencoded, ngược lại JSON.
   */
  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, path: string, body: Record<string, unknown>, opts: { form?: boolean; what?: string; timeoutMs?: number } = {}) {
    const url = joinUrl(baseUrlOf(cfg), path);
    const send = async (force: boolean) => {
      const headers: Record<string, string> = { ...(await this.authHeaders(cfg, force)), Accept: 'application/json' };
      if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return httpRequest<T>(url, { method: 'POST', headers, body: opts.form ? formBody(body) : body, timeoutMs: opts.timeoutMs ?? 90_000 });
    };
    let res = await send(false);
    if (this.isTokenExpired(res) && str(cfg.authMode, 'token') !== 'basic') {
      tokenCache.delete(this.cacheKey(cfg));
      res = await send(true);
    }
    assertOk(res, opts.what ?? `Gọi Viettel ${path}`);
    // HTTP 200 nhưng errorCode != null vẫn là lỗi nghiệp vụ
    const errorCode = pick<string>(res.data, 'errorCode');
    if (errorCode) {
      const desc = str(pick(res.data, 'description')) || errorCode;
      throw new EInvoiceProviderError(`Viettel từ chối (${errorCode}): ${desc}`, res.data, false);
    }
    return res;
  }

  /** Chuyển response createInvoice -> IssueResult */
  private toIssueResult(data: Record<string, unknown>, transactionUuid: string, payload: InvoicePayload, cfg: ProviderConfig): IssueResult {
    const result = (pick<Record<string, unknown>>(data, 'result') ?? {}) as Record<string, unknown>;
    const invoiceNo = str(result.invoiceNo).trim();
    const lookupCode = str(result.reservationCode) || null;
    return {
      // Viettel xử lý bất đồng bộ: chưa có số hoá đơn -> pending, job sync sẽ lấy lại theo transactionUuid
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: transactionUuid,
      invoiceNo: invoiceNo || null,
      serial: payload.serial,
      templateCode: payload.templateCode,
      taxAuthorityCode: str(result.codeOfTax) || null,
      lookupCode,
      lookupUrl: str(cfg.lookupUrl) || null,
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw: data,
    };
  }

  // ---------------------------------------------------------------------------
  // EInvoiceProvider
  // ---------------------------------------------------------------------------
  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    // Đăng nhập thử là cách kiểm tra tài khoản + URL + whitelist IP đơn giản nhất
    tokenCache.delete(this.cacheKey(cfg));
    await this.login(cfg);
    return { ok: true, message: 'Đăng nhập Viettel thành công.', details: { baseUrl: baseUrlOf(cfg), supplierTaxCode: str(cfg.supplierTaxCode) } };
  }

  private async create(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const body = buildViettelBody(payload, cfg);
    const transactionUuid = str(pick(body, 'generalInvoiceInfo.transactionUuid'));
    const res = await this.call(cfg, `InvoiceAPI/InvoiceWS/createInvoice/${encodeURIComponent(str(cfg.supplierTaxCode))}`, body, { what: 'Phát hành hoá đơn Viettel' });
    return this.toIssueResult(res.data, transactionUuid, payload, cfg);
  }

  issue(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.create(cfg, payload);
  }

  replace(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn thay thế');
    return this.create(cfg, payload);
  }

  adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn điều chỉnh');
    return this.create(cfg, payload);
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const invoiceNo = viettelInvoiceNo(ref);
    if (!invoiceNo) throw new EInvoiceProviderError('Hoá đơn chưa có số, không thể huỷ trên Viettel');
    if (!ref.issuedAt) throw new EInvoiceProviderError('Thiếu ngày phát hành hoá đơn (strIssueDate) để huỷ');
    const res = await this.call(
      cfg,
      'InvoiceAPI/InvoiceWS/cancelTransactionInvoice',
      {
        supplierTaxCode: str(cfg.supplierTaxCode),
        templateCode: str(ref.templateCode) || undefined,
        invoiceNo,
        strIssueDate: new Date(ref.issuedAt).getTime(),
        // Viettel bắt buộc tên + ngày văn bản thoả thuận huỷ
        additionalReferenceDesc: `Biên bản huỷ hoá đơn ${invoiceNo}`.slice(0, 400),
        additionalReferenceDate: Date.now(),
        reasonDelete: str(reason).slice(0, 255) || undefined,
      },
      { form: true, what: 'Huỷ hoá đơn Viettel' },
    );
    return { ok: true, message: str(pick(res.data, 'description')) || 'Đã huỷ hoá đơn trên Viettel', raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const transactionUuid = str(ref.providerRef);
    if (!transactionUuid) throw new EInvoiceProviderError('Thiếu transactionUuid (providerRef) để tra cứu trên Viettel');
    const res = await this.call(cfg, 'InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid', { supplierTaxCode: str(cfg.supplierTaxCode), transactionUuid }, { form: true, what: 'Tra cứu hoá đơn Viettel', timeoutMs: 60_000 });
    const list = (pick<Record<string, unknown>[]>(res.data, 'result') ?? []) as Record<string, unknown>[];
    const first = list[0];
    if (!first) return { status: 'pending', message: 'Viettel chưa ghi nhận hoá đơn cho transactionUuid này', raw: res.data };
    const statusText = str(first.status).toLowerCase();
    let status: SyncResult['status'] = str(first.invoiceNo) ? 'issued' : 'pending';
    if (/x[oó]a b[oỏ]|h[uủ]y/.test(statusText)) status = 'cancelled';
    else if (/b[iị] thay th[eế]/.test(statusText)) status = 'replaced';
    else if (/b[iị] [dđ]i[eề]u ch[iỉ]nh/.test(statusText)) status = 'adjusted';
    const issueDate = Number(first.issueDate);
    return {
      status,
      invoiceNo: str(first.invoiceNo) || null,
      serial: ref.serial ?? null,
      templateCode: ref.templateCode ?? null,
      taxAuthorityCode: str(first.codeOfTax) || null,
      lookupCode: str(first.reservationCode) || ref.lookupCode || null,
      lookupUrl: str(cfg.lookupUrl) || null,
      issuedAt: Number.isFinite(issueDate) && issueDate > 0 ? new Date(issueDate) : null,
      message: str(first.exchangeDes) || str(first.status) || null,
      raw: res.data,
    };
  }

  /** Tải file thể hiện (PDF) hoặc gói ZIP (chứa XML) theo số hoá đơn */
  private async representationFile(cfg: ProviderConfig, ref: InvoiceRef, fileType: 'PDF' | 'ZIP'): Promise<{ buffer: Buffer; fileName?: string }> {
    const invoiceNo = viettelInvoiceNo(ref);
    if (!invoiceNo) throw new EInvoiceProviderError('Hoá đơn chưa có số, chưa thể tải file từ Viettel');
    const res = await this.call(
      cfg,
      'InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile',
      { supplierTaxCode: str(cfg.supplierTaxCode), invoiceNo, templateCode: str(ref.templateCode), transactionUuid: str(ref.providerRef) || undefined, fileType },
      { what: `Tải ${fileType} hoá đơn Viettel`, timeoutMs: 60_000 },
    );
    const b64 = str(pick(res.data, 'fileToBytes'));
    if (!b64) throw new EInvoiceProviderError('Viettel không trả về nội dung file (fileToBytes)', res.data, true);
    return { buffer: Buffer.from(b64, 'base64'), fileName: str(pick(res.data, 'fileName')) || undefined };
  }

  async getPdf(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult> {
    const f = await this.representationFile(cfg, ref, 'PDF');
    return { buffer: f.buffer, mimeType: 'application/pdf', fileName: f.fileName ?? `${viettelInvoiceNo(ref)}.pdf` };
  }

  /** Viettel trả XML trong gói ZIP (kèm xsl, logo, QR) -> bóc file .xml ra */
  async getXml(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult> {
    const f = await this.representationFile(cfg, ref, 'ZIP');
    try {
      const zip = new AdmZip(f.buffer);
      const entry = zip.getEntries().find((e) => !e.isDirectory && /\.xml$/i.test(e.entryName));
      if (entry) return { buffer: entry.getData(), mimeType: 'application/xml', fileName: entry.entryName.split('/').pop() };
    } catch {
      // không phải zip hợp lệ -> trả nguyên gói để admin tự kiểm tra
    }
    return { buffer: f.buffer, mimeType: 'application/zip', fileName: f.fileName ?? `${viettelInvoiceNo(ref)}.zip` };
  }

  lookupUrl(cfg: ProviderConfig): string | null {
    // Cổng tra cứu Viettel không nhận mã qua query string công khai — khách nhập reservationCode tại trang
    return str(cfg.lookupUrl).trim() || null;
  }
}
