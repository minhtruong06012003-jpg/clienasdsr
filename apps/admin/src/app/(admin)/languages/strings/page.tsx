'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Save, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { resolveUiStrings, type UiStringCustomKey, type UiStringDef, type UiStringsStore } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';

/** Dữ liệu GET /admin/ui-strings */
interface UiStringsResponse extends UiStringsStore {
  definitions: UiStringDef[];
  defaults: Record<string, Record<string, string>>;
}

/** Một dòng hiển thị: chuỗi có sẵn hoặc khoá riêng */
interface Row {
  key: string;
  group: string;
  description?: string;
  custom: boolean;
}

/**
 * Màn dịch chuỗi giao diện cố định (nút, nhãn, thông báo) cho từng ngôn ngữ.
 * Thêm ngôn ngữ mới chỉ cần dịch ở đây, không phải sửa code; frontend đọc qua
 * /public/bootstrap (trường uiStrings) hoặc /public/ui-strings?locale=xx.
 */
export default function UiStringsPage() {
  // useSearchParams cần Suspense để Next prerender được trang
  return (
    <Suspense>
      <UiStringsEditor />
    </Suspense>
  );
}

function UiStringsEditor() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { all: languages, defaultLocale } = useLanguages();
  // ?locale=xx (từ menu từng ngôn ngữ ở trang Ngôn ngữ) chọn sẵn tab
  const [picked, setPicked] = useState<string | null>(useSearchParams().get('locale'));
  const [search, setSearch] = useState('');
  // bản đang sửa chưa lưu: edits[locale][key]; tách theo ngôn ngữ để chuyển tab không mất chữ đã gõ
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [keyForm, setKeyForm] = useState<UiStringCustomKey | null>(null);

  const q = useQuery({ queryKey: ['ui-strings'], queryFn: () => api.get<UiStringsResponse>('/admin/ui-strings') });
  const data = q.data;
  const active = picked && languages.some((l) => l.code === picked) ? picked : defaultLocale;

  /** Các dòng cần dịch: chuỗi có sẵn trước, khoá riêng sau */
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return [...data.definitions.map((d) => ({ ...d, custom: false })), ...data.custom.map((c) => ({ key: c.key, group: 'Khoá riêng', description: c.description, custom: true }))];
  }, [data]);

  /** Giá trị sẽ hiện ra nếu để trống ô của ngôn ngữ đang chọn (dùng làm placeholder) */
  const fallback = useMemo(() => {
    if (!data) return {};
    const withoutActive = { ...data, values: { ...data.values, [active]: {} } };
    return resolveUiStrings(active, defaultLocale, withoutActive);
  }, [data, active, defaultLocale]);

  /** Bản tham chiếu để người dịch đối chiếu: ngôn ngữ mặc định (nếu đang dịch chính nó thì lấy tiếng Anh) */
  const refLocale = active === defaultLocale ? (defaultLocale === 'en' ? 'vi' : 'en') : defaultLocale;
  const reference = useMemo(() => (data ? resolveUiStrings(refLocale, defaultLocale, data) : {}), [data, refLocale, defaultLocale]);

  const valueOf = (locale: string, key: string) => edits[locale]?.[key] ?? data?.values[locale]?.[key] ?? '';
  const dirtyLocales = Object.keys(edits).filter((loc) => Object.entries(edits[loc]).some(([k, v]) => v.trim() !== (data?.values[loc]?.[k] ?? '')));
  const dirty = dirtyLocales.length > 0;

  const save = useMutation({
    mutationFn: async () => {
      let latest: UiStringsStore | null = null;
      // lưu lần lượt từng ngôn ngữ có thay đổi (gửi đủ bộ của ngôn ngữ đó vì API ghi đè cả bộ)
      for (const loc of dirtyLocales) {
        const values = Object.fromEntries(rows.map((r) => [r.key, valueOf(loc, r.key)]).filter(([, v]) => v.trim()));
        latest = await api.put<UiStringsStore>(`/admin/ui-strings/${loc}`, { values });
      }
      return latest;
    },
    onSuccess: (latest) => {
      if (latest) qc.setQueryData<UiStringsResponse>(['ui-strings'], (old) => (old ? { ...old, ...latest } : old));
      setEdits({});
      toast.success('Đã lưu bản dịch giao diện');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const saveKey = useMutation({
    mutationFn: (k: UiStringCustomKey) => api.post<UiStringsStore>('/admin/ui-strings/keys', k),
    onSuccess: (latest) => {
      qc.setQueryData<UiStringsResponse>(['ui-strings'], (old) => (old ? { ...old, ...latest } : old));
      setKeyForm(null);
      toast.success('Đã lưu khoá');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const removeKey = useMutation({
    mutationFn: (key: string) => api.delete<UiStringsStore>(`/admin/ui-strings/keys/${encodeURIComponent(key)}`),
    onSuccess: (latest, key) => {
      qc.setQueryData<UiStringsResponse>(['ui-strings'], (old) => (old ? { ...old, ...latest } : old));
      // bỏ chữ đang gõ dở của khoá đã xoá để không bị tính là thay đổi
      setEdits((e) => Object.fromEntries(Object.entries(e).map(([loc, d]) => [loc, Object.fromEntries(Object.entries(d).filter(([k]) => k !== key))])));
      toast.success('Đã xoá khoá');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  useUnsavedGuard(dirty, () => save.mutate());

  const term = search.trim().toLowerCase();
  const visible = term ? rows.filter((r) => [r.key, r.description, valueOf(active, r.key), reference[r.key]].some((s) => s?.toLowerCase().includes(term))) : rows;
  const groups = [...new Set(visible.map((r) => r.group))];
  const translated = rows.filter((r) => valueOf(active, r.key).trim() || data?.defaults[active]?.[r.key]).length;
  const activeLang = languages.find((l) => l.code === active);

  return (
    <>
      <PageHeader
        title="Bản dịch giao diện"
        description="Dịch các chữ cố định trên website khách (nút, nhãn, thông báo) cho từng ngôn ngữ, không cần sửa code. Giao diện Admin Panel không dịch ở đây — chữ của admin cố định trong code."
        breadcrumbs={[{ label: 'Ngôn ngữ', href: '/languages' }, { label: 'Bản dịch giao diện' }]}
        actions={
          <>
            <Button variant="outline" onClick={() => setKeyForm({ key: '', description: '' })}>
              <Plus /> Thêm khoá
            </Button>
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3">
          <LocaleTabs languages={languages} value={active} onChange={setPicked} has={(code) => dirtyLocales.includes(code) || Object.keys(data?.values[code] ?? {}).length > 0 || !!data?.defaults[code]} />
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm khoá hoặc nội dung..." className="pl-8" />
          </div>
          {data && (
            <span className="text-xs text-muted-foreground">
              {activeLang?.flag} {activeLang?.name ?? active}: đã có bản dịch {translated}/{rows.length}
            </span>
          )}
        </div>

        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Không có chuỗi nào khớp</p>
        ) : (
          groups.map((group) => (
            <section key={group} className="overflow-hidden rounded-xl border bg-card">
              <h2 className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">{group}</h2>
              <div className="divide-y">
                {visible
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <div key={r.key} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:items-center md:gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{r.key}</code>
                          {r.custom && (
                            <Badge variant="secondary" className="shrink-0">
                              Riêng
                            </Badge>
                          )}
                        </div>
                        {r.description && <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>}
                        {reference[r.key] && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={reference[r.key]}>
                            <span className="uppercase">{refLocale}</span>: {reference[r.key]}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          value={valueOf(active, r.key)}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [active]: { ...prev[active], [r.key]: e.target.value } }))}
                          placeholder={fallback[r.key] || 'Chưa có bản dịch'}
                          aria-label={`Bản dịch ${r.key}`}
                        />
                        {r.custom && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Xoá khoá ${r.key}`}
                            disabled={removeKey.isPending}
                            onClick={async () => {
                              if (await confirm({ title: `Xoá khoá ${r.key}?`, description: 'Bản dịch của khoá này ở mọi ngôn ngữ cũng bị xoá. Frontend đang dùng khoá này sẽ hiện chuỗi rỗng.', destructive: true, confirmText: 'Xoá' }))
                                removeKey.mutate(r.key);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ))
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Ô để trống sẽ dùng chữ hiện mờ trong ô (bản có sẵn của ngôn ngữ đó, nếu không có thì tiếng Anh, sau cùng là ngôn ngữ mặc định).</p>
          <p>
            Frontend lấy chuỗi đã dịch qua trường <code className="rounded bg-muted px-1">uiStrings</code> của <code className="rounded bg-muted px-1">GET /api/public/bootstrap?locale=xx</code> hoặc <code className="rounded bg-muted px-1">GET /api/public/ui-strings?locale=xx</code>. Dùng &quot;Thêm khoá&quot; cho chữ riêng của từng dự án (vd: header.hotline).
          </p>
        </div>
      </PageBody>

      <Dialog open={!!keyForm} onOpenChange={(o) => !o && setKeyForm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Thêm khoá chuỗi</DialogTitle>
            <DialogDescription>Khoá riêng cho frontend của dự án, sau đó dịch ở từng ngôn ngữ.</DialogDescription>
          </DialogHeader>
          {keyForm && (
            <div className="space-y-4">
              <Field label="Khoá" required help="Chữ, số, dấu chấm, gạch dưới, gạch ngang. vd: header.hotline">
                <Input value={keyForm.key} onChange={(e) => setKeyForm({ ...keyForm, key: e.target.value.trim() })} placeholder="header.hotline" maxLength={80} autoFocus />
              </Field>
              <Field label="Mô tả">
                <Input value={keyForm.description ?? ''} onChange={(e) => setKeyForm({ ...keyForm, description: e.target.value })} placeholder="Chữ hiển thị cạnh số hotline ở header" maxLength={200} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyForm(null)}>
              Huỷ
            </Button>
            <Button onClick={() => keyForm && (keyForm.key ? saveKey.mutate(keyForm) : toast.error('Vui lòng nhập khoá'))} disabled={saveKey.isPending}>
              {saveKey.isPending && <Loader2 className="animate-spin" />} Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
