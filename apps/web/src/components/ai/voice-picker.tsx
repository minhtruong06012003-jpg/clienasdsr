"use client";

/**
 * Hộp chọn giọng đọc (ô select có `picker: "voice"`): ô hiện giọng đang chọn + nút nghe thử,
 * bấm "Đổi giọng" mở hộp thoại có tìm kiếm, lọc giới tính / kiểu giọng / 30 ngôn ngữ, nút ▶ nghe thử từng giọng,
 * và tích hợp trực tiếp Kho giọng đã nhân bản cá nhân của thành viên (`allowClonedVoices`).
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, Check, ChevronRight, Loader2, Pause, Play, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toolHref } from "@/lib/ai";
import { intlLocale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";
import { useAiTools } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { AiField, AiFieldOption, UserClonedVoice } from "@/lib/types";

const GENDERS = [
  { value: "", label: "Mọi giới tính" },
  { value: "female", label: "Nữ" },
  { value: "male", label: "Nam" },
  { value: "neutral", label: "Trung tính" },
] as const;
const GENDER_LABEL: Record<string, string> = { female: "Nữ", male: "Nam", neutral: "Trung tính" };

/** Nhãn tiếng Việt chuẩn của 30 ngôn ngữ đa quốc gia (ưu tiên khớp thói quen người dùng Việt; giao diện ngoại ngữ tự đổi qua Intl.DisplayNames) */
export const VOICE_LANG_VI: Record<string, string> = {
  vi: "Tiếng Việt",
  en: "Tiếng Anh",
  zh: "Tiếng Trung",
  es: "Tiếng Tây Ban Nha",
  fr: "Tiếng Pháp",
  de: "Tiếng Đức",
  ja: "Tiếng Nhật",
  ko: "Tiếng Hàn",
  it: "Tiếng Ý",
  pt: "Tiếng Bồ Đào Nha",
  ru: "Tiếng Nga",
  ar: "Tiếng Ả Rập",
  hi: "Tiếng Hindi",
  bn: "Tiếng Bengal",
  id: "Tiếng Indonesia",
  ms: "Tiếng Mã Lai",
  th: "Tiếng Thái",
  tl: "Tiếng Philippines",
  fil: "Tiếng Philippines",
  nl: "Tiếng Hà Lan",
  tr: "Tiếng Thổ Nhĩ Kỳ",
  pl: "Tiếng Ba Lan",
  sv: "Tiếng Thụy Điển",
  da: "Tiếng Đan Mạch",
  no: "Tiếng Na Uy",
  fi: "Tiếng Phần Lan",
  el: "Tiếng Hy Lạp",
  he: "Tiếng Do Thái",
  cs: "Tiếng Séc",
  hu: "Tiếng Hungary",
  ro: "Tiếng Romania",
};

export function langName(code: string, uiLocale: string) {
  const norm = code.trim().toLowerCase();
  if (uiLocale === "vi" && VOICE_LANG_VI[norm]) return VOICE_LANG_VI[norm];
  try {
    const iso = norm === "tl" ? "fil" : norm;
    const name = new Intl.DisplayNames([intlLocale(uiLocale)], { type: "language" }).of(iso);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : VOICE_LANG_VI[norm] || code;
  } catch {
    return VOICE_LANG_VI[norm] || code;
  }
}

/** Dòng mô tả phụ của một giọng: ngôn ngữ · giới tính · mô tả phong cách */
function voiceMeta(o: AiFieldOption, uiLocale: string, t: (s: string) => string) {
  const langPart = o.langs?.[0] ? langName(o.langs[0], uiLocale) : "";
  const genderPart = o.gender ? t(GENDER_LABEL[o.gender]) : "";
  const descPart = o.hint ? t(o.hint) : (o.tags ?? []).map((x) => t(x)).join(" · ");
  return [langPart, genderPart, descPart].filter(Boolean).join(" · ");
}

