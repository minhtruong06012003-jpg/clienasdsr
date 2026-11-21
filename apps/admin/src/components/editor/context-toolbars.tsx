'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight, Ban, ChevronDown, Columns3, ImagePlus, Rows3, Settings2, SquareCode, Table, TableCellsMerge, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Btn } from './toolbar-button';
import { CODE_LANGUAGES } from './extensions';
import { normalizeWidth, type ImageAlign, type ImageFigureAttrs } from './extensions/image-figure';

const WIDTHS = ['25%', '50%', '75%', '100%'];

function MenuBtn({ icon: Icon, label, children }: { icon: typeof Rows3; label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
          <Icon className="size-3.5" /> {label} <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableBar({ editor, canMerge, canSplit }: { editor: Editor; canMerge: boolean; canSplit: boolean }) {
  const c = () => editor.chain().focus();
  return (
    <>
      <span className="flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
        <Table className="size-3.5" /> Bảng
      </span>
      <MenuBtn icon={Rows3} label="Hàng">
        <DropdownMenuItem onSelect={() => c().addRowBefore().run()}>Thêm hàng phía trên</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c().addRowAfter().run()}>Thêm hàng phía dưới</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => c().deleteRow().run()}>
          Xoá hàng
        </DropdownMenuItem>
      </MenuBtn>
      <MenuBtn icon={Columns3} label="Cột">
        <DropdownMenuItem onSelect={() => c().addColumnBefore().run()}>Thêm cột bên trái</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c().addColumnAfter().run()}>Thêm cột bên phải</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => c().deleteColumn().run()}>
          Xoá cột
        </DropdownMenuItem>
      </MenuBtn>
      <MenuBtn icon={TableCellsMerge} label="Ô">
        <DropdownMenuItem disabled={!canMerge} onSelect={() => c().mergeCells().run()}>
          Gộp các ô đã chọn
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canSplit} onSelect={() => c().splitCell().run()}>
          Tách ô
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => c().toggleHeaderRow().run()}>Bật/tắt hàng tiêu đề</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c().toggleHeaderColumn().run()}>Bật/tắt cột tiêu đề</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c().toggleHeaderCell().run()}>Bật/tắt ô tiêu đề</DropdownMenuItem>
      </MenuBtn>
      <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive" onClick={() => c().deleteTable().run()}>
        <Trash2 className="size-3.5" /> Xoá bảng
      </Button>
    </>
  );
}

