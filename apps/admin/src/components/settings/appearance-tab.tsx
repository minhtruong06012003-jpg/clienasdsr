'use client';

import Link from 'next/link';
import { DEFAULT_SITE_FONT, SITE_FONTS, findSiteFont, googleFontHref } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { AsyncCombobox, COMBOBOX_LIMIT } from '@/components/common/async-combobox';
import { I18nInput } from '@/components/common/i18n-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, type Paginated } from '@/lib/api';
import { i18n } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { ColorInput, SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

const RADIUS = [
  { value: 'none', label: 'Vuông', px: 0 },
  { value: 'sm', label: 'Nhỏ', px: 4 },
  { value: 'md', label: 'Vừa', px: 8 },
  { value: 'lg', label: 'Lớn', px: 12 },
  { value: 'xl', label: 'Rất lớn', px: 18 },
  { value: 'full', label: 'Tròn', px: 999 },
];
const HEADER_STYLES = [
  { value: 'default', label: 'Mặc định (logo trái, menu phải)' },
  { value: 'centered', label: 'Logo giữa' },
  { value: 'minimal', label: 'Tối giản' },
];
const SITE_THEMES = [
  {
    value: 'default',
    label: 'AI Studio Hiện đại (Mặc định)',
    desc: 'Bố cục Studio chuyên nghiệp: trang chủ hiệu ứng hiện đại, khu thành viên có thanh menu dọc bên trái.',
  },
  {
    value: 'shopclone',
    label: 'ShopClone MMO (Danh mục & Ví cột phải)',
    desc: 'Giao diện kiểu ShopClone7: thanh tìm kiếm ngang, nút lọc chuyên mục, thẻ dịch vụ 2 cột kèm khung số dư bên phải.',
  },
];

interface BlockOption {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
}

/** Gọi danh sách block (server lọc theo tên/key) */
const fetchBlocks = (search: string) => api.get<Paginated<BlockOption>>('/admin/blocks', { search: search || undefined, limit: COMBOBOX_LIMIT }).then((r) => r.data);

/** Ô chọn block header/footer theo key — tìm phía server; key đã lưu nhưng block bị xoá sẽ hiện "(không tồn tại)" */
function BlockSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <AsyncCombobox<BlockOption>
      value={value}
      onChange={(key) => onChange(key ?? '')}
      queryKey={['blocks', 'options']}
      fetchOptions={fetchBlocks}
      // lấy nhãn của key đang chọn: tìm theo key rồi lấy đúng dòng trùng key (API admin chỉ có GET theo id)
      fetchSelected={async (key) => (await fetchBlocks(key)).find((b) => b.key === key) ?? null}
      getValue={(b) => b.key}
      getLabel={(b) => `${b.name} (${b.key})`}
      renderOption={(b) => (
        <>
          {b.name} <span className="font-mono text-xs text-muted-foreground">({b.key})</span>
        </>
      )}
      noneLabel="— Dùng giao diện mặc định của theme —"
      searchPlaceholder="Tìm block theo tên, key…"
    />
  );
}

