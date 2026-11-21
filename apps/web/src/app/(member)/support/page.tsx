import type { Metadata } from "next";
import { Suspense } from "react";
import { getServerI18n } from "@/lib/i18n/server";
import { SupportView } from "./support-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: t("Trung tâm Hỗ trợ & Ticket"),
    robots: { index: false, follow: false },
  };
}

export default function SupportPage() {
  return (
    <Suspense>
      <SupportView />
    </Suspense>
  );
}
