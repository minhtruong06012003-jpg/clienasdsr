'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Toggle } from '@/components/ui/toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Bảng màu kiểu WordPress */
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47',
];

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(v: string): string | null {
  const s = v.trim();
  if (!HEX_RE.test(s)) return null;
  const h = s.startsWith('#') ? s : `#${s}`;
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h.toLowerCase();
}

/** Popover chọn màu chữ / màu nền: bảng màu + ô nhập hex */
export function ColorPicker({ icon: Icon, label, value, onPick, highlight }: { icon: LucideIcon; label: string; value: string | null | undefined; onPick: (color: string | null) => void; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value ?? '');
  useEffect(() => {
    if (open) setHex(value ?? '');
  }, [open, value]);
  const apply = (c: string | null) => {
    onPick(c);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Toggle size="sm" pressed={!!value} aria-label={label} title={label} className="relative size-7 min-w-7 p-0">
          <Icon className="size-4" />
          <span className="absolute inset-x-1.5 bottom-0.5 h-[3px] rounded-full" style={{ background: value ?? (highlight ? '#ffff00' : 'currentColor'), opacity: value ? 1 : 0.35 }} />
        </Toggle>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="grid grid-cols-10 gap-1">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => apply(c)}
              className={cn('size-5 rounded-sm border border-black/10 transition hover:scale-110 dark:border-white/15', value?.toLowerCase() === c && 'ring-2 ring-ring ring-offset-1 ring-offset-background')}
              style={{ background: c }}
            />
          ))}
        </div>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const h = normalizeHex(hex);
            if (h) apply(h);
          }}
        >
          <span className="size-6 shrink-0 rounded-sm border" style={{ background: normalizeHex(hex) ?? 'transparent' }} />
          <Input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#1a2b3c" className="h-7 font-mono text-xs" />
          <Button type="submit" size="sm" variant="secondary" disabled={!normalizeHex(hex)}>
            Áp dụng
          </Button>
        </form>
        <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => apply(null)}>
          {highlight ? 'Bỏ màu nền' : 'Màu mặc định'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
