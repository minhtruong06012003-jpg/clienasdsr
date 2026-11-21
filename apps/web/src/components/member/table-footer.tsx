"use client";

/**
 * Chân bảng kiểu zsmm: bên trái "Hiển thị [50] bản ghi mỗi trang", bên phải phân trang nút vuông nhỏ
 * (trang hiện tại nền primary, có dấu … khi nhiều trang). Dùng chung cho các bảng danh sách khu thành viên.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

/** Các lựa chọn số bản ghi mỗi trang (API cho tối đa 200) */
export const PAGE_SIZES = [20, 50, 100];

/** Danh sách số trang cần hiện: luôn có trang đầu/cuối, quanh trang hiện tại ±1, chỗ bị lược là "…" */
function pageItems(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const set = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("…");
    out.push(p);
  });
  return out;
}

export function TableFooterBar({
  page,
  totalPages,
  total,
  limit,
  onPage,
  onLimit,
}: {
  page: number;
  totalPages: number;
  total?: number;
  limit?: number;
  onPage: (p: number) => void;
  /** bỏ trống thì không hiện ô chọn số bản ghi */
  onLimit?: (n: number) => void;
}) {
  const t = useT();
  const pages = Math.max(1, totalPages);
  // nút vuông nhỏ dùng cho phân trang
  const sq = "inline-flex size-7 items-center justify-center rounded-lg border text-xs font-semibold tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {onLimit && limit ? (
          <>
            {t("Hiển thị")}
            <Select value={String(limit)} onValueChange={(v) => onLimit(Number(v))}>
              <SelectTrigger className="h-8! w-18 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {t("bản ghi mỗi trang")}
          </>
        ) : null}
        {total !== undefined && <span className={cn(onLimit && "max-sm:hidden", "ml-1")}>· {t("Tổng {n}", { n: total })}</span>}
      </div>
      <div className="flex items-center gap-1 self-end sm:self-auto">
        <button type="button" className={cn(sq, "bg-card hover:bg-muted")} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t("Trang trước")}>
          <ChevronLeft className="size-3.5" />
        </button>
        {pageItems(page, pages).map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={cn(sq, p === page ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
            >
              {p}
            </button>
          ),
        )}
        <button type="button" className={cn(sq, "bg-card hover:bg-muted")} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t("Trang sau")}>
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Tab lọc chữ nhỏ có badge đếm: tab đang chọn nền primary-soft chữ primary, badge nền primary chữ trắng */
export function FilterTab({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
        active ? "bg-primary-soft font-semibold text-primary" : "text-foreground/80 hover:bg-muted",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-md px-1 text-[10px] font-semibold tabular-nums", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
          {count}
        </span>
      )}
    </button>
  );
}
