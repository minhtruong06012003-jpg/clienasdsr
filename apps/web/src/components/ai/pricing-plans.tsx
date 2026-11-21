"use client";

/**
 * Trang Nạp tiền qua Ngân hàng (VietQR tự động hiện ngay khi chọn mức tiền — chuẩn phong cách nhanh gọn như Prism Forge):
 * - Cột trái:
 *   1. Chọn số tiền: các nút mức gợi ý (mặc định chọn sẵn 100.000đ) + ô nhập số khác + dòng tính sẵn Thực nhận & Khuyến mãi mốc nạp;
 *   2. Chuyển khoản đúng nội dung: hiện sẵn Ngân hàng, Số tài khoản, Chủ tài khoản, Số tiền, Nội dung CK (1 chạm sao chép) + tự động kiểm tra tiền vào mỗi 5 giây.
 * - Cột phải: Khung mã VietQR trắng sắc nét tự động cập nhật ngay lập tức khi bấm đổi số tiền (không cần ấn nút Tạo mã QR hay chuyển trang) + tóm tắt Thực nhận vào ví.
 * - Phía dưới (!compact): Bảng Lịch sử nạp tiền (thay thế khối "Mọi lần nạp đều bao gồm" cũ).
 */
import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Gift,
  Info,
  Loader2,
  LogIn,
  PartyPopper,
  QrCode,
  RotateCcw,
  Search,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common";
import { QrImage } from "@/components/qr-image";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { usePlans } from "@/lib/queries";
import { nextTier, quoteTopup } from "@/lib/topup";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { Paginated, Topup, TopupConfig, TopupOptions } from "@/lib/types";
import { BankCircleIcon, CryptoCircleIcon } from "./topup-method-icons";
import { CryptoRechargeView } from "./crypto-recharge-view";

/** Cấu hình dự phòng khi API chưa trả `topup` */
const FALLBACK: TopupConfig = {
  rate: 1,
  min: 10_000,
  max: 100_000_000,
  presets: [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000],
  tiers: [],
  promo: null,
  personal: 0,
};

function isUsdtGateway(key: string, label: string) {
  return /usdt|tether|crypto|fpayment|binance|trc20|bep20/i.test(`${key} ${label}`);
}

export function PricingPlans({ compact }: { compact?: boolean }) {
  return (
    <Suspense fallback={<PricingPlansInner compact={compact} />}>
      <PricingPlansWithParams compact={compact} />
    </Suspense>
  );
}

function PricingPlansWithParams({ compact }: { compact?: boolean }) {
  const sp = useSearchParams();
  const m = sp.get("method");
  const initialMethod: "bank" | "crypto" = m === "crypto" ? "crypto" : "bank";
  return <PricingPlansInner compact={compact} initialMethod={initialMethod} />;
}

