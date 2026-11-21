'use client';

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Loader2 } from 'lucide-react';

/** Dòng cuối: đếm từ / ký tự, trạng thái tải ảnh */
export function EditorFooter({ editor, uploading }: { editor: Editor; uploading?: boolean }) {
  const s = useEditorState({ editor, selector: ({ editor: e }) => ({ words: e.storage.characterCount.words(), chars: e.storage.characterCount.characters() }) });
  return (
    <div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
      {uploading && (
        <span className="mr-auto flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" /> Đang tải ảnh lên...
        </span>
      )}
      <span>{s.words.toLocaleString('vi-VN')} từ</span>
      <span>{s.chars.toLocaleString('vi-VN')} ký tự</span>
    </div>
  );
}
