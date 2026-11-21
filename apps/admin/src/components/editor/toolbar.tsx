'use client';

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Code,
  Code2,
  Eraser,
  Film,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Maximize,
  Minimize,
  Minus,
  Plus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Btn } from './toolbar-button';
import { ColorPicker } from './color-picker';
import { LinkPopover } from './link-popover';
import { TablePicker } from './table-picker';
import { FindReplace } from './find-replace';

export interface ToolbarProps {
  editor: Editor;
  compact?: boolean;
  source: boolean;
  setSource: (v: boolean) => void;
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  linkOpen: boolean;
  setLinkOpen: (v: boolean) => void;
  findOpen: boolean;
  setFindOpen: (v: boolean) => void;
  onPickImage: () => void;
  onEmbed: () => void;
}

const HEADINGS = [
  { level: 0, label: 'Đoạn văn' },
  { level: 1, label: 'Tiêu đề 1' },
  { level: 2, label: 'Tiêu đề 2' },
  { level: 3, label: 'Tiêu đề 3' },
  { level: 4, label: 'Tiêu đề 4' },
] as const;

const Sep = () => <Separator orientation="vertical" className="mx-1 h-5" />;

/** Thanh công cụ chính của trình soạn thảo */
export function Toolbar({ editor, compact, source, setSource, fullscreen, setFullscreen, linkOpen, setLinkOpen, findOpen, setFindOpen, onPickImage, onEmbed }: ToolbarProps) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      heading: ([1, 2, 3, 4] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      align: (['left', 'center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? null,
      highlight: e.isActive('highlight') ? ((e.getAttributes('highlight').color as string | undefined) ?? '#ffff00') : null,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  const headings = compact ? HEADINGS.filter((h) => h.level !== 1 && h.level !== 4) : HEADINGS;
  const current = HEADINGS.find((h) => h.level === s.heading) ?? HEADINGS[0];

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b bg-background/95 p-1 backdrop-blur">
      {!compact && (
        <>
          <Btn icon={Undo2} label="Hoàn tác (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()} />
          <Btn icon={Redo2} label="Làm lại (Ctrl+Y)" disabled={!s.canRedo} onClick={() => c().redo().run()} />
          <Sep />
        </>
      )}

      {/* Kiểu đoạn / tiêu đề */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-28 justify-between px-2 text-xs font-medium" title="Kiểu đoạn văn">
            <span className="truncate">{current.label}</span>
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
          {headings.map((h) => (
            <DropdownMenuItem key={h.level} onSelect={() => (h.level === 0 ? c().setParagraph().run() : c().toggleHeading({ level: h.level }).run())} className={h.level === s.heading ? 'bg-muted' : undefined}>
              {h.level === 0 ? <span>Đoạn văn</span> : <span className="font-semibold" style={{ fontSize: `${1.25 - h.level * 0.08}rem` }}>{h.label}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Sep />

      <Btn icon={Bold} label="Đậm (Ctrl+B)" active={s.bold} onClick={() => c().toggleBold().run()} />
      <Btn icon={Italic} label="Nghiêng (Ctrl+I)" active={s.italic} onClick={() => c().toggleItalic().run()} />
      <Btn icon={Underline} label="Gạch chân (Ctrl+U)" active={s.underline} onClick={() => c().toggleUnderline().run()} />
      {!compact && <Btn icon={Strikethrough} label="Gạch ngang" active={s.strike} onClick={() => c().toggleStrike().run()} />}
      <ColorPicker icon={Baseline} label="Màu chữ" value={s.color} onPick={(col) => (col ? c().setColor(col).run() : c().unsetColor().run())} />
      <ColorPicker icon={Highlighter} label="Màu nền chữ" highlight value={s.highlight} onPick={(col) => (col ? c().setHighlight({ color: col }).run() : c().unsetHighlight().run())} />
      {!compact && <Btn icon={Eraser} label="Xoá định dạng" onClick={() => c().unsetAllMarks().clearNodes().run()} />}
      <Sep />

      <Btn icon={List} label="Danh sách" active={s.bullet} onClick={() => c().toggleBulletList().run()} />
      <Btn icon={ListOrdered} label="Danh sách số" active={s.ordered} onClick={() => c().toggleOrderedList().run()} />
      <Btn icon={Quote} label="Trích dẫn" active={s.quote} onClick={() => c().toggleBlockquote().run()} />
      {!compact && (
        <>
          <Sep />
          <Btn icon={AlignLeft} label="Căn trái" active={s.align === 'left'} onClick={() => c().setTextAlign('left').run()} />
          <Btn icon={AlignCenter} label="Căn giữa" active={s.align === 'center'} onClick={() => c().setTextAlign('center').run()} />
          <Btn icon={AlignRight} label="Căn phải" active={s.align === 'right'} onClick={() => c().setTextAlign('right').run()} />
          <Btn icon={AlignJustify} label="Căn đều" active={s.align === 'justify'} onClick={() => c().setTextAlign('justify').run()} />
        </>
      )}
      <Sep />

      <LinkPopover editor={editor} open={linkOpen} onOpenChange={setLinkOpen}>
        <Btn icon={Link2} label="Chèn / sửa liên kết (Ctrl+K)" active={s.link || linkOpen} />
      </LinkPopover>
      <Btn icon={ImagePlus} label="Chèn ảnh từ thư viện" onClick={onPickImage} />
      {!compact && (
        <>
          <TablePicker editor={editor} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-0.5 px-1.5 text-xs" title="Chèn thêm">
                <Plus className="size-4" />
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={onEmbed}>
                <Film /> Video / nhúng iframe
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c().toggleCodeBlock().run()}>
                <SquareCode /> Khối mã {s.codeBlock && '(đang bật)'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c().toggleCode().run()}>
                <Code /> Mã trong dòng
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => c().setHorizontalRule().run()}>
                <Minus /> Đường kẻ ngang
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      {compact && <Btn icon={Code} label="Mã trong dòng" active={s.code} onClick={() => c().toggleCode().run()} />}

      <div className="ml-auto flex items-center gap-0.5">
        {!compact && <FindReplace editor={editor} open={findOpen} onOpenChange={setFindOpen} />}
        <Btn icon={fullscreen ? Minimize : Maximize} label={fullscreen ? 'Thoát toàn màn hình (Esc)' : 'Toàn màn hình'} active={fullscreen} onClick={() => setFullscreen(!fullscreen)} />
        <Btn icon={Code2} label="Xem mã HTML" active={source} onClick={() => setSource(!source)} />
      </div>
    </div>
  );
}
