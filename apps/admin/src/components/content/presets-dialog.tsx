'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ContentTypeView } from '@cmsnt/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ContentIcon } from './content-icon';

interface ContentPreset {
  key: string;
  label: string;
  description: string;
  icon: string;
  /** API đánh dấu mẫu đã cài */
  installed?: boolean;
}

/**
 * Hộp thoại "Cài mẫu có sẵn": GET /admin/content-types/presets → danh sách mẫu (Dự án, Dịch vụ, Tuyển dụng...),
 * POST /admin/content-types/presets/:key cài loại nội dung + taxonomy + nhóm trường tuỳ chỉnh (idempotent).
 */
export function ContentPresetsDialog({ open, onOpenChange, installed }: { open: boolean; onOpenChange: (o: boolean) => void; installed: ContentTypeView[] }) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['content-type-presets'], queryFn: () => api.get<ContentPreset[]>('/admin/content-types/presets'), enabled: open });
  const install = useMutation({
    mutationFn: (key: string) => api.post(`/admin/content-types/presets/${key}`),
    onSuccess: (_d, key) => {
      const p = presets.data?.find((x) => x.key === key);
      toast.success(`Đã cài mẫu “${p?.label ?? key}” (loại nội dung, phân loại và nhóm trường tuỳ chỉnh)`);
      void qc.invalidateQueries({ queryKey: ['content-types'] });
      void qc.invalidateQueries({ queryKey: ['taxonomies'] });
      void qc.invalidateQueries({ queryKey: ['field-groups'] });
      void qc.invalidateQueries({ queryKey: ['custom-field-groups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const has = (key: string) => installed.some((t) => t.key === key);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cài mẫu loại nội dung</DialogTitle>
          <DialogDescription>Mỗi mẫu tạo sẵn loại nội dung, phân loại và nhóm trường tuỳ chỉnh phù hợp. Cài lại không làm mất dữ liệu đã có.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2">
          {presets.isLoading && (
            <div className="col-span-full flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {presets.isError && <p className="col-span-full py-6 text-center text-sm text-muted-foreground">Không tải được danh sách mẫu: {errorMessage(presets.error)}</p>}
          {presets.data?.map((p) => {
            const done = p.installed ?? has(p.key);
            return (
              <div key={p.key} className={cn('flex gap-3 rounded-lg border p-3', done && 'bg-muted/40')}>
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <ContentIcon name={p.icon} className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-medium">
                    {p.label}
                    {done && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
                  </p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                  <Button size="sm" variant={done ? 'outline' : 'default'} className="mt-2 h-7" disabled={install.isPending} onClick={() => install.mutate(p.key)}>
                    {install.isPending && install.variables === p.key && <Loader2 className="animate-spin" />}
                    {done ? 'Cài lại phần còn thiếu' : 'Cài mẫu'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
