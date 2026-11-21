/**
 * Template engine nhẹ cho email (cú pháp giống Handlebars, không phụ thuộc thư viện):
 *  - `{{a.b}}`            giá trị (escape HTML)
 *  - `{{{a.b}}}`          chèn HTML thô
 *  - `{{#each items}}...{{/each}}`   lặp; bên trong dùng `{{this}}`, `{{this.name}}`, `{{@index}}`, `{{@first}}`, `{{@last}}`
 *  - `{{#if x}}...{{else}}...{{/if}}`  điều kiện (falsy: undefined/null/false/0/''/mảng rỗng)
 *  - `{{#unless x}}...{{/unless}}`
 *  - `{{money total}}`, `{{date createdAt}}`  helper (có thể truyền thêm helper qua options)
 *
 * Tra cứu biến theo chuỗi scope: trong `each` tìm ở phần tử hiện tại trước, không có thì tìm ở ngoài.
 */

export type TemplateHelper = (value: unknown, ...args: unknown[]) => string;

export interface RenderOptions {
  helpers?: Record<string, TemplateHelper>;
}

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; path: string; raw: boolean; helper?: string; args: string[] }
  | { type: 'each'; path: string; children: Node[] }
  | { type: 'if'; path: string; negate: boolean; children: Node[]; elseChildren: Node[] };

const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g;

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const BUILTIN_HELPERS: Record<string, TemplateHelper> = {
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  money: (v) => (v === null || v === undefined || v === '' ? '' : `${Number(v).toLocaleString('vi-VN')}₫`),
  date: (v) => (v ? new Date(v as string).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : ''),
  json: (v) => JSON.stringify(v ?? null),
};

/** Phân tích chuỗi mẫu thành cây node */
export function parse(template: string): Node[] {
  const root: Node[] = [];
  // stack các khối đang mở; `target` là mảng đang nhận node (children hoặc elseChildren)
  const stack: { node: Node & ({ type: 'each' } | { type: 'if' }); target: Node[] }[] = [];
  let target = root;
  let last = 0;
  const src = String(template ?? '');
  for (const m of src.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) target.push({ type: 'text', value: src.slice(last, idx) });
    last = idx + m[0].length;
    const raw = m[1] !== undefined;
    const expr = (m[1] ?? m[2] ?? '').trim();

    if (!raw && expr.startsWith('#')) {
      const [kw, ...rest] = expr.slice(1).split(/\s+/);
      const path = rest.join(' ').trim();
      let node: Node;
      if (kw === 'each') node = { type: 'each', path, children: [] };
      else if (kw === 'if') node = { type: 'if', path, negate: false, children: [], elseChildren: [] };
      else if (kw === 'unless') node = { type: 'if', path, negate: true, children: [], elseChildren: [] };
      else {
        target.push({ type: 'text', value: m[0] });
        continue;
      }
      target.push(node);
      stack.push({ node, target });
      target = node.children;
      continue;
    }
    if (!raw && expr === 'else') {
      const top = stack[stack.length - 1];
      if (top && top.node.type === 'if') target = top.node.elseChildren;
      continue;
    }
    if (!raw && expr.startsWith('/')) {
      const kw = expr.slice(1).trim();
      const top = stack.pop();
      if (!top) continue;
      const expected = top.node.type === 'each' ? 'each' : top.node.negate ? 'unless' : 'if';
      if (kw !== expected) {
        // thẻ đóng không khớp: coi như đóng khối gần nhất để không treo render
      }
      target = top.target;
      continue;
    }
    // {{helper path arg...}} hoặc {{path}}
    const parts = expr.split(/\s+/);
    if (parts.length > 1) target.push({ type: 'var', helper: parts[0], path: parts[1], args: parts.slice(2), raw });
    else target.push({ type: 'var', path: expr, raw, args: [] });
  }
  if (last < src.length) target.push({ type: 'text', value: src.slice(last) });
  return root;
}

