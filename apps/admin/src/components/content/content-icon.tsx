'use client';

import { forwardRef, type ComponentProps } from 'react';
import { FileText, type LucideIcon } from 'lucide-react';
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic';

const ICON_SET = new Set<string>(iconNames);

/** Chuẩn hoá tên icon lucide: "Briefcase" / "BriefcaseBusiness" / "briefcase_business" → "briefcase-business" */
export function normalizeIconName(name: string | null | undefined): string {
  return (name ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Tên icon có trong bộ lucide không */
export function isIconName(name: string | null | undefined): name is IconName {
  return ICON_SET.has(normalizeIconName(name));
}

/** Icon lucide theo tên (tải động); tên sai / trống → FileText */
export function ContentIcon({ name, ...props }: { name?: string | null } & Omit<ComponentProps<typeof FileText>, 'ref'>) {
  const n = normalizeIconName(name);
  if (!ICON_SET.has(n)) return <FileText {...props} />;
  return <DynamicIcon {...props} name={n as IconName} fallback={() => <FileText {...props} />} />;
}

const cache = new Map<string, LucideIcon>();

/**
 * Component icon (kiểu LucideIcon) cho mục menu — để NavItem.icon dùng được icon theo tên của loại nội dung.
 * Cache theo tên để giữ nguyên tham chiếu component giữa các lần render (tránh remount).
 */
export function iconComponent(name: string | null | undefined): LucideIcon {
  const n = normalizeIconName(name);
  if (!ICON_SET.has(n)) return FileText;
  let C = cache.get(n);
  if (!C) {
    const Comp = forwardRef<SVGSVGElement, ComponentProps<typeof FileText>>(function NavContentIcon(props, ref) {
      return <DynamicIcon ref={ref} {...props} name={n as IconName} fallback={() => <FileText {...props} />} />;
    });
    C = Comp as unknown as LucideIcon;
    cache.set(n, C);
  }
  return C;
}
