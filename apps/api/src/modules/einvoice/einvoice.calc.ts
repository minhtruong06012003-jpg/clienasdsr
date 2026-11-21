/**
 * Hàm tính toán thuần (không phụ thuộc NestJS) cho hoá đơn điện tử:
 * - dựng dòng hàng từ đơn hàng (tách VAT ngược khi giá đã gồm thuế, phân bổ chiết khấu, dòng phí vận chuyển)
 * - tổng hợp theo thuế suất, tổng tiền
 * - đọc số tiền bằng chữ tiếng Việt
 * Được test trong einvoice.calc.spec.ts.
 */
import type { InvoiceLine, InvoiceTotals, VatBreakdown, VatRate } from './providers/provider.interface.js';

/** Thuế suất hợp lệ theo TT78 (số âm = nhóm đặc biệt) */
export const VAT_RATES: { value: VatRate; label: string; code: string }[] = [
  { value: 0, label: '0%', code: '0' },
  { value: 5, label: '5%', code: '5' },
  { value: 8, label: '8%', code: '8' },
  { value: 10, label: '10%', code: '10' },
  { value: -1, label: 'Không chịu thuế (KCT)', code: 'KCT' },
  { value: -2, label: 'Không kê khai, tính nộp thuế (KKKNT)', code: 'KKKNT' },
  { value: -3, label: 'Khác', code: 'KHAC' },
];

/** Mã thuế suất dạng chữ NCC thường dùng ("10", "KCT", "KKKNT") */
export function vatRateCode(rate: VatRate): string {
  return VAT_RATES.find((r) => r.value === rate)?.code ?? String(rate);
}

/** Phần trăm thực để tính tiền (thuế suất đặc biệt = 0) */
export function vatPercent(rate: VatRate): number {
  return rate > 0 ? rate : 0;
}

/** Làm tròn theo số lẻ của tiền tệ (VND = 0) */
export function roundMoney(v: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round((v + Number.EPSILON) * f) / f;
}

export interface SourceItem {
  name: string;
  sku?: string | null;
  unit?: string | null;
  quantity: number;
  /** Đơn giá trên đơn hàng (đã/chưa gồm VAT tuỳ `pricesIncludeVat`) */
  price: number;
  /** Thuế suất riêng của sản phẩm (nếu có), không thì dùng mặc định */
  vatRate?: VatRate | null;
}

export interface BuildLinesOptions {
  items: SourceItem[];
  /** Tổng giảm giá của đơn (đã gồm VAT nếu pricesIncludeVat) */
  discountTotal?: number;
  /** Phí vận chuyển (đã gồm VAT nếu pricesIncludeVat) */
  shippingTotal?: number;
  shippingAsLine?: boolean;
  shippingLineName?: string;
  /** Thuế suất cho dòng phí vận chuyển (mặc định = defaultVatRate) */
  shippingVatRate?: VatRate | null;
  defaultVatRate: VatRate;
  defaultUnit?: string;
  pricesIncludeVat: boolean;
  /** perLine: phân bổ chiết khấu vào từng dòng; separate: dòng chiết khấu riêng (âm) */
  discountMode?: 'perLine' | 'separate';
  decimals?: number;
}

/**
 * Dựng danh sách dòng hàng chuẩn hoá từ các mục của đơn hàng.
 * Nguyên tắc: mọi số tiền lưu trên dòng là CHƯA VAT, `total` là đã gồm VAT.
 */
