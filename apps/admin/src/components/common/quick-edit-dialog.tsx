'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field } from '@/components/common/field';
import { SlugInput } from '@/components/common/slug-input';
import { errorMessage } from '@/lib/api';
import { effectiveStatus, isFutureDate } from '@/lib/publish';
import type { ContentStatus } from '@/lib/types';

/** Trường chung cho mọi loại nội dung (theo ngôn ngữ đang xem ở danh sách) */
export interface QuickEditBase {
  title: string;
  slug: string;
  status: ContentStatus;
  /** giá trị datetime-local */
  publishedAt: string;
}

/**
 * Hộp thoại "Sửa nhanh" (giống Quick Edit của WordPress): tiêu đề + slug (ngôn ngữ đang xem),
 * trạng thái, ngày đăng; mỗi loại nội dung thêm trường riêng qua `extra`.
 * Mở khi `initial` khác null; `onSave` nhận form đã chuẩn hoá (status PUBLISHED + ngày tương lai -> SCHEDULED).
 */
export function QuickEditDialog<T extends QuickEditBase>({
  initial,
  onClose,
  onSave,
  heading,
  localeLabel,
  titleLabel = 'Tiêu đề',
  slugPrefix,
  canPublish,
  extra,
}: {
  initial: T | null;
  onClose: () => void;
  onSave: (form: T) => Promise<unknown>;
  heading: string;
  /** tên ngôn ngữ đang sửa (hiển thị ở mô tả) */
  localeLabel?: string;
  titleLabel?: string;
  slugPrefix?: string;
  canPublish: boolean;
  extra?: (form: T, set: (patch: Partial<T>) => void) => ReactNode;
}) {
  const [form, setForm] = useState<T | null>(initial);
  const [pending, setPending] = useState(false);
  useEffect(() => setForm(initial), [initial]);

  const set = (patch: Partial<T>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const scheduled = !!form && (form.status === 'PUBLISHED' || form.status === 'SCHEDULED') && isFutureDate(form.publishedAt);

  const submit = async () => {
    if (!form) return;
    if (!form.title.trim()) {
      toast.error(`Vui lòng nhập ${titleLabel.toLowerCase()}`);
      return;
    }
    setPending(true);
    try {
      await onSave({ ...form, status: effectiveStatus(form.status, form.publishedAt) });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={!!initial} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{localeLabel ? `Sửa nhanh bản ${localeLabel}. ` : ''}Nội dung chi tiết sửa trong trình soạn thảo.</DialogDescription>
        </DialogHeader>
        {form && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label={titleLabel} required>
              <Input value={form.title} onChange={(e) => set({ title: e.target.value } as Partial<T>)} autoFocus />
            </Field>
            <Field label="Đường dẫn (slug)">
              <SlugInput value={form.slug} onChange={(slug) => set({ slug } as Partial<T>)} source={form.title} prefix={slugPrefix} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Trạng thái" help={scheduled ? 'Ngày đăng ở tương lai -> sẽ hẹn giờ' : undefined}>
                <Select value={form.status === 'SCHEDULED' ? 'PUBLISHED' : form.status} onValueChange={(v) => set({ status: v as ContentStatus } as Partial<T>)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DRAFT">Bản nháp</SelectItem>
                    {canPublish && <SelectItem value="PUBLISHED">{scheduled ? 'Hẹn giờ đăng' : 'Đã xuất bản'}</SelectItem>}
                    <SelectItem value="ARCHIVED">Lưu trữ</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Ngày đăng">
                <Input type="datetime-local" value={form.publishedAt} onChange={(e) => set({ publishedAt: e.target.value } as Partial<T>)} />
              </Field>
            </div>
            {extra?.(form, set)}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />} Lưu
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
