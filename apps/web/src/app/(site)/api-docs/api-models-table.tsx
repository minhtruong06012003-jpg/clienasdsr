"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BadgePercent, ChevronDown, ChevronRight, ChevronUp, Info, Layers, ListFilter, Search, Server, Table2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/provider";
import { useCredits } from "@/lib/queries";
import { canOpenAdmin } from "@/lib/site";
import { cn } from "@/lib/utils";
import { type ApiModel, modelHref } from "./docs-ui";

function applyDiscountPrice(baseCredits: number, discountPct: number): number {
  if (baseCredits <= 0 || discountPct <= 0) return baseCredits;
  if (discountPct >= 100) return 0;
  return Math.max(1, Math.round(baseCredits * (1 - discountPct / 100)));
}

function serverSortOrder(serverId?: string): number {
  if (!serverId) return 999;
  const n = Number(serverId.replace(/^sv/i, ""));
  return Number.isFinite(n) ? n : 999;
}

function minNumericPrice(m: ApiModel): number {
  const pr = m.pricing;
  if (pr.mode === "free" || (pr.min_price === 0 && pr.max_price === 0)) return 0;
  if (typeof pr.min_price === "number" && pr.min_price >= 0) return pr.min_price;
  if (typeof pr.base === "number" && pr.base > 0) return pr.base;
  if (typeof pr.tier10to20 === "number" && pr.tier10to20 > 0) return pr.tier10to20;
  return Number.MAX_SAFE_INTEGER;
}

function formatApiModelHeadline(
  m: ApiModel,
  discountPct: number,
  t: (s: string, p?: Record<string, string | number>) => string,
  fmtPrice: (v: unknown) => string,
): { main: string; baseMain?: string; sub?: string } {
  const pr = m.pricing;
  if (pr.mode === "free" || (pr.min_price === 0 && pr.max_price === 0)) {
    return { main: t("Miễn phí") };
  }
  if (typeof pr.min_price === "number" && typeof pr.max_price === "number") {
    const suffix =
      pr.unit === "1.000 ký tự" || pr.unit === "giây"
        ? ` / ${t(pr.unit)}`
        : "";
    const minD = applyDiscountPrice(pr.min_price, discountPct);
    const maxD = applyDiscountPrice(pr.max_price, discountPct);
    const main = minD === maxD ? `${fmtPrice(minD)}${suffix}` : `${fmtPrice(minD)} – ${fmtPrice(maxD)}${suffix}`;
    const baseMain =
      discountPct > 0
        ? pr.min_price === pr.max_price
          ? `${fmtPrice(pr.min_price)}${suffix}`
          : `${fmtPrice(pr.min_price)} – ${fmtPrice(pr.max_price)}${suffix}`
        : undefined;
    return { main, baseMain };
  }
  if (pr.mode === "tiers") {
    const t1 = applyDiscountPrice(pr.tier10to20 ?? pr.base ?? 0, discountPct);
    const t2 = applyDiscountPrice(pr.tier20to30 ?? 0, discountPct);
    return { main: `10–20s: ${fmtPrice(t1)} · 20–30s: ${fmtPrice(t2)}` };
  }
  if (pr.mode === "fixed") {
    const parts: string[] = [];
    if (pr.base) parts.push(fmtPrice(applyDiscountPrice(pr.base, discountPct)));
    if (pr.per_unit) parts.push(`${fmtPrice(applyDiscountPrice(pr.per_unit, discountPct))} / ${pr.unit ? t(pr.unit) : t("đơn vị")}`);
    return { main: parts.join(" + ") || t("Miễn phí") };
  }
  return { main: t("Theo tham số") };
}

function ServerStatusDot({ status }: { status?: "healthy" | "maintenance" }) {
  const isMaint = status === "maintenance";
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        isMaint ? "bg-amber-500" : "bg-emerald-500",
      )}
    />
  );
}

