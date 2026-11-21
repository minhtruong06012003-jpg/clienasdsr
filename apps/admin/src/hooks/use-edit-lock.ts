'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EDIT_LOCK_HEARTBEAT_SECONDS, type EditLockEntity, type EditLockState } from '@cmsnt/shared';
import { api, errorMessage } from '@/lib/api';
import { toast } from 'sonner';

/** Trạng thái khoá chỉnh sửa của một trình soạn */
export interface EditLock {
  /** đã nhận phản hồi đầu tiên từ máy chủ */
  ready: boolean;
  /** người khác đang giữ khoá → trình soạn nên ở chế độ chỉ đọc */
  readOnly: boolean;
  /** người đang giữ khoá (khi readOnly) */
  holder: { userId: string; userName: string } | null;
  /** mình từng giữ khoá rồi bị người khác giành mất */
  takenOver: boolean;
  /** đang chỉ đọc rồi người kia rời đi → mình đã giữ được khoá, nên tải lại để lấy nội dung mới */
  freed: boolean;
  /** giành quyền sửa */
  takeover: () => Promise<void>;
  taking: boolean;
  /** gọi đầu mutationFn lưu: đang chỉ đọc thì ném lỗi để không ghi đè bản của người đang sửa */
  assertWritable: () => void;
}

const base = (entity: string, id: string) => `/admin/edit-locks/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`;

/**
 * Giữ khoá chỉnh sửa đồng thời cho bản ghi đang mở (giống post lock của WordPress):
 * - giữ/gia hạn ngay khi mở và heartbeat mỗi 30 giây (khoá hết hạn sau 60 giây nếu mất kết nối);
 * - người khác đang sửa → `readOnly` + `holder` để hiện banner "X đang sửa";
 * - rời trang trong SPA → DELETE; đóng tab → navigator.sendBeacon với releaseToken.
 * `id` null/'new' = bản ghi mới, không khoá.
 */
export function useEditLock(entity: EditLockEntity | (string & {}), id: string | null | undefined): EditLock {
  const enabled = !!id && id !== 'new';
  const [state, setState] = useState<{ ready: boolean; holder: EditLock['holder']; takenOver: boolean; freed: boolean }>({ ready: !enabled, holder: null, takenOver: false, freed: false });
  const [taking, setTaking] = useState(false);
  // đang giữ khoá hay không + token nhả khoá cho beacon (ref để dùng trong cleanup)
  const holding = useRef(false);
  const releaseToken = useRef<string | null>(null);

  /** Xử lý kết quả giữ/gia hạn khoá */
  const apply = useCallback((r: EditLockState) => {
    if (r.locked) {
      const wasHolding = holding.current;
      holding.current = false;
      releaseToken.current = null;
      setState((s) => ({ ready: true, holder: r.by, takenOver: s.takenOver || wasHolding, freed: false }));
    } else {
      const wasReadOnly = !holding.current;
      holding.current = true;
      releaseToken.current = r.releaseToken ?? null;
      setState((s) => ({ ready: true, holder: null, takenOver: false, freed: s.freed || (wasReadOnly && !!s.holder) }));
    }
  }, []);

  const heartbeat = useCallback(async () => {
    if (!enabled || !id) return;
    try {
      apply(await api.post<EditLockState>(base(entity, id)));
    } catch {
      // lỗi mạng tạm thời: bỏ qua, lần heartbeat sau thử lại
    }
  }, [apply, enabled, entity, id]);

  useEffect(() => {
    if (!enabled || !id) return;
    holding.current = false;
    setState({ ready: false, holder: null, takenOver: false, freed: false });
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), EDIT_LOCK_HEARTBEAT_SECONDS * 1000);
    // tab quay lại sau khi bị trình duyệt hạn chế timer → gia hạn ngay
    const onVisible = () => {
      if (document.visibilityState === 'visible') void heartbeat();
    };
    // đóng tab/rời trang thật: beacon không gửi được header nên dùng releaseToken
    const onPageHide = () => {
      if (!holding.current || !releaseToken.current) return;
      const body = new Blob([JSON.stringify({ token: releaseToken.current })], { type: 'application/json' });
      navigator.sendBeacon?.(`/api${base(entity, id)}/release`, body);
      holding.current = false;
    };
    // bfcache khôi phục trang → giữ lại khoá
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void heartbeat();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      // rời trình soạn trong SPA → nhả khoá
      if (holding.current) {
        holding.current = false;
        api.delete(base(entity, id)).catch(() => undefined);
      }
    };
  }, [enabled, entity, id, heartbeat]);

  const takeover = useCallback(async () => {
    if (!enabled || !id) return;
    setTaking(true);
    try {
      const r = await api.post<EditLockState>(`${base(entity, id)}/takeover`);
      apply(r);
      // giành quyền khi đang xem chỉ đọc: không coi là "người kia rời đi"
      setState((s) => ({ ...s, freed: false }));
      toast.success('Bạn đã giành quyền chỉnh sửa');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTaking(false);
    }
  }, [apply, enabled, entity, id]);

  const assertWritable = useCallback(() => {
    if (state.holder) throw new Error(`${state.holder.userName} đang chỉnh sửa — bạn đang ở chế độ chỉ đọc, không thể lưu`);
  }, [state.holder]);

  return { ...state, readOnly: !!state.holder, takeover, taking, assertWritable };
}
