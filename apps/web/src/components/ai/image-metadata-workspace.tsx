"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Download,
  ImagePlus,
  ListChecks,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/provider";

const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp"]);
const MAX_FILES = 50;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 30_000_000;

type OutputFormatMode = "keep" | "jpeg" | "png" | "webp";

interface MetaImageRow {
  id: string;
  file: File;
  previewUrl: string;
  outputUrl: string;
  outputBlob: Blob | null;
  outputName: string;
  width: number;
  height: number;
  status: "ready" | "processing" | "done" | "error";
  error: string;
}

/** Bảng CRC32 nhẹ để đóng gói file .ZIP ngay trên trình duyệt (0 thư viện ngoài, 0 tải lên server) */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function buildStoreZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // STORE (ảnh JPG/PNG/WebP đã nén sẵn)
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], { type: "application/zip" });
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; dispose: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, dispose: () => bmp.close?.() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function stripMetadataInBrowser(file: File, fmtMode: OutputFormatMode): Promise<{ blob: Blob; width: number; height: number; ext: string }> {
  const decoded = await decodeImage(file);
  try {
    const { width, height } = decoded;
    if (!width || !height) throw new Error("Không đọc được kích thước ảnh.");
    if (width * height > MAX_PIXELS) {
      throw new Error("Ảnh vượt quá 30 megapixel. Vui lòng thu nhỏ ảnh rồi thử lại.");
    }

    let targetMime = "image/png";
    let ext = "png";
    if (fmtMode === "jpeg" || (fmtMode === "keep" && file.type === "image/jpeg")) {
      targetMime = "image/jpeg";
      ext = "jpg";
    } else if (fmtMode === "webp" || (fmtMode === "keep" && file.type === "image/webp")) {
      targetMime = "image/webp";
      ext = "webp";
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: targetMime !== "image/jpeg" });
    if (!ctx) throw new Error("Trình duyệt không thể xử lý ảnh này.");

    if (targetMime === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Không thể mã hoá lại ảnh sạch metadata."))),
        targetMime,
        targetMime === "image/png" ? undefined : 0.94,
      );
    });
    canvas.width = 0;
    canvas.height = 0;
    return { blob, width, height, ext };
  } finally {
    decoded.dispose();
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Giao diện công cụ `Xóa Metadata Hình Ảnh Hàng Loạt` (`/tools/xoa-meta-hinh-anh` — T-383):
 * - Xoá sạch 100% EXIF, toạ độ GPS, thông số máy ảnh, C2PA / dấu vết prompt AI ngay trên trình duyệt của người dùng.
 * - Riêng tư tuyệt đối (ảnh không tải lên máy chủ), miễn phí 0đ, hỗ trợ tải lẻ hoặc nén `.ZIP` 1 chạm tối đa 50 ảnh/lượt.
 */
export function ImageMetadataWorkspace({
  demoMedia,
  modelPicker,
}: {
  demoMedia?: ReactNode;
  modelPicker?: ReactNode;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<MetaImageRow[]>([]);
  const [formatMode, setFormatMode] = useState<OutputFormatMode>("keep");
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<Set<string>>(new Set());

  const trackUrl = (blob: Blob) => {
    const u = URL.createObjectURL(blob);
    urlsRef.current.add(u);
    return u;
  };
  const releaseUrl = (u: string) => {
    if (u && urlsRef.current.has(u)) {
      URL.revokeObjectURL(u);
      urlsRef.current.delete(u);
    }
  };

  useEffect(() => {
    const set = urlsRef.current;
    return () => {
      set.forEach((u) => URL.revokeObjectURL(u));
      set.clear();
    };
  }, []);

  const addFiles = (fileList: FileList | File[] | null) => {
    if (!fileList || processing) return;
    const incoming = Array.from(fileList);
    const valid: File[] = [];
    const warnings: string[] = [];

    for (const f of incoming) {
      if (!SUPPORTED_MIMES.has(f.type)) {
        warnings.push(`${f.name}: định dạng chưa hỗ trợ`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        warnings.push(`${f.name}: lớn hơn 25 MB`);
        continue;
      }
      valid.push(f);
    }

    const slots = Math.max(0, MAX_FILES - items.length);
    const accepted = valid.slice(0, slots);
    if (valid.length > slots) warnings.push(`Tối đa ${MAX_FILES} ảnh trong một lượt.`);

    if (accepted.length > 0) {
      const nextRows: MetaImageRow[] = accepted.map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        file: f,
        previewUrl: trackUrl(f),
        outputUrl: "",
        outputBlob: null,
        outputName: "",
        width: 0,
        height: 0,
        status: "ready",
        error: "",
      }));
      setItems((prev) => [...prev, ...nextRows]);
      toast.success(`Đã thêm ${accepted.length} ảnh vào danh sách chờ xoá metadata.`);
    }
    if (warnings.length > 0) {
      toast.warning(warnings.slice(0, 3).join(" · ") + (warnings.length > 3 ? ` · và ${warnings.length - 3} ảnh khác` : ""));
    }
  };

  const removeRow = (id: string) => {
    if (processing) return;
    setItems((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) {
        releaseUrl(target.previewUrl);
        releaseUrl(target.outputUrl);
      }
      return prev.filter((x) => x.id !== id);
    });
  };

  const clearAll = () => {
    if (processing) return;
    items.forEach((x) => {
      releaseUrl(x.previewUrl);
      releaseUrl(x.outputUrl);
    });
    setItems([]);
  };

  const runCleanAll = async () => {
    if (!items.length || processing) return;
    setProcessing(true);
    setProgress({ done: 0, total: items.length });
    let doneCount = 0;
    let errCount = 0;

    for (const row of items) {
      setItems((prev) => prev.map((x) => (x.id === row.id ? { ...x, status: "processing", error: "" } : x)));
      try {
        const res = await stripMetadataInBrowser(row.file, formatMode);
        const outUrl = trackUrl(res.blob);
        const baseName = row.file.name.replace(/\.[^.]+$/, "") || "image";
        const outName = `${baseName}-clean.${res.ext}`;
        setItems((prev) =>
          prev.map((x) => {
            if (x.id !== row.id) return x;
            releaseUrl(x.outputUrl);
            return {
              ...x,
              status: "done",
              outputUrl: outUrl,
              outputBlob: res.blob,
              outputName: outName,
              width: res.width,
              height: res.height,
              error: "",
            };
          }),
        );
      } catch (err) {
        errCount++;
        setItems((prev) =>
          prev.map((x) =>
            x.id === row.id ? { ...x, status: "error", error: (err as Error)?.message || "Không thể xử lý ảnh." } : x,
          ),
        );
      } finally {
        doneCount++;
        setProgress({ done: doneCount, total: items.length });
      }
    }

    setProcessing(false);
    const okCount = doneCount - errCount;
    if (okCount > 0) {
      toast.success(`Hoàn tất: đã xoá sạch metadata cho ${okCount}/${doneCount} ảnh!`);
    } else {
      toast.error("Không thể xử lý các ảnh đã chọn.");
    }
  };

  const doneItems = items.filter((x) => x.status === "done" && x.outputBlob && x.outputUrl);

  const downloadSingle = (row: MetaImageRow) => {
    if (!row.outputUrl) return;
    const a = document.createElement("a");
    a.href = row.outputUrl;
    a.download = row.outputName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadEach = async () => {
    for (let i = 0; i < doneItems.length; i++) {
      downloadSingle(doneItems[i]);
      if (i < doneItems.length - 1) await new Promise((r) => setTimeout(r, 350));
    }
  };

  const downloadZip = async () => {
    if (!doneItems.length || zipping) return;
    setZipping(true);
    try {
      const usedNames = new Set<string>();
      const zipEntries = doneItems.map((x, idx) => {
        let name = x.outputName || `image-${idx + 1}-clean.jpg`;
        if (usedNames.has(name.toLowerCase())) {
          name = name.replace(/(\.[^.]+)$/, `-${idx + 1}$1`);
        }
        usedNames.add(name.toLowerCase());
        return { name, blob: x.outputBlob! };
      });
      const zipBlob = await buildStoreZip(zipEntries);
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Anh_Sach_Metadata_${doneItems.length}_file.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      toast.error((err as Error)?.message || "Không thể đóng gói file ZIP.");
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,410px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      {/* Cột trái: Khu vực kéo thả ảnh & cấu hình định dạng */}
      <div className="flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm lg:sticky lg:top-20">
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-500" /> {t("Xoá Metadata Bảo Mật")}
          </span>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
            {t("MIỄN PHÍ 0Đ")}
          </span>
        </div>

        <div className="space-y-4 px-5 py-4">
          {demoMedia}
          {modelPicker}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/avif,image/bmp"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed p-6 text-center transition ${
              dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60 hover:bg-muted/30"
            }`}
          >
            <div className="flex size-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <ImagePlus className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold">Bấm chọn hoặc kéo thả nhiều ảnh vào đây</p>
              <p className="text-xs text-muted-foreground">
                Hỗ trợ JPG, PNG, WebP, AVIF, BMP · Tối đa {MAX_FILES} ảnh/lượt (mỗi ảnh ≤ 25 MB)
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[13px] font-semibold">Định dạng ảnh đầu ra</label>
            <select
              value={formatMode}
              onChange={(e) => setFormatMode(e.target.value as OutputFormatMode)}
              disabled={processing}
              className="w-full rounded-2xl border bg-background px-3.5 py-2.5 text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
            >
              <option value="keep">Giữ theo định dạng gốc (JPG / PNG / WebP)</option>
              <option value="jpeg">Chuyển sang JPG chất lượng cao (94%)</option>
              <option value="png">Chuyển sang PNG không nén</option>
              <option value="webp">Chuyển sang WebP siêu nhẹ</option>
            </select>
          </div>

          <div className="rounded-2xl border bg-emerald-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
            🔒 <b className="text-foreground">Xử lý 100% trên thiết bị của bạn:</b> Hình ảnh không gửi lên máy chủ. Mọi thẻ ẩn EXIF, vị trí GPS, số seri máy ảnh, C2PA và thông số AI gốc đều được xoá sạch hoàn toàn.
          </div>
        </div>

        <div className="border-t bg-muted/30 px-5 py-3">
          <div className="mb-2.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Đã chọn: <b className="text-foreground">{items.length}/{MAX_FILES} ảnh</b>
            </span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400">{t("Miễn phí (0đ)")}</span>
          </div>
          <button
            type="button"
            disabled={processing || items.length === 0}
            onClick={() => void runCleanAll()}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[15px] font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {processing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>
                  Đang xoá metadata ({progress.done}/{progress.total})...
                </span>
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                <span>Xoá Metadata Hàng Loạt ({items.length})</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Cột phải: Danh sách ảnh & Tải kết quả */}
      <section className="flex min-h-[480px] flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-6">
        {items.length > 0 ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-muted/20 p-4">
              <div className="space-y-0.5">
                <div className="text-sm font-bold">
                  Danh sách ảnh ({doneItems.length}/{items.length} đã làm sạch)
                </div>
                <p className="text-xs text-muted-foreground">
                  {doneItems.length > 0
                    ? "Ảnh đã sạch 100% EXIF / GPS / thông tin ẩn. Tải từng ảnh hoặc tải trọn bộ file .ZIP."
                    : "Bấm nút Xoá Metadata Hàng Loạt ở cột trái để làm sạch toàn bộ ảnh."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {doneItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void downloadEach()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border bg-background px-3 py-2 text-xs font-bold hover:bg-muted"
                  >
                    <ListChecks className="size-3.5 text-indigo-500" /> Tải lẻ ({doneItems.length})
                  </button>
                )}
                {doneItems.length > 0 && (
                  <button
                    type="button"
                    disabled={zipping}
                    onClick={() => void downloadZip()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm shadow-emerald-600/20 hover:bg-emerald-500 disabled:opacity-60"
                  >
                    {zipping ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                    Tải tất cả (.ZIP)
                  </button>
                )}
                <button
                  type="button"
                  disabled={processing}
                  onClick={clearAll}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300"
                >
                  <Trash2 className="size-3.5" /> Xoá hết
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((row) => (
                <div key={row.id} className="flex items-center gap-3 rounded-2xl border bg-background p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={row.outputUrl || row.previewUrl}
                    alt={row.file.name}
                    className="size-16 shrink-0 rounded-xl border bg-muted object-cover"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-xs font-bold" title={row.outputName || row.file.name}>
                      {row.outputName || row.file.name}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{fmtSize(row.outputBlob ? row.outputBlob.size : row.file.size)}</span>
                      {row.width > 0 && row.height > 0 && (
                        <span>
                          · {row.width}×{row.height}
                        </span>
                      )}
                    </div>
                    {row.status === "done" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                        <CheckCircle2 className="size-3" /> Đã sạch Metadata
                      </span>
                    ) : row.status === "processing" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                        <Loader2 className="size-3 animate-spin" /> Đang xử lý...
                      </span>
                    ) : row.status === "error" ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                        <AlertCircle className="size-3 shrink-0" /> {row.error}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Sẵn sàng xử lý</span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {row.status === "done" && row.outputUrl && (
                      <button
                        type="button"
                        onClick={() => downloadSingle(row)}
                        title="Tải ảnh sạch metadata"
                        className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-500"
                      >
                        <Download className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={processing}
                      onClick={() => removeRow(row.id)}
                      title="Bỏ ảnh này"
                      className="inline-flex size-8 cursor-pointer items-center justify-center rounded-xl border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-7" />
            </div>
            <div className="max-w-md space-y-1.5">
              <h3 className="text-base font-bold">Xóa Metadata Hình Ảnh Hàng Loạt</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Thêm tối đa 50 ảnh cùng lúc để xoá sạch thông tin EXIF, toạ độ GPS, thông số máy ảnh và dữ liệu mô tả ẩn ngay trên trình duyệt — nhanh, miễn phí và bảo mật 100%.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
