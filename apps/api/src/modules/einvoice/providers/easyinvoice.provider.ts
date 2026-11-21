import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, extractMessage, httpRequest, joinUrl, pick, str } from './http.js';
import { formatDateVN, roundMoney } from '../einvoice.calc.js';

/**
 * Adapter EasyInvoice (Softdreams, easyinvoice.vn) — REST JSON, xác thực bằng header `Authentication: base64(user:pass)`.
 *
 * Tài liệu API của Softdreams KHÔNG công khai (chỉ cấp cho đối tác). Cấu trúc dưới đây dựng theo
 * "Tài liệu tích hợp EasyInvoice API v2 (TT78)" theo kiến thức tốt nhất — mọi đường dẫn / tên trường
 * phải được kiểm tra lại với tài liệu đối tác trước khi dùng thật:
 *  - Phát hành: `POST /api/publish/importAndIssueInvoice` {Pattern, Serial, Invoices[{Ikey, ...}]}
 *  - Thay thế / điều chỉnh: `POST /api/publish/replaceInvoice` / `adjustInvoice` (+ IkeyOld)
 *  - Huỷ: `POST /api/business/cancelInvoice` {Ikey, Pattern, Serial, Reason}
 *  - PDF/XML: `POST /api/business/getInvoicePdf` / `getInvoiceXml`
 *  - Trạng thái: `POST /api/business/getInvoiceStatus`
 * `Status` = 2 là thành công; Ikey = payload.id (idempotency); LookupCode = mã tra cứu cho khách.
 */

/** Thuế suất nội bộ -> VATRate EasyInvoice (-1 KCT, -2 KKKNT theo mô hình giống VNPT) */
export function easyVatRate(rate: VatRate): number | null {
  return rate === -3 ? null : rate;
}

/** dd/MM/yyyy theo giờ VN */
function dateVN(d: Date): string {
  const [y, m, day] = formatDateVN(d).split('-');
  return `${day}/${m}/${y}`;
}

/** Dựng 1 phần tử Invoices cho EasyInvoice. Export để test. */
export function buildEasyInvoice(payload: InvoicePayload): Record<string, unknown> {
  const b = payload.buyer;
  const anonymous = !!b.anonymous;
  const money = (v: number) => roundMoney(v, 0);
  const sign = (l: InvoiceLine, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);
  const t = payload.totals;
  const rates = [...new Set(payload.lines.map((l) => l.vatRate))];
  const o = payload.original;

  const inv: Record<string, unknown> = {
    Ikey: payload.id,
    ArisingDate: dateVN(payload.invoiceDate),
    CusCode: '',
    Buyer: anonymous ? 'Người mua không lấy hoá đơn' : b.name,
    CusName: anonymous ? '' : str(b.legalName),
    CusTaxCode: anonymous ? '' : str(b.taxCode),
    CusAddress: str(b.address),
    CusPhone: str(b.phone),
    CusEmail: str(b.email),
    CusBankName: str(b.bankName),
    CusBankNo: str(b.bankAccount),
    CusIdNo: anonymous ? '' : str(b.idNumber),
    BudgetCode: str(b.budgetCode),
    PaymentMethod: payload.paymentMethod || 'TM/CK',
    CurrencyUnit: payload.currency || 'VND',
    ExchangeRate: payload.exchangeRate || 1,
    Extra1: str(payload.note),
    Extra2: str(payload.orderCode),
    Total: money(t.subtotal),
    Discount: money(t.discountTotal),
    VATRate: rates.length === 1 ? easyVatRate(rates[0]) : null,
    VATAmount: money(t.vatTotal),
    Amount: money(t.total),
    AmountInWords: t.totalInWords,
    Products: payload.lines.map((l) => ({
      Code: str(l.sku),
      ProdName: l.name,
      ProdUnit: str(l.unit),
      ProdQuantity: l.kind === 'discount' ? 0 : l.quantity,
      ProdPrice: l.kind === 'discount' ? 0 : roundMoney(l.unitPrice, 2),
      Discount: money(l.discount),
      Amount: money(sign(l, l.amount)),
      VATRate: easyVatRate(l.vatRate),
      VATAmount: money(sign(l, l.vatAmount)),
      Total: money(sign(l, l.total)),
      ...(l.adjustment ? { IsIncrease: l.adjustment === 'increase' } : {}),
    })),
  };
  if (o) {
    // Hoá đơn gốc cho thay thế / điều chỉnh (tên trường theo kiến thức — xác minh)
    Object.assign(inv, {
      IkeyOld: str(o.providerRef) || undefined,
      OriginalInvoiceNo: o.invoiceNo,
      OriginalPattern: o.templateCode,
      OriginalSerial: o.serial,
      OriginalArisingDate: dateVN(o.issuedAt),
      Reason: o.reason,
      AgreementNo: str(o.agreementNo),
      AgreementDate: o.agreementDate ? dateVN(o.agreementDate) : '',
      ...(payload.kind === 'ADJUSTMENT' ? { AdjustmentType: 1 } : {}),
    });
  }
  return inv;
}

