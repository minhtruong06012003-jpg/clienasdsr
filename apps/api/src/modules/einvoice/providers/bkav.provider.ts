import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CancelResult, EInvoiceProvider, FileResult, InvoiceLine, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult, VatRate } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { soapCall, str } from './http.js';
import { formatDateVN, roundMoney } from '../einvoice.calc.js';

/**
 * Adapter BKAV eHoadon (ehoadon.bkav.com) — SOAP `WSPublicEHoaDon.asmx` với một hàm duy nhất
 * `ExecCommand(partnerGUID, CommandData)`.
 *  - CommandData = Base64( AES-256-CBC( GZip( JSON{ CmdType, CommandObject } ) ) ), khoá/iv lấy từ PartnerToken dạng "base64(key32):base64(iv16)".
 *  - Kết quả `<ExecCommandResult>` giải mã ngược -> JSON { Status, Object, MessLog } (Object thường là chuỗi JSON lồng).
 *  - CmdType theo tài liệu lưu hành đối tác (tạo + cấp số 112, ký/phát hành 205, huỷ 301, lấy thông tin 800, PDF 806, trạng thái CQT 850);
 *    các mã này có thể khác theo phiên bản — admin có thể sửa trong cấu hình.
 * Mã tra cứu cho khách = MTC; mã CQT = MCCQT.
 */

const DEFAULT_URLS = { sandbox: 'https://wsdemo.ehoadon.vn/WSPublicEHoaDon.asmx', production: 'https://ws.ehoadon.vn/WSPublicEHoaDon.asmx' } as const;
const LOOKUP_URLS = { sandbox: 'https://demo.ehoadon.vn/mtc', production: 'https://tracuu.ehoadon.vn/' } as const;

/** Mã lệnh mặc định (có thể ghi đè bằng cấu hình) */
export const BKAV_CMD = { create: 112, sign: 205, cancel: 301, info: 800, pdf: 806, xml: 808, taxStatus: 850 } as const;

function baseUrlOf(cfg: ProviderConfig): string {
  const custom = cfg.environment === 'production' ? str(cfg.productionUrl) : str(cfg.sandboxUrl);
  return custom.trim() || DEFAULT_URLS[cfg.environment];
}

/** Tách PartnerToken "key:iv" (base64) thành Buffer; kiểm tra độ dài AES-256-CBC */
export function parseBkavToken(token: string): { key: Buffer; iv: Buffer } {
  const [k, i] = String(token ?? '').trim().split(':');
  if (!k || !i) throw new EInvoiceProviderError('PartnerToken BKAV phải có dạng "key:iv" (base64)');
  const key = Buffer.from(k, 'base64');
  const iv = Buffer.from(i, 'base64');
  if (key.length !== 32) throw new EInvoiceProviderError(`Khoá AES của PartnerToken phải dài 32 byte (hiện ${key.length})`);
  if (iv.length !== 16) throw new EInvoiceProviderError(`IV của PartnerToken phải dài 16 byte (hiện ${iv.length})`);
  return { key, iv };
}

/** Mã hoá lệnh: JSON -> GZip -> AES-256-CBC -> Base64 */
export function bkavEncrypt(token: string, command: unknown): string {
  const { key, iv } = parseBkavToken(token);
  const gz = gzipSync(Buffer.from(JSON.stringify(command), 'utf8'));
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(gz), cipher.final()]).toString('base64');
}

/** Giải mã phản hồi: Base64 -> AES-256-CBC -> GunZip -> JSON */
export function bkavDecrypt<T = unknown>(token: string, data: string): T {
  const { key, iv } = parseBkavToken(token);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const raw = Buffer.concat([decipher.update(Buffer.from(String(data ?? '').trim(), 'base64')), decipher.final()]);
    plain = gunzipSync(raw);
  } catch (err) {
    throw new EInvoiceProviderError(`Không giải mã được phản hồi BKAV (sai PartnerToken?): ${(err as Error).message}`, { preview: String(data ?? '').slice(0, 100) });
  }
  const text = plain.toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EInvoiceProviderError('Phản hồi BKAV sau giải mã không phải JSON', { text: text.slice(0, 300) });
  }
}

/** TaxRateID của BKAV: 1 = 0%, 2 = 5%, 3 = 10%, 4 = KCT, 5 = KKKNT, 6 = 8% (xác minh với tài liệu BKAV) */
export function bkavTaxRateId(rate: VatRate): number | null {
  const map: Record<number, number> = { 0: 1, 5: 2, 10: 3, [-1]: 4, [-2]: 5, 8: 6 };
  return map[rate] ?? null;
}

