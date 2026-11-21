"use client";

/** Form mật khẩu mới: `POST /api/auth/reset-password { token, password }` (token sống 60 phút) */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, KeyRound, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthTitle } from "@/components/site/auth-shell";
import { Spinner } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError(t("Mật khẩu nhập lại không khớp"));
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password }, { auth: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div>
        <AuthTitle title={t("Liên kết không hợp lệ")} description={t("Liên kết đặt lại mật khẩu thiếu mã xác thực hoặc đã bị cắt. Vui lòng yêu cầu gửi lại.")} />
        <Button asChild size="lg">
          <Link href="/forgot-password">{t("Gửi lại liên kết")}</Link>
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <span className="mx-auto mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
          <CheckCircle2 className="size-7" />
        </span>
        <AuthTitle title={t("Đổi mật khẩu thành công")} description={t("Bạn có thể đăng nhập bằng mật khẩu mới.")} />
        <Button asChild size="lg">
          <Link href="/login">{t("Đăng nhập")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      <AuthTitle title={t("Đặt lại mật khẩu")} description={t("Nhập mật khẩu mới cho tài khoản của bạn.")} />
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">{t("Mật khẩu mới")}</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus className="h-12 rounded-xl bg-card pl-10" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">{t("Nhập lại mật khẩu")}</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-12 rounded-xl bg-card pl-10" />
          </div>
        </div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="h-12 w-full rounded-xl text-base" disabled={loading}>
          {loading ? <Spinner /> : <KeyRound />} {t("Lưu mật khẩu mới")}
        </Button>
      </form>
    </div>
  );
}
