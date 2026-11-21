import type { SettingsService } from '../settings/settings.service.js';

/** Nhóm cài đặt `credits` đã chuẩn hoá (giá trị luôn hợp lệ) */
export interface CreditSettings {
  /** Credits tặng khi đăng ký tài khoản mới (0 = không tặng) */
  signupBonus: number;
  /** Số tác vụ chạy cùng lúc khi chưa có gói / gói đã hết hạn */
  defaultConcurrency: number;
  /** Quyền lợi chung hiện ở khung "Mọi gói credits đều bao gồm" dưới bảng giá (mỗi phần tử một dòng) */
  packFeatures: string[];
  /** Ghi chú cuối khung quyền lợi (vd liên hệ hỗ trợ thanh toán), rỗng = không hiện */
  packNote: string;
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Giới hạn phần trăm trong khoảng 0–100 */
export const clampPercent = (n: number) => Math.min(100, Math.max(0, n));

/** Đọc + chuẩn hoá nhóm cài đặt `credits` */
export async function readCreditSettings(settings: SettingsService): Promise<CreditSettings> {
  const s = await settings.get<Partial<CreditSettings>>('credits');
  return {
    signupBonus: Math.max(0, Math.round(num(s.signupBonus, 0))),
    defaultConcurrency: Math.max(1, Math.round(num(s.defaultConcurrency, 1))),
    packFeatures: (Array.isArray(s.packFeatures) ? s.packFeatures : []).map((f) => String(f ?? '').trim()).filter(Boolean).slice(0, 30),
    packNote: typeof s.packNote === 'string' ? s.packNote.trim() : '',
  };
}

/** Làm tròn tiền VND về số nguyên (đồng) */
export const roundVnd = (n: number) => Math.round(n);

/**
 * % credits tặng thêm của một gói so với gói có đơn giá cao nhất (gói "gốc"):
 * vd gói gốc 20 credits / 52.000đ (2.600đ/credit), gói 51 credits / 130.000đ → 130.000 / 2.600 = 50 credits → tặng thêm 2%.
 */
export function packBonus(pack: { price: number; credits: number }, baseUnitPrice: number) {
  if (pack.price <= 0 || pack.credits <= 0 || baseUnitPrice <= 0) return 0;
  return Math.max(0, Math.round(((pack.credits * baseUnitPrice) / pack.price - 1) * 100));
}

// ---------------- nạp credits theo số tiền tự do ----------------

/** Một mốc khuyến mãi: nạp từ `min` đồng trở lên được tặng thêm `bonus`% credits */
export interface TopupTier {
  min: number;
  bonus: number;
}

/** Chương trình khuyến mãi có thời hạn (cộng dồn với % theo mốc), vd "Mừng khai trương +10%" */
export interface TopupPromo {
  enabled: boolean;
  /** % credits tặng thêm cho mọi lần nạp trong thời gian chương trình */
  bonus: number;
  /** Tên chương trình hiện cho khách */
  label: string;
  /** Thời gian bắt đầu / kết thúc (ISO), rỗng = không giới hạn */
  startsAt: string;
  endsAt: string;
}

/** Cấu hình nạp credits (đọc từ nhóm cài đặt `credits`, đã chuẩn hoá) */
export interface TopupSettings {
  /** Số credits nhận được cho mỗi 1đ (vd 1 = 100.000đ → 100.000 credits) */
  rate: number;
  /** Số tiền nạp tối thiểu / tối đa mỗi lần (VND) */
  min: number;
  max: number;
  /** Các mức tiền gợi ý (nút bấm nhanh) */
  presets: number[];
  /** Mốc khuyến mãi theo số tiền, sắp tăng dần */
  tiers: TopupTier[];
  promo: TopupPromo;
}

/** Mặc định khi admin chưa cài: 1đ = 1 credit, tặng thêm theo mốc từ 500.000đ */
export const TOPUP_DEFAULTS: TopupSettings = {
  rate: 1,
  min: 10_000,
  max: 100_000_000,
  presets: [50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
  tiers: [
    { min: 500_000, bonus: 3 },
    { min: 1_000_000, bonus: 5 },
    { min: 2_000_000, bonus: 8 },
    { min: 5_000_000, bonus: 10 },
    { min: 10_000_000, bonus: 15 },
  ],
  promo: { enabled: false, bonus: 10, label: 'Khuyến mãi', startsAt: '', endsAt: '' },
};

/** Chuẩn hoá cấu hình nạp credits (bỏ mốc lỗi, gộp mốc trùng, giữ min ≤ max) */
export function normalizeTopup(raw: Partial<TopupSettings> | undefined | null): TopupSettings {
  const r = raw ?? {};
  const rate = num(r.rate, TOPUP_DEFAULTS.rate) > 0 ? num(r.rate, TOPUP_DEFAULTS.rate) : TOPUP_DEFAULTS.rate;
  const min = Math.max(1000, Math.round(num(r.min, TOPUP_DEFAULTS.min)));
  const max = Math.max(min, Math.round(num(r.max, TOPUP_DEFAULTS.max)));
  const presets = Array.isArray(r.presets) ? r.presets : TOPUP_DEFAULTS.presets;
  // mỗi mức tối thiểu chỉ giữ một mốc (mốc sau ghi đè mốc trước), sắp tăng dần
  const tierMap = new Map<number, number>();
  for (const t of Array.isArray(r.tiers) ? r.tiers : TOPUP_DEFAULTS.tiers) {
    const tMin = Math.round(num(t?.min, NaN));
    const bonus = clampPercent(num(t?.bonus, NaN));
    if (Number.isFinite(tMin) && tMin > 0 && Number.isFinite(bonus) && bonus > 0) tierMap.set(tMin, bonus);
  }
  const p: Partial<TopupPromo> = r.promo ?? {};
  return {
    rate,
    min,
    max,
    presets: [...new Set(presets.map((n) => Math.round(num(n, 0))).filter((n) => n >= min && n <= max))].sort((a, b) => a - b).slice(0, 12),
    tiers: [...tierMap].map(([tMin, bonus]) => ({ min: tMin, bonus })).sort((a, b) => a.min - b.min),
    promo: {
      enabled: p.enabled === true,
      bonus: clampPercent(num(p.bonus, 0)),
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 80) : TOPUP_DEFAULTS.promo.label,
      startsAt: typeof p.startsAt === 'string' ? p.startsAt : '',
      endsAt: typeof p.endsAt === 'string' ? p.endsAt : '',
    },
  };
}

/** Đọc cấu hình nạp credits từ nhóm cài đặt `credits` (khoá `topup`) */
export async function readTopupSettings(settings: SettingsService): Promise<TopupSettings> {
  const s = await settings.get<{ topup?: Partial<TopupSettings> }>('credits');
  return normalizeTopup(s.topup);
}

/** Chương trình khuyến mãi đang chạy tại thời điểm `now` không (bật + trong khoảng thời gian, % > 0) */
export function promoActive(p: TopupPromo, now = new Date()) {
  if (!p.enabled || p.bonus <= 0) return false;
  const start = p.startsAt ? new Date(p.startsAt) : null;
  const end = p.endsAt ? new Date(p.endsAt) : null;
  if (start && !Number.isNaN(start.getTime()) && now < start) return false;
  if (end && !Number.isNaN(end.getTime()) && now > end) return false;
  return true;
}

/** Kết quả quy đổi một lần nạp: credits gốc + từng phần tặng thêm */
export interface TopupQuote {
  amount: number;
  /** Credits gốc = số tiền × tỉ lệ */
  base: number;
  /** % tặng theo mốc tiền / chương trình khuyến mãi / ưu đãi riêng của khách */
  tierBonus: number;
  promoBonus: number;
  personalBonus: number;
  /** Credits tặng thêm (tổng các %) */
  bonusCredits: number;
  /** Tổng credits nhận được */
  credits: number;
}

/**
 * Quy đổi số tiền nạp ra credits: credits gốc = tiền × tỉ lệ, cộng thêm (mốc cao nhất đạt được + khuyến mãi đang chạy
 * + ưu đãi riêng admin đặt cho khách)% trên credits gốc. Vd 1.000.000đ, tỉ lệ 1, mốc 5% + KM 10% → 1.000.000 + 150.000.
 */
export function quoteTopup(amount: number, s: TopupSettings, personal = 0, now = new Date()): TopupQuote {
  const a = Math.max(0, Math.round(amount));
  const base = Math.floor(a * s.rate);
  const tierBonus = [...s.tiers].reverse().find((t) => a >= t.min)?.bonus ?? 0;
  const promoBonus = promoActive(s.promo, now) ? s.promo.bonus : 0;
  const personalBonus = clampPercent(personal);
  const bonusCredits = Math.floor((base * (tierBonus + promoBonus + personalBonus)) / 100);
  return { amount: a, base, tierBonus, promoBonus, personalBonus, bonusCredits, credits: base + bonusCredits };
}
