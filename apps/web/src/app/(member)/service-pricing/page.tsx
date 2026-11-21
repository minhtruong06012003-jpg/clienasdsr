import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { publicRobots } from "@/lib/seo";
import { ServicePricingView } from "./service-pricing-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: t("Bảng giá & trạng thái dịch vụ AI"),
    description: t("Bảng giá chi tiết, trạng thái hoạt động trực tiếp và nhật ký cập nhật (Timeline) toàn bộ các dịch vụ tạo Video AI, Ảnh AI, Nâng cấp 4K, Giọng nói AI."),
    alternates: { canonical: "/service-pricing" },
    robots: await publicRobots(),
  };
}

export default function ServicePricingPage() {
  return <ServicePricingView />;
}
