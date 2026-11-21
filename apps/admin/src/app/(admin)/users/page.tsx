'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Film, Lock, LockOpen, LogOut, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { UserAvatar } from '@/components/users/user-avatar';
import { UserAiTasksDialog, type UserAiTasksTarget } from '@/components/users/user-ai-tasks-dialog';
import type { RoleOption } from '@/components/users/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { LockUserDialog } from '@/components/users/lock-user-dialog';
import { DeleteUserDialog } from '@/components/users/delete-user-dialog';

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: string;
  avatar: { url: string; urls: Record<string, string> } | null;
  role: { id: string; name: string; slug: string };
  lastLoginAt: string | null;
  /** Số dư ví (VND) — cũng là số tiền dùng để chạy công cụ AI */
  walletBalance: number;
  /** Chiết khấu giảm giá riêng (%) cho toàn bộ sản phẩm / công cụ AI */
  customDiscount: number;
  /** Tổng tiền (VND) đã chi chạy công cụ AI (đã trừ phần được hoàn) */
  creditsUsed: number;
  /** Tổng tiền (VND) đã cộng vào ví qua mua gói nạp tiền */
  creditsPurchased: number;
  /** Tổng tiền thật (VND) đã nạp vào ví qua cổng thanh toán / thẻ cào */
  totalDeposit: number;
  /** Tổng số đơn hàng đã chạy công cụ AI của thành viên */
  aiTasksCount?: number;
  createdAt: string;
  _count: { orders: number };
}

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Hoạt động' },
  { value: 'INACTIVE', label: 'Ngừng hoạt động' },
  { value: 'PENDING', label: 'Chờ duyệt' },
  { value: 'BANNED', label: 'Bị khoá' },
];

/** Các kiểu sắp xếp chọn nhanh, giá trị dạng "<cột>:<chiều>" ứng với tham số sort/order của API */
const SORT_OPTIONS = [
  { value: 'createdAt:desc', label: 'Mới tham gia nhất' },
  { value: 'createdAt:asc', label: 'Tham gia lâu nhất' },
  { value: 'aiTasksCount:desc', label: 'Đơn chạy AI nhiều → ít' },
  { value: 'walletBalance:desc', label: 'Số dư cao → thấp' },
  { value: 'walletBalance:asc', label: 'Số dư thấp → cao' },
  { value: 'totalDeposit:desc', label: 'Tổng nạp cao → thấp' },
  { value: 'totalDeposit:asc', label: 'Tổng nạp thấp → cao' },
];

