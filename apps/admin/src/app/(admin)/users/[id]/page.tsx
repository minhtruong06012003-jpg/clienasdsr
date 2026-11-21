'use client';

import Link from 'next/link';
import { Suspense, use, useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  Clock,
  Coins,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Fingerprint,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  LogOut,
  Mail,
  MonitorSmartphone,
  MoreHorizontal,
  Phone,
  RotateCcw,
  Save,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { StatusBadge } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ImageIdField } from '@/components/media/media-picker';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { UserAvatar } from '@/components/users/user-avatar';
import { SessionsList, type SessionItem } from '@/components/auth/sessions-list';
import { CreditsPanel } from '@/components/users/credits-panel';
import { LockUserDialog } from '@/components/users/lock-user-dialog';
import { DeleteUserDialog } from '@/components/users/delete-user-dialog';
import { UserActivityPanel } from '@/components/users/user-activity';
import { generatePassword, passwordStrength } from '@/components/users/password-strength';
import { PasswordPolicyHint } from '@/components/users/password-policy-hint';
import type { RoleOption } from '@/components/users/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { cn } from '@/lib/utils';

interface Address {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  ward: string | null;
  district: string | null;
  city: string | null;
  country: string;
  isDefault: boolean;
}

interface UserDetail {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  bio: string | null;
  status: string;
  locale: string | null;
  avatarId: string | null;
  avatar: { id: string; url: string; urls: Record<string, string> } | null;
  roleId: string;
  role: { id: string; name: string; slug: string };
  customFields?: Record<string, unknown>;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  twoFactorEnabled: boolean;
  failedLogins: number;
  lockedUntil: string | null;
  /** lý do admin khoá tạm thời (null = khoá tự động do đăng nhập sai) */
  lockReason: string | null;
  walletBalance: number;
  customDiscount: number;
  createdAt: string;
  updatedAt: string;
  addresses: Address[];
  _count: { orders: number; posts: number };
}

interface FormState {
  name: string;
  email: string;
  phone: string;
  bio: string;
  roleId: string;
  status: string;
  locale: string;
  avatarId: string | null;
  password: string;
  customDiscount: string;
  customFields: Record<string, unknown>;
}

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Hoạt động', desc: 'Có thể đăng nhập bình thường' },
  { value: 'PENDING', label: 'Chờ duyệt', desc: 'Chờ xác minh / duyệt tài khoản' },
  { value: 'INACTIVE', label: 'Ngừng hoạt động', desc: 'Tạm thời không thể đăng nhập' },
  { value: 'BANNED', label: 'Bị khoá', desc: 'Bị cấm truy cập' },
];

/** Các tab của trang chi tiết (chỉ hiện khi thành viên đã tồn tại) */
type TabKey = 'overview' | 'credits' | 'security' | 'activity';
const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Tổng quan', icon: UserRound },
  // tab số dư ví / AI Studio (key giữ 'credits' cho đường dẫn ?tab=credits cũ)
  { key: 'credits', label: 'Số dư & AI', icon: Coins },
  { key: 'security', label: 'Bảo mật', icon: Shield },
  { key: 'activity', label: 'Hoạt động', icon: Activity },
];

/** Copy chuỗi vào clipboard + toast */
const copy = (text: string, msg = 'Đã copy') => {
  void navigator.clipboard.writeText(text);
  toast.success(msg);
};

