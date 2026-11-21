"use client";

/**
 * Khung khu vực thành viên kiểu "AI Studio":
 * - Sidebar: logo + đổi ngôn ngữ, nút "Tạo mới" (mở bảng tìm công cụ), Tổng quan / Lịch sử tạo / Cộng đồng,
 *   nhóm "Công cụ AI" mở/thu được (icon màu theo nhóm), nhóm "Tài khoản" (bảng giá, giao dịch,
 *   tiếp thị liên kết, cài đặt); đáy là thẻ số dư (VND, gói cũ nếu còn + nút nạp tiền) và người dùng.
 * - Topbar: ô tìm công cụ (⌘K / Ctrl+K), pill số dư (VND) + nút Nạp tiền, sáng/tối. Mobile: sidebar thành drawer.
 * Bảo vệ route: chưa đăng nhập -> `/login?next=<đường dẫn hiện tại>`; một số trang (bảng giá, cộng đồng) xem được khi chưa đăng nhập.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Crown, CreditCard, ExternalLink, LogIn, LogOut, Menu, Plus, Search, ShieldCheck, Sparkles, UserPlus, UserRound, Wallet } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { PrefsSwitcher } from "@/components/prefs-switcher";
import { Logo } from "@/components/site/logo";
import { CompactFooter } from "@/components/site/compact-footer";
import { Spinner } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { useAiTools, useBootstrap, useCategories, useCredits, useSiteName } from "@/lib/queries";
import { groupsOf, groupTools, isMonoModelLogo, modelLogoOf, subToolIconOf, toolHref, toolIcon, toolId, toolLink } from "@/lib/ai";
import type { AiTool, WebMenuItem } from "@/lib/types";
import { ToolPalette } from "@/components/ai/tool-palette";
import { BankCircleIcon, CryptoCircleIcon, TopupMethodMenu } from "@/components/ai/topup-method-icons";
import { ShopCloneShell } from "@/components/themes/shopclone/shopclone-shell";
import { useI18n } from "@/lib/i18n/provider";
import { useSiteTheme } from "@/lib/site-theme";
import { ADMIN_URL, canOpenAdmin } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * Menu bên trái do admin sửa ở trang Menu website (nhóm cài đặt `web_menu`, gửi xuống qua /public/bootstrap).
 * Chưa tải được bootstrap thì dùng menu mặc định này (khớp WEB_MENU_DEFAULT_ITEMS ở apps/api/src/modules/settings/web-menu.ts).
 */
const DEFAULT_MENU: WebMenuItem[] = [
  { id: "dashboard", type: "link", label: "Bảng điều khiển", href: "/dashboard", icon: "layout-dashboard", badge: "", newTab: false, enabled: true },
  { id: "history", type: "link", label: "Lịch sử tạo", href: "/history", icon: "history", badge: "", newTab: false, enabled: true },
  { id: "community", type: "link", label: "Cộng đồng", href: "/community", icon: "globe", badge: "", newTab: false, enabled: true },
  { id: "support", type: "link", label: "Ticket hỗ trợ", href: "/support", icon: "ticket", badge: "24/7", newTab: false, enabled: true },
  { id: "ai-tools", type: "ai_tools", label: "Công cụ AI", href: "", icon: "", badge: "", newTab: false, enabled: true },
  { id: "account-heading", type: "heading", label: "Tài khoản", href: "", icon: "", badge: "", newTab: false, enabled: true },
  { id: "pricing", type: "link", label: "Nạp tiền", href: "/pricing", icon: "credit-card", badge: "", newTab: false, enabled: true },
  { id: "transactions", type: "link", label: "Lịch sử giao dịch", href: "/transactions", icon: "receipt-text", badge: "", newTab: false, enabled: true },
  { id: "affiliate", type: "link", label: "Tiếp thị liên kết", href: "/affiliate", icon: "gift", badge: "%", newTab: false, enabled: true },
  { id: "api-keys", type: "link", label: "API cho nhà phát triển", href: "/api-keys", icon: "key-round", badge: "", newTab: false, enabled: true },
  { id: "account", type: "link", label: "Cài đặt tài khoản", href: "/account", icon: "settings", badge: "", newTab: false, enabled: true },
];

