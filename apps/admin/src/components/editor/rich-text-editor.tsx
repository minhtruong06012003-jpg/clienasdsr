'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MediaPickerDialog } from '@/components/media/media-picker';
import { buildExtensions, cleanPastedHtml } from './extensions';
import { Toolbar } from './toolbar';
import { ContextBar } from './context-toolbars';
import { LinkBubble } from './link-popover';
import { EmbedDialog } from './embed-dialog';
import { EditorFooter } from './editor-footer';
import { mediaToImageAttrs, useEditorUpload } from './upload';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
  /** Thanh công cụ gọn cho panel nhỏ (page builder) */
  compact?: boolean;
}

/**
 * Trình soạn thảo rich text (TipTap) xuất HTML, mức WordPress classic:
 * màu chữ/nền, bảng có toolbar ngữ cảnh, ảnh từ thư viện Media (căn lề, độ rộng, chú thích, link, kéo thả/dán tự upload),
 * nhúng video/iframe, khối mã chọn ngôn ngữ, popover liên kết, tìm & thay thế, toàn màn hình, đếm từ, chế độ HTML.
 */
export function RichTextEditor({ value, onChange, placeholder = 'Bắt đầu viết nội dung...', minHeight = 260, className, compact }: RichTextEditorProps) {
  const [source, setSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [pickImage, setPickImage] = useState<'insert' | 'replace' | null>(null);
  const { handlePaste, handleDrop, uploading } = useEditorUpload();

  // onChange qua ref để không cần tạo lại editor khi callback đổi
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const extensions = useMemo(() => buildExtensions({ placeholder, compact }), [placeholder, compact]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      content: value,
      editorProps: {
        attributes: { class: 'prose prose-slate max-w-none px-4 py-3 dark:prose-invert prose-img:rounded-lg' },
        transformPastedHTML: cleanPastedHtml,
        handlePaste,
        handleDrop,
      },
      onUpdate: ({ editor: e }) => onChangeRef.current(e.isEmpty ? '' : e.getHTML()),
    },
    [extensions],
  );

  // cập nhật khi value đổi từ bên ngoài (đổi ngôn ngữ, khôi phục...)
  useEffect(() => {
    if (editor && !editor.isFocused && value !== editor.getHTML()) editor.commands.setContent(value || '', { emitUpdate: false });
  }, [value, editor]);

  // Phím tắt: Ctrl/Cmd+K mở popover liên kết, Esc thoát toàn màn hình
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setLinkOpen(true);
      }
    };
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  }, [editor]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-slot="popover-content"], [data-slot="dialog-content"], [data-slot="dropdown-menu-content"]')) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [fullscreen]);

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border bg-background focus-within:ring-3 focus-within:ring-ring/50', fullscreen && 'fixed inset-0 z-50 rounded-none border-0 focus-within:ring-0', className)}>
      {editor && (
        <Toolbar
          editor={editor}
          compact={compact}
          source={source}
          setSource={setSource}
          fullscreen={fullscreen}
          setFullscreen={setFullscreen}
          linkOpen={linkOpen}
          setLinkOpen={setLinkOpen}
          findOpen={findOpen}
          setFindOpen={setFindOpen}
          onPickImage={() => setPickImage('insert')}
          onEmbed={() => setEmbedOpen(true)}
        />
      )}
      {editor && !source && <ContextBar editor={editor} onReplaceImage={() => setPickImage('replace')} />}
      {source ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} className={cn('rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0', fullscreen && 'flex-1')} style={fullscreen ? undefined : { minHeight }} />
      ) : (
        <div style={fullscreen ? undefined : { minHeight }} className={cn('overflow-y-auto', fullscreen ? 'flex-1' : 'max-h-[70vh]')}>
          <div className={cn(fullscreen && 'mx-auto w-full max-w-4xl')}>
            <EditorContent editor={editor} />
          </div>
        </div>
      )}
      {editor && !compact && !source && <EditorFooter editor={editor} uploading={uploading} />}
      {editor && !source && <LinkBubble editor={editor} onEdit={() => setLinkOpen(true)} />}
      {editor && <EmbedDialog editor={editor} open={embedOpen} onOpenChange={setEmbedOpen} />}
      <MediaPickerDialog
        open={!!pickImage}
        onOpenChange={(o) => !o && setPickImage(null)}
        multiple={pickImage !== 'replace'}
        onSelect={(items) => {
          if (!editor) return;
          if (pickImage === 'replace' && items[0]) {
            const m = items[0];
            editor.chain().focus().updateAttributes('image', { src: m.urls?.large ?? m.url, alt: m.alt?.vi || m.originalName || null }).run();
            return;
          }
          editor
            .chain()
            .focus()
            .insertContent(items.map((m) => ({ type: 'image', attrs: mediaToImageAttrs(m) })))
            .run();
        }}
      />
    </div>
  );
}
