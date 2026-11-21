"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, CopyPlus, Download, Film, FolderUp, Loader2, Play, RotateCcw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useCredits } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { tNow } from "@/lib/i18n/translate";
import { cn } from "@/lib/utils";
import type { AiTask, AiTool, Paginated } from "@/lib/types";

type StitchRatio = "9:16" | "16:9" | "1:1";
type StitchQuality = "720p" | "1080p";

interface LibraryClip {
  id: string;
  title: string;
  toolName: string;
  url: string;
  isLocal?: boolean;
  file?: File;
  createdAt?: string;
}

interface QueueItem {
  uid: string;
  clip: LibraryClip;
}

interface StitchedResult {
  url: string;
  sizeBytes: number;
  ext: "mp4" | "webm";
  durationSec: number;
  ratio: StitchRatio;
  quality: StitchQuality;
}

const RATIOS: { value: StitchRatio; label: string }[] = [
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
];

function dimensionsOf(ratio: StitchRatio, quality: StitchQuality): { width: number; height: number } {
  const hd = quality === "1080p";
  if (ratio === "9:16") return hd ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  if (ratio === "16:9") return hd ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  return hd ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
}

function pickRecorderMime(): { mimeType: string; ext: "mp4" | "webm" } {
  if (typeof MediaRecorder === "undefined") return { mimeType: "", ext: "mp4" };
  const mp4Candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ];
  for (const m of mp4Candidates) {
    if (MediaRecorder.isTypeSupported(m)) return { mimeType: m, ext: "mp4" };
  }
  const webmCandidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of webmCandidates) {
    if (MediaRecorder.isTypeSupported(m)) return { mimeType: m, ext: "webm" };
  }
  return { mimeType: "", ext: "webm" };
}

function formatSec(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "--";
  const rounded = Math.round(sec);
  if (rounded < 60) return `${rounded}s`;
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function waitVideoReady(video: HTMLVideoElement, src: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException(tNow("Đã huỷ ghép video"), "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException(tNow("Đã huỷ ghép video"), "AbortError"));
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(tNow("Không đọc được định dạng của một trong các video đã chọn.")));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = src;
    video.currentTime = 0;
    video.load();
  });
}

/**
 * Ghép tuần tự nhiều video ngay trên trình duyệt bằng Canvas + WebAudio + Web Worker clock (30fps không bị bóp khi chuyển tab).
 */
