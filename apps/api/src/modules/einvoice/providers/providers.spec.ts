/**
 * Test thuần (không gọi mạng) cho các adapter HĐĐT:
 * - mapping payload chuẩn -> body request của Viettel / MISA / VNPT
 * - phân tích chuỗi OK:/ERR: của VNPT
 * - mã hoá / giải mã BKAV (AES-256-CBC + GZip) round-trip
 * - BUILTIN_PROVIDERS đủ key, field bắt buộc có label
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InvoicePayload, ProviderConfig } from './provider.interface.js';
import { BUILTIN_PROVIDERS } from './index.js';
import { buildViettelBody, viettelInvoiceNo, viettelTaxPercentage, viettelTransactionUuid } from './viettel.provider.js';
import { buildVnptInvoiceXml, parseVnptResult } from './vnpt.provider.js';
import { buildMisaInvoice, misaInvSeries, misaVatRateName } from './misa.provider.js';
import { bkavDecrypt, bkavEncrypt, bkavNumericId, bkavTaxRateId, buildBkavInvoice } from './bkav.provider.js';
import { buildEasyInvoice } from './easyinvoice.provider.js';
import { buildFptInvoice } from './fpt.provider.js';
import { buildMobifoneInvoice } from './mobifone.provider.js';

/** Payload mẫu: 2 dòng hàng (10% và KCT) + phí vận chuyển, ngày lập 04/10/2026 10:00 giờ VN */
function samplePayload(over: Partial<InvoicePayload> = {}): InvoicePayload {
  return {
    id: 'cmg1abcdef0001xyz',
    refCode: 'DH-000123-1',
    orderCode: 'DH-000123',
    kind: 'ORIGINAL',
    templateCode: '1/001',
    serial: 'C26TAA',
    invoiceDate: new Date('2026-10-04T03:00:00.000Z'),
    currency: 'VND',
    exchangeRate: 1,
    paymentMethod: 'TM/CK',
    seller: { name: 'Công ty CMSNT', taxCode: '0101234567', address: 'Hà Nội', email: 'kt@cmsnt.vn' },
    buyer: { name: 'Nguyễn Văn A', legalName: 'Công ty B', taxCode: '0109876543', address: 'HCM', email: 'a@b.vn', phone: '0900000000' },
    lines: [
      { index: 1, kind: 'product', name: 'Sản phẩm 1', sku: 'SP01', unit: 'Cái', quantity: 2, unitPrice: 100000, amount: 200000, discount: 0, vatRate: 10, vatAmount: 20000, total: 220000 },
      { index: 2, kind: 'product', name: 'Sách', sku: 'SP02', unit: 'Cuốn', quantity: 1, unitPrice: 50000, amount: 50000, discount: 0, vatRate: -1, vatAmount: 0, total: 50000 },
      { index: 3, kind: 'shipping', name: 'Phí vận chuyển', unit: 'Lần', quantity: 1, unitPrice: 30000, amount: 30000, discount: 0, vatRate: 10, vatAmount: 3000, total: 33000 },
    ],
    totals: {
      subtotal: 280000,
      discountTotal: 0,
      vatTotal: 23000,
      total: 303000,
      totalInWords: 'Ba trăm lẻ ba nghìn đồng',
      breakdown: [
        { vatRate: 10, amount: 230000, vatAmount: 23000 },
        { vatRate: -1, amount: 50000, vatAmount: 0 },
      ],
    },
    note: 'Giao giờ hành chính',
    original: null,
    ...over,
  };
}

const cfg = (extra: Record<string, unknown> = {}): ProviderConfig => ({ environment: 'sandbox', ...extra });

