import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { isChildSite } from '../../common/utils/tenant.js';
import { esc, sendMessage } from '../telegram/telegram.api.js';
import { parseChatIds, type TelegramAdminSettings } from '../telegram/telegram.service.js';

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEFAULT_VPS_IP = '103.200.22.81';

export interface ChildPanelsConfig {
  enabled: boolean;
  vpsIp: string;
  price: number;
  minDeposit: number;
  autoApprove: boolean;
  maxPerUser: number;
}

class CreateChildPanelDto {
  @IsString()
  @MaxLength(253)
  domain!: string;

  @IsString()
  @MaxLength(80)
  siteName!: string;

  @IsEmail({}, { message: 'Email admin web con không hợp lệ' })
  @MaxLength(160)
  adminEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  adminName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminPassword?: string;
}

class UpdateChildPanelConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(64) vpsIp?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minDeposit?: number;
  @IsOptional() @IsBoolean() autoApprove?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) maxPerUser?: number;
}

class ApproveChildPanelDto {
  @IsOptional() @IsBoolean() autoProvision?: boolean;
  @IsOptional() @IsString() @MaxLength(20) siteCode?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class RejectChildPanelDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class AdminCreateChildPanelDto {
  @IsString()
  @MaxLength(253)
  domain!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  siteCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  siteName?: string;

  @IsEmail({}, { message: 'Email admin web con không hợp lệ' })
  @MaxLength(160)
  adminEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  adminName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  ownerEmail?: string;

  @IsOptional()
  @IsBoolean()
  skipDnsCheck?: boolean;
}

interface ChildPanelRow {
  id: string;
  user_id: string;
  domain: string;
  site_name: string;
  admin_email: string;
  admin_name: string;
  admin_password: string;
  site_code: string | null;
  hub_job_id: string | null;
  fee: string | number;
  status: 'PENDING' | 'PROVISIONING' | 'ACTIVE' | 'REJECTED' | 'FAILED';
  note: string | null;
  created_at: Date;
  updated_at: Date;
  user_email?: string;
  user_name?: string;
}

function normalizeDomain(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

function generateStrongPassword(): string {
  return randomBytes(10).toString('base64url').slice(0, 14);
}

function readHubEnv(): { port: number; secret: string } | null {
  const file = '/var/www/novai-hub/hub.env';
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    const env: Record<string, string> = {};
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && /^(".*"|'.*')$/s.test(v)) v = v.slice(1, -1);
      env[m[1]] = v;
    }
    if (!env.HUB_SESSION_SECRET) return null;
    return { port: Number(env.HUB_PORT || 4900), secret: env.HUB_SESSION_SECRET };
  } catch {
    return null;
  }
}

interface HubSiteRecord {
  code: string;
  domain: string;
  name?: string;
  adminEmail?: string;
  status?: string;
  ssl?: boolean;
  createdAt?: string;
}

function existingHubSites(): HubSiteRecord[] {
  const file = '/var/www/novai-hub/data/sites.json';
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw?.sites ?? [];
    return list.map((s: Record<string, unknown>) => ({
      code: String(s.code ?? '').toLowerCase(),
      domain: String(s.domain ?? '').toLowerCase(),
      name: typeof s.name === 'string' ? s.name : undefined,
      adminEmail: typeof s.adminEmail === 'string' ? s.adminEmail : undefined,
      status: typeof s.status === 'string' ? s.status : undefined,
      ssl: Boolean(s.ssl),
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : undefined,
    }));
  } catch {
    return [];
  }
}

