"use client";

/**
 * Lịch sử giao dịch: tab "Ví tiền" (dòng tiền VND, bên dưới) và tab "Sử dụng AI" (credits-history.tsx: nhật ký trừ / hoàn tiền
 * khi chạy công cụ AI — cùng một số dư ví VND, 1 credit cũ = 1đ).
 * Dòng tiền ví:
 * - Thẻ "Dòng tiền" + nút "Xuất file sao kê" (tải CSV tối đa 200 giao dịch gần nhất theo bộ lọc đang chọn).
 * - 4 ô thống kê lấy từ `GET /api/account/wallet`: số dư khả dụng, tổng nạp, tổng thanh toán đơn, hoàn tiền.
 * - Ô tìm kiếm (lọc ngay trên trang đang xem: diễn giải, mã đơn, loại) + ô chọn loại biến động.
 * - Bảng biến động: `GET /api/account/wallet/transactions?type=&page&limit`, chân bảng chọn số bản ghi mỗi trang + phân trang số.
 */
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CreditsHistory } from "./credits-history";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, CreditCard, Download, RotateCcw, Search, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState, PageHeader, Spinner } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { toNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import type { TFunction } from "@/lib/i18n/translate";
import { useWallet } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { Paginated, WalletTransaction } from "@/lib/types";

/** Nhãn loại giao dịch ví (API có thể thêm loại mới — hiển thị nguyên mã) */
const TYPES: Record<string, string> = {
  DEPOSIT: "Tiền vào ví",
  WITHDRAW: "Trừ tiền",
  PAYMENT: "Thanh toán",
  REFUND: "Hoàn tiền",
};
/** Giá trị "tất cả" của ô lọc (Select không nhận value rỗng) */
const ALL = "all";
const FILTERS = [
  { value: ALL, label: "Tất cả biến động" },
  { value: "DEPOSIT", label: "Tiền vào ví" },
  { value: "PAYMENT", label: "Thanh toán" },
  { value: "REFUND", label: "Hoàn tiền" },
  { value: "WITHDRAW", label: "Trừ tiền" },
];
/** Các lựa chọn số bản ghi mỗi trang */
const PAGE_SIZES = [10, 20, 50, 100];

/** Diễn giải một giao dịch: ghi chú, nếu không có thì mã đơn (nhận hàm dịch t) */
const describe = (tx: WalletTransaction, t: TFunction) => tx.note || (tx.order ? t("Đơn {code}", { code: tx.order.code }) : "—");

/** Trang giao dịch (đọc ?tab= nên bọc Suspense) */
export default function TransactionsPage() {
  return (
    <Suspense>
      <TransactionsTabs />
    </Suspense>
  );
}

/** 2 tab: ví tiền (VND) và nhật ký sử dụng AI (?tab=credits, giữ tên tham số cũ) */
function TransactionsTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const tab = params.get("tab") === "credits" ? "credits" : "wallet";
  return (
    <div className="space-y-5 pt-2">
      <div className="inline-flex rounded-2xl border bg-card p-1 text-sm font-semibold">
        {(["wallet", "credits"] as const).map((k) => (
          <button key={k} type="button" onClick={() => router.replace(k === "credits" ? "/transactions?tab=credits" : "/transactions")} className={cn("rounded-xl px-4 py-1.5", tab === k ? "bg-foreground text-background" : "text-muted-foreground")}>
            {k === "wallet" ? t("Ví tiền") : t("Sử dụng AI")}
          </button>
        ))}
      </div>
      {tab === "credits" ? <CreditsHistory /> : <WalletFlow />}
    </div>
  );
}

