"use client";

/**
 * Chọn chế độ hiển thị của tác vụ AI: Công khai (lên trang cộng đồng, người khác xem / dùng lại thiết kế)
 * hoặc Riêng tư (chỉ chủ tác vụ xem). Nút tròn hình ổ khoá / quả địa cầu, bấm mở bảng chọn 2 lựa chọn.
 * - `VisibilityPicker`: điều khiển thuần (value/onChange) — dùng cạnh nút Tạo, giá trị gửi kèm khi chạy công cụ.
 * - `TaskVisibility`: đổi chế độ của một tác vụ đã tạo (PUT /account/ai/tasks/:id/visibility);
 *   tác vụ bị quản trị viên ẩn khỏi Cộng đồng thì hiện ổ khoá đỏ, không đổi được.
 * Lựa chọn ở form được nhớ trong localStorage để lần sau giữ nguyên.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Globe, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiTask } from "@/lib/types";

const STORAGE_KEY = "ai-visibility";

/** Hai lựa chọn hiển thị (nhãn / mô tả qua t()) */
const OPTIONS = [
  { value: true, icon: Globe, label: "Công khai", desc: "Gửi duyệt lên trang Cộng đồng — quản trị viên kiểm duyệt trước khi hiển thị công khai." },
  { value: false, icon: Lock, label: "Riêng tư", desc: "Chỉ bạn xem và chỉnh sửa." },
] as const;

/** Chế độ hiển thị mặc định cho lần tạo mới, nhớ lựa chọn gần nhất của khách (mặc định riêng tư) */
export function useVisibilityPref() {
  const [isPublic, setIsPublic] = useState(false);
  useEffect(() => {
    try {
      setIsPublic(localStorage.getItem(STORAGE_KEY) === "public");
    } catch {}
  }, []);
  const set = (v: boolean) => {
    setIsPublic(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "public" : "private");
    } catch {}
  };
  return [isPublic, set] as const;
}

export function VisibilityPicker({
  value,
  onChange,
  disabled,
  pending,
  className,
  align = "end",
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Icon = value ? Globe : Lock;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t("Hiển thị")}
          title={value ? t("Công khai") : t("Riêng tư")}
          className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60", value && "text-foreground", className)}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 gap-1 rounded-xl p-1.5">
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Hiển thị")}</div>
        {OPTIONS.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => {
              setOpen(false);
              if (o.value !== value) onChange(o.value);
            }}
            className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted", o.value === value && "bg-muted")}
          >
            <o.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t(o.label)}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{t(o.desc)}</span>
            </span>
            {o.value === value && <Check className="mt-0.5 size-4 shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Đổi chế độ hiển thị của một tác vụ đã tạo, cập nhật cache tác vụ + danh sách */
export function TaskVisibility({ task }: { task: AiTask }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (isPublic: boolean) => api.put<AiTask>(`/account/ai/tasks/${task.id}/visibility`, { isPublic }),
    onSuccess: (x) => {
      qc.setQueryData(["ai", "task", x.id], x);
      qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      toast.success(
        x.isPublic
          ? t("Đã hiển thị trên Cộng đồng")
          : x.communityPending
            ? t("Đã gửi vào mục Chờ kiểm duyệt Cộng đồng")
            : t("Đã chuyển sang Riêng tư"),
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (task.publicBlocked)
    return (
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" title={t("Quản trị viên đã ẩn tác phẩm này khỏi Cộng đồng")}>
        <Lock className="size-3.5" />
      </span>
    );
  const effectivePublic = m.isPending ? !!m.variables : !!task.isPublic || !!task.communityPending;
  return (
    <VisibilityPicker
      value={effectivePublic}
      onChange={(v) => m.mutate(v)}
      disabled={m.isPending}
      pending={m.isPending}
      className={task.communityPending && !task.isPublic ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" : undefined}
    />
  );
}
