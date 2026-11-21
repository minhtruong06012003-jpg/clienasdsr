'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTree, Loader2, MapPin, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { MenuItemNode } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { MenuSources } from '@/components/menus/menu-sources';
import { MenuTree } from '@/components/menus/menu-tree';
import { flatten } from '@/components/menus/tree-utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useLanguages } from '@/hooks/use-languages';
import { cn } from '@/lib/utils';

interface Menu {
  id: string;
  name: string;
  location: string | null;
  items: MenuItemNode[];
  updatedAt: string;
}

/** Vị trí menu (GET /admin/menus/locations): lõi + do giao diện khai báo */
interface Location {
  key: string;
  label: string;
  /** core | theme */
  source?: string;
}

/** Nhãn nguồn khai báo vị trí (lõi thì không hiện; nguồn lạ từ dữ liệu cũ hiện nguyên văn) */
const locationSource = (s?: string) => (!s || s === 'core' ? null : s === 'theme' ? 'giao diện' : s);

interface Draft {
  menuId: string;
  name: string;
  location: string | null;
  items: MenuItemNode[];
}

/** Gom tên nội dung gốc từ cache các nguồn đã tải (để hiển thị “Liên kết tới ...”) */
function useRefNames() {
  const qc = useQueryClient();
  const { defaultLocale } = useLanguages();
  const sources = qc.getQueriesData<{ id: string; label: Record<string, string> }[]>({ queryKey: ['menu-source'] });
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, data] of sources) {
      const type = String(key[1]);
      for (const i of data ?? []) out[`${type}:${i.id}`] = i.label[defaultLocale] || Object.values(i.label).find(Boolean) || '';
    }
    return out;
  }, [sources, defaultLocale]);
}

