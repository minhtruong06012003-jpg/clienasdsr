"use client";

/**
 * Thông báo nổi (popup) hiện khi khách vào website — Admin › Cài đặt › Thông báo nổi (nhóm public `popup`).
 * - audience: all | member (đã đăng nhập) | guest (chưa đăng nhập);
 * - frequency: once (tới khi admin đổi nội dung) | daily | session | always (mọi lần tải trang);
 * - content: mỗi dòng 1 đoạn, **chữ** = in đậm, link http(s) tự bấm được.
 * Đã xem được nhớ bằng "chữ ký" nội dung trong localStorage / sessionStorage, đổi nội dung là hiện lại.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBootstrap } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/provider";

const STORAGE_KEY = "novai-popup-seen";

interface PopupSettings {
  enabled?: boolean;
  title?: string;
  content?: string;
  image?: string;
  buttonLabel?: string;
  buttonUrl?: string;
  audience?: "all" | "member" | "guest";
  frequency?: "once" | "daily" | "session" | "always";
  delay?: number;
}

/** Chữ ký ngắn của nội dung (hash djb2) để biết admin đã đổi thông báo chưa */
function signature(p: PopupSettings) {
  const s = [p.title, p.content, p.image, p.buttonLabel, p.buttonUrl].join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Giá trị lưu cho lần xem này: once = chữ ký, daily = chữ ký + ngày hôm nay */
function seenValue(p: PopupSettings, sig: string) {
  return p.frequency === "daily" ? `${sig}:${new Date().toDateString()}` : sig;
}

/** Kho lưu theo tần suất: session dùng sessionStorage, always không lưu */
function storeOf(p: PopupSettings): Storage | null {
  try {
    if (p.frequency === "always") return null;
    return p.frequency === "session" ? sessionStorage : localStorage;
  } catch {
    // trình duyệt chặn storage: coi như không nhớ được
    return null;
  }
}

/** Một dòng nội dung: **đậm** và link http(s) */
function renderLine(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s]+)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    if (/^https?:\/\//.test(part))
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
          {part}
        </a>
      );
    return part;
  });
}

export function PopupNotice() {
  const { t } = useI18n();
  const { status } = useAuth();
  const cfg = useBootstrap().data?.settings?.popup as PopupSettings | undefined;
  const sig = useMemo(() => (cfg ? signature(cfg) : ""), [cfg]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // chờ biết trạng thái đăng nhập rồi mới xét đối tượng
    if (!cfg?.enabled || status === "loading") return;
    if (!cfg.title?.trim() && !cfg.content?.trim() && !cfg.image) return;
    if (cfg.audience === "member" && status !== "authenticated") return;
    if (cfg.audience === "guest" && status !== "guest") return;
    let seen: string | null = null;
    try {
      seen = storeOf(cfg)?.getItem(STORAGE_KEY) ?? null;
    } catch {
      // không đọc được storage: vẫn hiện
    }
    if (seen === seenValue(cfg, sig)) return;
    const timer = setTimeout(() => setOpen(true), Math.max(0, Number(cfg.delay) || 0) * 1000);
    return () => clearTimeout(timer);
  }, [cfg, sig, status]);

  if (!cfg) return null;

  // đóng (bấm Đóng / nút / ra ngoài / Esc) -> nhớ đã xem theo tần suất
  const close = () => {
    setOpen(false);
    try {
      storeOf(cfg)?.setItem(STORAGE_KEY, seenValue(cfg, sig));
    } catch {
      // bỏ qua khi không ghi được storage
    }
  };

  const url = cfg.buttonUrl?.trim();
  const internal = !!url && url.startsWith("/") && !url.startsWith("//");
  const rawContent = cfg.content?.trim() ? t(cfg.content.trim()) : "";
  const lines = rawContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => t(l));
  const titleText = cfg.title?.trim() ? t(cfg.title.trim()) : t("Thông báo");
  const btnText = cfg.buttonLabel?.trim() ? t(cfg.buttonLabel.trim()) : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        {cfg.image && (
          // eslint-disable-next-line @next/next/no-img-element -- ảnh Media admin chọn, không qua next/image
          <img src={cfg.image} alt="" className="max-h-64 w-full object-cover" />
        )}
        <div className="space-y-3 p-5">
          <DialogTitle className="pr-6 text-lg font-bold">{titleText}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              {lines.map((l, i) => (
                <p key={i}>{renderLine(l)}</p>
              ))}
            </div>
          </DialogDescription>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={close}>
              {t("Đóng")}
            </Button>
            {url && btnText && (
              <Button asChild onClick={close}>
                {internal ? (
                  <Link href={url}>{btnText}</Link>
                ) : (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {btnText}
                  </a>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
