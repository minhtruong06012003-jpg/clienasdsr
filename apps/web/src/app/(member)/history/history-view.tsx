"use client";

/**
 * Lịch sử đơn hàng / tác vụ AI dạng bảng ngang hiện đại giống Yupvox (`T-170`, `T-171`):
 * - Cột `Thời gian` (kèm ô tích chọn hàng loạt, nhãn chuyên mục, trạng thái & % xử lý trực tiếp)
 * - Cột `Công cụ / Model` (ảnh/video thu nhỏ xem trước + tên công cụ + mã đơn 1 chạm sao chép)
 * - Cột `Nội dung / Tác vụ` (mô tả prompt hoặc thông báo lỗi)
 * - Cột `Hỗ trợ` (nút phao cứu sinh mở nhanh Ticket hỗ trợ gắn sẵn mã đơn)
 * - Cột `Phí trừ` (số tiền đã dùng / đã hoàn)
 * - Cột `Thao tác` (3 nút tròn gọn đẹp: Xem kết quả, Tải về, Menu thêm Tạo lại / Xoá)
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  Check,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Hash,
  Images,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { copyText, ErrorState, Pager } from "@/components/common";
import { TaskThumb } from "@/components/ai/thumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { downloadTasksAsZip, downloadTasksIndividually, hasDownloadableFiles } from "@/lib/bulk-download";
import { useAiTools, useBootstrap, useCategories } from "@/lib/queries";
import { isRunning, promptOf, TASK_STATUS } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiTask, AiTaskStatus, Paginated } from "@/lib/types";

const STATUS_FILTERS: { value: "" | AiTaskStatus; label: string }[] = [
  { value: "", label: "Tất cả" },
  { value: "PROCESSING", label: "Đang xử lý" },
  { value: "SUCCEEDED", label: "Hoàn thành" },
  { value: "FAILED", label: "Đã hoàn tiền" },
];

export function HistoryView() {
  const { t, fmt } = useI18n();
  const params = useSearchParams();
  const tool = params.get("tool") ?? undefined;
  const tools = useAiTools();
  const categories = useCategories();
  const retentionDays = useBootstrap().data?.settings?.ai?.taskRetentionDays ?? 0;
  const toolName = tool ? tools.data?.find((x) => x.key === tool)?.name ?? tool : null;

  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ["ai", "tasks", { tool, category, status, page }],
    queryFn: () =>
      api.get<Paginated<AiTask>>("/account/ai/tasks", {
        tool,
        category: category || undefined,
        status: status || undefined,
        page,
        limit: 24,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.data.some((x) => isRunning(x.status)) ? 4000 : false),
  });

  const filteredRows = useMemo(() => {
    const raw = q.data?.data ?? [];
    const kw = search.trim().toLowerCase();
    if (!kw) return raw;
    return raw.filter((x) => {
      const hay = `${x.code} ${x.customName ?? ""} ${x.tool?.name ?? ""} ${x.toolKey} ${promptOf(x.input) ?? ""}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [q.data?.data, search]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewTask, setPreviewTask] = useState<AiTask | null>(null);
  const [renameTarget, setRenameTarget] = useState<AiTask | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const qc = useQueryClient();

  const openRename = (tk: AiTask) => {
    setRenameTarget(tk);
    setRenameDraft(tk.customName ?? "");
  };

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.put<AiTask>(`/account/ai/tasks/${encodeURIComponent(id)}/rename`, { name }),
    onSuccess: (updated) => {
      toast.success(updated.customName ? t("Đã lưu tên file: {name}", { name: updated.customName }) : t("Đã đặt lại tên file mặc định"));
      setRenameTarget(null);
      qc.setQueryData(["ai", "task", updated.id], updated);
      void qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  useEffect(() => setSelected(new Set()), [tool, category, status, page]);

  const selectable = filteredRows.filter((x) => !isRunning(x.status));
  const selectedTasks = selectable.filter((x) => selected.has(x.id));
  const downloadableOnPage = filteredRows.filter(hasDownloadableFiles);
  const selectedDownloadable = downloadableOnPage.filter((x) => selected.has(x.id));
  const allSelected = selectable.length > 0 && selectable.every((x) => selected.has(x.id));

  const [dlMode, setDlMode] = useState<null | "files" | "zip">(null);
  const [dlProgress, setDlProgress] = useState<{ cur: number; total: number } | null>(null);
  const [rerunProgress, setRerunProgress] = useState<{ cur: number; total: number } | null>(null);

  const rerun = useMutation({
    mutationFn: async (list: AiTask[]) => {
      const done: AiTask[] = [];
      for (let i = 0; i < list.length; i++) {
        const x = list[i];
        setRerunProgress({ cur: i + 1, total: list.length });
        try {
          done.push(
            await api.post<AiTask>(`/account/ai/tools/${encodeURIComponent(x.toolKey)}/run`, {
              input: x.input ?? {},
              isPublic: !!x.isPublic,
            }),
          );
        } catch (err) {
          if (!done.length) throw err;
          toast.error(
            t("Đã tạo lại {n}/{total} đơn, dừng do lỗi: {e}", {
              n: done.length,
              total: list.length,
              e: errorMessage(err),
            }),
          );
          break;
        }
      }
      return done;
    },
    onSuccess: (created) => {
      if (!created.length) return;
      const spent = created.reduce((sum, x) => sum + (x.credits || 0), 0);
      toast.success(
        created.length > 1
          ? spent > 0
            ? t("Đã tạo lại {n} đơn, đã trừ {c}", { n: created.length, c: fmt.money(spent) })
            : t("Đã tạo lại {n} đơn", { n: created.length })
          : spent > 0
            ? t("Đã tạo lại đơn mới, đã trừ {c}", { c: fmt.money(spent) })
            : t("Đã tạo lại đơn mới"),
      );
      setSelected(new Set());
      if (status && status !== "PROCESSING") setStatus("");
      setPage(1);
      void qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["credits"] });
      void qc.invalidateQueries({ queryKey: ["ai", "stats"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => setRerunProgress(null),
  });

  const runBulkZip = async (ids: string[]) => {
    if (!ids.length || dlMode) return;
    setDlMode("zip");
    try {
      const res = await downloadTasksAsZip(ids);
      toast.success(t("Đang tải file nén .ZIP ({n} file)", { n: res.fileCount }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDlMode(null);
    }
  };

  const runBulkFiles = async (ids: string[]) => {
    if (!ids.length || dlMode) return;
    setDlMode("files");
    setDlProgress({ cur: 0, total: ids.length });
    try {
      const res = await downloadTasksIndividually(ids, {
        onProgress: (cur, total) => setDlProgress({ cur, total }),
      });
      toast.success(
        res.fileCount > 1
          ? t("Đã bắt đầu tải {n} file về máy (nếu trình duyệt hỏi quyền tải nhiều file, hãy bấm Cho phép)", {
              n: res.fileCount,
            })
          : t("Đang tải file về máy"),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDlMode(null);
      setDlProgress(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = useMutation({
    mutationFn: (ids: string[]) => api.post<{ deleted: number; skipped: number }>("/account/ai/tasks/delete", { ids }),
    onSuccess: (r) => {
      toast.success(
        r.skipped
          ? t("Đã xoá {n} tác phẩm, bỏ qua {m} tác phẩm đang xử lý", { n: r.deleted, m: r.skipped })
          : t("Đã xoá {n} tác phẩm", { n: r.deleted }),
      );
      setSelected(new Set());
      setConfirmOpen(false);
      if (q.data && r.deleted >= q.data.data.length && page > 1) setPage(page - 1);
      void qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["ai", "stats"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const cats = categories.list.filter((c) => !tools.data || tools.data.some((x) => x.category === c.key));

  return (
    <div className="space-y-5 pt-2">
      {/* Tiêu đề + tổng số tác vụ + ô tìm kiếm nhanh chuẩn phong cách Yupvox */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-bold tracking-tight text-[#09090b] sm:text-2xl dark:text-white">{t("Lịch sử hoạt động")}</h1>
          {q.data && (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 tabular-nums dark:bg-white/[0.07] dark:text-zinc-300">
              {t("{n} tác vụ", { n: q.data.meta.total.toLocaleString("vi-VN") })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-10 min-w-[250px] items-center rounded-full border bg-card px-3.5 shadow-2xs transition focus-within:border-foreground/40 sm:w-72">
            <Search className="mr-2 size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Tìm theo tác vụ, mã đơn, nội dung...")}
              className="w-full bg-transparent text-[13px] font-normal outline-none placeholder:text-slate-400"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="inline-flex rounded-full border bg-card p-1 text-xs font-semibold shadow-2xs">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => (setStatus(s.value), setPage(1))}
                className={cn(
                  "rounded-full px-3 py-1.5 transition",
                  status === s.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(s.label)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Lưu ý thời hạn lưu trữ */}
      {retentionDays > 0 && (
        <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-4 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
          <Clock className="size-3.5 shrink-0" />
          <span className="truncate">
            {retentionDays === 1
              ? t("Hệ thống sẽ xoá file tự động sau 24h, vui lòng tải file về trước khi bị xoá.")
              : t("Hệ thống sẽ xoá file tự động sau {n} ngày, vui lòng tải file về trước khi bị xoá.", {
                  n: retentionDays,
                })}
          </span>
        </div>
      )}

      {/* Lọc chuyên mục + nút tải hàng loạt */}
      <div className="flex flex-wrap items-center gap-1.5">
        {toolName && (
          <Link
            href="/history"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-foreground/30 bg-muted px-3 text-xs font-semibold text-foreground"
          >
            {toolName} <X className="size-3.5" />
          </Link>
        )}
        <FilterChip active={!category} onClick={() => (setCategory(""), setPage(1))}>
          {t("Mọi nhóm")}
        </FilterChip>
        {cats.map((c) => (
          <FilterChip key={c.key} active={category === c.key} onClick={() => (setCategory(c.key), setPage(1))}>
            <c.icon className="size-3.5" /> {t(c.label)}
          </FilterChip>
        ))}
      </div>

      {/* Thanh thao tác khi đã tích chọn */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-2xl border bg-card/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur">
          <span className="font-bold">{t("Đã chọn {n}", { n: selected.size })}</span>
          {!allSelected && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set(selectable.map((x) => x.id)))}
            >
              {t("Chọn tất cả trang này")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelected(new Set())}
            className="rounded-full text-xs font-semibold"
          >
            <X className="size-3.5" /> {t("Bỏ chọn tất cả")}
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!selectedTasks.length || rerun.isPending || !!dlMode}
              onClick={() => rerun.mutate(selectedTasks)}
              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
            >
              {rerun.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              {rerun.isPending && rerunProgress
                ? t("Đang tạo {cur}/{total}...", { cur: rerunProgress.cur, total: rerunProgress.total })
                : t("Tạo lại ({n})", { n: selectedTasks.length })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!selectedDownloadable.length || !!dlMode || rerun.isPending}
              onClick={() => void runBulkFiles(selectedDownloadable.map((x) => x.id))}
            >
              {dlMode === "files" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {dlMode === "files" && dlProgress
                ? t("Đang tải {cur}/{total}...", { cur: dlProgress.cur, total: dlProgress.total })
                : t("Tải từng file ({n})", { n: selectedDownloadable.length })}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={!selectedDownloadable.length || !!dlMode}
              onClick={() => void runBulkZip(selectedDownloadable.map((x) => x.id))}
            >
              {dlMode === "zip" ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
              {dlMode === "zip" ? t("Đang nén...") : t("Tải nén .ZIP ({n})", { n: selectedDownloadable.length })}
            </Button>
            <Button variant="outline" size="sm" disabled={!!dlMode} onClick={() => setSelected(new Set())}>
              {t("Huỷ")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!!dlMode}
              onClick={() => (setConfirmIds([...selected]), setConfirmOpen(true))}
            >
              <Trash2 className="size-3.5" /> {t("Xoá")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(v) => !remove.isPending && setConfirmOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Xoá {n} tác phẩm?", { n: confirmIds.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Tác phẩm và file kết quả sẽ bị xoá vĩnh viễn, không khôi phục được. Số tiền đã dùng không được hoàn lại.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t("Huỷ")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(confirmIds);
              }}
            >
              {remove.isPending ? t("Đang xoá...") : t("Xoá")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* BẢNG NGANG HIỂN THỊ ĐƠN HÀNG AI GIỐNG YUPVOX */}
      {q.isLoading ? (
        <div className="space-y-3 rounded-2xl border bg-card p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-18 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !filteredRows.length ? (
        <div className="studio-dots flex flex-col items-center justify-center rounded-3xl border border-dashed px-6 py-20 text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg shadow-black/10">
            <Images className="size-6" />
          </span>
          <p className="mt-4 font-semibold">{search ? t("Không tìm thấy tác vụ phù hợp") : t("Chưa có tác phẩm nào")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("Chọn một công cụ ở menu bên trái để bắt đầu tạo.")}</p>
          <Link
            href="/dashboard"
            className="mt-5 inline-flex h-10 items-center rounded-full bg-foreground px-5 text-sm font-semibold text-background"
          >
            {t("Bắt đầu sáng tạo")}
          </Link>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "overflow-hidden rounded-2xl border bg-card shadow-2xs transition-opacity",
              q.isPlaceholderData && "opacity-60",
            )}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b bg-slate-50/70 text-[12.5px] font-medium whitespace-nowrap text-slate-500 dark:bg-white/[0.02] dark:text-zinc-400">
                  <tr>
                    <th className="w-[185px] min-w-[175px] py-3.5 pr-3 pl-5">
                      <div className="flex items-center gap-2.5">
                        {selectable.length > 0 && (
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={allSelected}
                            onClick={() =>
                              setSelected(allSelected ? new Set() : new Set(selectable.map((x) => x.id)))
                            }
                            className={cn(
                              "inline-flex size-4.5 shrink-0 items-center justify-center rounded border transition",
                              allSelected
                                ? "border-foreground bg-foreground text-background"
                                : "border-slate-300 bg-background hover:border-foreground dark:border-zinc-600",
                            )}
                          >
                            {allSelected && <Check className="size-3" strokeWidth={3} />}
                          </button>
                        )}
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="size-3.5" /> {t("Thời gian")}
                        </span>
                      </div>
                    </th>
                    <th className="w-[270px] min-w-[250px] px-3 py-3.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Sparkles className="size-3.5" /> {t("Công cụ / Model")}
                      </span>
                    </th>
                    <th className="min-w-[190px] px-3 py-3.5">
                      <span className="inline-flex items-center gap-1.5">
                        <AlertCircle className="size-3.5" /> {t("Ghi chú lỗi")}
                      </span>
                    </th>
                    <th className="w-[82px] min-w-[78px] px-2 py-3.5 text-center">
                      <span className="inline-flex items-center justify-center gap-1">
                        <MessageSquareText className="size-3.5" /> {t("Hỗ trợ")}
                      </span>
                    </th>
                    <th className="w-[115px] min-w-[105px] px-3 py-3.5 text-right">{t("Chi phí")}</th>
                    <th className="w-[110px] min-w-[105px] py-3.5 pr-5 pl-3 text-right">{t("Thao tác")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredRows.map((x) => (
                    <HistoryRow
                      key={x.id}
                      task={x}
                      selected={selected.has(x.id)}
                      rerunning={rerun.isPending}
                      onToggle={() => toggle(x.id)}
                      onPreview={() => setPreviewTask(x)}
                      onRename={() => openRename(x)}
                      onRerun={() => rerun.mutate([x])}
                      onDelete={() => {
                        setConfirmIds([x.id]);
                        setConfirmOpen(true);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {q.data && (
            <Pager page={page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onChange={setPage} />
          )}

          <TaskPreviewDialog
            task={previewTask ? (filteredRows.find((r) => r.id === previewTask.id) ?? previewTask) : null}
            onClose={() => setPreviewTask(null)}
            onRename={(tk) => openRename(tk)}
            rerunning={rerun.isPending}
            onRerun={(tk) => {
              setPreviewTask(null);
              rerun.mutate([tk]);
            }}
          />

          <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
            <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md rounded-2xl p-5">
              <DialogHeader>
                <DialogTitle className="text-base font-bold">{t("Đổi tên file tải về")}</DialogTitle>
              </DialogHeader>
              {renameTarget && (
                <form
                  className="mt-1 space-y-3.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    renameMut.mutate({ id: renameTarget.id, name: renameDraft.trim() });
                  }}
                >
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                      {t("Tên video / ảnh khi lưu về máy (không cần gõ đuôi .mp4, .png)")}
                    </label>
                    <input
                      autoFocus
                      value={renameDraft}
                      maxLength={80}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      placeholder={t("Ví dụ: Cảnh 01 mở đầu, Quảng cáo mỹ phẩm...")}
                      className="h-10 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10"
                    />
                    <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                      {t("Tên file khi tải:")}{" "}
                      <span className="font-mono font-semibold text-foreground">
                        {(renameDraft.trim().replace(/[\\/:*?"<>|]+/g, " ").trim() || renameTarget.code) +
                          "." +
                          (renameTarget.output?.files?.[0]?.type === "video" || renameTarget.tool?.output === "video"
                            ? "mp4"
                            : renameTarget.output?.files?.[0]?.type === "audio" || renameTarget.tool?.output === "audio"
                              ? "mp3"
                              : "png")}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    {renameTarget.customName && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={renameMut.isPending}
                        onClick={() => renameMut.mutate({ id: renameTarget.id, name: "" })}
                        className="mr-auto text-xs text-muted-foreground"
                      >
                        {t("Về mặc định")}
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
                      {t("Huỷ")}
                    </Button>
                    <Button type="submit" size="sm" disabled={renameMut.isPending}>
                      {renameMut.isPending && <Loader2 className="size-3.5 animate-spin" />}
                      {t("Lưu tên")}
                    </Button>
                  </div>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition",
        active
          ? "border-foreground bg-foreground text-background"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Một dòng ngang trong bảng lịch sử tác vụ giống Yupvox */
function HistoryRow({
  task: x,
  selected,
  rerunning,
  onToggle,
  onPreview,
  onRename,
  onRerun,
  onDelete,
}: {
  task: AiTask;
  selected: boolean;
  rerunning: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onRename: () => void;
  onRerun: () => void;
  onDelete: () => void;
}) {
  const { t, fmt } = useI18n();
  const router = useRouter();
  const st = TASK_STATUS[x.status];
  const running = isRunning(x.status);
  const canSelect = !running;
  const canDownload = hasDownloadableFiles(x);
  const prompt = promptOf(x.input);
  const pct = running ? (x.progress > 0 ? Math.min(99, Math.round(x.progress)) : x.status === "PROCESSING" ? 5 : 1) : 0;

  const [downloading, setDownloading] = useState(false);

  const createdStr = useMemo(() => {
    const d = new Date(x.createdAt);
    const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    return `${time} ${date}`;
  }, [x.createdAt]);

  return (
    <tr className={cn("group transition-colors hover:bg-muted/30", selected && "bg-muted/45")}>
      {/* 1. Thời gian + Nhãn chuyên mục + Trạng thái */}
      <td className="py-4 pr-3 pl-5 align-middle">
        <div className="flex items-start gap-2.5">
          {canSelect ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              onClick={onToggle}
              className={cn(
                "mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded border transition",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-slate-300 bg-background hover:border-foreground dark:border-zinc-600",
              )}
            >
              {selected && <Check className="size-3" strokeWidth={3} />}
            </button>
          ) : (
            <span className="mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center">
              <Loader2 className="size-3.5 animate-spin text-sky-600" />
            </span>
          )}

          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tabular-nums",
                  x.status === "SUCCEEDED"
                    ? "border-emerald-200/70 bg-emerald-50/60 text-[#1f7a5c] dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300/90"
                    : running
                      ? "border-sky-200/70 bg-sky-50/60 text-sky-700/90 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300/90"
                      : x.status === "FAILED" || x.refunded
                        ? "border-amber-200/70 bg-amber-50/60 text-[#9a5b13] dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90"
                        : "border-slate-200/80 bg-slate-100/70 text-slate-600 dark:border-white/10 dark:bg-zinc-500/15 dark:text-zinc-300",
                )}
              >
                {x.refunded && x.status !== "SUCCEEDED" ? t("Đã hoàn tiền") : t(st.label)}
                {running ? ` ${pct}%` : ""}
              </span>
            </div>
            <div className="flex items-center gap-1 text-[12px] font-normal text-slate-400 tabular-nums dark:text-zinc-400">
              <Clock className="size-3 shrink-0" />
              <span>{createdStr}</span>
            </div>
          </div>
        </div>
      </td>

      {/* 2. Công cụ / Model + Ảnh thu nhỏ (bấm hiện popup xem nhanh — T-191) + Mã đơn */}
      <td className="px-3 py-4 align-middle">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPreview}
            title={t("Xem nhanh kết quả")}
            className="relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-xl border bg-muted shadow-2xs transition hover:scale-[1.03] hover:ring-2 hover:ring-foreground/25"
          >
            <TaskThumb task={x} className="size-full! aspect-square!" />
          </button>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onPreview}
              className="block max-w-full truncate text-left text-[13.5px] font-semibold text-[#09090b] hover:underline dark:text-white"
            >
              {x.tool?.name ? t(x.tool.name) : x.toolKey}
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void copyText(x.code, t("Đã sao chép mã đơn hàng"))}
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 dark:bg-white/[0.06] dark:text-zinc-400 dark:hover:text-white"
                title={t("Sao chép mã đơn hàng")}
              >
                <span>{t("Mã đơn hàng")}:</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-zinc-200">{x.code}</span>
                <Copy className="size-2.5" />
              </button>
              {x.customName && (
                <button
                  type="button"
                  onClick={onRename}
                  title={t("Bấm để sửa tên file tải về")}
                  className="inline-flex max-w-48 items-center gap-1 truncate rounded-md border border-sky-200/80 bg-sky-50/70 px-2 py-0.5 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100/80 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300"
                >
                  <Pencil className="size-2.5 shrink-0" />
                  <span className="truncate">{x.customName}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </td>

      {/* 3. Ghi chú lỗi (T-214 & T-233: ô nền đỏ phấn dịu mắt, không chói, giúp dễ nhận diện đơn lỗi) */}
      <td className="px-3 py-4 align-middle">
        {x.error ? (
          <button
            type="button"
            onClick={onPreview}
            className="block max-w-xl rounded-xl border border-rose-200/70 bg-rose-50/60 px-3 py-2 text-left transition-colors hover:border-rose-300/80 hover:bg-rose-50/90 dark:border-rose-500/20 dark:bg-rose-500/[0.08] dark:hover:bg-rose-500/[0.13]"
          >
            <p className="line-clamp-2 text-[12.5px] font-normal leading-relaxed text-[#a64450] dark:text-rose-300/90">
              {x.error}
            </p>
          </button>
        ) : running ? (
          <div className="max-w-[200px]">
            <div className="text-[11.5px] font-medium text-sky-700/85 tabular-nums dark:text-sky-400">
              {t("Đang xử lý")} {pct}%
            </div>
            <div className="mt-1.5 h-1.5 w-36 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-500/80 transition-all duration-500"
                style={{ width: `${Math.max(pct, 6)}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-xs text-slate-300 dark:text-zinc-600">—</span>
        )}
      </td>

      {/* 4. Nút Hỗ trợ mở nhanh Ticket kèm mã đơn (T-218: đổi sang icon tin nhắn / ticket phù hợp) */}
      <td className="px-2 py-4 text-center align-middle">
        <Link
          href={`/support?new=1&orderCode=${encodeURIComponent(x.code)}`}
          title={t("Gửi ticket hỗ trợ cho đơn #{code}", { code: x.code })}
          className="inline-flex size-8.5 items-center justify-center rounded-full bg-slate-100/80 text-slate-500 transition hover:bg-slate-200/80 hover:text-slate-900 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
        >
          <MessageSquareText className="size-4" />
        </Link>
      </td>

      {/* 5. Chi phí: tông đỏ trầm / xanh trầm dịu mắt chuẩn fintech (T-219, T-220 & T-229) */}
      <td className="px-3 py-4 text-right align-middle">
        <div
          className={cn(
            "text-[13.5px] font-medium tabular-nums",
            Number(x.credits) <= 0
              ? "text-slate-500 dark:text-zinc-400"
              : x.refunded
                ? "text-[#1f7a5c] dark:text-emerald-400/90"
                : "text-[#b04652] dark:text-rose-400/90",
          )}
        >
          {Number(x.credits) <= 0
            ? fmt.money(0)
            : x.refunded
              ? `+${fmt.money(x.credits)}`
              : `−${fmt.money(x.credits)}`}
        </div>
      </td>

      {/* 6. Cụm nút tròn Thao tác (đã bỏ nút mắt xem trùng lặp theo T-207; làm dịu màu nút tải — T-229) */}
      <td className="py-4 pr-5 pl-3 text-right align-middle">
        <div className="inline-flex items-center justify-end gap-1.5">
          <button
            type="button"
            title={canDownload ? t("Tải về máy (có thể tải lại nhiều lần)") : t("Chưa có file kết quả để tải về")}
            onClick={() => {
              if (downloading) return;
              if (!canDownload) {
                toast.info(t("Đơn này không có file kết quả để tải về"));
                return;
              }
              setDownloading(true);
              void downloadTasksIndividually([x.id])
                .catch((err) => toast.error(errorMessage(err)))
                .finally(() => setDownloading(false));
            }}
            className="inline-flex size-8.5 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 hover:text-slate-950 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
          >
            {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex size-8.5 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 hover:text-slate-950 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.12]"
                aria-label={t("Thêm thao tác")}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 rounded-xl p-1">
              <DropdownMenuItem
                onSelect={() => onRename()}
                className="cursor-pointer gap-2 rounded-lg text-xs font-semibold"
              >
                <Pencil className="size-3.5 text-sky-600" /> {x.customName ? t("Sửa tên file tải về") : t("Đổi tên file tải về")}
              </DropdownMenuItem>
              {canSelect && (
                <DropdownMenuItem
                  disabled={rerunning}
                  onSelect={() => onRerun()}
                  className="cursor-pointer gap-2 rounded-lg text-xs font-semibold"
                >
                  <RotateCcw className="size-3.5 text-emerald-600" /> {t("Tạo lại đơn này")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => void copyText(x.code, t("Đã sao chép mã đơn"))}
                className="cursor-pointer gap-2 rounded-lg text-xs font-medium"
              >
                <Copy className="size-3.5" /> {t("Sao chép mã đơn")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => router.push(`/support?new=1&orderCode=${encodeURIComponent(x.code)}`)}
                className="cursor-pointer gap-2 rounded-lg text-xs font-medium"
              >
                <MessageSquareText className="size-3.5" /> {t("Báo lỗi / Hỗ trợ")}
              </DropdownMenuItem>
              {canSelect && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDelete()}
                    className="cursor-pointer gap-2 rounded-lg text-xs font-semibold"
                  >
                    <Trash2 className="size-3.5" /> {t("Xoá tác phẩm")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}

/** Popup xem nhanh ảnh / video kết quả ngay trên trang Lịch sử (T-191) */
function TaskPreviewDialog({
  task,
  onClose,
  onRename,
  rerunning,
  onRerun,
}: {
  task: AiTask | null;
  onClose: () => void;
  onRename: (t: AiTask) => void;
  rerunning: boolean;
  onRerun: (t: AiTask) => void;
}) {
  const { t, fmt } = useI18n();
  const [activeIdx, setActiveIdx] = useState(0);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setActiveIdx(0);
  }, [task?.id]);

  if (!task) return null;
  const files = task.output?.files ?? [];
  const curFile = files[activeIdx] ?? files[0];
  const prompt = promptOf(task.input);
  const canDownload = hasDownloadableFiles(task);
  const running = isRunning(task.status);

  return (
    <Dialog open={!!task} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-1.25rem)] max-w-[calc(100vw-1.25rem)] gap-0 overflow-hidden rounded-3xl p-0 sm:w-full sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4 text-left sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <div>
              <DialogTitle className="text-base font-bold">
                {task.tool?.name ? t(task.tool.name) : task.toolKey}
              </DialogTitle>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => void copyText(task.code, t("Đã sao chép mã đơn"))}
                  className="inline-flex items-center gap-1 font-mono font-semibold hover:text-foreground"
                >
                  #{task.code} <Copy className="size-3" />
                </button>
                <span>·</span>
                <span className="font-semibold tabular-nums">{fmt.money(task.credits)}</span>
                <span>·</span>
                <span>{new Date(task.createdAt).toLocaleString("vi-VN")}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 p-5 sm:p-6">
          {/* Khu vực hiển thị media chính hoặc thông báo trạng thái nền sáng rõ ràng dễ đọc (T-224) */}
          {curFile?.url ? (
            <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-2xl border bg-slate-950/95 p-2">
              {curFile.type === "video" ? (
                <video
                  key={curFile.url}
                  src={curFile.url}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[62vh] w-full rounded-xl object-contain"
                />
              ) : curFile.type === "audio" ? (
                <div className="w-full max-w-md p-6">
                  <audio key={curFile.url} src={curFile.url} controls autoPlay className="w-full" />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={curFile.url}
                  alt={task.code}
                  className="max-h-[62vh] w-auto rounded-xl object-contain"
                />
              )}
            </div>
          ) : running ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-2xl border border-sky-500/20 bg-sky-50/70 px-5 py-10 text-center dark:border-sky-500/25 dark:bg-sky-950/25">
              <Loader2 className="size-8 animate-spin text-sky-600 dark:text-sky-400" />
              <span className="text-sm font-semibold text-slate-900 dark:text-white">
                {t("Đang xử lý")} {task.progress > 0 ? `${Math.min(99, Math.round(task.progress))}%` : ""}
              </span>
            </div>
          ) : (
            <div className="flex min-h-[170px] flex-col items-center justify-center gap-2 rounded-2xl border border-amber-500/25 bg-amber-50/75 px-6 py-9 text-center dark:border-amber-500/30 dark:bg-amber-950/25">
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
                <AlertCircle className="size-5" />
              </span>
              <p className="max-w-lg text-sm font-medium leading-relaxed text-slate-800 dark:text-zinc-100">
                {task.error || t("Tác vụ chưa có file kết quả hiển thị.")}
              </p>
              {task.refunded && Number(task.credits) > 0 && (
                <span className="mt-1 inline-flex items-center rounded-full bg-emerald-500/15 px-3 py-0.5 text-xs font-semibold text-emerald-700 tabular-nums dark:text-emerald-300">
                  +{fmt.money(task.credits)} {t("đã tự động hoàn vào ví")}
                </span>
              )}
            </div>
          )}

          {/* Nếu đơn có nhiều ảnh/video thì cho chọn từng tấm ngay dưới */}
          {files.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {files.map((f, idx) => (
                <button
                  key={f.url + idx}
                  type="button"
                  onClick={() => setActiveIdx(idx)}
                  className={cn(
                    "size-14 shrink-0 overflow-hidden rounded-xl border-2 transition",
                    idx === activeIdx ? "border-foreground ring-2 ring-foreground/20" : "border-transparent opacity-65 hover:opacity-100",
                  )}
                >
                  {f.type === "video" ? (
                    <video src={`${f.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.url} alt="" className="size-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Prompt đã nhập */}
          {prompt && (
            <div className="rounded-2xl border bg-muted/35 p-3.5 text-xs leading-relaxed">
              <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-muted-foreground uppercase">
                <span>Prompt</span>
                <button
                  type="button"
                  onClick={() => void copyText(prompt, t("Đã sao chép prompt"))}
                  className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
                >
                  <Copy className="size-3" /> {t("Sao chép")}
                </button>
              </div>
              <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-foreground">{prompt}</p>
            </div>
          )}

          {/* Thanh nút hành động dưới đáy popup */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Link
              href={`/history/${task.code}`}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline"
            >
              {t("Mở trang chi tiết đầy đủ →")}
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRename(task)}
                className="rounded-full text-xs font-semibold"
              >
                <Pencil className="size-3.5" /> {task.customName ? t("Sửa tên") : t("Đổi tên")}
              </Button>
              {!running && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rerunning}
                  onClick={() => onRerun(task)}
                  className="rounded-full border-emerald-500/40 bg-emerald-500/10 text-xs font-bold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                >
                  <RotateCcw className="size-3.5" /> {t("Tạo lại")}
                </Button>
              )}
              {canDownload && (
                <Button
                  size="sm"
                  disabled={downloading}
                  onClick={() => {
                    setDownloading(true);
                    void downloadTasksIndividually([task.id])
                      .catch((err) => toast.error(errorMessage(err)))
                      .finally(() => setDownloading(false));
                  }}
                  className="rounded-full text-xs font-bold"
                >
                  {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {t("Tải về máy")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
