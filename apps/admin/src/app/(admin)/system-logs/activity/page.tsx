'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { AsyncCombobox, COMBOBOX_LIMIT } from '@/components/common/async-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage, qs, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { ACTION_GROUPS, describe, ENTITY } from '@/components/activity/activity-labels';
import { cn } from '@/lib/utils';

interface ActivityRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

/** Nhãn tiếng Việt cho khoá meta thường gặp */
const META_LABEL: Record<string, string> = {
  email: 'Email',
  name: 'Tên',
  key: 'Khoá',
  slug: 'Slug',
  group: 'Nhóm',
  keys: 'Trường đã đổi',
  location: 'Vị trí',
  action: 'Thao tác',
  count: 'Số lượng',
  files: 'File',
  pruned: 'Đã dọn',
  scheduled: 'Theo lịch',
  safetyBackup: 'Bản an toàn',
  ms: 'Thời gian (ms)',
  version: 'Phiên bản',
  from: 'Từ phiên bản',
  tags: 'Số tag',
  ok: 'Thành công',
  error: 'Lỗi',
  permissions: 'Số quyền',
  enabled: 'Bật',
  isDefault: 'Mặc định',
  locale: 'Ngôn ngữ',
  status: 'Trạng thái',
  title: 'Tiêu đề',
  // giao dịch thanh toán (payment.confirm / payment.overpaid) và xoá tài khoản (account.deleted)
  provider: 'Cổng',
  amount: 'Số tiền',
  expected: 'Số tiền cần',
  over: 'Thừa',
  purpose: 'Mục đích',
  transactionId: 'Mã giao dịch',
  method: 'Phương thức',
};

function metaValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Có' : 'Không';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function MetaList({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta ?? {});
  if (!entries.length) return <span className="text-xs text-muted-foreground">Không có chi tiết thêm</span>;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-muted-foreground">{META_LABEL[k] ?? k}</dt>
          <dd className="break-all font-mono">{metaValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

interface StaffUser {
  id: string;
  name: string;
  email: string;
}

function ActivityList() {
  const { params, set, page, limit } = useListParams({ search: '', entityType: '', userId: '', action: '', from: '', to: '' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['activity', params],
    queryFn: () => api.get<Paginated<ActivityRow>>('/admin/activity', { ...params, page, limit }),
  });
  const groups = useQuery({ queryKey: ['activity-actions'], queryFn: () => api.get<string[]>('/admin/activity/actions'), staleTime: 60_000 });

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { page: _p, limit: _l, ...filters } = params;
      await api.download(`/admin/activity${qs({ ...filters, export: 'csv' })}`, `activity-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const hasFilter = !!(params.userId || params.action || params.from || params.to || params.entityType || params.search);

  const columns: Column<ActivityRow>[] = [
    {
      key: 'expand',
      header: '',
      className: 'w-8 pr-0',
      cell: (r) => (
        <button type="button" onClick={() => toggle(r.id)} className="text-muted-foreground hover:text-foreground" aria-label="Chi tiết">
          {expanded.has(r.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ),
    },
    {
      key: 'createdAt',
      header: 'Thời gian',
      className: 'w-44',
      cell: (r) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="whitespace-nowrap text-sm">{timeAgo(r.createdAt)}</span>
          </TooltipTrigger>
          <TooltipContent>{formatDate(r.createdAt, 'dd/MM/yyyy HH:mm:ss')}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      key: 'user',
      header: 'Người dùng',
      cell: (r) =>
        r.user ? (
          <Link href={`/users/${r.user.id}`} className="group flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold uppercase text-primary">{r.user.name.charAt(0)}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium group-hover:text-primary">{r.user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{r.user.email}</span>
            </span>
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">Hệ thống</span>
        ),
    },
    {
      key: 'action',
      header: 'Hành động',
      cell: (r) => {
        const d = describe(r.action);
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge className={cn('border-transparent font-medium', d.verb.className)}>{d.verb.label}</Badge>
              <code className="text-xs text-muted-foreground">{r.action}</code>
            </div>
            {expanded.has(r.id) && (
              <div className="rounded-lg border bg-muted/40 p-2">
                <MetaList meta={r.meta} />
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'entity',
      header: 'Đối tượng',
      cell: (r) => {
        if (!r.entityType) return <span className="text-muted-foreground">—</span>;
        const e = ENTITY[r.entityType];
        const label = (
          <>
            <span className="font-medium">{e?.label ?? r.entityType}</span>
            {r.entityId && <span className="ml-1 font-mono text-xs text-muted-foreground">#{r.entityId.slice(0, 8)}</span>}
          </>
        );
        const extra = typeof r.meta?.email === 'string' ? <span className="ml-1 text-xs text-muted-foreground">({r.meta.email})</span> : null;
        return e?.href && r.entityId && r.action !== `${r.entityType}.delete` ? (
          <Link href={e.href(r.entityId)} className="text-sm hover:text-primary">
            {label}
            {extra}
          </Link>
        ) : (
          <span className="text-sm">
            {label}
            {extra}
          </span>
        );
      },
    },
    { key: 'ip', header: 'IP', cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ip ?? '—'}</span> },
  ];

  return (
    <>
      <SystemLogsHeader
        tab="activity"
        actions={
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? <Loader2 className="animate-spin" /> : <Download />} Xuất CSV
          </Button>
        }
      />
      <PageBody className="space-y-4">
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo hành động (vd: user.update)..."
          filters={
            <>
              <Select value={params.action || 'all'} onValueChange={(v) => set({ action: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Nhóm hành động" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả hành động</SelectItem>
                  {[...new Set([...Object.keys(ACTION_GROUPS), ...(groups.data ?? [])])].map((k) => (
                    <SelectItem key={k} value={k}>
                      {ACTION_GROUPS[k] ?? k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* lọc theo nhân viên: tìm phía server theo tên/email (không giới hạn 200 người như ô chọn nạp sẵn) */}
              <AsyncCombobox<StaffUser>
                value={params.userId}
                onChange={(userId) => set({ userId: userId ?? '' })}
                queryKey={['users', 'staff-options']}
                fetchOptions={(search) => api.get<Paginated<StaffUser>>('/admin/users', { type: 'staff', search: search || undefined, limit: COMBOBOX_LIMIT }).then((r) => r.data)}
                fetchSelected={(id) => api.get<StaffUser>(`/admin/users/${id}`)}
                getValue={(u) => u.id}
                getLabel={(u) => u.name}
                renderOption={(u) => (
                  <>
                    {u.name} <span className="text-muted-foreground">({u.email})</span>
                  </>
                )}
                noneLabel="Tất cả người dùng"
                searchPlaceholder="Tìm theo tên, email…"
                className="w-48"
              />
              <Select value={params.entityType || 'all'} onValueChange={(v) => set({ entityType: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Đối tượng" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả đối tượng</SelectItem>
                  {Object.entries(ENTITY)
                    .filter(([k]) => k !== 'auth' && k !== 'tools')
                    .map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Input type="date" value={params.from} onChange={(e) => set({ from: e.target.value })} className="w-36" aria-label="Từ ngày" />
                <span>→</span>
                <Input type="date" value={params.to} onChange={(e) => set({ to: e.target.value })} className="w-36" aria-label="Đến ngày" />
              </div>
              {hasFilter && (
                <Button variant="ghost" size="sm" onClick={() => set({ search: '', entityType: '', userId: '', action: '', from: '', to: '' })}>
                  <X /> Bỏ lọc
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
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle="Chưa có hoạt động nào"
        />
      </PageBody>
    </>
  );
}

export default function ActivityPage() {
  return (
    <Suspense>
      <ActivityList />
    </Suspense>
  );
}
