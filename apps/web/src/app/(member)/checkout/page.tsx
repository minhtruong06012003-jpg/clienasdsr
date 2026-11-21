import type { Metadata } from "next";
import { Suspense } from "react";
import { getServerI18n } from "@/lib/i18n/server";
import { CheckoutView } from "./checkout-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Thanh toán nạp tiền") };
}

/** Trang thanh toán nạp tiền vào ví (đọc ?plan=, ?method=, ?topup= nên bọc Suspense) */
export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutView />
    </Suspense>
  );
}
