"use client";

/**
 * Trang thanh toán nạp tiền vào ví (số dư dùng chạy công cụ AI, tính bằng VND): /checkout?amount=<số tiền VNĐ>[&topup=<id> khi quay về từ cổng]
 * - Cột trái: chọn phương thức thanh toán (VietQR ngân hàng / USDT Crypto có logo xanh Tether) hoặc màn hình quét mã QR + cam kết tự động 24/7;
 * - Cột phải: tóm tắt đơn nạp (tiền gốc, khuyến mãi mốc nạp, thực nhận vào ví, cần thanh toán) + nút Thanh toán cân đối chiều cao.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Gift,
  Infinity as InfinityIcon,
  Loader2,
  Lock,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { ErrorState, LoadingBlock } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useCredits, usePlans } from "@/lib/queries";
import { quoteTopup, type TopupQuote } from "@/lib/topup";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { Topup, TopupConfig, TopupOptions } from "@/lib/types";
import { TopupPanel } from "./topup-panel";

/** Kết quả hỏi trạng thái thanh toán qua cổng */
interface CheckoutStatus {
  status: Topup["status"];
  amount: number | null;
  /** Số tiền (VND) đã cộng vào ví, gồm cả phần tặng thêm */
  credits: number | null;
  purchaseCode: number | null;
  error: string | null;
}

/** Nhận diện cổng USDT / Crypto theo khoá hoặc nhãn để gắn logo Tether xanh & mô tả đúng */
function isUsdtGateway(key: string, label: string) {
  return /usdt|tether|crypto|fpayment|binance|trc20|bep20/i.test(`${key} ${label}`);
}

/** Logo Tether USDT tròn màu xanh ngọc chuẩn (#26A17B) */
function UsdtLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <circle cx="16" cy="16" r="16" fill="#26A17B" />
      <path
        fill="#FFFFFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.922 17.383v-.002c-.11.008-.677.042-1.942.042-1.01 0-1.721-.03-1.971-.042v.003c-3.888-.171-6.79-.848-6.79-1.658 0-.809 2.902-1.486 6.79-1.66v2.644c.254.018.982.061 1.988.061 1.207 0 1.812-.05 1.925-.06v-2.643c3.88.173 6.775.85 6.775 1.658 0 .81-2.895 1.485-6.775 1.657m0-3.59v-2.366h5.414V7.819H8.595v3.608h5.414v2.365c-4.4.202-7.709 1.074-7.709 2.118 0 1.044 3.309 1.915 7.709 2.118v7.582h3.913v-7.584c4.393-.202 7.694-1.073 7.694-2.116 0-1.043-3.301-1.914-7.694-2.117"
      />
    </svg>
  );
}

