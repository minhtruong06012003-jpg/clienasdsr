'use client';

/**
 * Tab "Danh sách mã": lọc theo sản phẩm / biến thể / trạng thái / lô / tìm kiếm, phân trang server,
 * chọn nhiều để khoá / mở khoá / xoá / đặt lô, menu từng mã (xem nội dung, sửa, đổi mã, thu hồi),
 * xuất CSV theo bộ lọc hiện tại.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileSpreadsheet, Layers, Loader2, Lock, MoreHorizontal, Pencil, RefreshCw, Trash2, Undo2, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { DIGITAL_CODE_STATUS_LABELS, DIGITAL_CODE_STATUSES, type AdminDigitalCode, type DigitalStockRow } from '@cmsnt/shared';
import { DataTable, type Column } from '@/components/common/data-table';
import { Field } from '@/components/common/field';
import { ListToolbar } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { usePrompt } from '@/components/common/prompt-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, qs, type Paginated } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CodeStatusBadge, DIGITAL_QK, invalidateDigital, ReplaceCodeDialog, ReportStatusBadge, RevealCodeDialog, RevokeCodeDialog, type DigitalBatch, type DigitalProductOption } from './shared';

/** Bộ lọc danh sách mã (lưu trên URL ở trang cha) */
export interface CodesFilter {
  productId: string;
  variantId: string;
  status: string;
  batch: string;
  search: string;
}