describe('Viettel S-Invoice', () => {
  it('map thuế suất: KCT -> -2, KKKNT -> -1, khác -> null', () => {
    expect(viettelTaxPercentage(10)).toBe(10);
    expect(viettelTaxPercentage(0)).toBe(0);
    expect(viettelTaxPercentage(-1)).toBe(-2);
    expect(viettelTaxPercentage(-2)).toBe(-1);
    expect(viettelTaxPercentage(-3)).toBeNull();
  });

  it('transactionUuid 10–36 ký tự', () => {
    expect(viettelTransactionUuid(samplePayload())).toBe('cmg1abcdef0001xyz');
    const short = viettelTransactionUuid(samplePayload({ id: 'ab', refCode: 'X-1' }));
    expect(short.length).toBeGreaterThanOrEqual(10);
    expect(viettelTransactionUuid(samplePayload({ id: 'a'.repeat(50) })).length).toBe(36);
  });

  it('ghép số hoá đơn theo định dạng Viettel', () => {
    expect(viettelInvoiceNo({ invoiceNo: 'C26TAA123' })).toBe('C26TAA123');
    expect(viettelInvoiceNo({ invoiceNo: '00000123', serial: 'C26TAA' })).toBe('C26TAA123');
    expect(viettelInvoiceNo({ invoiceNo: null })).toBe('');
  });

  it('dựng body createInvoice cho hoá đơn gốc', () => {
    const body = buildViettelBody(samplePayload(), cfg({ invoiceType: '1' }));
    const g = body.generalInvoiceInfo as Record<string, unknown>;
    expect(g.templateCode).toBe('1/001');
    expect(g.invoiceSeries).toBe('C26TAA');
    expect(g.adjustmentType).toBe('1');
    expect(g.invoiceIssuedDate).toBe(new Date('2026-10-04T03:00:00.000Z').getTime());
    expect(g.transactionUuid).toBe('cmg1abcdef0001xyz');
    expect(g).not.toHaveProperty('originalInvoiceId');

    const b = body.buyerInfo as Record<string, unknown>;
    expect(b.buyerName).toBe('Nguyễn Văn A');
    expect(b.buyerLegalName).toBe('Công ty B');
    expect(b.buyerTaxCode).toBe('0109876543');
    expect(b.buyerNotGetInvoice).toBe(0);
    expect(b.buyerIdType).toBeUndefined();

    const items = body.itemInfo as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ lineNumber: 1, selection: 1, itemCode: 'SP01', unitPrice: 100000, quantity: 2, itemTotalAmountWithoutTax: 200000, taxPercentage: 10, taxAmount: 20000, itemTotalAmountWithTax: 220000 });
    expect(items[1].taxPercentage).toBe(-2);

    const tb = body.taxBreakdowns as Record<string, unknown>[];
    expect(tb).toEqual([
      { taxPercentage: 10, taxableAmount: 230000, taxAmount: 23000 },
      { taxPercentage: -2, taxableAmount: 50000, taxAmount: 0 },
    ]);
    expect(body.summarizeInfo).toMatchObject({ totalAmountWithoutTax: 280000, totalTaxAmount: 23000, totalAmountWithTax: 303000, totalAmountWithTaxInWords: 'Ba trăm lẻ ba nghìn đồng', isTotalAmountPos: true });
    expect(body.payments).toEqual([{ paymentMethodName: 'TM/CK' }]);
  });

  it('người mua không lấy hoá đơn + CCCD', () => {
    const b1 = buildViettelBody(samplePayload({ buyer: { name: 'Khách lẻ', anonymous: true } }), cfg()).buyerInfo as Record<string, unknown>;
    expect(b1.buyerName).toBe('Người mua không lấy hoá đơn');
    expect(b1.buyerNotGetInvoice).toBe(1);
    expect(b1.buyerTaxCode).toBeUndefined();
    const b2 = buildViettelBody(samplePayload({ buyer: { name: 'Trần B', idNumber: '012345678901' } }), cfg()).buyerInfo as Record<string, unknown>;
    expect(b2.buyerIdType).toBe('1');
    expect(b2.buyerIdNo).toBe('012345678901');
  });

  it('hoá đơn điều chỉnh giảm: adjustmentType 5 + hoá đơn gốc + isIncreaseItem=false', () => {
    const payload = samplePayload({
      kind: 'ADJUSTMENT',
      lines: [{ index: 1, kind: 'product', name: 'Sản phẩm 1', unit: 'Cái', quantity: 1, unitPrice: 100000, amount: 100000, discount: 0, vatRate: 10, vatAmount: 10000, total: 110000, adjustment: 'decrease' }],
      totals: { subtotal: -100000, discountTotal: 0, vatTotal: -10000, total: -110000, totalInWords: 'Một trăm mười nghìn đồng', breakdown: [{ vatRate: 10, amount: -100000, vatAmount: -10000 }] },
      original: { invoiceNo: 'C26TAA120', serial: 'C26TAA', templateCode: '1/001', issuedAt: new Date('2026-09-01T03:00:00.000Z'), reason: 'Giảm giá sau bán', agreementNo: 'BB-01', agreementDate: new Date('2026-10-01T03:00:00.000Z') },
    });
    const body = buildViettelBody(payload, cfg());
    const g = body.generalInvoiceInfo as Record<string, unknown>;
    expect(g.adjustmentType).toBe('5');
    expect(g.adjustmentInvoiceType).toBe('1');
    expect(g.originalInvoiceId).toBe('C26TAA120');
    expect(g.originalInvoiceIssueDate).toBe(new Date('2026-09-01T03:00:00.000Z').getTime());
    expect(g.originalInvoiceType).toBe('1');
    expect(g.originalTemplateCode).toBe('1/001');
    expect(g.additionalReferenceDesc).toBe('BB-01');
    expect(g.adjustedNote).toBe('Giảm giá sau bán');
    const item = (body.itemInfo as Record<string, unknown>[])[0];
    expect(item.isIncreaseItem).toBe(false);
    expect(item.itemTotalAmountWithoutTax).toBe(100000);
    expect(body.summarizeInfo).toMatchObject({ totalAmountWithTax: 110000, isTotalAmountPos: false, isTotalTaxAmountPos: false });
    // Thay thế -> adjustmentType 3, không có adjustmentInvoiceType
    const g2 = buildViettelBody({ ...payload, kind: 'REPLACEMENT' }, cfg()).generalInvoiceInfo as Record<string, unknown>;
    expect(g2.adjustmentType).toBe('3');
    expect(g2.adjustmentInvoiceType).toBeUndefined();
  });
});