/** PartnerInvoiceID số ổn định sinh từ id chuỗi (BKAV yêu cầu số nguyên; giữ 12 chữ số để không vượt int64) */
export function bkavNumericId(id: string): number {
  const hex = createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

/** PayMethodID: 1 TM, 2 CK, 3 TM/CK */
function payMethodId(method: string): number {
  const m = String(method ?? '').toUpperCase().replace(/\s/g, '');
  if (m === 'TM') return 1;
  if (m === 'CK') return 2;
  return 3;
}

/** Dựng phần tử CommandObject (hoá đơn) cho lệnh tạo. Export để test. */
export function buildBkavInvoice(payload: InvoicePayload, cfg: ProviderConfig): Record<string, unknown> {
  const b = payload.buyer;
  const anonymous = !!b.anonymous;
  const money = (v: number) => roundMoney(v, 0);
  const sign = (l: InvoiceLine, v: number) => (l.adjustment === 'decrease' ? -Math.abs(v) : l.adjustment === 'increase' ? Math.abs(v) : v);
  const partnerId = bkavNumericId(payload.id);
  const o = payload.original;

  const invoice: Record<string, unknown> = {
    // 1 GTGT; thay thế/điều chỉnh dùng InvoiceTypeID riêng theo tài liệu BKAV (TT78) kèm OriginalInvoiceIdentify
    InvoiceTypeID: Number(cfg.invoiceTypeId ?? 1),
    InvoiceDate: formatDateVN(payload.invoiceDate, true).replace(' ', 'T'),
    BuyerName: anonymous ? 'Người mua không lấy hoá đơn' : b.name,
    BuyerTaxCode: anonymous ? '' : str(b.taxCode),
    BuyerUnitName: anonymous ? '' : str(b.legalName),
    BuyerAddress: str(b.address),
    BuyerBankAccount: str(b.bankAccount),
    BuyerEmail: str(b.email),
    BuyerIdNo: anonymous ? '' : str(b.idNumber),
    PayMethodID: payMethodId(payload.paymentMethod),
    // 3 = nhận qua email
    ReceiveTypeID: 3,
    ReceiverEmail: str(b.email),
    ReceiverMobile: str(b.phone),
    ReceiverAddress: str(b.address),
    ReceiverName: anonymous ? '' : b.name,
    Note: str(payload.note),
    BillCode: str(payload.orderCode),
    CurrencyID: payload.currency || 'VND',
    ExchangeRate: payload.exchangeRate || 1,
    InvoiceForm: str(cfg.invoiceForm).trim() || payload.templateCode,
    InvoiceSerial: str(cfg.invoiceSerial).trim() || payload.serial,
    InvoiceNo: 0,
    OriginalInvoiceIdentify: o ? `${o.templateCode}_${o.serial}_${o.invoiceNo}` : '',
    PartnerInvoiceID: partnerId,
    PartnerInvoiceStringID: payload.id,
  };
  if (o) {
    // Lý do + biên bản thoả thuận (tên trường theo kiến thức cộng đồng — xác minh)
    invoice.AdjustReason = o.reason;
    invoice.AgreementNo = str(o.agreementNo);
    invoice.AgreementDate = o.agreementDate ? formatDateVN(o.agreementDate) : '';
  }

  const details = payload.lines.map((l) => ({
    ItemName: l.name,
    UnitName: l.unit || '',
    Qty: l.kind === 'discount' ? 0 : l.quantity,
    Price: l.kind === 'discount' ? 0 : roundMoney(l.unitPrice, 2),
    Amount: money(sign(l, l.amount)),
    TaxRateID: bkavTaxRateId(l.vatRate),
    TaxRate: l.vatRate > 0 ? l.vatRate : 0,
    TaxAmount: money(sign(l, l.vatAmount)),
    DiscountRate: 0,
    DiscountAmount: money(l.discount),
    IsDiscount: l.kind === 'discount',
    // 0 hàng hoá, 1 ghi chú (tham khảo)
    ItemTypeID: l.kind === 'note' ? 1 : 0,
    // Hoá đơn điều chỉnh: true tăng / false giảm
    ...(l.adjustment ? { IsIncrease: l.adjustment === 'increase' } : {}),
  }));

  return { Invoice: invoice, ListInvoiceDetailsWS: details, ListInvoiceAttachFileWS: null, PartnerInvoiceID: partnerId, PartnerInvoiceStringID: payload.id };
}

/** Phản hồi đã giải mã của ExecCommand */
interface BkavEnvelope {
  Status?: number | string;
  Object?: unknown;
  MessLog?: string;
}

export class BkavProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'bkav',
    name: 'BKAV eHoadon',
    description: 'Hoá đơn điện tử BKAV eHoadon qua webservice ExecCommand (mã hoá AES + GZip). BKAV ký bằng HSM/chứng thư đặt tại BKAV.',
    website: 'https://ehoadon.bkav.com',
    docsUrl: 'https://ehoadon.bkav.com',
    signing: 'hsm',
    fields: [
      { key: 'partnerGUID', label: 'Partner GUID', type: 'text', required: true, help: 'GUID BKAV cấp cho mỗi điểm phát hành.' },
      { key: 'partnerToken', label: 'Partner Token', type: 'password', required: true, help: 'Dạng "base64(key 32 byte):base64(iv 16 byte)" — khoá AES-256-CBC do BKAV cấp.' },
      { key: 'invoiceForm', label: 'Mẫu số ghi đè (InvoiceForm)', type: 'text', placeholder: '1', help: 'Để trống = dùng mẫu số trong cài đặt chung.' },
      { key: 'invoiceSerial', label: 'Ký hiệu ghi đè (InvoiceSerial)', type: 'text', placeholder: 'C24TAA', help: 'Để trống = dùng ký hiệu trong cài đặt chung.' },
      { key: 'invoiceTypeId', label: 'Loại hoá đơn (InvoiceTypeID)', type: 'number', default: 1, help: '1 = GTGT, 2 = bán hàng...' },
      { key: 'cmdCreate', label: 'CmdType tạo hoá đơn', type: 'number', default: BKAV_CMD.create, help: '112 = tạo theo mẫu/ký hiệu chỉ định, BKAV cấp số (hoặc 101).' },
      { key: 'cmdSign', label: 'CmdType ký & phát hành', type: 'number', default: BKAV_CMD.sign, help: '205 = ký HSM + gửi CQT. Đặt 0 nếu tài khoản đã cấu hình tự ký khi tạo.' },
      { key: 'cmdCancel', label: 'CmdType huỷ', type: 'number', default: BKAV_CMD.cancel },
      { key: 'cmdPdf', label: 'CmdType lấy PDF', type: 'number', default: BKAV_CMD.pdf },
      { key: 'cmdStatus', label: 'CmdType trạng thái CQT', type: 'number', default: BKAV_CMD.taxStatus },
      { key: 'sandboxUrl', label: 'Webservice URL (sandbox)', type: 'url', env: 'sandbox', default: DEFAULT_URLS.sandbox },
      { key: 'productionUrl', label: 'Webservice URL (production)', type: 'url', env: 'production', default: DEFAULT_URLS.production },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: false, sync: true, testConnection: true, lookup: true },
    notes: [
      'Các CmdType (112/205/301/800/806/850) lấy từ tài liệu lưu hành nội bộ của BKAV — PHẢI đối chiếu với "Tài liệu tích hợp WS eHoadon" bản BKAV cấp cho doanh nghiệp và sửa lại trong cấu hình nếu khác.',
      'Hoá đơn thay thế/điều chỉnh: gửi OriginalInvoiceIdentify "[Mẫu]_[Ký hiệu]_[Số]"; InvoiceTypeID cho loại thay thế/điều chỉnh có thể cần giá trị riêng theo tài liệu BKAV.',
      'Tên trường file PDF trong Object trả về chưa chắc chắn (PDF/Data/FileData) — adapter dò nhiều tên; kiểm tra lại với sandbox wsdemo.',
      'Sai PartnerToken sẽ gặp lỗi "Padding is invalid" khi giải mã.',
    ],
  };

  private cmd(cfg: ProviderConfig, key: 'cmdCreate' | 'cmdSign' | 'cmdCancel' | 'cmdPdf' | 'cmdStatus', fallback: number): number {
    const v = Number(cfg[key]);
    return Number.isFinite(v) && cfg[key] !== '' && cfg[key] !== null && cfg[key] !== undefined ? v : fallback;
  }

  /** Gọi ExecCommand: mã hoá lệnh, gửi SOAP, giải mã phản hồi; ném lỗi nếu Status != 0 */
  private async exec(cfg: ProviderConfig, cmdType: number, commandObject: unknown, what: string): Promise<{ status: number; object: unknown; messLog: string; raw: unknown }> {
    const token = str(cfg.partnerToken);
    const commandData = bkavEncrypt(token, { CmdType: cmdType, CommandObject: commandObject });
    const { result, raw } = await soapCall(baseUrlOf(cfg), 'ExecCommand', { partnerGUID: str(cfg.partnerGUID), CommandData: commandData }, { timeoutMs: 90_000 });
    if (!result.trim()) throw new EInvoiceProviderError(`${what}: BKAV trả về phản hồi rỗng`, raw, true);
    const env = bkavDecrypt<BkavEnvelope>(token, result);
    // Object thường là chuỗi JSON lồng -> parse nếu được
    let object: unknown = env.Object;
    if (typeof object === 'string') {
      try {
        object = JSON.parse(object);
      } catch {
        // giữ nguyên chuỗi (vd base64 file)
      }
    }
    const status = Number(env.Status ?? 0);
    const messLog = str(env.MessLog);
    if (status !== 0) throw new EInvoiceProviderError(`${what} thất bại: ${messLog || `BKAV Status=${status}`}`, { envelope: env, object }, false);
    return { status, object, messLog, raw: { envelope: env, object } };
  }

  /** Lấy phần tử kết quả hoá đơn đầu tiên (Object có thể là mảng hoặc object) và kiểm tra Status từng hoá đơn */
  private firstInvoiceObject(object: unknown, what: string): Record<string, unknown> {
    const first = (Array.isArray(object) ? object[0] : object) as Record<string, unknown> | undefined;
    if (!first) throw new EInvoiceProviderError(`${what}: BKAV không trả về dữ liệu hoá đơn`, object, true);
    const st = first.Status !== undefined ? Number(first.Status) : 0;
    if (st !== 0) throw new EInvoiceProviderError(`${what} thất bại: ${str(first.MessLog) || `Status=${st}`}`, object, false);
    const inner = (first.Object && typeof first.Object === 'object' ? first.Object : first) as Record<string, unknown>;
    return inner;
  }

  private partnerRef(ref: InvoiceRef) {
    const stringId = str(ref.providerRef) || ref.id;
    return { PartnerInvoiceID: bkavNumericId(stringId), PartnerInvoiceStringID: stringId };
  }

  private toIssueResult(obj: Record<string, unknown>, payload: InvoicePayload, cfg: ProviderConfig, raw: unknown): IssueResult {
    const invoiceNo = str(obj.InvoiceNo).replace(/^0+(?=\d)/, '');
    const mtc = str(obj.MTC) || null;
    return {
      status: invoiceNo && invoiceNo !== '0' ? 'issued' : 'pending',
      providerRef: payload.id,
      invoiceNo: invoiceNo && invoiceNo !== '0' ? invoiceNo : null,
      serial: str(obj.InvoiceSerial) || str(cfg.invoiceSerial) || payload.serial,
      templateCode: str(obj.InvoiceForm) || str(cfg.invoiceForm) || payload.templateCode,
      taxAuthorityCode: str(obj.MCCQT) || null,
      lookupCode: mtc,
      lookupUrl: LOOKUP_URLS[cfg.environment],
      issuedAt: invoiceNo ? payload.invoiceDate : null,
      raw: { ...(raw as object), invoiceGuid: obj.InvoiceGUID },
    };
  }

  // ---------------------------------------------------------------------------
  // EInvoiceProvider
  // ---------------------------------------------------------------------------
  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    parseBkavToken(str(cfg.partnerToken));
    // Lấy thông tin một hoá đơn không tồn tại: nếu giải mã được phản hồi nghĩa là GUID/token đúng
    try {
      await this.exec(cfg, BKAV_CMD.info, [{ PartnerInvoiceID: 0, PartnerInvoiceStringID: `ping-${Date.now()}` }], 'Kiểm tra kết nối BKAV');
    } catch (err) {
      const e = err as EInvoiceProviderError;
      if (e.retryable || /giải mã|Padding|SOAP|kết nối|thời gian/i.test(e.message)) throw err;
      // Status != 0 (không tìm thấy hoá đơn) vẫn chứng tỏ xác thực OK
    }
    return { ok: true, message: 'Kết nối BKAV thành công (giải mã phản hồi hợp lệ).', details: { baseUrl: baseUrlOf(cfg) } };
  }

  /** Tạo hoá đơn (+ ký/phát hành nếu cmdSign > 0) */
  private async create(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const created = await this.exec(cfg, this.cmd(cfg, 'cmdCreate', BKAV_CMD.create), [buildBkavInvoice(payload, cfg)], 'Tạo hoá đơn BKAV');
    let obj = this.firstInvoiceObject(created.object, 'Tạo hoá đơn BKAV');
    const signCmd = this.cmd(cfg, 'cmdSign', BKAV_CMD.sign);
    if (signCmd > 0) {
      const signed = await this.exec(cfg, signCmd, [{ PartnerInvoiceID: bkavNumericId(payload.id), PartnerInvoiceStringID: payload.id }], 'Ký & phát hành hoá đơn BKAV');
      try {
        const signedObj = this.firstInvoiceObject(signed.object, 'Ký & phát hành hoá đơn BKAV');
        obj = { ...obj, ...signedObj };
      } catch (err) {
        // Ký lỗi nhưng hoá đơn đã tạo: ném lỗi để admin biết (hoá đơn nháp vẫn nằm trên BKAV)
        throw new EInvoiceProviderError(`${(err as Error).message}. Hoá đơn đã được tạo trên BKAV (chưa ký) — kiểm tra trên van.ehoadon.vn.`, signed.raw, false);
      }
    }
    return this.toIssueResult(obj, payload, cfg, created.raw);
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
    const r = await this.exec(cfg, this.cmd(cfg, 'cmdCancel', BKAV_CMD.cancel), [{ ...this.partnerRef(ref), Reason: str(reason) || 'Huỷ hoá đơn' }], 'Huỷ hoá đơn BKAV');
    this.firstInvoiceObject(r.object, 'Huỷ hoá đơn BKAV');
    return { ok: true, message: r.messLog || 'Đã huỷ hoá đơn trên BKAV', raw: r.raw };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    // Lấy thông tin hoá đơn (800) + trạng thái CQT (850) rồi gộp
    const info = await this.exec(cfg, BKAV_CMD.info, [this.partnerRef(ref)], 'Lấy thông tin hoá đơn BKAV');
    const obj = this.firstInvoiceObject(info.object, 'Lấy thông tin hoá đơn BKAV');
    let tax: Record<string, unknown> = {};
    try {
      const t = await this.exec(cfg, this.cmd(cfg, 'cmdStatus', BKAV_CMD.taxStatus), [this.partnerRef(ref)], 'Lấy trạng thái CQT BKAV');
      tax = this.firstInvoiceObject(t.object, 'Lấy trạng thái CQT BKAV');
    } catch {
      // không bắt buộc — vẫn trả thông tin cơ bản
    }
    // InvoiceStatusID BKAV (tham khảo): 1 nháp, 2 chờ ký, 3 đã phát hành, 4 huỷ, 5 bị điều chỉnh, 6 bị thay thế
    const statusId = Number(obj.InvoiceStatusID ?? tax.InvoiceStatusID);
    const map: Record<number, SyncResult['status']> = { 1: 'pending', 2: 'pending', 3: 'issued', 4: 'cancelled', 5: 'adjusted', 6: 'replaced' };
    const invoiceNo = str(obj.InvoiceNo).replace(/^0+(?=\d)/, '');
    const hasNo = invoiceNo && invoiceNo !== '0';
    return {
      status: map[statusId] ?? (hasNo ? 'issued' : 'unknown'),
      invoiceNo: hasNo ? invoiceNo : ref.invoiceNo ?? null,
      serial: str(obj.InvoiceSerial) || ref.serial || null,
      templateCode: str(obj.InvoiceForm) || ref.templateCode || null,
      taxAuthorityCode: str(tax.MCCQT ?? obj.MCCQT) || null,
      lookupCode: str(obj.MTC) || ref.lookupCode || null,
      lookupUrl: LOOKUP_URLS[cfg.environment],
      issuedAt: obj.InvoiceDate ? new Date(String(obj.InvoiceDate)) : ref.issuedAt ?? null,
      message: str(tax.MessLog ?? tax.Description ?? obj.MessLog) || null,
      raw: { info: info.raw, tax },
    };
  }

  async getPdf(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult> {
    const r = await this.exec(cfg, this.cmd(cfg, 'cmdPdf', BKAV_CMD.pdf), [this.partnerRef(ref)], 'Lấy PDF hoá đơn BKAV');
    const obj = this.firstInvoiceObject(r.object, 'Lấy PDF hoá đơn BKAV');
    // Tên trường chứa base64 chưa chắc — dò lần lượt
    const b64 = str(obj.PDF ?? obj.Pdf ?? obj.Data ?? obj.FileData ?? obj.Base64 ?? obj.Content ?? (typeof r.object === 'string' ? r.object : ''));
    if (!b64 || b64.startsWith('{')) throw new EInvoiceProviderError('BKAV không trả về nội dung PDF (kiểm tra CmdType lấy PDF)', r.raw);
    return { buffer: Buffer.from(b64, 'base64'), mimeType: 'application/pdf', fileName: `${str(ref.invoiceNo) || ref.id}.pdf` };
  }

  lookupUrl(cfg: ProviderConfig): string | null {
    // Cổng tra cứu BKAV: khách nhập MTC tại trang
    return LOOKUP_URLS[cfg.environment];
  }
}
