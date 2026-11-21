import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface SessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  current: boolean;
}

/** Nhận diện trình duyệt / hệ điều hành đơn giản từ User-Agent (đủ để hiển thị danh sách thiết bị) */
export function parseUserAgent(ua: string | null | undefined): Pick<SessionView, 'browser' | 'os' | 'device'> {
  const s = ua ?? '';
  if (!s) return { browser: 'Không rõ', os: 'Không rõ', device: 'unknown' };
  const ver = (re: RegExp) => re.exec(s)?.[1]?.split('.')[0];
  let browser = 'Trình duyệt khác';
  if (/Edg\//.test(s)) browser = `Edge ${ver(/Edg\/([\d.]+)/) ?? ''}`;
  else if (/OPR\/|Opera/.test(s)) browser = `Opera ${ver(/OPR\/([\d.]+)/) ?? ''}`;
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/CriOS\//.test(s)) browser = `Chrome ${ver(/CriOS\/([\d.]+)/) ?? ''}`;
  else if (/FxiOS\//.test(s)) browser = `Firefox ${ver(/FxiOS\/([\d.]+)/) ?? ''}`;
  else if (/Chrome\//.test(s)) browser = `Chrome ${ver(/Chrome\/([\d.]+)/) ?? ''}`;
  else if (/Firefox\//.test(s)) browser = `Firefox ${ver(/Firefox\/([\d.]+)/) ?? ''}`;
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = `Safari ${ver(/Version\/([\d.]+)/) ?? ''}`;
  else if (/curl\//i.test(s)) browser = 'curl';
  else if (/PostmanRuntime/.test(s)) browser = 'Postman';

  let os = 'Không rõ';
  if (/Windows NT 10|Windows NT 11/.test(s)) os = 'Windows';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  const device: SessionView['device'] = /iPad|Tablet/.test(s) ? 'tablet' : /Mobile|iPhone|Android/.test(s) ? 'mobile' : 'desktop';
  return { browser: browser.trim(), os, device };
}

/** Cache trạng thái phiên cho guard (giây) — thu hồi ở nơi khác có hiệu lực chậm nhất sau chừng này */
const SESSION_STATE_TTL_MS = 20_000;
/** Khoảng chờ sau khi xoay vòng refresh token: dòng thay thế được tạo ngay sau đó, chưa kiểm tra chuỗi */
const ROTATION_SETTLE_MS = 5_000;

/** Danh sách / thu hồi phiên đăng nhập (mỗi refresh token còn hiệu lực = 1 phiên / thiết bị) */
@Injectable()
export class SessionsService {
  private state = new Map<string, { active: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phiên (claim `sid` của access token) còn hiệu lực không. Phiên bị thu hồi chủ động (đăng xuất,
   * thu hồi thiết bị, đổi mật khẩu, admin khoá) -> access token cũ bị từ chối ngay, không chờ hết hạn.
   *
   * Phiên đã bị "xoay vòng" (refresh) chỉ còn hiệu lực khi CHUỖI phiên của nó còn sống: thu hồi chủ động
   * chỉ đánh dấu dòng mới nhất (revokedAt null), nên nếu chỉ nhìn `rotatedAt` thì access token gắn sid của
   * dòng cũ vẫn dùng được tới khi hết hạn sau đăng xuất / đổi mật khẩu / đăng xuất tất cả.
   * Chuỗi = cùng userId + cùng createdAt (issueTokens giữ nguyên createdAt khi xoay vòng).
   */
  async isActive(sid: string): Promise<boolean> {
    const hit = this.state.get(sid);
    if (hit && Date.now() - hit.at < SESSION_STATE_TTL_MS) return hit.active;
    const row = await this.prisma.refreshToken.findUnique({ where: { id: sid }, select: { userId: true, createdAt: true, revokedAt: true, rotatedAt: true } });
    let active = false;
    if (row && !row.revokedAt) active = true;
    else if (row?.rotatedAt) {
      // vừa xoay vòng (dòng kế tiếp có thể chưa kịp tạo xong) -> chưa kết luận chuỗi đã chết
      if (Date.now() - row.rotatedAt.getTime() < ROTATION_SETTLE_MS) active = true;
      else active = (await this.prisma.refreshToken.count({ where: { userId: row.userId, createdAt: row.createdAt, revokedAt: null, expiresAt: { gt: new Date() } } })) > 0;
    }
    if (this.state.size > 10_000) this.state.clear();
    this.state.set(sid, { active, at: Date.now() });
    return active;
  }

  /** Xoá cache trạng thái phiên (sau khi thu hồi) để guard tra lại DB ngay trên instance này */
  forgetAll() {
    this.state.clear();
  }

  async list(userId: string, currentId?: string | null): Promise<SessionView[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    return rows
      .map((r) => ({ ...r, ...parseUserAgent(r.userAgent), current: r.id === currentId }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /**
   * Thu hồi CẢ CHUỖI phiên chứa dòng refresh token khớp `where` (cùng userId + createdAt): gồm dòng mới nhất,
   * các nhánh rẽ do refresh song song trong thời gian ân hạn và các dòng đã xoay vòng. Trả số dòng bị thu hồi
   * (0 = không tìm thấy hoặc chuỗi đã kết thúc).
   */
  async revokeChain(where: { id?: string; tokenHash?: string; userId?: string }): Promise<number> {
    if (!where.id && !where.tokenHash) return 0;
    const row = await this.prisma.refreshToken.findFirst({ where, select: { userId: true, createdAt: true } });
    if (!row) return 0;
    const { count } = await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, createdAt: row.createdAt, revokedAt: null }, data: { revokedAt: new Date() } });
    // các dòng đã xoay vòng cùng chuỗi đang được cache là "còn hiệu lực" -> xoá cache để guard tra lại DB
    this.forgetAll();
    return count;
  }

  /** Thu hồi 1 phiên của user (chỉ phiên thuộc user đó) — thu hồi cả chuỗi phiên */
  async revoke(userId: string, id: string) {
    const count = await this.revokeChain({ id, userId });
    if (!count) throw new NotFoundException('Phiên đăng nhập không tồn tại hoặc đã kết thúc');
    return { success: true };
  }

  /**
   * Thu hồi mọi phiên khác, giữ nguyên CHUỖI phiên hiện tại (sid trong access token có thể là dòng đã xoay vòng,
   * nên so theo createdAt của chuỗi chứ không theo id — tránh thu hồi nhầm dòng sống của chính thiết bị này).
   */
  async revokeOthers(userId: string, currentId?: string | null) {
    const current = currentId ? await this.prisma.refreshToken.findFirst({ where: { id: currentId, userId }, select: { createdAt: true } }) : null;
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(current ? { createdAt: { not: current.createdAt } } : {}) },
      data: { revokedAt: new Date() },
    });
    // xoá cache trạng thái mọi phiên để guard tra lại DB ngay
    this.forgetAll();
    return { success: true, revoked: count };
  }
}