describe('VNPT Invoice', () => {
  it('parse OK: nhiều hoá đơn', () => {
    const r = parseVnptResult('OK:1/001;C26TAA-ORDER-2026-000123_25;C26TAA-ORDER-2026-000124_26');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pattern).toBe('1/001');
      expect(r.items).toEqual([
        { serial: 'C26TAA', key: 'ORDER-2026-000123', invoiceNo: '25' },
        { serial: 'C26TAA', key: 'ORDER-2026-000124', invoiceNo: '26' },
      ]);
    }
  });

  it('parse ERR: có thông điệp tiếng Việt', () => {
    const r = parseVnptResult('ERR:13');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('13');
      expect(r.message).toMatch(/Fkey/);
    }
    expect(parseVnptResult('ERR:1').ok).toBe(false);
    expect(parseVnptResult('xyz').ok).toBe(false);
  });

  it('dựng XML hoá đơn với key, ngày dd/MM/yyyy, VATRate KCT = -1', () => {
    const xml = buildVnptInvoiceXml(samplePayload());
    expect(xml.startsWith('<Invoices><Inv><key>cmg1abcdef0001xyz</key><Invoice>')).toBe(true);
    expect(xml).toContain('<ArisingDate>04/10/2026</ArisingDate>');
    expect(xml).toContain('<CusName>Công ty B</CusName>');
    expect(xml).toContain('<Buyer>Nguyễn Văn A</Buyer>');
    expect(xml).toContain('<CusTaxCode>0109876543</CusTaxCode>');
    expect(xml).toContain('<ProdName>Sản phẩm 1</ProdName>');
    expect(xml).toContain('<VATRate>-1</VATRate>');
    expect(xml).toContain('<Amount>303000</Amount>');
    expect(xml).toContain('<AmountInWords>Ba trăm lẻ ba nghìn đồng</AmountInWords>');
    // nhiều thuế suất -> VATRate cấp hoá đơn để trống
    expect(xml).toContain('<VATAmount>23000</VATAmount><Amount>303000</Amount>');
    expect(xml).not.toContain('<OriginalInvoiceNo>');
    expect((xml.match(/<Product>/g) ?? []).length).toBe(3);
  });

  it('escape ký tự đặc biệt trong XML', () => {
    const xml = buildVnptInvoiceXml(samplePayload({ lines: [{ index: 1, kind: 'product', name: 'Áo <M> & "N"', unit: 'Cái', quantity: 1, unitPrice: 1, amount: 1, discount: 0, vatRate: 10, vatAmount: 0, total: 1 }] }));
    expect(xml).toContain('<ProdName>Áo &lt;M&gt; &amp; &quot;N&quot;</ProdName>');
  });
});

