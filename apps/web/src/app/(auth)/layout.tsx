import { AuthShell } from "@/components/site/auth-shell";

/** Layout chung cho đăng nhập / đăng ký / quên mật khẩu */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
