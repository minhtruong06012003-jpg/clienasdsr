"use client";

/**
 * Nhật ký sử dụng AI (tiền VND trong ví): nạp gói, dùng công cụ AI, hoàn tiền khi lỗi, tặng, admin điều chỉnh
 * (`GET /api/account/credits/transactions`; số dư sau = số dư ví sau giao dịch, 1 credit cũ = 1đ).
 */
import Link from "next/link";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { EmptyState, ErrorState, LoadingBlock, Pager } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useCredits } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { CreditTransaction, Paginated } from "@/lib/types";

const TYPES: Record<CreditTransaction["type"], string> = {
  PURCHASE: "Nạp tiền",
  USAGE: "Dùng công cụ AI",
  REFUND: "Hoàn tiền",
  BONUS: "Tặng",
  ADJUST: "Điều chỉnh",
};

export function CreditsHistory() {
  const { t, fmt } = useI18n();
  const credits = useCredits();
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["credits", "transactions", type, page],
    queryFn: () => api.get<Paginated<CreditTransaction>>("/account/credits/transactions", { type: type || undefined, page, limit: 20 }),
    placeholderData: keepPreviousData,
  });
  const stat = (label: string, value: string) => (
    <div className="rounded-2xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat(t("Số dư"), fmt.money(credits.data?.credits))}
        {stat(t("Đã dùng"), fmt.money(credits.data?.totalUsed))}
        {stat(t("Gói hiện tại"), credits.data?.plan?.active ? credits.data.plan.name : t("Chưa có"))}
        {stat(t("Luồng đồng thời"), String(credits.data?.concurrency ?? "-"))}
      </div>
      <section className="rounded-3xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold">{t("Biến động sử dụng AI")}</h2>
          <select className="h-9 rounded-xl border bg-card px-3 text-[13px]" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
            <option value="">{t("Tất cả")}</option>
            {Object.entries(TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {t(v)}
              </option>
            ))}
          </select>
        </div>
        {q.isLoading ? (
          <LoadingBlock />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.data.length ? (
          <EmptyState icon={<Coins />} title={t("Chưa có biến động")} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Thời gian")}</TableHead>
                    <TableHead>{t("Loại")}</TableHead>
                    <TableHead>{t("Diễn giải")}</TableHead>
                    <TableHead className="text-right">{t("Số tiền")}</TableHead>
                    <TableHead className="text-right">{t("Số dư sau")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.data.map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{new Date(x.createdAt).toLocaleString("vi-VN")}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{t(TYPES[x.type] ?? x.type)}</TableCell>
                      <TableCell className="max-w-[360px] truncate text-[13px]">
                        {x.task ? (
                          <Link href={`/history/${x.task.code}`} className="hover:underline">
                            {x.note}
                          </Link>
                        ) : (
                          x.note
                        )}
                      </TableCell>
                      <TableCell className={cn("text-right font-semibold tabular-nums", x.amount > 0 ? "text-emerald-600" : "text-red-600")}>
                        {x.amount > 0 ? "+" : ""}
                        {fmt.money(x.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt.money(x.balanceAfter)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager page={page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onChange={setPage} />
          </>
        )}
      </section>
    </div>
  );
}