@Injectable()
export class ChildPanelsService implements OnModuleInit {
  private readonly logger = new Logger('ChildPanels');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
  ) {}

  async onModuleInit() {
    if (isChildSite()) return;
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS child_panel_requests (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          domain TEXT NOT NULL,
          site_name TEXT NOT NULL,
          admin_email TEXT NOT NULL,
          admin_name TEXT NOT NULL,
          admin_password TEXT NOT NULL,
          site_code TEXT,
          hub_job_id TEXT,
          fee NUMERIC(15, 2) NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'PENDING',
          note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_child_panel_requests_user ON child_panel_requests(user_id, created_at DESC);`);
      await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_child_panel_requests_domain ON child_panel_requests(domain);`);
    } catch (err) {
      this.logger.error(`Khởi tạo bảng child_panel_requests lỗi: ${(err as Error).message}`);
    }
  }

  async getConfig(): Promise<ChildPanelsConfig> {
    const raw = await this.settings.get<Partial<ChildPanelsConfig>>('child_panels');
    return {
      enabled: raw.enabled !== false,
      vpsIp: (raw.vpsIp || DEFAULT_VPS_IP).trim() || DEFAULT_VPS_IP,
      price: Math.max(0, Math.round(Number(raw.price) || 0)),
      minDeposit: Math.max(0, Math.round(Number(raw.minDeposit) || 0)),
      autoApprove: raw.autoApprove === true,
      maxPerUser: Math.max(1, Math.round(Number(raw.maxPerUser) || 5)),
    };
  }

  async updateConfig(dto: UpdateChildPanelConfigDto): Promise<ChildPanelsConfig> {
    if (isChildSite()) throw new ForbiddenException('Chỉ website chính mới quản lý cấu hình Website con');
    const cur = await this.getConfig();
    const next: ChildPanelsConfig = {
      enabled: dto.enabled ?? cur.enabled,
      vpsIp: dto.vpsIp !== undefined ? dto.vpsIp.trim() || DEFAULT_VPS_IP : cur.vpsIp,
      price: dto.price !== undefined ? Math.max(0, Math.round(dto.price)) : cur.price,
      minDeposit: dto.minDeposit !== undefined ? Math.max(0, Math.round(dto.minDeposit)) : cur.minDeposit,
      autoApprove: dto.autoApprove ?? cur.autoApprove,
      maxPerUser: dto.maxPerUser !== undefined ? Math.max(1, Math.round(dto.maxPerUser)) : cur.maxPerUser,
    };
    await this.settings.update('child_panels', next as unknown as Record<string, unknown>);
    return next;
  }

  async checkDns(rawDomain: string) {
    const domain = normalizeDomain(rawDomain);
    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Domain không hợp lệ (ví dụ hợp lệ: vidu.com, không có https:// hay www)');
    }
    const cfg = await this.getConfig();
    let ips: string[] = [];
    let wwwIps: string[] = [];
    let error: string | null = null;
    try {
      ips = await dns.resolve4(domain);
    } catch (err) {
      error = (err as { code?: string }).code || (err as Error).message;
    }
    try {
      wwwIps = await dns.resolve4(`www.${domain}`);
    } catch {
      wwwIps = [];
    }
    return {
      domain,
      vpsIp: cfg.vpsIp,
      ok: ips.includes(cfg.vpsIp),
      ips,
      wwwOk: wwwIps.includes(cfg.vpsIp),
      wwwIps,
      error,
    };
  }

  private async userTotalDeposit(userId: string): Promise<number> {
    const agg = await this.prisma.paymentTransaction.aggregate({
      where: { userId, status: 'PAID' },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  private presentRow(r: ChildPanelRow) {
    return {
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      domain: r.domain,
      siteName: r.site_name,
      adminEmail: r.admin_email,
      adminName: r.admin_name,
      adminPassword: r.admin_password,
      siteCode: r.site_code,
      hubJobId: r.hub_job_id,
      fee: Number(r.fee ?? 0),
      status: r.status,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async myPanels(userId: string) {
    if (isChildSite()) {
      return {
        config: { enabled: false, vpsIp: DEFAULT_VPS_IP, price: 0, minDeposit: 0, autoApprove: false, maxPerUser: 1 },
        totalDeposited: 0,
        items: [],
      };
    }
    const [config, totalDeposited, rows] = await Promise.all([
      this.getConfig(),
      this.userTotalDeposit(userId),
      this.prisma.$queryRaw<ChildPanelRow[]>`
        SELECT * FROM child_panel_requests
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
      `,
    ]);
    return {
      config,
      totalDeposited,
      items: rows.map((r) => this.presentRow(r)),
    };
  }

  async create(user: AuthUser, dto: CreateChildPanelDto) {
    if (isChildSite()) throw new ForbiddenException('Tính năng tạo Website con chỉ khả dụng trên website chính');
    const cfg = await this.getConfig();
    if (!cfg.enabled) throw new BadRequestException('Tính năng đăng ký Website con hiện đang tạm đóng');

    const domain = normalizeDomain(dto.domain);
    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Domain không hợp lệ (nhập dạng vidu.com, không có www và không có https://)');
    }
    if (domain === 'nov.ai.vn' || domain.endsWith('.nov.ai.vn')) {
      throw new BadRequestException('Vui lòng sử dụng tên miền riêng của bạn');
    }

    const siteName = dto.siteName.trim() || domain;
    const adminEmail = dto.adminEmail.trim().toLowerCase();
    const adminName = (dto.adminName ?? '').trim() || 'Quản trị viên';
    const rawPw = (dto.adminPassword ?? '').trim();
    if (rawPw && rawPw.length < 10) {
      throw new BadRequestException('Mật khẩu admin tự đặt cần tối thiểu 10 ký tự (hoặc để trống để hệ thống tự sinh)');
    }
    const adminPassword = rawPw || generateStrongPassword();

    // Kiểm tra trùng domain trên Hub hoặc trong danh sách đang hoạt động / chờ duyệt
    const hubSites = existingHubSites();
    if (hubSites.some((s) => s.domain === domain)) {
      throw new BadRequestException(`Tên miền ${domain} đã được sử dụng trên hệ thống`);
    }
    const dup = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_panel_requests
      WHERE domain = ${domain} AND status NOT IN ('REJECTED')
      LIMIT 1
    `;
    if (dup.length) {
      throw new BadRequestException(`Tên miền ${domain} đã được đăng ký trước đó`);
    }

    // Giới hạn số lượng website con mỗi tài khoản
    const countRows = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*)::bigint AS cnt FROM child_panel_requests
      WHERE user_id = ${user.id}::uuid AND status NOT IN ('REJECTED')
    `;
    if (Number(countRows[0]?.cnt ?? 0) >= cfg.maxPerUser) {
      throw new BadRequestException(`Mỗi tài khoản tối đa ${cfg.maxPerUser} website con`);
    }

    // Kiểm tra tổng nạp tối thiểu (nếu admin cấu hình)
    if (cfg.minDeposit > 0) {
      const deposited = await this.userTotalDeposit(user.id);
      if (deposited < cfg.minDeposit) {
        throw new BadRequestException(
          `Tài khoản cần tổng nạp tối thiểu ${cfg.minDeposit.toLocaleString('vi-VN')}đ để tạo Website con (hiện tại: ${deposited.toLocaleString('vi-VN')}đ)`,
        );
      }
    }

    // Kiểm tra bản ghi A của domain đã trỏ về IP VPS chưa
    const dnsRes = await this.checkDns(domain);
    if (!dnsRes.ok) {
      const curIps = dnsRes.ips.length ? dnsRes.ips.join(', ') : 'chưa có bản ghi A';
      throw new BadRequestException(
        `Domain ${domain} chưa trỏ bản ghi A về ${cfg.vpsIp} (hiện tại: ${curIps}). Vui lòng trỏ bản ghi A về ${cfg.vpsIp} và đợi vài phút cập nhật DNS rồi bấm lại!`,
      );
    }

    const id = randomUUID();
    let walletTxn: Awaited<ReturnType<WalletService['apply']>> | undefined;
    await this.prisma.$transaction(async (db) => {
      if (cfg.price > 0) {
        walletTxn = await this.wallet.apply(db, {
          userId: user.id,
          type: 'WITHDRAW',
          amount: -cfg.price,
          note: `Phí khởi tạo Website con (${domain})`,
          meta: { source: 'child_panel', childPanelId: id, domain },
        });
      }
      await db.$executeRaw`
        INSERT INTO child_panel_requests (id, user_id, domain, site_name, admin_email, admin_name, admin_password, fee, status, created_at, updated_at)
        VALUES (${id}::uuid, ${user.id}::uuid, ${domain}, ${siteName}, ${adminEmail}, ${adminName}, ${adminPassword}, ${cfg.price}, 'PENDING', NOW(), NOW())
      `;
    });
    if (walletTxn) await this.wallet.afterChange(walletTxn);

    void this.notifyAdminTelegram({ domain, siteName, adminEmail, userEmail: user.email, autoApprove: cfg.autoApprove });

    if (cfg.autoApprove) {
      try {
        return await this.approve(id, { autoProvision: true });
      } catch (err) {
        this.logger.warn(`Tự động khởi tạo ${domain} lỗi, giữ trạng thái chờ xử lý: ${(err as Error).message}`);
      }
    }

    const rows = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    return this.presentRow(rows[0]);
  }

  private async notifyAdminTelegram(info: { domain: string; siteName: string; adminEmail: string; userEmail: string; autoApprove: boolean }) {
    try {
      const tg = await this.settings.get<TelegramAdminSettings>('telegram_admin');
      if (!tg.enabled || !tg.botToken) return;
      const chats = parseChatIds(tg.chatIds);
      if (!chats.length) return;
      const text =
        `🌐 <b>Yêu cầu tạo Website con mới</b>\n` +
        `• Domain: <code>${esc(info.domain)}</code>\n` +
        `• Tên web: <b>${esc(info.siteName)}</b>\n` +
        `• Email admin: <code>${esc(info.adminEmail)}</code>\n` +
        `• Người gửi: <code>${esc(info.userEmail)}</code>\n` +
        `• Chế độ: ${info.autoApprove ? 'Đang tự động khởi tạo qua Hub' : 'Chờ duyệt trong Admin › Website con'}`;
      for (const chatId of chats) {
        await sendMessage(tg.botToken, chatId, text).catch(() => undefined);
      }
    } catch {
      /* bỏ qua lỗi thông báo phụ */
    }
  }

  // ---------------- Admin ----------------

  async adminList(status?: string) {
    if (isChildSite()) throw new ForbiddenException('Chỉ website chính mới quản lý Website con');
    const [config, rows] = await Promise.all([
      this.getConfig(),
      status
        ? this.prisma.$queryRaw<ChildPanelRow[]>`
            SELECT r.*, u.email AS user_email, u.name AS user_name
            FROM child_panel_requests r
            LEFT JOIN users u ON u.id = r.user_id
            WHERE r.status = ${status}
            ORDER BY r.created_at DESC
          `
        : this.prisma.$queryRaw<ChildPanelRow[]>`
            SELECT r.*, u.email AS user_email, u.name AS user_name
            FROM child_panel_requests r
            LEFT JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
          `,
    ]);
    const items = rows.map((r) => this.presentRow(r));
    const knownDomains = new Set(items.map((x) => x.domain.toLowerCase()));
    for (const hs of existingHubSites()) {
      if (!hs.domain || knownDomains.has(hs.domain)) continue;
      const mappedStatus: 'ACTIVE' | 'PENDING' = hs.status === 'active' ? 'ACTIVE' : 'PENDING';
      if (status && status !== mappedStatus) continue;
      items.push({
        id: `hub-${hs.code}`,
        userId: '',
        userEmail: 'Khởi tạo từ NovAI Hub',
        userName: 'Quản trị hệ thống',
        domain: hs.domain,
        siteName: hs.name || hs.domain,
        adminEmail: hs.adminEmail || '—',
        adminName: 'Admin',
        adminPassword: '',
        siteCode: hs.code,
        hubJobId: null,
        fee: 0,
        status: mappedStatus,
        note: hs.ssl ? 'Đang hoạt động trên NovAI Hub (HTTPS sẵn sàng)' : 'Đang hoạt động trên NovAI Hub (chưa bật SSL)',
        createdAt: hs.createdAt ? new Date(hs.createdAt) : new Date(0),
        updatedAt: hs.createdAt ? new Date(hs.createdAt) : new Date(0),
      });
    }
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      config,
      hubAvailable: !!readHubEnv(),
      items,
    };
  }

  async adminCreate(actor: AuthUser, dto: AdminCreateChildPanelDto) {
    if (isChildSite()) throw new ForbiddenException('Chỉ website chính mới khởi tạo Website con');
    const cfg = await this.getConfig();
    const domain = normalizeDomain(dto.domain);
    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Domain không hợp lệ (nhập dạng vidu.com, không có www và không có https://)');
    }
    if (domain === 'nov.ai.vn') {
      throw new BadRequestException('Không thể trùng tên miền chính nov.ai.vn');
    }

    const preferredCode = (dto.siteCode ?? '').trim().toLowerCase();
    if (preferredCode && !/^[a-z][a-z0-9]{1,19}$/.test(preferredCode)) {
      throw new BadRequestException('Mã web con chỉ gồm chữ thường và số, bắt đầu bằng chữ cái (2–20 ký tự)');
    }

    const hubSites = existingHubSites();
    if (hubSites.some((s) => s.domain === domain)) {
      throw new BadRequestException(`Tên miền ${domain} đã tồn tại trên hệ thống`);
    }
    if (preferredCode && hubSites.some((s) => s.code === preferredCode)) {
      throw new BadRequestException(`Mã web con "${preferredCode}" đã được dùng bởi website con khác`);
    }
    const dup = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_panel_requests
      WHERE domain = ${domain} AND status NOT IN ('REJECTED')
      LIMIT 1
    `;
    if (dup.length) {
      throw new BadRequestException(`Tên miền ${domain} đã có trong danh sách yêu cầu`);
    }

    if (!dto.skipDnsCheck) {
      const dnsRes = await this.checkDns(domain);
      if (!dnsRes.ok) {
        const curIps = dnsRes.ips.length ? dnsRes.ips.join(', ') : 'chưa có bản ghi A';
        throw new BadRequestException(
          `Domain ${domain} chưa trỏ bản ghi A về ${cfg.vpsIp} (hiện tại: ${curIps}). Hãy trỏ bản ghi A về ${cfg.vpsIp} hoặc tích "Vẫn khởi tạo khi DNS đang cập nhật".`,
        );
      }
    }

    let targetUserId = actor.id;
    const ownerEmail = (dto.ownerEmail ?? '').trim().toLowerCase();
    if (ownerEmail) {
      const foundUser = await this.prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } });
      if (!foundUser) {
        throw new BadRequestException(`Không tìm thấy thành viên có email "${ownerEmail}" trên nov.ai.vn`);
      }
      targetUserId = foundUser.id;
    }

    const siteName = (dto.siteName ?? '').trim() || domain;
    const adminEmail = dto.adminEmail.trim().toLowerCase();
    const adminName = (dto.adminName ?? '').trim() || 'Quản trị viên';
    const rawPw = (dto.adminPassword ?? '').trim();
    if (rawPw && rawPw.length < 10) {
      throw new BadRequestException('Mật khẩu admin tự đặt cần tối thiểu 10 ký tự (hoặc để trống để tự sinh)');
    }
    const adminPassword = rawPw || generateStrongPassword();
    const siteCode = this.buildUniqueSiteCode(domain, preferredCode || undefined);
    const id = randomUUID();

    await this.prisma.$executeRaw`
      INSERT INTO child_panel_requests (id, user_id, domain, site_name, admin_email, admin_name, admin_password, site_code, fee, status, note, created_at, updated_at)
      VALUES (${id}::uuid, ${targetUserId}::uuid, ${domain}, ${siteName}, ${adminEmail}, ${adminName}, ${adminPassword}, ${siteCode}, 0, 'PENDING', 'Khởi tạo trực tiếp từ Admin', NOW(), NOW())
    `;

    if (readHubEnv()) {
      return this.approve(id, { autoProvision: true, siteCode });
    }
    const created = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    return this.presentRow(created[0]);
  }

  private buildUniqueSiteCode(domain: string, preferred?: string): string {
    const used = new Set(existingHubSites().map((s) => s.code));
    const rawBase = (preferred?.trim() || domain.split('.')[0] || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    let base = /^[a-z]/.test(rawBase) ? rawBase : `w${rawBase}`;
    if (base.length < 2) base = `${base}web`;
    base = base.slice(0, 16);
    if (!used.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base.slice(0, 16)}${i}`.slice(0, 20);
      if (!used.has(candidate)) return candidate;
    }
    return `w${randomBytes(4).toString('hex')}`;
  }

  async approve(id: string, dto: ApproveChildPanelDto) {
    if (isChildSite()) throw new ForbiddenException('Chỉ website chính mới quản lý Website con');
    const rows = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Không tìm thấy yêu cầu tạo Website con');
    if (row.status === 'ACTIVE') throw new BadRequestException('Website con này đã ở trạng thái hoạt động');

    if (!dto.autoProvision) {
      const note = dto.note?.trim() || 'Đã kích hoạt Website con';
      await this.prisma.$executeRaw`
        UPDATE child_panel_requests
        SET status = 'ACTIVE', note = ${note}, updated_at = NOW()
        WHERE id = ${id}::uuid
      `;
      const updated = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
      return this.presentRow(updated[0]);
    }

    const hub = readHubEnv();
    if (!hub) {
      throw new BadRequestException('Không tìm thấy cấu hình NovAI Hub (/var/www/novai-hub/hub.env) trên máy chủ');
    }
    const siteCode = this.buildUniqueSiteCode(row.domain, dto.siteCode);
    const res = await fetch(`http://127.0.0.1:${hub.port}/internal/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Secret': hub.secret,
      },
      body: JSON.stringify({
        code: siteCode,
        domain: row.domain,
        name: row.site_name,
        adminEmail: row.admin_email,
        adminName: row.admin_name,
        adminPassword: row.admin_password,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; jobId?: string; error?: string };
    if (!res.ok || !data.ok || !data.jobId) {
      throw new BadRequestException(data.error || `NovAI Hub từ chối khởi tạo (HTTP ${res.status})`);
    }

    await this.prisma.$executeRaw`
      UPDATE child_panel_requests
      SET status = 'PROVISIONING', site_code = ${siteCode}, hub_job_id = ${data.jobId}, note = 'Đang khởi tạo tự động database, PM2, Nginx & SSL...', updated_at = NOW()
      WHERE id = ${id}::uuid
    `;

    void this.watchHubJob(id, hub, data.jobId);
    const updated = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    return this.presentRow(updated[0]);
  }

  private async watchHubJob(requestId: string, hub: { port: number; secret: string }, jobId: string) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(`http://127.0.0.1:${hub.port}/internal/job/${encodeURIComponent(jobId)}`, {
          headers: { 'X-Hub-Secret': hub.secret },
        });
        if (!res.ok) continue;
        const job = (await res.json()) as { status?: string; lines?: string[] };
        if (job.status === 'done') {
          await this.prisma.$executeRaw`
            UPDATE child_panel_requests
            SET status = 'ACTIVE', note = 'Đã khởi tạo hoàn tất (HTTPS + Trang quản trị sẵn sàng)', updated_at = NOW()
            WHERE id = ${requestId}::uuid
          `;
          return;
        }
        if (job.status === 'failed') {
          const lastErr = (job.lines ?? []).slice(-3).join(' | ').slice(0, 450) || 'Lỗi trong quá trình khởi tạo trên Hub';
          await this.prisma.$executeRaw`
            UPDATE child_panel_requests
            SET status = 'FAILED', note = ${lastErr}, updated_at = NOW()
            WHERE id = ${requestId}::uuid
          `;
          return;
        }
      } catch {
        /* tiếp tục hỏi lại */
      }
    }
  }

  async reject(id: string, dto: RejectChildPanelDto) {
    if (isChildSite()) throw new ForbiddenException('Chỉ website chính mới quản lý Website con');
    const rows = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Không tìm thấy yêu cầu');
    if (row.status === 'REJECTED') throw new BadRequestException('Yêu cầu này đã bị từ chối trước đó');

    const fee = Number(row.fee ?? 0);
    const note = dto.note?.trim() || (fee > 0 ? 'Từ chối yêu cầu — đã hoàn phí về ví' : 'Từ chối yêu cầu');
    let refundTxn: Awaited<ReturnType<WalletService['apply']>> | undefined;
    await this.prisma.$transaction(async (db) => {
      if (fee > 0 && row.status !== 'ACTIVE') {
        refundTxn = await this.wallet.apply(db, {
          userId: row.user_id,
          type: 'REFUND',
          amount: fee,
          note: `Hoàn phí tạo Website con (${row.domain})`,
          meta: { source: 'child_panel_refund', childPanelId: id, domain: row.domain },
        });
      }
      await db.$executeRaw`
        UPDATE child_panel_requests
        SET status = 'REJECTED', note = ${note}, updated_at = NOW()
        WHERE id = ${id}::uuid
      `;
    });
    if (refundTxn) await this.wallet.afterChange(refundTxn);
    const updated = await this.prisma.$queryRaw<ChildPanelRow[]>`SELECT * FROM child_panel_requests WHERE id = ${id}::uuid LIMIT 1`;
    return this.presentRow(updated[0]);
  }
}

@Controller('account/child-panels')
export class AccountChildPanelsController {
  constructor(private readonly service: ChildPanelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.myPanels(user.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('check-dns')
  checkDns(@Query('domain') domain = '') {
    return this.service.checkDns(domain);
  }

  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateChildPanelDto) {
    return this.service.create(user, dto);
  }
}

@Controller('admin/child-panels')
@RequirePermissions('settings.manage')
export class AdminChildPanelsController {
  constructor(private readonly service: ChildPanelsService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.service.adminList(status);
  }

  @Get('check-dns')
  checkDns(@Query('domain') domain = '') {
    return this.service.checkDns(domain);
  }

  @Post()
  adminCreate(@CurrentUser() user: AuthUser, @Body() dto: AdminCreateChildPanelDto) {
    return this.service.adminCreate(user, dto);
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateChildPanelConfigDto) {
    return this.service.updateConfig(dto);
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveChildPanelDto) {
    return this.service.approve(id, dto);
  }

  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectChildPanelDto) {
    return this.service.reject(id, dto);
  }
}

@Module({
  controllers: [AccountChildPanelsController, AdminChildPanelsController],
  providers: [ChildPanelsService],
  exports: [ChildPanelsService],
})
export class ChildPanelsModule {}
