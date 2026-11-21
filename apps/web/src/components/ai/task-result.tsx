"use client";

/**
 * Kết quả một tác vụ AI hiển thị dạng "khung xem" (canvas nền chấm):
 * - thanh trên: trạng thái, mã tác vụ, chi phí (VND); nút "Dùng lại thiết lập", tải về, mở tab mới;
 * - đang chạy: chỉ hiện thanh trạng thái + đồng hồ đếm thời gian (tiến độ xem ở dải "Gần đây"), không vẽ khung xem;
 * - lỗi: thông báo kèm số tiền đã hoàn vào số dư + nút thử lại (Muse hỏi lại thì có ô trả lời); xong: ảnh / video / âm thanh / văn bản.
 * `useTask` hỏi lại trạng thái mỗi 3 giây cho tới khi tác vụ kết thúc, rồi làm mới số dư ví.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, Download, ExternalLink, Loader2, MessageCircleQuestion, Pencil, RotateCcw, Send, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/components/common";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { downloadTasksIndividually } from "@/lib/bulk-download";
import { isRunning, TASK_STATUS, ToolIcon } from "@/lib/ai";
import { useCategories } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiOutputFile, AiTask } from "@/lib/types";
import { TaskVisibility } from "@/components/ai/visibility";

/** Tác vụ theo id / mã, tự hỏi lại khi đang chạy */
export function useTask(id: string | null | undefined, initial?: AiTask) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ai", "task", id],
    queryFn: () => api.get<AiTask>(`/account/ai/tasks/${encodeURIComponent(id!)}`),
    enabled: !!id,
    initialData: initial && initial.id === id ? initial : undefined,
    refetchInterval: (query) => (query.state.data && isRunning(query.state.data.status) ? 3000 : false),
  });
  const status = q.data?.status;
  // tác vụ vừa kết thúc -> làm mới số dư (hoàn tiền nếu lỗi) và lịch sử
  useEffect(() => {
    if (status && !isRunning(status)) {
      qc.invalidateQueries({ queryKey: ["credits"] });
      qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      qc.invalidateQueries({ queryKey: ["ai", "stats"] });
    }
  }, [status, qc]);
  return q;
}

/** Tên file tải về: ưu tiên tên khách tự đặt `customName`, mặc định `<mã tác vụ>-<số thứ tự>.<đuôi>` */
function fileName(task: AiTask, f: AiOutputFile, i: number, total = 1) {
  const ext = f.url.split("?")[0].split(".").pop()?.slice(0, 5) || (f.type === "video" ? "mp4" : f.type === "audio" ? "mp3" : "png");
  if (task.customName) {
    return `${task.customName}${total > 1 ? `-${i + 1}` : ""}.${ext}`;
  }
  return `${task.code}-${i + 1}.${ext}`;
}