/** Danh sách mục menu đang hiện (ẩn Bảng giá dịch vụ trên thanh công cụ trái theo T-314; đồng bộ nhãn Bảng điều khiển & đặt Ticket hỗ trợ ngay dưới Cộng đồng — T-211) */
function useWebMenu(): WebMenuItem[] {
  const { data } = useBootstrap();
  const items = data?.settings?.web_menu?.items;
  const rawList = (Array.isArray(items) && items.length ? [...items] : [...DEFAULT_MENU]).filter((i) => {
    if (i.enabled === false) return false;
    const clean = i.href.split(/[?#]/)[0].replace(/\/+$/, "");
    if (i.id === "service-pricing" || clean === "/service-pricing") return false;
    return true;
  });
  const hasSupport = rawList.some((i) => i.id === "support" || i.href.split(/[?#]/)[0] === "/support");
  if (!hasSupport) {
    const aiIdx = rawList.findIndex((i) => i.type === "ai_tools" || i.id === "ai-tools");
    const commIdx = rawList.findIndex((i) => i.id === "community" || i.href.split(/[?#]/)[0] === "/community");
    const supportItem: WebMenuItem = {
      id: "support",
      type: "link",
      label: "Ticket hỗ trợ",
      href: "/support",
      icon: "ticket",
      badge: "24/7",
      newTab: false,
      enabled: true,
    };
    if (commIdx >= 0) rawList.splice(commIdx + 1, 0, supportItem);
    else if (aiIdx >= 0) rawList.splice(aiIdx, 0, supportItem);
    else rawList.push(supportItem);
  }
  return rawList.map((i) => {
    const clean = i.href.split(/[?#]/)[0].replace(/\/+$/, "");
    if ((i.id === "dashboard" || clean === "/dashboard") && i.label.trim() === "Tổng quan") {
      return { ...i, label: "Bảng điều khiển" };
    }
    if (i.id === "support" || clean === "/support") {
      return {
        ...i,
        icon: !i.icon || i.icon === "message-circle-heart" ? "ticket" : i.icon,
        badge: i.badge || "24/7",
      };
    }
    return i;
  });
}

/** Các đường dẫn khách chưa đăng nhập được vào thẳng bên trong giao diện AI Studio mà không bị đẩy sang trang đăng nhập (T-310) */
const GUEST_OK = ["/", "/dashboard", "/tools", "/pricing", "/service-pricing", "/community", "/api-docs"];

export function MemberShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useAuth();
  const { t } = useI18n();
  const { theme } = useSiteTheme();
  const guestOk = pathname === "/" || GUEST_OK.some((p) => p !== "/" && (pathname === p || pathname.startsWith(`${p}/`)));

  // chưa đăng nhập vào trang tài khoản riêng tư -> chuyển tới đăng nhập kèm ?next=
  useEffect(() => {
    if (status === "guest" && !guestOk) {
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
  }, [status, guestOk, router]);

  if (!guestOk && status !== "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {status === "guest" ? t("Đang chuyển tới trang đăng nhập...") : t("Đang tải...")}
      </div>
    );
  }
  if (theme === "shopclone") {
    return <ShopCloneShell>{children}</ShopCloneShell>;
  }
  return <AuthedShell>{children}</AuthedShell>;
}

/** Khung khi đã đăng nhập: sidebar (thu gọn được, nhớ trong localStorage) + topbar + nội dung + bảng tìm công cụ */
function AuthedShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);

  // đọc trạng thái thu gọn sau khi mount (tránh lệch HTML server / client)
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("sidebar-collapsed") === "1");
    } catch {
      /* trình duyệt chặn storage */
    }
  }, []);
  const toggle = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem("sidebar-collapsed", v ? "0" : "1");
      } catch {
        /* bỏ qua */
      }
      return !v;
    });

  // đổi trang thì đóng drawer mobile + giải phóng triệt để khoá cuộn / pointer-events trên body (tránh đơ cảm ứng trên iOS WebKit — T-319)
  useEffect(() => {
    setOpen(false);
    if (typeof document !== "undefined") {
      document.body.style.removeProperty("pointer-events");
      document.body.removeAttribute("data-scroll-locked");
    }
  }, [pathname]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!open) {
      document.documentElement.style.removeProperty("overflow");
      document.body.style.removeProperty("pointer-events");
      return;
    }
    document.documentElement.style.overflow = "hidden";
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => {
      document.documentElement.style.removeProperty("overflow");
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // phím tắt ⌘K / Ctrl+K mở bảng tìm công cụ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const closeDrawer = () => setOpen(false);
  const openPalette = () => {
    setOpen(false);
    setPalette(true);
  };

  return (
    <div className="bg-app min-h-screen lg:flex">
      {/* sidebar desktop (PC co dãn theo chiều dài tối đa của tên model, cố định mượt khi cuộn; mobile/tablet giữ nguyên drawer — T-287) */}
      <aside
        className={cn(
          "sticky top-0 z-30 hidden h-screen shrink-0 border-r border-sidebar-border bg-sidebar transition-all duration-200 lg:block",
          collapsed ? "w-[76px]" : "w-max min-w-[256px] max-w-[292px] xl:min-w-[288px] xl:max-w-[356px]",
        )}
      >
        <SidebarContent collapsed={collapsed} onToggle={toggle} onCreate={openPalette} />
      </aside>
      {/* drawer mobile thuần GPU CSS transform (không qua Radix RemoveScroll/pointer-events lock + không backdrop-blur đè lên video trên iPhone — T-319) */}
      <div
        aria-hidden={!open}
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          open ? "pointer-events-auto visible" : "pointer-events-none invisible delay-200",
        )}
      >
        <div
          onClick={closeDrawer}
          className={cn(
            "absolute inset-0 bg-black/45 transition-opacity duration-200",
            open ? "opacity-100" : "opacity-0",
          )}
        />
        <aside
          role="dialog"
          aria-label="Menu"
          className={cn(
            "relative flex h-full w-[280px] max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-popover-foreground shadow-xl transition-transform duration-200 ease-out will-change-transform",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <SidebarContent drawer onCreate={openPalette} onNavigate={closeDrawer} />
        </aside>
      </div>
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setOpen(true)} onSearch={openPalette} />
        <main className="mx-auto w-full max-w-[1360px] flex-1 px-4 pb-12 sm:px-6 lg:px-8">{children}</main>
        {/* chân trang gọn căn giữa: logo, liên kết chính sách, thông tin công ty, bản quyền */}
        <CompactFooter />
      </div>
      <ToolPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

/** Một dòng menu: đang chọn -> pill đen nổi bật chữ đậm + icon xanh ngọc giống Yupvox; hỗ trợ badge báo đỏ số tin nhắn chưa đọc (T-216) & nhấn bật Ticket hỗ trợ (T-476) */
function NavLink({ href, icon: Icon, label, active, collapsed, badge, alertCount, highlightSupport, newTab, onNavigate }: { href: string; icon: typeof Wallet; label: string; active: boolean; collapsed?: boolean; badge?: string; alertCount?: number; highlightSupport?: boolean; newTab?: boolean; onNavigate?: () => void }) {
  const external = newTab || /^https?:\/\//i.test(href);
  const Comp = external ? "a" : Link;
  return (
    <Comp
      href={href}
      {...(!external ? { prefetch: false } : {})}
      {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}
      onClick={onNavigate}
      title={collapsed ? (alertCount ? `${label} (${alertCount})` : label) : undefined}
      className={cn(
        "relative flex h-9.5 items-center gap-3 rounded-full px-3.5 text-[14px] transition-all",
        active
          ? "bg-foreground font-semibold text-background shadow-xs"
          : highlightSupport
            ? "bg-gradient-to-r from-sky-500/[0.11] via-blue-500/[0.08] to-indigo-500/[0.08] font-semibold text-sky-950 ring-1 ring-sky-400/35 hover:from-sky-500/[0.18] hover:to-indigo-500/[0.14] hover:ring-sky-400/55 dark:from-sky-500/[0.16] dark:via-blue-500/[0.12] dark:to-indigo-500/[0.12] dark:text-sky-100 dark:ring-sky-400/30 dark:hover:ring-sky-400/50"
            : "font-medium text-[#475569] hover:bg-muted hover:text-[#09090b] dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon
        className={cn(
          "size-[18px] shrink-0",
          active
            ? "text-emerald-400 dark:text-emerald-600"
            : highlightSupport
              ? "text-sky-600 dark:text-sky-400"
              : "text-[#64748b] dark:text-zinc-400",
        )}
      />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && !!alertCount && alertCount > 0 && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white shadow-2xs tabular-nums">
          {alertCount > 99 ? "99+" : alertCount}
        </span>
      )}
      {collapsed && !!alertCount && alertCount > 0 && (
        <span className=" absolute top-0.5 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9.5px] font-bold text-white tabular-nums">
          {alertCount > 9 ? "9+" : alertCount}
        </span>
      )}
      {!collapsed && !alertCount && badge && (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-bold tracking-tight",
            highlightSupport
              ? active
                ? "bg-white/20 text-white dark:bg-black/20 dark:text-zinc-900"
                : "bg-sky-600 text-white shadow-2xs dark:bg-sky-500 dark:text-white"
              : "rounded-md bg-amber-100 px-1.5 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
          )}
        >
          {badge}
        </span>
      )}
    </Comp>
  );
}

