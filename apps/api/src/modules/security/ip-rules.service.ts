import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { ipMatchesRule, isLoopbackIp, isPrivateIp, normalizeIp, normalizeIpRule, ruleCoversLoopback, type IpRuleType, type IpRuleView } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Danh sách quy tắc giữ trong bộ nhớ bao lâu (mọi request đều tra nên không query DB mỗi lần) */
const CACHE_MS = 30_000;
/** Ghi bộ đếm lượt chặn xuống DB theo lô */
const FLUSH_HITS_MS = 60_000;

interface CachedRule {
  id: string;
  type: IpRuleType;
  value: string;
  expiresAt: Date | null;
}

export interface CreateIpRuleInput {
  type: IpRuleType;
  value: string;
  note?: string | null;
  /** phút; bỏ trống = vĩnh viễn */
  durationMinutes?: number | null;
}

/**
 * Quy tắc IP của Trung tâm bảo mật:
 * - `block`: IP / dải CIDR bị từ chối mọi request tới API (middleware `IpFilterMiddleware`).
 * - `allow_admin`: khi bật `security.adminIpAllowlist`, chỉ các IP này vào được trang quản trị.
 * Địa chỉ loopback (máy chủ tự gọi: storefront SSR, cron) không bao giờ bị chặn.
 */
