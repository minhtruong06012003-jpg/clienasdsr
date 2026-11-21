"use client";

/**
 * Trang chủ & Tổng quan phong cách ShopClone7 (`d:\Downloads\well-known`):
 * 1. Khung thông báo hệ thống đầu trang (`account-card` ghim từ Bảng tin nếu có).
 * 2. Hàng 4 thẻ công cụ nhanh nổi bật màu gradient (`widget_tools.php` `box-product-main`).
 * 3. Lưới 2 cột chuẩn ShopClone7 (`col-xl-9` Trái + `col-xl-3` Phải):
 *    - Cột trái: Dãy nút lọc chuyên mục `.btn-category-home` + các khối chuyên mục `.home-heading` + lưới 2 cột thẻ sản phẩm `.feature-card` (viền nét đứt, hover viền xanh + đổ bóng, logo model, mô tả `» ...`, nhãn trạng thái, giá đỏ đậm và nút gradient `DÙNG NGAY`).
 *    - Cột phải (dính khi cuộn): Thẻ Ví & Tài khoản `.card-wallet-home` (`Số dư hiện tại`, 3 ô xám `.wallet-card` hover đổi màu xanh giống hệt `wallet.css`, nút `+ NẠP TIỀN NGAY` / `ĐĂNG NHẬP` + `ĐĂNG KÝ`) và danh sách Tác phẩm AI gần đây.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronsRight,
  CreditCard,
  History,
  Layers,
  LogIn,
  Megaphone,
  Play,
  Search,
  ShoppingBag,
  Sparkles,
  UserPlus,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { ViewportVideo } from "@/components/ai/viewport-video";
import { useAuth } from "@/lib/auth";
import { useAiTools, useBalance, useCategories, useCredits } from "@/lib/queries";
import {
  type AiCategoryRaw,
  groupsOf,
  isMonoModelLogo,
  mergeModelGroups,
  modelLogoOf,
  pricingText,
  promptOf,
  toolId,
  toolLink,
  ToolIcon,
} from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import type { AiTool, CommunityTask, Paginated } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useShopCloneFilter } from "./shopclone-shell";

interface Announcement {
  id: string;
  title: string | null;
  content: string;
  pinned: boolean;
  createdAt: string;
}

const QUICK_GRADIENTS = [
  "linear-gradient(90deg, #431D7A 0%, #7146AD 100%)",
  "linear-gradient(90deg, #0E5A8A 0%, #1F8ECD 100%)",
  "linear-gradient(90deg, #126B40 0%, #1DB968 100%)",
  "linear-gradient(90deg, #9A3412 0%, #EA580C 100%)",
];

export function ShopCloneHome({
  initialTools,
  initialCategories,
}: {
  initialTools?: AiTool[];
  initialCategories?: AiCategoryRaw[];
}) {
  return (
    <Suspense fallback={<ShopCloneHomeInner initialTools={initialTools} initialCategories={initialCategories} />}>
      <ShopCloneHomeWithParams initialTools={initialTools} initialCategories={initialCategories} />
    </Suspense>
  );
}

function ShopCloneHomeWithParams({
  initialTools,
  initialCategories,
}: {
  initialTools?: AiTool[];
  initialCategories?: AiCategoryRaw[];
}) {
  const sp = useSearchParams();
  const filter = useShopCloneFilter();
  const qParam = sp.get("q") ?? "";
  const catParam = sp.get("cat") ?? "";

  useEffect(() => {
    if (qParam && filter) filter.setKeyword(qParam);
    if (catParam && filter) filter.setSelectedCategory(catParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, catParam]);

  return <ShopCloneHomeInner initialTools={initialTools} initialCategories={initialCategories} />;
}

function ShopCloneHomeInner({
  initialTools,
  initialCategories,
}: {
  initialTools?: AiTool[];
  initialCategories?: AiCategoryRaw[];
}) {
  const { t, fmt } = useI18n();
  const { status } = useAuth();
  const authed = status === "authenticated";

  const toolsQuery = useAiTools(initialTools);
  const catsQuery = useCategories(initialCategories);
  const filter = useShopCloneFilter();

  const keyword = (filter?.keyword ?? "").trim();
  const selectedCat = filter?.selectedCategory ?? "all";
  const setSelectedCat = filter?.setSelectedCategory ?? (() => {});
  const setKeyword = filter?.setKeyword ?? (() => {});

  const rawTools = toolsQuery.data ?? [];
  const mergedTools = useMemo(() => mergeModelGroups(rawTools), [rawTools]);

  // Đếm số model con trong mỗi nhóm model để hiện trên thẻ giống "Kho hàng / Model" của ShopClone
  const modelCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of rawTools) {
      for (const g of groupsOf(item)) {
        m.set(g, (m.get(g) ?? 0) + 1);
      }
    }
    return m;
  }, [rawTools]);

  const categoriesWithTools = useMemo(
    () =>
      catsQuery.list
        .map((c) => ({
          ...c,
          tools: mergedTools.filter((x) => x.category === c.key),
        }))
        .filter((c) => c.tools.length > 0),
    [catsQuery.list, mergedTools],
  );

  const visibleSections = useMemo(() => {
    const kw = keyword.toLowerCase();
    return categoriesWithTools
      .filter((c) => selectedCat === "all" || c.key === selectedCat)
      .map((c) => ({
        ...c,
        tools: kw
          ? c.tools.filter(
              (x) =>
                x.name.toLowerCase().includes(kw) ||
                (x.description ?? "").toLowerCase().includes(kw) ||
                x.key.toLowerCase().includes(kw),
            )
          : c.tools,
      }))
      .filter((c) => c.tools.length > 0);
  }, [categoriesWithTools, selectedCat, keyword]);

  // 4 thẻ công cụ nhanh đầu trang kiểu widget_tools.php
  const quickCards = useMemo(() => {
    return categoriesWithTools.slice(0, 4).map((c, idx) => ({
      key: c.key,
      title: t(c.label),
      subtitle: t("{n} công cụ sẵn sàng", { n: c.tools.length }),
      icon: c.icon,
      gradient: QUICK_GRADIENTS[idx % QUICK_GRADIENTS.length],
    }));
  }, [categoriesWithTools, t]);

  return (
    <div className="space-y-5">
      {/* 1. Thông báo ghim đầu trang (khi đã đăng nhập & có thông báo từ Admin) */}
      {authed && <TopAnnouncementCard />}

      {/* 2. Hàng 4 thẻ công cụ nổi bật kiểu widget_tools.php của ShopClone7 */}
      {quickCards.length > 0 && (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          {quickCards.map((card) => {
            const Icon = card.icon || Video;
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => {
                  setSelectedCat(card.key);
                  document.getElementById("sc-products")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                style={{ background: card.gradient }}
                className="group flex h-[92px] w-full items-center rounded-xl px-4 text-left text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <span className="mr-3.5 inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white text-zinc-900 shadow-[0_4px_6px_rgba(0,0,0,0.20)] transition group-hover:scale-105">
                  <Icon className="size-7 text-[var(--sc-primary)]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-bold tracking-tight">{card.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-white/85">{card.subtitle}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 3. Bố cục 2 cột chuẩn ShopClone7: Cột trái sản phẩm (9/12) + Cột phải Số dư Ví (3/12) */}
      <div id="sc-products" className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_315px]">
        {/* CỘT TRÁI: Nút lọc chuyên mục + Danh sách công cụ theo từng chuyên mục */}
        <div className="min-w-0 space-y-5">
          {/* Thanh nút lọc danh mục kiểu `.custom-button-list` / `.btn-category-home` */}
          <div className="rounded-xl border border-zinc-200/90 bg-white p-3 shadow-[0_2px_8px_rgba(0,0,0,0.05)] dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedCat("all")}
                style={
                  selectedCat === "all"
                    ? { background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }
                    : undefined
                }
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-[13px] font-bold transition",
                  selectedCat === "all"
                    ? "text-white shadow-xs"
                    : "bg-[#2f343b] text-white hover:bg-[#454c56] dark:bg-zinc-800 dark:hover:bg-zinc-700",
                )}
              >
                <ShoppingBag className="size-3.5" />
                {t("Tất cả dịch vụ")} ({mergedTools.length})
              </button>

              {categoriesWithTools.map((c) => {
                const active = selectedCat === c.key;
                const Icon = c.icon;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setSelectedCat(c.key)}
                    style={
                      active
                        ? { background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }
                        : undefined
                    }
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-[13px] font-semibold transition",
                      active
                        ? "text-white shadow-xs"
                        : "bg-[#2f343b] text-white hover:bg-[#454c56] dark:bg-zinc-800 dark:hover:bg-zinc-700",
                    )}
                  >
                    <Icon className="size-3.5 opacity-90" />
                    <span>{t(c.label)}</span>
                  </button>
                );
              })}
            </div>

            {/* Ô lọc nhanh trên mobile hoặc hiển thị đang lọc từ khoá */}
            <div className="mt-2.5 flex items-center gap-2 md:hidden">
              <div className="flex flex-1 items-center rounded-lg border bg-[#f5f5f5] px-3 dark:border-zinc-700 dark:bg-zinc-800">
                <Search className="mr-2 size-4 text-zinc-400" />
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder={t("Tìm nhanh tên công cụ AI...")}
                  className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
                {keyword && (
                  <button type="button" onClick={() => setKeyword("")} className="text-zinc-400">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            {keyword && (
              <div className="mt-2.5 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <span>
                  {t("Kết quả tìm kiếm cho từ khoá:")} <b className="text-red-600 dark:text-red-400">&ldquo;{keyword}&rdquo;</b>
                </span>
                <button type="button" onClick={() => setKeyword("")} className="font-semibold underline">
                  {t("Xoá lọc")}
                </button>
              </div>
            )}
          </div>

          {/* Danh sách chuyên mục & Thẻ sản phẩm 2 cột kiểu ShopClone7 */}
          {toolsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-36 animate-pulse rounded-lg border bg-white dark:bg-zinc-900" />
              ))}
            </div>
          ) : visibleSections.length === 0 ? (
            <div className="rounded-xl border bg-white p-10 text-center shadow-2xs dark:bg-zinc-900">
              <WandSparkles className="mx-auto size-10 text-zinc-300 dark:text-zinc-600" />
              <p className="mt-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
                {t("Không tìm thấy công cụ AI nào phù hợp.")}
              </p>
              {(keyword || selectedCat !== "all") && (
                <button
                  type="button"
                  onClick={() => {
                    setKeyword("");
                    setSelectedCat("all");
                  }}
                  style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
                  className="mt-3 inline-flex h-9 items-center rounded-md px-4 text-xs font-bold text-white"
                >
                  {t("Xem toàn bộ dịch vụ")}
                </button>
              )}
            </div>
          ) : (
            visibleSections.map((sec) => {
              const CatIcon = sec.icon;
              return (
                <section key={sec.key} className="space-y-3">
                  {/* Thanh tiêu đề chuyên mục `.home-heading h3` */}
                  <div
                    style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
                    className="flex items-center justify-between rounded-[10px] px-4 py-2.5 text-white shadow-[3px_4px_8px_rgba(0,0,0,0.18)]"
                  >
                    <h2 className="flex items-center gap-2.5 text-base font-bold uppercase tracking-wide sm:text-[17px]">
                      <span className="inline-flex size-7 items-center justify-center rounded-lg bg-white/20">
                        <CatIcon className="size-4 text-white" />
                      </span>
                      {t(sec.label)}
                    </h2>
                    <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-bold">
                      {sec.tools.length} {t("dịch vụ")}
                    </span>
                  </div>

                  {/* Lưới thẻ sản phẩm 2 cột `.feature-card` */}
                  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    {sec.tools.map((item) => (
                      <ShopCloneToolCard
                        key={toolId(item)}
                        tool={item}
                        catLabel={t(sec.label)}
                        modelCount={item.group ? (modelCountMap.get(item.group) ?? 1) : 1}
                        fmtPrice={fmt.price}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        {/* CỘT PHẢI: Khung Số dư Ví `.card-wallet-home` + Hoạt động cộng đồng gần đây */}
        <aside className="space-y-5 xl:sticky xl:top-24">
          <WalletSidebarCard />
          <RecentCommunityCard />
        </aside>
      </div>
    </div>
  );
}

/** Một thẻ công cụ AI thiết kế chuẩn `.feature-card` của CMSNT ShopClone7 */
function ShopCloneToolCard({
  tool,
  catLabel,
  modelCount,
  fmtPrice,
}: {
  tool: AiTool;
  catLabel: string;
  modelCount: number;
  fmtPrice: (n: unknown) => string;
}) {
  const { t } = useI18n();
  const logo = modelLogoOf(tool.name);
  const href = toolLink(tool);
  const isFree = tool.pricing.mode === "free" || tool.price === 0;
  const priceDisplay =
    typeof tool.price === "number" && tool.price > 0
      ? fmtPrice(tool.price)
      : pricingText(tool, t, fmtPrice);

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between rounded-[8px] border border-dotted border-zinc-400 bg-white p-3.5 transition-all duration-200 hover:border-solid hover:border-[var(--sc-primary)] hover:shadow-[0_8px_18px_rgba(0,0,0,0.09)] dark:border-zinc-700 dark:bg-zinc-900",
        tool.maintenance && "opacity-80",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Ô ảnh vuông bên trái kiểu `BOX_5` */}
        <Link
          href={href}
          className="inline-flex size-13 shrink-0 items-center justify-center rounded-lg border border-zinc-200/80 bg-[#f8f9fa] p-2 shadow-2xs transition group-hover:scale-105 dark:border-zinc-800 dark:bg-zinc-800"
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className={cn("size-8 object-contain", isMonoModelLogo(logo) && "dark:invert")} />
          ) : (
            <ToolIcon name={tool.icon} className="size-6 text-[var(--sc-primary)]" />
          )}
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={href}
              className="text-[15px] font-bold leading-snug text-zinc-900 transition hover:text-[var(--sc-primary)] dark:text-zinc-100"
            >
              {t(tool.name)}
            </Link>
            {tool.maintenance ? (
              <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                {t("Bảo trì")}
              </span>
            ) : (
              tool.badge && (
                <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                  {t(tool.badge)}
                </span>
              )
            )}
          </div>

          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            <ChevronsRight className="mr-0.5 inline size-3.5 -translate-y-0.5 text-[var(--sc-primary)]" />
            {tool.description ? t(tool.description) : t("Công cụ xử lý tự động tốc độ cao trên nền tảng đám mây.")}
          </p>
        </div>
      </div>

      {/* Hàng nhãn Kho hàng / Model + Giá bán + Nút MUA / DÙNG NGAY */}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-2 border-t border-dashed border-zinc-200 pt-2.5 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold",
              tool.maintenance
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
            )}
          >
            {tool.maintenance ? t("Đang bảo trì") : t("Sẵn sàng 24/7")}
          </span>
          {modelCount > 1 ? (
            <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
              <Layers className="size-3" /> {modelCount} model
            </span>
          ) : (
            <span className="inline-flex items-center rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {catLabel}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <div className="text-right">
            <span className="block text-[10px] text-zinc-400">{t("Giá từ")}</span>
            <span
              className={cn(
                "text-[15px] font-bold tabular-nums",
                isFree ? "text-emerald-600 dark:text-emerald-400" : "text-[#e11d48] dark:text-rose-400",
              )}
            >
              {isFree ? t("Miễn phí") : priceDisplay}
            </span>
          </div>

          <Link
            href={href}
            style={
              tool.maintenance
                ? undefined
                : { background: "linear-gradient(181deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }
            }
            className={cn(
              "inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] px-3.5 text-xs font-bold uppercase tracking-wide text-white shadow-2xs transition hover:-translate-y-0.5 hover:shadow-md",
              tool.maintenance && "bg-zinc-400 dark:bg-zinc-700",
            )}
          >
            {tool.maintenance ? t("XEM") : t("DÙNG NGAY")}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Khung Số dư Ví bên phải giống hệt `card-wallet-home` & `wallet.css` của ShopClone7 */
function WalletSidebarCard() {
  const { t, fmt } = useI18n();
  const { status } = useAuth();
  const authed = status === "authenticated";
  const credits = useCredits(authed);
  const wallet = useBalance();

  const currentBalance = credits.data?.credits ?? wallet.balance ?? 0;
  const totalSpentTopup = credits.data?.pricing?.spent ?? 0;
  const totalUsed = credits.data?.totalUsed ?? 0;
  const discount = credits.data?.pricing?.customDiscount ?? 0;
  const concurrency = credits.data?.concurrency ?? 1;

  return (
    <section className="rounded-[8px] bg-white p-5 shadow-[2px_6px_12px_rgba(0,0,0,0.08)] dark:border dark:border-zinc-800 dark:bg-zinc-900">
      {authed ? (
        <>
          <div className="mb-4 text-center">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Số dư hiện tại")}</p>
            <h3
              className="mt-1 text-2xl font-bold tracking-tight tabular-nums sm:text-[26px]"
              style={{ color: "var(--sc-primary)" }}
            >
              {fmt.money(currentBalance)}
            </h3>
          </div>

          <div className="space-y-2.5">
            <div className="group rounded-lg bg-[#f5f5f5] px-4 py-2.5 transition hover:bg-[var(--sc-primary)] dark:bg-zinc-800">
              <p className="text-xs text-zinc-500 transition group-hover:text-white/85">{t("Tổng tiền nạp")}</p>
              <div className="text-sm font-bold tabular-nums text-zinc-900 transition group-hover:text-white dark:text-zinc-100">
                {fmt.money(totalSpentTopup)}
              </div>
            </div>

            <div className="group rounded-lg bg-[#f5f5f5] px-4 py-2.5 transition hover:bg-[var(--sc-primary)] dark:bg-zinc-800">
              <p className="text-xs text-zinc-500 transition group-hover:text-white/85">{t("Số dư đã sử dụng")}</p>
              <div className="text-sm font-bold tabular-nums text-zinc-900 transition group-hover:text-white dark:text-zinc-100">
                {fmt.money(totalUsed)}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="group rounded-lg bg-[#f5f5f5] px-3 py-2.5 transition hover:bg-[var(--sc-primary)] dark:bg-zinc-800">
                <p className="text-[11px] text-zinc-500 transition group-hover:text-white/85">{t("Giảm giá")}</p>
                <div className="text-sm font-bold tabular-nums text-zinc-900 transition group-hover:text-white dark:text-zinc-100">
                  {discount}%
                </div>
              </div>
              <div className="group rounded-lg bg-[#f5f5f5] px-3 py-2.5 transition hover:bg-[var(--sc-primary)] dark:bg-zinc-800">
                <p className="text-[11px] text-zinc-500 transition group-hover:text-white/85">{t("Luồng chạy")}</p>
                <div className="text-sm font-bold tabular-nums text-zinc-900 transition group-hover:text-white dark:text-zinc-100">
                  {concurrency} {t("luồng")}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2">
            <Link
              href="/pricing"
              style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-white shadow-sm transition hover:opacity-95"
            >
              <CreditCard className="size-4" /> {t("Nạp tiền ngay")}
            </Link>
            <Link
              href="/history"
              className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-200 text-xs font-bold text-zinc-700 transition hover:border-[var(--sc-primary)] hover:text-[var(--sc-primary)] dark:border-zinc-700 dark:text-zinc-200"
            >
              <History className="size-3.5" /> {t("Lịch sử đã tạo")}
            </Link>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="text-center">
            <span
              className="mx-auto inline-flex size-11 items-center justify-center rounded-full text-white shadow-sm"
              style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
            >
              <Sparkles className="size-5" />
            </span>
            <h3 className="mt-2 text-base font-bold text-zinc-900 dark:text-zinc-100">
              {t("Tài khoản thành viên")}
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              {t("Đăng nhập để nạp số dư và sử dụng toàn bộ công cụ AI tự động 24/7")}
            </p>
          </div>

          <div className="space-y-2 pt-1">
            <Link
              href="/login"
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#2563eb] text-xs font-bold uppercase tracking-wide text-white shadow-xs transition hover:opacity-95"
            >
              <LogIn className="size-4" /> {t("Đăng nhập")}
            </Link>
            <Link
              href="/register"
              style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-bold uppercase tracking-wide text-white shadow-xs transition hover:opacity-95"
            >
              <UserPlus className="size-4" /> {t("Đăng ký tài khoản")}
            </Link>
          </div>

          <ul className="space-y-1.5 border-t pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> {t("Nạp VietQR & USDT tự động 5 giây")}
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> {t("Tự hoàn tiền 100% nếu tác vụ lỗi")}
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> {t("Số dư vĩnh viễn không hết hạn")}
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}

/** Khung thông báo đầu trang lấy từ Bảng tin `/account/announcements` */
function TopAnnouncementCard() {
  const q = useQuery({
    queryKey: ["announcements", "shopclone"],
    queryFn: () => api.get<Announcement[]>("/account/announcements"),
    staleTime: 2 * 60_000,
    meta: { silentError: true },
  });
  const top = q.data?.[0];
  if (!top) return null;

  return (
    <div className="flex items-start gap-3 rounded-[8px] border-l-4 border-[var(--sc-primary)] bg-white px-4 py-3.5 shadow-[0_2px_10px_rgba(0,0,0,0.06)] dark:bg-zinc-900">
      <Megaphone className="mt-0.5 size-5 shrink-0 text-[var(--sc-primary)]" />
      <div className="min-w-0 flex-1 text-sm">
        {top.title && <div className="font-bold text-zinc-900 dark:text-zinc-100">{top.title}</div>}
        <p className="line-clamp-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{top.content}</p>
      </div>
    </div>
  );
}

/** Khung Tác phẩm Cộng đồng gần đây dưới cột phải (thay cho "Đơn hàng gần đây" của ShopClone7) */
function RecentCommunityCard() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["public", "ai", "community", "shopclone-feed"],
    queryFn: () => api.get<Paginated<CommunityTask>>("/public/ai/community", { limit: 6 }, { auth: false }),
    staleTime: 60_000,
    meta: { silentError: true },
  });
  const items = (q.data?.data ?? []).filter((x) => x.output.files?.length).slice(0, 5);
  if (!items.length) return null;

  return (
    <section className="overflow-hidden rounded-[8px] bg-white shadow-[2px_6px_12px_rgba(0,0,0,0.08)] dark:border dark:border-zinc-800 dark:bg-zinc-900">
      <div
        style={{ background: "linear-gradient(135deg, var(--sc-primary) 0%, var(--sc-primary-dark) 100%)" }}
        className="flex items-center justify-between px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white"
      >
        <span className="flex items-center gap-1.5">
          <Play className="size-3.5 fill-current" /> {t("Tác phẩm vừa tạo")}
        </span>
        <Link href="/community" className="text-[11px] font-semibold underline opacity-90 hover:opacity-100">
          {t("Xem thêm")}
        </Link>
      </div>
      <div className="divide-y divide-zinc-100 p-3 dark:divide-zinc-800">
        {items.map((x) => {
          const f = x.output.files?.[0];
          const prompt = promptOf(x.input);
          return (
            <Link
              key={x.id}
              href="/community"
              className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0 hover:opacity-85"
            >
              <div className="size-11 shrink-0 overflow-hidden rounded-md border bg-black">
                {f?.type === "video" ? (
                  <ViewportVideo src={`${f.url}#t=0.1`} hoverPlay={false} className="size-full object-cover" />
                ) : f?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt="" loading="lazy" className="size-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-bold text-zinc-800 dark:text-zinc-100">
                  {x.tool?.name ? t(x.tool.name) : x.toolKey}
                </div>
                <p className="truncate text-[11px] text-zinc-500">
                  {prompt || `@${x.author || "member"}`}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