export function buildLines(opts: BuildLinesOptions): InvoiceLine[] {
  const d = opts.decimals ?? 0;
  const unitDefault = opts.defaultUnit || 'Cái';
  const mode = opts.discountMode ?? 'perLine';
  const lines: InvoiceLine[] = [];

  // Tổng giá trị hàng (theo giá trên đơn) để phân bổ chiết khấu theo tỉ lệ
  const gross = opts.items.reduce((s, it) => s + it.price * it.quantity, 0);
  const discountGross = Math.max(0, opts.discountTotal ?? 0);
  let allocated = 0;

  opts.items.forEach((it, i) => {
    const rate = it.vatRate ?? opts.defaultVatRate;
    const pct = vatPercent(rate) / 100;
    // chiết khấu phân bổ cho dòng (theo giá trên đơn)
    let lineDiscountGross = 0;
    if (mode === 'perLine' && discountGross > 0 && gross > 0) {
      const isLast = i === opts.items.length - 1;
      lineDiscountGross = isLast ? roundMoney(discountGross - allocated, d) : roundMoney((discountGross * it.price * it.quantity) / gross, d);
      allocated += lineDiscountGross;
    }
    // tách VAT ngược nếu giá đã gồm thuế
    const unitPrice = opts.pricesIncludeVat ? it.price / (1 + pct) : it.price;
    const discount = opts.pricesIncludeVat ? lineDiscountGross / (1 + pct) : lineDiscountGross;
    const amountRaw = unitPrice * it.quantity - discount;
    const amount = roundMoney(amountRaw, d);
    const vatAmount = roundMoney(amountRaw * pct, d);
    lines.push({
      index: lines.length + 1,
      kind: 'product',
      name: it.name,
      sku: it.sku ?? undefined,
      unit: it.unit || unitDefault,
      quantity: it.quantity,
      unitPrice: roundMoney(unitPrice, Math.max(d, 2)),
      discount: roundMoney(discount, d),
      amount,
      vatRate: rate,
      vatAmount,
      total: roundMoney(amount + vatAmount, d),
    });
  });

  // Dòng chiết khấu riêng (khi không phân bổ): dùng thuế suất mặc định
  if (mode === 'separate' && discountGross > 0) {
    const rate = opts.defaultVatRate;
    const pct = vatPercent(rate) / 100;
    const amountRaw = -(opts.pricesIncludeVat ? discountGross / (1 + pct) : discountGross);
    const amount = roundMoney(amountRaw, d);
    const vatAmount = roundMoney(amountRaw * pct, d);
    lines.push({ index: lines.length + 1, kind: 'discount', name: 'Chiết khấu / giảm giá', unit: '', quantity: 1, unitPrice: amount, discount: 0, amount, vatRate: rate, vatAmount, total: roundMoney(amount + vatAmount, d) });
  }

  // Dòng phí vận chuyển
  const ship = opts.shippingTotal ?? 0;
  if (ship > 0 && opts.shippingAsLine !== false) {
    const rate = opts.shippingVatRate ?? opts.defaultVatRate;
    const pct = vatPercent(rate) / 100;
    const amountRaw = opts.pricesIncludeVat ? ship / (1 + pct) : ship;
    const amount = roundMoney(amountRaw, d);
    const vatAmount = roundMoney(amountRaw * pct, d);
    lines.push({ index: lines.length + 1, kind: 'shipping', name: opts.shippingLineName || 'Phí vận chuyển', unit: 'Lần', quantity: 1, unitPrice: roundMoney(amountRaw, Math.max(d, 2)), discount: 0, amount, vatRate: rate, vatAmount, total: roundMoney(amount + vatAmount, d) });
  }

  return lines;
}

/** Tổng hợp theo thuế suất + tổng tiền + số tiền bằng chữ */
export function summarize(lines: InvoiceLine[], decimals = 0, currency = 'VND'): InvoiceTotals {
  const byRate = new Map<VatRate, VatBreakdown>();
  let subtotal = 0;
  let vatTotal = 0;
  let discountTotal = 0;
  for (const l of lines) {
    subtotal += l.amount;
    vatTotal += l.vatAmount;
    discountTotal += l.discount;
    const b = byRate.get(l.vatRate) ?? { vatRate: l.vatRate, amount: 0, vatAmount: 0 };
    b.amount += l.amount;
    b.vatAmount += l.vatAmount;
    byRate.set(l.vatRate, b);
  }
  subtotal = roundMoney(subtotal, decimals);
  vatTotal = roundMoney(vatTotal, decimals);
  const total = roundMoney(subtotal + vatTotal, decimals);
  return {
    subtotal,
    discountTotal: roundMoney(discountTotal, decimals),
    vatTotal,
    total,
    totalInWords: numberToVietnameseWords(total, currency),
    breakdown: [...byRate.values()].map((b) => ({ vatRate: b.vatRate, amount: roundMoney(b.amount, decimals), vatAmount: roundMoney(b.vatAmount, decimals) })),
  };
}

