"use client";

/**
 * Khung giao diện ShopClone MMO (lấy nguyên bố cục & chất liệu từ CMSNT ShopClone7):
 * - Thanh thông báo trên cùng (`header-top`) nền màu chủ đạo `--sc-primary` + đổi ngôn ngữ / tiền tệ / sáng tối.
 * - Thanh đầu trang trắng (`header-part`, dính khi cuộn): Logo trái, ô tìm kiếm công cụ AI ở giữa, nút tròn Lịch sử + Nạp tiền + Tài khoản / Số dư bên phải.
 * - Thanh menu ngang (`navbar-part`): Trang chủ, Công cụ AI (dropdown danh mục), Nạp tiền, Lịch sử tạo, Biến động số dư, Tiếp thị liên kết, Cộng đồng, Tài liệu API, Tài khoản.
 * - Mobile: Drawer trượt ngang có 2 tab `DANH MỤC` & `MENU CHÍNH` giống hệt ShopClone7.
 * - Chân trang trắng 4 cột + thanh bản quyền màu chủ đạo.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Gift,
  Globe,
  History,
  House,
  KeyRound,
  LogIn,
  LogOut,
  Menu,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { PrefsSwitcher } from "@/components/prefs-switcher";
import { Logo } from "@/components/site/logo";
import { ToolPalette } from "@/components/ai/tool-palette";
import { TopupMethodMenu } from "@/components/ai/topup-method-icons";
import { useAuth } from "@/lib/auth";
import { useAiTools, useBalance, useCategories, useCredits, useSiteName } from "@/lib/queries";
import { groupTools, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { useSiteTheme } from "@/lib/site-theme";
import { ADMIN_URL, canOpenAdmin } from "@/lib/site";
import { cn } from "@/lib/utils";

interface ShopSearchContextValue {
  keyword: string;
  setKeyword: (v: string) => void;
  selectedCategory: string;
  setSelectedCategory: (v: string) => void;
}

const ShopSearchContext = createContext<ShopSearchContextValue | null>(null);

export function useShopCloneFilter() {
  return useContext(ShopSearchContext);
}

export function ShopCloneShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, fmt } = useI18n();
  const { status, user, signOut } = useAuth();
  const siteName = useSiteName();
  const { primaryColor, secondaryColor, showTopbar, topbarText, stickyHeader } = useSiteTheme();
  const tools = useAiTools();
  const categories = useCategories();
  const groups = useMemo(() => groupTools(tools.data, categories.list), [tools.data, categories.list]);

  const authed = status === "authenticated";
  const credits = useCredits(authed);
  const wallet = useBalance();
  const currentBalance = credits.data?.credits ?? wallet.balance ?? 0;

  const [keyword, setKeyword] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"cats" | "menu">("cats");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const isStoreHome = pathname === "/" || pathname === "/dashboard";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const topNotice = useMemo(() => {
    if (!topbarText) return t("Hệ thống tạo Video, Ảnh, Giọng nói AI tự động 24/7 — Nạp tiền tự động 5 giây!");
    if (typeof topbarText === "string") return t(topbarText);
    const picked = topbarText[locale] || topbarText.vi || Object.values(topbarText)[0] || "";
    if (!picked || /vận chuyển|free shipping/i.test(picked)) {
      return t("Hệ thống tạo Video, Ảnh, Giọng nói AI tự động 24/7 — Nạp tiền tự động 5 giây!");
    }
    return topbarText[locale] ? picked : t(picked);
  }, [topbarText, locale, t]);

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isStoreHome) {
      const q = keyword.trim();
      router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
      return;
    }
    const el = document.getElementById("sc-products");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const jumpCategory = (catKey: string) => {
    setSelectedCategory(catKey);
    setDrawerOpen(false);
    if (!isStoreHome) {
      router.push(catKey === "all" ? "/" : `/?cat=${encodeURIComponent(catKey)}`);
      return;
    }
    setTimeout(() => {
      document.getElementById("sc-products")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  };

  const scVars = {
    "--sc-primary": primaryColor || "#119744",
    "--sc-primary-dark": secondaryColor && secondaryColor !== "#0f172a" ? secondaryColor : "#0d7a36",
  } as CSSProperties;

  const navItems = [
    { href: authed ? "/dashboard" : "/", label: t("Trang chủ"), icon: House, active: isStoreHome },
    { href: "/pricing", label: t("Nạp tiền"), icon: CreditCard, active: pathname.startsWith("/pricing") || pathname.startsWith("/checkout") },
    { href: "/history", label: t("Lịch sử tạo"), icon: History, active: pathname.startsWith("/history") },
    { href: "/transactions", label: t("Biến động số dư"), icon: ReceiptText, active: pathname.startsWith("/transactions") },
    { href: "/community", label: t("Cộng đồng"), icon: Globe, active: pathname.startsWith("/community") },
    { href: "/affiliate", label: t("Tiếp thị liên kết"), icon: Gift, active: pathname.startsWith("/affiliate") },
    { href: authed ? "/api-keys" : "/api-docs", label: t("Tài liệu API"), icon: KeyRound, active: pathname.startsWith("/api-keys") || pathname.startsWith("/api-docs") },
  ];

  const initials = (user?.name || user?.email || "U").slice(0, 2).toUpperCase();

  return (
    <ShopSearchContext.Provider value={{ keyword, setKeyword, selectedCategory, setSelectedCategory }}>
      <div
        style={scVars}
        className="flex min-h-screen flex-col bg-[#f5f6f7] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
      >
        {/* 1. Thanh Topbar màu thương hiệu kiểu ShopClone7 */}
        {showTopbar && (
          <div
            className="w-full py-1.5 text-white"
            style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
          >
            <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3 px-3 text-xs sm:px-5">
              <p className="truncate font-medium tracking-wide opacity-95">
                <Sparkles className="mr-1.5 inline size-3.5 -translate-y-0.5" />
                {topNotice}
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <div className="rounded-md bg-white/15 px-1 text-white [&_button]:h-7 [&_button]:text-xs [&_button]:text-white hover:[&_button]:bg-white/15">
                  <PrefsSwitcher />
                </div>
                <div className="rounded-md bg-white/15 text-white [&_button]:size-7 [&_button]:text-white hover:[&_button]:bg-white/15">
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 2. Header trắng chính: Logo + Ô tìm kiếm giữa + Nút tròn Lịch sử / Nạp tiền / Số dư */}
        <header
          className={cn(
            "z-40 w-full border-b border-zinc-200/80 bg-white transition-shadow dark:border-zinc-800 dark:bg-zinc-900",
            stickyHeader && "sticky top-0",
            scrolled && "shadow-[0_5px_15px_rgba(0,0,0,0.10)]",
          )}
        >
          <div className="mx-auto flex max-w-[1320px] items-center gap-3 px-3 py-3 sm:gap-5 sm:px-5">
            {/* Mobile: nút mở menu + logo */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={t("Mở menu")}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-700 transition hover:bg-[var(--sc-primary)] hover:text-white lg:hidden dark:bg-zinc-800 dark:text-zinc-200"
            >
              <Menu className="size-5" />
            </button>

            <div className="shrink-0">
              <Logo />
            </div>

            {/* Ô tìm kiếm tròn giữa màn hình giống ShopClone */}
            <form
              onSubmit={onSearchSubmit}
              className="hidden flex-1 items-center rounded-lg border-2 border-transparent bg-[#f5f5f5] px-3.5 transition focus-within:border-[var(--sc-primary)] focus-within:bg-white md:flex dark:bg-zinc-800 dark:focus-within:bg-zinc-900"
            >
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t("Tìm kiếm công cụ AI (Seedance, Kling, Veo, Nano Banana, Giọng đọc...)")}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
              />
              {keyword && (
                <button
                  type="button"
                  onClick={() => setKeyword("")}
                  className="mr-1 inline-flex size-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-700"
                  aria-label="Xoá từ khoá"
                >
                  <X className="size-3.5" />
                </button>
              )}
              <button
                type="submit"
                aria-label={t("Tìm kiếm")}
                className="inline-flex size-8 items-center justify-center rounded-md text-zinc-600 transition hover:text-[var(--sc-primary)] dark:text-zinc-300"
              >
                <Search className="size-4.5" />
              </button>
            </form>

            {/* Cụm nút bên phải */}
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              {/* Mobile: nút mở tìm kiếm nhanh */}
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label={t("Tìm công cụ AI")}
                className="inline-flex size-9 items-center justify-center rounded-full bg-[#f5f5f5] text-zinc-700 transition hover:bg-[var(--sc-primary)] hover:text-white md:hidden dark:bg-zinc-800 dark:text-zinc-200"
              >
                <Search className="size-4" />
              </button>

              <Link
                href="/history"
                title={t("Lịch sử tạo")}
                className="hidden size-10 items-center justify-center rounded-full bg-[#f5f5f5] text-zinc-700 transition hover:bg-[var(--sc-primary)] hover:text-white sm:inline-flex dark:bg-zinc-800 dark:text-zinc-200"
              >
                <History className="size-4.5" />
              </Link>

              <TopupMethodMenu align="end">
                <button
                  type="button"
                  title={t("Nạp tiền")}
                  className="hidden size-10 items-center justify-center rounded-full bg-[#f5f5f5] text-zinc-700 transition hover:bg-[var(--sc-primary)] hover:text-white sm:inline-flex dark:bg-zinc-800 dark:text-zinc-200"
                >
                  <Wallet className="size-4.5" />
                </button>
              </TopupMethodMenu>

              {authed && canOpenAdmin(user) && (
                <a
                  href={ADMIN_URL}
                  target="_blank"
                  rel="noreferrer"
                  title={t("Trang quản trị")}
                  className="hidden h-10 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs font-semibold text-zinc-700 transition hover:border-[var(--sc-primary)] hover:text-[var(--sc-primary)] xl:inline-flex dark:border-zinc-700 dark:text-zinc-200"
                >
                  <ShieldCheck className="size-4" /> {t("Quản trị")}
                </a>
              )}

              {authed ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2.5 rounded-full border border-zinc-200 bg-[#f8f9fa] py-1 pr-3 pl-1 text-left transition hover:border-[var(--sc-primary)] dark:border-zinc-700 dark:bg-zinc-800"
                    >
                      <Avatar className="size-8 border">
                        {user?.avatar?.url && <AvatarImage src={user.avatar.url} alt={user.name || ""} />}
                        <AvatarFallback className="bg-[var(--sc-primary)] text-xs font-bold text-white">{initials}</AvatarFallback>
                      </Avatar>
                      <div className="hidden leading-tight sm:block">
                        <div className="max-w-[120px] truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                          {user?.name || user?.email?.split("@")[0]}
                        </div>
                        <div className="text-xs font-bold tabular-nums" style={{ color: "var(--sc-primary)" }}>
                          {fmt.money(currentBalance)}
                        </div>
                      </div>
                      <ChevronDown className="size-3.5 text-zinc-500" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuLabel>
                      <div className="truncate font-semibold">{user?.name || user?.email}</div>
                      <div className="mt-0.5 text-xs font-bold tabular-nums" style={{ color: "var(--sc-primary)" }}>
                        {t("Số dư:")} {fmt.money(currentBalance)}
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href="/pricing">
                        <CreditCard className="size-4" /> {t("Nạp tiền vào ví")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/history">
                        <History className="size-4" /> {t("Lịch sử tạo AI")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/transactions">
                        <ReceiptText className="size-4" /> {t("Biến động số dư")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/account">
                        <Settings className="size-4" /> {t("Thông tin tài khoản")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/api-keys">
                        <KeyRound className="size-4" /> {t("Khoá API Developer")}
                      </Link>
                    </DropdownMenuItem>
                    {canOpenAdmin(user) && (
                      <DropdownMenuItem asChild>
                        <a href={ADMIN_URL} target="_blank" rel="noreferrer">
                          <ShieldCheck className="size-4" /> {t("Mở trang quản trị")}
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => signOut()} className="text-red-600 focus:text-red-600">
                      <LogOut className="size-4" /> {t("Đăng xuất")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <div className="flex items-center gap-2">
                  <Link
                    href="/login"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 transition hover:border-[var(--sc-primary)] hover:text-[var(--sc-primary)] sm:px-3.5 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    <LogIn className="size-3.5" /> {t("Đăng nhập")}
                  </Link>
                  <Link
                    href="/register"
                    style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
                    className="hidden h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-bold text-white shadow-xs transition hover:opacity-95 sm:inline-flex"
                  >
                    <UserPlus className="size-3.5" /> {t("Đăng ký")}
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* 3. Thanh Navbar ngang (Desktop) giống ShopClone7 */}
          <nav className="hidden border-t border-zinc-100 bg-white lg:block dark:border-zinc-800/80 dark:bg-zinc-900">
            <div className="mx-auto flex max-w-[1320px] items-center gap-1 px-5">
              {/* Trang chủ */}
              <Link
                href={authed ? "/dashboard" : "/"}
                className={cn(
                  "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition",
                  isStoreHome
                    ? "border-[var(--sc-primary)] text-[var(--sc-primary)]"
                    : "border-transparent text-zinc-700 hover:text-[var(--sc-primary)] dark:text-zinc-300",
                )}
              >
                <House className="size-4" /> {t("Trang chủ")}
              </Link>

              {/* Dropdown Danh mục Công cụ AI */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition outline-none",
                      pathname.startsWith("/tools")
                        ? "border-[var(--sc-primary)] text-[var(--sc-primary)]"
                        : "border-transparent text-zinc-700 hover:text-[var(--sc-primary)] dark:text-zinc-300",
                    )}
                  >
                    <Sparkles className="size-4" /> {t("Danh mục AI")} <ChevronDown className="size-3.5 opacity-70" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 p-1.5">
                  <DropdownMenuItem onClick={() => jumpCategory("all")} className="font-semibold">
                    <Sparkles className="size-4 text-[var(--sc-primary)]" /> {t("Tất cả công cụ AI")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {groups.map((g) => (
                    <DropdownMenuItem key={g.key} onClick={() => jumpCategory(g.key)} className="justify-between">
                      <span className="flex items-center gap-2">
                        <g.icon className="size-4 text-zinc-500" />
                        <span>{t(g.label)}</span>
                      </span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {g.tools.length}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {navItems.slice(1).map((item) =>
                item.href === "/pricing" ? (
                  <TopupMethodMenu key={item.href} align="start">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition outline-none",
                        item.active
                          ? "border-[var(--sc-primary)] text-[var(--sc-primary)]"
                          : "border-transparent text-zinc-700 hover:text-[var(--sc-primary)] dark:text-zinc-300",
                      )}
                    >
                      <item.icon className="size-4" /> {item.label} <ChevronDown className="size-3.5 opacity-70" />
                    </button>
                  </TopupMethodMenu>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition",
                      item.active
                        ? "border-[var(--sc-primary)] text-[var(--sc-primary)]"
                        : "border-transparent text-zinc-700 hover:text-[var(--sc-primary)] dark:text-zinc-300",
                    )}
                  >
                    <item.icon className="size-4" /> {item.label}
                  </Link>
                ),
              )}

              {authed && (
                <Link
                  href="/account"
                  className={cn(
                    "ml-auto inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] font-semibold transition",
                    pathname.startsWith("/account")
                      ? "border-[var(--sc-primary)] text-[var(--sc-primary)]"
                      : "border-transparent text-zinc-700 hover:text-[var(--sc-primary)] dark:text-zinc-300",
                  )}
                >
                  <UserRound className="size-4" /> {t("Tài khoản")}
                </Link>
              )}
            </div>
          </nav>
        </header>

        {/* 4. Drawer Mobile 2 Tab (Danh mục AI / Menu chính) giống ShopClone7 */}
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="flex w-[290px] max-w-[86vw] flex-col gap-0 p-0">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <div className="flex items-center justify-between border-b px-4 py-3.5">
              <Logo />
            </div>

            {authed && (
              <div className="border-b bg-zinc-50 px-4 py-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">{t("Số dư hiện tại")}</div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-lg font-bold tabular-nums" style={{ color: "var(--sc-primary)" }}>
                    {fmt.money(currentBalance)}
                  </span>
                  <Link
                    href="/pricing"
                    onClick={() => setDrawerOpen(false)}
                    style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
                    className="rounded-md px-2.5 py-1 text-xs font-bold text-white"
                  >
                    + {t("Nạp tiền")}
                  </Link>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 border-b text-xs font-bold uppercase">
              <button
                type="button"
                onClick={() => setDrawerTab("cats")}
                className={cn(
                  "border-b-2 py-2.5 transition",
                  drawerTab === "cats" ? "border-[var(--sc-primary)] text-[var(--sc-primary)]" : "border-transparent text-zinc-500",
                )}
              >
                {t("Danh mục AI")}
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab("menu")}
                className={cn(
                  "border-b-2 py-2.5 transition",
                  drawerTab === "menu" ? "border-[var(--sc-primary)] text-[var(--sc-primary)]" : "border-transparent text-zinc-500",
                )}
              >
                {t("Menu chính")}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2.5">
              {drawerTab === "cats" ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => jumpCategory("all")}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold transition",
                      selectedCategory === "all" && isStoreHome
                        ? "bg-[var(--sc-primary)]/10 text-[var(--sc-primary)]"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <Sparkles className="size-4" /> {t("Tất cả dịch vụ AI")}
                    </span>
                    <ChevronRight className="size-4 opacity-50" />
                  </button>
                  {groups.map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => jumpCategory(g.key)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition",
                        selectedCategory === g.key && isStoreHome
                          ? "bg-[var(--sc-primary)]/10 font-semibold text-[var(--sc-primary)]"
                          : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      )}
                    >
                      <span className="flex items-center gap-2.5">
                        <g.icon className="size-4 text-zinc-500" /> {t(g.label)}
                      </span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {g.tools.length}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {navItems.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition",
                        item.active
                          ? "bg-[var(--sc-primary)]/10 font-semibold text-[var(--sc-primary)]"
                          : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      )}
                    >
                      <item.icon className="size-4" />
                      <span className="flex-1">{item.label}</span>
                      <ChevronRight className="size-4 opacity-40" />
                    </Link>
                  ))}
                  {authed && (
                    <Link
                      href="/account"
                      onClick={() => setDrawerOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Settings className="size-4" />
                      <span className="flex-1">{t("Cài đặt tài khoản")}</span>
                      <ChevronRight className="size-4 opacity-40" />
                    </Link>
                  )}
                </div>
              )}
            </div>

            {!authed && (
              <div className="grid grid-cols-2 gap-2 border-t p-3">
                <Link
                  href="/login"
                  onClick={() => setDrawerOpen(false)}
                  className="inline-flex h-10 items-center justify-center rounded-lg border font-semibold text-sm"
                >
                  {t("Đăng nhập")}
                </Link>
                <Link
                  href="/register"
                  onClick={() => setDrawerOpen(false)}
                  style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
                  className="inline-flex h-10 items-center justify-center rounded-lg font-semibold text-sm text-white"
                >
                  {t("Đăng ký")}
                </Link>
              </div>
            )}
          </SheetContent>
        </Sheet>

        {/* 5. Vùng nội dung chính */}
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-3 py-5 sm:px-5">{children}</main>

        {/* 6. Chân trang trắng kiểu ShopClone7 + dải bản quyền màu thương hiệu */}
        <footer className="mt-8 border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-8 px-4 py-10 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
            <div className="space-y-3">
              <Logo />
              <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t("Hệ thống cung cấp công cụ tạo Video AI, Ảnh AI 4K, Giọng đọc AI tự động 24/7. Nạp tiền tự động, cam kết hoàn tiền 100% khi tác vụ lỗi.")}
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100">
                {t("Danh mục dịch vụ")}
              </h3>
              <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                {groups.slice(0, 5).map((g) => (
                  <li key={g.key}>
                    <button
                      type="button"
                      onClick={() => jumpCategory(g.key)}
                      className="inline-flex items-center gap-1.5 transition hover:text-[var(--sc-primary)]"
                    >
                      <ToolIcon name={undefined} className="hidden" />
                      <ChevronRight className="size-3.5 opacity-60" /> {t(g.label)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100">
                {t("Tài khoản & Nạp tiền")}
              </h3>
              <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                <li>
                  <Link href="/pricing" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <ChevronRight className="size-3.5 opacity-60" /> {t("Nạp tiền tự động 24/7")}
                  </Link>
                </li>
                <li>
                  <Link href="/history" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <ChevronRight className="size-3.5 opacity-60" /> {t("Lịch sử đơn tạo AI")}
                  </Link>
                </li>
                <li>
                  <Link href="/affiliate" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <ChevronRight className="size-3.5 opacity-60" /> {t("Tiếp thị liên kết hoa hồng")}
                  </Link>
                </li>
                <li>
                  <Link href="/api-docs" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <ChevronRight className="size-3.5 opacity-60" /> {t("Tài liệu đấu nối API")}
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100">
                {t("Chính sách & Bảo mật")}
              </h3>
              <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                <li>
                  <Link href="/p/dieu-khoan" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <BookOpen className="size-3.5 opacity-60" /> {t("Điều khoản dịch vụ")}
                  </Link>
                </li>
                <li>
                  <Link href="/p/chinh-sach-bao-mat" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <BookOpen className="size-3.5 opacity-60" /> {t("Chính sách bảo mật")}
                  </Link>
                </li>
                <li>
                  <Link href="/p/chinh-sach-noi-dung-ai" className="inline-flex items-center gap-1.5 hover:text-[var(--sc-primary)]">
                    <BookOpen className="size-3.5 opacity-60" /> {t("Chính sách nội dung AI")}
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div
            className="py-3.5 text-xs text-white"
            style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
          >
            <div className="mx-auto flex max-w-[1320px] flex-col items-center justify-between gap-1.5 px-4 sm:flex-row sm:px-5">
              <p>© {new Date().getFullYear()} <b>{siteName}</b>. {t("Bảo lưu mọi quyền.")}</p>
              <p className="opacity-90">{t("Tự động 24/7 · Bảo mật thanh toán · Tự hoàn tiền khi lỗi")}</p>
            </div>
          </div>
        </footer>

        <ToolPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </ShopSearchContext.Provider>
  );
}
