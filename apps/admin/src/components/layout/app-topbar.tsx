'use client';

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ExternalLink, Home, LogOut, Palette, Plus, Search, UserCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { THEME_OPTIONS, ThemeToggle } from '@/components/common/theme-toggle';
import { useCommandPalette } from '@/components/layout/command-palette';
import { type NavGroup, type NavItem } from '@/lib/nav';
import { useAdminNav } from '@/hooks/use-content-types';
import { useAuth } from '@/lib/auth';
import { HAS_WEB_URL, WEB_HOME } from '@/lib/site';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  href?: string;
}

interface PageMeta {
  title?: string;
  breadcrumbs?: Crumb[];
}

const PageMetaCtx = createContext<{ meta: PageMeta; setMeta: (m: PageMeta | null) => void }>({ meta: {}, setMeta: () => undefined });

/** Cho phép PageHeader báo tiêu đề / breadcrumb của trang để topbar hiển thị */
export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMetaState] = useState<PageMeta>({});
  // setMeta phải ổn định (không đổi theo meta) để effect trong usePageMeta không chạy lặp vô hạn
  const setMeta = useCallback((m: PageMeta | null) => setMetaState(m ?? {}), []);
  const value = useMemo(() => ({ meta, setMeta }), [meta, setMeta]);
  return <PageMetaCtx.Provider value={value}>{children}</PageMetaCtx.Provider>;
}

