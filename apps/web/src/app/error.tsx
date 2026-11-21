"use client";

/** Ranh giới lỗi chung: hiện thông báo thay vì trắng trang; tự làm mới 1 lần nếu tab Safari ngủ lâu bị lệch JS chunk sau khi cập nhật web (T-252) */
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

function isStaleChunkError(err: Error): boolean {
  const msg = `${err?.name ?? ""} ${err?.message ?? ""}`;
  return /ChunkLoadError|Loading chunk .* failed|Importing a module script failed|Failed to fetch dynamically imported module/i.test(msg);
}

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();

  useEffect(() => {
    if (!isStaleChunkError(error)) return;
    try {
      const key = `novai_chunk_reload:${window.location.pathname}`;
      const last = Number(window.sessionStorage.getItem(key) || "0");
      if (Date.now() - last > 15_000) {
        window.sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    } catch {
      /* bỏ qua nếu sessionStorage bị khoá */
    }
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">{t("Đã có lỗi xảy ra")}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{error.message || t("Vui lòng thử lại sau ít phút.")}</p>
      <div className="flex items-center gap-2">
        <Button onClick={reset}>{t("Thử lại")}</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("Tải lại trang")}
        </Button>
      </div>
    </div>
  );
}
