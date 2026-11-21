"use client";

/**
 * Khung trang tài khoản (đăng nhập / đăng ký / quên mật khẩu...) theo ảnh mẫu:
 * nền xanh nhạt có đốm tròn, ở giữa là 1 thẻ trắng bo góc chia 2 cột —
 * trái: logo, khẩu hiệu, các model AI hỗ trợ, khung minh hoạ, 3 ưu điểm; phải: chọn ngôn ngữ, logo và form.
 * Nội dung cột trái đổi theo trang (bản đăng ký có khẩu hiệu nhận tiền dùng thử và dòng bản quyền).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Coins, Globe, Headset, RotateCcw, ShieldHalf, Sparkles, Wand2, Zap } from "lucide-react";
import { useSiteName } from "@/lib/queries";
import { errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export function AuthShell({ children }: { children: ReactNode }) {
  const siteName = useSiteName();
  const { t } = useI18n();
  const isRegister = usePathname()?.startsWith("/register");

  return (
    <div className="auth-scope relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f4f4f5] px-4 py-6 sm:px-6 lg:py-10">
      {/* đốm tròn trang trí ở các góc */}
      <span className="auth-blob -top-24 -left-24 size-72" />
      <span className="auth-blob -top-16 -right-20 size-56" />
      <span className="auth-blob -bottom-32 -left-10 size-80 opacity-70" />
      <span className="auth-blob -right-24 -bottom-24 size-72" />

      <div className="relative grid w-full max-w-[1100px] overflow-hidden rounded-[22px] bg-white shadow-[0_30px_80px_-35px_rgb(0_0_0/0.18)] grid-cols-1 lg:grid-cols-2">
        {/* cột trái: chỉ hiện từ màn hình lớn */}
        <aside className="relative hidden flex-col overflow-hidden bg-gradient-to-br from-[#f4f4f5] via-[#fafafa] to-[#f1f1f2] px-10 pt-9 pb-7 lg:flex">
          <span className="pointer-events-none absolute -top-16 right-10 size-44 rounded-full bg-white/50" />
          <span className="pointer-events-none absolute right-[-60px] bottom-24 size-48 rounded-full bg-white/40" />
          <AuthBrand siteName={siteName} align="left" />

          {isRegister ? (
            <>
              <h2 className="relative mt-7 text-[30px] leading-[1.25] font-bold text-[#0a0a0a]">
                {t("Tạo tài khoản ngay")}
                <br />
                {t("nhận tiền dùng thử")} <span className="text-[#111111]">{shortName(siteName)}</span>
              </h2>
              <p className="relative mt-3 max-w-sm text-[13.5px] leading-relaxed text-[#6b6b70]">
                {t("Tạo video, ảnh, giọng đọc, âm nhạc bằng các model AI hàng đầu — một tài khoản, một ví tiền.")}
              </p>
            </>
          ) : (
            <>
              <h2 className="relative mt-7 text-[28px] leading-[1.3] font-bold text-[#0a0a0a]">
                {t("Sáng tạo nội dung bằng AI")}
                <br />
                {t("cùng {name}", { name: siteName })}
              </h2>
              <p className="relative mt-2.5 max-w-xs text-[14px] leading-relaxed text-[#6b6b70]">{t("Video · Hình ảnh · Giọng nói · Âm nhạc")}</p>
            </>
          )}

          <SocialRow className="relative mt-5" />

          <AiPreview className="mt-6 mb-4" />

          {isRegister ? (
            <div className="relative mt-auto grid grid-cols-3 divide-x divide-[#e4e4e7]">
              <Feature filled icon={<Zap className="size-4" fill="currentColor" />} title={t("Đăng ký nhanh")} sub={t("Chỉ vài giây")} />
              <Feature filled icon={<ShieldHalf className="size-4" />} title={t("Bảo mật cao")} sub={t("100% an toàn")} />
              <Feature filled icon={<Headset className="size-4" />} title={t("Hỗ trợ 24/7")} sub={t("Luôn sẵn sàng")} />
            </div>
          ) : (
            <div className="relative mt-auto grid grid-cols-3 divide-x divide-[#e4e4e7]">
              <Feature icon={<Wand2 className="size-5" />} title={t("Model AI")} sub={t("hàng đầu")} />
              <Feature icon={<RotateCcw className="size-5" />} title={t("Hoàn tiền")} sub={t("khi lỗi")} />
              <Feature icon={<Coins className="size-5" />} title={t("Trả phí")} sub={t("theo lượt dùng")} />
            </div>
          )}
          {isRegister && <p className="relative mt-6 text-xs text-[#8e8e93]">© {new Date().getFullYear()} {siteName}. All rights reserved.</p>}
        </aside>

        {/* cột phải: form */}
        <main className="relative flex min-w-0 flex-col px-5 pt-14 pb-8 sm:px-10 lg:px-14 lg:pt-12 lg:pb-10">
          <LanguagePill className="absolute top-4 right-4 sm:top-5 sm:right-5" />
          <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center">
            <AuthBrand siteName={siteName} align="center" className="mb-6" />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Lấy phần đầu tên website cho khẩu hiệu (vd "ZSMM PANEL" -> "ZSMM") */
function shortName(name: string) {
  return name.split(/\s+/)[0] || name;
}

