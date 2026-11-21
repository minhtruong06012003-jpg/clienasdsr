import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/** Phụ thuộc mà mỗi cổng cần: đọc cấu hình (nhóm cài đặt cùng tên cổng) và truy vấn DB */
export interface GatewayDeps {
  settings: SettingsService;
  prisma: PrismaService;
}

/** HMAC-SHA256 dùng ký / kiểm chữ ký của các cổng */
export const hmacSha256 = (key: string, data: string, encoding: 'hex' | 'base64' = 'hex') => createHmac('sha256', key).update(data, 'utf8').digest(encoding);

/** So sánh chuỗi chống timing attack */
export function safeEqual(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Gọi API cổng thanh toán, timeout 15s, trả JSON */
export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Phản hồi không hợp lệ (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json as T;
}

/** Bỏ dấu, chỉ giữ chữ số + chữ cái (nội dung chuyển khoản) */
export const alnum = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]/g, '');
