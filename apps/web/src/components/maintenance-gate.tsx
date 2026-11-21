"use client";

/**
 * Chế độ bảo trì website (Cài đặt › Chung › Bảo trì website trong trang quản trị).
 * - Khách thường: thay toàn bộ trang bằng thông báo bảo trì (API cũng chặn khách đăng nhập / đăng ký).
 * - Quản trị viên vẫn dùng website bình thường, kèm thanh nhắc đang bảo trì. Nhận biết quản trị viên khi:
 *   tài khoản đăng nhập website có quyền admin.access / '*', hoặc trình duyệt đang đăng nhập trang quản trị
 *   (cookie `cmsnt_admin=1` do apps/admin ghi — chỉ để hiển thị, quyền thật vẫn do API kiểm tra).
 * - Trang đăng nhập / quên / đặt lại mật khẩu luôn mở để quản trị viên đăng nhập được trên website.
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wrench } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBootstrap, useSiteName } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";

/** Các trang vẫn mở khi bảo trì (để quản trị viên đăng nhập) */
const OPEN_PATHS = ["/login", "/forgot-password", "/reset-password"];

/** Tài khoản có quyền vào trang quản trị — khớp kiểm tra phía API (hasAdminAccess) */
const isAdminPerms = (perms?: string[]) => !!perms && (perms.includes("*") || perms.includes("admin.access"));

export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const { status, user } = useAuth();
  const boot = useBootstrap();
  const siteName = useSiteName();
  // cookie admin chỉ đọc được ở trình duyệt -> đọc sau khi mount; bọc try/catch vì Safari bật "Chặn tất cả cookie" sẽ ném SecurityError (T-252)
  const [adminCookie, setAdminCookie] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setAdminCookie(/(?:^|;\s*)cmsnt_admin=1(?:;|$)/.test(document.cookie));
    } catch {
      setAdminCookie(false);
    }
  }, []);

  const general = boot.data?.settings?.general;
  if (!general?.maintenanceMode) return <>{children}</>;

  const isAdmin = adminCookie === true || isAdminPerms(user?.role?.permissions);
  if (isAdmin) {
    return (
      <>
        {/* thanh nhắc chỉ quản trị viên thấy */}
        <div className="sticky top-0 z-[60] flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-amber-950">
          <Wrench className="size-3.5 shrink-0" />
          {t("Website đang bảo trì — khách chỉ thấy trang thông báo, bạn xem được vì là quản trị viên.")}
        </div>
        {children}
      </>
    );
  }
  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return <>{children}</>;
  // chưa biết có phải quản trị viên không (đang đọc cookie / tải tài khoản) -> chưa hiện gì để khỏi nháy trang bảo trì
  if (adminCookie === null || status === "loading") return null;

  const raw = general.maintenanceMessage;
  const message = (typeof raw === "string" ? raw : raw?.[locale] || raw?.vi || (raw ? Object.values(raw)[0] : "")) || t("Website đang bảo trì, vui lòng quay lại sau.");
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
          <Wrench className="size-7" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{siteName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{t("Đang bảo trì")}</h1>
        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{message}</p>
        <Link href="/login" className="mt-6 inline-block text-xs text-muted-foreground underline-offset-4 hover:underline">
          {t("Đăng nhập quản trị viên")}
        </Link>
      </div>
    </main>
  );
}
