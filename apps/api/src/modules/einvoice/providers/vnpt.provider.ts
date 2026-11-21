import type { CancelResult, EInvoiceProvider, FileResult, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { joinUrl, soapCall, str, xmlEscape, xmlText } from './http.js';
import { formatDateVN, roundMoney } from '../einvoice.calc.js';

/**
 * Adapter VNPT Invoice (vnpt-invoice.com.vn) — SOAP 1.1 trên các webservice .asmx tại domain riêng của khách:
 *  - PublishService.asmx  : ImportAndPublishInv (tạo + ký HSM + gửi CQT)
 *  - BusinessService.asmx : cancelInv / adjustInv / replaceInv
 *  - PortalService.asmx   : downloadInvPDFFkeyNoPay (PDF base64), downloadInvFkey (XML), listInvByCusFkey (trạng thái)
 *
 * Dữ liệu hoá đơn gửi dạng XML `<Invoices><Inv><key>..</key><Invoice>..</Invoice></Inv></Invoices>`,
 * kết quả chuỗi `OK:<pattern>;<serial>-<key>_<invoiceNo>` hoặc `ERR:<n>` (bảng mã dưới).
 * Fkey (`key`) = `payload.id` để chống trùng; dùng làm providerRef cho mọi thao tác sau.
 */

/** Bảng mã lỗi VNPT -> thông điệp tiếng Việt */
export const VNPT_ERRORS: Record<string, string> = {
  '1': 'Tài khoản đăng nhập sai hoặc không có quyền thực hiện',
  '2': 'Không tồn tại hoá đơn để thay thế/điều chỉnh (hoặc hoá đơn chưa phát hành)',
  '3': 'Dữ liệu XML không đúng định dạng',
  '4': 'Không tồn tại dải hoá đơn (pattern/serial) hoặc dải chưa được cấp quyền',
  '5': 'Lỗi khi lưu hoá đơn — giao dịch đã được hoàn tác, hãy thử lại',
  '6': 'Dải hoá đơn không đủ số để phát hành',
  '7': 'Tài khoản người dùng không khớp với tài khoản dịch vụ (Account) / công ty',
  '8': 'Hoá đơn đã được thanh toán, không thể thao tác',
  '9': 'Trạng thái hoá đơn không cho phép thực hiện (đã huỷ / đã bị thay thế)',
  '10': 'Lô hoá đơn vượt số lượng tối đa cho phép',
  '13': 'Mã tham chiếu (Fkey) đã tồn tại — hoá đơn này đã được gửi trước đó',
  '20': 'Mẫu số (pattern) và ký hiệu (serial) không khớp nhau',
  '21': 'Trùng số hoá đơn / ngày hoá đơn không hợp lệ',
  '29': 'Lỗi chứng thư số (chưa cấu hình HSM hoặc chứng thư hết hạn)',
  '30': 'Hoá đơn không tồn tại trên hệ thống VNPT',
};

/** Kết quả phân tích chuỗi trả về của VNPT */
export type VnptResult = { ok: true; pattern: string | null; items: { serial: string | null; key: string; invoiceNo: string }[]; raw: string } | { ok: false; code: string; message: string; raw: string };

/**
 * Phân tích `OK:1/001;C24TAA-ORDER-123_25;C24TAA-ORDER-124_26` hoặc `ERR:13`.
 * Một số hàm (cancelInv, downloadInv*) chỉ trả `OK:` hoặc chuỗi base64 — hàm này chỉ dùng cho ImportAndPublish/adjust/replace.
 */
export function parseVnptResult(result: string): VnptResult {
  const raw = String(result ?? '').trim();
  if (/^ERR:/i.test(raw)) {
    const code = raw.slice(4).trim().split(/[^0-9]/)[0] || raw.slice(4).trim();
    return { ok: false, code, message: VNPT_ERRORS[code] ?? `VNPT trả lỗi ${raw}`, raw };
  }
  if (!/^OK:?/i.test(raw)) return { ok: false, code: 'UNKNOWN', message: `Phản hồi VNPT không nhận dạng được: ${raw.slice(0, 200)}`, raw };
  const body = raw.replace(/^OK:?/i, '');
  const parts = body.split(';').filter(Boolean);
  // phần tử đầu là pattern (chứa "/") nếu có
  const pattern = parts.length && !parts[0].includes('_') ? parts.shift()! : null;
  const items = parts.map((p) => {
    const us = p.lastIndexOf('_');
    const left = us >= 0 ? p.slice(0, us) : p;
    const invoiceNo = us >= 0 ? p.slice(us + 1) : '';
    const dash = left.indexOf('-');
    return dash >= 0 ? { serial: left.slice(0, dash), key: left.slice(dash + 1), invoiceNo } : { serial: null, key: left, invoiceNo };
  });
  return { ok: true, pattern, items, raw };
}

/** Thuế suất nội bộ -> VATRate của VNPT (-1 không chịu thuế, -2 không kê khai; "khác" không có mã -> để trống) */
export function vnptVatRate(rate: VatRate): number | null {
  if (rate === -3) return null;
  return rate;
}

/** dd/MM/yyyy theo giờ Việt Nam */
function dateVN(d: Date): string {
  const [y, m, day] = formatDateVN(d).split('-');
  return `${day}/${m}/${y}`;
}

/** Thẻ XML (bỏ qua null/undefined, giữ thẻ rỗng cho chuỗi rỗng vì XSD của VNPT thường yêu cầu có thẻ) */
function tag(name: string, value: unknown): string {
  if (value === undefined || value === null) return `<${name}></${name}>`;
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/**
 * Dựng XML hoá đơn cho ImportAndPublishInv / adjustInv / replaceInv. Export để test.
 * Số tiền VND làm tròn 0 lẻ; dòng điều chỉnh truyền số âm/dương theo chiều tăng/giảm.
 */
export function buildVnptInvoiceXml(payload: InvoicePayload): string {
  const b = payload.buyer;
  const anonymous = !!b.anonymous;
  const sign = (l: { adjustment?: 'increase' | 'decrease' }, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);
  const money = (v: number) => roundMoney(v, 0);

  const products = payload.lines
    .map((l) =>
      [
        '<Product>',
        tag('Code', l.sku ?? ''),
        tag('ProdName', l.name),
        tag('ProdUnit', l.unit ?? ''),
        tag('ProdQuantity', l.kind === 'discount' ? '' : l.quantity),
        tag('ProdPrice', l.kind === 'discount' ? '' : roundMoney(l.unitPrice, 2)),
        tag('Discount', money(l.discount)),
        tag('Amount', money(sign(l, l.amount))),
        tag('VATRate', vnptVatRate(l.vatRate) ?? ''),
        tag('VATAmount', money(sign(l, l.vatAmount))),
        tag('Total', money(sign(l, l.total))),
        tag('Extra1', ''),
        tag('Extra2', ''),
        '</Product>',
      ].join(''),
    )
    .join('');

  // Thuế suất cấp hoá đơn: chỉ điền khi mọi dòng cùng một thuế suất (nhiều thuế suất -> để trống, VNPT tổng hợp theo dòng)
  const rates = [...new Set(payload.lines.map((l) => l.vatRate))];
  const invoiceVat = rates.length === 1 ? vnptVatRate(rates[0]) : null;
  const t = payload.totals;
  const o = payload.original;

  const invoice = [
    tag('CusCode', ''),
    tag('CusName', anonymous ? 'Người mua không lấy hoá đơn' : b.legalName || b.name),
    tag('Buyer', anonymous ? '' : b.legalName ? b.name : ''),
    tag('CusAddress', b.address ?? ''),
    tag('CusTaxCode', anonymous ? '' : b.taxCode ?? ''),
    tag('CusPhone', b.phone ?? ''),
    tag('CusEmail', b.email ?? ''),
    tag('CusBankName', b.bankName ?? ''),
    tag('CusBankNo', b.bankAccount ?? ''),
    tag('CusIdNo', anonymous ? '' : b.idNumber ?? ''),
    tag('BudgetCode', b.budgetCode ?? ''),
    tag('PaymentMethod', payload.paymentMethod || 'TM/CK'),
    tag('KindOfService', ''),
    tag('CurrencyUnit', payload.currency || 'VND'),
    tag('ExchangeRate', payload.exchangeRate || 1),
    tag('ArisingDate', dateVN(payload.invoiceDate)),
    `<Products>${products}</Products>`,
    tag('Total', money(t.subtotal)),
    tag('DiscountAmount', money(t.discountTotal)),
    tag('VATRate', invoiceVat ?? ''),
    tag('VATAmount', money(t.vatTotal)),
    tag('Amount', money(t.total)),
    tag('AmountInWords', t.totalInWords),
    tag('Extra1', payload.note ?? ''),
    tag('Extra2', payload.orderCode ?? ''),
    // Tham chiếu hoá đơn gốc (chỉ hoá đơn thay thế/điều chỉnh)
    ...(o
      ? [tag('OriginalInvoiceNo', o.invoiceNo), tag('OriginalSerial', o.serial), tag('OriginalPattern', o.templateCode), tag('OriginalArisingDate', dateVN(o.issuedAt)), tag('AdjustReason', o.reason), tag('AgreementNo', o.agreementNo ?? ''), tag('AgreementDate', o.agreementDate ? dateVN(o.agreementDate) : '')]
      : []),
  ].join('');

  return `<Invoices><Inv><key>${xmlEscape(payload.id)}</key><Invoice>${invoice}</Invoice></Inv></Invoices>`;
}

export class VnptProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'vnpt',
    name: 'VNPT Invoice',
    description: 'Hoá đơn điện tử VNPT (webservice SOAP tại domain riêng của doanh nghiệp). Ký bằng HSM/SmartCA do VNPT lưu trữ.',
    website: 'https://vnpt-invoice.com.vn',
    docsUrl: 'https://vnpt-invoice.com.vn',
    signing: 'hsm',
    fields: [
      { key: 'baseUrl', label: 'Địa chỉ webservice', type: 'url', required: true, placeholder: 'https://tenkhach-tt78admin.vnpt-invoice.com.vn', help: 'Domain admin VNPT cấp cho doanh nghiệp (hệ thống tự nối /PublishService.asmx, /BusinessService.asmx, /PortalService.asmx). Sandbox dùng domain demo VNPT cấp.' },
      { key: 'account', label: 'Tài khoản dịch vụ (Account)', type: 'text', required: true, help: 'Tài khoản webservice do VNPT cấp (khác tài khoản đăng nhập web).' },
      { key: 'acPass', label: 'Mật khẩu dịch vụ (ACpass)', type: 'password', required: true },
      { key: 'username', label: 'Tài khoản người dùng', type: 'text', required: true, help: 'Tài khoản có quyền phát hành hoá đơn trên web VNPT.' },
      { key: 'password', label: 'Mật khẩu người dùng', type: 'password', required: true },
      { key: 'pattern', label: 'Mẫu số (pattern) ghi đè', type: 'text', placeholder: '1/001', help: 'Để trống = dùng mẫu số trong cài đặt chung.' },
      { key: 'serial', label: 'Ký hiệu (serial) ghi đè', type: 'text', placeholder: 'C24TAA', help: 'Để trống = dùng ký hiệu trong cài đặt chung.' },
      { key: 'convert', label: 'Chuyển đổi (convert)', type: 'number', default: 0, help: 'Tham số convert của ImportAndPublishInv; thường để 0.' },
      { key: 'lookupUrl', label: 'Trang tra cứu cho khách', type: 'url', placeholder: 'https://tenkhach-tt78.vnpt-invoice.com.vn/tra-cuu', help: 'Khách nhập mã tra cứu (Fkey / mã bí mật) tại trang này.' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Tài liệu VNPT chỉ cấp cho đối tác; tên thẻ XML theo TT78 (OriginalInvoiceNo, CusIdNo, BudgetCode...) có thể khác theo phiên bản domain — đối chiếu với tài liệu VNPT cấp cho doanh nghiệp.',
      'Hàm đồng bộ dùng listInvByCusFkey của PortalService; cấu trúc XML trả về (Status, MCCQT) cần kiểm tra lại với hệ thống thật.',
      'Fkey = id hoá đơn trong hệ thống; gửi lại cùng Fkey sẽ bị VNPT từ chối (ERR:13) — tránh tạo trùng.',
    ],
  };

  private url(cfg: ProviderConfig, service: 'PublishService' | 'BusinessService' | 'PortalService') {
    return joinUrl(str(cfg.baseUrl), `${service}.asmx`);
  }

  /** Ném lỗi nếu chuỗi trả về là ERR:n */
  private assertNotErr(result: string, what: string, raw: unknown) {
    const r = String(result ?? '').trim();
    if (/^ERR:/i.test(r)) {
      const code = r.slice(4).trim().split(/[^0-9]/)[0];
      const retryable = code === '5';
      throw new EInvoiceProviderError(`${what} thất bại: ${VNPT_ERRORS[code] ?? r} (${r})`, raw, retryable);
    }
  }

  private pattern(cfg: ProviderConfig, payload: InvoicePayload) {
    return str(cfg.pattern).trim() || payload.templateCode;
  }

  private serial(cfg: ProviderConfig, payload: InvoicePayload) {
    return str(cfg.serial).trim() || payload.serial;
  }

  /** Chuyển kết quả OK:... thành IssueResult */
  private toIssueResult(parsed: VnptResult, payload: InvoicePayload, cfg: ProviderConfig, raw: unknown): IssueResult {
    if (!parsed.ok) throw new EInvoiceProviderError(`Phát hành hoá đơn VNPT thất bại: ${parsed.message}`, raw, parsed.code === '5');
    const item = parsed.items.find((i) => i.key === payload.id) ?? parsed.items[0];
    const invoiceNo = str(item?.invoiceNo).trim();
    return {
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: payload.id,
      invoiceNo: invoiceNo || null,
      serial: item?.serial || this.serial(cfg, payload),
      templateCode: parsed.pattern || this.pattern(cfg, payload),
      lookupCode: payload.id,
      lookupUrl: this.lookupUrl(cfg, { id: payload.id, lookupCode: payload.id }),
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw,
    };
  }

  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    // Không có hàm ping riêng: gọi listInvByCusFkey với Fkey giả — nếu sai tài khoản VNPT trả ERR:1, còn lại coi như kết nối được
    const today = dateVN(new Date());
    const { result, raw } = await soapCall(this.url(cfg, 'PortalService'), 'listInvByCusFkey', { fkey: `ping-${Date.now()}`, fromDate: today, toDate: today, userName: str(cfg.username), userPass: str(cfg.password) }, { timeoutMs: 30_000 });
    if (/^ERR:1\b/i.test(result.trim())) throw new EInvoiceProviderError('VNPT từ chối tài khoản người dùng (ERR:1) — kiểm tra tài khoản/mật khẩu và quyền', raw);
    return { ok: true, message: 'Kết nối webservice VNPT thành công.', details: { baseUrl: str(cfg.baseUrl), response: result.slice(0, 200) } };
  }

  async issue(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const { result, raw } = await soapCall(this.url(cfg, 'PublishService'), 'ImportAndPublishInv', {
      Account: str(cfg.account),
      ACpass: str(cfg.acPass),
      xmlInvData: buildVnptInvoiceXml(payload),
      username: str(cfg.username),
      pass: str(cfg.password),
      pattern: this.pattern(cfg, payload),
      serial: this.serial(cfg, payload),
      convert: Number(cfg.convert ?? 0),
    });
    return this.toIssueResult(parseVnptResult(result), payload, cfg, raw);
  }

  /** replaceInv / adjustInv: XML hoá đơn mới + fkey của hoá đơn gốc */
  private async replaceOrAdjust(cfg: ProviderConfig, payload: InvoicePayload, action: 'replaceInv' | 'adjustInv'): Promise<IssueResult> {
    const originalKey = str(payload.original?.providerRef);
    if (!originalKey) throw new EInvoiceProviderError('Thiếu Fkey (providerRef) của hoá đơn gốc trên VNPT');
    const { result, raw } = await soapCall(this.url(cfg, 'BusinessService'), action, {
      Account: str(cfg.account),
      ACpass: str(cfg.acPass),
      xmlInvData: buildVnptInvoiceXml(payload),
      username: str(cfg.username),
      pass: str(cfg.password),
      fkey: originalKey,
      convert: Number(cfg.convert ?? 0),
    });
    return this.toIssueResult(parseVnptResult(result), payload, cfg, raw);
  }

  replace(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.replaceOrAdjust(cfg, payload, 'replaceInv');
  }

  adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.replaceOrAdjust(cfg, payload, 'adjustInv');
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef): Promise<CancelResult> {
    const fkey = str(ref.providerRef) || ref.id;
    const { result, raw } = await soapCall(this.url(cfg, 'BusinessService'), 'cancelInv', { Account: str(cfg.account), ACpass: str(cfg.acPass), fkey, userName: str(cfg.username), userPass: str(cfg.password) });
    this.assertNotErr(result, 'Huỷ hoá đơn VNPT', raw);
    return { ok: true, message: result || 'Đã huỷ hoá đơn trên VNPT', raw };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const fkey = str(ref.providerRef) || ref.id;
    // Khoảng ngày rộng quanh ngày phát hành để chắc chắn lọt hoá đơn
    const base = ref.issuedAt ? new Date(ref.issuedAt) : new Date();
    const from = new Date(base.getTime() - 366 * 86_400_000);
    const to = new Date(Math.min(Date.now(), base.getTime() + 366 * 86_400_000));
    const { result, raw } = await soapCall(this.url(cfg, 'PortalService'), 'listInvByCusFkey', { fkey, fromDate: dateVN(from), toDate: dateVN(to), userName: str(cfg.username), userPass: str(cfg.password) }, { timeoutMs: 30_000 });
    this.assertNotErr(result, 'Tra cứu hoá đơn VNPT', raw);
    const xml = result;
    const invoiceNo = xmlText(xml, 'InvoiceNo') ?? xmlText(xml, 'No');
    const statusCode = xmlText(xml, 'Status') ?? xmlText(xml, 'InvoiceStatus');
    const mccqt = xmlText(xml, 'MCCQT') ?? xmlText(xml, 'TaxAuthorityCode');
    // Mã trạng thái VNPT: 1 chờ ký, 2 đã phát hành, 3 đã huỷ, 4 bị điều chỉnh, 5 bị thay thế
    const map: Record<string, SyncResult['status']> = { '1': 'pending', '2': 'issued', '3': 'cancelled', '4': 'adjusted', '5': 'replaced' };
    let status: SyncResult['status'] = statusCode ? map[statusCode.trim()] ?? 'unknown' : invoiceNo ? 'issued' : 'unknown';
    if (!invoiceNo && !statusCode) status = 'unknown';
    return {
      status,
      invoiceNo: invoiceNo || null,
      serial: xmlText(xml, 'Serial') ?? ref.serial ?? null,
      templateCode: xmlText(xml, 'Pattern') ?? ref.templateCode ?? null,
      taxAuthorityCode: mccqt || null,
      lookupCode: fkey,
      lookupUrl: this.lookupUrl(cfg, ref),
      message: status === 'unknown' ? 'Không đọc được trạng thái từ phản hồi VNPT — xem raw' : null,
      raw,
    };
  }

  /** Tải file qua PortalService: VNPT trả base64 (PDF) hoặc chuỗi XML; `ERR:` nếu lỗi */
  private async download(cfg: ProviderConfig, ref: InvoiceRef, action: 'downloadInvPDFFkeyNoPay' | 'downloadInvFkey'): Promise<string> {
    const fkey = str(ref.providerRef) || ref.id;
    const { result, raw } = await soapCall(this.url(cfg, 'PortalService'), action, { fkey, userName: str(cfg.username), userPass: str(cfg.password) }, { timeoutMs: 60_000 });
    this.assertNotErr(result, 'Tải file hoá đơn VNPT', raw);
    if (!result.trim()) throw new EInvoiceProviderError('VNPT trả về nội dung file rỗng', raw, true);
    return result.trim();
  }

  async getPdf(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult> {
    const b64 = await this.download(cfg, ref, 'downloadInvPDFFkeyNoPay');
    return { buffer: Buffer.from(b64, 'base64'), mimeType: 'application/pdf', fileName: `${str(ref.invoiceNo) || ref.id}.pdf` };
  }

  async getXml(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult> {
    const data = await this.download(cfg, ref, 'downloadInvFkey');
    // Có domain trả XML thô, có domain trả base64 của XML
    const buffer = data.startsWith('<') ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64');
    return { buffer, mimeType: 'application/xml', fileName: `${str(ref.invoiceNo) || ref.id}.xml` };
  }

  lookupUrl(cfg: ProviderConfig, ref: InvoiceRef): string | null {
    const base = str(cfg.lookupUrl).trim();
    if (!base) return null;
    const code = str(ref.lookupCode) || str(ref.providerRef);
    return code ? `${base}${base.includes('?') ? '&' : '?'}fkey=${encodeURIComponent(code)}` : base;
  }
}