describe('MISA meInvoice', () => {
  it('tên thuế suất và ký hiệu đầy đủ', () => {
    expect(misaVatRateName(10)).toBe('10%');
    expect(misaVatRateName(0)).toBe('0%');
    expect(misaVatRateName(-1)).toBe('KCT');
    expect(misaVatRateName(-2)).toBe('KKKNT');
    expect(misaInvSeries({ templateCode: '1/001', serial: 'C26TAA' })).toBe('1C26TAA');
    expect(misaInvSeries({ templateCode: '1', serial: '1C26TAA' })).toBe('1C26TAA');
    expect(misaInvSeries({ templateCode: '1', serial: 'C26TAA' }, '2C26TBB')).toBe('2C26TBB');
  });

  it('dựng InvoiceData', () => {
    const inv = buildMisaInvoice(samplePayload(), cfg());
    expect(inv.RefID).toBe('cmg1abcdef0001xyz');
    expect(inv.InvSeries).toBe('1C26TAA');
    expect(inv.InvDate).toBe('2026-10-04');
    expect(inv.BuyerLegalName).toBe('Công ty B');
    expect(inv.BuyerFullName).toBe('Nguyễn Văn A');
    expect(inv.TotalAmountOC).toBe(303000);
    expect(inv.TotalVATAmountOC).toBe(23000);
    const detail = inv.OriginalInvoiceDetail as Record<string, unknown>[];
    expect(detail[0]).toMatchObject({ ItemType: 1, LineNumber: 1, ItemCode: 'SP01', Quantity: 2, UnitPrice: 100000, AmountWithoutVATOC: 200000, VATRateName: '10%', VATAmountOC: 20000 });
    expect(detail[1].VATRateName).toBe('KCT');
    expect(inv.TaxRateInfo).toEqual([
      { VATRateName: '10%', AmountWithoutVATOC: 230000, VATAmountOC: 23000 },
      { VATRateName: 'KCT', AmountWithoutVATOC: 50000, VATAmountOC: 0 },
    ]);
    expect(inv).not.toHaveProperty('ReferenceType');
  });

  it('hoá đơn thay thế có tham chiếu gốc; khách lẻ không lấy hoá đơn', () => {
    const inv = buildMisaInvoice(samplePayload({ kind: 'REPLACEMENT', original: { invoiceNo: '00000120', serial: 'C26TAA', templateCode: '1', issuedAt: new Date('2026-09-01T03:00:00.000Z'), providerRef: 'L4CXU6X0W0', reason: 'Sai địa chỉ' } }), cfg());
    expect(inv.ReferenceType).toBe(1);
    expect(inv.OriginalInvNo).toBe('00000120');
    expect(inv.OriginalInvSeries).toBe('1C26TAA');
    expect(inv.OriginalInvDate).toBe('2026-09-01');
    expect(inv.OriginalInvTransactionID).toBe('L4CXU6X0W0');
    expect(inv.ReplaceReason).toBe('Sai địa chỉ');
    const anon = buildMisaInvoice(samplePayload({ buyer: { name: 'Khách', anonymous: true } }), cfg());
    expect(anon.BuyerFullName).toBe('Người mua không lấy hoá đơn');
    expect(anon.BuyerTaxCode).toBeUndefined();
    expect(anon.IsBuyerNotGetInvoice).toBe(true);
  });
});

