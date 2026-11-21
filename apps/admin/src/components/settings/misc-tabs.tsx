'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AtSign, Eye, EyeOff, Globe, Info, Loader2, MessageCircle, Send, Server, Video } from 'lucide-react';
import { toast } from 'sonner';
import { Field, Section } from '@/components/common/field';
import { I18nInput } from '@/components/common/i18n-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SwitchRow } from './inputs';
import { MailQueuePanel } from './mail-queue-panel';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/** Lấy src của iframe Google Maps để xem trước (không render HTML tuỳ ý) */
function mapSrc(code: unknown): string | null {
  const m = /src="(https:\/\/(?:www\.)?google\.com\/maps\/embed[^"]*)"/i.exec(String(code ?? ''));
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

export function ContactTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="contact" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <Section title="Thông tin doanh nghiệp" description="Hiển thị ở chân trang, trang liên hệ và dữ liệu cấu trúc SEO">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Tên công ty / cửa hàng">
                <Input value={v.companyName ?? ''} onChange={(e) => set({ companyName: e.target.value })} />
              </Field>
              <Field label="Mã số thuế">
                <Input value={v.taxCode ?? ''} onChange={(e) => set({ taxCode: e.target.value })} />
              </Field>
              <Field label="Email liên hệ">
                <Input type="email" value={v.email ?? ''} onChange={(e) => set({ email: e.target.value.trim() })} placeholder="lienhe@example.com" />
              </Field>
              <Field label="Số điện thoại">
                <Input value={v.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} placeholder="028 xxxx xxxx" />
              </Field>
              <Field label="Hotline">
                <Input value={v.hotline ?? ''} onChange={(e) => set({ hotline: e.target.value })} placeholder="1900 xxxx" />
              </Field>
              <Field label="Giờ làm việc">
                <I18nInput value={v.workingHours} onChange={(workingHours) => set({ workingHours })} placeholder="8:00 - 21:00, Thứ 2 - Chủ nhật" />
              </Field>
            </div>
            <Field label="Địa chỉ">
              <I18nInput multiline rows={2} value={v.address} onChange={(address) => set({ address })} />
            </Field>
          </Section>
          <Section title="Bản đồ" description="Dán mã nhúng iframe từ Google Maps (Chia sẻ → Nhúng bản đồ)">
            <Textarea value={v.mapEmbed ?? ''} onChange={(e) => set({ mapEmbed: e.target.value })} rows={4} className="font-mono text-xs" placeholder='<iframe src="https://www.google.com/maps/embed?..." ...></iframe>' spellCheck={false} />
            {mapSrc(v.mapEmbed) && <iframe src={mapSrc(v.mapEmbed)!} title="Xem trước bản đồ" className="h-56 w-full rounded-lg border" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />}
          </Section>
        </>
      )}
    </SettingsGroup>
  );
}

const SOCIALS = [
  { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/tentrang', icon: Globe },
  { key: 'messenger', label: 'Messenger', placeholder: 'https://m.me/tentrang', icon: MessageCircle },
  { key: 'zalo', label: 'Zalo', placeholder: 'https://zalo.me/0900000000', icon: MessageCircle },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@kenh', icon: Video },
  { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@taikhoan', icon: Video },
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/taikhoan', icon: AtSign },
  { key: 'x', label: 'X (Twitter)', placeholder: 'https://x.com/taikhoan', icon: AtSign },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/company/congty', icon: Globe },
];

export function SocialTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="social" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <Section title="Liên kết mạng xã hội" description="Để trống để ẩn biểu tượng tương ứng trên website">
          <div className="grid gap-4 md:grid-cols-2">
            {SOCIALS.map((s) => (
              <Field key={s.key} label={s.label}>
                <div className="relative">
                  <s.icon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={v[s.key] ?? ''} onChange={(e) => set({ [s.key]: e.target.value.trim() })} placeholder={s.placeholder} className="pl-8" />
                </div>
              </Field>
            ))}
          </div>
        </Section>
      )}
    </SettingsGroup>
  );
}

