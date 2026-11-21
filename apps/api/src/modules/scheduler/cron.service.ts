import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

interface Entry {
  name: string;
  expression: string;
  owner?: string;
  lastRun?: Date;
  lastError?: string;
  runs: number;
}

/**
 * Đăng ký tác vụ định kỳ lúc chạy (cho các module): cron.add('sync', EVERY_6_HOURS, fn, 'my-module').
 * Biểu thức cron chuẩn 5 trường (phút giờ ngày tháng thứ). Tên đầy đủ = <owner>:<name>; gỡ toàn bộ của một module bằng removeOwner(owner).
 */
@Injectable()
export class CronService {
  private readonly logger = new Logger('Cron');
  private entries = new Map<string, Entry>();

  constructor(private readonly registry: SchedulerRegistry) {}

  add(name: string, expression: string, fn: () => Promise<unknown> | unknown, owner?: string) {
    const full = owner ? `${owner}:${name}` : name;
    this.remove(full);
    const entry: Entry = { name: full, expression, owner, runs: 0 };
    const job = new CronJob(expression, async () => {
      entry.lastRun = new Date();
      entry.runs += 1;
      try {
        await fn();
        entry.lastError = undefined;
      } catch (err) {
        entry.lastError = (err as Error).message;
        this.logger.error(`Cron "${full}" lỗi: ${entry.lastError}`);
      }
    });
    this.registry.addCronJob(full, job);
    this.entries.set(full, entry);
    if (process.env.NODE_ENV !== 'test') job.start();
    return () => this.remove(full);
  }

  remove(full: string) {
    if (!this.entries.has(full)) return;
    try {
      this.registry.deleteCronJob(full);
    } catch {
      /* đã bị gỡ */
    }
    this.entries.delete(full);
  }

  removeOwner(owner: string) {
    for (const [name, e] of this.entries) if (e.owner === owner) this.remove(name);
  }

  list() {
    return [...this.entries.values()].map((e) => {
      const job = this.registry.getCronJobs().get(e.name);
      return { ...e, nextRun: job ? (job.nextDate()?.toJSDate() ?? null) : null };
    });
  }
}
