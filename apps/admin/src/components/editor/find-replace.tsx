'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Replace, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Toggle } from '@/components/ui/toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

interface Match {
  from: number;
  to: number;
}

/** Tìm mọi vị trí khớp trong tài liệu (theo từng textblock, node inline lá tính 1 ký tự) */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const q = caseSensitive ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const raw = node.textBetween(0, node.content.size, undefined, '￼');
    const text = caseSensitive ? raw : raw.toLowerCase();
    let i = text.indexOf(q);
    while (i !== -1) {
      out.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
      i = text.indexOf(q, i + q.length);
    }
    return false;
  });
  return out;
}

/** Popover tìm & thay thế (không chặn tương tác với trình soạn thảo) */
export function FindReplace({ editor, open, onOpenChange }: { editor: Editor; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  // version tăng mỗi lần tài liệu đổi (chỉ lắng nghe khi popover mở) -> tính lại số kết quả
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!open) return;
    const h = () => setVersion((v) => v + 1);
    editor.on('update', h);
    return () => {
      editor.off('update', h);
    };
  }, [open, editor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => (open ? findMatches(editor.state.doc, query, caseSensitive) : []), [editor, version, query, caseSensitive, open]);
  useEffect(() => {
    if (!open) return;
    const { from, to } = editor.state.selection;
    if (from !== to) setQuery(editor.state.doc.textBetween(from, to, ' ').slice(0, 100));
  }, [open, editor]);

  const select = (m: Match) => editor.chain().setTextSelection(m).scrollIntoView().run();
  const findNext = () => {
    if (!matches.length) return;
    const { from, to } = editor.state.selection;
    const idx = matches.findIndex((m) => m.from > from || (m.from === from && m.to > to));
    select(matches[idx === -1 ? 0 : idx]);
  };
  const currentMatch = () => {
    const { from, to } = editor.state.selection;
    return matches.find((m) => m.from === from && m.to === to);
  };
  const replaceOne = () => {
    const m = currentMatch();
    if (!m) return findNext();
    editor.chain().insertContentAt({ from: m.from, to: m.to }, replacement).run();
    findNext();
  };
  const replaceAll = () => {
    if (!matches.length) return;
    const tr = editor.state.tr;
    for (const m of [...matches].reverse()) tr.insertText(replacement, m.from, m.to);
    editor.view.dispatch(tr);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Toggle size="sm" pressed={open} aria-label="Tìm & thay thế" title="Tìm & thay thế" className="size-7 min-w-7 p-0">
          <Replace className="size-4" />
        </Toggle>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2" onInteractOutside={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Tìm & thay thế</span>
          <Button type="button" size="icon-xs" variant="ghost" onClick={() => onOpenChange(false)} aria-label="Đóng">
            <X />
          </Button>
        </div>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              findNext();
            }
          }}
          placeholder="Tìm..."
          className="h-8"
        />
        <Input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              replaceOne();
            }
          }}
          placeholder="Thay bằng..."
          className="h-8"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={caseSensitive} onCheckedChange={(v) => setCaseSensitive(v === true)} /> Phân biệt hoa thường
          </label>
          <span>{query ? `${matches.length} kết quả` : ''}</span>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button type="button" size="sm" variant="outline" disabled={!matches.length} onClick={findNext}>
            Tìm tiếp
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!matches.length} onClick={replaceOne}>
            Thay thế
          </Button>
          <Button type="button" size="sm" disabled={!matches.length} onClick={replaceAll}>
            Thay tất cả
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