const CODE_FIELDS = [
  { key: 'headCode', label: 'Chèn vào <head>', help: 'Mã xác minh, Google Analytics, Facebook Pixel, CSS tuỳ chỉnh...' },
  { key: 'bodyStartCode', label: 'Ngay sau thẻ mở <body>', help: 'Vd: phần noscript của Google Tag Manager' },
  { key: 'bodyEndCode', label: 'Trước thẻ đóng </body>', help: 'Script chat (Tawk, Zalo widget...), mã theo dõi chuyển đổi' },
];

export function ScriptsTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="scripts" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            Mã nhúng được chèn nguyên văn vào mọi trang của website. Chỉ dán mã từ nguồn tin cậy — mã sai có thể làm hỏng giao diện. Với GA4 / GTM / Facebook Pixel / TikTok Pixel, nên dùng mục Cài đặt › Mã theo dõi (chỉ cần nhập ID).
          </div>
          {CODE_FIELDS.map((f) => (
            <Section key={f.key} title={f.label} description={f.help}>
              <Textarea value={v[f.key] ?? ''} onChange={(e) => set({ [f.key]: e.target.value })} rows={8} spellCheck={false} className="bg-zinc-950 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 dark:bg-zinc-950" placeholder="<!-- dán mã tại đây -->" />
            </Section>
          ))}
        </>
      )}
    </SettingsGroup>
  );
}

/**
 * Cấu hình nhanh nhà cung cấp gửi mail. Chọn một mục sẽ điền sẵn host/cổng/SSL (và tên đăng nhập nếu cố định).
 * `passLabel` / `hint`: đổi nhãn ô mật khẩu và hướng dẫn riêng cho từng nhà cung cấp.
 */
const SMTP_PRESETS: { key: string; label: string; host: string; port: number; secure: boolean; user?: string; userLabel?: string; passLabel?: string; hint: ReactNode }[] = [
  { key: 'gmail', label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465, secure: true, passLabel: 'App Password', hint: <>Tên đăng nhập là địa chỉ Gmail. Mật khẩu là <b>App Password</b> 16 ký tự (Tài khoản Google → Bảo mật → Mật khẩu ứng dụng, cần bật xác minh 2 bước).</> },
  { key: 'outlook', label: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, secure: false, hint: <>Tên đăng nhập là email Microsoft 365. Quản trị viên cần bật <b>SMTP AUTH</b> cho hộp thư này.</> },
  { key: 'resend', label: 'Resend (resend.com)', host: 'smtp.resend.com', port: 465, secure: true, user: 'resend', passLabel: 'API key', hint: <>Tạo API key (dạng <code className="font-mono">re_...</code>) tại resend.com → API Keys, quyền <b>Sending access</b>. Email người gửi phải thuộc tên miền đã xác minh trong Resend → Domains.</> },
  { key: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true, hint: <>Tên đăng nhập là email Zoho. Nếu bật xác minh 2 bước, dùng mật khẩu riêng cho ứng dụng.</> },
  { key: 'ses', label: 'Amazon SES (ap-southeast-1)', host: 'email-smtp.ap-southeast-1.amazonaws.com', port: 587, secure: false, userLabel: 'SMTP username', passLabel: 'SMTP password', hint: <>Dùng SMTP credentials tạo trong SES → SMTP settings (khác với Access key IAM). Đổi vùng trong host nếu tài khoản ở vùng khác.</> },
  { key: 'mailgun', label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false, hint: <>Dùng SMTP credentials của tên miền trong Mailgun → Sending → Domain settings. Tài khoản vùng EU dùng host smtp.eu.mailgun.org.</> },
];
/** Giá trị đặc biệt của ô chọn: tự nhập máy chủ SMTP riêng */
const CUSTOM_SMTP = 'custom';

