import { computeTax, pickTaxRate, resolveTaxMode, type TaxRateRow } from './tax.calc.js';

/** Công thức cũ trong OrdersService.quote (trước khi có TaxService) để so khớp tương thích */
function legacy(subtotal: number, discount: number, shipping: number, taxRate: number, pricesIncludeTax: boolean) {
  const taxable = subtotal - discount;
  const taxTotal = taxRate ? (pricesIncludeTax ? taxable - taxable / (1 + taxRate / 100) : (taxable * taxRate) / 100) : 0;
  return { taxTotal, total: taxable + shipping + (pricesIncludeTax ? 0 : taxTotal) };
}

const rate = (over: Partial<TaxRateRow>): TaxRateRow => ({ id: over.id ?? 'r', name: over.name ?? 'VAT', taxClass: 'standard', country: '*', province: '*', rate: 10, shipping: false, priority: 0, isActive: true, ...over });

describe('tax: resolveTaxMode', () => {
  it('chưa cấu hình / giá trị lạ -> flat (hành vi cũ)', () => {
    expect(resolveTaxMode(undefined)).toBe('flat');
    expect(resolveTaxMode('abc')).toBe('flat');
    expect(resolveTaxMode('rates')).toBe('rates');
    expect(resolveTaxMode('none')).toBe('none');
  });
});

describe('tax: computeTax chế độ flat khớp công thức cũ', () => {
  const cases: [number, number, number, number, boolean][] = [
    [1_000_000, 0, 30_000, 0, true],
    [1_000_000, 100_000, 30_000, 10, true],
    [1_000_000, 100_000, 30_000, 10, false],
    [333_333, 33_333, 0, 8, false],
    [125_000, 0, 15_000, 5, true],
  ];
  it.each(cases)('subtotal=%d discount=%d ship=%d rate=%d incl=%s', (subtotal, discount, ship, r, incl) => {
    const res = computeTax([{ total: subtotal }], {}, { discountTotal: discount, shippingTotal: ship }, { taxRate: r, pricesIncludeTax: incl });
    const old = legacy(subtotal, discount, ship, r, incl);
    expect(res.mode).toBe('flat');
    expect(res.inclusive).toBe(incl);
    expect(res.taxTotal).toBeCloseTo(old.taxTotal, 8);
    expect(subtotal - discount + ship + (res.inclusive ? 0 : res.taxTotal)).toBeCloseTo(old.total, 8);
    expect(res.shippingTax).toBe(0);
  });

  it('bỏ qua bảng thuế suất khi không ở chế độ rates', () => {
    const res = computeTax([{ total: 100, taxClass: 'reduced' }], { province: 'VN-HN' }, {}, { taxRate: 10, pricesIncludeTax: false }, [rate({ rate: 50 })]);
    expect(res.taxTotal).toBeCloseTo(10);
  });
});

describe('tax: computeTax chế độ none / inclusive', () => {
  it('none -> 0', () => {
    expect(computeTax([{ total: 1000 }], {}, {}, { taxMode: 'none', taxRate: 10 }).taxTotal).toBe(0);
  });
  it('inclusive luôn tách ngược dù pricesIncludeTax = false', () => {
    const res = computeTax([{ total: 1100 }], {}, {}, { taxMode: 'inclusive', taxRate: 10, pricesIncludeTax: false });
    expect(res.inclusive).toBe(true);
    expect(res.taxTotal).toBeCloseTo(100);
  });
});

describe('tax: pickTaxRate', () => {
  const rates = [
    rate({ id: 'all', rate: 10 }),
    rate({ id: 'vn', country: 'VN', rate: 8 }),
    rate({ id: 'hn', country: 'VN', province: 'VN-HN', rate: 5 }),
    rate({ id: 'hn-low', country: 'VN', province: 'VN-HN', rate: 3, priority: -1 }),
    rate({ id: 'reduced', taxClass: 'reduced', rate: 5 }),
    rate({ id: 'off', country: 'VN', province: 'VN-SG', rate: 1, isActive: false }),
  ];
  it('tỉnh > quốc gia > "*"; cùng mức thì priority cao hơn', () => {
    expect(pickTaxRate(rates, null, { country: 'VN', province: 'VN-HN' })?.id).toBe('hn');
    expect(pickTaxRate(rates, 'standard', { country: 'vn', province: 'vn-hn' })?.id).toBe('hn');
    expect(pickTaxRate(rates, null, { country: 'VN', province: 'VN-DN' })?.id).toBe('vn');
    expect(pickTaxRate(rates, null, { country: 'US' })?.id).toBe('all');
  });
  it('mặc định quốc gia VN, bỏ dòng tắt, lọc theo lớp thuế', () => {
    expect(pickTaxRate(rates, null, {})?.id).toBe('vn');
    expect(pickTaxRate(rates, null, { province: 'VN-SG' })?.id).toBe('vn');
    expect(pickTaxRate(rates, 'reduced', { province: 'VN-HN' })?.id).toBe('reduced');
    expect(pickTaxRate(rates, 'zero', { province: 'VN-HN' })).toBeNull();
  });
});

describe('tax: computeTax chế độ rates', () => {
  const rates = [
    rate({ id: 'std', name: 'VAT 10%', rate: 10, shipping: true }),
    rate({ id: 'hn', name: 'HN 8%', country: 'VN', province: 'VN-HN', rate: 8 }),
    rate({ id: 'red', name: 'Giảm 5%', taxClass: 'reduced', rate: 5 }),
  ];
  const settings = { taxMode: 'rates', pricesIncludeTax: false };

  it('mỗi dòng theo lớp thuế, giảm giá phân bổ theo tỉ lệ, ship chịu thuế theo mức standard', () => {
    const res = computeTax(
      [
        { taxClass: null, total: 600 },
        { taxClass: 'reduced', total: 400 },
      ],
      { country: 'VN', province: 'VN-DN' },
      { discountTotal: 100, shippingTotal: 50 },
      settings,
      rates,
    );
    // dòng 1: (600 - 60) * 10% = 54; dòng 2: (400 - 40) * 5% = 18; ship 50 * 10% = 5
    expect(res.taxTotal).toBeCloseTo(77);
    expect(res.shippingTax).toBeCloseTo(5);
    expect(res.inclusive).toBe(false);
    expect(res.breakdown.find((b) => b.rateId === 'std')?.amount).toBeCloseTo(59);
    expect(res.breakdown.find((b) => b.rateId === 'red')?.amount).toBeCloseTo(18);
  });

  it('địa chỉ HN dùng mức tỉnh; mức tỉnh không áp ship -> ship không chịu thuế', () => {
    const res = computeTax([{ taxClass: 'standard', total: 1000 }], { province: 'VN-HN' }, { shippingTotal: 30 }, settings, rates);
    expect(res.taxTotal).toBeCloseTo(80);
    expect(res.shippingTax).toBe(0);
  });

  it('giá đã gồm thuế -> tách ngược', () => {
    const res = computeTax([{ total: 1080 }], { province: 'VN-HN' }, {}, { taxMode: 'rates', pricesIncludeTax: true }, rates);
    expect(res.inclusive).toBe(true);
    expect(res.taxTotal).toBeCloseTo(80);
  });

  it('lớp thuế không có mức nào -> 0; giảm giá không vượt tạm tính', () => {
    const res = computeTax([{ taxClass: 'zero', total: 500 }, { total: 500 }], {}, { discountTotal: 5000 }, settings, rates);
    expect(res.taxTotal).toBe(0);
  });
});
