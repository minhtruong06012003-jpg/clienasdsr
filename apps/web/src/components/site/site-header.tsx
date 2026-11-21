"use client";

/** Thanh đầu trang công khai: logo, menu, đổi giao diện, nút đăng nhập / vào bảng điều khiển; mobile dùng drawer */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BadgeDollarSign, BookOpen, ChevronRight, Globe, Home, LayoutDashboard, LogIn, Menu, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { PrefsSwitcher } from "@/components/prefs-switcher";
import { Logo } from "./logo";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/provider";
import { ADMIN_URL, canOpenAdmin } from "@/lib/site";
import { cn } from "@/lib/utils";

/** Menu chính của các trang công khai (Tài liệu API, Blog, Trang tĩnh) */
export const SITE_NAV = [
  { href: "/", label: "Bảng điều khiển", icon: Home },
  { href: "/community", label: "Cộng đồng", icon: Globe },
  { href: "/pricing", label: "Nạp tiền", icon: BadgeDollarSign },
  { href: "/api-docs", label: "Tài liệu API", icon: BookOpen },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { status, user } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // đổ bóng + nền mờ khi cuộn trang
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : !href.includes("#") && pathname.startsWith(href));

  return (
    <header className={cn("sticky top-0 z-40 w-full transition-all", scrolled ? "border-b bg-background/80 backdrop-blur-xl" : "bg-transparent")}>
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:h-16 sm:px-6">
        <Logo />
        <nav className="ml-6 hidden items-center gap-1 md:flex">
          {SITE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn("rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", isActive(item.href) && "text-foreground")}
            >
              {t(item.label)}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <PrefsSwitcher className="h-9" />
          <ThemeToggle className="size-9" />
          {/* mobile: một nút gọn cạnh menu (vào panel / đăng nhập) */}
          {status === "authenticated" ? (
            <Button asChild size="sm" className="h-9 rounded-full px-3.5 sm:hidden">
              <Link href="/dashboard">
                <LayoutDashboard /> {t("Vào panel")}
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className="h-9 rounded-full bg-background/70 px-3.5 sm:hidden">
              <Link href="/login">{t("Đăng nhập")}</Link>
            </Button>
          )}
          {/* tài khoản quản trị: nút mở trang quản trị ở tab mới */}
          {status === "authenticated" && canOpenAdmin(user) && (
            <Button asChild variant="outline" size="lg" className="hidden bg-background/70 sm:inline-flex">
              <a href={ADMIN_URL} target="_blank" rel="noreferrer">
                <ShieldCheck /> {t("Quản trị")}
              </a>
            </Button>
          )}
          {status === "authenticated" ? (
            <Button asChild className="hidden sm:inline-flex" size="lg">
              <Link href="/dashboard">
                <LayoutDashboard /> {t("Bảng điều khiển")}
              </Link>
            </Button>
          ) : (
            <div className="hidden items-center gap-1.5 sm:flex">
              <Button asChild variant="ghost" size="lg">
                <Link href="/login">{t("Đăng nhập")}</Link>
              </Button>
              <Button asChild size="lg" className="bg-brand-gradient shadow-md shadow-primary/25 hover:opacity-90">
                <Link href="/register">{t("Đăng ký miễn phí")}</Link>
              </Button>
            </div>
          )}
          {/* menu mobile */}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 md:hidden" aria-label={t("Mở menu")}>
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[19rem] max-w-[85vw] gap-0 p-0">
              <SheetTitle className="sr-only">{t("Menu")}</SheetTitle>
              <div className="bg-hero border-b px-5 pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5">
                <Logo />
                <p className="mt-2 text-xs text-muted-foreground">{t("Sáng tạo video, ảnh, giọng nói, âm nhạc bằng AI")}</p>
              </div>
              <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
                {SITE_NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn("flex items-center gap-3 rounded-xl px-3 py-3 font-medium transition-colors hover:bg-muted", isActive(item.href) && "bg-primary/8 text-primary")}
                  >
                    <span className={cn("inline-flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground", isActive(item.href) && "bg-primary/12 text-primary")}>
                      <item.icon className="size-4" />
                    </span>
                    <span className="flex-1">{t(item.label)}</span>
                    <ChevronRight className="size-4 text-muted-foreground/60" />
                  </Link>
                ))}
              </nav>
              <div className="flex flex-col gap-2 border-t p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                {status === "authenticated" ? (
                  <Button asChild size="lg" className="bg-brand-gradient h-11 shadow-md shadow-primary/25 hover:opacity-90">
                    <Link href="/dashboard" onClick={() => setOpen(false)}>
                      <LayoutDashboard /> {t("Bảng điều khiển")}
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button asChild size="lg" className="bg-brand-gradient h-11 shadow-md shadow-primary/25 hover:opacity-90">
                      <Link href="/register" onClick={() => setOpen(false)}>
                        <UserPlus /> {t("Đăng ký miễn phí")}
                      </Link>
                    </Button>
                    <Button asChild variant="outline" size="lg" className="h-11">
                      <Link href="/login" onClick={() => setOpen(false)}>
                        <LogIn /> {t("Đăng nhập")}
                      </Link>
                    </Button>
                  </>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
