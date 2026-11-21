'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toLocalInput } from '@/components/commerce/utils';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Các mốc khoá nhanh (giờ); 'custom' = tự chọn ngày giờ mở khoá */
const PRESETS = [
  { key: '1h', label: '1 giờ', hours: 1 },
  { key: '24h', label: '24 giờ', hours: 24 },
  { key: '3d', label: '3 ngày', hours: 72 },
  { key: '7d', label: '7 ngày', hours: 168 },
  { key: '30d', label: '30 ngày', hours: 720 },
  { key: 'custom', label: 'Tự chọn', hours: 0 },
] as const;

type PresetKey = (typeof PRESETS)[number]['key'];

/**
 * Hộp thoại khoá tạm thời tài khoản: chọn thời hạn + lý do. Thành viên bị đăng xuất mọi thiết bị ngay,
 * khi đăng nhập sẽ thấy thời điểm mở khoá và lý do; hết hạn tự mở khoá (hoặc admin mở khoá sớm).
 */
export function LockUserDialog({ userId, userName, onClose, onDone }: { userId: string; userName: string; onClose: () => void; onDone: () => void }) {
  const [preset, setPreset] = useState<PresetKey>('24h');
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 3 * 86_400_000).toISOString()));
  const [reason, setReason] = useState('');
  // mốc "bây giờ" để tính giờ mở khoá (render phải thuần nên không gọi Date.now() trực tiếp); cập nhật khi đổi lựa chọn
  const [now, setNow] = useState(() => Date.now());

  /** Thời điểm mở khoá theo lựa chọn, tính từ mốc `base` (null = ngày tự chọn chưa hợp lệ) */
  const computeUntil = (base: number) => {
    if (preset !== 'custom') return new Date(base + PRESETS.find((p) => p.key === preset)!.hours * 3600_000);
    const d = custom ? new Date(custom) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const until = computeUntil(now);
  const invalid = !until || until.getTime() <= now;

  const save = useMutation({
    // tính lại theo thời điểm bấm khoá để "24 giờ" đúng là 24 giờ kể từ lúc lưu
    mutationFn: async () => {
      const at = computeUntil(Date.now())!;
      await api.post(`/admin/users/${userId}/lock`, { until: at.toISOString(), reason: reason.trim() || undefined });
      return at;
    },
    onSuccess: (at) => {
      toast.success(`Đã khoá ${userName} tới ${formatDate(at.toISOString())}`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Khoá tạm thời tài khoản</DialogTitle>
          <DialogDescription>
            <b>{userName}</b> sẽ bị đăng xuất khỏi mọi thiết bị và không thể đăng nhập tới thời điểm mở khoá. Hết hạn tài khoản tự mở lại.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label>Thời hạn khoá</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn(preset === p.key && 'border-primary bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary')}
                  onClick={() => {
                    setPreset(p.key);
                    setNow(Date.now());
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {preset === 'custom' && <Input type="datetime-local" value={custom} min={toLocalInput(new Date(now).toISOString())} onChange={(e) => {
                  setCustom(e.target.value);
                  setNow(Date.now());
                }} className="mt-1.5" />}
            <p className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
              {invalid ? 'Thời điểm mở khoá phải ở tương lai.' : <>Tự mở khoá lúc <b className="tabular-nums">{formatDate(until!.toISOString())}</b></>}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lock-reason">Lý do</Label>
            <Textarea id="lock-reason" rows={2} maxLength={300} placeholder="vd. Nghi ngờ gian lận đơn hàng, chờ xác minh" value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-xs text-muted-foreground">Thành viên thấy lý do này khi cố đăng nhập. Để trống nếu không muốn hiển thị.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" variant="destructive" disabled={invalid || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Lock />} Khoá tài khoản
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
