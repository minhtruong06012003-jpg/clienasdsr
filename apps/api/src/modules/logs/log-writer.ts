import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Bộ ghi nhật ký lỗi dạng file theo ngày (giống `storage/logs/laravel-YYYY-MM-DD.log` của Laravel).
 * Mỗi dòng là 1 JSON (JSON Lines) để trang quản trị đọc/lọc dễ dàng mà vẫn `tail -f` được.
 *
 * Là singleton thuần (không qua DI của Nest) vì phải dùng được trước khi tạo AppModule
 * (lỗi khởi động) và trong handler `uncaughtException`.
 */

/** Mức log từ thấp tới cao */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRequestInfo {
  method?: string;
  url?: string;
  status?: number;
  ip?: string;
  userId?: string;
  userEmail?: string;
  userAgent?: string;
  referer?: string;
}

export interface LogEntry {
  id: string;
  time: string;
  level: LogLevel;
  /** Nơi phát sinh: api | http | process | cron | job | web-server | web-client | admin-client ... */
  source: string;
  /** Ngữ cảnh Nest (tên Logger), vd 'Prisma', 'Mail' */
  context?: string;
  message: string;
  stack?: string;
  request?: LogRequestInfo;
  meta?: Record<string, unknown>;
}

export type LogInput = Omit<LogEntry, 'id' | 'time'> & { time?: string };

/** Cấu hình lấy từ nhóm cài đặt `logging` (LogsService đồng bộ khi khởi động và khi cài đặt đổi) */
export interface LogConfig {
  /** mức ghi tối thiểu */
  level: LogLevel;
  /** dung lượng tối đa của file mỗi ngày; vượt thì chỉ ghi lỗi fatal */
  maxFileMb: number;
  /** ghi cả lỗi 4xx của request HTTP (mức warn) */
  log4xx: boolean;
  /** nhận lỗi JavaScript gửi từ trình duyệt (website, trang quản trị) */
  captureClient: boolean;
}

/** Thư mục lưu log: LOG_DIR (mặc định `logs` cạnh thư mục chạy API = apps/api/logs) */
const dirEnv = process.env.LOG_DIR?.trim() || 'logs';
export const LOG_DIR = isAbsolute(dirEnv) ? dirEnv : resolve(process.cwd(), dirEnv);
/** Tên file hợp lệ — dùng cả để chặn path traversal khi đọc/xoá theo tên */
export const LOG_FILE_RE = /^cmsnt-(\d{4}-\d{2}-\d{2})\.log$/;
const SEEN_FILE = join(LOG_DIR, '.seen');

/** Khoá nhạy cảm: giá trị luôn được che khi ghi log */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|otp|signature|license/i;
/** Che giá trị nhạy cảm dạng `key=value` hoặc `"key":"value"` trong URL/thông điệp */
const SENSITIVE_PAIR = /((?:pass(?:word)?|secret|token|access_token|refresh_token|api[-_]?key|signature|otp|code_verifier)["']?\s*[=:]\s*["']?)([^&\s"',;}]+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;

export function redactText(text: string): string {
  return text.replace(SENSITIVE_PAIR, '$1***').replace(BEARER, '$1***');
}

/** Che khoá nhạy cảm trong object (đệ quy, giới hạn độ sâu để không treo khi object vòng) */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[…]';
  if (typeof value === 'string') return redactText(value.length > 4000 ? `${value.slice(0, 4000)}…` : value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = SENSITIVE_KEY.test(k) ? '***' : redactValue(v, depth + 1);
    return out;
  }
  return value;
}

/** Ngày theo giờ máy chủ, dạng YYYY-MM-DD (đặt TZ cho tiến trình nếu cần giờ Việt Nam) */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const logFileName = (day: string) => `cmsnt-${day}.log`;

const levelRank = (l: LogLevel) => LOG_LEVELS.indexOf(l);
const clip = (s: string | undefined, max: number) => (s && s.length > max ? `${s.slice(0, max)}…` : s);

/** Số lần một lỗi y hệt được ghi trong 1 phút trước khi bị gộp (chống vòng lặp lỗi làm phình file) */
const FLOOD_LIMIT = 20;

class LogWriter {
  private config: LogConfig = {
    level: (LOG_LEVELS as readonly string[]).includes(process.env.LOG_LEVEL ?? '') ? (process.env.LOG_LEVEL as LogLevel) : 'warn',
    maxFileMb: 50,
    log4xx: false,
    captureClient: true,
  };
  private stream: WriteStream | null = null;
  private streamDay = '';
  private size = 0;
  /** đã ghi dòng thông báo "vượt dung lượng" cho ngày hiện tại chưa */
  private capNoticeDay = '';
  private failed = false;
  /** chống lặp: khoá lỗi -> số lần trong phút hiện tại */
  private flood = new Map<string, { count: number; sample: LogInput }>();
  private floodMinute = 0;
  /** số lỗi error/fatal chưa xem (badge trên menu) */
  private unseen = 0;
  private seenAt = 0;

  constructor() {
    try {
      this.seenAt = Number(readFileSync(SEEN_FILE, 'utf8')) || 0;
    } catch {
      this.seenAt = 0;
    }
  }

  get settings(): Readonly<LogConfig> {
    return this.config;
  }