/** Tiêu đề nhóm menu */
function NavHeading({ children }: { children: ReactNode }) {
  return <div className="px-3.5 pt-5 pb-1.5 text-[11px] font-bold tracking-[0.07em] text-[#94a3b8] uppercase dark:text-zinc-500">{children}</div>;
}

/** Nội dung sidebar (dùng cho cả desktop và drawer mobile) */
function SidebarContent({ drawer, collapsed, onToggle, onCreate, onNavigate }: { drawer?: boolean; collapsed?: boolean; onToggle?: () => void; onCreate: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { status } = useAuth();
  const authed = status === "authenticated";
  const { t } = useI18n();
  const tools = useAiTools();
  const categories = useCategories();
  const groups = groupTools(tools.data, categories.list);
  const menu = useWebMenu();
  const ticketUnread = useQuery({
    queryKey: ["tickets", "unread"],
    queryFn: () => api.get<{ unread: number }>("/account/tickets/unread-count"),
    enabled: authed,
    refetchInterval: 15_000,
    staleTime: 10_000,
    meta: { silentError: true },
  });
  const supportUnreadCount = authed ? (ticketUnread.data?.unread ?? 0) : 0;
  // so khớp theo phần đường dẫn (bỏ ?query / #hash); `/` và `/dashboard` cùng sáng mục Bảng điều khiển (T-310)
  const isActive = (raw: string) => {
    if (!raw.startsWith("/")) return false;
    const href = raw.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
    if (href === "/dashboard" && pathname === "/") return true;
    return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  };
  // dòng nhóm model (link mở model rẻ nhất): đang ở trang bất kỳ model nào của nhóm thì vẫn đánh dấu đang mở
  const toolActive = (x: AiTool) => (x.group ? (tools.data ?? []).some((m) => groupsOf(m).includes(x.group!) && isActive(toolHref(m.key))) : isActive(toolHref(x.key)));
  // Accordion 1 nhóm: tại mỗi thời điểm chỉ mở tối đa 1 nhóm Công cụ AI (mới vào mở đúng nhóm của công cụ hiện tại, ở trang khác thì thu gọn hết)
  const activeGroupKey = groups.find((g) => g.tools.some(toolActive))?.key ?? null;
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroupKey);
  useEffect(() => {
    setOpenGroup(activeGroupKey);
  }, [activeGroupKey]);
  const isTopupRoute = pathname.startsWith("/pricing") || pathname.startsWith("/checkout");
  const [topupOpen, setTopupOpen] = useState<boolean>(false);
  const showTopupSub = topupOpen || isTopupRoute;
  const isOpen = (key: string) => openGroup === key;
  const c = collapsed && !drawer;

  return (
    <div className="flex h-full flex-col">
      {/* logo + chữ Nov AI căn giữa cân đối + đường gạch mảnh phân tách vùng dưới giống Yupvox (T-192, T-193, T-194) */}
      <div
        className={cn(
          "relative flex h-16 shrink-0 items-center justify-center border-b border-slate-200/75 px-4 dark:border-white/[0.06]",
          c && "px-2",
        )}
      >
        {!c && (
          <div onClick={onNavigate}>
            <Logo href="/" withBrandText className="pr-5" />
          </div>
        )}
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground transition hover:text-foreground",
              !c && "absolute right-3",
            )}
            title={c ? t("Mở rộng") : t("Thu gọn")}
          >
            {c ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
          </button>
        )}
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pt-3 pb-3">
        {/* Thước đo chiều ngang ẩn trên PC để sidebar tự động dãn vừa khít tên model dài nhất mà không bị giật khung khi đóng/mở nhóm (T-287) */}
        {!drawer && !c && groups.length > 0 && (
          <div aria-hidden className="pointer-events-none h-0 overflow-hidden opacity-0 select-none">
            <div className="ml-[23px] border-l pl-2.5">
              {groups
                .flatMap((g) => g.tools)
                .map((tool) => (
                  <div key={`sz-${toolId(tool)}`} className="flex items-center gap-2.5 px-2.5 pr-4 text-[13.5px] whitespace-nowrap">
                    <span className="size-4 shrink-0" />
                    <span>{t(tool.name)}</span>
                  </div>
                ))}
            </div>
            {groups.map((g) => (
              <div key={`szg-${g.key}`} className="flex items-center gap-3 px-3 pr-3 text-[14px] font-bold whitespace-nowrap">
                <span className="size-6 shrink-0" />
                <span>{t(g.label)}</span>
                <span className="text-[11px]">{g.tools.length}</span>
                <span className="size-3.5 shrink-0" />
              </div>
            ))}
          </div>
        )}
        {/* duyệt menu theo thứ tự admin xếp: dòng link, tiêu đề nhóm (thu gọn = đường kẻ), khối Công cụ AI */}
        {menu.map((item) => {
          if (item.type === "heading") return c ? <div key={item.id} className="mx-3 my-3 border-t" /> : item.label ? <NavHeading key={item.id}>{t(item.label)}</NavHeading> : <div key={item.id} className="h-3" />;
          if (item.type === "link") {
            const cleanHref = item.href.split(/[?#]/)[0].replace(/\/+$/, "");
            const isPricingItem = item.id === "pricing" || cleanHref === "/pricing";
            if (isPricingItem) {
              const Icon = toolIcon(item.icon);
              if (c) {
                return (
                  <TopupMethodMenu key={item.id} side="right" align="start">
                    <button
                      type="button"
                      title={t(item.label)}
                      className={cn(
                        "relative flex h-9 w-full items-center justify-center rounded-xl text-[13px] font-medium transition-colors",
                        isTopupRoute
                          ? "bg-muted text-foreground dark:bg-white/[0.06]"
                          : "text-foreground/70 hover:bg-muted hover:text-foreground dark:text-foreground/60 dark:hover:bg-white/[0.04]",
                      )}
                    >
                      <Icon className="size-[18px] shrink-0" />
                    </button>
                  </TopupMethodMenu>
                );
              }
              return (
                <div key={item.id}>
                  <button
                    type="button"
                    onClick={() => setTopupOpen((v) => !showTopupSub || !v ? !showTopupSub : false)}
                    className={cn(
                      "relative flex h-9.5 w-full items-center gap-3 rounded-full px-3.5 text-[14px] transition-colors",
                      isTopupRoute
                        ? "bg-foreground font-semibold text-background shadow-xs"
                        : showTopupSub
                          ? "bg-muted font-bold text-[#09090b] dark:bg-white/[0.06] dark:text-white"
                          : "font-medium text-[#475569] hover:bg-muted hover:text-[#09090b] dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white",
                    )}
                  >
                    <Icon className={cn("size-[18px] shrink-0", isTopupRoute ? "text-emerald-400 dark:text-emerald-600" : "text-[#64748b] dark:text-zinc-400")} />
                    <span className="min-w-0 flex-1 truncate text-left">{t(item.label)}</span>
                    <ChevronDown className={cn("size-3.5 opacity-70 transition-transform", showTopupSub && "rotate-180")} />
                  </button>
                  {showTopupSub && (
                    <div className="mt-1 mb-1.5 ml-[23px] space-y-0.5 border-l pl-2.5 dark:border-white/[0.07]">
                      <Link
                        href="/pricing?method=bank"
                        prefetch={false}
                        onClick={onNavigate}
                        className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-[#525b6a] transition-colors hover:bg-muted hover:text-[#09090b] dark:text-zinc-300 dark:hover:bg-white/[0.04] dark:hover:text-white"
                      >
                        <BankCircleIcon className="size-[18px]" />
                        <span className="truncate">{t("Ngân hàng")}</span>
                      </Link>
                      <Link
                        href="/pricing?method=crypto"
                        prefetch={false}
                        onClick={onNavigate}
                        className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-[#525b6a] transition-colors hover:bg-muted hover:text-[#09090b] dark:text-zinc-300 dark:hover:bg-white/[0.04] dark:hover:text-white"
                      >
                        <CryptoCircleIcon className="size-[18px]" />
                        <span className="truncate">{t("Crypto")}</span>
                      </Link>
                    </div>
                  )}
                </div>
              );
            }
            const isSupportItem = item.id === "support" || cleanHref === "/support";
            return (
              <NavLink
                key={item.id}
                href={item.href}
                icon={toolIcon(item.icon)}
                label={t(item.label)}
                active={isActive(item.href)}
                collapsed={c}
                badge={item.badge ? t(item.badge) : undefined}
                alertCount={isSupportItem ? supportUnreadCount : undefined}
                highlightSupport={isSupportItem}
                newTab={item.newTab}
                onNavigate={onNavigate}
              />
            );
          }
          return (
            <Fragment key={item.id}>
              {c ? <div className="mx-3 my-3 border-t" /> : item.label ? <NavHeading>{t(item.label)}</NavHeading> : null}
              {groups.map((g) => {
                const open = isOpen(g.key);
                const groupActive = g.tools.some(toolActive);
                if (c) {
                  // thu gọn: icon nhóm dẫn tới công cụ đầu tiên
                  return <NavLink key={g.key} href={toolLink(g.tools[0])} icon={g.icon} label={t(g.label)} active={groupActive} collapsed />;
                }
                return (
                  <div key={g.key}>
                    <button
                      type="button"
                      onClick={() => setOpenGroup((cur) => (cur === g.key ? null : g.key))}
                      className={cn(
                        "flex h-9.5 w-full items-center gap-3 rounded-xl px-3 text-[14px] transition-colors",
                        groupActive || open
                          ? "font-bold text-[#09090b] dark:text-white"
                          : "font-medium text-[#475569] hover:bg-muted hover:text-[#09090b] dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-white",
                      )}
                    >
                      <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md", g.tone)}>
                        <g.icon className="size-3.5" />
                      </span>
                      <span className="flex-1 text-left">{t(g.label)}</span>
                      <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{g.tools.length}</span>
                      <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
                    </button>
                    {open && (
                      <div className="mt-0.5 mb-1.5 ml-[23px] space-y-0.5 border-l pl-2.5 dark:border-white/[0.07]">
                        {g.tools.map((tool) => {
                          const active = toolActive(tool);
                          const logo = modelLogoOf(tool.name);
                          const SubIcon = subToolIconOf(tool);
                          return (
                            <Link
                              key={toolId(tool)}
                              href={toolLink(tool)}
                              prefetch={false}
                              onClick={onNavigate}
                              className={cn(
                                "group/sub flex h-8.5 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors",
                                active
                                  ? "bg-muted font-semibold text-[#09090b] dark:bg-white/[0.08] dark:text-white"
                                  : "font-normal text-[#525b6a] hover:bg-muted hover:text-[#09090b] dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-white",
                              )}
                            >
                              {logo ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={logo} alt="" className={cn("size-4 shrink-0 object-contain", isMonoModelLogo(logo) && "dark:invert")} />
                              ) : (
                                <SubIcon
                                  className={cn(
                                    "size-[15px] shrink-0 transition-colors",
                                    active
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-slate-400 group-hover/sub:text-slate-700 dark:text-zinc-500 dark:group-hover/sub:text-zinc-200",
                                  )}
                                />
                              )}
                              <span className="min-w-0 flex-1 truncate">{t(tool.name)}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </nav>

      {authed ? <SidebarUser collapsed={c} onNavigate={onNavigate} /> : <SidebarGuest collapsed={c} onNavigate={onNavigate} />}
    </div>
  );
}

/** Đáy sidebar khi chưa đăng nhập: nút Đăng ký miễn phí & Đăng nhập gọn gàng (T-310) */
function SidebarGuest({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const nextParam = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  if (collapsed) {
    return (
      <div className="shrink-0 p-3 pt-1 flex justify-center">
        <Link
          href={`/login${nextParam}`}
          onClick={onNavigate}
          title={t("Đăng nhập")}
          className="inline-flex size-9 items-center justify-center rounded-full bg-foreground text-background shadow-xs transition hover:opacity-90"
        >
          <LogIn className="size-4" />
        </Link>
      </div>
    );
  }
  return (
    <div className="shrink-0 space-y-2 border-t border-slate-200/75 p-3 dark:border-white/[0.06]">
      <Link
        href="/register"
        onClick={onNavigate}
        className="flex h-9.5 w-full items-center justify-center gap-1.5 rounded-full bg-foreground px-3.5 text-[13px] font-semibold text-background shadow-xs transition hover:opacity-90"
      >
        <UserPlus className="size-4" />
        {t("Đăng ký miễn phí")}
      </Link>
      <Link
        href={`/login${nextParam}`}
        onClick={onNavigate}
        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full border bg-card px-3.5 text-[13px] font-medium text-foreground transition hover:bg-muted"
      >
        <LogIn className="size-3.5" />
        {t("Đăng nhập")}
      </Link>
    </div>
  );
}

/** Thẻ số dư ở đáy sidebar: số dư ví (VND, dùng để chạy công cụ AI), gói cước cũ còn hạn (nếu có), nút nạp tiền */
function CreditsCard() {
  const credits = useCredits();
  const { t, fmt } = useI18n();
  const plan = credits.data?.plan?.active ? credits.data.plan : null;
  const next = credits.data?.nextRefill;
  return (
    <div className="credit-card mx-3 mb-2 shrink-0 overflow-hidden rounded-2xl border p-3 dark:border-white/[0.07]">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Crown className="size-3.5 text-amber-500" />
          {plan ? (plan.cycle === "year" ? t("Gói {name} (năm)", { name: plan.name }) : t("Gói {name}", { name: plan.name })) : t("Số dư")}
        </span>
        <Link href="/transactions?tab=credits" className="hover:text-foreground">
          {t("Chi tiết")}
        </Link>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-bold tracking-tight tabular-nums">{fmt.money(credits.data?.credits)}</span>
      </div>
      {/* gói năm cũ: lần cộng tiền kế tiếp */}
      {next?.at && (
        <div className="text-[10px] text-muted-foreground">
          {t("+{n} vào {d}", { n: fmt.money(next.credits), d: new Date(next.at).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) })}
        </div>
      )}
      <TopupMethodMenu side="top" align="center">
        <button type="button" className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-foreground text-xs font-semibold text-background transition hover:opacity-90">
          <Sparkles className="size-3.5" /> {t("Nạp tiền")}
        </button>
      </TopupMethodMenu>
    </div>
  );
}

/** Nút chọn ngôn ngữ nhanh trên sidebar (VI / EN / ID... — hiện mọi ngôn ngữ đang bật) */
/** Chữ cái đầu của tên (ảnh đại diện mặc định) */
function initialsOf(name?: string) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "U";
}

/** Kiểu mục trong menu tài khoản: giống mục menu sidebar (bo tròn, cao 36px, chữ 13px) */
const MENU_ITEM =
  "h-9 gap-3 rounded-xl px-2.5 text-[13px] font-medium text-foreground/80 focus:bg-muted dark:text-foreground/70 dark:focus:bg-white/[0.06] [&_svg:not([class*='size-'])]:size-[18px]";

/** Thẻ người dùng ở đáy sidebar: tên + số dư hiện tại (thay cho email — T-182), bấm mở menu tài khoản */
function SidebarUser({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { user, signOut } = useAuth();
  const credits = useCredits();
  const { t, fmt } = useI18n();
  const router = useRouter();
  const go = (href: string) => {
    onNavigate?.();
    router.push(href);
  };
  return (
    <div className="shrink-0 p-3 pt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-2xl border bg-card/80 px-2.5 py-2 text-left shadow-2xs transition hover:bg-muted dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]",
              collapsed && "justify-center border-0 bg-transparent p-1 shadow-none",
            )}
          >
            <Avatar className="size-9">
              {user?.avatar?.url && <AvatarImage src={user.avatar.url} alt={user.name} />}
              <AvatarFallback className="bg-foreground text-xs font-bold text-background">{initialsOf(user?.name)}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[#09090b] dark:text-white">{user?.name}</span>
                <span className="block truncate text-[12px] font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
                  {fmt.money(credits.data?.credits)}
                </span>
              </span>
            )}
            {!collapsed && <ChevronDown className="size-3.5 text-muted-foreground" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-64 rounded-2xl border border-sidebar-border p-1.5 shadow-xl ring-0 dark:border-white/[0.08] dark:bg-[#141414]"
        >
          {/* đầu menu: ảnh đại diện + tên + email, kèm số dư ví (VND) */}
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 p-2.5 dark:bg-white/[0.04]">
              <Avatar className="size-9">
                {user?.avatar?.url && <AvatarImage src={user.avatar.url} alt={user.name} />}
                <AvatarFallback className="bg-foreground text-xs font-bold text-background">{initialsOf(user?.name)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-foreground">{user?.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{user?.email}</span>
              </span>
            </div>
            <Link
              href="/transactions?tab=credits"
              prefetch={false}
              onClick={onNavigate}
              className="mt-1.5 flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.04]"
            >
              <Wallet className="size-4 text-amber-500" />
              <span>{t("Số dư")}</span>
              <span className="font-bold text-foreground tabular-nums">{fmt.money(credits.data?.credits)}</span>
              <ChevronRight className="ml-auto size-3.5" />
            </Link>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-sidebar-border dark:bg-white/[0.06]" />
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => go("/account")}>
            <UserRound /> {t("Tài khoản")}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => go("/pricing")}>
            <CreditCard /> <span className="flex-1">{t("Nạp tiền")}</span>
            <Crown className="size-3.5! text-amber-500" />
          </DropdownMenuItem>
          {/* tài khoản quản trị: mở trang quản trị ở tab mới */}
          {canOpenAdmin(user) && (
            <DropdownMenuItem className={MENU_ITEM} asChild>
              <a href={ADMIN_URL} target="_blank" rel="noreferrer">
                <ShieldCheck /> <span className="flex-1">{t("Trang quản trị")}</span>
                <ExternalLink className="size-3.5! text-muted-foreground" />
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-sidebar-border dark:bg-white/[0.06]" />
          <DropdownMenuItem variant="destructive" className={MENU_ITEM} onSelect={() => signOut()}>
            <LogOut /> {t("Đăng xuất")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Thanh trên: nút menu (mobile), ô tìm công cụ, cụm điều hướng + ngôn ngữ + sáng/tối + đăng nhập/đăng ký (hoặc số dư ví khi đã đăng nhập) */
function Topbar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { status, user } = useAuth();
  const authed = status === "authenticated";
  const credits = useCredits(authed);
  const pathname = usePathname();
  const site = useSiteName();
  const { t, fmt } = useI18n();
  const nextParam = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return (
    <header className="sticky top-0 z-20 border-b border-transparent bg-background/95 dark:border-white/[0.04] md:bg-background/80 md:backdrop-blur-md md:supports-[backdrop-filter]:bg-background/65">
      <div className="mx-auto flex h-16 max-w-[1360px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* cụm trái (nút menu + tên site) chỉ hiện dưới lg; từ lg ẩn hẳn để ô tìm kiếm bắt đầu ngay mép trái nội dung */}
        <div className="flex min-w-0 shrink items-center gap-3 lg:hidden">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Menu">
            <Menu />
          </Button>
          <span className="truncate font-semibold lg:hidden">{site}</span>
        </div>
        {/* ô tìm công cụ (desktop): flex-1 để dài full theo khung nội dung, chỉ chừa chỗ cho cụm bên phải */}
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border bg-card px-4 text-sm text-muted-foreground shadow-xs transition hover:border-foreground/30 hover:text-foreground md:flex dark:hover:border-white/15"
        >
          <Search className="size-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{t("Tìm công cụ AI...")}</span>
          <kbd className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">⌘K</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
          {/* nút mở trang quản trị: chỉ tài khoản có quyền quản trị mới thấy */}
          {authed && canOpenAdmin(user) && (
            <a
              href={ADMIN_URL}
              target="_blank"
              rel="noreferrer"
              title={t("Mở trang quản trị ở tab mới")}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 text-xs font-semibold whitespace-nowrap shadow-xs transition hover:border-foreground/30 dark:hover:border-white/15"
            >
              <ShieldCheck className="size-4" />
              <span className="hidden lg:inline">{t("Quản trị")}</span>
              <ExternalLink className="hidden size-3 text-muted-foreground lg:block" />
            </a>
          )}
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onSearch} aria-label={t("Tìm công cụ AI...")}>
            <Search />
          </Button>
          {authed ? (
            <>
              <div className="hidden items-center gap-1 rounded-full border bg-card py-1 pr-1 pl-3 text-[13px] shadow-xs sm:flex">
                <Link href="/transactions?tab=credits" className="flex items-center gap-1.5 pr-1">
                  <Wallet className="size-4 text-amber-500" />
                  <span className="font-semibold text-[#09090b] tabular-nums dark:text-white">{fmt.money(credits.data?.credits)}</span>
                </Link>
                <TopupMethodMenu align="end">
                  <button type="button" className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-foreground px-3 text-xs font-semibold text-background hover:opacity-90">
                    <Plus className="size-3.5" /> {t("Nạp tiền")}
                  </button>
                </TopupMethodMenu>
              </div>
              <TopupMethodMenu align="end">
                <button type="button" className="inline-flex h-8 items-center gap-1 rounded-full bg-foreground px-3 text-xs font-semibold text-background sm:hidden">
                  <Wallet className="size-3.5" /> {fmt.money(credits.data?.credits)}
                </button>
              </TopupMethodMenu>
              <PrefsSwitcher className="h-9 rounded-full" />
              <ThemeToggle className="size-9 rounded-full" />
            </>
          ) : (
            <>
              <PrefsSwitcher className="h-9 rounded-full" />
              <ThemeToggle className="size-9 rounded-full" />
              <Link
                href={`/login${nextParam}`}
                className="inline-flex h-9 shrink-0 items-center rounded-full border bg-card px-3.5 text-xs font-semibold text-foreground shadow-2xs transition hover:bg-muted sm:px-4 sm:text-[13px]"
              >
                {t("Đăng nhập")}
              </Link>
              <Link
                href="/register"
                className="hidden h-9 shrink-0 items-center rounded-full bg-foreground px-4 text-[13px] font-semibold text-background shadow-sm transition hover:opacity-90 sm:inline-flex"
              >
                {t("Đăng ký miễn phí")}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
