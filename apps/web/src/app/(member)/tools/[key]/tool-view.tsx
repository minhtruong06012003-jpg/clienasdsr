"use client";

/**
 * Trang chạy một công cụ AI (bố cục studio 2 cột):
 * - Trên: đường dẫn (Tổng quan › nhóm), icon + tên + mô tả công cụ, cách tính giá, liên kết lịch sử của công cụ.
 * - Trái (dính khi cuộn): bảng "Thiết lập" gồm form động (ToolForm) và chân bảng cố định có báo giá (VND)
 *   (hỏi API mỗi khi form đổi, có debounce) + nút chọn Công khai / Riêng tư + nút "Tạo" (trừ tiền vào số dư ví và tạo tác vụ).
 * - Phải: khung xem kết quả tác vụ đang chọn (tự cập nhật khi đang xử lý) + dải "Gần đây" của công cụ này.
 * Mở từ ô prompt ở Tổng quan (?prompt=...) thì điền sẵn prompt vào ô nhập chính.
 * Mở từ trang Cộng đồng (?reuse=<mã tác phẩm công khai>) thì điền sẵn thiết lập của tác phẩm đó (trừ ô tải file).
 * Công cụ tạo ảnh / video có ô prompt: thêm thanh chuyển "Tạo ảnh (Tạo video) / Tạo hàng loạt" (?tab=batch) — chế độ hàng loạt
 * ẩn ô prompt ở bảng Thiết lập (prompt lấy từ danh sách), thêm BatchSettings (nguồn ảnh của video, số luồng, đánh số, tên dự án),
 * khung phải là BatchPanel, nút chân bảng chạy cả lô.
 * Ô prompt ở chế độ thường là PromptList: nhập tới 8 mô tả (hoặc bật "Mỗi dòng 1 mục"), mỗi mô tả gửi thành một tác vụ riêng;
 * mô tả đầu tiên luôn nằm trong `values[prompt]` (để điền sẵn / dùng lại vẫn hoạt động), các mô tả thêm giữ ở `extraPrompts`.
 * Công cụ có `pairs` (vd Motion Control): các ô file của cặp hiện thành danh sách cặp ô vuông (PairList), mỗi cặp đủ file × mỗi mô tả
 * là một tác vụ; có `copies` thì thêm ô "Số lượng nhân bản" (nhân tiếp số tác vụ).
 * Công cụ có `samples` thì hiện khung "Ví dụ đầu ra" (ToolSamples) dưới khung kết quả.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Coins, Columns2, Film, History, Image as ImageIcon, Layers, Loader2, LogIn, Maximize2, Minimize2, Minus, Plus, Rows2, Search, Settings2, Sparkles, Volume2, VolumeX, Wallet, Wand2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { ErrorState, LoadingBlock } from "@/components/common";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HorizontalComposer } from "@/components/ai/horizontal-composer";
import { PromptList, ToolForm, initialValues, promptItems, type FormValues } from "@/components/ai/tool-form";
import { TaskResult, useTask } from "@/components/ai/task-result";
import { TaskThumb } from "@/components/ai/thumb";
import { BatchPanel, BatchSettings, useBatch } from "@/components/ai/batch-runner";
import { PairList, pairReady, type PairRow } from "@/components/ai/pair-list";
import { VisibilityPicker, useVisibilityPref } from "@/components/ai/visibility";
import { ToolSamples } from "@/components/ai/samples";
import { TikTokToolWorkspace } from "@/components/ai/tiktok-downloader-modal";
import { BulkDownloadWorkspace } from "@/components/ai/bulk-download-workspace";
import { ImageMetadataWorkspace } from "@/components/ai/image-metadata-workspace";
import { VideoStitchWorkspace } from "@/components/ai/video-stitch-workspace";
import { VoiceCloneWorkspace } from "@/components/ai/voice-clone-workspace";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDebounced } from "@/hooks/use-debounced";
import { useAiTools, useCategories, useCredits } from "@/lib/queries";
import { groupsOf, isRunning, modelLogoOf, priceRank, pricingText, promptFieldOf, TASK_STATUS, toolHref, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { canOpenAdmin } from "@/lib/site";
import { cn } from "@/lib/utils";
import type { AiTask, AiTool, CommunityTask, Paginated } from "@/lib/types";

export function ToolView({ toolKey }: { toolKey: string }) {
  const tools = useAiTools();
  const { t } = useI18n();
  const params = useSearchParams();
  // công cụ gốc đã tách theo model (link cũ, lịch sử, Cộng đồng) -> mở model con đầu tiên của nó
  const found = tools.data?.find((x) => x.key === toolKey) ?? tools.data?.find((x) => x.key.startsWith(`${toolKey}~`));
  // model ở nhiều nhóm: nhóm đang xem lấy từ ?g= (link từ menu), không có / sai thì nhóm đầu tiên
  // useMemo: giữ nguyên object khi render lại (các effect / callback bên dưới phụ thuộc `tool`)
  const g = params.get("g");
  const tool = useMemo(() => {
    if (!found) return undefined;
    const groups = groupsOf(found);
    return { ...found, group: g && groups.includes(g) ? g : (groups[0] ?? null) };
  }, [found, g]);
  if (tools.isLoading) return <LoadingBlock className="py-24" />;
  if (tools.error) return <ErrorState error={tools.error} onRetry={() => tools.refetch()} />;
  if (!tool)
    return (
      <div className="py-24 text-center">
        <p className="text-sm text-muted-foreground">{t("Công cụ không tồn tại hoặc đang tạm dừng.")}</p>
        <Link href="/dashboard" className="mt-3 inline-block text-sm font-semibold underline underline-offset-4">
          {t("Về trang tổng quan")}
        </Link>
      </div>
    );
  // nhóm model: các công cụ cùng nhóm (theo thứ tự admin xếp) để khách chọn model ngay trên trang
  const models = tool.group ? (tools.data ?? []).filter((x) => groupsOf(x).includes(tool.group!)) : [];
  // key = tool để form đặt lại khi chuyển công cụ
  return <ToolRunner key={tool.key} tool={tool} models={models} />;
}

/**
 * Giữ bảng "Thiết lập" (dính khi cuộn) luôn nằm gọn trong màn hình từ màn lg trở lên: chiều cao tối đa
 * = chiều cao cửa sổ − vị trí mép trên hiện tại của bảng − lề dưới. Nhờ vậy chân bảng (chi phí + nút Tạo)
 * không bị cắt trên laptop màn thấp, và bảng tự cao thêm khi khách cuộn trang (phần đầu trang cuộn khỏi màn hình).
 */
function useFitViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // màn nhỏ hơn lg: bố cục xếp chồng, bảng cao tự nhiên
        if (!mq.matches) return void el.style.removeProperty("max-height");
        // 80px = lg:top-20 (vị trí dính), 16px = lề dưới; tối thiểu 360px để form vẫn dùng được
        const top = Math.max(el.getBoundingClientRect().top, 80);
        el.style.maxHeight = `${Math.max(360, window.innerHeight - top - 16)}px`;
      });
    };
    fit();
    window.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    mq.addEventListener("change", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      mq.removeEventListener("change", fit);
    };
  }, []);
  return ref;
}