export function AppearanceTab({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }) {
  const { defaultLocale } = useLanguages();
  const { can } = useAuth();
  const canBlocks = can('blocks.manage');

  return (
    <SettingsGroup group="appearance" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const radius = RADIUS.find((r) => r.value === v.borderRadius)?.px ?? 8;
        const activeTheme = (v.theme as string) || 'default';
        return (
          <>
            <Section title="Giao diện chủ đề (Theme)" description="Chọn bố cục hiển thị ngoài website khách. Áp dụng riêng cho từng website.">
              <div className="grid gap-3 md:grid-cols-2">
                {SITE_THEMES.map((th) => {
                  const selected = activeTheme === th.value;
                  return (
                    <button
                      key={th.value}
                      type="button"
                      onClick={() =>
                        set(
                          th.value === 'shopclone' && (!v.primaryColor || v.primaryColor === '#2563eb')
                            ? { theme: th.value, primaryColor: '#119744', secondaryColor: '#0d7a36' }
                            : { theme: th.value },
                        )
                      }
                      className={`flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition ${
                        selected ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'hover:border-foreground/30 hover:bg-muted/40'
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{th.label}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {selected ? 'Đang chọn' : 'Chọn'}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{th.desc}</p>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Màu sắc & kiểu chữ">
              <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Màu chính">
                      <ColorInput value={v.primaryColor} onChange={(primaryColor) => set({ primaryColor })} />
                    </Field>
                    <Field label="Màu phụ">
                      <ColorInput value={v.secondaryColor} onChange={(secondaryColor) => set({ secondaryColor })} />
                    </Field>
                    <Field label="Màu nhấn">
                      <ColorInput value={v.accentColor} onChange={(accentColor) => set({ accentColor })} />
                    </Field>
                  </div>
                  <Field label="Font chữ">
                    <Select value={v.fontFamily ?? DEFAULT_SITE_FONT} onValueChange={(fontFamily) => set({ fontFamily })}>
                      <SelectTrigger className="w-full max-w-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* dùng chung danh sách với website: chỉ font Google có bộ chữ tiếng Việt */}
                        {SITE_FONTS.map((f) => (
                          <SelectItem key={f.name} value={f.name}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Bo góc">
                    <ToggleGroup type="single" variant="outline" size="sm" value={v.borderRadius ?? 'md'} onValueChange={(borderRadius) => borderRadius && set({ borderRadius })} className="flex-wrap">
                      {RADIUS.map((r) => (
                        <ToggleGroupItem key={r.value} value={r.value} className="gap-1.5 px-3">
                          <span className="size-3.5 border-2 border-current" style={{ borderRadius: Math.min(r.px, 7) }} />
                          {r.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Field>
                </div>
                {/* xem trước: nạp font đang chọn từ Google Fonts để thấy đúng dáng chữ */}
                {findSiteFont(v.fontFamily) && <link rel="stylesheet" href={googleFontHref(findSiteFont(v.fontFamily)!)} />}
                <div className="rounded-xl border bg-white p-4 text-zinc-900 shadow-sm" style={{ fontFamily: `'${v.fontFamily}', system-ui, sans-serif` }}>
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Xem trước</div>
                  <div className="mt-2 text-lg font-bold" style={{ color: v.secondaryColor }}>
                    Tiêu đề sản phẩm
                  </div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Nội dung mô tả ngắn hiển thị với font {v.fontFamily}.</p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="px-4 py-2 text-sm font-medium text-white" style={{ background: v.primaryColor, borderRadius: radius }}>
                      Mua ngay
                    </span>
                    <span className="border px-4 py-2 text-sm font-medium" style={{ borderColor: v.primaryColor, color: v.primaryColor, borderRadius: radius }}>
                      Thêm vào giỏ
                    </span>
                  </div>
                  <span className="mt-3 inline-block px-2 py-0.5 text-xs font-semibold text-white" style={{ background: v.accentColor, borderRadius: Math.min(radius, 999) }}>
                    -20%
                  </span>
                </div>
              </div>
            </Section>

            <Section title="Đầu trang (header)">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Kiểu header">
                  <Select value={v.headerStyle ?? 'default'} onValueChange={(headerStyle) => set({ headerStyle })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HEADER_STYLES.map((h) => (
                        <SelectItem key={h.value} value={h.value}>
                          {h.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {canBlocks && (
                  <Field label="Block header tuỳ chỉnh" help={<>Thay header mặc định bằng block dùng chung. <Link href="/blocks" className="text-primary">Quản lý block</Link></>}>
                    <BlockSelect value={v.headerBlockKey ?? ''} onChange={(headerBlockKey) => set({ headerBlockKey })} />
                  </Field>
                )}
              </div>
              <SwitchRow label="Header dính khi cuộn" description="Header luôn hiển thị ở đầu màn hình khi cuộn trang" checked={!!v.stickyHeader} onChange={(stickyHeader) => set({ stickyHeader })} />
            </Section>

            <Section title="Thanh thông báo trên cùng (topbar)">
              <SwitchRow label="Hiển thị topbar" checked={!!v.showTopbar} onChange={(showTopbar) => set({ showTopbar })} />
              {v.showTopbar && (
                <>
                  <Field label="Nội dung topbar">
                    <I18nInput value={v.topbarText} onChange={(topbarText) => set({ topbarText })} />
                  </Field>
                  <div className="truncate rounded-md px-3 py-1.5 text-center text-xs text-white" style={{ background: v.secondaryColor }}>
                    {i18n(v.topbarText, defaultLocale) || '...'}
                  </div>
                </>
              )}
            </Section>

            {canBlocks && (
              <Section title="Chân trang (footer)">
                <Field label="Block chân trang" help="Block dùng chung hiển thị phía trên footer (vd: CTA, đăng ký nhận tin)">
                  <BlockSelect value={v.footerBlockKey ?? ''} onChange={(footerBlockKey) => set({ footerBlockKey })} />
                </Field>
              </Section>
            )}
          </>
        );
      }}
    </SettingsGroup>
  );
}