@Injectable()
export class IpRulesService {
  private readonly logger = new Logger('IpRules');
  private cache: { at: number; rules: CachedRule[] } | null = null;
  private loading: Promise<CachedRule[]> | null = null;
  /** lượt chặn chưa ghi xuống DB: ruleId -> số lượt */
  private pendingHits = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
  ) {
    const timer = setInterval(() => void this.flushHits(), FLUSH_HITS_MS);
    timer.unref?.();
  }

  /** Quy tắc còn hiệu lực (cache 30 giây, nhiều request đồng thời dùng chung 1 lần query) */
  private async rules(): Promise<CachedRule[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rules;
    this.loading ??= this.prisma.ipRule
      .findMany({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true, type: true, value: true, expiresAt: true } })
      .then((rows) => {
        const rules = rows.map((r) => ({ ...r, type: r.type as IpRuleType }));
        this.cache = { at: Date.now(), rules };
        return rules;
      })
      .catch((err: Error) => {
        // DB lỗi: không chặn ai (fail-open) thay vì làm sập toàn bộ API
        this.logger.warn(`Không đọc được quy tắc IP: ${err.message}`);
        return this.cache?.rules ?? [];
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  invalidate() {
    this.cache = null;
  }

  private match(rules: CachedRule[], type: IpRuleType, ip: string): CachedRule | undefined {
    const now = Date.now();
    return rules.find((r) => r.type === type && (!r.expiresAt || r.expiresAt.getTime() > now) && ipMatchesRule(ip, r.value));
  }

  /** IP có bị chặn không (loopback luôn được phép). Ghi nhận lượt chặn để hiển thị. */
  async isBlocked(ipRaw: string | null | undefined): Promise<boolean> {
    const ip = normalizeIp(ipRaw);
    if (!ip || isLoopbackIp(ip)) return false;
    const rules = await this.rules();
    if (!rules.length) return false;
    const hit = this.match(rules, 'block', ip);
    if (hit) this.pendingHits.set(hit.id, (this.pendingHits.get(hit.id) ?? 0) + 1);
    return !!hit;
  }

  /** Danh sách cho phép quản trị đang có hiệu lực không (bật trong cài đặt + có ít nhất 1 IP) */
  async adminAllowlistActive(): Promise<boolean> {
    const cfg = await this.settings.get<{ adminIpAllowlist?: boolean }>('security');
    if (!cfg.adminIpAllowlist) return false;
    return (await this.rules()).some((r) => r.type === 'allow_admin');
  }

  /** IP có được vào trang quản trị không (danh sách cho phép tắt -> mọi IP đều được) */
  async isAdminAllowed(ipRaw: string | null | undefined): Promise<boolean> {
    const ip = normalizeIp(ipRaw);
    if (!ip || isLoopbackIp(ip)) return true;
    if (!(await this.adminAllowlistActive())) return true;
    return !!this.match(await this.rules(), 'allow_admin', ip);
  }

  /** Ghi bộ đếm lượt chặn theo lô (giảm ghi DB khi bị tấn công dồn dập) */
  private async flushHits() {
    if (!this.pendingHits.size) return;
    const batch = [...this.pendingHits];
    this.pendingHits.clear();
    const now = new Date();
    for (const [id, n] of batch) {
      await this.prisma.ipRule.updateMany({ where: { id }, data: { hits: { increment: n }, lastHitAt: now } }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- quản lý

  async list(type?: IpRuleType): Promise<IpRuleView[]> {
    const rows = await this.prisma.ipRule.findMany({
      where: { ...(type ? { type } : {}), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const creatorIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    const creators = creatorIds.length ? await this.prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } }) : [];
    const byId = new Map(creators.map((c) => [c.id, c]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as IpRuleType,
      value: r.value,
      note: r.note,
      source: r.source === 'auto' ? 'auto' : 'manual',
      expiresAt: r.expiresAt?.toISOString() ?? null,
      hits: r.hits,
      lastHitAt: r.lastHitAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdById ? (byId.get(r.createdById) ?? null) : null,
    }));
  }

  /**
   * Thêm quy tắc. Chặn: không cho chặn loopback / toàn bộ Internet, không cho tự chặn IP đang dùng.
   * Trùng (cùng loại + giá trị) thì cập nhật ghi chú / thời hạn thay vì báo lỗi.
   */
  async create(input: CreateIpRuleInput, actor: { id: string; ip?: string | null }) {
    const value = normalizeIpRule(input.value);
    if (!value) throw new BadRequestException(`"${input.value}" không phải IP hoặc dải CIDR hợp lệ (vd. 203.113.1.5, 203.113.1.0/24, 2001:db8::/32)`);
    if (input.type === 'block') {
      if (ruleCoversLoopback(value)) throw new BadRequestException('Không thể chặn địa chỉ nội bộ máy chủ (127.0.0.1 / ::1) hoặc toàn bộ Internet');
      if (actor.ip && ipMatchesRule(normalizeIp(actor.ip), value)) throw new BadRequestException('Quy tắc này chặn luôn IP bạn đang dùng — bạn sẽ mất quyền truy cập');
    }
    const minutes = input.durationMinutes ? Math.min(525_600, Math.max(1, Math.round(input.durationMinutes))) : null;
    const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : null;
    const note = input.note?.trim().slice(0, 200) || null;
    const rule = await this.prisma.ipRule.upsert({
      where: { type_value: { type: input.type, value } },
      create: { type: input.type, value, note, expiresAt, source: 'manual', createdById: actor.id },
      update: { note, expiresAt, source: 'manual', createdById: actor.id },
    });
    this.invalidate();
    this.events.emit('activity', { userId: actor.id, action: input.type === 'block' ? 'security.ip_block' : 'security.ip_allow', entityType: 'ip_rule', entityId: rule.id, meta: { value, expiresAt } });
    return { id: rule.id, value };
  }

  /**
   * Xoá quy tắc. Không cho xoá IP cho phép cuối cùng / IP đang dùng khi danh sách cho phép đang bật
   * (sẽ khoá chính mình ngoài trang quản trị).
   */
  async remove(id: string, actor: { id: string; ip?: string | null }) {
    const rule = await this.prisma.ipRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Quy tắc không tồn tại');
    if (rule.type === 'allow_admin' && (await this.adminAllowlistActive())) {
      const ip = normalizeIp(actor.ip);
      const others = (await this.rules()).filter((r) => r.type === 'allow_admin' && r.id !== id);
      if (!others.length) throw new BadRequestException('Đây là IP cuối cùng trong danh sách cho phép. Tắt "Chỉ cho phép IP trong danh sách" trước khi xoá.');
      if (ip && !isLoopbackIp(ip) && !others.some((r) => ipMatchesRule(ip, r.value))) throw new BadRequestException('Xoá quy tắc này sẽ khoá IP bạn đang dùng khỏi trang quản trị');
    }
    await this.prisma.ipRule.delete({ where: { id } });
    this.invalidate();
    this.events.emit('activity', { userId: actor.id, action: rule.type === 'block' ? 'security.ip_unblock' : 'security.ip_disallow', entityType: 'ip_rule', entityId: id, meta: { value: rule.value } });
    return { success: true };
  }

  /** Bật / tắt danh sách cho phép quản trị — bật thì IP đang dùng phải nằm trong danh sách */
  async setAdminAllowlist(enabled: boolean, actor: { id: string; ip?: string | null }) {
    if (enabled) {
      const ip = normalizeIp(actor.ip);
      const allow = (await this.rules()).filter((r) => r.type === 'allow_admin');
      if (!allow.length) throw new BadRequestException('Thêm ít nhất một IP vào danh sách cho phép trước khi bật');
      if (ip && !isLoopbackIp(ip) && !allow.some((r) => ipMatchesRule(ip, r.value))) {
        throw new BadRequestException(`IP bạn đang dùng (${ip}) chưa có trong danh sách — bật lúc này sẽ khoá chính bạn ngoài trang quản trị`);
      }
    }
    await this.settings.update('security', { adminIpAllowlist: enabled }, actor.id);
    this.invalidate();
    return { enabled };
  }

  /** Hệ thống tự chặn IP do đăng nhập sai quá nhiều (không ghi đè quy tắc chặn vĩnh viễn có sẵn) */
  async autoBlock(ipRaw: string, minutes: number, reason: string): Promise<boolean> {
    const ip = normalizeIpRule(normalizeIp(ipRaw));
    // không tự chặn IP nội bộ (thường là proxy chung của mọi người dùng); quản trị viên vẫn chặn tay được
    if (!ip || isPrivateIp(ip)) return false;
    const existing = await this.prisma.ipRule.findUnique({ where: { type_value: { type: 'block', value: ip } } });
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    if (existing && (!existing.expiresAt || existing.expiresAt > expiresAt)) return false;
    await this.prisma.ipRule.upsert({
      where: { type_value: { type: 'block', value: ip } },
      create: { type: 'block', value: ip, note: reason.slice(0, 200), source: 'auto', expiresAt },
      update: { note: reason.slice(0, 200), source: 'auto', expiresAt },
    });
    this.invalidate();
    this.events.emit('activity', { userId: null, action: 'security.ip_autoblock', entityType: 'ip_rule', entityId: ip, ip, meta: { minutes, reason } });
    return true;
  }

  /** Dọn quy tắc đã hết hạn (giữ bảng gọn, danh sách admin chỉ hiện quy tắc còn hiệu lực) */
  @Cron('15 4 * * *')
  async cleanupExpired() {
    if (process.env.NODE_ENV === 'test') return;
    const r = await this.prisma.ipRule.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (r.count) this.logger.log(`Đã dọn ${r.count} quy tắc IP hết hạn`);
  }
}