  configure(next: Partial<LogConfig>) {
    const level = (LOG_LEVELS as readonly string[]).includes(next.level as string) ? (next.level as LogLevel) : this.config.level;
    const maxFileMb = Number(next.maxFileMb);
    this.config = {
      level,
      maxFileMb: Number.isFinite(maxFileMb) && maxFileMb > 0 ? Math.min(maxFileMb, 2048) : this.config.maxFileMb,
      log4xx: next.log4xx ?? this.config.log4xx,
      captureClient: next.captureClient ?? this.config.captureClient,
    };
  }

  /** Mức này có được ghi theo cấu hình không */
  enabled(level: LogLevel) {
    return levelRank(level) >= levelRank(this.config.level) || level === 'fatal';
  }

  /** Ghi 1 dòng log. `sync` = ghi đồng bộ (dùng khi tiến trình sắp thoát) */
  write(input: LogInput, opts: { sync?: boolean } = {}) {
    if (!this.enabled(input.level)) return;
    if (!opts.sync && this.isFlood(input)) return;
    const entry: LogEntry = {
      id: randomBytes(6).toString('hex'),
      time: input.time ?? new Date().toISOString(),
      level: input.level,
      source: input.source,
      ...(input.context ? { context: clip(input.context, 200) } : {}),
      message: redactText(clip(String(input.message ?? ''), 8000) || '(không có nội dung)'),
      ...(input.stack ? { stack: redactText(clip(input.stack, 16000)!) } : {}),
      ...(input.request ? { request: redactValue(input.request) as LogRequestInfo } : {}),
      ...(input.meta && Object.keys(input.meta).length ? { meta: redactValue(input.meta) as Record<string, unknown> } : {}),
    };
    this.append(entry, !!opts.sync);
  }

  private append(entry: LogEntry, sync: boolean) {
    const day = localDay();
    const line = `${JSON.stringify(entry)}\n`;
    try {
      if (this.streamDay !== day || !this.stream) this.open(day);
      // vượt dung lượng ngày: chỉ còn ghi fatal, kèm 1 dòng báo để người xem biết log bị cắt
      if (this.size > this.config.maxFileMb * 1024 * 1024 && entry.level !== 'fatal') {
        if (this.capNoticeDay === day) return;
        this.capNoticeDay = day;
        const notice: LogEntry = { id: randomBytes(6).toString('hex'), time: new Date().toISOString(), level: 'warn', source: 'api', context: 'Logs', message: `File log hôm nay đã vượt ${this.config.maxFileMb} MB — ngừng ghi các lỗi mức thấp hơn fatal tới hết ngày` };
        return this.raw(`${JSON.stringify(notice)}\n`, sync);
      }
      if ((entry.level === 'error' || entry.level === 'fatal') && Date.parse(entry.time) > this.seenAt) this.unseen++;
      this.raw(line, sync);
    } catch (err) {
      this.fail(err);
    }
  }

  private raw(line: string, sync: boolean) {
    this.size += Buffer.byteLength(line);
    if (sync || !this.stream) appendFileSync(join(LOG_DIR, logFileName(this.streamDay)), line);
    else this.stream.write(line);
  }

  private open(day: string) {
    this.closeStream();
    mkdirSync(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, logFileName(day));
    this.size = existsSync(file) ? statSync(file).size : 0;
    this.stream = createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (err) => this.fail(err));
    this.streamDay = day;
  }

  /** Đóng file đang ghi (khi xoá file log; lần ghi sau sẽ tạo file mới) */
  closeStream() {
    this.stream?.end();
    this.stream = null;
    this.streamDay = '';
  }

  /** Không ghi được (thiếu quyền, đầy đĩa...) -> báo ra console 1 lần, không làm sập API */
  private fail(err: unknown) {
    this.stream = null;
    this.streamDay = '';
    if (this.failed) return;
    this.failed = true;
    console.error(`[Logs] Không ghi được file log vào ${LOG_DIR}: ${(err as Error)?.message ?? err}`);
  }

  /** Gộp lỗi lặp lại: quá FLOOD_LIMIT lần/phút cùng nội dung thì bỏ, cuối phút ghi 1 dòng tổng kết */
  private isFlood(input: LogInput): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.floodMinute) {
      const summary = [...this.flood.values()].filter((f) => f.count > FLOOD_LIMIT);
      this.flood.clear();
      this.floodMinute = minute;
      for (const f of summary) {
        this.write({ level: f.sample.level, source: f.sample.source, context: f.sample.context, message: `Lỗi lặp lại thêm ${f.count - FLOOD_LIMIT} lần trong 1 phút (đã gộp): ${clip(f.sample.message, 500)}` });
      }
    }
    const key = `${input.level}|${input.source}|${input.context ?? ''}|${String(input.message).slice(0, 300)}`;
    const cur = this.flood.get(key);
    if (cur) cur.count++;
    else this.flood.set(key, { count: 1, sample: input });
    return (cur?.count ?? 1) > FLOOD_LIMIT;
  }

  /** Số lỗi error/fatal mới kể từ lần xem gần nhất */
  unseenCount() {
    return this.unseen;
  }

  get lastSeenAt() {
    return this.seenAt;
  }

  /** LogsService đếm lại từ file lúc khởi động */
  setUnseen(n: number) {
    this.unseen = n;
  }

  markSeen() {
    this.seenAt = Date.now();
    this.unseen = 0;
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(SEEN_FILE, String(this.seenAt));
    } catch {
      /* không lưu được thì chỉ reset trong bộ nhớ */
    }
  }
}

export const logWriter = new LogWriter();
