import type { PrismaService } from '../../prisma/prisma.service.js';

export const CONTENT_STATUS_KEYS = ['DRAFT', 'PUBLISHED', 'SCHEDULED', 'ARCHIVED'] as const;

export interface StatusCounts {
  ALL: number;
  DRAFT: number;
  PUBLISHED: number;
  SCHEDULED: number;
  ARCHIVED: number;
  TRASH: number;
}

/**
 * Đếm số bản ghi theo trạng thái cho tab danh sách (Tất cả / Nháp / Đã xuất bản / Hẹn giờ / Lưu trữ / Thùng rác).
 * Đếm toàn cục, không phụ thuộc bộ lọc hiện tại. ALL = tổng bản ghi chưa vào thùng rác.
 */
export async function countByStatus(prisma: PrismaService, model: 'page' | 'post' | 'product'): Promise<StatusCounts> {
  // Các delegate có cùng cấu trúc status/deletedAt -> gom về một kiểu tối giản để gọi chung
  const delegate = prisma[model] as unknown as {
    groupBy(args: { by: ['status']; where: { deletedAt: null }; _count: { _all: true } }): Promise<{ status: string; _count: { _all: number } }[]>;
    count(args: { where: { deletedAt: { not: null } } }): Promise<number>;
  };
  const [groups, trash] = await Promise.all([
    delegate.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
    delegate.count({ where: { deletedAt: { not: null } } }),
  ]);
  const counts: StatusCounts = { ALL: 0, DRAFT: 0, PUBLISHED: 0, SCHEDULED: 0, ARCHIVED: 0, TRASH: trash };
  for (const g of groups) {
    const key = g.status as (typeof CONTENT_STATUS_KEYS)[number];
    if (CONTENT_STATUS_KEYS.includes(key)) counts[key] = g._count._all;
    counts.ALL += g._count._all;
  }
  return counts;
}

/** Gắn tên tác giả cho danh sách revision (bảng revision chỉ lưu authorId, không có quan hệ). */
export async function attachRevisionAuthors<T extends { authorId: string | null }>(prisma: PrismaService, rows: T[]): Promise<(T & { author: { id: string; name: string } | null })[]> {
  const ids = [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const map = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, author: r.authorId ? (map.get(r.authorId) ?? null) : null }));
}
