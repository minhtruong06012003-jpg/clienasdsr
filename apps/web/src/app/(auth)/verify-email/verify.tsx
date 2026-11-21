"use client";

/** Gọi `POST /api/auth/verify-email { token }` một lần khi mở trang; thành công thì đăng nhập luôn và vào dashboard */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthTitle } from "@/components/site/auth-shell";
import { LoadingBlock } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AuthResult } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";

export function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const { signIn } = useAuth();
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "ok" | "error">(token ? "loading" : "error");
  // lỗi API trả về; rỗng thì hiện thông báo mặc định (thiếu token / hết hạn) dịch theo ngôn ngữ khi render
  const [error, setError] = useState<string>("");
  // chặn gọi 2 lần (React StrictMode chạy effect hai lần ở dev, token chỉ dùng được 1 lần)
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .post<AuthResult>("/auth/verify-email", { token }, { auth: false })
      .then((res) => {
        signIn(res);
        setState("ok");
        setTimeout(() => router.replace("/dashboard"), 1500);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setState("error");
      });
  }, [token, signIn, router]);

  if (state === "loading") return <LoadingBlock text={t("Đang xác minh email...")} />;
  if (state === "ok") {
    return (
      <div className="text-center">
        <span className="mx-auto mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
          <CheckCircle2 className="size-7" />
        </span>
        <AuthTitle title={t("Xác minh thành công")} description={t("Đang chuyển tới bảng điều khiển...")} />
      </div>
    );
  }
  return (
    <div className="text-center">
      <span className="mx-auto mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <XCircle className="size-7" />
      </span>
      <AuthTitle title={t("Không xác minh được email")} description={error || (token ? t("Liên kết đã hết hạn (24 giờ) hoặc đã được dùng.") : t("Liên kết xác minh không hợp lệ"))} />
      <Button asChild size="lg">
        <Link href="/login">{t("Về trang đăng nhập")}</Link>
      </Button>
    </div>
  );
}