function ImageProps({ editor, attrs }: { editor: Editor; attrs: ImageFigureAttrs }) {
  const [open, setOpen] = useState(false);
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [href, setHref] = useState('');
  const [widthPx, setWidthPx] = useState('');
  useEffect(() => {
    if (!open) return;
    setAlt(attrs.alt ?? '');
    setCaption(attrs.caption ?? '');
    setHref(attrs.href ?? '');
    setWidthPx(attrs.width?.endsWith('px') ? attrs.width.slice(0, -2) : '');
  }, [open, attrs]);
  const apply = () => {
    const width = widthPx.trim() ? normalizeWidth(widthPx) : attrs.width?.endsWith('px') ? null : attrs.width;
    editor
      .chain()
      .focus()
      .updateAttributes('image', { alt: alt.trim() || null, caption: caption.trim() || null, href: href.trim() || null, width })
      .run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
          <Settings2 className="size-3.5" /> Thuộc tính
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3" onCloseAutoFocus={(e) => e.preventDefault()}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rte-img-alt">Văn bản thay thế (alt)</Label>
            <Input id="rte-img-alt" value={alt} onChange={(e) => setAlt(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rte-img-cap">Chú thích</Label>
            <Input id="rte-img-cap" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Hiện dưới ảnh" className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rte-img-href">Liên kết khi bấm ảnh</Label>
            <Input id="rte-img-href" value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://..." className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rte-img-w">Độ rộng (px, để trống dùng %)</Label>
            <Input id="rte-img-w" type="number" min={40} value={widthPx} onChange={(e) => setWidthPx(e.target.value)} className="h-8" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
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

function ImageBar({ editor, attrs, onReplace }: { editor: Editor; attrs: ImageFigureAttrs; onReplace: () => void }) {
  const set = (patch: Partial<ImageFigureAttrs>) => editor.chain().focus().updateAttributes('image', patch).run();
  const alignBtn = (value: ImageAlign, icon: typeof AlignLeft, label: string) => <Btn key={label} icon={icon} label={label} active={attrs.align === value} onClick={() => set({ align: value })} />;
  return (
    <>
      <span className="flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
        <ImagePlus className="size-3.5" /> Ảnh
      </span>
      {alignBtn('left', AlignLeft, 'Căn trái (chữ bao quanh)')}
      {alignBtn('center', AlignCenter, 'Căn giữa')}
      {alignBtn('right', AlignRight, 'Căn phải (chữ bao quanh)')}
      {alignBtn(null, Ban, 'Không căn')}
      <span className="mx-1 h-5 w-px bg-border" />
      {WIDTHS.map((w) => (
        <Toggle key={w} size="sm" pressed={attrs.width === w} onPressedChange={() => set({ width: attrs.width === w ? null : w })} className="h-7 px-1.5 text-xs" title={`Độ rộng ${w}`}>
          {w}
        </Toggle>
      ))}
      {attrs.width?.endsWith('px') && <span className="px-1 text-xs text-muted-foreground">{attrs.width}</span>}
      <span className="mx-1 h-5 w-px bg-border" />
      <ImageProps editor={editor} attrs={attrs} />
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={onReplace}>
        <ImagePlus className="size-3.5" /> Thay ảnh
      </Button>
      <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive" onClick={() => editor.chain().focus().deleteSelection().run()}>
        <Trash2 className="size-3.5" /> Xoá ảnh
      </Button>
    </>
  );
}

function CodeBar({ editor, language }: { editor: Editor; language: string }) {
  return (
    <>
      <span className="flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
        <SquareCode className="size-3.5" /> Khối mã
      </span>
      <Select value={language} onValueChange={(v) => editor.chain().focus().updateAttributes('codeBlock', { language: v === 'plaintext' ? null : v }).run()}>
        <SelectTrigger size="sm" className="h-7 w-44 text-xs">
          <SelectValue placeholder="Ngôn ngữ" />
        </SelectTrigger>
        <SelectContent>
          {CODE_LANGUAGES.map((l) => (
            <SelectItem key={l.value} value={l.value}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        Thoát khối mã
      </Button>
    </>
  );
}

const pickImage = (a: Record<string, unknown>): ImageFigureAttrs => ({
  src: (a.src as string) ?? null,
  alt: (a.alt as string) ?? null,
  title: (a.title as string) ?? null,
  width: (a.width as string) ?? null,
  align: (a.align as ImageAlign) ?? null,
  caption: (a.caption as string) ?? null,
  href: (a.href as string) ?? null,
});

/** Thanh công cụ ngữ cảnh: hiện khi con trỏ trong bảng / khối mã hoặc đang chọn ảnh */
export function ContextBar({ editor, onReplaceImage }: { editor: Editor; onReplaceImage: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const image = e.isActive('image');
      const code = e.isActive('codeBlock');
      return {
        table: e.isActive('table'),
        canMerge: e.can().mergeCells(),
        canSplit: e.can().splitCell(),
        code,
        language: code ? ((e.getAttributes('codeBlock').language as string | null) ?? 'plaintext') : 'plaintext',
        image: image ? pickImage(e.getAttributes('image')) : null,
      };
    },
  });
  if (!s.image && !s.table && !s.code) return null;
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1 py-0.5">
      {s.image ? <ImageBar editor={editor} attrs={s.image} onReplace={onReplaceImage} /> : s.code ? <CodeBar editor={editor} language={s.language} /> : <TableBar editor={editor} canMerge={s.canMerge} canSplit={s.canSplit} />}
    </div>
  );
}