/** Dialog sửa mã: ghi chú, lô, giá vốn, hạn dùng, trạng thái (còn / khoá) và nội dung (khi chưa giao) */
function EditCodeDialog({ code, onClose }: { code: AdminDigitalCode | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [batch, setBatch] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [status, setStatus] = useState<'AVAILABLE' | 'DISABLED' | ''>('');
  const [content, setContent] = useState('');

  // chỉ mã chưa gắn đơn (còn / khoá) mới được đổi trạng thái và nội dung
  const editable = code?.status === 'AVAILABLE' || code?.status === 'DISABLED';

  useEffect(() => {
    if (!code) return;
    setNote(code.note ?? '');
    setBatch(code.batch ?? '');
    setCostPrice(code.costPrice != null ? String(code.costPrice) : '');
    setExpiresAt(code.expiresAt ? code.expiresAt.slice(0, 10) : '');
    setStatus(code.status === 'AVAILABLE' || code.status === 'DISABLED' ? code.status : '');
    setContent('');
  }, [code]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        note: note.trim() || null,
        batch: batch.trim() || null,
        costPrice: costPrice.trim() === '' ? null : Number(costPrice),
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      };
      if (editable && status && status !== code!.status) body.status = status;
      if (editable && content.trim()) body.content = content.trim();
      return api.patch<AdminDigitalCode>(`/admin/digital-codes/${code!.id}`, body);
    },
    onSuccess: () => {
      toast.success('Đã lưu mã');
      invalidateDigital(qc);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (costPrice.trim() && !(Number(costPrice) >= 0)) return toast.error('Giá vốn không hợp lệ');
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Sửa mã</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{code?.preview}</span> · {code?.productName}
              {code?.variantLabel ? ` · ${code.variantLabel}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Lô">
              <Input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Giá vốn">
              <Input type="number" min={0} step="any" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
            </Field>
            <Field label="Hạn dùng">
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
            {editable && (
              <Field label="Trạng thái">
                <Select value={status} onValueChange={(v) => setStatus(v as 'AVAILABLE' | 'DISABLED')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AVAILABLE">{DIGITAL_CODE_STATUS_LABELS.AVAILABLE}</SelectItem>
                    <SelectItem value="DISABLED">{DIGITAL_CODE_STATUS_LABELS.DISABLED}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <Field label="Ghi chú">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
          </Field>
          {editable && (
            <Field label="Nội dung mới" help="Để trống nếu giữ nguyên nội dung hiện tại. Nội dung luôn được mã hoá khi lưu.">
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} maxLength={2000} className="font-mono" placeholder="tài khoản|mật khẩu|ghi chú" spellCheck={false} />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Lưu
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CodesTab({
  filter,
  page,
  limit,
  onFilterChange,
  stockRows,
  canManage,
  canReveal,
  canExport,
}: {
  filter: CodesFilter;
  page: number;
  limit: number;
  onFilterChange: (patch: Partial<Record<string, string | number | undefined>>) => void;
  /** dòng tồn kho (để dựng bộ lọc sản phẩm / biến thể) */
  stockRows: DigitalStockRow[];
  canManage: boolean;
  canReveal: boolean;
  canExport: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [selected, setSelected] = useState<string[]>([]);
  const [reveal, setReveal] = useState<AdminDigitalCode | null>(null);
  const [edit, setEdit] = useState<AdminDigitalCode | null>(null);
  const [replace, setReplace] = useState<AdminDigitalCode | null>(null);
  const [revoke, setRevoke] = useState<AdminDigitalCode | null>(null);

  // đổi bộ lọc -> bỏ chọn
  useEffect(() => setSelected([]), [filter.productId, filter.variantId, filter.status, filter.batch, filter.search]);

  const query = {
    productId: filter.productId || undefined,
    variantId: filter.variantId || undefined,
    status: filter.status || undefined,
    batch: filter.batch || undefined,
    search: filter.search || undefined,
  };
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: [DIGITAL_QK, 'list', query, page, limit], queryFn: () => api.get<Paginated<AdminDigitalCode>>('/admin/digital-codes', { ...query, page, limit }),
  });
  const batches = useQuery({ queryKey: [DIGITAL_QK, 'batches', filter.productId], queryFn: () => api.get<DigitalBatch[]>('/admin/digital-codes/batches', { productId: filter.productId || undefined }) });

  // danh sách sản phẩm để lọc lấy từ API riêng (không phụ thuộc bảng tồn kho đang bị lọc theo sản phẩm);
  // gộp thêm sản phẩm trong bảng tồn kho phòng khi nằm ngoài 50 sản phẩm API trả về
  const productList = useQuery({ queryKey: [DIGITAL_QK, 'products', ''], queryFn: () => api.get<DigitalProductOption[]>('/admin/digital-codes/products') });
  const productOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of productList.data ?? []) m.set(p.id, p.name);
    for (const r of stockRows) if (!m.has(r.productId)) m.set(r.productId, r.productName);
    // sản phẩm đang lọc (từ link trang khác) chưa có trong danh sách -> vẫn hiện để Select không trống
    if (filter.productId && !m.has(filter.productId)) m.set(filter.productId, 'Sản phẩm đang lọc');
    return [...m].map(([id, name]) => ({ id, name }));
  }, [productList.data, stockRows, filter.productId]);
  // biến thể của sản phẩm đang lọc: ưu tiên từ API sản phẩm, không có thì lấy từ bảng tồn kho
  const variantOptions = useMemo(() => {
    const fromApi = productList.data?.find((p) => p.id === filter.productId)?.variants;
    if (fromApi?.length) return fromApi.map((v) => ({ id: v.id, label: v.label }));
    return stockRows.filter((r) => r.productId === filter.productId && r.variantId).map((r) => ({ id: r.variantId!, label: r.variantLabel ?? r.variantId! }));
  }, [productList.data, stockRows, filter.productId]);

  /** Thao tác hàng loạt */
  const bulk = useMutation({
    mutationFn: (body: { action: 'disable' | 'enable' | 'delete' | 'setBatch'; batch?: string }) => api.post<{ affected: number }>('/admin/digital-codes/bulk', { ids: selected, ...body }),
    onSuccess: (r) => {
      toast.success(`Đã cập nhật ${r.affected} mã`);
      setSelected([]);
      invalidateDigital(qc);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runBulk = async (action: 'disable' | 'enable' | 'delete' | 'setBatch') => {
    if (action === 'setBatch') {
      const name = await prompt({ title: `Đặt lô cho ${selected.length} mã`, label: 'Tên lô', placeholder: 'Vd: Lô nhà cung cấp A', confirmText: 'Đặt lô' });
      if (name == null) return;
      bulk.mutate({ action, batch: name.trim() });
      return;
    }
    const texts = {
      disable: { title: `Khoá ${selected.length} mã?`, description: 'Mã bị khoá sẽ không được bán cho tới khi mở khoá. Chỉ áp dụng cho mã còn trong kho.', confirmText: 'Khoá mã', destructive: false },
      enable: { title: `Mở khoá ${selected.length} mã?`, description: 'Mã được mở khoá sẽ quay lại kho để bán.', confirmText: 'Mở khoá', destructive: false },
      delete: { title: `Xoá ${selected.length} mã?`, description: 'Chỉ xoá được mã còn trong kho / đang khoá và chưa từng giao cho khách. Không thể hoàn tác.', confirmText: 'Xoá vĩnh viễn', destructive: true },
    }[action];
    if (!(await confirm(texts))) return;
    bulk.mutate({ action });
  };

  /** Xuất CSV theo bộ lọc hiện tại (file chứa nội dung thật của mã) */
  const exportCsv = async () => {
    const ok = await confirm({ title: 'Xuất mã ra file CSV?', description: 'File chứa nội dung thật (chưa che) của các mã theo bộ lọc hiện tại. Hãy bảo quản cẩn thận; thao tác được ghi vào nhật ký.', confirmText: 'Xuất file' });
    if (!ok) return;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await toast.promise(api.download(`/admin/digital-codes/export.csv${qs(query)}`, `kho-ma-${stamp}.csv`), { loading: 'Đang xuất file...', success: 'Đã tải file CSV', error: (e) => errorMessage(e) });
  };

  const columns: Column<AdminDigitalCode>[] = [
    {
      key: 'preview',
      header: 'Mã',
      cell: (r) => (
        <div className="min-w-44 max-w-72">
          <div className={cn('break-all font-mono text-xs', r.status === 'REVOKED' && 'text-muted-foreground line-through')}>{r.preview}</div>
          <div className="truncate text-xs text-muted-foreground">
            {r.productName}
            {r.variantLabel ? ` · ${r.variantLabel}` : ''}
          </div>
          {r.note && <div className="truncate text-xs italic text-muted-foreground">{r.note}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <CodeStatusBadge status={r.status} />
          <ReportStatusBadge status={r.reportStatus} className="text-[10px]" />
          {r.expiresAt && <span className={cn('text-[11px]', new Date(r.expiresAt) < new Date() ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>HSD {formatDate(r.expiresAt, 'dd/MM/yyyy')}</span>}
        </div>
      ),
    },
    { key: 'batch', header: 'Lô', cell: (r) => <span className="line-clamp-2 max-w-40 text-xs">{r.batch ?? '—'}</span> },
    {
      key: 'order',
      header: 'Đơn hàng',
      cell: (r) =>
        r.orderId ? (
          <Link href={`/orders/${r.orderId}`} className="font-mono text-sm font-medium hover:text-primary">
            #{r.orderCode ?? r.orderId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'soldAt',
      header: 'Ngày bán',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          {r.soldAt ? formatDate(r.soldAt) : <span className="text-muted-foreground">Nhập {formatDate(r.createdAt, 'dd/MM/yyyy')}</span>}
          {r.costPrice != null && <div className="text-muted-foreground">Vốn {formatMoney(r.costPrice)}</div>}
        </div>
      ),
    },
    {
      key: 'viewed',
      header: 'Khách xem',
      cell: (r) =>
        r.status === 'SOLD' || r.status === 'REVOKED' ? (
          r.viewedAt ? (
            <span className="whitespace-nowrap text-xs text-emerald-700 dark:text-emerald-400" title={formatDate(r.viewedAt)}>
              Đã xem
            </span>
          ) : (
            <span className="whitespace-nowrap text-xs text-muted-foreground">Chưa xem</span>
          )
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) =>
        canReveal || canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Thao tác">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canReveal && (
                <DropdownMenuItem onClick={() => setReveal(r)}>
                  <Eye /> Xem nội dung
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuItem onClick={() => setEdit(r)}>
                    <Pencil /> Sửa
                  </DropdownMenuItem>
                  {r.status === 'SOLD' && (
                    <DropdownMenuItem onClick={() => setReplace(r)}>
                      <RefreshCw /> Đổi mã
                    </DropdownMenuItem>
                  )}
                  {/* chỉ thu hồi được mã đã gắn đơn (đang giữ / đã giao) */}
                  {(r.status === 'SOLD' || r.status === 'RESERVED') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setRevoke(r)}>
                        <Undo2 /> Thu hồi
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <ListToolbar
        search={filter.search}
        onSearchChange={(v) => onFilterChange({ search: v })}
        placeholder="Bản che, lô, ghi chú, mã đơn hoặc dán nguyên mã..."
        selectedCount={selected.length}
        onClearSelection={() => setSelected([])}
        bulkActions={
          canManage && (
            <>
              <Button size="xs" variant="outline" onClick={() => void runBulk('disable')} disabled={bulk.isPending}>
                <Lock /> Khoá
              </Button>
              <Button size="xs" variant="outline" onClick={() => void runBulk('enable')} disabled={bulk.isPending}>
                <Unlock /> Mở khoá
              </Button>
              <Button size="xs" variant="outline" onClick={() => void runBulk('setBatch')} disabled={bulk.isPending}>
                <Layers /> Đặt lô
              </Button>
              <Button size="xs" variant="destructive" onClick={() => void runBulk('delete')} disabled={bulk.isPending}>
                {bulk.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Xoá
              </Button>
            </>
          )
        }
        filters={
          <>
            <Select value={filter.productId || 'all'} onValueChange={(v) => onFilterChange({ productId: v === 'all' ? '' : v, variantId: '', batch: '' })}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Sản phẩm" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi sản phẩm</SelectItem>
                {productOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {variantOptions.length > 0 && (
              <Select value={filter.variantId || 'all'} onValueChange={(v) => onFilterChange({ variantId: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Biến thể" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi biến thể</SelectItem>
                  {variantOptions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={filter.status || 'all'} onValueChange={(v) => onFilterChange({ status: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Trạng thái" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi trạng thái</SelectItem>
                {DIGITAL_CODE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {DIGITAL_CODE_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!!batches.data?.length && (
              <Select value={filter.batch || 'all'} onValueChange={(v) => onFilterChange({ batch: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Lô" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi lô</SelectItem>
                  {batches.data.map((b) => (
                    <SelectItem key={b.batch} value={b.batch}>
                      {b.batch} ({b.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canExport && (
              <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
                <FileSpreadsheet /> Xuất CSV
              </Button>
            )}
          </>
        }
      />

      <DataTable
        columns={columns}
        data={list.data?.data}
        meta={list.data?.meta}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        selectable={canManage}
        selected={selected}
        onSelectedChange={setSelected}
        onPageChange={(p) => onFilterChange({ page: p })}
        onLimitChange={(l) => onFilterChange({ limit: l })}
        emptyTitle="Không có mã nào"
        emptyDescription={filter.productId || filter.status || filter.batch || filter.search ? 'Thử bỏ bớt bộ lọc.' : 'Bấm “Nhập mã” để nạp mã vào kho.'}
      />

      <RevealCodeDialog code={reveal} onClose={() => setReveal(null)} />
      <EditCodeDialog code={edit} onClose={() => setEdit(null)} />
      <ReplaceCodeDialog code={replace} onClose={() => setReplace(null)} />
      <RevokeCodeDialog code={revoke} onClose={() => setRevoke(null)} />
    </div>
  );
}
