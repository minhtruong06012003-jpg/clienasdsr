import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { DashboardView } from "./dashboard-view";

/** Tiêu đề tab dịch theo ngôn ngữ khách chọn */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Tổng quan") };
}

/** Trang tổng quan của thành viên */
export default function DashboardPage() {
  return <DashboardView />;
}
