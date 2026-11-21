'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { type Badges, type NavItem } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useAdminNav } from '@/hooks/use-content-types';
import { cn } from '@/lib/utils';

/** Số việc cần xử lý cạnh menu, tự làm mới mỗi phút */
export function useAdminBadges() {
  return useQuery({ queryKey: ['admin-badges'], queryFn: () => api.get<Badges>('/admin/dashboard/badges'), refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 20_000 });
}

function CountBadge({ value, className }: { value?: number; className?: string }) {
  if (!value) return null;
  return (
    <span className={cn('ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold tabular-nums text-white group-data-[collapsible=icon]:hidden', className)}>
      {value > 99 ? '99+' : value}
    </span>
  );
}

// cùng tông với topbar: chữ xám đậm, hover nền xám nhạt, mục đang chọn nền xanh nhạt + chữ/icon xanh
// max-md: menu trên điện thoại (dạng ngăn kéo) cao hơn cho dễ bấm bằng ngón tay
const ITEM_CLS =
  'h-8 max-md:h-10 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&>svg]:text-sidebar-foreground/70 ' +
  'data-[active=true]:bg-primary/25 data-[active=true]:font-medium data-[active=true]:text-white data-[active=true]:[&>svg]:text-primary-foreground dark:data-[active=true]:bg-primary/15 ' +
  'data-[state=open]:[&>svg]:text-sidebar-accent-foreground';
const SUB_CLS = 'h-7 max-md:h-9 rounded-md text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-primary/25 data-[active=true]:font-medium data-[active=true]:text-primary dark:data-[active=true]:bg-primary/15';
const GROUP_LABEL_CLS = 'px-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50';

/** Tên trang quản trị trên đầu sidebar (không dùng logo); cao 14 (bằng topbar) để hai đường viền nối liền nhau */
function Brand({ name }: { name: string }) {
  return (
    <SidebarMenuButton size="lg" asChild tooltip={name} className="h-10 rounded-lg hover:bg-sidebar-accent group-data-[collapsible=icon]:h-8! group-data-[collapsible=icon]:p-0!">
      <Link href="/dashboard">
        {/* menu thu gọn chỉ còn icon nên ẩn luôn chữ */}
        <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate font-semibold text-sidebar-accent-foreground">{name}</span>
          <span className="truncate text-xs text-sidebar-foreground/70">Trang quản trị</span>
        </div>
      </Link>
    </SidebarMenuButton>
  );
}

/** Nút thu gọn / mở rộng ở chân sidebar (ngoài ra còn kéo ở mép và phím Ctrl/⌘ B) */
function CollapseButton() {
  const { state, toggleSidebar, isMobile } = useSidebar();
  if (isMobile) return null;
  const collapsed = state === 'collapsed';
  return (
    <SidebarMenuButton onClick={toggleSidebar} tooltip={collapsed ? 'Mở rộng menu (Ctrl/⌘ B)' : 'Thu gọn menu (Ctrl/⌘ B)'} className={cn(ITEM_CLS, 'h-8 text-sidebar-foreground/80')}>
      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      <span>Thu gọn menu</span>
      <kbd className="ml-auto rounded border border-sidebar-border bg-sidebar-accent px-1.5 font-sans text-[10px] text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">⌘B</kbd>
    </SidebarMenuButton>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { can, isDeveloper } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();
  // điện thoại: chọn xong một trang thì tự đóng ngăn kéo menu để thấy ngay nội dung
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);
  const rawBadges = useAdminBadges().data;
  // số lỗi mới chỉ báo cho Nhà phát triển (tab Nhật ký lỗi ẩn với vai trò khác)
  const badges = isDeveloper ? (rawBadges ?? {}) : { ...rawBadges, newErrors: undefined };
  // menu động: NAV + loại nội dung tuỳ biến, đã ẩn mục thuộc tính năng bị tắt
  const { nav } = useAdminNav();

  const isActive = (href: string) => pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
  // permission dạng mảng = chỉ cần một trong các quyền (can() với mảng là "cần tất cả")
  const visible = (item: NavItem) => !item.permission || (Array.isArray(item.permission) ? item.permission.some((p) => can(p)) : can(item.permission));
  // Tên thương hiệu cố định của trang quản trị (không phụ thuộc tên website)
  const name = 'Admin Panel';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <Brand name={name} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0 py-1">
        {nav.map((group) => {
          const items = group.items.filter(visible);
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label} className="py-1">
              <SidebarGroupLabel className={GROUP_LABEL_CLS}>{group.label}</SidebarGroupLabel>
              <SidebarMenu className="gap-0.5">
                {items.map((item) => {
                  const children = item.children?.filter(visible) ?? [];
                  const count = item.badge ? badges[item.badge] : undefined;
                  if (!children.length) {
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={count ? `${item.title} (${count})` : item.title} className={ITEM_CLS}>
                          <Link href={item.href}>
                            {item.icon && <item.icon />}
                            <span>{item.title}</span>
                            <CountBadge value={count} />
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  }
                  const open = children.some((c) => isActive(c.href)) || isActive(item.href);
                  return (
                    <Collapsible key={item.href} asChild defaultOpen={open} className="group/collapsible">
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton tooltip={count ? `${item.title} (${count})` : item.title} isActive={open} className={ITEM_CLS}>
                            {item.icon && <item.icon />}
                            <span>{item.title}</span>
                            <CountBadge value={count} />
                            <ChevronRight className={cn('size-3.5 opacity-60 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90', !count && 'ml-auto')} />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub className="mr-0 gap-0.5 border-sidebar-border">
                            {children.map((c) => (
                              <SidebarMenuSubItem key={c.href}>
                                <SidebarMenuSubButton asChild isActive={pathname === c.href} className={SUB_CLS}>
                                  <Link href={c.href}>
                                    <span>{c.title}</span>
                                    {c.badge && <CountBadge value={badges[c.badge]} className="h-4 min-w-4 px-1 text-[10px]" />}
                                  </Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      {/* chân sidebar chỉ có nút thu gọn (không dùng trên điện thoại) */}
      <SidebarFooter className="border-t border-sidebar-border max-md:hidden">
        <SidebarMenu>
          <SidebarMenuItem>
            <CollapseButton />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