/** Số giây -> "1:05" */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Thời gian đã chạy của tác vụ, cập nhật mỗi giây khi còn đang chạy */
function useElapsed(task: AiTask) {
  const running = isRunning(task.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const end = running ? now : task.completedAt ? new Date(task.completedAt).getTime() : now;
  return Math.max(0, (end - new Date(task.createdAt).getTime()) / 1000);
}

export function TaskResult({ task, onRetry, onReuse, onReplied }: { task: AiTask; onRetry?: () => void; onReuse?: () => void; onReplied?: (next: AiTask) => void }) {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const st = TASK_STATUS[task.status];
  // chỉ hiển thị file có link hợp lệ (tác vụ cũ có thể lưu link rác, vd. từng ký tự của một URL)
  const files = (task.output?.files ?? []).filter((f) => typeof f?.url === "string" && /^(https?:\/\/|data:|\/[^/])/i.test(f.url));
  const running = isRunning(task.status);
  const elapsed = useElapsed(task);
  const single = task.status === "SUCCEEDED" && files.length === 1 ? files[0] : null;
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(task.customName ?? "");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setRenaming(false);
    setNameDraft(task.customName ?? "");
  }, [task.id, task.customName]);

  const renameMut = useMutation({
    mutationFn: (name: string) => api.put<AiTask>(`/account/ai/tasks/${encodeURIComponent(task.id)}/rename`, { name }),
    onSuccess: (updated) => {
      toast.success(updated.customName ? t("Đã lưu tên file: {name}", { name: updated.customName }) : t("Đã đặt lại tên file mặc định"));
      setRenaming(false);
      qc.setQueryData(["ai", "task", task.id], updated);
      void qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex h-full flex-col">
      {/* thanh trạng thái + thao tác */}
      <div className="flex flex-wrap items-center gap-2 pb-3 text-xs">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold tabular-nums", st.className)}>
          {running && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
          {t(st.label)}
          {running
            ? (() => {
                if (task.status === "PENDING") return "";
                const raw = Math.max(0, Math.min(97, Math.round(task.progress || 0)));
                const outKind = task.tool?.output;
                const est = outKind === "audio" || outKind === "text" ? 25 : outKind === "image" ? 42 : /motion|kling|seedance|veo|wan|sora/i.test(`${task.toolKey} ${task.tool?.name ?? ""}`) ? 145 : 90;
                const startMs = new Date(task.startedAt || task.createdAt).getTime();
                const runSec = Math.max(1, (Date.now() - startMs) / 1000);
                const curve = Math.min(95, Math.max(4, Math.round(95 * (1 - Math.exp(-runSec / est)))));
                return ` · ${Math.min(97, Math.max(raw, curve))}%`;
              })()
            : ""}
        </span>
        <span className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <button
            type="button"
            onClick={() => void copyText(task.code, t("Đã sao chép mã đơn"))}
            title={t("Bấm để sao chép mã đơn")}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-medium text-foreground transition hover:bg-foreground/10"
          >
            <span>{t("Mã đơn")}:</span>
            <span className="font-mono font-semibold">{task.code}</span>
            <Copy className="size-3 text-muted-foreground" />
          </button>
          <span>
            · {fmt.money(task.credits)} · {mmss(elapsed)}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* đổi Công khai / Riêng tư cho tác vụ này */}
          <TaskVisibility task={task} />
          {onReuse && (
            <button type="button" onClick={onReuse} className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-2.5 font-medium transition hover:bg-muted" title={t("Điền lại thiết lập của lần tạo này vào form")}>
              <SlidersHorizontal className="size-3.5" /> <span className="hidden sm:inline">{t("Dùng lại thiết lập")}</span>
            </button>
          )}
          {task.status === "SUCCEEDED" && files.length > 0 && (
            renaming ? (
              <form
                className="inline-flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  renameMut.mutate(nameDraft.trim());
                }}
              >
                <input
                  autoFocus
                  value={nameDraft}
                  maxLength={80}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder={t("Nhập tên file...")}
                  className="h-8 w-36 rounded-lg border bg-background px-2.5 text-xs outline-none focus:border-foreground/40 sm:w-44"
                />
                <button
                  type="submit"
                  disabled={renameMut.isPending}
                  className="inline-flex size-8 items-center justify-center rounded-lg bg-foreground text-background transition hover:opacity-90"
                  title={t("Lưu tên")}
                >
                  {renameMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(false);
                    setNameDraft(task.customName ?? "");
                  }}
                  className="inline-flex size-8 items-center justify-center rounded-lg border bg-card transition hover:bg-muted"
                  title={t("Huỷ")}
                >
                  <X className="size-3.5" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-2.5 font-medium transition hover:bg-muted"
                title={t("Đổi tên file khi tải về")}
              >
                <Pencil className="size-3.5" />
                <span className="max-w-28 truncate">{task.customName || t("Đổi tên")}</span>
              </button>
            )
          )}
          {single && (
            <>
              <a href={single.url} target="_blank" rel="noreferrer" className="inline-flex size-8 items-center justify-center rounded-lg border bg-card transition hover:bg-muted" title={t("Mở trong tab mới")}>
                <ExternalLink className="size-3.5" />
              </a>
              <button
                type="button"
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void downloadTasksIndividually([task.id])
                    .catch((err) => toast.error(errorMessage(err)))
                    .finally(() => setDownloading(false));
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 font-semibold text-background transition hover:opacity-90 disabled:opacity-60"
              >
                {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {t("Tải về")}
              </button>
            </>
          )}
        </div>
      </div>

      {/* khung xem: bỏ hẳn khi tác vụ đang chạy (khung chờ dư thừa, đã có thẻ "Đang xử lý" ở dải Gần đây) */}
      {!running && (
      <div className="studio-dots flex min-h-[360px] flex-1 items-center justify-center rounded-2xl border p-4 sm:p-6">
        {(task.status === "FAILED" || task.status === "CANCELLED") && (
          <div className="w-full max-w-md rounded-2xl border border-red-200 bg-card p-5 text-center shadow-sm dark:border-red-500/30">
            <span className="mx-auto inline-flex size-11 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">
              <AlertCircle className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold">{task.status === "CANCELLED" ? t("Tác vụ đã bị huỷ") : t("Tạo không thành công")}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{task.error || t("Tác vụ không thành công")}</p>
            {task.refunded && <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">{t("{n} đã được hoàn lại vào số dư.", { n: fmt.money(task.credits) })}</p>}
            {task.museReply && <MuseReply task={task} onReplied={onReplied} />}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-4 inline-flex h-9.5 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-5 text-xs font-bold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
              >
                <RotateCcw className="size-3.5" /> {t("Tạo lại")}
              </button>
            )}
          </div>
        )}

        {task.status === "SUCCEEDED" && (
          <div className="w-full space-y-4">
            {task.output?.text && <div className="mx-auto max-w-2xl rounded-2xl border bg-card p-5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm">{task.output.text}</div>}
            {files.length > 0 && (
              <div className={cn("grid gap-4", files.length > 1 && files.every((f) => f.type === "image") ? "grid-cols-2" : "grid-cols-1")}>
                {files.map((f, i) => (
                  <div key={f.url} className="group relative flex justify-center">
                    {f.type === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.url} alt={task.code} className="max-h-[64vh] w-auto max-w-full rounded-xl object-contain shadow-xl ring-1 ring-black/5" />
                    ) : f.type === "video" ? (
                      <video src={f.url} controls playsInline className="max-h-[64vh] w-full max-w-full rounded-xl bg-black shadow-xl" />
                    ) : (
                      <AudioCard task={task} url={f.url} />
                    )}
                    {/* nhiều file: nút tải riêng từng file khi rê chuột */}
                    {files.length > 1 && (
                      <a
                        href={f.url}
                        download={fileName(task, f, i, files.length)}
                        className="absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-lg bg-black/60 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
                        title={t("Tải về")}
                      >
                        <Download className="size-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** Dòng lựa chọn Muse đưa ra, vd "A — 10 giây, 16:9" / "B) 12–15 giây" */
const OPTION_LINE = /^\s*\**([A-H])\**\s*[—–\-.:)]\s*(.+)$/;

/**
 * Muse không làm video mà hỏi lại: hiện câu hỏi, các lựa chọn A / B... (bấm để điền) và ô trả lời.
 * Gửi trả lời tạo tác vụ mới (tính tiền như một video, lỗi thì hoàn), mỗi tác vụ chỉ trả lời được 1 lần.
 */
function MuseReply({ task, onReplied }: { task: AiTask; onReplied?: (next: AiTask) => void }) {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const q = task.museReply!;
  const options = q.question.split("\n").map((l) => l.match(OPTION_LINE)).filter((m): m is RegExpMatchArray => !!m);
  const send = useMutation({
    mutationFn: () => api.post<AiTask>(`/account/ai/tasks/${task.id}/reply`, { message: message.trim() }),
    onSuccess: (next) => {
      qc.invalidateQueries({ queryKey: ["ai", "task", task.id] });
      qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      qc.invalidateQueries({ queryKey: ["credits"] });
      if (onReplied) onReplied(next);
      else router.push(`/history/${next.code}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="mt-4 text-left">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"><MessageCircleQuestion className="size-3.5" /> {t("Muse hỏi lại")}</p>
      <div className="max-h-56 overflow-y-auto rounded-xl bg-muted/50 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{q.question}</div>
      {q.replied ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {q.replyTask ? (
            <>
              {t("Bạn đã trả lời câu hỏi này.")}{" "}
              <Link href={`/history/${q.replyTask}`} className="font-semibold text-foreground underline">{t("Xem đơn {code}", { code: q.replyTask })}</Link>
            </>
          ) : (
            t("Câu trả lời đang được gửi...")
          )}
        </p>
      ) : (
        <>
          {options.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {options.map((m) => (
                <button
                  key={m[1]}
                  type="button"
                  onClick={() => setMessage(m[0].trim())}
                  className={cn("rounded-lg border px-3 py-2 text-left text-xs transition hover:bg-muted", message === m[0].trim() && "border-foreground bg-muted")}
                >
                  <span className="font-bold">{m[1]}</span> · <span className="line-clamp-2">{m[2]}</span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={20000}
            rows={3}
            placeholder={options.length ? t("Chọn một lựa chọn ở trên hoặc tự nhập câu trả lời") : t("Nhập câu trả lời cho Muse")}
            className="mt-3 rounded-xl text-[13px]"
          />
          <button
            type="button"
            disabled={!message.trim() || send.isPending}
            onClick={() => send.mutate()}
            className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-foreground px-4 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("Trả lời để Muse làm tiếp")}
          </button>
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">{t("Tính phí như một video mới ({n}), lỗi thì được hoàn lại. Chỉ trả lời được 1 lần.", { n: fmt.money(task.credits) })}</p>
        </>
      )}
    </div>
  );
}

/** Trình phát âm thanh trên thẻ gradient */
function AudioCard({ task, url }: { task: AiTask; url: string }) {
  const cat = useCategories().of(task.tool?.category ?? "voice");
  return (
    <div className="w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-xl">
      <div className={cn("flex h-28 items-center justify-center bg-gradient-to-br text-white", cat.art)}>
        <ToolIcon name={task.tool?.icon} className="size-10 opacity-90" />
      </div>
      <div className="p-4">
        <audio src={url} controls className="w-full" />
      </div>
    </div>
  );
}
