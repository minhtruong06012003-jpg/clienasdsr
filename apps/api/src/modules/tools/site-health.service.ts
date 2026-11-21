import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { access, constants, mkdir, readdir, stat } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService, STORAGE, type StorageDriver } from '../media/storage.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { JobsService } from '../scheduler/jobs.service.js';
import { CronService } from '../scheduler/cron.service.js';
import { appVersion } from '../../config/app-version.js';
import { BackupService } from './backup.service.js';
import { decryptCode, deriveCodeKeys } from '../digital-codes/digital-codes.crypto.js';

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface HealthItem {
  key: string;
  /** Nhóm hiển thị: system | database | storage | security | services */
  group: string;
  label: string;
  status: HealthStatus;
  value: string;
  hint?: string;
}

const UPLOAD_SCAN_CAP = 100_000;
const WEAK_SECRETS = ['dev-secret', 'change-me-access-secret', 'change-me-revalidate-secret', 'chuoi-ngau-nhien-dai-it-nhat-32-ky-tu', 'chuoi-ngau-nhien-khac', ''];

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDuration = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${m} phút` : `${m} phút`;
};

/** Trang Site Health: kiểm tra cấu hình, dịch vụ, dung lượng... trả danh sách mục + điểm tổng */
@Injectable()
export class SiteHealthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly local: LocalStorageService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly cron: CronService,
    private readonly backup: BackupService,
  ) {}

  async report() {
    const items: HealthItem[] = [];
    const checks = [this.system(), this.database(), this.storageChecks(), this.security(), this.services()];
    for (const r of await Promise.allSettled(checks)) {
      if (r.status === 'fulfilled') items.push(...r.value);
      else items.push({ key: 'check-error', group: 'system', label: 'Kiểm tra lỗi', status: 'error', value: (r.reason as Error).message });
    }
    const counts = { ok: 0, warn: 0, error: 0 };
    for (const i of items) counts[i.status]++;
    const score = items.length ? Math.round(((counts.ok + counts.warn * 0.5) / items.length) * 100) : 100;
    return { score, counts, items, generatedAt: new Date().toISOString() };
  }

  private async system(): Promise<HealthItem[]> {
    const mem = process.memoryUsage();
    const load = loadavg()[0];
    const cores = cpus().length || 1;
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const env = this.config.get<string>('env');
    return [
      { key: 'cms', group: 'system', label: 'Phiên bản CMS', status: 'ok', value: appVersion() },
      { key: 'node', group: 'system', label: 'Node.js', status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'warn', value: process.versions.node, hint: 'Khuyến nghị Node 20 trở lên' },
      { key: 'env', group: 'system', label: 'Môi trường', status: env === 'production' ? 'ok' : 'warn', value: env ?? 'development', hint: env === 'production' ? undefined : 'NODE_ENV chưa phải production (Swagger, log chi tiết đang bật)' },
      { key: 'uptime', group: 'system', label: 'Thời gian chạy tiến trình', status: 'ok', value: fmtDuration(process.uptime()) },
      {
        key: 'memory',
        group: 'system',
        label: 'Bộ nhớ tiến trình',
        status: mem.rss > totalmem() * 0.8 ? 'warn' : 'ok',
        value: `RSS ${fmtBytes(mem.rss)} · heap ${fmtBytes(mem.heapUsed)}/${fmtBytes(mem.heapTotal)} · máy ${fmtBytes(totalmem())}`,
      },
      { key: 'cpu', group: 'system', label: 'CPU', status: load / cores > 0.9 ? 'warn' : 'ok', value: `${cores} nhân · load 1 phút ${load.toFixed(2)}` },
      { key: 'time', group: 'system', label: 'Giờ máy chủ', status: 'ok', value: `${new Date().toLocaleString('vi-VN', { timeZone: tz })} (${tz})`, hint: 'Lịch sao lưu/cron chạy theo múi giờ này' },
    ];
  }

  private async database(): Promise<HealthItem[]> {
    const [ver] = await this.prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    const [size] = await this.prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
    const [tables] = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`;
    const [migrations] = await this.prisma.$queryRaw<{ n: bigint; failed: bigint }[]>`SELECT count(*) AS n, count(*) FILTER (WHERE finished_at IS NULL) AS failed FROM "_prisma_migrations"`.catch(() => [{ n: 0n, failed: 0n }]);
    const version = /PostgreSQL ([\d.]+)/.exec(ver.version)?.[1] ?? ver.version;
    const major = Number(version.split('.')[0]);
    return [
      { key: 'db-version', group: 'database', label: 'PostgreSQL', status: major >= 14 ? 'ok' : 'warn', value: version, hint: major >= 14 ? undefined : 'Khuyến nghị PostgreSQL 14 trở lên' },
      { key: 'db-size', group: 'database', label: 'Dung lượng database', status: 'ok', value: `${fmtBytes(Number(size.size))} · ${Number(tables.n)} bảng` },
      {
        key: 'db-migrations',
        group: 'database',
        label: 'Migration',
        status: Number(migrations.failed) ? 'error' : 'ok',
        value: `${Number(migrations.n)} đã áp dụng${Number(migrations.failed) ? `, ${Number(migrations.failed)} lỗi` : ''}`,
        hint: Number(migrations.failed) ? 'Có migration chưa hoàn tất — kiểm tra bảng _prisma_migrations' : undefined,
      },
    ];
  }

  private async scanDir(root: string) {
    let files = 0;
    let bytes = 0;
    let capped = false;
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (++files > UPLOAD_SCAN_CAP) {
        capped = true;
        break;
      }
      const st = await stat(join(e.parentPath ?? root, e.name)).catch(() => null);
      if (st) bytes += st.size;
    }
    return { files: Math.min(files, UPLOAD_SCAN_CAP), bytes, capped };
  }

  private async writable(dir: string) {
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    return access(dir, constants.W_OK).then(() => true, () => false);
  }

  private async storageChecks(): Promise<HealthItem[]> {
    const items: HealthItem[] = [];
    const driver = this.storage.name;
    items.push({ key: 'storage-driver', group: 'storage', label: 'Driver lưu trữ media', status: 'ok', value: driver === 's3' ? `S3 (${process.env.S3_BUCKET ?? ''}${process.env.S3_ENDPOINT ? ` @ ${process.env.S3_ENDPOINT}` : ''})` : 'Local (thư mục uploads)', hint: driver === 'local' ? 'Có thể chuyển sang S3/R2 bằng STORAGE_DRIVER=s3' : undefined });
    const mediaCount = await this.prisma.media.count();
    const scan = await this.scanDir(this.local.root);
    items.push({ key: 'uploads', group: 'storage', label: 'Thư mục uploads', status: 'ok', value: `${scan.files}${scan.capped ? '+' : ''} file · ${fmtBytes(scan.bytes)} · ${mediaCount} bản ghi media`, hint: this.local.root });
    for (const [key, label, dir] of [
      ['dir-uploads', 'Ghi được: uploads', this.local.root],
      ['dir-backups', 'Ghi được: backups', this.backup.dir],
    ] as const) {
      const ok = await this.writable(dir);
      items.push({ key, group: 'storage', label, status: ok ? 'ok' : 'error', value: ok ? 'Có' : 'Không ghi được', hint: dir });
    }
    const pg = await this.backup.pgDumpStatus();
    items.push({
      key: 'pg_dump',
      group: 'storage',
      label: 'Sao lưu database',
      status: pg.ok ? 'ok' : 'warn',
      value: pg.ok ? (pg.via === 'cmd' ? 'Dùng BACKUP_CMD' : pg.version ?? 'pg_dump sẵn sàng') : pg.error ?? 'Không có pg_dump',
      hint: pg.ok ? undefined : 'Cài postgresql-client trên máy chủ API hoặc đặt BACKUP_CMD / BACKUP_RESTORE_CMD',
    });
    const backups = await this.backup.list().catch(() => []);
    const latest = backups.find((b) => b.type === 'db');
    const ageDays = latest ? (Date.now() - latest.createdAt.getTime()) / 86_400_000 : null;
    const bs = await this.backup.getSettings();
    items.push({
      key: 'backup-latest',
      group: 'storage',
      label: 'Bản sao lưu gần nhất',
      status: !latest ? 'warn' : ageDays! > 7 ? 'warn' : 'ok',
      value: latest ? `${latest.name} (${fmtDuration((Date.now() - latest.createdAt.getTime()) / 1000)} trước)` : 'Chưa có',
      hint: bs.schedule === 'none' ? 'Chưa bật lịch sao lưu tự động (Công cụ › Sao lưu)' : `Lịch: ${bs.schedule === 'daily' ? 'hằng ngày' : 'hằng tuần'} lúc ${bs.hour}:00, giữ ${bs.keep} bản`,
    });
    return items;
  }

  private async security(): Promise<HealthItem[]> {
    const items: HealthItem[] = [];
    const prod = this.config.get<string>('env') === 'production';
    const jwt = process.env.JWT_ACCESS_SECRET ?? '';
    const jwtWeak = WEAK_SECRETS.includes(jwt) || jwt.length < 32;
    items.push({ key: 'jwt', group: 'security', label: 'JWT_ACCESS_SECRET', status: jwtWeak ? (prod ? 'error' : 'warn') : 'ok', value: jwtWeak ? (jwt.length < 32 && !WEAK_SECRETS.includes(jwt) ? `Quá ngắn (${jwt.length} ký tự)` : 'Đang dùng giá trị mặc định') : `Đã đặt (${jwt.length} ký tự)`, hint: jwtWeak ? 'Đặt chuỗi ngẫu nhiên ≥ 32 ký tự' : undefined });
    const rv = this.config.get<string>('web.revalidateSecret') ?? '';
    items.push({ key: 'revalidate', group: 'security', label: 'REVALIDATE_SECRET', status: WEAK_SECRETS.includes(rv) ? 'warn' : 'ok', value: WEAK_SECRETS.includes(rv) ? (rv ? 'Giá trị mặc định' : 'Chưa đặt') : 'Đã đặt', hint: WEAK_SECRETS.includes(rv) ? 'Frontend riêng (nếu có) sẽ không được làm mới cache khi nội dung đổi' : undefined });
    const apiUrl = this.config.get<string>('apiPublicUrl') ?? '';
    const https = apiUrl.startsWith('https://');
    items.push({ key: 'api-url', group: 'security', label: 'API_PUBLIC_URL', status: https || !prod ? 'ok' : 'warn', value: apiUrl, hint: https ? undefined : 'Production nên dùng HTTPS' });
    const cors = this.config.get<string[]>('corsOrigins') ?? [];
    items.push({ key: 'cors', group: 'security', label: 'CORS_ORIGINS', status: cors.length ? 'ok' : prod ? 'error' : 'warn', value: cors.length ? cors.join(', ') : 'Chưa đặt (cho phép mọi origin)', hint: cors.length ? undefined : 'Đặt danh sách domain admin + storefront' });
    const seedEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@cmsnt.co').toLowerCase();
    const seed = await this.prisma.user.findFirst({ where: { email: { equals: seedEmail, mode: 'insensitive' } }, select: { passwordHash: true } });
    const stillDefault = !!seed && (await argon2.verify(seed.passwordHash, process.env.SEED_ADMIN_PASSWORD ?? '123456').catch(() => false));
    items.push({ key: 'seed-password', group: 'security', label: 'Mật khẩu admin khởi tạo', status: stillDefault ? (prod ? 'error' : 'warn') : 'ok', value: stillDefault ? `${seedEmail} vẫn dùng mật khẩu seed` : 'Đã đổi', hint: stillDefault ? 'Đổi mật khẩu tại Hồ sơ cá nhân' : undefined });
    // kho mã số: chưa đặt khoá riêng -> mã dẫn xuất từ JWT_ACCESS_SECRET, đổi JWT là mất khả năng giải mã
    const digitalCodes = await this.prisma.digitalCode.count().catch(() => 0);
    if (digitalCodes) {
      const ownKey = !!process.env.DIGITAL_CODES_KEY?.trim();
      items.push({ key: 'digital-codes-key', group: 'security', label: 'DIGITAL_CODES_KEY', status: ownKey ? 'ok' : 'warn', value: ownKey ? `Đã đặt · ${digitalCodes} mã trong kho` : `Chưa đặt · ${digitalCodes} mã đang mã hoá bằng khoá dẫn xuất từ JWT_ACCESS_SECRET`, hint: ownKey ? 'Sao lưu khoá này cùng database — mất khoá là mất toàn bộ nội dung mã' : 'Đổi JWT_ACCESS_SECRET sẽ làm mọi mã cũ không giải mã được. Đặt khoá riêng TRƯỚC khi nhập mã (mã đã nhập phải nhập lại sau khi đổi khoá).' });
      items.push(await this.digitalCodesDecrypt());
    }
    items.push({ key: 'trust-proxy', group: 'security', label: 'TRUST_PROXY', status: 'ok', value: process.env.TRUST_PROXY ?? 'loopback', hint: 'Đặt 1 khi API nằm sau reverse proxy để ghi đúng IP' });
    return items;
  }

  /**
   * Giải mã thử mã mẫu trong kho bằng khoá hiện tại (cùng cách lấy khoá với DigitalCodesService): mã còn trong kho cũ nhất
   * (mã sẽ được giao tiếp theo) + mã mới nhất. Không giải mã được -> khoá đã bị đổi, mã sẽ không giao được (bị chuyển Tạm khoá).
   */
  private async digitalCodesDecrypt(): Promise<HealthItem> {
    const keys = deriveCodeKeys(this.config.get<string>('DIGITAL_CODES_KEY') ?? process.env.DIGITAL_CODES_KEY ?? '', this.config.get<string>('jwt.accessSecret') ?? '');
    const [oldestAvailable, newest] = await Promise.all([
      this.prisma.digitalCode.findFirst({ where: { status: 'AVAILABLE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, content: true } }),
      this.prisma.digitalCode.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, content: true } }),
    ]);
    const samples = [oldestAvailable, newest].filter((x): x is { id: string; content: string } => !!x);
    const failed = samples.filter((c) => decryptCode(c.content, keys) === null);
    if (failed.length) {
      return {
        key: 'digital-codes-decrypt',
        group: 'security',
        label: 'Giải mã kho mã',
        status: 'error',
        value: `Không giải mã được mã mẫu bằng khoá hiện tại (${failed.length}/${samples.length} mã thử) — DIGITAL_CODES_KEY / JWT_ACCESS_SECRET đã bị đổi?`,
        hint: 'Mã mã hoá bằng khoá cũ sẽ không giao được (hệ thống chuyển sang "Tạm khoá" khi chọn giao). Khôi phục đúng khoá cũ, hoặc nhập lại các mã đó.',
      };
    }
    return { key: 'digital-codes-decrypt', group: 'security', label: 'Giải mã kho mã', status: 'ok', value: `Giải mã thử ${samples.length} mã mẫu thành công` };
  }

  private async services(): Promise<HealthItem[]> {
    const items: HealthItem[] = [];
    const mail = await this.settings.get<{ host?: string; fromEmail?: string }>('mail');
    items.push({ key: 'smtp', group: 'services', label: 'SMTP', status: mail.host ? 'ok' : 'warn', value: mail.host ? `${mail.host} · từ ${mail.fromEmail || '(chưa đặt)'}` : 'Chưa cấu hình', hint: mail.host ? undefined : 'Email đơn hàng, đặt lại mật khẩu sẽ không gửi được (Cài đặt › Email)' });
    const web = this.config.get<string>('web.internalUrl');
    // Panel không kèm website khách: frontend riêng là tuỳ chọn -> chưa đặt WEB_URL không phải lỗi
    if (!web) items.push({ key: 'storefront', group: 'services', label: 'Frontend', status: 'ok', value: 'Không dùng (chưa đặt WEB_URL)' });
    else {
      const started = Date.now();
      try {
        const res = await fetch(`${web}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const ok = res.status < 500;
        items.push({ key: 'storefront', group: 'services', label: 'Frontend', status: ok ? 'ok' : 'error', value: `${web} → HTTP ${res.status} (${Date.now() - started} ms)` });
      } catch (err) {
        items.push({ key: 'storefront', group: 'services', label: 'Frontend', status: 'error', value: `${web} không phản hồi`, hint: (err as Error).message });
      }
    }
    const stats = await this.jobs.stats();
    items.push({ key: 'jobs', group: 'services', label: 'Hàng đợi job', status: stats.failed ? 'warn' : 'ok', value: `${stats.pending} chờ · ${stats.running} đang chạy · ${stats.failed} lỗi · ${stats.handlers.length} handler`, hint: stats.failed ? 'Xem tab Tác vụ nền để chạy lại' : undefined });
    const cron = this.cron.list();
    const errored = cron.filter((c) => c.lastError);
    items.push({ key: 'cron', group: 'services', label: 'Cron', status: errored.length ? 'warn' : 'ok', value: `${cron.length} tác vụ đăng ký${errored.length ? `, ${errored.length} lỗi lần chạy cuối` : ''}`, hint: errored.map((c) => `${c.name}: ${c.lastError}`).join('; ') || undefined });
    return items;
  }
}
