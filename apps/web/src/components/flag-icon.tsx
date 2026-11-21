/**
 * Cờ quốc gia dạng SVG sắc nét (thay emoji cờ vốn bị Windows hiển thị thành chữ VN / GB / ID / CN).
 */
import { cn } from "@/lib/utils";

export function FlagIcon({ code, className }: { code: string; className?: string }) {
  const c = code.trim().toLowerCase();
  const base = cn("inline-block h-3.5 w-5 shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgb(0_0_0/0.08)]", className);

  if (c === "vi" || c === "vn") {
    return (
      <svg viewBox="0 0 30 20" className={base} aria-hidden>
        <rect width="30" height="20" fill="#DA251D" />
        <polygon
          fill="#FFFF00"
          points="15,4 16.47,8.52 21.22,8.52 17.38,11.31 18.85,15.83 15,13.04 11.15,15.83 12.62,11.31 8.78,8.52 13.53,8.52"
        />
      </svg>
    );
  }

  if (c === "en" || c === "gb" || c === "uk") {
    return (
      <svg viewBox="0 0 60 30" className={base} aria-hidden>
        <rect width="60" height="30" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" strokeWidth="6" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="3.5" />
        <path d="M30,0 V30 M0,15 H60" stroke="#FFFFFF" strokeWidth="10" />
        <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" strokeWidth="6" />
      </svg>
    );
  }

  if (c === "id") {
    return (
      <svg viewBox="0 0 30 20" className={base} aria-hidden>
        <rect width="30" height="10" fill="#CE1126" />
        <rect y="10" width="30" height="10" fill="#FFFFFF" />
      </svg>
    );
  }

  if (c === "zh" || c === "zh-cn" || c === "cn") {
    return (
      <svg viewBox="0 0 30 20" className={base} aria-hidden>
        <rect width="30" height="20" fill="#EE1C25" />
        <polygon
          fill="#FFFF00"
          points="5,2.2 5.88,4.91 8.73,4.91 6.42,6.59 7.31,9.3 5,7.62 2.69,9.3 3.58,6.59 1.27,4.91 4.12,4.91"
        />
        <circle cx="10.2" cy="2.2" r="0.75" fill="#FFFF00" />
        <circle cx="12" cy="4.2" r="0.75" fill="#FFFF00" />
        <circle cx="12" cy="6.8" r="0.75" fill="#FFFF00" />
        <circle cx="10.2" cy="8.8" r="0.75" fill="#FFFF00" />
      </svg>
    );
  }

  if (c === "th") {
    return (
      <svg viewBox="0 0 30 20" className={base} aria-hidden>
        <rect width="30" height="20" fill="#A51931" />
        <rect y="3.33" width="30" height="13.34" fill="#F4F5F8" />
        <rect y="6.67" width="30" height="6.66" fill="#2D2A4A" />
      </svg>
    );
  }

  const isoMap: Record<string, string> = { ja: "jp", ko: "kr", th: "th", fr: "fr", de: "de", ru: "ru", es: "es" };
  const iso = isoMap[c] ?? c.split("-").pop() ?? "un";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`https://flagcdn.com/${iso}.svg`} alt="" className={cn(base, "object-cover")} />
  );
}
