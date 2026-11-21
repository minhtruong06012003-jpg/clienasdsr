"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Heart, Loader2, Music, Play, Settings2, Share2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";

interface TikTokExtractResult {
  id: string;
  title: string;
  authorName: string;
  authorAvatar: string | null;
  cover: string | null;
  duration: number;
  videoUrl: string;
  hdDownloadUrl: string;
  standardDownloadUrl: string | null;
  musicDownloadUrl: string | null;
  musicTitle: string | null;
  stats?: {
    plays: number;
    likes: number;
    comments: number;
    shares: number;
  };
}

/**
 * Giao diện công cụ `Tải Video TikTok Không Logo` (nằm trong danh sách công cụ AI DeepCut, link riêng `/tools/tiktok-download`,
 * vẫn giữ nguyên ô chọn Model AI & Video mẫu khi Admin gom chung vào bất kỳ nhóm model nào; tốn 0đ và 0 byte ổ đĩa VPS).
 */
export function TikTokToolWorkspace({
  demoMedia,
  modelPicker,
}: {
  demoMedia?: ReactNode;
  modelPicker?: ReactNode;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TikTokExtractResult | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = url.trim();
    if (!raw) {
      toast.error(t("Vui lòng dán link video TikTok vào ô tìm kiếm."));
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.post<TikTokExtractResult>("/public/ai/tiktok/extract", { url: raw }, { auth: false });
      if (!data?.videoUrl) {
        toast.error(t("Không tìm thấy luồng video hợp lệ. Hãy đảm bảo video ở chế độ công khai."));
        return;
      }
      setResult(data);
      toast.success(t("Bóc tách video thành công! Đã sẵn sàng tải xuống."));
    } catch (err) {
      toast.error((err as Error)?.message || t("Không thể lấy video. Hãy kiểm tra lại đường link TikTok."));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCleanLink = async () => {
    if (!result) return;
    const fullUrl = result.videoUrl.startsWith("http") ? result.videoUrl : `${window.location.origin}${result.videoUrl}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      toast.success(t("Đã sao chép liên kết video sạch vào clipboard!"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("Không thể sao chép liên kết"));
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
      {/* Cột trái: Thiết lập + chọn Model trong nhóm (nếu Admin gom nhóm) + ô dán link TikTok */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm lg:sticky lg:top-20"
      >
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <Settings2 className="size-4 text-muted-foreground" /> {t("Thiết lập")}
          </span>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
            {t("MIỄN PHÍ")}
          </span>
        </div>

        <div className="space-y-4 px-5 py-4">
          {demoMedia}
          {modelPicker}

          <div className="space-y-2">
            <label htmlFor="tiktok-tool-url" className="block text-[13px] font-semibold">
              {t("Dán liên kết TikTok (Hỗ trợ link vt.tiktok.com & tiktok.com):")}
            </label>
            <div className="relative">
              <input
                id="tiktok-tool-url"
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("Dán link TikTok (vt.tiktok.com / tiktok.com/@user/video/...) hoặc văn bản chia sẻ từ app...")}
                className="w-full rounded-2xl border bg-background py-3 pr-9 pl-3.5 text-sm transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
              />
              {url && (
                <button
                  type="button"
                  onClick={() => {
                    setUrl("");
                    setResult(null);
                    inputRef.current?.focus();
                  }}
                  aria-label={t("Xoá")}
                  className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              💡 {t("Video sau khi tải hoàn toàn sạch bóng logo và watermark TikTok")}
            </p>
          </div>
        </div>

        <div className="border-t bg-muted/30 px-5 py-3">
          <div className="mb-2.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("Chi phí")}</span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400">{t("Miễn phí (0đ)")}</span>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[15px] font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>{t("Đang Bóc Tách...")}</span>
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                <span>{t("Lấy Video")}</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Cột phải: Khung xem trước video & tải xuống */}
      <section className="flex min-h-[460px] flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-6">
        {result ? (
          <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="grid gap-5 md:grid-cols-[240px_minmax(0,1fr)]">
              <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-2xl border bg-black shadow-md">
                <video
                  src={result.videoUrl}
                  poster={result.cover || undefined}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                />
              </div>

              <div className="flex min-w-0 flex-col justify-between space-y-4">
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2.5">
                    {result.authorAvatar && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={result.authorAvatar} alt={result.authorName} className="size-7 rounded-full border object-cover" />
                    )}
                    <span className="truncate text-sm font-bold">{result.authorName}</span>
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                      {t("Sạch 100% Logo")}
                    </span>
                  </div>
                  <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground">{result.title}</p>

                  {result.stats && (
                    <div className="flex flex-wrap items-center gap-4 pt-1 font-mono text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Play className="size-3.5 text-indigo-500" />
                        {result.stats.plays.toLocaleString()}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Heart className="size-3.5 text-rose-500" />
                        {result.stats.likes.toLocaleString()}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Share2 className="size-3.5 text-amber-500" />
                        {result.stats.shares.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-2.5 border-t pt-4">
                  <a
                    href={result.hdDownloadUrl}
                    download={`TikTok_Clean_HD_${result.id}.mp4`}
                    className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-md shadow-emerald-600/20 transition hover:bg-emerald-500"
                  >
                    <Download className="size-4" />
                    <span>{t("Tải Video HD Không Logo (Độ Nét Cao)")}</span>
                  </a>

                  {result.standardDownloadUrl && (
                    <a
                      href={result.standardDownloadUrl}
                      download={`TikTok_Clean_Standard_${result.id}.mp4`}
                      title={t("Bản nén H.264 tương thích 100% trình phát mặc định của Windows")}
                      className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-xs font-bold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
                    >
                      <Download className="size-4" />
                      <span>{t("Tải Bản Tương Thích Windows (Chuẩn H.264)")}</span>
                    </a>
                  )}

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {result.musicDownloadUrl && (
                      <a
                        href={result.musicDownloadUrl}
                        download={`TikTok_Audio_${result.id}.mp3`}
                        className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border bg-background px-3 py-2.5 text-xs font-bold transition hover:bg-muted"
                      >
                        <Music className="size-3.5 shrink-0 text-indigo-500" />
                        <span className="truncate">{t("Tải Nhạc MP3")}</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={handleCopyCleanLink}
                      className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border bg-background px-3 py-2.5 text-xs font-bold transition hover:bg-muted ${!result.musicDownloadUrl ? "sm:col-span-2" : ""}`}
                    >
                      {copied ? (
                        <>
                          <Check className="size-3.5 text-emerald-500" />
                          <span>{t("Đã Sao Chép")}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5 text-muted-foreground" />
                          <span>{t("Copy Link Sạch")}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {result.standardDownloadUrl && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-xs leading-relaxed text-slate-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                <span className="shrink-0">💡</span>
                <div>
                  <strong className="text-foreground">{t("Lưu ý khi mở trên Windows:")}</strong>{" "}
                  {t("Nếu trình phát mặc định của Windows báo thiếu codec HEVC, bạn có thể bấm nút")}{" "}
                  <strong className="text-indigo-700 dark:text-indigo-300">{t("Tải Bản Tương Thích Windows (Chuẩn H.264)")}</strong>{" "}
                  {t("hoặc mở trực tiếp bằng CapCut / trình duyệt.")}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="studio-dots flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center">
            <span className="inline-flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-xl">
              <Download className="size-7" />
            </span>
            <p className="mt-5 text-base font-semibold">{t("Tải Video TikTok Không Logo · Miễn phí 100%")}</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {t("Dán liên kết TikTok (vt.tiktok.com hoặc tiktok.com) vào khung bên trái rồi bấm Lấy Video để bóc tách MP4 chuẩn HD sạch 100% watermark & nhạc MP3 gốc.")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