function BreakdownBlock({
  m,
  discountPct,
  expanded,
  onToggle,
}: {
  m: ApiModel;
  discountPct: number;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const { t, fmt } = useI18n();
  const [tabIdx, setTabIdx] = useState(0);
  const tables = m.pricing.tables ?? [];
  const items = m.pricing.items ?? [];

  if (tables.length > 0) {
    const safeIdx = Math.min(tabIdx, tables.length - 1);
    const activeTable = tables[safeIdx];
    const totalCells = tables.reduce(
      (sum, tb) => sum + tb.rows.reduce((rs, r) => rs + r.prices.filter((p) => p !== null).length, 0),
      0,
    );

    if (!expanded && onToggle) {
      return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {items.slice(0, 4).map((it, idx) => {
            const disc = applyDiscountPrice(it.price, discountPct);
            return (
              <span key={`${it.label}-${idx}`} className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 px-2 py-0.5 text-[11px]">
                <span className="text-muted-foreground">{t(it.label)}:</span>
                <span className={cn("font-semibold tabular-nums", discountPct > 0 && it.price > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
                  {it.price === 0 ? t("Miễn phí") : fmt.price(disc)}
                </span>
                {discountPct > 0 && it.price > disc && (
                  <span className="text-[10px] text-muted-foreground/60 line-through tabular-nums">{fmt.price(it.price)}</span>
                )}
              </span>
            );
          })}
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-primary/10"
          >
            <Table2 className="size-3" />
            {t("Xem đủ {n} mức giá", { n: totalCells })}
            <ChevronDown className="size-3" />
          </button>
        </div>
      );
    }

    return (
      <div className="mt-2.5 space-y-2 rounded-xl border bg-muted/15 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {tables.length > 1 ? (
              tables.map((tb, idx) => (
                <button
                  key={`${tb.title ?? idx}-${idx}`}
                  type="button"
                  onClick={() => setTabIdx(idx)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition",
                    safeIdx === idx
                      ? "border-foreground bg-foreground text-background"
                      : "bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(tb.title || `Nhóm ${idx + 1}`)}
                </button>
              ))
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                <Table2 className="size-3.5 text-primary" />
                {t("Bảng giá chi tiết từng độ phân giải & thời lượng")}
              </span>
            )}
            {discountPct > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                <BadgePercent className="size-3" />
                {t("Đã giảm -{n}%", { n: discountPct })}
              </span>
            )}
          </div>
          {onToggle && (
            <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
              {t("Thu gọn")} <ChevronUp className="size-3" />
            </button>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full min-w-[340px] border-collapse text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-semibold whitespace-nowrap">{t(activeTable.rowHeader || "Độ phân giải")}</th>
                {activeTable.columns.map((col) => (
                  <th key={col} className="px-2.5 py-1.5 text-right font-semibold whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {activeTable.rows.map((row) => (
                <tr key={row.label} className="hover:bg-muted/20">
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{t(row.label)}</td>
                  {row.prices.map((p, cIdx) => {
                    const disc = p !== null ? applyDiscountPrice(p, discountPct) : null;
                    return (
                      <td key={`${row.label}-${activeTable.columns[cIdx]}`} className="px-2.5 py-1.5 text-right font-semibold whitespace-nowrap tabular-nums">
                        {p === null || disc === null ? (
                          <span className="font-normal text-muted-foreground/45">—</span>
                        ) : p === 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400">{t("Miễn phí")}</span>
                        ) : discountPct > 0 && p > disc ? (
                          <div className="leading-tight">
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">{fmt.price(disc)}</span>
                            <span className="block text-[10px] font-normal text-muted-foreground/60 line-through">{fmt.price(p)}</span>
                          </div>
                        ) : (
                          fmt.price(p)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {m.pricing.note && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="size-3 shrink-0 text-primary" />
            <span>{t(m.pricing.note)}</span>
          </p>
        )}
      </div>
    );
  }

  if (!items.length) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((it, idx) => {
          const disc = applyDiscountPrice(it.price, discountPct);
          return (
            <span key={`${it.label}-${idx}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/35 px-2.5 py-1 text-[11.5px]">
              <span className="text-muted-foreground">{t(it.label)}:</span>
              <span className={cn("font-bold tabular-nums", discountPct > 0 && it.price > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
                {it.price === 0 ? t("Miễn phí") : fmt.price(disc)}
                {it.unit ? <span className="font-normal text-muted-foreground"> / {t(it.unit)}</span> : null}
              </span>
              {discountPct > 0 && it.price > disc && (
                <span className="text-[10px] text-muted-foreground/60 line-through tabular-nums">{fmt.price(it.price)}</span>
              )}
            </span>
          );
        })}
      </div>
      {m.pricing.note && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Info className="size-3 shrink-0 text-primary" />
          <span>{t(m.pricing.note)}</span>
        </p>
      )}
    </div>
  );
}

function DiscountBanner({
  userDiscount,
  isAdminViewer,
  showBaseOnly,
  setShowBaseOnly,
  adminPreviewDiscount,
  setAdminPreviewDiscount,
}: {
  userDiscount: number;
  isAdminViewer: boolean;
  showBaseOnly: boolean;
  setShowBaseOnly: (v: boolean) => void;
  adminPreviewDiscount: number | null;
  setAdminPreviewDiscount: (v: number | null) => void;
}) {
  const { t } = useI18n();
  const activeDiscount = adminPreviewDiscount !== null ? adminPreviewDiscount : userDiscount;
  if (userDiscount <= 0 && !isAdminViewer) return null;

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-white">
          <BadgePercent className="size-4" />
        </span>
        <div className="min-w-0 text-xs">
          {userDiscount > 0 && adminPreviewDiscount === null ? (
            <>
              <div className="font-bold text-emerald-800 dark:text-emerald-200">
                {t("Tài khoản API của bạn đang được giảm {n}% trên toàn bộ model", { n: userDiscount })}
              </div>
              <p className="text-emerald-700/90 dark:text-emerald-300/85">
                {t("Toàn bộ mức giá từng lựa chọn bên dưới đã trừ sẵn -{n}% (khớp 100% số tiền trừ khi gọi POST /v1/generations).", { n: userDiscount })}
              </p>
            </>
          ) : (
            <>
              <div className="font-bold text-emerald-800 dark:text-emerald-200">
                {activeDiscount > 0
                  ? t("Đang xem trước bảng giá chiết khấu khách -{n}%", { n: activeDiscount })
                  : t("Xem thử bảng giá theo % chiết khấu khách hàng")}
              </div>
              <p className="text-emerald-700/90 dark:text-emerald-300/85">
                {t("Khách đấu API có mức giảm riêng (vd 5%, 10%...) khi đăng nhập sẽ tự động thấy sẵn bảng giá đã giảm.")}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {userDiscount > 0 && adminPreviewDiscount === null && (
          <div className="inline-flex rounded-full border border-emerald-500/30 bg-background/90 p-0.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setShowBaseOnly(false)}
              className={cn(
                "h-7 rounded-full px-2.5 transition",
                !showBaseOnly ? "bg-emerald-600 text-white" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("Bảng giá của bạn (-{n}%)", { n: userDiscount })}
            </button>
            <button
              type="button"
              onClick={() => setShowBaseOnly(true)}
              className={cn(
                "h-7 rounded-full px-2.5 transition",
                showBaseOnly ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("Giá niêm yết gốc")}
            </button>
          </div>
        )}

        {isAdminViewer && (
          <div className="flex flex-wrap items-center gap-1 rounded-full border border-emerald-500/30 bg-background/90 p-0.5 text-xs">
            {([null, 5, 10, 15, 20] as const).map((pct) => {
              const selected = pct === null ? adminPreviewDiscount === null : adminPreviewDiscount === pct;
              return (
                <button
                  key={pct === null ? "auto" : pct}
                  type="button"
                  onClick={() => {
                    setShowBaseOnly(false);
                    setAdminPreviewDiscount(pct);
                  }}
                  className={cn(
                    "h-6.5 rounded-full px-2.5 font-semibold transition",
                    selected ? "bg-emerald-600 text-white" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {pct === null ? (userDiscount > 0 ? `${t("Của tôi")} (-${userDiscount}%)` : t("Giá gốc")) : `-${pct}%`}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

type ModelGroupRow = {
  canon: string;
  displayName: string;
  output: string;
  servers: ApiModel[];
};

/** Bảng danh sách toàn bộ model trong `/api-docs#model-list` theo cấu trúc chuẩn `Model -> Server (SV)` */
export function ApiModelsCatalog({ models }: { models: ApiModel[] }) {
  const { t, fmt } = useI18n();
  const { status: authStatus, user } = useAuth();
  const authed = authStatus === "authenticated";
  const credits = useCredits(authed);
  const [search, setSearch] = useState("");
  const [outFilter, setOutFilter] = useState<string>("all");
  const [serverFilter, setServerFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grouped" | "flat">("grouped");
  const [selectedServerByCanon, setSelectedServerByCanon] = useState<Record<string, string>>({});
  const [expandAll, setExpandAll] = useState<boolean>(true);
  const [localOpen, setLocalOpen] = useState<Record<string, boolean>>({});
  const [showBaseOnly, setShowBaseOnly] = useState(false);
  const [adminPreviewDiscount, setAdminPreviewDiscount] = useState<number | null>(null);

  const userDiscount = authed ? Math.max(0, Math.min(100, Number(credits.data?.pricing?.customDiscount ?? 0))) : 0;
  const isAdminViewer = authed && canOpenAdmin(user);
  const activeDiscount = adminPreviewDiscount !== null ? adminPreviewDiscount : userDiscount;
  const effectiveDiscount = showBaseOnly ? 0 : activeDiscount;

  const allServers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const m of models) {
      if (!m.server_id || !m.server_name) continue;
      const cur = map.get(m.server_id);
      if (cur) cur.count += 1;
      else map.set(m.server_id, { id: m.server_id, name: m.server_name, count: 1 });
    }
    return [...map.values()].sort((a, b) => serverSortOrder(a.id) - serverSortOrder(b.id));
  }, [models]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return models.filter((m) => {
      if (outFilter !== "all" && m.output !== outFilter) return false;
      if (serverFilter !== "all" && m.server_id !== serverFilter) return false;
      if (!kw) return true;
      const hay = `${m.id} ${m.canonical_model ?? ""} ${m.server_id ?? ""} ${m.server_name ?? ""} ${m.name} ${m.type} ${m.output} ${m.params.map((p) => p.name).join(" ")}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [models, search, outFilter, serverFilter]);

  const groupedRows = useMemo<ModelGroupRow[]>(() => {
    const map = new Map<string, ApiModel[]>();
    for (const m of filtered) {
      const canon = m.canonical_model || m.id;
      const list = map.get(canon) ?? [];
      list.push(m);
      map.set(canon, list);
    }
    return [...map.entries()].map(([canon, list]) => {
      const sorted = [...list].sort((a, b) => {
        const aMaint = a.server_status === "maintenance" ? 1 : 0;
        const bMaint = b.server_status === "maintenance" ? 1 : 0;
        if (aMaint !== bMaint) return aMaint - bMaint;
        const pa = minNumericPrice(a);
        const pb = minNumericPrice(b);
        if (pa !== pb) return pa - pb;
        return serverSortOrder(a.server_id) - serverSortOrder(b.server_id);
      });
      const primary = sorted[0];
      const cleanName =
        (primary.name || "").split(/\s[·•|]\s|\s[-–—]\s|\s?\(/)[0]?.trim() || primary.name;
      return {
        canon,
        displayName: cleanName,
        output: primary.output,
        servers: sorted,
      };
    });
  }, [filtered]);

  const outputs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models) counts.set(m.output, (counts.get(m.output) ?? 0) + 1);
    return ["image", "video", "audio", "text"].filter((k) => counts.has(k)).map((k) => ({ key: k, count: counts.get(k) ?? 0 }));
  }, [models]);

  return (
    <div className="space-y-4">
      <DiscountBanner
        userDiscount={userDiscount}
        isAdminViewer={isAdminViewer}
        showBaseOnly={showBaseOnly}
        setShowBaseOnly={setShowBaseOnly}
        adminPreviewDiscount={adminPreviewDiscount}
        setAdminPreviewDiscount={setAdminPreviewDiscount}
      />

      {/* Thanh tìm kiếm + chế độ hiển thị Model -> Server */}
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Tìm model / server SV / tham số (seedream-5.5, sv15, seedance, kling, veo...)")}
            className="h-9.5 w-full rounded-full border bg-card pr-4 pl-9 text-xs outline-none focus:border-foreground/40"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-full border bg-muted/40 p-0.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setViewMode("grouped")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-3 transition",
                viewMode === "grouped" ? "bg-foreground text-background shadow-2xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Layers className="size-3.5" />
              {t("Model → Server")} ({groupedRows.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("flat")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-3 transition",
                viewMode === "flat" ? "bg-foreground text-background shadow-2xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListFilter className="size-3.5" />
              {t("Tất cả Route")} ({filtered.length})
            </button>
          </div>

          {allServers.length > 0 && (
            <select
              value={serverFilter}
              onChange={(e) => setServerFilter(e.target.value)}
              className="h-8 rounded-full border bg-card px-3 text-xs font-semibold text-foreground outline-none focus:border-foreground/40"
              aria-label={t("Lọc theo Server")}
            >
              <option value="all">{t("Tất cả Server (SV)")}</option>
              {allServers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.count})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Bộ lọc loại kết quả + đóng/mở bảng giá */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOutFilter("all")}
            className={cn(
              "h-8 rounded-full border px-3 text-xs font-semibold transition",
              outFilter === "all" ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {t("Tất cả")} ({models.length})
          </button>
          {outputs.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setOutFilter(o.key)}
              className={cn(
                "h-8 rounded-full border px-3 font-mono text-xs font-semibold transition",
                outFilter === o.key ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {o.key} ({o.count})
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setLocalOpen({});
            setExpandAll((v) => !v);
          }}
          className="inline-flex h-8 items-center gap-1 rounded-full border bg-card px-3 text-xs font-semibold text-foreground transition hover:bg-muted"
        >
          <Table2 className="size-3.5 text-primary" />
          {expandAll ? t("Thu gọn bảng giá") : t("Mở toàn bộ bảng giá")}
        </button>
      </div>

      <div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-2xs">
        {viewMode === "grouped" ? (
          groupedRows.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">{t("Không tìm thấy model nào khớp từ khoá.")}</div>
          ) : (
            groupedRows.map((g) => {
              const selectedRouteId = selectedServerByCanon[g.canon];
              const activeModel = g.servers.find((s) => s.id === selectedRouteId) ?? g.servers[0];
              const headline = formatApiModelHeadline(activeModel, effectiveDiscount, t, fmt.price);
              const isRowExpanded = localOpen[g.canon] ?? expandAll;
              const healthyCount = g.servers.filter((s) => s.server_status !== "maintenance").length;

              return (
                <div key={g.canon} className="p-4 transition hover:bg-muted/10">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={modelHref(activeModel.id)}
                          className="inline-flex items-center gap-0.5 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-bold text-primary hover:underline"
                        >
                          {g.canon} <ChevronRight className="size-3.5" />
                        </Link>
                        <span className="text-sm font-semibold text-foreground">{t(g.displayName)}</span>
                        <span className="rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">{g.output}</span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
                          <Server className="size-3" />
                          {healthyCount}/{g.servers.length} SV {t("sống")}
                        </span>
                      </div>

                      {/* Thanh chọn Server SV trực quan ngay dưới Model */}
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] font-semibold text-muted-foreground">{t("Chọn Server:")}</span>
                        {g.servers.map((sv) => {
                          const isSelected = sv.id === activeModel.id;
                          const isMaint = sv.server_status === "maintenance";
                          const svMin = minNumericPrice(sv);
                          const svMinDisc = svMin < Number.MAX_SAFE_INTEGER ? applyDiscountPrice(svMin, effectiveDiscount) : null;
                          const dupCount = g.servers.filter((x) => x.server_id === sv.server_id).length;
                          const subVariant =
                            dupCount > 1
                              ? /1080p/i.test(sv.id)
                                ? "1080p"
                                : /720p/i.test(sv.id)
                                  ? "720p"
                                  : sv.id.includes("/")
                                    ? sv.id.split("/")[1]
                                    : sv.id !== g.canon
                                      ? sv.id.replace(`${g.canon}-`, "")
                                      : null
                              : null;
                          return (
                            <button
                              key={sv.id}
                              type="button"
                              onClick={() => setSelectedServerByCanon((prev) => ({ ...prev, [g.canon]: sv.id }))}
                              title={`${sv.server_name ?? "SV"} · ${sv.name} · route: ${sv.id} · ${isMaint ? "maintenance" : "healthy"}`}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition",
                                isSelected
                                  ? "border-primary bg-primary/10 text-primary shadow-2xs"
                                  : isMaint
                                    ? "border-amber-500/35 bg-amber-500/5 text-amber-700 opacity-80 hover:opacity-100 dark:text-amber-300"
                                    : "bg-background text-foreground hover:bg-muted",
                              )}
                            >
                              <ServerStatusDot status={sv.server_status} />
                              <span className="font-mono font-bold">
                                {sv.server_name ?? sv.server_id?.toUpperCase() ?? "SV"}
                                {subVariant ? ` · ${subVariant}` : ""}
                              </span>
                              {isMaint ? (
                                <span className="text-[10px] font-medium">({t("Bảo trì")})</span>
                              ) : svMinDisc !== null ? (
                                <span className="font-normal text-muted-foreground tabular-nums">
                                  {svMinDisc === 0 ? t("Miễn phí") : `${t("từ")} ${fmt.price(svMinDisc)}`}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                        <span>
                          API payload:{" "}
                          <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                            {`{"model": "${g.canon}", "server": "${activeModel.server_id ?? "auto"}"}`}
                          </code>
                        </span>
                        {activeModel.id !== g.canon && (
                          <span>
                            route_id: <code className="rounded bg-muted px-1 py-0.5">{activeModel.id}</code>
                          </span>
                        )}
                      </div>

                      <div className="font-mono text-[11px] text-muted-foreground">
                        params ({activeModel.server_name ?? "SV"}): {activeModel.params.length ? activeModel.params.map((p) => p.name).join(", ") : "—"}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-between gap-3 sm:text-right">
                      <div>
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
                          <div className="text-[11px] text-muted-foreground/65 line-through tabular-nums">{headline.baseMain}</div>
                        )}
                      </div>
                      <Link
                        href={modelHref(activeModel.id)}
                        className="inline-flex h-8 items-center gap-1 rounded-full border bg-background px-3 text-xs font-semibold transition hover:bg-muted"
                      >
                        {t("Chi tiết API")} ({activeModel.server_name ?? "SV"})
                        <ChevronRight className="size-3.5" />
                      </Link>
                    </div>
                  </div>

                  <BreakdownBlock
                    m={activeModel}
                    discountPct={effectiveDiscount}
                    expanded={isRowExpanded}
                    onToggle={() => setLocalOpen((prev) => ({ ...prev, [g.canon]: !isRowExpanded }))}
                  />
                </div>
              );
            })
          )
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">{t("Không tìm thấy model nào khớp từ khoá.")}</div>
        ) : (
          filtered.map((m) => {
            const headline = formatApiModelHeadline(m, effectiveDiscount, t, fmt.price);
            const isRowExpanded = localOpen[m.id] ?? expandAll;
            const isMaint = m.server_status === "maintenance";
            return (
              <div key={m.id} className="p-4 transition hover:bg-muted/10">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={modelHref(m.id)}
                        className="inline-flex items-center gap-0.5 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-bold text-primary hover:underline"
                      >
                        {m.id} <ChevronRight className="size-3.5" />
                      </Link>
                      {m.server_name && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold",
                            isMaint
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          )}
                        >
                          <ServerStatusDot status={m.server_status} />
                          {m.server_name} · {isMaint ? "maintenance" : "healthy"}
                        </span>
                      )}
                      <span className="text-sm font-semibold text-foreground">{t(m.name)}</span>
                      <span className="rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">{m.output}</span>
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {m.canonical_model ? `canonical_model: ${m.canonical_model} · server: "${m.server_id}" · ` : ""}
                      params: {m.params.length ? m.params.map((p) => p.name).join(", ") : "—"}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center justify-between gap-3 sm:text-right">
                    <div>
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
                        <div className="text-[11px] text-muted-foreground/65 line-through tabular-nums">{headline.baseMain}</div>
                      )}
                    </div>
                    <Link
                      href={modelHref(m.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-full border bg-background px-3 text-xs font-semibold transition hover:bg-muted"
                    >
                      {t("Chi tiết API")}
                      <ChevronRight className="size-3.5" />
                    </Link>
                  </div>
                </div>

                <BreakdownBlock
                  m={m}
                  discountPct={effectiveDiscount}
                  expanded={isRowExpanded}
                  onToggle={() => setLocalOpen((prev) => ({ ...prev, [m.id]: !isRowExpanded }))}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Khung bảng giá chi tiết từng lựa chọn tham số trên trang riêng của 1 model (`/api-docs/models/[...id]`) */
export function ApiModelPricingCard({ model }: { model: ApiModel }) {
  const { t, fmt } = useI18n();
  const { status: authStatus, user } = useAuth();
  const authed = authStatus === "authenticated";
  const credits = useCredits(authed);
  const [showBaseOnly, setShowBaseOnly] = useState(false);
  const [adminPreviewDiscount, setAdminPreviewDiscount] = useState<number | null>(null);

  const userDiscount = authed ? Math.max(0, Math.min(100, Number(credits.data?.pricing?.customDiscount ?? 0))) : 0;
  const isAdminViewer = authed && canOpenAdmin(user);
  const activeDiscount = adminPreviewDiscount !== null ? adminPreviewDiscount : userDiscount;
  const effectiveDiscount = showBaseOnly ? 0 : activeDiscount;
  const headline = formatApiModelHeadline(model, effectiveDiscount, t, fmt.price);

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-2xs sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">{t("Bảng giá API chi tiết theo từng cấu hình tham số")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("Đơn giá thực tế (VNĐ) trừ vào ví khi gọi POST /v1/generations (hoặc kiểm tra trước qua POST /v1/generations/estimate).")}
          </p>
        </div>
        <div className="text-right">
          <div className={cn("text-base font-bold tabular-nums", effectiveDiscount > 0 && headline.baseMain ? "text-emerald-600 dark:text-emerald-400" : "text-primary")}>
            {headline.main}
          </div>
          {effectiveDiscount > 0 && headline.baseMain && headline.baseMain !== headline.main && (
            <div className="text-xs text-muted-foreground line-through tabular-nums">{headline.baseMain}</div>
          )}
        </div>
      </div>

      <DiscountBanner
        userDiscount={userDiscount}
        isAdminViewer={isAdminViewer}
        showBaseOnly={showBaseOnly}
        setShowBaseOnly={setShowBaseOnly}
        adminPreviewDiscount={adminPreviewDiscount}
        setAdminPreviewDiscount={setAdminPreviewDiscount}
      />

      <BreakdownBlock m={model} discountPct={effectiveDiscount} expanded />
    </div>
  );
}
