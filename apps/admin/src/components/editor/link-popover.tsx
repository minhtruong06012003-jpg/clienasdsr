'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { ExternalLink, Link2Off, Pencil } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

function buildRel(newTab: boolean, nofollow: boolean) {
  const parts = [];
  if (newTab) parts.push('noopener', 'noreferrer');
  if (nofollow) parts.push('nofollow');
  return parts.length ? parts.join(' ') : null;
}

/** Popover đặt/sửa liên kết (URL, mở tab mới, nofollow, gỡ link). children là nút kích hoạt trên toolbar. */
export function LinkPopover({ editor, open, onOpenChange, children }: { editor: Editor; open: boolean; onOpenChange: (o: boolean) => void; children: ReactNode }) {
  const [url, setUrl] = useState('');
  const [newTab, setNewTab] = useState(false);
  const [nofollow, setNofollow] = useState(false);
  const [hasLink, setHasLink] = useState(false);

  useEffect(() => {
    if (!open) return;
    const attrs = editor.getAttributes('link') as { href?: string; target?: string | null; rel?: string | null };
    const active = editor.isActive('link');
    setHasLink(active);
    setUrl(attrs.href ?? '');
    setNewTab(active ? attrs.target === '_blank' : false);
    setNofollow(active ? !!attrs.rel?.includes('nofollow') : false);
  }, [open, editor]);

  const apply = () => {
    const href = url.trim();
    if (!href) return remove();
    const attrs = { href, target: newTab ? '_blank' : null, rel: buildRel(newTab, nofollow) };
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive('link')) {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink(attrs).run();
    }
    onOpenChange(false);
  };
  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3" onCloseAutoFocus={(e) => e.preventDefault()}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rte-link-url">Liên kết</Label>
            <Input id="rte-link-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://... hoặc /trang-noi-bo" className="h-8" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={newTab} onCheckedChange={(v) => setNewTab(v === true)} /> Mở trong tab mới
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={nofollow} onCheckedChange={(v) => setNofollow(v === true)} /> Thêm rel=&quot;nofollow&quot;
          </label>
          <div className="flex justify-end gap-2">
            {hasLink && (
              <Button type="button" size="sm" variant="ghost" className="mr-auto text-destructive" onClick={remove}>
                <Link2Off /> Gỡ liên kết
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button type="submit" size="sm">
              Áp dụng
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Bubble hiện khi con trỏ đứng trong liên kết: xem URL, mở, sửa, gỡ */
export function LinkBubble({ editor, onEdit }: { editor: Editor; onEdit: () => void }) {
  const href = useEditorState({ editor, selector: ({ editor: e }) => (e.isActive('link') ? ((e.getAttributes('link').href as string | undefined) ?? '') : '') });
  return (
    <BubbleMenu editor={editor} pluginKey="rte-link-bubble" shouldShow={({ editor: e }) => e.isActive('link')} options={{ placement: 'bottom', offset: 6 }} className="z-[60] flex max-w-sm items-center gap-1 rounded-lg border bg-popover p-1 text-xs text-popover-foreground shadow-md">
      <a href={href} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1 px-1.5 text-primary hover:underline" title={href}>
        <ExternalLink className="size-3.5 shrink-0" />
        <span className="truncate">{href}</span>
      </a>
      <Button type="button" size="icon-xs" variant="ghost" title="Sửa liên kết" onClick={onEdit}>
        <Pencil />
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" title="Gỡ liên kết" onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>
        <Link2Off />
      </Button>
    </BubbleMenu>
  );
}
