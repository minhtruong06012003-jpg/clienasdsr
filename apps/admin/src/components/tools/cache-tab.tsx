'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eraser, Info, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ClearResult {
  cleared: string[];
  revalidate: { ok: boolean; tags: string[]; error?: string; status?: number };
}

/**
 * API chưa cấu hình địa chỉ frontend riêng / REVALIDATE_SECRET (dự án chỉ dùng API headless):
 * không phải lỗi — chỉ là không có frontend nào để làm mới cache.
 */
const notConfigured = (r: ClearResult['revalidate']) => !r.ok && !r.status && /chưa cấu hình/i.test(r.error ?? '');

/** Tab Cache: xoá cache in-memory của API + làm mới cache của frontend riêng (nếu có) */
export function CacheTab() {
  const qc = useQueryClient();
  const [result, setResult] = useState<ClearResult | null>(null);
  const clear = useMutation({
    mutationFn: () => api.post<ClearResult>('/admin/tools/cache/clear'),
    onSuccess: (r) => {
      setResult(r);
      if (r.revalidate.ok) toast.success('Đã xoá cache và làm mới frontend riêng');
      // chưa cấu hình frontend riêng -> chỉ xoá cache API là đủ, không cảnh báo
      else if (notConfigured(r.revalidate)) toast.success('Đã xoá cache API');
      else toast.warning(`Đã xoá cache API, nhưng frontend riêng chưa làm mới: ${r.revalidate.error}`);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Xoá cache" description="Dùng khi website hiển thị nội dung cũ sau khi chỉnh sửa, đổi cài đặt hoặc cập nhật giao diện">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Xoá cache cài đặt và ngôn ngữ trong bộ nhớ của API.</li>
          <li>Gọi frontend riêng (nếu có) làm mới toàn bộ cache: trang, bài viết, sản phẩm, menu, cài đặt, block, media, sitemap...</li>
          <li>Trang sẽ được render lại ở lượt truy cập kế tiếp — không gián đoạn website.</li>
        </ul>
        <Button onClick={() => clear.mutate()} disabled={clear.isPending}>
          {clear.isPending ? <Loader2 className="animate-spin" /> : <Eraser />} Xoá toàn bộ cache
        </Button>
      </Section>

      <Section title="Kết quả lần gần nhất">
        {!result ? (
          <p className="text-sm text-muted-foreground">Chưa xoá cache trong phiên này.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> Cache API: {result.cleared.join(', ')}
            </p>
            {notConfigured(result.revalidate) ? (
              // chưa cấu hình frontend riêng: thông tin trung tính, không tô đỏ
              <p className="flex items-start gap-2 text-muted-foreground">
                <Info className="mt-0.5 size-4" />
                <span>Frontend riêng: chưa cấu hình — bỏ qua bước làm mới cache.</span>
              </p>
            ) : (
              <p className={cn('flex items-start gap-2', result.revalidate.ok ? '' : 'text-red-600 dark:text-red-400')}>
                {result.revalidate.ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" /> : <XCircle className="mt-0.5 size-4" />}
                <span>
                  Frontend riêng: {result.revalidate.ok ? `đã làm mới ${result.revalidate.tags.length} nhóm cache` : result.revalidate.error}
                  {result.revalidate.status ? ` (HTTP ${result.revalidate.status})` : ''}
                </span>
              </p>
            )}
            <div className={cn('flex flex-wrap gap-1', notConfigured(result.revalidate) && 'hidden')}>
              {result.revalidate.tags.map((t) => (
                <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t}
                </code>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Chỉ cần khi dự án có frontend riêng (nếu có): đặt WEB_URL (hoặc WEB_INTERNAL_URL) ở API và REVALIDATE_SECRET giống nhau ở API và frontend.</p>
      </Section>
    </div>
  );
}
