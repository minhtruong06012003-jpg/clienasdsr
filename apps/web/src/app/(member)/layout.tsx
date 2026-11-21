import type { Metadata } from "next";
import { MemberShell } from "@/components/member/member-shell";

// Khu vực thành viên không cần index tìm kiếm
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Layout khu vực thành viên (bảo vệ đăng nhập phía client vì token nằm ở localStorage) */
export default function MemberLayout({ children }: { children: React.ReactNode }) {
  return <MemberShell>{children}</MemberShell>;
}
