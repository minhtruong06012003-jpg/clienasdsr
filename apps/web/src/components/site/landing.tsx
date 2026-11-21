"use client";

import { DashboardView } from "@/app/(member)/dashboard/dashboard-view";
import { ShopCloneHome } from "@/components/themes/shopclone/shopclone-home";
import type { AiCategoryRaw } from "@/lib/ai";
import { useSiteTheme } from "@/lib/site-theme";
import type { AiTool } from "@/lib/types";

/**
 * Trang chủ `/` vào thẳng bên trong giao diện AI Studio (`DashboardView`) theo yêu cầu T-310
 * (bỏ lớp trang mẫu landing bên ngoài để khách trải nghiệm công cụ ngay lập tức; giữ nguyên chủ đề `shopclone` nếu bật).
 */
export function Landing({ initialTools, initialCategories }: { initialTools?: AiTool[]; initialCategories?: AiCategoryRaw[] }) {
  const { theme } = useSiteTheme();
  if (theme === "shopclone") {
    return <ShopCloneHome initialTools={initialTools} initialCategories={initialCategories} />;
  }
  return <DashboardView initialTools={initialTools} initialCategories={initialCategories} />;
}
