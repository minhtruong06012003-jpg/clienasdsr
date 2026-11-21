'use client';

/**
 * AI Studio › Cộng đồng (`/ai/community` — T-324, T-325):
 * Quản lý trực quan toàn bộ Video & Ảnh hiển thị ở mục "🌐 Cộng đồng" ngoài Trang chủ (Top 12) và trang `/community`.
 * - Xem dạng lưới thẻ trực quan y hệt ngoài website (hover xem thử video ngay, bấm mở phóng to).
 * - 1 chạm Ẩn video/ảnh rác hoặc trùng lặp, Ghim tác phẩm đẹp lên đầu Trang chủ, duyệt thêm từ Kho tác phẩm khách tạo,
 *   hoặc tải trực tiếp Video / Ảnh mẫu mới lên Cộng đồng.
 */
import { Suspense, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckSquare,
  Clock,
  Eye,
  EyeOff,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { Field } from '@/components/common/field';
import { PermissionGate, fmtCount } from '@/components/ai/shared';
import { AdminAiTaskDialog } from '@/components/ai/task-detail-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

type CommunityTab = 'public' | 'candidates' | 'blocked';
type MediaFilter = 'all' | 'video' | 'image';

interface CommunityAdminItem {
  id: string;
  code: string;
  toolKey: string;
  toolName: string;
  category: string;
  isPublic: boolean;
  publicBlocked: boolean;
  communityPending?: boolean;
  pinned: boolean;
  prompt: string;
  files: { url: string; type: string; name?: string }[];
  user: { id: string; name: string; email: string } | null;
  createdAt: string;
}

interface CommunityAdminResponse extends Paginated<CommunityAdminItem> {
  counts: {
    publicCount: number;
    candidatesCount: number;
    blockedCount: number;
    pinnedCount: number;
  };
  pinnedIds: string[];
}

interface PublicToolOption {
  key: string;
  name: string;
  category: string;
  badge?: string | null;
  output?: string;
}

function formatItemTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Date.now() - d.getTime() >= 45 * 60_000) {
    return formatDate(d, 'HH:mm dd/MM/yyyy');
  }
  return timeAgo(d);
}

function isVideoFile(file?: { url: string; type?: string }) {
  if (!file) return false;
  if (file.type === 'video') return true;
  return /\.(mp4|webm|mov)(\?|$)/i.test(file.url);
}

