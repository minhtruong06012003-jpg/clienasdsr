'use client';

/**
 * Hai tab Cài đặt gắn thêm thành phần vào website (nhóm cài đặt public, storefront tự render, tôn trọng `enabled`):
 * - Mã theo dõi (`tracking`): GA4, Google Tag Manager, Facebook Pixel, TikTok Pixel — chỉ cần nhập ID.
 * - Nút liên hệ nổi (`contactButtons`): danh sách kênh liên hệ (Telegram, Zalo, Messenger...) ở góc màn hình, bật/tắt + icon riêng từng kênh.
 * - Thông báo nổi (`popup`): hộp thông báo hiện khi khách vào website (tiêu đề, nội dung, ảnh, nút bấm, đối tượng, tần suất).
 */
import Link from 'next/link';
import { useState } from 'react';
import { ChevronDown, ChevronUp, ImagePlus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { contactChannelIcon, findContactChannel, normalizeContactButtons, type ContactButtonItem } from '@cmsnt/shared';
import { MediaPickerDialog } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Field, Section } from '@/components/common/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/** ID theo dõi chỉ gồm chữ, số, gạch ngang/dưới (API cũng lọc lại) — bỏ khoảng trắng khi dán */
const cleanId = (v: string) => v.trim().replace(/\s+/g, '');

const TRACKING_FIELDS = [
  { key: 'ga4Id', label: 'Google Analytics 4 ID', help: 'Ví dụ: G-XXXXXXXXXX', placeholder: 'G-XXXXXXXXXX' },
  { key: 'gtmId', label: 'Google Tag Manager ID', help: 'Ví dụ: GTM-XXXXXXX', placeholder: 'GTM-XXXXXXX' },
  { key: 'fbPixelId', label: 'Facebook Pixel ID', help: 'Dãy số trong Meta Events Manager → Nguồn dữ liệu', placeholder: '1234567890123456' },
  { key: 'tiktokPixelId', label: 'TikTok Pixel ID', help: 'Lấy trong TikTok Ads Manager → Assets → Events', placeholder: 'CXXXXXXXXXXXXXXXXXXX' },
] as const;

/** Cài đặt › Mã theo dõi (nhóm `tracking`) */
export function TrackingTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="tracking" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const enabled = v.enabled !== false;
        return (
          <>
            <Section title="Analytics & Pixel" description="Chèn Google Analytics 4, Google Tag Manager, Facebook Pixel, TikTok Pixel vào mọi trang của website mà không cần sửa code. Để trống ô nào thì bỏ qua dịch vụ đó.">
              <SwitchRow label="Bật mã theo dõi" description="Tắt sẽ gỡ toàn bộ mã theo dõi khỏi website (các ID vẫn được giữ)" checked={enabled} onChange={(enabled) => set({ enabled })} />
              <div className="grid gap-4 md:grid-cols-2">
                {TRACKING_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} help={f.help}>
                    <Input value={v[f.key] ?? ''} onChange={(e) => set({ [f.key]: cleanId(e.target.value) })} placeholder={f.placeholder} className="font-mono text-sm" disabled={!enabled} />
                  </Field>
                ))}
              </div>
            </Section>
            <p className="text-xs text-muted-foreground">
              Cần chèn mã khác (xác minh tên miền, chat, chuyển đổi quảng cáo...)? Dùng{' '}
              <Link href="/settings?tab=scripts" className="font-medium text-primary hover:underline">
                Cài đặt › Mã nhúng
              </Link>
              . Tránh nhập cùng một ID ở cả hai nơi để không bị đếm trùng.
            </p>
          </>
        );
      }}
    </SettingsGroup>
  );
}

/**
 * Ô icon của một kênh: ảnh admin tải lên > icon thư viện của kênh > chữ cái đầu trên nền màu kênh.
 * Bấm để chọn / tải ảnh từ thư viện Media.
 */
function ContactIconPicker({ item, onChange }: { item: ContactButtonItem; onChange: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const src = item.icon || contactChannelIcon(item.key);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Bấm để tải icon riêng" className="group relative size-11 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- ảnh Media / icon SVG thư viện của API
          <img src={src} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-base font-semibold text-white" style={{ background: findContactChannel(item.key)?.color ?? '#7c3aed' }}>
            {item.label.charAt(0).toUpperCase() || '?'}
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition group-hover:opacity-100">
          <ImagePlus className="size-4" />
        </span>
      </button>
      <MediaPickerDialog open={open} onOpenChange={setOpen} title="Chọn icon" onSelect={(items) => items[0] && onChange(items[0].url)} />
    </>
  );
}

