"use client";

/**
 * Hộp chọn mẫu (ô select có `picker: "template"`, vd mẫu dựng video của Tin tức thành video):
 * ô hiện mẫu đang chọn (ảnh bìa + tên + nhóm) và nút "Đổi mẫu"; bấm mở hộp thoại có tab theo nhóm (`option.group`),
 * tìm kiếm và lưới thẻ dọc 9:16 — rê chuột (hoặc chạm) vào thẻ thì phát video xem trước (`option.video`).
 */
import { useMemo, useState } from "react";
import { Check, ChevronRight, LayoutTemplate, Play, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiField, AiFieldOption } from "@/lib/types";

/** Ảnh bìa nhỏ của mẫu (không có ảnh thì hiện biểu tượng) */
function Thumb({ option, className }: { option?: AiFieldOption; className?: string }) {
  return (
    <span className={cn("relative block shrink-0 overflow-hidden rounded-lg bg-muted", className)}>
      {option?.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={option.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <LayoutTemplate className="absolute inset-0 m-auto size-5 text-muted-foreground" />
      )}
    </span>
  );
}

/** Thẻ mẫu trong lưới: ảnh bìa, rê chuột thì phát video xem trước (chỉ tải video khi đang xem) */
function TemplateCard({ option: o, active, playing, onHover, onPick }: { option: AiFieldOption; active: boolean; playing: boolean; onHover: (v: string | null) => void; onPick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onPick} onMouseEnter={() => onHover(o.value)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(o.value)} onBlur={() => onHover(null)} className="group text-left">
      <span className={cn("relative block aspect-[9/16] overflow-hidden rounded-xl border bg-[#101827] transition", active ? "border-primary ring-2 ring-primary/50" : "group-hover:border-foreground/30")}>
        {o.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={o.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
        )}
        {playing && o.video && <video src={o.video} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />}
        {active ? (
          <span className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3.5" />
          </span>
        ) : (
          o.video &&
          !playing && (
            <span className="absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/55 text-white">
              <Play className="size-3.5 fill-white" />
            </span>
          )
        )}
      </span>
      <span className={cn("mt-1.5 block truncate text-[12px] font-semibold", active ? "text-primary" : "text-foreground/80")}>{t(o.label)}</span>
    </button>
  );
}

export function TemplatePicker({ field: f, options, value, onChange, disabled }: { field: AiField; options: AiFieldOption[]; value: unknown; onChange: (v: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const selected = options.find((o) => o.value === value);

  // các nhóm theo thứ tự xuất hiện trong danh sách
  const groups = useMemo(() => [...new Set(options.map((o) => o.group).filter((g): g is string => !!g))], [options]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return options.filter((o) => (!group || o.group === group) && (!s || o.label.toLowerCase().includes(s) || t(o.label).toLowerCase().includes(s) || o.group?.toLowerCase().includes(s)));
  }, [options, q, group, t]);

  // mở hộp thoại thì nhảy tới nhóm của mẫu đang chọn
  const show = () => {
    setGroup(selected?.group ?? "");
    setQ("");
    setOpen(true);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">
          {t(f.label)}
          {f.required && <span className="text-rose-500"> *</span>}
        </span>
        <span className="text-[11px] text-muted-foreground">{t("{n} mẫu", { n: options.length })}</span>
      </div>
      {/* mẫu đang chọn + nút mở hộp chọn */}
      <button type="button" disabled={disabled || !options.length} onClick={show} className="flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition hover:border-foreground/20 disabled:opacity-60">
        <Thumb option={selected} className="h-14 w-8" />
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Mẫu đã chọn")}</span>
          <span className="block truncate text-[14px] font-semibold">
            {selected ? t(selected.label) : t("Chọn mẫu")}
            {selected?.group && <span className="font-normal text-muted-foreground"> · {t(selected.group)}</span>}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-semibold text-primary">
          {t("Đổi mẫu")} <ChevronRight className="size-4" />
        </span>
      </button>
      {f.help && <p className="mt-1 text-[11px] text-muted-foreground">{t(f.help)}</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[min(90dvh,900px)] flex-col gap-0 p-0 sm:max-w-4xl">
          <DialogHeader className="border-b px-5 pt-5 pb-4">
            <DialogTitle className="text-lg">{t("Chọn mẫu dựng video")}</DialogTitle>
            <DialogDescription>{t("Rê chuột vào mẫu để xem video minh hoạ, bấm để chọn.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 border-b px-5 py-4">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Tìm tên mẫu...")} className="h-10 rounded-xl pl-9" />
            </div>
            {groups.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {["", ...groups].map((g) => (
                  <button
                    key={g || "all"}
                    type="button"
                    onClick={() => setGroup(g)}
                    className={cn("h-8 shrink-0 rounded-lg border px-3 text-[12.5px] font-medium transition", group === g ? "border-foreground bg-muted ring-2 ring-foreground/15" : "bg-card text-foreground/80 hover:border-foreground/20")}
                  >
                    {g ? t(g) : t("Tất cả")}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {list.map((o) => (
                <TemplateCard
                  key={o.value}
                  option={o}
                  active={o.value === value}
                  playing={hover === o.value}
                  onHover={setHover}
                  onPick={() => {
                    onChange(o.value);
                    // chạm trên điện thoại: lần chạm đầu phát video xem trước, chọn xong vẫn giữ hộp thoại để xem tiếp
                    setHover(o.value);
                  }}
                />
              ))}
            </div>
            {!list.length && <p className="py-10 text-center text-[13px] text-muted-foreground">{t("Không có mẫu nào khớp")}</p>}
          </div>
          <DialogFooter className="m-0 border-t px-5 py-4">
            <button type="button" onClick={() => setOpen(false)} className="h-11 w-full rounded-xl bg-primary text-[14px] font-semibold text-primary-foreground transition hover:opacity-90">
              {selected ? `${t("Dùng mẫu")} “${t(selected.label)}”` : t("Xong")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
