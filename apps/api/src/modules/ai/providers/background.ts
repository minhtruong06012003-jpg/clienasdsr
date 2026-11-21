import type { AiProviderResult } from '../ai.types.js';

/**
 * Chạy nền cho nhà cung cấp có API ĐỒNG BỘ (request giữ kết nối tới khi xong, có thể vài phút — vd IMG Studio, VidGrab).
 * `submit()` không chờ: đăng ký việc vào bộ nhớ, trả `processing` ngay để request của khách không bị treo;
 * cron hỏi trạng thái gọi `poll()` -> `backgroundState()` đọc kết quả khi việc chạy xong.
 *
 * API chạy 1 instance (ecosystem.config.cjs: instances 1) nên giữ trong bộ nhớ là đủ.
 * Nếu API khởi động lại giữa chừng thì việc bị mất -> poll trả `failed` (tác vụ được hoàn credits).
 */

interface Job {
  /** Kết quả khi đã xong (undefined = đang chạy) */
  result?: AiProviderResult;
  /** Tiến độ ước tính / do nhà cung cấp báo (0–99) */
  progress: number;
  startedAt: number;
  /** Thời gian chạy ước tính (ms) để hiện thanh tiến độ khi nhà cung cấp không báo tiến độ */
  estimateMs: number;
}

const JOBS = new Map<string, Job>();
/** Kết quả chưa ai đọc quá lâu thì bỏ (tác vụ đã bị huỷ vì quá hạn) */
const KEEP_MS = 3 * 60 * 60_000;

/** Bắt đầu một việc nền với mã `id`; lỗi ném ra được chuyển thành `failed` */
export function startBackground(id: string, run: (setProgress: (p: number) => void) => Promise<AiProviderResult>, estimateMs = 60_000) {
  const job: Job = { progress: 0, startedAt: Date.now(), estimateMs };
  JOBS.set(id, job);
  run((p) => (job.progress = Math.max(job.progress, Math.min(99, Math.round(p)))))
    .then((r) => (job.result = r))
    .catch((err) => (job.result = { status: 'failed', providerTaskId: id, error: (err as Error).message || 'Nhà cung cấp AI báo lỗi', raw: (err as { raw?: unknown }).raw }));
  // dọn việc cũ để Map không phình mãi
  for (const [k, j] of JOBS) if (Date.now() - j.startedAt > KEEP_MS) JOBS.delete(k);
}

/** Trạng thái việc nền cho `poll()` */
export function backgroundState(id: string): AiProviderResult {
  const job = JOBS.get(id);
  if (!job) return { status: 'failed', providerTaskId: id, error: 'Tác vụ bị gián đoạn do máy chủ khởi động lại, tiền đã được hoàn lại' };
  if (job.result) {
    JOBS.delete(id);
    return job.result;
  }
  // tiến độ ước tính tăng chậm dần, không vượt 95% khi chưa xong
  const guess = 95 * (1 - Math.exp(-(Date.now() - job.startedAt) / job.estimateMs));
  return { status: 'processing', providerTaskId: id, progress: Math.max(job.progress, Math.round(guess)) };
}

/** Lấy file đầu vào khách đã tải lên (URL nội bộ), hoặc tải từ link ngoài */
export async function loadInputFile(readUpload: (url: string) => Promise<{ data: Buffer; mimeType: string; filename: string } | null>, url: string) {
  const own = await readUpload(url);
  if (own) return own;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Không tải được file đầu vào (HTTP ${res.status})`);
  const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return { data: Buffer.from(await res.arrayBuffer()), mimeType, filename: url.split('?')[0].split('/').pop() || 'file' };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
