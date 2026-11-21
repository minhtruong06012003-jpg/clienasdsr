/**
 * Tính thuế thuần (không phụ thuộc DB) — dùng bởi TaxService và test.
 *
 * Tương thích ngược: `taxMode` chưa cấu hình được coi là `flat` và cho ra ĐÚNG công thức cũ trong
 * OrdersService.quote / OrdersAdminService.totals:
 *   taxable = subtotal - discount
 *   tax = pricesIncludeTax ? taxable - taxable / (1 + r/100) : taxable * r / 100
 * Số trả về CHƯA làm tròn (nơi gọi làm tròn như trước để không lệch số liệu).
 */
import type { TaxBreakdownLine, TaxComputation, TaxMode } from '@cmsnt/shared';

/** Phần cài đặt `commerce` liên quan đến thuế */
export interface TaxSettings {
  taxMode?: TaxMode | string | null;
  taxRate?: number | string | null;
  pricesIncludeTax?: boolean | null;
}

/** Dòng thuế suất tối thiểu cần để tính (khớp bảng tax_rates) */
export interface TaxRateRow {
  id: string;
  name: string;
  taxClass: string;
  country: string;
  province: string;
  rate: number;
  shipping: boolean;
  priority: number;
  isActive?: boolean;
}

export interface TaxLineInput {
  /** lớp thuế của sản phẩm; null/rỗng = standard */
  taxClass?: string | null;
  /** thành tiền dòng (giá × số lượng, theo giá hiển thị trên đơn) */
  total: number;
}

export interface TaxAddress {
  /** mã quốc gia ISO, mặc định VN */
  country?: string | null;
  /** mã tỉnh "VN-HN" */
  province?: string | null;
}

export interface TaxTotalsInput {
  discountTotal?: number;
  shippingTotal?: number;
}

export const STANDARD_CLASS = 'standard';

/** Chuẩn hoá chế độ thuế; giá trị lạ / chưa cấu hình → flat (hành vi cũ) */
export function resolveTaxMode(mode: unknown): TaxMode {
  return mode === 'none' || mode === 'inclusive' || mode === 'rates' ? mode : 'flat';
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * Chọn thuế suất phù hợp nhất cho (lớp thuế, quốc gia, tỉnh):
 * chỉ xét dòng đang bật, cùng lớp thuế; khớp tỉnh > khớp quốc gia > "*" (mọi nơi); cùng mức thì priority cao hơn thắng.
 */
export function pickTaxRate<R extends TaxRateRow>(rates: R[], taxClass: string | null | undefined, address: TaxAddress = {}): R | null {
  const cls = (taxClass || STANDARD_CLASS).trim().toLowerCase();
  const country = norm(address.country) || 'VN';
  const province = norm(address.province);
  let best: R | null = null;
  let bestScore = -1;
  for (const r of rates) {
    if (r.isActive === false || r.taxClass.trim().toLowerCase() !== cls) continue;
    const rc = norm(r.country) || '*';
    const rp = norm(r.province) || '*';
    if (rc !== '*' && rc !== country) continue;
    if (rp !== '*' && rp !== province) continue;
    // độ cụ thể: tỉnh (2) + quốc gia (1); "*" thấp nhất
    const score = (rp !== '*' ? 2 : 0) + (rc !== '*' ? 1 : 0);
    if (score > bestScore || (score === bestScore && best && r.priority > best.priority)) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** Thuế trên một số tiền: gộp (tách ngược) hoặc cộng thêm */
const taxOf = (amount: number, ratePct: number, inclusive: boolean) => (ratePct ? (inclusive ? amount - amount / (1 + ratePct / 100) : (amount * ratePct) / 100) : 0);

/**
 * Tính thuế cho đơn/báo giá.
 * - flat / inclusive: một mức `taxRate` trên (tạm tính - giảm giá), y công thức cũ; không đánh thuế phí ship.
 * - rates: từng dòng theo lớp thuế + địa chỉ; giảm giá phân bổ theo tỉ lệ thành tiền; phí ship chịu thuế nếu
 *   thuế suất standard áp cho địa chỉ có `shipping = true`.
 */
export function computeTax(lines: TaxLineInput[], address: TaxAddress, totals: TaxTotalsInput, settings: TaxSettings, rates: TaxRateRow[] = []): TaxComputation {
  const mode = resolveTaxMode(settings.taxMode);
  const subtotal = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const discount = Math.min(Math.max(0, Number(totals.discountTotal) || 0), subtotal);
  const shipping = Math.max(0, Number(totals.shippingTotal) || 0);

  if (mode === 'none') return { mode, inclusive: !!settings.pricesIncludeTax, taxTotal: 0, shippingTax: 0, breakdown: [] };

  if (mode === 'flat' || mode === 'inclusive') {
    const rate = Number(settings.taxRate) || 0;
    const inclusive = mode === 'inclusive' ? true : !!settings.pricesIncludeTax;
    const taxTotal = taxOf(subtotal - discount, rate, inclusive);
    return { mode, inclusive, taxTotal, shippingTax: 0, breakdown: rate ? [{ rateId: null, name: `Thuế ${rate}%`, rate, amount: taxTotal }] : [] };
  }

  // ---- rates ----
  const inclusive = !!settings.pricesIncludeTax;
  const groups = new Map<string, TaxBreakdownLine>();
  const addTo = (r: TaxRateRow, amount: number) => {
    if (!amount) return;
    const g = groups.get(r.id) ?? { rateId: r.id, name: r.name, rate: Number(r.rate), amount: 0 };
    g.amount += amount;
    groups.set(r.id, g);
  };
  let taxTotal = 0;
  for (const l of lines) {
    const total = Number(l.total) || 0;
    if (total <= 0) continue;
    // phân bổ giảm giá theo tỉ lệ thành tiền dòng
    const base = subtotal > 0 ? total - (discount * total) / subtotal : total;
    const r = pickTaxRate(rates, l.taxClass, address);
    if (!r) continue;
    const t = taxOf(base, Number(r.rate), inclusive);
    taxTotal += t;
    addTo(r, t);
  }
  let shippingTax = 0;
  if (shipping > 0) {
    const r = pickTaxRate(rates, STANDARD_CLASS, address);
    if (r?.shipping) {
      shippingTax = taxOf(shipping, Number(r.rate), inclusive);
      taxTotal += shippingTax;
      addTo(r, shippingTax);
    }
  }
  return { mode, inclusive, taxTotal, shippingTax, breakdown: [...groups.values()] };
}
