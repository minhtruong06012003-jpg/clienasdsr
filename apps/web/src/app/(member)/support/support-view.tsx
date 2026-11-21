"use client";

/**
 * Trung tâm Hỗ trợ & Ticket ngay trên website — thiết kế chuẩn phong cách hiện đại như `yupvox.com/support`:
 * - Đầu trang: Tiêu đề + mô tả trực 24/7 + nút `+ Tạo Ticket mới`.
 * - Thanh lọc trạng thái có số đếm: `Tất cả (N)`, `Đang mở (N)`, `Đã phản hồi (N)`, `Đã đóng (N)` + ô tìm kiếm nhanh.
 * - Bố cục 2 cột:
 *   + Cột trái: Danh sách Ticket của khách -> bấm mở hộp thoại hội thoại 2 chiều trực tiếp với đội ngũ hỗ trợ.
 *   + Cột phải: Các thẻ kênh hỗ trợ nhanh (Telegram, Email, Thời gian phản hồi 15–30 phút 24/7).
 * - Tự mở popup Tạo Ticket mới kèm sẵn `Mã đơn` khi khách bấm nút phao Hỗ trợ từ trang `/history` (`?new=1&orderCode=...`).
 */
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  Headphones,
  ImagePlus,
  LifeBuoy,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquarePlus,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ErrorState, Pager } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { useBootstrap } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { Ticket, TicketAttachment, TicketCategory, TicketList } from "@/lib/types";

const CATEGORIES: { value: TicketCategory; label: string }[] = [
  { value: "ORDER", label: "Báo lỗi đơn / Tác vụ AI" },
  { value: "PAYMENT", label: "Nạp tiền & Thanh toán" },
  { value: "SERVICE", label: "Góp ý dịch vụ / Model AI" },
  { value: "API", label: "API & Website con" },
  { value: "OTHER", label: "Vấn đề khác" },
];

const STATUS_TABS = [
  { value: "", label: "Tất cả", countKey: "ALL" },
  { value: "OPEN", label: "Đang mở", countKey: "OPEN" },
  { value: "ANSWERED", label: "Đã phản hồi", countKey: "ANSWERED" },
  { value: "CLOSED", label: "Đã đóng", countKey: "CLOSED" },
] as const;

function categoryLabelOf(cat: string) {
  return CATEGORIES.find((c) => c.value === cat)?.label ?? "Hỗ trợ chung";
}

function statusMeta(status: string) {
  if (status === "ANSWERED") {
    return {
      label: "Đã phản hồi",
      cls: "border border-emerald-200/70 bg-emerald-50/65 text-[#1f7a5c] dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300",
    };
  }
  if (status === "CLOSED") {
    return {
      label: "Đã đóng",
      cls: "border border-slate-200/80 bg-slate-100/75 text-slate-600 dark:border-white/10 dark:bg-zinc-500/15 dark:text-zinc-400",
    };
  }
  return {
    label: status === "CUSTOMER_REPLY" ? "Chờ hỗ trợ viên" : "Đang mở",
    cls: "border border-amber-200/70 bg-amber-50/65 text-[#9a5b13] dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300",
  };
}