function PricingPlansInner({
  compact,
  initialMethod = "bank",
}: {
  compact?: boolean;
  initialMethod?: "bank" | "crypto";
}) {
  const { t, locale, fmt } = useI18n();
  const { status } = useAuth();
  const authed = status === "authenticated";
  const qc = useQueryClient();
  const plans = usePlans();

  const cfg = plans.data?.topup ?? FALLBACK;
  const presets = cfg.presets.length ? cfg.presets : FALLBACK.presets;

  const defaultPreset = useMemo(() => {
    if (presets.includes(100_000)) return 100_000;
    const valid = presets.find((p) => p >= cfg.min);
    return valid ?? Math.max(100_000, cfg.min);
  }, [presets, cfg.min]);

  const [amount, setAmount] = useState<number>(defaultPreset);
  const [debouncedAmount, setDebouncedAmount] = useState<number>(defaultPreset);
  const [customText, setCustomText] = useState<string>("");
  const userTouchedRef = useRef(false);

  useEffect(() => {
    if (!userTouchedRef.current) {
      setAmount(defaultPreset);
      setDebouncedAmount(defaultPreset);
    }
  }, [defaultPreset]);

  const [method, setMethod] = useState<"bank" | "crypto">(initialMethod);
  useEffect(() => {
    setMethod(initialMethod);
  }, [initialMethod]);

  // Debounce 650ms khi đổi mức tiền để bấm liên tiếp nhiều nút không gửi dồn request gây lỗi "thao tác quá nhanh"
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAmount(amount), 650);
    return () => clearTimeout(timer);
  }, [amount]);

  const options = useQuery({
    queryKey: ["credits", "checkout-options", locale],
    queryFn: () => api.get<TopupOptions>("/account/credits/checkout/options", { locale }),
    staleTime: 60_000,
    enabled: authed,
    meta: { silentError: true },
  });

  const bankGatewayKey = useMemo(() => {
    const list = options.data?.providers ?? [];
    return list.find((p) => !isUsdtGateway(p.key, p.label))?.key ?? null;
  }, [options.data]);

  const value = amount || 0;
  const q = useMemo(() => quoteTopup(value, cfg), [value, cfg]);
  const upcoming = nextTier(value, cfg);
  const tooLow = value < cfg.min;
  const tooHigh = value > cfg.max;
  const invalid = tooLow || tooHigh;

  const [activeTx, setActiveTx] = useState<Topup | null>(null);
  const [paidDone, setPaidDone] = useState<{ paid: number; credits: number } | null>(null);
  const lastRequestedAmountRef = useRef<number | null>(null);

  const generateQr = useMutation({
    mutationFn: (targetAmount: number) =>
      api.post<Topup>(
        "/account/credits/buy/checkout",
        { amount: targetAmount, provider: bankGatewayKey, replacePending: true },
        { query: { locale } },
      ),
    onSuccess: (tx) => {
      setActiveTx(tx);
      qc.invalidateQueries({ queryKey: ["wallet", "topups"] });
    },
    onError: (err) => {
      toast.error(errorMessage(err));
    },
  });

  // Tự động tạo / cập nhật mã QR ngay khi khách đăng nhập & chọn mức tiền hợp lệ
  useEffect(() => {
    if (!authed || method !== "bank" || !bankGatewayKey || paidDone) return;
    if (debouncedAmount < cfg.min || debouncedAmount > cfg.max) return;
    if (lastRequestedAmountRef.current === debouncedAmount && activeTx?.status === "PENDING") return;
    lastRequestedAmountRef.current = debouncedAmount;
    generateQr.mutate(debouncedAmount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, method, bankGatewayKey, debouncedAmount, cfg.min, cfg.max, paidDone]);

  // Poll trạng thái giao dịch đang hiển thị mỗi 5 giây để tự động báo thành công ngay khi tiền vào
  const pollTx = useQuery({
    queryKey: ["wallet", "topup", "live-bank", activeTx?.id],
    queryFn: () => api.get<Topup>(`/account/wallet/topups/${activeTx!.id}`),
    enabled: authed && !!activeTx?.id && activeTx.status === "PENDING" && !paidDone,
    refetchInterval: (query) => (query.state.data?.status === "PENDING" ? 5000 : false),
    meta: { silentError: true },
  });

  const liveTx = pollTx.data ?? activeTx;

  useEffect(() => {
    if (liveTx?.status === "PAID" && !paidDone) {
      const paidVal = Number(liveTx.amount || value);
      const earned = quoteTopup(paidVal, cfg).credits;
      setPaidDone({ paid: paidVal, credits: earned });
      toast.success(t("Nạp tiền thành công! Đã cộng vào số dư ví."));
      qc.invalidateQueries({ queryKey: ["credits"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTx?.status]);

  const selectPreset = (p: number) => {
    userTouchedRef.current = true;
    setPaidDone(null);
    setCustomText("");
    setAmount(p);
  };

  // Cập nhật URL ảnh VietQR tức thì theo số tiền đang chọn trong lúc chờ debounce 650ms lưu DB
  const displayQrImageUrl = useMemo(() => {
    const rawUrl = liveTx?.qrImageUrl;
    if (!rawUrl) return null;
    if (!invalid && value >= cfg.min && /img\.vietqr\.io/i.test(rawUrl)) {
      return rawUrl.replace(/([?&]amount=)\d+/, `$1${value}`);
    }
    return rawUrl;
  }, [liveTx?.qrImageUrl, value, invalid, cfg.min]);

  if (method === "crypto") {
    return <CryptoRechargeView compact={compact} onSwitchBank={() => setMethod("bank")} />;
  }

  return (
    <div className="space-y-6">
      {cfg.promo && <PromoBanner promo={cfg.promo} />}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* CỘT TRÁI: Bước 1 (Chọn số tiền) + Bước 2 (Thông tin chuyển khoản đúng nội dung) */}
        <div className="space-y-5">
          {/* 1. Chọn số tiền */}
          <section className="rounded-[28px] border bg-card p-5 shadow-xs sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <BankCircleIcon className="size-10 shadow-sm" />
                <div>
                  <h2 className="text-lg font-bold tracking-tight">{t("Nạp tiền qua Ngân hàng")}</h2>
                  <p className="text-xs text-muted-foreground">
                    {t("Số dư tính bằng đồng, dùng bao nhiêu trừ bấy nhiêu. Tiền nạp được cộng tự động.")}
                  </p>
                </div>
              </div>

              {/* Chuyển nhanh Ngân hàng / Crypto */}
              <div className="inline-flex rounded-full border bg-muted/50 p-1 text-xs font-semibold">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-foreground shadow-xs transition"
                >
                  <BankCircleIcon className="size-4.5" /> {t("Ngân hàng")}
                </button>
                <button
                  type="button"
                  onClick={() => setMethod("crypto")}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-muted-foreground transition hover:text-foreground"
                >
                  <CryptoCircleIcon className="size-4.5 rounded-full ring-1 ring-white/40" /> {t("Crypto")}
                </button>
              </div>
            </div>

            <div className="mt-5">
              <div className="text-sm font-bold">{t("1. Chọn số tiền")}</div>

              {/* Dàn nút mức gợi ý */}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {presets.map((p) => {
                  const bonus = quoteTopup(p, { ...cfg, promo: null, personal: 0 }).tierBonus;
                  const active = p === value && customText === "";
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => selectPreset(p)}
                      className={cn(
                        "relative flex h-12 items-center justify-center rounded-xl border px-2 text-[13px] font-bold whitespace-nowrap tabular-nums transition sm:text-sm",
                        active
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/40 dark:text-emerald-300"
                          : "bg-background hover:border-foreground/40",
                      )}
                    >
                      {fmt.moneyBase(p)}
                      {bonus > 0 && (
                        <span
                          className={cn(
                            "absolute -top-2 right-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                            active
                              ? "bg-emerald-500 text-white"
                              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                          )}
                        >
                          +{bonus}%
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Hoặc nhập số khác */}
              <label className="mt-4 block text-xs font-semibold text-muted-foreground" htmlFor="topup-custom-amount">
                {t("Hoặc nhập số khác (đồng)")}
              </label>
              <div
                className={cn(
                  "mt-1.5 flex items-center rounded-xl border bg-background px-3.5 transition focus-within:border-foreground",
                  invalid && "border-red-400",
                )}
              >
                <input
                  id="topup-custom-amount"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={t("Ví dụ 150.000")}
                  value={customText ? Number(customText).toLocaleString("vi-VN") : ""}
                  onChange={(e) => {
                    userTouchedRef.current = true;
                    setPaidDone(null);
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 12);
                    setCustomText(digits);
                    setAmount(digits ? Number(digits) : defaultPreset);
                  }}
                  className="h-11 min-w-0 flex-1 bg-transparent text-base font-bold tracking-tight tabular-nums outline-none placeholder:font-normal placeholder:text-muted-foreground/65"
                />
                <span className="text-xs font-bold text-muted-foreground">VNĐ</span>
              </div>

              {/* Dòng tóm tắt nhận được ngay dưới ô nhập */}
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                {invalid ? (
                  <span className="font-semibold text-red-600 dark:text-red-400">
                    {tooHigh
                      ? t("Tối đa {n} mỗi lần nạp", { n: fmt.moneyBase(cfg.max) })
                      : t("Tối thiểu {n}", { n: fmt.moneyBase(cfg.min) })}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("Nạp")} <b className="text-foreground tabular-nums">{fmt.moneyBase(value)}</b> ·{" "}
                    {t("Thực nhận vào ví:")}{" "}
                    <b className="text-emerald-600 dark:text-emerald-400 tabular-nums">{fmt.money(q.credits)}</b>
                    {q.bonusPct > 0 && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                        <Gift className="size-2.5" /> +{q.bonusPct}%
                      </span>
                    )}
                  </span>
                )}
                {fmt.currency.code !== fmt.base.code && value > 0 && (
                  <span className="text-muted-foreground tabular-nums">≈ {fmt.money(value)}</span>
                )}
              </div>

              {upcoming && !invalid && (
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <TrendingUp className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {t("Nạp thêm {n} để được tặng thêm {d}%.", {
                      n: fmt.moneyBase(upcoming.min - value),
                      d: upcoming.bonus,
                    })}{" "}
                    <button
                      type="button"
                      onClick={() => selectPreset(upcoming.min)}
                      className="font-semibold underline underline-offset-2"
                    >
                      {t("Chọn {n}", { n: fmt.moneyBase(upcoming.min) })}
                    </button>
                  </span>
                </p>
              )}
            </div>
          </section>

          {/* 2. Chuyển khoản đúng nội dung */}
          <section className="rounded-[28px] border bg-card p-5 shadow-xs sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold sm:text-base">{t("2. Chuyển khoản đúng nội dung")}</h3>
              {authed && liveTx?.status === "PENDING" && !paidDone && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  <Loader2 className="size-3 animate-spin" /> {t("Tự động cộng tiền sau vài giây")}
                </span>
              )}
            </div>

            {!authed ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground sm:text-sm">
                  {t("Vui lòng đăng nhập để hệ thống cấp mã VietQR và nội dung chuyển khoản riêng cho tài khoản của bạn.")}
                </p>
                <Link
                  href="/login?next=/pricing"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-foreground px-4 text-xs font-bold text-background transition hover:opacity-90"
                >
                  <LogIn className="size-3.5" /> {t("Đăng nhập ngay")}
                </Link>
              </div>
            ) : paidDone ? (
              <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-6 text-center">
                <CheckCircle2 className="size-10 text-emerald-600 dark:text-emerald-400" />
                <div className="text-base font-bold">{t("Nạp tiền thành công!")}</div>
                <p className="text-xs text-muted-foreground sm:text-sm">
                  {t("Đã nhận {pay} — cộng +{get} vào số dư ví của bạn.", {
                    pay: fmt.moneyBase(paidDone.paid),
                    get: fmt.money(paidDone.credits),
                  })}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setPaidDone(null);
                    setActiveTx(null);
                    lastRequestedAmountRef.current = null;
                    generateQr.mutate(value);
                  }}
                  className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-xl bg-foreground px-4 text-xs font-bold text-background"
                >
                  <Sparkles className="size-3.5" /> {t("Nạp thêm lần nữa")}
                </button>
              </div>
            ) : !bankGatewayKey && !options.isLoading ? (
              <p className="mt-4 rounded-2xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
                {t("Cổng chuyển khoản ngân hàng đang bảo trì, bạn có thể chuyển sang tab Crypto để nạp bằng USDT.")}
              </p>
            ) : (
              <div className="mt-4 divide-y rounded-2xl border bg-muted/35 text-xs sm:text-sm">
                <BankField label={t("Ngân hàng")} value={liveTx?.bank?.bankName ?? "—"} loading={!liveTx && generateQr.isPending} />
                <BankField
                  label={t("Số tài khoản")}
                  value={liveTx?.bank?.accountNumber ?? "—"}
                  copy={liveTx?.bank?.accountNumber}
                  loading={!liveTx && generateQr.isPending}
                />
                <BankField
                  label={t("Chủ tài khoản")}
                  value={liveTx?.bank?.accountName ?? "—"}
                  loading={!liveTx && generateQr.isPending}
                />
                <BankField
                  label={t("Số tiền chuyển")}
                  value={fmt.moneyBase(!invalid ? value : (liveTx?.amount ?? value))}
                  copy={String(!invalid ? value : (liveTx?.amount ?? value))}
                  strong
                />
                <BankField
                  label={t("Nội dung chuyển khoản")}
                  value={liveTx?.transferContent ?? "—"}
                  copy={liveTx?.transferContent ?? undefined}
                  highlight
                  loading={!liveTx && generateQr.isPending}
                />
              </div>
            )}
          </section>
        </div>

        {/* CỘT PHẢI: Thẻ mã VietQR hiển thị trực tiếp ngay khi chọn số tiền */}
        <aside className="xl:sticky xl:top-20">
          <section className="overflow-hidden rounded-[28px] border bg-card p-5 shadow-md sm:p-6">
            {!authed ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <span className="inline-flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                  <QrCode className="size-8" />
                </span>
                <div className="mt-4 text-base font-bold">{t("Mã VietQR tự động")}</div>
                <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">
                  {t("Đăng nhập để hiển thị ngay mã QR ngân hàng theo đúng số tiền bạn chọn.")}
                </p>
                <Link
                  href="/login?next=/pricing"
                  className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-xs font-bold text-background shadow-sm transition hover:opacity-90"
                >
                  <LogIn className="size-3.5" /> {t("Đăng nhập để hiện QR")}
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="relative flex w-full items-center justify-center rounded-2xl border bg-white p-3 shadow-xs">
                  {displayQrImageUrl || liveTx?.qrData ? (
                    <QrImage
                      value={liveTx?.qrData}
                      imageUrl={displayQrImageUrl}
                      size={300}
                      className={cn(
                        "h-auto w-full max-w-[290px] object-contain p-0 transition-opacity",
                        generateQr.isPending && !displayQrImageUrl && "opacity-50",
                      )}
                    />
                  ) : (
                    <div className="flex h-[290px] w-full items-center justify-center">
                      <Loader2 className="size-7 animate-spin text-zinc-400" />
                    </div>
                  )}
                  {generateQr.isPending && !displayQrImageUrl && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-white/45 backdrop-blur-[1px]">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white shadow-md">
                        <Loader2 className="size-3.5 animate-spin" /> {t("Đang cập nhật QR...")}
                      </span>
                    </div>
                  )}
                </div>

                {/* Khung tóm tắt số tiền nhận được căn giữa, tông xanh sáng hài hoà với thẻ VietQR (T-195) */}
                <div className="mt-4 w-full rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3.5 text-center">
                  <div className="text-[11.5px] font-semibold tracking-wider text-slate-500 uppercase dark:text-zinc-400">
                    {t("Bạn nhận được")}
                  </div>
                  <div className="mt-1 text-2xl font-bold tracking-tight text-emerald-700 tabular-nums dark:text-emerald-400">
                    {fmt.money(invalid ? 0 : q.credits)}
                  </div>
                </div>

                <p className="mt-3 text-center text-[11px] text-muted-foreground">
                  {t("Mở app ngân hàng bất kỳ quét mã QR trên, tiền tự động cộng vào ví trong 5–30 giây.")}
                </p>
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* BẢNG LỊCH SỬ NẠP TIỀN (T-168: thay cho khối "Mọi lần nạp đều bao gồm" cũ) */}
      {!compact && <TopupHistorySection authed={authed} />}
    </div>
  );
}

