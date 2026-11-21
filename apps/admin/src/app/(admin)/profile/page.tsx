'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Eye, EyeOff, KeyRound, Loader2, MonitorSmartphone, RefreshCw, Save, ShieldAlert, ShieldCheck, ShieldOff, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Confirm2faDialog, Enable2faDialog, RecoveryCodes } from '@/components/auth/two-factor';
import { SessionsList } from '@/components/auth/sessions-list';
import { ApiKeysPanel } from '@/components/api-keys/api-keys-panel';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { ImageIdField } from '@/components/media/media-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { passwordStrength } from '@/components/users/password-strength';
import { PasswordPolicyHint } from '@/components/users/password-policy-hint';

interface Me {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  bio: string | null;
  avatarId: string | null;
  locale: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  role: { id: string; name: string; slug: string; permissions: string[] };
  twoFactorEnabled: boolean;
  recoveryCodesLeft: number;
  setup2faRequired: boolean;
}

interface ProfileForm {
  name: string;
  phone: string;
  bio: string;
  avatarId: string | null;
  locale: string;
}

/** Tab Bảo mật: xác thực 2 bước, mã dự phòng, phiên đăng nhập */
function SecurityTab({ me, required }: { me: Me; required: boolean }) {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    await refreshUser().catch(() => undefined);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        {required && !me.twoFactorEnabled && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" />
            <div>
              <p className="font-medium">Website yêu cầu quản trị viên bật xác thực 2 bước</p>
              <p className="mt-0.5 text-xs">Bạn cần bật xác thực 2 bước bên dưới trước khi dùng các chức năng khác của trang quản trị.</p>
            </div>
          </div>
        )}

        <Section
          title="Xác thực 2 bước (2FA)"
          description="Lớp bảo vệ thứ hai: ngoài mật khẩu, mỗi lần đăng nhập cần thêm mã 6 số từ ứng dụng xác thực trên điện thoại."
          actions={
            me.twoFactorEnabled ? (
              <Badge className="gap-1 border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                <ShieldCheck className="size-3" /> Đang bật
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <ShieldOff className="size-3" /> Chưa bật
              </Badge>
            )
          }
        >
          {me.twoFactorEnabled ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Mã dự phòng còn lại: <span className="font-medium text-foreground">{me.recoveryCodesLeft}/10</span>
                {me.recoveryCodesLeft <= 2 && <span className="ml-2 text-amber-600 dark:text-amber-400">— sắp hết, hãy tạo bộ mã mới.</span>}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setRegenOpen(true)}>
                  <RefreshCw /> Tạo lại mã dự phòng
                </Button>
                <Button variant="outline" className="text-destructive" onClick={() => setDisableOpen(true)}>
                  <ShieldOff /> Tắt xác thực 2 bước
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>Cài ứng dụng xác thực: Google Authenticator, Microsoft Authenticator, Authy, 1Password…</li>
                <li>Quét mã QR, nhập mã 6 số để xác nhận.</li>
                <li>Lưu 10 mã dự phòng để đăng nhập khi mất điện thoại.</li>
              </ul>
              <Button onClick={() => setEnableOpen(true)}>
                <ShieldCheck /> Bật xác thực 2 bước
              </Button>
            </div>
          )}
        </Section>

        <Section title="Thiết bị đã đăng nhập" description="Các phiên đang hoạt động của tài khoản bạn. Thu hồi phiên lạ nếu nghi ngờ bị lộ mật khẩu.">
          <SessionsList listPath="/auth/sessions" revokePath={(id) => `/auth/sessions/${id}`} revokeOthersPath="/auth/sessions" queryKey={['my-sessions']} />
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="Mẹo bảo mật">
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> Bật 2FA cho mọi tài khoản có quyền quản trị.
            </li>
            <li className="flex gap-2">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Dùng mật khẩu dài, không dùng lại ở website khác.
            </li>
            <li className="flex gap-2">
              <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Đăng xuất thiết bị bạn không còn dùng.
            </li>
          </ul>
        </Section>
      </div>

      <Enable2faDialog open={enableOpen} onOpenChange={setEnableOpen} email={me.email} onEnabled={() => void reload()} />
      <Confirm2faDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Tắt xác thực 2 bước?"
        description="Tài khoản sẽ chỉ còn được bảo vệ bằng mật khẩu. Mã dự phòng hiện tại và các thiết bị tin cậy sẽ bị huỷ."
        allowPassword
        destructive
        confirmText="Tắt 2FA"
        onConfirm={async (input) => {
          await api.post('/auth/2fa/disable', input);
          toast.success('Đã tắt xác thực 2 bước');
          await reload();
        }}
      />
      <Confirm2faDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title="Tạo lại mã dự phòng"
        description="Bộ mã cũ sẽ hết hiệu lực ngay. Nhập mã từ ứng dụng xác thực để xác nhận."
        confirmText="Tạo mã mới"
        onConfirm={async (input) => {
          const r = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes/regenerate', input);
          setNewCodes(r.recoveryCodes);
          await reload();
        }}
      />
      <Dialog open={!!newCodes} onOpenChange={(o) => !o && setNewCodes(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Bộ mã dự phòng mới</DialogTitle>
            <DialogDescription>Các mã cũ không còn dùng được nữa.</DialogDescription>
          </DialogHeader>
          {newCodes && <RecoveryCodes codes={newCodes} email={me.email} />}
          <DialogFooter>
            <Button onClick={() => setNewCodes(null)}>Tôi đã lưu mã</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const PROFILE_TABS = [
  { key: 'profile', label: 'Hồ sơ', icon: UserRound },
  { key: 'security', label: 'Bảo mật', icon: ShieldCheck },
  { key: 'api-keys', label: 'API key', icon: Code2 },
] as const;

function ProfileContent() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tabParam = sp.get('tab');
  const tab = tabParam === 'security' || tabParam === 'api-keys' ? tabParam : 'profile';
  const { refreshUser, login } = useAuth();
  const { languages } = useLanguages();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (form || !me.data) return;
    const u = me.data;
    setForm({ name: u.name, phone: u.phone ?? '', bio: u.bio ?? '', avatarId: u.avatarId, locale: u.locale ?? '' });
  }, [me.data, form]);

  const update = (patch: Partial<ProfileForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (!form.name.trim()) throw new Error('Vui lòng nhập họ tên');
      return api.patch<Me>('/auth/me', { name: form.name.trim(), phone: form.phone.trim(), bio: form.bio, avatarId: form.avatarId, locale: form.locale || undefined });
    },
    onSuccess: async (data) => {
      toast.success('Đã cập nhật hồ sơ');
      setDirty(false);
      qc.setQueryData(['me'], data);
      await refreshUser();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      if (!pw.current) throw new Error('Vui lòng nhập mật khẩu hiện tại');
      if (pw.next.length < 8) throw new Error('Mật khẩu mới tối thiểu 8 ký tự');
      if (pw.next !== pw.confirm) throw new Error('Mật khẩu xác nhận không khớp');
      await api.post('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
      // Đổi mật khẩu sẽ thu hồi mọi phiên đăng nhập -> đăng nhập lại phiên hiện tại bằng mật khẩu mới
      if (me.data) await login(me.data.email, pw.next).catch(() => undefined);
    },
    onSuccess: async () => {
      toast.success('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.');
      setPw({ current: '', next: '', confirm: '' });
      await refreshUser().catch(() => undefined);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, doSave);

  if (!form || !me.data) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const u = me.data;
  const strength = passwordStrength(pw.next);
  // bắt buộc 2FA mà chưa bật -> khoá tab Hồ sơ, chỉ cho thao tác ở tab Bảo mật
  const lockToSecurity = u.setup2faRequired && !u.twoFactorEnabled;

  return (
    <>
      <PageHeader
        title="Hồ sơ cá nhân"
        description={u.email}
        actions={
          tab === 'profile' && (
            <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu thay đổi
            </Button>
          )
        }
      />
      <PageBody>
        <Tabs value={lockToSecurity ? 'security' : tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })} className="mb-6">
          <TabsList>
            {PROFILE_TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} disabled={lockToSecurity && t.key !== 'security'}>
                <t.icon className="size-4" /> {t.label}
                {t.key === 'security' && !u.twoFactorEnabled && <span className="ml-1 inline-block size-1.5 rounded-full bg-amber-500" aria-label="Chưa bật 2FA" />}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {tab === 'security' || lockToSecurity ? (
          <SecurityTab me={u} required={!!u.setup2faRequired} />
        ) : tab === 'api-keys' ? (
          <ApiKeysPanel />
        ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <div className="min-w-0 space-y-6">
            <Section title="Thông tin cá nhân">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Họ và tên" required>
                  <Input value={form.name} onChange={(e) => update({ name: e.target.value })} />
                </Field>
                <Field label="Email" help="Liên hệ quản trị viên để đổi email đăng nhập">
                  <Input value={u.email} disabled />
                </Field>
                <Field label="Số điện thoại">
                  <Input value={form.phone} onChange={(e) => update({ phone: e.target.value })} placeholder="09xx xxx xxx" />
                </Field>
                <Field label="Ngôn ngữ ưa thích">
                  <Select value={form.locale || 'auto'} onValueChange={(v) => update({ locale: v === 'auto' ? '' : v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Theo mặc định website</SelectItem>
                      {languages.map((l) => (
                        <SelectItem key={l.code} value={l.code}>
                          {l.flag} {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Giới thiệu" help="Hiển thị ở phần tác giả của bài viết">
                <Textarea value={form.bio} onChange={(e) => update({ bio: e.target.value })} rows={4} />
              </Field>
            </Section>

            <Section title="Đổi mật khẩu" description="Sau khi đổi, các phiên đăng nhập trên thiết bị khác sẽ bị đăng xuất.">
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  changePassword.mutate();
                }}
              >
                <input type="text" name="username" autoComplete="username" value={u.email} readOnly hidden />
                <Field label="Mật khẩu hiện tại" required>
                  <Input type={showPw ? 'text' : 'password'} autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className="max-w-sm" />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Mật khẩu mới" required>
                    <div className="relative">
                      <Input type={showPw ? 'text' : 'password'} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="pr-9" />
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPw((v) => !v)} aria-label="Hiện mật khẩu">
                        {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    {pw.next && (
                      <div className="flex items-center gap-2 pt-1">
                        <div className="flex flex-1 gap-1">
                          {[0, 1, 2, 3].map((i) => (
                            <span key={i} className={`h-1 flex-1 rounded-full ${i < strength.score ? strength.color : 'bg-muted'}`} />
                          ))}
                        </div>
                        <span className="text-xs text-muted-foreground">{strength.label}</span>
                      </div>
                    )}
                    <PasswordPolicyHint password={pw.next} email={u.email} name={u.name} />
                  </Field>
                  <Field label="Nhập lại mật khẩu mới" required error={pw.confirm && pw.confirm !== pw.next ? 'Mật khẩu xác nhận không khớp' : undefined}>
                    <Input type={showPw ? 'text' : 'password'} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
                  </Field>
                </div>
                <Button type="submit" variant="outline" disabled={changePassword.isPending || !pw.current || !pw.next}>
                  {changePassword.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Đổi mật khẩu
                </Button>
              </form>
            </Section>
          </div>

          <div className="space-y-6">
            <Section title="Ảnh đại diện">
              <ImageIdField value={form.avatarId} onChange={(id) => update({ avatarId: id })} aspect="aspect-square" label="Chọn ảnh đại diện" />
            </Section>
            <Section title="Tài khoản">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Vai trò</dt>
                <dd>
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="size-3" /> {u.role.name}
                  </Badge>
                </dd>
                <dt className="text-muted-foreground">Ngày tạo</dt>
                <dd>{formatDate(u.createdAt, 'dd/MM/yyyy')}</dd>
                <dt className="text-muted-foreground">Đăng nhập</dt>
                <dd>{formatDate(u.lastLoginAt)}</dd>
                {u.lastLoginIp && (
                  <>
                    <dt className="text-muted-foreground">IP</dt>
                    <dd className="font-mono text-xs">{u.lastLoginIp}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Quyền</dt>
                <dd className="text-xs text-muted-foreground">{u.role.permissions.includes('*') ? 'Toàn quyền' : `${u.role.permissions.length} quyền`}</dd>
                <dt className="text-muted-foreground">2FA</dt>
                <dd>
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => router.replace(`${pathname}?tab=security`, { scroll: false })}>
                    {u.twoFactorEnabled ? 'Đang bật' : 'Chưa bật — thiết lập'}
                  </button>
                </dd>
              </dl>
            </Section>
          </div>
        </div>
        )}
      </PageBody>
    </>
  );
}

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfileContent />
    </Suspense>
  );
}
