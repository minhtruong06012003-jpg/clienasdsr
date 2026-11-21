'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Crown, Loader2, Lock, Plus, Save, ShieldCheck, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { SETTING_PERMISSION_KEYS, SETTING_SECTIONS, slugify } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import type { PermissionGroup, PermissionItem, RoleOption } from '@/components/users/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFeatures } from '@/hooks/use-features';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { cn } from '@/lib/utils';

interface RoleForm {
  id?: string;
  name: string;
  slug: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
}

const NEW = '__new__';

export default function RolesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can, refreshUser, user: me } = useAuth();
  const { isOn } = useFeatures();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles') });
  const groups = useQuery({ queryKey: ['permission-groups'], queryFn: () => api.get<PermissionGroup[]>('/admin/roles/permissions'), staleTime: Infinity });
  const canManage = can('roles.manage');

  const load = useCallback((r: RoleOption | null) => {
    setForm(r ? { id: r.id, name: r.name, slug: r.slug, description: r.description ?? '', permissions: r.permissions, isSystem: r.isSystem } : { name: '', slug: '', description: '', permissions: ['admin.access', 'dashboard.view'], isSystem: false });
    setSelectedId(r?.id ?? NEW);
    setDirty(false);
  }, []);

  // chọn vai trò đầu tiên khi tải xong
  useEffect(() => {
    if (!selectedId && roles.data?.length) load(roles.data[0]);
  }, [roles.data, selectedId, load]);

  const select = async (r: RoleOption | null) => {
    if (dirty && !(await confirm({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi phân quyền của vai trò hiện tại sẽ bị mất.', confirmText: 'Bỏ thay đổi', destructive: true }))) return;
    load(r);
  };

  const update = (patch: Partial<RoleForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };

  const isAdminRole = form?.slug === 'administrator';
  const full = !!form?.permissions.includes('*');
  const perms = useMemo(() => new Set(form?.permissions ?? []), [form?.permissions]);
  const visibleGroups = useMemo(
    () =>
      (groups.data ?? []).map((g) => ({
        ...g,
        permissions: g.permissions.filter((p) => !p.feature || isOn(p.feature)),
      })),
    [groups.data, isOn],
  );
  const allKeys = useMemo(() => visibleGroups.flatMap((g) => g.permissions.map((p) => p.key)), [visibleGroups]);
  const leafKeys = useMemo(() => allKeys.filter((k) => k !== 'settings.manage'), [allKeys]);
  const visibleSettingKeys = useMemo(() => leafKeys.filter((k) => k.startsWith('settings.')), [leafKeys]);

  const hasSettingSub = useCallback(
    (key: string) => full || perms.has('settings.manage') || perms.has(key),
    [full, perms],
  );

  const selectedCount = useMemo(
    () => leafKeys.filter((k) => (k.startsWith('settings.') ? hasSettingSub(k) : perms.has(k))).length,
    [leafKeys, hasSettingSub, perms],
  );

  const applySettingsMutation = (mutate: (s: Set<string>) => void) => {
    const next = new Set(perms);
    if (next.has('settings.manage')) {
      for (const k of SETTING_PERMISSION_KEYS) next.add(k);
      next.delete('settings.manage');
    }
    mutate(next);
    if (visibleSettingKeys.length > 0 && visibleSettingKeys.every((k) => next.has(k))) {
      next.add('settings.manage');
    } else {
      next.delete('settings.manage');
    }
    update({ permissions: [...next] });
  };

  const togglePerm = (key: string, on: boolean) => {
    if (key === 'settings.manage') {
      const next = new Set(perms);
      if (on) {
        next.add('settings.manage');
        for (const k of visibleSettingKeys) next.add(k);
      } else {
        next.delete('settings.manage');
        for (const k of SETTING_PERMISSION_KEYS) next.delete(k);
      }
      update({ permissions: [...next] });
      return;
    }
    if (key.startsWith('settings.')) {
      applySettingsMutation((next) => {
        if (on) next.add(key);
        else next.delete(key);
      });
      return;
    }
    const next = new Set(perms);
    if (on) next.add(key);
    else next.delete(key);
    update({ permissions: [...next] });
  };

  const toggleSettingItems = (items: readonly PermissionItem[], on: boolean) => {
    applySettingsMutation((next) => {
      for (const p of items) {
        if (on) next.add(p.key);
        else next.delete(p.key);
      }
    });
  };

  const toggleGroup = (g: PermissionGroup, on: boolean) => {
    const next = new Set(perms);
    if (g.key === 'system') {
      if (!on) {
        for (const k of SETTING_PERMISSION_KEYS) next.delete(k);
      }
    }
    for (const p of g.permissions) {
      if (on) next.add(p.key);
      else next.delete(p.key);
    }
    update({ permissions: [...next] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (!form.name.trim()) throw new Error('Vui lòng nhập tên vai trò');
      const body = { name: form.name.trim(), slug: form.slug.trim() || undefined, description: form.description, permissions: form.permissions };
      return form.id ? api.patch<RoleOption>(`/admin/roles/${form.id}`, body) : api.post<RoleOption>('/admin/roles', body);
    },
    onSuccess: async (data) => {
      toast.success(form?.id ? 'Đã lưu vai trò' : 'Đã tạo vai trò');
      setDirty(false);
      const list = await qc.fetchQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles') });
      load(list.find((r) => r.id === data.id) ?? null);
      // quyền của chính mình có thể vừa thay đổi
      if (me && data.id === me.role.id) await refreshUser().catch(() => undefined);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/roles/${id}`),
    onSuccess: async () => {
      toast.success('Đã xoá vai trò');
      setDirty(false);
      const list = await qc.fetchQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles') });
      load(list[0] ?? null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, canManage ? doSave : undefined);

  const current = roles.data?.find((r) => r.id === form?.id);

  return (
    <>
      <PageHeader
        title="Vai trò & phân quyền"
        description="Mỗi thành viên có một vai trò. Vai trò quyết định những gì họ được xem và thao tác trong trang quản trị."
        breadcrumbs={[{ label: 'Thành viên', href: '/users' }, { label: 'Vai trò' }]}
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => select(null)}>
                <Plus /> Thêm vai trò
              </Button>
              <Button onClick={() => save.mutate()} disabled={!form || save.isPending || !dirty}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
              </Button>
            </>
          )
        }
      />
      <PageBody>
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <div className="space-y-2">
            {roles.isLoading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
            {roles.data?.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => r.id !== selectedId && select(r)}
                className={cn('flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition', selectedId === r.id ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/40')}
              >
                <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', r.permissions.includes('*') ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' : 'bg-primary/10 text-primary')}>
                  {r.permissions.includes('*') ? <Crown className="size-4" /> : <ShieldCheck className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    <span className="truncate">{r.name}</span>
                    {r.isSystem && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3" /> {r._count.users}
                    </span>
                    <span>·</span>
                    <span>{r.permissions.includes('*') ? 'Toàn quyền' : `${r.permissions.length} quyền`}</span>
                  </div>
                </div>
              </button>
            ))}
            {selectedId === NEW && (
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-primary bg-primary/5 p-3 text-sm font-medium text-primary">
                <Plus className="size-4" /> {form?.name || 'Vai trò mới'}
              </div>
            )}
          </div>

          {form && (
            <fieldset disabled={!canManage} className="min-w-0 space-y-6">
              <Section
                title={form.id ? 'Thông tin vai trò' : 'Vai trò mới'}
                actions={
                  form.isSystem ? (
                    <Badge variant="secondary" className="gap-1">
                      <Lock className="size-3" /> Vai trò hệ thống
                    </Badge>
                  ) : undefined
                }
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Tên vai trò" required>
                    <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="vd: Cộng tác viên" />
                  </Field>
                  <Field label="Mã (slug)" help={form.isSystem ? 'Không thể đổi mã của vai trò hệ thống' : 'Để trống sẽ tự tạo từ tên'}>
                    <Input value={form.slug} disabled={form.isSystem} onChange={(e) => update({ slug: e.target.value })} onBlur={(e) => update({ slug: slugify(e.target.value) })} placeholder={slugify(form.name) || 'cong-tac-vien'} className="font-mono text-sm" />
                  </Field>
                </div>
                <Field label="Mô tả">
                  <Textarea value={form.description} onChange={(e) => update({ description: e.target.value })} rows={2} />
                </Field>
              </Section>

              <Section
                title="Quyền hạn"
                description={full ? 'Vai trò này có toàn quyền trên hệ thống' : `Đã chọn ${selectedCount}/${leafKeys.length} quyền`}
                actions={
                  !full && (
                    <div className="flex gap-1">
                      <Button type="button" variant="ghost" size="xs" onClick={() => update({ permissions: [...allKeys] })}>
                        Chọn tất cả
                      </Button>
                      <Button type="button" variant="ghost" size="xs" onClick={() => update({ permissions: [] })}>
                        Bỏ chọn
                      </Button>
                    </div>
                  )
                }
              >
                <label className={cn('flex items-center justify-between gap-4 rounded-lg border p-3', full ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20' : '')}>
                  <div className="flex items-center gap-3">
                    <Crown className="size-5 text-amber-500" />
                    <div>
                      <div className="text-sm font-medium">Toàn quyền (*)</div>
                      <div className="text-xs text-muted-foreground">Bao gồm mọi quyền hiện tại và các quyền được thêm trong tương lai.</div>
                    </div>
                  </div>
                  <Switch checked={full} disabled={isAdminRole} onCheckedChange={(v) => update({ permissions: v ? ['*'] : allKeys.filter((k) => k !== '*') })} />
                </label>
                {isAdminRole && <p className="text-xs text-muted-foreground">Vai trò Quản trị viên luôn có toàn quyền để tránh bị khoá khỏi hệ thống.</p>}

                {groups.isLoading ? (
                  <Skeleton className="h-64" />
                ) : (
                  <div className={cn('grid gap-3 md:grid-cols-2 2xl:grid-cols-3', full && 'pointer-events-none opacity-50')}>
                    {visibleGroups.map((g) => {
                      if (g.key === 'system') {
                        const settingSubs = g.permissions.filter((p) => p.key.startsWith('settings.') && p.key !== 'settings.manage');
                        const otherPerms = g.permissions.filter((p) => !p.key.startsWith('settings.'));
                        const checkedSettingsCount = settingSubs.filter((p) => hasSettingSub(p.key)).length;
                        const otherCheckedCount = otherPerms.filter((p) => full || perms.has(p.key)).length;
                        const totalLeaves = settingSubs.length + otherPerms.length;
                        const totalChecked = checkedSettingsCount + otherCheckedCount;
                        const groupState = totalChecked === totalLeaves ? true : totalChecked > 0 ? 'indeterminate' : false;
                        const settingsState = checkedSettingsCount === settingSubs.length ? true : checkedSettingsCount > 0 ? 'indeterminate' : false;

                        return (
                          <div key={g.key} className="rounded-lg border md:col-span-2 2xl:col-span-3">
                            <label className="flex cursor-pointer items-center gap-2 border-b bg-muted/40 px-3 py-2">
                              <Checkbox checked={groupState} onCheckedChange={(v) => toggleGroup(g, v === true)} disabled={full} />
                              <span className="flex-1 text-sm font-semibold">{g.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {totalChecked}/{totalLeaves}
                              </span>
                            </label>
                            <div className="space-y-3 p-3">
                              {/* Mục Cài đặt kèm toàn bộ các mục con (Website, AI Studio, Thanh toán, Thông báo & thành viên, Hệ thống) */}
                              <div className="rounded-lg border bg-muted/15">
                                <div className="flex items-center gap-2 px-3 py-2">
                                  <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm font-medium">
                                    <Checkbox checked={settingsState} onCheckedChange={(v) => togglePerm('settings.manage', v === true)} disabled={full} />
                                    <span>Cài đặt</span>
                                    <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-normal">
                                      {checkedSettingsCount}/{settingSubs.length} mục
                                    </Badge>
                                  </label>
                                  <code className="hidden text-[10px] text-muted-foreground sm:inline">settings.*</code>
                                  <button
                                    type="button"
                                    onClick={() => setSettingsOpen((o) => !o)}
                                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                  >
                                    <span>{settingsOpen ? 'Thu gọn' : 'Mở rộng'}</span>
                                    <ChevronDown className={cn('size-3.5 transition-transform', settingsOpen && 'rotate-180')} />
                                  </button>
                                </div>
                                {settingsOpen && (
                                  <div className="grid gap-2.5 border-t bg-card/70 p-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {SETTING_SECTIONS.map((sec) => {
                                      const secItems = settingSubs.filter((p) => p.section === sec.key);
                                      if (!secItems.length) return null;
                                      const secCount = secItems.filter((p) => hasSettingSub(p.key)).length;
                                      const secState = secCount === secItems.length ? true : secCount > 0 ? 'indeterminate' : false;
                                      return (
                                        <div key={sec.key} className="rounded-md border bg-background p-2.5">
                                          <label className="mb-2 flex cursor-pointer items-center gap-2 border-b pb-1.5">
                                            <Checkbox checked={secState} onCheckedChange={(v) => toggleSettingItems(secItems, v === true)} disabled={full} />
                                            <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sec.label}</span>
                                            <span className="text-[11px] text-muted-foreground">
                                              {secCount}/{secItems.length}
                                            </span>
                                          </label>
                                          <div className="space-y-1.5">
                                            {secItems.map((p) => (
                                              <label key={p.key} className="flex cursor-pointer items-center gap-2 text-sm">
                                                <Checkbox checked={hasSettingSub(p.key)} onCheckedChange={(v) => togglePerm(p.key, v === true)} disabled={full} />
                                                <span className="flex-1">{p.label}</span>
                                                <code className="text-[10px] text-muted-foreground">{p.key}</code>
                                              </label>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>

                              {/* Các quyền Hệ thống còn lại */}
                              <div className="grid gap-x-6 gap-y-1.5 pt-0.5 sm:grid-cols-2 xl:grid-cols-3">
                                {otherPerms.map((p) => (
                                  <label key={p.key} className="flex cursor-pointer items-center gap-2 text-sm">
                                    <Checkbox checked={full || perms.has(p.key)} onCheckedChange={(v) => togglePerm(p.key, v === true)} disabled={full} />
                                    <span className="flex-1">{p.label}</span>
                                    <code className="text-[10px] text-muted-foreground">{p.key}</code>
                                  </label>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const count = g.permissions.filter((p) => full || perms.has(p.key)).length;
                      const state = count === g.permissions.length ? true : count > 0 ? 'indeterminate' : false;
                      return (
                        <div key={g.key} className="rounded-lg border">
                          <label className="flex cursor-pointer items-center gap-2 border-b bg-muted/40 px-3 py-2">
                            <Checkbox checked={state} onCheckedChange={(v) => toggleGroup(g, v === true)} disabled={full} />
                            <span className="flex-1 text-sm font-semibold">{g.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {count}/{g.permissions.length}
                            </span>
                          </label>
                          <div className="space-y-1.5 p-3">
                            {g.permissions.map((p) => (
                              <label key={p.key} className="flex cursor-pointer items-center gap-2 text-sm">
                                <Checkbox checked={full || perms.has(p.key)} onCheckedChange={(v) => togglePerm(p.key, v === true)} disabled={full} />
                                <span className="flex-1">{p.label}</span>
                                <code className="text-[10px] text-muted-foreground">{p.key}</code>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!full && !perms.has('admin.access') && <p className="text-xs text-amber-600 dark:text-amber-400">Lưu ý: thiếu quyền “Truy cập trang quản trị” thì thành viên thuộc vai trò này không thể đăng nhập trang quản trị.</p>}
              </Section>

              {form.id && canManage && (
                <div className="flex items-center justify-between rounded-xl border border-dashed p-4">
                  <div className="text-sm">
                    <div className="font-medium">Xoá vai trò</div>
                    <div className="text-xs text-muted-foreground">
                      {form.isSystem ? 'Vai trò hệ thống không thể xoá.' : current && current._count.users > 0 ? `Đang có ${current._count.users} thành viên thuộc vai trò này — hãy chuyển họ sang vai trò khác trước.` : 'Vai trò chưa được gán cho thành viên nào.'}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={form.isSystem || (current?._count.users ?? 0) > 0 || remove.isPending}
                    onClick={async () => {
                      if (await confirm({ title: `Xoá vai trò "${form.name}"?`, destructive: true, confirmText: 'Xoá' })) remove.mutate(form.id!);
                    }}
                  >
                    <Trash2 /> Xoá
                  </Button>
                </div>
              )}
            </fieldset>
          )}
        </div>
      </PageBody>
    </>
  );
}
