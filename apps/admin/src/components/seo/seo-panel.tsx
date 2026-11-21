'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, CircleAlert, XCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Field } from '@/components/common/field';
import { ImageIdField } from '@/components/media/media-picker';
import type { SeoFields } from '@/lib/types';
import { cn } from '@/lib/utils';
import { analyzeSeo } from './seo-analyzer';

interface SeoPanelProps {
  value: SeoFields;
  onChange: (patch: Partial<SeoFields>) => void;
  title: string;
  slug: string;
  content: string;
  /** Đường dẫn hiển thị trong bản xem trước Google, vd https://site.com/blog/abc */
  url: string;
  hasImage?: boolean;
  siteName?: string;
}

function Counter({ value, min, max }: { value: number; min: number; max: number }) {
  return <span className={cn('text-xs tabular-nums', value === 0 ? 'text-muted-foreground' : value < min || value > max ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>{value}/{max}</span>;
}

type SchemaJson = Record<string, unknown> | unknown[] | null;

const toText = (v: SchemaJson) => (v ? JSON.stringify(v, null, 2) : '');

/** Ô nhập Schema JSON-LD (controlled): chấp nhận object hoặc mảng JSON, báo lỗi khi JSON sai */
function SchemaJsonField({ value, onChange }: { value: SchemaJson; onChange: (v: SchemaJson) => void }) {
  const [text, setText] = useState(() => toText(value));
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(value);

  // giá trị đổi từ bên ngoài (tải lại, hoàn tác...) mà khác nội dung đang hiển thị -> cập nhật lại ô nhập
  if (value !== synced) {
    setSynced(value);
    let same = false;
    try {
      same = text.trim() ? JSON.stringify(JSON.parse(text)) === JSON.stringify(value) : !value;
    } catch {
      same = false;
    }
    if (!same && !error) setText(toText(value));
  }

  const handle = (raw: string) => {
    setText(raw);
    const v = raw.trim();
    if (!v) {
      setError(null);
      onChange(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(v);
      if (!parsed || typeof parsed !== 'object') {
        setError('Schema phải là object {...} hoặc mảng [...] JSON');
        return;
      }
      setError(null);
      onChange(parsed as SchemaJson);
    } catch (err) {
      setError(`JSON không hợp lệ (chưa được áp dụng): ${err instanceof Error ? err.message : ''}`.trim());
    }
  };

  return (
    <Field label="Schema JSON-LD tuỳ chỉnh" help="Bổ sung structured data (tự động đã có Article/Product/Breadcrumb). Nhập object hoặc mảng JSON." error={error ?? undefined}>
      <Textarea
        value={text}
        onChange={(e) => handle(e.target.value)}
        rows={5}
        className={cn('font-mono text-xs', error && 'border-destructive focus-visible:ring-destructive/30')}
        aria-invalid={!!error}
        placeholder='{"@context":"https://schema.org", ...}'
      />
    </Field>
  );
}

/** Panel SEO: xem trước Google, meta, từ khoá, OG image, robots, JSON-LD + chấm điểm */
export function SeoPanel({ value, onChange, title, slug, content, url, hasImage, siteName = '' }: SeoPanelProps) {
  const seoTitle = value.seoTitle || title;
  const result = useMemo(
    () => analyzeSeo({ title, seoTitle: value.seoTitle, seoDescription: value.seoDescription, keyword: value.seoKeywords?.split(',')[0], slug, content, hasImage }),
    [title, value.seoTitle, value.seoDescription, value.seoKeywords, slug, content, hasImage],
  );
  // khoá theo ngôn ngữ của bản dịch -> ô JSON-LD không mang nội dung đang gõ sang ngôn ngữ khác
  const scope = 'locale' in value ? String((value as { locale?: unknown }).locale ?? '') : '';
  const scoreColor = result.score >= 80 ? 'text-emerald-600 dark:text-emerald-400 border-emerald-500' : result.score >= 50 ? 'text-amber-600 dark:text-amber-400 border-amber-500' : 'text-red-600 dark:text-red-400 border-red-500';

  return (
    <div className="space-y-4">
      {/* Google preview */}
      <div className="rounded-lg border bg-white p-3 text-left dark:bg-zinc-950">
        <div className="truncate text-xs text-[#202124] dark:text-zinc-400">{url}</div>
        <div className="truncate text-lg leading-snug text-[#1a0dab] dark:text-blue-400">
          {seoTitle}
          {siteName && ` | ${siteName}`}
        </div>
        <div className="line-clamp-2 text-sm text-[#4d5156] dark:text-zinc-400">{value.seoDescription || 'Thêm mô tả meta để kiểm soát đoạn trích hiển thị trên Google.'}</div>
      </div>

      <div className="flex items-center gap-3">
        <div className={cn('flex size-12 items-center justify-center rounded-full border-4 text-sm font-bold', scoreColor)}>{result.score}</div>
        <div className="text-sm">
          <div className="font-medium">Điểm SEO</div>
          <div className="text-xs text-muted-foreground">{result.score >= 80 ? 'Tốt' : result.score >= 50 ? 'Cần cải thiện' : 'Kém'}</div>
        </div>
      </div>

      <Field label="Từ khoá chính" help="Từ khoá đầu tiên dùng để phân tích; các từ khoá khác cách nhau bởi dấu phẩy">
        <Input value={value.seoKeywords ?? ''} onChange={(e) => onChange({ seoKeywords: e.target.value })} placeholder="vd: điện thoại giá rẻ" />
      </Field>
      <Field label="Tiêu đề SEO" action={<Counter value={(value.seoTitle ?? '').length} min={30} max={60} />}>
        <Input value={value.seoTitle ?? ''} onChange={(e) => onChange({ seoTitle: e.target.value })} placeholder={title} />
      </Field>
      <Field label="Mô tả meta" action={<Counter value={(value.seoDescription ?? '').length} min={120} max={160} />}>
        <Textarea value={value.seoDescription ?? ''} onChange={(e) => onChange({ seoDescription: e.target.value })} rows={3} />
      </Field>

      <Accordion type="multiple" className="rounded-lg border px-3">
        <AccordionItem value="checks">
          <AccordionTrigger className="text-sm">Phân tích ({result.checks.filter((c) => c.ok !== true).length} gợi ý)</AccordionTrigger>
          <AccordionContent>
            <ul className="space-y-1.5 text-xs">
              {result.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  {c.ok === true ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : c.ok === 'warn' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-500" />}
                  {c.message}
                </li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="social">
          <AccordionTrigger className="text-sm">Chia sẻ mạng xã hội (Open Graph)</AccordionTrigger>
          <AccordionContent className="space-y-2">
            <p className="text-xs text-muted-foreground">Ảnh hiển thị khi chia sẻ lên Facebook, Zalo... (khuyến nghị 1200×630). Bỏ trống sẽ dùng ảnh đại diện.</p>
            <ImageIdField value={value.ogImageId} onChange={(id) => onChange({ ogImageId: id })} aspect="aspect-[1200/630]" />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="advanced" className="border-b-0">
          <AccordionTrigger className="text-sm">Nâng cao</AccordionTrigger>
          <AccordionContent className="space-y-4">
            <Field label="Canonical URL" help="Chỉ điền khi nội dung trùng lặp với URL khác">
              <Input value={value.canonicalUrl ?? ''} onChange={(e) => onChange({ canonicalUrl: e.target.value })} placeholder="https://..." />
            </Field>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Không cho Google index (noindex)</Label>
              <Switch checked={!!value.noindex} onCheckedChange={(v) => onChange({ noindex: v })} />
            </div>
            {'nofollow' in value || value.nofollow !== undefined ? (
              <div className="flex items-center justify-between">
                <Label className="text-sm">Không theo dõi liên kết (nofollow)</Label>
                <Switch checked={!!value.nofollow} onCheckedChange={(v) => onChange({ nofollow: v })} />
              </div>
            ) : null}
            <SchemaJsonField key={scope} value={value.schemaJson ?? null} onChange={(schemaJson) => onChange({ schemaJson })} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
