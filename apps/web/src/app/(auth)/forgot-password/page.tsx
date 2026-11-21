"use client";

/** Quên mật khẩu: `POST /api/auth/forgot-password?locale=<ngôn ngữ đang chọn> { email }` — API luôn trả success (không lộ email tồn tại) */
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Mail, MailCheck, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthTitle } from "@/components/site/auth-shell";
import { Spinner } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";

export default function ForgotPasswordPage() {
  const { t, locale } = useI18n();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim() }, { auth: false, query: { locale } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center">
        <span className="mx-auto mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
          <MailCheck className="size-7" />
        </span>
        <AuthTitle title={t("Đã gửi hướng dẫn")} description={t("Nếu {email} đã đăng ký, bạn sẽ nhận được email chứa liên kết đặt lại mật khẩu (hiệu lực 60 phút).", { email })} />
        <Button asChild variant="outline" size="lg">
          <Link href="/login">{t("Về trang đăng nhập")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      <AuthTitle title={t("Quên mật khẩu")} description={t("Nhập email đăng ký, chúng tôi sẽ gửi liên kết để đặt lại mật khẩu.")} />
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t("Email")}</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus className="h-12 rounded-xl bg-card pl-10" />
          </div>
        </div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="h-12 w-full rounded-xl text-base" disabled={loading}>
          {loading ? <Spinner /> : <Send />} {t("Gửi liên kết đặt lại")}
        </Button>
        <Link href="/login" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t("Quay lại đăng nhập")}
        </Link>
      </form>
    </div>
  );
}
