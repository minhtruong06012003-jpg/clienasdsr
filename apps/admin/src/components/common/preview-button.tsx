'use client';

import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';

export type PreviewType = 'page' | 'post' | 'product' | 'entry';

/** Thông báo khi chưa cấu hình địa chỉ website/frontend để xem trước */
const NO_WEB_URL_MSG = 'Chưa cấu hình địa chỉ website (WEB_URL ở API / Cài đặt → Chung → Địa chỉ website) nên chưa thể xem trước.';

/**
 * Mở tab mới xem trước bản nháp (POST /admin/preview/token -> URL website/frontend riêng có token 30 phút).
 * Chưa cấu hình địa chỉ website (API báo lỗi hoặc trả URL tương đối) -> đóng tab vừa mở và báo toast, không mở tab hỏng.
 * `ensureId`: với bản ghi mới chưa lưu thì lưu nháp trước rồi trả về id (trả null nếu không lưu được).
 */
export function PreviewButton({ type, id, locale, ensureId, size = 'sm', variant = 'outline', label = 'Xem trước' }: { type: PreviewType; id: string | null; locale: string; ensureId?: () => Promise<string | null>; size?: 'sm' | 'default'; variant?: 'outline' | 'ghost'; label?: string }) {
  const [pending, setPending] = useState(false);

  const open = async () => {
    if (pending) return;
    setPending(true);
    // mở tab trước khi gọi API để không bị trình duyệt chặn popup
    const win = window.open('', '_blank');
    try {
      const targetId = id ?? (ensureId ? await ensureId() : null);
      if (!targetId) throw new Error('Hãy lưu nháp trước khi xem trước');
      const { url } = await api.post<{ url: string }>('/admin/preview/token', { type, id: targetId, locale });
      // URL không tuyệt đối = API chưa biết địa chỉ website -> mở ra sẽ là trang lỗi của admin
      if (!/^https?:\/\//i.test(url ?? '')) throw new Error(NO_WEB_URL_MSG);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (e) {
      win?.close();
      toast.error('Không mở được bản xem trước', { description: errorMessage(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button type="button" variant={variant} size={size} onClick={open} disabled={pending} title="Mở bản xem trước ở tab mới (kể cả khi chưa xuất bản)">
      {pending ? <Loader2 className="animate-spin" /> : <Eye />} {label}
    </Button>
  );
}