export class EasyInvoiceProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'easyinvoice',
    name: 'EasyInvoice (Softdreams)',
    description: 'Hoá đơn điện tử EasyInvoice của Softdreams qua REST API (tài liệu đối tác). Ký HSM phía Softdreams.',
    website: 'https://easyinvoice.vn',
    docsUrl: 'https://easyinvoice.vn/tai-nguyen/',
    signing: 'hsm',
    fields: [
      { key: 'baseUrl', label: 'API URL', type: 'url', required: true, placeholder: 'https://<MST>.easyinvoice.com.vn', help: 'Production: subdomain theo MST doanh nghiệp; sandbox: host UAT do Softdreams cấp (vd https://demo.easyinvoice.com.vn).' },
      { key: 'username', label: 'Tài khoản API', type: 'text', required: true },
      { key: 'password', label: 'Mật khẩu API', type: 'password', required: true },
      { key: 'pattern', label: 'Mẫu số ghi đè (Pattern)', type: 'text', placeholder: '1/001', help: 'Để trống = dùng mẫu số trong cài đặt chung.' },
      { key: 'serial', label: 'Ký hiệu ghi đè (Serial)', type: 'text', placeholder: 'C24TAA', help: 'Để trống = dùng ký hiệu trong cài đặt chung.' },
      { key: 'lookupUrl', label: 'Trang tra cứu cho khách', type: 'url', placeholder: 'https://<MST>.easyinvoice.com.vn/search', help: 'Để trống = dùng {API URL}/search?code={LookupCode}.' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
    notes: [
      'Tài liệu API Softdreams không công khai: đường dẫn (/api/publish/importAndIssueInvoice, /api/business/getInvoicePdf...), tên trường và bảng mã Status CẦN KIỂM TRA LẠI với tài liệu đối tác Softdreams cấp.',
      'Status = 2 được coi là thành công; các mã khác coi là lỗi và hiển thị Message của Softdreams.',
      'Ikey = id hoá đơn trong hệ thống (chống trùng).',
    ],
  };

  private headers(cfg: ProviderConfig): Record<string, string> {
    // Softdreams dùng header "Authentication" (không phải Authorization) chứa base64(user:pass)
    return { Authentication: Buffer.from(`${str(cfg.username)}:${str(cfg.password)}`, 'utf8').toString('base64'), 'Content-Type': 'application/json' };
  }

  private pattern(cfg: ProviderConfig, fallback?: string | null) {
    return str(cfg.pattern).trim() || str(fallback);
  }

  private serial(cfg: ProviderConfig, fallback?: string | null) {
    return str(cfg.serial).trim() || str(fallback);
  }

  /** Gọi API và kiểm tra Status == 2 */
  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, path: string, body: unknown, what: string) {
    const res = await httpRequest<T>(joinUrl(str(cfg.baseUrl), path), { method: 'POST', headers: this.headers(cfg), body, timeoutMs: 90_000 });
    assertOk(res, what);
    const status = Number(pick(res.data, 'Status') ?? pick(res.data, 'status'));
    if (Number.isFinite(status) && status !== 2) {
      const msg = str(pick(res.data, 'Message') ?? pick(res.data, 'message')) || extractMessage(res.data) || `Status=${status}`;
      // Status 1 = sai xác thực (không thử lại); các mã khác coi là lỗi dữ liệu
      throw new EInvoiceProviderError(`${what} thất bại: ${msg} (Status ${status})`, res.data, false);
    }
    return res;
  }

  private toIssueResult(data: unknown, payload: InvoicePayload, cfg: ProviderConfig): IssueResult {
    const list = (pick<Record<string, unknown>[]>(data, 'Data.Invoices') ?? pick<Record<string, unknown>[]>(data, 'Data') ?? []) as Record<string, unknown>[];
    const item = (Array.isArray(list) ? list.find((i) => str(i.Ikey) === payload.id) ?? list[0] : undefined) ?? {};
    const invoiceNo = str(item.No ?? item.InvoiceNo).trim();
    const lookupCode = str(item.LookupCode ?? item.MTC) || null;
    return {
      status: invoiceNo ? 'issued' : 'pending',
      providerRef: payload.id,
      invoiceNo: invoiceNo || null,
      serial: str(item.Serial) || this.serial(cfg, payload.serial),
      templateCode: str(item.Pattern) || this.pattern(cfg, payload.templateCode),
      taxAuthorityCode: str(item.MCCQT) || null,
      lookupCode,
      lookupUrl: this.lookupUrl(cfg, { id: payload.id, lookupCode }),
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw: data,
    };
  }

  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    // Không có endpoint ping công khai: tra trạng thái một Ikey giả — Status 1 (sai xác thực) sẽ bị ném lỗi, còn lại coi là kết nối OK
    const res = await httpRequest(joinUrl(str(cfg.baseUrl), '/api/business/getInvoiceStatus'), { method: 'POST', headers: this.headers(cfg), body: { Ikey: `ping-${Date.now()}`, Pattern: this.pattern(cfg), Serial: this.serial(cfg) }, timeoutMs: 30_000 });
    assertOk(res, 'Kiểm tra kết nối EasyInvoice');
    const status = Number(pick(res.data, 'Status'));
    if (status === 1) throw new EInvoiceProviderError('EasyInvoice từ chối xác thực (Status 1) — kiểm tra tài khoản/mật khẩu API', res.data);
    return { ok: true, message: 'Kết nối EasyInvoice thành công.', details: { baseUrl: str(cfg.baseUrl), response: res.data as Record<string, unknown> } };
  }

  private async publish(cfg: ProviderConfig, payload: InvoicePayload, path: string, what: string) {
    const res = await this.call(cfg, path, { Pattern: this.pattern(cfg, payload.templateCode), Serial: this.serial(cfg, payload.serial), Invoices: [buildEasyInvoice(payload)] }, what);
    return this.toIssueResult(res.data, payload, cfg);
  }

  issue(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.publish(cfg, payload, '/api/publish/importAndIssueInvoice', 'Phát hành hoá đơn EasyInvoice');
  }

  replace(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn thay thế');
    return this.publish(cfg, payload, '/api/publish/replaceInvoice', 'Lập hoá đơn thay thế EasyInvoice');
  }

  adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    if (!payload.original) throw new EInvoiceProviderError('Thiếu thông tin hoá đơn gốc để lập hoá đơn điều chỉnh');
    return this.publish(cfg, payload, '/api/publish/adjustInvoice', 'Lập hoá đơn điều chỉnh EasyInvoice');
  }

  private refBody(cfg: ProviderConfig, ref: InvoiceRef) {
    return { Ikey: str(ref.providerRef) || ref.id, Pattern: this.pattern(cfg, ref.templateCode), Serial: this.serial(cfg, ref.serial) };
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const res = await this.call(cfg, '/api/business/cancelInvoice', { ...this.refBody(cfg, ref), Reason: str(reason) || 'Huỷ hoá đơn' }, 'Huỷ hoá đơn EasyInvoice');
    return { ok: true, message: str(pick(res.data, 'Message')) || 'Đã huỷ hoá đơn trên EasyInvoice', raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const res = await this.call(cfg, '/api/business/getInvoiceStatus', this.refBody(cfg, ref), 'Tra trạng thái hoá đơn EasyInvoice');
    const d = (pick<Record<string, unknown>>(res.data, 'Data') ?? {}) as Record<string, unknown>;
    const first = (Array.isArray(d) ? d[0] : d) as Record<string, unknown>;
    // 0 nháp, 1 chờ ký, 2 đã phát hành, 3 huỷ, 4 bị điều chỉnh, 5 bị thay thế
    const map: Record<number, SyncResult['status']> = { 0: 'pending', 1: 'pending', 2: 'issued', 3: 'cancelled', 4: 'adjusted', 5: 'replaced' };
    const code = Number(first.Status ?? first.InvoiceStatus);
    return {
      status: map[code] ?? 'unknown',
      invoiceNo: str(first.No ?? first.InvoiceNo) || ref.invoiceNo || null,
      serial: str(first.Serial) || ref.serial || null,
      templateCode: str(first.Pattern) || ref.templateCode || null,
      taxAuthorityCode: str(first.MCCQT) || null,
      lookupCode: str(first.LookupCode) || ref.lookupCode || null,
      lookupUrl: this.lookupUrl(cfg, { ...ref, lookupCode: str(first.LookupCode) || ref.lookupCode }),
      message: str(pick(res.data, 'Message')) || null,
      raw: res.data,
    };
  }

  private async file(cfg: ProviderConfig, ref: InvoiceRef, kind: 'pdf' | 'xml'): Promise<FileResult> {
    const path = kind === 'pdf' ? '/api/business/getInvoicePdf' : '/api/business/getInvoiceXml';
    const res = await this.call(cfg, path, this.refBody(cfg, ref), `Tải ${kind.toUpperCase()} hoá đơn EasyInvoice`);
    const data = pick(res.data, 'Data');
    const content = typeof data === 'string' ? data : str(pick(data, 'Content') ?? pick(data, 'Base64') ?? pick(data, 'File'));
    if (!content) throw new EInvoiceProviderError('EasyInvoice không trả về nội dung file', res.data, true);
    const name = `${str(ref.invoiceNo) || ref.id}.${kind}`;
    if (kind === 'xml' && content.trimStart().startsWith('<')) return { buffer: Buffer.from(content, 'utf8'), mimeType: 'application/xml', fileName: name };
    return { buffer: Buffer.from(content, 'base64'), mimeType: kind === 'pdf' ? 'application/pdf' : 'application/xml', fileName: name };
  }

  getPdf(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'pdf');
  }

  getXml(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'xml');
  }

  lookupUrl(cfg: ProviderConfig, ref: Pick<InvoiceRef, 'lookupCode' | 'id'>): string | null {
    const base = str(cfg.lookupUrl).trim() || (str(cfg.baseUrl).trim() ? joinUrl(str(cfg.baseUrl), 'search') : '');
    if (!base) return null;
    const code = str(ref.lookupCode);
    return code ? `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : base;
  }
}
