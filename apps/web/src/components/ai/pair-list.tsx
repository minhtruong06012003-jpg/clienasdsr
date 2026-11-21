"use client";

/**
 * Form "nhiều cặp" (giống Motion Control của Studio TMC): mỗi hàng là một cặp ô vuông file (vd [Ảnh nhân vật + Video mẫu]),
 * bấm / kéo thả để tải lên ngay (POST /account/ai/uploads). Ô `linkField` có thêm ô "Dán link video TikTok / Douyin / MP4":
 * máy chủ tải video về (POST /account/ai/uploads/from-url) rồi điền vào ô đó.
 * Hàng cuối đủ file thì tự thêm một hàng trống; mỗi hàng đủ file được trang công cụ gửi thành một tác vụ riêng.
 */
import { useRef, useState } from "react";
import { Link2, Loader2, Plus, Upload, Video, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiField } from "@/lib/types";

/** Một hàng: tên ô -> URL file đã tải lên */
export type PairRow = Record<string, string | undefined>;

/** Hàng đã đủ file của mọi ô trong cặp */
export const pairReady = (row: PairRow, names: string[]) => names.every((n) => !!row[n]);

export function PairList({
  fields,
  rows,
  onChange,
  max = 10,
  linkField,
  disabled,
}: {
  fields: AiField[];
  rows: PairRow[];
  onChange: (rows: PairRow[]) => void;
  max?: number;
  linkField?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const names = fields.map((f) => f.name);
  const list = rows.length ? rows : [{}];
  const ready = list.filter((r) => pairReady(r, names)).length;

  // đặt giá trị một ô của hàng i; hàng cuối vừa đủ file thì thêm hàng trống (chưa quá max)
  const setCell = (i: number, name: string, url: string | undefined) => {
    const next = list.map((r, j) => (j === i ? { ...r, [name]: url } : r));
    const last = next[next.length - 1];
    if (pairReady(last, names) && next.length < max) next.push({});
    onChange(next);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">
          {fields.map((f) => t(f.label)).join(" + ")}
          <span className="text-rose-500"> *</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{ready > 0 ? t("{n} cặp sẵn sàng chạy", { n: ready }) : t("Chọn đủ file cho từng cặp")}</span>
      </div>
      <div className="space-y-2.5">
        {list.map((row, i) => (
          <div key={i} className={cn("rounded-2xl border bg-muted/20 p-2.5 transition", pairReady(row, names) && "border-emerald-500/40 bg-emerald-500/5")}>
            <div className="flex items-center gap-2">
              <div className="flex w-9 shrink-0 flex-col items-center text-[11px] font-semibold text-muted-foreground">
                <span>{t("Cặp")}</span>
                <span className="rounded-md bg-muted px-1.5 text-foreground">#{i + 1}</span>
              </div>
              <div className="grid min-w-0 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${fields.length}, minmax(0, 1fr))` }}>
                {fields.map((f) => (
                  <SquareSlot key={f.name} field={f} value={row[f.name]} onChange={(url) => setCell(i, f.name, url)} disabled={disabled} />
                ))}
              </div>
              <button
                type="button"
                disabled={disabled || list.length <= 1}
                onClick={() => onChange(list.filter((_, j) => j !== i))}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-rose-600 disabled:opacity-30"
                aria-label={t("Xoá cặp #{n}", { n: i + 1 })}
              >
                <X className="size-4" />
              </button>
            </div>
            {linkField && names.includes(linkField) && <LinkInput disabled={disabled} onDone={(url) => setCell(i, linkField, url)} />}
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={disabled || list.length >= max}
        onClick={() => onChange([...list, {}])}
        className="mt-2.5 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed text-[13px] font-semibold text-foreground/80 transition hover:bg-muted disabled:opacity-50"
      >
        <Plus className="size-4" /> {t("Thêm cặp ô vuông mới (Làm nhiều cặp cùng lúc)")}
      </button>
    </div>
  );
}

/** Ô vuông chọn một file: bấm / kéo thả, tải lên ngay, xem trước ảnh / video */
function SquareSlot({ field: f, value, onChange, disabled }: { field: AiField; value?: string; onChange: (url: string | undefined) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const isVideo = f.type === "video";

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post<{ url: string }>("/account/ai/uploads", fd);
      onChange(res.url);
    } catch (err) {
      toast.error(`${file.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!disabled) upload(e.dataTransfer.files[0]);
      }}
      className={cn("group relative aspect-square overflow-hidden rounded-xl border-2 border-dashed bg-card transition", value ? "border-solid" : "hover:border-foreground/30", drag && "border-foreground bg-muted/60")}
    >
      {value ? (
        <>
          {isVideo ? (
            <video src={value} className="size-full bg-black object-cover" muted loop playsInline autoPlay />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="size-full object-cover" />
          )}
          {!disabled && (
            <>
              <button type="button" onClick={() => input.current?.click()} className="absolute inset-x-1.5 bottom-1.5 rounded-lg bg-black/60 py-1 text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                {isVideo ? t("Đổi video") : t("Đổi ảnh")}
              </button>
              <button type="button" onClick={() => onChange(undefined)} className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80" aria-label="Remove">
                <X className="size-3.5" />
              </button>
            </>
          )}
        </>
      ) : (
        <button type="button" disabled={disabled || busy} onClick={() => input.current?.click()} className="flex size-full flex-col items-center justify-center gap-1.5 px-1 text-center">
          <span className="inline-flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
            {busy ? <Loader2 className="size-4 animate-spin" /> : isVideo ? <Video className="size-4" /> : <Upload className="size-4" />}
          </span>
          <span className="text-[12px] font-semibold leading-tight">{busy ? t("Đang tải lên...") : t(f.label)}</span>
          {!busy && <span className="text-[10.5px] text-muted-foreground">{isVideo ? t("Tải file / Dán link") : t("Bấm / Kéo thả")}</span>}
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={f.accept}
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Ô dán link video: dán xong (hoặc gõ rồi Enter) thì máy chủ tải video về thành file đầu vào */
function LinkInput({ onDone, disabled }: { onDone: (url: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchLink = async (raw: string) => {
    const url = raw.trim();
    if (!url || busy) return;
    if (!/^https?:\/\//i.test(url)) return toast.error(t("Link không hợp lệ, vui lòng dán link bắt đầu bằng http:// hoặc https://"));
    setBusy(true);
    try {
      const res = await api.post<{ url: string }>("/account/ai/uploads/from-url", { url });
      onDone(res.url);
      setText("");
      toast.success(t("Đã lấy xong video mẫu từ link"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mt-2">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}</span>
      <input
        type="url"
        value={text}
        disabled={disabled || busy}
        placeholder={busy ? t("Đang tự động tải video từ link...") : t("Dán link video TikTok / Douyin / MP4 vào đây...")}
        onChange={(e) => setText(e.target.value)}
        // dán link là tải luôn, không cần bấm thêm
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (pasted) {
            e.preventDefault();
            setText(pasted.trim());
            fetchLink(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            fetchLink(text);
          }
        }}
        className="h-9 w-full rounded-xl border bg-card pr-3 pl-8 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:opacity-60"
      />
    </div>
  );
}