export function SupportView() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const boot = useBootstrap();

  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefillOrderCode, setPrefillOrderCode] = useState("");
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);

  // Tự mở form tạo ticket mới nếu vào từ nút Hỗ trợ ở trang Lịch sử (?new=1&orderCode=...)
  useEffect(() => {
    if (params.get("new") === "1") {
      setPrefillOrderCode(params.get("orderCode") ?? "");
      setCreateOpen(true);
      router.replace("/support", { scroll: false });
    }
  }, [params, router]);

  const q = useQuery({
    queryKey: ["account", "tickets", { status, page }],
    queryFn: () => api.get<TicketList>("/account/tickets", { status: status || undefined, page, limit: 15 }),
    refetchInterval: 15_000,
  });

  const counts = q.data?.counts ?? { ALL: 0, OPEN: 0, ANSWERED: 0, CLOSED: 0 };

  // Đọc thông tin liên hệ nhanh của site từ cài đặt chung / nút liên hệ
  const supportInfo = useMemo(() => {
    const general = (boot.data?.settings?.general ?? {}) as { contactEmail?: string; email?: string };
    const contacts = ((boot.data?.settings?.contact_buttons as { items?: { type?: string; value?: string; url?: string; enabled?: boolean }[] } | undefined)?.items ?? []).filter(
      (i) => i.enabled !== false,
    );
    const menuItems = boot.data?.settings?.web_menu?.items ?? [];
    const tgBtn = contacts.find((c) => /telegram/i.test(`${c.type ?? ""} ${c.url ?? ""} ${c.value ?? ""}`));
    const tgMenu = menuItems.find((m) => /t\.me\//i.test(m.href));
    const tgUrl = tgBtn?.url || tgBtn?.value || tgMenu?.href || "";
    const tgHandle = tgUrl ? tgUrl.replace(/^https?:\/\/(www\.)?t\.me\//i, "@").replace(/\/+$/, "") : "";
    const email = general.contactEmail || general.email || "";
    return { tgUrl, tgHandle, email };
  }, [boot.data]);

  return (
    <div className="space-y-6 pt-2">
      {/* Đầu trang chuẩn Yupvox Support Center & Tickets */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t("Trung tâm Hỗ trợ & Ticket")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Gửi yêu cầu hỗ trợ kỹ thuật, kiểm tra đơn hàng AI hoặc vấn đề nạp tiền. Đội ngũ hỗ trợ trực 24/7.")}
          </p>
        </div>

        <Button
          onClick={() => {
            setPrefillOrderCode("");
            setCreateOpen(true);
          }}
          className="h-11 rounded-full px-5 text-sm font-bold shadow-sm"
        >
          <MessageSquarePlus className="size-4" /> {t("Tạo Ticket mới")}
        </Button>
      </div>

      {/* Thanh tab lọc trạng thái kèm số đếm */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => {
          const active = status === tab.value;
          const cnt = counts[tab.countKey] ?? 0;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => {
                setStatus(tab.value);
                setPage(1);
              }}
              className={cn(
                "inline-flex h-9.5 items-center gap-2 rounded-full border px-4 text-xs font-bold transition sm:text-[13px]",
                active
                  ? "border-foreground bg-foreground text-background shadow-2xs"
                  : "bg-card text-slate-600 hover:border-foreground/30 hover:text-slate-950 dark:text-zinc-300 dark:hover:text-white",
              )}
            >
              <span>{t(tab.label)}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                  active ? "bg-background/20 text-background" : "bg-muted text-muted-foreground",
                )}
              >
                {cnt}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        {/* CỘT TRÁI: Danh sách Ticket */}
        <div className="space-y-4">
          {q.isLoading ? (
            <div className="space-y-3 rounded-2xl border bg-card p-5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : q.error ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : !q.data?.data.length ? (
            <section className="flex flex-col items-center justify-center rounded-3xl border border-dashed bg-card px-6 py-16 text-center">
              <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-muted text-foreground">
                <LifeBuoy className="size-7" />
              </span>
              <h2 className="mt-4 text-base font-bold">{t("Chưa có ticket hỗ trợ nào")}</h2>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground sm:text-sm">
                {t("Khi gặp lỗi tác vụ AI, cần kiểm tra giao dịch nạp tiền hoặc góp ý tính năng, hãy bấm Tạo Ticket mới để đội ngũ hỗ trợ xử lý ngay cho bạn.")}
              </p>
              <Button
                onClick={() => {
                  setPrefillOrderCode("");
                  setCreateOpen(true);
                }}
                className="mt-5 rounded-full px-5 font-bold"
              >
                <MessageSquarePlus className="size-4" /> {t("Tạo Ticket đầu tiên")}
              </Button>
            </section>
          ) : (
            <>
              <div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-2xs">
                {q.data.data.map((tk) => {
                  const st = statusMeta(tk.status);
                  return (
                    <button
                      key={tk.id}
                      type="button"
                      onClick={() => setActiveTicketId(tk.id)}
                      className={cn(
                        "flex w-full flex-col gap-2 p-4 text-left transition hover:bg-muted/35 sm:p-5",
                        tk.customerUnread && "bg-emerald-500/[0.04]",
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-bold text-foreground">
                            #{tk.code}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
                            <Tag className="size-3" /> {t(categoryLabelOf(tk.category))}
                          </span>
                          {tk.orderCodes && (
                            <span className="rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                              {t("Mã đơn:")} {tk.orderCodes}
                            </span>
                          )}
                          {tk.customerUnread && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10.5px] font-semibold text-[#b04652] dark:border-rose-500/25 dark:bg-rose-500/15 dark:text-rose-300">
                              <Sparkles className="size-2.5" /> {t("Có phản hồi mới")}
                            </span>
                          )}
                        </div>

                        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-bold", st.cls)}>
                          {t(st.label)}
                        </span>
                      </div>

                      <div className="text-[14.5px] font-bold text-slate-900 dark:text-white">{tk.subject}</div>

                      {tk.lastMessage && (
                        <p className="line-clamp-1 text-xs text-muted-foreground sm:text-[13px]">
                          <span className="font-semibold text-foreground/80">
                            {tk.lastMessage.isStaff ? `${t("Hỗ trợ viên")}: ` : `${t("Bạn")}: `}
                          </span>
                          {tk.lastMessage.body}
                        </p>
                      )}

                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Clock className="size-3" />
                        <span>
                          {t("Cập nhật:")}{" "}
                          {new Date(tk.lastReplyAt || tk.createdAt).toLocaleString("vi-VN")}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <Pager
                page={page}
                totalPages={q.data.meta.totalPages}
                total={q.data.meta.total}
                onChange={setPage}
              />
            </>
          )}
        </div>

        {/* CỘT PHẢI: Kênh liên hệ nhanh & Cam kết phản hồi giống Yupvox */}
        <aside className="space-y-4">
          {supportInfo.tgUrl && (
            <section className="rounded-2xl border bg-card p-5 shadow-2xs">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-400">
                  <MessageCircle className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-muted-foreground">{t("Kênh Telegram hỗ trợ")}</div>
                  <div className="truncate text-sm font-bold">{supportInfo.tgHandle || "Telegram"}</div>
                </div>
              </div>
              <a
                href={supportInfo.tgUrl.startsWith("http") ? supportInfo.tgUrl : `https://t.me/${supportInfo.tgUrl.replace(/^@/, "")}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex h-9.5 w-full items-center justify-center gap-1.5 rounded-xl border bg-background text-xs font-bold transition hover:bg-muted"
              >
                {t("Chat qua Telegram")} <ExternalLink className="size-3.5" />
              </a>
            </section>
          )}

          {supportInfo.email && (
            <section className="rounded-2xl border bg-card p-5 shadow-2xs">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                  <Mail className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-muted-foreground">{t("Email hỗ trợ")}</div>
                  <div className="truncate text-sm font-bold">{supportInfo.email}</div>
                </div>
              </div>
              <a
                href={`mailto:${supportInfo.email}`}
                className="mt-4 inline-flex h-9.5 w-full items-center justify-center gap-1.5 rounded-xl border bg-background text-xs font-bold transition hover:bg-muted"
              >
                {t("Gửi Email trực tiếp")}
              </a>
            </section>
          )}

          <section className="rounded-2xl border bg-card p-5 shadow-2xs">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                <Headphones className="size-5" />
              </span>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">{t("Thời gian phản hồi")}</div>
                <div className="text-sm font-bold">{t("Hỗ trợ 24/7 (15–30 phút)")}</div>
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0 text-emerald-600" />
              {t("Trực hỗ trợ liên tục kể cả ngày lễ & cuối tuần.")}
            </p>
          </section>
        </aside>
      </div>

      {/* Hộp thoại tạo Ticket mới */}
      <CreateTicketDialog
        open={createOpen}
        initialOrderCode={prefillOrderCode}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          void qc.invalidateQueries({ queryKey: ["account", "tickets"] });
          setActiveTicketId(created.id);
        }}
      />

      {/* Hộp thoại xem & trả lời Ticket */}
      <TicketThreadDialog
        ticketId={activeTicketId}
        onClose={() => {
          setActiveTicketId(null);
          void qc.invalidateQueries({ queryKey: ["account", "tickets"] });
        }}
      />
    </div>
  );
}

function useTicketMediaUploader(t: (key: string) => string) {
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const uploadFiles = async (fileList: File[]) => {
    const allowed = fileList.filter(
      (f) => /^(image|video)\//i.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f.name),
    );
    if (!allowed.length) return;
    if (attachments.length + allowed.length > 6) {
      toast.error(t("Mỗi tin nhắn đính kèm tối đa 6 ảnh/video"));
      return;
    }
    setUploading(true);
    try {
      const uploaded: TicketAttachment[] = [];
      for (const file of allowed) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await api.upload<TicketAttachment>("/account/ai/uploads?ticket=1", fd);
        uploaded.push(res);
      }
      setAttachments((prev) => [...prev, ...uploaded].slice(0, 6));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === "file" && /^(image|video)\//i.test(it.type))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  return { attachments, setAttachments, uploading, setUploading, uploadFiles, handlePaste };
}

function TicketAttachmentPreviewStrip({
  attachments,
  uploading,
  onRemove,
  uploadingText,
}: {
  attachments: TicketAttachment[];
  uploading: boolean;
  onRemove: (idx: number) => void;
  uploadingText: string;
}) {
  if (attachments.length === 0 && !uploading) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {attachments.map((att, idx) => {
        const isVid =
          att.kind === "video" ||
          att.mimeType?.startsWith("video/") ||
          /\.(mp4|webm|mov)(\?|$)/i.test(att.url);
        return (
          <div key={`${att.url}-${idx}`} className="relative overflow-hidden rounded-xl border bg-muted/40">
            {isVid ? (
              <div className="relative flex h-16 w-24 items-center justify-center bg-black text-white">
                <video src={att.url} muted preload="metadata" className="h-full w-full object-cover opacity-80" />
                <Film className="absolute size-5 drop-shadow" />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={att.url} alt={att.name || ""} className="h-16 w-20 object-cover" />
            )}
            <button
              type="button"
              onClick={() => onRemove(idx)}
              className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/75 text-white hover:bg-rose-600"
              aria-label="Remove attachment"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      {uploading && (
        <div className="inline-flex h-16 items-center gap-1.5 rounded-xl border border-dashed px-3 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {uploadingText}
        </div>
      )}
    </div>
  );
}

function CreateTicketDialog({
  open,
  initialOrderCode,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialOrderCode?: string;
  onClose: () => void;
  onCreated: (tk: Ticket) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<TicketCategory>("ORDER");
  const [subject, setSubject] = useState("");
  const [orderCodes, setOrderCodes] = useState("");
  const [message, setMessage] = useState("");
  const media = useTicketMediaUploader(t);

  useEffect(() => {
    if (open) {
      setOrderCodes(initialOrderCode ?? "");
      if (initialOrderCode) {
        setCategory("ORDER");
        setSubject(t("Hỗ trợ kiểm tra đơn #{code}", { code: initialOrderCode }));
      } else {
        setSubject("");
      }
      setMessage("");
      media.setAttachments([]);
      media.setUploading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialOrderCode, t]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Ticket>("/account/tickets", {
        category,
        subject: subject.trim(),
        orderCodes: orderCodes.trim() || undefined,
        message: message.trim(),
        attachments: media.attachments,
      }),
    onSuccess: (res) => {
      toast.success(t("Đã gửi Ticket hỗ trợ #{code}!", { code: res.code }));
      onCreated(res);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canSubmit = subject.trim().length >= 3 && (message.trim().length >= 3 || media.attachments.length > 0) && !media.uploading;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !create.isPending && onClose()}>
      <DialogContent className="w-[calc(100vw-1.25rem)] max-w-[calc(100vw-1.25rem)] rounded-3xl p-4 sm:w-full sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">{t("Tạo Ticket hỗ trợ mới")}</DialogTitle>
        </DialogHeader>

        <form
          className="mt-2 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-bold">{t("Danh mục hỗ trợ")}</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TicketCategory)}
                className="h-10 w-full rounded-xl border bg-background px-3 text-base font-semibold outline-none focus:border-foreground sm:text-xs"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {t(c.label)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold">{t("Mã đơn / Mã nạp (nếu có)")}</label>
              <input
                type="text"
                value={orderCodes}
                onChange={(e) => setOrderCodes(e.target.value)}
                placeholder={t("VD: T5TN4ERO hoặc NAP123...")}
                className="h-10 w-full rounded-xl border bg-background px-3 font-mono text-base outline-none focus:border-foreground sm:text-xs"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-bold">{t("Tiêu đề yêu cầu")} *</label>
            <input
              type="text"
              required
              minLength={3}
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("Tóm tắt ngắn gọn vấn đề cần hỗ trợ...")}
              className="h-10 w-full rounded-xl border bg-background px-3.5 text-base outline-none focus:border-foreground sm:text-sm"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-xs font-bold">{t("Nội dung chi tiết")} *</label>
              <label
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-semibold transition hover:bg-muted",
                  media.uploading && "pointer-events-none opacity-60",
                )}
              >
                {media.uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
                <span>{t("Đính kèm ảnh / video")}</span>
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  disabled={media.uploading}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length) void media.uploadFiles(files);
                  }}
                />
              </label>
            </div>
            <textarea
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={media.handlePaste}
              placeholder={t("Mô tả chi tiết lỗi (có thể dán ảnh chụp màn hình Ctrl+V hoặc đính kèm video)...")}
              className="w-full rounded-2xl border bg-background p-3.5 text-base outline-none focus:border-foreground sm:text-sm"
            />
            <TicketAttachmentPreviewStrip
              attachments={media.attachments}
              uploading={media.uploading}
              onRemove={(idx) => media.setAttachments((prev) => prev.filter((_, i) => i !== idx))}
              uploadingText={t("Đang tải ảnh/video...")}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending} className="rounded-full">
              {t("Huỷ")}
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || !canSubmit}
              className="rounded-full px-5 font-bold"
            >
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {t("Gửi Ticket")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TicketThreadDialog({
  ticketId,
  onClose,
}: {
  ticketId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [replyText, setReplyText] = useState("");
  const media = useTicketMediaUploader(t);

  useEffect(() => {
    setReplyText("");
    media.setAttachments([]);
    media.setUploading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  const q = useQuery({
    queryKey: ["account", "ticket", ticketId],
    queryFn: async () => {
      const detail = await api.get<Ticket>(`/account/tickets/${ticketId}`);
      void qc.invalidateQueries({ queryKey: ["tickets", "unread"] });
      void qc.invalidateQueries({ queryKey: ["account", "tickets"] });
      return detail;
    },
    enabled: !!ticketId,
    refetchInterval: 8_000,
  });

  const sendReply = useMutation({
    mutationFn: () =>
      api.post<Ticket>(`/account/tickets/${ticketId}/reply`, {
        message: replyText.trim(),
        attachments: media.attachments,
      }),
    onSuccess: (updated) => {
      setReplyText("");
      media.setAttachments([]);
      qc.setQueryData(["account", "ticket", ticketId], updated);
      void qc.invalidateQueries({ queryKey: ["account", "tickets"] });
      toast.success(t("Đã gửi phản hồi"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const closeTicket = useMutation({
    mutationFn: () => api.post<Ticket>(`/account/tickets/${ticketId}/close`),
    onSuccess: (updated) => {
      qc.setQueryData(["account", "ticket", ticketId], updated);
      void qc.invalidateQueries({ queryKey: ["account", "tickets"] });
      toast.success(t("Đã đóng ticket"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const tk = q.data;

  return (
    <Dialog open={!!ticketId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4 text-left sm:px-6">
          {tk ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-bold">#{tk.code}</span>
                  <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-bold", statusMeta(tk.status).cls)}>
                    {t(statusMeta(tk.status).label)}
                  </span>
                  {tk.orderCodes && (
                    <span className="rounded border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {t("Mã đơn:")} {tk.orderCodes}
                    </span>
                  )}
                </div>
                <DialogTitle className="mt-1.5 text-base font-bold">{tk.subject}</DialogTitle>
              </div>

              {tk.status !== "CLOSED" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={closeTicket.isPending}
                  onClick={() => closeTicket.mutate()}
                  className="rounded-full text-xs font-semibold"
                >
                  <XCircle className="size-3.5" /> {t("Đóng ticket")}
                </Button>
              )}
            </div>
          ) : (
            <DialogTitle className="text-base font-bold">{t("Chi tiết Ticket")}</DialogTitle>
          )}
        </DialogHeader>

        {/* Nội dung hội thoại 2 chiều */}
        <div className="min-h-[260px] flex-1 space-y-3 overflow-y-auto bg-muted/20 p-5 sm:p-6">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            (tk?.messages ?? []).map((m) => (
              <div key={m.id} className={cn("flex flex-col", m.isStaff ? "items-start" : "items-end")}>
                <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  {m.isStaff && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="size-2.5" /> {m.authorName || t("Đội ngũ Hỗ trợ")}
                    </span>
                  )}
                  {!m.isStaff && <span className="font-semibold">{t("Bạn")}</span>}
                  <span>·</span>
                  <span>{new Date(m.createdAt).toLocaleString("vi-VN")}</span>
                </div>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-2xs",
                      m.isStaff
                        ? "rounded-tl-sm border bg-card text-foreground"
                        : "rounded-tr-sm bg-foreground text-background",
                    )}
                  >
                    {m.body ? <div>{m.body}</div> : null}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className={cn("grid gap-2", m.body && "mt-2")}>
                        {m.attachments.map((att, idx) => {
                          const isVid =
                            att.kind === "video" ||
                            att.mimeType?.startsWith("video/") ||
                            /\.(mp4|webm|mov)(\?|$)/i.test(att.url);
                          return isVid ? (
                            <div key={`${att.url}-${idx}`} className="overflow-hidden rounded-xl border border-black/10 bg-black">
                              <video
                                src={att.url}
                                controls
                                playsInline
                                preload="metadata"
                                className="max-h-80 w-full object-contain"
                              />
                            </div>
                          ) : (
                            <a
                              key={`${att.url}-${idx}`}
                              href={att.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block overflow-hidden rounded-xl border border-black/10 bg-black/5"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={att.url} alt={att.name || ""} className="max-h-80 w-full object-contain" />
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
              </div>
            ))
          )}
        </div>

        {/* Khung gửi phản hồi */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if ((!replyText.trim() && media.attachments.length === 0) || media.uploading) return;
            sendReply.mutate();
          }}
          className="space-y-2.5 border-t bg-card p-3.5 sm:px-6 sm:py-4"
        >
          <TicketAttachmentPreviewStrip
            attachments={media.attachments}
            uploading={media.uploading}
            onRemove={(idx) => media.setAttachments((prev) => prev.filter((_, i) => i !== idx))}
            uploadingText={t("Đang tải ảnh/video...")}
          />
          <div className="flex items-end gap-2">
            <label
              title={t("Đính kèm ảnh / video")}
              className={cn(
                "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-2xl border bg-background px-3 text-xs font-semibold transition hover:bg-muted",
                media.uploading && "pointer-events-none opacity-60",
              )}
            >
              {media.uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              <span className="hidden sm:inline">{t("Ảnh / Video")}</span>
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                className="hidden"
                disabled={media.uploading}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) void media.uploadFiles(files);
                }}
              />
            </label>
            <textarea
              rows={2}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onPaste={media.handlePaste}
              placeholder={
                tk?.status === "CLOSED"
                  ? t("Nhập tin nhắn hoặc đính kèm ảnh/video để mở lại ticket...")
                  : t("Nhập phản hồi hoặc dán ảnh (Ctrl+V) / đính kèm video...")
              }
              className="min-h-[44px] min-w-0 flex-1 resize-none rounded-2xl border bg-background px-3.5 py-2.5 text-base outline-none focus:border-foreground sm:text-sm"
            />
            <Button
              type="submit"
              disabled={sendReply.isPending || media.uploading || (!replyText.trim() && media.attachments.length === 0)}
              className="h-11 shrink-0 rounded-2xl px-4 font-bold"
            >
              {sendReply.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {t("Gửi")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
