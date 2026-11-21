'use client';

import { useEffect, useRef } from 'react';
import type { EditorView } from '@tiptap/pm/view';
import { Fragment } from '@tiptap/pm/model';
import { useMediaUpload, isImage } from '@/components/media/use-upload';
import type { Media } from '@/lib/types';

/** Thuộc tính node ảnh từ Media trong thư viện */
export function mediaToImageAttrs(m: Media, locale = 'vi') {
  return { src: m.urls?.large ?? m.url, alt: m.alt?.[locale] || m.originalName || null, caption: m.caption?.[locale] || null };
}

function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (f && f.type.startsWith('image/')) out.push(f);
  }
  return out;
}

/** Kéo thả / dán ảnh vào trình soạn thảo -> tự upload lên thư viện Media rồi chèn */
export function useEditorUpload() {
  const { upload, uploading } = useMediaUpload();
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  }, [upload]);

  const insertAt = (view: EditorView, pos: number, items: Media[]) => {
    const type = view.state.schema.nodes.image;
    if (!type) return;
    const nodes = items.filter(isImage).map((m) => type.create(mediaToImageAttrs(m)));
    if (!nodes.length) return;
    const p = Math.min(pos, view.state.doc.content.size);
    view.dispatch(view.state.tr.insert(p, Fragment.from(nodes)).scrollIntoView());
  };

  const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
    const files = imageFiles(event.clipboardData?.files?.length ? event.clipboardData.files : event.clipboardData?.items);
    if (!files.length) return false;
    // dán từ Word/Docs thường kèm cả HTML lẫn ảnh chụp nội dung -> ưu tiên HTML
    if (event.clipboardData?.getData('text/html')?.trim()) return false;
    event.preventDefault();
    const pos = view.state.selection.to;
    void uploadRef.current(files).then((items) => insertAt(view, pos, items));
    return true;
  };

  const handleDrop = (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean): boolean => {
    if (moved) return false;
    const files = imageFiles(event.dataTransfer?.files);
    if (!files.length) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.to;
    void uploadRef.current(files).then((items) => insertAt(view, pos, items));
    return true;
  };

  return { handlePaste, handleDrop, uploading };
}
