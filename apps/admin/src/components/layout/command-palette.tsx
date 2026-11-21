'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Boxes, ExternalLink, FileText, LayoutTemplate, Loader2, LogOut, Moon, Package, ShoppingCart, Sun, UserCircle } from 'lucide-react';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command';
import { type NavItem } from '@/lib/nav';
import { typeLabel, useAdminNav } from '@/hooks/use-content-types';
import { useFeatures } from '@/hooks/use-features';
import { useAuth } from '@/lib/auth';
import { api, type Paginated } from '@/lib/api';
import { HAS_WEB_URL, WEB_HOME } from '@/lib/site';
import { useDebounce } from '@/hooks/use-debounce';
import { formatMoney } from '@/lib/format';

const Ctx = createContext<{ open: () => void }>({ open: () => undefined });

/** Mở ô Tìm nhanh từ nơi khác (nút trên sidebar...) */
export const useCommandPalette = () => useContext(Ctx);

interface Hit {
  id: string;
  title: string;
  sub?: string;
  href: string;
}

const firstTr = <T extends { locale: string }>(trs: T[] | undefined) => trs?.find((t) => t.locale === 'vi') ?? trs?.[0];

/** Bỏ dấu để gõ "don hang" vẫn ra "Đơn hàng" */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounce(query.trim(), 250);
  const router = useRouter();
  const { can, logout } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // menu động (kèm loại nội dung tuỳ biến, đã ẩn tính năng tắt) — dùng chung với sidebar
  const { nav, quickCreate, contentTypes } = useAdminNav();
  const { isOn } = useFeatures();
  const visible = useCallback((i: NavItem) => !i.permission || (Array.isArray(i.permission) ? i.permission.some((p) => can(p)) : can(i.permission)), [can]);

  // mọi trang trong menu (gộp mục con), kèm nhóm để hiển thị
  const pages = useMemo(() => {
    const out: (NavItem & { group: string; parent?: string })[] = [];
    for (const g of nav)
      for (const item of g.items.filter(visible)) {
        const kids = item.children?.filter(visible) ?? [];
        if (!kids.length) out.push({ ...item, group: g.label });
        for (const c of kids) out.push({ ...c, icon: item.icon, group: g.label, parent: item.title });
      }
    return out;
  }, [visible, nav]);

  const search = useQuery({
    queryKey: ['command-search', q, contentTypes.length],
    enabled: open && q.length >= 2,
    staleTime: 15_000,
    queryFn: async () => {
      const opt = { search: q, limit: 5, page: 1 };
      const [orders, products, pagesRes, posts, entries] = await Promise.all([
        can('orders.read') && isOn('shop') ? api.get<Paginated<{ id: string; code: string; customerName: string; total: unknown; currency: string }>>('/admin/orders', opt).catch(() => null) : null,
        can('products.read') && isOn('shop') ? api.get<Paginated<{ id: string; sku: string | null; translations: { locale: string; name: string }[] }>>('/admin/products', opt).catch(() => null) : null,
        can('pages.read') ? api.get<Paginated<{ id: string; translations: { locale: string; title: string; slug: string }[] }>>('/admin/pages', opt).catch(() => null) : null,
        can('posts.read') && isOn('blog') ? api.get<Paginated<{ id: string; translations: { locale: string; title: string }[] }>>('/admin/posts', opt).catch(() => null) : null,
        // bài của loại nội dung tuỳ biến (Dự án, Dịch vụ...) — picker rút gọn của API
        can('entries.read') && contentTypes.length ? api.get<{ id: string; title: string; type: string; status: string }[]>('/admin/entries/lookup', { search: q, limit: 6 }).catch(() => null) : null,
      ]);
      return {
        orders: (orders?.data ?? []).map<Hit>((o) => ({ id: o.id, title: `#${o.code}`, sub: `${o.customerName} · ${formatMoney(Number(o.total), o.currency)}`, href: `/orders/${o.id}` })),
        products: (products?.data ?? []).map<Hit>((p) => ({ id: p.id, title: firstTr(p.translations)?.name || '(chưa có tên)', sub: p.sku ?? undefined, href: `/products/${p.id}` })),
        pages: (pagesRes?.data ?? []).map<Hit>((p) => ({ id: p.id, title: firstTr(p.translations)?.title || '(chưa có tiêu đề)', sub: `/${firstTr(p.translations)?.slug ?? ''}`, href: `/pages/${p.id}` })),
        posts: (posts?.data ?? []).map<Hit>((p) => ({ id: p.id, title: firstTr(p.translations)?.title || '(chưa có tiêu đề)', href: `/posts/${p.id}` })),
        entries: (Array.isArray(entries) ? entries : []).slice(0, 6).map<Hit>((e) => {
          const t = contentTypes.find((x) => x.key === e.type);
          return { id: e.id, title: e.title || '(chưa có tiêu đề)', sub: t ? typeLabel(t.labels, 'vi', 'singular', t.key) : e.type, href: `/content/${e.type}/${e.id}` };
        }),
      };
    },
  });

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const hitGroups: { key: keyof NonNullable<typeof search.data>; label: string; icon: typeof ShoppingCart }[] = [
    { key: 'orders', label: 'Đơn hàng', icon: ShoppingCart },
    { key: 'products', label: 'Sản phẩm', icon: Package },
    { key: 'pages', label: 'Trang', icon: LayoutTemplate },
    { key: 'posts', label: 'Bài viết', icon: FileText },
    { key: 'entries', label: 'Nội dung tuỳ biến', icon: Boxes },
  ];
  const ctx = useMemo(() => ({ open: () => setOpen(true) }), []);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen} title="Tìm nhanh" description="Tìm trang quản trị, thao tác hoặc nội dung" className="sm:max-w-xl">
        {/* cmdk tự lọc theo value; value gồm cả chữ không dấu để gõ không dấu vẫn khớp */}
        <Command>
        <CommandInput placeholder="Tìm trang, thao tác, mã đơn, sản phẩm, bài viết…" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(60vh,460px)]">
          <CommandEmpty>{search.isFetching ? <Loader2 className="mx-auto size-4 animate-spin" /> : 'Không tìm thấy kết quả phù hợp.'}</CommandEmpty>

          {hitGroups.map(({ key, label, icon: Icon }) => {
            const hits = search.data?.[key] ?? [];
            if (!hits.length || q.length < 2) return null;
            return (
              <CommandGroup key={key} heading={label}>
                {hits.map((h) => (
                  // giữ nguyên chuỗi tìm trong value để cmdk không lọc mất kết quả từ server
                  <CommandItem key={h.id} value={`${key} ${h.id} ${query}`} onSelect={() => go(h.href)}>
                    <Icon />
                    <span className="truncate">{h.title}</span>
                    {h.sub && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{h.sub}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}

          {quickCreate.some(visible) && (
            <CommandGroup heading="Tạo mới">
              {quickCreate.filter(visible).map((i) => (
                <CommandItem key={i.href} value={`tao ${fold(i.title)} ${i.title}`} onSelect={() => go(i.href)}>
                  {i.icon && <i.icon />} {i.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          <CommandGroup heading="Đi tới">
            {pages.map((p) => (
              <CommandItem key={p.href + p.title} value={`${p.title} ${fold(p.title)} ${p.parent ? fold(p.parent) : ''} ${p.keywords ?? ''}`} onSelect={() => go(p.href)}>
                {p.icon && <p.icon />}
                <span>{p.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">{p.parent ?? p.group}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading="Khác">
            {/* chỉ có lệnh "Xem website" khi đã cấu hình NEXT_PUBLIC_WEB_URL */}
            {HAS_WEB_URL && (
              <CommandItem value="xem website mo trang web" onSelect={() => run(() => window.open(WEB_HOME, '_blank', 'noopener'))}>
                <ExternalLink /> Xem website
              </CommandItem>
            )}
            <CommandItem value="ho so cua toi profile doi mat khau" onSelect={() => go('/profile')}>
              <UserCircle /> Hồ sơ & đổi mật khẩu
            </CommandItem>
            <CommandItem value="giao dien sang toi dark mode theme" onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
              {resolvedTheme === 'dark' ? <Sun /> : <Moon />} Chuyển giao diện {resolvedTheme === 'dark' ? 'sáng' : 'tối'}
              <CommandShortcut>⌘⇧L</CommandShortcut>
            </CommandItem>
            <CommandItem value="dang xuat logout" onSelect={() => run(() => void logout())}>
              <LogOut /> Đăng xuất
            </CommandItem>
          </CommandGroup>
        </CommandList>
        </Command>
      </CommandDialog>
    </Ctx.Provider>
  );
}
