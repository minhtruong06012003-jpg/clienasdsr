"use client";

/** Các mảnh giao diện dùng chung: tiêu đề trang, trạng thái rỗng/lỗi, phân trang, nút sao chép, badge trạng thái */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, isNotFound } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import { tNow } from "@/lib/i18n/translate";

/**
 * Thẻ tiêu đề ở đầu mỗi trang thành viên (theo mẫu zsmm): thẻ trắng viền nhạt, icon navy + tiêu đề + mô tả bên trái,
 * nút hành động bên phải; `children` (bộ lọc, tab...) nằm bên dưới, ngăn bằng đường kẻ.
 */
export function PageHeader({ title, description, actions, icon, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-5 overflow-hidden rounded-2xl border bg-card p-4 shadow-xs sm:mb-6 sm:p-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight sm:text-xl">
            {icon && <span className="inline-flex shrink-0 text-primary [&_svg]:size-5">{icon}</span>}
            {title}
          </h2>
          {description && <p className="mt-1 text-xs leading-relaxed text-subtle-foreground">{description}</p>}
        </div>
        {/* mobile: các nút chia đều chiều ngang; desktop: shrink-0 giữ trọn vẹn nút bên trong thẻ không bị tràn */}
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 *:flex-1 sm:justify-end sm:*:flex-none">{actions}</div>}
      </div>
      {children && <div className="mt-4 border-t pt-4">{children}</div>}
    </section>
  );
}

/** Trạng thái không có dữ liệu */
export function EmptyState({ title, description, icon, action, className }: { title?: string; description?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  const t = useT();
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-9 text-center sm:py-12", className)}>
      <span className="mb-1 inline-flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">{icon ?? <Inbox className="size-6" />}</span>
      <p className="font-medium">{title ?? t("Chưa có dữ liệu")}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

/**
 * Hiện lỗi tải dữ liệu. 404 (chức năng chưa sẵn sàng / đã tắt) hiển thị nhẹ nhàng như trạng thái rỗng.
 */
export function ErrorState({ error, onRetry, className, notFoundText }: { error: unknown; onRetry?: () => void; className?: string; notFoundText?: string }) {
  const t = useT();
  if (isNotFound(error)) {
    return <EmptyState className={className} title={t("Chức năng đang được cập nhật")} description={notFoundText ?? t("Dữ liệu chưa sẵn sàng, vui lòng quay lại sau.")} />;
  }
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </span>
      <p className="font-medium">{t("Không tải được dữ liệu")}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("Thử lại")}
        </Button>
      )}
    </div>
  );
}

/** Vòng xoay tải dữ liệu */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} />;
}

export function LoadingBlock({ className, text }: { className?: string; text?: string }) {
  const t = useT();
  return (
    <div className={cn("flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground", className)}>
      <Spinner /> {text ?? t("Đang tải...")}
    </div>
  );
}

/** Phân trang đơn giản: Trước / Trang x/y / Sau */
export function Pager({ page, totalPages, total, onChange }: { page: number; totalPages: number; total?: number; onChange: (p: number) => void }) {
  const t = useT();
  if (totalPages <= 1) return total !== undefined ? <p className="px-1 pt-3 text-xs text-muted-foreground">{t("Tổng {n} mục", { n: total })}</p> : null;
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <p className="text-xs text-muted-foreground">{total !== undefined ? `${t("Tổng {n} mục", { n: total })} · ` : ""}
        {t("Trang {page}/{total}", { page, total: totalPages })}</p>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft /> {t("Trước")}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          {t("Sau")} <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/** Sao chép chuỗi vào clipboard, có phản hồi ngắn */
export async function copyText(text: string, label = tNow("Đã sao chép")) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
    return true;
  } catch {
    toast.error(tNow("Trình duyệt không cho phép sao chép, hãy chép thủ công"));
    return false;
  }
}

export function CopyButton({ value, label, className, size = "icon-sm" }: { value: string; label?: string; className?: string; size?: "icon-sm" | "icon-xs" | "icon" }) {
  const [done, setDone] = useState(false);
  const t = useT();
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className={className}
      aria-label={label ?? t("Sao chép")}
      onClick={async () => {
        if (await copyText(value, label ? t("Đã sao chép {label}", { label: label.toLowerCase() }) : undefined)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check className="text-emerald-500" /> : <Copy />}
    </Button>
  );
}

/** Badge trạng thái theo bảng nhãn/màu (nhãn tiếng Việt trong bảng được dịch tại đây) */
export function StatusBadge({ status, map }: { status: string; map: Record<string, { label: string; className: string }> }) {
  const t = useT();
  const s = map[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap", s.className)}>{t(s.label)}</span>;
}
