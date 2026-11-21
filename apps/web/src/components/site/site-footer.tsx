"use client";

/** Chân trang công khai: giới thiệu, liên kết nhanh, nền tảng, chính sách */
import Link from "next/link";
import { Logo } from "./logo";
import { useSiteName } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";

export function SiteFooter() {
  const name = useSiteName();
  const { t } = useI18n();
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-card/50">
      {/* mobile: khối giới thiệu chiếm trọn hàng, 3 cột liên kết xếp lưới 2 cột */}
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-x-6 gap-y-8 px-4 py-10 sm:px-6 sm:py-12 md:grid-cols-2 lg:grid-cols-4 lg:gap-10">
        <div className="col-span-2 space-y-3 md:col-span-2 lg:col-span-1">
          <Logo />
          <p className="text-sm text-muted-foreground">{t("Nền tảng AI tất cả trong một: tạo video, ảnh, giọng đọc, âm nhạc bằng AI với các model hàng đầu, trả phí theo lượt dùng.")}</p>
        </div>
        <FooterCol
          title="Sản phẩm"
          links={[
            { href: "/#tools", label: "Công cụ AI" },
            { href: "/service-pricing", label: "Bảng giá dịch vụ" },
            { href: "/pricing", label: "Bảng giá nạp tiền" },
            { href: "/dashboard", label: "Bảng điều khiển" },
            { href: "/history", label: "Lịch sử tạo" },
            { href: "/community", label: "Cộng đồng" },
          ]}
        />
        <FooterCol
          title="Tài khoản"
          links={[
            { href: "/register", label: "Đăng ký" },
            { href: "/login", label: "Đăng nhập" },
            { href: "/affiliate", label: "Tiếp thị liên kết" },
          ]}
        />
        <FooterCol
          title="Hỗ trợ"
          links={[
            { href: "/api-docs", label: "Tài liệu API" },
            { href: "/p/dieu-khoan", label: "Điều khoản dịch vụ" },
            { href: "/p/chinh-sach-bao-mat", label: "Chính sách bảo mật" },
            { href: "/p/chinh-sach-noi-dung-ai", label: "Chính Sách Nội Dung AI" },
          ]}
        />
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-1.5 px-4 py-5 text-center text-xs text-muted-foreground sm:flex-row sm:px-6 sm:text-left">
          <p>
            {t("© {year} {name}. Bảo lưu mọi quyền.", { year, name })}
          </p>
          <p>{t("Thanh toán an toàn · Tự động 24/7 · Hoàn tiền khi lỗi")}</p>
        </div>
      </div>
    </footer>
  );
}

/** Một cột liên kết chân trang: tiêu đề + nhãn truyền vào là chuỗi tiếng Việt gốc, dịch tại đây */
function FooterCol({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  const { t } = useI18n();
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold">{t(title)}</h3>
      <ul className="space-y-2.5 text-sm text-muted-foreground sm:space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="transition-colors hover:text-foreground">
              {t(l.label)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
