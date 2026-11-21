"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Film,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";

type QualityOpt = "best" | "720p" | "480p" | "360p";

interface ExtractedVideoItem {
  id: string;
  url: string;
  title: string;
  duration: number;
  platform: string;
  thumbnailUrl: string | null;
}

interface BulkJobItem {
  id: string;
  url: string;
  sourceLabel: string;
  status: "queued" | "running" | "downloading" | "done" | "error" | "canceled" | string;
  percent: number;
  error: string;
  video: {
    title: string;
    platform: string;
    duration: number;
    size: number;
    width: number;
    height: number;
    thumbnailUrl: string | null;
    streamUrl: string | null;
    downloadUrl: string | null;
    fileName: string;
  } | null;
}

interface BulkJobState {
  jobToken: string;
  status: string;
  quality: string;
  items: BulkJobItem[];
  summary: {
    total: number;
    done: number;
    error: number;
    running: number;
    queued: number;
    canceled: number;
    progress: number;
  };
  zipUrl: string | null;
}

const QUALITIES: { value: QualityOpt; label: string }[] = [
  { value: "best", label: "Cao nhất (Full HD / gốc)" },
  { value: "720p", label: "HD 720p · Khuyên dùng" },
  { value: "480p", label: "480p · Dung lượng nhẹ" },
  { value: "360p", label: "360p · Tải siêu nhanh" },
];

function parseUrls(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/https?:\/\/[^\s"'<>]+/i);
    if (!m) continue;
    const clean = m[0].replace(/[),.;!?]+$/, "").trim();
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
    if (out.length >= 30) break;
  }
  return out;
}