async function stitchClipsInBrowser(opts: {
  items: QueueItem[];
  ratio: StitchRatio;
  quality: StitchQuality;
  durations: Record<string, number>;
  signal: AbortSignal;
  onProgress: (pct: number, stepLabel: string) => void;
}): Promise<StitchedResult> {
  const { items, ratio, quality, durations, signal, onProgress } = opts;
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    throw new Error(tNow("Trình duyệt hiện tại không hỗ trợ ghép video trực tiếp. Vui lòng dùng Chrome, Edge hoặc Safari mới nhất."));
  }

  const tempObjectUrls: string[] = [];
  let worker: Worker | null = null;
  let workerUrl = "";
  let audioCtx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;

  try {
    // 1. Tải sẵn toàn bộ video vào bộ nhớ Blob cục bộ để không bị CORS canvas và chuyển cảnh tức thì 0ms
    const localSrcs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) throw new DOMException(tNow("Đã huỷ"), "AbortError");
      const { clip } = items[i];
      onProgress(Math.round((i / items.length) * 15), tNow("Đang nạp video {i}/{total}...", { i: i + 1, total: items.length }));
      if (clip.isLocal && clip.file) {
        const u = URL.createObjectURL(clip.file);
        tempObjectUrls.push(u);
        localSrcs.push(u);
      } else {
        const fullUrl = clip.url.startsWith("http") ? clip.url : `${window.location.origin}${clip.url}`;
        const res = await fetch(fullUrl, { credentials: "include", signal });
        if (!res.ok) throw new Error(tNow("Không tải được video \"{title}\" (HTTP {status})", { title: clip.title, status: res.status }));
        const blob = await res.blob();
        const u = URL.createObjectURL(blob);
        tempObjectUrls.push(u);
        localSrcs.push(u);
      }
    }

    const { width, height } = dimensionsOf(ratio, quality);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error(tNow("Không khởi tạo được bộ dựng khung hình Canvas."));
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioCtx();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();

    // Giữ nhịp âm thanh nền cực nhỏ để đường tiếng luôn liền mạch kể cả khi gặp clip câm
    const osc = audioCtx.createOscillator();
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0.00001;
    osc.connect(silentGain);
    silentGain.connect(dest);
    osc.start();

    const makeVideoEl = () => {
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.muted = false;
      v.volume = 1;
      v.crossOrigin = "anonymous";
      const node = audioCtx!.createMediaElementSource(v);
      node.connect(dest);
      return v;
    };

    let activeVid = makeVideoEl();
    let standbyVid = makeVideoEl();

    await waitVideoReady(activeVid, localSrcs[0], signal);
    let standbyReadyPromise: Promise<void> | null =
      localSrcs.length > 1 ? waitVideoReady(standbyVid, localSrcs[1], signal) : null;

    const canvasStream = canvas.captureStream(30);
    const videoTrack = canvasStream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const { mimeType, ext } = pickRecorderMime();
    const bitrate = quality === "1080p" ? 8_000_000 : 4_500_000;
    recorder = mimeType
      ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128_000 })
      : new MediaRecorder(combinedStream, { videoBitsPerSecond: bitrate });

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const stoppedPromise = new Promise<Blob>((resolve, reject) => {
      recorder!.onstop = () => {
        const finalType = recorder?.mimeType || mimeType || (ext === "mp4" ? "video/mp4" : "video/webm");
        resolve(new Blob(chunks, { type: finalType }));
      };
      recorder!.onerror = () => reject(new Error(tNow("Bộ ghi video gặp sự cố khi xuất file.")));
    });

    const drawFrame = (v: HTMLVideoElement) => {
      const vw = v.videoWidth || width;
      const vh = v.videoHeight || height;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);
      if (vw > 0 && vh > 0) {
        const scale = Math.min(width / vw, height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.drawImage(v, (width - dw) / 2, (height - dh) / 2, dw, dh);
      }
      if (typeof videoTrack?.requestFrame === "function") {
        try {
          videoTrack.requestFrame();
        } catch {
          /* ignore */
        }
      }
    };

    // Web Worker phát xung 33ms/lần (~30fps) không bị trình duyệt làm chậm khi người dùng chuyển sang tab khác
    const workerBlob = new Blob(
      ['let t=null;onmessage=(e)=>{if(e.data==="start"){clearInterval(t);t=setInterval(()=>postMessage(0),33);}else{clearInterval(t);}};'],
      { type: "application/javascript" },
    );
    workerUrl = URL.createObjectURL(workerBlob);
    worker = new Worker(workerUrl);

    let currentVideoForDraw = activeVid;
    drawFrame(currentVideoForDraw);
    worker.onmessage = () => {
      if (!currentVideoForDraw.paused && !currentVideoForDraw.ended) {
        drawFrame(currentVideoForDraw);
      }
    };
    worker.postMessage("start");

    recorder.start(250);

    const estDurations = items.map((it) => Math.max(1, durations[it.clip.id] || 6));
    const totalEst = estDurations.reduce((a, b) => a + b, 0);
    let elapsedBefore = 0;

    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) throw new DOMException(tNow("Đã huỷ"), "AbortError");
      currentVideoForDraw = activeVid;
      drawFrame(activeVid);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const clipDur = Number.isFinite(activeVid.duration) && activeVid.duration > 0 ? activeVid.duration : estDurations[i];
        const safetyTimer = window.setTimeout(() => {
          finish();
        }, Math.ceil((clipDur + 4) * 1000));

        const progressTimer = window.setInterval(() => {
          const cur = Math.min(clipDur, activeVid.currentTime || 0);
          const ratioDone = Math.min(1, (elapsedBefore + cur) / Math.max(1, totalEst));
          const pct = Math.min(98, 15 + Math.round(ratioDone * 83));
          onProgress(pct, tNow("Đang ghép video {i}/{total} · {pct}%", { i: i + 1, total: items.length, pct }));
        }, 200);

        const onAbort = () => {
          cleanup();
          activeVid.pause();
          reject(new DOMException(tNow("Đã huỷ"), "AbortError"));
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          drawFrame(activeVid);
          cleanup();
          resolve();
        };
        const onErr = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(tNow("Lỗi khi phát video thứ {i} trong lúc ghép.", { i: i + 1 })));
        };
        const cleanup = () => {
          window.clearTimeout(safetyTimer);
          window.clearInterval(progressTimer);
          signal.removeEventListener("abort", onAbort);
          activeVid.removeEventListener("ended", finish);
          activeVid.removeEventListener("error", onErr);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        activeVid.addEventListener("ended", finish, { once: true });
        activeVid.addEventListener("error", onErr, { once: true });

        activeVid.play().catch(onErr);
      });

      elapsedBefore += Number.isFinite(activeVid.duration) && activeVid.duration > 0 ? activeVid.duration : estDurations[i];

      if (i + 1 < items.length) {
        if (standbyReadyPromise) await standbyReadyPromise;
        const prevVid = activeVid;
        activeVid = standbyVid;
        standbyVid = prevVid;
        standbyReadyPromise = i + 2 < items.length ? waitVideoReady(standbyVid, localSrcs[i + 2], signal) : null;
      }
    }

    onProgress(99, tNow("Đang đóng gói file video hoàn chỉnh..."));
    worker.postMessage("stop");
    osc.stop();
    if (recorder.state !== "inactive") recorder.stop();
    const finalBlob = await stoppedPromise;
    const finalExt: "mp4" | "webm" = (finalBlob.type || mimeType).includes("mp4") ? "mp4" : ext;

    onProgress(100, tNow("Hoàn tất!"));
    return {
      url: URL.createObjectURL(finalBlob),
      sizeBytes: finalBlob.size,
      ext: finalExt,
      durationSec: Math.round(elapsedBefore),
      ratio,
      quality,
    };
  } finally {
    if (worker) {
      worker.postMessage("stop");
      worker.terminate();
    }
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    if (audioCtx && audioCtx.state !== "closed") {
      audioCtx.close().catch(() => undefined);
    }
    for (const u of tempObjectUrls) URL.revokeObjectURL(u);
  }
}