/** Logo trang tài khoản: ô gradient tia sét + tên website + dòng "AI CREATIVE STUDIO" */
export function AuthBrand({ siteName, align, className }: { siteName: string; align: "left" | "center"; className?: string }) {
  const center = align === "center";
  return (
    <Link href="/" className={cn("relative flex w-fit items-center gap-2.5", center && "mx-auto flex-col gap-2", className)}>
      <span className={cn("relative inline-flex items-center justify-center rounded-2xl bg-gradient-to-br from-[#18181b] via-[#3f3f46] to-[#71717a] text-white shadow-lg shadow-[#111111]/30", center ? "size-12" : "size-11")}>
        <Zap className="size-6" fill="currentColor" />
      </span>
      <span className={cn("leading-none", center && "text-center")}>
        <span className="block text-[22px] font-bold tracking-tight text-[#0a0a0a]">{siteName}</span>
        <span className="mt-1 block text-[9.5px] font-semibold tracking-[0.28em] text-[#6b6b70] uppercase">AI Creative Studio</span>
      </span>
    </Link>
  );
}

/** Hàng tên các model AI nổi bật */
function SocialRow({ className }: { className?: string }) {
  const items = ["Veo 3.1", "Kling", "Seedance", "GPT Image", "ElevenLabs"];
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {items.map((i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#18181b] shadow-sm">
          <Sparkles className="size-3 text-[#111111]" /> {i}
        </span>
      ))}
    </div>
  );
}

/** Khung minh hoạ: 3 thẻ kết quả AI xếp cạnh nhau (ảnh mẫu ở public/images/auth, nền gradient giữ chỗ khi ảnh chưa tải) */
function AiPreview({ className }: { className?: string }) {
  const { t } = useI18n();
  const cards = [
    { g: "from-neutral-800 to-neutral-500", l: "Video AI", src: "/images/auth/video.webp" },
    { g: "from-zinc-700 to-zinc-400", l: "Ảnh AI", src: "/images/auth/image.webp" },
    { g: "from-stone-900 to-stone-600", l: "Giọng đọc", src: "/images/auth/voice.webp" },
  ];
  return (
    <div className={cn("relative grid grid-cols-3 gap-3", className)}>
      {cards.map((c, i) => (
        <div key={c.l} className={cn("relative aspect-[9/13] overflow-hidden rounded-2xl bg-gradient-to-br shadow-lg", c.g, i === 1 && "-translate-y-3")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ảnh tĩnh nhỏ, không cần tối ưu qua next/image */}
          <img src={c.src} alt={t(c.l)} loading="lazy" className="absolute inset-0 size-full object-cover" />
          <span className="absolute inset-x-2 bottom-2 rounded-lg bg-black/30 px-2 py-1 text-[10px] font-medium text-white backdrop-blur">{t(c.l)}</span>
        </div>
      ))}
    </div>
  );
}

/** 1 ưu điểm ở chân cột trái; `filled` = icon tròn nền xanh (bản đăng ký) */
function Feature({ icon, title, sub, filled }: { icon: ReactNode; title: string; sub: string; filled?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-3 first:pl-0">
      {filled ? (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3f3f46] to-[#111111] text-white shadow-md shadow-[#111111]/30">{icon}</span>
      ) : (
        <span className="shrink-0 text-[#46464b]">{icon}</span>
      )}
      <span className={cn("text-[12px] leading-snug", filled ? "text-[#0a0a0a]" : "text-[#46464b]")}>
        <span className={cn("block", filled && "font-semibold")}>{title}</span>
        <span className={cn("block", filled && "text-[11px] text-[#6b6b70]")}>{sub}</span>
      </span>
    </div>
  );
}

/** Nút chọn ngôn ngữ giao diện (danh sách ngôn ngữ admin bật và có từ điển); chọn xong tự đóng */
function LanguagePill({ className }: { className?: string }) {
  const { t, locale, languages, setLocale } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  const pick = (code: Locale) => {
    if (ref.current) ref.current.open = false;
    if (code !== locale) setLocale(code).catch((err) => toast.error(errorMessage(err)));
  };
  return (
    <details ref={ref} className={cn("group z-10", className)}>
      <summary aria-label={t("Ngôn ngữ")} className="flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-[#e7e7e9] bg-white px-2.5 py-1 text-xs font-medium text-[#46464b] shadow-sm [&::-webkit-details-marker]:hidden">
        <Globe className="size-3.5" /> {locale === "vi" ? "VN" : locale.toUpperCase()} <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 mt-1.5 w-36 space-y-0.5 rounded-xl border border-[#e7e7e9] bg-white p-1 text-sm shadow-lg">
        {languages.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => pick(l.code)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-medium",
              l.code === locale ? "bg-[#f2f2f3] text-[#111111]" : "text-[#46464b] hover:bg-[#f7f7f8]",
            )}
          >
            <span>
              {l.flag} {l.name}
            </span>
            {l.code === locale && <Check className="size-4" />}
          </button>
        ))}
      </div>
    </details>
  );
}

/** Tiêu đề form tài khoản (căn giữa như ảnh mẫu) */
export function AuthTitle({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-6 text-center">
      <h1 className="text-[24px] font-bold tracking-tight text-[#0a0a0a]">{title}</h1>
      {description && <p className="mt-1.5 text-[13.5px] text-[#6b6b70]">{description}</p>}
    </div>
  );
}