/** Dòng tiền ví (VND) */
function WalletFlow() {
  const { t, fmt } = useI18n();
  const [type, setType] = useState(ALL);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const wallet = useWallet();
  const apiType = type === ALL ? "" : type;

  const txs = useQuery({
    queryKey: ["wallet", "transactions", apiType, page, limit],
    queryFn: () => api.get<Paginated<WalletTransaction>>("/account/wallet/transactions", { type: apiType, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  // API chưa hỗ trợ tìm kiếm -> lọc theo từ khoá trên các dòng của trang đang xem
  const rows = useMemo(() => {
    const all = txs.data?.data ?? [];
    const k = search.trim().toLowerCase();
    if (!k) return all;
    return all.filter((tx) => [describe(tx, t), tx.order?.code ?? "", TYPES[tx.type] ? t(TYPES[tx.type]) : tx.type, tx.id].some((v) => String(v).toLowerCase().includes(k)));
  }, [txs.data, search, t]);
  const meta = txs.data?.meta;

  /** Xuất sao kê CSV (mở được bằng Excel): tối đa 200 giao dịch mới nhất theo loại đang lọc */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await api.get<Paginated<WalletTransaction>>("/account/wallet/transactions", { type: apiType, page: 1, limit: 200 });
      const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [
        [t("Thời gian"), t("Loại giao dịch"), t("Diễn giải"), t("Biến động"), t("Số dư sau GD")].map(cell).join(","),
        // số tiền trong file giữ dạng số theo tiền gốc để tính toán được trong Excel
        ...res.data.map((tx) => [fmt.dateTime(tx.createdAt), TYPES[tx.type] ? t(TYPES[tx.type]) : tx.type, describe(tx, t), toNumber(tx.amount), toNumber(tx.balanceAfter)].map(cell).join(",")),
      ];
      // thêm BOM để Excel đọc đúng tiếng Việt
      const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `sao-ke-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const w = wallet.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Dòng tiền")}
        icon={<TrendingUp />}
        actions={
          <Button variant="outline" size="sm" className="rounded-xl font-semibold" onClick={exportCsv} disabled={exporting}>
            {exporting ? <Spinner /> : <Download />} {t("Xuất file sao kê")}
          </Button>
        }
      >
        {/* 4 ô thống kê màu theo mẫu */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatBox tone="muted" icon={Wallet} label={t("Số dư khả dụng")} value={w ? fmt.money(w.balance) : undefined} loading={wallet.isLoading} />
          <StatBox tone="success" icon={ArrowUpRight} label={t("Tổng nạp qua thanh toán")} value={w ? `+${fmt.money(w.totalDeposited)}` : undefined} loading={wallet.isLoading} />
          <StatBox tone="danger" icon={CreditCard} label={t("Tổng thanh toán đơn")} value={w ? `−${fmt.money(w.totalSpent)}` : undefined} loading={wallet.isLoading} />
          <StatBox tone="warning" icon={RotateCcw} label={t("Hoàn tiền & điều chỉnh")} value={w ? fmt.money(w.totalRefunded ?? 0) : undefined} loading={wallet.isLoading} />
        </div>
        {/* tìm kiếm + lọc loại biến động */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Tìm theo nội dung, mã đơn hoặc loại giao dịch...")} className="h-10 pl-10 text-sm" />
          </div>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {t(f.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PageHeader>

      {/* thẻ bảng biến động */}
      <section className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        {txs.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : txs.isError ? (
          <ErrorState error={txs.error} onRetry={() => txs.refetch()} />
        ) : (
          <>
            {/* mobile: mỗi giao dịch một dòng gọn */}
            <ul className="divide-y md:hidden">
              {rows.map((tx) => {
                const amount = toNumber(tx.amount);
                const plus = amount >= 0;
                return (
                  <li key={tx.id} className="flex items-start gap-3 px-4 py-3">
                    <TypeIcon plus={plus} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{TYPES[tx.type] ? t(TYPES[tx.type]) : tx.type}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{describe(tx, t)}</p>
                      <p className="mt-0.5 text-[11px] text-subtle-foreground">{fmt.dateTime(tx.createdAt)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn("text-sm font-semibold tabular-nums", plus ? "text-success" : "text-destructive")}>
                        {plus ? "+" : "−"}
                        {fmt.money(Math.abs(amount))}
                      </p>
                      <p className="text-[11px] text-subtle-foreground tabular-nums">{t("Dư: {amount}", { amount: fmt.money(tx.balanceAfter) })}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="hidden md:block">
              <Table className="min-w-[680px]">
                <TableHeader className="bg-muted">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4 text-xs font-semibold">{t("Thời gian")}</TableHead>
                    <TableHead className="text-xs font-semibold">{t("Loại giao dịch")}</TableHead>
                    <TableHead className="text-xs font-semibold">{t("Diễn giải chi tiết")}</TableHead>
                    <TableHead className="text-right text-xs font-semibold">{t("Biến động")}</TableHead>
                    <TableHead className="pr-4 text-right text-xs font-semibold">{t("Số dư sau GD")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((tx) => {
                    const amount = toNumber(tx.amount);
                    const plus = amount >= 0;
                    return (
                      <TableRow key={tx.id}>
                        <TableCell className="pl-4 text-xs whitespace-nowrap text-muted-foreground">{fmt.dateTime(tx.createdAt)}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
                            <TypeIcon plus={plus} small />
                            {TYPES[tx.type] ? t(TYPES[tx.type]) : tx.type}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-sm text-sm whitespace-normal text-muted-foreground">{describe(tx, t)}</TableCell>
                        <TableCell className={cn("text-right font-semibold whitespace-nowrap tabular-nums", plus ? "text-success" : "text-destructive")}>
                          {plus ? "+" : "−"}
                          {fmt.money(Math.abs(amount))}
                        </TableCell>
                        <TableCell className="pr-4 text-right whitespace-nowrap tabular-nums">{fmt.money(tx.balanceAfter)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {!rows.length && (
              <div className="px-4 py-12 text-center">
                <p className="text-sm font-semibold">{t("Không tìm thấy giao dịch phù hợp")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("Thử từ khoá khác hoặc chuyển bộ lọc sang Tất cả biến động.")}</p>
              </div>
            )}
          </>
        )}

        {/* chân bảng: số bản ghi mỗi trang + phân trang số */}
        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("Hiển thị")}
            <Select
              value={String(limit)}
              onValueChange={(v) => {
                setLimit(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger size="sm" className="w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {t("bản ghi mỗi trang")} <span className="text-subtle-foreground">{t("(Tổng {n})", { n: meta?.total ?? 0 })}</span>
          </div>
          <NumberPager page={meta?.page ?? 1} totalPages={Math.max(1, meta?.totalPages ?? 1)} onChange={setPage} />
        </div>
      </section>
    </div>
  );
}

/** Màu từng ô thống kê theo mẫu: muted / xanh lá / đỏ / vàng */
const TONES = {
  muted: { box: "bg-muted border-border", label: "text-muted-foreground", value: "text-foreground", icon: "text-primary" },
  success: { box: "bg-success-soft border-success/25", label: "text-success", value: "text-success", icon: "text-success" },
  danger: { box: "bg-danger-soft border-destructive/25", label: "text-destructive", value: "text-destructive", icon: "text-destructive" },
  warning: { box: "bg-warning-soft border-warning/30", label: "text-warning", value: "text-warning", icon: "text-warning" },
} as const;

/** Một ô thống kê: nhãn nhỏ + icon góc phải, số tiền đậm bên dưới */
function StatBox({ tone, icon: Icon, label, value, loading }: { tone: keyof typeof TONES; icon: LucideIcon; label: string; value?: string; loading?: boolean }) {
  const t = TONES[tone];
  return (
    <div className={cn("rounded-xl border px-3.5 py-3", t.box)}>
      <div className="flex items-start justify-between gap-2">
        <p className={cn("text-[11px] leading-tight", t.label)}>{label}</p>
        <Icon className={cn("size-3.5 shrink-0", t.icon)} />
      </div>
      {loading ? <Skeleton className="mt-2 h-5 w-20" /> : <p className={cn("mt-1.5 truncate font-bold tabular-nums", t.value)}>{value ?? "—"}</p>}
    </div>
  );
}

/** Icon tròn nhỏ báo tiền vào (xanh) / tiền ra (đỏ) */
function TypeIcon({ plus, small }: { plus: boolean; small?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full", small ? "size-6" : "mt-0.5 size-8", plus ? "bg-success-soft text-success" : "bg-danger-soft text-destructive")}>
      {plus ? <ArrowDownLeft className={small ? "size-3.5" : "size-4"} /> : <ArrowUpRight className={small ? "size-3.5" : "size-4"} />}
    </span>
  );
}

/** Phân trang dạng số như mẫu: ‹ 1 2 3 … › (trang đang chọn nền primary) */
function NumberPager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  // các trang hiển thị: đầu, cuối và lân cận trang hiện tại; chỗ trống dùng dấu …
  const pages: (number | "gap")[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== "gap") pages.push("gap");
  }
  const { t } = useI18n();
  const btn = "inline-flex size-8 items-center justify-center rounded-lg text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="flex items-center gap-1 self-end sm:self-auto">
      <button type="button" aria-label={t("Trang trước")} className={cn(btn, "text-muted-foreground hover:bg-muted")} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft className="size-4" />
      </button>
      {pages.map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
            …
          </span>
        ) : (
          <button key={p} type="button" onClick={() => onChange(p)} className={cn(btn, p === page ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
            {p}
          </button>
        ),
      )}
      <button type="button" aria-label={t("Trang sau")} className={cn(btn, "text-muted-foreground hover:bg-muted")} disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
