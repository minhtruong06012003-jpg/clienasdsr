'use client';

/**
 * AI Studio › Website con (/admin/ai/child-panels):
 * Quản lý yêu cầu mở Website con từ khách hàng (duyệt & khởi tạo tự động qua NovAI Hub 1 chạm, đánh dấu hoạt động thủ công, hoặc từ chối)
 * kèm cấu hình nhanh (bật/tắt, tự động duyệt, phí tạo, tổng nạp tối thiểu, số web tối đa/khách).
 */
import { Suspense, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, Globe, Loader2, Plus, RefreshCw, Rocket, Save, WandSparkles, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { StatusTabs } from '@/components/common/list-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChildPanelConfig {
  enabled: boolean;
  vpsIp: string;
  price: number;
  minDeposit: number;
  autoApprove: boolean;
  maxPerUser: number;
}

interface AdminChildPanelRow {
  id: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  domain: string;
  siteName: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
  siteCode: string | null;
  hubJobId: string | null;
  fee: number;
  status: 'PENDING' | 'PROVISIONING' | 'ACTIVE' | 'REJECTED' | 'FAILED';
  note: string | null;
  createdAt: string;
}

interface AdminChildPanelsResponse {
  config: ChildPanelConfig;
  hubAvailable: boolean;
  items: AdminChildPanelRow[];
}

