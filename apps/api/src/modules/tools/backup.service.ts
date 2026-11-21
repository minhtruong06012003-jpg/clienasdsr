import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import AdmZip from 'adm-zip';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService } from '../media/storage.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { JobsService } from '../scheduler/jobs.service.js';
import { CronService } from '../scheduler/cron.service.js';
import { ALL_CACHE_TAGS } from '../events/revalidate.listener.js';

export interface BackupFile {
  name: string;
  size: number;
  createdAt: Date;
  type: 'db' | 'uploads';
}

export interface BackupSettings {
  schedule: 'none' | 'daily' | 'weekly';
  hour: number;
  keep: number;
  includeUploads: boolean;
}

export interface PgConn {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

const DB_RE = /^cmsnt-\d{8}-\d{6}(-[a-z0-9-]+)?\.sql\.gz$/;
const UPLOADS_RE = /^uploads-\d{8}-\d{6}\.(tar\.gz|zip)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STDERR_CAP = 4000;
export const BACKUP_JOB = 'backup.create';

/** Nhãn thời gian cho tên file: YYYYMMDD-HHmmss (giờ máy chủ) */
export function backupStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Lấy thông tin kết nối từ DATABASE_URL (postgresql://user:pass@host:port/db?schema=public) */
export function parseDatabaseUrl(url: string | undefined): PgConn {
  if (!url) throw new Error('Thiếu DATABASE_URL');
  const u = new URL(url);
  return { host: u.hostname || 'localhost', port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
}

function collectStderr(child: ChildProcess) {
  let out = '';
  child.stderr?.on('data', (c: Buffer) => {
    if (out.length < STDERR_CAP) out += c.toString();
  });
  return () => out.trim();
}

const notFoundHint = (bin: string, envName: string) =>
  `Không tìm thấy lệnh "${bin}" trên máy chủ API. Cài postgresql-client (Docker: apk add postgresql18-client) hoặc đặt biến môi trường ${envName} (vd: docker exec novai-postgres ${bin} -U cmsnt -d novai ...).`;

/** Chờ tiến trình kết thúc; không bao giờ reject (lỗi spawn trả về trong `err`) để tránh unhandled rejection */
function waitExit(child: ChildProcess) {
  return new Promise<{ code: number; err?: NodeJS.ErrnoException }>((res) => {
    child.once('error', (err: NodeJS.ErrnoException) => res({ code: -1, err }));
    child.once('close', (code) => res({ code: code ?? 0 }));
  });
}

function spawnError(err: NodeJS.ErrnoException, bin: string, envName: string) {
  return new BadRequestException(err.code === 'ENOENT' ? notFoundHint(bin, envName) : err.message);
}

function spawnShellOrBin(cmd: string | undefined, bin: string, args: string[], env: NodeJS.ProcessEnv) {
  return cmd ? spawn('sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * pg_dump -> gzip -> file. Dùng BACKUP_CMD nếu có (lệnh in SQL ra stdout), không thì gọi pg_dump theo DATABASE_URL.
 * Dump kèm --clean --if-exists để khi khôi phục ghi đè được bảng đang có.
 */
export async function dumpToFile(dest: string, opts: { cmd?: string; conn?: PgConn }) {
  const conn = opts.cmd ? undefined : opts.conn;
  const env = { ...process.env, ...(conn ? { PGPASSWORD: conn.password } : {}) };
  const args = conn ? ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '--no-owner', '--no-privileges', '--clean', '--if-exists'] : [];
  const child = spawnShellOrBin(opts.cmd, 'pg_dump', args, env);
  const stderr = collectStderr(child);
  const exit = waitExit(child);
  const tmp = `${dest}.part`;
  try {
    // lỗi spawn (ENOENT) làm stdout đóng sớm -> ưu tiên báo lỗi tiến trình thay vì lỗi stream
    await pipeline(child.stdout!, createGzip({ level: 6 }), createWriteStream(tmp)).catch(async (pipeErr: Error) => {
      const r = await exit;
      throw r.err ? spawnError(r.err, 'pg_dump', 'BACKUP_CMD') : pipeErr;
    });
    const r = await exit;
    if (r.err) throw spawnError(r.err, 'pg_dump', 'BACKUP_CMD');
    if (r.code !== 0) throw new BadRequestException(`pg_dump thoát mã ${r.code}: ${stderr() || 'không có thông báo lỗi'}`);
    const size = (await stat(tmp)).size;
    if (size < 64) throw new BadRequestException(`File sao lưu rỗng — kiểm tra lại lệnh/kết nối. ${stderr()}`);
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** gunzip -> psql (hoặc BACKUP_RESTORE_CMD đọc SQL từ stdin). Dừng ngay khi gặp lỗi SQL. */
export async function restoreFromFile(src: string, opts: { cmd?: string; conn?: PgConn }) {
  const conn = opts.cmd ? undefined : opts.conn;
  const env = { ...process.env, ...(conn ? { PGPASSWORD: conn.password } : {}) };
  const args = conn ? ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '-X', '-q', '-v', 'ON_ERROR_STOP=1'] : [];
  const child = spawnShellOrBin(opts.cmd, 'psql', args, env);
  const stderr = collectStderr(child);
  child.stdout?.resume();
  const exit = waitExit(child);
  await pipeline(createReadStream(src), createGunzip(), child.stdin!).catch(async (err: Error) => {
    // psql thoát sớm (lỗi SQL / không có lệnh) -> EPIPE; mã thoát bên dưới sẽ báo lỗi cụ thể
    const r = await exit;
    if (r.err) throw spawnError(r.err, 'psql', 'BACKUP_RESTORE_CMD');
    if (!/EPIPE|closed|destroyed/i.test(err.message)) throw err;
  });
  const r = await exit;
  if (r.err) throw spawnError(r.err, 'psql', 'BACKUP_RESTORE_CMD');
  if (r.code !== 0) throw new BadRequestException(`psql thoát mã ${r.code}: ${stderr() || 'không có thông báo lỗi'}`);
}

/**
 * Sao lưu / khôi phục database + thư mục uploads từ trang quản trị.
 * - Thư mục: BACKUP_DIR (mặc định "backups" cạnh thư mục uploads; Docker: volume /app/backups)
 * - Tạo bản sao lưu chạy nền qua job "backup.create"; lịch tự động kiểm tra mỗi giờ theo cài đặt nhóm "backup".
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger('Backup');
  readonly dir: string;
  private readonly dumpCmd = process.env.BACKUP_CMD?.trim() || undefined;
  private readonly restoreCmd = process.env.BACKUP_RESTORE_CMD?.trim() || undefined;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly local: LocalStorageService,
    private readonly settings: SettingsService,
    private readonly languages: LanguagesService,
    private readonly jobs: JobsService,
    private readonly cron: CronService,
    private readonly events: EventEmitter2,
  ) {
    const d = process.env.BACKUP_DIR?.trim();
    this.dir = d ? resolve(process.cwd(), d) : resolve(dirname(this.local.root), 'backups');
  }

  onModuleInit() {
    this.jobs.register<{ includeUploads?: boolean; actorId?: string | null; scheduled?: boolean }>(BACKUP_JOB, (p) => this.create(p));
    // mỗi giờ kiểm tra lịch (đổi cài đặt có hiệu lực ngay, không cần đăng ký lại cron)
    this.cron.add('scheduled', '0 * * * *', () => this.runScheduled(), 'backup');
  }

  private conn(): PgConn {
    return parseDatabaseUrl(this.config.get<string>('databaseUrl'));
  }

  private async ensureDir() {
    await mkdir(this.dir, { recursive: true });
  }

  private safePath(name: string) {
    if (!NAME_RE.test(name) || name.includes('..') || !(DB_RE.test(name) || UPLOADS_RE.test(name))) throw new BadRequestException('Tên file sao lưu không hợp lệ');
    const full = resolve(join(this.dir, name));
    if (!full.startsWith(this.dir + '/')) throw new BadRequestException('Đường dẫn không hợp lệ');
    return full;
  }

  /** Kiểm tra pg_dump sẵn sàng (hoặc BACKUP_CMD đã đặt) — dùng cho Site Health */
  async pgDumpStatus(): Promise<{ ok: boolean; via: 'cmd' | 'pg_dump'; version?: string; error?: string }> {
    if (this.dumpCmd) return { ok: true, via: 'cmd' };
    return new Promise((res) => {
      execFile('pg_dump', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) res({ ok: false, via: 'pg_dump', error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Không có pg_dump trong PATH' : err.message });
        else res({ ok: true, via: 'pg_dump', version: stdout.trim() });
      });
    });
  }

  async writable() {
    await this.ensureDir();
    return access(this.dir, constants.W_OK).then(() => true, () => false);
  }

  async getSettings(): Promise<BackupSettings> {
    const s = await this.settings.get<Partial<BackupSettings>>('backup');
    return { schedule: s.schedule ?? 'none', hour: Number(s.hour ?? 3), keep: Math.max(1, Number(s.keep ?? 7)), includeUploads: !!s.includeUploads };
  }

  async list(): Promise<BackupFile[]> {
    await this.ensureDir();
    const names = await readdir(this.dir);
    const out: BackupFile[] = [];
    for (const name of names) {
      const type = DB_RE.test(name) ? 'db' : UPLOADS_RE.test(name) ? 'uploads' : null;
      if (!type) continue;
      const st = await stat(join(this.dir, name)).catch(() => null);
      if (st?.isFile()) out.push({ name, size: st.size, createdAt: st.mtime, type });
    }
    return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async createDb(suffix?: string): Promise<BackupFile> {
    await this.ensureDir();
    const name = `cmsnt-${backupStamp()}${suffix ? `-${suffix}` : ''}.sql.gz`;
    const dest = join(this.dir, name);
    const started = Date.now();
    await dumpToFile(dest, { cmd: this.dumpCmd, conn: this.dumpCmd ? undefined : this.conn() });
    const st = await stat(dest);
    this.logger.log(`Đã sao lưu DB: ${name} (${(st.size / 1024).toFixed(0)} KB, ${Date.now() - started} ms)`);
    return { name, size: st.size, createdAt: st.mtime, type: 'db' };
  }

  /** Nén thư mục uploads: tar.gz nếu có tar, không thì zip (adm-zip) */
  async createUploads(): Promise<BackupFile> {
    await this.ensureDir();
    const root = this.local.root;
    await mkdir(root, { recursive: true });
    const stamp = backupStamp();
    let name = `uploads-${stamp}.tar.gz`;
    let dest = join(this.dir, name);
    const tar = spawn('tar', ['-czf', dest, '-C', root, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = collectStderr(tar);
    const r = await waitExit(tar);
    if (r.err && r.err.code !== 'ENOENT') throw new BadRequestException(r.err.message);
    const code = r.err ? -1 : r.code;
    if (code === -1) {
      name = `uploads-${stamp}.zip`;
      dest = join(this.dir, name);
      const zip = new AdmZip();
      zip.addLocalFolder(root);
      await zip.writeZipPromise(dest);
    } else if (code !== 0) {
      await unlink(dest).catch(() => undefined);
      throw new BadRequestException(`tar thoát mã ${code}: ${stderr()}`);
    }
    const st = await stat(dest);
    return { name, size: st.size, createdAt: st.mtime, type: 'uploads' };
  }

  /** Tạo bộ sao lưu (DB + tuỳ chọn uploads), dọn bản cũ theo cài đặt keep */
  async create(opts: { includeUploads?: boolean; actorId?: string | null; scheduled?: boolean } = {}) {
    if (this.running) throw new BadRequestException('Đang có tiến trình sao lưu/khôi phục khác, vui lòng đợi');
    this.running = true;
    try {
      const files: BackupFile[] = [await this.createDb()];
      if (opts.includeUploads) files.push(await this.createUploads());
      const { keep } = await this.getSettings();
      const pruned = await this.prune(keep);
      this.events.emit('activity', { userId: opts.actorId ?? null, action: 'backup.create', entityType: 'backup', meta: { files: files.map((f) => f.name), scheduled: !!opts.scheduled, pruned } });
      return { files, pruned };
    } finally {
      this.running = false;
    }
  }

  /** Đưa vào hàng đợi job, trả jobId để UI theo dõi */
  async enqueue(opts: { includeUploads?: boolean; actorId?: string | null; scheduled?: boolean }) {
    const job = await this.jobs.enqueue(BACKUP_JOB, opts, { maxAttempts: 1, dedupeKey: opts.scheduled ? `backup:scheduled:${new Date().toISOString().slice(0, 10)}` : undefined });
    return { jobId: job.id };
  }

  jobStatus(id: string) {
    return this.prisma.job.findUnique({ where: { id }, select: { id: true, type: true, status: true, attempts: true, lastError: true, createdAt: true, updatedAt: true } });
  }

  /** Giữ lại `keep` bản mới nhất mỗi loại, xoá phần còn lại */
  async prune(keep: number) {
    const files = await this.list();
    const removed: string[] = [];
    for (const type of ['db', 'uploads'] as const) {
      const old = files.filter((f) => f.type === type).slice(Math.max(1, keep));
      for (const f of old) {
        await unlink(join(this.dir, f.name)).catch(() => undefined);
        removed.push(f.name);
      }
    }
    if (removed.length) this.logger.log(`Đã xoá ${removed.length} bản sao lưu cũ`);
    return removed;
  }

  private async runScheduled() {
    const s = await this.getSettings();
    if (s.schedule === 'none') return;
    const now = new Date();
    if (now.getHours() !== s.hour) return;
    if (s.schedule === 'weekly' && now.getDay() !== 0) return;
    await this.enqueue({ includeUploads: s.includeUploads, scheduled: true });
  }

  async download(name: string) {
    const full = this.safePath(name);
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) throw new NotFoundException('Không tìm thấy file sao lưu');
    return { stream: createReadStream(full), size: st.size, name };
  }

  async remove(name: string, actorId?: string | null) {
    const full = this.safePath(name);
    await unlink(full).catch(() => {
      throw new NotFoundException('Không tìm thấy file sao lưu');
    });
    this.events.emit('activity', { userId: actorId ?? null, action: 'backup.delete', entityType: 'backup', meta: { name } });
    return { success: true };
  }

  /**
   * Khôi phục DB từ file .sql.gz. Luôn tạo bản sao lưu an toàn (hậu tố -pre-restore) trước.
   * Trong lúc chạy, các bảng bị drop/tạo lại -> request khác có thể lỗi tạm thời.
   */
  async restore(name: string, actorId?: string | null) {
    const full = this.safePath(name);
    if (!DB_RE.test(name)) throw new BadRequestException('Chỉ khôi phục được file sao lưu database (.sql.gz)');
    if (!(await stat(full).catch(() => null))?.isFile()) throw new NotFoundException('Không tìm thấy file sao lưu');
    if (this.running) throw new BadRequestException('Đang có tiến trình sao lưu/khôi phục khác, vui lòng đợi');
    this.running = true;
    const started = Date.now();
    try {
      const safety = await this.createDb('pre-restore');
      await restoreFromFile(full, { cmd: this.restoreCmd, conn: this.restoreCmd ? undefined : this.conn() });
      this.settings.clearCache();
      this.languages.clearCache();
      this.events.emit('content.changed', { type: 'restore', tags: ALL_CACHE_TAGS });
      this.events.emit('activity', { userId: actorId ?? null, action: 'backup.restore', entityType: 'backup', meta: { name, safetyBackup: safety.name, ms: Date.now() - started } });
      this.logger.warn(`Đã khôi phục DB từ ${name} (bản an toàn: ${safety.name})`);
      return { success: true, safetyBackup: safety.name, ms: Date.now() - started };
    } finally {
      this.running = false;
    }
  }
}