function lookup(path: string, scopes: unknown[]): unknown {
  if (path === 'this') return scopes[0];
  if (path.startsWith('this.')) return dig(scopes[0], path.slice(5));
  if (path.startsWith('@')) {
    for (const s of scopes) if (s && typeof s === 'object' && path in (s as object)) return (s as Record<string, unknown>)[path];
    return undefined;
  }
  for (const s of scopes) {
    if (s === null || s === undefined || typeof s !== 'object') continue;
    const v = dig(s, path);
    if (v !== undefined) return v;
  }
  return undefined;
}

function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

function resolveArg(arg: string, scopes: unknown[]): unknown {
  if (/^(['"]).*\1$/.test(arg)) return arg.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(arg)) return Number(arg);
  if (arg === 'true') return true;
  if (arg === 'false') return false;
  return lookup(arg, scopes);
}

function renderNodes(nodes: Node[], scopes: unknown[], helpers: Record<string, TemplateHelper>): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value;
    } else if (n.type === 'var') {
      let value = lookup(n.path, scopes);
      if (n.helper) {
        const fn = helpers[n.helper];
        if (fn) value = fn(value, ...n.args.map((a) => resolveArg(a, scopes)));
        else value = lookup(n.helper, scopes); // không phải helper -> coi như biến có khoảng trắng thừa
      }
      if (value === null || value === undefined) continue;
      if (typeof value === 'object' && !(value instanceof Date)) value = Array.isArray(value) ? value.join(', ') : JSON.stringify(value);
      if (value instanceof Date) value = value.toISOString();
      out += n.raw || n.helper === 'raw' ? String(value) : escapeHtml(value);
    } else if (n.type === 'each') {
      const list = lookup(n.path, scopes);
      const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
      arr.forEach((item, i) => {
        const meta = { '@index': i, '@number': i + 1, '@first': i === 0, '@last': i === arr.length - 1 };
        out += renderNodes(n.children, [item, meta, ...scopes], helpers);
      });
    } else if (n.type === 'if') {
      const ok = truthy(lookup(n.path, scopes)) !== n.negate;
      out += renderNodes(ok ? n.children : n.elseChildren, scopes, helpers);
    }
  }
  return out;
}

/** Render mẫu với biến. Biến thiếu -> chuỗi rỗng. */
export function render(template: string, vars: Record<string, unknown>, options: RenderOptions = {}): string {
  const helpers = { ...BUILTIN_HELPERS, ...(options.helpers ?? {}) };
  return renderNodes(parse(template), [vars], helpers);
}

/** Liệt kê tên biến/đường dẫn dùng trong mẫu (để gợi ý / kiểm tra) */
export function usedPaths(template: string): string[] {
  const out = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 'var') out.add(n.path);
      else if (n.type === 'each') {
        out.add(n.path);
        walk(n.children);
      } else if (n.type === 'if') {
        out.add(n.path);
        walk(n.children);
        walk(n.elseChildren);
      }
    }
  };
  walk(parse(template));
  return [...out];
}

export interface MoneyFormat {
  currencySymbol?: string;
  currencyPosition?: 'before' | 'after' | string;
  thousandSeparator?: string;
  decimalSeparator?: string;
  decimals?: number;
}

/** Định dạng tiền theo Cài đặt › Bán hàng */
export function formatMoney(value: unknown, fmt: MoneyFormat = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const decimals = Number.isInteger(fmt.decimals) ? Number(fmt.decimals) : 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, fmt.thousandSeparator ?? '.');
  const num = decPart ? `${grouped}${fmt.decimalSeparator ?? ','}${decPart}` : grouped;
  const symbol = fmt.currencySymbol ?? '₫';
  const sign = n < 0 ? '-' : '';
  return fmt.currencyPosition === 'before' ? `${sign}${symbol}${num}` : `${sign}${num}${symbol}`;
}

/** Định dạng ngày giờ dd/MM/yyyy HH:mm theo múi giờ */
export function formatDate(value: unknown, timeZone = 'Asia/Ho_Chi_Minh', withTime = true): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    const parts = new Intl.DateTimeFormat('vi-VN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const date = `${get('day')}/${get('month')}/${get('year')}`;
    return withTime ? `${date} ${get('hour')}:${get('minute')}` : date;
  } catch {
    return d.toISOString();
  }
}
