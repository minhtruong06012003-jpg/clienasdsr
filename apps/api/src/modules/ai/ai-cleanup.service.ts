import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AI_TASK_RETENTION_MIN_DAYS } from '../settings/settings.defaults.js';
import { STORAGE, type StorageDriver } from '../media/storage.service.js';
import { AiFilesService } from './ai-files.service.js';

/** Cấu hình dọn tác vụ trong nhóm `ai` */
interface AiCleanupSettings {
  /** Tự xoá tác vụ đã kết thúc cũ hơn N ngày (0 = tắt) */
  taskRetentionDays?: number;
  /** Giữ lại tác vụ đang công khai trên trang Cộng đồng */
  taskRetentionKeepPublic?: boolean;
}

/** Số tác vụ xoá mỗi lô (giữ vừa phải để transaction luôn nhanh, không chạm timeout) */
const BATCH = 100;
/** Trần số lô mỗi lượt (100 × 200 = 20.000 tác vụ) */
const MAX_BATCHES = 200;
/** Trần số file hết hạn quét xoá mỗi lượt */
const MAX_SWEEP_FILES = 6000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** File đầu vào tham chiếu (`ai/inputs`) giữ đủ 24 giờ khớp vòng đời lịch sử tác vụ để khách bấm "Dùng lại" hoặc tạo nhiều cảnh liên tiếp không bị lỗi thiếu ảnh gốc (T-503) */
const INPUT_CACHE_MS = 24 * HOUR_MS;
/** Bản sao ổ đĩa local (`ai/outputs`) có sẵn `sourceUrl` dự phòng -> giữ SSD 6 giờ để tránh đầy đĩa 97GB, từ 6h–24h tự stream qua proxy ký */
const OUTPUT_LOCAL_CACHE_MS = 6 * HOUR_MS;

/** Lấy mọi chuỗi trong một giá trị JSON (input / output của tác vụ) để tìm URL file */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function isStandbyInstance(): boolean {
  return process.env.PORT === '4318' || process.env.NOVAI_STANDBY === '1';
}

/**
 * Tự dọn tác vụ AI cũ & tối ưu dung lượng ổ đĩa / hiệu năng PostgreSQL (T-396):
 * - Không dùng truy vấn O(N×M) `strpos(t.input::text, ...)` gây nghẽn CPU Postgres mỗi 15 phút;
 *   thay bằng dựng `Set<string>` đường dẫn đang cần giữ ngay trong RAM (< 20ms).
 * - Tác vụ hoàn thành vẫn lưu lịch sử đủ `taskRetentionDays` (24h).
 * - File tham chiếu `ai/inputs` quá 2h (không còn đơn PENDING/PROCESSING) được giải phóng sớm.
 * - File kết quả local `ai/outputs` quá 6h (đã có `sourceUrl` để proxy ký phục vụ tiếp tới 24h, không thuộc Cộng đồng `isPublic`) được giải phóng sớm để ổ đĩa VPS luôn thông thoáng.
 */