/** Cài đặt › Nút liên hệ nổi (nhóm `contactButtons`): bật/tắt, sắp xếp, đổi tên + icon từng kênh, thêm kênh tự do */
export function ContactButtonsTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="contactButtons" onDirtyChange={onDirtyChange}>
      {(raw, set) => {
        const v = normalizeContactButtons(raw);
        const setItems = (items: ContactButtonItem[]) => set({ ...v, items });
        const patch = (i: number, p: Partial<ContactButtonItem>) => setItems(v.items.map((it, j) => (j === i ? { ...it, ...p } : it)));
        // đổi chỗ kênh i với kênh bên cạnh (dir = -1 lên, 1 xuống)
        const move = (i: number, dir: -1 | 1) => {
          const items = [...v.items];
          [items[i], items[i + dir]] = [items[i + dir], items[i]];
          setItems(items);
        };
        const addCustom = () => setItems([...v.items, { key: `custom-${Date.now().toString(36)}`, label: 'Liên hệ', url: '', icon: '', enabled: true }]);
        const active = v.items.filter((it) => it.enabled && it.url).length;
        return (
          <>
            <Section title="Hiển thị" description="Nút tròn nổi ở góc màn hình website, bấm vào xổ ra danh sách kênh liên hệ.">
              <SwitchRow label="Bật nút liên hệ nổi" description="Tắt sẽ ẩn toàn bộ nút trên website (thông tin các kênh vẫn được giữ)" checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} />
              <SwitchRow label="Mở sẵn danh sách kênh" description="Bật: khách vào trang thấy ngay các kênh. Tắt: chỉ hiện nút tròn, bấm mới xổ ra" checked={v.defaultOpen} onChange={(defaultOpen) => set({ ...v, defaultOpen })} disabled={!v.enabled} />
              <Field label="Vị trí" className="max-w-xs">
                <Select value={v.position} onValueChange={(position) => set({ ...v, position })} disabled={!v.enabled}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="right">Góc phải dưới</SelectItem>
                    <SelectItem value="left">Góc trái dưới</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </Section>
            <Section
              title="Kênh liên hệ"
              description={`Bật kênh và nhập link / số / username, kênh nào tắt hoặc để trống thì ẩn. Icon trống = icon mặc định; bấm ô icon để tải ảnh riêng. Đang hiện ${active} kênh.`}
              actions={
                <Button type="button" variant="outline" size="sm" onClick={addCustom} disabled={v.items.length >= 30}>
                  <Plus /> Thêm kênh khác
                </Button>
              }
            >
              <div className={cn('divide-y rounded-lg border', !v.enabled && 'opacity-60')}>
                {v.items.map((it, i) => {
                  const ch = findContactChannel(it.key);
                  return (
                    <div key={it.key} className="flex flex-wrap items-center gap-3 p-3">
                      <div className="flex flex-col">
                        <Button type="button" variant="ghost" size="icon" className="size-6" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Đưa lên">
                          <ChevronUp />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="size-6" onClick={() => move(i, 1)} disabled={i === v.items.length - 1} aria-label="Đưa xuống">
                          <ChevronDown />
                        </Button>
                      </div>
                      <ContactIconPicker item={it} onChange={(icon) => patch(i, { icon })} />
                      <Switch checked={it.enabled} onCheckedChange={(enabled) => patch(i, { enabled })} aria-label={`Bật ${it.label}`} />
                      <Input value={it.label} onChange={(e) => patch(i, { label: e.target.value })} placeholder={ch?.label ?? 'Tên kênh'} className="w-36" aria-label="Tên hiển thị" />
                      <Input value={it.url} onChange={(e) => patch(i, { url: e.target.value })} placeholder={ch?.placeholder ?? 'https://...'} className="min-w-52 flex-1" aria-label="Link / số / username" />
                      {it.icon && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => patch(i, { icon: '' })}>
                          <RotateCcw /> Icon mặc định
                        </Button>
                      )}
                      {!ch && (
                        <Button type="button" variant="ghost" size="icon" onClick={() => setItems(v.items.filter((_, j) => j !== i))} aria-label="Xoá kênh" className="text-destructive">
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Gọi điện nhập số điện thoại, Email nhập địa chỉ email, Zalo / WhatsApp nhập số hoặc link, Telegram nhập username hoặc link. Kênh khác nhập link đầy đủ.</p>
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}

/** Lựa chọn đối tượng + tần suất của thông báo nổi (khớp normalizePopup ở API) */
const POPUP_AUDIENCES = [
  { value: 'all', label: 'Mọi khách truy cập' },
  { value: 'member', label: 'Chỉ thành viên đã đăng nhập' },
  { value: 'guest', label: 'Chỉ khách chưa đăng nhập' },
];
const POPUP_FREQUENCIES = [
  { value: 'once', label: 'Một lần (hiện lại khi đổi nội dung)' },
  { value: 'daily', label: 'Mỗi ngày một lần' },
  { value: 'session', label: 'Mỗi lần mở website' },
  { value: 'always', label: 'Mọi lần tải trang' },
];

/** Cài đặt › Thông báo nổi (nhóm `popup`): hộp thông báo hiện khi khách vào website */
export function PopupTab({ onDirtyChange }: TabProps) {
  const [picker, setPicker] = useState(false);
  return (
    <SettingsGroup group="popup" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const enabled = v.enabled === true;
        return (
          <>
            <Section title="Hiển thị" description="Hộp thông báo hiện giữa màn hình khi khách vào website, khách bấm Đóng để tắt.">
              <SwitchRow label="Bật thông báo nổi" description="Tắt sẽ ẩn thông báo trên website (nội dung vẫn được giữ)" checked={enabled} onChange={(enabled) => set({ enabled })} />
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Hiện cho">
                  <Select value={v.audience ?? 'all'} onValueChange={(audience) => set({ audience })} disabled={!enabled}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POPUP_AUDIENCES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Tần suất">
                  <Select value={v.frequency ?? 'once'} onValueChange={(frequency) => set({ frequency })} disabled={!enabled}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POPUP_FREQUENCIES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Hiện sau (giây)" help="0 = hiện ngay khi vào trang">
                  <Input type="number" min={0} max={60} value={v.delay ?? 1} onChange={(e) => set({ delay: e.target.value === '' ? '' : Number(e.target.value) })} disabled={!enabled} />
                </Field>
              </div>
            </Section>
            <Section title="Nội dung" description="Mỗi dòng là một đoạn, bọc chữ trong **hai dấu sao** để in đậm. Đường link trong nội dung tự bấm được.">
              <Field label="Tiêu đề">
                <Input value={v.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="Thông báo" maxLength={150} />
              </Field>
              <Field label="Nội dung">
                <Textarea value={v.content ?? ''} onChange={(e) => set({ content: e.target.value })} rows={6} maxLength={5000} placeholder={'Ví dụ:\n**Khuyến mãi tháng 11:** tặng thêm 20% tiền vào ví khi mua gói.\nÁp dụng tới hết 30/11.'} />
              </Field>
              <Field label="Ảnh (không bắt buộc)" help="Hiện phía trên nội dung, nên dùng ảnh ngang">
                <div className="flex flex-wrap items-center gap-3">
                  {v.image && (
                    // eslint-disable-next-line @next/next/no-img-element -- ảnh từ thư viện Media
                    <img src={v.image} alt="" className="h-20 rounded-lg border object-cover" />
                  )}
                  <Button type="button" variant="outline" size="sm" onClick={() => setPicker(true)}>
                    <ImagePlus /> {v.image ? 'Đổi ảnh' : 'Chọn ảnh'}
                  </Button>
                  {v.image && (
                    <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => set({ image: '' })}>
                      <Trash2 /> Bỏ ảnh
                    </Button>
                  )}
                </div>
                <MediaPickerDialog open={picker} onOpenChange={setPicker} title="Chọn ảnh thông báo" onSelect={(items) => items[0] && set({ image: items[0].url })} />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Chữ trên nút" help="Để trống = không có nút (chỉ có nút Đóng)">
                  <Input value={v.buttonLabel ?? ''} onChange={(e) => set({ buttonLabel: e.target.value })} placeholder="Xem ngay" maxLength={60} />
                </Field>
                <Field label="Link của nút" help="Link trong website (vd /pricing) hoặc link đầy đủ https://...">
                  <Input value={v.buttonUrl ?? ''} onChange={(e) => set({ buttonUrl: e.target.value })} placeholder="/pricing" />
                </Field>
              </div>
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}
