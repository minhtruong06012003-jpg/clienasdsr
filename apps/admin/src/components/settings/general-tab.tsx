'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { AsyncCombobox, COMBOBOX_LIMIT } from '@/components/common/async-combobox';
import { I18nInput } from '@/components/common/i18n-input';
import { ImageIdField } from '@/components/media/media-picker';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { SwitchRow } from './inputs';
import { mediaId, mediaInitial, SettingsGroup } from './settings-group';

const FALLBACK_TZ = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];

const DATE_FORMATS = ['dd/MM/yyyy', 'dd-MM-yyyy', 'dd.MM.yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMMM, yyyy'];

interface PageOption {
  id: string;
  status: string;
  translations: { locale: string; title: string; slug: string }[];
}

export function GeneralTab({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }) {
  const { defaultLocale } = useLanguages();
  const { can } = useAuth();
  const canPages = can('pages.read');
  const timezones = useMemo(() => {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return fn ? fn('timeZone') : FALLBACK_TZ;
  }, []);

  return (
    <SettingsGroup group="general" mediaFields={['logo', 'logoDark', 'favicon']} onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <Section title="Thông tin website">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Tên website" required>
                <I18nInput value={v.siteName} onChange={(siteName) => set({ siteName })} />
              </Field>
              <Field label="Khẩu hiệu (tagline)">
                <I18nInput value={v.tagline} onChange={(tagline) => set({ tagline })} />
              </Field>
            </div>
            <Field label="Địa chỉ website (URL)" help="URL gốc của website/frontend, dùng cho sitemap, canonical, email, xem trước. Vd: https://example.com">
              <Input value={v.siteUrl ?? ''} onChange={(e) => set({ siteUrl: e.target.value.trim() })} placeholder="https://example.com" className="max-w-md" />
            </Field>
            {canPages && (
              <Field label="Trang chủ" help={<>Trang hiển thị ở địa chỉ gốc “/”. Quản lý tại <Link href="/pages" className="text-primary">Trang</Link>.</>}>
                {/* tìm trang phía server (không giới hạn 200 trang như ô chọn nạp sẵn) */}
                <AsyncCombobox<PageOption>
                  value={v.homepageId}
                  onChange={(homepageId) => set({ homepageId })}
                  queryKey={['pages', 'homepage-options']}
                  fetchOptions={(search) => api.get<Paginated<PageOption>>('/admin/pages', { search: search || undefined, limit: COMBOBOX_LIMIT }).then((r) => r.data)}
                  fetchSelected={(id) => api.get<PageOption>(`/admin/pages/${id}`)}
                  getValue={(p) => p.id}
                  getLabel={(p) => pickTr(p.translations, defaultLocale)?.title || '(không tiêu đề)'}
                  renderOption={(p) => (
                    <>
                      {pickTr(p.translations, defaultLocale)?.title || '(không tiêu đề)'}
                      {p.status !== 'PUBLISHED' && <span className="ml-1 text-xs text-muted-foreground">(chưa xuất bản)</span>}
                    </>
                  )}
                  noneLabel="— Chưa chọn —"
                  searchPlaceholder="Tìm trang theo tiêu đề, slug…"
                  className="max-w-md"
                />
              </Field>
            )}
          </Section>

          <Section title="Logo & biểu tượng" description="Khuyến nghị logo PNG/SVG nền trong suốt, favicon vuông 512×512">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Logo">
                <ImageIdField value={mediaId(v.logo)} initial={mediaInitial(v.logo)} onChange={(id, m) => set({ logo: m ?? id })} aspect="aspect-[3/1]" />
              </Field>
              <Field label="Logo nền tối">
                <div className="rounded-lg bg-zinc-900 p-1">
                  <ImageIdField value={mediaId(v.logoDark)} initial={mediaInitial(v.logoDark)} onChange={(id, m) => set({ logoDark: m ?? id })} aspect="aspect-[3/1]" />
                </div>
              </Field>
              <Field label="Favicon">
                <div className="w-28">
                  <ImageIdField value={mediaId(v.favicon)} initial={mediaInitial(v.favicon)} onChange={(id, m) => set({ favicon: m ?? id })} aspect="aspect-square" label="Chọn" />
                </div>
              </Field>
            </div>
          </Section>

          <Section title="Khu vực & hiển thị">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Múi giờ">
                <Input list="tz-list" value={v.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value })} placeholder="Asia/Ho_Chi_Minh" />
                <datalist id="tz-list">
                  {timezones.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </Field>
              <Field label="Định dạng ngày">
                <Select value={v.dateFormat ?? 'dd/MM/yyyy'} onValueChange={(dateFormat) => set({ dateFormat })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Số bài viết mỗi trang">
                <Input type="number" min={1} max={100} value={v.postsPerPage ?? 12} onChange={(e) => set({ postsPerPage: Number(e.target.value) || 1 })} className="w-32" />
              </Field>
              <Field label="Số sản phẩm mỗi trang">
                <Input type="number" min={1} max={100} value={v.productsPerPage ?? 12} onChange={(e) => set({ productsPerPage: Number(e.target.value) || 1 })} className="w-32" />
              </Field>
            </div>
          </Section>

          <Section title="Chế độ bảo trì">
            <SwitchRow
              label="Bật chế độ bảo trì"
              description="Khách truy cập sẽ thấy thông báo bảo trì. Quản trị viên vẫn dùng trang quản trị bình thường."
              checked={!!v.maintenanceMode}
              onChange={(maintenanceMode) => set({ maintenanceMode })}
              className={v.maintenanceMode ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20' : undefined}
            />
            {v.maintenanceMode && (
              <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-4" /> Website đang ở chế độ bảo trì sau khi lưu.
              </p>
            )}
            <Field label="Thông báo bảo trì">
              <I18nInput multiline value={v.maintenanceMessage} onChange={(maintenanceMessage) => set({ maintenanceMessage })} />
            </Field>
          </Section>
        </>
      )}
    </SettingsGroup>
  );
}