function fmtSec(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtMb(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Giao diện công cụ `Tải Video Hàng Loạt Không Logo` (`/tools/bulk-download` — T-382):
 * - Hỗ trợ TikTok, Douyin, YouTube Shorts/Video, Facebook Reels, Instagram Reels, Bilibili, Xiaohongshu, Kuaishou.
 * - Có 2 chế độ: Dán danh sách link (tới 30 link/lượt) hoặc Quét cả Kênh / Trang cá nhân để chọn video tải hàng loạt.
 * - Xem trước trực tiếp, tải lẻ từng MP4 sạch logo hoặc nén tải 1 chạm toàn bộ ra file `.ZIP` (0đ, 0 byte ổ đĩa VPS).
 */
export function BulkDownloadWorkspace({
  demoMedia,
  modelPicker,
}: {
  demoMedia?: ReactNode;
  modelPicker?: ReactNode;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"urls" | "scan">("urls");
  const [urlsText, setUrlsText] = useState("");
  const [quality, setQuality] = useState<QualityOpt>("best");
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [job, setJob] = useState<BulkJobState | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);

  // Tab Quét kênh / user
  const [scanQuery, setScanQuery] = useState("");
  const [scanLimit, setScanLimit] = useState(20);
  const [scanning, setScanning] = useState(false);
  const [scannedItems, setScannedItems] = useState<ExtractedVideoItem[]>([]);
  const [selectedScanIds, setSelectedScanIds] = useState<string[]>([]);

  const parsedUrls = useMemo(() => parseUrls(urlsText), [urlsText]);
  const isJobRunning = !!job && !["done", "partial", "error", "canceled"].includes(job.status);

  const pollJob = useCallback(async (token: string) => {
    try {
      const next = await api.get<BulkJobState>(`/public/ai/bulk-download/jobs/${encodeURIComponent(token)}`, { auth: false });
      setJob(next);
    } catch {
      /* giữ trạng thái hiện tại nếu mạng chập chờn 1 nhịp */
    }
  }, []);

  useEffect(() => {
    if (!job?.jobToken || !isJobRunning) return;
    const timer = window.setInterval(() => {
      void pollJob(job.jobToken);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.jobToken, isJobRunning, pollJob]);

  const startBulkJob = async (overrideUrls?: string[]) => {
    const list = overrideUrls ?? parsedUrls;
    if (!list.length) {
      toast.error(t("Vui lòng dán ít nhất 1 đường link video hợp lệ (mỗi dòng 1 link)."));
      return;
    }
    setSubmitting(true);
    setPreviewItemId(null);
    try {
      const created = await api.post<BulkJobState>(
        "/public/ai/bulk-download/jobs",
        { urls: list, quality },
        { auth: false },
      );
      setJob(created);
      toast.success(`Đã bắt đầu tải hàng loạt ${list.length} video!`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleScanChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = scanQuery.trim();
    if (!q) {
      toast.error(t("Vui lòng dán link kênh TikTok / YouTube / Douyin cần quét."));
      return;
    }
    setScanning(true);
    setScannedItems([]);
    setSelectedScanIds([]);
    try {
      const res = await api.post<{ items: ExtractedVideoItem[] }>(
        "/public/ai/bulk-download/extract",
        { query: q, limit: scanLimit },
        { auth: false },
      );
      const list = res.items ?? [];
      setScannedItems(list);
      setSelectedScanIds(list.map((x) => x.id));
      if (!list.length) {
        toast.info("Không tìm thấy video công khai nào trong kênh này.");
      } else {
        toast.success(`Đã quét được ${list.length} video!`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setScanning(false);
    }
  };

  const pushScannedToDownload = (autoStart: boolean) => {
    const chosen = scannedItems.filter((x) => selectedScanIds.includes(x.id)).map((x) => x.url);
    if (!chosen.length) {
      toast.error("Vui lòng chọn ít nhất 1 video để tải.");
      return;
    }
    const merged = parseUrls([urlsText, ...chosen].filter(Boolean).join("\n"));
    setUrlsText(merged.join("\n"));
    setTab("urls");
    if (autoStart) {
      void startBulkJob(merged);
    } else {
      toast.success(`Đã đưa ${chosen.length} link vào danh sách chờ tải.`);
    }
  };

  const handleCancel = async () => {
    if (!job?.jobToken) return;
    setActionBusy(true);
    try {
      const next = await api.post<BulkJobState>(`/public/ai/bulk-download/jobs/${encodeURIComponent(job.jobToken)}/cancel`, {}, { auth: false });
      setJob(next);
      toast.info("Đã dừng tiến trình tải hàng loạt.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetryFailed = async () => {
    if (!job?.jobToken) return;
    setActionBusy(true);
    try {
      const next = await api.post<BulkJobState>(`/public/ai/bulk-download/jobs/${encodeURIComponent(job.jobToken)}/retry-failed`, {}, { auth: false });
      setJob(next);
      toast.success("Đang thử tải lại các video bị lỗi...");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadEach = async () => {
    const doneItems = (job?.items ?? []).filter((x) => x.status === "done" && x.video?.downloadUrl);
    if (!doneItems.length) return;
    for (let i = 0; i < doneItems.length; i++) {
      const dl = doneItems[i].video!.downloadUrl!;
      const a = document.createElement("a");
      a.href = dl;
      a.download = doneItems[i].video!.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (i < doneItems.length - 1) {
        await new Promise((r) => setTimeout(r, 650));
      }
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,450px)_minmax(0,1fr)]">
      {/* Cột trái: Thiết lập nguồn link / quét kênh */}
      <div className="flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm lg:sticky lg:top-20">
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <Settings2 className="size-4 text-muted-foreground" /> {t("Thiết lập tải hàng loạt")}
          </span>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
            {t("MIỄN PHÍ 0Đ")}
          </span>
        </div>

        <div className="space-y-4 px-5 py-4">
          {demoMedia}
          {modelPicker}

          {/* Chuyển chế độ Dán Link / Quét Kênh */}
          <div className="grid grid-cols-2 gap-1 rounded-2xl border bg-muted/40 p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setTab("urls")}
              className={`rounded-xl py-2 transition ${tab === "urls" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
            >
              Dán danh sách Link
            </button>
            <button
              type="button"
              onClick={() => setTab("scan")}
              className={`rounded-xl py-2 transition ${tab === "scan" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
            >
              Quét Kênh / User
            </button>
          </div>

          {tab === "urls" ? (
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[13px] font-semibold">Danh sách link video (mỗi dòng 1 link)</label>
                  <span className="text-xs font-medium text-muted-foreground">{parsedUrls.length}/30 link</span>
                </div>
                <textarea
                  rows={7}
                  value={urlsText}
                  onChange={(e) => setUrlsText(e.target.value)}
                  placeholder={
                    "https://www.tiktok.com/@user/video/...\nhttps://www.youtube.com/shorts/...\nhttps://www.instagram.com/reel/...\nhttps://v.douyin.com/..."
                  }
                  className="w-full resize-y rounded-2xl border bg-background p-3.5 font-mono text-xs leading-relaxed transition-colors placeholder:font-sans placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
                />
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Hỗ trợ TikTok, Douyin, YouTube, Reels, Instagram, Bilibili, Xiaohongshu</span>
                  {urlsText.trim() && (
                    <button
                      type="button"
                      onClick={() => setUrlsText("")}
                      className="inline-flex items-center gap-1 font-semibold text-rose-600 hover:underline dark:text-rose-400"
                    >
                      <Trash2 className="size-3" /> Xoá
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[13px] font-semibold">Chất lượng video tải về</label>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as QualityOpt)}
                  className="w-full rounded-2xl border bg-background px-3.5 py-2.5 text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  {QUALITIES.map((q) => (
                    <option key={q.value} value={q.value}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <form onSubmit={handleScanChannel} className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="block text-[13px] font-semibold">Link Kênh / Trang cá nhân cần quét</label>
                <input
                  type="text"
                  value={scanQuery}
                  onChange={(e) => setScanQuery(e.target.value)}
                  placeholder="https://www.tiktok.com/@ten_kenh hoặc https://www.youtube.com/@kenh/shorts"
                  className="w-full rounded-2xl border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={scanLimit}
                  onChange={(e) => setScanLimit(Number(e.target.value))}
                  className="rounded-xl border bg-background px-3 py-2 text-xs font-semibold"
                >
                  <option value={10}>Lấy 10 video mới nhất</option>
                  <option value={20}>Lấy 20 video mới nhất</option>
                  <option value={30}>Lấy 30 video mới nhất</option>
                </select>
                <button
                  type="submit"
                  disabled={scanning}
                  className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                  {scanning ? "Đang quét kênh..." : "Quét danh sách"}
                </button>
              </div>

              {scannedItems.length > 0 && (
                <div className="space-y-2.5 rounded-2xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span>
                      Đã chọn {selectedScanIds.length}/{scannedItems.length} video
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedScanIds(selectedScanIds.length === scannedItems.length ? [] : scannedItems.map((x) => x.id))
                      }
                      className="text-primary hover:underline"
                    >
                      {selectedScanIds.length === scannedItems.length ? "Bỏ chọn hết" : "Chọn tất cả"}
                    </button>
                  </div>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                    {scannedItems.map((it, i) => {
                      const checked = selectedScanIds.includes(it.id);
                      return (
                        <label
                          key={it.id}
                          className="flex cursor-pointer items-center gap-2.5 rounded-xl border bg-background p-2 text-xs hover:bg-muted/40"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedScanIds((prev) =>
                                prev.includes(it.id) ? prev.filter((x) => x !== it.id) : [...prev, it.id],
                              )
                            }
                            className="size-4 rounded"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            #{i + 1} · {it.title}
                          </span>
                          {it.duration > 0 && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtSec(it.duration)}</span>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => pushScannedToDownload(false)}
                      className="rounded-xl border bg-background py-2 text-xs font-semibold hover:bg-muted"
                    >
                      Đưa vào ô Link
                    </button>
                    <button
                      type="button"
                      onClick={() => pushScannedToDownload(true)}
                      className="rounded-xl bg-emerald-600 py-2 text-xs font-bold text-white hover:bg-emerald-500"
                    >
                      Tải ngay ({selectedScanIds.length})
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>

        {tab === "urls" && (
          <div className="border-t bg-muted/30 px-5 py-3">
            <div className="mb-2.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("Chi phí")}</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">{t("Miễn phí (0đ)")}</span>
            </div>
            <button
              type="button"
              disabled={submitting || isJobRunning || parsedUrls.length === 0}
              onClick={() => void startBulkJob()}
              className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[15px] font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting || isJobRunning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>{submitting ? "Đang khởi tạo lô tải..." : `Đang tải (${job?.summary.done ?? 0}/${job?.summary.total ?? 0})...`}</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-4" />
                  <span>Bắt đầu tải hàng loạt ({parsedUrls.length})</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Cột phải: Tiến trình & kết quả video tải hàng loạt */}
      <section className="flex min-h-[480px] flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-6">
        {job ? (
          <div className="space-y-4">
            {/* Thanh tổng kết tiến trình & nút Tải ZIP */}
            <div className="rounded-2xl border bg-muted/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                    <span>
                      Tiến độ: {job.summary.done}/{job.summary.total} video hoàn tất
                    </span>
                    {job.summary.error > 0 && (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                        {job.summary.error} lỗi
                      </span>
                    )}
                    <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">{job.summary.progress}%</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isJobRunning
                      ? "Hệ thống đang bóc tách & xoá watermark song song, tự cập nhật mỗi 2 giây..."
                      : "Đã xử lý xong lô tải! Bạn có thể xem trước, tải lẻ từng MP4 hoặc nén tải 1 file ZIP."}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {isJobRunning && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={handleCancel}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300"
                    >
                      <XCircle className="size-3.5" /> Huỷ tải
                    </button>
                  )}
                  {!isJobRunning && job.summary.error > 0 && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={handleRetryFailed}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                    >
                      <RefreshCw className="size-3.5" /> Thử lại lỗi
                    </button>
                  )}
                  {job.summary.done > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleDownloadEach()}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border bg-background px-3 py-2 text-xs font-bold hover:bg-muted"
                    >
                      <ListChecks className="size-3.5 text-indigo-500" /> Tải lẻ từng file ({job.summary.done})
                    </button>
                  )}
                  {job.zipUrl && job.summary.done > 0 && (
                    <a
                      href={job.zipUrl}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm shadow-emerald-600/20 hover:bg-emerald-500"
                    >
                      <Archive className="size-3.5" /> Tải tất cả (.ZIP)
                    </a>
                  )}
                </div>
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-500"
                  style={{ width: `${Math.max(4, job.summary.progress)}%` }}
                />
              </div>
            </div>

            {/* Danh sách từng video */}
            <div className="space-y-3">
              {job.items.map((it, idx) => {
                const vid = it.video;
                const showingPreview = previewItemId === it.id && vid?.streamUrl;
                return (
                  <div key={it.id} className="rounded-2xl border bg-background p-3.5 transition hover:border-border/90">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        {vid?.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={vid.thumbnailUrl}
                            alt={vid.title}
                            className="h-16 w-12 shrink-0 rounded-xl border bg-black object-cover"
                          />
                        ) : (
                          <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground">
                            <Film className="size-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold">#{idx + 1}</span>
                            {it.status === "done" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                                <CheckCircle2 className="size-3" /> Sạch Logo
                              </span>
                            ) : it.status === "error" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                                <AlertCircle className="size-3" /> Lỗi
                              </span>
                            ) : it.status === "running" || it.status === "downloading" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                                <Loader2 className="size-3 animate-spin" /> Đang tải {it.percent > 0 ? `${it.percent}%` : ""}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                <Clock className="size-3" /> Chờ xử lý
                              </span>
                            )}
                            {vid?.width && vid?.height ? (
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {vid.width}×{vid.height}
                              </span>
                            ) : null}
                            {vid?.duration ? (
                              <span className="font-mono text-[11px] text-muted-foreground">· {fmtSec(vid.duration)}</span>
                            ) : null}
                            {vid?.size ? (
                              <span className="font-mono text-[11px] text-muted-foreground">· {fmtMb(vid.size)}</span>
                            ) : null}
                          </div>

                          <p className="line-clamp-1 text-sm font-semibold">{vid?.title || it.url || `Video #${idx + 1}`}</p>
                          {it.url && (
                            <a
                              href={it.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                            >
                              <span className="truncate">{it.url}</span>
                              <ExternalLink className="size-3 shrink-0" />
                            </a>
                          )}
                          {it.error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{it.error}</p>}
                        </div>
                      </div>

                      {vid?.downloadUrl && (
                        <div className="flex shrink-0 items-center gap-2">
                          {vid.streamUrl && (
                            <button
                              type="button"
                              onClick={() => setPreviewItemId(showingPreview ? null : it.id)}
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border bg-muted/40 px-3 py-2 text-xs font-semibold hover:bg-muted"
                            >
                              <Play className="size-3.5 text-indigo-500" />
                              {showingPreview ? "Ẩn xem" : "Xem thử"}
                            </button>
                          )}
                          <a
                            href={vid.downloadUrl}
                            download={vid.fileName}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-500"
                          >
                            <Download className="size-3.5" /> Tải MP4
                          </a>
                        </div>
                      )}
                    </div>

                    {showingPreview && vid?.streamUrl && (
                      <div className="mt-3 overflow-hidden rounded-2xl border bg-black">
                        <video src={vid.streamUrl} controls autoPlay playsInline className="mx-auto max-h-[380px] w-full object-contain" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Download className="size-7" />
            </div>
            <div className="max-w-md space-y-1.5">
              <h3 className="text-base font-bold">Tải Video Hàng Loạt Không Logo (Đa Nền Tảng)</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Dán nhiều link video cùng lúc (TikTok, Douyin, YouTube Shorts, Facebook Reels, Instagram, Bilibili, Xiaohongshu) hoặc quét cả kênh để tải sạch watermark hoàn toàn miễn phí.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
