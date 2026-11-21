import { Injectable, Logger } from '@nestjs/common';

type Callback = (...args: any[]) => unknown;

interface HookEntry {
  fn: Callback;
  priority: number;
  /** Tên module đăng ký (chỉ để ghi log / liệt kê) */
  source?: string;
}

/**
 * Bus sự kiện nội bộ giữa các module của lõi:
 *  - action: chạy side-effect khi có sự kiện  -> doAction('order.created', order)
 *  - filter: biến đổi dữ liệu theo chuỗi      -> value = await applyFilters('page.public', page, ctx)
 * Module (thông báo email, thông báo admin...) đăng ký hook trong onModuleInit; lõi phát sự kiện mà không cần biết ai nghe.
 * Callback chạy tuần tự theo priority tăng dần; lỗi của một callback được ghi log và không làm hỏng chuỗi.
 */
@Injectable()
export class HooksService {
  private readonly logger = new Logger('Hooks');
  private actions = new Map<string, HookEntry[]>();
  private filters = new Map<string, HookEntry[]>();

  /** Đăng ký action. Trả về hàm gỡ. */
  addAction(name: string, fn: Callback, priority = 10, source?: string) {
    this.add(this.actions, name, { fn, priority, source });
    return () => this.remove(this.actions, name, fn);
  }

  /** Đăng ký filter. Trả về hàm gỡ. */
  addFilter<T = unknown>(name: string, fn: (value: T, ...args: any[]) => T | Promise<T>, priority = 10, source?: string) {
    this.add(this.filters, name, { fn: fn as Callback, priority, source });
    return () => this.remove(this.filters, name, fn as Callback);
  }

  async doAction(name: string, ...args: unknown[]): Promise<void> {
    for (const h of this.actions.get(name) ?? []) {
      try {
        await h.fn(...args);
      } catch (err) {
        this.logger.error(`Action "${name}" (${h.source ?? 'core'}) lỗi: ${(err as Error).message}`);
      }
    }
  }

  async applyFilters<T>(name: string, value: T, ...args: unknown[]): Promise<T> {
    let current = value;
    for (const h of this.filters.get(name) ?? []) {
      try {
        current = (await h.fn(current, ...args)) as T;
      } catch (err) {
        this.logger.error(`Filter "${name}" (${h.source ?? 'core'}) lỗi: ${(err as Error).message}`);
      }
    }
    return current;
  }

  private add(map: Map<string, HookEntry[]>, name: string, entry: HookEntry) {
    const list = map.get(name) ?? [];
    list.push(entry);
    // sort ổn định: cùng priority thì giữ thứ tự đăng ký
    list.sort((a, b) => a.priority - b.priority);
    map.set(name, list);
  }

  private remove(map: Map<string, HookEntry[]>, name: string, fn: Callback) {
    map.set(name, (map.get(name) ?? []).filter((h) => h.fn !== fn));
  }
}
