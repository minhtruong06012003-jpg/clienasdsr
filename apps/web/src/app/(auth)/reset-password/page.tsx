import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { ResetPasswordForm } from "./reset-form";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Đặt lại mật khẩu"), robots: { index: false } };
}

/** Trang đặt lại mật khẩu từ link email `/reset-password?token=` */
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
