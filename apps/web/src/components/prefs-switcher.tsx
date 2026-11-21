"use client";

/**
 * Nút quả địa cầu ở thanh trên (trang công khai + khu vực thành viên): đổi nhanh ngôn ngữ và tiền tệ hiển thị.
 * Múi giờ đổi ở trang Tài khoản (danh sách dài, ít khi đổi).
 */
import { Globe } from "lucide-react";
import { toast } from "sonner";
import { FlagIcon } from "@/components/flag-icon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { currencyName, type Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

/** Tiêu đề nhóm (Ngôn ngữ / Tiền tệ): chữ nhỏ in hoa, giãn chữ */
const SECTION = "px-1.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase";
/** Một lựa chọn: ô icon + tên + mã nhỏ bên cạnh (1 dòng cho gọn); dòng đang chọn nền màu chủ đạo nhạt, dấu ✓ màu chủ đạo */
const ITEM = "gap-2 rounded-lg py-1 pr-8 pl-1 data-[state=checked]:bg-primary-soft data-[state=checked]:text-primary [&_[data-slot=dropdown-menu-radio-item-indicator]]:right-2.5 [&_[data-slot=dropdown-menu-radio-item-indicator]_svg]:text-primary!";
/** Ô vuông chứa cờ / ký hiệu tiền tệ */
const TILE = "inline-flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-sm leading-none";
/** Mã ngôn ngữ / tiền tệ: in hoa, nhỏ, màu nhạt, nằm cuối dòng */
const HINT = "shrink-0 text-[10px] font-medium text-muted-foreground! uppercase";

/** Ký hiệu tiền tệ ngắn theo ngôn ngữ (₫, $, €...); mã lạ thì dùng chính mã đó */
function currencySymbol(code: string, locale: string) {
  if (code === "VND") return "đ";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

export function PrefsSwitcher({ className }: { className?: string }) {
  const { t, locale, currency, languages, currencies, setLocale, setCurrency } = useI18n();
  // chỉ một ngôn ngữ và một tiền tệ -> không có gì để chọn
  if (languages.length < 2 && currencies.list.length < 2) return null;
  const onError = (err: unknown) => toast.error(errorMessage(err));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("gap-1.5 px-2.5 text-xs font-semibold", className)} aria-label={t("Ngôn ngữ & tiền tệ")}>
          <FlagIcon code={locale} className="h-3.5 w-5" />
          <span className="uppercase">{locale}</span>
          {currencies.list.length > 1 && <span className="text-muted-foreground">· {currency}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56 rounded-xl p-1">
        {languages.length > 1 && (
          <>
            <DropdownMenuLabel className={SECTION}>{t("Ngôn ngữ")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale).catch(onError)} className="space-y-0.5">
              {languages.map((l) => (
                <DropdownMenuRadioItem key={l.code} value={l.code} className={ITEM}>
                  <span className={TILE}>
                    <FlagIcon code={l.code} className="h-3.5 w-[19px]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                  <span className={HINT}>{l.code}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {languages.length > 1 && currencies.list.length > 1 && <DropdownMenuSeparator className="mx-1 my-1" />}
        {currencies.list.length > 1 && (
          <>
            <DropdownMenuLabel className={SECTION}>{t("Tiền tệ")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={currency} onValueChange={(v) => setCurrency(v).catch(onError)} className="space-y-0.5">
              {currencies.list.map((c) => (
                <DropdownMenuRadioItem key={c.code} value={c.code} className={ITEM}>
                  <span className={cn(TILE, "text-xs font-bold")}>{currencySymbol(c.code, locale)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{c.name || currencyName(c.code, locale)}</span>
                  <span className={HINT}>{c.code}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