const STATUS_BADGE: Record<AdminChildPanelRow['status'], { label: string; className: string }> = {
  PENDING: { label: 'Chờ duyệt', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  PROVISIONING: { label: 'Đang khởi tạo', className: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  ACTIVE: { label: 'Đang hoạt động', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  REJECTED: { label: 'Đã từ chối', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  FAILED: { label: 'Lỗi khởi tạo', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

function suggestCodeFromDomain(raw: string): string {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')[0]
    .replace(/[^a-z0-9]/g, '');
  if (!clean) return '';
  const prefixed = /^[a-z]/.test(clean) ? clean : `w${clean}`;
  return (prefixed.length < 2 ? `${prefixed}web` : prefixed).slice(0, 18);
}

function randomAdminPw(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789@#$!';
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function ChildPanelsAdminContent() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState<ChildPanelConfig | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [codeTouched, setCodeTouched] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    domain: '',
    siteCode: '',
    siteName: '',
    adminEmail: '',
    adminName: '',
    adminPassword: '',
    ownerEmail: '',
    skipDnsCheck: false,
  });
  const [dnsState, setDnsState] = useState<{
    checking: boolean;
    checkedDomain: string;
    ok?: boolean;
    ips?: string[];
    vpsIp?: string;
    error?: string | null;
  }>({ checking: false, checkedDomain: '' });

  const q = useQuery({
    queryKey: ['admin-child-panels', statusFilter],
    queryFn: () => api.get<AdminChildPanelsResponse>('/admin/child-panels', { status: statusFilter || undefined }),
    refetchInterval: (query) => (query.state.data?.items?.some((x) => x.status === 'PROVISIONING') ? 5000 : false),
  });

  useEffect(() => {
    if (q.data?.config && !form) {
      setForm(q.data.config);
    }
  }, [q.data?.config, form]);

  const saveConfig = useMutation({
    mutationFn: (next: ChildPanelConfig) => api.put<ChildPanelConfig>('/admin/child-panels/config', next),
    onSuccess: (saved) => {
      setForm(saved);
      toast.success('Đã lưu cấu hình Website con');
      void qc.invalidateQueries({ queryKey: ['admin-child-panels'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const approve = useMutation({
    mutationFn: ({ id, autoProvision }: { id: string; autoProvision: boolean }) =>
      api.post(`/admin/child-panels/${id}/approve`, { autoProvision }),
    onSuccess: (_, vars) => {
      toast.success(vars.autoProvision ? 'Đang tự động khởi tạo Website con qua NovAI Hub...' : 'Đã đánh dấu Website con hoạt động');
      void qc.invalidateQueries({ queryKey: ['admin-child-panels'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/admin/child-panels/${id}/reject`, {}),
    onSuccess: () => {
      toast.success('Đã từ chối yêu cầu');
      void qc.invalidateQueries({ queryKey: ['admin-child-panels'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runDnsCheck = async (rawDomain?: string) => {
    const d = (rawDomain ?? createDraft.domain).trim();
    if (!d) {
      toast.error('Vui lòng nhập domain trước khi kiểm tra DNS');
      return;
    }
    setDnsState({ checking: true, checkedDomain: d });
    try {
      const res = await api.get<{ domain: string; vpsIp: string; ok: boolean; ips: string[]; error: string | null }>(
        '/admin/child-panels/check-dns',
        { domain: d },
      );
      setDnsState({
        checking: false,
        checkedDomain: res.domain,
        ok: res.ok,
        ips: res.ips,
        vpsIp: res.vpsIp,
        error: res.error,
      });
    } catch (err) {
      setDnsState({ checking: false, checkedDomain: d, ok: false, error: errorMessage(err) });
    }
  };

  const createPanel = useMutation({
    mutationFn: () =>
      api.post<AdminChildPanelRow>('/admin/child-panels', {
        domain: createDraft.domain.trim(),
        siteCode: createDraft.siteCode.trim() || undefined,
        siteName: createDraft.siteName.trim() || undefined,
        adminEmail: createDraft.adminEmail.trim(),
        adminName: createDraft.adminName.trim() || undefined,
        adminPassword: createDraft.adminPassword.trim() || undefined,
        ownerEmail: createDraft.ownerEmail.trim() || undefined,
        skipDnsCheck: createDraft.skipDnsCheck,
      }),
    onSuccess: (created) => {
      toast.success(
        created.status === 'PROVISIONING'
          ? `Đang tự động khởi tạo Website con ${created.domain} qua NovAI Hub...`
          : `Đã tạo Website con ${created.domain}`,
      );
      setCreateOpen(false);
      setCodeTouched(false);
      setDnsState({ checking: false, checkedDomain: '' });
      setCreateDraft({
        domain: '',
        siteCode: '',
        siteName: '',
        adminEmail: '',
        adminName: '',
        adminPassword: '',
        ownerEmail: '',
        skipDnsCheck: false,
      });
      void qc.invalidateQueries({ queryKey: ['admin-child-panels'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: Column<AdminChildPanelRow>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      cell: (r) => <span className="whitespace-nowrap text-xs">{formatDate(r.createdAt, 'HH:mm dd/MM/yyyy')}</span>,
    },
    {
      key: 'user',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="min-w-0 text-xs">
          <div className="font-semibold">{r.userName || '—'}</div>
          <div className="text-muted-foreground">{r.userEmail || r.userId}</div>
        </div>
      ),
    },
    {
      key: 'domain',
      header: 'Domain / Tên web',
      cell: (r) => (
        <div className="space-y-0.5 text-xs">
          <div className="flex items-center gap-1.5 font-mono font-bold">
            <span>{r.domain}</span>
            <a href={`https://${r.domain}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary" title="Mở website">
              <ExternalLink className="size-3.5" />
            </a>
          </div>
          <div className="text-muted-foreground">
            Tên web: <strong className="text-foreground">{r.siteName}</strong>
            {r.siteCode && <span className="ml-1.5 font-mono text-[11px]">(mã: {r.siteCode})</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'admin',
      header: 'Tài khoản Admin web con',
      cell: (r) => (
        <div className="space-y-0.5 text-xs">
          <div>
            <span className="font-mono">{r.adminEmail}</span> <span className="text-muted-foreground">({r.adminName})</span>
          </div>
          {r.adminPassword ? (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>MK:</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{r.adminPassword}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(r.adminPassword).then(() => toast.success('Đã chép mật khẩu'))}
                className="hover:text-foreground"
                title="Sao chép mật khẩu"
              >
                <Copy className="size-3" />
              </button>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => {
        const b = STATUS_BADGE[r.status] ?? STATUS_BADGE.PENDING;
        return (
          <div className="max-w-56 space-y-1">
            <Badge className={cn('border-transparent font-medium', b.className)}>{b.label}</Badge>
            {r.note && <p className="line-clamp-2 text-[11px] text-muted-foreground">{r.note}</p>}
            {r.fee > 0 && <p className="text-[11px] font-medium tabular-nums">Phí: {formatMoney(r.fee, 'VND')}</p>}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: 'Thao tác',
      className: 'text-right',
      cell: (r) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {(r.status === 'PENDING' || r.status === 'FAILED') && (
            <>
              {q.data?.hubAvailable && (
                <Button
                  size="xs"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate({ id: r.id, autoProvision: true })}
                  title="Tự động tạo DB, PM2, Nginx & cài SSL qua NovAI Hub"
                >
                  <Rocket className="size-3.5" /> Duyệt & Tạo tự động
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={approve.isPending}
                onClick={() => approve.mutate({ id: r.id, autoProvision: false })}
              >
                <CheckCircle2 className="size-3.5" /> Đã tạo xong
              </Button>
              <Button
                size="xs"
                variant="destructive"
                disabled={reject.isPending}
                onClick={() => reject.mutate(r.id)}
              >
                <XCircle className="size-3.5" /> Từ chối
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Website con (Child Panels)"
        description="Quản lý yêu cầu khởi tạo website con của đối tác và cấu hình điều kiện mở web con"
        breadcrumbs={[{ label: 'AI Studio' }, { label: 'Website con' }]}
        actions={
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Tạo web con
          </Button>
        }
      />
      <PageBody>
        <div className="space-y-5">
          {form && (
            <div className="rounded-xl border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Globe className="size-4 text-primary" /> Cấu hình đăng ký Website con
                </div>
                <Button size="sm" disabled={saveConfig.isPending} onClick={() => saveConfig.mutate(form)}>
                  {saveConfig.isPending ? <Loader2 className="animate-spin" /> : <Save className="size-3.5" />} Lưu cấu hình
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">IP trỏ bản ghi A</label>
                  <Input value={form.vpsIp} onChange={(e) => setForm({ ...form, vpsIp: e.target.value })} className="font-mono text-xs" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Phí tạo web con (VNĐ)</label>
                  <Input
                    type="number"
                    min={0}
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })}
                    className="tabular-nums text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Tổng nạp tối thiểu yêu cầu (VNĐ)</label>
                  <Input
                    type="number"
                    min={0}
                    value={form.minDeposit}
                    onChange={(e) => setForm({ ...form, minDeposit: Number(e.target.value) || 0 })}
                    className="tabular-nums text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Số web con tối đa / tài khoản</label>
                  <Input
                    type="number"
                    min={1}
                    value={form.maxPerUser}
                    onChange={(e) => setForm({ ...form, maxPerUser: Math.max(1, Number(e.target.value) || 1) })}
                    className="tabular-nums text-xs"
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-6 border-t pt-3 text-xs">
                <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
                  <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                  <span>Cho phép khách gửi đăng ký Website con</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
                  <Switch checked={form.autoApprove} onCheckedChange={(v) => setForm({ ...form, autoApprove: v })} />
                  <span>Tự động duyệt & khởi tạo ngay qua NovAI Hub (không cần chờ duyệt tay)</span>
                </label>
              </div>
            </div>
          )}

          <StatusTabs
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: '', label: 'Tất cả' },
              { value: 'PENDING', label: 'Chờ duyệt' },
              { value: 'PROVISIONING', label: 'Đang khởi tạo' },
              { value: 'ACTIVE', label: 'Đang hoạt động' },
              { value: 'FAILED', label: 'Lỗi' },
              { value: 'REJECTED', label: 'Đã từ chối' },
            ]}
          />

          <DataTable
            columns={columns}
            data={q.data?.items}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            emptyTitle="Chưa có yêu cầu Website con nào"
            emptyDescription="Khi đối tác điền biểu mẫu tại trang /child-panels, yêu cầu sẽ xuất hiện tại đây để bạn duyệt 1 chạm."
          />
        </div>
      </PageBody>

      {/* Dialog + Tạo web con trực tiếp từ Admin */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="size-4 text-primary" /> Tạo Website con mới
            </DialogTitle>
            <DialogDescription>
              Trước khi tạo, hãy trỏ bản ghi <strong>A</strong> của domain (và <code>www</code> nếu muốn) về IP{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{form?.vpsIp || '103.200.22.81'}</code>. Hệ thống sẽ tự động tạo Database, PM2, Nginx &amp; chứng chỉ SSL HTTPS qua NovAI Hub.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label>Domain (không có www, không có https://) *</Label>
              <div className="flex gap-2">
                <Input
                  value={createDraft.domain}
                  onChange={(e) => {
                    const domain = e.target.value;
                    setCreateDraft((s) => ({
                      ...s,
                      domain,
                      siteCode: codeTouched ? s.siteCode : suggestCodeFromDomain(domain),
                    }));
                  }}
                  placeholder="vidu.com"
                  className="font-mono text-sm"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={dnsState.checking || !createDraft.domain.trim()}
                  onClick={() => void runDnsCheck()}
                >
                  {dnsState.checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Kiểm tra DNS
                </Button>
              </div>
              {dnsState.checkedDomain && !dnsState.checking && (
                <div
                  className={cn(
                    'rounded-lg border px-2.5 py-1.5 text-xs',
                    dnsState.ok
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
                  )}
                >
                  {dnsState.ok
                    ? `✓ Bản ghi A của ${dnsState.checkedDomain} đã trỏ đúng về ${dnsState.vpsIp}`
                    : `⚠ ${dnsState.checkedDomain} hiện trỏ về: ${dnsState.ips?.length ? dnsState.ips.join(', ') : dnsState.error || 'chưa có bản ghi A'} (cần trỏ về ${dnsState.vpsIp || form?.vpsIp || '103.200.22.81'})`}
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Mã web con (tên DB / tiến trình)</Label>
                <Input
                  value={createDraft.siteCode}
                  onChange={(e) => {
                    setCodeTouched(true);
                    setCreateDraft((s) => ({ ...s, siteCode: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) }));
                  }}
                  placeholder="vd: vidu"
                  className="font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground">Chữ thường + số (2–20 ký tự), tự gợi ý theo domain</p>
              </div>
              <div className="space-y-1.5">
                <Label>Tên hiển thị website</Label>
                <Input
                  value={createDraft.siteName}
                  onChange={(e) => setCreateDraft((s) => ({ ...s, siteName: e.target.value }))}
                  placeholder="Tên hiện trên web con"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Email admin web con *</Label>
                <Input
                  type="email"
                  value={createDraft.adminEmail}
                  onChange={(e) => setCreateDraft((s) => ({ ...s, adminEmail: e.target.value }))}
                  placeholder="admin@vidu.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Tên admin</Label>
                <Input
                  value={createDraft.adminName}
                  onChange={(e) => setCreateDraft((s) => ({ ...s, adminName: e.target.value }))}
                  placeholder="Quản trị viên"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Mật khẩu admin (để trống = tự sinh mật khẩu mạnh)</Label>
              <div className="flex gap-2">
                <Input
                  value={createDraft.adminPassword}
                  onChange={(e) => setCreateDraft((s) => ({ ...s, adminPassword: e.target.value }))}
                  placeholder="Tối thiểu 10 ký tự hoặc để trống tự sinh"
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => setCreateDraft((s) => ({ ...s, adminPassword: randomAdminPw() }))}
                >
                  <WandSparkles className="size-3.5" /> Tự sinh
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Email thành viên sở hữu trên nov.ai.vn (tuỳ chọn)</Label>
              <Input
                type="email"
                value={createDraft.ownerEmail}
                onChange={(e) => setCreateDraft((s) => ({ ...s, ownerEmail: e.target.value }))}
                placeholder="Bỏ trống nếu tạo nội bộ, hoặc nhập email đối tác trên nov.ai.vn"
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Switch
                checked={createDraft.skipDnsCheck}
                onCheckedChange={(skipDnsCheck) => setCreateDraft((s) => ({ ...s, skipDnsCheck }))}
              />
              <span>Vẫn khởi tạo ngay kể cả khi DNS đang trong quá trình cập nhật</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Huỷ
            </Button>
            <Button
              disabled={createPanel.isPending || !createDraft.domain.trim() || !createDraft.adminEmail.trim()}
              onClick={() => createPanel.mutate()}
            >
              {createPanel.isPending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
              Tạo &amp; Khởi tạo tự động
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminChildPanelsPage() {
  return (
    <Suspense>
      <ChildPanelsAdminContent />
    </Suspense>
  );
}
