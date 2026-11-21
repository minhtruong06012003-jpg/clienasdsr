'use client';

/**
 * Tab Nhật ký đăng nhập: lọc theo email/IP, kết quả, khu vực; bảng phân trang server-side
 * (tái sử dụng DataTable + ListToolbar dùng chung), chặn nhanh IP ngay trên từng dòng.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, HelpCircle, Loader2, Monitor, Smartphone, Tablet, XCircle } from 'lucide-react';
import { LOGIN_FAIL_LABELS, type LoginAttemptView } from '@cmsnt/shared';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { SECURITY_KEYS, ToneBadge, useQuickBlockIp } from './shared';

/** Nhãn phương thức đăng nhập thành công */
const METHOD_LABELS: Record<NonNullable<LoginAttemptView['method']>, string> = {
  password: 'Mật khẩu',
  totp: '2FA',
  recovery: 'Mã dự phòng',
  // đăng nhập bằng tài khoản Google (POST /api/auth/google)
  google: 'Google',
};

/** Icon theo loại thiết bị */
const DEVICE_ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet, unknown: HelpCircle } as const;

export function LoginAttemptsTab() {
  const sp = useSearchParams();
  // cho phép mở sẵn bộ lọc qua URL (vd từ bảng "IP đăng nhập sai nhiều nhất": ?tab=logins&search=1.2.3.4)
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const [result, setResult] = useState('all');
  const [area, setArea] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  // tăng khi bấm lọc theo IP trên bảng để ô tìm kiếm nạp lại giá trị mới (không remount khi đang gõ)
  const [toolbarKey, setToolbarKey] = useState(0);
  const { block, pendingIp } = useQuickBlockIp();

  const query = { page, limit, search: search.trim() || undefined, result: result === 'all' ? undefined : result, area: area === 'all' ? undefined : area };
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: [...SECURITY_KEYS.loginAttempts, query],
    queryFn: () => api.get<Paginated<LoginAttemptView>>('/admin/security/login-attempts', query),
    placeholderData: keepPreviousData,
  });

  const columns: Column<LoginAttemptView>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
     
      cell: (r) => (
        <div className="whitespace-nowrap">
          <p className="text-sm">{formatDate(r.createdAt, 'dd/MM/yyyy HH:mm:ss')}</p>
          <p className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'account',
      header: 'Tài khoản',
     
      cell: (r) => (
        <div className="min-w-0 max-w-64">
          <p className="truncate text-sm font-medium" title={r.email}>
            {r.email || '—'}
          </p>
          {r.user ? (
            <Link href={`/users/${r.user.id}`} className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
              {r.user.name}
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground">Không khớp tài khoản</p>
          )}
          {/* điện thoại: thời gian gộp dưới tài khoản vì cột riêng bị ẩn */}
          <p className="text-[11px] text-muted-foreground md:hidden">{formatDate(r.createdAt, 'dd/MM/yyyy HH:mm:ss')}</p>
        </div>
      ),
    },
    {
      key: 'result',
      header: 'Kết quả',
      cell: (r) =>
        r.success ? (
          <ToneBadge tone="green">
            <CheckCircle2 /> Thành công{r.method ? ` · ${METHOD_LABELS[r.method]}` : ''}
          </ToneBadge>
        ) : (
          <ToneBadge tone="red" title={r.reason ? LOGIN_FAIL_LABELS[r.reason] : undefined}>
            <XCircle /> {r.reason ? LOGIN_FAIL_LABELS[r.reason] : 'Thất bại'}
          </ToneBadge>
        ),
    },
    {
      key: 'area',
      header: 'Khu vực',
      cell: (r) => <ToneBadge tone={r.area === 'admin' ? 'violet' : 'sky'}>{r.area === 'admin' ? 'Quản trị' : 'Website'}</ToneBadge>,
    },
    {
      key: 'ip',
      header: 'IP',
      cell: (r) =>
        r.ip ? (
          <div className="flex items-center gap-1">
            <button type="button" className="font-mono text-xs hover:underline" title="Lọc theo IP này" onClick={() => {
                setSearch(r.ip!);
                setPage(1);
                setToolbarKey((k) => k + 1);
              }}>
              {r.ip}
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
              title="Chặn IP này 24 giờ"
              aria-label={`Chặn IP ${r.ip}`}
              disabled={pendingIp === r.ip}
              onClick={(e) => {
                e.stopPropagation();
                block(r.ip!);
              }}
            >
              {pendingIp === r.ip ? <Loader2 className="animate-spin" /> : <Ban />}
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'device',
      header: 'Thiết bị',
      cell: (r) => {
        const Icon = DEVICE_ICONS[r.device] ?? HelpCircle;
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <Icon className="size-3.5 shrink-0" />
            {[r.browser, r.os].filter(Boolean).join(' · ') || 'Không rõ'}
          </span>
        );
      },
    },
  ];

  const filtered = !!(search.trim() || result !== 'all' || area !== 'all');

  return (
    <div className="space-y-4">
      <ListToolbar
        key={toolbarKey}
        search={search}
        onSearchChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
        placeholder="Tìm theo email hoặc đầu IP..."
        filters={
          <>
            <Select
              value={result}
              onValueChange={(v) => {
                setResult(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Kết quả">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi kết quả</SelectItem>
                <SelectItem value="success">Thành công</SelectItem>
                <SelectItem value="failed">Thất bại</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={area}
              onValueChange={(v) => {
                setArea(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Khu vực">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi khu vực</SelectItem>
                <SelectItem value="admin">Quản trị</SelectItem>
                <SelectItem value="site">Website</SelectItem>
              </SelectContent>
            </Select>
            {isFetching && !isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </>
        }
      />
      <DataTable
        columns={columns}
        data={data?.data}
        loading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        meta={data?.meta}
        onPageChange={setPage}
        onLimitChange={(n) => {
          setLimit(n);
          setPage(1);
        }}
        emptyTitle={filtered ? 'Không có lượt đăng nhập phù hợp' : 'Chưa có lượt đăng nhập nào'}
        emptyDescription={filtered ? 'Thử đổi từ khoá hoặc bộ lọc.' : 'Mọi lượt đăng nhập vào trang quản trị và website sẽ được ghi lại tại đây.'}
      />
    </div>
  );
}