export function CheckoutView() {
  const { t, locale, fmt } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const plans = usePlans();
  const credits = useCredits();
  const options = useQuery({
    queryKey: ["credits", "checkout-options", locale],
    queryFn: () => api.get<TopupOptions>("/account/credits/checkout/options", { locale }),
    staleTime: 60_000,
  });

  const cfg: TopupConfig | undefined = plans.data?.topup;
  const rawAmount = Math.max(0, Math.round(Number(params.get("amount")) || 0));
  const value = rawAmount || cfg?.presets.find((p) => p >= (cfg?.min ?? 0)) || cfg?.min || 0;
  const q = useMemo(() => (cfg ? quoteTopup(value, cfg) : null), [value, cfg]);
  const invalid = !cfg || value < cfg.min || value > cfg.max;
  const [method, setMethod] = useState<string | null>(null);
  const [topup, setTopup] = useState<{ id: string; tx?: Topup } | null>(() => (params.get("topup") ? { id: params.get("topup")! } : null));
  const [done, setDone] = useState<{ amount: number; credits?: number; balance?: number } | null>(null);

  useEffect(() => {
    if (!value) return;
    const qs = new URLSearchParams({ amount: String(value) });
    const urlMethod = params.get("method");
    if (urlMethod === "bank" || urlMethod === "crypto") qs.set("method", urlMethod);
    if (topup) qs.set("topup", topup.id);
    if (topup && params.get("cancelled")) qs.set("cancelled", params.get("cancelled")!);
    const next = `${pathname}?${qs}`;
    if (next !== `${pathname}?${params}`) router.replace(next, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, topup?.id]);

  const final = value;
  const gateways = options.data?.enabled ? options.data.providers.filter((p) => !p.crypto) : [];
  const preferredType = params.get("method");
  const defaultGatewayKey = useMemo(() => {
    if (!gateways.length) return null;
    if (preferredType === "crypto") {
      return gateways.find((g) => isUsdtGateway(g.key, g.label))?.key ?? gateways[0].key;
    }
    if (preferredType === "bank") {
      return gateways.find((g) => !isUsdtGateway(g.key, g.label))?.key ?? gateways[0].key;
    }
    return gateways[0].key;
  }, [gateways, preferredType]);
  const chosen = method ?? defaultGatewayKey;
  const chosenGateway = gateways.find((g) => g.key === chosen) ?? null;
  const chosenIsUsdt = chosenGateway ? isUsdtGateway(chosenGateway.key, chosenGateway.label) : false;
  const charge = Math.max(final, options.data?.min ?? 0);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["credits"] });
    qc.invalidateQueries({ queryKey: ["wallet"] });
    qc.invalidateQueries({ queryKey: ["plans"] });
  };

  const buy = useMutation({
    mutationFn: () => api.post<{ credits: number; quote: TopupQuote }>("/account/credits/buy", { amount: value }),
    onSuccess: (res) => {
      setDone({ amount: value, credits: res.quote.credits, balance: res.credits });
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const gateway = useMutation({
    mutationFn: () => api.post<Topup>("/account/credits/buy/checkout", { amount: value, provider: chosen }, { query: { locale } }),
    onSuccess: (tx) => {
      if (tx.checkoutUrl && !tx.qrData && !tx.qrImageUrl && !tx.transferContent) {
        window.location.href = tx.checkoutUrl;
        return;
      }
      setTopup({ id: tx.id, tx });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const pay = () => gateway.mutate();
  const busy = buy.isPending || gateway.isPending;

  // Khi khách bấm "Tạo mã QR →" từ trang Nạp tiền Ngân hàng (`?auto=1`) -> tự sinh mã QR ngân hàng ngay không cần bấm lần 2
  const [autoTriggered, setAutoTriggered] = useState(false);
  useEffect(() => {
    if (
      autoTriggered ||
      params.get("auto") !== "1" ||
      topup ||
      done ||
      invalid ||
      !chosen ||
      chosenIsUsdt ||
      gateway.isPending
    ) {
      return;
    }
    setAutoTriggered(true);
    gateway.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggered, topup, done, invalid, chosen, chosenIsUsdt]);

  if (plans.isLoading || credits.isLoading) return <LoadingBlock className="py-24" />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={() => plans.refetch()} />;
  if (!cfg || !q) return <LoadingBlock className="py-24" />;
  if (done) return <Success amount={done.amount} credits={done.credits} balance={done.balance} />;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/pricing" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground">
            <ArrowLeft className="size-3.5" /> {t("Bảng giá nạp tiền")}
          </Link>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">{t("Thanh toán nạp tiền")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Chọn phương thức thanh toán bên dưới. Tiền được cộng tự động vào ví ngay khi hoàn tất và không có thời hạn.")}
          </p>
        </div>
        {!topup && (
          <Link
            href="/pricing"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border bg-card px-3.5 text-xs font-semibold text-muted-foreground shadow-2xs transition hover:border-foreground/30 hover:text-foreground"
          >
            {t("Mức nạp:")} <b className="text-foreground tabular-nums">{fmt.moneyBase(value)}</b> · {t("Đổi")}
          </Link>
        )}
      </div>

      <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* cột trái: phương thức thanh toán / mã QR + cam kết tự động */}
        <section className="flex flex-col justify-between rounded-3xl border bg-card p-5 shadow-xs sm:p-6">
          <div>
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-base font-bold tracking-tight">
                {topup ? t("Quét mã để thanh toán") : t("Phương thức thanh toán")}
              </h2>
              {!topup && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                  <Zap className="size-3" /> {t("Xác nhận tự động 24/7")}
                </span>
              )}
            </div>

            {topup ? (
              <TopupPanel
                key={topup.id}
                id={topup.id}
                initial={topup.tx}
                cancelled={params.get("cancelled") === "1"}
                onClose={() => setTopup(null)}
                paidSlot={<GatewayResult id={topup.id} credits={q.credits} onDone={(c) => (setDone({ amount: value, credits: c }), refresh())} onRetryWallet={() => buy.mutate()} />}
              />
            ) : (
              <div className="space-y-3">
                {gateways.map((g) => {
                  const usdt = isUsdtGateway(g.key, g.label);
                  return (
                    <Choice
                      key={g.key}
                      active={chosen === g.key}
                      usdt={usdt}
                      onClick={() => setMethod(g.key)}
                      title={g.label}
                      tag={usdt ? "USDT · Crypto" : "VietQR 24/7"}
                    >
                      <div className="text-xs leading-relaxed text-muted-foreground">
                        {usdt
                          ? t("Thanh toán tự động bằng USDT theo tỉ giá thực tế, cộng số dư ngay sau khi mạng lưới xác nhận")
                          : t("Quét mã QR bằng mọi app ngân hàng hoặc ví điện tử, tiền tự cộng vào số dư trong vài giây")}
                      </div>
                    </Choice>
                  );
                })}
                {!gateways.length && (
                  <p className="rounded-2xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
                    {t("Chưa có cổng thanh toán trực tuyến, vui lòng liên hệ hỗ trợ để nạp tiền.")}
                  </p>
                )}
              </div>
            )}
          </div>

          {!topup && (
            <div className="mt-6 border-t border-dashed pt-4">
              <div className="grid gap-2.5 sm:grid-cols-3">
                <div className="flex items-start gap-2.5 rounded-2xl bg-muted/45 p-3">
                  <Zap className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 text-xs">
                    <div className="font-semibold text-foreground">{t("Cộng tiền tức thì")}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{t("Tự động 5–30 giây")}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 rounded-2xl bg-muted/45 p-3">
                  <InfinityIcon className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                  <div className="min-w-0 text-xs">
                    <div className="font-semibold text-foreground">{t("Số dư vĩnh viễn")}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{t("Không giới hạn ngày dùng")}</div>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 rounded-2xl bg-muted/45 p-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="min-w-0 text-xs">
                    <div className="font-semibold text-foreground">{t("An toàn 100%")}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{t("Tự hoàn tiền khi lỗi")}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* cột phải: tóm tắt đơn nạp */}
        <aside className="flex flex-col">
          <section className="flex flex-1 flex-col justify-between overflow-hidden rounded-3xl border bg-card shadow-sm">
            <div>
              <div className="studio-mesh flex items-center justify-between gap-2 border-b px-6 py-4">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t("Tóm tắt đơn hàng")}</div>
                  <div className="mt-0.5 text-lg font-bold tracking-tight tabular-nums">{t("Nạp {n}", { n: fmt.moneyBase(value) })}</div>
                </div>
                {!invalid && q.bonusPct > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                    <Gift className="size-3.5" /> +{q.bonusPct}%
                  </span>
                )}
              </div>

              <dl className="space-y-3 px-6 py-5 text-[13px]">
                <Row label={t("Tiền gốc")} value={fmt.money(invalid ? 0 : q.base)} />
                {!invalid && q.tierBonus > 0 && <Row label={t("Khuyến mãi mốc nạp ({d}%)", { d: q.tierBonus })} value={<Bonus n={Math.floor((q.base * q.tierBonus) / 100)} />} />}
                {!invalid && q.promoBonus > 0 && cfg.promo && <Row label={`${cfg.promo.label} (${q.promoBonus}%)`} value={<Bonus n={Math.floor((q.base * q.promoBonus) / 100)} />} />}
                {!invalid && q.personalBonus > 0 && <Row label={t("Ưu đãi riêng của bạn ({d}%)", { d: q.personalBonus })} value={<Bonus n={Math.floor((q.base * q.personalBonus) / 100)} />} />}
                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-2.5">
                  <Row
                    label={<span className="font-semibold text-foreground">{t("Thực nhận vào ví")}</span>}
                    value={<span className="text-base font-bold text-emerald-600 dark:text-emerald-400">+{fmt.money(invalid ? 0 : q.credits)}</span>}
                  />
                </div>
                <Row label={t("Thời hạn số dư")} value={t("Vĩnh viễn")} />
                <div className="border-t pt-2.5" />
                <Row label={t("Số tiền nạp")} value={fmt.moneyBase(final)} />
              </dl>
            </div>

            <div className="border-t bg-muted/40 px-6 py-5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{t("Cần thanh toán")}</span>
                <div className="text-right">
                  <span className="text-2xl font-bold tracking-tight tabular-nums">{fmt.moneyBase(charge)}</span>
                  {fmt.currency.code !== fmt.base.code && <span className="ml-1.5 text-sm text-muted-foreground tabular-nums">≈ {fmt.money(charge)}</span>}
                </div>
              </div>
              {charge > final && <p className="mt-1 text-[11px] text-muted-foreground">{t("Cổng thanh toán yêu cầu tối thiểu {n}, phần dư được giữ trong ví.", { n: fmt.moneyBase(charge) })}</p>}
              {!topup && (
                <button
                  type="button"
                  onClick={pay}
                  disabled={busy || invalid || !chosen}
                  className={cn(
                    "mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-bold shadow-lg transition hover:opacity-95 disabled:opacity-50",
                    chosenIsUsdt
                      ? "bg-[#26A17B] text-white shadow-[#26A17B]/25"
                      : "bg-foreground text-background shadow-black/10",
                  )}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : chosenIsUsdt ? (
                    <UsdtLogo className="size-5 rounded-full ring-1 ring-white/40" />
                  ) : (
                    <CreditCard className="size-4" />
                  )}
                  {chosen
                    ? chosenIsUsdt
                      ? t("Thanh toán USDT ({n})", { n: fmt.moneyBase(charge) })
                      : t("Thanh toán {n}", { n: fmt.moneyBase(charge) })
                    : t("Chưa có cổng thanh toán")}
                </button>
              )}
              <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Lock className="size-3" /> {t("Bảo mật SSL")}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="size-3" /> {t("Kích hoạt tự động")}
                </span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Ô lựa chọn phương thức thanh toán (hỗ trợ giao diện xanh riêng cho USDT) */
