'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_ABANDONED_CART, type AbandonedCartSettings } from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';

/**
 * Cấu hình nhắc giỏ bỏ dở (settings nhóm commerce, khoá abandonedCart).
 * Chỉ gửi khoá abandonedCart — API gộp nông nên các cài đặt bán hàng khác giữ nguyên.
 */
export function AbandonedCartSettingsDialog({ open, onOpenChange, value }: { open: boolean; onOpenChange: (open: boolean) => void; value?: AbandonedCartSettings }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AbandonedCartSettings>(value ?? DEFAULT_ABANDONED_CART);
  useEffect(() => {
    if (open) setForm(value ?? DEFAULT_ABANDONED_CART);
  }, [open, value]);

  const save = useMutation({
    mutationFn: () => api.put('/admin/settings/commerce', { abandonedCart: form }),
    onSuccess: () => {
      toast.success('Đã lưu cài đặt nhắc giỏ hàng');
      void qc.invalidateQueries({ queryKey: ['abandoned-carts'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const num = (k: keyof AbandonedCartSettings) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));
  const invalid = !(form.firstDelayHours > 0) || form.secondDelayHours < 0 || (form.secondDelayHours > 0 && form.secondDelayHours <= form.firstDelayHours) || !(form.maxAgeDays >= 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cài đặt nhắc giỏ hàng bỏ dở</DialogTitle>
          <DialogDescription>Tự động gửi email mẫu “Nhắc giỏ hàng bỏ dở” cho khách đã để lại email nhưng chưa đặt hàng. Hệ thống kiểm tra mỗi 15 phút.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <Label htmlFor="ac-enabled" className="text-sm">
              Bật gửi email nhắc tự động
            </Label>
            <Switch id="ac-enabled" checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nhắc lần 1 sau (giờ)" htmlFor="ac-first" help="Tính từ lần hoạt động cuối của giỏ">
              <Input id="ac-first" type="number" min={0.25} step={0.25} value={form.firstDelayHours} onChange={num('firstDelayHours')} />
            </Field>
            <Field label="Nhắc lần 2 sau (giờ)" htmlFor="ac-second" help="0 = chỉ nhắc 1 lần">
              <Input id="ac-second" type="number" min={0} step={1} value={form.secondDelayHours} onChange={num('secondDelayHours')} />
            </Field>
            <Field label="Không nhắc giỏ cũ hơn (ngày)" htmlFor="ac-max" className="sm:col-span-2">
              <Input id="ac-max" type="number" min={1} max={90} value={form.maxAgeDays} onChange={num('maxAgeDays')} />
            </Field>
          </div>
          {invalid && <p className="text-xs text-destructive">Số giờ nhắc lần 2 phải lớn hơn lần 1 (hoặc bằng 0), số ngày tối thiểu là 1.</p>}
          <p className="text-xs text-muted-foreground">Sửa nội dung email ở Cài đặt › Mẫu email (mẫu “Nhắc giỏ hàng bỏ dở”). Cần cấu hình SMTP để email được gửi đi.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || invalid}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
