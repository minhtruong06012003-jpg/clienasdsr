import { SiteShell } from "@/components/site/site-shell";

/** Layout trang công khai: tự chọn khung giao diện theo chủ đề website */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
