import { describe, expect, it } from 'vitest';
import { clampPercent, normalizeTopup, packBonus, quoteTopup } from './credits.settings.js';

describe('credits.settings', () => {
  it('packBonus: % tặng thêm so với đơn giá gói gốc', () => {
    const base = 52_000 / 20;
    expect(packBonus({ price: 52_000, credits: 20 }, base)).toBe(0);
    expect(packBonus({ price: 130_000, credits: 51 }, base)).toBe(2);
    expect(packBonus({ price: 2_600_000, credits: 1100 }, base)).toBe(10);
  });

  it('packBonus: gói miễn phí / chưa có đơn giá gốc thì không tặng', () => {
    expect(packBonus({ price: 0, credits: 10 }, 2600)).toBe(0);
    expect(packBonus({ price: 52_000, credits: 20 }, 0)).toBe(0);
  });

  it('clampPercent: giữ trong khoảng 0–100', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(15)).toBe(15);
    expect(clampPercent(150)).toBe(100);
  });
});

describe('nạp credits', () => {
  const s = normalizeTopup({
    rate: 1,
    min: 10_000,
    tiers: [
      { min: 1_000_000, bonus: 5 },
      { min: 500_000, bonus: 3 },
      { min: 0, bonus: 50 },
    ],
    promo: { enabled: true, bonus: 10, label: 'KM', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-02-01T00:00:00Z' },
  });

  it('normalizeTopup: bỏ mốc lỗi, sắp mốc tăng dần', () => {
    expect(s.tiers).toEqual([
      { min: 500_000, bonus: 3 },
      { min: 1_000_000, bonus: 5 },
    ]);
  });

  it('quoteTopup: lấy mốc cao nhất đạt được + khuyến mãi trong thời gian chạy', () => {
    const inPromo = new Date('2026-01-15T00:00:00Z');
    expect(quoteTopup(100_000, s, 0, inPromo)).toMatchObject({ base: 100_000, tierBonus: 0, promoBonus: 10, credits: 110_000 });
    expect(quoteTopup(1_200_000, s, 0, inPromo)).toMatchObject({ tierBonus: 5, promoBonus: 10, credits: 1_380_000 });
  });

  it('quoteTopup: hết thời gian khuyến mãi thì chỉ còn mốc + ưu đãi riêng', () => {
    const after = new Date('2026-03-01T00:00:00Z');
    expect(quoteTopup(600_000, s, 2, after)).toMatchObject({ tierBonus: 3, promoBonus: 0, personalBonus: 2, credits: 630_000 });
  });
});
