"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Check, FileAudio, Loader2, Mic, Pause, Pencil, Play, Search, Sparkles, Trash2, Upload, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { toolHref } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { useAiTools } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { UserClonedVoice } from "@/lib/types";
import { langName, VOICE_LANG_VI } from "./voice-picker";

const ALL_LANG_CODES = [
  "vi", "en", "zh", "es", "fr", "de", "ja", "ko", "it", "pt",
  "ru", "ar", "hi", "bn", "id", "ms", "th", "tl", "nl", "tr",
  "pl", "sv", "da", "no", "fi", "el", "he", "cs", "hu", "ro",
];

export function VoiceCloneWorkspace({
  demoMedia,
  modelPicker,
}: {
  demoMedia?: React.ReactNode;
  modelPicker?: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const tools = useAiTools();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("vi");
  const [gender, setGender] = useState<"female" | "male">("female");
  const [refAudioUrl, setRefAudioUrl] = useState("");
  const [refAudioName, setRefAudioName] = useState("");
  const [localPreviewUrl, setLocalPreviewUrl] = useState("");
  const [uploadingPct, setUploadingPct] = useState<number | null>(null);
  const [refText, setRefText] = useState("");
  const [consent, setConsent] = useState(true);

  const [search, setSearch] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<UserClonedVoice | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editLang, setEditLang] = useState("vi");
  const [editGender, setEditGender] = useState<"female" | "male">("female");
  const [confirmDelete, setConfirmDelete] = useState<UserClonedVoice | null>(null);

  const ttsTool = useMemo(() => {
    const list = (tools.data ?? []).filter(
      (x) => x.category === "giong-noi-ai" && (x.key === "tts" || x.key.startsWith("tts-") || x.key.endsWith(".tts")),
    );
    return (
      list.find((x) => x.badge === "SV6" || x.key.startsWith("tts-") || ("hint" in x.pricing && x.pricing.hint?.includes("nhân bản"))) ??
      list[0]
    );
  }, [tools.data]);
  const srtTool = useMemo(
    () => (tools.data ?? []).find((x) => x.key === "convert-subtitles" || x.key.startsWith("convert-subtitles-") || x.key.endsWith(".convert-subtitles")),
    [tools.data],
  );

  const voicesQuery = useQuery({
    queryKey: ["ai", "my-voices"],
    queryFn: () => api.get<{ limit: number; items: UserClonedVoice[] }>("/account/ai/voices"),
  });

  const items = voicesQuery.data?.items ?? [];
  const limit = voicesQuery.data?.limit ?? 20;

  const filteredItems = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (v) =>
        v.name.toLowerCase().includes(kw) ||
        v.description.toLowerCase().includes(kw) ||
        v.refText.toLowerCase().includes(kw) ||
        (VOICE_LANG_VI[v.language]?.toLowerCase().includes(kw) ?? false),
    );
  }, [items, search]);

  const togglePlay = (v: UserClonedVoice) => {
    const el = (audioRef.current ??= new Audio());
    if (playingId === v.id) {
      el.pause();
      setPlayingId(null);
      return;
    }
    el.pause();
    el.src = v.previewUrl;
    el.onended = () => setPlayingId(null);
    setPlayingId(v.id);
    el.play().catch(() => {
      setPlayingId(null);
      toast.error(t("Không phát được file nghe thử"));
    });
  };

  const handleSelectFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadingPct(1);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await api.upload<{ url: string; name: string }>("/account/ai/uploads", form, (pct) => setUploadingPct(pct));
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
      setLocalPreviewUrl(URL.createObjectURL(file));
      setRefAudioUrl(uploaded.url);
      setRefAudioName(file.name);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploadingPct(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const clearAudio = () => {
    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    setLocalPreviewUrl("");
    setRefAudioUrl("");
    setRefAudioName("");
  };

  const createMut = useMutation({
    mutationFn: () =>
      api.post<UserClonedVoice>("/account/ai/voices", {
        name: name.trim(),
        description: description.trim() || undefined,
        language,
        gender,
        refAudioUrl,
        refText: refText.trim(),
      }),
    onSuccess: (created) => {
      toast.success(t("Đã tạo giọng \"{name}\" vào Kho giọng đã clone!", { name: created.name }));
      setName("");
      setDescription("");
      setRefText("");
      clearAudio();
      qc.invalidateQueries({ queryKey: ["ai", "my-voices"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const updateMut = useMutation({
    mutationFn: () =>
      api.put<UserClonedVoice>(`/account/ai/voices/${encodeURIComponent(editing!.id)}`, {
        name: editName.trim(),
        description: editDesc.trim(),
        language: editLang,
        gender: editGender,
      }),
    onSuccess: () => {
      toast.success(t("Đã cập nhật thông tin giọng nhân bản"));
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["ai", "my-voices"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/account/ai/voices/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success(t("Đã xoá giọng khỏi Kho giọng đã clone"));
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ["ai", "my-voices"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const openEdit = (v: UserClonedVoice) => {
    setEditing(v);
    setEditName(v.name);
    setEditDesc(v.description || "");
    setEditLang(v.language || "vi");
    setEditGender(v.gender === "male" ? "male" : "female");
  };

  const useVoiceInTool = (voiceValue: string, targetToolKey?: string) => {
    if (!targetToolKey) {
      toast.error(t("Công cụ đích đang tạm dừng"));
      return;
    }
    const baseHref = toolHref(targetToolKey);
    const sep = baseHref.includes("?") ? "&" : "?";
    router.push(`${baseHref}${sep}voice=${encodeURIComponent(voiceValue)}`);
  };

  const canSubmit = Boolean(name.trim() && refAudioUrl && refText.trim().length >= 4 && consent && !createMut.isPending && uploadingPct === null);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,470px)_minmax(0,1fr)]">
      {/* Cột trái: Form tạo mẫu giọng nhân bản */}
      <form
        className="flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          createMut.mutate();
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AudioLines className="size-4 text-emerald-500" />
            <span>{t("Tạo giọng nhân bản mới")}</span>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            {t("Lưu miễn phí")}
          </span>
        </div>

        <div className="space-y-3.5 px-5 py-4">
          {demoMedia}
          {modelPicker}

          <div>
            <label className="mb-1.5 block text-[13px] font-semibold">
              {t("Tên giọng nói")} <span className="text-rose-500">*</span>
            </label>
            <Input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("VD: Giọng Thương Hiệu, Chí Mạnh, Review Phim...")}
              disabled={createMut.isPending}
              className="h-10 rounded-xl"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-semibold">{t("Mô tả phong cách (Tuỳ chọn)")}</label>
            <Input
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("VD: Quảng cáo game, TikTok bán hàng, kể chuyện đêm khuya...")}
              disabled={createMut.isPending}
              className="h-10 rounded-xl"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold">
                {t("Ngôn ngữ gốc")} <span className="text-rose-500">*</span>
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={createMut.isPending}
                className="h-10 w-full rounded-xl border bg-background px-3 text-[13px] outline-none focus:border-foreground/40"
              >
                {ALL_LANG_CODES.map((code) => (
                  <option key={code} value={code}>
                    {langName(code, locale)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold">
                {t("Giới tính")} <span className="text-rose-500">*</span>
              </label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as "female" | "male")}
                disabled={createMut.isPending}
                className="h-10 w-full rounded-xl border bg-background px-3 text-[13px] outline-none focus:border-foreground/40"
              >
                <option value="female">{t("Giọng Nữ")}</option>
                <option value="male">{t("Giọng Nam")}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-semibold">
              {t("File giọng mẫu (5–25 giây)")} <span className="text-rose-500">*</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/wav,audio/mpeg,audio/mp3,audio/flac,audio/ogg,audio/mp4,audio/x-m4a,.wav,.mp3,.m4a,.flac,.ogg"
              className="hidden"
              onChange={(e) => handleSelectFile(e.target.files?.[0])}
            />
            {refAudioUrl ? (
              <div className="space-y-2 rounded-2xl border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                    <FileAudio className="size-4 shrink-0 text-emerald-500" />
                    <span className="truncate">{refAudioName || t("Đã tải file giọng mẫu")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={clearAudio}
                    disabled={createMut.isPending}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-rose-600"
                    aria-label={t("Xoá")}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                {localPreviewUrl && <audio controls src={localPreviewUrl} className="h-9 w-full" />}
              </div>
            ) : (
              <button
                type="button"
                disabled={uploadingPct !== null || createMut.isPending}
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed bg-muted/20 px-4 py-6 text-center transition hover:border-foreground/30 hover:bg-muted/40 disabled:opacity-60"
              >
                {uploadingPct !== null ? (
                  <>
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <span className="text-xs font-semibold">{t("Đang tải lên")} ({uploadingPct}%)</span>
                  </>
                ) : (
                  <>
                    <Upload className="size-5 text-muted-foreground" />
                    <span className="text-[13px] font-semibold">{t("Bấm để tải lên đoạn ghi âm mẫu")}</span>
                    <span className="text-[11px] text-muted-foreground">{t("WAV, MP3, M4A thu âm điện thoại, OGG · rõ tiếng, không dính nhạc nền")}</span>
                  </>
                )}
              </button>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="text-[13px] font-semibold">
                {t("Lời nói chính xác trong file mẫu")} <span className="text-rose-500">*</span>
              </label>
              <span className="text-[11px] text-muted-foreground tabular-nums">{refText.length} / 2.000</span>
            </div>
            <Textarea
              value={refText}
              maxLength={2000}
              rows={3}
              onChange={(e) => setRefText(e.target.value)}
              disabled={createMut.isPending}
              placeholder={t("Gõ đúng nguyên văn từng chữ người nói đã đọc trong đoạn ghi âm mẫu ở trên...")}
              className="rounded-2xl bg-muted/25 text-[13.5px] leading-relaxed"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("Gõ càng khớp lời trong file mẫu thì âm sắc giọng nhân bản ra càng tự nhiên và tròn chữ.")}
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3 text-xs leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded accent-emerald-600"
            />
            <span>{t("Tôi xác nhận đây là giọng nói của tôi hoặc tôi có quyền hợp pháp sử dụng giọng nói này để tạo bản sao kỹ thuật số.")}</span>
          </label>
        </div>

        <div className="border-t bg-muted/15 px-5 py-4">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createMut.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("Đang phân tích & lưu giọng nhân bản...")}
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                {t("Tạo & Lưu vào Kho giọng")}
              </>
            )}
          </button>
        </div>
      </form>

      {/* Cột phải: Kho giọng đã clone + Chuyển tiếp sang Chuyển văn bản / Chuyển phụ đề */}
      <section className="flex flex-col rounded-3xl border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-base font-bold">
              <span>{t("Giọng nói đã clone")}</span>
              <span className="rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums">
                {items.length}/{limit}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("Bấm \"Sử dụng\" trên bất kỳ giọng nào để chuyển thẳng sang Chuyển văn bản hoặc Chuyển phụ đề (.SRT) với giọng đó.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ttsTool && (
              <button
                type="button"
                onClick={() => router.push(toolHref(ttsTool.key))}
                className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-semibold transition hover:bg-muted"
              >
                <Mic className="size-3.5 text-primary" /> {t("Mở Chuyển văn bản")}
              </button>
            )}
            {srtTool && (
              <button
                type="button"
                onClick={() => router.push(toolHref(srtTool.key))}
                className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-semibold transition hover:bg-muted"
              >
                <FileAudio className="size-3.5 text-emerald-600 dark:text-emerald-400" /> {t("Mở Chuyển phụ đề (.SRT)")}
              </button>
            )}
          </div>
        </div>

        {items.length > 3 && (
          <div className="relative mt-3.5">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Tìm kiếm trong kho giọng đã clone...")}
              className="h-9.5 rounded-xl pl-9 text-xs"
            />
          </div>
        )}

        <div className="mt-4 space-y-3">
          {voicesQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("Đang tải kho giọng...")}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-14 text-center">
              <div className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <AudioLines className="size-6" />
              </div>
              <p className="text-sm font-semibold">
                {items.length === 0 ? t("Kho giọng đã clone của bạn đang trống") : t("Không tìm thấy giọng khớp từ khoá")}
              </p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                {t("Hãy tải lên 1 đoạn thu âm 5–25 giây ở khung bên trái để tạo giọng nói riêng. Sau khi lưu, bạn có thể dùng lại không giới hạn số lần ở cả Chuyển văn bản và Chuyển phụ đề (.SRT).")}
              </p>
            </div>
          ) : (
            filteredItems.map((v) => {
              const activePlay = playingId === v.id;
              return (
                <div
                  key={v.id}
                  className="rounded-2xl border bg-background/60 p-4 transition hover:border-foreground/25 hover:shadow-xs"
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => togglePlay(v)}
                      aria-label={activePlay ? t("Dừng nghe thử") : t("Nghe thử")}
                      className={cn(
                        "mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full border transition",
                        activePlay ? "border-emerald-600 bg-emerald-600 text-white" : "bg-card hover:border-foreground/30 hover:bg-muted",
                      )}
                    >
                      {activePlay ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-px fill-current" />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-[15px] font-bold text-foreground">{v.name}</h3>
                        <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                          {t("Giọng nhân bản · ×2.5")}
                        </span>
                      </div>

                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[
                          langName(v.language, locale),
                          v.gender === "male" ? t("Nam") : t("Nữ"),
                          v.description,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>

                      {v.refText && (
                        <p className="mt-1.5 line-clamp-1 text-xs italic text-muted-foreground/85">
                          &ldquo;{v.refText}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                    {ttsTool && (
                      <button
                        type="button"
                        onClick={() => useVoiceInTool(v.value, ttsTool.key)}
                        className="inline-flex h-8.5 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 text-xs font-bold text-white shadow-xs transition hover:bg-emerald-700"
                      >
                        <Zap className="size-3.5 fill-current" /> {t("Sử dụng")}
                      </button>
                    )}

                    {srtTool && (
                      <button
                        type="button"
                        onClick={() => useVoiceInTool(v.value, srtTool.key)}
                        className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                      >
                        <FileAudio className="size-3.5" /> {t("Dùng cho Phụ đề (.SRT)")}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => openEdit(v)}
                      className="inline-flex h-8.5 items-center gap-1 rounded-xl border bg-card px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="size-3.5" /> {t("Sửa")}
                    </button>

                    <button
                      type="button"
                      onClick={() => setConfirmDelete(v)}
                      className="ml-auto inline-flex size-8.5 items-center justify-center rounded-xl border bg-card text-muted-foreground transition hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600"
                      aria-label={t("Xoá giọng")}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Hộp thoại đổi tên / mô tả giọng */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Chỉnh sửa thông tin giọng clone")}</DialogTitle>
            <DialogDescription>{t("Thay đổi tên hiển thị, phong cách hoặc phân loại ngôn ngữ trong kho giọng của bạn.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="mb-1 block text-xs font-semibold">{t("Tên giọng nói")}</label>
              <Input value={editName} maxLength={80} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold">{t("Mô tả phong cách")}</label>
              <Input value={editDesc} maxLength={200} onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold">{t("Ngôn ngữ")}</label>
                <select
                  value={editLang}
                  onChange={(e) => setEditLang(e.target.value)}
                  className="h-9 w-full rounded-lg border bg-background px-2.5 text-xs outline-none"
                >
                  {ALL_LANG_CODES.map((code) => (
                    <option key={code} value={code}>
                      {langName(code, locale)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold">{t("Giới tính")}</label>
                <select
                  value={editGender}
                  onChange={(e) => setEditGender(e.target.value as "female" | "male")}
                  className="h-9 w-full rounded-lg border bg-background px-2.5 text-xs outline-none"
                >
                  <option value="female">{t("Giọng Nữ")}</option>
                  <option value="male">{t("Giọng Nam")}</option>
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <button type="button" onClick={() => setEditing(null)} className="h-9 rounded-xl border px-4 text-xs font-semibold hover:bg-muted">
              {t("Huỷ")}
            </button>
            <button
              type="button"
              disabled={!editName.trim() || updateMut.isPending}
              onClick={() => updateMut.mutate()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {updateMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {t("Lưu thay đổi")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hộp thoại xác nhận xoá giọng */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Xoá giọng nhân bản?")}</DialogTitle>
            <DialogDescription>
              {confirmDelete ? t("Giọng \"{name}\" sẽ bị xoá vĩnh viễn khỏi Kho giọng đã clone của bạn.", { name: confirmDelete.name }) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" onClick={() => setConfirmDelete(null)} className="h-9 rounded-xl border px-4 text-xs font-semibold hover:bg-muted">
              {t("Huỷ")}
            </button>
            <button
              type="button"
              disabled={deleteMut.isPending}
              onClick={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {deleteMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t("Xoá giọng")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
