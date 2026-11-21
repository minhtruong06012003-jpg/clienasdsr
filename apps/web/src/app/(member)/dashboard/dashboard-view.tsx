"use client";

/**
 * Trang tổng quan của thành viên (bố cục kiểu YupVox):
 * - Trái: "Tính năng dùng nhiều nhất" — lưới thẻ công cụ xếp theo lượt tạo 30 ngày toàn site (GET /public/ai/tools/popular),
 *   công cụ cùng nhóm model gộp thành 1 thẻ và cộng dồn lượt dùng; chưa có lượt dùng thì theo thứ tự admin đặt (nổi bật trước).
 * - Phải: Bảng tin — thông báo admin tự viết kèm ngày giờ (GET /account/announcements), bên dưới là banner giới thiệu bạn bè.
 * - Màn hình nhỏ: ô tìm công cụ + Bảng tin nằm trên cùng, trước "Tính năng dùng nhiều nhất".
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Copy, Download, Flame, Globe, Play, Search, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { ToolPalette } from "@/components/ai/tool-palette";
import { ViewportVideo } from "@/components/ai/viewport-video";
import { ShopCloneHome } from "@/components/themes/shopclone/shopclone-home";
import { useAiTools } from "@/lib/queries";
import { type AiCategoryRaw, groupsOf, mergeModelGroups, promptOf, toolHref, toolId, toolLink, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { useSiteTheme } from "@/lib/site-theme";
import type { AiTool, CommunityTask, Paginated } from "@/lib/types";

/** Số thẻ tính năng hiện mặc định ở trang tổng quan */
const POPULAR_LIMIT = 8;

/** GET /public/ai/tools/popular: lượt tạo 30 ngày của từng công cụ (khoá công khai) */
interface PopularRow {
  key: string;
  uses: number;
}

export function DashboardView({ initialTools, initialCategories }: { initialTools?: AiTool[]; initialCategories?: AiCategoryRaw[] } = {}) {
  const { theme } = useSiteTheme();
  if (theme === "shopclone") {
    return <ShopCloneHome initialTools={initialTools} initialCategories={initialCategories} />;
  }
  return (
    <div className="min-w-0 space-y-6 pt-2">
      <div className="lg:hidden">
        <MobileSearch />
      </div>
      <CommunityShowcase />
      <PopularTools initialTools={initialTools} />
    </div>
  );
}

/** Ô tìm công cụ cho màn hình nhỏ (dưới md topbar chỉ có icon kính lúp): bấm mở bảng tìm công cụ nhanh */
function MobileSearch() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 w-full items-center gap-3 rounded-2xl border bg-card px-4 text-sm text-muted-foreground shadow-xs transition hover:border-foreground/30 hover:text-foreground dark:hover:border-white/15"
      >
        <Search className="size-[18px]" />
        <span className="flex-1 text-left">{t("Tìm công cụ AI...")}</span>
      </button>
      <ToolPalette open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Lưới "Tính năng dùng nhiều nhất" */
function PopularTools({ initialTools }: { initialTools?: AiTool[] }) {
  const { t } = useI18n();
  const tools = useAiTools(initialTools);
  const [showAll, setShowAll] = useState(false);
  const popular = useQuery({ queryKey: ["public", "ai", "popular"], queryFn: () => api.get<PopularRow[]>("/public/ai/tools/popular", undefined, { auth: false }), staleTime: 5 * 60_000, meta: { silentError: true } });

  const allSorted = useMemo(() => {
    const uses = new Map((popular.data ?? []).map((r) => [r.key, r.uses]));
    const raw = tools.data ?? [];
    // lượt dùng của một thẻ: công cụ đứng riêng = của chính nó; thẻ nhóm model = cộng mọi công cụ trong nhóm
    const score = (x: AiTool) => (x.group ? raw.filter((r) => groupsOf(r).includes(x.group!)).reduce((s, r) => s + (uses.get(r.key) ?? 0), 0) : (uses.get(x.key) ?? 0));
    return mergeModelGroups(raw)
      .map((x, i) => ({ tool: x, uses: score(x), i }))
      // nhiều lượt dùng trước; bằng nhau thì công cụ nổi bật trước, rồi theo thứ tự admin đặt
      .sort((a, b) => b.uses - a.uses || Number(b.tool.featured) - Number(a.tool.featured) || a.i - b.i)
      .map((x) => x.tool);
  }, [tools.data, popular.data]);

  const list = showAll ? allSorted : allSorted.slice(0, POPULAR_LIMIT);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="inline-flex items-center gap-2 text-base font-bold">
          <Flame className="size-4 text-orange-500" /> {t("Tính năng dùng nhiều nhất")}
        </h2>
        {allSorted.length > POPULAR_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            {showAll ? t("Thu gọn") : `${t("Xem tất cả")} (${allSorted.length})`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tools.isLoading
          ? Array.from({ length: POPULAR_LIMIT }, (_, i) => <div key={i} className="h-40 animate-pulse rounded-2xl border bg-muted/40" />)
          : list.map((x) => (
              <Link key={toolId(x)} href={toolLink(x)} className="group flex min-h-40 flex-col rounded-2xl border bg-card p-4 shadow-xs transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md dark:hover:border-white/15">
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl border bg-muted/50">
                    <ToolIcon name={x.icon} toolName={`${x.name} ${x.modelLabel ?? ""} ${x.key}`} className="size-5" />
                  </span>
                  {x.maintenance ? (
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">{t("Đang bảo trì")}</span>
                  ) : (
                    x.badge && <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold text-background uppercase">{t(x.badge)}</span>
                  )}
                </div>
                <div className="mt-4 truncate text-sm font-semibold">{t(x.name)}</div>
                {x.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t(x.description)}</p>}
                <ArrowRight className="mt-auto size-4 pt-1 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-foreground" />
              </Link>
            ))}
      </div>
    </section>
  );
}

