/**
 * Tiện ích cho báo cáo bán hàng: khoảng thời gian theo múi giờ website, nhóm kỳ, xuất CSV.
 * Không phụ thuộc Prisma để có thể test đơn vị.
 */

export type Interval = 'day' | 'week' | 'month';

export interface ResolvedRange {
  /** Mốc bắt đầu (UTC instant, bao gồm) */
  from: Date;
  /** Mốc kết thúc (UTC instant, KHÔNG bao gồm) */
  to: Date;
  /** Kỳ trước có cùng độ dài, nằm ngay trước `from` */
  prevFrom: Date;
  prevTo: Date;
  /** Ngày địa phương đầu/cuối (YYYY-MM-DD) — dùng để sinh các mốc rỗng trên biểu đồ */
  fromDay: string;
  toDay: string;
  timezone: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Múi giờ IANA có hợp lệ với Intl không */
export function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Độ lệch (phút) của múi giờ `tz` so với UTC tại thời điểm `at` */
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Ngày địa phương (YYYY-MM-DD) của một thời điểm theo múi giờ */
export function localDay(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 00:00 ngày địa phương `day` (YYYY-MM-DD) theo múi giờ -> UTC instant */
export function zonedDayStart(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // lệch 1 lần rồi tính lại để đúng cả ngày đổi giờ mùa hè
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let result = guess - offset * 60000;
  offset = tzOffsetMinutes(new Date(result), tz);
  result = guess - offset * 60000;
  return new Date(result);
}

/** Cộng N ngày vào chuỗi YYYY-MM-DD (tính trên lịch, không phụ thuộc múi giờ) */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Số ngày giữa 2 ngày lịch (b - a) */
export function diffDays(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400_000);
}

/**
 * Chuẩn hoá khoảng thời gian từ query `from`/`to`.
 * - Nhận ngày `YYYY-MM-DD` (hiểu theo múi giờ website, `to` bao gồm cả ngày) hoặc ISO datetime.
 * - Mặc định 30 ngày gần nhất (tính cả hôm nay). Giới hạn tối đa 2 năm.
 */
export function resolveRange(q: { from?: string; to?: string }, tz: string, now = new Date()): ResolvedRange {
  const today = localDay(now, tz);
  let fromDay: string;
  let toDay: string;
  let from: Date;
  let to: Date;

  if (q.to && DATE_ONLY.test(q.to)) toDay = q.to;
  else if (q.to && !Number.isNaN(Date.parse(q.to))) toDay = localDay(new Date(q.to), tz);
  else toDay = today;

  if (q.from && DATE_ONLY.test(q.from)) fromDay = q.from;
  else if (q.from && !Number.isNaN(Date.parse(q.from))) fromDay = localDay(new Date(q.from), tz);
  else fromDay = addDays(toDay, -29);

  if (diffDays(fromDay, toDay) < 0) [fromDay, toDay] = [toDay, fromDay];
  if (diffDays(fromDay, toDay) > 731) fromDay = addDays(toDay, -731);

  // ISO datetime -> giữ nguyên mốc giờ; ngày lịch -> trọn ngày địa phương
  from = q.from && !DATE_ONLY.test(q.from) && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from) : zonedDayStart(fromDay, tz);
  to = q.to && !DATE_ONLY.test(q.to) && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to) : zonedDayStart(addDays(toDay, 1), tz);
  if (from.getTime() > to.getTime()) [from, to] = [to, from];

  const length = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - length), prevTo: from, fromDay, toDay, timezone: tz };
}

/** Khoá kỳ (YYYY-MM-DD) của một ngày lịch theo interval: tuần = thứ Hai, tháng = ngày 1 */
export function periodKey(day: string, interval: Interval): string {
  if (interval === 'day') return day;
  const [y, m, d] = day.split('-').map(Number);
  if (interval === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = CN
  return addDays(day, -((dow + 6) % 7));
}

/** Danh sách khoá kỳ (đã sắp xếp) phủ kín khoảng ngày — để biểu đồ không bị hụt kỳ không có đơn */
export function periodKeys(fromDay: string, toDay: string, interval: Interval): string[] {
  const keys: string[] = [];
  let key = periodKey(fromDay, interval);
  const last = periodKey(toDay, interval);
  while (key <= last) {
    keys.push(key);
    if (interval === 'day') key = addDays(key, 1);
    else if (interval === 'week') key = addDays(key, 7);
    else {
      const [y, m] = key.split('-').map(Number);
      key = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    }
  }
  return keys;
}

/** % thay đổi so với kỳ trước (làm tròn 1 chữ số); kỳ trước = 0 -> 100 nếu có tăng, 0 nếu không */
export function pctChange(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Ô CSV: bọc dấu nháy, nhân đôi nháy kép, chặn công thức Excel (=, +, -, @, tab, CR) */
export function csvEscape(value: unknown): string {
  let s = value == null ? '' : value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(', ') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Nối header + các dòng thành nội dung CSV UTF-8 có BOM (Excel đọc đúng tiếng Việt) */
export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
}
