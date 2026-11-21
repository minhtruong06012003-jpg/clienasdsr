"use client";

/**
 * Giao diện Nạp tiền bằng Crypto (USDT):
 * - Tông màu sáng thoáng đồng bộ (`bg-card` trắng + khung nhận tiền xanh ngọc nhạt `#26A17B`, bỏ hoàn toàn khối màu đen tối — T-172).
 * - Hiển thị sẵn các cổng / mạng lưới ví USDT (`Tron TRC20`, `BNB Smart Chain BEP20`, `Binance Pay`...) ngay bên ngoài form để khách chọn tiện lợi (T-173, T-174).
 * - Khi bấm `Tạo đơn nạp tiền`: nếu khách chưa chọn mạng ví trước đó thì chuyển sang màn hình `Chọn mạng thanh toán (Ví USDT)` trước (T-167, không bị localStorage cũ nhảy cóc); chọn mạng xong hiển thị ngay mã QR + địa chỉ ví USDT + số USDT chính xác cần chuyển + đếm ngược & tự động đối soát blockchain 24/7 ngay trên trang.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  CheckCircle2,
  ChevronRight,
  Clock,
  ExternalLink,
  Gift,
  Info,
  Loader2,
  Percent,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common";
import { QrImage } from "@/components/qr-image";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { usePlans } from "@/lib/queries";
import { quoteTopup } from "@/lib/topup";
import { useI18n } from "@/lib/i18n/provider";
import type { Paginated, Topup, TopupConfig, TopupOptions, UsdtNetworkOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BankCircleIcon, CryptoCircleIcon } from "./topup-method-icons";

const FALLBACK_CFG: TopupConfig = {
  rate: 1,
  min: 10_000,
  max: 100_000_000,
  presets: [100_000, 200_000, 500_000, 1_000_000],
  tiers: [],
  promo: null,
  personal: 0,
};

const DEFAULT_NETWORKS: UsdtNetworkOption[] = [
  { walletId: "4", network: "TRON", label: "Tron (TRC20)", kind: "chain" },
  { walletId: "5", network: "BSC", label: "BNB Smart Chain (BEP20)", kind: "chain" },
];

function isUsdtProvider(key: string, label: string) {
  return /usdt|tether|crypto|fpayment|binance|trc20|bep20/i.test(`${key} ${label}`);
}

/** Nhận diện màu & ký hiệu chuẩn theo từng mạng ví giống cổng USDT Gateway */
function networkMeta(net: Pick<UsdtNetworkOption, "network" | "label" | "kind">) {
  const s = `${net.network} ${net.label} ${net.kind ?? ""}`.toLowerCase();
  if (s.includes("binance") || net.kind === "binance") {
    return { badge: "PAY", sub: "Gửi nội bộ qua app Binance", bg: "bg-[#F0B90B]", text: "text-zinc-950" };
  }
  if (s.includes("tron") || s.includes("trc20") || s.includes("trx")) {
    return { badge: "TRX", sub: "USDT · TRON", bg: "bg-[#EB0029]", text: "text-white" };
  }
  if (s.includes("bsc") || s.includes("bep20") || s.includes("bnb")) {
    return { badge: "BNB", sub: "USDT · BSC", bg: "bg-[#F0B90B]", text: "text-zinc-950" };
  }
  if (s.includes("erc20") || s.includes("eth")) {
    return { badge: "ETH", sub: "USDT · Ethereum", bg: "bg-[#627EEA]", text: "text-white" };
  }
  return { badge: "USDT", sub: `USDT · ${net.network}`, bg: "bg-[#26A17B]", text: "text-white" };
}

