"use client";

/**
 * Nút liên hệ nổi ở góc dưới màn hình (Cài đặt › Nút liên hệ trong admin, nhóm public `contactButtons`).
 * Nút tròn chính bấm để xổ / thu danh sách kênh (Telegram, Zalo, Messenger...); chỉ hiện kênh đang bật và có link.
 * Trạng thái mở / đóng khách chọn được nhớ trong phiên (sessionStorage) để chuyển trang không bị bật lại.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Mail, MessageCircleMore, Phone, Ticket, X } from "lucide-react";
import { contactChannelIcon, contactHref, findContactChannel, normalizeContactButtons, type ContactButtonItem } from "@cmsnt/shared";
import { useBootstrap } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "smm-contact-open";

/** Icon tròn của một kênh: ảnh admin tải lên > icon thư viện > icon vẽ sẵn (gọi điện, email) / chữ cái đầu */
function ChannelIcon({ item }: { item: ContactButtonItem }) {
  const src = item.icon || contactChannelIcon(item.key);
  // eslint-disable-next-line @next/next/no-img-element -- ảnh Media / icon SVG của API, không qua next/image
  if (src) return <img src={src} alt="" className="size-full rounded-full object-cover" loading="lazy" />;
  const color = findContactChannel(item.key)?.color ?? "#111111";
  const Icon = item.key === "phone" ? Phone : item.key === "email" ? Mail : null;
  return (
    <span className="flex size-full items-center justify-center rounded-full text-white" style={{ background: color }}>
      {Icon ? <Icon className="size-[48%]" /> : <span className="text-lg font-semibold">{item.label.charAt(0).toUpperCase()}</span>}
    </span>
  );
}

export function ContactButtons() {
  const { t } = useI18n();
  const raw = useBootstrap().data?.settings?.contactButtons;
  const cfg = useMemo(() => normalizeContactButtons(raw), [raw]);
  // kênh hiển thị: đang bật + có link hợp lệ
  const items = useMemo(
    () =>
      cfg.items
        .map((it) => ({
          ...it,
          label: t(it.label.trim() || findContactChannel(it.key)?.label || "Liên hệ"),
          href: contactHref(it.key, it.url),
        }))
        .filter((it) => it.enabled && it.href),
    [cfg.items, t],
  );
  const [open, setOpen] = useState(false);

  // trạng thái ban đầu: lựa chọn của khách trong phiên, chưa có thì theo cài đặt "Mở sẵn"
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // trình duyệt chặn storage: dùng mặc định
    }
    setOpen(saved ? saved === "1" : cfg.defaultOpen);
  }, [cfg.defaultOpen]);

  const toggle = () => {
    setOpen((o) => {
      try {
        sessionStorage.setItem(STORAGE_KEY, o ? "0" : "1");
      } catch {
        // bỏ qua khi không ghi được storage
      }
      return !o;
    });
  };

  if (!cfg.enabled) return null;
  const left = cfg.position === "left";
  const hasCustomTicket = items.some((it) => it.href === "/support" || it.href.endsWith("/support"));

  return (
    <div
      className={cn(
        // mobile: đẩy lên trên thanh điều hướng dưới của khu thành viên (cao 4rem + vùng an toàn)
        "fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-3 lg:bottom-6 print:hidden",
        left ? "left-4" : "right-4",
      )}
    >
      <ul id="contact-buttons-list" className={cn("flex flex-col items-center gap-3 transition-all duration-200", open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0")} aria-hidden={!open}>
        {items.map((it) => (
          <li key={it.key} className="group relative">
            <a
              href={it.href}
              target={/^https?:/i.test(it.href) ? "_blank" : undefined}
              rel="noopener noreferrer"
              aria-label={it.label}
              tabIndex={open ? 0 : -1}
              className="block size-12 rounded-full bg-background p-0.5 shadow-lg ring-1 ring-black/5 transition-transform hover:scale-110 dark:ring-white/10"
            >
              <ChannelIcon item={it} />
            </a>
            {/* nhãn kênh hiện khi rê chuột (desktop) */}
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow transition-opacity group-hover:opacity-100",
                left ? "left-full ml-3" : "right-full mr-3",
              )}
            >
              {it.label}
            </span>
          </li>
        ))}
        {!hasCustomTicket && (
          <li key="__support_ticket__" className="group relative">
            <Link
              href="/support"
              aria-label={t("Chat Ticket hỗ trợ 24/7")}
              tabIndex={open ? 0 : -1}
              className="block size-12 rounded-full bg-background p-0.5 shadow-lg ring-1 ring-black/5 transition-transform hover:scale-110 dark:ring-white/10"
            >
              <span className="relative flex size-full items-center justify-center rounded-full bg-gradient-to-br from-sky-500 via-blue-600 to-indigo-600 text-white">
                <Ticket className="size-[50%]" />
                <span className="absolute -right-1 -bottom-0.5 rounded-full bg-emerald-500 px-1 py-px text-[8px] leading-tight font-extrabold text-white ring-1 ring-background">
                  24/7
                </span>
              </span>
            </Link>
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow transition-opacity group-hover:opacity-100",
                left ? "left-full ml-3" : "right-full mr-3",
              )}
            >
              {t("Chat Ticket hỗ trợ 24/7")}
            </span>
          </li>
        )}
      </ul>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="contact-buttons-list"
        aria-label={open ? t("Đóng liên hệ") : t("Liên hệ hỗ trợ")}
        className={cn(
          "relative flex size-14 items-center justify-center rounded-full text-white shadow-xl ring-4 ring-background transition-all active:scale-95",
          open ? "bg-muted-foreground/70 hover:bg-muted-foreground/85" : "bg-brand-gradient",
        )}
      >
        {/* vòng sóng nhấp nháy khi đang thu gọn để khách chú ý */}
        {!open && <span className="absolute inset-0 animate-ping rounded-full bg-primary/40 [animation-duration:2s]" aria-hidden />}
        {open ? <X className="relative size-6" /> : <MessageCircleMore className="relative size-6" />}
      </button>
    </div>
  );
}
