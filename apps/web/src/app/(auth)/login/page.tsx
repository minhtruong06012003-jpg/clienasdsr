import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Đăng nhập") };
}

/** Trang đăng nhập (form dùng useSearchParams nên bọc Suspense) */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