/** Phát / dừng file nghe thử: một thẻ <audio> dùng chung, `playing` = mã giọng đang phát */
function usePreviewPlayer(template?: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => () => audio.current?.pause(), []);

  const toggle = (voice: string, directUrl?: string) => {
    const srcUrl = directUrl || (template ? template.replace("{value}", encodeURIComponent(voice)) : "");
    if (!srcUrl) return;
    const el = (audio.current ??= new Audio());
    if (playing === voice) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.pause();
    el.src = srcUrl;
    el.onended = () => setPlaying(null);
    setLoading(voice);
    setPlaying(voice);
    el.play()
      .catch(() => {
        setPlaying(null);
        toast.error(t("Không phát được file nghe thử"));
      })
      .finally(() => setLoading(null));
  };
  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };
  return { playing, loading, toggle, stop };
}

/** Nút tròn ▶ / ⏸ nghe thử */
function PlayButton({ voice, directUrl, player, size = "md" }: { voice: string; directUrl?: string; player: ReturnType<typeof usePreviewPlayer>; size?: "sm" | "md" }) {
  const { t } = useI18n();
  const active = player.playing === voice;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        player.toggle(voice, directUrl);
      }}
      aria-label={active ? t("Dừng nghe thử") : t("Nghe thử")}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border transition",
        size === "sm" ? "size-8" : "size-10",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:border-foreground/30 hover:bg-muted",
      )}
    >
      {player.loading === voice ? <Loader2 className="size-4 animate-spin" /> : active ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-px fill-current" />}
    </button>
  );
}

