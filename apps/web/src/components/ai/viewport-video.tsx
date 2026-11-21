"use client";

import { useEffect, useRef, useState } from "react";

interface ViewportVideoProps {
  src: string;
  className?: string;
  hoverPlay?: boolean;
  /** Giữ chiều cao tối thiểu khi thẻ ở dạng lưới tự co giãn (masonry) chưa vào vùng nhìn */
  placeholderClassName?: string;
}

/**
 * Thẻ <video> tối ưu cho iPhone / Android (T-319):
 * - Chỉ gắn `src` và cấp phát bộ giải mã phần cứng khi thẻ nằm gần vùng nhìn (IntersectionObserver),
 *   tránh vượt trần ~16 AVPlayer của iOS WebKit khi mở Cộng đồng / Bảng điều khiển / Lịch sử đơn hàng.
 * - Khi chuyển sang trang/tab khác (unmount) hoặc cuộn xa khỏi màn hình, chủ động `pause() + removeAttribute("src") + load()`
 *   để đóng ngay luồng tải MP4 và trả slot giải mã phần cứng tức thì, không làm nghẽn chuyển trang.
 * - Trên thiết bị cảm ứng (`hover: none`), tắt hover-play để chạm mở thẻ không kích hoạt phát ngầm gây khựng.
 */
export function ViewportVideo({ src, className, hoverPlay = true, placeholderClassName }: ViewportVideoProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const heightRef = useRef<number>(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting && el.offsetHeight > 0) {
          heightRef.current = el.offsetHeight;
        }
        setVisible(entry.isIntersecting);
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    return () => {
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    };
  }, [visible, src]);

  const canHover = () =>
    hoverPlay && typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

  return (
    <div
      ref={wrapRef}
      className="size-full"
      style={!visible && heightRef.current > 0 ? { minHeight: `${heightRef.current}px` } : undefined}
    >
      {visible ? (
        <video
          ref={videoRef}
          src={src}
          muted
          playsInline
          loop
          preload="metadata"
          className={className}
          onLoadedMetadata={() => {
            if (wrapRef.current && wrapRef.current.offsetHeight > 0) {
              heightRef.current = wrapRef.current.offsetHeight;
            }
          }}
          onMouseEnter={(e) => {
            if (canHover()) void e.currentTarget.play().catch(() => undefined);
          }}
          onMouseLeave={(e) => {
            if (!canHover()) return;
            e.currentTarget.pause();
            try {
              e.currentTarget.currentTime = 0.1;
            } catch {
              /* ignore */
            }
          }}
        />
      ) : (
        <div className={placeholderClassName ?? className} />
      )}
    </div>
  );
}