function MenusContent() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const refNames = useRefNames();

  const menus = useQuery({ queryKey: ['menus'], queryFn: () => api.get<Menu[]>('/admin/menus') });
  const locations = useQuery({ queryKey: ['menu-locations'], queryFn: () => api.get<Location[]>('/admin/menus/locations'), staleTime: Infinity });
  const selectedId = (menus.data?.some((m) => m.id === sp.get('id')) ? sp.get('id') : menus.data?.[0]?.id) ?? null;
  const current = menus.data?.find((m) => m.id === selectedId) ?? null;

  // nạp bản nháp khi đổi menu
  useEffect(() => {
    if (current && (!draft || draft.menuId !== current.id)) {
      setDraft({ menuId: current.id, name: current.name, location: current.location, items: current.items ?? [] });
      setDirty(false);
    }
  }, [current, draft]);

  const confirmDiscard = async () =>
    !dirty || (await confirm({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi của menu hiện tại sẽ bị mất.', confirmText: 'Bỏ thay đổi', destructive: true }));

  const selectMenu = async (id: string) => {
    if (id === selectedId) return;
    if (!(await confirmDiscard())) return;
    setDirty(false);
    router.replace(`${pathname}?id=${id}`, { scroll: false });
  };

  /** Tạo menu mới sẽ chuyển sang menu đó -> hỏi trước nếu menu hiện tại đang sửa dở */
  const openCreate = async () => {
    if (!(await confirmDiscard())) return;
    setCreating('');
  };

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !current) throw new Error('Chưa chọn menu');
      if (!draft.name.trim()) throw new Error('Vui lòng nhập tên menu');
      return api.patch<Menu>(`/admin/menus/${current.id}`, { name: draft.name.trim(), location: draft.location, items: draft.items });
    },
    onSuccess: (m) => {
      toast.success('Đã lưu menu');
      setDirty(false);
      setDraft({ menuId: m.id, name: m.name, location: m.location, items: m.items ?? [] });
      void qc.invalidateQueries({ queryKey: ['menus'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const create = useMutation({
    mutationFn: (name: string) => api.post<Menu>('/admin/menus', { name, location: null, items: [] }),
    onSuccess: async (m) => {
      toast.success('Đã tạo menu');
      setCreating(null);
      await qc.invalidateQueries({ queryKey: ['menus'] });
      setDirty(false);
      router.replace(`${pathname}?id=${m.id}`, { scroll: false });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/menus/${id}`),
    onSuccess: async () => {
      toast.success('Đã xoá menu');
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['menus'] });
      router.replace(pathname, { scroll: false });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, doSave);

  const addItems = (items: MenuItemNode[]) => {
    if (!draft) return;
    update({ items: [...draft.items, ...items] });
    toast.success(`Đã thêm ${items.length} mục vào cuối menu`);
  };

  const locationOwner = (key: string) => menus.data?.find((m) => m.location === key && m.id !== current?.id);
  const itemCount = draft ? flatten(draft.items).length : 0;

  return (
    <>
      <PageHeader
        title="Menu"
        description="Tạo menu điều hướng và gán vào vị trí trên giao diện"
        actions={
          <>
            <Button variant="outline" onClick={() => void openCreate()}>
              <Plus /> Tạo menu
            </Button>
            {current && (
              <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu menu
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        {menus.isLoading ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : !menus.data?.length ? (
          <EmptyState
            icon={ListTree}
            title="Chưa có menu nào"
            description="Tạo menu đầu tiên rồi gán vào vị trí header / footer."
            action={
              <Button size="sm" onClick={() => void openCreate()}>
                <Plus /> Tạo menu
              </Button>
            }
          />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
            <div className="space-y-6">
              <section className="rounded-xl border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">Danh sách menu</h3>
                </div>
                <div className="space-y-1 p-2">
                  {menus.data.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => selectMenu(m.id)}
                      className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition', m.id === selectedId ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}
                    >
                      <ListTree className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{m.id === selectedId && draft ? draft.name || m.name : m.name}</span>
                      {m.location && (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {locations.data?.find((l) => l.key === m.location)?.label ?? m.location}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </section>
              <MenuSources onAdd={addItems} disabled={!current} />
            </div>

            {current && draft && draft.menuId === current.id ? (
              <div className="min-w-0 space-y-4">
                <section className="rounded-xl border bg-card">
                  <div className="grid gap-4 border-b p-4 md:grid-cols-2">
                    <Field label="Tên menu" required>
                      <Input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                    </Field>
                    <Field label="Vị trí hiển thị" help={draft.location && locationOwner(draft.location) ? `Đang được dùng bởi “${locationOwner(draft.location)!.name}” — sẽ được chuyển sang menu này khi lưu.` : 'Mỗi vị trí chỉ gán một menu'}>
                      <Select value={draft.location ?? 'none'} onValueChange={(v) => update({ location: v === 'none' ? null : v })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">— Không gán —</SelectItem>
                          {locations.data?.map((l) => {
                            const owner = locationOwner(l.key);
                            return (
                              <SelectItem key={l.key} value={l.key}>
                                <MapPin className="size-3.5" /> {l.label}
                                {locationSource(l.source) && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{locationSource(l.source)}</span>}
                                {owner && <span className="text-xs text-muted-foreground">(đang dùng: {owner.name})</span>}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">Cấu trúc menu</h3>
                        <p className="text-xs text-muted-foreground">Kéo thả để sắp xếp. Kéo sang phải để tạo menu con (tối đa 3 cấp). Bấm vào mục để chỉnh sửa.</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{itemCount} mục</span>
                    </div>
                    <MenuTree items={draft.items} onChange={(items) => update({ items })} refNames={refNames} />
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={async () => {
                        if (await confirm({ title: `Xoá menu “${current.name}”?`, description: current.location ? 'Menu đang được gán vào một vị trí — vị trí đó sẽ trống sau khi xoá.' : undefined, destructive: true, confirmText: 'Xoá menu' }))
                          remove.mutate(current.id);
                      }}
                    >
                      <Trash2 /> Xoá menu
                    </Button>
                    <div className="flex items-center gap-2">
                      {dirty && <span className="text-sm text-amber-600 dark:text-amber-400">Có thay đổi chưa lưu</span>}
                      <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                        {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu menu
                      </Button>
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <Skeleton className="h-96 rounded-xl" />
            )}
          </div>
        )}
      </PageBody>

      <Dialog open={creating !== null} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tạo menu mới</DialogTitle>
          </DialogHeader>
          <form
            id="create-menu"
            onSubmit={(e) => {
              e.preventDefault();
              if (creating?.trim()) create.mutate(creating.trim());
            }}
          >
            <Field label="Tên menu" required>
              <Input value={creating ?? ''} onChange={(e) => setCreating(e.target.value)} placeholder="vd: Menu chân trang" autoFocus />
            </Field>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>
              Huỷ
            </Button>
            <Button type="submit" form="create-menu" disabled={!creating?.trim() || create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />} Tạo menu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function MenusPage() {
  return (
    <Suspense>
      <MenusContent />
    </Suspense>
  );
}
