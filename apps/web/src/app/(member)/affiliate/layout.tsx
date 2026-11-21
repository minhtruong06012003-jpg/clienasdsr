import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";

// trang là client component nên tiêu đề tab khai báo ở layout của route
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Tiếp thị liên kết") };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
