"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MemberShell } from "@/components/member/member-shell";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { ShopCloneShell } from "@/components/themes/shopclone/shopclone-shell";
import { useSiteTheme } from "@/lib/site-theme";

/** Chọn khung hiển thị ngoài trang công khai theo chủ đề website (`default` = vào thẳng AI Studio ở trang chủ, `shopclone` = ShopClone MMO) */
export function SiteShell({ children }: { children: ReactNode }) {
  const { theme } = useSiteTheme();
  const pathname = usePathname();
  if (theme === "shopclone") {
    return <ShopCloneShell>{children}</ShopCloneShell>;
  }
  if (pathname === "/" || pathname.startsWith("/api-docs")) {
    return <MemberShell>{children}</MemberShell>;
  }
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
