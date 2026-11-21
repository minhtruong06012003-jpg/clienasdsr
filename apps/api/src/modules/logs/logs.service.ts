import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createReadStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SettingsService } from '../settings/settings.service.js';
import { CronService } from '../scheduler/cron.service.js';
import { LOG_DIR, LOG_FILE_RE, LOG_LEVELS, logWriter, type LogConfig, type LogEntry, type LogLevel } from './log-writer.js';
import type { ClientErrorDto, LogEntriesQuery } from './logs.dto.js';

export interface LoggingSettings extends Partial<LogConfig> {
  retentionDays?: number;
}

export type LevelCounts = Record<LogLevel, number>;

export interface LogFileInfo {
  name: string;
  date: string;
  size: number;
  mtime: string;
  counts: LevelCounts;
}

const emptyCounts = (): LevelCounts => ({ debug: 0, info: 0, warn: 0, error: 0, fatal: 0 });
/** level luôn nằm ở đầu dòng (id, time, level) -> chỉ cần dò 120 ký tự đầu, không phải parse JSON */
const LEVEL_RE = /"level":"(debug|info|warn|error|fatal)"/;
const clip = (s: string | undefined, max: number) => (s ? s.slice(0, max) : undefined);

/** Đọc / lọc / dọn file nhật ký lỗi + đồng bộ cấu hình ghi log từ cài đặt */
@Injectable()
export class LogsService implements OnModuleInit {
  /** cache số đếm theo level của từng file, khoá = tên + kích thước + mtime */
  private countCache = new Map<string, { key: string; counts: LevelCounts }>();

  constructor(
    private readonly settings: SettingsService,
    private readonly cron: CronService,
  ) {}

  async onModuleInit() {
    await this.applySettings();
    // 03:15 mỗi ngày xoá file log quá hạn lưu
    this.cron.add('cleanup', '15 3 * * *', () => this.cleanup(), 'logs');
    // đếm lỗi chưa xem từ các file gần đây (badge menu) — chạy nền, không chặn khởi động
    void this.recountUnseen();
  }

  /** Cài đặt đổi -> áp lại cấu hình cho bộ ghi */
  @OnEvent('content.changed')
  async onSettingsChanged(payload: { type?: string }) {
    if (payload?.type === 'settings') await this.applySettings();
  }

  /** Tác vụ nền thất bại hẳn (hết lượt thử lại) -> ghi mức error */
  @OnEvent('job.failed')
  onJobFailed(job: { id?: string; type?: string; attempts?: number; lastError?: string; payload?: unknown }) {
    logWriter.write({
      level: 'error',
      source: 'job',
      context: job.type,
      message: `Tác vụ nền "${job.type}" thất bại sau ${job.attempts ?? '?'} lần thử: ${job.lastError ?? ''}`,
      meta: { jobId: job.id, payload: job.payload },
    });
  }

  private async applySettings() {
    try {
      logWriter.configure(await this.settings.get<LoggingSettings>('logging'));
    } catch {
      /* DB chưa sẵn sàng -> giữ cấu hình mặc định */
    }
  }

  /** Danh sách file log, mới nhất trước */
  async files(): Promise<{ data: LogFileInfo[]; dir: string; totalSize: number }> {
    const names = await this.fileNames();
    const data: LogFileInfo[] = [];
    for (const name of names) {
      const st = await stat(join(LOG_DIR, name)).catch(() => null);
      if (!st) continue;
      data.push({ name, date: LOG_FILE_RE.exec(name)![1], size: st.size, mtime: st.mtime.toISOString(), counts: await this.counts(name, st.size, st.mtimeMs) });
    }
    return { data, dir: LOG_DIR, totalSize: data.reduce((s, f) => s + f.size, 0) };
  }

  private async fileNames(): Promise<string[]> {
    const all = await readdir(LOG_DIR).catch(() => [] as string[]);
    return all.filter((n) => LOG_FILE_RE.test(n)).sort().reverse();
  }

  private async counts(name: string, size: number, mtimeMs: number): Promise<LevelCounts> {
    const key = `${size}:${mtimeMs}`;
    const hit = this.countCache.get(name);
    if (hit?.key === key) return hit.counts;
    const counts = emptyCounts();
    await this.eachLine(name, (line) => {
      const m = LEVEL_RE.exec(line.slice(0, 120));
      if (m) counts[m[1] as LogLevel]++;
    });
    this.countCache.set(name, { key, counts });
    return counts;
  }

