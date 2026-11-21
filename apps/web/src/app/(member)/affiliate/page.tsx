"use client";

/**
 * Giới thiệu bạn bè: `GET /api/account/affiliate` → link giới thiệu, % hoa hồng, ví hoa hồng (số dư rút được),
 * 3 tab: người được giới thiệu, lịch sử ví hoa hồng (`/account/affiliate/transactions`),
 * yêu cầu rút (`/account/affiliate/payouts`, gửi `POST`, huỷ `POST /:id/cancel`). Style thẻ trắng + bảng của mẫu zsmm.
 */
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Gift, HandCoins, History, Landmark, Link2, Percent, Users, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, EmptyState, ErrorState, PageHeader, Pager, Spinner } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AffiliateInfo, AffiliatePayout, AffiliateTransaction, Paginated } from "@/lib/types";

/** Nhãn loại giao dịch ví hoa hồng (khoá tiếng Việt, dịch qua t()) */
const TXN_LABEL: Record<AffiliateTransaction["type"], string> = {
  COMMISSION: "Hoa hồng",
  REVOKE: "Thu hồi hoa hồng",
  PAYOUT: "Rút hoa hồng",
  PAYOUT_REFUND: "Hoàn yêu cầu rút",
  ADJUST: "Điều chỉnh",
};

/** Nhãn + màu trạng thái yêu cầu rút */
const PAYOUT_STATUS: Record<AffiliatePayout["status"], { label: string; className: string }> = {
  PENDING: { label: "Chờ duyệt", className: "bg-warning-soft text-warning" },
  APPROVED: { label: "Đã duyệt", className: "bg-success-soft text-success" },
  REJECTED: { label: "Từ chối", className: "bg-danger-soft text-destructive" },
  CANCELLED: { label: "Đã huỷ", className: "bg-muted text-muted-foreground" },
};

