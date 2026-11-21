import { buildLines, integerToVietnameseWords, isValidTaxCode, numberToVietnameseWords, roundMoney, summarize, vatRateCode } from './einvoice.calc.js';
import { normalizeInvoiceRequest } from './einvoice.request.js';

describe('einvoice: buildLines (giá đã gồm VAT 10%)', () => {
  const lines = buildLines({
    items: [
      { name: 'Áo thun', quantity: 2, price: 110_000 },
      { name: 'Quần jean', quantity: 1, price: 330_000 },
    ],
    discountTotal: 55_000,
    shippingTotal: 33_000,
    shippingAsLine: true,
    defaultVatRate: 10,
    pricesIncludeVat: true,
    discountMode: 'perLine',
  });

  it('tách VAT ngược: đơn giá chưa thuế = giá / 1.1', () => {
    expect(lines[0].unitPrice).toBe(100_000);
    expect(lines[1].unitPrice).toBe(300_000);
  });

  it('phân bổ chiết khấu theo tỉ lệ giá trị dòng (220k : 330k = 2 : 3)', () => {
    // 55.000đ gồm VAT -> 50.000 chưa VAT, chia 20.000 / 30.000
    expect(lines[0].discount).toBe(20_000);
    expect(lines[1].discount).toBe(30_000);
    expect(lines[0].amount).toBe(180_000);
    expect(lines[1].amount).toBe(270_000);
  });

  it('có dòng phí vận chuyển chưa VAT 30.000', () => {
    const ship = lines.find((l) => l.kind === 'shipping')!;
    expect(ship.amount).toBe(30_000);
    expect(ship.vatAmount).toBe(3_000);
  });

  it('tổng khớp với tổng đơn hàng (220k + 330k − 55k + 33k = 528k)', () => {
    const t = summarize(lines);
    expect(t.subtotal).toBe(480_000);
    expect(t.vatTotal).toBe(48_000);
    expect(t.total).toBe(528_000);
    expect(t.breakdown).toEqual([{ vatRate: 10, amount: 480_000, vatAmount: 48_000 }]);
    expect(t.totalInWords).toBe('Năm trăm hai mươi tám nghìn đồng');
  });
});

describe('einvoice: buildLines (giá chưa VAT, chiết khấu dòng riêng, nhiều thuế suất)', () => {
  const lines = buildLines({
    items: [
      { name: 'Sách', quantity: 3, price: 50_000, vatRate: 5 },
      { name: 'Dịch vụ KCT', quantity: 1, price: 200_000, vatRate: -1 },
    ],
    discountTotal: 10_000,
    defaultVatRate: 10,
    pricesIncludeVat: false,
    discountMode: 'separate',
  });

  it('dòng chiết khấu riêng là số âm theo thuế suất mặc định', () => {
    const d = lines.find((l) => l.kind === 'discount')!;
    expect(d.amount).toBe(-10_000);
    expect(d.vatAmount).toBe(-1_000);
  });

  it('thuế suất KCT không tính tiền thuế, có mã KCT', () => {
    const kct = lines[1];
    expect(kct.vatAmount).toBe(0);
    expect(vatRateCode(kct.vatRate)).toBe('KCT');
  });

  it('tổng hợp theo từng thuế suất', () => {
    const t = summarize(lines);
    expect(t.breakdown.map((b) => b.vatRate).sort()).toEqual([-1, 10, 5].sort());
    expect(t.subtotal).toBe(150_000 + 200_000 - 10_000);
    expect(t.vatTotal).toBe(7_500 - 1_000);
  });
});

describe('einvoice: đọc số bằng chữ', () => {
  it.each([
    [0, 'không'],
    [5, 'năm'],
    [15, 'mười lăm'],
    [21, 'hai mươi mốt'],
    [24, 'hai mươi tư'],
    [105, 'một trăm lẻ năm'],
    [1_000, 'một nghìn'],
    [1_005, 'một nghìn không trăm lẻ năm'],
    [12_345, 'mười hai nghìn ba trăm bốn mươi lăm'],
    [1_000_000, 'một triệu'],
    [1_000_000_000, 'một tỷ'],
    [2_500_000_000, 'hai tỷ năm trăm triệu'],
  ])('%i -> %s', (n, words) => {
    expect(integerToVietnameseWords(n)).toBe(words);
  });

  it('kèm đơn vị tiền tệ và viết hoa chữ đầu', () => {
    expect(numberToVietnameseWords(1_250_000)).toBe('Một triệu hai trăm năm mươi nghìn đồng');
    expect(numberToVietnameseWords(10.5, 'USD')).toBe('Mười đô la Mỹ và năm mươi cent');
    expect(numberToVietnameseWords(-100)).toBe('Âm một trăm đồng');
  });
});

describe('einvoice: mã số thuế & yêu cầu xuất HĐ', () => {
  it('MST hợp lệ 10 số hoặc 10-3 số', () => {
    expect(isValidTaxCode('0101234567')).toBe(true);
    expect(isValidTaxCode('0101234567-001')).toBe(true);
    expect(isValidTaxCode('123')).toBe(false);
    expect(isValidTaxCode('0101234567001')).toBe(false);
  });

  it('roundMoney làm tròn theo số lẻ', () => {
    expect(roundMoney(1234.5)).toBe(1235);
    expect(roundMoney(1.005, 2)).toBe(1.01);
  });

  it('normalizeInvoiceRequest: công ty bắt buộc MST, cá nhân không', () => {
    expect(normalizeInvoiceRequest(null)).toBeNull();
    expect(normalizeInvoiceRequest({ requested: false })).toEqual({ requested: false });
    expect(() => normalizeInvoiceRequest({ requested: true, type: 'company', name: 'Cty A', address: 'HN' })).toThrow(/mã số thuế/i);
    expect(() => normalizeInvoiceRequest({ requested: true, type: 'company', name: 'Cty A', address: 'HN', taxCode: '12' })).toThrow(/không hợp lệ/);
    expect(normalizeInvoiceRequest({ requested: true, type: 'personal', name: 'Nguyễn A', address: 'HN', email: 'a@b.vn' })).toMatchObject({ requested: true, type: 'personal', name: 'Nguyễn A', email: 'a@b.vn' });
    expect(normalizeInvoiceRequest({ requested: true, type: 'company', name: 'Cty A', address: 'HN', taxCode: '0101234567' }, false)?.taxCode).toBe('0101234567');
  });
});
