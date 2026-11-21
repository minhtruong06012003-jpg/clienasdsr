'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useConfirm } from '@/components/common/confirm-dialog';

const LEAVE_MESSAGE = 'Bạn có thay đổi chưa lưu. Rời trang và bỏ các thay đổi này?';

/**
 * Bỏ focus khỏi phần tử đang sửa (vd: chữ đang gõ trên canvas Page Builder chỉ ghi vào store khi blur)
 * để thay đổi cuối cùng được ghi nhận trước khi lưu.
 */
export function flushActiveEdit() {
  if (typeof document === 'undefined') return;
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

/** Link nội bộ (cùng origin, mở trong tab hiện tại) có dẫn sang URL khác không */
function internalTarget(e: MouseEvent): HTMLAnchorElement | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  // link bên trong canvas Page Builder chỉ để xem trước, canvas tự chặn điều hướng
  if (a.closest('[data-builder-canvas]')) return null;
  if (a.target && a.target !== '_self') return null;
  if (a.hasAttribute('download')) return null;
  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  // chỉ đổi hash trên cùng trang -> không rời trang
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return a;
}

/**
 * Cảnh báo khi rời trang còn thay đổi chưa lưu (đóng tab/reload và bấm link nội bộ như sidebar, nút ←)
 * + phím tắt Ctrl/Cmd+S để lưu.
 */
export function useUnsavedGuard(dirty: boolean, onSave?: () => void) {
  const dirtyRef = useRef(dirty);
  const router = useRouter();
  const confirm = useConfirm();
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!onSave) return;
        flushActiveEdit();
        onSave();
      }
    };
    // capture: chạy trước handler của next/link để chặn điều hướng client-side,
    // hỏi bằng hộp thoại xác nhận rồi mới tự điều hướng nếu đồng ý
    const click = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const a = internalTarget(e);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const url = new URL(a.href, window.location.href);
      void confirm({ title: 'Rời trang?', description: LEAVE_MESSAGE, confirmText: 'Rời trang', cancelText: 'Ở lại', destructive: true }).then((ok) => {
        if (!ok) return;
        dirtyRef.current = false;
        router.push(url.pathname + url.search + url.hash);
      });
    };
    window.addEventListener('beforeunload', before);
    window.addEventListener('keydown', key);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', before);
      window.removeEventListener('keydown', key);
      document.removeEventListener('click', click, true);
    };
  }, [onSave, confirm, router]);
}