export default function AffiliatePage() {
  const { t, fmt } = useI18n();
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [tab, setTab] = useState("referrals");
  const aff = useQuery({
    queryKey: ["affiliate"],
    queryFn: () => api.get<AffiliateInfo>("/account/affiliate"),
    retry: false,
  });
  const a = aff.data;
  // API trả link tương đối (website chưa cấu hình địa chỉ) hoặc chưa trả link -> dựng theo origin hiện tại
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = a?.link?.startsWith("/") ? `${origin}${a.link}` : a?.link || (a?.code && origin ? `${origin}/register?ref=${encodeURIComponent(a.code)}` : "");
  const balance = Number(a?.balance ?? 0);
  const canPayout = !!a?.payout && (a.payout.wallet || a.payout.bank);

  return (
    <div>
      <PageHeader title={t("Giới thiệu bạn bè")} description={t("Chia sẻ link giới thiệu, nhận hoa hồng mỗi khi bạn bè nạp tiền thành công.")} icon={<Gift className="size-5" />} />
      {aff.isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : aff.isError ? (
        <Card>
          <CardContent>
            <ErrorState error={aff.error} onRetry={() => aff.refetch()} notFoundText={t("Chương trình giới thiệu đang được cập nhật.")} />
          </CardContent>
        </Card>
      ) : !a?.enabled ? (
        <Card>
          <CardContent>
            <EmptyState icon={<Gift className="size-6" />} title={t("Chương trình giới thiệu đang tạm dừng")} />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            {/* thẻ link giới thiệu (kiểu thẻ trắng của mẫu): trái là % hoa hồng, phải là ô link nền muted + sao chép */}
            <section className="rounded-2xl border bg-card p-4 shadow-xs md:p-5">
              <h3 className="flex items-center gap-2 font-bold">
                <Gift className="size-4.5 text-primary" /> {t("Hoa hồng giới thiệu")}
              </h3>
              <p className="mt-0.5 text-xs text-subtle-foreground">{t("Nhận ngay hoa hồng trên mỗi lần nạp tiền thành công của người bạn giới thiệu.")}</p>
              <p className="mt-3 text-3xl font-bold text-primary">{a.commission}%</p>
              <p className="mt-4 mb-1.5 text-xs font-semibold">{t("Link giới thiệu của bạn")}</p>
              <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
                <Link2 className="ml-2 size-4 shrink-0 text-muted-foreground" />
                <Input readOnly value={link} className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent" onFocus={(e) => e.target.select()} />
                <CopyButton value={link} label={t("Link giới thiệu")} />
              </div>
              <p className="mt-1.5 text-xs text-subtle-foreground">
                {t("Mã giới thiệu:")} <b className="text-foreground">{a.code}</b>
              </p>
            </section>

            {/* ví hoa hồng: số dư rút được + nút gửi yêu cầu rút */}
            <section className="flex flex-col rounded-2xl border bg-card p-4 shadow-xs md:p-5">
              <h3 className="flex items-center gap-2 font-bold">
                <Wallet className="size-4.5 text-primary" /> {t("Ví hoa hồng")}
              </h3>
              <p className="mt-3 text-3xl font-bold tabular-nums">{fmt.money(balance)}</p>
              <p className="mt-1 text-xs text-subtle-foreground">
                {Number(a.pendingPayout ?? 0) > 0 ? t("Đang chờ duyệt rút: {amount}", { amount: fmt.money(a.pendingPayout) }) : t("Số dư có thể rút")}
              </p>
              <div className="mt-auto pt-4">
                <Button className="w-full" disabled={!canPayout || balance <= 0} onClick={() => setPayoutOpen(true)}>
                  <HandCoins /> {t("Rút hoa hồng")}
                </Button>
                {a.payout && a.payout.min > 0 && <p className="mt-1.5 text-center text-[11px] text-muted-foreground">{t("Rút tối thiểu {amount}", { amount: fmt.money(a.payout.min) })}</p>}
              </div>
            </section>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            <Stat icon={Users} label={t("Người đã giới thiệu")} value={fmt.num(a.referrals)} />
            <Stat icon={Coins} label={t("Hoa hồng đã nhận")} value={fmt.money(a.earned)} />
            <Stat icon={Landmark} label={t("Đã rút")} value={fmt.money(a.paidOut ?? 0)} />
            <Stat icon={Percent} label={t("Tỉ lệ hoa hồng")} value={`${a.commission}%`} />
          </div>

          <section className="rounded-2xl border bg-card p-4 shadow-xs md:p-5">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
                <TabsTrigger value="referrals" className="flex-none">
                  <Users /> {t("Người được giới thiệu")}
                </TabsTrigger>
                <TabsTrigger value="history" className="flex-none">
                  <History /> {t("Lịch sử hoa hồng")}
                </TabsTrigger>
                <TabsTrigger value="payouts" className="flex-none">
                  <HandCoins /> {t("Yêu cầu rút")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="referrals" className="pt-3">
                <ReferralsList recent={a.recent} />
              </TabsContent>
              <TabsContent value="history" className="pt-3">
                {tab === "history" && <HistoryList />}
              </TabsContent>
              <TabsContent value="payouts" className="pt-3">
                {tab === "payouts" && <PayoutList />}
              </TabsContent>
            </Tabs>
          </section>
        </div>
      )}
      {payoutOpen && a?.payout && (
        <PayoutDialog
          balance={balance}
          rules={a.payout}
          onClose={() => setPayoutOpen(false)}
          onDone={() => {
            setPayoutOpen(false);
            setTab("payouts");
          }}
        />
      )}
    </div>
  );
}

/** Người được giới thiệu gần đây (20 người, tên đã che) + hoa hồng họ mang lại */
function ReferralsList({ recent }: { recent: AffiliateInfo["recent"] }) {
  const { t, fmt } = useI18n();
  if (!recent?.length) return <p className="py-12 text-center text-xs text-muted-foreground">{t("Chưa có ai đăng ký qua link của bạn. Hãy chia sẻ link lên mạng xã hội, nhóm, diễn đàn...")}</p>;
  return (
    <>
      {/* mobile: danh sách gọn */}
      <ul className="-mx-1 divide-y md:hidden">
        {recent.map((r, i) => (
          <li key={i} className="flex items-center gap-3 px-1 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.name}</p>
              <p className="text-[11px] text-muted-foreground">{fmt.dateTime(r.createdAt)}</p>
            </div>
            <span className="text-sm font-semibold text-success tabular-nums">+{fmt.money(r.earned)}</span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-xl border md:block">
        <Table className="min-w-[520px]">
          <TableHeader className="bg-muted">
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-xs font-semibold">{t("Thành viên")}</TableHead>
              <TableHead className="text-xs font-semibold">{t("Ngày tham gia")}</TableHead>
              <TableHead className="text-right text-xs font-semibold">{t("Hoa hồng mang lại")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt.dateTime(r.createdAt)}</TableCell>
                <TableCell className="text-right font-semibold text-success tabular-nums">{fmt.money(r.earned)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/** Lịch sử ví hoa hồng: hoa hồng, thu hồi, rút, hoàn yêu cầu rút, điều chỉnh */
function HistoryList() {
  const { t, fmt } = useI18n();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["affiliate-txns", page],
    queryFn: () => api.get<Paginated<AffiliateTransaction>>("/account/affiliate/transactions", { page, limit: 15 }),
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <p className="py-12 text-center text-xs text-muted-foreground">{t("Chưa có giao dịch hoa hồng nào.")}</p>;
  return (
    <>
      <ul className="-mx-1 divide-y">
        {rows.map((r) => {
          const plus = Number(r.amount) >= 0;
          return (
            <li key={r.id} className="flex items-start gap-3 px-1 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {t(TXN_LABEL[r.type])}
                  {r.fromUser && <span className="font-normal text-muted-foreground"> · {r.fromUser.name}</span>}
                  {r.payout && <span className="font-normal text-muted-foreground"> · #{r.payout.code}</span>}
                </p>
                {r.note && <p className="line-clamp-2 text-xs text-muted-foreground">{r.note}</p>}
                <p className="text-[11px] text-muted-foreground">{fmt.dateTime(r.createdAt)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("text-sm font-semibold tabular-nums", plus ? "text-success" : "text-destructive")}>
                  {plus ? "+" : "−"}
                  {fmt.money(Math.abs(Number(r.amount)))}
                </p>
                <p className="text-[11px] text-muted-foreground tabular-nums">{t("Số dư {amount}", { amount: fmt.money(r.balanceAfter) })}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <Pager page={page} totalPages={q.data?.meta.totalPages ?? 1} total={q.data?.meta.total} onChange={setPage} />
    </>
  );
}

/** Yêu cầu rút của khách; yêu cầu đang chờ duyệt có nút huỷ (tiền trả lại ví hoa hồng) */
function PayoutList() {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["affiliate-payouts", page],
    queryFn: () => api.get<Paginated<AffiliatePayout>>("/account/affiliate/payouts", { page, limit: 15 }),
    placeholderData: keepPreviousData,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/account/affiliate/payouts/${id}/cancel`),
    onSuccess: () => {
      toast.success(t("Đã huỷ yêu cầu rút, tiền đã trả về ví hoa hồng"));
      void qc.invalidateQueries({ queryKey: ["affiliate"] });
      void qc.invalidateQueries({ queryKey: ["affiliate-payouts"] });
      void qc.invalidateQueries({ queryKey: ["affiliate-txns"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <p className="py-12 text-center text-xs text-muted-foreground">{t("Bạn chưa gửi yêu cầu rút nào.")}</p>;
  return (
    <>
      <ul className="-mx-1 divide-y">
        {rows.map((r) => {
          const st = PAYOUT_STATUS[r.status];
          return (
            <li key={r.id} className="flex items-start gap-3 px-1 py-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="font-mono">#{r.code}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", st.className)}>{t(st.label)}</span>
                </p>
                <p className="text-xs text-muted-foreground">{r.method === "BANK" ? `${r.bankName} · ${r.bankAccount} · ${r.bankHolder}` : t("Vào số dư ví")}</p>
                {r.adminNote && <p className="text-xs">{t("Ghi chú từ quản trị: {note}", { note: r.adminNote })}</p>}
                <p className="text-[11px] text-muted-foreground">{fmt.dateTime(r.createdAt)}</p>
              </div>
              <div className="shrink-0 space-y-1 text-right">
                <p className="text-sm font-semibold tabular-nums">{fmt.money(r.amount)}</p>
                {r.status === "PENDING" && (
                  <Button size="xs" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                    {t("Huỷ")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Pager page={page} totalPages={q.data?.meta.totalPages ?? 1} total={q.data?.meta.total} onChange={setPage} />
    </>
  );
}

/** Form gửi yêu cầu rút: chọn nhận vào ví hoặc ngân hàng, nhập số tiền (theo tiền hiển thị, đổi về tiền gốc khi gửi) */
function PayoutDialog({ balance, rules, onClose, onDone }: { balance: number; rules: NonNullable<AffiliateInfo["payout"]>; onClose: () => void; onDone: () => void }) {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const [method, setMethod] = useState<"WALLET" | "BANK">(rules.wallet ? "WALLET" : "BANK");
  const [amountText, setAmountText] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankHolder, setBankHolder] = useState("");
  const [note, setNote] = useState("");
  // số khách nhập theo tiền tệ hiển thị -> tiền gốc
  const amount = Math.round(fmt.toBase(Number(amountText.replace(/[^\d.]/g, "")) || 0));
  const tooLow = amount > 0 && amount < rules.min;
  const tooHigh = amount > balance;
  const bankOk = method === "WALLET" || (bankName.trim().length >= 2 && bankAccount.trim().length >= 4 && bankHolder.trim().length >= 2);
  const valid = amount > 0 && !tooLow && !tooHigh && bankOk;

  const send = useMutation({
    mutationFn: () =>
      api.post("/account/affiliate/payouts", {
        amount,
        method,
        note: note.trim() || undefined,
        ...(method === "BANK" ? { bankName: bankName.trim(), bankAccount: bankAccount.trim(), bankHolder: bankHolder.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success(t("Đã gửi yêu cầu rút, vui lòng chờ quản trị viên duyệt"));
      void qc.invalidateQueries({ queryKey: ["affiliate"] });
      void qc.invalidateQueries({ queryKey: ["affiliate-payouts"] });
      void qc.invalidateQueries({ queryKey: ["affiliate-txns"] });
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Rút hoa hồng")}</DialogTitle>
          <DialogDescription>{t("Số dư hoa hồng hiện có: {amount}", { amount: fmt.money(balance) })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) send.mutate();
          }}
        >
          {/* cách nhận tiền: chỉ hiện các cách website cho phép */}
          <div className="grid grid-cols-2 gap-2">
            {rules.wallet && (
              <MethodButton active={method === "WALLET"} onClick={() => setMethod("WALLET")} icon={Wallet} title={t("Vào số dư ví")} hint={t("Dùng để đặt đơn")} />
            )}
            {rules.bank && (
              <MethodButton active={method === "BANK"} onClick={() => setMethod("BANK")} icon={Landmark} title={t("Về ngân hàng")} hint={t("Chuyển khoản sau khi duyệt")} />
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payout-amount">{t("Số tiền")}</Label>
            <div className="flex gap-2">
              <Input id="payout-amount" inputMode="decimal" autoFocus value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder={fmt.money(Math.max(rules.min, 0))} />
              <Button type="button" variant="outline" onClick={() => setAmountText(String(Math.floor(fmt.convert(balance))))}>
                {t("Tất cả")}
              </Button>
            </div>
            {tooLow && <p className="text-xs text-destructive">{t("Rút tối thiểu {amount}", { amount: fmt.money(rules.min) })}</p>}
            {tooHigh && <p className="text-xs text-destructive">{t("Vượt quá số dư hoa hồng")}</p>}
          </div>
          {method === "BANK" && (
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="payout-bank">{t("Ngân hàng")}</Label>
                <Input id="payout-bank" maxLength={100} value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Vietcombank" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payout-account">{t("Số tài khoản")}</Label>
                <Input id="payout-account" inputMode="numeric" maxLength={40} value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payout-holder">{t("Tên chủ tài khoản")}</Label>
                <Input id="payout-holder" maxLength={120} value={bankHolder} onChange={(e) => setBankHolder(e.target.value)} placeholder="NGUYEN VAN A" className="uppercase" />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="payout-note">{t("Ghi chú (tuỳ chọn)")}</Label>
            <Textarea id="payout-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Huỷ")}
            </Button>
            <Button type="submit" disabled={!valid || send.isPending}>
              {send.isPending && <Spinner />}
              {t("Gửi yêu cầu")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MethodButton({ active, onClick, icon: Icon, title, hint }: { active: boolean; onClick: () => void; icon: typeof Wallet; title: string; hint: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex items-start gap-2 rounded-xl border p-3 text-left transition-colors", active ? "border-primary bg-primary-soft" : "hover:bg-muted")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-xs sm:flex-row sm:items-center sm:gap-3 sm:p-4">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary sm:size-10">
        <Icon className="size-4 sm:size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] leading-tight text-subtle-foreground sm:text-xs">{label}</p>
        <p className="truncate font-bold tabular-nums sm:text-lg">{value}</p>
      </div>
    </div>
  );
}