function Choice({
  active,
  usdt,
  disabled,
  onClick,
  title,
  tag,
  children,
}: {
  active: boolean;
  usdt?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  tag?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-55",
        usdt
          ? active
            ? "border-[#26A17B] bg-[#26A17B]/[0.08] ring-2 ring-[#26A17B]/25"
            : "border-[#26A17B]/30 bg-[#26A17B]/[0.02] hover:border-[#26A17B]/70 hover:bg-[#26A17B]/[0.05]"
          : active
            ? "border-foreground bg-muted/70 ring-2 ring-foreground/15"
            : "hover:border-foreground/30 hover:bg-muted/30",
      )}
    >
      {usdt ? (
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#26A17B]/15 p-1.5 shadow-2xs">
          <UsdtLogo className="size-full" />
        </span>
      ) : (
        <span
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-xl transition",
            active ? "bg-foreground text-background shadow-xs" : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
          )}
        >
          <QrCode className="size-5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
          {title}
          {tag && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                usdt
                  ? "bg-[#26A17B] text-white"
                  : "bg-sky-500/12 text-sky-700 dark:text-sky-300",
              )}
            >
              {tag}
            </span>
          )}
        </span>
        <span className="mt-1 block">{children}</span>
      </span>
      <span
        className={cn(
          "mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition",
          usdt
            ? active
              ? "border-[#26A17B]"
              : "border-[#26A17B]/45"
            : active
              ? "border-foreground"
              : "border-muted-foreground/40",
        )}
      >
        {active && <span className={cn("size-2.5 rounded-full", usdt ? "bg-[#26A17B]" : "bg-foreground")} />}
      </span>
    </button>
  );
}

