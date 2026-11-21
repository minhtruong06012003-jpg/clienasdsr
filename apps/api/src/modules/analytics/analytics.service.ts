import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CronService } from '../scheduler/cron.service.js';
import { isValidTimezone, localDay } from '../reports/reports.util.js';
import { clip, isBot, isExcludedPath, normalizePath, parseUserAgent, referrerHost, visitorHash } from './analytics.util.js';
import type { TrackDto } from './analytics.dto.js';

export interface AnalyticsSettings {
  enabled?: boolean;
  excludeAdmins?: boolean;
  respectDnt?: boolean;
  excludePaths?: string;
  retentionDays?: number;
}

export interface TrackMeta {
  ip?: string;
  userAgent?: string;
  /** mã quốc gia từ CDN (cf-ipcountry, x-vercel-ip-country...) */
  country?: string;
  /** header Origin của storefront — để bỏ referrer nội bộ */
  origin?: string;
}

/** Ghi nhận lượt xem trang storefront + dọn dữ liệu cũ theo cài đặt lưu trữ */
@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    private readonly cron: CronService,
  ) {}

  onModuleInit() {
    // 03:30 mỗi ngày xoá lượt xem quá hạn (chỉ khi người quản trị đặt retentionDays > 0)
    this.cron.add('cleanup', '30 3 * * *', () => this.cleanup(), 'analytics');
  }

  /** Bí mật để băm mã khách — không lộ ra ngoài, đổi bí mật = mọi mã khách đổi theo */
  private secret() {
    return process.env.ANALYTICS_SALT || this.config.get<string>('jwt.accessSecret') || 'cmsnt-analytics';
  }

  private async timezone() {
    const general = await this.settings.get<{ timezone?: string }>('general');
    return isValidTimezone(general.timezone) ? general.timezone : 'Asia/Ho_Chi_Minh';
  }

  /** Ghi 1 lượt xem; trả về false nếu bị bỏ qua (tắt thống kê, bot, đường dẫn loại trừ...) */
  async track(dto: TrackDto, meta: TrackMeta): Promise<boolean> {
    const cfg = await this.settings.get<AnalyticsSettings>('analytics');
    if (cfg.enabled === false) return false;
    const ua = meta.userAgent ?? '';
    if (isBot(ua)) return false;
    const path = normalizePath(dto.path);
    if (!path || isExcludedPath(path, cfg.excludePaths)) return false;

    let siteHost: string | null = null;
    try {
      siteHost = meta.origin ? new URL(meta.origin).hostname : null;
    } catch {
      siteHost = null;
    }
    const tz = await this.timezone();
    const visitorId = visitorHash(this.secret(), localDay(new Date(), tz), meta.ip ?? '', ua);
    const { device, browser, os } = parseUserAgent(ua);
    const country = clip(meta.country, 2)?.toUpperCase() ?? null;

    await this.prisma.pageView.create({
      data: {
        path,
        title: clip(dto.title, 300),
        locale: clip(dto.locale, 10),
        visitorId,
        sessionId: clip(dto.sid, 64) ?? visitorId,
        isEntry: !!dto.entry,
        referrerHost: referrerHost(dto.referrer, siteHost),
        referrer: referrerHost(dto.referrer, siteHost) ? clip(dto.referrer, 1000) : null,
        utmSource: clip(dto.utmSource, 100)?.toLowerCase() ?? null,
        utmMedium: clip(dto.utmMedium, 100)?.toLowerCase() ?? null,
        utmCampaign: clip(dto.utmCampaign, 150),
        device,
        browser,
        os,
        // XX/T1 = không xác định / Tor (Cloudflare)
        country: country && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null,
      },
    });
    return true;
  }

  /** Xoá lượt xem cũ hơn `retentionDays` ngày */
  async cleanup() {
    const cfg = await this.settings.get<AnalyticsSettings>('analytics');
    const days = Math.floor(Number(cfg.retentionDays) || 0);
    if (days <= 0) return { deleted: 0 };
    const before = new Date(Date.now() - days * 86400_000);
    const { count } = await this.prisma.pageView.deleteMany({ where: { createdAt: { lt: before } } });
    if (count) this.logger.log(`Đã xoá ${count} lượt xem cũ hơn ${days} ngày`);
    return { deleted: count };
  }
}
