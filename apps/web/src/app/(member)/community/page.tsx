import type { Metadata } from "next";
import { Suspense } from "react";
import { getServerI18n } from "@/lib/i18n/server";
import { publicRobots } from "@/lib/seo";
import { CommunityView } from "./community-view";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  // trang xem được khi chưa đăng nhập -> cho index (khu thành viên mặc định noindex ở layout)
  return {
    title: t("Cộng đồng"),
    description: t("Thư viện video, ảnh, giọng đọc do cộng đồng tạo bằng AI — xem prompt và tạo lại tác phẩm tương tự chỉ với một cú bấm."),
    alternates: { canonical: "/community" },
    robots: await publicRobots(),
  };
}

/** Trang Cộng đồng: tác phẩm khách chọn hiển thị Công khai (đọc ?q= ?category= nên bọc Suspense) */
export default function CommunityPage() {
  return (
    <Suspense>
      <CommunityView />
    </Suspense>
  );
}
