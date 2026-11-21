'use client';

import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Table } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Toggle } from '@/components/ui/toggle';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

const COLS = 8;
const ROWS = 6;

/** Popover chèn bảng: rê chuột chọn số hàng/cột */
export function TablePicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [header, setHeader] = useState(true);
  const insert = (rows: number, cols: number) => {
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: header }).run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Toggle size="sm" pressed={open} aria-label="Chèn bảng" title="Chèn bảng" className="size-7 min-w-7 p-0">
          <Table className="size-4" />
        </Toggle>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-2" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${COLS}, 1.25rem)` }} onMouseLeave={() => setHover({ r: 0, c: 0 })}>
          {Array.from({ length: ROWS * COLS }, (_, i) => {
            const r = Math.floor(i / COLS) + 1;
            const c = (i % COLS) + 1;
            const on = r <= hover.r && c <= hover.c;
            return <button key={i} type="button" aria-label={`${r} x ${c}`} onMouseEnter={() => setHover({ r, c })} onClick={() => insert(r, c)} className={cn('size-5 rounded-sm border transition', on ? 'border-primary bg-primary/30' : 'bg-muted/50 hover:border-primary')} />;
          })}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{hover.r ? `${hover.r} hàng × ${hover.c} cột` : 'Chọn kích thước'}</span>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={header} onCheckedChange={(v) => setHeader(v === true)} /> Hàng tiêu đề
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
