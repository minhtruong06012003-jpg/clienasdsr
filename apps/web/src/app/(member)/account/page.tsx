"use client";

/**
 * Cấu hình tài khoản (theo mẫu zsmm "Cấu hình"), 2 cột:
 * - Trái: "Thông tin tài khoản & Liên hệ" (`PATCH /api/auth/me`), "Đổi mật khẩu tài khoản"
 *   (`POST /api/auth/change-password` — thu hồi mọi phiên, phải đăng nhập lại).
 * - Phải: "Bảo mật 2 lớp (2FA)" (`/api/auth/2fa/setup|enable|disable`), "Tùy biến hiển thị" (chế độ Sáng/Tối + màu
 *   giao diện, đổi màu ở trang Giao diện), "Ngôn ngữ & khu vực" (ngôn ngữ, tiền tệ, múi giờ), "Lịch sử đăng nhập gần đây" (`GET/DELETE /api/auth/sessions`).
 * - "Thông báo Telegram" (`/api/account/telegram`): liên kết bot Telegram của website, chọn loại thông báo; ẩn khi admin tắt bot.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { BellRing, ChevronRight, Eye, EyeOff, History, Laptop, Link2Off, Lock, LogOut, MonitorSmartphone, Palette as PaletteIcon, Send, ShieldCheck, ShieldOff, Smartphone, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, ErrorState, LoadingBlock, Spinner } from "@/components/common";
import { usePalette } from "@/components/palette-provider";
import { QrImage } from "@/components/qr-image";
import { api, errorMessage } from "@/lib/api";
import { ME_KEY, useAuth } from "@/lib/auth";
import { useI18n, useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { SessionView, User } from "@/lib/types";

export default function AccountPage() {
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      {/* grid-cols-1 (minmax(0,1fr)) để cột trên mobile không bị nội dung dài kéo rộng quá màn hình */}
      {/* cột trái: thông tin tài khoản + đổi mật khẩu */}
      <div className="min-w-0 space-y-6">
        <ProfileCard />
        <PasswordCard />
      </div>
      {/* cột phải: 2FA, Telegram, tùy biến hiển thị, lịch sử đăng nhập */}
      <div className="min-w-0 space-y-6">
        <TwoFactorCard />
        <TelegramCard />
        <DisplayCard />
        <SessionsCard />
      </div>
    </div>
  );
}

/* ---------------- Khung thẻ dùng chung ---------------- */

/** Thẻ theo mẫu: nền trắng viền nhạt, tiêu đề đậm + icon, đường kẻ dưới tiêu đề, `badge` nằm bên phải tiêu đề */
function SectionCard({ title, icon, badge, size = "md", children, className }: { title: string; icon: ReactNode; badge?: ReactNode; size?: "md" | "sm"; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border bg-card p-4 shadow-xs md:p-5", className)}>
      <div className="mb-4 flex items-center justify-between gap-2 border-b pb-3">
        <h3 className={cn("flex items-center gap-2 font-bold", size === "md" ? "text-base" : "text-sm")}>
          <span className="inline-flex text-foreground [&_svg]:size-4.5">{icon}</span>
          {title}
        </h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

/** Nhãn ô nhập theo mẫu: chữ nhỏ, đậm vừa */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <Label htmlFor={htmlFor} className="mb-1.5 text-xs font-semibold">
      {children}
    </Label>
  );
}

/** Ô mật khẩu có nút mắt để hiện/ẩn ký tự */
function PasswordInput({ id, value, onChange, autoComplete, minLength, maxLength }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; minLength?: number; maxLength?: number }) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} required className="pr-10" />
      <button type="button" onClick={() => setShow((v) => !v)} className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={show ? t("Ẩn mật khẩu") : t("Hiện mật khẩu")}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/* ---------------- Thông tin tài khoản & Liên hệ ---------------- */