/** Đăng ký tiêu đề/breadcrumb của trang hiện tại lên topbar (tự gỡ khi rời trang) */
export function usePageMeta(meta: PageMeta) {
  const { setMeta } = useContext(PageMetaCtx);
  // so sánh theo chuỗi để mảng literal mỗi lần render không gây set state lặp vô hạn
  const key = JSON.stringify([meta.title ?? null, meta.breadcrumbs ?? null]);
  useEffect(() => {
    setMeta(meta);
    return () => setMeta(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setMeta]);
}

/** Tìm mục menu khớp đường dẫn dài nhất → [cha?, mục] để dựng breadcrumb tự động */
function navTrail(pathname: string, nav: NavGroup[]): NavItem[] {
  let best: NavItem[] = [];
  let bestLen = -1;
  const match = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  for (const group of nav) {
    for (const item of group.items) {
      if (match(item.href) && item.href.length > bestLen) {
        best = [item];
        bestLen = item.href.length;
      }
      for (const child of item.children ?? []) {
        if (match(child.href) && child.href.length >= bestLen) {
          best = child.href === item.href ? [item] : [item, child];
          bestLen = child.href.length;
        }
      }
    }
  }
  return best;
}

function useCrumbs(): Crumb[] {
  const pathname = usePathname();
  const { meta } = useContext(PageMetaCtx);
  // menu động (có loại nội dung tuỳ biến) để breadcrumb /content/<loại> ra đúng tên loại
  const { nav } = useAdminNav();
  return useMemo(() => {
    // breadcrumb trang tự khai báo ("Sản phẩm › Chỉnh sửa") được ưu tiên
    if (meta.breadcrumbs?.length) return meta.breadcrumbs;
    const trail: Crumb[] = navTrail(pathname, nav).map((i) => ({ label: i.title, href: i.href }));
    const last = trail[trail.length - 1];
    if (last && last.href !== pathname && meta.title) trail.push({ label: meta.title });
    if (!trail.length && meta.title) trail.push({ label: meta.title });
    return trail;
  }, [pathname, meta, nav]);
}

function TopbarBreadcrumb() {
  const crumbs = useCrumbs();
  const showHome = crumbs[0]?.href !== '/dashboard';
  const current = crumbs[crumbs.length - 1];
  return (
    <>
      {/* Điện thoại: chỉ tên trang hiện tại */}
      <span className="truncate text-sm font-semibold sm:hidden">{current?.label}</span>
      <Breadcrumb className="hidden min-w-0 sm:block">
        <BreadcrumbList className="flex-nowrap gap-1 sm:gap-1">
          {showHome && (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/dashboard" aria-label="Bảng điều khiển" className="flex items-center">
                    <Home className="size-3.5" />
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {crumbs.length > 0 && <BreadcrumbSeparator />}
            </>
          )}
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            // mục cha chỉ hiện từ md trở lên; separator là <li> riêng nên đặt ngang hàng với item
            const cls = !isLast ? 'hidden md:inline-flex' : undefined;
            return (
              <Fragment key={`${c.label}-${i}`}>
                <BreadcrumbItem className={cn('min-w-0', cls)}>
                  {isLast || !c.href ? (
                    <BreadcrumbPage className={cn('truncate', isLast && 'font-medium')}>{c.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={c.href} className="truncate">
                        {c.label}
                      </Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator className={cls} />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </>
  );
}

function QuickCreate() {
  const { can } = useAuth();
  // tạo nhanh: mục tĩnh (đã ẩn tính năng tắt) + "<loại> mới" cho từng loại nội dung
  const { quickCreate } = useAdminNav();
  const creates = quickCreate.filter((i) => !i.permission || (Array.isArray(i.permission) ? i.permission.some((p) => can(p)) : can(i.permission)));
  if (!creates.length) return null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="default" className="size-9 shrink-0 px-0 md:size-8 md:w-auto md:px-3" aria-label="Tạo mới">
              <Plus className="size-4" />
              <span className="hidden md:inline">Tạo mới</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent className="md:hidden">Tạo mới</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Tạo nhanh</DropdownMenuLabel>
        {creates.map((c) => (
          <DropdownMenuItem key={c.href} asChild>
            <Link href={c.href}>
              {c.icon && <c.icon />} {c.title}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const initial = user?.name?.[0]?.toUpperCase() ?? '?';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ml-1 flex shrink-0 items-center gap-2 rounded-full outline-none ring-offset-background transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:ring-2 data-[state=open]:ring-ring/40"
          aria-label="Tài khoản"
        >
          <Avatar className="size-9 border border-border md:size-8">
            {user?.avatar?.url && <AvatarImage src={user.avatar.urls?.thumb ?? user.avatar.url} alt={user.name} />}
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initial}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-3 font-normal">
          <Avatar className="size-9">
            {user?.avatar?.url && <AvatarImage src={user.avatar.urls?.thumb ?? user.avatar.url} alt={user.name} />}
            <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{user?.name}</div>
            <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
            {user?.role?.name && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{user.role.name}</div>}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <UserCircle /> Hồ sơ & đổi mật khẩu
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette /> Giao diện
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              {THEME_OPTIONS.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value}>
                  <o.icon /> {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* "Xem website" chỉ hiện khi đã cấu hình NEXT_PUBLIC_WEB_URL */}
        {HAS_WEB_URL && (
          <DropdownMenuItem asChild className="sm:hidden">
            <a href={WEB_HOME} target="_blank" rel="noreferrer">
              <ExternalLink /> Trang khách
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void logout()} variant="destructive">
          <LogOut /> Đăng xuất
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Thanh công cụ toàn cục (dính trên cùng, dùng chung mọi trang):
 * nút mở sidebar · breadcrumb · tìm nhanh · tạo mới · xem website · thông báo · giao diện · tài khoản
 */
export function AppTopbar() {
  const palette = useCommandPalette();
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b bg-card/95 px-3 sm:gap-2 backdrop-blur supports-[backdrop-filter]:bg-card/85 md:px-4">
      <SidebarTrigger className="-ml-1 size-9 text-muted-foreground md:size-8 hover:text-foreground" aria-label="Thu/mở menu" />
      <Separator orientation="vertical" className="hidden !h-5 sm:block" />
      <div className="flex min-w-0 flex-1 items-center">
        <TopbarBreadcrumb />
      </div>

      {/* Tìm nhanh: ô giả trên màn rộng, icon trên điện thoại */}
      <button
        type="button"
        onClick={palette.open}
        className="hidden h-8 w-56 items-center gap-2 rounded-md border bg-muted/50 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:w-72 md:flex"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left">Tìm nhanh…</span>
        <kbd className="pointer-events-none rounded border bg-background px-1.5 font-sans text-[10px] font-medium text-muted-foreground">⌘K</kbd>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-9 text-muted-foreground hover:text-foreground md:hidden" onClick={palette.open} aria-label="Tìm nhanh">
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Tìm nhanh (Ctrl/⌘ K)</TooltipContent>
      </Tooltip>

      <QuickCreate />
      <Separator orientation="vertical" className="mx-0.5 hidden !h-5 sm:block" />

      {/* Mở website khách ở tab mới (chỉ hiện khi đã cấu hình NEXT_PUBLIC_WEB_URL) */}
      {HAS_WEB_URL && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className="hidden h-8 gap-1.5 px-2.5 text-xs font-medium sm:inline-flex" asChild>
              <a href={WEB_HOME} target="_blank" rel="noreferrer" aria-label="Mở trang khách">
                <Home className="size-3.5" />
                <span className="hidden md:inline">Trang khách</span>
                <ExternalLink className="size-3 text-muted-foreground" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Mở website khách ở tab mới</TooltipContent>
        </Tooltip>
      )}
      <ThemeToggle className="hidden sm:inline-flex" />
      <UserMenu />
    </header>
  );
}