export function MailTab({ onDirtyChange }: TabProps) {
  const { user } = useAuth();
  const [showPass, setShowPass] = useState(false);
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const test = useMutation({
    mutationFn: () => api.post('/admin/settings/mail/test', { to: testTo }),
    onSuccess: () => toast.success(`Đã gửi email thử tới ${testTo}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  // người dùng chủ động chọn "Server SMTP riêng" (khi host còn trống vẫn giữ lựa chọn)
  const [custom, setCustom] = useState(false);
  return (
    <SettingsGroup group="mail" onDirtyChange={onDirtyChange}>
      {(v, set, original) => {
        const preset = SMTP_PRESETS.find((p) => p.host === v.host);
        const isCustom = !preset && (custom || !!v.host);
        return (
          <>
            <Section title="Máy chủ SMTP" description="Dùng để gửi email thông báo đơn hàng, form liên hệ, đặt lại mật khẩu">
              {/* Nhà cung cấp: nhận diện theo host đang nhập; chọn mục khác sẽ điền sẵn thông số */}
              <Field label="Nhà cung cấp">
                <Select
                  value={preset?.key ?? (v.host || custom ? CUSTOM_SMTP : '')}
                  onValueChange={(key) => {
                    if (key === CUSTOM_SMTP) {
                      setCustom(true);
                      // đang dùng thông số của nhà cung cấp có sẵn → xoá để nhập máy chủ riêng
                      if (preset) set({ host: '', port: 587, secure: false, ...(preset.user ? { user: '' } : {}) });
                      return;
                    }
                    const p = SMTP_PRESETS.find((x) => x.key === key);
                    if (!p) return;
                    setCustom(false);
                    // tên đăng nhập cố định (vd Resend = "resend"); rời nhà cung cấp đó thì xoá tên cố định cũ
                    set({ host: p.host, port: p.port, secure: p.secure, ...(p.user ? { user: p.user } : preset?.user && v.user === preset.user ? { user: '' } : {}) });
                  }}
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue placeholder="Chọn nhà cung cấp..." />
                  </SelectTrigger>
                  <SelectContent>
                    {SMTP_PRESETS.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={CUSTOM_SMTP}>
                      <Server className="size-4 text-muted-foreground" /> Server SMTP riêng
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {(preset || isCustom) && (
                <div className="flex gap-2.5 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <p>
                    {preset
                      ? preset.hint
                      : <>Nhập thông số máy chủ của bạn (cPanel, DirectAdmin, Postfix, mail hosting...). Thường dùng cổng <b>465</b> kèm SSL/TLS, hoặc <b>587</b> với STARTTLS (tắt SSL/TLS). Cổng 25 hay bị nhà cung cấp hosting chặn.</>}
                  </p>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-[1fr_120px]">
                <Field label="Máy chủ (host)">
                  <Input value={v.host ?? ''} onChange={(e) => set({ host: e.target.value.trim() })} placeholder="mail.tenmien.com" className="font-mono text-sm" />
                </Field>
                <Field label="Cổng">
                  <Input type="number" value={v.port ?? 587} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
                </Field>
              </div>
              <SwitchRow label="Kết nối bảo mật SSL/TLS" description="Bật cho cổng 465. Cổng 587 dùng STARTTLS — để tắt." checked={!!v.secure} onChange={(secure) => set({ secure })} />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={preset?.userLabel ?? 'Tên đăng nhập'} help={preset?.user ? `Cố định là “${preset.user}” với ${preset.label}` : undefined}>
                  <Input value={v.user ?? ''} onChange={(e) => set({ user: e.target.value.trim() })} autoComplete="off" readOnly={!!preset?.user} className={cn(preset?.user && 'bg-muted font-mono')} />
                </Field>
                <Field label={preset?.passLabel ?? 'Mật khẩu'}>
                  <div className="relative">
                    <Input type={showPass ? 'text' : 'password'} value={v.pass ?? ''} onChange={(e) => set({ pass: e.target.value })} autoComplete="new-password" placeholder={preset?.key === 'resend' ? 're_xxxxxxxxx' : undefined} className="pr-9" />
                    <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPass((s) => !s)} aria-label="Hiện mật khẩu">
                      {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </Field>
              </div>
            </Section>
            <Section title="Người gửi">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Tên người gửi">
                  <Input value={v.fromName ?? ''} onChange={(e) => set({ fromName: e.target.value })} placeholder="CMSNT Shop" />
                </Field>
                <Field label="Email người gửi" help="Để trống sẽ dùng tên đăng nhập SMTP">
                  <Input type="email" value={v.fromEmail ?? ''} onChange={(e) => set({ fromEmail: e.target.value.trim() })} placeholder="no-reply@example.com" />
                </Field>
              </div>
            </Section>
            <Section title="Gửi thử" description="Gửi ngay (không qua hàng chờ) bằng cấu hình đã lưu — hãy lưu thay đổi trước khi thử">
              <div className="flex flex-wrap gap-2">
                <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="email nhận thử" className="max-w-xs" />
                <Button type="button" variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !testTo || !original.host}>
                  {test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Gửi email thử
                </Button>
              </div>
              {!original.host && <p className="text-xs text-muted-foreground">Chưa có máy chủ SMTP nào được lưu.</p>}
            </Section>
            <Section title="Hàng chờ gửi" description="Email được xếp hàng và gửi nền: không làm chậm website, tự thử lại khi máy chủ mail lỗi tạm thời">
              <MailQueuePanel compact />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Tối đa email mỗi phút" help="0 = không giới hạn. Gmail khoảng 20/phút; Resend gói miễn phí khoảng 120/phút. Vượt mức thì email chờ sang phút sau.">
                  <Input type="number" min={0} max={10000} value={v.rateLimitPerMinute ?? 60} onChange={(e) => set({ rateLimitPerMinute: Math.max(0, Number(e.target.value) || 0) })} className="w-32" />
                </Field>
                <Field label="Số lần thử mỗi email" help="Thử lại sau 1 phút, 5 phút, 15 phút, 1 giờ... Địa chỉ nhận không tồn tại thì không thử lại.">
                  <Input type="number" min={1} max={10} value={v.maxAttempts ?? 5} onChange={(e) => set({ maxAttempts: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} className="w-32" />
                </Field>
              </div>
              <SwitchRow
                label="Tạm dừng gửi email"
                description="Email mới vẫn được xếp hàng nhưng chưa gửi đi — dùng khi đổi nhà cung cấp SMTP hoặc kiểm tra lỗi. Tắt để gửi tiếp."
                checked={!!v.queuePaused}
                onChange={(queuePaused) => set({ queuePaused })}
                className={v.queuePaused ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20' : undefined}
              />
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}

export function AccountTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="account" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <div className="space-y-6">
          <Section title="Tài khoản khách hàng">
            <SwitchRow label="Cho phép đăng ký tài khoản" description="Khách có thể tự tạo tài khoản trên website để theo dõi đơn hàng, lưu địa chỉ" checked={v.allowRegistration !== false} onChange={(allowRegistration) => set({ allowRegistration })} />
            <SwitchRow label="Yêu cầu xác minh email" description="Khách phải xác nhận email trước khi đăng nhập (cần cấu hình SMTP)" checked={!!v.requireEmailVerification} onChange={(requireEmailVerification) => set({ requireEmailVerification })} />
          </Section>
          {/* Đăng nhập Google cho khách: API chỉ xác minh ID token theo Client ID, không cần client secret */}
          <Section title="Đăng nhập bằng Google" description="Khách đăng nhập / đăng ký nhanh bằng tài khoản Google">
            <SwitchRow label="Bật đăng nhập Google" description="Cần nhập Client ID bên dưới; tắt thì API từ chối mọi yêu cầu đăng nhập Google" checked={!!v.googleLoginEnabled} onChange={(googleLoginEnabled) => set({ googleLoginEnabled })} />
            <Field
              label="Google OAuth Client ID"
              help={
                <>
                  Google Cloud Console › APIs &amp; Services › Credentials › Create credentials › OAuth client ID, loại <b>Web application</b>; thêm domain website vào “Authorized JavaScript origins”. Frontend dùng Google Identity Services lấy <code className="font-mono">idToken</code> rồi gửi tới{' '}
                  <code className="font-mono">POST /api/auth/google</code>. Client ID công khai được (không phải bí mật).
                </>
              }
            >
              <Input value={v.googleClientId ?? ''} onChange={(e) => set({ googleClientId: e.target.value.trim() })} placeholder="1234567890-abc.apps.googleusercontent.com" className="font-mono text-sm" autoComplete="off" />
            </Field>
          </Section>
        </div>
      )}
    </SettingsGroup>
  );
}