/**
 * Mục "Cộng đồng" nổi bật đầu trang Tổng quan: lấy các video / tác phẩm công khai mới nhất từ `/public/ai/community`
 * (ưu tiên video), rê chuột phát thử tắt tiếng, bấm mở hộp xem lớn kèm nút "Dùng lại thiết kế" & liên kết sang `/community`.
 */
function CommunityShowcase() {
  const { t } = useI18n();
  const [open, setOpen] = useState<CommunityTask | null>(null);
  const q = useQuery({
    queryKey: ["public", "ai", "community", "dashboard"],
    queryFn: () => api.get<Paginated<CommunityTask>>("/public/ai/community", { limit: 24 }, { auth: false }),
    staleTime: 60_000,
    meta: { silentError: true },
  });

  const list = useMemo(() => {
    const all = q.data?.data ?? [];
    const videos = all.filter((x) => x.output.files?.[0]?.type === "video");
    return (videos.length >= 6 ? videos : all.filter((x) => x.output.files?.length)).slice(0, 12);
  }, [q.data]);

  if (!q.isLoading && !list.length) return null;

  const activePrompt = open ? promptOf(open.input) : "";
  const activeFile = open?.output.files?.[0];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="inline-flex items-center gap-2 text-base font-bold">
          <Globe className="size-4 text-primary" /> {t("Cộng đồng")}
        </h2>
        <Link href="/community" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          {t("Xem tất cả")} <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {q.isLoading
          ? Array.from({ length: 6 }, (_, i) => <div key={i} className="aspect-[3/4] animate-pulse rounded-2xl border bg-muted/40" />)
          : list.map((x) => {
              const f = x.output.files?.[0];
              const prompt = promptOf(x.input);
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setOpen(x)}
                  className="group relative aspect-[3/4] overflow-hidden rounded-2xl border bg-black text-left shadow-xs transition hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-lg"
                >
                  {f?.type === "video" ? (
                    <ViewportVideo
                      src={`${f.url}#t=0.1`}
                      className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
                    />
                  ) : f?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.url} alt={prompt || x.code} loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                  ) : null}
                  {f?.type === "video" && (
                    <span className="pointer-events-none absolute top-2.5 right-2.5 inline-flex size-7 items-center justify-center rounded-full bg-black/65 text-white transition group-hover:scale-110">
                      <Play className="size-3.5 fill-current" />
                    </span>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-10 pb-2.5">
                    {prompt && <p className="line-clamp-1 text-[11px] font-medium text-white/95">{prompt}</p>}
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] text-white/75">
                      <span className="truncate">{x.tool?.name ? t(x.tool.name) : x.toolKey}</span>
                      {x.author && <span className="shrink-0">@{x.author}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
          {open && (
            <div className="grid md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex items-center justify-center bg-black">
                {activeFile?.type === "video" ? (
                  <video src={activeFile.url} controls autoPlay loop playsInline className="block max-h-[70dvh] w-full" />
                ) : activeFile?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={activeFile.url} alt={activePrompt || open.code} className="block max-h-[70dvh] w-full object-contain" />
                ) : null}
              </div>
              <div className="flex flex-col gap-4 p-5">
                <div>
                  <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                    <ToolIcon name={open.tool?.icon} toolName={open.tool?.name ?? open.toolKey} className="size-4" /> {open.tool?.name ? t(open.tool.name) : open.toolKey}
                  </DialogTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {open.author ? `@${open.author} · ` : ""}
                    {new Date(open.createdAt).toLocaleDateString("vi-VN")}
                  </p>
                </div>
                {activePrompt && (
                  <div className="min-h-0">
                    <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                      {t("Mô tả (prompt)")}
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(activePrompt).then(() => toast.success(t("Đã sao chép prompt")), () => undefined)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        <Copy className="size-3" /> {t("Sao chép")}
                      </button>
                    </div>
                    <p className="max-h-56 overflow-y-auto rounded-xl bg-muted/50 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{activePrompt}</p>
                  </div>
                )}
                <div className="mt-auto flex flex-col gap-2">
                  <Link
                    href={`${toolHref(open.toolKey)}?reuse=${encodeURIComponent(open.code)}`}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-semibold text-background transition hover:opacity-90"
                  >
                    <Wand2 className="size-4" /> {t("Dùng lại thiết kế")}
                  </Link>
                  {activeFile && (
                    <a href={activeFile.url} download target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border text-sm font-medium transition hover:bg-muted">
                      <Download className="size-4" /> {t("Tải về")}
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
