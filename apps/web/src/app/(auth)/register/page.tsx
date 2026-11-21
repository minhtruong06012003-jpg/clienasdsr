import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { RegisterForm } from "./register-form";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Đăng ký") };
}

/** Trang đăng ký tài khoản */
export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
