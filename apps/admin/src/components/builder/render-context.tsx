'use client';

import { useMemo, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { blockT, type ImageProps, type LinkProps, type RenderContext } from '@cmsnt/blocks';
import { localePrefix, resolveUiStrings, type UiStringsStore } from '@cmsnt/shared';
import { api } from '@/lib/api';

interface Bootstrap {
  defaultLocale: string;
  settings: {
    appearance: { primaryColor?: string; secondaryColor?: string; accentColor?: string };
    commerce: { currency?: string; currencySymbol?: string; currencyPosition?: string; thousandSeparator?: string; decimals?: number };
  };
}

/** Link trong canvas: không điều hướng khi bấm */
function CanvasLink({ href, className, children, ...rest }: LinkProps) {
  return (
    <a href={href} className={className} onClick={(e) => e.preventDefault()} {...rest}>
      {children}
    </a>
  );
}

/** Ảnh trong canvas: <img> thường, hỗ trợ fill như next/image */
function CanvasImage({ src, alt, width, height, className, fill }: ImageProps) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={width ?? undefined} height={height ?? undefined} loading="lazy" className={`${fill ? 'absolute inset-0 h-full w-full' : ''} ${className ?? ''}`} />;
}

export function usePublicBootstrap() {
  return useQuery({ queryKey: ['public-bootstrap'], queryFn: () => api.get<Bootstrap>('/public/bootstrap'), staleTime: 5 * 60_000 });
}

/** RenderContext cho canvas Page Builder (mode = edit) + biến màu thương hiệu */
export function useCanvasContext(locale: string): { ctx: RenderContext; style: CSSProperties } {
  const { data } = usePublicBootstrap();
  // bản dịch chuỗi giao diện admin đã nhập → canvas hiện đúng chữ như website (kể cả ngôn ngữ mới)
  const ui = useQuery({ queryKey: ['ui-strings'], queryFn: () => api.get<UiStringsStore>('/admin/ui-strings'), staleTime: 5 * 60_000 });
  return useMemo(() => {
    const c = data?.settings.commerce ?? {};
    const a = data?.settings.appearance ?? {};
    const defaultLocale = data?.defaultLocale ?? 'vi';
    const formatPrice = (n: number) => {
      const num = Number(n).toFixed(c.decimals ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, c.thousandSeparator ?? '.');
      const sym = c.currencySymbol ?? '₫';
      return c.currencyPosition === 'before' ? `${sym}${num}` : `${num}${sym}`;
    };
    const ctx: RenderContext = {
      locale,
      defaultLocale,
      mode: 'edit',
      apiUrl: '/api',
      formatPrice,
      href: (path) => `${localePrefix(locale, defaultLocale)}${path}`,
      Link: CanvasLink,
      Image: CanvasImage,
      t: blockT(locale, ui.data ? resolveUiStrings(locale, defaultLocale, ui.data) : null),
    };
    const style = { '--cms-brand': a.primaryColor, '--cms-secondary': a.secondaryColor, '--cms-accent': a.accentColor } as CSSProperties;
    return { ctx, style };
  }, [data, ui.data, locale]);
}