@Injectable()
export class AiCleanupService implements OnModuleInit {
  private readonly logger = new Logger('AiCleanup');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly files: AiFilesService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  onModuleInit() {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_SCHEDULER === '1' ||
      process.env.DISABLE_SCHEDULER === 'true' ||
      isStandbyInstance()
    ) {
      return;
    }
    const t = setTimeout(() => {
      void this.run().catch((err: Error) => this.logger.error(`Dọn tác vụ AI lúc khởi động lỗi: ${err.message}`));
    }, 60_000);
    t.unref?.();
  }

  @Cron('*/15 * * * *')
  async nightly() {
    if (process.env.NODE_ENV === 'test' || isStandbyInstance()) return;
    await this.run().catch((err: Error) => this.logger.error(`Dọn tác vụ AI lỗi: ${err.message}`));
  }

  /** Dựng tập đường dẫn storage cần bảo vệ trong RAM (O(N) siêu nhẹ, không quét chuỗi trên Postgres) */
  private async buildProtectedPaths(nowMs: number, excludeIds?: Set<string>): Promise<Set<string>> {
    const keep = new Set<string>();
    const rows = await this.prisma.aiTask.findMany({
      select: { id: true, status: true, isPublic: true, createdAt: true, input: true, output: true },
    });
    const outputCacheCutoff = nowMs - OUTPUT_LOCAL_CACHE_MS;

    for (const r of rows) {
      if (excludeIds?.has(r.id)) continue;
      const isRunning = r.status === 'PENDING' || r.status === 'PROCESSING';
      const isCommunityPublic = r.isPublic && r.status === 'SUCCEEDED';
      const createdMs = r.createdAt.getTime();

      // Giữ toàn bộ file đầu vào tham chiếu của mọi đơn còn trong lịch sử (24h) để khách bấm "Dùng lại" bất cứ lúc nào không bị mất ảnh mẫu (T-503)
      for (const s of collectStrings(r.input)) {
        const p = this.files.pathOf(s);
        if (p) keep.add(p);
      }

      // Output giữ vĩnh viễn nếu đang trên Cộng đồng, đang chạy, mới tạo < 6h, hoặc không có sourceUrl dự phòng
      if (isRunning || isCommunityPublic || createdMs >= outputCacheCutoff) {
        for (const s of collectStrings(r.output)) {
          const p = this.files.pathOf(s);
          if (p) keep.add(p);
        }
      } else if (r.status === 'SUCCEEDED') {
        const outFiles = (r.output as { files?: { url?: unknown; sourceUrl?: unknown }[] } | null)?.files;
        if (Array.isArray(outFiles)) {
          for (const f of outFiles) {
            const url = typeof f?.url === 'string' ? f.url : '';
            const hasBackup = typeof f?.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl);
            if (!hasBackup && url) {
              const p = this.files.pathOf(url);
              if (p) keep.add(p);
            }
          }
        }
      }
    }
    return keep;
  }

  /** Một lượt dọn; trả số tác vụ và số file đã xoá */
  async run(now = new Date()): Promise<{ tasks: number; files: number; orphans: number }> {
    if (this.running) return { tasks: 0, files: 0, orphans: 0 };
    this.running = true;
    try {
      const s = await this.settings.get<AiCleanupSettings>('ai');
      const rawDays = s.taskRetentionDays === undefined ? 1 : Number(s.taskRetentionDays);
      const days = Math.floor(Number.isFinite(rawDays) ? rawDays : 1);
      if (days <= 0) return { tasks: 0, files: 0, orphans: 0 };
      const cutoff = new Date(now.getTime() - Math.max(AI_TASK_RETENTION_MIN_DAYS, days) * DAY_MS);
      let tasks = 0;
      let files = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const r = await this.deleteBatch(cutoff, s.taskRetentionKeepPublic !== false, now.getTime());
        tasks += r.tasks;
        files += r.files;
        if (r.tasks < BATCH) break;
      }
      const orphans = await this.sweepExpiredFiles(now.getTime());
      // Dọn nhẹ token phiên đăng nhập đã hết hạn > 24h để bảng refresh_tokens luôn gọn
      await this.prisma.refreshToken
        .deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY_MS) } } })
        .catch(() => undefined);

      if (tasks || orphans) {
        this.logger.log(`Đã dọn chu kỳ ${days * 24}h: xoá ${tasks} tác vụ AI, ${files} file tác vụ và ${orphans} file bộ nhớ đệm quá hạn`);
      }
      return { tasks, files, orphans };
    } finally {
      this.running = false;
    }
  }

  private async deleteBatch(cutoff: Date, keepPublic: boolean, nowMs: number) {
    const rows = await this.prisma.aiTask.findMany({
      where: {
        status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] },
        createdAt: { lt: cutoff },
        ...(keepPublic ? { OR: [{ isPublic: false }, { status: { not: 'SUCCEEDED' } }] } : {}),
      },
      select: { id: true, userId: true, input: true, output: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    return this.purge(rows, nowMs);
  }

  /** Khách tự xoá nhiều tác phẩm của mình (trang Lịch sử tạo, tích chọn nhiều thẻ) */
  async deleteForUser(userId: string, ids: string[]): Promise<{ deleted: number; skipped: number; files: number }> {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.aiTask.findMany({
      where: { id: { in: unique }, userId, status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
      select: { id: true, userId: true, input: true, output: true },
    });
    const r = await this.purge(rows, Date.now());
    return { deleted: r.tasks, skipped: unique.length - r.tasks, files: r.files };
  }

  /** Xoá các tác vụ đã chọn kèm file đầu vào / kết quả trên storage không còn tác vụ khác dùng */
  private async purge(rows: { id: string; userId: string; input: unknown; output: unknown }[], nowMs: number) {
    if (!rows.length) return { tasks: 0, files: 0 };
    const ids = rows.map((t) => t.id);
    const excludeSet = new Set(ids);

    const paths = new Set<string>();
    for (const t of rows) {
      for (const str of collectStrings([t.input, t.output])) {
        const p = this.files.pathOf(str);
        if (p && !p.includes('..') && (p.startsWith(`ai/inputs/${t.userId}/`) || p.startsWith(`ai/outputs/${t.userId}/`))) paths.add(p);
      }
    }

    let candidates = [...paths];
    if (candidates.length) {
      const keep = await this.buildProtectedPaths(nowMs, excludeSet);
      candidates = candidates.filter((p) => !keep.has(p));
    }

    const count = await this.prisma.$transaction(
      async (tx) => {
        const deletedByTool = await tx.$queryRaw<{ toolKey: string; cnt: number }[]>`
          WITH deleted AS (
            DELETE FROM ai_tasks WHERE id = ANY(${ids}::uuid[]) RETURNING "toolKey"
          )
          SELECT "toolKey", COUNT(*)::int AS cnt FROM deleted GROUP BY "toolKey"
        `;
        for (const { toolKey, cnt } of deletedByTool) {
          await tx.$executeRaw`
            UPDATE ai_tools
            SET options = jsonb_set(
              COALESCE(options::jsonb, '{}'::jsonb),
              '{archivedRuns}',
              to_jsonb(COALESCE((options::jsonb->>'archivedRuns')::int, 0) + ${cnt}::int)
            )
            WHERE key = ${toolKey}
          `;
        }
        return deletedByTool.reduce((sum, r) => sum + r.cnt, 0);
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    let files = 0;
    for (const p of candidates) {
      await this.storage
        .delete(p)
        .then(() => files++)
        .catch(() => undefined);
    }
    return { tasks: count, files };
  }

  /**
   * Giải phóng file đệm `ai/inputs` (> 2h) và `ai/outputs` (> 6h đã có `sourceUrl`) không nằm trong tập bảo vệ `buildProtectedPaths`.
   * Tuyệt đối KHÔNG đụng `ai/demos`, `ai/voice-samples`, `ai/voice-vault`, `tickets/` hay thư viện media chung.
   */
  private async sweepExpiredFiles(nowMs: number): Promise<number> {
    if (!this.storage.localPath) return 0;
    const uploadRoot = this.storage.localPath('');
    const inputCutoffMs = nowMs - INPUT_CACHE_MS;
    const outputCutoffMs = nowMs - OUTPUT_LOCAL_CACHE_MS;
    const expired: { abs: string; rel: string }[] = [];

    const walk = async (dir: string, cutoffMs: number): Promise<void> => {
      if (expired.length >= MAX_SWEEP_FILES) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (expired.length >= MAX_SWEEP_FILES) break;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, cutoffMs);
          const rest = await readdir(full).catch(() => ['_']);
          if (rest.length === 0) await rmdir(full).catch(() => undefined);
        } else if (e.isFile()) {
          const st = await stat(full).catch(() => null);
          if (st && st.mtimeMs < cutoffMs) {
            const rel = relative(uploadRoot, full).replace(/\\/g, '/');
            if ((rel.startsWith('ai/inputs/') || rel.startsWith('ai/outputs/')) && !rel.includes('..')) {
              expired.push({ abs: full, rel });
            }
          }
        }
      }
    };

    await walk(this.storage.localPath('ai/inputs'), inputCutoffMs);
    await walk(this.storage.localPath('ai/outputs'), outputCutoffMs);
    if (!expired.length) return 0;

    const keep = await this.buildProtectedPaths(nowMs);
    let deleted = 0;
    for (const item of expired) {
      if (keep.has(item.rel)) continue;
      await unlink(item.abs)
        .then(() => deleted++)
        .catch(() => undefined);
    }
    return deleted;
  }
}
