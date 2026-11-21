'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const THEME_OPTIONS = [
  { value: 'light', label: 'Sáng', icon: Sun },
  { value: 'dark', label: 'Tối', icon: Moon },
  { value: 'system', label: 'Theo hệ thống', icon: Monitor },
] as const;

/** Tránh lệch hydrate: theme chỉ biết được ở client */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Nút đổi giao diện: nhấn là chuyển ngay Sáng ↔ Tối (không mở menu).
 * Tuỳ chọn "Theo hệ thống" nằm trong menu tài khoản trên topbar.
 */
export function ThemeToggle({ className }: { className?: string; align?: 'start' | 'end' }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === 'dark';
  const Icon = isDark ? Moon : Sun;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('size-8 text-muted-foreground hover:text-foreground', className)}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          aria-label={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isDark ? 'Giao diện sáng' : 'Giao diện tối'} (Ctrl/⌘ + Shift + L)</TooltipContent>
    </Tooltip>
  );
}

/** Phím tắt Ctrl/⌘ + Shift + L đổi nhanh Sáng ↔ Tối */
export function ThemeHotkey() {
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resolvedTheme, setTheme]);
  return null;
}
