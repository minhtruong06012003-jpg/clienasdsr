'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronRight, Eye, EyeOff, ExternalLink, ShieldCheck, XCircle } from 'lucide-react';
import { checkPassword, describePasswordPolicy, readPasswordPolicy } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

const PROVIDERS = [
  { value: 'none', label: 'Không dùng captcha' },
  { value: 'turnstile', label: 'Cloudflare Turnstile (miễn phí, không làm phiền người dùng)', url: 'https://dash.cloudflare.com/?to=/:account/turnstile' },
  { value: 'recaptcha-v2', label: 'Google reCAPTCHA v2 (ô "Tôi không phải robot")', url: 'https://www.google.com/recaptcha/admin' },
  { value: 'recaptcha-v3', label: 'Google reCAPTCHA v3 (vô hình, chấm điểm)', url: 'https://www.google.com/recaptcha/admin' },
  { value: 'hcaptcha', label: 'hCaptcha', url: 'https://dashboard.hcaptcha.com/' },
];

const SCOPES = [
  { key: 'forms', label: 'Form tự viết của dự án', desc: 'Form liên hệ / đăng ký nhận tin viết riêng cho từng website (dùng useCaptcha(config, "forms"))' },
  { key: 'register', label: 'Đăng ký thành viên', desc: 'Form tạo tài khoản ở trang /account' },
  { key: 'review', label: 'Đánh giá sản phẩm', desc: 'Form viết đánh giá ở trang sản phẩm' },
];

/** Các điều kiện ký tự của chính sách mật khẩu (khoá trong nhóm settings `security`) */
const PASSWORD_RULES = [
  { key: 'passwordRequireUppercase', label: 'Chữ in hoa (A–Z)' },
  { key: 'passwordRequireLowercase', label: 'Chữ thường (a–z)' },
  { key: 'passwordRequireNumber', label: 'Chữ số (0–9)' },
  { key: 'passwordRequireSymbol', label: 'Ký tự đặc biệt (!@#…)' },
] as const;

const IDLE_OPTIONS = [
  { value: 0, label: 'Không giới hạn' },
  { value: 30, label: '30 phút' },
  { value: 60, label: '1 giờ' },
  { value: 120, label: '2 giờ' },
  { value: 240, label: '4 giờ' },
  { value: 480, label: '8 giờ' },
];

const MAX_SESSION_OPTIONS = [
  { value: 0, label: 'Theo hạn đăng nhập mặc định (30 ngày)' },
  { value: 8, label: '8 giờ (một ca làm việc)' },
  { value: 12, label: '12 giờ' },
  { value: 24, label: '1 ngày' },
  { value: 72, label: '3 ngày' },
  { value: 168, label: '7 ngày' },
];

const ALERT_OPTIONS = [
  { value: 'admins', label: 'Chỉ tài khoản quản trị' },
  { value: 'all', label: 'Mọi tài khoản (cả thành viên website)' },
  { value: 'off', label: 'Tắt' },
];

