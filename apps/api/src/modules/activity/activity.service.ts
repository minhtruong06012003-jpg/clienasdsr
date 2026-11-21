import { Controller, Get, Injectable, Logger, Module, Query, Res } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface ActivityEvent {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

/** Nhật ký giữ 180 ngày, cron dọn mỗi ngày */
export const ACTIVITY_RETENTION_DAYS = 180;
const CSV_MAX_ROWS = 20_000;

export interface ActivityFilter {
  entityType?: string;
  entityId?: string;
  userId?: string;
  /** Lọc theo prefix hành động, vd "user" hoặc "user.update" */
  action?: string;
  /** ISO date/datetime (bao gồm) */
  from?: string;
  /** ISO date/datetime (bao gồm; nếu chỉ có ngày thì tính hết ngày đó) */
  to?: string;
  search?: string;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger('Activity');

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('activity', { async: true })
  async log(e: ActivityEvent) {
    await this.prisma.activityLog
      .create({ data: { userId: e.userId ?? null, action: e.action, entityType: e.entityType, entityId: e.entityId, meta: (e.meta ?? {}) as object, ip: e.ip } })
      .catch(() => undefined);
  }

  private where(q: ActivityFilter): Prisma.ActivityLogWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) {
      const d = new Date(q.from);
      if (!Number.isNaN(d.getTime())) createdAt.gte = d;
    }
    if (q.to) {
      const d = new Date(q.to);
      if (!Number.isNaN(d.getTime())) {
        // chỉ ngày (yyyy-mm-dd) -> hết ngày đó
        if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) d.setHours(23, 59, 59, 999);
        createdAt.lte = d;
      }
    }
    return {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.search ? { action: { contains: q.search, mode: 'insensitive' as const } } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
    };
  }

  async list(q: PaginationQueryDto & ActivityFilter) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = this.where(q);
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true, email: true } } } }),
      this.prisma.activityLog.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  /** Xuất CSV (tối đa 20.000 dòng mới nhất theo bộ lọc) */
  async exportCsv(q: ActivityFilter) {
    const rows = await this.prisma.activityLog.findMany({ where: this.where(q), orderBy: { createdAt: 'desc' }, take: CSV_MAX_ROWS, include: { user: { select: { name: true, email: true } } } });
    // chặn chèn công thức Excel (=, +, -, @)
    const esc = (v: unknown) => {
      let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ['Thời gian', 'Người dùng', 'Email', 'Hành động', 'Đối tượng', 'ID đối tượng', 'IP', 'Chi tiết'];
    const lines = rows.map((r) => [r.createdAt.toISOString(), r.user?.name ?? 'Hệ thống', r.user?.email ?? '', r.action, r.entityType ?? '', r.entityId ?? '', r.ip ?? '', r.meta].map(esc).join(','));
    return `﻿${[header.map(esc).join(','), ...lines].join('\r\n')}`;
  }

  /** Danh sách nhóm hành động (prefix trước dấu chấm) đang có trong log — cho bộ lọc */
  async actionGroups() {
    const rows = await this.prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
    return [...new Set(rows.map((r) => r.action.split('.')[0]))];
  }

  /** Dọn nhật ký cũ hơn ACTIVITY_RETENTION_DAYS */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanup() {
    if (process.env.NODE_ENV === 'test') return;
    const r = await this.prisma.activityLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 86_400_000) } } });
    if (r.count) this.logger.log(`Đã dọn ${r.count} dòng nhật ký cũ hơn ${ACTIVITY_RETENTION_DAYS} ngày`);
  }
}

class ActivityQuery extends PaginationQueryDto {
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsIn(['csv']) export?: 'csv';
}

@Controller('admin/activity')
@RequirePermissions('activity.read')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  async list(@Query() q: ActivityQuery, @Res({ passthrough: true }) res: Response) {
    if (q.export === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`);
      return this.activity.exportCsv(q);
    }
    return this.activity.list(q);
  }

  @Get('actions')
  actions() {
    return this.activity.actionGroups();
  }
}

@Module({ controllers: [ActivityController], providers: [ActivityService] })
export class ActivityModule {}