/** Số tiền (VND) tặng thêm vào ví (màu xanh) */
function Bonus({ n }: { n: number }) {
  const { fmt } = useI18n();
  return <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{fmt.money(n)}</span>;
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Đã nhận tiền từ cổng (TopupPanel gọi sang): hỏi GET /account/credits/checkout/:id cho tới khi webhook cộng xong tiền vào ví.
 */
function GatewayResult({ id, credits, onDone, onRetryWallet }: { id: string; credits: number; onDone: (credits: number) => void; onRetryWallet: () => void }) {
  const { t, fmt } = useI18n();
  const q = useQuery({
    queryKey: ["credits", "checkout", id],
    queryFn: () => api.get<CheckoutStatus>(`/account/credits/checkout/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.credits || d.error) ? false : 2000;
    },
  });
  useEffect(() => {
    if (q.data?.credits) onDone(q.data.credits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.credits]);

  if (q.data?.error) {
    return (
      <div className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        <div className="flex items-start gap-2.5">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div>
            <div className="font-semibold">{t("Tiền đã vào ví nhưng chưa tự cộng khuyến mãi được")}</div>
            <p className="mt-0.5 text-xs opacity-90">{q.data.error}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRetryWallet} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-foreground px-3.5 text-xs font-semibold text-background">
            <RotateCcw className="size-3.5" /> {t("Thử lại")}
          </button>
          <Link href="/pricing" className="inline-flex h-9 items-center rounded-xl border bg-background px-3.5 text-xs font-medium">
            {t("Về bảng giá")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Loader2 className="size-8 animate-spin text-emerald-600" />
      <div className="font-semibold">{t("Đã nhận thanh toán — đang cộng {n} vào số dư...", { n: fmt.money(credits) })}</div>
      <p className="text-xs text-muted-foreground">{t("Vui lòng giữ trang này vài giây.")}</p>
    </div>
  );
}

/** Màn hình nạp tiền thành công */
function Success({ amount, credits, balance }: { amount: number; credits?: number; balance?: number }) {
  const { t, fmt } = useI18n();
  return (
    <div className="mx-auto max-w-lg py-10">
      <section className="rounded-3xl border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto inline-flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
          <CheckCircle2 className="size-8" />
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{t("Nạp tiền thành công!")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {credits ? t("Đã thanh toán {pay} — ví được cộng +{get}.", { pay: fmt.moneyBase(amount), get: fmt.money(credits) }) : t("Đã nạp {n} vào ví.", { n: fmt.moneyBase(amount) })}
        </p>
        {balance !== undefined && (
          <div className="mx-auto mt-4 inline-flex items-center gap-1.5 rounded-full bg-muted px-4 py-1.5 text-sm font-semibold tabular-nums">
            <Zap className="size-4 text-amber-500" /> {t("Số dư hiện tại:")} {fmt.money(balance)}
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          <Link href="/dashboard" className="inline-flex h-11 items-center gap-2 rounded-xl bg-foreground px-5 text-sm font-semibold text-background shadow-sm hover:opacity-90">
            {t("Bắt đầu tạo ngay")}
          </Link>
          <Link href="/transactions" className="inline-flex h-11 items-center rounded-xl border px-4 text-sm font-medium hover:bg-muted">
            {t("Xem lịch sử giao dịch")}
          </Link>
        </div>
      </section>
    </div>
  );
}