function ProfileCard() {
  const { t, fmt } = useI18n();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setPhone(user.phone ?? "");
    }
  }, [user]);

  const save = useMutation({
    mutationFn: () => api.patch<User>("/auth/me", { name: name.trim(), phone: phone.trim() }),
    onSuccess: (u) => {
      qc.setQueryData(ME_KEY, u);
      toast.success(t("Đã lưu thông tin"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <SectionCard title={t("Thông tin tài khoản & Liên hệ")} icon={<UserRound />}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return toast.error(t("Vui lòng nhập họ tên"));
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>{t("Địa chỉ email:")}</FieldLabel>
            <Input value={user?.email ?? ""} disabled />
            <p className="mt-1 text-[11px] text-subtle-foreground">{t("Email đăng nhập không thể thay đổi.")}</p>
          </div>
          <div>
            <FieldLabel>{t("Cấp bậc tài khoản:")}</FieldLabel>
            <Input value={user?.role?.name ?? t("Khách hàng")} disabled />
            {user?.createdAt && <p className="mt-1 text-[11px] text-subtle-foreground">{t("Thành viên từ {date}", { date: fmt.dateTime(user.createdAt) })}</p>}
          </div>
          <div>
            <FieldLabel htmlFor="name">{t("Họ tên:")}</FieldLabel>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={t("Nhập họ tên")} />
          </div>
          <div>
            <FieldLabel htmlFor="phone">{t("Số điện thoại:")}</FieldLabel>
            <Input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("Nhập số điện thoại")} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" className="rounded-xl" disabled={save.isPending}>
            {save.isPending && <Spinner />} {t("Lưu thay đổi")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

/* ---------------- Đổi mật khẩu tài khoản ---------------- */

function PasswordCard() {
  const t = useT();
  const router = useRouter();
  const { signOut } = useAuth();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const change = useMutation({
    mutationFn: () => api.post("/auth/change-password", { currentPassword: form.currentPassword, newPassword: form.newPassword }),
    onSuccess: async () => {
      // API thu hồi mọi phiên -> đăng nhập lại
      toast.success(t("Đổi mật khẩu thành công, vui lòng đăng nhập lại"));
      await signOut();
      router.replace("/login");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <SectionCard title={t("Đổi mật khẩu tài khoản")} icon={<Lock />}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.newPassword !== form.confirm) return toast.error(t("Mật khẩu nhập lại không khớp"));
          change.mutate();
        }}
      >
        <div>
          <FieldLabel htmlFor="cur">{t("Mật khẩu hiện tại:")}</FieldLabel>
          <PasswordInput id="cur" autoComplete="current-password" value={form.currentPassword} onChange={(v) => setForm((f) => ({ ...f, currentPassword: v }))} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="new">{t("Mật khẩu mới:")}</FieldLabel>
            <PasswordInput id="new" autoComplete="new-password" minLength={8} maxLength={128} value={form.newPassword} onChange={(v) => setForm((f) => ({ ...f, newPassword: v }))} />
          </div>
          <div>
            <FieldLabel htmlFor="confirm">{t("Nhập lại mật khẩu mới:")}</FieldLabel>
            <Input id="confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} required />
          </div>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-subtle-foreground">{t("Sau khi đổi, mọi thiết bị sẽ phải đăng nhập lại.")}</p>
          <Button type="submit" className="rounded-xl" disabled={change.isPending}>
            {change.isPending && <Spinner />} {t("Cập nhật mật khẩu")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

/* ---------------- Bảo mật 2 lớp ---------------- */

function TwoFactorCard() {
  const t = useT();
  const { user, reloadUser } = useAuth();
  const enabled = !!user?.twoFactorEnabled;
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup"),
    onSuccess: (res) => (setSetup(res), setCode("")),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code: code.replace(/\s/g, "") }),
    onSuccess: (res) => {
      setSetup(null);
      setRecovery(res.recoveryCodes ?? []);
      reloadUser();
      toast.success(t("Đã bật xác thực hai lớp"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const disable = useMutation({
    // nhận mã 6 số từ app hoặc mật khẩu hiện tại
    mutationFn: () => api.post("/auth/2fa/disable", /^\d{6}$/.test(disableCode.trim()) ? { code: disableCode.trim() } : { password: disableCode }),
    onSuccess: () => {
      setDisableOpen(false);
      setDisableCode("");
      reloadUser();
      toast.success(t("Đã tắt xác thực hai lớp"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <SectionCard
      title={t("Bảo mật 2 lớp (2FA)")}
      icon={<ShieldCheck />}
      size="sm"
      badge={
        <span className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap", enabled ? "border-transparent bg-success-soft text-success" : "bg-muted text-muted-foreground")}>
          {enabled ? t("Đã kích hoạt") : t("Chưa kích hoạt")}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("Tăng cường bảo vệ tài khoản bằng mã 6 số từ Google Authenticator hoặc Authy.")}</p>
        {enabled ? (
          <>
            <p className="rounded-xl bg-success-soft px-3 py-2.5 text-xs text-success">{t("2FA đang bật. Còn {n} mã dự phòng chưa dùng.", { n: user?.recoveryCodesLeft ?? 0 })}</p>
            <Button variant="destructive" className="w-full rounded-xl" onClick={() => setDisableOpen(true)}>
              <ShieldOff /> {t("Tắt bảo mật 2 lớp")}
            </Button>
          </>
        ) : setup ? (
          <div className="space-y-3">
            <div className="flex justify-center">
              <div className="rounded-2xl border bg-white p-2">
                <QrImage value={setup.otpauthUrl} size={160} />
              </div>
            </div>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                enable.mutate();
              }}
            >
              <p className="text-xs text-muted-foreground">{t("1. Quét mã QR bằng ứng dụng xác thực (hoặc nhập khoá thủ công).")}</p>
              <div className="flex items-center gap-1">
                <code className="flex-1 rounded-xl bg-muted px-2.5 py-2 font-mono text-xs break-all">{setup.secret}</code>
                <CopyButton value={setup.secret} label={t("Khoá")} />
              </div>
              <p className="text-xs text-muted-foreground">{t("2. Nhập mã 6 số đang hiển thị trong ứng dụng.")}</p>
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" className="font-mono tracking-widest" />
              <div className="flex gap-2">
                <Button type="submit" className="flex-1 rounded-xl" disabled={code.replace(/\s/g, "").length < 6 || enable.isPending}>
                  {enable.isPending && <Spinner />} {t("Bật 2FA")}
                </Button>
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => setSetup(null)}>
                  {t("Huỷ")}
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <Button className="h-10 w-full rounded-xl" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? <Spinner /> : <Smartphone />} {t("Cài đặt Google Authenticator")}
          </Button>
        )}
      </div>

      {/* mã dự phòng hiện một lần sau khi bật */}
      <Dialog open={!!recovery} onOpenChange={(o) => !o && setRecovery(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Lưu mã dự phòng")}</DialogTitle>
            <DialogDescription>{t("Mỗi mã dùng được một lần khi bạn mất điện thoại. Mã chỉ hiển thị lần này.")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-3 font-mono text-sm">
            {recovery?.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <DialogFooter>
            <CopyButton value={(recovery ?? []).join("\n")} label={t("Mã dự phòng")} size="icon" />
            <Button onClick={() => setRecovery(null)}>{t("Tôi đã lưu")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Tắt xác thực hai lớp")}</DialogTitle>
            <DialogDescription>{t("Nhập mã 6 số từ ứng dụng hoặc mật khẩu hiện tại để xác nhận.")}</DialogDescription>
          </DialogHeader>
          <Input type="password" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder={t("Mã 6 số hoặc mật khẩu")} autoComplete="off" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              {t("Đóng")}
            </Button>
            <Button variant="destructive" disabled={!disableCode || disable.isPending} onClick={() => disable.mutate()}>
              {disable.isPending && <Spinner />} {t("Tắt 2FA")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

/* ---------------- Thông báo Telegram ---------------- */

interface TelegramStatus {
  available: boolean;
  botUsername: string | null;
  linked: boolean;
  username: string | null;
  linkedAt: string | null;
  events: { key: string; enabled: boolean }[];
}

/** Tên hiển thị từng loại thông báo (khoá khớp USER_EVENTS ở API modules/telegram) */
const TELEGRAM_EVENT_LABELS: Record<string, string> = {
  taskSucceeded: "Tác vụ AI hoàn thành",
  taskFailed: "Tác vụ AI lỗi / bị huỷ (kèm hoàn tiền)",
  topup: "Nạp tiền vào ví",
  plan: "Kích hoạt gói nạp",
  affiliate: "Hoa hồng & rút tiền giới thiệu",
};

const TELEGRAM_KEY = ["account", "telegram"];

/**
 * Liên kết bot Telegram: bấm nút -> API trả link t.me/<bot>?start=<mã> (hạn 30 phút) -> mở Telegram bấm Start.
 * Trong lúc chờ, thẻ hỏi lại trạng thái mỗi 3 giây để hiện "Đã liên kết" ngay khi khách bấm Start.
 */
function TelegramCard() {
  const t = useT();
  const qc = useQueryClient();
  const [waitUntil, setWaitUntil] = useState(0);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const waiting = waitUntil > Date.now();
  const q = useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: () => api.get<TelegramStatus>("/account/telegram"),
    // tính lại hạn mỗi lần (không dùng biến `waiting` của lần render cũ) để hết hạn link là thôi hỏi
    refetchInterval: (query) => (waitUntil > Date.now() && !query.state.data?.linked ? 3000 : false),
  });
  const data = q.data;

  // đã liên kết xong thì thôi chờ
  useEffect(() => {
    if (data?.linked && waitUntil) {
      setWaitUntil(0);
      toast.success(t("Đã liên kết Telegram"));
    }
  }, [data?.linked, waitUntil, t]);

  const link = useMutation({
    mutationFn: () => api.post<{ url: string; expiresIn: number }>("/account/telegram/link"),
    onSuccess: (r) => {
      setWaitUntil(Date.now() + r.expiresIn * 1000);
      // mở tab mới; trình duyệt chặn popup thì khách bấm link hiện trong thẻ
      window.open(r.url, "_blank", "noopener");
      setLinkUrl(r.url);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const prefs = useMutation({
    mutationFn: (events: Record<string, boolean>) => api.put<TelegramStatus>("/account/telegram/prefs", { events }),
    onSuccess: (d) => qc.setQueryData(TELEGRAM_KEY, d),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const unlink = useMutation({
    mutationFn: () => api.delete<TelegramStatus>("/account/telegram"),
    onSuccess: (d) => {
      qc.setQueryData(TELEGRAM_KEY, d);
      setConfirmUnlink(false);
      setLinkUrl(null);
      toast.success(t("Đã huỷ liên kết Telegram"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // admin chưa bật bot và khách chưa từng liên kết -> ẩn hẳn thẻ
  if (q.isLoading || (!data?.available && !data?.linked)) return null;

  return (
    <SectionCard
      title={t("Thông báo Telegram")}
      icon={<BellRing />}
      size="sm"
      badge={
        <span className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap", data.linked ? "border-transparent bg-success-soft text-success" : "bg-muted text-muted-foreground")}>
          {data.linked ? t("Đã liên kết") : t("Chưa liên kết")}
        </span>
      }
    >
      <div className="space-y-3">
        {data.linked ? (
          <>
            <p className="rounded-xl bg-success-soft px-3 py-2.5 text-xs text-success">
              {data.username ? t("Đang nhận thông báo qua Telegram {name}.", { name: /^\w+$/.test(data.username) ? `@${data.username}` : data.username }) : t("Đang nhận thông báo qua Telegram.")}{" "}
              {data.botUsername && (
                <a href={`https://t.me/${data.botUsername}`} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                  @{data.botUsername}
                </a>
              )}
            </p>
            {data.events.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-xs font-semibold">{t("Nhận thông báo khi:")}</p>
                {data.events.map((e) => (
                  <label key={e.key} className="flex items-center justify-between gap-3 text-xs">
                    <span>{t(TELEGRAM_EVENT_LABELS[e.key] ?? e.key)}</span>
                    <Switch size="sm" checked={e.enabled} disabled={prefs.isPending} onCheckedChange={(on) => prefs.mutate({ [e.key]: on })} />
                  </label>
                ))}
              </div>
            )}
            <Button variant="outline" className="w-full rounded-xl" onClick={() => setConfirmUnlink(true)}>
              <Link2Off /> {t("Huỷ liên kết Telegram")}
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("Nhận thông báo khi tác vụ AI hoàn thành, nạp tiền thành công, kích hoạt gói... ngay trên Telegram.")}</p>
            <Button className="h-10 w-full rounded-xl" onClick={() => link.mutate()} disabled={link.isPending}>
              {link.isPending ? <Spinner /> : <Send />} {t("Liên kết Telegram")}
            </Button>
            {waiting && linkUrl && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner />
                <span>
                  {t("Bấm Start (Bắt đầu) trong Telegram để hoàn tất.")}{" "}
                  <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline">
                    {t("Mở lại Telegram")}
                  </a>
                </span>
              </p>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title={t("Huỷ liên kết Telegram?")}
        description={t("Bạn sẽ không nhận thông báo qua Telegram nữa. Có thể liên kết lại bất cứ lúc nào.")}
        confirmText={t("Huỷ liên kết")}
        destructive
        loading={unlink.isPending}
        onConfirm={() => unlink.mutate()}
      />
    </SectionCard>
  );
}

/* ---------------- Tùy biến hiển thị ---------------- */

/** Chế độ Sáng/Tối dạng nút đoạn + màu giao diện đang dùng (đổi ở trang Giao diện) */
function DisplayCard() {
  const t = useT();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { active } = usePalette();
  const [mounted, setMounted] = useState(false);
  // next-themes chỉ biết chế độ thật sau khi mount -> tránh lệch hydrate
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  const primary = (dark ? active.dark : active.light).primary;

  return (
    <SectionCard title={t("Tùy biến hiển thị")} icon={<MonitorSmartphone />} size="sm">
      <div className="divide-y text-xs">
        {/* chế độ giao diện: nút đoạn, mục chọn nền primary chữ trắng */}
        <div className="flex items-center justify-between gap-3 pb-3">
          <span className="text-muted-foreground">{t("Chế độ giao diện:")}</span>
          <div className="flex gap-1.5">
            {(
              [
                { value: "light", label: "Sáng" },
                { value: "dark", label: "Tối" },
                { value: "system", label: "Tự động" },
              ] as const
            ).map((m) => {
              const on = mounted && theme === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTheme(m.value)}
                  className={cn(
                    "h-7 rounded-lg border px-2.5 font-semibold transition-colors",
                    on ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {t(m.label)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

/* ---------------- Lịch sử đăng nhập gần đây ---------------- */

function SessionsCard() {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const sessions = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: () => api.get<SessionView[]>("/auth/sessions"),
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success(t("Đã đăng xuất phiên"));
      qc.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.delete("/auth/sessions"),
    onSuccess: () => {
      toast.success(t("Đã đăng xuất các thiết bị khác"));
      setConfirmAll(false);
      qc.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <SectionCard title={t("Lịch sử đăng nhập gần đây")} icon={<History />} size="sm">
      {sessions.isLoading ? (
        <LoadingBlock className="py-6" text={t("Đang tải lịch sử đăng nhập...")} />
      ) : sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
      ) : (
        <div className="space-y-2">
          {(sessions.data ?? []).map((s) => {
            const Icon = /mobile|android|iphone/i.test(`${s.device} ${s.os} ${s.userAgent}`) ? Smartphone : Laptop;
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-xl border bg-muted px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">{[s.browser, s.os].filter(Boolean).join(" / ") || t("Thiết bị không xác định")}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{s.ip ?? "—"}</p>
                    <p className="text-[11px] text-muted-foreground" title={fmt.dateTime(s.lastUsedAt ?? s.createdAt)}>
                      {t("{date} · hoạt động {ago}", { date: fmt.dateTime(s.createdAt), ago: fmt.timeAgo(s.lastUsedAt ?? s.createdAt) })}
                    </p>
                  </div>
                </div>
                {s.current ? (
                  <span className="shrink-0 text-xs font-semibold text-success">{t("Hiện tại")}</span>
                ) : (
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                    <LogOut /> {t("Đăng xuất")}
                  </Button>
                )}
              </div>
            );
          })}
          <p className="pt-1 text-[11px] text-subtle-foreground">{t("Các thiết bị đang đăng nhập vào tài khoản. Đăng xuất thiết bị lạ nếu bạn nghi ngờ tài khoản bị lộ.")}</p>
          {(sessions.data?.length ?? 0) > 1 && (
            <Button variant="outline" size="sm" className="w-full rounded-xl" onClick={() => setConfirmAll(true)}>
              <LogOut /> {t("Đăng xuất mọi thiết bị khác")}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog open={confirmAll} onOpenChange={setConfirmAll} title={t("Đăng xuất mọi thiết bị khác?")} confirmText={t("Đăng xuất")} destructive loading={revokeOthers.isPending} onConfirm={() => revokeOthers.mutate()} />
    </SectionCard>
  );
}