/**
 * Giao diện công cụ `Ghép Video AI Liền Mạch` (`/tools/video-stitch`):
 * - Trái: Lưới video đã tạo trong Lịch sử AI của tài khoản + nút tải thêm video từ máy tính / điện thoại.
 * - Phải: Thứ tự ghép (đổi chỗ ↑ ↓, nhân bản, xoá), chọn tỉ lệ 9:16 / 16:9 / 1:1, chọn độ nét 720p / 1080p,
 *   ghép trực tiếp ngay trên trình duyệt (0đ, không tốn tài nguyên máy chủ, chuyển tab thoải mái).
 */
export function VideoStitchWorkspace({
  tool,
  demoMedia,
  modelPicker,
}: {
  tool?: AiTool;
  demoMedia?: ReactNode;
  modelPicker?: ReactNode;
}) {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const credits = useCredits();
  const [filterTool, setFilterTool] = useState<string>("all");
  const [localClips, setLocalClips] = useState<LibraryClip[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [ratio, setRatio] = useState<StitchRatio>("9:16");
  const [quality, setQuality] = useState<StitchQuality>("1080p");
  const [stitching, setStitching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stepText, setStepText] = useState("");
  const [result, setResult] = useState<StitchedResult | null>(null);

  const isPaid = !!tool && tool.pricing.mode !== "free";
  const stitchQuote = useQuery({
    queryKey: ["ai", "quote", tool?.key, ratio, quality],
    queryFn: () => api.post<{ credits: number }>(`/public/ai/tools/${encodeURIComponent(tool!.key)}/quote`, { input: { aspectRatio: ratio, resolution: quality } }),
    enabled: isPaid,
    staleTime: 60_000,
    retry: false,
    meta: { silentError: true },
  });
  const stitchPrice = isPaid ? (stitchQuote.data?.credits ?? tool?.price ?? 0) : 0;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const localUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = localUrlsRef.current;
    return () => {
      abortRef.current?.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (result?.url) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  const tasksQuery = useQuery({
    queryKey: ["ai", "tasks", "stitch-library"],
    queryFn: () => api.get<Paginated<AiTask>>("/account/ai/tasks", { status: "SUCCEEDED", limit: 60 }),
    staleTime: 30_000,
  });

  const remoteClips = useMemo<LibraryClip[]>(() => {
    const rows = tasksQuery.data?.data ?? [];
    const out: LibraryClip[] = [];
    for (const task of rows) {
      const files = task.output?.files ?? [];
      files.forEach((f, idx) => {
        const isVid = f.type === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(f.url || "");
        if (!isVid || !f.url) return;
        const suffix = files.length > 1 ? ` (${idx + 1})` : "";
        out.push({
          id: `task-${task.id}-${idx}`,
          title: `#${task.code}${suffix}`,
          toolName: task.tool?.name || t("Video AI"),
          url: f.url,
          createdAt: task.createdAt,
        });
      });
    }
    return out;
  }, [tasksQuery.data, t]);

  const allClips = useMemo(() => [...localClips, ...remoteClips], [localClips, remoteClips]);

  const toolFilters = useMemo(() => {
    const names = new Set<string>();
    for (const c of remoteClips) if (c.toolName) names.add(c.toolName);
    return [...names];
  }, [remoteClips]);

  const visibleClips = useMemo(() => {
    if (filterTool === "all") return allClips;
    if (filterTool === "__local__") return localClips;
    return allClips.filter((c) => c.toolName === filterTool);
  }, [allClips, localClips, filterTool]);

  // Bản đồ clip.id -> danh sách vị trí xuất hiện (1-based) để hiển thị huy hiệu số thứ tự trên thẻ bên trái
  const orderMap = useMemo(() => {
    const m = new Map<string, number[]>();
    queue.forEach((item, index) => {
      const arr = m.get(item.clip.id) ?? [];
      arr.push(index + 1);
      m.set(item.clip.id, arr);
    });
    return m;
  }, [queue]);

  const totalDuration = useMemo(
    () => queue.reduce((sum, item) => sum + (durations[item.clip.id] || 0), 0),
    [queue, durations],
  );

  const toggleClip = (clip: LibraryClip) => {
    if (stitching) return;
    setQueue((prev) => {
      const exists = prev.some((x) => x.clip.id === clip.id);
      if (exists) return prev.filter((x) => x.clip.id !== clip.id);
      return [...prev, { uid: `${clip.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, clip }];
    });
  };

  const duplicateAt = (idx: number) => {
    if (stitching) return;
    setQueue((prev) => {
      const target = prev[idx];
      if (!target) return prev;
      const copy: QueueItem = {
        uid: `${target.clip.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        clip: target.clip,
      };
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
    });
  };

  const moveItem = (idx: number, dir: -1 | 1) => {
    if (stitching) return;
    const nextIdx = idx + dir;
    setQueue((prev) => {
      if (nextIdx < 0 || nextIdx >= prev.length) return prev;
      const copy = [...prev];
      const [picked] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, picked);
      return copy;
    });
  };

  const removeAt = (idx: number) => {
    if (stitching) return;
    setQueue((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleLocalFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const added: LibraryClip[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
        toast.error(t("File {name} không phải định dạng video hợp lệ.", { name: file.name }));
        continue;
      }
      const objUrl = URL.createObjectURL(file);
      localUrlsRef.current.push(objUrl);
      added.push({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: file.name.replace(/\.[^.]+$/, ""),
        toolName: t("Tải từ máy"),
        url: objUrl,
        isLocal: true,
        file,
      });
    }
    if (!added.length) return;
    setLocalClips((prev) => [...added, ...prev]);
    setQueue((prev) => [
      ...prev,
      ...added.map((clip) => ({
        uid: `${clip.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        clip,
      })),
    ]);
    toast.success(t("Đã thêm {n} video từ máy vào danh sách ghép!", { n: added.length }));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleStartStitch = async () => {
    if (queue.length < 2) {
      toast.error(t("Cần chọn ít nhất 2 video để ghép."));
      return;
    }
    if (isPaid && stitchPrice > 0) {
      const bal = credits.data?.credits ?? 0;
      if (bal < stitchPrice) {
        toast.error(t("Số dư ví không đủ ({need}), vui lòng nạp thêm để ghép video.", { need: fmt.price(stitchPrice) }));
        return;
      }
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStitching(true);
    setProgress(2);
    setStepText(t("Đang khởi tạo bộ ghép video..."));
    if (result?.url) {
      URL.revokeObjectURL(result.url);
      setResult(null);
    }

    try {
      const stitched = await stitchClipsInBrowser({
        items: queue,
        ratio,
        quality,
        durations,
        signal: ctrl.signal,
        onProgress: (pct, label) => {
          setProgress(pct);
          setStepText(label);
        },
      });
      if (isPaid && stitchPrice > 0 && tool) {
        try {
          await api.post(`/account/ai/tools/${encodeURIComponent(tool.key)}/run`, {
            input: { aspectRatio: ratio, resolution: quality },
            isPublic: false,
          });
          void qc.invalidateQueries({ queryKey: ["credits"] });
        } catch (chargeErr) {
          URL.revokeObjectURL(stitched.url);
          throw new Error(errorMessage(chargeErr));
        }
      }
      setResult(stitched);
      toast.success(t("Ghép thành công {n} video! Bạn có thể xem trước và tải về ngay.", { n: queue.length }));
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        toast.info(t("Đã dừng ghép video."));
      } else {
        toast.error((err as Error)?.message || t("Không thể ghép video, vui lòng thử lại."));
      }
    } finally {
      setStitching(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const selectedUniqueCount = orderMap.size;

  return (
    <div className="space-y-5">
      {/* Khung xem kết quả nổi bật ngay khi vừa ghép xong */}
      {result && (
        <section className="overflow-hidden rounded-3xl border border-emerald-500/30 bg-card p-4 shadow-md sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Sparkles className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-bold">{t("Video đã ghép hoàn chỉnh")}</h2>
                <p className="text-xs text-muted-foreground">
                  {result.ratio} · {result.quality} · {formatSec(result.durationSec)} · {formatMb(result.sizeBytes)} · .{result.ext.toUpperCase()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={result.url}
                download={`AI_GhepVideo_${result.ratio.replace(":", "x")}_${result.quality}_${Date.now()}.${result.ext}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              >
                <Download className="size-3.5" /> {t("Tải video về máy")}
              </a>
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(result.url);
                  setResult(null);
                }}
                className="inline-flex size-9 items-center justify-center rounded-full border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title={t("Đóng khung kết quả")}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="flex justify-center rounded-2xl bg-black/95 p-2">
            <video
              key={result.url}
              src={result.url}
              controls
              autoPlay
              playsInline
              className="max-h-[520px] w-auto rounded-xl object-contain"
            />
          </div>
        </section>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_410px]">
        {/* Cột trái: Thư viện video đã có + Tải video từ máy */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium text-muted-foreground">
                {t("Đã chọn")} <b className="text-foreground">{selectedUniqueCount}/{allClips.length}</b>
              </span>
              {queue.length > 0 && !stitching && (
                <button
                  type="button"
                  onClick={() => setQueue([])}
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                >
                  <RotateCcw className="size-3" /> {t("Bỏ chọn hết")}
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime,video/*"
                multiple
                className="hidden"
                onChange={(e) => handleLocalFiles(e.target.files)}
              />
              <button
                type="button"
                disabled={stitching}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-card px-3 text-xs font-semibold transition hover:bg-muted disabled:opacity-50"
              >
                <Upload className="size-3.5" /> {t("Thêm video từ máy")}
              </button>

              <select
                value={filterTool}
                onChange={(e) => setFilterTool(e.target.value)}
                aria-label={t("Lọc nguồn video")}
                className="h-9 min-w-[165px] rounded-xl border bg-card px-3 text-xs font-medium text-foreground focus:border-primary focus:outline-none"
              >
                <option value="all">{t("Mọi video")} ({allClips.length})</option>
                {localClips.length > 0 && (
                  <option value="__local__">{t("Tải từ máy")} ({localClips.length})</option>
                )}
                {toolFilters.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {tasksQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="aspect-square animate-pulse rounded-2xl border bg-muted/50" />
              ))}
            </div>
          ) : visibleClips.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed bg-card/60 px-6 py-16 text-center">
              <span className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Film className="size-6" />
              </span>
              <p className="text-sm font-semibold">{t("Chưa có video nào trong danh sách")}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t("Hãy tạo video bằng các công cụ AI Studio hoặc bấm nút bên dưới để chọn các đoạn video có sẵn từ máy tính / điện thoại của bạn.")}
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-semibold text-background transition hover:opacity-90"
              >
                <FolderUp className="size-3.5" /> {t("Chọn video từ máy")}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {visibleClips.map((clip) => {
                const orders = orderMap.get(clip.id);
                const selected = !!orders?.length;
                const dur = durations[clip.id];
                return (
                  <button
                    key={clip.id}
                    type="button"
                    disabled={stitching}
                    onClick={() => toggleClip(clip)}
                    className={cn(
                      "group relative aspect-square overflow-hidden rounded-2xl border bg-zinc-950 text-left transition duration-150 focus:outline-none",
                      selected
                        ? "border-primary ring-2 ring-primary ring-offset-2 ring-offset-background"
                        : "border-border/70 hover:-translate-y-0.5 hover:border-foreground/40 hover:shadow-md",
                      stitching && "cursor-not-allowed opacity-75",
                    )}
                  >
                    <video
                      src={clip.url}
                      preload="metadata"
                      muted
                      playsInline
                      onLoadedMetadata={(e) => {
                        const d = e.currentTarget.duration;
                        if (Number.isFinite(d) && d > 0) {
                          setDurations((prev) => (prev[clip.id] === d ? prev : { ...prev, [clip.id]: d }));
                        }
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.play().catch(() => undefined);
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.pause();
                        e.currentTarget.currentTime = 0;
                      }}
                      className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
                    />

                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/35" />

                    {/* Nút tròn chọn & số thứ tự xuất hiện góc trên trái */}
                    <span
                      className={cn(
                        "pointer-events-none absolute top-2.5 left-2.5 inline-flex min-w-6 h-6 items-center justify-center rounded-full px-1.5 text-[11px] font-bold shadow-sm transition",
                        selected
                          ? "bg-white text-zinc-950 ring-2 ring-black/20"
                          : "border border-white/70 bg-black/45 text-transparent group-hover:border-white",
                      )}
                    >
                      {selected ? orders.join(",") : <Check className="size-3 opacity-0" />}
                    </span>

                    {clip.isLocal && (
                      <span className="pointer-events-none absolute top-2.5 right-2.5 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[9.5px] font-bold uppercase text-zinc-950">
                        {t("Máy bạn")}
                      </span>
                    )}

                    {/* Thời lượng + mã tác vụ góc dưới */}
                    <div className="pointer-events-none absolute inset-x-2.5 bottom-2 flex items-center justify-between gap-1.5 text-[11px] font-medium text-white">
                      <span className="inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 backdrop-blur-xs">
                        <Play className="size-2.5 fill-current" />
                        {dur ? formatSec(dur) : "Video"}
                      </span>
                      <span className="truncate text-[10px] text-white/80">{clip.title}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Cột phải: Bảng điều khiển Thứ tự ghép + Tỉ lệ + Nút Ghép video */}
        <aside className="flex flex-col gap-5 rounded-3xl border bg-card p-5 shadow-sm lg:sticky lg:top-20">
          {demoMedia}
          {modelPicker}

          {/* THỨ TỰ GHÉP */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
                {t("Thứ tự ghép")}
              </span>
              {queue.length > 0 && (
                <span className="text-xs font-medium text-muted-foreground">
                  {queue.length} {t("đoạn")} · ~{formatSec(totalDuration)}
                </span>
              )}
            </div>

            {queue.length === 0 ? (
              <div className="rounded-2xl border border-dashed bg-muted/25 px-4 py-5 text-xs leading-relaxed text-muted-foreground">
                {t("Bấm video bên trái để thêm — thứ tự bấm là thứ tự xuất hiện.")}
              </div>
            ) : (
              <div className="max-h-[290px] space-y-2 overflow-y-auto pr-1">
                {queue.map((item, idx) => (
                  <div
                    key={item.uid}
                    className="flex items-center gap-2.5 rounded-2xl border bg-background/80 p-2 text-xs transition hover:border-foreground/25"
                  >
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-background">
                      {idx + 1}
                    </span>
                    <video
                      src={item.clip.url}
                      preload="metadata"
                      muted
                      playsInline
                      className="size-10 shrink-0 rounded-lg bg-black object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-foreground">{item.clip.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {durations[item.clip.id] ? `${durations[item.clip.id].toFixed(1)}s` : item.clip.toolName}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        disabled={stitching || idx === 0}
                        onClick={() => moveItem(idx, -1)}
                        title={t("Đưa lên trước")}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={stitching || idx === queue.length - 1}
                        onClick={() => moveItem(idx, 1)}
                        title={t("Đưa xuống sau")}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={stitching}
                        onClick={() => duplicateAt(idx)}
                        title={t("Nhân đôi đoạn này")}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30"
                      >
                        <CopyPlus className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={stitching}
                        onClick={() => removeAt(idx)}
                        title={t("Xoá khỏi danh sách")}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11.5px] text-muted-foreground">
              {t("Dùng ↑ ↓ để đổi thứ tự. Cần ít nhất 2 video.")}
            </p>
          </div>

          {/* TỈ LỆ */}
          <div className="space-y-2">
            <span className="block text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
              {t("Tỉ lệ")}
            </span>
            <div className="flex flex-wrap gap-2">
              {RATIOS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  disabled={stitching}
                  onClick={() => setRatio(r.value)}
                  className={cn(
                    "inline-flex h-9 items-center justify-center rounded-full border px-4 text-xs font-semibold transition",
                    ratio === r.value
                      ? "border-foreground bg-foreground text-background shadow-xs"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              {t("Clip khác tỉ lệ sẽ được đặt giữa khung, viền đen.")}
            </p>
          </div>

          {/* ĐỘ PHÂN GIẢI XUẤT */}
          <div className="space-y-2">
            <span className="block text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
              {t("Chất lượng xuất")}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "1080p", label: "Full HD 1080p" },
                  { value: "720p", label: "HD 720p (Nhanh)" },
                ] as const
              ).map((q) => (
                <button
                  key={q.value}
                  type="button"
                  disabled={stitching}
                  onClick={() => setQuality(q.value)}
                  className={cn(
                    "inline-flex h-9 items-center justify-center rounded-xl border px-3 text-xs font-semibold transition",
                    quality === q.value
                      ? "border-foreground bg-foreground text-background shadow-xs"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(q.label)}
                </button>
              ))}
            </div>
          </div>

          {/* TIẾN ĐỘ & NÚT GHÉP */}
          <div className="space-y-2.5 pt-1">
            {stitching && (
              <div className="space-y-1.5 rounded-2xl border bg-muted/30 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-medium text-foreground">{stepText}</span>
                  <span className="shrink-0 font-bold tabular-nums">{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${Math.max(3, progress)}%` }}
                  />
                </div>
              </div>
            )}

            {stitching ? (
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-rose-500/40 bg-rose-500/10 px-5 text-sm font-semibold text-rose-600 transition hover:bg-rose-500/20 dark:text-rose-400"
              >
                <Loader2 className="size-4 animate-spin" />
                {t("Đang ghép... Bấm để huỷ")}
              </button>
            ) : (
              <button
                type="button"
                disabled={queue.length < 2}
                onClick={handleStartStitch}
                className={cn(
                  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition",
                  queue.length >= 2
                    ? "bg-foreground text-background shadow-sm hover:opacity-90"
                    : "cursor-not-allowed bg-muted text-muted-foreground",
                )}
              >
                <Film className="size-4" />
                {t("Ghép {n} video", { n: queue.length })}
                {stitchPrice > 0 ? ` · ${fmt.price(stitchPrice)}` : ""}
              </button>
            )}

            <p className="text-center text-[11.5px] leading-relaxed text-muted-foreground">
              {stitchPrice > 0
                ? t("Ghép trực tiếp trên trình duyệt ({price}/lượt, chỉ trừ tiền khi ghép xong). Chuyển tab thoải mái, chỉ đừng đóng trang.", { price: fmt.price(stitchPrice) })
                : t("Ghép ngay trên máy bạn, không tốn tiền. Chuyển tab thoải mái, chỉ đừng đóng trang.")}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
