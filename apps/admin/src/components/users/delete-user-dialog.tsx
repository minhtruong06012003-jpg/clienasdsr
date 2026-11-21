'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Lock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

interface PreviewItem {
  key: string;
  label: string;
  count: number;
  total?: number;
  detail?: { posts: number; pages: number; entries: number };
  keepNote?: string;
  deleteNote?: string;
}

interface DeletePreview {
  user: { id: string; name: string; email: string; walletBalance: number };
  /** luôn bị xoá theo tài khoản */
  required: PreviewItem[];
  /** admin tích chọn để xoá kèm, bỏ tích = giữ lại */
  optional: PreviewItem[];
  defaults: string[];
}

/**
 * Hộp thoại xoá VĨNH VIỄN thành viên: liệt kê dữ liệu liên quan kèm số lượng, dữ liệu bắt buộc xoá theo tài khoản
 * và các nhóm tuỳ chọn (checkbox). Phải nhập lại email để xác nhận. Gợi ý khoá tạm thời nếu chỉ muốn chặn đăng nhập.
 */
export function DeleteUserDialog({ userId, onClose, onDone, onLockInstead }: { userId: string; onClose: () => void; onDone: () => void; onLockInstead?: () => void }) {
  const preview = useQuery({ queryKey: ['user-delete-preview', userId], queryFn: () => api.get<DeletePreview>(`/admin/users/${userId}/delete-preview`), gcTime: 0 });
  const [include, setInclude] = useState<Set<string> | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');

  // tích sẵn các nhóm mặc định (dữ liệu cá nhân) khi tải xong thống kê
  useEffect(() => {
    if (preview.data && !include) setInclude(new Set(preview.data.defaults));
  }, [preview.data, include]);

  const data = preview.data;
  const selected = include ?? new Set<string>();
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setInclude(next);
  };
  const emailOk = !!data && confirmEmail.trim().toLowerCase() === data.user.email.toLowerCase();

  const remove = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/delete`, { include: [...selected], confirmEmail: confirmEmail.trim() }),
    onSuccess: () => {
      toast.success(`Đã xoá vĩnh viễn ${data?.user.name ?? 'thành viên'}`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const requiredTotal = data?.required.reduce((s, r) => s + r.count, 0) ?? 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !remove.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Xoá vĩnh viễn thành viên{data ? ` ${data.user.name}` : ''}?</DialogTitle>
          <DialogDescription>Tài khoản bị xoá hẳn khỏi hệ thống, không thể khôi phục. Email sẽ được giải phóng để đăng ký lại. Chọn dữ liệu liên quan muốn xoá kèm bên dưới.</DialogDescription>
        </DialogHeader>

        {preview.isLoading || !data ? (
          preview.isError ? (
            <p className="text-sm text-destructive">{errorMessage(preview.error)}</p>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-48 rounded-lg" />
            </div>
          )
        ) : (
          <div className="space-y-4">
            {onLockInstead && (
              <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <Lock className="size-4 shrink-0" />
                <span className="flex-1">Chỉ muốn chặn đăng nhập một thời gian? Khoá tạm thời sẽ giữ nguyên mọi dữ liệu.</span>
                <Button size="xs" variant="outline" className="shrink-0" onClick={onLockInstead}>
                  Khoá tạm thời
                </Button>
              </div>
            )}

            {data.user.walletBalance > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Ví còn <b className="tabular-nums">{formatMoney(data.user.walletBalance)}</b> — số dư này sẽ mất cùng tài khoản. Hãy hoàn tiền cho thành viên trước nếu cần.
                </span>
              </div>
            )}

            {/* dữ liệu luôn bị xoá cùng tài khoản */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm font-medium">
                Luôn xoá cùng tài khoản
                <span className="text-xs font-normal text-muted-foreground">{requiredTotal} bản ghi</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                {data.required.map((r) => (
                  <div key={r.key} className={cn('flex items-center justify-between gap-2', r.count === 0 && 'text-muted-foreground')}>
                    <span className="truncate">{r.label}</span>
                    <span className="tabular-nums">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* nhóm tuỳ chọn: tích = xoá kèm, bỏ tích = giữ lại */}
            <div className="space-y-2">
              <div className="text-sm font-medium">Chọn dữ liệu xoá kèm</div>
              <ul className="divide-y rounded-lg border">
                {data.optional.map((o) => {
                  const on = selected.has(o.key);
                  const empty = o.count === 0;
                  return (
                    <li key={o.key}>
                      <label className={cn('flex cursor-pointer items-start gap-3 px-3 py-2.5', empty && 'cursor-default opacity-60')}>
                        <Checkbox className="mt-0.5" checked={on && !empty} disabled={empty} onCheckedChange={(v) => toggle(o.key, v === true)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                            <span className="font-medium">{o.label}</span>
                            <Badge variant="secondary" className="tabular-nums">
                              {o.count}
                            </Badge>
                            {o.key === 'orders' && o.count > 0 && <span className="text-xs text-muted-foreground">tổng {formatMoney(o.total ?? 0)}</span>}
                            {o.detail && o.count > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {o.detail.posts} bài viết · {o.detail.pages} trang · {o.detail.entries} nội dung khác
                              </span>
                            )}
                          </div>
                          {!empty && <p className={cn('text-xs', on ? 'text-destructive' : 'text-muted-foreground')}>{on ? o.deleteNote : o.keepNote}</p>}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-email">
                Nhập <b className="font-mono">{data.user.email}</b> để xác nhận
              </Label>
              <Input id="confirm-email" autoComplete="off" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={data.user.email} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
            Huỷ
          </Button>
          <Button variant="destructive" disabled={!emailOk || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Xoá vĩnh viễn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
