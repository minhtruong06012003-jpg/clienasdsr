'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export type RevisionResource = 'pages' | 'posts' | 'products' | 'entries';

export interface RevisionItem {
  id: string;
  locale?: string;
  title: string;
  createdAt: string;
  author?: { id: string; name: string } | null;
  /** bài viết */
  contentLength?: number;
  /** trang */
  blockCount?: number;
  /** sản phẩm */
  status?: string;
  price?: number;
  salePrice?: number | null;
  stockQuantity?: number;
  variantCount?: number;
}

const DESCRIPTION: Record<RevisionResource, string> = {
  pages: 'Mỗi lần lưu thay đổi block sẽ tạo một phiên bản (giữ 30 bản gần nhất). Khôi phục sẽ ghi đè bản hiện tại (bản hiện tại cũng được lưu lại thành phiên bản).',
  posts: 'Mỗi lần lưu thay đổi tiêu đề / tóm tắt / nội dung sẽ tạo một phiên bản (giữ 30 bản gần nhất). Khôi phục ghi đè bản dịch hiện tại (bản hiện tại cũng được lưu lại).',
  entries: 'Mỗi lần lưu thay đổi tiêu đề / tóm tắt / nội dung / block sẽ tạo một phiên bản (giữ 30 bản gần nhất). Khôi phục ghi đè bản dịch hiện tại (bản hiện tại cũng được lưu lại).',
  products: 'Mỗi lần lưu thay đổi sẽ chụp lại toàn bộ sản phẩm (giá, kho, biến thể, bản dịch...; giữ 20 bản). Khôi phục ghi đè toàn bộ sản phẩm (bản hiện tại cũng được lưu lại).',
};

/**
 * Lịch sử phiên bản dùng chung cho Trang / Bài viết / Sản phẩm.
 * - GET /admin/{resource}/{id}/revisions[?locale=] -> danh sách
 * - GET /admin/{resource}/revisions/{rid}          -> nội dung đầy đủ (xem trước)
 * - POST /admin/{resource}/{id}/revisions/{rid}/restore -> khôi phục server-side, trả bản ghi mới -> onRestored
 */
export function RevisionsDialog<TDetail = unknown, TEntity = unknown>({
  resource,
  id,
  locale,
  canRestore = true,
  onRestored,
  renderPreview,
  trigger,
}: {
  resource: RevisionResource;
  id: string;
  /** chỉ hiện phiên bản của ngôn ngữ này (trang/bài viết) */
  locale?: string;
  canRestore?: boolean;
  onRestored?: (entity: TEntity) => void;
  /** hiển thị nội dung một phiên bản khi người dùng bấm "Xem" */
  renderPreview?: (detail: TDetail) => ReactNode;
  trigger?: ReactNode;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const queryKey = [`${resource}-revisions`, id, locale ?? ''];

  const list = useQuery({ queryKey, queryFn: () => api.get<RevisionItem[]>(`/admin/${resource}/${id}/revisions`, locale ? { locale } : undefined), enabled: open });
  const detail = useQuery({ queryKey: [`${resource}-revision`, viewId], queryFn: () => api.get<TDetail>(`/admin/${resource}/revisions/${viewId}`), enabled: !!viewId && !!renderPreview });

  const restore = useMutation({
    mutationFn: (rid: string) => api.post<TEntity>(`/admin/${resource}/${id}/revisions/${rid}/restore`),
    onSuccess: (entity, rid) => {
      const r = list.data?.find((x) => x.id === rid);
      toast.success(`Đã khôi phục phiên bản ${r ? formatDate(r.createdAt) : ''}`);
      void qc.invalidateQueries({ queryKey: [`${resource}-revisions`, id] });
      setOpen(false);
      setViewId(null);
      onRestored?.(entity);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doRestore = async (r: RevisionItem) => {
    if (!(await confirm({ title: `Khôi phục phiên bản ${formatDate(r.createdAt)}?`, description: 'Nội dung hiện tại sẽ bị ghi đè (và được lưu lại thành một phiên bản mới để có thể quay lại).', confirmText: 'Khôi phục' }))) return;
    restore.mutate(r.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setViewId(null);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" title="Lịch sử phiên bản">
            <History /> Lịch sử
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className={cn('max-h-[85vh] overflow-hidden', renderPreview ? 'sm:max-w-4xl' : 'sm:max-w-xl')}>
        <DialogHeader>
          <DialogTitle>Lịch sử phiên bản</DialogTitle>
          <DialogDescription>{DESCRIPTION[resource]}</DialogDescription>
        </DialogHeader>
        <div className={cn('grid gap-4', renderPreview && 'md:grid-cols-[320px_1fr]')}>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
            {list.isLoading && <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />}
            {list.data?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Chưa có phiên bản cũ</p>}
            {list.data?.map((r, i) => (
              <div key={r.id} className={cn('rounded-lg border px-3 py-2', viewId === r.id && 'border-primary bg-primary/5')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {formatDate(r.createdAt)}
                      {i === 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          Mới nhất
                        </Badge>
                      )}
                      {r.locale && <span className="text-[10px] uppercase text-muted-foreground">{r.locale}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground" title={r.title}>
                      {timeAgo(r.createdAt)}
                      {r.author ? ` · ${r.author.name}` : ''} · {r.title || '(không tiêu đề)'}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {r.contentLength != null && `${r.contentLength.toLocaleString('vi-VN')} ký tự`}
                      {r.blockCount != null && `${r.blockCount} block`}
                      {r.price != null && `Giá ${r.price.toLocaleString('vi-VN')}${r.salePrice != null ? ` · KM ${r.salePrice.toLocaleString('vi-VN')}` : ''}${r.variantCount ? ` · ${r.variantCount} biến thể` : ''}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {renderPreview && (
                      <Button size="sm" variant="ghost" onClick={() => setViewId(viewId === r.id ? null : r.id)}>
                        Xem
                      </Button>
                    )}
                    {canRestore && (
                      <Button size="sm" variant="outline" onClick={() => doRestore(r)} disabled={restore.isPending}>
                        {restore.isPending && restore.variables === r.id ? <Loader2 className="animate-spin" /> : <RotateCcw />} Khôi phục
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {renderPreview && (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/30 p-4">
              {!viewId && <p className="text-sm text-muted-foreground">Chọn “Xem” ở một phiên bản để xem nội dung.</p>}
              {viewId && detail.isLoading && <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />}
              {viewId && detail.data && renderPreview(detail.data)}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
