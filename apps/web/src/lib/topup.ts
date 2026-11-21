/**
 * Tính số tiền (VND) thực nhận vào ví khi nạp theo số tiền tự do — khớp `quoteTopup()` ở API (credits.settings.ts):
 * tiền gốc = tiền nạp × tỉ lệ, tặng thêm (mốc cao nhất đạt được + khuyến mãi đang chạy + ưu đãi riêng)% trên tiền gốc.
 */
import type { TopupConfig } from "./types";

export interface TopupQuote {
  amount: number;
  base: number;
  tierBonus: number;
  promoBonus: number;
  personalBonus: number;
  /** Tổng % tặng thêm */
  bonusPct: number;
  /** Số tiền (VND) tặng thêm */
  bonusCredits: number;
  /** Tổng VND cộng vào ví = gốc + tặng thêm */
  credits: number;
}

export function quoteTopup(amount: number, c: TopupConfig): TopupQuote {
  const a = Math.max(0, Math.round(amount || 0));
  const base = Math.floor(a * c.rate);
  const tierBonus = [...c.tiers].reverse().find((t) => a >= t.min)?.bonus ?? 0;
  const promoBonus = c.promo?.bonus ?? 0;
  const personalBonus = c.personal ?? 0;
  const bonusPct = tierBonus + promoBonus + personalBonus;
  const bonusCredits = Math.floor((base * bonusPct) / 100);
  return { amount: a, base, tierBonus, promoBonus, personalBonus, bonusPct, bonusCredits, credits: base + bonusCredits };
}

/** Mốc khuyến mãi kế tiếp chưa đạt (để nhắc "nạp thêm X được tặng Y%") */
export function nextTier(amount: number, c: TopupConfig) {
  return c.tiers.find((t) => t.min > amount) ?? null;
}

/** Đường dẫn trang thanh toán nạp tiền (kèm phương thức `bank` | `crypto` nếu đã chọn trước) */
export const topupHref = (amount: number, method?: "bank" | "crypto") =>
  `/checkout?amount=${Math.round(amount)}${method ? `&method=${method}` : ""}`;