describe('BKAV eHoadon', () => {
  const token = `${randomBytes(32).toString('base64')}:${randomBytes(16).toString('base64')}`;

  it('mã hoá rồi giải mã ra JSON gốc', () => {
    const cmd = { CmdType: 112, CommandObject: [{ Invoice: { BuyerName: 'Nguyễn Văn A — "test" <x>' }, ListInvoiceDetailsWS: [{ ItemName: 'SP', Qty: 2 }] }] };
    const enc = bkavEncrypt(token, cmd);
    expect(typeof enc).toBe('string');
    expect(enc).not.toContain('CmdType');
    expect(bkavDecrypt(token, enc)).toEqual(cmd);
  });

  it('sai token -> lỗi dễ hiểu', () => {
    const enc = bkavEncrypt(token, { a: 1 });
    const other = `${randomBytes(32).toString('base64')}:${randomBytes(16).toString('base64')}`;
    expect(() => bkavDecrypt(other, enc)).toThrow(/giải mã/);
    expect(() => bkavEncrypt('khong-hop-le', { a: 1 })).toThrow(/key:iv/);
    expect(() => bkavEncrypt(`${randomBytes(8).toString('base64')}:${randomBytes(16).toString('base64')}`, {})).toThrow(/32 byte/);
  });

  it('TaxRateID, PartnerInvoiceID ổn định và CommandObject', () => {
    expect(bkavTaxRateId(10)).toBe(3);
    expect(bkavTaxRateId(8)).toBe(6);
    expect(bkavTaxRateId(-1)).toBe(4);
    expect(bkavTaxRateId(-3)).toBeNull();
    expect(bkavNumericId('abc')).toBe(bkavNumericId('abc'));
    expect(bkavNumericId('abc')).not.toBe(bkavNumericId('abd'));
    const obj = buildBkavInvoice(samplePayload(), cfg({ invoiceForm: '1', invoiceSerial: 'C26TAA' }));
    const inv = obj.Invoice as Record<string, unknown>;
    expect(inv.InvoiceForm).toBe('1');
    expect(inv.InvoiceSerial).toBe('C26TAA');
    expect(inv.InvoiceDate).toBe('2026-10-04T10:00:00');
    expect(inv.BuyerUnitName).toBe('Công ty B');
    expect(inv.PayMethodID).toBe(3);
    expect(inv.PartnerInvoiceStringID).toBe('cmg1abcdef0001xyz');
    expect(obj.PartnerInvoiceID).toBe(inv.PartnerInvoiceID);
    const details = obj.ListInvoiceDetailsWS as Record<string, unknown>[];
    expect(details[0]).toMatchObject({ ItemName: 'Sản phẩm 1', Qty: 2, Price: 100000, Amount: 200000, TaxRateID: 3, TaxRate: 10, TaxAmount: 20000 });
    expect(details[1].TaxRateID).toBe(4);
  });
});

