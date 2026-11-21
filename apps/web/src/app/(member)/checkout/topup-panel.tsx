"use client";

/**
 * Hiển thị một giao dịch thanh toán gói cước qua cổng (lưu dưới dạng giao dịch nạp ví, nhận tiền xong API tự mua gói): QR, thông tin chuyển khoản, nội dung CK, đếm ngược hết hạn,
 * nút mở cổng thanh toán (checkoutUrl). Khi còn PENDING thì hỏi `GET /api/account/wallet/topups/:id` mỗi 5 giây.
 * USDT (tx.usdt): hiện số USDT + tỉ giá, khách bấm "Mở trang thanh toán" sang USDT Gateway để chọn mạng và lấy địa chỉ ví.
 * Binance Pay (tx.crypto): hiện số coin + Binance Pay ID + mã ghi chú (Note) thay cho thông tin ngân hàng / nội dung chuyển khoản.
 * Nạp thủ công (tx.manual): hiện hướng dẫn của quản trị viên + nút "Tôi đã chuyển khoản" (`POST /api/account/wallet/topups/:id/notify`).
 * `paidSlot` (tuỳ chọn): nội dung thay cho màn "Nạp tiền thành công" (vd trang thanh toán gói hiện trạng thái kích hoạt gói).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CheckCircle2, Clock, ExternalLink, Loader2, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/common";
import { QrImage } from "@/components/qr-image";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import type { Topup } from "@/lib/types";

/** Nhãn trạng thái giao dịch nạp */
export const TOPUP_STATUS: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Chờ thanh toán", className: "bg-amber-500/12 text-amber-600 dark:text-amber-400" },
  PAID: { label: "Thành công", className: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  FAILED: { label: "Thất bại", className: "bg-red-500/12 text-red-600 dark:text-red-400" },
  CANCELLED: { label: "Đã huỷ", className: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400" },
  EXPIRED: { label: "Hết hạn", className: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400" },
};

export function TopupPanel({ initial, id, cancelled, onClose, paidSlot }: { initial?: Topup | null; id: string; cancelled?: boolean; onClose?: () => void; paidSlot?: ReactNode }) {
  const qc = useQueryClient();
  const { t, fmt } = useI18n();
  const q = useQuery({
    queryKey: ["wallet", "topup", id],
    queryFn: () => api.get<Topup>(`/account/wallet/topups/${id}`),
    initialData: initial ?? undefined,
    // hỏi định kỳ khi còn chờ thanh toán (API tự hỏi cổng nếu webhook chưa tới)
    refetchInterval: (query) => (query.state.data?.status === "PENDING" ? 5000 : false),
    retry: 1,
  });
  const tx = q.data;

  // nạp thủ công: khách báo đã chuyển khoản -> quản trị viên thấy ghi chú ở Giao dịch nạp ví
  const notify = useMutation({
    mutationFn: () => api.post<Topup>(`/account/wallet/topups/${id}/notify`),
    onSuccess: (data) => {
      qc.setQueryData(["wallet", "topup", id], data);
      qc.invalidateQueries({ queryKey: ["wallet", "topups"] });
      toast.success(t("Đã báo quản trị viên, vui lòng chờ kiểm tra."));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // thanh toán xong -> làm mới số dư + lịch sử
  useEffect(() => {
    if (tx?.status === "PAID") {
      qc.invalidateQueries({ queryKey: ["wallet", "summary"] });
      qc.invalidateQueries({ queryKey: ["wallet", "topups"] });
      qc.invalidateQueries({ queryKey: ["wallet", "transactions"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    }
  }, [tx?.status, qc]);

  // chênh lệch giờ máy khách so với máy chủ để đếm ngược chính xác
  const serverNow = tx?.serverNow;
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(serverNow ? new Date(serverNow).getTime() - Date.now() : 0);
  }, [serverNow]);
  const remaining = useCountdown(tx?.expiresAt ? new Date(tx.expiresAt).getTime() : null, offset);

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t("Đang tải giao dịch...")}
      </div>
    );
  }
  if (!tx) return <p className="py-8 text-center text-sm text-destructive">{t("Không tìm thấy giao dịch thanh toán.")}</p>;

  if (tx.status === "PAID" && paidSlot) return <>{paidSlot}</>;
  if (tx.status === "PAID") {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="inline-flex size-16 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-8" />
        </span>
        <p className="text-xl font-bold">{t("Nạp tiền thành công!")}</p>
        <p className="text-sm text-muted-foreground">
          {/* số tiền cộng vào ví hiển thị theo tiền tệ khách chọn */}
          {tx.paidAt
            ? t("Đã cộng {amount} vào số dư lúc {time}.", { amount: tx.bonus ? t("{amount} + bonus {bonus}", { amount: fmt.money(tx.amount), bonus: fmt.money(tx.bonus) }) : fmt.money(tx.amount), time: fmt.dateTime(tx.paidAt) })
            : t("Đã cộng {amount} vào số dư.", { amount: tx.bonus ? t("{amount} + bonus {bonus}", { amount: fmt.money(tx.amount), bonus: fmt.money(tx.bonus) }) : fmt.money(tx.amount) })}
        </p>
        {onClose && (
          <Button className="mt-3 rounded-xl font-bold" onClick={onClose}>
            {t("Nạp thêm")}
          </Button>
        )}
      </div>
    );
  }

  if (tx.status !== "PENDING" || cancelled) {
    const s = TOPUP_STATUS[tx.status];
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="inline-flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <XCircle className="size-8" />
        </span>
        <p className="text-xl font-bold">{cancelled && tx.status === "PENDING" ? t("Bạn đã huỷ thanh toán") : t("Giao dịch {status}", { status: s ? t(s.label).toLowerCase() : tx.status })}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{tx.note || t("Bạn có thể tạo giao dịch thanh toán mới bất cứ lúc nào.")}</p>
        <div className="mt-3 flex gap-2">
          {cancelled && tx.status === "PENDING" && tx.checkoutUrl && (
            <Button asChild variant="outline">
              <a href={tx.checkoutUrl}>{t("Thanh toán lại")}</a>
            </Button>
          )}
          {onClose && <Button className="rounded-xl font-bold" onClick={onClose}>{t("Tạo giao dịch mới")}</Button>}
        </div>
      </div>
    );
  }

  const crypto = tx.crypto;
  const usdt = tx.usdt;
  const hasTransfer = !!(tx.bank || tx.transferContent || crypto);
  return (
    // container query: chỉ chia 2 cột (QR | thông tin) khi chính khung đủ rộng (~640px),
    // cột trái trang Nạp tiền hẹp nên QR nằm trên, thông tin chuyển khoản bên dưới đủ rộng để không bẻ chữ
    <div className="@container">
      <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-[auto_minmax(0,1fr)] @2xl:gap-6">
      {/* grid-cols-1 trên mobile để thông tin chuyển khoản dài không đẩy khung rộng quá màn hình */}
      {(tx.qrImageUrl || tx.qrData) && (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-2xl border bg-white p-2 shadow-xs">
            <QrImage value={tx.qrData} imageUrl={tx.qrImageUrl} size={200} />
          </div>
          <p className="text-xs text-muted-foreground">{crypto ? t("Quét mã bằng app Binance") : t("Quét mã bằng app ngân hàng")}</p>
        </div>
      )}
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">
            <Loader2 className="size-3.5 animate-spin" /> {tx.manual?.notifiedAt ? t("Đang chờ quản trị viên duyệt") : t("Đang chờ thanh toán")}
          </span>
          {remaining !== null && (
            <span className={`inline-flex items-center gap-1.5 text-sm font-medium tabular-nums ${remaining < 120 ? "text-destructive" : "text-muted-foreground"}`}>
              <Clock className="size-4" /> {remaining > 0 ? t("Hết hạn sau {time}", { time: fmtDuration(remaining) }) : t("Đã hết hạn")}
            </span>
          )}
        </div>
        {/* bảng thông tin chuyển khoản: hộp nền muted giống "Ghi chú phương thức" của mẫu */}
        <div className="divide-y divide-border/70 rounded-xl bg-muted">
          {usdt ? (
            <>
              {/* số USDT có phần lẻ do gateway cộng để phân biệt hoá đơn: phải chuyển đúng từng chữ số */}
              <Field label={t("Số tiền cần chuyển")} value={`${usdt.amount} ${usdt.currency}`} copy={usdt.amount} strong />
              {usdt.rate > 0 && <Field label={t("Tỉ giá")} value={`1 ${usdt.currency} = ${fmt.moneyBase(usdt.rate)}`} />}
              <Field label={t("Số tiền nạp")} value={fmt.moneyBase(tx.amount)} />
            </>
          ) : crypto ? (
            <>
              {/* phải chuyển ĐÚNG số coin + ghi mã nạp cố định của tài khoản vào ô Ghi chú để hệ thống nhận ra giao dịch (giao dịch cũ không có memo) */}
              <Field label={t("Số tiền cần chuyển")} value={`${crypto.amount} ${crypto.currency}`} copy={crypto.amount} strong />
              <Field label={t("Binance Pay ID")} value={crypto.payId} copy={crypto.payId} />
              {crypto.memo && <Field label={t("Ghi chú (Note)")} value={crypto.memo} copy={crypto.memo} strong />}
              <Field label={t("Số tiền nạp")} value={fmt.moneyBase(tx.amount)} />
            </>
          ) : (
            /* số tiền chuyển khoản là tiền thật theo tiền gốc */
            <Field label={t("Số tiền")} value={fmt.moneyBase(tx.amount)} copy={String(tx.amount)} strong />
          )}
          {tx.bank && (
            <>
              <Field label={t("Ngân hàng")} value={tx.bank.bankName} />
              <Field label={t("Số tài khoản")} value={tx.bank.accountNumber} copy={tx.bank.accountNumber} />
              <Field label={t("Chủ tài khoản")} value={tx.bank.accountName} />
            </>
          )}
          {tx.transferContent && !crypto && !usdt && <Field label={t("Nội dung chuyển khoản")} value={tx.transferContent} copy={tx.transferContent} strong />}
        </div>
        {usdt ? (
          <p className="text-xs text-muted-foreground">
            {t("Bấm \"Mở trang thanh toán\", chọn mạng (TRC20, BEP20...) rồi chuyển ĐÚNG {amount} {coin} tới địa chỉ ví hiển thị. Số dư được cộng tự động khi giao dịch xác nhận trên blockchain, trang này tự cập nhật.", { amount: usdt.amount, coin: usdt.currency })}
          </p>
        ) : crypto ? (
          <p className="text-xs text-muted-foreground">
            {crypto.memo
              ? t("Mở app Binance → Pay → Gửi, nhập Binance Pay ID, chuyển ĐÚNG {amount} {coin} và ghi mã {memo} vào ô Ghi chú (Note). Đây là mã nạp cố định của tài khoản bạn, các lần nạp sau vẫn ghi đúng mã này. Thiếu mã hoặc sai số tiền sẽ không được cộng tự động. Hệ thống tự cộng tiền trong khoảng 30 giây, trang này tự cập nhật.", { amount: crypto.amount, coin: crypto.currency, memo: crypto.memo })
              : t("Mở app Binance → Pay → Gửi, nhập Binance Pay ID và chuyển ĐÚNG {amount} {coin} (không làm tròn). Hệ thống tự cộng tiền trong khoảng 30 giây, trang này tự cập nhật.", { amount: crypto.amount, coin: crypto.currency })}
          </p>
        ) : tx.manual ? (
          <>
            {tx.manual.note && <p className="whitespace-pre-line rounded-xl border border-dashed px-3.5 py-2.5 text-xs">{tx.manual.note}</p>}
            <p className="text-xs text-muted-foreground">{t("Chuyển đúng số tiền và nội dung rồi bấm \"Tôi đã chuyển khoản\". Quản trị viên sẽ kiểm tra và cộng tiền, trang này tự cập nhật khi được duyệt.")}</p>
            {tx.manual.notifiedAt ? (
              <p className="flex items-center gap-1.5 rounded-xl bg-success-soft px-3.5 py-2.5 text-xs">
                <BadgeCheck className="size-4 shrink-0 text-success" /> {t("Bạn đã báo chuyển khoản lúc {time}. Vui lòng chờ quản trị viên kiểm tra.", { time: fmt.dateTime(tx.manual.notifiedAt) })}
              </p>
            ) : (
              <Button size="lg" className="h-12 w-full rounded-xl text-sm font-bold tracking-wide uppercase" disabled={notify.isPending} onClick={() => notify.mutate()}>
                {notify.isPending ? <Loader2 className="animate-spin" /> : <BadgeCheck />} {t("Tôi đã chuyển khoản")}
              </Button>
            )}
          </>
        ) : (
          hasTransfer && <p className="text-xs text-muted-foreground">{t("Chuyển đúng số tiền và nội dung để hệ thống tự kích hoạt gói sau vài giây. Trang này tự cập nhật khi nhận được tiền.")}</p>
        )}
        {tx.checkoutUrl && (
          <Button asChild size="lg" className="h-12 w-full rounded-xl text-sm font-bold tracking-wide uppercase">
            <a href={tx.checkoutUrl} rel="noopener noreferrer">
              <ExternalLink /> {t("Mở trang thanh toán")}
            </a>
          </Button>
        )}
        {onClose && (
          <Button variant="outline" className="h-11 w-full rounded-xl" onClick={onClose}>
            <RotateCcw /> {t("Tạo giao dịch khác")}
          </Button>
        )}
      </div>
      </div>
    </div>
  );
}

function Field({ label, value, copy, strong }: { label: string; value: string; copy?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      {/* nhãn được xuống dòng, giá trị giữ đủ rộng (tối đa 75%) để mã nội dung CK không bị bẻ vụn */}
      <span className="shrink-0 text-xs whitespace-nowrap text-subtle-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1">
        {/* xuống dòng thay vì cắt "..." — nội dung CK / chủ tài khoản phải đọc được đầy đủ khi cột hẹp */}
        <span className={`min-w-0 text-right wrap-anywhere ${strong ? "font-bold text-primary" : "font-medium"}`}>{value}</span>
        {copy && <CopyButton value={copy} label={label} size="icon-xs" />}
      </span>
    </div>
  );
}

/** Đếm ngược số giây còn lại tới mốc thời gian (theo giờ máy chủ) */
function useCountdown(target: number | null, offset: number) {
  const calc = () => (target === null ? null : Math.max(0, Math.floor((target - (Date.now() + offset)) / 1000)));
  const [left, setLeft] = useState<number | null>(calc);
  useEffect(() => {
    setLeft(calc());
    if (target === null) return;
    const t = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, offset]);
  return left;
}

/** Định dạng thời gian còn lại: m:ss, từ 1 giờ trở lên (nạp thủ công chờ duyệt lâu) thì h:mm:ss */
function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
