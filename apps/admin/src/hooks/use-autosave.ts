'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'cmsnt-autosave';
/** Thời gian chờ sau lần gõ cuối trước khi tự lưu */
export const AUTOSAVE_DELAY = 30_000;

/**
 * Tự động lưu bản nháp: khi `active` (bản ghi đã có id, đang DRAFT) và `dirty`, chờ `delay` ms
 * kể từ lần thay đổi cuối (mỗi lần `signal` đổi thì đếm lại) rồi gọi `onSave`.
 * Công tắc bật/tắt ghi nhớ trong localStorage `cmsnt-autosave` (mặc định bật).
 */
export function useAutosave({ active, dirty, signal, onSave, delay = AUTOSAVE_DELAY }: { active: boolean; dirty: boolean; signal: unknown; onSave: () => void; delay?: number }) {
  const [enabled, setEnabledState] = useState(true);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '0') setEnabledState(false);
    } catch {
      /* private mode */
    }
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!enabled || !active || !dirty) return;
    const t = setTimeout(() => onSaveRef.current(), delay);
    return () => clearTimeout(t);
    // signal: đổi mỗi lần người dùng sửa -> đặt lại bộ đếm
  }, [enabled, active, dirty, signal, delay]);

  const markSaved = useCallback(() => setLastSavedAt(new Date()), []);

  return { enabled, setEnabled, lastSavedAt, markSaved };
}
