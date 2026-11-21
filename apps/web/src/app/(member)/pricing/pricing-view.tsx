"use client";

/**
 * Trang bảng giá & nạp tiền vào ví (`PricingPlans`).
 */
import Link from "next/link";
import { Coins, CreditCard } from "lucide-react";
import { PricingPlans } from "@/components/ai/pricing-plans";
import { useI18n } from "@/lib/i18n/provider";

export function PricingView() {
  const { t } = useI18n();
  return (
    <div className="space-y-4 pt-2 pb-6">
      <div className="inline-flex rounded-full border bg-card p-1 text-sm shadow-xs">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 font-semibold text-background shadow">
          <CreditCard className="size-3.5" />
          {t("Nạp tiền vào ví")}
        </span>
        <Link
          href="/service-pricing"
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 font-medium text-muted-foreground transition hover:text-foreground"
        >
          <Coins className="size-3.5 text-amber-500" />
          {t("Bảng giá dịch vụ")}
        </Link>
      </div>
      <PricingPlans />
    </div>
  );
}
