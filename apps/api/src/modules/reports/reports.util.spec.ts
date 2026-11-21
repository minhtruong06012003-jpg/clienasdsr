import { describe, expect, it } from 'vitest';
import { addDays, csvEscape, localDay, pctChange, periodKey, periodKeys, resolveRange, toCsv, zonedDayStart } from './reports.util.js';

const TZ = 'Asia/Ho_Chi_Minh';

describe('reports.util', () => {
  it('zonedDayStart: 00:00 giờ Việt Nam = 17:00 UTC hôm trước', () => {
    expect(zonedDayStart('2026-10-03', TZ).toISOString()).toBe('2026-10-02T17:00:00.000Z');
    expect(localDay(new Date('2026-10-02T17:00:00.000Z'), TZ)).toBe('2026-10-03');
    expect(localDay(new Date('2026-10-02T16:59:59.000Z'), TZ)).toBe('2026-10-02');
  });

  it('resolveRange: mặc định 30 ngày tính cả hôm nay, to không bao gồm', () => {
    const r = resolveRange({}, TZ, new Date('2026-10-03T05:00:00.000Z'));
    expect(r.fromDay).toBe('2026-09-04');
    expect(r.toDay).toBe('2026-10-03');
    expect(r.to.toISOString()).toBe('2026-10-03T17:00:00.000Z');
    expect(r.prevTo.getTime()).toBe(r.from.getTime());
    expect(r.to.getTime() - r.from.getTime()).toBe(r.prevTo.getTime() - r.prevFrom.getTime());
  });

  it('resolveRange: nhận ngày lịch và tự đảo nếu from > to', () => {
    const r = resolveRange({ from: '2026-10-05', to: '2026-10-01' }, TZ);
    expect(r.fromDay).toBe('2026-10-01');
    expect(r.toDay).toBe('2026-10-05');
    expect(r.from.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-05T17:00:00.000Z');
  });

  it('periodKey/periodKeys: tuần bắt đầu thứ Hai, tháng ngày 1, phủ kín khoảng', () => {
    expect(periodKey('2026-10-03', 'week')).toBe('2026-09-28'); // thứ Bảy -> thứ Hai
    expect(periodKey('2026-10-03', 'month')).toBe('2026-10-01');
    expect(periodKeys('2026-09-29', '2026-10-02', 'day')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(periodKeys('2026-11-20', '2027-01-05', 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(periodKeys('2026-09-30', '2026-10-13', 'week')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('pctChange', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(10, 0)).toBe(100);
    expect(pctChange(0, 0)).toBe(0);
  });

  it('csv: BOM, nháy kép, chống chèn công thức', () => {
    expect(csvEscape('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape(null)).toBe('""');
    const csv = toCsv(['Kỳ', 'Doanh thu'], [['2026-10-01', 1000]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"2026-10-01","1000"');
  });
});
