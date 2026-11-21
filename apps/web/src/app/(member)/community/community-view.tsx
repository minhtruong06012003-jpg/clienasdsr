"use client";

/**
 * Trang Cộng đồng — thư viện tác phẩm khách chọn hiển thị "Công khai":
 * - lọc theo nhóm (chip), ô tìm theo prompt (debounce), lưới kiểu masonry giữ đúng tỉ lệ ảnh / video, nút "Xem thêm";
 * - bấm một thẻ mở hộp xem lớn: prompt, công cụ, tác giả, nút "Dùng lại thiết kế" (mở công cụ với ?reuse=<mã>
 *   để điền sẵn thiết lập), sao chép prompt, tải về.
 * Xem được khi chưa đăng nhập (khung website công khai); dùng lại thiết kế sẽ yêu cầu đăng nhập.
 */
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Copy, Download, Globe, Loader2, Play, Search, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { ErrorState } from "@/components/common";
import { ViewportVideo } from "@/components/ai/viewport-video";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
import { useAiTools, useCategories } from "@/lib/queries";
import { promptOf, toolHref, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { CommunityTask, Paginated } from "@/lib/types";

const PAGE_SIZE = 24;

export function CommunityView() {
  const { t } = useI18n();
  const params = useSearchParams();
  const tools = useAiTools();
  const categories = useCategories();
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebounced(search.trim(), 400);
  const [open, setOpen] = useState<CommunityTask | null>(null);

  const list = useInfiniteQuery({
    queryKey: ["ai", "community", { category, q }],
    queryFn: ({ pageParam }) => api.get<Paginated<CommunityTask>>("/public/ai/community", { category: category || undefined, q: q || undefined, page: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.meta.total;
  // chỉ hiện nhóm đang có công cụ bật
  const cats = categories.list.filter((c) => !tools.data || tools.data.some((x) => x.category === c.key));

  return (
    <div className="space-y-6 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Globe className="size-6" /> {t("Cộng đồng")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Tác phẩm mọi người chia sẻ công khai — xem và dùng lại thiết kế chỉ với một cú bấm.")}
            {total !== undefined && ` · ${t("{n} tác phẩm", { n: total.toLocaleString("vi-VN") })}`}
          </p>
        </div>
        {/* ô tìm theo prompt */}
        <label className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            placeholder={t("Tìm theo mô tả...")}
            className="h-10 w-full rounded-full border bg-card pr-9 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={t("Xoá")}>
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>

      {/* lọc nhóm */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={!category} onClick={() => setCategory("")}>
          {t("Tất cả")}
        </FilterChip>
        {cats.map((c) => (
          <FilterChip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
            <c.icon className="size-3.5" /> {t(c.label)}
          </FilterChip>
        ))}
      </div>

      {list.isLoading ? (
        <div className="columns-2 gap-4 md:columns-3 xl:columns-4 2xl:columns-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className={cn("mb-4 animate-pulse break-inside-avoid rounded-2xl border bg-muted/40", i % 3 === 0 ? "aspect-[3/4]" : i % 3 === 1 ? "aspect-square" : "aspect-[4/3]")} />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !items.length ? (
        <div className="studio-dots flex flex-col items-center justify-center rounded-3xl border border-dashed px-6 py-20 text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg shadow-black/10">
            <Globe className="size-6" />
          </span>
          <p className="mt-4 font-semibold">{q || category ? t("Không tìm thấy tác phẩm phù hợp") : t("Chưa có tác phẩm công khai nào")}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("Khi tạo, chọn biểu tượng ổ khoá cạnh nút Tạo và chuyển sang Công khai để chia sẻ tác phẩm của bạn tại đây.")}</p>
          <Link href="/dashboard" className="mt-5 inline-flex h-10 items-center rounded-xl bg-foreground px-5 text-sm font-semibold text-background">
            {t("Bắt đầu sáng tạo")}
          </Link>
        </div>
      ) : (
        <>
          <div className="columns-2 gap-4 md:columns-3 xl:columns-4 2xl:columns-5">
            {items.map((x) => (
              <CommunityCard key={x.id} task={x} onOpen={() => setOpen(x)} />
            ))}
          </div>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
                className="inline-flex h-10 items-center gap-2 rounded-full border bg-card px-6 text-sm font-semibold transition hover:bg-muted disabled:opacity-60"
              >
                {list.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
                {t("Xem thêm")}
              </button>
            </div>
          )}
        </>
      )}

      <CommunityDialog task={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition", active ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}

/** Ảnh / video / âm thanh của tác phẩm, giữ tỉ lệ gốc (lưới masonry) hoặc vừa khung (hộp xem lớn) */
function Media({ task, large }: { task: CommunityTask; large?: boolean }) {
  const cat = useCategories().of(task.tool?.category ?? "tools");
  const f = task.output.files?.[0];
  if (f?.type === "image")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={f.url} alt={promptOf(task.input) || task.code} loading="lazy" className={cn("block w-full", large ? "max-h-[70dvh] object-contain" : "h-auto transition duration-500 group-hover:scale-[1.03]")} />;
  if (f?.type === "video")
    return large ? (
      <video src={f.url} controls autoPlay loop playsInline className="block max-h-[70dvh] w-full bg-black" />
    ) : (
      <div className="relative bg-black">
        <ViewportVideo
          src={`${f.url}#t=0.1`}
          className="block h-auto w-full"
          placeholderClassName="aspect-[3/4] w-full bg-zinc-900"
        />
        <span className="pointer-events-none absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/65 text-white">
          <Play className="size-3.5 fill-current" />
        </span>
      </div>
    );
  // âm thanh / văn bản: nền gradient theo nhóm (+ trình phát khi xem lớn)
  return (
    <div className={cn("flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 bg-gradient-to-br p-4 text-white", cat.art)}>
      <ToolIcon name={task.tool?.icon} className="size-8 opacity-90" />
      {large && f?.type === "audio" && <audio src={f.url} controls className="w-full max-w-sm" />}
      {large && !f && task.output.text && <p className="line-clamp-6 text-sm">{task.output.text}</p>}
    </div>
  );
}

/** Thẻ tác phẩm trong lưới: rê chuột hiện prompt + tác giả */
function CommunityCard({ task: x, onOpen }: { task: CommunityTask; onOpen: () => void }) {
  const { t } = useI18n();
  const prompt = promptOf(x.input);
  return (
    <button type="button" onClick={onOpen} className="group relative mb-4 block w-full break-inside-avoid overflow-hidden rounded-2xl border bg-card text-left shadow-xs transition hover:-translate-y-0.5 hover:shadow-lg">
      <Media task={x} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-10 pb-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
        {prompt && <p className="line-clamp-2 text-[11px] leading-snug text-white">{prompt}</p>}
        <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-white/75">
          <span className="truncate">{x.tool?.name ? t(x.tool.name) : x.toolKey}</span>
          {x.author && <span className="shrink-0">@{x.author}</span>}
        </div>
      </div>
    </button>
  );
}

/** Hộp xem lớn một tác phẩm + dùng lại thiết kế */
function CommunityDialog({ task, onClose }: { task: CommunityTask | null; onClose: () => void }) {
  const { t } = useI18n();
  const prompt = task ? promptOf(task.input) : "";
  const f = task?.output.files?.[0];
  return (
    <Dialog open={!!task} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {task && (
          <div className="grid md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex items-center justify-center bg-muted/40">
              <Media task={task} large />
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div>
                <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                  <ToolIcon name={task.tool?.icon} toolName={task.tool?.name ?? task.toolKey} className="size-4" /> {task.tool?.name ? t(task.tool.name) : task.toolKey}
                </DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {task.author ? `@${task.author} · ` : ""}
                  {new Date(task.createdAt).toLocaleDateString("vi-VN")}
                </p>
              </div>
              {prompt && (
                <div className="min-h-0">
                  <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                    {t("Mô tả (prompt)")}
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(prompt).then(() => toast.success(t("Đã sao chép prompt")), () => undefined)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      <Copy className="size-3" /> {t("Sao chép")}
                    </button>
                  </div>
                  <p className="max-h-56 overflow-y-auto rounded-xl bg-muted/50 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{prompt}</p>
                </div>
              )}
              <div className="mt-auto flex flex-col gap-2">
                <Link
                  href={`${toolHref(task.toolKey)}?reuse=${encodeURIComponent(task.code)}`}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-semibold text-background transition hover:opacity-90"
                >
                  <Wand2 className="size-4" /> {t("Dùng lại thiết kế")}
                </Link>
                {f && (
                  <a href={f.url} download target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border text-sm font-medium transition hover:bg-muted">
                    <Download className="size-4" /> {t("Tải về")}
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
