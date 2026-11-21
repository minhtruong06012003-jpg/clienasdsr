"use client";

/** Logo website: ảnh logo đã upload ở Cài đặt › Chung + chữ thương hiệu (vd NOV) bên cạnh khi hiển thị ở sidebar / header */
import Link from "next/link";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSiteLogo, useSiteName } from "@/lib/queries";
import type { MediaRef } from "@/lib/types";

/** Ảnh logo đã upload; có bản tối thì tự đổi theo giao diện sáng/tối. Trả null nếu chưa upload logo */
export function SiteLogoImage({ className }: { className?: string }) {
  const name = useSiteName();
  const { light, dark } = useSiteLogo();
  const main = light ?? dark;
  if (!main) return null;
  const src = (m: MediaRef) => m.urls?.medium ?? m.urls?.webp ?? m.url;
  const alt = (m: MediaRef) => (typeof m.alt === "string" && m.alt) || name;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src(main)} alt={alt(main)} className={cn("w-auto object-contain", dark && light && "dark:hidden", className)} />
      {dark && light && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src(dark)} alt={alt(dark)} className={cn("hidden w-auto object-contain dark:block", className)} />
      )}
    </>
  );
}

/** Rút gọn tên thương hiệu hiển thị cạnh icon logo (nov.ai.vn / NovAI -> Nov AI; các site con giữ nguyên tên site, không dính tên web nguồn — T-372) */
function shortBrandName(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) {
    if (typeof window !== "undefined" && window.location.hostname) {
      const h = window.location.hostname.replace(/^www\./i, "").trim();
      if (h && !/^nov\.ai\.vn$/i.test(h) && h !== "localhost" && h !== "127.0.0.1") {
        return h.replace(/\.[a-z.]+$/i, "");
      }
    }
    return "Nov AI";
  }
  if (/^nov(\.ai(\.vn)?|\s*ai|\s*studio)?$/i.test(s)) return "Nov AI";
  return s.replace(/\.[a-z.]+$/i, "");
}

export function Logo({
  href = "/",
  className,
  compact,
  withBrandText = true,
}: {
  href?: string;
  className?: string;
  compact?: boolean;
  withBrandText?: boolean;
}) {
  const name = useSiteName();
  const { light, dark } = useSiteLogo();
  const brandText = shortBrandName(name);

  if (light || dark) {
    return (
      <Link href={href} className={cn("inline-flex items-center gap-2.5", className)} aria-label={name}>
        <SiteLogoImage className={compact ? "max-h-8 max-w-8 rounded-lg" : "max-h-8.5 max-w-36 rounded-xl"} />
        {!compact && withBrandText && (
          <span className="truncate text-[17.5px] leading-none font-bold tracking-[-0.015em] text-[#09090b] dark:text-white">
            {brandText}
          </span>
        )}
      </Link>
    );
  }
  return (
    <Link href={href} className={cn("flex items-center gap-2.5 font-bold tracking-[-0.015em]", className)}>
      <span className="bg-brand-gradient inline-flex size-8 items-center justify-center rounded-xl text-white shadow-md shadow-primary/30">
        <Zap className="size-4.5" fill="currentColor" />
      </span>
      {!compact && <span className="truncate text-[17.5px] leading-none text-[#09090b] dark:text-white">{brandText}</span>}
    </Link>
  );
}
