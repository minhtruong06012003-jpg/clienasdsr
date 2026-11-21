import { api } from "./api";
import type { AiTask } from "./types";

export interface DownloadFileItem {
  taskId: string;
  code: string;
  name: string;
  type: string;
  url: string;
}

export interface DownloadLinksResult {
  zipUrl: string;
  zipName: string;
  taskCount: number;
  fileCount: number;
  skippedCount: number;
  files: DownloadFileItem[];
}

/** Kiểm tra tác vụ đã hoàn thành và có ít nhất 1 file kết quả hợp lệ để tải về */
export function hasDownloadableFiles(task: AiTask | null | undefined): boolean {
  if (!task || task.status !== "SUCCEEDED") return false;
  const files = task.output?.files;
  return Array.isArray(files) && files.some((f) => typeof f?.url === "string" && /^(https?:\/\/|data:|\/[^/])/i.test(f.url));
}

/** Kích hoạt tải xuống một URL cùng domain (API gắn sẵn Content-Disposition: attachment; gắn dấu thời gian để tải lại nhiều lần không bị trình duyệt bỏ qua) */
export function triggerAttachmentDownload(url: string, fileName?: string) {
  const freshUrl =
    url.startsWith("/") && !url.startsWith("//")
      ? `${url}${url.includes("?") ? "&" : "?"}_dl=${Date.now()}`
      : url;
  const a = document.createElement("a");
  a.href = freshUrl;
  a.download = fileName ?? "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tải tất cả tác vụ hoàn thành đã chọn dưới dạng 1 file nén .ZIP (luồng trực tiếp từ máy chủ) */
export async function downloadTasksAsZip(
  ids: string[],
  opts?: { labels?: Record<string, string>; zipName?: string },
): Promise<DownloadLinksResult> {
  const res = await api.post<DownloadLinksResult>("/account/ai/tasks/download-links", {
    ids,
    labels: opts?.labels,
    zipName: opts?.zipName,
  });
  triggerAttachmentDownload(res.zipUrl, res.zipName);
  return res;
}

/**
 * Tải lần lượt từng file gốc (.mp4, .png, .mp3...) thẳng về thư mục Tải xuống của thiết bị
 * (tiện cho điện thoại / CapCut không cần giải nén). Giãn nhịp nhẹ để trình duyệt không chặn nhầm.
 */
export async function downloadTasksIndividually(
  ids: string[],
  opts?: {
    labels?: Record<string, string>;
    onProgress?: (current: number, total: number) => void;
  },
): Promise<DownloadLinksResult> {
  const res = await api.post<DownloadLinksResult>("/account/ai/tasks/download-links", {
    ids,
    labels: opts?.labels,
  });
  const total = res.files.length;
  for (let i = 0; i < total; i++) {
    opts?.onProgress?.(i + 1, total);
    triggerAttachmentDownload(res.files[i].url, res.files[i].name);
    if (i < total - 1) await sleep(500);
  }
  return res;
}
