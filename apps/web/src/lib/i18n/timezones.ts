/** Danh sách múi giờ cho ô chọn: "(UTC+07:00) Asia/Ho_Chi_Minh", sắp theo độ lệch giờ */

const FALLBACK_TZ = ["Asia/Ho_Chi_Minh", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai", "Australia/Sydney", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "UTC"];

export interface TimezoneOption {
  value: string;
  label: string;
  /** độ lệch so với UTC (phút) để sắp xếp */
  offset: number;
}

/** Độ lệch UTC hiện tại của một múi giờ (phút), tính cả giờ mùa hè */
function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** "+07:00" */
export function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

let cached: TimezoneOption[] | null = null;

/** Mọi múi giờ trình duyệt hỗ trợ (dự phòng danh sách phổ biến), có nhãn độ lệch */
export function timezoneOptions(): TimezoneOption[] {
  if (cached) return cached;
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = fn ? fn("timeZone") : FALLBACK_TZ;
  const now = new Date();
  cached = list
    .map((value) => {
      const offset = offsetMinutes(value, now);
      return { value, offset, label: `(UTC${formatOffset(offset)}) ${value.replace(/_/g, " ")}` };
    })
    .sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value));
  return cached;
}

/** Thời điểm -> giá trị ô datetime-local (yyyy-MM-ddTHH:mm) theo múi giờ khách chọn */
export function toZonedInput(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Giá trị ô datetime-local (hiểu theo múi giờ `tz`) -> thời điểm thật; sai định dạng -> null */
export function fromZonedInput(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // trừ độ lệch múi giờ; tính lại lần 2 để đúng cả lúc chuyển giờ mùa hè
  let at = asUtc - offsetMinutes(tz, new Date(asUtc)) * 60_000;
  at = asUtc - offsetMinutes(tz, new Date(at)) * 60_000;
  return new Date(at);
}