function BankField({
  label,
  value,
  copy,
  strong,
  highlight,
  loading,
}: {
  label: string;
  value: string;
  copy?: string;
  strong?: boolean;
  highlight?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {loading ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "text-right tabular-nums",
              highlight
                ? "rounded-lg bg-emerald-500/12 px-2 py-0.5 font-mono font-bold text-emerald-700 dark:text-emerald-300"
                : strong
                  ? "font-bold text-foreground"
                  : "font-semibold text-foreground",
            )}
          >
            {value}
          </span>
        )}
        {copy && !loading && <CopyButton value={copy} label={label} size="icon-xs" />}
      </span>
    </div>
  );
}

/** Bảng Lịch sử nạp tiền đặt cuối trang Nạp tiền Ngân hàng */
function TopupHistorySection({ authed }: { authed: boolean }) {
  const { t, fmt } = useI18n();
  const [searchCode, setSearchCode] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const q = useQuery({
    queryKey: ["wallet", "topups", "bank-history"],
    queryFn: () => api.get<Paginated<Topup>>("/account/wallet/topups", { page: 1, limit: 50 }),
    enabled: authed,
    staleTime: 15_000,
    meta: { silentError: true },
  });

  const rows = useMemo(() => {
    const all = (q.data?.data ?? []).filter(
      (tx) => !isUsdtGateway(tx.provider, "") && !tx.usdt && !tx.crypto,
    );
    return all.filter((tx) => {
      const code = `${tx.transferContent ?? ""} ${tx.reference ?? ""} ${tx.id}`.toLowerCase();
      if (searchCode.trim() && !code.includes(searchCode.trim().toLowerCase())) return false;
      if (statusFilter === "waiting" && tx.status !== "PENDING") return false;
      if (statusFilter === "completed" && tx.status !== "PAID") return false;
      if (statusFilter === "expired" && !["EXPIRED", "CANCELLED", "FAILED"].includes(tx.status)) return false;
      return true;
    });
  }, [q.data, searchCode, statusFilter]);

  const paidTotal = useMemo(
    () =>
      rows
        .filter((r) => r.status === "PAID")
        .reduce((s, r) => s + Number(r.amount || 0) + Number(r.bonus || 0), 0),
    [rows],
  );

  return (
    <section className="overflow-hidden rounded-[28px] border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-muted text-foreground">
            <Clock className="size-4" />
          </span>
          <h3 className="text-sm font-bold tracking-tight sm:text-base">{t("Lịch sử nạp tiền")}</h3>
        </div>
        {authed && (
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-medium transition hover:bg-muted"
          >
            <RotateCcw className={cn("size-3.5", q.isFetching && "animate-spin")} /> {t("Làm mới")}
          </button>
        )}
      </div>

      {!authed ? (
        <div className="px-6 py-10 text-center text-xs text-muted-foreground sm:text-sm">
          {t("Đăng nhập để xem lịch sử nạp tiền của bạn.")}
        </div>
      ) : (
        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex h-9 min-w-[200px] flex-1 items-center rounded-xl border bg-background px-3">
              <Search className="mr-2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={searchCode}
                onChange={(e) => setSearchCode(e.target.value)}
                placeholder={t("Tìm nội dung CK / mã giao dịch...")}
                className="w-full bg-transparent text-xs outline-none"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-xl border bg-background px-3 text-xs font-medium outline-none"
            >
              <option value="">{t("Mọi trạng thái")}</option>
              <option value="waiting">{t("Đang chờ thanh toán")}</option>
              <option value="completed">{t("Hoàn thành")}</option>
              <option value="expired">{t("Hết hạn / Đã huỷ")}</option>
            </select>
            {(searchCode || statusFilter) && (
              <button
                type="button"
                onClick={() => {
                  setSearchCode("");
                  setStatusFilter("");
                }}
                className="h-9 rounded-xl border px-3 text-xs font-semibold hover:bg-muted"
              >
                {t("Bỏ lọc")}
              </button>
            )}
          </div>

          <div className="overflow-x-auto rounded-2xl border">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="border-b bg-muted/40 text-[11px] font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">{t("Mã nạp / Nội dung")}</th>
                  <th className="px-4 py-3">{t("Phương thức")}</th>
                  <th className="px-4 py-3 text-right">{t("Số tiền nạp")}</th>
                  <th className="px-4 py-3 text-center">{t("Trạng thái")}</th>
                  <th className="px-4 py-3">{t("Thời gian")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">
                      {t("Chưa có giao dịch nạp tiền nào.")}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const code = row.transferContent || row.reference || row.id.slice(0, 8).toUpperCase();
                    const isCrypto = isUsdtGateway(row.provider, "") || !!row.usdt || !!row.crypto;
                    return (
                      <tr key={row.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs font-semibold">{code}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                            {isCrypto ? (
                              <>
                                <CryptoCircleIcon className="size-4" /> USDT Crypto
                              </>
                            ) : (
                              <>
                                <BankCircleIcon className="size-4" />{" "}
                                {row.bank?.bankName ? `VietQR · ${row.bank.bankName}` : t("VietQR Ngân hàng")}
                              </>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums">
                          {fmt.moneyBase(Number(row.amount || 0))}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <HistoryStatusBadge status={row.status} />
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                          {new Date(row.createdAt).toLocaleString("vi-VN")}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              <tfoot className="border-t bg-muted/30 text-xs">
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-right text-muted-foreground">
                    {t("Tổng đã nạp thành công:")}{" "}
                    <strong className="text-foreground tabular-nums">{fmt.moneyBase(paidTotal)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === "PAID") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
        {t("Hoàn thành")}
      </span>
    );
  }
  if (status === "PENDING") {
    return (
      <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
        {t("Đang chờ")}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-zinc-500/15 px-2.5 py-0.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-400">
      {t("Hết hạn")}
    </span>
  );
}

/** Banner chương trình khuyến mãi đang chạy + đếm ngược tới lúc kết thúc (nếu có hạn) */
function PromoBanner({ promo }: { promo: NonNullable<TopupConfig["promo"]> }) {
  const { t } = useI18n();
  const left = useCountdown(promo.endsAt);
  return (
    <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden rounded-[24px] border border-emerald-300/60 bg-gradient-to-r from-emerald-50 via-card to-amber-50 px-5 py-4 dark:border-emerald-500/30 dark:from-emerald-500/10 dark:to-amber-500/10">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-md">
        <PartyPopper className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold">{promo.label}</div>
        <div className="text-sm text-muted-foreground">
          {t("Tặng thêm {d}% cho mọi lần nạp, cộng dồn với khuyến mãi theo mốc.", { d: promo.bonus })}
        </div>
      </div>
      {left && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-bold text-background tabular-nums">
          <Clock className="size-3.5" /> {t("Còn {t}", { t: left })}
        </span>
      )}
    </div>
  );
}

function useCountdown(end: string | null) {
  const { t } = useI18n();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!end) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [end]);
  if (!end || now === null) return null;
  const ms = new Date(end).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return d > 0 ? `${t("{d} ngày", { d })} ${hms}` : hms;
}

/** Giữ export tương thích ngược */
export function PackFeatures({ features, note }: { features: string[]; note: string }) {
  const { t } = useI18n();
  if (!features.length && !note) return null;
  return (
    <section className="studio-mesh relative mx-auto mt-12 max-w-5xl overflow-hidden rounded-[28px] border p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-2xl bg-foreground text-background shadow-md">
          <Gift className="size-5" />
        </span>
        <h2 className="text-xl font-bold tracking-tight">{t("Mọi lần nạp đều bao gồm")}</h2>
      </div>
      {features.length > 0 && (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2.5 rounded-2xl border bg-card/70 px-4 py-3 text-sm backdrop-blur">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> {t(f)}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className="mt-5 flex items-start gap-2 rounded-2xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" /> {t(note)}
        </p>
      )}
    </section>
  );
}