export function VoicePicker({ field: f, options, value, onChange, disabled, modelLabel }: { field: AiField; options: AiFieldOption[]; value: unknown; onChange: (v: string) => void; disabled?: boolean; modelLabel?: string }) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const tools = useAiTools();
  const player = usePreviewPlayer(f.preview);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [gender, setGender] = useState("");
  const [lang, setLang] = useState("");
  const [voiceKind, setVoiceKind] = useState<"" | "cloned" | "system" | "premium">("");

  const cloneTool = useMemo(
    () => (tools.data ?? []).find((x) => x.key === "voice-clone" || x.key.startsWith("voice-clone-") || x.key.endsWith(".voice-clone")),
    [tools.data],
  );

  const myVoicesQuery = useQuery({
    queryKey: ["ai", "my-voices"],
    queryFn: () => api.get<{ limit: number; items: UserClonedVoice[] }>("/account/ai/voices"),
    enabled: Boolean(f.allowClonedVoices && user),
    staleTime: 60_000,
  });

  const clonedOptions: (AiFieldOption & { previewUrl?: string; isUserClone?: boolean })[] = useMemo(() => {
    if (!f.allowClonedVoices || !myVoicesQuery.data?.items?.length) return [];
    return myVoicesQuery.data.items.map((v) => ({
      value: v.value,
      label: v.name,
      hint: v.description || (v.refText ? `"${v.refText.slice(0, 80)}${v.refText.length > 80 ? "..." : ""}"` : undefined),
      badge: "Giọng đã clone · ×2.5",
      gender: v.gender,
      langs: [v.language],
      tags: ["Giọng đã clone"],
      previewUrl: v.previewUrl,
      isUserClone: true,
    }));
  }, [f.allowClonedVoices, myVoicesQuery.data]);

  const mergedOptions: (AiFieldOption & { previewUrl?: string; isUserClone?: boolean })[] = useMemo(
    () => [...clonedOptions, ...options],
    [clonedOptions, options],
  );

  const selected = mergedOptions.find((o) => o.value === value);

  // Danh sách ngôn ngữ: nếu công cụ khai báo `filterLangs` (30 ngôn ngữ đa quốc gia) thì giữ đầy đủ thứ tự ưu tiên; ngược lại suy từ các giọng hiện có
  const langs = useMemo(() => {
    if (f.filterLangs?.length) {
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const c of [...f.filterLangs, ...mergedOptions.flatMap((o) => o.langs ?? [])]) {
        const norm = c.trim().toLowerCase();
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          ordered.push(norm);
        }
      }
      return ordered.map((code) => ({ code, name: langName(code, locale) }));
    }
    const set = new Set(mergedOptions.flatMap((o) => o.langs ?? []));
    return [...set]
      .map((code) => ({ code, name: langName(code, locale) }))
      .sort((a, b) => Number(b.code === "vi") - Number(a.code === "vi") || a.name.localeCompare(b.name, intlLocale(locale)));
  }, [f.filterLangs, mergedOptions, locale]);

  useEffect(() => {
    if (lang && !langs.some((l) => l.code === lang)) setLang("");
  }, [langs, lang]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return mergedOptions.filter((o) => {
      if (gender && o.gender !== gender) return false;
      if (lang && !o.langs?.some((x) => x.toLowerCase() === lang.toLowerCase())) return false;
      if (voiceKind === "cloned" && !o.isUserClone) return false;
      if (voiceKind === "premium" && (o.isUserClone || !o.tags?.includes("Giọng cao cấp"))) return false;
      if (voiceKind === "system" && (o.isUserClone || o.tags?.includes("Giọng cao cấp"))) return false;
      if (!s) return true;
      return (
        o.label.toLowerCase().includes(s) ||
        t(o.label).toLowerCase().includes(s) ||
        (o.hint && (o.hint.toLowerCase().includes(s) || t(o.hint).toLowerCase().includes(s))) ||
        (o.tags?.some((x) => x.toLowerCase().includes(s) || t(x).toLowerCase().includes(s)) ?? false) ||
        (o.badge?.toLowerCase().includes(s) ?? false)
      );
    });
  }, [mergedOptions, q, gender, lang, voiceKind, t]);

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) player.stop();
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">
          {t(f.label)}
          {f.required && <span className="text-rose-500"> *</span>}
        </span>
        <div className="flex items-center gap-2">
          {f.allowClonedVoices && cloneTool && (
            <Link
              href={toolHref(cloneTool.key)}
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
            >
              <AudioLines className="size-3" /> {clonedOptions.length > 0 ? `${t("Kho giọng clone")} (${clonedOptions.length})` : t("+ Nhân bản giọng")}
            </Link>
          )}
          <span className="text-[11px] text-muted-foreground">{t("{n} giọng", { n: mergedOptions.length })}</span>
        </div>
      </div>

      {/* giọng đang chọn: nghe thử ngay + nút mở hộp chọn */}
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
        {selected && <PlayButton voice={selected.value} directUrl={selected.previewUrl} player={player} />}
        <button type="button" disabled={disabled || !mergedOptions.length} onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold">{selected ? (selected.isUserClone ? selected.label : t(selected.label)) : t("Chọn giọng đọc")}</span>
              {selected?.badge && (
                <span className={cn("shrink-0 rounded-full border px-2 py-px text-[10.5px] font-medium", selected.isUserClone ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                  {t(selected.badge)}
                </span>
              )}
            </span>
            {selected && <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{voiceMeta(selected, locale, t)}</span>}
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-semibold text-primary">
            {t("Đổi giọng")} <ChevronRight className="size-4" />
          </span>
        </button>
      </div>
      {f.help && <p className="mt-1 text-[11px] text-muted-foreground">{t(f.help)}</p>}

      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="flex max-h-[min(90dvh,860px)] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="border-b px-5 pt-5 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
              <div>
                <DialogTitle className="text-lg">{t("Chọn giọng đọc")}</DialogTitle>
                <DialogDescription className="mt-0.5">
                  {t("{n} giọng đọc", { n: list.length })}
                  {modelLabel ? ` (${t("Mô hình")}: ${t(modelLabel)})` : ""}
                </DialogDescription>
              </div>
              {f.allowClonedVoices && cloneTool && (
                <Link
                  href={toolHref(cloneTool.key)}
                  onClick={() => close(false)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white transition hover:bg-emerald-700"
                >
                  <Plus className="size-3.5" /> {t("Tạo giọng clone mới")}
                </Link>
              )}
            </div>
          </DialogHeader>
          <div className="space-y-3 border-b px-5 py-4">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Tìm theo tên người đọc hoặc phong cách (vd: narrator, warm, girl, Roger...)")} className="h-10 rounded-xl pl-9" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {GENDERS.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGender(g.value)}
                  className={cn("h-8 rounded-lg border px-2.5 text-[12px] font-medium transition", gender === g.value ? "border-foreground bg-muted ring-2 ring-foreground/15" : "bg-card text-foreground/80 hover:border-foreground/20")}
                >
                  {t(g.label)}
                </button>
              ))}
              {f.allowClonedVoices && (
                <select
                  value={voiceKind}
                  onChange={(e) => setVoiceKind(e.target.value as typeof voiceKind)}
                  className="h-8 rounded-lg border bg-card px-2 text-[12px] outline-none"
                  aria-label={t("Kiểu giọng")}
                >
                  <option value="">{t("Mọi kiểu giọng")}</option>
                  <option value="cloned">{t("Giọng đã clone")} ({clonedOptions.length})</option>
                  <option value="system">{t("Giọng tiêu chuẩn")}</option>
                  <option value="premium">{t("Giọng cao cấp")}</option>
                </select>
              )}
              {langs.length > 1 && (
                <select value={lang} onChange={(e) => setLang(e.target.value)} className="ml-auto h-8 max-w-[190px] rounded-lg border bg-card px-2 text-[12px] outline-none" aria-label={t("Ngôn ngữ")}>
                  <option value="">{t("Mọi ngôn ngữ")}</option>
                  {langs.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p className="text-[11.5px] text-muted-foreground">💡 {t("Giọng nào cũng đọc được tiếng Việt & 30 ngôn ngữ — bấm nút ▶ để nghe thử hoặc chọn từ Kho giọng đã clone của bạn.")}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
            {list.map((o) => {
              const active = o.value === value;
              return (
                <div
                  key={o.value}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onChange(o.value);
                    close(false);
                  }}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onChange(o.value), close(false))}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition",
                    active ? "border-primary bg-primary/10 ring-1 ring-primary/40" : o.isUserClone ? "border-emerald-500/30 bg-emerald-500/[0.04] hover:border-emerald-500/60" : "bg-card hover:border-foreground/20",
                  )}
                >
                  <PlayButton voice={o.value} directUrl={o.previewUrl} player={player} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold">{o.isUserClone ? o.label : t(o.label)}</span>
                      {o.badge && (
                        <span className={cn("rounded-full border px-2 py-px text-[10.5px] font-medium", o.isUserClone ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                          {t(o.badge)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{voiceMeta(o, locale, t)}</div>
                  </div>
                  {active && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-primary">
                      <Check className="size-4" /> {t("Đang chọn")}
                    </span>
                  )}
                </div>
              );
            })}
            {!list.length && (
              <div className="py-10 text-center">
                <p className="text-[13px] text-muted-foreground">
                  {voiceKind === "cloned" && !clonedOptions.length
                    ? t("Bạn chưa có giọng nói nào trong Kho giọng đã clone.")
                    : t("Không có giọng nào khớp bộ lọc")}
                </p>
                {f.allowClonedVoices && cloneTool && voiceKind === "cloned" && !clonedOptions.length && (
                  <Link
                    href={toolHref(cloneTool.key)}
                    onClick={() => close(false)}
                    className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-xs font-semibold text-white transition hover:bg-emerald-700"
                  >
                    <Plus className="size-3.5" /> {t("Tạo giọng nhân bản đầu tiên")}
                  </Link>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="m-0 border-t px-5 py-4">
            <button type="button" onClick={() => close(false)} className="h-11 w-full rounded-xl bg-primary text-[14px] font-semibold text-primary-foreground transition hover:opacity-90">
              {t("Xong")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
