'use client';

import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { I18nInput } from '@/components/common/i18n-input';
import { ImageIdField } from '@/components/media/media-picker';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useLanguages } from '@/hooks/use-languages';
import { i18n } from '@/lib/format';
// WEB_URL có thể rỗng (chưa cấu hình website) -> dùng tên miền minh hoạ trong bản xem trước / gợi ý
import { WEB_URL } from '@/lib/site';
import { SwitchRow } from './inputs';
import { mediaId, mediaInitial, SettingsGroup } from './settings-group';

const ORG_TYPES = [
  { value: 'Organization', label: 'Tổ chức (Organization)' },
  { value: 'Corporation', label: 'Doanh nghiệp (Corporation)' },
  { value: 'LocalBusiness', label: 'Doanh nghiệp địa phương (LocalBusiness)' },
  { value: 'Store', label: 'Cửa hàng (Store)' },
  { value: 'OnlineStore', label: 'Cửa hàng trực tuyến (OnlineStore)' },
  { value: 'Restaurant', label: 'Nhà hàng (Restaurant)' },
  { value: 'EducationalOrganization', label: 'Tổ chức giáo dục' },
  { value: 'Person', label: 'Cá nhân (Person)' },
];

const TOKENS = [
  { token: '%title%', desc: 'Tiêu đề trang' },
  { token: '%siteName%', desc: 'Tên website' },
  { token: '%tagline%', desc: 'Khẩu hiệu' },
];