export function CryptoRechargeView({
  compact,
  onSwitchBank,
}: {
  compact?: boolean;
  onSwitchBank?: () => void;
}) {
  const { t, locale, fmt } = useI18n();
  const { status } = useAuth();
  const authed = status === "authenticated";
  const router = useRouter();
  const qc = useQueryClient();
  const plans = usePlans();
  const cfg = plans.data?.topup ?? FALLBACK_CFG;

  const options = useQuery({
    queryKey: ["credits", "checkout-options", locale],
    queryFn: () => api.get<TopupOptions>("/account/credits/checkout/options", { locale }),
    staleTime: 60_000,
    enabled: authed,
    meta: { silentError: true },
  });

  const usdtRate = options.data?.usdtRate ?? 26_000;
  const minUsdt = options.data?.minUsdt ?? 1;
  const publicNetworks = options.data?.usdtNetworks?.length ? options.data.usdtNetworks : DEFAULT_NETWORKS;
  const usdtGatewayKey = useMemo(() => {
    const list = options.data?.providers ?? [];
    return list.find((p) => isUsdtProvider(p.key, p.label))?.key ?? "usdt";
  }, [options.data]);

  const [rawUsdt, setRawUsdt] = useState("");
  /** Mạng lưới khách chọn sẵn ngay bên ngoài form (null = chưa chọn -> bấm Tạo đơn sẽ vào bước chọn mạng trước) */
  const [preselectedNet, setPreselectedNet] = useState<string | null>(null);
  /** Hoá đơn USDT vừa tạo + mạng lưới đang mở thanh toán */
  const [activeInvoice, setActiveInvoice] = useState<Topup | null>(null);
  const [selectedNetKey, setSelectedNetKey] = useState<string | null>(null);

  const usdtAmount = useMemo(() => {
    const normalized = rawUsdt.replace(/,/g, ".").replace(/[^0-9.]/g, "");
    const num = parseFloat(normalized);
    return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : 0;
  }, [rawUsdt]);

  const vndAmount = Math.round(usdtAmount * usdtRate);
  const quote = useMemo(() => quoteTopup(vndAmount, cfg), [vndAmount, cfg]);

  const createInvoice = useMutation({
    mutationFn: () =>
      api.post<Topup>(
        "/account/credits/buy/checkout",
        { amount: vndAmount, provider: usdtGatewayKey },
        { query: { locale } },
      ),
    onSuccess: (tx) => {
      const nets = tx.usdt?.networks ?? [];
      if (!nets.length && tx.checkoutUrl) {
        window.location.href = tx.checkoutUrl;
        return;
      }
      setActiveInvoice(tx);
      // Nếu bên ngoài form khách đã bấm chọn sẵn ví (vd TRC20 / BEP20) thì mở thẳng ví đó; chưa chọn thì dừng ở bước 1 (Chọn ví USDT)
      const matchedPre = preselectedNet
        ? nets.find((n) => n.network === preselectedNet || n.walletId === preselectedNet)?.network ?? null
        : null;
      setSelectedNetKey(matchedPre);
      qc.invalidateQueries({ queryKey: ["wallet", "topups"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const handleSubmit = () => {
    if (!authed) {
      router.push(`/register?next=${encodeURIComponent("/pricing?method=crypto")}`);
      return;
    }
    if (usdtAmount < minUsdt) {
      toast.error(t("Số tiền nạp tối thiểu là {n} USDT", { n: minUsdt }));
      return;
    }
    if (vndAmount > cfg.max) {
      toast.error(t("Tối đa {n} mỗi lần nạp", { n: fmt.moneyBase(cfg.max) }));
      return;
    }
    createInvoice.mutate();
  };

  return (
    <div className="space-y-6">
      {activeInvoice ? (
        <ActiveUsdtInvoicePanel
          initial={activeInvoice}
          selectedNetKey={selectedNetKey}
          onSelectNet={setSelectedNetKey}
          onBackForm={() => {
            setActiveInvoice(null);
            setSelectedNetKey(null);
          }}
        />
      ) : (
        <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          {/* CỘT TRÁI: Form Nạp tiền bằng Crypto tông sáng hiện đại */}
          <section className="flex flex-col justify-between rounded-[28px] border bg-card p-5 shadow-xs sm:p-7">
            <div>
              {/* Tiêu đề + Chuyển nhanh Ngân hàng / Crypto */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CryptoCircleIcon className="size-10 shadow-sm" />
                  <div>
                    <h2 className="text-lg font-bold tracking-tight">{t("Nạp tiền bằng Crypto")}</h2>
                    <p className="text-xs text-muted-foreground">
                      {t("Thanh toán tự động qua USDT (TRC20, BEP20, Binance Pay)")}
                    </p>
                  </div>
                </div>

                {onSwitchBank && (
                  <div className="inline-flex rounded-full border bg-muted/50 p-1 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={onSwitchBank}
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-muted-foreground transition hover:text-foreground"
                    >
                      <BankCircleIcon className="size-4.5" /> {t("Ngân hàng")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-foreground shadow-xs"
                    >
                      <CryptoCircleIcon className="size-4.5" /> {t("Crypto")}
                    </button>
                  </div>
                )}
              </div>

              {/* Ô nhập số tiền USDT */}
              <label htmlFor="crypto-usdt-input" className="mt-6 block text-sm font-semibold">
                {t("Nhập số tiền USDT cần nạp")}
              </label>
              <div className="mt-2 flex items-center rounded-2xl border-2 bg-background px-4 transition focus-within:border-[#26A17B]">
                <input
                  id="crypto-usdt-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={rawUsdt}
                  onChange={(e) => setRawUsdt(e.target.value)}
                  placeholder={t("Ví dụ: 100")}
                  className="h-14 min-w-0 flex-1 bg-transparent text-3xl font-bold tracking-tight tabular-nums outline-none placeholder:text-xl placeholder:font-medium placeholder:text-muted-foreground/60"
                />
                <span className="inline-flex items-center gap-1.5 text-base font-bold text-[#26A17B]">
                  <CryptoCircleIcon className="size-5" /> USDT
                </span>
              </div>

              {/* Nút chọn nhanh mốc USDT */}
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[5, 10, 20, 50, 100, 200].map((u) => {
                  const active = usdtAmount === u;
                  return (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setRawUsdt(String(u))}
                      className={cn(
                        "flex h-10 items-center justify-center rounded-xl border text-xs font-bold tabular-nums transition",
                        active
                          ? "border-[#26A17B] bg-[#26A17B]/12 text-[#167c5c] ring-1 ring-[#26A17B]/35 dark:text-[#42d6a8]"
                          : "bg-card text-muted-foreground hover:border-[#26A17B]/45 hover:text-foreground",
                      )}
                    >
                      {u} USDT
                    </button>
                  );
                })}
              </div>

              {/* Khung Tỷ giá hôm nay */}
              <div className="mt-4 flex items-center justify-between rounded-2xl border bg-muted/35 px-4 py-2.5">
                <ArrowUpDown className="size-4 shrink-0 text-muted-foreground" />
                <div className="text-center">
                  <div className="text-[11px] font-medium text-muted-foreground">{t("Tỷ giá hôm nay")}</div>
                  <div className="mt-0.5 text-sm font-bold tracking-tight tabular-nums sm:text-base">
                    1 USDT = {usdtRate.toLocaleString("vi-VN")}đ
                  </div>
                </div>
                <TrendingUp className="size-4 shrink-0 text-[#26A17B]" />
              </div>

              {/* Khung Số tiền nhận được ước tính — căn giữa cân đối, tông xanh ngọc sáng nhẹ nhàng (T-172 & T-205) */}
              <div className="mt-4 rounded-2xl border border-[#26A17B]/25 bg-gradient-to-br from-[#26A17B]/[0.08] via-emerald-500/[0.04] to-background p-4 text-center sm:p-5">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">
                    {t("Số tiền bạn nhận được ước tính")}
                  </span>
                  {usdtAmount > 0 && quote.bonusPct > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#26A17B] px-2.5 py-0.5 text-[11px] font-bold text-white shadow-2xs">
                      <Gift className="size-3" /> +{quote.bonusPct}%
                    </span>
                  )}
                </div>
                <div className="mt-1.5 text-center text-3xl font-bold tracking-tight text-[#147a5b] tabular-nums sm:text-4xl dark:text-[#42d9ab]">
                  {usdtAmount > 0 ? fmt.moneyBase(quote.credits) : "0đ"}
                </div>
                {usdtAmount > 0 && quote.bonusCredits > 0 && (
                  <div className="mt-1 text-center text-xs font-medium text-muted-foreground tabular-nums">
                    {t("Gốc {base} + thưởng {bonus}", {
                      base: fmt.moneyBase(quote.base),
                      bonus: fmt.moneyBase(quote.bonusCredits),
                    })}
                  </div>
                )}
              </div>

              {/* Cổng / mạng lưới ví USDT hiện sẵn ngay bên ngoài để chọn nhanh (T-173 & T-174) */}
              <div className="mt-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-foreground sm:text-sm">
                    {t("Chọn cổng / mạng lưới ví USDT")}
                  </span>
                  {preselectedNet && (
                    <button
                      type="button"
                      onClick={() => setPreselectedNet(null)}
                      className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      {t("Chọn lại lúc tạo đơn")}
                    </button>
                  )}
                </div>
                <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                  {publicNetworks.map((net) => {
                    const meta = networkMeta(net);
                    const active = preselectedNet === net.network;
                    return (
                      <button
                        key={net.network}
                        type="button"
                        onClick={() => setPreselectedNet((cur) => (cur === net.network ? null : net.network))}
                        className={cn(
                          "flex items-center gap-3 rounded-2xl border p-3 text-left transition",
                          active
                            ? "border-[#26A17B] bg-[#26A17B]/[0.07] ring-2 ring-[#26A17B]/25"
                            : "bg-background hover:border-[#26A17B]/45 hover:bg-muted/30",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tracking-tight shadow-2xs",
                            meta.bg,
                            meta.text,
                          )}
                        >
                          {meta.badge}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-bold text-foreground sm:text-[13px]">
                            {net.label}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{t(meta.sub)}</span>
                        </span>
                        <span
                          className={cn(
                            "inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition",
                            active ? "border-[#26A17B]" : "border-muted-foreground/35",
                          )}
                        >
                          {active && <span className="size-2.5 rounded-full bg-[#26A17B]" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <button
                type="button"
                disabled={createInvoice.isPending || usdtAmount < minUsdt}
                onClick={handleSubmit}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#26A17B] text-sm font-bold text-white shadow-md shadow-[#26A17B]/20 transition hover:bg-[#1f8a68] disabled:opacity-50"
              >
                {createInvoice.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CryptoCircleIcon className="size-5 rounded-full ring-1 ring-white/40" />
                )}
                {preselectedNet
                  ? t("Tạo đơn & lấy mã ví {net}", {
                      net: publicNetworks.find((n) => n.network === preselectedNet)?.label ?? preselectedNet,
                    })
                  : t("Tạo đơn nạp tiền")}{" "}
                <ArrowRight className="size-4" />
              </button>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
                <Info className="size-3.5 shrink-0 text-[#26A17B]" />
                {t("Số tiền sẽ được cộng tự động vào tài khoản ngay sau khi thanh toán thành công")}
              </p>
            </div>
          </section>

          {/* CỘT PHẢI: Lưu ý & Bảng khuyến mãi mốc USDT */}
          <div className="flex flex-col gap-5">
            <section className="rounded-[28px] border bg-card p-5 shadow-xs sm:p-6">
              <div className="flex items-center gap-2.5 border-b pb-3.5">
                <span className="inline-flex size-8 items-center justify-center rounded-xl bg-[#26A17B]/12 text-[#167c5c] dark:text-[#42d6a8]">
                  <AlertTriangle className="size-4" />
                </span>
                <h3 className="text-sm font-bold tracking-tight">{t("Lưu ý khi nạp Crypto")}</h3>
              </div>
              <ul className="mt-4 space-y-2.5 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                <li>
                  • {t("Hạn mức nạp tối thiểu:")} <b className="text-foreground">{minUsdt} USDT</b>.
                </li>
                <li>
                  • {t("Bạn có thể chọn sẵn mạng ví")} <b className="text-foreground">Tron (TRC20)</b> {t("hoặc")}{" "}
                  <b className="text-foreground">BNB Smart Chain (BEP20)</b>{" "}
                  {t("ngay trên form hoặc chọn ở bước kế tiếp sau khi tạo đơn.")}
                </li>
                <li>
                  • {t("Vui lòng chuyển ĐÚNG mạng lưới và ĐÚNG số USDT (gồm cả phần số lẻ thập phân) hiển thị trên hoá đơn.")}
                </li>
                <li>
                  • {t("Hệ thống đối soát tự động 24/7, cộng tiền vào số dư sau 1–3 phút khi giao dịch hoàn tất trên blockchain.")}
                </li>
              </ul>
            </section>

            {cfg.tiers.length > 0 && (
              <section className="flex-1 overflow-hidden rounded-[28px] border bg-card shadow-xs">
                <div className="flex items-center gap-2.5 border-b px-5 py-4 sm:px-6">
                  <span className="inline-flex size-8 items-center justify-center rounded-xl bg-[#26A17B]/12 text-[#167c5c] dark:text-[#42d6a8]">
                    <Percent className="size-4" />
                  </span>
                  <h3 className="text-sm font-bold tracking-tight">{t("Khuyến mãi nạp thêm")}</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="border-b bg-muted/40 text-[11px] font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-5 py-2.5">{t("Nạp từ mức")}</th>
                        <th className="px-5 py-2.5 text-right">{t("Thưởng thêm")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {cfg.tiers.map((tier) => {
                        const approxUsdt = Math.ceil((tier.min / usdtRate) * 100) / 100;
                        const reached = vndAmount >= tier.min;
                        return (
                          <tr key={tier.min} className={cn(reached && "bg-emerald-500/[0.06]")}>
                            <td className="px-5 py-2.5 font-medium tabular-nums">
                              <b className="text-foreground">
                                {approxUsdt.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} USDT
                              </b>{" "}
                              <span className="text-xs text-muted-foreground">({fmt.moneyBase(tier.min)})</span>
                            </td>
                            <td className="px-5 py-2.5 text-right font-bold text-[#167c5c] tabular-nums dark:text-[#42d6a8]">
                              +{tier.bonus}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* BẢNG LỊCH SỬ NẠP CRYPTO */}
      {!compact && authed && <CryptoHistorySection />}
    </div>
  );
}

/**
 * Màn hình thanh toán hoá đơn USDT vừa tạo:
 * - Bước 1 (khi `selectedNetKey === null`): Chọn mạng lưới / ví USDT (`Tron TRC20`, `BNB Smart Chain BEP20`, `Binance Pay`...) giống hệt giao diện chuẩn USDT Gateway (T-167).
 * - Bước 2 (khi đã chọn mạng): Hiện mã QR + Địa chỉ ví nhận + Số USDT chính xác cần chuyển + Đếm ngược + Tự động đối soát mỗi 5 giây.
 */
function ActiveUsdtInvoicePanel({
  initial,
  selectedNetKey,
  onSelectNet,
  onBackForm,
}: {
  initial: Topup;
  selectedNetKey: string | null;
  onSelectNet: (net: string | null) => void;
  onBackForm: () => void;
}) {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const networks = initial.usdt?.networks ?? [];
  const chosenNet = networks.find((n) => n.network === selectedNetKey) ?? null;

  const q = useQuery({
    queryKey: ["wallet", "topup", "usdt-live", initial.id, chosenNet?.walletId ?? "none"],
    queryFn: () =>
      api.get<Topup>(`/account/wallet/topups/${initial.id}`, {
        ...(chosenNet?.walletId ? { walletId: chosenNet.walletId } : {}),
      }),
    initialData: initial,
    refetchInterval: (query) => (query.state.data?.status === "PENDING" ? 6000 : false),
    meta: { silentError: true },
  });

  const tx = q.data ?? initial;
  const payUsdt = tx.usdt?.amount ?? "—";

  useEffect(() => {
    if (tx.status === "PAID") {
      toast.success(t("Nạp tiền USDT thành công! Đã cộng vào số dư ví."));
      qc.invalidateQueries({ queryKey: ["credits"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.status]);

  const remaining = useInvoiceCountdown(tx.expiresAt ? new Date(tx.expiresAt).getTime() : null);

  if (tx.status === "PAID") {
    return (
      <section className="mx-auto max-w-2xl rounded-[28px] border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto inline-flex size-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-9" />
        </span>
        <h2 className="mt-4 text-2xl font-bold">{t("Nạp tiền Crypto thành công!")}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("Hệ thống đã xác nhận giao dịch {u} USDT và cộng tiền vào số dư ví của bạn.", { u: payUsdt })}
        </p>
        <button
          type="button"
          onClick={onBackForm}
          className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-[#26A17B] px-6 text-sm font-bold text-white shadow-sm hover:bg-[#1f8a68]"
        >
          <Sparkles className="size-4" /> {t("Tạo đơn nạp mới")}
        </button>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl overflow-hidden rounded-[28px] border bg-card shadow-sm">
      {/* Thanh tiêu đề kiểu USDT Gateway */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-5 py-4 sm:px-7">
        <div className="flex items-center gap-3">
          <CryptoCircleIcon className="size-9 shadow-2xs" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold sm:text-base">
                {t("Thanh toán")} <span className="text-[#26A17B] tabular-nums">{payUsdt} USDT</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="size-3" /> {t("Đối soát tự động")}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("Mã đơn:")} <span className="font-mono font-semibold">{tx.reference || tx.transferContent}</span> ·{" "}
              {t("Nạp")} <b className="text-foreground">{fmt.moneyBase(tx.amount)}</b>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {remaining !== null && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold tabular-nums",
                remaining < 120
                  ? "bg-red-500/12 text-red-600 dark:text-red-400"
                  : "bg-amber-500/15 text-amber-800 dark:text-amber-300",
              )}
            >
              <Clock className="size-3.5" />
              {remaining > 0 ? `${t("Còn")} ${fmtSec(remaining)}` : t("Đã hết hạn")}
            </span>
          )}
          <button
            type="button"
            onClick={onBackForm}
            className="inline-flex h-8 items-center gap-1 rounded-full border bg-background px-3 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> {t("Đổi số tiền")}
          </button>
        </div>
      </div>

      {/* BƯỚC 1: CHỌN MẠNG LƯỚI / VÍ USDT (luôn hiện trước khi khách chưa chọn mạng — T-167) */}
      {!chosenNet ? (
        <div className="p-6 sm:p-8">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#26A17B]/12 px-3 py-1 text-[11px] font-bold tracking-wider text-[#167c5c] uppercase dark:text-[#42d6a8]">
              1 · {t("Chọn phương thức")}
            </span>
            <h3 className="mt-2.5 text-xl font-bold tracking-tight sm:text-2xl">
              {t("Chọn mạng lưới / ví USDT thanh toán")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              {t("Chọn đúng mạng lưới mà ví của bạn đang sử dụng để tránh thất lạc tài sản.")}
            </p>
          </div>

          <div className="mx-auto mt-6 grid max-w-2xl gap-3.5 sm:grid-cols-2">
            {networks.map((net) => {
              const meta = networkMeta(net);
              return (
                <button
                  key={net.network}
                  type="button"
                  onClick={() => onSelectNet(net.network)}
                  className="group flex items-center gap-3.5 rounded-2xl border bg-background p-4 text-left shadow-2xs transition hover:-translate-y-0.5 hover:border-[#26A17B] hover:shadow-md"
                >
                  <span
                    className={cn(
                      "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-xs font-bold shadow-xs",
                      meta.bg,
                      meta.text,
                    )}
                  >
                    {meta.badge}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-foreground">{net.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(meta.sub)}</span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-[#26A17B]" />
                </button>
              );
            })}
          </div>

          <p className="mt-6 text-center text-xs text-amber-700 dark:text-amber-300">
            ⚠️ {t("Mạng gửi và mạng nhận bắt buộc phải trùng khớp. Chuyển nhầm mạng lưới có thể không khôi phục được.")}
          </p>
        </div>
      ) : (
        /* BƯỚC 2: QUÉT QR & ĐỊA CHỈ VÍ CỦA MẠNG ĐÃ CHỌN */
        <div className="p-5 sm:p-7">
          {/* Thanh chuyển nhanh giữa các mạng ngay phía trên */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {networks.map((net) => {
                const meta = networkMeta(net);
                const active = net.network === chosenNet.network;
                return (
                  <button
                    key={net.network}
                    type="button"
                    onClick={() => onSelectNet(net.network)}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-xs font-bold transition",
                      active
                        ? "border-[#26A17B] bg-[#26A17B]/12 text-[#167c5c] ring-1 ring-[#26A17B]/30 dark:text-[#42d6a8]"
                        : "bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className={cn("inline-flex size-5 items-center justify-center rounded-full text-[9px] font-bold", meta.bg, meta.text)}>
                      {meta.badge}
                    </span>
                    {net.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => onSelectNet(null)}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              ← {t("Chọn mạng khác")}
            </button>
          </div>

          <div className="grid items-start gap-6 md:grid-cols-[250px_minmax(0,1fr)]">
            {/* Mã QR ví USDT */}
            <div className="flex flex-col items-center rounded-2xl border bg-white p-4 text-center shadow-2xs">
              {chosenNet.qr ? (
                <QrImage value={chosenNet.qr} imageUrl={chosenNet.qr} size={215} className="p-0" />
              ) : (
                <div className="flex h-[215px] items-center justify-center px-3 text-xs text-zinc-500">
                  {t("Sao chép địa chỉ nhận bên cạnh để chuyển thủ công.")}
                </div>
              )}
              <span className="mt-2.5 text-xs font-semibold text-zinc-700">
                {chosenNet.kind === "binance" ? t("Quét bằng ứng dụng Binance") : t("Quét mã bằng ví Crypto của bạn")}
              </span>
            </div>

            {/* Thông tin số lượng & địa chỉ ví nhận */}
            <div className="space-y-3.5">
              <div className="divide-y rounded-2xl border bg-muted/35 text-xs sm:text-sm">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-muted-foreground">{t("Số tiền chuyển chính xác")}</span>
                  <span className="flex items-center gap-1.5">
                    <b className="rounded-lg bg-[#26A17B]/15 px-2.5 py-0.5 font-mono text-base font-bold text-[#147a5b] tabular-nums dark:text-[#42d9ab]">
                      {payUsdt} USDT
                    </b>
                    <CopyButton value={payUsdt} label={t("Số tiền USDT")} size="icon-xs" />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-muted-foreground">{t("Mạng lưới")}</span>
                  <span className="font-bold text-foreground">{chosenNet.label}</span>
                </div>
                {chosenNet.address && (
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="shrink-0 text-muted-foreground">
                      {chosenNet.kind === "binance" ? "Binance Pay ID" : t("Địa chỉ ví nhận")}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 font-mono text-xs font-bold break-all text-right text-foreground sm:text-[13px]">
                        {chosenNet.address}
                      </span>
                      <CopyButton value={chosenNet.address} label={t("Địa chỉ ví")} size="icon-xs" />
                    </span>
                  </div>
                )}
                {chosenNet.memo && (
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="text-muted-foreground">{t("Memo / Tag (bắt buộc)")}</span>
                    <span className="flex items-center gap-1.5">
                      <b className="font-mono text-foreground">{chosenNet.memo}</b>
                      <CopyButton value={chosenNet.memo} label="Memo" size="icon-xs" />
                    </span>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
                • {t("Bắt buộc chuyển ĐÚNG")}{" "}
                <b className="font-mono underline">{payUsdt} USDT</b>{" "}
                {t("(bao gồm cả phần thập phân lẻ để hệ thống nhận diện tự động hoá đơn của bạn).")}
                <br />• {t("Chỉ gửi USDT trên mạng")} <b>{chosenNet.label}</b>.
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-[#167c5c] dark:text-[#42d6a8]">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("Đang chờ thanh toán... Hệ thống tự động cộng số dư sau 1–3 phút xác nhận.")}
                </span>
                {tx.checkoutUrl && (
                  <a
                    href={tx.checkoutUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {t("Mở trang cổng")} <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function useInvoiceCountdown(targetMs: number | null) {
  const calc = () => (targetMs === null ? null : Math.max(0, Math.floor((targetMs - Date.now()) / 1000)));
  const [left, setLeft] = useState<number | null>(calc);
  useEffect(() => {
    setLeft(calc());
    if (targetMs === null) return;
    const id = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMs]);
  return left;
}

function fmtSec(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function CryptoHistorySection() {
  const { t, fmt } = useI18n();
  const [searchCode, setSearchCode] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const q = useQuery({
    queryKey: ["wallet", "topups", "crypto-history"],
    queryFn: () => api.get<Paginated<Topup>>("/account/wallet/topups", { page: 1, limit: 50 }),
    staleTime: 20_000,
    meta: { silentError: true },
  });

  const cryptoRows = useMemo(() => {
    const all = (q.data?.data ?? []).filter(
      (tx) => isUsdtProvider(tx.provider, "") || !!tx.usdt || !!tx.crypto,
    );
    return all.filter((tx) => {
      const code = (tx.reference || tx.transferContent || tx.id).toLowerCase();
      if (searchCode.trim() && !code.includes(searchCode.trim().toLowerCase())) return false;
      if (statusFilter === "waiting" && tx.status !== "PENDING") return false;
      if (statusFilter === "completed" && tx.status !== "PAID") return false;
      if (statusFilter === "expired" && !["EXPIRED", "CANCELLED", "FAILED"].includes(tx.status)) return false;
      return true;
    });
  }, [q.data, searchCode, statusFilter]);

  const paidTotal = useMemo(
    () =>
      cryptoRows
        .filter((r) => r.status === "PAID")
        .reduce((s, r) => s + Number(r.amount || 0) + Number(r.bonus || 0), 0),
    [cryptoRows],
  );
  const waitingTotal = useMemo(
    () =>
      cryptoRows
        .filter((r) => r.status === "PENDING")
        .reduce((s, r) => s + Number(r.amount || 0), 0),
    [cryptoRows],
  );

  return (
    <section className="overflow-hidden rounded-[28px] border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-muted text-foreground">
            <Clock className="size-4" />
          </span>
          <h3 className="text-sm font-bold tracking-tight">{t("Lịch sử nạp Crypto")}</h3>
        </div>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="inline-flex h-8 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-medium transition hover:bg-muted"
        >
          <RotateCcw className={cn("size-3.5", q.isFetching && "animate-spin")} /> {t("Làm mới")}
        </button>
      </div>

      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-9 min-w-[200px] flex-1 items-center rounded-xl border bg-background px-3">
            <Search className="mr-2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={searchCode}
              onChange={(e) => setSearchCode(e.target.value)}
              placeholder={t("Tìm mã giao dịch...")}
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
                <th className="px-4 py-3">{t("Mã giao dịch")}</th>
                <th className="px-4 py-3 text-right">{t("Số lượng")}</th>
                <th className="px-4 py-3 text-right">{t("Thực nhận")}</th>
                <th className="px-4 py-3 text-center">{t("Trạng thái")}</th>
                <th className="px-4 py-3">{t("Thời gian tạo")}</th>
                <th className="px-4 py-3">{t("Cổng nạp")}</th>
                <th className="px-4 py-3 text-center">{t("Thao tác")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {cryptoRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-xs text-muted-foreground">
                    {t("Chưa có giao dịch nạp Crypto nào.")}
                  </td>
                </tr>
              ) : (
                cryptoRows.map((row) => {
                  const code = row.reference || row.transferContent || row.id.slice(0, 8).toUpperCase();
                  const usdtStr = row.usdt?.amount ?? row.crypto?.amount ?? "—";
                  const receivedVnd = Number(row.amount || 0) + Number(row.bonus || 0);
                  const gatewayLabel = row.crypto
                    ? "Binance Pay"
                    : /fpayment/i.test(row.provider)
                      ? "FPayment USDT"
                      : "USDT Gateway";
                  return (
                    <tr key={row.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-mono text-xs font-semibold">{code}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <b>{usdtStr}</b> <span className="font-semibold text-[#26A17B]">USDT</span>
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums">
                        {fmt.moneyBase(receivedVnd)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                        {new Date(row.createdAt).toLocaleString("vi-VN")}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold">
                          <CryptoCircleIcon className="size-3.5" />
                          <span>{gatewayLabel}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {row.checkoutUrl ? (
                          <a
                            href={row.checkoutUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition hover:bg-muted"
                          >
                            {row.status === "PENDING" ? t("Thanh toán") : t("Xem")}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            <tfoot className="border-t bg-muted/30 text-xs">
              <tr>
                <td colSpan={7} className="px-4 py-3 text-right text-muted-foreground">
                  {t("Đã thanh toán:")}{" "}
                  <strong className="text-foreground tabular-nums">{fmt.moneyBase(paidTotal)}</strong>
                  {" · "}
                  {t("Chưa thanh toán:")}{" "}
                  <strong className="text-foreground tabular-nums">{fmt.moneyBase(waitingTotal)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
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