function CommunityAdminContent() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isChildSite = !!user?.isChildSite;

  const [tab, setTab] = useState<CommunityTab>('public');
  const [mediaType, setMediaType] = useState<MediaFilter>('all');
  const [tool, setTool] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 24;

  const [selected, setSelected] = useState<string[]>([]);
  const [previewItem, setPreviewItem] = useState<CommunityAdminItem | null>(null);
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  const [openUpload, setOpenUpload] = useState(false);

  const toolsQuery = useQuery({
    queryKey: ['public-ai-tools-options'],
    queryFn: () => api.get<PublicToolOption[]>('/public/ai/tools'),
    staleTime: 60_000,
  });

  const q = useQuery({
    placeholderData: keepPreviousData,
    staleTime: 3_000,
    queryKey: ['admin-ai-community', tab, mediaType, tool, search, page, limit],
    queryFn: () =>
      api.get<CommunityAdminResponse>('/admin/ai/community', {
        tab,
        mediaType: mediaType === 'all' ? undefined : mediaType,
        tool: tool === 'all' ? undefined : tool,
        search: search || undefined,
        page,
        limit,
      }),
  });

  const moderate = useMutation({
    mutationFn: (payload: { ids: string[]; action: 'publish' | 'unpublish' | 'hide' | 'pin' | 'unpin' | 'publish_pin'; label?: string }) =>
      api.post<{ ok: boolean; count: number }>('/admin/ai/community/moderate', {
        ids: payload.ids,
        action: payload.action,
      }),
    onSuccess: (_res, vars) => {
      toast.success(vars.label || `Đã cập nhật ${vars.ids.length} tác phẩm Cộng đồng`);
      setSelected((prev) => prev.filter((id) => !vars.ids.includes(id)));
      void qc.invalidateQueries({ queryKey: ['admin-ai-community'] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const items = q.data?.data ?? [];
  const counts = q.data?.counts ?? { publicCount: 0, candidatesCount: 0, blockedCount: 0, pinnedCount: 0 };
  const totalPages = Math.max(1, q.data?.meta.totalPages ?? 1);
  const isDefaultPublicView = tab === 'public' && page === 1 && mediaType === 'all' && tool === 'all' && !search;

  const pageIds = useMemo(() => items.map((x) => x.id), [items]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectPage = () => {
    if (allPageSelected) {
      setSelected((prev) => prev.filter((id) => !pageIds.includes(id)));
    } else {
      setSelected((prev) => [...new Set([...prev, ...pageIds])]);
    }
  };

  const switchTab = (next: CommunityTab) => {
    setTab(next);
    setPage(1);
    setSelected([]);
  };

  const applySearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
    setSelected([]);
  };

  return (
    <>
      <PageHeader
        title="Cộng đồng"
        description="Tách rõ 2 mục: Hiện lên Website (đã duyệt) và Chờ kiểm duyệt — ảnh/video khách tạo KHÔNG tự động đẩy lên Website khi chưa được duyệt."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
              Làm mới
            </Button>
            <Button size="sm" onClick={() => setOpenUpload(true)}>
              <Plus className="size-4" />
              Đăng Video / Ảnh mẫu
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-4">
        {/* Thanh 2 Mục chính: 1. Hiện lên Website | 2. Chờ kiểm duyệt (+ mục phụ Đã loại bỏ) */}
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => switchTab('public')}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-bold transition',
                  tab === 'public'
                    ? 'border-emerald-600 bg-emerald-600 text-white shadow-xs'
                    : 'border-border bg-muted/50 text-foreground hover:bg-muted',
                )}
              >
                <Globe className="size-4" />
                1. Hiện lên Website
                <span className={cn('rounded-full px-2 py-0.5 text-[11px]', tab === 'public' ? 'bg-white/20 text-white' : 'bg-background text-muted-foreground')}>
                  {fmtCount(counts.publicCount)}
                </span>
              </button>

              <button
                type="button"
                onClick={() => switchTab('candidates')}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-bold transition',
                  tab === 'candidates'
                    ? 'border-amber-500 bg-amber-500 text-white shadow-xs'
                    : 'border-amber-300/70 bg-amber-50/70 text-amber-900 hover:bg-amber-100/80 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200',
                )}
              >
                <Clock className="size-4" />
                2. Chờ kiểm duyệt
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px]',
                    tab === 'candidates' ? 'bg-white/25 text-white' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
                  )}
                >
                  {fmtCount(counts.candidatesCount)}
                </span>
              </button>

              <button
                type="button"
                onClick={() => switchTab('blocked')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
                  tab === 'blocked'
                    ? 'bg-slate-800 text-white shadow-xs dark:bg-slate-200 dark:text-slate-900'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <EyeOff className="size-3.5" />
                Đã loại bỏ ({fmtCount(counts.blockedCount)})
              </button>
            </div>

            {counts.pinnedCount > 0 && (
              <Badge className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
                <Pin className="mr-1 size-3" />
                Đang ghim {counts.pinnedCount} mục đầu trang
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Lọc loại file */}
            <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
              {(
                [
                  { key: 'all', label: 'Tất cả' },
                  { key: 'video', label: 'Video', icon: Film },
                  { key: 'image', label: 'Hình ảnh', icon: ImageIcon },
                ] as const
              ).map((m) => {
                const Icon = 'icon' in m ? m.icon : null;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setMediaType(m.key);
                      setPage(1);
                    }}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition',
                      mediaType === m.key ? 'bg-background text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {Icon ? <Icon className="size-3.5" /> : null}
                    {m.label}
                  </button>
                );
              })}
            </div>

            {/* Lọc công cụ AI */}
            <Select
              value={tool}
              onValueChange={(v) => {
                setTool(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 w-[220px] text-xs">
                <SelectValue placeholder="Tất cả công cụ AI" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả công cụ AI</SelectItem>
                {(toolsQuery.data ?? []).map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.badge ? `[${t.badge}] ` : ''}
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Tìm kiếm */}
            <form onSubmit={applySearch} className="flex min-w-[240px] flex-1 items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Tìm mã T..., tên/email khách (@duy...), công cụ hoặc prompt..."
                  className="h-8 pr-7 pl-8 text-xs"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setSearch('');
                      setPage(1);
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <Button type="submit" variant="secondary" size="sm" className="h-8 px-3 text-xs">
                Lọc
              </Button>
            </form>
          </div>

          {/* Thanh thao tác chọn nhiều */}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5 text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleSelectPage}
                  className="inline-flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground"
                >
                  {allPageSelected ? <CheckSquare className="size-4 text-primary" /> : <Square className="size-4" />}
                  {allPageSelected ? 'Bỏ chọn trang này' : 'Chọn tất cả trang này'}
                </button>
                {selected.length > 0 && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                    Đã chọn {selected.length} mục
                  </span>
                )}
              </div>

              {selected.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {tab === 'public' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'pin',
                            label: `Đã ghim ${selected.length} mục lên đầu Trang chủ & Cộng đồng`,
                          })
                        }
                      >
                        <Pin className="size-3.5 text-amber-600" />
                        Ghim đầu ({selected.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'unpin',
                            label: `Đã bỏ ghim ${selected.length} mục`,
                          })
                        }
                      >
                        <PinOff className="size-3.5" />
                        Bỏ ghim
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'unpublish',
                            label: `Đã chuyển ${selected.length} mục về Chờ kiểm duyệt`,
                          })
                        }
                      >
                        <Clock className="size-3.5 text-amber-600" />
                        Về Chờ duyệt ({selected.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'hide',
                            label: `Đã loại bỏ ${selected.length} mục khỏi Cộng đồng`,
                          })
                        }
                      >
                        <EyeOff className="size-3.5" />
                        Loại bỏ ({selected.length})
                      </Button>
                    </>
                  )}

                  {tab === 'candidates' && (
                    <>
                      <Button
                        size="sm"
                        className="h-7 gap-1 bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-700"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'publish',
                            label: `Đã duyệt ${selected.length} mục hiện lên Website`,
                          })
                        }
                      >
                        <Check className="size-3.5" />
                        Duyệt lên Website ({selected.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'publish_pin',
                            label: `Đã duyệt & ghim ${selected.length} mục lên đầu Trang chủ`,
                          })
                        }
                      >
                        <Pin className="size-3.5 text-amber-600" />
                        Duyệt & Ghim đầu ({selected.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 gap-1 px-2.5 text-xs"
                        disabled={moderate.isPending}
                        onClick={() =>
                          moderate.mutate({
                            ids: selected,
                            action: 'hide',
                            label: `Đã loại bỏ ${selected.length} mục khỏi hàng chờ duyệt`,
                          })
                        }
                      >
                        <EyeOff className="size-3.5" />
                        Loại bỏ ({selected.length})
                      </Button>
                    </>
                  )}

                  {tab === 'blocked' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2.5 text-xs"
                      disabled={moderate.isPending}
                      onClick={() =>
                        moderate.mutate({
                          ids: selected,
                          action: 'unpublish',
                          label: `Đã đưa ${selected.length} mục trở lại Chờ kiểm duyệt`,
                        })
                      }
                    >
                      <RotateCcw className="size-3.5 text-amber-600" />
                      Đưa về Chờ duyệt ({selected.length})
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setSelected([])}
                  >
                    Bỏ chọn
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Lưới thẻ Video & Ảnh trực quan */}
        {q.isLoading ? (
          <div className="flex min-h-[280px] items-center justify-center rounded-xl border bg-card">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Globe}
            title={
              tab === 'public'
                ? isChildSite
                  ? 'Website đang tự động hiển thị Cộng đồng mẫu từ hệ thống trung tâm'
                  : 'Chưa có tác phẩm nào đang hiện trên Cộng đồng'
                : tab === 'candidates'
                  ? 'Chưa có tác phẩm khách tạo nào phù hợp bộ lọc'
                  : 'Chưa có tác phẩm nào bị ẩn'
            }
            description={
              tab === 'public'
                ? 'Bạn có thể bấm "+ Đăng Video / Ảnh mẫu" để đưa tác phẩm nổi bật lên đầu Trang chủ hoặc chọn từ tab "Kho tác phẩm khách tạo".'
                : 'Thử đổi bộ lọc tìm kiếm hoặc chuyển sang tab khác.'
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {items.map((item, idx) => {
              const file = item.files[0];
              const isVid = isVideoFile(file);
              const isChecked = selected.includes(item.id);
              const homepageSlot = isDefaultPublicView && idx < 12 ? idx + 1 : null;
              const authorTag = item.user?.name?.trim().split(/\s+/).pop() || 'User';

              return (
                <div
                  key={item.id}
                  className={cn(
                    'group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-2xs transition hover:shadow-md',
                    isChecked && 'ring-2 ring-primary border-primary',
                    item.pinned && !isChecked && 'border-amber-400/80 dark:border-amber-600/70',
                  )}
                >
                  {/* Khung Media (hover tự phát video xem thử) */}
                  <div
                    className="relative aspect-[3/4] w-full cursor-pointer overflow-hidden bg-slate-950"
                    onClick={() => setPreviewItem(item)}
                    onMouseEnter={(e) => {
                      const v = e.currentTarget.querySelector('video');
                      if (v) void v.play().catch(() => undefined);
                    }}
                    onMouseLeave={(e) => {
                      const v = e.currentTarget.querySelector('video');
                      if (v) {
                        v.pause();
                        v.currentTime = 0.1;
                      }
                    }}
                  >
                    {file ? (
                      isVid ? (
                        <video
                          src={`${file.url}#t=0.1`}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <img
                          src={file.url}
                          alt={item.prompt || item.toolName}
                          loading="lazy"
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                        />
                      )
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-slate-400">Không có media</div>
                    )}

                    {/* Checkbox chọn nhiều góc trái trên */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(item.id);
                      }}
                      className={cn(
                        'absolute top-2 left-2 z-10 flex size-6 items-center justify-center rounded-md border backdrop-blur-xs transition',
                        isChecked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-white/40 bg-black/45 text-white opacity-85 hover:opacity-100',
                      )}
                      title="Chọn tác phẩm"
                    >
                      {isChecked ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                    </button>

                    {/* Nhãn Ghim / Vị trí Trang chủ / Khách gửi duyệt */}
                    <div className="pointer-events-none absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
                      {item.pinned && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs">
                          <Pin className="size-2.5" /> Ghim đầu
                        </span>
                      )}
                      {homepageSlot !== null && (
                        <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-xs">
                          Trang chủ #{homepageSlot}
                        </span>
                      )}
                      {!item.isPublic && item.communityPending && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-600/95 px-2 py-0.5 text-[10px] font-semibold text-white shadow-xs">
                          <Clock className="size-2.5" /> Khách gửi duyệt
                        </span>
                      )}
                    </div>

                    {/* Icon loại media góc dưới trái */}
                    <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {isVid ? <Play className="size-2.5 fill-white" /> : <ImageIcon className="size-2.5" />}
                      <span className="max-w-[125px] truncate">{item.toolName}</span>
                    </div>
                  </div>

                  {/* Thông tin khách + Prompt + Nút thao tác 1 chạm */}
                  <div className="flex flex-1 flex-col justify-between gap-2 p-2.5">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-1 text-[11px]">
                        <span className="truncate font-semibold text-foreground" title={item.user?.email || ''}>
                          @{authorTag}
                        </span>
                        <button
                          type="button"
                          onClick={() => setTaskDetailId(item.id)}
                          className="font-mono text-[10px] text-muted-foreground hover:text-primary hover:underline"
                          title="Mở chi tiết tác vụ"
                        >
                          {item.code}
                        </button>
                      </div>
                      <p className="line-clamp-2 min-h-[2rem] text-[11px] leading-4 text-muted-foreground">
                        {item.prompt || <span className="italic opacity-70">Không có mô tả prompt</span>}
                      </p>
                      <div className="text-[10px] text-muted-foreground/80">{formatItemTime(item.createdAt)}</div>
                    </div>

                    {/* Hàng nút thao tác trực tiếp */}
                    <div className="flex flex-wrap gap-1 border-t pt-2">
                      {tab === 'public' && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant={item.pinned ? 'secondary' : 'outline'}
                            className="h-7 flex-1 gap-1 px-1.5 text-[11px]"
                            disabled={moderate.isPending}
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: item.pinned ? 'unpin' : 'pin',
                                label: item.pinned ? `Đã bỏ ghim ${item.code}` : `Đã ghim ${item.code} lên đầu Trang chủ`,
                              })
                            }
                          >
                            {item.pinned ? <PinOff className="size-3" /> : <Pin className="size-3 text-amber-600" />}
                            {item.pinned ? 'Bỏ ghim' : 'Ghim'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 gap-1 px-1.5 text-[11px]"
                            disabled={moderate.isPending}
                            title="Gỡ khỏi Website đưa về Chờ kiểm duyệt"
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'unpublish',
                                label: `Đã chuyển ${item.code} về Chờ kiểm duyệt`,
                              })
                            }
                          >
                            <Clock className="size-3 text-amber-600" />
                            Chờ duyệt
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px] border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                            disabled={moderate.isPending}
                            title="Loại bỏ vĩnh viễn khỏi Cộng đồng"
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'hide',
                                label: `Đã loại bỏ ${item.code}`,
                              })
                            }
                          >
                            <X className="size-3.5" />
                          </Button>
                        </>
                      )}

                      {tab === 'candidates' && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 flex-1 gap-1 bg-emerald-600 px-1.5 text-[11px] text-white hover:bg-emerald-700"
                            disabled={moderate.isPending}
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'publish',
                                label: `Đã duyệt ${item.code} hiện lên Website`,
                              })
                            }
                          >
                            <Check className="size-3" />
                            Duyệt
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-1.5 text-[11px]"
                            disabled={moderate.isPending}
                            title="Duyệt & Ghim lên đầu Trang chủ"
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'publish_pin',
                                label: `Đã duyệt & ghim ${item.code} lên đầu Trang chủ`,
                              })
                            }
                          >
                            <Pin className="size-3 text-amber-600" />
                            Ghim
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px] border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                            disabled={moderate.isPending}
                            title="Loại bỏ tác phẩm không phù hợp"
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'hide',
                                label: `Đã loại bỏ ${item.code}`,
                              })
                            }
                          >
                            <X className="size-3.5" />
                          </Button>
                        </>
                      )}

                      {tab === 'blocked' && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 gap-1 px-1.5 text-[11px]"
                            disabled={moderate.isPending}
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'unpublish',
                                label: `Đã đưa ${item.code} về Chờ kiểm duyệt`,
                              })
                            }
                          >
                            <RotateCcw className="size-3 text-amber-600" />
                            Về Chờ duyệt
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 gap-1 px-1.5 text-[11px]"
                            disabled={moderate.isPending}
                            onClick={() =>
                              moderate.mutate({
                                ids: [item.id],
                                action: 'publish',
                                label: `Đã duyệt ${item.code} hiện lên Website`,
                              })
                            }
                          >
                            <Eye className="size-3 text-emerald-600" />
                            Duyệt Web
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Phân trang */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-2.5 text-xs">
            <span className="text-muted-foreground">
              Trang <strong>{page}</strong> / {totalPages} · Tổng {fmtCount(q.data?.meta.total ?? 0)} tác phẩm
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={page <= 1 || q.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Trang trước
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={page >= totalPages || q.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Trang sau
              </Button>
            </div>
          </div>
        )}
      </PageBody>

      {/* Hộp thoại xem phóng to Video / Ảnh */}
      {previewItem && (
        <Dialog open onOpenChange={(o) => !o && setPreviewItem(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                <span>{previewItem.toolName}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {previewItem.code}
                </Badge>
                {previewItem.pinned && (
                  <Badge className="bg-amber-500 text-white">
                    <Pin className="mr-1 size-3" /> Đang ghim đầu
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                Tạo bởi <strong>{previewItem.user?.name || 'Khách'}</strong> ({previewItem.user?.email || '—'}) ·{' '}
                {formatItemTime(previewItem.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="flex max-h-[65vh] items-center justify-center overflow-hidden rounded-xl bg-black">
                {previewItem.files[0] ? (
                  isVideoFile(previewItem.files[0]) ? (
                    <video
                      src={previewItem.files[0].url}
                      controls
                      autoPlay
                      playsInline
                      className="max-h-[65vh] w-auto max-w-full"
                    />
                  ) : (
                    <img
                      src={previewItem.files[0].url}
                      alt={previewItem.prompt || previewItem.toolName}
                      className="max-h-[65vh] w-auto max-w-full object-contain"
                    />
                  )
                ) : null}
              </div>

              {previewItem.prompt && (
                <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
                  <div className="mb-1 font-semibold text-muted-foreground">Prompt:</div>
                  <div className="whitespace-pre-wrap">{previewItem.prompt}</div>
                </div>
              )}
            </div>

            <DialogFooter className="flex flex-wrap items-center justify-between gap-2 sm:justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const id = previewItem.id;
                  setPreviewItem(null);
                  setTaskDetailId(id);
                }}
              >
                Xem chi tiết đơn AI
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {previewItem.isPublic ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={moderate.isPending}
                      onClick={() => {
                        moderate.mutate({
                          ids: [previewItem.id],
                          action: previewItem.pinned ? 'unpin' : 'pin',
                          label: previewItem.pinned ? 'Đã bỏ ghim' : 'Đã ghim lên đầu Trang chủ',
                        });
                        setPreviewItem(null);
                      }}
                    >
                      {previewItem.pinned ? <PinOff className="size-4" /> : <Pin className="size-4 text-amber-600" />}
                      {previewItem.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={moderate.isPending}
                      onClick={() => {
                        moderate.mutate({
                          ids: [previewItem.id],
                          action: 'hide',
                          label: `Đã ẩn ${previewItem.code} khỏi Cộng đồng`,
                        });
                        setPreviewItem(null);
                      }}
                    >
                      <EyeOff className="size-4" />
                      Ẩn khỏi Cộng đồng
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                      disabled={moderate.isPending}
                      onClick={() => {
                        moderate.mutate({
                          ids: [previewItem.id],
                          action: 'publish',
                          label: `Đã duyệt ${previewItem.code} hiện lên Website`,
                        });
                        setPreviewItem(null);
                      }}
                    >
                      <Check className="size-4" />
                      Duyệt hiện lên Website
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={moderate.isPending}
                      onClick={() => {
                        moderate.mutate({
                          ids: [previewItem.id],
                          action: 'publish_pin',
                          label: `Đã duyệt & ghim ${previewItem.code} lên đầu Trang chủ`,
                        });
                        setPreviewItem(null);
                      }}
                    >
                      <Pin className="size-4 text-amber-600" />
                      Duyệt & Ghim đầu
                    </Button>
                    {!previewItem.publicBlocked && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={moderate.isPending}
                        onClick={() => {
                          moderate.mutate({
                            ids: [previewItem.id],
                            action: 'hide',
                            label: `Đã loại bỏ ${previewItem.code}`,
                          });
                          setPreviewItem(null);
                        }}
                      >
                        <EyeOff className="size-4" />
                        Loại bỏ
                      </Button>
                    )}
                  </>
                )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Hộp thoại chi tiết tác vụ gốc */}
      <AdminAiTaskDialog id={taskDetailId} onClose={() => setTaskDetailId(null)} />

      {/* Hộp thoại tải trực tiếp Video / Ảnh mẫu lên Cộng đồng */}
      {openUpload && (
        <UploadShowcaseDialog
          tools={toolsQuery.data ?? []}
          onClose={() => setOpenUpload(false)}
          onCreated={() => {
            setOpenUpload(false);
            setTab('public');
            setPage(1);
            void qc.invalidateQueries({ queryKey: ['admin-ai-community'] });
          }}
        />
      )}
    </>
  );
}

function UploadShowcaseDialog({
  tools,
  onClose,
  onCreated,
}: {
  tools: PublicToolOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [toolKey, setToolKey] = useState<string>(() => tools[0]?.key ?? '');
  const [fileUrl, setFileUrl] = useState('');
  const [fileType, setFileType] = useState<'video' | 'image'>('video');
  const [prompt, setPrompt] = useState('');
  const [pin, setPin] = useState(true);
  const [uploading, setUploading] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; code: string }>('/admin/ai/community/showcase', {
        toolKey,
        fileUrl: fileUrl.trim(),
        fileType,
        prompt: prompt.trim() || undefined,
        pin,
      }),
    onSuccess: (res) => {
      toast.success(`Đã đăng tác phẩm mẫu ${res.code} lên Cộng đồng!`);
      onCreated();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Đăng Video / Ảnh mẫu lên Cộng đồng</DialogTitle>
          <DialogDescription>
            Tải lên video hoặc hình ảnh đẹp để trưng bày ngoài Trang chủ & trang Cộng đồng. Khi khách bấm &ldquo;Dùng lại thiết kế&rdquo; sẽ mở đúng công cụ AI bạn gắn bên dưới.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Công cụ AI gắn kèm" required>
            <Select value={toolKey} onValueChange={setToolKey}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn công cụ AI..." />
              </SelectTrigger>
              <SelectContent>
                {tools.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.badge ? `[${t.badge}] ` : ''}
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="File Video / Hình ảnh" required>
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-xs transition hover:opacity-90">
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {uploading ? 'Đang tải lên...' : 'Chọn file từ máy'}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,image/png,image/jpeg"
                    className="hidden"
                    disabled={uploading || create.isPending}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setUploading(true);
                      try {
                        const fd = new FormData();
                        fd.append('file', file);
                        const r = await api.upload<{ url: string }>('/account/ai/uploads?demo=1', fd);
                        setFileUrl(r.url);
                        setFileType(file.type.startsWith('video/') ? 'video' : 'image');
                        toast.success('Đã tải file lên thành công');
                      } catch (err) {
                        toast.error(errorMessage(err));
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>

                <Select value={fileType} onValueChange={(v: 'video' | 'image') => setFileType(v)}>
                  <SelectTrigger className="h-9 w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="video">Loại: Video</SelectItem>
                    <SelectItem value="image">Loại: Hình ảnh</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Input
                value={fileUrl}
                onChange={(e) => {
                  const v = e.target.value;
                  setFileUrl(v);
                  if (/\.(mp4|webm|mov)(\?|$)/i.test(v)) setFileType('video');
                  else if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(v)) setFileType('image');
                }}
                placeholder="Hoặc dán trực tiếp đường dẫn /uploads/... hoặc https://..."
                className="text-xs"
              />

              {fileUrl.trim() && (
                <div className="flex max-h-48 items-center justify-center overflow-hidden rounded-lg border bg-black">
                  {fileType === 'video' ? (
                    <video src={fileUrl.trim()} controls muted playsInline className="max-h-48 w-auto" />
                  ) : (
                    <img src={fileUrl.trim()} alt="Preview" className="max-h-48 w-auto object-contain" />
                  )}
                </div>
              )}
            </div>
          </Field>

          <Field label="Câu lệnh mẫu (Prompt gợi ý cho khách — không bắt buộc)">
            <Textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Nhập câu lệnh mẫu để khách bấm Dùng lại thiết kế sẽ điền sẵn..."
              className="text-xs"
            />
          </Field>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border bg-muted/30 p-3">
            <div>
              <div className="text-xs font-semibold">Ghim lên đầu Trang chủ & Cộng đồng</div>
              <div className="text-[11px] text-muted-foreground">Hiển thị ngay ở vị trí đầu tiên ngoài website</div>
            </div>
            <Switch checked={pin} onCheckedChange={setPin} />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending || uploading}>
            Huỷ
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || uploading || !toolKey || !fileUrl.trim()}
          >
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Globe className="size-4" />}
            Đăng lên Cộng đồng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminAiCommunityPage() {
  return (
    <PermissionGate permission={['ai.tasks.manage', 'ai.tools']}>
      <Suspense>
        <CommunityAdminContent />
      </Suspense>
    </PermissionGate>
  );
}
