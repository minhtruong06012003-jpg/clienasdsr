import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { UpsertAnnouncementDto } from './announcements.dto.js';
import { sanitizeRichHtml } from '../../common/utils/sanitize-html.js';

/** Bảng tin: thông báo admin tự viết, khách xem ở trang Tổng quan (ghim trước, mới nhất trước) */
@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Khách: thông báo đang hiện, tối đa 30 bản gần nhất */
  memberList() {
    return this.prisma.announcement.findMany({
      where: { active: true },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 30,
      select: { id: true, title: true, content: true, pinned: true, createdAt: true },
    });
  }

  /** Admin: toàn bộ thông báo kèm người viết */
  adminList() {
    return this.prisma.announcement.findMany({
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    });
  }

  /** Thêm mới (id rỗng) hoặc sửa thông báo */
  async save(dto: UpsertAnnouncementDto, userId: string, id?: string) {
    // nội dung HTML hiện thô ở trang khách -> luôn lọc theo allowlist (chống XSS), kể cả admin có quyền cao
    const data = { title: dto.title?.trim() || null, content: sanitizeRichHtml(dto.content.trim()), pinned: !!dto.pinned, active: dto.active !== false };
    if (!id) return this.prisma.announcement.create({ data: { ...data, createdById: userId } });
    await this.ensure(id);
    return this.prisma.announcement.update({ where: { id }, data });
  }

  /** Xoá hẳn một thông báo */
  async remove(id: string) {
    await this.ensure(id);
    await this.prisma.announcement.delete({ where: { id } });
    return { ok: true };
  }

  private async ensure(id: string) {
    const row = await this.prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Không tìm thấy thông báo');
  }
}
