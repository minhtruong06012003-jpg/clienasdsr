"use client";

/**
 * Ảnh xem trước của một tác vụ AI (lưới lịch sử, dải "gần đây", Tổng quan):
 * - ảnh: hiện ảnh; video: khung đầu, rê chuột thì phát không tiếng;
 * - âm thanh: nền gradient theo nhóm + sóng âm; đang chạy: hiệu ứng shimmer; lỗi: nền chấm xám; chưa có file: icon trên nền gradient.
 */
import { AlertCircle, Loader2, Play } from "lucide-react";
import { isRunning, ToolIcon } from "@/lib/ai";
import { useCategories } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { AiTask } from "@/lib/types";
import { ViewportVideo } from "./viewport-video";

/** Chiều cao các vạch sóng âm (cố định để server / client giống nhau) */
const WAVE = [40, 70, 55, 90, 65, 100, 75, 50, 85, 60, 95, 45, 70, 55, 80];

export function TaskThumb({ task, className }: { task: AiTask; className?: string }) {
  const f = task.output?.files?.[0];
  const cat = useCategories().of(task.tool?.category ?? "tools");
  const box = cn("relative aspect-[4/3] w-full overflow-hidden", className);

  if (task.status === "SUCCEEDED" && f?.type === "image")
    return (
      <div className={cn(box, "bg-muted")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={f.url} alt={task.code} loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />
      </div>
    );

  if (task.status === "SUCCEEDED" && f?.type === "video")
    return (
      <div className={cn(box, "bg-black")}>
        <ViewportVideo src={`${f.url}#t=0.1`} className="size-full object-cover" />
        <span className="pointer-events-none absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/65 text-white">
          <Play className="size-3.5 fill-current" />
        </span>
      </div>
    );

  // lỗi / huỷ: nền xám trung tính (không dùng gradient để khỏi lẫn với kết quả thật)
  if (task.status === "FAILED" || task.status === "CANCELLED")
    return (
      <div className={cn(box, "studio-dots flex flex-col items-center justify-center gap-1.5 text-muted-foreground")}>
        <AlertCircle className="size-6" />
        <ToolIcon name={task.tool?.icon} className="size-3.5 opacity-60" />
      </div>
    );

  return (
    <div className={cn(box, "bg-gradient-to-br", cat.art, isRunning(task.status) && "studio-shimmer")}>
      {/* lớp tối nhẹ cho chữ / icon dễ đọc */}
      <div className="absolute inset-0 bg-black/10" />
      <div className="relative flex size-full flex-col items-center justify-center gap-2 text-white">
        {task.status === "SUCCEEDED" && f?.type === "audio" ? (
          <div className="studio-wave flex h-10 items-center gap-[3px]">
            {WAVE.map((h, i) => (
              <span key={i} className="w-[3px] rounded-full bg-white/90" style={{ height: `${h}%`, animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        ) : isRunning(task.status) ? (
          (() => {
            const pct = task.progress > 0 ? Math.min(99, Math.round(task.progress)) : task.status === "PROCESSING" ? 5 : 1;
            return (
              <>
                <Loader2 className="size-7 animate-spin opacity-90" />
                <span className="font-mono text-xs font-bold tracking-tight text-white drop-shadow tabular-nums">
                  {pct}%
                </span>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-white/15">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-500"
                    style={{ width: `${Math.max(pct, 6)}%` }}
                  />
                </div>
              </>
            );
          })()
        ) : (
          <ToolIcon name={task.tool?.icon} className="size-8 opacity-90" />
        )}
      </div>
    </div>
  );
}
