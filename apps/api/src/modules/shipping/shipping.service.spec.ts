import { computeMethodCost, matchRule, pickZone } from './shipping.service.js';
import { couponEligibleTotal } from '../orders/orders.service.js';
import { VN_PROVINCES } from './regions.js';

describe('shipping: regions', () => {
  it('có đủ 63 tỉnh/thành, mã không trùng', () => {
    expect(VN_PROVINCES).toHaveLength(63);
    expect(new Set(VN_PROVINCES.map((p) => p.code)).size).toBe(63);
    expect(VN_PROVINCES.every((p) => p.code.startsWith('VN-'))).toBe(true);
  });
});

describe('shipping: pickZone', () => {
  const zones = [
    { id: 'all', regions: ['*'] },
    { id: 'vn', regions: ['VN'] },
    { id: 'hn', regions: ['VN-HN', 'VN-HP'] },
  ];
  it('ưu tiên tỉnh > quốc gia > mọi nơi, bất kể thứ tự', () => {
    expect(pickZone(zones, 'VN-HN', 'VN')?.id).toBe('hn');
    expect(pickZone(zones, 'VN-SG', 'VN')?.id).toBe('vn');
    expect(pickZone(zones, undefined, 'US')?.id).toBe('all');
    expect(pickZone(zones, undefined, undefined)?.id).toBe('vn');
  });
  it('không khớp vùng nào -> null', () => {
    expect(pickZone([{ regions: ['VN-HN'] }], 'VN-SG', 'VN')).toBeNull();
    expect(pickZone([{ regions: ['VN-HN'] }], undefined, 'VN')).toBeNull();
  });
});

describe('shipping: matchRule / computeMethodCost', () => {
  const rules = [
    { upTo: 500, cost: 20000 },
    { upTo: 2000, cost: 35000 },
    { upTo: null, cost: 60000 },
  ];
  it('tra bảng theo upTo tăng dần, null = còn lại', () => {
    expect(matchRule(rules, 100)).toBe(20000);
    expect(matchRule(rules, 500)).toBe(20000);
    expect(matchRule(rules, 1500)).toBe(35000);
    expect(matchRule(rules, 9999)).toBe(60000);
    expect(matchRule([{ upTo: 500, cost: 1 }], 600)).toBeNull();
    expect(matchRule([], 1)).toBeNull();
  });
  it('FLAT / PICKUP / FREE', () => {
    expect(computeMethodCost({ type: 'FLAT', cost: 30000 as never, minOrderTotal: null, rules: [] }, { subtotal: 1, weight: 0 })).toBe(30000);
    expect(computeMethodCost({ type: 'PICKUP', cost: 30000 as never, minOrderTotal: null, rules: [] }, { subtotal: 1, weight: 0 })).toBe(0);
    expect(computeMethodCost({ type: 'FREE', cost: 0 as never, minOrderTotal: 500000 as never, rules: [] }, { subtotal: 499999, weight: 0 })).toBeNull();
    expect(computeMethodCost({ type: 'FREE', cost: 0 as never, minOrderTotal: 500000 as never, rules: [] }, { subtotal: 500000, weight: 0 })).toBe(0);
    expect(computeMethodCost({ type: 'FREE', cost: 0 as never, minOrderTotal: null, rules: [] }, { subtotal: 1, weight: 0 })).toBe(0);
  });
  it('WEIGHT theo gram, PRICE theo tạm tính, không khớp -> phí mặc định', () => {
    expect(computeMethodCost({ type: 'WEIGHT', cost: 99 as never, minOrderTotal: null, rules }, { subtotal: 0, weight: 1200 })).toBe(35000);
    expect(computeMethodCost({ type: 'PRICE', cost: 99 as never, minOrderTotal: null, rules }, { subtotal: 300, weight: 0 })).toBe(20000);
    expect(computeMethodCost({ type: 'PRICE', cost: 99 as never, minOrderTotal: null, rules: [{ upTo: 100, cost: 5 }] }, { subtotal: 300, weight: 0 })).toBe(99);
  });
});

describe('coupon: couponEligibleTotal', () => {
  const items = [
    { productId: 'a', categoryIds: ['c1'], total: 100 },
    { productId: 'b', categoryIds: ['c2'], total: 200 },
    { productId: 'c', categoryIds: [], total: 300 },
  ];
  it('không điều kiện -> toàn bộ', () => {
    expect(couponEligibleTotal({ productIds: [], excludeProductIds: [], categoryIds: [] }, items)).toBe(600);
  });
  it('productIds hoặc categoryIds (OR), excludeProductIds loại trừ', () => {
    expect(couponEligibleTotal({ productIds: ['a'], excludeProductIds: [], categoryIds: [] }, items)).toBe(100);
    expect(couponEligibleTotal({ productIds: [], excludeProductIds: [], categoryIds: ['c2'] }, items)).toBe(200);
    expect(couponEligibleTotal({ productIds: ['a'], excludeProductIds: [], categoryIds: ['c2'] }, items)).toBe(300);
    expect(couponEligibleTotal({ productIds: [], excludeProductIds: ['c'], categoryIds: [] }, items)).toBe(300);
    expect(couponEligibleTotal({ productIds: ['a'], excludeProductIds: ['a'], categoryIds: [] }, items)).toBe(0);
  });
});
