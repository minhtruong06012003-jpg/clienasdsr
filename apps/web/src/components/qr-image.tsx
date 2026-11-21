"use client";

/**
 * Hiển thị mã QR: nếu `src` là URL ảnh (http/data:image) thì dùng thẳng,
 * còn lại coi là chuỗi cần mã hoá (VietQR EMVCo, otpauth://...) và vẽ bằng thư viện qrcode.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

export function QrImage({ value, imageUrl, size = 220, className, alt }: { value?: string | null; imageUrl?: string | null; size?: number; className?: string; alt?: string }) {
  const t = useT();
  const direct = imageUrl || (value && /^(https?:|data:image\/)/.test(value) ? value : null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (direct || !value) return;
    let alive = true;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((u) => alive && setDataUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [value, direct, size]);

  const src = direct || dataUrl;
  if (failed) return <p className="text-sm text-muted-foreground">{t("Không tạo được mã QR")}</p>;
  if (!src) return <Skeleton className={cn("rounded-xl", className)} style={{ width: size, height: size }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? t("Mã QR")} width={size} height={size} className={cn("rounded-xl bg-white p-2", className)} />;
}