describe('EasyInvoice / FPT / MobiFone (mapping cơ bản)', () => {
  it('EasyInvoice: Ikey + ngày dd/MM/yyyy', () => {
    const inv = buildEasyInvoice(samplePayload());
    expect(inv.Ikey).toBe('cmg1abcdef0001xyz');
    expect(inv.ArisingDate).toBe('04/10/2026');
    expect(inv.Amount).toBe(303000);
    expect((inv.Products as unknown[]).length).toBe(3);
  });

  it('FPT: sid, type và thuế suất chữ cho KCT', () => {
    const body = buildFptInvoice(samplePayload(), cfg());
    expect(body.sid).toBe('cmg1abcdef0001xyz');
    expect(body.type).toBe(1);
    expect(body.serial).toBe('C26TAA');
    const items = body.items as Record<string, unknown>[];
    expect(items[1].vatRate).toBe('KCT');
    expect(body.total).toMatchObject({ amount: 303000, vat: 23000 });
  });

  it('MobiFone: inv_* và ma_thue', () => {
    const inv = buildMobifoneInvoice(samplePayload(), cfg());
    expect(inv.inv_invoiceSeries).toBe('1C26TAA');
    expect(inv.inv_invoiceIssuedDate).toBe('2026-10-04');
    expect(inv.inv_TotalAmount).toBe(303000);
    const rows = (inv.details as { data: Record<string, unknown>[] }[])[0].data;
    expect(rows[0]).toMatchObject({ inv_itemName: 'Sản phẩm 1', ma_thue: '10', inv_TotalAmountWithoutVat: 200000 });
    expect(rows[1].ma_thue).toBe('KCT');
  });
});

describe('BUILTIN_PROVIDERS', () => {
  it('đủ key theo thứ tự và không trùng', () => {
    expect(BUILTIN_PROVIDERS.map((p) => p.meta.key)).toEqual(['viettel', 'vnpt', 'misa', 'bkav', 'easyinvoice', 'fpt', 'mobifone', 'custom', 'manual']);
  });

  it('meta hợp lệ: tên, mô tả, field có label/key duy nhất, capabilities khớp method', () => {
    for (const p of BUILTIN_PROVIDERS) {
      const m = p.meta;
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      const keys = new Set<string>();
      for (const f of m.fields) {
        expect(f.key.length, `${m.key}.${f.key}`).toBeGreaterThan(0);
        expect(f.label.length, `${m.key}.${f.key} thiếu label`).toBeGreaterThan(0);
        expect(keys.has(f.key), `${m.key}: trùng field ${f.key}`).toBe(false);
        keys.add(f.key);
        if (f.type === 'select') expect(f.options?.length ?? 0, `${m.key}.${f.key} thiếu options`).toBeGreaterThan(0);
      }
      // capability khai báo thì phải có method tương ứng
      if (m.capabilities.replace) expect(typeof p.replace, `${m.key} thiếu replace()`).toBe('function');
      if (m.capabilities.adjust) expect(typeof p.adjust, `${m.key} thiếu adjust()`).toBe('function');
      if (m.capabilities.sync) expect(typeof p.sync, `${m.key} thiếu sync()`).toBe('function');
      if (m.capabilities.pdf) expect(typeof p.getPdf, `${m.key} thiếu getPdf()`).toBe('function');
      if (m.capabilities.xml) expect(typeof p.getXml, `${m.key} thiếu getXml()`).toBe('function');
      if (m.capabilities.lookup) expect(typeof p.lookupUrl, `${m.key} thiếu lookupUrl()`).toBe('function');
    }
  });

  it('field baseUrl theo môi trường có default', () => {
    for (const key of ['viettel', 'misa', 'bkav', 'fpt']) {
      const p = BUILTIN_PROVIDERS.find((x) => x.meta.key === key)!;
      const sb = p.meta.fields.find((f) => f.key === 'sandboxUrl');
      const pr = p.meta.fields.find((f) => f.key === 'productionUrl');
      expect(sb?.env).toBe('sandbox');
      expect(pr?.env).toBe('production');
      expect(String(sb?.default)).toMatch(/^https:\/\//);
      expect(String(pr?.default)).toMatch(/^https:\/\//);
    }
  });
});
