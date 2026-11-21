"use client";

/**
 * Bảng tìm công cụ nhanh (mở bằng nút "Tạo mới", ô tìm ở topbar hoặc phím ⌘K / Ctrl+K):
 * gõ tên hoặc mô tả (không dấu cũng được), mũi tên lên / xuống để chọn, Enter để mở công cụ.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAiTools, useCategories } from "@/lib/queries";
import { groupsOf, mergeModelGroups, toolLink, toolId, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import type { AiTool } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bỏ dấu tiếng Việt + chữ thường để so khớp ("giong noi" khớp "Giọng nói") */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

export function ToolPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const tools = useAiTools();
  const categories = useCategories();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  // mỗi lần mở: xoá ô tìm, chọn dòng đầu
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const list = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    // tìm trên từng model (tên có cả tên model) rồi mới gộp nhóm model -> chọn đúng model khớp từ khoá
    return mergeModelGroups(
      (tools.data ?? []).filter((x) => {
        const hay = fold(`${groupsOf(x).join(" ")} ${x.name} ${t(x.name)} ${x.description ?? ""} ${x.description ? t(x.description) : ""} ${t(categories.of(x.category).label)}`);
        return words.every((w) => hay.includes(w));
      }),
    );
  }, [tools.data, q, t]);

  const go = (x: AiTool) => {
    onOpenChange(false);
    router.push(toolLink(x));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{t("Tìm công cụ AI")}</DialogTitle>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, list.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && list[idx]) {
                e.preventDefault();
                go(list[idx]);
              }
            }}
            placeholder={t("Bạn muốn tạo gì? Vd: video, giọng nói, ảnh...")}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded-md border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">ESC</kbd>
        </div>
        <div className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
          {list.map((x, i) => {
            const cat = categories.of(x.category);
            return (
              <button
                key={toolId(x)}
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => go(x)}
                className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors", i === idx ? "bg-muted" : "hover:bg-muted/60")}
              >
                <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg", cat.tone)}>
                  <ToolIcon name={x.icon} toolName={`${x.name} ${x.modelLabel ?? ""} ${x.key}`} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{t(x.name)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{x.description ? t(x.description) : null}</span>
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{t(cat.label)}</span>
                {i === idx && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
          {!list.length && <p className="py-10 text-center text-sm text-muted-foreground">{tools.isLoading ? t("Đang tải...") : t("Không tìm thấy công cụ phù hợp")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
