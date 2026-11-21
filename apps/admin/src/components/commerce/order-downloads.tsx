'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth';

interface OrderDownloadRow {
  id: string;
  name: string;
  productName?: string | null;
  downloadLimit: number | null;
  downloadCount: number;
  remaining: number | null;
  expiresAt: string | null;
  expired: boolean;
  available: boolean;
  url: string;
}

/** File tải về đã cấp cho đơn (sản phẩm số) — chỉ hiện khi có file */
export function OrderDownloadsSection({ orderId, paid, hasDigital }: { orderId: string; paid: boolean; hasDigital: boolean }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['order-downloads', orderId], queryFn: () => api.get<OrderDownloadRow[]>(`/admin/downloads/by-order/${orderId}`), enabled: hasDigital });
  const regrant = useMutation({
    mutationFn: () => api.post(`/admin/downloads/by-order/${orderId}/regrant`, { resetCount: true }),
    onSuccess: () => {
      toast.success('Đã cấp lại quyền tải');
      void qc.invalidateQueries({ queryKey: ['order-downloads', orderId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!hasDigital) return null;
  const rows = list.data ?? [];
  return (
    <Section
      title="File tải về"
      description={paid ? 'Khách tải qua tài khoản hoặc link trong email' : 'Sẽ cấp khi đơn được đánh dấu đã thanh toán'}
      actions={
        paid && can('orders.write') ? (
          <Button size="sm" variant="outline" onClick={() => regrant.mutate()} disabled={regrant.isPending}>
            {regrant.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Cấp lại / đặt lại lượt
          </Button>
        ) : undefined
      }
    >
      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Đang tải…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{paid ? 'Chưa có file nào được cấp.' : 'Chưa cấp.'}</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
              <Download className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{d.name}</span>
                {d.productName && <span className="text-muted-foreground"> · {d.productName}</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {d.downloadLimit != null ? `${d.downloadCount}/${d.downloadLimit} lượt` : `${d.downloadCount} lượt`}
                {d.expiresAt ? ` · hết hạn ${formatDate(d.expiresAt, 'dd/MM/yyyy')}` : ''}
              </span>
              {d.expired ? <Badge variant="secondary">Hết hạn</Badge> : d.available ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300">Khả dụng</Badge> : <Badge variant="secondary">Hết lượt</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