export default function UserEditorPage({ params }: { params: Promise<{ id: string }> }) {
  // useSearchParams (tab trên URL) cần bọc Suspense theo quy ước Next
  return (
    <Suspense
      fallback={
        <div className="flex h-[60vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <UserEditor params={params} />
    </Suspense>
  );
}

function UserEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can, user: me, refreshUser } = useAuth();
  const { languages } = useLanguages();
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showPw, setShowPw] = useState(false);
  // hộp thoại khoá tạm thời / xoá vĩnh viễn đang mở
  const [dialog, setDialog] = useState<'lock' | 'delete' | null>(null);
  const readOnly = !can('users.write');
  const isSelf = me?.id === id;

  // tab hiện tại lấy từ URL (?tab=) để F5 / chia sẻ link vẫn đúng tab
  const tabParam = sp.get('tab') as TabKey | null;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';
  const setTab = (t: TabKey) => router.replace(t === 'overview' ? pathname : `${pathname}?tab=${t}`, { scroll: false });

  const user = useQuery({ queryKey: ['user', id], queryFn: () => api.get<UserDetail>(`/admin/users/${id}`), enabled: !isNew });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles') });
  // dùng chung cache với SessionsList (cùng queryKey) để đếm số thiết bị ở hero
  const sessions = useQuery({ queryKey: ['user-sessions', id], queryFn: () => api.get<SessionItem[]>(`/admin/users/${id}/sessions`), enabled: !isNew });

  useEffect(() => {
    if (form) return;
    if (isNew && roles.data) {
      const def = roles.data.find((r) => r.slug === 'customer') ?? roles.data[roles.data.length - 1];
      setForm({ name: '', email: '', phone: '', bio: '', roleId: def?.id ?? '', status: 'ACTIVE', locale: '', avatarId: null, password: '', customDiscount: '0', customFields: {} });
    } else if (user.data) {
      const u = user.data;
      setForm({ name: u.name, email: u.email, phone: u.phone ?? '', bio: u.bio ?? '', roleId: u.roleId, status: u.status, locale: u.locale ?? '', avatarId: u.avatarId, password: '', customDiscount: String(u.customDiscount ?? 0), customFields: u.customFields ?? {} });
    }
  }, [isNew, roles.data, user.data, form]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };
  /** Huỷ thay đổi chưa lưu: nạp lại form từ dữ liệu server */
  const discard = () => {
    setForm(null);
    setDirty(false);
    setShowPw(false);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (!form.name.trim()) throw new Error('Vui lòng nhập họ tên');
      if (!form.email.trim()) throw new Error('Vui lòng nhập email');
      if (isNew && form.password.length < 8) throw new Error('Mật khẩu tối thiểu 8 ký tự');
      if (!isNew && form.password && form.password.length < 8) throw new Error('Mật khẩu mới tối thiểu 8 ký tự');
      const parsedDiscount = Math.max(0, Math.min(100, Number(String(form.customDiscount || '0').replace(',', '.')) || 0));
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        bio: form.bio,
        roleId: form.roleId,
        status: form.status,
        avatarId: form.avatarId,
        customDiscount: parsedDiscount,
        customFields: form.customFields,
        // chuỗi rỗng = bỏ chọn (dùng ngôn ngữ mặc định); khi tạo mới thì không gửi
        ...(form.locale || !isNew ? { locale: form.locale } : {}),
        ...(form.password ? { password: form.password } : {}),
      };
      return isNew ? api.post<UserDetail>('/admin/users', body) : api.patch<UserDetail>(`/admin/users/${id}`, body);
    },
    onSuccess: async (data) => {
      toast.success(isNew ? 'Đã tạo thành viên' : form?.password ? 'Đã lưu và đặt mật khẩu mới' : 'Đã lưu thay đổi');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['user-credits', id] });
      void qc.invalidateQueries({ queryKey: ['roles'] });
      if (isSelf) await refreshUser().catch(() => undefined);
      if (isNew) router.replace(`/users/${data.id}`);
      else {
        // chờ tải lại chi tiết (có addresses) rồi mới nạp lại form -> không hiện lại giá trị cũ
        await user.refetch();
        void qc.invalidateQueries({ queryKey: ['user-sessions', id] });
        setForm(null);
        setShowPw(false);
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`/admin/users/${id}/revoke-sessions`),
    onSuccess: () => {
      toast.success('Đã thu hồi mọi phiên đăng nhập');
      void qc.invalidateQueries({ queryKey: ['user-sessions', id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unlock = useMutation({
    mutationFn: () => api.post(`/admin/users/${id}/unlock`),
    onSuccess: () => {
      toast.success('Đã mở khoá tài khoản');
      void user.refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reset2fa = useMutation({
    mutationFn: () => api.post(`/admin/users/${id}/reset-2fa`),
    onSuccess: () => {
      toast.success('Đã đặt lại xác thực 2 bước. Thành viên sẽ đăng nhập lại chỉ bằng mật khẩu.');
      void user.refetch();
      void qc.invalidateQueries({ queryKey: ['user-sessions', id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, readOnly ? undefined : doSave);

  if (!form || (!isNew && user.isLoading)) {
    if (!isNew && user.isError)
      return (
        <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          Không tìm thấy thành viên
          <Button variant="outline" size="sm" asChild>
            <Link href="/users">Quay lại danh sách</Link>
          </Button>
        </div>
      );
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const u = user.data;
  const strength = passwordStrength(form.password);
  const selectedRole = roles.data?.find((r) => r.id === form.roleId);
  const isLocked = !!u?.lockedUntil && new Date(u.lockedUntil) > new Date();
  const canManage = !readOnly && !isSelf; // thao tác bảo mật lên tài khoản người khác
  const localeName = u?.locale ? languages.find((l) => l.code === u.locale)?.name : null;

  // ---------------- hành động bảo mật (dùng ở menu "⋯" lẫn tab Bảo mật) ----------------
  const askUnlock = async () => {
    const why = u?.lockReason ? `do quản trị viên khoá (lý do: ${u.lockReason})` : 'do đăng nhập sai nhiều lần';
    if (await confirm({ title: 'Mở khoá tài khoản?', description: `Tài khoản đang bị tạm khoá ${why} tới ${formatDate(u?.lockedUntil)}. Mở khoá để thành viên đăng nhập lại ngay.`, confirmText: 'Mở khoá' })) unlock.mutate();
  };
  const askReset2fa = async () => {
    if (await confirm({ title: 'Đặt lại xác thực 2 bước?', description: 'Dùng khi thành viên mất điện thoại và mã dự phòng. 2FA sẽ bị tắt, mọi phiên đăng nhập bị thu hồi; thành viên đăng nhập lại bằng mật khẩu rồi tự bật 2FA mới.', confirmText: 'Đặt lại 2FA', destructive: true })) reset2fa.mutate();
  };
  const askRevoke = async () => {
    if (await confirm({ title: 'Thu hồi mọi phiên đăng nhập?', description: 'Thành viên sẽ bị đăng xuất khỏi tất cả thiết bị và phải đăng nhập lại.' })) revoke.mutate();
  };
  const askDelete = () => setDialog('delete');
  const askLock = () => setDialog('lock');

  // ---------------- các khối form dùng chung giữa tab Tổng quan và trang tạo mới ----------------
  const accountForm = (
    <Section title="Thông tin tài khoản" description="Thông tin hiển thị và liên hệ của thành viên">
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Họ và tên" required>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} autoFocus={isNew} placeholder="Nguyễn Văn A" />
          </Field>
          <Field label="Email" required help={!isNew ? 'Dùng để đăng nhập và nhận thông báo' : undefined}>
            <Input type="email" value={form.email} onChange={(e) => update({ email: e.target.value })} autoComplete="off" placeholder="email@domain.com" />
          </Field>
          <Field label="Số điện thoại">
            <Input value={form.phone} onChange={(e) => update({ phone: e.target.value })} placeholder="09xx xxx xxx" />
          </Field>
          <Field label="Ngôn ngữ" help="Ngôn ngữ giao diện và email gửi cho thành viên">
            <Select value={form.locale || 'auto'} onValueChange={(v) => update({ locale: v === 'auto' ? '' : v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Mặc định của website</SelectItem>
                {languages.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.flag} {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Chiết khấu giảm giá (%)"
            help="Giảm trực tiếp % giá trên toàn bộ công cụ AI & sản phẩm của website cho thành viên này (0 = giá gốc)"
          >
            <div className="flex h-9 items-stretch overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring/40">
              <span className="inline-flex items-center border-r bg-muted/60 px-2.5 text-xs font-semibold text-muted-foreground">%</span>
              <input
                type="number"
                min={0}
                max={100}
                step="0.5"
                value={form.customDiscount}
                onChange={(e) => update({ customDiscount: e.target.value })}
                placeholder="0"
                className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums outline-none"
              />
              <span className="inline-flex items-center border-l bg-muted/60 px-2.5 text-xs font-semibold text-muted-foreground">%</span>
            </div>
          </Field>
        </div>
        <Field label="Giới thiệu" help="Hiển thị ở trang tác giả nếu thành viên có bài viết">
          <Textarea value={form.bio} onChange={(e) => update({ bio: e.target.value })} rows={3} placeholder="Vài dòng về thành viên…" />
        </Field>
      </fieldset>
    </Section>
  );

  const passwordForm = !readOnly && !isSelf && (
    <Section
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" /> {isNew ? 'Mật khẩu' : 'Đặt mật khẩu mới'}
        </span>
      }
      description={isNew ? 'Tối thiểu 8 ký tự. Nên tạo ngẫu nhiên rồi gửi cho thành viên.' : 'Để trống nếu không muốn đổi. Đổi mật khẩu sẽ đăng xuất thành viên khỏi mọi thiết bị.'}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-full max-w-sm">
          <Input type={showPw ? 'text' : 'password'} value={form.password} onChange={(e) => update({ password: e.target.value })} autoComplete="new-password" placeholder={isNew ? 'Nhập mật khẩu' : 'Mật khẩu mới'} className="pr-9" />
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPw((v) => !v)} aria-label="Hiện mật khẩu">
            {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            update({ password: generatePassword() });
            setShowPw(true);
          }}
        >
          <Sparkles /> Tạo ngẫu nhiên
        </Button>
        {form.password && (
          <Button type="button" variant="ghost" size="icon" onClick={() => copy(form.password, 'Đã copy mật khẩu')} aria-label="Copy mật khẩu">
            <Copy />
          </Button>
        )}
      </div>
      {form.password && (
        <div className="flex max-w-sm items-center gap-2">
          <div className="flex flex-1 gap-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${i < strength.score ? strength.color : 'bg-muted'}`} />
            ))}
          </div>
          <span className="text-xs text-muted-foreground">{strength.label}</span>
        </div>
      )}
      {(isNew || form.password) && <PasswordPolicyHint password={form.password} email={form.email} name={form.name} className="max-w-xl" />}
      {!isNew && form.password && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5" /> Mật khẩu mới chỉ có hiệu lực sau khi bấm “Lưu thay đổi”.
        </p>
      )}
    </Section>
  );

  const permissionForm = (
    <Section title="Phân quyền" description="Vai trò quyết định thành viên được làm gì trong hệ thống">
      <fieldset disabled={readOnly} className="space-y-4">
        <Field
          label="Vai trò"
          action={
            can('roles.manage') && (
              <Link href="/users/roles" className="text-xs text-primary hover:underline">
                Quản lý vai trò
              </Link>
            )
          }
        >
          <Select value={form.roleId} onValueChange={(v) => update({ roleId: v })} disabled={readOnly || isSelf}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Chọn vai trò" />
            </SelectTrigger>
            <SelectContent>
              {roles.data?.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedRole?.description && <p className="text-xs text-muted-foreground">{selectedRole.description}</p>}
          {isSelf && <p className="text-xs text-muted-foreground">Không thể tự đổi vai trò của chính mình.</p>}
        </Field>
        <Field label="Trạng thái">
          <Select value={form.status} onValueChange={(v) => update({ status: v })} disabled={readOnly || isSelf}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{STATUS_OPTIONS.find((s) => s.value === form.status)?.desc}</p>
        </Field>
      </fieldset>
    </Section>
  );

  const avatarForm = (
    <Section title="Ảnh đại diện">
      {readOnly ? (
        u && <UserAvatar name={u.name} avatar={u.avatar} className="size-24 text-xl" />
      ) : (
        <ImageIdField value={form.avatarId} initial={u?.avatar} onChange={(fid) => update({ avatarId: fid })} aspect="aspect-square" label="Chọn ảnh đại diện" />
      )}
    </Section>
  );

  /** Trường tuỳ chỉnh của thành viên (nhóm lọc theo vai trò đang chọn) */
  const roleSlug = roles.data?.find((r) => r.id === form.roleId)?.slug ?? u?.role.slug;
  const customFieldsForm = <CustomFieldsPanel entity="user" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ roleSlug }} disabled={readOnly} />;

  // ---------------- trang tạo mới: không có hero / tab ----------------
  if (isNew || !u) {
    return (
      <>
        <PageHeader
          title="Thêm thành viên"
          description="Tạo tài khoản mới cho khách hàng hoặc nhân viên"
          breadcrumbs={[{ label: 'Thành viên', href: '/users' }, { label: 'Mới' }]}
          actions={
            !readOnly && (
              <>
                <Button variant="outline" asChild>
                  <Link href="/users">Huỷ</Link>
                </Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Tạo thành viên
                </Button>
              </>
            )
          }
        />
        <PageBody>
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-6">
              {accountForm}
              {customFieldsForm}
              {passwordForm}
            </div>
            <div className="space-y-6">
              {permissionForm}
              {avatarForm}
            </div>
          </div>
        </PageBody>
      </>
    );
  }

  // ---------------- trang chỉnh sửa ----------------
  const activeSessions = sessions.data?.length;
  const headerMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Thao tác khác">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {can('activity.read') && (
          <DropdownMenuItem asChild>
            <Link href={`/system-logs/activity?userId=${u.id}`}>
              <Activity /> Nhật ký hoạt động đầy đủ
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => copy(u.id, 'Đã copy ID thành viên')}>
          <Fingerprint /> Copy ID thành viên
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuSeparator />
            {isLocked ? (
              <DropdownMenuItem onClick={askUnlock}>
                <LockOpen /> Mở khoá tài khoản
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={askLock}>
                <Lock /> Khoá tạm thời
              </DropdownMenuItem>
            )}
            {u.twoFactorEnabled && (
              <DropdownMenuItem onClick={askReset2fa}>
                <ShieldOff /> Đặt lại xác thực 2 bước
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={askRevoke}>
              <LogOut /> Thu hồi mọi phiên đăng nhập
            </DropdownMenuItem>
          </>
        )}
        {!isSelf && can('users.delete') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={askDelete}>
              <Trash2 /> Xoá thành viên
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <PageHeader
        title={u.name || 'Thành viên'}
        description={u.email}
        breadcrumbs={[{ label: 'Thành viên', href: '/users' }, { label: u.name || 'Chỉnh sửa' }]}
        actions={
          <>
            {!readOnly && dirty && (
              <>
                <span className="hidden items-center gap-1.5 text-xs text-amber-700 sm:flex dark:text-amber-400">
                  <span className="size-1.5 rounded-full bg-amber-500" /> Chưa lưu
                </span>
                <Button variant="ghost" onClick={discard} disabled={save.isPending}>
                  <RotateCcw /> Huỷ
                </Button>
              </>
            )}
            {!readOnly && (
              <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu thay đổi
              </Button>
            )}
            {headerMenu}
          </>
        }
      />
      <PageBody>
        {/* ===== Hero: nhận diện nhanh thành viên ===== */}
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
            <UserAvatar name={u.name} avatar={u.avatar} className="size-20 text-2xl ring-4 ring-background shadow-sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold leading-tight tracking-tight">{u.name}</h2>
                <StatusBadge status={u.status} />
                <Badge variant="outline" className="gap-1">
                  <Shield className="size-3" /> {u.role.name}
                </Badge>
                {u.twoFactorEnabled ? (
                  <Badge className="gap-1 border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    <ShieldCheck className="size-3" /> 2FA
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-muted-foreground">
                    <ShieldOff className="size-3" /> Chưa bật 2FA
                  </Badge>
                )}
                {isLocked && (
                  <Badge className="gap-1 border-transparent bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                    <ShieldAlert className="size-3" /> Tạm khoá tới {formatDate(u.lockedUntil, 'HH:mm dd/MM')}
                    {u.lockReason && <span className="max-w-48 truncate font-normal" title={u.lockReason}>· {u.lockReason}</span>}
                  </Badge>
                )}
                {isSelf && <Badge variant="secondary">Tài khoản của bạn</Badge>}
              </div>

              {/* liên hệ */}
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                <span className="group flex items-center gap-1.5 text-muted-foreground">
                  <Mail className="size-3.5" />
                  <a href={`mailto:${u.email}`} className="text-foreground hover:text-primary">
                    {u.email}
                  </a>
                  <button type="button" onClick={() => copy(u.email, 'Đã copy email')} className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100" aria-label="Copy email">
                    <Copy className="size-3" />
                  </button>
                </span>
                {u.phone && (
                  <span className="group flex items-center gap-1.5 text-muted-foreground">
                    <Phone className="size-3.5" />
                    <a href={`tel:${u.phone}`} className="text-foreground hover:text-primary">
                      {u.phone}
                    </a>
                    <button type="button" onClick={() => copy(u.phone!, 'Đã copy số điện thoại')} className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100" aria-label="Copy số điện thoại">
                      <Copy className="size-3" />
                    </button>
                  </span>
                )}
                {localeName && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Globe className="size-3.5" /> {localeName}
                  </span>
                )}
              </div>

              {/* mốc thời gian */}
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5" title={formatDate(u.createdAt)}>
                  <CalendarDays className="size-3.5" /> Tham gia {formatDate(u.createdAt, 'dd/MM/yyyy')} · {timeAgo(u.createdAt)}
                </span>
                <span className="flex items-center gap-1.5" title={u.lastLoginAt ? formatDate(u.lastLoginAt) : undefined}>
                  <Clock className="size-3.5" /> Đăng nhập cuối {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'chưa có'}
                  {u.lastLoginIp && <span className="font-mono">({u.lastLoginIp})</span>}
                </span>
                <button type="button" onClick={() => copy(u.id, 'Đã copy ID thành viên')} className="flex items-center gap-1.5 hover:text-foreground" title={u.id}>
                  <Fingerprint className="size-3.5" /> ID <span className="font-mono">{u.id.slice(0, 8)}…</span>
                </button>
              </div>
            </div>
          </div>

          {/* dải số liệu */}
          <div className="grid grid-cols-2 divide-x border-t bg-muted/30 sm:grid-cols-3">
            <HeroStat icon={FileText} label="Bài viết" value={u._count.posts} href={u._count.posts > 0 && can('posts.read') ? `/posts?authorId=${u.id}` : undefined} />
            <HeroStat icon={Wallet} label="Số dư ví" value={formatMoney(u.walletBalance)} valueClassName="text-primary" />
            <HeroStat icon={MonitorSmartphone} label="Thiết bị đang đăng nhập" value={activeSessions ?? '…'} onClick={() => setTab('security')} />
          </div>
        </div>

        {/* ===== Tabs ===== */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="-mt-2">
          <TabsList variant="line" className="h-auto w-full justify-start overflow-x-auto border-b">
            {TABS.map((t) => {
              if (t.key === 'activity' && !can('activity.read')) return null;
              const count = t.key === 'security' ? activeSessions : undefined;
              return (
                <TabsTrigger key={t.key} value={t.key} className="h-9 flex-none px-3">
                  <t.icon className="size-4" /> {t.label}
                  {count != null && count > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>}
                  {t.key === 'security' && (isLocked || !u.twoFactorEnabled) && <span className={cn('size-1.5 rounded-full', isLocked ? 'bg-red-500' : 'bg-amber-500')} aria-label="Cần chú ý" />}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        {tab === 'overview' && (
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-6">
              {accountForm}
              {customFieldsForm}
            </div>
            <div className="space-y-6">
              {permissionForm}
              {avatarForm}
              <Section title="Thông tin hệ thống">
                <dl className="space-y-2.5 text-sm">
                  <InfoRow label="ID">
                    <button type="button" onClick={() => copy(u.id, 'Đã copy ID thành viên')} className="flex items-center gap-1 font-mono text-xs hover:text-primary" title={u.id}>
                      {u.id.slice(0, 13)}… <Copy className="size-3" />
                    </button>
                  </InfoRow>
                  <InfoRow label="Tạo lúc">{formatDate(u.createdAt)}</InfoRow>
                  <InfoRow label="Cập nhật">{formatDate(u.updatedAt)}</InfoRow>
                  <InfoRow label="Đăng nhập cuối">{u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}</InfoRow>
                  <InfoRow label="IP cuối">
                    <span className="font-mono text-xs">{u.lastLoginIp ?? '—'}</span>
                  </InfoRow>
                </dl>
              </Section>
            </div>
          </div>
        )}

        {tab === 'credits' && <CreditsPanel userId={u.id} />}


        {tab === 'security' && (
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-6">
              {passwordForm}
              {isSelf && (
                <div className="flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                  <KeyRound className="size-4" /> Đổi mật khẩu và quản lý 2FA của bạn tại{' '}
                  <Link href="/profile?tab=security" className="text-primary hover:underline">
                    Hồ sơ cá nhân
                  </Link>
                </div>
              )}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <MonitorSmartphone className="size-4 text-muted-foreground" /> Thiết bị đã đăng nhập
                  </span>
                }
                description="Các phiên đang hoạt động của thành viên. Thu hồi phiên sẽ đăng xuất thiết bị đó ngay."
                actions={
                  canManage &&
                  (activeSessions ?? 0) > 0 && (
                    <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={askRevoke}>
                      {revoke.isPending ? <Loader2 className="animate-spin" /> : <LogOut />} Thu hồi tất cả
                    </Button>
                  )
                }
              >
                <SessionsList listPath={`/admin/users/${id}/sessions`} revokePath={(sid) => `/admin/users/${id}/sessions/${sid}`} canRevoke={canManage} queryKey={['user-sessions', id]} />
              </Section>
            </div>
            <div className="space-y-6">
              <Section title="Tình trạng bảo mật">
                <div className="divide-y">
                  <SecurityRow
                    icon={u.twoFactorEnabled ? ShieldCheck : ShieldOff}
                    tone={u.twoFactorEnabled ? 'ok' : 'warn'}
                    label="Xác thực 2 bước"
                    value={u.twoFactorEnabled ? 'Đang bật' : 'Chưa bật'}
                    action={
                      canManage &&
                      u.twoFactorEnabled && (
                        <Button size="xs" variant="outline" disabled={reset2fa.isPending} onClick={askReset2fa}>
                          {reset2fa.isPending ? <Loader2 className="animate-spin" /> : null} Đặt lại
                        </Button>
                      )
                    }
                  />
                  <SecurityRow
                    icon={isLocked ? ShieldAlert : LockOpen}
                    tone={isLocked ? 'danger' : 'ok'}
                    label="Khoá tạm thời"
                    value={isLocked ? `Tới ${formatDate(u.lockedUntil, 'HH:mm dd/MM/yyyy')}${u.lockReason ? ` · ${u.lockReason}` : ' · đăng nhập sai nhiều lần'}` : 'Không bị khoá'}
                    action={
                      canManage &&
                      (isLocked ? (
                        <Button size="xs" variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400" disabled={unlock.isPending} onClick={askUnlock}>
                          {unlock.isPending ? <Loader2 className="animate-spin" /> : <LockOpen />} Mở khoá
                        </Button>
                      ) : (
                        <Button size="xs" variant="outline" onClick={askLock}>
                          <Lock /> Khoá
                        </Button>
                      ))
                    }
                  />
                  <SecurityRow icon={AlertTriangle} tone={u.failedLogins > 0 ? 'warn' : 'muted'} label="Đăng nhập sai liên tiếp" value={`${u.failedLogins} lần`} />
                  <SecurityRow icon={MonitorSmartphone} tone="muted" label="Thiết bị đang đăng nhập" value={activeSessions == null ? '…' : `${activeSessions} thiết bị`} />
                  <SecurityRow icon={Clock} tone="muted" label="Đăng nhập cuối" value={u.lastLoginAt ? `${formatDate(u.lastLoginAt)}${u.lastLoginIp ? ` · ${u.lastLoginIp}` : ''}` : 'Chưa có'} />
                </div>
              </Section>

              {!isSelf && can('users.delete') && (
                <Section title={<span className="text-destructive">Vùng nguy hiểm</span>} className="border-destructive/30">
                  <p className="text-xs text-muted-foreground">Xoá vĩnh viễn tài khoản cùng dữ liệu liên quan (bạn chọn giữ hay xoá đơn hàng, nội dung, media...). Không thể khôi phục — chỉ muốn chặn đăng nhập thì dùng Khoá tạm thời.</p>
                  <Button variant="outline" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={askDelete}>
                    <Trash2 /> Xoá thành viên
                  </Button>
                </Section>
              )}
            </div>
          </div>
        )}

        {tab === 'activity' && <UserActivityPanel userId={u.id} />}
      </PageBody>

      {dialog === 'lock' && (
        <LockUserDialog
          userId={u.id}
          userName={u.name}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void user.refetch();
            void qc.invalidateQueries({ queryKey: ['user-sessions', id] });
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
      {dialog === 'delete' && (
        <DeleteUserDialog
          userId={u.id}
          onClose={() => setDialog(null)}
          onLockInstead={canManage && !isLocked ? () => setDialog('lock') : undefined}
          onDone={() => {
            setDialog(null);
            setDirty(false);
            void qc.invalidateQueries({ queryKey: ['users'] });
            router.push('/users');
          }}
        />
      )}
    </>
  );
}

/** Ô số liệu ở dải dưới hero; bấm để chuyển tab / đi tới trang liên quan */
function HeroStat({ icon: Icon, label, value, valueClassName, href, onClick }: { icon: LucideIcon; label: string; value: ReactNode; valueClassName?: string; href?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </span>
      <span className={cn('mt-1 block text-lg font-semibold tabular-nums leading-tight', valueClassName)}>{value}</span>
    </>
  );
  const cls = 'block px-4 py-3 text-left transition-colors';
  if (href)
    return (
      <Link href={href} className={cn(cls, 'hover:bg-muted/60')}>
        {inner}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cn(cls, 'w-full hover:bg-muted/60')}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

/** Dòng nhãn – giá trị trong thẻ "Thông tin hệ thống" */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/** Dòng trạng thái trong thẻ "Tình trạng bảo mật" */
function SecurityRow({ icon: Icon, tone, label, value, action }: { icon: LucideIcon; tone: 'ok' | 'warn' | 'danger' | 'muted'; label: string; value: string; action?: ReactNode }) {
  const toneCls = {
    ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    danger: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    muted: 'bg-muted text-muted-foreground',
  }[tone];
  return (
    <div className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', toneCls)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
      {action}
    </div>
  );
}
