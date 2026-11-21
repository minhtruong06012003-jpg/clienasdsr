'use client';

import { slugify, type TypeLabels } from '@cmsnt/shared';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { Language } from '@/lib/types';

/**
 * Nhập nhãn (số ít / số nhiều) + slug gốc theo từng ngôn ngữ đang bật — dùng cho loại nội dung và taxonomy.
 * Slug trống sẽ gợi ý từ nhãn số nhiều (người dùng vẫn sửa tay được).
 */
export function LabelsSlugsEditor({
  languages,
  labels,
  slugs,
  onChange,
  defaultLocale,
  disabled,
  slugHint,
}: {
  languages: Language[];
  labels: TypeLabels;
  slugs: Record<string, string>;
  onChange: (next: { labels: TypeLabels; slugs: Record<string, string> }) => void;
  defaultLocale: string;
  disabled?: boolean;
  /** Ví dụ đường dẫn hiển thị dưới ô slug, vd "/{slug}/ten-bai" */
  slugHint?: (slug: string, locale: string) => string;
}) {
  const setLabel = (locale: string, patch: Partial<{ singular: string; plural: string }>) => {
    const cur = labels[locale] ?? { singular: '', plural: '' };
    const next = { ...cur, ...patch };
    // slug chưa nhập (hoặc vẫn đang là slug tự sinh từ nhãn cũ) → tự sinh theo nhãn số nhiều mới
    const autoSlug = !slugs[locale] || slugs[locale] === slugify(cur.plural || cur.singular || '');
    onChange({ labels: { ...labels, [locale]: next }, slugs: autoSlug && patch.plural !== undefined ? { ...slugs, [locale]: slugify(next.plural || next.singular) } : slugs });
  };
  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[64px_1fr_1fr_1fr] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
        <span>Ngôn ngữ</span>
        <span>Tên số nhiều *</span>
        <span>Tên số ít</span>
        <span>Đường dẫn (slug) *</span>
      </div>
      {languages.map((l) => {
        const lb = labels[l.code] ?? { singular: '', plural: '' };
        const slug = slugs[l.code] ?? '';
        return (
          <div key={l.code} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[64px_1fr_1fr_1fr] sm:items-start sm:border-0 sm:p-0">
            <div className="flex items-center gap-1 pt-2">
              <Badge variant={l.code === defaultLocale ? 'default' : 'outline'} className="uppercase">
                {l.code}
              </Badge>
            </div>
            <Input value={lb.plural} disabled={disabled} onChange={(e) => setLabel(l.code, { plural: e.target.value })} placeholder={l.code === 'vi' ? 'VD: Dự án' : 'e.g. Projects'} aria-label={`Tên số nhiều (${l.code})`} />
            <Input value={lb.singular} disabled={disabled} onChange={(e) => setLabel(l.code, { singular: e.target.value })} placeholder={l.code === 'vi' ? 'VD: Dự án' : 'e.g. Project'} aria-label={`Tên số ít (${l.code})`} />
            <div>
              <Input value={slug} disabled={disabled} className="font-mono text-xs" onChange={(e) => onChange({ labels, slugs: { ...slugs, [l.code]: slugify(e.target.value) || e.target.value.toLowerCase() } })} placeholder={l.code === 'vi' ? 'du-an' : 'projects'} aria-label={`Slug (${l.code})`} />
              {slugHint && slug && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{slugHint(slug, l.code)}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Kiểm tra nhãn + slug: ngôn ngữ mặc định bắt buộc có tên số nhiều và slug */
export function validateLabels(labels: TypeLabels, slugs: Record<string, string>, defaultLocale: string): string | null {
  if (!labels[defaultLocale]?.plural?.trim()) return `Vui lòng nhập tên (số nhiều) cho ngôn ngữ ${defaultLocale.toUpperCase()}`;
  if (!slugs[defaultLocale]?.trim()) return `Vui lòng nhập đường dẫn (slug) cho ngôn ngữ ${defaultLocale.toUpperCase()}`;
  return null;
}

/** Bỏ ngôn ngữ trống, tự điền số ít = số nhiều khi bỏ trống */
export function cleanLabels(labels: TypeLabels, slugs: Record<string, string>) {
  const outLabels: TypeLabels = {};
  const outSlugs: Record<string, string> = {};
  for (const [code, l] of Object.entries(labels)) {
    const plural = l.plural.trim() || l.singular.trim();
    if (!plural) continue;
    outLabels[code] = { plural, singular: l.singular.trim() || plural };
  }
  for (const [code, s] of Object.entries(slugs)) if (s.trim()) outSlugs[code] = s.trim();
  return { labels: outLabels, slugs: outSlugs };
}
