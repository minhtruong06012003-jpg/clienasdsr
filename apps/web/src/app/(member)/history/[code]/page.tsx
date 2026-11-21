"use client";

/**
 * Chi tiết một tác vụ AI theo mã (T...) hoặc id:
 * - trái: khung xem kết quả (TaskResult);
 * - phải: prompt đã nhập (sao chép được), các thiết lập khác hiển thị bằng nhãn của form công cụ
 *   (vd "Độ phân giải: 1K" thay vì "option: |1K"), thông tin mã / chi phí (VND) / thời gian.
 */
import Link from "next/link";
import { use } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Loader2, RotateCcw, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { ErrorState, LoadingBlock } from "@/components/common";
import { TaskResult, useTask } from "@/components/ai/task-result";
import { fieldOptions } from "@/components/ai/tool-form";
import { api, errorMessage } from "@/lib/api";
import { useAiTools, useCategories } from "@/lib/queries";
import { isRunning, promptOf, toolHref, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import type { AiTask } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function TaskDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { t, fmt } = useI18n();
  const task = useTask(code);
  const tools = useAiTools();
  const categories = useCategories();

  const rerun = useMutation({
    mutationFn: async (src: AiTask) =>
      api.post<AiTask>(`/account/ai/tools/${encodeURIComponent(src.toolKey)}/run`, {
        input: src.input ?? {},
        isPublic: !!src.isPublic,
      }),
    onSuccess: (created) => {
      toast.success(
        created.credits > 0
          ? t("Đã tạo lại đơn #{code} ({c})", { code: created.code, c: fmt.money(created.credits) })
          : t("Đã tạo lại đơn #{code}", { code: created.code }),
      );
      void qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["credits"] });
      void qc.invalidateQueries({ queryKey: ["ai", "stats"] });
      router.push(`/history/${created.code}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (task.isLoading) return <LoadingBlock className="py-24" />;
  if (task.error || !task.data) return <ErrorState error={task.error} onRetry={() => task.refetch()} />;
  const x = task.data;
  const tool = tools.data?.find((d) => d.key === x.toolKey);
  const cat = categories.of(x.tool?.category ?? tool?.category ?? "tools");
  const prompt = promptOf(x.input);

  // thiết lập khác (bỏ prompt, URL file): dùng nhãn ô + nhãn lựa chọn của form nếu còn công cụ
  const settings = Object.entries(x.input ?? {})
    .filter(([k, v]) => k !== "prompt" && k !== "text" && v !== "" && v !== null && typeof v !== "object" && !String(v).startsWith("http"))
    .map(([k, v]) => {
      const f = tool?.fields.find((d) => d.name === k);
      const opt = f?.type === "select" ? fieldOptions(f, x.input).find((o) => o.value === v) : undefined;
      const value = typeof v === "boolean" ? (v ? t("Có") : t("Không")) : opt ? t(opt.label) : String(v);
      return { key: k, label: f ? t(f.label) : k, value };
    });

  const copy = () =>
    navigator.clipboard
      .writeText(prompt)
      .then(() => toast.success(t("Đã sao chép prompt")))
      .catch(() => toast.error(t("Không sao chép được")));

  return (
    <div className="space-y-5 pt-2">
      <Link href="/history" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> {t("Lịch sử tạo")}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg", cat.art)}>
            <ToolIcon name={x.tool?.icon} className="size-6" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">{x.tool?.name ? t(x.tool.name) : x.toolKey}</h1>
            <p className="text-xs text-muted-foreground">{new Date(x.createdAt).toLocaleString("vi-VN")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isRunning(x.status) && (
            <button
              type="button"
              disabled={rerun.isPending}
              onClick={() => rerun.mutate(x)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
            >
              {rerun.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              {rerun.isPending ? t("Đang tạo lại...") : t("Tạo lại")}
            </button>
          )}
          <Link href={toolHref(x.toolKey)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-md shadow-black/10">
            <Wand2 className="size-4" /> {t("Tạo tiếp")}
          </Link>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex min-h-[480px] flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-5">
          <TaskResult task={x} onRetry={!rerun.isPending ? () => rerun.mutate(x) : undefined} />
        </section>

        <aside className="space-y-4">
          {prompt && (
            <section className="rounded-3xl border bg-card p-5 shadow-xs">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">{x.input?.text !== undefined ? t("Văn bản") : "Prompt"}</h2>
                <button type="button" onClick={copy} className="inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition hover:bg-muted">
                  <Copy className="size-3" /> {t("Sao chép")}
                </button>
              </div>
              <p className="max-h-64 overflow-y-auto rounded-xl bg-muted/50 p-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{prompt}</p>
            </section>
          )}
          <section className="rounded-3xl border bg-card p-5 shadow-xs">
            <h2 className="mb-3 text-sm font-semibold">{t("Thông tin")}</h2>
            <dl className="divide-y text-[13px]">
              {settings.map((s) => (
                <Row key={s.key} label={s.label} value={s.value} />
              ))}
              <Row label={t("Mã tác vụ")} value={`#${x.code}`} />
              <Row label={t("Chi phí")} value={fmt.money(x.credits)} />
              {x.completedAt && <Row label={t("Hoàn tất lúc")} value={new Date(x.completedAt).toLocaleString("vi-VN")} />}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium break-words">{value}</dd>
    </div>
  );
}