function UsersList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can, user: me } = useAuth();
  const { params, set, page, limit } = useListParams({ type: '', roleId: '', status: '', search: '', sort: 'createdAt', order: 'desc' });

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['users', params], queryFn: () => api.get<Paginated<UserRow>>('/admin/users', { ...params, page, limit }),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles') });
  // các thành viên đang được tích chọn để thao tác hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  // thành viên đang mở hộp thoại khoá tạm thời / xoá vĩnh viễn
  const [dialog, setDialog] = useState<{ type: 'lock' | 'delete'; id: string; name: string } | null>(null);
  // thành viên đang mở popup xem danh sách Đơn chạy AI (T-448 / T-449)
  const [tasksTarget, setTasksTarget] = useState<UserAiTasksTarget | null>(null);

  /** Thao tác hàng loạt qua POST /admin/users/bulk — server xử lý từng người và trả về các mục lỗi */
  const bulk = useMutation({
    mutationFn: (body: { ids: string[]; action: string; status?: string; roleId?: string }) => api.post<{ ok: number; failed: { id: string; message: string }[] }>('/admin/users/bulk', body),
    onSuccess: (res, body) => {
      // nhãn thông báo theo từng loại thao tác
      const label = { delete: 'Đã xoá', unlock: 'Đã mở khoá', 'revoke-sessions': 'Đã đăng xuất' }[body.action] ?? 'Đã cập nhật';
      if (res.ok) toast.success(`${label} ${res.ok} thành viên`);
      if (res.failed.length) {
        const messages = [...new Set(res.failed.map((f) => f.message))].slice(0, 3).join('; ');
        toast.error(`${res.failed.length} thành viên không xử lý được: ${messages}`);
      }
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  /** Hỏi xác nhận cho thao tác nhạy cảm rồi gửi yêu cầu hàng loạt */
  const runBulk = async (action: string, extra: { status?: string; roleId?: string } = {}, ask?: { title: string; description?: string; destructive?: boolean; confirmText?: string }) => {
    if (ask && !(await confirm(ask))) return;
    bulk.mutate({ ids: selected, action, ...extra });
  };
  const n = selected.length;

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/revoke-sessions`),
    onSuccess: () => toast.success('Đã đăng xuất thành viên khỏi mọi thiết bị'),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      header: 'Thành viên',
      sortable: true,
      cell: (r) => (
        <Link href={`/users/${r.id}`} className="group flex items-center gap-3">
          <UserAvatar name={r.name} avatar={r.avatar} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate font-medium group-hover:text-primary">
              {r.name}
              {r.id === me?.id && <span className="text-xs font-normal text-muted-foreground">(bạn)</span>}
            </div>
            <div className="truncate text-xs text-muted-foreground">{r.email}</div>
          </div>
        </Link>
      ),
    },
    {
      key: 'aiTasksCount',
      header: 'Đơn chạy AI',
      sortable: true,
      cell: (r) => {
        const totalTasks = Number(r.aiTasksCount ?? 0);
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTasksTarget({ id: r.id, name: r.name, email: r.email, aiTasksCount: totalTasks });
            }}
            title={`Xem toàn bộ đơn chạy AI của ${r.name}`}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold whitespace-nowrap tabular-nums transition ${
              totalTasks > 0
                ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground'
                : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Film className="size-3.5 shrink-0" />
            {totalTasks.toLocaleString('vi-VN')} đơn
          </button>
        );
      },
    },
    { key: 'phone', header: 'Điện thoại', cell: (r) => <span className="whitespace-nowrap text-sm">{r.phone || <span className="text-muted-foreground">—</span>}</span> },
    {
      key: 'role',
      header: 'Vai trò',
      cell: (r) => (
        <Badge variant={r.role.slug === 'customer' ? 'outline' : 'secondary'} className="gap-1">
          {r.role.slug !== 'customer' && <ShieldCheck className="size-3" />}
          {r.role.name}
        </Badge>
      ),
    },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'customDiscount',
      header: 'Chiết khấu',
      cell: (r) =>
        Number(r.customDiscount) > 0 ? (
          <Badge variant="secondary" className="border-emerald-200 bg-emerald-50 font-semibold text-emerald-700 tabular-nums dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
            -{Number(r.customDiscount)}%
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    // Số dư ví của thành viên (VND) — cũng là số tiền dùng để chạy công cụ AI
    {
      key: 'walletBalance',
      header: 'Số dư ví',
      sortable: true,
      cell: (r) => (
        <span className={`whitespace-nowrap font-medium tabular-nums ${Number(r.walletBalance) > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
          {formatMoney(r.walletBalance)}
        </span>
      ),
    },
    // Tổng tiền thật (VND) đã nạp vào ví qua cổng thanh toán / thẻ cào — không tính admin cộng tay
    {
      key: 'totalDeposit',
      header: 'Tổng nạp',
      sortable: true,
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{formatMoney(r.totalDeposit)}</span>,
    },
    // Tổng tiền (VND) thành viên đã chi chạy công cụ AI (đã trừ phần được hoàn)
    {
      key: 'creditsUsed',
      header: 'Đã chi chạy AI',
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{formatMoney(r.creditsUsed)}</span>,
    },
    // Tổng tiền (VND) đã cộng vào ví qua mua gói nạp tiền
    {
      key: 'creditsPurchased',
      header: 'Tổng nạp qua gói',
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{formatMoney(r.creditsPurchased)}</span>,
    },
    {
      key: 'lastLoginAt',
      header: 'Đăng nhập lần cuối',
      sortable: true,
      cell: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground" title={formatDate(r.lastLoginAt)}>{r.lastLoginAt ? timeAgo(r.lastLoginAt) : 'Chưa đăng nhập'}</span>,
    },
    { key: 'createdAt', header: 'Ngày tham gia', sortable: true, cell: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(r.createdAt, 'dd/MM/yyyy')}</span> },
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
            <DropdownMenuItem asChild>
              <Link href={`/users/${r.id}`}>
                <Pencil /> {can('users.write') ? 'Chỉnh sửa' : 'Xem chi tiết'}
              </Link>
            </DropdownMenuItem>
            {can('users.write') && r.id !== me?.id && (
              <DropdownMenuItem
                onClick={async () => {
                  if (await confirm({ title: `Đăng xuất ${r.name} khỏi mọi thiết bị?`, description: 'Thành viên sẽ phải đăng nhập lại.' })) revoke.mutate(r.id);
                }}
              >
                <LogOut /> Thu hồi phiên đăng nhập
              </DropdownMenuItem>
            )}
            {can('users.write') && r.id !== me?.id && (
              <DropdownMenuItem onClick={() => setDialog({ type: 'lock', id: r.id, name: r.name })}>
                <Lock /> Khoá tạm thời
              </DropdownMenuItem>
            )}
            {can('users.delete') && r.id !== me?.id && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDialog({ type: 'delete', id: r.id, name: r.name })}>
                  <Trash2 /> Xoá
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Thành viên"
        description="Quản trị viên, nhân viên và khách hàng"
        actions={
          <>
            {can('roles.manage') && (
              <Button variant="outline" asChild>
                <Link href="/users/roles">
                  <ShieldCheck /> Vai trò & quyền
                </Link>
              </Button>
            )}
            {can('users.write') && (
              <Button asChild>
                <Link href="/users/new">
                  <Plus /> Thêm thành viên
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <StatusTabs
          value={params.type}
          onChange={(v) => set({ type: v, roleId: '' })}
          options={[
            { value: '', label: 'Tất cả' },
            { value: 'staff', label: 'Nhân viên' },
            { value: 'customer', label: 'Khách hàng' },
          ]}
        />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo tên, email, SĐT..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            can('users.write') || can('users.delete') ? (
              <>
                {can('users.write') && (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline" disabled={bulk.isPending}>
                          Trạng thái <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {STATUS_OPTIONS.map((o) => (
                          <DropdownMenuItem
                            key={o.value}
                            onClick={() =>
                              void runBulk('status', { status: o.value }, o.value === 'ACTIVE' ? undefined : { title: `Chuyển ${n} thành viên sang "${o.label}"?`, description: 'Các thành viên này sẽ bị đăng xuất khỏi mọi thiết bị.' })
                            }
                          >
                            <StatusBadge status={o.value} />
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline" disabled={bulk.isPending}>
                          <UserCog /> Vai trò <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Gán vai trò cho {n} thành viên</DropdownMenuLabel>
                        {roles.data?.map((r) => (
                          <DropdownMenuItem key={r.id} onClick={() => void runBulk('role', { roleId: r.id }, { title: `Gán vai trò "${r.name}" cho ${n} thành viên?` })}>
                            {r.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline" disabled={bulk.isPending}>
                          Khác <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuItem onClick={() => void runBulk('unlock')}>
                          <LockOpen /> Mở khoá đăng nhập sai
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void runBulk('revoke-sessions', {}, { title: `Đăng xuất ${n} thành viên khỏi mọi thiết bị?`, description: 'Thành viên sẽ phải đăng nhập lại.' })}>
                          <LogOut /> Thu hồi phiên đăng nhập
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {can('users.delete') && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={bulk.isPending}
                    onClick={() =>
                      void runBulk('delete', {}, { title: `Xoá vĩnh viễn ${n} thành viên?`, description: 'Tài khoản bị xoá hẳn, không thể khôi phục, kèm phiên, địa chỉ, ví, giỏ hàng, đánh giá, bình luận, nhật ký. Đơn hàng, bài viết và media được giữ lại. Muốn chọn chi tiết dữ liệu xoá kèm, hãy xoá từng thành viên.', destructive: true, confirmText: 'Xoá vĩnh viễn' })
                    }
                  >
                    <Trash2 /> Xoá
                  </Button>
                )}
              </>
            ) : undefined
          }
          filters={
            <>
              <Select value={params.roleId || 'all'} onValueChange={(v) => set({ roleId: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Vai trò" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả vai trò</SelectItem>
                  {roles.data
                    ?.filter((r) => (params.type === 'customer' ? r.slug === 'customer' : params.type === 'staff' ? r.slug !== 'customer' : true))
                    .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select value={params.status || 'all'} onValueChange={(v) => set({ status: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Trạng thái" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả trạng thái</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* sắp xếp nhanh; bấm tiêu đề cột cũng đổi được — kiểu không có trong danh sách thì hiện chữ gợi ý */}
              <Select value={SORT_OPTIONS.some((o) => o.value === `${params.sort}:${params.order}`) ? `${params.sort}:${params.order}` : ''} onValueChange={(v) => {
                const [sort, order] = v.split(':');
                set({ sort, order });
              }}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Sắp xếp" />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          selectable={can('users.write') || can('users.delete')}
          selected={selected}
          onSelectedChange={setSelected}
          sort={{ key: params.sort, order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ sort: s.key, order: s.order })}
          emptyTitle="Không tìm thấy thành viên"
          emptyAction={
            can('users.write') ? (
              <Button asChild size="sm">
                <Link href="/users/new">
                  <Plus /> Thêm thành viên
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>

      {dialog?.type === 'lock' && (
        <LockUserDialog
          userId={dialog.id}
          userName={dialog.name}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
      {dialog?.type === 'delete' && (
        <DeleteUserDialog
          userId={dialog.id}
          onClose={() => setDialog(null)}
          onLockInstead={can('users.write') ? () => setDialog({ ...dialog, type: 'lock' }) : undefined}
          onDone={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
      <UserAiTasksDialog target={tasksTarget} onClose={() => setTasksTarget(null)} />
    </>
  );
}

export default function UsersPage() {
  return (
    <Suspense>
      <UsersList />
    </Suspense>
  );
}
