'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSION_GROUPS, hasPermission, type ApiKeyCreated, type ApiKeyItem, type ApiKeyStatus } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import type { PermissionGroup } from '@/components/users/types';

/** Lựa chọn hạn dùng nhanh (số ngày); 'custom' = chọn ngày, 'never' = không hết hạn */
const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Không hết hạn' },
  { value: '30', label: '30 ngày' },
  { value: '90', label: '90 ngày' },
  { value: '365', label: '1 năm' },
  { value: 'custom', label: 'Chọn ngày…' },
] as const;

const STATUS: Record<ApiKeyStatus, { label: string; className: string }> = {
  active: { label: 'Đang dùng', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  expired: { label: 'Hết hạn', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  revoked: { label: 'Đã thu hồi', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
};

/** Tab Hồ sơ › API key: tạo/xem/thu hồi API key cá nhân (người có roles.manage xem được key của mọi người) */
export function ApiKeysPanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user, can } = useAuth();
  const canManageAll = can('roles.manage');
  const [showAll, setShowAll] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const all = canManageAll && showAll;
  const keys = useQuery({
    queryKey: ['api-keys', all],
    queryFn: () => api.get<{ data: ApiKeyItem[]; canManageAll: boolean }>('/admin/api-keys', { all: all ? 1 : undefined }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/api-keys/${id}`),
    onSuccess: () => {
      toast.success('Đã thu hồi API key');
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onRevoke = async (k: ApiKeyItem) => {
    const ok = await confirm({
      title: `Thu hồi API key “${k.name}”?`,
      description: 'Ứng dụng đang dùng key này sẽ bị từ chối ngay lập tức (401). Không thể hoàn tác.',
      confirmText: 'Thu hồi',
      destructive: true,
    });
    if (ok) revoke.mutate(k.id);
  };

  const rows = keys.data?.data ?? [];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        <Section
          title="API key"
          description="Dùng API key để ứng dụng/tích hợp bên ngoài gọi API quản trị thay bạn. Key chỉ hiện đầy đủ một lần khi tạo."
          actions={
            <div className="flex items-center gap-3">
              {canManageAll && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={showAll} onCheckedChange={setShowAll} /> <Users className="size-4" /> Của mọi người
                </label>
              )}
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> Tạo API key
              </Button>
            </div>
          }
        >
          {keys.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={KeyRound} title="Chưa có API key" description="Tạo key để kết nối ứng dụng bên ngoài với website." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tên</TableHead>
                    {all && <TableHead>Chủ sở hữu</TableHead>}
                    <TableHead>Quyền</TableHead>
                    <TableHead>Hạn dùng</TableHead>
                    <TableHead>Dùng lần cuối</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((k) => (
                    <TableRow key={k.id} className={k.status !== 'active' ? 'opacity-60' : undefined}>
                      <TableCell>
                        <div className="font-medium">{k.name}</div>
                        <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                      </TableCell>
                      {all && (
                        <TableCell>
                          <div className="text-sm">{k.user?.name ?? '—'}</div>
                          <div className="text-xs text-muted-foreground">{k.user?.email}</div>
                        </TableCell>
                      )}
                      <TableCell className="text-sm">
                        {k.permissions.length ? (
                          <span title={k.permissions.join(', ')}>{k.permissions.length} quyền</span>
                        ) : (
                          <span className="text-muted-foreground">Như tài khoản</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{k.expiresAt ? formatDate(k.expiresAt, 'dd/MM/yyyy') : <span className="text-muted-foreground">Không</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {k.lastUsedAt ? (
                          <>
                            <div>{formatDate(k.lastUsedAt)}</div>
                            {k.lastUsedIp && <div className="font-mono text-xs text-muted-foreground">{k.lastUsedIp}</div>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Chưa dùng</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS[k.status].className}>{STATUS[k.status].label}</Badge>
                      </TableCell>
                      <TableCell>
                        {k.status !== 'revoked' && (k.userId === user?.id || canManageAll) && (
                          <Button variant="ghost" size="icon-sm" title="Thu hồi" onClick={() => void onRevoke(k)} disabled={revoke.isPending}>
                            <Trash2 className="text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="Cách dùng">
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>Gửi key trong header của mỗi request tới API:</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
              {'Authorization: Bearer cmsnt_…\n# hoặc\nX-API-Key: cmsnt_…'}
            </pre>
            <p>Quyền của key luôn nằm trong quyền tài khoản của bạn; vai trò bị thu hẹp thì key cũng mất quyền tương ứng.</p>
            <p>Key không dùng được để đổi mật khẩu, bật/tắt 2FA hay tạo key mới.</p>
          </div>
        </Section>
      </div>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(k) => {
          setCreateOpen(false);
          setCreated(k);
          void qc.invalidateQueries({ queryKey: ['api-keys'] });
        }}
        userPermissions={user?.role.permissions ?? []}
      />
      <CreatedKeyDialog created={created} onClose={() => setCreated(null)} />
    </div>
  );
}

/** Hộp thoại tạo key: tên, hạn dùng, quyền (toàn bộ quyền tài khoản hoặc tập con) */
function CreateKeyDialog({ open, onOpenChange, onCreated, userPermissions }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (k: ApiKeyCreated) => void; userPermissions: string[] }) {
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<string>('90');
  const [customDate, setCustomDate] = useState('');
  // ngày nhỏ nhất chọn được (ngày mai) — tính 1 lần khi mở hộp thoại
  const [minDate] = useState(() => new Date(Date.now() + 86400_000).toISOString().slice(0, 10));
  const [scope, setScope] = useState<'all' | 'limited'>('limited');
  const [perms, setPerms] = useState<Set<string>>(new Set(['admin.access']));

  // danh sách quyền đầy đủ từ API nếu được xem; không thì dùng danh sách có sẵn trong @cmsnt/shared
  const groupsQ = useQuery({
    queryKey: ['permission-groups'],
    queryFn: () => api.get<PermissionGroup[]>('/admin/roles/permissions'),
    staleTime: Infinity,
    enabled: open && can('users.read'),
  });
  // chỉ cho chọn quyền tài khoản đang có
  const groups = useMemo(() => {
    const src: readonly PermissionGroup[] = groupsQ.data ?? PERMISSION_GROUPS;
    return src.map((g) => ({ ...g, permissions: g.permissions.filter((p) => hasPermission(userPermissions, p.key)) })).filter((g) => g.permissions.length);
  }, [groupsQ.data, userPermissions]);

  const reset = () => {
    setName('');
    setExpiry('90');
    setCustomDate('');
    setScope('limited');
    setPerms(new Set(['admin.access']));
  };

  const create = useMutation({
    mutationFn: () => {
      let expiresAt: string | undefined;
      if (expiry === 'custom') {
        if (!customDate) throw new Error('Vui lòng chọn ngày hết hạn');
        expiresAt = new Date(`${customDate}T23:59:59`).toISOString();
      } else if (expiry !== 'never') {
        expiresAt = new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
      }
      if (scope === 'limited' && perms.size === 0) throw new Error('Chọn ít nhất một quyền');
      return api.post<ApiKeyCreated>('/admin/api-keys', { name: name.trim(), expiresAt, permissions: scope === 'all' ? [] : [...perms] });
    },
    onSuccess: (k) => {
      reset();
      onCreated(k);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const toggle = (key: string, on: boolean) => {
    const next = new Set(perms);
    if (on) next.add(key);
    else next.delete(key);
    setPerms(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tạo API key</DialogTitle>
          <DialogDescription>Key sẽ hiện đầy đủ một lần duy nhất sau khi tạo.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tên gợi nhớ" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Đồng bộ kho, Zapier…" maxLength={100} autoFocus />
            </Field>
            <Field label="Hạn dùng">
              <div className="flex gap-2">
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {expiry === 'custom' && <Input type="date" value={customDate} min={minDate} onChange={(e) => setCustomDate(e.target.value)} />}
              </div>
            </Field>
          </div>

          <Field label="Quyền">
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'all' | 'limited')} className="grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary">
                <RadioGroupItem value="limited" className="mt-0.5" />
                <span>
                  <span className="font-medium">Giới hạn quyền</span>
                  <span className="block text-xs text-muted-foreground">Chỉ các quyền được chọn (khuyến nghị)</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary">
                <RadioGroupItem value="all" className="mt-0.5" />
                <span>
                  <span className="font-medium">Như tài khoản của tôi</span>
                  <span className="block text-xs text-muted-foreground">Mọi quyền tài khoản đang có</span>
                </span>
              </label>
            </RadioGroup>
          </Field>

          {scope === 'limited' && (
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-3">
              {groups.map((g) => (
                <div key={g.key}>
                  <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">{g.label}</p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {g.permissions.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={perms.has(p.key)} onCheckedChange={(v) => toggle(p.key, v === true)} />
                        <span>{p.label}</span>
                        <code className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">{p.key}</code>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Tạo key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Hiện key vừa tạo (một lần duy nhất) kèm nút sao chép */
function CreatedKeyDialog({ created, onClose }: { created: ApiKeyCreated | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      toast.success('Đã sao chép API key');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Không sao chép được, hãy bôi đen và sao chép thủ công');
    }
  };
  return (
    <Dialog
      open={!!created}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" /> Đã tạo API key “{created?.name}”
          </DialogTitle>
          <DialogDescription>Sao chép và lưu key ở nơi an toàn. Vì lý do bảo mật, bạn sẽ không xem lại được key này.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={created?.key ?? ''} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" onClick={() => void copy()} title="Sao chép">
            {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
          </Button>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Không chia sẻ key công khai hay đưa vào mã nguồn. Nếu lộ key, hãy thu hồi ngay và tạo key mới.
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Tôi đã lưu key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
