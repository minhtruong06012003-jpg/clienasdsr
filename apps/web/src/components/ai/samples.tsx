"use client";

/**
 * Khung "Ví dụ đầu ra" trên trang công cụ: cho khách xem trước công cụ làm được gì.
 * - Ví dụ `compare`: ảnh trước / sau chồng lên nhau, kéo thanh giữa (chuột, chạm hoặc phím mũi tên) để so sánh.
 * - Ví dụ `image`: một ảnh kết quả, bấm để mở ảnh gốc ở tab mới.
 * Nhiều ví dụ thì hiện hàng nút chọn (theo `caption`) phía trên khung xem.
 */
import { useState } from "react";
import { MoveHorizontal, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiSample } from "@/lib/types";

export function ToolSamples({ samples, className }: { samples: AiSample[]; className?: string }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  if (!samples.length) return null;
  const sample = samples[Math.min(index, samples.length - 1)];
  return (
    <section className={cn("rounded-3xl border bg-card p-4 shadow-sm sm:p-5", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-amber-500" /> {t("Ví dụ đầu ra")}
        </h2>
        {sample.hint && <span className="text-xs text-muted-foreground">{t(sample.hint)}</span>}
      </div>
      {samples.length > 1 && (
        <div className="studio-scroll -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {samples.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-pressed={i === index}
              className={cn("shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition", i === index ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground")}
            >
              {s.caption ? t(s.caption) : t("Ví dụ {n}", { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
      {/* key = ví dụ để thanh so sánh về giữa khi đổi ví dụ */}
      {sample.type === "compare" ? <CompareSlider key={index} before={sample.before} after={sample.after} /> : <SampleImage key={index} url={sample.url} alt={sample.caption} />}
    </section>
  );
}

/** Ảnh trước / sau chồng lên nhau: phần bên trái thanh kéo là ảnh gốc, bên phải là kết quả (nhãn "Ảnh gốc" / "Kết quả") */
function CompareSlider({ before, after }: { before: string; after: string }) {
  const { t } = useI18n();
  // vị trí thanh kéo, % chiều ngang khung
  const [pos, setPos] = useState(50);
  return (
    <div className="relative mx-auto w-full max-w-2xl select-none overflow-hidden rounded-2xl bg-muted">
      {/* ảnh kết quả làm nền (quyết định chiều cao khung), ảnh gốc phủ lên và bị cắt theo thanh kéo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt={t("Kết quả")} className="block h-auto w-full" draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={before} alt={t("Ảnh gốc")} className="absolute inset-0 size-full object-cover" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} draggable={false} />
      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">{t("Ảnh gốc")}</span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">{t("Kết quả")}</span>
      {/* đường chia + tay nắm */}
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow" style={{ left: `${pos}%` }}>
        <span className="absolute left-1/2 top-1/2 inline-flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-lg">
          <MoveHorizontal className="size-4" />
        </span>
      </div>
      {/* ô range trong suốt phủ toàn khung: nhận kéo chuột, chạm và phím mũi tên */}
      <input
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={t("Kéo để so sánh trước và sau")}
        className="absolute inset-0 size-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}

/** Một ảnh kết quả mẫu */
function SampleImage({ url, alt }: { url: string; alt?: string }) {
  const { t } = useI18n();
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mx-auto block w-full max-w-2xl overflow-hidden rounded-2xl bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt ? t(alt) : t("Ví dụ đầu ra")} className="block h-auto w-full" />
    </a>
  );
}
