import { ConsoleLogger } from '@nestjs/common';
import { logWriter, type LogLevel } from './log-writer.js';

/** Ngữ cảnh Nest -> nguồn log hiển thị trong trang Nhật ký lỗi */
const SOURCE_BY_CONTEXT: Record<string, string> = {
  Cron: 'cron',
  Jobs: 'job',
  ScheduledPublish: 'cron',
  ExceptionsHandler: 'http',
};

const looksLikeStack = (v: unknown) => typeof v === 'string' && /\n\s+at\s/.test(v);

/**
 * Logger toàn cục của API: vẫn in ra console như mặc định của Nest, đồng thời ghi vào file
 * nhật ký lỗi (theo mức tối thiểu trong cài đặt). Mọi `new Logger('X').error(...)` trong code
 * đều đi qua đây nên không cần sửa từng module.
 */
export class AppLogger extends ConsoleLogger {
  error(message: unknown, ...params: unknown[]) {
    super.error(message, ...params);
    this.capture('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]) {
    super.fatal(message, ...params);
    this.capture('fatal', message, params);
  }

  warn(message: unknown, ...params: unknown[]) {
    super.warn(message, ...params);
    this.capture('warn', message, params);
  }

  log(message: unknown, ...params: unknown[]) {
    super.log(message, ...params);
    this.capture('info', message, params);
  }

  debug(message: unknown, ...params: unknown[]) {
    super.debug(message, ...params);
    this.capture('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]) {
    super.verbose(message, ...params);
    this.capture('debug', message, params);
  }

  /**
   * Tách tham số theo quy ước của Nest: tham số chuỗi cuối = context; với error/fatal,
   * tham số đầu dạng stack trace = stack. Phần còn lại đưa vào meta.
   */
  private capture(level: LogLevel, message: unknown, params: unknown[]) {
    if (!logWriter.enabled(level)) return;
    try {
      const rest = [...params];
      let context = this.context;
      const last = rest[rest.length - 1];
      const isErrorLevel = level === 'error' || level === 'fatal';
      // error('msg', stack) chỉ có 1 tham số là stack -> không phải context
      if (typeof last === 'string' && !(isErrorLevel && rest.length === 1 && looksLikeStack(last))) {
        context = last;
        rest.pop();
      }
      let stack: string | undefined;
      if (isErrorLevel && (looksLikeStack(rest[0]) || (rest.length === 1 && typeof rest[0] === 'string'))) stack = rest.shift() as string;

      let text: string;
      if (message instanceof Error) {
        text = message.message;
        stack ??= message.stack;
      } else if (typeof message === 'string') text = message;
      else text = safeJson(message);

      const extra = rest.filter((v) => v !== undefined);
      logWriter.write({
        level,
        source: (context && SOURCE_BY_CONTEXT[context]) || 'api',
        context,
        message: text,
        stack: stack || undefined,
        meta: extra.length ? { extra: extra.map((v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)) } : undefined,
      });
    } catch {
      /* ghi log không bao giờ được làm hỏng luồng chính */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
