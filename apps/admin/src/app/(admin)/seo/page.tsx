'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, ExternalLink, Eye, EyeOff, FileCode2, FileText, Image as ImageIcon, Loader2, MoreHorizontal, Newspaper, Package, Pencil, Plus, RefreshCw, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field, Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { HAS_WEB_URL, WEB_URL } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { useSettingGroup } from '@/hooks/use-settings';
import { cn } from '@/lib/utils';

interface Redirect {
  id: string;
  fromPath: string;
  toPath: string;
  statusCode: number;
  isActive: boolean;
  hits: number;
  createdAt: string;
  updatedAt: string;
}

interface Audit {
  pagesNoDesc: number;
  postsNoDesc: number;
  productsNoDesc: number;
  productsNoImage: number;
  postsNoImage: number;
  mediaNoAlt: number;
}

const STATUS_CODES = [
  { value: 301, label: '301 — Chuyển vĩnh viễn', short: 'Vĩnh viễn' },
  { value: 302, label: '302 — Chuyển tạm thời', short: 'Tạm thời' },
  { value: 307, label: '307 — Tạm thời (giữ method)', short: 'Tạm thời' },
  { value: 308, label: '308 — Vĩnh viễn (giữ method)', short: 'Vĩnh viễn' },
  { value: 410, label: '410 — Đã xoá vĩnh viễn (Gone)', short: 'Gone' },
];

interface SeoSettings {
  noindexSite?: boolean;
  defaultDescription?: Record<string, string>;
  defaultOgImage?: unknown;
  robotsTxt?: string;
}

type RedirectForm = { id?: string; fromPath: string; toPath: string; statusCode: number; isActive: boolean };