  /** Đọc từng dòng của file (stream, không nạp cả file vào bộ nhớ) */
  private async eachLine(name: string, fn: (line: string) => void) {
    const input = createReadStream(join(LOG_DIR, name), { encoding: 'utf8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) if (line) fn(line);
    } finally {
      rl.close();
      input.destroy();
    }
  }

  /** Kiểm tra tên file hợp lệ (chặn ../ và file lạ ngoài thư mục log) */
  assertName(name: string) {
    if (!LOG_FILE_RE.test(name)) throw new BadRequestException('Tên file log không hợp lệ');
    return join(LOG_DIR, name);
  }

  /**
   * Lọc entry của 1 file, mới nhất trước. Chỉ giữ trong bộ nhớ `page * limit` dòng khớp
   * cuối cùng (vì trang 1 = các dòng mới nhất ở cuối file) nên file lớn vẫn nhẹ.
   */
  async entries(q: LogEntriesQuery) {
    const names = await this.fileNames();
    const name = q.file || names[0];
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(Math.max(1, q.limit ?? 50), 200);
    const empty = { data: [] as LogEntry[], meta: { page, limit, total: 0, totalPages: 0 }, counts: emptyCounts(), sources: [] as string[], file: name ?? null };
    if (!name) return empty;
    this.assertName(name);
    if (!names.includes(name)) throw new NotFoundException('Không tìm thấy file log');

    const levels = new Set((q.level ?? '').split(',').filter((l): l is LogLevel => (LOG_LEVELS as readonly string[]).includes(l)));
    const search = q.search?.trim().toLowerCase();
    const counts = emptyCounts();
    const sources = new Set<string>();
    const cap = page * limit;
    let tail: LogEntry[] = [];
    let total = 0;
    let lineNo = 0;

    await this.eachLine(name, (line) => {
      lineNo++;
      let e: LogEntry;
      try {
        e = JSON.parse(line) as LogEntry;
      } catch {
        // dòng không phải JSON (ghi tay, bị cắt dở) -> vẫn hiện để không mất thông tin
        e = { id: `raw-${lineNo}`, time: '', level: 'info', source: 'raw', message: line.slice(0, 8000) };
      }
      if (e.source) sources.add(e.source);
      if (q.source && e.source !== q.source) return;
      if (search && !matches(e, search)) return;
      if (e.level in counts) counts[e.level]++;
      if (levels.size && !levels.has(e.level)) return;
      total++;
      tail.push(e);
      if (tail.length > cap * 2) tail = tail.slice(-cap);
    });
    tail = tail.slice(-cap);
    // vị trí (trong danh sách khớp, cũ -> mới) của trang yêu cầu
    const offset = total - tail.length;
    const start = Math.max(0, total - page * limit) - offset;
    const end = total - (page - 1) * limit - offset;
    const data = end > 0 ? tail.slice(Math.max(0, start), end).reverse() : [];
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) }, counts, sources: [...sources].sort(), file: name };
  }

  async remove(name: string) {
    const path = this.assertName(name);
    // đang ghi vào chính file này -> đóng trước để lần ghi sau tạo file mới
    logWriter.closeStream();
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    this.countCache.delete(name);
    return { deleted: name };
  }

  async clear() {
    const names = await this.fileNames();
    for (const n of names) await this.remove(n);
    logWriter.markSeen();
    return { deleted: names.length };
  }

  markSeen() {
    logWriter.markSeen();
    return { ok: true };
  }

  /** Xoá file cũ hơn `retentionDays` ngày (0 = giữ vĩnh viễn) */
  async cleanup() {
    const cfg = await this.settings.get<LoggingSettings>('logging');
    const days = Math.floor(Number(cfg.retentionDays) || 0);
    if (days <= 0) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    let removed = 0;
    for (const n of await this.fileNames()) {
      if (LOG_FILE_RE.exec(n)![1] < cutoffDay) {
        await this.remove(n);
        removed++;
      }
    }
    return removed;
  }

  /** Đếm error/fatal sau lần xem gần nhất trong 3 file mới nhất */
  private async recountUnseen() {
    try {
      const seenAt = logWriter.lastSeenAt;
      let n = 0;
      for (const name of (await this.fileNames()).slice(0, 3)) {
        const st = await stat(join(LOG_DIR, name));
        if (st.mtimeMs <= seenAt) continue;
        await this.eachLine(name, (line) => {
          const m = LEVEL_RE.exec(line.slice(0, 120));
          if (!m || (m[1] !== 'error' && m[1] !== 'fatal')) return;
          const t = /"time":"([^"]+)"/.exec(line.slice(0, 120));
          if (t && Date.parse(t[1]) > seenAt) n++;
        });
      }
      // cộng dồn với lỗi đã phát sinh trong lúc đang đếm thì không chính xác tuyệt đối — chấp nhận được cho badge
      logWriter.setUnseen(Math.max(n, logWriter.unseenCount()));
    } catch {
      /* bỏ qua */
    }
  }

  /**
   * Nhận lỗi JavaScript từ trình duyệt / máy chủ storefront. Dữ liệu do client gửi nên cắt
   * ngắn mọi trường; tắt hẳn bằng cài đặt "Nhận lỗi JavaScript từ trình duyệt".
   */
  captureClient(dto: ClientErrorDto, source: string, req: { ip?: string; userAgent?: string; userId?: string; userEmail?: string }) {
    if (!logWriter.settings.captureClient) return { accepted: false };
    logWriter.write({
      level: dto.level === 'warn' ? 'warn' : 'error',
      source,
      context: clip(dto.name, 100) || (source === 'web-server' ? 'NextServer' : 'Browser'),
      message: clip(dto.message, 2000) || '(không có nội dung)',
      stack: clip(dto.stack, 8000),
      request: {
        method: clip(dto.method, 10),
        url: clip(dto.url, 1000),
        ip: req.ip,
        userId: req.userId,
        userEmail: req.userEmail,
        userAgent: clip(dto.userAgent || req.userAgent, 300),
      },
      meta: {
        ...(dto.digest ? { digest: clip(dto.digest, 100) } : {}),
        ...(dto.componentStack ? { componentStack: clip(dto.componentStack, 4000) } : {}),
        ...(dto.routePath ? { routePath: clip(dto.routePath, 300) } : {}),
        ...(dto.routeType ? { routeType: clip(dto.routeType, 50) } : {}),
      },
    });
    return { accepted: true };
  }
}

function matches(e: LogEntry, search: string) {
  return [e.message, e.context, e.stack, e.request?.url, e.request?.userEmail, e.source].some((v) => v && v.toLowerCase().includes(search));
}