// ---------------------------------------------------------------------------
// Đọc số tiền bằng chữ tiếng Việt
// ---------------------------------------------------------------------------
const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

/** Đọc nhóm 3 chữ số; `full` = có nhóm lớn hơn phía trước (đọc "không trăm", "lẻ") */
function readTriple(n: number, full: boolean): string {
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;
  const parts: string[] = [];
  if (hundreds > 0 || full) parts.push(`${DIGITS[hundreds]} trăm`);
  if (tens === 0) {
    if (ones > 0) parts.push(hundreds > 0 || full ? `lẻ ${DIGITS[ones]}` : DIGITS[ones]);
  } else if (tens === 1) {
    parts.push('mười');
    if (ones === 5) parts.push('lăm');
    else if (ones > 0) parts.push(DIGITS[ones]);
  } else {
    parts.push(`${DIGITS[tens]} mươi`);
    if (ones === 1) parts.push('mốt');
    else if (ones === 4) parts.push('tư');
    else if (ones === 5) parts.push('lăm');
    else if (ones > 0) parts.push(DIGITS[ones]);
  }
  return parts.join(' ');
}

/** Đọc số nguyên không âm bằng chữ ("một triệu hai trăm nghìn") */
export function integerToVietnameseWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'không';
  const units = ['', ' nghìn', ' triệu', ' tỷ'];
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) {
      // nhóm "tỷ" rỗng vẫn phải đọc "tỷ" nếu phía trước có số (vd 1.000.000.000 = một tỷ)
      if (i % 4 === 3 && parts.length) parts.push('tỷ');
      continue;
    }
    const unit = units[i % 4] + (i >= 4 ? ' tỷ'.repeat(Math.floor(i / 4)) : '');
    parts.push(readTriple(g, i < groups.length - 1).trim() + unit);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** "Một triệu hai trăm nghìn đồng" / "... đô la Mỹ và ... cent" */
export function numberToVietnameseWords(amount: number, currency = 'VND'): string {
  const cur = currency.toUpperCase();
  const names: Record<string, [string, string | null]> = { VND: ['đồng', null], USD: ['đô la Mỹ', 'cent'], EUR: ['euro', 'cent'], JPY: ['yên', null] };
  const [major, minor] = names[cur] ?? [cur, null];
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const intPart = Math.floor(abs);
  const frac = Math.round((abs - intPart) * 100);
  let words = `${integerToVietnameseWords(intPart)} ${major}`;
  if (minor && frac > 0) words += ` và ${integerToVietnameseWords(frac)} ${minor}`;
  else if (!minor && frac > 0) words += ` ${integerToVietnameseWords(frac)}`;
  words = words.replace(/\s+/g, ' ').trim();
  words = words.charAt(0).toUpperCase() + words.slice(1);
  return negative ? `Âm ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words;
}

/** Chuẩn hoá mã số thuế VN: 10 số hoặc 10 số-3 số chi nhánh */
export function isValidTaxCode(code: string): boolean {
  return /^\d{10}(-\d{3})?$/.test(code.trim());
}

/** Định dạng ngày yyyy-MM-dd theo giờ Việt Nam (NCC yêu cầu ngày lập theo giờ VN) */
export function formatDateVN(d: Date, withTime = false): string {
  const vn = new Date(d.getTime() + 7 * 60 * 60_000);
  const date = vn.toISOString().slice(0, 10);
  return withTime ? `${date} ${vn.toISOString().slice(11, 19)}` : date;
}
