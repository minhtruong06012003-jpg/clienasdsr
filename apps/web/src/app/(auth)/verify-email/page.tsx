import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { VerifyEmail } from "./verify";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Xác minh email"), robots: { index: false } };
}

/** Trang xác minh email từ link `/verify-email?token=` */
export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
