'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Eye, Loader2, Lock, RefreshCw, UserRoundPen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/components/common/confirm-dialog';
import type { EditLock } from '@/hooks/use-edit-lock';

/**
 * Banner khoá chỉnh sửa đồng thời, đặt ở đầu PageBody của trình soạn:
 * - người khác đang sửa → hộp thoại "X đang sửa — Xem chỉ đọc / Giành quyền sửa", sau đó banner chỉ đọc cố định;
 * - bị người khác giành quyền → hộp thoại báo, chuyển sang chỉ đọc;
 * - người kia đã rời đi → gợi ý tải lại để lấy nội dung mới nhất.
 * `variant="inline"`: dạng gọn để đặt trong thanh header của Page Builder (trang, theme template, global block).
 */
export function EditLockBanner({ lock, variant = 'block' }: { lock: EditLock; variant?: 'block' | 'inline' }) {
  const router = useRouter();
  const confirm = useConfirm();
  // đã chọn "Xem chỉ đọc" (đóng hộp thoại) cho người giữ khoá hiện tại
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const holderKey = lock.holder ? `${lock.holder.userId}:${lock.takenOver ? 't' : 'l'}` : null;

  // người giữ khoá đổi (vd bị giành quyền) → hiện lại hộp thoại
  useEffect(() => {
    if (!holderKey) setDismissedFor(null);
  }, [holderKey]);

  if (!lock.ready) return null;

  const name = lock.holder?.userName || 'Người khác';
  const dialogOpen = !!holderKey && dismissedFor !== holderKey;

  const takeover = async () => {
    const ok = await confirm({
      title: 'Giành quyền chỉnh sửa?',
      description: `${name} sẽ bị chuyển sang chế độ chỉ đọc và thay đổi chưa lưu của họ có thể bị mất.`,
      confirmText: 'Giành quyền sửa',
      destructive: true,
    });
    if (ok) await lock.takeover();
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={(o) => !o && holderKey && setDismissedFor(holderKey)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="size-5 text-amber-600 dark:text-amber-400" />
              {lock.takenOver ? `${name} đã giành quyền chỉnh sửa` : `${name} đang chỉnh sửa nội dung này`}
            </DialogTitle>
            <DialogDescription>
              {lock.takenOver
                ? 'Bạn đã chuyển sang chế độ chỉ đọc. Thay đổi chưa lưu của bạn sẽ không được lưu — hãy sao chép lại nếu cần.'
                : 'Để tránh ghi đè lên nhau, bạn có thể xem ở chế độ chỉ đọc hoặc giành quyền chỉnh sửa.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => router.back()}>
              <ArrowLeft /> Quay lại
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => holderKey && setDismissedFor(holderKey)}>
                <Eye /> Xem chỉ đọc
              </Button>
              <Button onClick={() => void lock.takeover()} disabled={lock.taking}>
                {lock.taking ? <Loader2 className="animate-spin" /> : <UserRoundPen />} Giành quyền sửa
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {variant === 'inline' && lock.readOnly && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-900/40"
          title={`${name} đang chỉnh sửa — chế độ chỉ đọc. Bấm để giành quyền sửa`}
          onClick={() => void takeover()}
          disabled={lock.taking}
        >
          {lock.taking ? <Loader2 className="animate-spin" /> : <Lock />}
          <span className="max-w-40 truncate">Chỉ đọc · {name}</span>
        </Button>
      )}

      {variant === 'inline' && !lock.readOnly && lock.freed && (
        <Button size="sm" variant="outline" className="shrink-0" title="Người sửa trước đã rời đi — tải lại để lấy nội dung mới nhất" onClick={() => window.location.reload()}>
          <RefreshCw /> Tải lại
        </Button>
      )}

      {variant === 'block' && lock.readOnly && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <Lock className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            <span className="font-medium">{name}</span> đang chỉnh sửa — bạn đang xem ở chế độ chỉ đọc, không thể lưu.
          </p>
          <Button size="sm" variant="outline" onClick={() => void takeover()} disabled={lock.taking}>
            {lock.taking ? <Loader2 className="animate-spin" /> : <UserRoundPen />} Giành quyền sửa
          </Button>
        </div>
      )}

      {variant === 'block' && !lock.readOnly && lock.freed && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300">
          <UserRoundPen className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">Người sửa trước đã rời trình soạn, bạn đã có quyền chỉnh sửa. Tải lại trang để lấy nội dung mới nhất trước khi sửa.</p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCw /> Tải lại
          </Button>
        </div>
      )}
    </>
  );
}