/**
 * Chọn model trong nhóm model:
 * - Trên PC (`lg+`, bố cục 2 cột): chỉ hiện 1 thẻ model gọn gàng kèm mũi tên `›`, bấm vào bung bảng nổi sang BÊN PHẢI (`side="right"`) kiểu Higgsfield.
 * - Trên điện thoại (`< lg`): giữ nguyên giao diện thu gọn / mở dọc ngay trong cột như cũ để không tràn mép phải hay bật bàn phím ảo.
 */
function ModelPicker({ tool, models, prompt, tab, disabled }: { tool: AiTool; models: AiTool[]; prompt?: string; tab?: string; disabled?: boolean }) {
  const { t, fmt } = useI18n();
  const { status } = useAuth();
  const authed = status === "authenticated";
  const router = useRouter();
  const collapsible = models.length > 2;
  const [mobileOpen, setMobileOpen] = useState(!collapsible);
  const [pcOpen, setPcOpen] = useState(false);
  const [search, setSearch] = useState("");
  const go = (m: AiTool) => {
    setPcOpen(false);
    if (m.key === tool.key) return;
    const trimmed = prompt?.trim() ?? "";
    let urlPrompt: string | undefined = trimmed || undefined;
    if (trimmed.length > 800) {
      try {
        sessionStorage.setItem("novai-switch-prompt", trimmed);
        urlPrompt = undefined;
      } catch {
        urlPrompt = trimmed.slice(0, 800);
      }
    }
    router.replace(
      toolHref(m.key, {
        g: groupsOf(m).length > 1 ? (tool.group ?? undefined) : undefined,
        tab,
        prompt: urlPrompt,
      }),
      { scroll: false },
    );
  };
  const prices = useQueries({
    queries: models.map((m) => ({
      queryKey: ["ai", "quote", m.key, "default", authed ? "auth" : "guest"],
      queryFn: async () =>
        (
          await api.post<{ credits: number }>(
            authed ? `/account/ai/tools/${encodeURIComponent(m.key)}/quote` : `/public/ai/tools/${encodeURIComponent(m.key)}/quote`,
            { input: initialValues(m.fields) },
          )
        ).credits,
      staleTime: 5 * 60_000,
      retry: false,
      meta: { silentError: true },
    })),
  });
  const rankOf = (m: AiTool, i: number) => (typeof m.price === "number" ? m.price : (prices[i]?.data ?? priceRank(m)));
  const sorted = models.map((m, i) => ({ m, price: prices[i]?.data ?? m.price ?? undefined, rank: rankOf(m, i) })).sort((a, b) => a.rank - b.rank);
  const current = sorted.find((x) => x.m.key === tool.key) ?? sorted[0];
  const kw = search.trim().toLowerCase();
  const filtered = kw
    ? sorted.filter(({ m }) => {
        const label = t(m.modelLabel || m.name).toLowerCase();
        const raw = (m.modelLabel || m.name).toLowerCase();
        return label.includes(kw) || raw.includes(kw) || (m.badge?.toLowerCase().includes(kw) ?? false);
      })
    : sorted;
  const curLogo = current ? modelLogoOf(current.m.modelLabel || current.m.name) : null;

  return (
    <div className="mb-4">
      {/* ---------- ĐIỆN THOẠI (< lg): giữ nguyên kiểu thu gọn / xổ dọc như cũ ---------- */}
      <div className="lg:hidden">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold">{t("Model AI")}</span>
          {collapsible && (
            <button
              type="button"
              onClick={() => setMobileOpen((o) => !o)}
              aria-expanded={mobileOpen}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition",
                mobileOpen ? "border border-primary/40 text-primary hover:bg-primary/10" : "bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/25 hover:bg-primary/90",
              )}
            >
              {mobileOpen ? t("Thu gọn") : t("Đổi model ({n})", { n: models.length })}
              <ChevronDown className={cn("size-3.5 transition", mobileOpen && "rotate-180")} />
            </button>
          )}
        </div>
        <div className="grid gap-2">
          {sorted.map(({ m, price }) => {
            const active = m.key === tool.key;
            if (!mobileOpen && !active) return null;
            const logo = modelLogoOf(m.modelLabel || m.name);
            return (
              <button
                key={m.key}
                type="button"
                disabled={disabled}
                onClick={() => (mobileOpen ? go(m) : setMobileOpen(true))}
                aria-pressed={active}
                className={cn("flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-2xl border px-3 py-2.5 text-left transition", active ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:border-foreground/30 hover:bg-muted/50")}
              >
                {logo ? (
                  <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl border bg-white", active && "border-primary")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logo} alt="" className="size-5" />
                  </span>
                ) : (
                  <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    <ToolIcon name={m.icon} className="size-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm font-semibold", active && "text-primary")}>{t(m.modelLabel || m.name)}</span>
                  <span className="block text-[11px] text-muted-foreground">{price !== undefined ? (price > 0 ? fmt.price(price) : t("Miễn phí")) : pricingText(m, t, fmt.price)}</span>
                </span>
                {m.maintenance ? (
                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">{t("Đang bảo trì")}</span>
                ) : (
                  m.badge && <span className="shrink-0 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase text-background">{t(m.badge)}</span>
                )}
                {!mobileOpen && (
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                    <ChevronDown className="size-4" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------- PC (lg+): chỉ 1 thẻ gọn + bung bảng chọn sang BÊN PHẢI kiểu Higgsfield ---------- */}
      <div className="hidden lg:block">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold">{t("Model AI")}</span>
          <span className="text-[11px] text-muted-foreground">{t("{n} model", { n: models.length })}</span>
        </div>
        <Popover
          open={pcOpen}
          onOpenChange={(next) => {
            setPcOpen(next);
            if (!next) setSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled || !current}
              className={cn(
                "group flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-2xl border bg-card px-3 py-2.5 text-left transition hover:border-foreground/35 hover:bg-muted/40 disabled:opacity-60",
                pcOpen && "border-primary bg-primary/5 ring-1 ring-primary",
              )}
            >
              {current &&
                (curLogo ? (
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl border bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={curLogo} alt="" className="size-5" />
                  </span>
                ) : (
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                    <ToolIcon name={current.m.icon} className="size-4" />
                  </span>
                ))}
              {current && (
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold leading-snug text-foreground">{t(current.m.modelLabel || current.m.name)}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {current.price !== undefined ? (current.price > 0 ? fmt.price(current.price) : t("Miễn phí")) : pricingText(current.m, t, fmt.price)}
                  </span>
                </span>
              )}
              {current?.m.maintenance ? (
                <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">{t("Đang bảo trì")}</span>
              ) : (
                current?.m.badge && (
                  <span className="shrink-0 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase text-background">{t(current.m.badge)}</span>
                )
              )}
              <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground", pcOpen && "translate-x-0.5 text-primary")} />
            </button>
          </PopoverTrigger>

          <PopoverContent
            side="right"
            align="start"
            sideOffset={12}
            collisionPadding={16}
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="w-auto min-w-[380px] max-w-[min(540px,calc(100vw-420px))] gap-2 rounded-2xl border bg-popover p-2.5 shadow-2xl"
          >
            {models.length >= 4 && (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("Tìm model...")}
                  className="h-9 w-full rounded-xl border bg-muted/40 pr-3 pl-8 text-[13px] outline-none focus:border-foreground/40 focus:bg-background"
                />
              </div>
            )}
            <div className="flex items-center gap-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground">
              <Sparkles className="size-3 text-primary" />
              <span>{t("Danh sách model")} ({filtered.length})</span>
            </div>
            <div className="max-h-[min(65vh,460px)] space-y-1 overflow-y-auto pr-0.5">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">{t("Không có kết quả phù hợp")}</p>
              ) : (
                filtered.map(({ m, price }) => {
                  const active = m.key === tool.key;
                  const logo = modelLogoOf(m.modelLabel || m.name);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => go(m)}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition",
                        active ? "border-primary bg-primary/10 ring-1 ring-primary/40" : "border-transparent hover:bg-muted/70",
                      )}
                    >
                      {logo ? (
                        <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl border bg-white", active && "border-primary")}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={logo} alt="" className="size-5" />
                        </span>
                      ) : (
                        <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                          <ToolIcon name={m.icon} className="size-4" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[13px] font-semibold leading-snug", active && "text-primary")}>{t(m.modelLabel || m.name)}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {price !== undefined ? (price > 0 ? fmt.price(price) : t("Miễn phí")) : pricingText(m, t, fmt.price)}
                        </span>
                      </span>
                      {m.maintenance ? (
                        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">{t("Đang bảo trì")}</span>
                      ) : (
                        m.badge && (
                          <span className="shrink-0 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase text-background">{t(m.badge)}</span>
                        )
                      )}
                      {active && <Check className="size-4 shrink-0 text-primary" />}
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function ToolRunner({ tool, models }: { tool: AiTool; models: AiTool[] }) {
  const { t, fmt } = useI18n();
  const { user, status: authStatus } = useAuth();
  const authed = authStatus === "authenticated";
  const qc = useQueryClient();
  const credits = useCredits(authed);
  const params = useSearchParams();
  const cat = useCategories().of(tool.category);
  const pf = promptFieldOf(tool);
  const [values, setValues] = useState<FormValues>(() => {
    const v = initialValues(tool.fields);
    // prompt chuyển sang từ ô "Bạn muốn tạo gì?" ở Tổng quan hoặc đổi qua lại giữa các model (dùng sessionStorage khi prompt dài > 800 ký tự để tránh lỗi 414 URI Too Large)
    let p = params.get("prompt");
    if (!p) {
      try {
        const stashed = sessionStorage.getItem("novai-switch-prompt");
        if (stashed) {
          p = stashed;
          sessionStorage.removeItem("novai-switch-prompt");
        }
      } catch {
        /* bỏ qua */
      }
    }
    if (p && pf) v[pf.name] = pf.max ? p.slice(0, pf.max) : p;
    const presetVoice = params.get("voice");
    if (presetVoice && tool.fields.some((f) => f.name === "voice")) v.voice = presetVoice;
    return v;
  });
  const presetVoiceParam = params.get("voice");
  useEffect(() => {
    if (presetVoiceParam && tool.fields.some((f) => f.name === "voice")) {
      setValues((prev) => (prev.voice === presetVoiceParam ? prev : { ...prev, voice: presetVoiceParam }));
    }
  }, [presetVoiceParam, tool.fields]);
  const [taskId, setTaskId] = useState<string | null>(null);
  // các mô tả thêm (ô 2..8) và công tắc "Mỗi dòng 1 mục" của ô prompt
  const [extraPrompts, setExtraPrompts] = useState<string[]>([]);
  const [perLine, setPerLine] = useState(false);
  // form nhiều cặp: các hàng [ảnh + video...] và số lượng nhân bản
  const pairCfg = tool.pairs?.fields.length ? tool.pairs : null;
  const pairNames = useMemo(() => pairCfg?.fields ?? [], [pairCfg]);
  const [pairs, setPairs] = useState<PairRow[]>([{}]);
  const [copies, setCopies] = useState(1);
  const maxCopies = Math.max(1, tool.copies ?? 1);
  // chế độ hiển thị gửi kèm khi tạo (Công khai / Riêng tư), nhớ lựa chọn gần nhất
  const [isPublic, setIsPublic] = useVisibilityPref();
  // bảng Thiết lập luôn vừa màn hình (chân bảng không bị cắt trên laptop)
  const formRef = useFitViewport<HTMLFormElement>();
  const router = useRouter();
  const pathname = usePathname();
  // công cụ tải TikTok không logo & ghép video trực tiếp trên trình duyệt chạy tức thì 0đ (không tạo task trên ổ đĩa)
  const isTikTokTool = tool.key === "tiktok-download" || tool.key.startsWith("tiktok-download-") || tool.key.endsWith(".tiktok-download");
  const isBulkDownloadTool = tool.key === "bulk-download" || tool.key.startsWith("bulk-download-") || tool.key.endsWith(".bulk-download");
  const isImageMetaTool = tool.key === "xoa-meta-hinh-anh" || tool.key.startsWith("xoa-meta-hinh-anh-") || tool.key.endsWith(".xoa-meta-hinh-anh");
  const isStitchTool = tool.key === "video-stitch" || tool.key.startsWith("video-stitch-") || tool.key.endsWith(".video-stitch");
  const isVoiceCloneTool = tool.key === "voice-clone" || tool.key.startsWith("voice-clone-") || tool.key.endsWith(".voice-clone");
  const isClientFreeTool = isTikTokTool || isBulkDownloadTool || isImageMetaTool || isStitchTool || isVoiceCloneTool;
  // tạo hàng loạt: công cụ ra ảnh / video có ô prompt
  const canBatch = !isClientFreeTool && (tool.output === "image" || tool.output === "video") && !!pf;
  const isVideo = tool.output === "video";
  const mode = canBatch && params.get("tab") === "batch" ? "batch" : "single";
  const setMode = (m: "single" | "batch") => {
    const q = new URLSearchParams(params.toString());
    if (m === "batch") q.set("tab", "batch");
    else q.delete("tab");
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  // Lưu trạng thái thử nghiệm giao diện Ngang trong phiên trình duyệt (tiện test xuyên suốt các công cụ trên iPhone / điện thoại)
  const [demoHorizontal, setDemoHorizontal] = useState(false);
  useEffect(() => {
    try {
      if (params.get("layout") === "horizontal") {
        sessionStorage.setItem("novai-demo-layout", "horizontal");
        setDemoHorizontal(true);
      } else if (sessionStorage.getItem("novai-demo-layout") === "horizontal") {
        setDemoHorizontal(true);
      }
    } catch {
      /* trình duyệt chặn storage */
    }
  }, [params]);

  const showLayoutToggle = canOpenAdmin(user) || params.get("layout") === "horizontal" || demoHorizontal;
  const isHorizontal = mode === "single" && (params.get("layout") === "horizontal" || demoHorizontal);
  const setLayout = (l: "vertical" | "horizontal") => {
    const q = new URLSearchParams(params.toString());
    try {
      if (l === "horizontal") {
        sessionStorage.setItem("novai-demo-layout", "horizontal");
        setDemoHorizontal(true);
      } else {
        sessionStorage.removeItem("novai-demo-layout");
        setDemoHorizontal(false);
      }
    } catch {
      /* bỏ qua */
    }
    if (l === "horizontal") {
      q.set("layout", "horizontal");
      q.delete("tab");
    } else {
      q.delete("layout");
    }
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  };

  // Xếp danh sách model theo giá thấp nhất lên đầu (dùng chung cho cả bố cục dọc và hộp ngang KlingAI)
  const modelQuotes = useQueries({
    queries: (isHorizontal ? models : []).map((m) => ({
      queryKey: ["ai", "quote", m.key, "default", authed],
      queryFn: async () =>
        (
          await api.post<{ credits: number }>(
            authed ? `/account/ai/tools/${encodeURIComponent(m.key)}/quote` : `/public/ai/tools/${encodeURIComponent(m.key)}/quote`,
            { input: initialValues(m.fields) },
            { auth: authed },
          )
        ).credits,
      staleTime: 5 * 60_000,
      retry: false,
      meta: { silentError: true },
    })),
  });
  const sortedModels = useMemo(() => {
    return models
      .map((m, i) => ({
        m,
        price: modelQuotes[i]?.data ?? m.price ?? undefined,
        rank: typeof m.price === "number" ? m.price : (modelQuotes[i]?.data ?? priceRank(m)),
      }))
      .sort((a, b) => a.rank - b.rank);
  }, [models, modelQuotes]);

  // "Dùng lại thiết kế" từ trang Cộng đồng: tải tác phẩm công khai rồi điền thiết lập vào form (một lần)
  const reuseCode = params.get("reuse");
  const reused = useRef(false);
  const shared = useQuery({
    queryKey: ["ai", "community", "item", reuseCode],
    queryFn: () => api.get<CommunityTask>(`/public/ai/community/${encodeURIComponent(reuseCode!)}`),
    enabled: !!reuseCode && !isClientFreeTool,
    retry: false,
    meta: { silentError: true },
  });
  useEffect(() => {
    const x = shared.data;
    // tác phẩm của công cụ gốc trước khi tách theo model vẫn dùng lại được ở model con
    if (!x || reused.current || (x.toolKey !== tool.key && !tool.key.startsWith(`${x.toolKey}~`))) return;
    reused.current = true;
    // chỉ nhận các ô có trong form hiện tại của công cụ (trừ ô ẩn — vd model cố định của model con)
    const names = new Set(tool.fields.filter((f) => !f.hidden).map((f) => f.name));
    const picked = Object.fromEntries(Object.entries(x.input).filter(([k]) => names.has(k)));
    setValues({ ...initialValues(tool.fields), ...picked } as FormValues);
    if (pairCfg) setPairs([pickPair(picked, pairCfg.fields)]);
    toast.success(t("Đã điền thiết kế #{code} từ Cộng đồng", { code: x.code }));
  }, [shared.data, tool, t, pairCfg]);
  useEffect(() => {
    if (shared.error) toast.error(errorMessage(shared.error));
  }, [shared.error]);

  // danh sách form sẽ gửi: mỗi mô tả một form (chế độ thường); không có mô tả nào thì gửi đúng form hiện tại
  const promptList = useMemo(() => (pf ? [String(values[pf.name] ?? ""), ...extraPrompts] : []), [pf, values, extraPrompts]);
  // + nhiều cặp: mỗi cặp đủ file × mỗi mô tả; chưa có cặp nào đủ thì dùng hàng đầu (để vẫn báo giá được) — × số lượng nhân bản
  const readyPairs = useMemo(() => pairs.filter((r) => pairReady(r, pairNames)), [pairs, pairNames]);
  const inputs = useMemo<FormValues[]>(() => {
    if (mode === "batch") return [values];
    let list: FormValues[] = [values];
    if (pf) {
      const { items } = promptItems(promptList, perLine);
      if (items.length) list = items.map((p) => ({ ...values, [pf.name]: p }));
    }
    if (pairCfg) {
      const rows = readyPairs.length ? readyPairs : [pairs[0] ?? {}];
      list = rows.flatMap((row) => list.map((v) => ({ ...v, ...pickPair(row, pairNames) })));
    }
    const n = Math.min(copies, maxCopies);
    return n > 1 ? list.flatMap((v) => Array.from({ length: n }, () => v)) : list;
  }, [pf, mode, values, promptList, perLine, pairCfg, readyPairs, pairs, pairNames, copies, maxCopies]);

  // báo giá: hỏi giá từng form (giá có thể theo độ dài chữ) rồi cộng lại, sau khi ngừng gõ 400ms
  const userDiscount = credits.data?.pricing?.customDiscount ?? 0;
  const debounced = useDebounced(inputs, 400);
  const quote = useQuery({
    queryKey: ["ai", "quote", tool.key, debounced, userDiscount, authed],
    queryFn: async () => {
      // form trùng nhau (nhân bản) hoặc chỉ khác file của cặp thì chung giá -> mỗi loại chỉ hỏi một lần; riêng công cụ tính theo giây / mốc thời lượng cần giữ link video/audio/media để đo độ dài thật
      const unitLabel = "unitLabel" in tool.pricing ? tool.pricing.unitLabel : null;
      const keepMedia = tool.pricing.mode === "tiers" || tool.pricing.mode === "dynamic" || unitLabel === "giây";
      const sig = (input: FormValues) =>
        JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => !pairNames.includes(k) || (keepMedia && (k === "video" || k === "audio" || k === "media")))));
      const unique = [...new Map(debounced.map((input) => [sig(input), input])).entries()];
      const quoteUrl = authed ? `/account/ai/tools/${encodeURIComponent(tool.key)}/quote` : `/public/ai/tools/${encodeURIComponent(tool.key)}/quote`;
      const prices = new Map(
        await Promise.all(
          unique.map(async ([k, input]) => {
            const res = await api.post<{ credits: number; originalCredits?: number; discount?: number }>(quoteUrl, { input }, { auth: authed });
            return [k, { credits: res.credits, original: res.originalCredits ?? res.credits, discount: res.discount ?? 0 }] as const;
          }),
        ),
      );
      const each = debounced.map((input) => prices.get(sig(input)) ?? { credits: 0, original: 0, discount: 0 });
      return {
        credits: each.reduce((sum, x) => sum + x.credits, 0),
        originalCredits: each.reduce((sum, x) => sum + x.original, 0),
        discount: each[0]?.discount ?? 0,
        unit: each[0]?.credits ?? 0,
        originalUnit: each[0]?.original ?? 0,
      };
    },
    retry: (count, err) => count < 2 && /502|503|504|network|fetch/i.test(errorMessage(err)),
    retryDelay: 1500,
    enabled: !isClientFreeTool,
    meta: { silentError: true },
  });

  // gửi lần lượt từng mô tả; lỗi giữa chừng thì dừng, giữ các tác vụ đã gửi thành công
  const run = useMutation({
    // `list`: gửi đúng các form này (vd "Thử lại" một kết quả); bỏ trống thì gửi theo form hiện tại
    mutationFn: async (list?: FormValues[]) => {
      if (!list && pairCfg && !readyPairs.length) throw new Error(t("Vui lòng chọn đủ file cho ít nhất 1 cặp ô vuông!"));
      const queue = list ?? inputs;
      const done: AiTask[] = [];
      for (const input of queue) {
        try {
          done.push(await api.post<AiTask>(`/account/ai/tools/${encodeURIComponent(tool.key)}/run`, { input, isPublic }));
        } catch (err) {
          if (!done.length) throw err;
          toast.error(t("Đã gửi {n}/{total} mô tả, dừng lại do lỗi: {e}", { n: done.length, total: queue.length, e: errorMessage(err) }));
          break;
        }
      }
      return done;
    },
    onSuccess: (tasks) => {
      setTaskId(tasks[0].id);
      // đã gửi các cặp -> làm trống danh sách cặp để chuẩn bị lượt sau
      if (pairCfg) setPairs([{}]);
      for (const x of tasks) qc.setQueryData(["ai", "task", x.id], x);
      qc.invalidateQueries({ queryKey: ["credits"] });
      qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
      const spent = tasks.reduce((sum, x) => sum + x.credits, 0);
      // công cụ miễn phí (0đ) không nhắc chuyện trừ tiền
      if (tasks.length > 1) toast.success(spent > 0 ? t("Đã gửi {n} yêu cầu, đã trừ {c}", { n: tasks.length, c: fmt.money(spent) }) : t("Đã gửi {n} yêu cầu", { n: tasks.length }));
      else toast.success(spent > 0 ? t("Đã gửi yêu cầu, đã trừ {n}", { n: fmt.money(spent) }) : t("Đã gửi yêu cầu"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const task = useTask(taskId);
  const recent = useQuery({
    queryKey: ["ai", "tasks", "tool", tool.key],
    queryFn: () => api.get<Paginated<AiTask>>("/account/ai/tasks", { tool: tool.key, limit: 12 }),
    enabled: authed && !isClientFreeTool,
    refetchInterval: (query) => (query.state.data?.data.some((x) => isRunning(x.status)) ? 4000 : false),
    meta: { silentError: true },
  });
  // chưa chạy lần nào trong phiên này -> hiện kết quả gần nhất của công cụ
  useEffect(() => {
    if (!taskId && recent.data?.data?.[0]) setTaskId(recent.data.data[0].id);
  }, [recent.data, taskId]);

  const price = quote.data?.credits;
  const originalPrice = quote.data?.originalCredits;
  const activeDiscount = quote.data?.discount ?? 0;
  const balance = credits.data?.credits ?? 0;
  const enough = price === undefined || balance >= price;
  const quoteError = quote.error ? errorMessage(quote.error) : null;
  const batch = useBatch(tool, values, credits.data?.concurrency ?? 1, isPublic, (patch) => setValues((prev) => ({ ...prev, ...patch })));
  // chi phí ước tính cả lô = giá một lượt với thiết lập chung × số dòng sẵn sàng (dòng ghi đè độ phân giải có thể chênh)
  const batchCount = batch.count.ready;
  const batchPrice = quote.data ? quote.data.unit * batchCount : undefined;
  const batchOriginalPrice = quote.data ? quote.data.originalUnit * batchCount : undefined;
  const groupDemoVideo = tool.demoVideo || models.find((m) => m.demoVideo)?.demoVideo || null;
  const batchEnough = batchPrice === undefined || balance >= batchPrice;
  // ô của cặp chỉ giữ ô đầu làm chỗ đặt PairList, các ô còn lại của cặp ẩn khỏi form
  const formFields = useMemo(
    () =>
      tool.fields.filter(
        (f) =>
          !(mode === "batch" && pf && f.name === pf.name) &&
          // lô video: ô ảnh khởi đầu đã hiển thị ngay dưới thẻ Nguồn ảnh ở BatchSettings
          !(mode === "batch" && batch.imgField && f.name === batch.imgField.name) &&
          !(pairCfg && pairNames.indexOf(f.name) > 0),
      ),
    [mode, pf, tool.fields, pairCfg, pairNames, batch.imgField],
  );
  const pairFields = useMemo(() => pairNames.map((n) => tool.fields.find((f) => f.name === n)).filter((f): f is NonNullable<typeof f> => !!f), [pairNames, tool.fields]);
  const history = useMemo(
    () => (recent.data?.data ?? []).map((x) => (task.data && x.id === task.data.id ? task.data : x)),
    [recent.data, task.data],
  );

  // điền lại thiết lập của một lần tạo cũ vào form
  const reuse = (x: AiTask) => {
    setValues({ ...initialValues(tool.fields), ...x.input });
    if (pairCfg) setPairs([pickPair(x.input, pairCfg.fields)]);
    toast.success(t("Đã điền lại thiết lập của lần tạo #{code}", { code: x.code }));
  };

  return (
    <div className="space-y-5 pt-2">
      {/* tiêu đề công cụ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Link href="/dashboard" className="hover:text-foreground">
              {t("Bảng điều khiển")}
            </Link>
            <ChevronRight className="size-3" />
            <span>{t(cat.label)}</span>
            {tool.group && (
              <>
                <ChevronRight className="size-3" />
                <span>{t(tool.group)}</span>
              </>
            )}
          </nav>
          <div className="flex items-center gap-3.5">
            {(() => {
              const headerLogo = modelLogoOf(tool.modelLabel || tool.name);
              return headerLogo ? (
                <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl border bg-white p-2 shadow-sm dark:border-white/15">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={headerLogo} alt="" className="size-7 object-contain" />
                </span>
              ) : (
                <span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg", cat.art)}>
                  <ToolIcon name={tool.icon} className="size-6" />
                </span>
              );
            })()}
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
                {/* Hiện trực tiếp tên model đang chọn trên tiêu đề (T-190) */}
                {t(tool.modelLabel || tool.name)}
                {tool.badge && <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", /hot/i.test(tool.badge) ? "bg-rose-500 text-white" : "bg-foreground text-background")}>{t(tool.badge)}</span>}
              </h1>
              <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{tool.description ? t(tool.description) : null}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {showLayoutToggle && !isClientFreeTool && (
            <div className="inline-flex h-8 items-center rounded-full border bg-card p-0.5 font-medium" title="Chuyển thử bố cục Dọc / Ngang (chỉ Admin hoặc link demo mới thấy)">
              <button
                type="button"
                onClick={() => setLayout("vertical")}
                className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 transition", !isHorizontal ? "bg-foreground text-background shadow-xs" : "text-muted-foreground hover:text-foreground")}
              >
                <Columns2 className="size-3.5" /> Dọc
              </button>
              <button
                type="button"
                onClick={() => setLayout("horizontal")}
                className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 transition", isHorizontal ? "bg-emerald-500 font-semibold text-zinc-950 shadow-xs" : "text-muted-foreground hover:text-foreground")}
              >
                <Rows2 className="size-3.5" /> Ngang (Demo)
              </button>
            </div>
          )}
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 font-medium">
            <Coins className="size-3.5 text-amber-500" /> {pricingText(tool, t, fmt.price)}
          </span>
          {!isClientFreeTool && (
            <Link href={`/history?tool=${encodeURIComponent(tool.key)}`} className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 font-medium transition hover:bg-muted">
              <History className="size-3.5" /> {t("Lịch sử")}
            </Link>
          )}
        </div>
      </div>

      {canBatch && (
        <div className="inline-flex rounded-full border bg-card p-1 text-sm">
          {(["single", "batch"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-4 font-medium transition", mode === m ? "bg-foreground text-background shadow" : "text-muted-foreground hover:text-foreground")}
            >
              {m === "single" ? <Wand2 className="size-3.5" /> : <Layers className="size-3.5" />}
              {m === "single" ? (isVideo ? t("Tạo video") : t("Tạo ảnh")) : t("Tạo hàng loạt")}
            </button>
          ))}
        </div>
      )}

      {isTikTokTool ? (
        <TikTokToolWorkspace
          demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          modelPicker={models.length > 1 ? <ModelPicker tool={tool} models={models} /> : null}
        />
      ) : isBulkDownloadTool ? (
        <BulkDownloadWorkspace
          demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          modelPicker={models.length > 1 ? <ModelPicker tool={tool} models={models} /> : null}
        />
      ) : isImageMetaTool ? (
        <ImageMetadataWorkspace
          demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          modelPicker={models.length > 1 ? <ModelPicker tool={tool} models={models} /> : null}
        />
      ) : isStitchTool ? (
        <VideoStitchWorkspace
          tool={tool}
          demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          modelPicker={models.length > 1 ? <ModelPicker tool={tool} models={models} /> : null}
        />
      ) : isVoiceCloneTool ? (
        <VoiceCloneWorkspace
          demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          modelPicker={models.length > 1 ? <ModelPicker tool={tool} models={models} /> : null}
        />
      ) : isHorizontal ? (
        <div className="space-y-6">
          <HorizontalComposer
            tool={tool}
            models={sortedModels.map((x) => x.m)}
            modelPrices={sortedModels.map((x) => x.price)}
            promptField={pf}
            values={values}
            onChangeValues={setValues}
            pairCfg={pairCfg}
            pairFields={pairFields}
            pairs={pairs}
            onChangePairs={setPairs}
            copies={copies}
            maxCopies={maxCopies}
            onChangeCopies={setCopies}
            inputsCount={inputs.length}
            price={price}
            balance={balance}
            enough={enough}
            quoteFetching={quote.isFetching}
            quoteError={quoteError}
            isPublic={isPublic}
            onChangePublic={setIsPublic}
            submitting={run.isPending}
            onSubmit={() => run.mutate(undefined)}
            demoMedia={<DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />}
          />

          <div className="mx-auto w-full max-w-5xl space-y-5">
            {task.data && (
              <section className={cn("flex flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-5", !isRunning(task.data.status) && "min-h-[420px]")}>
                <TaskResult task={task.data} onRetry={() => run.mutate([task.data!.input as FormValues])} onReuse={() => reuse(task.data!)} onReplied={(next) => setTaskId(next.id)} />
              </section>
            )}

            {history.length > 0 && (
              <section>
                <div className="mb-2.5 flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold">{t("Gần đây")}</h2>
                  <Link href={`/history?tool=${encodeURIComponent(tool.key)}`} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                    {t("Xem tất cả")}
                  </Link>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {history.map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      onClick={() => setTaskId(x.id)}
                      className={cn("group overflow-hidden rounded-2xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md", x.id === taskId && "ring-2 ring-foreground/15 ring-offset-2 ring-offset-background")}
                    >
                      <TaskThumb task={x} />
                      <div className="flex items-center justify-between gap-1 px-2.5 py-2 text-[10.5px]">
                        <span className="truncate text-muted-foreground">#{x.code}</span>
                        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 font-semibold tabular-nums", TASK_STATUS[x.status].className)}>
                          {t(TASK_STATUS[x.status].label)}
                          {isRunning(x.status) ? ` ${x.progress > 0 ? Math.min(99, Math.round(x.progress)) : x.status === "PROCESSING" ? 5 : 1}%` : ""}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <ToolSamples samples={tool.samples ?? []} />
          </div>
        </div>
      ) : (
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,340px)_minmax(280px,1fr)] xl:grid-cols-[minmax(0,425px)_minmax(0,1fr)]">
        {/* bảng thiết lập */}
        <form
          ref={formRef}
          className="flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm lg:sticky lg:top-20"
          onSubmit={(e) => {
            e.preventDefault();
            if (tool.maintenance) return;
            if (!authed) {
              router.push(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
              return;
            }
            if (mode === "batch") batch.start();
            else run.mutate(undefined);
          }}
        >
          <div className="flex items-center gap-2 border-b px-5 py-3 text-sm font-semibold">
            <Settings2 className="size-4 text-muted-foreground" /> {t("Thiết lập")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <DemoMediaBox url={groupDemoVideo} modelName={tool.group ? t(tool.group) : models.length > 1 ? t(tool.modelLabel || tool.name) : undefined} />
            {models.length > 1 && <ModelPicker tool={tool} models={models} prompt={pf ? String(values[pf.name] ?? "") : undefined} tab={mode === "batch" ? "batch" : undefined} disabled={run.isPending} />}
            {tool.pricing.mode === "tiers" && (
              <div className="mb-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-3 text-xs">
                <div className="mb-2 flex items-center gap-1.5 font-semibold text-foreground">
                  <Coins className="size-3.5 text-amber-500" />
                  {t("Bảng giá riêng theo thời lượng video mẫu (> 10s)")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border bg-background/80 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">{t("Từ 10s – 20s (2 cảnh)")}</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{fmt.price(tool.pricing.tier10to20)}</div>
                  </div>
                  <div className="rounded-xl border bg-background/80 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">{t("Từ 20s – 30s (3 cảnh)")}</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{fmt.price(tool.pricing.tier20to30)}</div>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {t("Hệ thống tự động đo độ dài video khi tải lên để áp dụng đúng mức giá (video từ 10s trở xuống vui lòng dùng mục max 10s).")}
                </p>
              </div>
            )}
            {mode === "batch" && <BatchSettings tool={tool} batch={batch} />}
            <ToolForm
              fields={formFields}
              values={values}
              onChange={setValues}
              disabled={run.isPending}
              slots={{
                ...(pairCfg && pairFields.length
                  ? {
                      [pairNames[0]]: <PairList fields={pairFields} rows={pairs} onChange={setPairs} max={pairCfg.max} linkField={pairCfg.linkField} disabled={run.isPending} />,
                    }
                  : {}),
                ...(mode === "single" && pf
                  ? {
                      [pf.name]: (
                        <PromptList
                          field={pf}
                          value={promptList}
                          onChange={(list) => {
                            setValues((v) => ({ ...v, [pf.name]: list[0] ?? "" }));
                            setExtraPrompts(list.slice(1));
                          }}
                          perLine={perLine}
                          onPerLine={setPerLine}
                          disabled={run.isPending}
                        />
                      ),
                    }
                  : {}),
              }}
            />
            {/* số lượng nhân bản: mỗi bản là một tác vụ riêng */}
            {mode === "single" && maxCopies > 1 && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-[13px] font-semibold">{t("Số lượng nhân bản")}</span>
                <div className="inline-flex items-center rounded-xl border bg-card">
                  <button type="button" disabled={run.isPending || copies <= 1} onClick={() => setCopies((c) => Math.max(1, c - 1))} className="inline-flex size-9 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-40" aria-label="-">
                    <Minus className="size-4" />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold tabular-nums">{copies}</span>
                  <button type="button" disabled={run.isPending || copies >= maxCopies} onClick={() => setCopies((c) => Math.min(maxCopies, c + 1))} className="inline-flex size-9 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-40" aria-label="+">
                    <Plus className="size-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* chân bảng chế độ hàng loạt: chi phí ước tính cả lô + nút chạy */}
          {mode === "batch" ? (
            <div className="border-t bg-muted/30 px-5 py-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-[11px] text-muted-foreground">{t("Chi phí ước tính ({n} × {p})", { n: batchCount, p: quote.data ? fmt.price(quote.data.unit) : "—" })}</div>
                  <div className="flex items-center gap-1.5 text-lg font-bold tabular-nums">
                    {quote.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Coins className="size-4 text-amber-500" />}
                    {batchPrice !== undefined ? fmt.money(batchPrice) : "—"}
                    {batchPrice !== undefined && batchOriginalPrice !== undefined && batchOriginalPrice > batchPrice && (
                      <>
                        <span className="text-xs font-normal text-muted-foreground line-through">{fmt.money(batchOriginalPrice)}</span>
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                          -{activeDiscount}%
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {authed && (
                  <div className="text-right text-[11px] text-muted-foreground">
                    {t("Số dư")}
                    <div className={cn("text-[13px] font-semibold tabular-nums", batchEnough ? "text-foreground" : "text-red-600")}>{fmt.money(balance)}</div>
                  </div>
                )}
              </div>
              {quoteError && <div className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{quoteError}</div>}
              {authed && !batchEnough && <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t("Số dư chưa đủ cho cả lô — lô sẽ tự tạm dừng khi hết số dư.")}</div>}
              {tool.maintenance ? (
                <button
                  type="button"
                  disabled
                  className="mt-2.5 inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/15 text-[15px] font-semibold text-amber-700 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300"
                >
                  <Wrench className="size-4" /> {t("Đang bảo trì")}
                </button>
              ) : !authed ? (
                <Link
                  href={`/login?next=${encodeURIComponent(pathname)}`}
                  className="mt-2.5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-foreground text-[15px] font-semibold text-background shadow-lg shadow-black/10 transition hover:opacity-90"
                >
                  <LogIn className="size-4" /> {t("Đăng nhập để tạo ngay")}
                </Link>
              ) : (
              <div className="mt-2.5 flex gap-2">
              <VisibilityPicker value={isPublic} onChange={setIsPublic} align="start" className="size-11 rounded-2xl" />
              <button
                type="submit"
                disabled={batch.running || !batchCount || !!quoteError}
                className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-foreground text-[15px] font-semibold text-background shadow-lg shadow-black/10 transition disabled:opacity-60 disabled:shadow-none"
              >
                {batch.running ? <Loader2 className="size-4 animate-spin" /> : <Layers className="size-4" />}
                {batch.running ? t("Đang chạy lô...") : batchCount ? (isVideo ? t("Tạo {n} video", { n: batchCount }) : t("Tạo {n} ảnh", { n: batchCount })) : t("Thêm prompt ở khung bên phải")}
              </button>
              </div>
              )}
            </div>
          ) : (
            <>
          {/* chân bảng: chi phí + nút tạo */}
            <div className="border-t bg-muted/30 px-5 py-3">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                    <span>{inputs.length > 1 ? t("Chi phí ({n} kết quả)", { n: inputs.length }) : t("Chi phí")}</span>
                    {(() => {
                      const ul = "unitLabel" in tool.pricing ? tool.pricing.unitLabel : null;
                      if (ul === "1.000 ký tự" || ul === "ký tự") {
                        const chars = inputs.reduce((sum, inp) => {
                          const raw = String(inp.text ?? inp.script ?? inp.srtText ?? inp.prompt ?? "");
                          return sum + raw.length;
                        }, 0);
                        return (
                          <span className="font-medium text-foreground/80">
                            · {chars > 0 ? t("{n} ký tự", { n: chars.toLocaleString("vi-VN") }) : t("Tính theo ký tự")}
                          </span>
                        );
                      }
                      if (ul === "giây") {
                        return <span className="font-medium text-foreground/80">· {t("Tính theo giây")}</span>;
                      }
                      return null;
                    })()}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-lg font-bold tabular-nums">
                    {quote.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Coins className="size-4 text-amber-500" />}
                    {price !== undefined ? fmt.money(price) : "—"}
                    {price !== undefined && originalPrice !== undefined && originalPrice > price && (
                      <>
                        <span className="text-xs font-normal text-muted-foreground line-through">{fmt.money(originalPrice)}</span>
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                          -{activeDiscount}%
                        </span>
                      </>
                    )}
                    {"perUnit" in tool.pricing && tool.pricing.perUnit && tool.pricing.unitLabel ? (
                      <span className="ml-1 text-[11px] font-medium text-muted-foreground">
                        ({pricingText(tool, t, fmt.price)})
                      </span>
                    ) : null}
                  </div>
                  {"hint" in tool.pricing && tool.pricing.hint ? (
                    <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{t(tool.pricing.hint)}</div>
                  ) : null}
                </div>
                {authed && (
                  <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                    {t("Số dư")}
                    <div className={cn("text-[13px] font-semibold tabular-nums", enough ? "text-foreground" : "text-red-600")}>{fmt.money(balance)}</div>
                  </div>
                )}
              </div>
              {quoteError && <div className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{quoteError}</div>}
              {tool.maintenance ? (
                <button
                  type="button"
                  disabled
                  className="mt-2.5 inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/15 text-[15px] font-semibold text-amber-700 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300"
                >
                  <Wrench className="size-4" /> {t("Đang bảo trì")}
                </button>
              ) : !authed ? (
                <Link
                  href={`/login?next=${encodeURIComponent(pathname)}`}
                  className="mt-2.5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-foreground text-[15px] font-semibold text-background shadow-lg shadow-black/10 transition hover:opacity-90"
                >
                  <LogIn className="size-4" /> {t("Đăng nhập để tạo ngay")}
                </Link>
              ) : enough ? (
                <div className="mt-2.5 flex gap-2">
                <VisibilityPicker value={isPublic} onChange={setIsPublic} disabled={run.isPending} align="start" className="size-11 rounded-2xl" />
                <button
                  type="submit"
                  disabled={run.isPending || !!quoteError}
                  className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-foreground text-[15px] font-semibold text-background shadow-lg shadow-black/10 transition hover:shadow-black/10 disabled:opacity-60 disabled:shadow-none"
                >
                  {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                  {run.isPending ? t("Đang gửi...") : inputs.length > 1 ? t("Tạo {n} kết quả", { n: inputs.length }) : t("Tạo ngay")}
                </button>
                </div>
              ) : (
                <Link href="/pricing" className="mt-2.5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-foreground text-sm font-semibold text-background">
                  <Wallet className="size-4" /> {t("Không đủ số dư — nạp thêm")}
                </Link>
              )}
            </div>
            </>
          )}
        </form>

        {/* khung xem + gần đây (tác vụ đang chạy: TaskResult chỉ còn thanh trạng thái nên bỏ chiều cao tối thiểu) */}
        <div className="min-w-0 space-y-5">
          {mode === "batch" ? (
            <BatchPanel tool={tool} batch={batch} />
          ) : (
          <section className={cn("flex flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-5", !(task.data && isRunning(task.data.status)) && "min-h-[520px]")}>
            {task.data ? (
              <TaskResult task={task.data} onRetry={() => run.mutate([task.data!.input as FormValues])} onReuse={() => reuse(task.data!)} onReplied={(next) => setTaskId(next.id)} />
            ) : (
              <div className="studio-dots flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center">
                <span className={cn("inline-flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br text-white shadow-xl", cat.art)}>
                  <ToolIcon name={tool.icon} className="size-7" />
                </span>
                <p className="mt-5 text-base font-semibold">{t("Tác phẩm của bạn sẽ xuất hiện ở đây")}</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("Hoàn tất thiết lập bên trái rồi bấm Tạo ngay. Tiền chỉ bị trừ khi gửi, lỗi sẽ được hoàn lại tự động.")}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1">
                    <Sparkles className="size-3 text-foreground" /> {t("Chất lượng cao")}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1">
                    <Coins className="size-3 text-amber-500" /> {t("Hoàn tiền khi lỗi")}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1">
                    <History className="size-3 text-foreground" /> {t("Lưu trong lịch sử")}
                  </span>
                </div>
              </div>
            )}
          </section>
          )}

          {mode === "single" && history.length > 0 && (
            <section>
              <div className="mb-2.5 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold">{t("Gần đây")}</h2>
                <Link href={`/history?tool=${encodeURIComponent(tool.key)}`} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                  {t("Xem tất cả")}
                </Link>
              </div>
              <div className="studio-scroll -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
                {history.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    onClick={() => setTaskId(x.id)}
                    className={cn("group w-40 shrink-0 overflow-hidden rounded-2xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md", x.id === taskId && "ring-2 ring-foreground/15 ring-offset-2 ring-offset-background")}
                  >
                    <TaskThumb task={x} />
                    <div className="flex items-center justify-between gap-1 px-2.5 py-2 text-[10.5px]">
                      <span className="truncate text-muted-foreground">#{x.code}</span>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 font-semibold tabular-nums", TASK_STATUS[x.status].className)}>
                        {t(TASK_STATUS[x.status].label)}
                        {isRunning(x.status) ? ` ${x.progress > 0 ? Math.min(99, Math.round(x.progress)) : x.status === "PROCESSING" ? 5 : 1}%` : ""}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ví dụ đầu ra của công cụ (vd ảnh trước / sau của Phục chế ảnh cũ) */}
          {mode === "single" && <ToolSamples samples={tool.samples ?? []} />}
        </div>
      </div>
      )}
    </div>
  );
}

/**
 * Khung phát video / ảnh mẫu tham khảo ở đầu bảng Thiết lập (T-269):
 * - Mặc định hiển thị TRỌN KHUNG 100% từ đầu tới chân (không cắt mất đầu nhân vật ở video dọc 9:16),
 *   đồng thời co khít thẻ <video>/<img> theo đúng tỉ lệ thật (`h-72 w-auto`) đặt trên nền kính mờ đồng màu (`blur-2xl`)
 *   để trình duyệt không vẽ 2 dải viền đen hai bên.
 * - Có nút chuyển sang Phóng tràn khung (neo sát đỉnh `object-[50%_12%]` giữ phần đầu/mặt) & Thu gọn.
 */
function DemoMediaBox({ url, modelName }: { url: string | null; modelName?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [muted, setMuted] = useState(true);
  const [fill, setFill] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [canBlurBg, setCanBlurBg] = useState(false);
  const fgVideoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 640px)");
    setCanBlurBg(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCanBlurBg(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    setFill(false);
    setIsLandscape(false);
    return () => {
      for (const el of [fgVideoRef.current, bgVideoRef.current]) {
        if (!el) continue;
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          /* ignore */
        }
      }
    };
  }, [url, open]);

  if (!url) return null;
  const isImage = /\.(gif|webp|png|jpe?g)(\?|$)/i.test(url);
  const baseLabel = isImage ? t("Ảnh mẫu tham khảo") : t("Video mẫu tham khảo");
  const HeaderIcon = isImage ? ImageIcon : Film;
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border bg-muted/30">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
          <HeaderIcon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">{modelName ? `${baseLabel} · ${modelName}` : baseLabel}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {open && !isLandscape && (
            <button
              type="button"
              onClick={() => setFill((f) => !f)}
              title={fill ? t("Xem trọn khung gốc (không cắt đầu)") : t("Phóng tràn khung")}
              className="inline-flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground transition hover:text-foreground"
              aria-label={fill ? "Fit" : "Fill"}
            >
              {fill ? <Minimize2 className="size-3 text-primary" /> : <Maximize2 className="size-3" />}
            </button>
          )}
          {open && !isImage && (
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="inline-flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground transition hover:text-foreground"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3 text-primary" />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
          >
            {open ? t("Thu gọn") : t("Xem mẫu")}
            <ChevronDown className={cn("size-3 transition", open && "rotate-180")} />
          </button>
        </div>
      </div>
      {open && (
        <div className="relative flex items-center justify-center overflow-hidden border-t bg-muted/60">
          {!fill && !isLandscape &&
            (isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-85 blur-2xl saturate-150"
              />
            ) : canBlurBg ? (
              <video
                ref={bgVideoRef}
                key={`bg-${url}`}
                src={url}
                autoPlay
                loop
                muted
                playsInline
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-85 blur-2xl saturate-150"
              />
            ) : null)}
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={baseLabel}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w > 0 && h > 0) setIsLandscape(w / h >= 1.2);
              }}
              className={cn(
                "relative z-10 mx-auto block transition-all",
                fill
                  ? "aspect-[16/10] w-full object-cover object-[50%_12%]"
                  : isLandscape
                    ? "h-auto w-full"
                    : "h-72 w-auto max-w-full object-contain shadow-md",
              )}
            />
          ) : (
            <video
              ref={fgVideoRef}
              key={url}
              src={url}
              autoPlay
              loop
              muted={muted}
              playsInline
              controls
              onLoadedMetadata={(e) => {
                const { videoWidth: w, videoHeight: h } = e.currentTarget;
                if (w > 0 && h > 0) setIsLandscape(w / h >= 1.2);
              }}
              onPlay={() => void bgVideoRef.current?.play().catch(() => undefined)}
              onPause={() => bgVideoRef.current?.pause()}
              onSeeked={(e) => {
                if (bgVideoRef.current) bgVideoRef.current.currentTime = e.currentTarget.currentTime;
              }}
              className={cn(
                "relative z-10 mx-auto block transition-all",
                fill
                  ? "aspect-[16/10] w-full object-cover object-[50%_12%]"
                  : isLandscape
                    ? "h-auto w-full"
                    : "h-72 w-auto max-w-full object-contain shadow-md",
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Lấy giá trị các ô của cặp từ một form (chỉ giữ chuỗi URL) */
function pickPair(input: Record<string, unknown>, names: string[]): PairRow {
  return Object.fromEntries(names.map((n) => [n, typeof input[n] === "string" && input[n] ? (input[n] as string) : undefined]));
}
