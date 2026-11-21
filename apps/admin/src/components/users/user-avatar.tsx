import { cn } from '@/lib/utils';

const COLORS = ['bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300', 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300', 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300', 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300', 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300', 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

/** Ảnh đại diện thành viên, fallback chữ cái đầu với màu theo tên */
export function UserAvatar({ name, avatar, className }: { name: string; avatar?: { url: string; urls?: Record<string, string> } | null; className?: string }) {
  const src = avatar?.urls?.thumb ?? avatar?.url;
  const color = COLORS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % COLORS.length];
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn('size-9 shrink-0 rounded-full object-cover', className)} />
  ) : (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', color, className)}>{initials(name)}</span>
  );
}
