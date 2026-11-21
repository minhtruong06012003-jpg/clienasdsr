import type { Metadata } from "next";
import { Suspense } from "react";
import { getServerI18n } from "@/lib/i18n/server";
import { HistoryView } from "./history-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Lịch sử tạo") };
}

/** Lịch sử tác vụ AI (đọc ?tool= nên bọc Suspense) */
export default function HistoryPage() {
  return (
    <Suspense>
      <HistoryView />
    </Suspense>
  );
}
