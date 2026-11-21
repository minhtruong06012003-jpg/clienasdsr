"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  BadgePercent,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  CreditCard,
  Flame,
  Info,
  Layers,
  Megaphone,
  Pin,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { modelLogoOf, priceRank, pricingText, toolHref, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { useAiTools, useCategories, useCredits } from "@/lib/queries";
import { canOpenAdmin } from "@/lib/site";
import type { AiTool, AiToolPriceBreakdown } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PopularRow {
  key: string;
  uses: number;
}

interface AnnouncementItem {
  id: string;
  title: string | null;
  content: string;
  pinned: boolean;
  createdAt: string;
}

interface TimelineEntry {
  id: string;
  dateLabel: string;
  badge?: string;
  pinned?: boolean;
  title: string;
  detail: string;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} · ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function buildAutoSystemTimeline(tools: AiTool[], t: (s: string, p?: Record<string, string | number>) => string): TimelineEntry[] {
  if (!tools.length) return [];
  const entries: TimelineEntry[] = [];
  const has4kVideo = tools.some((x) => /video-4k-upscale|upscale-4k/i.test(x.key));
  const hasVoice = tools.some((x) => x.category === "giong-noi-ai" || /tts|voice-clone|convert-subtitles/i.test(x.key));
  const hasSeedance25 = tools.some((x) => /seedance-2\.5|seedance_2_5/i.test(x.key));
  const hasCinema = tools.some((x) => /kling-4|veo-3\.1|minimax-h3|wan-3|happy-horse/i.test(x.key));
  const hasImage4k = tools.some((x) => /nano-banana|gpt-image-2|seedream|flux/i.test(x.key));
  const maintenanceTools = tools.filter((x) => x.maintenance);

  if (maintenanceTools.length > 0) {
    entries.push({
      id: "auto-maint",
      dateLabel: t("Trạng thái hiện tại"),
      badge: "BẢO TRÌ",
      title: t("Đang bảo trì tạm thời {n} model", { n: maintenanceTools.length }),
      detail: maintenanceTools
        .slice(0, 5)
        .map((m) => m.modelLabel || m.name)
        .join(" · "),
    });
  }

  if (hasSeedance25) {
    entries.push({
      id: "auto-sd25",
      dateLabel: "19/11/2026",
      badge: "MỚI",
      title: t("Mở khoá độ phân giải 4K trên Seedance 2.5 & nâng cấp Tạo hàng loạt"),
      detail: t("Hỗ trợ tạo video điện ảnh tới 4K dài 30 giây có âm thanh gốc, bổ sung chọn nguồn ảnh hàng loạt cho cả công cụ Ảnh và Video."),
    });
  }

  if (hasVoice) {
    entries.push({
      id: "auto-voice",
      dateLabel: "19/11/2026",
      badge: "MỚI",
      title: t("Ra mắt Giọng nói AI, Lồng tiếng phụ đề (.SRT) & Kho giọng nhân bản"),
      detail: t("Chuyển văn bản & file phụ đề .SRT sang 30 ngôn ngữ, kèm lưu giọng nhân bản miễn phí vào kho cá nhân để tái sử dụng nhanh."),
    });
  }

  if (has4kVideo) {
    entries.push({
      id: "auto-up4k",
      dateLabel: "19/11/2026",
      badge: "4K",
      title: t("Bổ sung Nâng cấp Video 4K (4K Fast · 4K Pro · 4K Max)"),
      detail: t("Nâng độ nét video 480p/720p/1080p lên chuẩn 4K sắc nét, hỗ trợ cả kiểu Trung thực và Sáng tạo, giữ nguyên âm thanh gốc."),
    });
  }

  if (hasCinema) {
    entries.push({
      id: "auto-cinema",
      dateLabel: "11/2026",
      badge: "CINEMA",
      title: t("Cập nhật tổ hợp Video AI Điện Ảnh thế hệ mới"),
      detail: t("Vận hành ổn định các dòng Kling 4.0, Google Veo 3.1, MiniMax H3, Wan 3.0, Grok Imagine 1.5, FLUX 3 Max và Motion Control."),
    });
  }

  if (hasImage4k) {
    entries.push({
      id: "auto-img4k",
      dateLabel: "11/2026",
      badge: "STUDIO",
      title: t("Đồng bộ Studio Tạo & Chỉnh sửa Ảnh AI chuẩn 2K – 4K"),
      detail: t("Hỗ trợ Nano Banana 2.1, Gemini 3 Pro Image, GPT Image 2.6, Seedream 5.5, Grok Imagine 2.0 và FLUX 3 kèm ghép ảnh tham chiếu."),
    });
  }

  entries.push({
    id: "auto-guarantee",
    dateLabel: t("Cam kết 24/7"),
    badge: "BẢO VỆ VÍ",
    title: t("Tự động cập nhật giá & hoàn tiền 100% khi đơn lỗi"),
    detail: t("Bảng giá hiển thị trực tiếp theo thời gian thực. Mọi tác vụ bị từ chối hoặc gián đoạn xử lý đều được hệ thống hoàn tiền tự động vào ví."),
  });

  return entries;
}

/** Khớp chính xác công thức `AiService.applyUserDiscount` phía API (làm tròn đồng gần nhất, tối thiểu 1đ khi gốc > 0) */
function applyDiscountPrice(baseCredits: number, discountPct: number): number {
  if (baseCredits <= 0 || discountPct <= 0) return baseCredits;
  if (discountPct >= 100) return 0;
  return Math.max(1, Math.round(baseCredits * (1 - discountPct / 100)));
}

function formatHeadlinePrice(
  tool: AiTool,
  bd: AiToolPriceBreakdown | undefined,
  discountPct: number,
  t: (s: string, p?: Record<string, string | number>) => string,
  fmtPrice: (v: unknown) => string,
): { main: string; baseMain?: string; sub: string } {
  if (tool.pricing.mode === "free" || (bd && bd.minPrice === 0 && bd.maxPrice === 0)) {
    return { main: t("Miễn phí"), sub: t("0đ / lượt sử dụng") };
  }
  if (bd && bd.minPrice !== null && bd.maxPrice !== null) {
    const perUnitSuffix =
      bd.unitLabel === "1.000 ký tự" || bd.unitLabel === "giây"
        ? ` / ${t(bd.unitLabel)}`
        : "";
    const minDisc = applyDiscountPrice(bd.minPrice, discountPct);
    const maxDisc = applyDiscountPrice(bd.maxPrice, discountPct);
    const main =
      minDisc === maxDisc
        ? `${fmtPrice(minDisc)}${perUnitSuffix}`
        : `${fmtPrice(minDisc)} – ${fmtPrice(maxDisc)}${perUnitSuffix}`;
    const baseMain =
      discountPct > 0
        ? bd.minPrice === bd.maxPrice
          ? `${fmtPrice(bd.minPrice)}${perUnitSuffix}`
          : `${fmtPrice(bd.minPrice)} – ${fmtPrice(bd.maxPrice)}${perUnitSuffix}`
        : undefined;
    const choiceCount = bd.tables?.length
      ? bd.tables.reduce((sum, tb) => sum + tb.rows.reduce((rs, r) => rs + r.prices.filter((p) => p !== null).length, 0), 0)
      : bd.items.length;
    const sub =
      choiceCount > 1
        ? t("Chi tiết {n} lựa chọn bên dưới", { n: choiceCount })
        : bd.unitLabel
          ? t("Tính theo {u}", { u: t(bd.unitLabel) })
          : t("Giá niêm yết cố định");
    return { main, baseMain, sub };
  }
  const fallback = pricingText(tool, t, fmtPrice);
  const sub =
    "unitLabel" in tool.pricing && tool.pricing.unitLabel
      ? t("Tính theo {u}", { u: t(tool.pricing.unitLabel) })
      : t("Theo cấu hình chọn");
  return { main: fallback, sub };
}

function ServiceOptionBreakdown({
  bd,
  discountPct,
  showAll,
  t,
  fmtPrice,
}: {
  bd: AiToolPriceBreakdown;
  discountPct: number;
  showAll: boolean;
  t: (s: string, p?: Record<string, string | number>) => string;
  fmtPrice: (v: unknown) => string;
}) {
  const [tabIdx, setTabIdx] = useState(0);
  const [localOpen, setLocalOpen] = useState<boolean | null>(null);
  const isExpanded = localOpen ?? showAll;

  const tables = bd.tables ?? [];
  if (tables.length > 0) {
    const safeIdx = Math.min(tabIdx, tables.length - 1);
    const activeTable = tables[safeIdx];
    const totalCells = tables.reduce(
      (sum, tb) => sum + tb.rows.reduce((rs, r) => rs + r.prices.filter((p) => p !== null).length, 0),
      0,
    );

    if (!isExpanded) {
      return (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-dashed pt-2.5">
          {bd.items.map((it, idx) => {
            const disc = applyDiscountPrice(it.price, discountPct);
            return (
              <span
                key={`${it.label}-${idx}`}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/35 px-2.5 py-1 text-xs"
              >
                <span className="text-muted-foreground">{t(it.label)}:</span>
                <span className={cn("font-semibold tabular-nums", discountPct > 0 && it.price > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
                  {it.price === 0 ? t("Miễn phí") : fmtPrice(disc)}
                </span>
                {discountPct > 0 && it.price > disc && (
                  <span className="text-[10.5px] text-muted-foreground/65 line-through tabular-nums">{fmtPrice(it.price)}</span>
                )}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setLocalOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-primary/10"
          >
            <Table2 className="size-3.5" />
            {t("Xem đủ {n} mức giá", { n: totalCells })}
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      );
    }

    return (
      <div className="mt-3 space-y-2 border-t border-dashed pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {tables.length > 1 ? (
              <div className="flex flex-wrap items-center gap-1">
                {tables.map((tb, idx) => (
                  <button
                    key={`${tb.title ?? idx}-${idx}`}
                    type="button"
                    onClick={() => setTabIdx(idx)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                      safeIdx === idx
                        ? "border-foreground bg-foreground text-background"
                        : "bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(tb.title || `Nhóm ${idx + 1}`)}
                  </button>
                ))}
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Table2 className="size-3.5 text-primary" />
                {t("Bảng giá chi tiết từng độ phân giải & thời lượng")}
              </span>
            )}
            {discountPct > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-bold text-emerald-700 dark:text-emerald-300">
                <BadgePercent className="size-3" />
                {t("Đã giảm -{n}%", { n: discountPct })}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setLocalOpen(false)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {t("Thu gọn")}
            <ChevronUp className="size-3.5" />
          </button>
        </div>

        <div className="studio-scroll overflow-x-auto rounded-2xl border bg-background/70">
          <table className="w-full min-w-[360px] border-collapse text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                  {t(activeTable.rowHeader || "Độ phân giải")}
                </th>
                {activeTable.columns.map((col) => (
                  <th key={col} className="px-2.5 py-2 text-right font-semibold whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {activeTable.rows.map((row) => (
                <tr key={row.label} className="transition hover:bg-muted/25">
                  <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{t(row.label)}</td>
                  {row.prices.map((p, cIdx) => {
                    const disc = p !== null ? applyDiscountPrice(p, discountPct) : null;
                    return (
                      <td
                        key={`${row.label}-${activeTable.columns[cIdx]}`}
                        className="px-2.5 py-2 text-right font-semibold whitespace-nowrap tabular-nums"
                      >
                        {p === null || disc === null ? (
                          <span className="font-normal text-muted-foreground/45">—</span>
                        ) : p === 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400">{t("Miễn phí")}</span>
                        ) : discountPct > 0 && p > disc ? (
                          <div className="leading-tight">
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">{fmtPrice(disc)}</span>
                            <span className="block text-[10px] font-normal text-muted-foreground/65 line-through">{fmtPrice(p)}</span>
                          </div>
                        ) : (
                          fmtPrice(p)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {bd.note && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="size-3 shrink-0 text-primary/80" />
            <span>{t(bd.note)}</span>
          </p>
        )}
      </div>
    );
  }

  if (!bd.items.length) return null;

  return (
    <div className="mt-2.5 space-y-1.5 border-t border-dashed pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {bd.items.map((it, idx) => {
          const disc = applyDiscountPrice(it.price, discountPct);
          return (
            <span
              key={`${it.label}-${idx}`}
              className="inline-flex items-center gap-1.5 rounded-xl border bg-background/80 px-2.5 py-1 text-xs shadow-2xs"
            >
              <span className="text-muted-foreground">{t(it.label)}:</span>
              <span className={cn("font-bold tabular-nums", discountPct > 0 && it.price > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
                {it.price === 0 ? t("Miễn phí") : fmtPrice(disc)}
                {it.unit ? (
                  <span className="font-normal text-muted-foreground"> / {t(it.unit)}</span>
                ) : null}
              </span>
              {discountPct > 0 && it.price > disc && (
                <span className="text-[10.5px] text-muted-foreground/65 line-through tabular-nums">{fmtPrice(it.price)}</span>
              )}
            </span>
          );
        })}
      </div>
      {bd.note && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Info className="size-3 shrink-0 text-primary/80" />
          <span>{t(bd.note)}</span>
        </p>
      )}
    </div>
  );
}

export function ServicePricingView() {
  const { t, fmt } = useI18n();
  const { status: authStatus, user } = useAuth();
  const authed = authStatus === "authenticated";
  const credits = useCredits(authed);
  const toolsQuery = useAiTools();
  const cats = useCategories();
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "maintenance">("all");
  const [expandAllMatrices, setExpandAllMatrices] = useState<boolean>(true);
  const [showBaseOnly, setShowBaseOnly] = useState<boolean>(false);
  const [adminPreviewDiscount, setAdminPreviewDiscount] = useState<number | null>(null);

  const userDiscount = authed
    ? Math.max(0, Math.min(100, Number(credits.data?.pricing?.customDiscount ?? 0)))
    : 0;
  const isAdminViewer = authed && canOpenAdmin(user);
  const activeDiscount = adminPreviewDiscount !== null ? adminPreviewDiscount : userDiscount;
  const effectiveDiscount = showBaseOnly ? 0 : activeDiscount;

  const matrixQuery = useQuery({
    queryKey: ["public", "ai", "price-matrix"],
    queryFn: () => api.get<Record<string, AiToolPriceBreakdown>>("/public/ai/tools/price-matrix", undefined, { auth: false }),
    staleTime: 2 * 60_000,
    meta: { silentError: true },
  });

  const popularQuery = useQuery({
    queryKey: ["public", "ai", "popular"],
    queryFn: () => api.get<PopularRow[]>("/public/ai/tools/popular", undefined, { auth: false }),
    staleTime: 2 * 60_000,
    meta: { silentError: true },
  });

  const announcementsQuery = useQuery({
    queryKey: ["public", "announcements", authStatus === "authenticated"],
    queryFn: () => api.get<AnnouncementItem[]>("/account/announcements", undefined, { auth: authStatus === "authenticated" }),
    staleTime: 2 * 60_000,
    retry: false,
    meta: { silentError: true },
  });

  const tools = useMemo(() => toolsQuery.data ?? [], [toolsQuery.data]);
  const matrixMap = useMemo(() => matrixQuery.data ?? {}, [matrixQuery.data]);
  const usesMap = useMemo(() => new Map((popularQuery.data ?? []).map((r) => [r.key, r.uses])), [popularQuery.data]);

  const stats = useMemo(() => {
    const total = tools.length;
    const maintenance = tools.filter((x) => x.maintenance).length;
    const online = Math.max(0, total - maintenance);
    const catKeys = new Set(tools.map((x) => x.category));
    const totalUses = (popularQuery.data ?? []).reduce((s, r) => s + (Number(r.uses) || 0), 0);
    return { total, online, maintenance, categories: catKeys.size, totalUses };
  }, [tools, popularQuery.data]);

  const activeCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of tools) {
      counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
    }
    return cats.list
      .filter((c) => counts.has(c.key))
      .map((c) => ({ ...c, count: counts.get(c.key) ?? 0 }));
  }, [cats.list, tools]);

  const filteredByCat = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const filtered = tools.filter((tool) => {
      if (catFilter !== "all" && tool.category !== catFilter) return false;
      if (statusFilter === "online" && tool.maintenance) return false;
      if (statusFilter === "maintenance" && !tool.maintenance) return false;
      if (!kw) return true;
      const bd = matrixMap[tool.key];
      const optLabels = bd ? [...bd.items.map((i) => i.label), ...(bd.tables ?? []).flatMap((tb) => [tb.title ?? "", ...tb.columns, ...tb.rows.map((r) => r.label)])].join(" ") : "";
      const hay = `${tool.name} ${tool.modelLabel ?? ""} ${tool.group ?? ""} ${tool.description ?? ""} ${tool.key} ${optLabels}`.toLowerCase();
      return hay.includes(kw);
    });

    const grouped = new Map<string, AiTool[]>();
    for (const tool of filtered) {
      const arr = grouped.get(tool.category) ?? [];
      arr.push(tool);
      grouped.set(tool.category, arr);
    }

    const orderedKeys = [
      ...cats.list.map((c) => c.key).filter((k) => grouped.has(k)),
      ...[...grouped.keys()].filter((k) => !cats.list.some((c) => c.key === k)),
    ];

    return orderedKeys.map((key) => {
      const cat = cats.of(key);
      const list = [...(grouped.get(key) ?? [])].sort((a, b) => {
        if (Boolean(a.maintenance) !== Boolean(b.maintenance)) return a.maintenance ? 1 : -1;
        const ua = usesMap.get(a.key) ?? 0;
        const ub = usesMap.get(b.key) ?? 0;
        if (ub !== ua) return ub - ua;
        return priceRank(a) - priceRank(b);
      });
      return { key, cat, list };
    });
  }, [tools, search, catFilter, statusFilter, cats, usesMap, matrixMap]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const fromAnnouncements: TimelineEntry[] = (announcementsQuery.data ?? []).slice(0, 12).map((a) => ({
      id: `ann-${a.id}`,
      dateLabel: formatShortDate(a.createdAt),
      badge: t(a.pinned ? "GHIM" : "CẬP NHẬT"),
      pinned: a.pinned,
      title: a.title?.trim() ? t(a.title.trim()) : t("Thông báo hệ thống"),
      detail: t(a.content.trim()),
    }));
    const autoItems = buildAutoSystemTimeline(tools, t);
    return [...fromAnnouncements, ...autoItems];
  }, [announcementsQuery.data, tools, t]);

  return (
    <div className="space-y-6 pt-2 pb-8">
      {/* Thanh chuyển nhanh Bảng giá dịch vụ <-> Nạp tiền vào ví */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border bg-card p-1 text-sm shadow-xs">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 font-semibold text-background shadow">
            <Coins className="size-3.5 text-amber-400" />
            {t("Bảng giá dịch vụ")}
          </span>
          <Link
            href="/pricing"
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 font-medium text-muted-foreground transition hover:text-foreground"
          >
            <CreditCard className="size-3.5" />
            {t("Nạp tiền vào ví")}
          </Link>
        </div>

        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          {t("Đồng bộ bảng giá & trạng thái trực tiếp 24/7")}
        </div>
      </div>

      {/* Tiêu đề trang */}
      <div className="rounded-3xl border bg-gradient-to-br from-card via-card to-muted/40 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {t("Bảng giá chi tiết từng lựa chọn dịch vụ AI")}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("Tra cứu rõ ràng đơn giá của từng độ phân giải (720p, 1080p, 2K, 4K), từng mốc thời lượng giây, chế độ âm thanh và từng phân khúc giọng đọc AI theo thời gian thực.")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href="/pricing"
              className="inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background shadow-sm transition hover:opacity-90"
            >
              <CreditCard className="size-4" />
              {t("Nạp tiền ngay")}
            </Link>
            <Link
              href="/dashboard"
              className="inline-flex h-10 items-center gap-2 rounded-full border bg-background px-4 text-sm font-semibold transition hover:bg-muted"
            >
              <Sparkles className="size-4 text-amber-500" />
              {t("Vào Studio")}
            </Link>
          </div>
        </div>

        {/* 4 ô thống kê tổng quan */}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl border bg-background/80 p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("Dịch vụ hoạt động")}</span>
              <Activity className="size-4 text-emerald-500" />
            </div>
            <div className="mt-1.5 text-xl font-bold tabular-nums sm:text-2xl">
              {stats.online}
              <span className="text-sm font-medium text-muted-foreground"> / {stats.total}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              {stats.maintenance > 0
                ? t("{n} dịch vụ đang bảo trì", { n: stats.maintenance })
                : t("100% dịch vụ trực tuyến ổn định")}
            </p>
          </div>

          <div className="rounded-2xl border bg-background/80 p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("Chuyên mục AI")}</span>
              <Layers className="size-4 text-sky-500" />
            </div>
            <div className="mt-1.5 text-xl font-bold tabular-nums sm:text-2xl">{stats.categories}</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t("Video, Ảnh, Sửa ảnh, Motion, 4K, Voice")}</p>
          </div>

          <div className="rounded-2xl border bg-background/80 p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("Lượt tạo 30 ngày")}</span>
              <Flame className="size-4 text-orange-500" />
            </div>
            <div className="mt-1.5 text-xl font-bold tabular-nums sm:text-2xl">
              {stats.totalUses.toLocaleString("vi-VN")}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t("Thống kê vận hành thực tế trên web")}</p>
          </div>

          <div className="rounded-2xl border bg-background/80 p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("Bảo vệ số dư")}</span>
              <ShieldCheck className="size-4 text-primary" />
            </div>
            <div className="mt-1.5 text-base font-bold sm:text-lg">{t("Hoàn tiền 100%")}</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t("Tự động hoàn ví ngay nếu đơn lỗi")}</p>
          </div>
        </div>

        {/* Khung thông báo & chuyển đổi bảng giá chiết khấu riêng của khách (T-311) */}
        {(userDiscount > 0 || isAdminViewer) && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-xs">
                <BadgePercent className="size-4" />
              </span>
              <div className="min-w-0">
                {userDiscount > 0 && adminPreviewDiscount === null ? (
                  <>
                    <div className="text-sm font-bold text-emerald-800 dark:text-emerald-200">
                      {t("Tài khoản của bạn đang được giảm {n}% trên toàn bộ dịch vụ AI", { n: userDiscount })}
                    </div>
                    <p className="text-xs text-emerald-700/90 dark:text-emerald-300/85">
                      {t("Toàn bộ mức giá chi tiết bên dưới đã được tính sẵn mức giảm -{n}% (kèm giá niêm yết gạch ngang để đối chiếu).", { n: userDiscount })}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-bold text-emerald-800 dark:text-emerald-200">
                      {activeDiscount > 0
                        ? t("Đang xem trước bảng giá chiết khấu khách -{n}%", { n: activeDiscount })
                        : t("Xem thử bảng giá theo % chiết khấu khách hàng")}
                    </div>
                    <p className="text-xs text-emerald-700/90 dark:text-emerald-300/85">
                      {t("Khách có mức giảm riêng (vd 5%, 10%...) khi đăng nhập sẽ tự động thấy sẵn bảng giá đã giảm tương ứng.")}
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {userDiscount > 0 && adminPreviewDiscount === null && (
                <div className="inline-flex rounded-full border border-emerald-500/30 bg-background/90 p-1 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setShowBaseOnly(false)}
                    className={cn(
                      "h-7.5 rounded-full px-3 transition",
                      !showBaseOnly ? "bg-emerald-600 text-white shadow-2xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t("Bảng giá của bạn (-{n}%)", { n: userDiscount })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBaseOnly(true)}
                    className={cn(
                      "h-7.5 rounded-full px-3 transition",
                      showBaseOnly ? "bg-foreground text-background shadow-2xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t("Giá niêm yết gốc")}
                  </button>
                </div>
              )}

              {isAdminViewer && (
                <div className="flex flex-wrap items-center gap-1 rounded-full border border-emerald-500/30 bg-background/90 p-1 text-xs">
                  {([null, 5, 10, 15, 20] as const).map((pct) => {
                    const selected =
                      pct === null
                        ? adminPreviewDiscount === null
                        : adminPreviewDiscount === pct;
                    return (
                      <button
                        key={pct === null ? "auto" : pct}
                        type="button"
                        onClick={() => {
                          setShowBaseOnly(false);
                          setAdminPreviewDiscount(pct);
                        }}
                        className={cn(
                          "h-7 rounded-full px-2.5 font-semibold transition",
                          selected
                            ? "bg-emerald-600 text-white shadow-2xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {pct === null
                          ? userDiscount > 0
                            ? `${t("Của tôi")} (-${userDiscount}%)`
                            : t("Giá gốc")
                          : `-${pct}%`}
                      </button>
                    );
                  })}
                  <label className="inline-flex items-center gap-1 pr-2 pl-1.5 text-[11px] text-muted-foreground">
                    <span>{t("Khác:")}</span>
                    <input
                      type="number"
                      min={0}
                      max={99}
                      placeholder="%"
                      value={adminPreviewDiscount !== null && ![5, 10, 15, 20].includes(adminPreviewDiscount) ? adminPreviewDiscount : ""}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        setShowBaseOnly(false);
                        if (!raw) {
                          setAdminPreviewDiscount(null);
                          return;
                        }
                        const n = Math.max(0, Math.min(99, Number(raw)));
                        if (Number.isFinite(n)) setAdminPreviewDiscount(n);
                      }}
                      className="h-6 w-12 rounded-md border bg-background px-1.5 text-center text-xs font-semibold text-foreground outline-none focus:border-emerald-500"
                    />
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bố cục 2 cột: Trái = Bảng giá chi tiết · Phải = Timeline cập nhật */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_350px]">
        {/* Cột trái: Bộ lọc + Bảng giá các dịch vụ */}
        <div className="min-w-0 space-y-5">
          {/* Thanh tìm kiếm & lọc */}
          <div className="space-y-3 rounded-3xl border bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("Tìm kiếm dịch vụ / model / cấu hình (Seedance, Kling, Veo, Gemini, 4K, 1080p, Giọng nói...)")}
                  className="h-10 w-full rounded-full border bg-background pr-4 pl-10 text-sm outline-none focus:border-foreground/40"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex h-10 shrink-0 items-center rounded-full border bg-background p-1 text-xs font-medium">
                  {(
                    [
                      ["all", t("Tất cả")],
                      ["online", t("Hoạt động")],
                      ["maintenance", t("Bảo trì")],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setStatusFilter(k)}
                      className={cn(
                        "h-8 rounded-full px-3 transition",
                        statusFilter === k ? "bg-foreground font-semibold text-background" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setExpandAllMatrices((v) => !v)}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border bg-background px-3.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                >
                  <Table2 className="size-3.5 text-primary" />
                  {expandAllMatrices ? t("Thu gọn bảng Video") : t("Mở toàn bộ bảng Video")}
                </button>
              </div>
            </div>

            {/* Lọc theo chuyên mục */}
            <div className="studio-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
              <button
                type="button"
                onClick={() => setCatFilter("all")}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition",
                  catFilter === "all" ? "border-foreground bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {t("Tất cả")} ({tools.length})
              </button>
              {activeCategories.map((c) => {
                const CatIcon = c.icon;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setCatFilter(c.key)}
                    className={cn(
                      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition",
                      catFilter === c.key ? "border-foreground bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <CatIcon className="size-3.5" />
                    {t(c.label)} ({c.count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Danh sách bảng giá theo từng chuyên mục */}
          {toolsQuery.isLoading ? (
            <div className="rounded-3xl border bg-card p-10 text-center text-sm text-muted-foreground">
              {t("Đang tải bảng giá dịch vụ trực tiếp...")}
            </div>
          ) : filteredByCat.length === 0 ? (
            <div className="rounded-3xl border bg-card p-10 text-center text-sm text-muted-foreground">
              {t("Không tìm thấy dịch vụ nào khớp bộ lọc hiện tại.")}
            </div>
          ) : (
            filteredByCat.map(({ key, cat, list }) => (
              <section key={key} className="overflow-hidden rounded-3xl border bg-card shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/25 px-4 py-3.5 sm:px-5">
                  <div className="flex items-center gap-2.5">
                    <span className={cn("inline-flex size-8 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-xs", cat.art)}>
                      <cat.icon className="size-4" />
                    </span>
                    <div>
                      <h2 className="text-base font-bold leading-tight">{t(cat.label)}</h2>
                      <p className="text-xs text-muted-foreground">{t("{n} dịch vụ trong chuyên mục", { n: list.length })}</p>
                    </div>
                  </div>
                </div>

                <div className="divide-y">
                  {list.map((tool) => {
                    const logo = modelLogoOf(tool.modelLabel || tool.name);
                    const uses = usesMap.get(tool.key) ?? 0;
                    const bd = matrixMap[tool.key];
                    const headline = formatHeadlinePrice(tool, bd, effectiveDiscount, t, fmt.price);
                    return (
                      <div key={tool.key} className="px-4 py-4 transition hover:bg-muted/15 sm:px-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            {logo ? (
                              <span className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl border bg-white p-1.5 shadow-2xs dark:border-white/15">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={logo} alt="" className="size-6 object-contain" />
                              </span>
                            ) : (
                              <span className={cn("mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white", cat.art)}>
                                <ToolIcon name={tool.icon} className="size-4" />
                              </span>
                            )}
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Link href={toolHref(tool.key)} className="text-sm font-semibold hover:text-primary hover:underline">
                                  {t(tool.modelLabel || tool.name)}
                                </Link>
                                {tool.badge && (
                                  <span
                                    className={cn(
                                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                                      /hot/i.test(tool.badge)
                                        ? "bg-rose-500 text-white"
                                        : /miễn phí|free/i.test(tool.badge)
                                          ? "bg-emerald-500 text-white"
                                          : "bg-foreground text-background",
                                    )}
                                  >
                                    {t(tool.badge)}
                                  </span>
                                )}
                                {tool.group && (
                                  <span className="rounded-full border bg-muted/50 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                                    {t(tool.group)}
                                  </span>
                                )}
                              </div>
                              {tool.description && (
                                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t(tool.description)}</p>
                              )}
                              <div className="mt-1 flex flex-wrap items-center gap-2.5 text-[11px]">
                                {tool.maintenance ? (
                                  <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                                    <Wrench className="size-3" /> {t("Đang bảo trì")}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle2 className="size-3" /> {t("Đang hoạt động")}
                                  </span>
                                )}
                                {uses > 0 && (
                                  <span className="text-muted-foreground">
                                    · {t("{n} lượt tạo gần đây", { n: uses.toLocaleString("vi-VN") })}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center justify-between gap-3 border-t pt-2.5 sm:border-t-0 sm:pt-0">
                            <div className="text-left sm:text-right">
                              <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                                <span
                                  className={cn(
                                    "text-sm font-bold tabular-nums",
                                    effectiveDiscount > 0 && headline.baseMain && headline.baseMain !== headline.main
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-foreground",
                                  )}
                                >
                                  {headline.main}
                                </span>
                                {effectiveDiscount > 0 && headline.baseMain && headline.baseMain !== headline.main && (
                                  <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                                    -{effectiveDiscount}%
                                  </span>
                                )}
                              </div>
                              {effectiveDiscount > 0 && headline.baseMain && headline.baseMain !== headline.main && (
                                <div className="text-[11px] text-muted-foreground/70 line-through tabular-nums">{headline.baseMain}</div>
                              )}
                              <div className="text-[11px] text-muted-foreground">{headline.sub}</div>
                            </div>
                            <Link
                              href={toolHref(tool.key)}
                              className={cn(
                                "inline-flex h-8.5 items-center gap-1 rounded-full border px-3.5 text-xs font-semibold transition",
                                tool.maintenance
                                  ? "text-muted-foreground hover:bg-muted"
                                  : "border-foreground/15 bg-foreground text-background hover:opacity-90",
                              )}
                            >
                              {t("Dùng ngay")}
                              <ArrowRight className="size-3.5" />
                            </Link>
                          </div>
                        </div>

                        {bd ? (
                          <ServiceOptionBreakdown bd={bd} discountPct={effectiveDiscount} showAll={expandAllMatrices} t={t} fmtPrice={fmt.price} />
                        ) : matrixQuery.isLoading ? (
                          <div className="mt-2.5 flex gap-2 border-t border-dashed pt-2.5">
                            <span className="h-6 w-28 animate-pulse rounded-lg bg-muted/50" />
                            <span className="h-6 w-28 animate-pulse rounded-lg bg-muted/50" />
                            <span className="h-6 w-28 animate-pulse rounded-lg bg-muted/50" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        {/* Cột phải (Sticky): Timeline cập nhật dịch vụ & bảng tin */}
        <aside className="rounded-3xl border bg-card p-4 shadow-sm sm:p-5 lg:sticky lg:top-20">
          <div className="flex items-center justify-between gap-2 border-b pb-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Clock className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-bold leading-tight">{t("Timeline cập nhật dịch vụ")}</h2>
                <p className="text-[11px] text-muted-foreground">{t("Lịch sử nâng cấp model & bảng giá")}</p>
              </div>
            </div>
            <Megaphone className="size-4 text-muted-foreground" />
          </div>

          <div className="studio-scroll relative mt-4 max-h-[75dvh] space-y-4 overflow-y-auto pr-1">
            <div className="pointer-events-none absolute top-2 bottom-2 left-[9px] w-px bg-border" />
            {timeline.map((item, idx) => (
              <div key={item.id} className="relative pl-6">
                <span
                  className={cn(
                    "absolute top-1.5 left-0 inline-flex size-[19px] items-center justify-center rounded-full border-2 bg-card",
                    idx === 0 || item.pinned
                      ? "border-emerald-500 text-emerald-500"
                      : item.badge === "BẢO TRÌ"
                        ? "border-amber-500 text-amber-500"
                        : "border-muted-foreground/40",
                  )}
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      idx === 0 || item.pinned
                        ? "bg-emerald-500"
                        : item.badge === "BẢO TRÌ"
                          ? "bg-amber-500"
                          : "bg-muted-foreground/50",
                    )}
                  />
                </span>
                <div className="rounded-2xl border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                    <span className="font-medium text-muted-foreground">{item.dateLabel}</span>
                    {item.badge && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                          item.badge === "BẢO TRÌ"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : item.pinned
                              ? "bg-primary/15 text-primary"
                              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                        )}
                      >
                        {item.pinned && <Pin className="size-2.5" />}
                        {t(item.badge)}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1 text-[13px] font-semibold leading-snug text-foreground">{t(item.title)}</h3>
                  <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{t(item.detail)}</p>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