function SeoContent() {
  const { params, set, page, limit } = useListParams({ tab: 'redirects', search: '' });
  return (
    <>
      <PageHeader title="SEO" description="Chuyển hướng URL, kiểm tra SEO toàn site, sitemap & robots.txt" />
      <PageBody>
        <Tabs value={params.tab} onValueChange={(v) => set({ tab: v, search: '' })}>
          <TabsList>
            <TabsTrigger value="redirects">Chuyển hướng</TabsTrigger>
            <TabsTrigger value="audit">Kiểm tra SEO</TabsTrigger>
            <TabsTrigger value="sitemap">Sitemap & Robots</TabsTrigger>
          </TabsList>
          <TabsContent value="redirects" className="mt-4">
            <RedirectsTab search={params.search} onSearch={(v) => set({ search: v })} page={page} limit={limit} onPage={(p) => set({ page: p })} onLimit={(l) => set({ limit: l })} />
          </TabsContent>
          <TabsContent value="audit" className="mt-4">
            <AuditTab />
          </TabsContent>
          <TabsContent value="sitemap" className="mt-4">
            <SitemapTab />
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

function RedirectsTab({ search, onSearch, page, limit, onPage, onLimit }: { search: string; onSearch: (v: string) => void; page: number; limit: number; onPage: (p: number) => void; onLimit: (l: number) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<RedirectForm | null>(null);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['redirects', { search, page, limit }], queryFn: () => api.get<Paginated<Redirect>>('/admin/seo/redirects', { search, page, limit }),
  });
  const { can } = useAuth();
  // tích chọn để bật/tắt/xoá hàng loạt (API chưa có endpoint /bulk → gọi endpoint đơn lẻ cho từng id)
  const canManage = can('seo.manage');
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  const afterBulk = () => {
    setSelected([]);
    void qc.invalidateQueries({ queryKey: ['redirects'] });
  };
  // PATCH cần đủ trường nên lấy dữ liệu dòng đang hiển thị; bỏ qua mục đã ở đúng trạng thái
  const bulkToggle = (isActive: boolean) => {
    const rows = (list.data?.data ?? []).filter((r) => selected.includes(r.id) && r.isActive !== isActive);
    if (!rows.length) return toast.info(isActive ? 'Các mục đã chọn đều đang bật' : 'Các mục đã chọn đều đang tắt');
    const byId = new Map(rows.map((r) => [r.id, r]));
    void bulk.run({
      ids: rows.map((r) => r.id),
      action: (id) => {
        const r = byId.get(id)!;
        return api.patch(`/admin/seo/redirects/${id}`, { fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode, isActive });
      },
      doneLabel: isActive ? 'Đã bật' : 'Đã tắt',
      onDone: afterBulk,
    });
  };
  const bulkRemove = async () => {
    if (!(await confirm({ title: `Xoá ${selected.length} chuyển hướng?`, description: 'Các đường dẫn nguồn sẽ không còn được chuyển hướng.', destructive: true, confirmText: 'Xoá' }))) return;
    void bulk.run({ ids: selected, action: (id) => api.delete(`/admin/seo/redirects/${id}`), doneLabel: 'Đã xoá', onDone: afterBulk });
  };

  const save = useMutation({
    mutationFn: ({ id, ...body }: RedirectForm) => (id ? api.patch<Redirect>(`/admin/seo/redirects/${id}`, body) : api.post<Redirect>('/admin/seo/redirects', body)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['redirects'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/seo/redirects/${id}`),
    onSuccess: () => {
      toast.success('Đã xoá chuyển hướng');
      void qc.invalidateQueries({ queryKey: ['redirects'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = async () => {
    if (!editing) return;
    if (!editing.fromPath.trim()) return toast.error('Vui lòng nhập đường dẫn nguồn');
    if (editing.statusCode !== 410 && !editing.toPath.trim()) return toast.error('Vui lòng nhập đích chuyển hướng');
    await save.mutateAsync({ ...editing, toPath: editing.statusCode === 410 ? editing.toPath || '/' : editing.toPath });
    toast.success(editing.id ? 'Đã cập nhật chuyển hướng' : 'Đã thêm chuyển hướng');
    setEditing(null);
  };

  const columns: Column<Redirect>[] = [
    {
      key: 'path',
      header: 'Đường dẫn',
      cell: (r) => (
        <button type="button" className="flex min-w-0 max-w-full items-center gap-2 text-left" onClick={() => setEditing({ ...r })}>
          <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{r.fromPath}</code>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          {r.statusCode === 410 ? <span className="text-xs text-muted-foreground">(đã xoá)</span> : <code className="truncate text-xs text-primary">{r.toPath}</code>}
        </button>
      ),
    },
    {
      key: 'statusCode',
      header: 'Mã',
      cell: (r) => (
        <Badge variant="outline" className={cn('font-mono', r.statusCode === 410 ? 'text-red-600 dark:text-red-400' : r.statusCode === 301 || r.statusCode === 308 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
          {r.statusCode}
        </Badge>
      ),
    },
    { key: 'hits', header: 'Lượt truy cập', cell: (r) => <span className="tabular-nums">{r.hits.toLocaleString('vi-VN')}</span> },
    { key: 'createdAt', header: 'Ngày tạo', cell: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(r.createdAt)}</span> },
    {
      key: 'isActive',
      header: 'Bật',
      cell: (r) => <Switch checked={r.isActive} onCheckedChange={(v) => save.mutate({ id: r.id, fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode, isActive: v })} aria-label="Bật/tắt" />,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditing({ ...r })}>
              <Pencil /> Chỉnh sửa
            </DropdownMenuItem>
            {/* thử chuyển hướng cần biết địa chỉ website — ẩn khi chưa cấu hình */}
            {HAS_WEB_URL && (
              <DropdownMenuItem asChild>
                <a href={`${WEB_URL}${r.fromPath}`} target="_blank" rel="noreferrer">
                  <ExternalLink /> Thử chuyển hướng
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                if (await confirm({ title: `Xoá chuyển hướng ${r.fromPath}?`, destructive: true, confirmText: 'Xoá' })) remove.mutate(r.id);
              }}
            >
              <Trash2 /> Xoá
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <ListToolbar
        search={search}
        onSearchChange={(v) => {
          // đổi từ khoá → danh sách khác, bỏ chọn để không thao tác nhầm mục đang ẩn
          setSelected([]);
          onSearch(v);
        }}
        placeholder="Tìm đường dẫn..."
        selectedCount={selected.length}
        onClearSelection={() => setSelected([])}
        bulkActions={
          <>
            <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkToggle(true)}>
              <Eye /> Bật
            </Button>
            <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkToggle(false)}>
              <EyeOff /> Tắt
            </Button>
            <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={bulkRemove}>
              <Trash2 /> Xoá
            </Button>
          </>
        }
        filters={
          <Button className="ml-auto" onClick={() => setEditing({ fromPath: '', toPath: '', statusCode: 301, isActive: true })}>
            <Plus /> Thêm chuyển hướng
          </Button>
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
        // bật/tắt hàng loạt cần dữ liệu dòng đang hiển thị → bỏ chọn khi sang trang
        onPageChange={(p) => {
          setSelected([]);
          onPage(p);
        }}
        onLimitChange={onLimit}
        emptyTitle="Chưa có chuyển hướng"
        emptyDescription="Dùng chuyển hướng 301 khi đổi đường dẫn để giữ thứ hạng tìm kiếm và tránh lỗi 404."
        emptyAction={
          <Button size="sm" onClick={() => setEditing({ fromPath: '', toPath: '', statusCode: 301, isActive: true })}>
            <Plus /> Thêm chuyển hướng
          </Button>
        }
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Sửa chuyển hướng' : 'Thêm chuyển hướng'}</DialogTitle>
            <DialogDescription>Đường dẫn tương đối trên website/frontend, vd: /san-pham-cu → /san-pham/moi</DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              id="redirect-form"
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <Field label="Từ đường dẫn" required help="Có thể dán URL đầy đủ, hệ thống tự lấy phần đường dẫn">
                <Input value={editing.fromPath} onChange={(e) => setEditing({ ...editing, fromPath: e.target.value })} placeholder="/duong-dan-cu" className="font-mono text-sm" autoFocus />
              </Field>
              <Field label="Kiểu chuyển hướng">
                <Select value={String(editing.statusCode)} onValueChange={(v) => setEditing({ ...editing, statusCode: Number(v) })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_CODES.map((s) => (
                      <SelectItem key={s.value} value={String(s.value)}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {editing.statusCode !== 410 && (
                <Field label="Đến" required help="Đường dẫn nội bộ (/blog/bai-moi) hoặc URL tuyệt đối (https://...)">
                  <Input value={editing.toPath} onChange={(e) => setEditing({ ...editing, toPath: e.target.value })} placeholder="/duong-dan-moi" className="font-mono text-sm" />
                </Field>
              )}
              <div className="flex items-center justify-between rounded-lg border p-3">
                <Label>Kích hoạt</Label>
                <Switch checked={editing.isActive} onCheckedChange={(v) => setEditing({ ...editing, isActive: v })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Huỷ
            </Button>
            <Button type="submit" form="redirect-form" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface Check {
  key: string;
  title: string;
  /** Mô tả khi đạt */
  pass: string;
  description: string;
  count?: number;
  ok: boolean;
  severity: 'error' | 'warning' | 'info';
  href: string;
  action: string;
  icon: React.ElementType;
}

function AuditTab() {
  const { can } = useAuth();
  const audit = useQuery({ queryKey: ['seo-audit'], queryFn: () => api.get<Audit>('/admin/seo/audit') });
  const seo = useSettingGroup<SeoSettings>('seo', can('settings.manage'));
  const a = audit.data;
  const s = seo.data;

  const checks: Check[] = a
    ? [
        ...(s
          ? [
              { key: 'noindex', title: 'Toàn bộ website đang chặn lập chỉ mục', pass: 'Website cho phép lập chỉ mục', description: 'Tuỳ chọn “Không cho công cụ tìm kiếm lập chỉ mục” đang bật. Google sẽ không hiển thị website.', ok: !s.noindexSite, severity: 'error' as const, href: '/settings?tab=seo', action: 'Mở cài đặt SEO', icon: AlertTriangle },
              { key: 'desc', title: 'Chưa có mô tả mặc định', pass: 'Đã có mô tả meta mặc định', description: 'Mô tả meta mặc định dùng cho các trang chưa nhập mô tả riêng.', ok: Object.values((s.defaultDescription ?? {}) as Record<string, string>).some(Boolean), severity: 'warning' as const, href: '/settings?tab=seo', action: 'Mở cài đặt SEO', icon: FileText },
              { key: 'og', title: 'Chưa có ảnh chia sẻ mặc định', pass: 'Đã có ảnh chia sẻ mặc định', description: 'Ảnh OG hiển thị khi chia sẻ link lên Facebook, Zalo... nếu nội dung không có ảnh.', ok: !!s.defaultOgImage, severity: 'warning' as const, href: '/settings?tab=seo', action: 'Mở cài đặt SEO', icon: ImageIcon },
            ]
          : []),
        { key: 'pagesNoDesc', title: 'Trang thiếu mô tả SEO', pass: 'Mọi trang đều có mô tả SEO', description: 'Bản dịch trang đã xuất bản chưa có meta description.', count: a.pagesNoDesc, ok: !a.pagesNoDesc, severity: 'warning', href: '/pages', action: 'Xem trang', icon: FileText },
        { key: 'postsNoDesc', title: 'Bài viết thiếu mô tả SEO', pass: 'Mọi bài viết đều có mô tả SEO', description: 'Bản dịch bài viết đã xuất bản chưa có meta description.', count: a.postsNoDesc, ok: !a.postsNoDesc, severity: 'warning', href: '/posts?status=PUBLISHED', action: 'Xem bài viết', icon: Newspaper },
        { key: 'productsNoDesc', title: 'Sản phẩm thiếu mô tả SEO', pass: 'Mọi sản phẩm đều có mô tả SEO', description: 'Bản dịch sản phẩm đang bán chưa có meta description.', count: a.productsNoDesc, ok: !a.productsNoDesc, severity: 'warning', href: '/products?status=PUBLISHED', action: 'Xem sản phẩm', icon: Package },
        { key: 'productsNoImage', title: 'Sản phẩm chưa có ảnh đại diện', pass: 'Mọi sản phẩm đều có ảnh', description: 'Sản phẩm không có ảnh làm giảm tỉ lệ nhấp và không hiển thị trong Google Shopping.', count: a.productsNoImage, ok: !a.productsNoImage, severity: 'error', href: '/products?status=PUBLISHED', action: 'Xem sản phẩm', icon: Package },
        { key: 'postsNoImage', title: 'Bài viết chưa có ảnh đại diện', pass: 'Mọi bài viết đều có ảnh đại diện', description: 'Ảnh đại diện được dùng làm ảnh chia sẻ mạng xã hội và kết quả tìm kiếm.', count: a.postsNoImage, ok: !a.postsNoImage, severity: 'warning', href: '/posts?status=PUBLISHED', action: 'Xem bài viết', icon: Newspaper },
        { key: 'mediaNoAlt', title: 'Ảnh thiếu văn bản thay thế (alt)', pass: 'Mọi ảnh đều có văn bản thay thế', description: 'Alt giúp Google hiểu nội dung ảnh và hỗ trợ người khiếm thị.', count: a.mediaNoAlt, ok: !a.mediaNoAlt, severity: 'info', href: '/media', action: 'Mở thư viện media', icon: ImageIcon },
      ]
    : [];
  const issues = checks.filter((c) => !c.ok);
  const passed = checks.filter((c) => c.ok);
  const score = checks.length ? Math.round((passed.length / checks.length) * 100) : 0;

  if (audit.isLoading) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <div className={cn('flex size-16 items-center justify-center rounded-full border-4 text-lg font-bold', score >= 80 ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400' : score >= 50 ? 'border-amber-500 text-amber-600 dark:text-amber-400' : 'border-red-500 text-red-600 dark:text-red-400')}>{score}</div>
        <div className="flex-1">
          <div className="font-semibold">Điểm SEO tổng quan</div>
          <p className="text-sm text-muted-foreground">
            {issues.length ? `${issues.length} vấn đề cần xử lý · ${passed.length} mục đạt yêu cầu` : 'Tuyệt vời! Không phát hiện vấn đề nào.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
          <RefreshCw className={cn(audit.isFetching && 'animate-spin')} /> Kiểm tra lại
        </Button>
      </div>

      {issues.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {issues.map((c) => (
            <div key={c.key} className={cn('flex gap-3 rounded-xl border bg-card p-4', c.severity === 'error' ? 'border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20' : c.severity === 'warning' ? 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20' : 'border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/20')}>
              <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', c.severity === 'error' ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' : c.severity === 'warning' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400' : 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400')}>
                <c.icon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.title}</span>
                  {c.count != null && <Badge variant="secondary">{c.count}</Badge>}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{c.description}</p>
                <Button variant="link" size="sm" className="mt-1 h-auto px-0" asChild>
                  <Link href={c.href}>
                    {c.action} <ArrowRight />
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {passed.length > 0 && (
        <Section title="Đã đạt">
          <ul className="grid gap-2 sm:grid-cols-2">
            {passed.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" /> {c.pass}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function SitemapTab() {
  const { can } = useAuth();
  const seo = useSettingGroup<SeoSettings>('seo', can('settings.manage'));
  const links = [
    { label: 'Sitemap XML', url: `${WEB_URL}/sitemap.xml`, icon: FileCode2, desc: 'Gửi URL này cho Google Search Console và Bing Webmaster Tools. Sitemap tự cập nhật khi nội dung thay đổi.' },
    { label: 'robots.txt', url: `${WEB_URL}/robots.txt`, icon: FileText, desc: 'Hướng dẫn bot tìm kiếm trang nào được phép thu thập. Nội dung chỉnh trong Cài đặt → SEO.' },
  ];
  const copy = (url: string) => {
    void navigator.clipboard.writeText(url);
    toast.success('Đã copy');
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {/* sitemap.xml / robots.txt do website/frontend riêng phục vụ — chưa cấu hình địa chỉ thì chỉ ghi chú */}
        {!HAS_WEB_URL && (
          <p className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
            sitemap.xml và robots.txt do website/frontend riêng phục vụ (lấy dữ liệu từ API). Đặt <code className="font-mono text-xs">NEXT_PUBLIC_WEB_URL</code> cho trang quản trị để hiện địa chỉ đầy đủ tại đây.
          </p>
        )}
        {HAS_WEB_URL && links.map((l) => (
          <div key={l.url} className="flex flex-wrap items-start gap-3 rounded-xl border bg-card p-4">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <l.icon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{l.label}</div>
              <p className="text-sm text-muted-foreground">{l.desc}</p>
              <div className="mt-2 flex items-center gap-1">
                <Input readOnly value={l.url} className="h-8 max-w-md font-mono text-xs" />
                <Button size="icon-sm" variant="outline" onClick={() => copy(l.url)} aria-label="Copy">
                  <Copy />
                </Button>
                <Button size="icon-sm" variant="outline" asChild>
                  <a href={l.url} target="_blank" rel="noreferrer" aria-label="Mở">
                    <ExternalLink />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        ))}
        {seo.data && (
          <Section title="Nội dung robots.txt hiện tại" actions={<Link href="/settings?tab=seo" className="text-xs text-primary">Chỉnh sửa</Link>}>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{seo.data.robotsTxt || '(trống)'}</pre>
            {seo.data.noindexSite && (
              <p className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <AlertTriangle className="size-4" /> Đang bật chặn lập chỉ mục toàn site — robots.txt sẽ chặn mọi bot.
              </p>
            )}
          </Section>
        )}
      </div>
      <Section title="Cấu hình liên quan">
        <div className="space-y-2 text-sm">
          {[
            { href: '/settings?tab=seo', label: 'Cài đặt SEO chung', desc: 'Mẫu tiêu đề, mô tả mặc định, robots.txt, mã xác minh' },
            { href: '/settings?tab=general', label: 'Địa chỉ website', desc: 'URL gốc dùng trong sitemap & canonical' },
            { href: '/languages', label: 'Ngôn ngữ', desc: 'Sitemap tự sinh hreflang cho từng ngôn ngữ' },
          ].map((l) => (
            <Link key={l.href} href={l.href} className="flex items-center gap-3 rounded-lg border p-3 transition hover:border-primary/40 hover:bg-muted/50">
              <Settings className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{l.label}</div>
                <div className="text-xs text-muted-foreground">{l.desc}</div>
              </div>
              <ArrowRight className="size-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </Section>
    </div>
  );
}

export default function SeoPage() {
  return (
    <Suspense>
      <SeoContent />
    </Suspense>
  );
}
