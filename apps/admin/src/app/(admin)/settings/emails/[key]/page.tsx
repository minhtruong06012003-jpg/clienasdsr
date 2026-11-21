'use client';

import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Code2, Copy, Loader2, Monitor, RotateCcw, Save, Send, Smartphone, Type } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { useConfirm } from '@/components/common/confirm-dialog';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import type { EmailTemplateDetail } from '../_components/types';

type Mode = 'code' | 'rich';

export default function EmailTemplateEditPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  return (
    <Suspense>
      <Editor templateKey={decodeURIComponent(key)} />
    </Suspense>
  );
}

function Editor({ templateKey }: { templateKey: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canManage = can('settings.emails');
  const { languages, defaultLocale } = useLanguages();

  const [locale, setLocaleState] = useState(sp.get('locale') || '');
  const active = locale || defaultLocale;

  const q = useQuery({
    queryKey: ['email-templates', templateKey, active],
    queryFn: () => api.get<EmailTemplateDetail>(`/admin/email-templates/${encodeURIComponent(templateKey)}`, { locale: active }),
    enabled: !!active,
  });
  const listQ = useQuery({ queryKey: ['email-templates'], queryFn: () => api.get<{ data: { key: string; locales: Record<string, { customized: boolean }> }[] }>('/admin/email-templates') });

  const [form, setForm] = useState<{ subject: string; html: string; enabled: boolean } | null>(null);
  const [loadedFor, setLoadedFor] = useState('');
  const [mode, setMode] = useState<Mode>('code');
  const [mobile, setMobile] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // nạp form khi đổi locale / tải xong
  useEffect(() => {
    if (!q.data) return;
    const id = `${q.data.key}:${q.data.locale}`;
    if (loadedFor === id) return;
    setForm({ subject: q.data.subject, html: q.data.html, enabled: q.data.enabled });
    setLoadedFor(id);
  }, [q.data, loadedFor]);

  const dirty = !!q.data && !!form && (form.subject !== q.data.subject || form.html !== q.data.html || form.enabled !== q.data.enabled);

  const setLocale = async (code: string) => {
    if (code === active) return;
    if (dirty && !(await confirm({ title: 'Bỏ thay đổi chưa lưu?', description: 'Thay đổi ở ngôn ngữ hiện tại chưa được lưu sẽ bị mất.', confirmText: 'Bỏ thay đổi', destructive: true }))) return;
    setLoadedFor('');
    setLocaleState(code);
    router.replace(`?locale=${code}`, { scroll: false });
  };

  const save = useMutation({
    mutationFn: () => api.put<EmailTemplateDetail>(`/admin/email-templates/${encodeURIComponent(templateKey)}`, { locale: active, ...form }),
    onSuccess: (data) => {
      toast.success('Đã lưu mẫu email');
      qc.setQueryData(['email-templates', templateKey, active], data);
      qc.invalidateQueries({ queryKey: ['email-templates'] });
      setForm({ subject: data.subject, html: data.html, enabled: data.enabled });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const doSave = useCallback(() => {
    if (canManage && form && !save.isPending) save.mutate();
  }, [canManage, form, save]);
  useUnsavedGuard(dirty, doSave);

  const reset = useMutation({
    mutationFn: () => api.delete<EmailTemplateDetail>(`/admin/email-templates/${encodeURIComponent(templateKey)}?locale=${active}`),
    onSuccess: (data) => {
      toast.success('Đã khôi phục mẫu mặc định');
      qc.setQueryData(['email-templates', templateKey, active], data);
      qc.invalidateQueries({ queryKey: ['email-templates'] });
      setForm({ subject: data.subject, html: data.html, enabled: data.enabled });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const test = useMutation({
    mutationFn: () => api.post<{ success: boolean }>(`/admin/email-templates/${encodeURIComponent(templateKey)}/test`, { locale: active, to: testTo.trim(), subject: form?.subject, html: form?.html }),
    onSuccess: () => {
      toast.success(`Đã gửi email thử tới ${testTo.trim()}`);
      setTestOpen(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // xem trước (debounce theo nội dung đang soạn)
  const debounced = useDebounce(form ? `${form.subject}\u0000${form.html}` : '', 500);
  const preview = useQuery({
    queryKey: ['email-templates', templateKey, active, 'preview', debounced],
    queryFn: () => api.post<{ subject: string; html: string }>(`/admin/email-templates/${encodeURIComponent(templateKey)}/preview`, { locale: active, subject: form?.subject, html: form?.html }),
    enabled: !!form && !!active,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const insertVar = (name: string) => {
    const token = name === 'body' || name === 'message' ? `{{{${name}}}}` : name.startsWith('order.items') || name === 'form.fields' || name === 'downloads' || name === 'order.shippingAddressLines' ? `{{#each ${name}}}\n  {{this}}\n{{/each}}` : `{{${name}}}`;
    if (mode === 'code' && textareaRef.current && form) {
      const el = textareaRef.current;
      const start = el.selectionStart ?? form.html.length;
      const end = el.selectionEnd ?? start;
      const html = form.html.slice(0, start) + token + form.html.slice(end);
      setForm({ ...form, html });
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
      return;
    }
    navigator.clipboard?.writeText(token).then(
      () => toast.success(`Đã sao chép ${token} — dán vào vị trí mong muốn`),
      () => toast.error('Không sao chép được'),
    );
  };

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    if (next === 'rich' && !(await confirm({ title: 'Chuyển sang soạn thảo trực quan?', description: 'Trình soạn thảo trực quan có thể làm hỏng bảng/khối {{#each}} và style của mẫu HTML. Chỉ nên dùng cho email văn bản đơn giản. Bạn luôn có thể Khôi phục mặc định.', confirmText: 'Chuyển' }))) return;
    setMode(next);
  };

  const t = q.data;
  const hasCustom = useCallback((code: string) => !!listQ.data?.data.find((x) => x.key === templateKey)?.locales[code]?.customized, [listQ.data, templateKey]);
  const varGroups = useMemo(() => {
    const vars = t?.vars ?? [];
    const site = vars.filter((v) => v.name.startsWith('site.') || ['adminUrl', 'webUrl', 'year'].includes(v.name));
    return { main: vars.filter((v) => !site.includes(v)), site };
  }, [t]);

  if (q.isLoading || !t || !form) {
    return (
      <>
        <PageHeader title="Mẫu email" breadcrumbs={[{ label: 'Cài đặt', href: '/settings' }, { label: 'Mẫu email', href: '/settings/emails' }]} />
        <PageBody>{q.error ? <p className="text-sm text-destructive">{errorMessage(q.error)}</p> : <Skeleton className="h-96 rounded-xl" />}</PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t.name}
        description={t.description}
        breadcrumbs={[{ label: 'Cài đặt', href: '/settings' }, { label: 'Mẫu email', href: '/settings/emails' }, { label: t.name }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={active} onChange={setLocale} has={hasCustom} />
            <Button variant="outline" size="sm" onClick={() => setTestOpen(true)} disabled={!canManage}>
              <Send /> Gửi thử
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage || reset.isPending || (!t.customized && !dirty)}
              onClick={async () => {
                if (await confirm({ title: 'Khôi phục mẫu mặc định?', description: `Nội dung tuỳ chỉnh của ngôn ngữ ${active.toUpperCase()} sẽ bị thay bằng mẫu mặc định của hệ thống.`, confirmText: 'Khôi phục', destructive: true })) reset.mutate();
              }}
            >
              {reset.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Khôi phục mặc định
            </Button>
            {canManage && (
              <Button size="sm" onClick={doSave} disabled={save.isPending || !dirty}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-6">
            <Section
              title={
                <span className="flex items-center gap-2">
                  Nội dung
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">{t.key}</code>
                  {t.customized ? <Badge className="border-transparent bg-amber-100 text-[11px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Đã tuỳ chỉnh</Badge> : <Badge variant="outline" className="text-[11px] font-normal">Mặc định</Badge>}
                </span>
              }
              description={t.updatedAt ? `Cập nhật ${formatDate(t.updatedAt)}` : undefined}
              actions={
                t.key !== 'layout' && (
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} disabled={!canManage} />
                    <span className={cn(!form.enabled && 'text-muted-foreground')}>{form.enabled ? 'Đang bật' : 'Đang tắt'}</span>
                  </label>
                )
              }
            >
              <Field label="Tiêu đề email" htmlFor="subject" help="Có thể dùng biến, vd. [{{site.name}}] Đơn hàng #{{order.code}}">
                <Input id="subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} disabled={!canManage} />
              </Field>
              <Field
                label="Nội dung (HTML)"
                help={t.key === 'layout' ? 'Bố cục phải chứa {{{body}}} — nơi chèn phần thân của từng email.' : 'Phần thân email; hệ thống tự bọc trong Bố cục chung (logo, màu thương hiệu, footer). Nếu muốn tự viết toàn bộ, thêm thẻ <body> vào nội dung.'}
                action={
                  <div className="inline-flex rounded-md border p-0.5">
                    <button type="button" onClick={() => switchMode('code')} className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs', mode === 'code' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
                      <Code2 className="size-3.5" /> HTML
                    </button>
                    <button type="button" onClick={() => switchMode('rich')} className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs', mode === 'rich' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
                      <Type className="size-3.5" /> Trực quan
                    </button>
                  </div>
                }
              >
                {mode === 'code' ? (
                  <Textarea ref={textareaRef} value={form.html} onChange={(e) => setForm({ ...form, html: e.target.value })} disabled={!canManage} spellCheck={false} className="min-h-[420px] font-mono text-xs leading-relaxed" />
                ) : (
                  <RichTextEditor value={form.html} onChange={(html) => setForm((f) => (f ? { ...f, html } : f))} minHeight={400} compact />
                )}
              </Field>
            </Section>

            <Section title="Biến khả dụng" description={mode === 'code' ? 'Bấm để chèn vào vị trí con trỏ trong ô HTML.' : 'Bấm để sao chép rồi dán vào trình soạn thảo.'}>
              <VarList title="Dữ liệu của email" vars={varGroups.main} onPick={insertVar} />
              <VarList title="Website & liên hệ" vars={varGroups.site} onPick={insertVar} />
              <p className="text-xs text-muted-foreground">
                Cú pháp: <code>{'{{a.b}}'}</code> giá trị (đã escape), <code>{'{{{a.b}}}'}</code> HTML thô, <code>{'{{#each list}}…{{this.x}}…{{/each}}'}</code> lặp, <code>{'{{#if x}}…{{else}}…{{/if}}'}</code> điều kiện, <code>{'{{money order.total}}'}</code> tiền theo cài đặt, <code>{'{{date order.createdAt}}'}</code> ngày giờ.
              </p>
            </Section>
          </div>

          <div className="min-w-0">
            <Section
              className="xl:sticky xl:top-20"
              title="Xem trước"
              description={preview.data ? <span className="line-clamp-1">Tiêu đề: {preview.data.subject || '(trống)'}</span> : 'Render với dữ liệu mẫu'}
              actions={
                <div className="flex items-center gap-1">
                  {preview.isFetching && <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" />}
                  <Button variant={mobile ? 'ghost' : 'secondary'} size="icon" className="size-7" onClick={() => setMobile(false)} aria-label="Xem desktop">
                    <Monitor className="size-4" />
                  </Button>
                  <Button variant={mobile ? 'secondary' : 'ghost'} size="icon" className="size-7" onClick={() => setMobile(true)} aria-label="Xem mobile">
                    <Smartphone className="size-4" />
                  </Button>
                </div>
              }
            >
              {preview.error ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{errorMessage(preview.error)}</p>
              ) : (
                <div className="cms-light -m-4 overflow-auto rounded-b-xl bg-zinc-100 p-3">
                  {preview.data ? <iframe title="Xem trước email" sandbox="" srcDoc={preview.data.html} className={cn('mx-auto block h-[70vh] rounded-md bg-white shadow-sm transition-all', mobile ? 'w-[390px]' : 'w-full')} /> : <Skeleton className="h-[70vh]" />}
                </div>
              )}
            </Section>
          </div>
        </div>
      </PageBody>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Gửi email thử</DialogTitle>
            <DialogDescription>Gửi mẫu “{t.name}” ({active.toUpperCase()}) với dữ liệu mẫu, dùng nội dung đang soạn (kể cả chưa lưu). Cần cấu hình SMTP tại Cài đặt › Email.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (testTo.trim()) test.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="test-to">Email nhận</Label>
              <Input id="test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" autoFocus required />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTestOpen(false)}>
                Huỷ
              </Button>
              <Button type="submit" disabled={test.isPending || !testTo.trim()}>
                {test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Gửi
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function VarList({ title, vars, onPick }: { title: string; vars: { name: string; label: string }[]; onPick: (name: string) => void }) {
  if (!vars.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {vars.map((v) => (
          <button key={v.name} type="button" onClick={() => onPick(v.name)} title={v.label} className="group inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:border-primary hover:text-primary">
            <Braces className="size-3 text-muted-foreground group-hover:text-primary" />
            <code>{v.name}</code>
            <Copy className="size-3 opacity-0 transition group-hover:opacity-60" />
          </button>
        ))}
      </div>
    </div>
  );
}
