/**
 * Lọc sản phẩm theo thuộc tính dùng chung: `?attr[color]=red,blue&attr[size]=m`.
 * Một sản phẩm khớp khi có ÍT NHẤT MỘT biến thể đang bán (isActive) thoả TẤT CẢ thuộc tính được lọc
 * (mỗi thuộc tính: một trong các giá trị liệt kê) — dựa trên ProductVariant.optionValues { [key]: value }.
 */
import { ATTRIBUTE_KEY_RE } from '@cmsnt/shared';
import type { Prisma } from '../../generated/prisma/client.js';

/** Giới hạn để tránh query quá nặng */
const MAX_KEYS = 8;
const MAX_VALUES = 20;

/**
 * Đọc bộ lọc thuộc tính từ query thô (ValidationPipe whitelist bỏ key lạ nên controller đọc req.query).
 * Hỗ trợ: `attr[key]=a,b` (qs extended), `attr[key]=a&attr[key]=b`, khoá phẳng `attr[key]` / `attr.key` / `attr_key` (query parser simple).
 */
export function parseAttrQuery(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  const add = (key: string, v: unknown) => {
    const k = key.toLowerCase();
    if (!ATTRIBUTE_KEY_RE.test(k)) return;
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').flatMap((s) => s.split(','));
    const vals = list.map((s) => s.trim()).filter((s) => s && s.length <= 100);
    if (!vals.length) return;
    out[k] = [...new Set([...(out[k] ?? []), ...vals])].slice(0, MAX_VALUES);
  };
  if (q.attr && typeof q.attr === 'object' && !Array.isArray(q.attr)) for (const [k, v] of Object.entries(q.attr as Record<string, unknown>)) add(k, v);
  for (const [k, v] of Object.entries(q)) {
    const m = /^attr(?:\[([a-z0-9_]+)\]|\.([a-z0-9_]+)|_([a-z0-9_]+))$/i.exec(k);
    if (m) add(m[1] ?? m[2] ?? m[3], v);
  }
  const keys = Object.keys(out).slice(0, MAX_KEYS);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, out[k]])) : undefined;
}

/** Điều kiện Prisma cho bộ lọc thuộc tính (rỗng nếu không lọc) */
export function attrWhere(filters: Record<string, string[]> | undefined): Prisma.ProductWhereInput[] {
  if (!filters) return [];
  const conds: Prisma.ProductVariantWhereInput[] = Object.entries(filters).map(([key, values]) => ({
    OR: values.map((v) => ({ optionValues: { path: [key], equals: v } })),
  }));
  if (!conds.length) return [];
  return [{ variants: { some: { isActive: true, AND: conds } } }];
}
