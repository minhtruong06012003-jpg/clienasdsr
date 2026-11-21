"use client";

/**
 * Chân trang gọn, căn giữa (dùng ở khu vực thành viên đã đăng nhập):
 * logo → hàng liên kết (trang chủ, bảng giá, giới thiệu, liên hệ, các chính sách) →
 * dòng thông tin công ty (tên · địa chỉ · email, lấy từ Admin › Cài đặt › Liên hệ; trống thì ẩn) → bản quyền.
 * Các trang /p/<slug> là trang CMS: tạo ở Admin với đúng slug bên dưới để liên kết không bị 404.
 */
import Link from "next/link";
import { useBootstrap, useSiteName } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";

/** Liên kết chân trang: nhãn là chuỗi tiếng Việt gốc, dịch khi hiển thị */
const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Trang Chủ" },
  { href: "/service-pricing", label: "Bảng Giá" },
  { href: "/pricing", label: "Nạp Tiền" },
  { href: "/p/gioi-thieu", label: "Về Chúng Tôi" },
  { href: "/p/lien-he", label: "Liên Hệ" },
  { href: "/p/dieu-khoan", label: "Điều Khoản Dịch Vụ" },
  { href: "/p/chinh-sach-bao-mat", label: "Chính Sách Bảo Mật" },
  { href: "/p/chinh-sach-hoan-tien", label: "Chính Sách Hoàn Tiền" },
  { href: "/p/chinh-sach-noi-dung-ai", label: "Chính Sách Nội Dung AI" },
];

/** Lấy chuỗi từ cài đặt: chuỗi thường hoặc object đa ngôn ngữ { vi, en } */
function text(v: unknown, locale: string): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, string>;
    return (o[locale] || o.vi || "").trim();
  }
  return "";
}

export function CompactFooter() {
  const name = useSiteName();
  const { t, locale } = useI18n();
  const { data } = useBootstrap();
  const contact = data?.settings?.contact ?? {};
  const company = text(contact.companyName, locale);
  const address = text(contact.address, locale);
  const email = text(contact.email, locale);
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border/60">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-5 px-4 py-10 text-center sm:px-6">
        {/* hàng liên kết: tự xuống dòng, căn giữa */}
        <nav className="flex flex-wrap justify-center gap-x-7 gap-y-3 text-sm text-muted-foreground">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="transition-colors hover:text-foreground">
              {t(l.label)}
            </Link>
          ))}
        </nav>
        {/* thông tin công ty: chỉ hiện phần đã nhập trong cài đặt */}
        {(company || address || email) && (
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            {[company, address].filter(Boolean).join(" · ")}
            {email && (
              <>
                {(company || address) && " · "}
                <a href={`mailto:${email}`} className="text-muted-foreground hover:text-foreground">
                  {email}
                </a>
              </>
            )}
          </p>
        )}
        <p className="text-xs text-muted-foreground/80">{t("© {year} {name}. Bản quyền đã được bảo hộ.", { year, name: company || name })}</p>
      </div>
    </footer>
  );
}
