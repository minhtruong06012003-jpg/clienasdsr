'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Languages as LanguagesIcon, Loader2, Type, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import type { Language } from '@/lib/types';

/** Một vài ngôn ngữ phổ biến để điền nhanh */
const PRESETS: Omit<Language, 'isDefault' | 'enabled' | 'sortOrder'>[] = [
  { code: 'vi', name: 'Tiếng Việt', nativeName: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'en', name: 'Tiếng Anh', nativeName: 'English', flag: '🇬🇧' },
  { code: 'id', name: 'Tiếng Indonesia', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'zh-cn', name: 'Tiếng Trung', nativeName: '简体中文', flag: '🇨🇳' },
  { code: 'ja', name: 'Tiếng Nhật', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Tiếng Hàn', nativeName: '한국어', flag: '🇰🇷' },
  { code: 'fr', name: 'Tiếng Pháp', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'Tiếng Đức', nativeName: 'Deutsch', flag: '🇩🇪' },
  { code: 'th', name: 'Tiếng Thái', nativeName: 'ไทย', flag: '🇹🇭' },
];

type LangForm = Omit<Language, 'sortOrder'> & { sortOrder: number | string };

const blank = (sortOrder: number): LangForm => ({ code: '', name: '', nativeName: '', flag: '', enabled: true, isDefault: false, sortOrder });

export default function LanguagesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ form: LangForm; isNew: boolean } | null>(null);

  const list = useQuery({ queryKey: ['languages'], queryFn: () => api.get<Language[]>('/admin/languages') });
  const langs = list.data ?? [];

  const upsert = useMutation({
    mutationFn: (l: Partial<Language> & { code: string; name: string }) =>
      api.post<Language[]>('/admin/languages', {
        code: l.code,
        name: l.name,
        // chuỗi rỗng = xoá giá trị cũ (undefined sẽ bị bỏ qua và giữ nguyên giá trị cũ)
        nativeName: l.nativeName ?? '',
        flag: l.flag ?? '',
        enabled: l.enabled,
        isDefault: l.isDefault,
        sortOrder: l.sortOrder != null ? Number(l.sortOrder) || 0 : undefined,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['languages'], data);
      void qc.invalidateQueries({ queryKey: ['languages'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (code: string) => api.delete<Language[]>(`/admin/languages/${code}`),
    onSuccess: (data) => {
      toast.success('Đã xoá ngôn ngữ');
      qc.setQueryData(['languages'], data);
      void qc.invalidateQueries({ queryKey: ['languages'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    if (!f.code.trim() || !f.name.trim()) return toast.error('Vui lòng nhập mã và tên ngôn ngữ');
    if (editing.isNew && langs.some((l) => l.code === f.code.trim().toLowerCase())) return toast.error('Mã ngôn ngữ đã tồn tại');
    await upsert.mutateAsync({ ...f, code: f.code.trim().toLowerCase(), sortOrder: Number(f.sortOrder) || 0 });
    toast.success(editing.isNew ? 'Đã thêm ngôn ngữ' : 'Đã cập nhật');
    setEditing(null);
  };

  const move = async (index: number, dir: -1 | 1) => {
    const ordered = [...langs];
    const target = index + dir;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    // đánh lại thứ tự liên tục cho các dòng bị đổi
    const changed = ordered.map((l, i) => ({ ...l, sortOrder: i })).filter((l, i) => langs[i]?.code !== l.code || langs[i]?.sortOrder !== i);
    for (const l of changed) await upsert.mutateAsync(l);
  };

  const setF = (patch: Partial<LangForm>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <>
      <PageHeader
        title="Ngôn ngữ"
        description="Các ngôn ngữ nội dung của website. Ngôn ngữ mặc định không có tiền tố trên URL."
        actions={
          <>
            {/* chữ cố định trên website (nút, nhãn, thông báo) dịch ở màn riêng, không cần sửa code */}
            <Button variant="outline" asChild>
              <Link href="/languages/strings">
                <Type /> Bản dịch giao diện
              </Link>
            </Button>
            <Button onClick={() => setEditing({ form: blank(langs.length), isNew: true })}>
              <Plus /> Thêm ngôn ngữ
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-16 text-xs font-semibold uppercase text-muted-foreground">Thứ tự</TableHead>
                <TableHead className="text-xs font-semibold uppercase text-muted-foreground">Ngôn ngữ</TableHead>
                <TableHead className="text-xs font-semibold uppercase text-muted-foreground">Mã</TableHead>
                <TableHead className="text-xs font-semibold uppercase text-muted-foreground">Tiền tố URL</TableHead>
                <TableHead className="text-xs font-semibold uppercase text-muted-foreground">Bật</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : langs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-6">
                    <EmptyState icon={LanguagesIcon} title="Chưa có ngôn ngữ" />
                  </TableCell>
                </TableRow>
              ) : (
                langs.map((l, i) => (
                  <TableRow key={l.code}>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon-xs" disabled={i === 0 || upsert.isPending} onClick={() => move(i, -1)} aria-label="Lên">
                          <ArrowUp />
                        </Button>
                        <Button variant="ghost" size="icon-xs" disabled={i === langs.length - 1 || upsert.isPending} onClick={() => move(i, 1)} aria-label="Xuống">
                          <ArrowDown />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <button type="button" className="flex items-center gap-3 text-left" onClick={() => setEditing({ form: { ...l, nativeName: l.nativeName ?? '', flag: l.flag ?? '' }, isNew: false })}>
                        <span className="text-2xl leading-none">{l.flag || '🏳️'}</span>
                        <span>
                          <span className="flex items-center gap-2 font-medium">
                            {l.name}
                            {l.isDefault && (
                              <Badge variant="secondary" className="gap-1">
                                <Star className="size-3 fill-amber-400 text-amber-400" /> Mặc định
                              </Badge>
                            )}
                          </span>
                          {l.nativeName && <span className="text-xs text-muted-foreground">{l.nativeName}</span>}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase">{l.code}</code>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{l.isDefault ? '/ (không tiền tố)' : `/${l.code}/`}</TableCell>
                    <TableCell>
                      <Switch checked={l.enabled} disabled={l.isDefault || upsert.isPending} onCheckedChange={(v) => upsert.mutate({ ...l, enabled: v })} aria-label="Bật/tắt" />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing({ form: { ...l, nativeName: l.nativeName ?? '', flag: l.flag ?? '' }, isNew: false })}>
                            <Pencil /> Chỉnh sửa
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/languages/strings?locale=${l.code}`}>
                              <Type /> Dịch giao diện
                            </Link>
                          </DropdownMenuItem>
                          {!l.isDefault && (
                            <DropdownMenuItem
                              onClick={async () => {
                                if (!(await confirm({ title: `Đặt ${l.name} làm ngôn ngữ mặc định?`, description: 'URL của ngôn ngữ mặc định sẽ không có tiền tố. Các liên kết cũ có thể thay đổi — hãy cân nhắc tạo chuyển hướng 301.' }))) return;
                                await upsert.mutateAsync({ ...l, isDefault: true });
                                toast.success('Đã đổi ngôn ngữ mặc định');
                              }}
                            >
                              <Star /> Đặt làm mặc định
                            </DropdownMenuItem>
                          )}
                          {!l.isDefault && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={async () => {
                                  if (await confirm({ title: `Xoá ngôn ngữ ${l.name}?`, description: 'Nội dung đã dịch sang ngôn ngữ này vẫn còn trong cơ sở dữ liệu nhưng sẽ không hiển thị nữa.', destructive: true, confirmText: 'Xoá' }))
                                    remove.mutate(l.code);
                                }}
                              >
                                <Trash2 /> Xoá
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">Mẹo: tắt ngôn ngữ để ẩn tạm thời khỏi website mà không mất bản dịch. Mã ngôn ngữ theo chuẩn ISO (vd: vi, en, zh-cn). Sau khi thêm ngôn ngữ, dịch nội dung ở từng trang/bài viết/sản phẩm và dịch chữ cố định ở mục Bản dịch giao diện.</p>
      </PageBody>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? 'Thêm ngôn ngữ' : `Sửa ngôn ngữ: ${editing?.form.name}`}</DialogTitle>
            <DialogDescription>Ngôn ngữ mới sẽ xuất hiện ở các ô nhập đa ngôn ngữ trong toàn bộ trang quản trị.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              {editing.isNew && (
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.filter((p) => !langs.some((l) => l.code === p.code)).map((p) => (
                    <button key={p.code} type="button" onClick={() => setF({ ...p })} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">
                      <span>{p.flag}</span> {p.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-[1fr_88px] gap-3">
                <Field label="Mã ngôn ngữ" required help="vd: vi, en, zh-cn">
                  <Input value={editing.form.code} disabled={!editing.isNew} onChange={(e) => setF({ code: e.target.value.toLowerCase() })} placeholder="en" maxLength={10} />
                </Field>
                <Field label="Cờ (emoji)">
                  <Input value={editing.form.flag ?? ''} onChange={(e) => setF({ flag: e.target.value })} placeholder="🇬🇧" className="text-center text-lg" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tên hiển thị" required>
                  <Input value={editing.form.name} onChange={(e) => setF({ name: e.target.value })} placeholder="Tiếng Anh" />
                </Field>
                <Field label="Tên bản địa">
                  <Input value={editing.form.nativeName ?? ''} onChange={(e) => setF({ nativeName: e.target.value })} placeholder="English" />
                </Field>
              </div>
              <Field label="Thứ tự">
                <Input type="number" value={editing.form.sortOrder} onChange={(e) => setF({ sortOrder: e.target.value })} className="w-28" />
              </Field>
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <Label>Bật ngôn ngữ</Label>
                  <Switch checked={editing.form.enabled || editing.form.isDefault} disabled={editing.form.isDefault} onCheckedChange={(v) => setF({ enabled: v })} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Ngôn ngữ mặc định</Label>
                    <p className="text-xs text-muted-foreground">Chỉ có một ngôn ngữ mặc định</p>
                  </div>
                  <Switch checked={editing.form.isDefault} disabled={!editing.isNew && langs.find((l) => l.code === editing.form.code)?.isDefault} onCheckedChange={(v) => setF({ isDefault: v })} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Huỷ
            </Button>
            <Button onClick={save} disabled={upsert.isPending}>
              {upsert.isPending && <Loader2 className="animate-spin" />} Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