export function SeoTab({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }) {
  const { defaultLocale } = useLanguages();
  const tplRef = useRef<HTMLInputElement>(null);

  return (
    <SettingsGroup group="seo" mediaFields={['defaultOgImage', 'organizationLogo']} onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const insertToken = (token: string) => {
          const el = tplRef.current;
          const cur = String(v.titleTemplate ?? '');
          const pos = el?.selectionStart ?? cur.length;
          const next = cur.slice(0, pos) + token + cur.slice(el?.selectionEnd ?? pos);
          set({ titleTemplate: next });
          requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(pos + token.length, pos + token.length);
          });
        };
        const currentHost =
          typeof window !== 'undefined' && window.location.hostname
            ? window.location.hostname.replace(/^adm-/, '').replace(/^www\./, '')
            : (WEB_URL || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const sampleSiteName =
          !currentHost || /^nov\.ai\.vn$/i.test(currentHost) || currentHost === 'localhost' ? 'NOV AI' : currentHost;
        const sampleTitle = i18n(v.defaultTitle, defaultLocale) || 'Tạo Video AI Điện Ảnh 4K';
        const preview = String(v.titleTemplate || '%title%')
          .replace(/%title%/g, sampleTitle)
          .replace(/%siteName%/g, sampleSiteName)
          .replace(/%tagline%/g, 'Nền tảng AI tạo video, ảnh, giọng nói');
        const desc = i18n(v.defaultDescription, defaultLocale);
        return (
          <>
            {v.noindexSite && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 px-3 py-2 text-sm text-red-700 dark:text-red-300 dark:bg-red-950/20">
                <AlertTriangle className="size-4" /> Website đang chặn công cụ tìm kiếm lập chỉ mục.
              </div>
            )}
            <Section title="Tiêu đề & mô tả mặc định">
              <Field label="Mẫu tiêu đề trang" help="Áp dụng cho thẻ <title> của mọi trang">
                <Input ref={tplRef} value={v.titleTemplate ?? ''} onChange={(e) => set({ titleTemplate: e.target.value })} className="font-mono text-sm" />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {TOKENS.map((t) => (
                    <button key={t.token} type="button" onClick={() => insertToken(t.token)} className="rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:border-primary hover:text-primary" title={t.desc}>
                      {t.token}
                    </button>
                  ))}
                  <span className="text-xs text-muted-foreground">← bấm để chèn</span>
                </div>
              </Field>
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Xem trước trên Google</div>
                <div className="mt-1 truncate text-xs text-emerald-700 dark:text-emerald-300">{currentHost || 'domain.vn'} › tools › cinema-video</div>
                <div className="truncate text-lg text-[#1a0dab] dark:text-sky-400">{preview}</div>
                <div className="line-clamp-2 text-sm text-muted-foreground">{desc || 'Mô tả mặc định sẽ hiển thị ở đây khi trang không có mô tả riêng.'}</div>
              </div>
              <Field label="Tiêu đề mặc định" help="Dùng cho trang chủ khi trang chưa có tiêu đề SEO">
                <I18nInput value={v.defaultTitle} onChange={(defaultTitle) => set({ defaultTitle })} />
              </Field>
              <Field label="Mô tả mặc định" help={`Khoảng 120–160 ký tự. Hiện tại: ${desc.length} ký tự`}>
                <I18nInput multiline value={v.defaultDescription} onChange={(defaultDescription) => set({ defaultDescription })} />
              </Field>
              <Field label="Từ khoá mặc định" help="Phân tách bằng dấu phẩy">
                <I18nInput value={v.defaultKeywords} onChange={(defaultKeywords) => set({ defaultKeywords })} />
              </Field>
            </Section>

            <Section title="Mạng xã hội & dữ liệu cấu trúc">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Ảnh chia sẻ mặc định (OG image)" help="1200×630px, dùng khi nội dung không có ảnh">
                  <ImageIdField value={mediaId(v.defaultOgImage)} initial={mediaInitial(v.defaultOgImage)} onChange={(id, m) => set({ defaultOgImage: m ?? id })} aspect="aspect-[1200/630]" />
                </Field>
                <Field label="Logo tổ chức" help="Hiển thị trong dữ liệu cấu trúc (schema.org) của Google">
                  <div className="w-40">
                    <ImageIdField value={mediaId(v.organizationLogo)} initial={mediaInitial(v.organizationLogo)} onChange={(id, m) => set({ organizationLogo: m ?? id })} aspect="aspect-square" label="Chọn logo" />
                  </div>
                </Field>
                <Field label="Loại tổ chức">
                  <Select value={v.organizationType ?? 'Organization'} onValueChange={(organizationType) => set({ organizationType })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORG_TYPES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Tài khoản X (Twitter)">
                  <Input value={v.twitterHandle ?? ''} onChange={(e) => set({ twitterHandle: e.target.value })} placeholder="@tenthuonghieu" />
                </Field>
              </div>
            </Section>

            <Section title="Lập chỉ mục & robots.txt">
              <SwitchRow
                label="Không cho công cụ tìm kiếm lập chỉ mục toàn site"
                description="Chỉ bật khi website đang phát triển / thử nghiệm. Thêm noindex vào mọi trang và chặn trong robots.txt."
                checked={!!v.noindexSite}
                onChange={(noindexSite) => set({ noindexSite })}
                className={v.noindexSite ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/20' : undefined}
              />
              <SwitchRow label="Thêm ảnh vào sitemap" description="Giúp ảnh sản phẩm / bài viết xuất hiện trên Google Hình ảnh" checked={v.sitemapIncludeImages !== false} onChange={(sitemapIncludeImages) => set({ sitemapIncludeImages })} />
              <Field label="Nội dung robots.txt" help={`Nên có dòng "Sitemap: ${WEB_URL || 'https://ten-mien-cua-ban'}/sitemap.xml" để bot tìm thấy sitemap.`}>
                <Textarea value={v.robotsTxt ?? ''} onChange={(e) => set({ robotsTxt: e.target.value })} rows={8} className="font-mono text-xs" spellCheck={false} />
              </Field>
            </Section>

            <Section title="Xác minh quyền sở hữu" description="Chỉ dán giá trị content của thẻ meta (không dán cả thẻ)">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Google Search Console">
                  <Input value={v.googleVerification ?? ''} onChange={(e) => set({ googleVerification: e.target.value.trim() })} placeholder="abc123..." className="font-mono text-sm" />
                </Field>
                <Field label="Bing Webmaster Tools">
                  <Input value={v.bingVerification ?? ''} onChange={(e) => set({ bingVerification: e.target.value.trim() })} placeholder="ABC123..." className="font-mono text-sm" />
                </Field>
              </div>
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}
