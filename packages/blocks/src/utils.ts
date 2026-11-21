import type { BlockSettings } from '@cmsnt/shared';

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

/**
 * LƯU Ý RESPONSIVE: block dùng container query (@2xl, @3xl, @5xl...) thay vì breakpoint màn hình
 * để Page Builder xem trước đúng giao diện mobile/tablet trong khung nhỏ.
 * Storefront và canvas admin đều bọc nội dung trong phần tử có class "@container".
 *   @2xl ≈ 672px (tablet nhỏ) | @3xl ≈ 768px (tablet) | @5xl ≈ 1024px (desktop)
 */
const PAD_TOP: Record<string, string> = { none: 'pt-0', sm: 'pt-6', md: 'pt-10 @3xl:pt-12', lg: 'pt-14 @3xl:pt-20', xl: 'pt-20 @3xl:pt-28' };
const PAD_BOTTOM: Record<string, string> = { none: 'pb-0', sm: 'pb-6', md: 'pb-10 @3xl:pb-12', lg: 'pb-14 @3xl:pb-20', xl: 'pb-20 @3xl:pb-28' };
const CONTAINER: Record<string, string> = {
  default: 'mx-auto w-full max-w-7xl px-4 @3xl:px-6',
  wide: 'mx-auto w-full max-w-[96rem] px-4 @3xl:px-6',
  narrow: 'mx-auto w-full max-w-3xl px-4 @3xl:px-6',
  full: 'w-full',
};
const HIDE: Record<string, string> = { mobile: 'max-@3xl:hidden', tablet: '@3xl:max-@5xl:hidden', desktop: '@5xl:hidden' };

export function sectionClasses(s: BlockSettings = {}) {
  return cn(PAD_TOP[s.paddingTop ?? 'md'], PAD_BOTTOM[s.paddingBottom ?? 'md'], ...(s.hideOn ?? []).map((h) => HIDE[h]), s.className);
}

export function containerClass(container: BlockSettings['container'] = 'default') {
  return CONTAINER[container] ?? CONTAINER.default;
}

export const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 @2xl:grid-cols-2',
  3: 'grid-cols-1 @2xl:grid-cols-2 @5xl:grid-cols-3',
  4: 'grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4',
  5: 'grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-5',
  6: 'grid-cols-2 @3xl:grid-cols-4 @5xl:grid-cols-6',
};

export function gridCols(n: number | string | undefined, fallback = 3) {
  return GRID_COLS[Number(n) || fallback] ?? GRID_COLS[fallback];
}

/** Lấy giá trị theo đường dẫn "items.0.title" */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** Gán giá trị theo đường dẫn, trả về object mới (immutable) */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const src = (obj ?? {}) as Record<string, unknown>;
  const clone: Record<string, unknown> | unknown[] = Array.isArray(src) ? [...src] : { ...src };
  (clone as Record<string, unknown>)[head] = rest.length ? setPath(src[head], rest.join('.'), value) : value;
  return clone as T;
}

/** Nhận diện url YouTube / Vimeo -> url embed */
export function videoEmbed(url: string): { type: 'iframe' | 'video'; src: string } | null {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { type: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return { type: 'iframe', src: `https://player.vimeo.com/video/${vimeo[1]}` };
  return { type: 'video', src: url };
}
