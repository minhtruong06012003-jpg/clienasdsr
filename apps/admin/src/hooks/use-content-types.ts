'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContentTypeView, TaxonomyView, TermAdminView, TypeLabels } from '@cmsnt/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { NAV, QUICK_CREATE, type NavGroup, type NavItem } from '@/lib/nav';
import { iconComponent } from '@/components/content/content-icon';
import { useFeatures } from '@/hooks/use-features';

/** Quyền đọc danh sách loại nội dung / taxonomy (API: content_types.manage hoặc entries.read) */
const READ_PERMS = ['entries.read', 'content_types.manage'];

/** Danh sách loại nội dung (kèm entryCount, taxonomies) — dùng cho sidebar, trang nội dung, trường tuỳ chỉnh */
export function useContentTypes(enabled = true) {
  const { can, user } = useAuth();
  const allowed = !!user && READ_PERMS.some((p) => can(p));
  return useQuery({
    queryKey: ['content-types'],
    queryFn: () => api.get<ContentTypeView[]>('/admin/content-types'),
    enabled: enabled && allowed,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Danh sách taxonomy (GET /admin/taxonomies — content_types.manage hoặc entries.read).
 * Không tải được → các trang dùng `taxonomyLabel()` lùi về key.
 */
export function useTaxonomies(enabled = true) {
  const { can, user } = useAuth();
  return useQuery({
    queryKey: ['taxonomies'],
    queryFn: () => api.get<TaxonomyView[]>('/admin/taxonomies'),
    enabled: enabled && !!user && READ_PERMS.some((p) => can(p)),
    staleTime: 60_000,
    retry: false,
  });
}

/** Term của một taxonomy (cây phẳng có parentId, kèm translations + entryCount) — GET /admin/taxonomies/:key/terms */
export function useTaxonomyTerms(taxonomy: string | null | undefined, enabled = true) {
  const { can, user } = useAuth();
  return useQuery({
    queryKey: ['taxonomy-terms', taxonomy],
    queryFn: () => api.get<TermAdminView[]>(`/admin/taxonomies/${taxonomy}/terms`),
    enabled: enabled && !!taxonomy && !!user && (can('entries.read') || can('entries.taxonomy')),
    staleTime: 30_000,
  });
}

/** Sắp term thành cây phẳng theo thứ tự cha → con, kèm độ sâu (để thụt lề) */
export function flattenTerms<T extends { id: string; parentId: string | null; sortOrder?: number }>(list: T[]): (T & { depth: number })[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(list.map((t) => t.id));
  for (const t of list) {
    const p = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), t]);
  }
  const out: (T & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of (byParent.get(parent) ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      out.push({ ...t, depth });
      if (depth < 20) walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Tên term theo locale (lùi về bản dịch đầu tiên) */
export function termName(t: Pick<TermAdminView, 'translations'> | null | undefined, locale: string): string {
  return t?.translations?.find((x) => x.locale === locale)?.name ?? t?.translations?.[0]?.name ?? '';
}

/** Một loại nội dung theo key */
export function useContentType(key: string | null | undefined) {
  const q = useContentTypes(!!key);
  const type = useMemo(() => q.data?.find((t) => t.key === key) ?? null, [q.data, key]);
  return { ...q, type };
}

/** Nhãn số nhiều / số ít theo locale (lùi về locale mặc định, rồi bản đầu tiên, rồi key) */
export function typeLabel(labels: TypeLabels | null | undefined, locale: string, form: 'plural' | 'singular' = 'plural', fallback = ''): string {
  const l = labels?.[locale] ?? labels?.vi ?? Object.values(labels ?? {})[0];
  return (form === 'plural' ? l?.plural || l?.singular : l?.singular || l?.plural) || fallback;
}

/** Nhãn taxonomy theo key (khi không tải được danh sách taxonomy thì hiện key) */
export function taxonomyLabel(taxonomies: TaxonomyView[] | undefined, key: string, locale: string, form: 'plural' | 'singular' = 'plural') {
  const t = taxonomies?.find((x) => x.key === key);
  return t ? typeLabel(t.labels, locale, form, key) : key;
}

/** Mục menu cho một loại nội dung: Tất cả / Thêm mới / mỗi taxonomy */
function typeNavItem(t: ContentTypeView, taxonomies: TaxonomyView[] | undefined, locale: string): NavItem {
  const plural = typeLabel(t.labels, locale, 'plural', t.key);
  const singular = typeLabel(t.labels, locale, 'singular', plural);
  const base = `/content/${t.key}`;
  return {
    title: plural,
    href: base,
    icon: iconComponent(t.icon),
    permission: ['entries.read', 'entries.taxonomy'],
    keywords: `${t.key} ${singular} noi dung tuy bien`,
    children: [
      { title: `Tất cả ${plural.toLowerCase()}`, href: base, permission: 'entries.read', keywords: `${t.key} ${singular}` },
      { title: `Thêm ${singular.toLowerCase()}`, href: `${base}/new`, permission: 'entries.write' },
      ...t.taxonomies.map<NavItem>((tax) => ({ title: taxonomyLabel(taxonomies, tax, locale), href: `${base}/terms/${tax}`, permission: 'entries.taxonomy', keywords: `${tax} phan loai taxonomy term` })),
    ],
  };
}

/**
 * Lọc menu theo công tắc tính năng và mục chỉ dành cho Nhà phát triển (devOnly).
 * Không lọc quyền — nơi dùng tự lọc bằng can().
 */
function filterFeatures(
  groups: NavGroup[],
  isOn: (k?: NavItem['feature']) => boolean,
  isDeveloper: boolean,
  isChildSite: boolean,
): NavGroup[] {
  // bỏ cả mục / nhóm đánh dấu hidden, devOnly (nếu không phải dev), childOnly (chỉ hiện ở web con) và mainOnly (chỉ hiện ở web chính)
  const show = (i: NavItem) => !i.hidden && isOn(i.feature) && (isDeveloper || !i.devOnly) && (!i.childOnly || isChildSite) && (!i.mainOnly || !isChildSite);
  const fItems = (items: NavItem[]): NavItem[] => items.filter(show).map((i) => (i.children ? { ...i, children: fItems(i.children) } : i));
  return groups.filter((g) => !g.hidden && isOn(g.feature)).map((g) => ({ ...g, items: fItems(g.items) }));
}

/**
 * Menu admin động: NAV tĩnh + mỗi loại nội dung đang bật (chèn ngay sau "Bài viết" trong nhóm Nội dung),
 * ẩn nhóm/mục có `feature` đang tắt. QUICK_CREATE thêm "Thêm <loại>" cho từng loại.
 * Dùng chung cho sidebar, Tìm nhanh (Ctrl/⌘ K), nút Tạo mới và breadcrumb trên topbar.
 */
export function useAdminNav(locale = 'vi') {
  const types = useContentTypes();
  const taxonomies = useTaxonomies();
  const { isOn } = useFeatures();
  const { isDeveloper, isChildSite } = useAuth();
  return useMemo(() => {
    const active = (types.data ?? []).filter((t) => t.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
    const dynamic = active.map((t) => typeNavItem(t, taxonomies.data, locale));
    const nav: NavGroup[] = NAV.map((g) => {
      if (!dynamic.length || !g.items.some((i) => i.href === '/posts')) return g;
      const at = g.items.findIndex((i) => i.href === '/posts') + 1;
      return { ...g, items: [...g.items.slice(0, at), ...dynamic, ...g.items.slice(at)] };
    });
    const quickCreate: NavItem[] = [
      ...QUICK_CREATE,
      ...active.map<NavItem>((t) => ({ title: `${typeLabel(t.labels, locale, 'singular', t.key)} mới`, href: `/content/${t.key}/new`, icon: iconComponent(t.icon), permission: 'entries.write' })),
    ].filter((i) => !i.hidden && isOn(i.feature));
    return { nav: filterFeatures(nav, isOn, isDeveloper, isChildSite), quickCreate, contentTypes: active };
  }, [types.data, taxonomies.data, locale, isOn, isDeveloper, isChildSite]);
}
