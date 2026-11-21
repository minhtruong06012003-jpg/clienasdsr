'use client';

import { createContext, useContext, useEffect, useRef, type ElementType } from 'react';

/** Cầu nối giữa canvas và Page Builder: block gọi onChange khi sửa trực tiếp trên giao diện */
export interface EditorBridge {
  onChange: (blockId: string, path: string, value: unknown) => void;
  onSelect?: (blockId: string, path?: string) => void;
}

export const EditorBridgeContext = createContext<EditorBridge | null>(null);

export function useEditorBridge() {
  return useContext(EditorBridgeContext);
}

interface EditableProps {
  blockId: string;
  path: string;
  value: string | undefined;
  as?: ElementType;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
}

/** Text sửa trực tiếp trên canvas (contentEditable). Chỉ dùng ở chế độ edit. */
export function Editable({ blockId, path, value, as: Tag = 'span', className, multiline, placeholder = 'Nhập nội dung...' }: EditableProps) {
  const bridge = useEditorBridge();
  const ref = useRef<HTMLElement>(null);

  // đồng bộ khi giá trị đổi từ panel bên phải (không ghi đè khi đang gõ)
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerText !== (value ?? '')) el.innerText = value ?? '';
  }, [value]);

  return (
    <Tag
      ref={ref}
      className={`${className ?? ''} cms-editable`}
      contentEditable={bridge ? 'plaintext-only' : undefined}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      data-editable-path={path}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        bridge?.onSelect?.(blockId, path);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' && !multiline) {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
      }}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        const text = e.currentTarget.innerText.replace(/\n$/, '');
        if (text !== (value ?? '')) bridge?.onChange(blockId, path, text);
      }}
    >
      {value}
    </Tag>
  );
}