/** Ô số nguyên có kẹp giới hạn (rỗng / chữ -> giá trị nhỏ nhất) */
function NumberInput({ value, onChange, min, max, suffix }: { value: unknown; onChange: (n: number) => void; min: number; max: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input type="number" min={min} max={max} value={Number(value ?? min)} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))} className="max-w-[8rem]" />
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** Select giá trị số (Radix Select chỉ nhận chuỗi) */
function NumberSelect({ value, options, onChange }: { value: unknown; options: { value: number; label: string }[]; onChange: (n: number) => void }) {
  const current = String(Number(value) || 0);
  return (
    <Select value={options.some((o) => String(o.value) === current) ? current : String(options[0].value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-full max-w-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={String(o.value)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Ô thử mật khẩu theo chính sách đang chỉnh (chưa lưu) — thấy ngay điều kiện nào chưa đạt */
function PasswordTester({ settings }: { settings: Record<string, unknown> }) {
  const [pw, setPw] = useState('');
  const policy = useMemo(() => readPasswordPolicy(settings), [settings]);
  const errors = pw ? checkPassword(pw, policy) : [];
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-xs text-muted-foreground">{describePasswordPolicy(policy)}</p>
      <Input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Gõ thử một mật khẩu để kiểm tra…" autoComplete="off" spellCheck={false} className="max-w-sm font-mono text-sm" />
      {pw && (
        <p className={cn('flex items-start gap-1.5 text-xs', errors.length ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
          {errors.length ? <XCircle className="mt-px size-3.5 shrink-0" /> : <CheckCircle2 className="mt-px size-3.5 shrink-0" />}
          {errors.length ? `Chưa đạt: ${errors.join(', ')}` : 'Mật khẩu đạt chính sách'}
        </p>
      )}
    </div>
  );
}

/**
 * Cài đặt › Bảo mật (nhóm `security`): đăng nhập & chống dò mật khẩu, chính sách mật khẩu, 2FA,
 * phiên quản trị, cảnh báo, captcha. Nhật ký đăng nhập và danh sách IP nằm ở Trung tâm bảo mật (/security).
 */
export function SecurityTab({ onDirtyChange }: TabProps) {
  const { user } = useAuth();
  const [showSecret, setShowSecret] = useState(false);
  return (
    <SettingsGroup group="security" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const provider: string = v.captchaProvider || 'none';
        const on: string[] = Array.isArray(v.captchaOn) ? v.captchaOn : [];
        const meta = PROVIDERS.find((p) => p.value === provider);
        const toggleScope = (key: string, checked: boolean) => set({ captchaOn: checked ? [...new Set([...on, key])] : on.filter((k) => k !== key) });
        return (
          <>
            {/* Lối tắt sang Trung tâm bảo mật: điểm bảo mật, nhật ký đăng nhập, chặn IP */}
            <Link href="/security" className="group flex items-center gap-3 rounded-xl border bg-gradient-to-r from-primary/5 to-transparent p-4 transition hover:border-primary/40">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldCheck className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Trung tâm bảo mật</span>
                <span className="block text-xs text-muted-foreground">Điểm bảo mật, nhật ký đăng nhập, IP bị chặn và danh sách IP được vào trang quản trị</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" />
            </Link>

            <Section title="Đăng nhập & chống dò mật khẩu" description="Hai lớp bảo vệ: khoá từng tài khoản khi bị đoán mật khẩu, và chặn cả IP khi một máy thử đăng nhập vào nhiều tài khoản.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Khoá tài khoản sau" help="Áp dụng cho cả sai mật khẩu và sai mã 2FA">
                  <NumberInput value={v.maxFailedLogins ?? 5} min={1} max={50} suffix="lần sai liên tiếp" onChange={(maxFailedLogins) => set({ maxFailedLogins })} />
                </Field>
                <Field label="Thời gian khoá" help="Quản trị viên có thể mở khoá sớm trong trang thành viên">
                  <NumberInput value={v.lockoutMinutes ?? 15} min={1} max={1440} suffix="phút" onChange={(lockoutMinutes) => set({ lockoutMinutes })} />
                </Field>
              </div>
              <SwitchRow
                label="Tự chặn IP đăng nhập sai nhiều lần"
                description="Chống tấn công dò mật khẩu hàng loạt (credential stuffing): một IP sai quá nhiều lần trên bất kỳ tài khoản nào sẽ bị chặn truy cập toàn bộ website trong một khoảng thời gian."
                checked={v.ipProtection !== false}
                onChange={(ipProtection) => set({ ipProtection })}
              />
              {v.ipProtection !== false && (
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Số lượt sai tối đa">
                    <NumberInput value={v.ipMaxFailures ?? 20} min={3} max={500} suffix="lượt" onChange={(ipMaxFailures) => set({ ipMaxFailures })} />
                  </Field>
                  <Field label="Trong khoảng">
                    <NumberInput value={v.ipWindowMinutes ?? 15} min={1} max={1440} suffix="phút" onChange={(ipWindowMinutes) => set({ ipWindowMinutes })} />
                  </Field>
                  <Field label="Chặn IP trong">
                    <NumberInput value={v.ipBlockMinutes ?? 60} min={1} max={43200} suffix="phút" onChange={(ipBlockMinutes) => set({ ipBlockMinutes })} />
                  </Field>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Câu báo lỗi đăng nhập luôn là “Email hoặc mật khẩu không đúng” cho cả email không tồn tại, để kẻ xấu không dò được email nào đã đăng ký. Địa chỉ nội bộ máy chủ (127.0.0.1) không bao giờ bị chặn.
              </p>
            </Section>

            <Section title="Chính sách mật khẩu" description="Áp dụng mỗi khi đặt mật khẩu mới: đăng ký, đổi mật khẩu, đặt lại mật khẩu, quản trị viên tạo / sửa thành viên. Mật khẩu hiện có không bị ảnh hưởng.">
              <Field label="Độ dài tối thiểu" help="Khuyến nghị từ 10 ký tự cho tài khoản quản trị">
                <NumberInput value={v.passwordMinLength ?? 8} min={6} max={64} suffix="ký tự" onChange={(passwordMinLength) => set({ passwordMinLength })} />
              </Field>
              <Field label="Bắt buộc có">
                <div className="grid gap-2 sm:grid-cols-2">
                  {PASSWORD_RULES.map((r) => (
                    <label key={r.key} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm hover:bg-muted/50">
                      <Checkbox checked={!!v[r.key]} onCheckedChange={(c) => set({ [r.key]: c === true })} />
                      {r.label}
                    </label>
                  ))}
                </div>
              </Field>
              <SwitchRow label="Chặn mật khẩu phổ biến" description="Từ chối 123456, password, matkhau, admin123… kể cả khi thêm số / ký tự đặc biệt phía sau (Password@123)." checked={v.passwordBlockCommon !== false} onChange={(passwordBlockCommon) => set({ passwordBlockCommon })} />
              <SwitchRow label="Không chứa email hoặc tên" description="Mật khẩu không được chứa phần trước @ của email hay tên người dùng (so sánh không dấu)." checked={v.passwordBlockPersonalInfo !== false} onChange={(passwordBlockPersonalInfo) => set({ passwordBlockPersonalInfo })} />
              <PasswordTester settings={v} />
            </Section>

            <Section title="Xác thực 2 bước (2FA)">
              <SwitchRow
                label="Bắt buộc 2FA với tài khoản quản trị"
                description="Tài khoản có quyền vào trang quản trị mà chưa bật 2FA sẽ bị đưa tới trang Hồ sơ > Bảo mật để thiết lập trước khi dùng các chức năng khác."
                checked={!!v.require2faForAdmins}
                onChange={(require2faForAdmins) => set({ require2faForAdmins })}
              />
              {v.require2faForAdmins && user && !user.twoFactorEnabled && (
                <p className="text-xs text-amber-600 dark:text-amber-400">Tài khoản của bạn chưa bật 2FA — sau khi lưu, bạn cũng sẽ phải thiết lập 2FA ngay.</p>
              )}
            </Section>

            <Section title="Phiên đăng nhập quản trị" description="Giới hạn thời gian của phiên đăng nhập trang quản trị, giảm rủi ro khi quên đăng xuất trên máy dùng chung. Không áp dụng cho thành viên website.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Tự đăng xuất khi không hoạt động" help="Tính từ lần thao tác cuối (sai số khoảng 15 phút)">
                  <NumberSelect value={v.adminIdleTimeoutMinutes} options={IDLE_OPTIONS} onChange={(adminIdleTimeoutMinutes) => set({ adminIdleTimeoutMinutes })} />
                </Field>
                <Field label="Thời gian tối đa của một phiên" help="Hết thời gian thì phải đăng nhập lại dù vẫn đang dùng">
                  <NumberSelect value={v.adminSessionMaxHours} options={MAX_SESSION_OPTIONS} onChange={(adminSessionMaxHours) => set({ adminSessionMaxHours })} />
                </Field>
              </div>
              {/* bật (mặc định): dùng song song nhiều máy; tắt: đăng nhập mới sẽ đăng xuất các thiết bị khác */}
              <SwitchRow
                label="Cho phép đăng nhập song song nhiều thiết bị"
                description="Bật: một tài khoản quản trị đăng nhập cùng lúc trên nhiều máy / trình duyệt mà không bị đăng xuất. Tắt: mỗi lần đăng nhập mới sẽ đăng xuất các thiết bị đang đăng nhập khác."
                checked={v.adminAllowConcurrentSessions !== false}
                onChange={(adminAllowConcurrentSessions) => set({ adminAllowConcurrentSessions })}
              />
              <p className="text-xs text-muted-foreground">Thu hồi phiên (đăng xuất thiết bị, đổi mật khẩu, khoá tài khoản) có hiệu lực ngay, không chờ token hết hạn.</p>
            </Section>

            <Section title="Cảnh báo & nhật ký">
              <Field label="Email cảnh báo đăng nhập từ thiết bị mới" help="Gửi cho chủ tài khoản khi đăng nhập bằng trình duyệt / thiết bị chưa từng dùng. Cần cấu hình email (Cài đặt › Email); sửa nội dung ở mẫu email “Cảnh báo đăng nhập từ thiết bị mới”.">
                <Select value={v.newDeviceAlert || 'admins'} onValueChange={(newDeviceAlert) => set({ newDeviceAlert })}>
                  <SelectTrigger className="w-full max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALERT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <SwitchRow label="Thông báo khi tài khoản bị khoá hoặc IP bị tự chặn" description="Hiện trong chuông thông báo của quản trị viên có quyền quản lý cài đặt." checked={v.notifyOnLockout !== false} onChange={(notifyOnLockout) => set({ notifyOnLockout })} />
              <Field label="Giữ nhật ký đăng nhập">
                <NumberInput value={v.loginLogRetentionDays ?? 90} min={7} max={3650} suffix="ngày" onChange={(loginLogRetentionDays) => set({ loginLogRetentionDays })} />
              </Field>
            </Section>

            <Section title="Captcha chống spam" description="Bảo vệ các form công khai khỏi bot. Lấy Site key / Secret key từ trang quản lý của nhà cung cấp, nhớ khai báo đúng tên miền website.">
              <Field label="Nhà cung cấp" action={meta?.url && (
                <a href={meta.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  Lấy key <ExternalLink className="size-3" />
                </a>
              )}>
                <Select value={provider} onValueChange={(captchaProvider) => set({ captchaProvider })}>
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {provider !== 'none' && (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Site key" help="Khoá công khai, được nhúng vào website">
                      <Input value={v.captchaSiteKey ?? ''} onChange={(e) => set({ captchaSiteKey: e.target.value.trim() })} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
                    </Field>
                    <Field label="Secret key" help="Khoá bí mật, chỉ máy chủ dùng để xác minh — không bao giờ gửi ra website">
                      <div className="relative">
                        <Input type={showSecret ? 'text' : 'password'} value={v.captchaSecretKey ?? ''} onChange={(e) => set({ captchaSecretKey: e.target.value.trim() })} autoComplete="new-password" className="pr-9 font-mono text-sm" spellCheck={false} />
                        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowSecret((s) => !s)} aria-label="Hiện secret key">
                          {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      </div>
                    </Field>
                  </div>
                  {provider === 'recaptcha-v3' && (
                    <Field label="Điểm tối thiểu chấp nhận (0 – 1)" help="reCAPTCHA v3 chấm điểm mỗi lượt gửi (1 = chắc chắn người thật). Thấp hơn ngưỡng này sẽ bị từ chối. Google khuyến nghị 0.5.">
                      <Input type="number" min={0} max={1} step={0.1} value={v.recaptchaMinScore ?? 0.5} onChange={(e) => set({ recaptchaMinScore: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} className="max-w-[8rem]" />
                    </Field>
                  )}
                  <Field label="Áp dụng cho">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {SCOPES.map((s) => (
                        <label key={s.key} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50">
                          <Checkbox checked={on.includes(s.key)} onCheckedChange={(c) => toggleScope(s.key, c === true)} className="mt-0.5" />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">{s.label}</span>
                            <span className="block text-xs text-muted-foreground">{s.desc}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </Field>
                  {(!v.captchaSiteKey || !v.captchaSecretKey) && <p className="text-xs text-amber-600 dark:text-amber-400">Chưa đủ Site key và Secret key — captcha sẽ không được áp dụng cho tới khi điền đủ.</p>}
                </>
              )}
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}
