import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { publicRobots } from "@/lib/seo";
import { PricingView } from "./pricing-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  // trang xem được khi chưa đăng nhập -> cho index (khu thành viên mặc định noindex ở layout)
  return {
    title: t("Bảng giá nạp tiền"),
    description: t("Nạp tiền một lần, dùng chung cho mọi công cụ AI tạo video, ảnh, giọng đọc, âm nhạc. Nạp càng nhiều càng được tặng thêm, tạo lỗi tự hoàn tiền."),
    alternates: { canonical: "/pricing" },
    robots: await publicRobots(),
  };
}

/** Trang nạp tiền vào ví: số tiền tự do + mốc khuyến mãi (xem được cả khi chưa đăng nhập) */
export default function PricingPage() {
  return <PricingView />;
}
