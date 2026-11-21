'use client';

/**
 * AI Studio › Bảng tin: admin tự viết thông báo (cập nhật mới của web, bảo trì...) — khách xem ở trang Tổng quan,
 * kèm ngày giờ đăng; thông báo ghim nằm trên cùng, thông báo ẩn chỉ còn thấy ở đây.
 * API: GET/POST/PUT/DELETE /admin/announcements (quyền announcements.manage).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { Field } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { PermissionGate } from '@/components/ai/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LazyRichTextEditor } from '@/components/editor/lazy-rich-text-editor';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface Announcement {
  id: string;
  title: string | null;
  content: string;
  pinned: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string; email: string } | null;
}

/** Nội dung đã là HTML (soạn bằng trình soạn thảo) hay chữ thuần (thông báo cũ) */
const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

/** Chữ thuần (thông báo cũ) -> HTML để mở trong trình soạn thảo: escape ký tự đặc biệt, mỗi dòng một đoạn */
function plainToHtml(s: string) {
  if (!s || isHtml(s)) return s;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s
    .split('\n')
    .map((line) => `<p>${esc(line)}</p>`)
    .join('');
}

/** Bỏ thẻ HTML để xem trước ngắn gọn trong bảng danh sách */
const htmlToText = (s: string) => (isHtml(s) ? s.replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : s);

export default function AnnouncementsPage() {
  return (
    <>
      <PageHeader title="Bảng tin" description="Thông báo bạn viết sẽ hiện ở trang Tổng quan của khách kèm ngày giờ đăng — dùng để báo cập nhật mới của web" breadcrumbs={[{ label: 'AI Studio' }, { label: 'Bảng tin' }]} />
      <PageBody>
        <PermissionGate permission="announcements.manage">
          <AnnouncementList />
        </PermissionGate>
      </PageBody>
    </>
  );
}

/** Danh sách thông báo + thêm / sửa / xoá */
function AnnouncementList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Partial<Announcement> | null>(null);
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<Announcement[]>('/admin/announcements') });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/announcements/${id}`),
    onSuccess: () => {
      toast.success('Đã xoá thông báo');
      qc.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const columns: Column<Announcement>[] = [
    {
      key: 'content',
      header: 'Thông báo',
      mobile: 'primary',
      cell: (r) => (
        <div className="max-w-xl">
          <div className="flex items-center gap-1.5 font-medium">
            {r.pinned && <Pin className="size-3.5 text-amber-500" />}
            {r.title || <span className="text-muted-foreground">(Không tiêu đề)</span>}
            {!r.active && <Badge variant="outline">Ẩn</Badge>}
          </div>
          <div className="line-clamp-2 text-xs whitespace-pre-line text-muted-foreground">{htmlToText(r.content)}</div>
        </div>
      ),
    },
    { key: 'createdAt', header: 'Ngày đăng', cell: (r) => <span className="text-sm whitespace-nowrap tabular-nums">{formatDate(r.createdAt)}</span> },
    { key: 'author', header: 'Người viết', cell: (r) => <span className="text-sm">{r.createdBy?.name ?? '—'}</span> },
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={(e) => (e.stopPropagation(), setEdit(r))} aria-label="Sửa">
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Xoá"
            onClick={async (e) => {
              e.stopPropagation();
              if (await confirm({ title: 'Xoá thông báo này?', description: 'Thông báo sẽ biến mất khỏi bảng tin của khách và không khôi phục được.', destructive: true, confirmText: 'Xoá' })) remove.mutate(r.id);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEdit({ active: true, pinned: false })}>
          <Plus /> Viết thông báo
        </Button>
      </div>
      <DataTable columns={columns} data={q.data} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => setEdit(r)} emptyTitle="Chưa có thông báo nào" />
      {edit && <AnnouncementDialog item={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Hộp viết / sửa thông báo */
function AnnouncementDialog({ item, onClose }: { item: Partial<Announcement>; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: item.title ?? '', content: plainToHtml(item.content ?? ''), pinned: !!item.pinned, active: item.active !== false });
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const save = useMutation({
    mutationFn: () => (item.id ? api.put(`/admin/announcements/${item.id}`, f) : api.post('/admin/announcements', f)),
    onSuccess: () => {
      toast.success('Đã lưu thông báo');
      qc.invalidateQueries({ queryKey: ['announcements'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item.id ? 'Sửa thông báo' : 'Viết thông báo mới'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Tiêu đề" help="Tuỳ chọn, vd: Cập nhật ngày 01/11">
            <Input value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={160} />
          </Field>
          <Field label="Nội dung" required help="Bôi đen chữ để chèn liên kết (Ctrl/Cmd+K), đổi màu, in đậm... — khách thấy đúng định dạng này">
            {/* trình soạn thảo gọn (TipTap) xuất HTML; API lọc lại HTML trước khi lưu */}
            <LazyRichTextEditor compact value={f.content} onChange={(html) => set({ content: html })} minHeight={180} placeholder="Viết nội dung thông báo..." />
          </Field>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.pinned} onCheckedChange={(v) => set({ pinned: v })} /> Ghim lên đầu
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.active} onCheckedChange={(v) => set({ active: v })} /> Hiện cho khách
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button disabled={!htmlToText(f.content).trim() || save.isPending} onClick={() => save.mutate()}>
            {item.id ? 'Lưu' : 'Đăng thông báo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
