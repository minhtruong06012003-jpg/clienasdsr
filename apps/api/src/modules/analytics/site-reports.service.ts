import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { pctChange, periodKeys, toCsv, type Interval, type ResolvedRange } from '../reports/reports.util.js';

type Range = { from: Date; to: Date };
type RangeQuery = { from?: string; to?: string };
type SeriesQuery = RangeQuery & { interval?: Interval };

const n = (v: unknown) => Number(v ?? 0);
const round1 = (v: number) => Math.round(v * 10) / 10;
/** Người xem có quyền (hoặc toàn quyền "*") */
const can = (permissions: string[], perm: string) => permissions.includes('*') || permissions.includes(perm);

/** Nhóm nguồn truy cập theo phiên (lượt xem đầu tiên của phiên) */
const CHANNEL_SQL = Prisma.sql`CASE
  WHEN s."utmMedium" ILIKE '%mail%' OR s."utmSource" ILIKE '%newsletter%' THEN 'email'
  WHEN s."utmSource" IS NOT NULL THEN 'campaign'
  WHEN s."referrerHost" IS NULL THEN 'direct'
  WHEN s."referrerHost" ~* '^(mail|webmail|email)\\.|(^|\\.)(outlook|hotmail|webmail)\\.|^com\\.google\\.android\\.gm$|^com\\.microsoft\\.office\\.outlook' THEN 'email'
  WHEN s."referrerHost" ~* '^(www\\.|m\\.)?(google|bing|yahoo|duckduckgo|yandex|baidu|coccoc|ecosia|naver|seznam|qwant|startpage|search\\.brave)\\.|^search\\.|^com\\.google\\.android\\.googlequicksearchbox' THEN 'search'
  WHEN s."referrerHost" ~* '(^|\\.)(facebook|fb|messenger|instagram|tiktok|zalo|zaloapp|youtube|youtu|twitter|x|linkedin|lnkd|pinterest|reddit|threads|telegram|discord|quora)\\.|^com\\.(zing\\.zalo|facebook\\.|instagram\\.|zhiliaoapp\\.|ss\\.android\\.ugc|twitter\\.|linkedin\\.|pinterest|reddit\\.|google\\.android\\.youtube)' OR s."referrerHost" IN ('t.co', 't.me') THEN 'social'
  ELSE 'referral' END`;

const CHANNEL_LABEL: Record<string, string> = { direct: 'Trực tiếp', search: 'Tìm kiếm', social: 'Mạng xã hội', referral: 'Website giới thiệu', campaign: 'Chiến dịch', email: 'Email' };
const COMMENT_STATUS: Record<string, string> = { APPROVED: 'Đã duyệt', PENDING: 'Chờ duyệt', SPAM: 'Spam', TRASH: 'Thùng rác' };

/**
 * Báo cáo toàn website (Báo cáo › Tổng quan website): truy cập, nội dung, thành viên, tương tác, email.
 * Dùng chung quy ước khoảng thời gian / múi giờ / nhóm kỳ với báo cáo bán hàng (ReportsService).
 *
 * Quy ước truy cập:
 * - Khách = mã ẩn danh đổi mỗi ngày -> trong khoảng nhiều ngày, số khách là tổng khách duy nhất từng ngày.
 * - Phiên = sessionId do trình duyệt tạo (hết hạn sau 30 phút không hoạt động); thoát = phiên chỉ có 1 lượt xem.
 * - Thời lượng phiên = lượt xem cuối - lượt xem đầu (phiên 1 trang = 0 giây).
 * - Nguồn/kênh tính theo lượt xem ĐẦU TIÊN của phiên.
 */
@Injectable()
export class SiteReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly languages: LanguagesService,
  ) {}

  private meta(r: ResolvedRange) {
    return { from: r.fromDay, to: r.toDay, timezone: r.timezone };
  }

  private pv(r: Range, alias = 'pv') {
    return Prisma.sql`${Prisma.raw(alias)}."createdAt" >= ${r.from} AND ${Prisma.raw(alias)}."createdAt" < ${r.to}`;
  }

  /** Ngày đầu kỳ (YYYY-MM-DD) theo múi giờ website của cột thời gian */
  private period(column: string, interval: Interval, tz: string) {
    return Prisma.sql`to_char(date_trunc(${interval}, (${Prisma.raw(column)} AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;
  }

  /** Điền đủ các kỳ (kỳ không có dữ liệu = 0) */
  private fill<K extends string>(r: ResolvedRange, interval: Interval, rows: ({ period: string } & Record<K, unknown>)[], keys: K[]) {
    const map = new Map(rows.map((x) => [x.period, x]));
    return periodKeys(r.fromDay, r.toDay, interval).map((period) => {
      const x = map.get(period);
      return { period, ...(Object.fromEntries(keys.map((k) => [k, n(x?.[k])])) as Record<K, number>) };
    });
  }

  // ------------------------------------------------------------------ Truy cập

  private async trafficSummary(r: Range) {
    const [row] = await this.prisma.$queryRaw<{ pageviews: number; visitors: number; sessions: number; bounces: number; duration: number }[]>`
      WITH s AS (
        SELECT pv."sessionId", COUNT(*) AS views, EXTRACT(EPOCH FROM MAX(pv."createdAt") - MIN(pv."createdAt")) AS secs
        FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1
      )
      SELECT
        (SELECT COUNT(*) FROM page_views pv WHERE ${this.pv(r)})::int AS pageviews,
        (SELECT COUNT(DISTINCT pv."visitorId") FROM page_views pv WHERE ${this.pv(r)})::int AS visitors,
        (SELECT COUNT(*) FROM s)::int AS sessions,
        (SELECT COUNT(*) FROM s WHERE views = 1)::int AS bounces,
        COALESCE((SELECT AVG(secs) FROM s), 0)::float AS duration`;
    const sessions = n(row?.sessions);
    const pageviews = n(row?.pageviews);
    return {
      visitors: n(row?.visitors),
      pageviews,
      sessions,
      bounceRate: sessions ? round1((n(row?.bounces) / sessions) * 100) : 0,
      avgDuration: Math.round(n(row?.duration)),
      pagesPerSession: sessions ? round1(pageviews / sessions) : 0,
    };
  }

  async traffic(q: SeriesQuery) {
    const r = await this.reports.range(q);
    const interval = q.interval ?? 'day';
    const rows = await this.prisma.$queryRaw<{ period: string; visitors: number; pageviews: number; sessions: number }[]>`
      SELECT ${this.period('pv."createdAt"', interval, r.timezone)} AS period,
        COUNT(DISTINCT pv."visitorId")::int AS visitors, COUNT(*)::int AS pageviews, COUNT(DISTINCT pv."sessionId")::int AS sessions
      FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1 ORDER BY 1`;
    return { range: this.meta(r), interval, data: this.fill(r, interval, rows, ['visitors', 'pageviews', 'sessions']) };
  }

  /** Lượt xem theo thứ (0 = Thứ Hai) × giờ, theo múi giờ website */
  async hours(q: RangeQuery) {
    const r = await this.reports.range(q);
    const local = Prisma.sql`((pv."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.timezone})`;
    const rows = await this.prisma.$queryRaw<{ dow: number; hour: number; pageviews: number }[]>`
      SELECT (EXTRACT(ISODOW FROM ${local})::int - 1) AS dow, EXTRACT(HOUR FROM ${local})::int AS hour, COUNT(*)::int AS pageviews
      FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1, 2`;
    return { range: this.meta(r), data: rows.map((x) => ({ dow: n(x.dow), hour: n(x.hour), pageviews: n(x.pageviews) })) };
  }

  /** 5 phút gần nhất */
  async realtime() {
    const r = { from: new Date(Date.now() - 5 * 60_000), to: new Date(Date.now() + 60_000) };
    const [online] = await this.prisma.$queryRaw<{ online: number }[]>`SELECT COUNT(DISTINCT pv."visitorId")::int AS online FROM page_views pv WHERE ${this.pv(r)}`;
    const pages = await this.prisma.$queryRaw<{ path: string; title: string | null; visitors: number }[]>`
      SELECT pv.path, (ARRAY_AGG(pv.title ORDER BY pv."createdAt" DESC))[1] AS title, COUNT(DISTINCT pv."visitorId")::int AS visitors
      FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT 10`;
    const recent = await this.prisma.pageView.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { createdAt: true, path: true, title: true, device: true, browser: true, os: true, referrerHost: true, country: true },
    });
    return { online: n(online?.online), pages: pages.map((x) => ({ ...x, visitors: n(x.visitors) })), recent };
  }

  async pages(q: RangeQuery & { limit?: number; search?: string }) {
    const r = await this.reports.range(q);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const search = q.search?.trim() ? Prisma.sql`AND (pv.path ILIKE ${`%${q.search.trim()}%`} OR pv.title ILIKE ${`%${q.search.trim()}%`})` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ path: string; title: string | null; pageviews: number; visitors: number; entries: number; bounces: number }[]>`
      WITH sc AS (
        SELECT pv."sessionId", COUNT(*) AS views FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1
      ), first AS (
        SELECT DISTINCT ON (pv."sessionId") pv."sessionId", pv.path
        FROM page_views pv WHERE ${this.pv(r)} ORDER BY pv."sessionId", pv."createdAt"
      ), e AS (
        SELECT f.path, COUNT(*) AS entries, COUNT(*) FILTER (WHERE sc.views = 1) AS bounces
        FROM first f JOIN sc ON sc."sessionId" = f."sessionId" GROUP BY 1
      )
      SELECT pv.path,
        (ARRAY_AGG(pv.title ORDER BY pv."createdAt" DESC) FILTER (WHERE pv.title IS NOT NULL))[1] AS title,
        COUNT(*)::int AS pageviews, COUNT(DISTINCT pv."visitorId")::int AS visitors,
        COALESCE(MAX(e.entries), 0)::int AS entries, COALESCE(MAX(e.bounces), 0)::int AS bounces
      FROM page_views pv LEFT JOIN e ON e.path = pv.path
      WHERE ${this.pv(r)} ${search}
      GROUP BY pv.path ORDER BY pageviews DESC, pv.path LIMIT ${limit}`;
    const [totals] = await this.prisma.$queryRaw<{ pageviews: number; visitors: number }[]>`
      SELECT COUNT(*)::int AS pageviews, COUNT(DISTINCT pv."visitorId")::int AS visitors FROM page_views pv WHERE ${this.pv(r)}`;
    return {
      range: this.meta(r),
      data: rows.map((x) => ({
        path: x.path,
        title: x.title,
        pageviews: n(x.pageviews),
        visitors: n(x.visitors),
        entries: n(x.entries),
        bounceRate: n(x.entries) ? round1((n(x.bounces) / n(x.entries)) * 100) : 0,
      })),
      totals: { pageviews: n(totals?.pageviews), visitors: n(totals?.visitors) },
    };
  }

  /** CTE phiên: lượt xem đầu tiên của mỗi phiên trong kỳ */
  private sessionsCte(r: Range) {
    return Prisma.sql`s AS (
      SELECT DISTINCT ON (pv."sessionId") pv."sessionId", pv."visitorId", pv."referrerHost", pv."utmSource", pv."utmMedium", pv."utmCampaign"
      FROM page_views pv WHERE ${this.pv(r)} ORDER BY pv."sessionId", pv."createdAt"
    )`;
  }

  async sources(q: RangeQuery) {
    const r = await this.reports.range(q);
    const [channels, referrers, campaigns] = await Promise.all([
      this.prisma.$queryRaw<{ channel: string; sessions: number; visitors: number }[]>`
        WITH ${this.sessionsCte(r)}
        SELECT ${CHANNEL_SQL} AS channel, COUNT(*)::int AS sessions, COUNT(DISTINCT s."visitorId")::int AS visitors
        FROM s GROUP BY 1 ORDER BY 2 DESC`,
      this.prisma.$queryRaw<{ host: string; sessions: number; visitors: number }[]>`
        WITH ${this.sessionsCte(r)}
        SELECT s."referrerHost" AS host, COUNT(*)::int AS sessions, COUNT(DISTINCT s."visitorId")::int AS visitors
        FROM s WHERE s."referrerHost" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
      this.prisma.$queryRaw<{ source: string; medium: string | null; campaign: string | null; sessions: number; visitors: number }[]>`
        WITH ${this.sessionsCte(r)}
        SELECT s."utmSource" AS source, s."utmMedium" AS medium, s."utmCampaign" AS campaign, COUNT(*)::int AS sessions, COUNT(DISTINCT s."visitorId")::int AS visitors
        FROM s WHERE s."utmSource" IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50`,
    ]);
    const num = <T extends { sessions: number; visitors: number }>(rows: T[]) => rows.map((x) => ({ ...x, sessions: n(x.sessions), visitors: n(x.visitors) }));
    return { range: this.meta(r), channels: num(channels), referrers: num(referrers), campaigns: num(campaigns) };
  }

  async devices(q: RangeQuery) {
    const r = await this.reports.range(q);
    const by = (column: string, fallback: string) =>
      this.prisma.$queryRaw<{ name: string; value: number }[]>`
        SELECT COALESCE(pv.${Prisma.raw(`"${column}"`)}, ${fallback}) AS name, COUNT(DISTINCT pv."visitorId")::int AS value
        FROM page_views pv WHERE ${this.pv(r)} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
    const [devices, browsers, os, countries, locales] = await Promise.all([by('device', 'desktop'), by('browser', 'Khác'), by('os', 'Khác'), by('country', ''), by('locale', '')]);
    // thiết bị trả mã desktop | mobile | tablet, quốc gia mã ISO, ngôn ngữ mã locale — admin tự đổi sang nhãn
    const clean = (rows: { name: string; value: number }[]) => rows.filter((x) => x.name).map((x) => ({ name: x.name, value: n(x.value) }));
    return { range: this.meta(r), devices: clean(devices), browsers: clean(browsers), os: clean(os), countries: clean(countries), locales: clean(locales) };
  }

  // ------------------------------------------------------------------ Nội dung

  private async statusCounts(table: 'pages' | 'posts' | 'products') {
    const rows = await this.prisma.$queryRaw<{ published: number; draft: number; scheduled: number; archived: number; trash: number; total: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND status = 'PUBLISHED')::int AS published,
        COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND status = 'DRAFT')::int AS draft,
        COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND status = 'SCHEDULED')::int AS scheduled,
        COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND status = 'ARCHIVED')::int AS archived,
        COUNT(*) FILTER (WHERE "deletedAt" IS NOT NULL)::int AS trash,
        COUNT(*) FILTER (WHERE "deletedAt" IS NULL)::int AS total
      FROM ${Prisma.raw(table)}`;
    const x = rows[0];
    return { published: n(x?.published), draft: n(x?.draft), scheduled: n(x?.scheduled), archived: n(x?.archived), trash: n(x?.trash), total: n(x?.total) };
  }

  /** Số nội dung xuất bản (publishedAt) trong kỳ */
  private async publishedIn(table: 'pages' | 'posts' | 'products', r: Range) {
    const [row] = await this.prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ${Prisma.raw(table)} WHERE "deletedAt" IS NULL AND status = 'PUBLISHED' AND "publishedAt" >= ${r.from} AND "publishedAt" < ${r.to}`;
    return n(row?.c);
  }

  async content(q: SeriesQuery) {
    const r = await this.reports.range(q);
    const interval = q.interval ?? 'day';
    const locale = await this.languages.defaultLocale();
    const pub = (table: string) => Prisma.sql`
      SELECT ${this.period('"publishedAt"', interval, r.timezone)} AS period, COUNT(*)::int AS c
      FROM ${Prisma.raw(table)} WHERE "deletedAt" IS NULL AND status = 'PUBLISHED' AND "publishedAt" >= ${r.from} AND "publishedAt" < ${r.to} GROUP BY 1`;
    const [pages, posts, products, seriesRows, topPosts, authors, postCategories, productCategories, media, mediaTypes] = await Promise.all([
      this.statusCounts('pages'),
      this.statusCounts('posts'),
      this.statusCounts('products'),
      this.prisma.$queryRaw<{ period: string; pages: number; posts: number; products: number }[]>`
        SELECT period, SUM(pages)::int AS pages, SUM(posts)::int AS posts, SUM(products)::int AS products FROM (
          SELECT period, c AS pages, 0 AS posts, 0 AS products FROM (${pub('pages')}) a
          UNION ALL SELECT period, 0, c, 0 FROM (${pub('posts')}) b
          UNION ALL SELECT period, 0, 0, c FROM (${pub('products')}) d
        ) u GROUP BY 1`,
      this.prisma.$queryRaw<{ id: string; title: string | null; viewCount: number; commentCount: number; publishedAt: Date | null }[]>`
        SELECT p.id, (SELECT t.title FROM post_translations t WHERE t."postId" = p.id ORDER BY (t.locale = ${locale}) DESC, t.locale LIMIT 1) AS title,
          p."viewCount", p."commentCount", p."publishedAt"
        FROM posts p WHERE p."deletedAt" IS NULL AND p.status = 'PUBLISHED' ORDER BY p."viewCount" DESC, p."publishedAt" DESC NULLS LAST LIMIT 10`,
      this.prisma.$queryRaw<{ id: string | null; name: string | null; posts: number }[]>`
        SELECT u.id::text AS id, u.name, COUNT(*)::int AS posts
        FROM posts p LEFT JOIN users u ON u.id = p."authorId"
        WHERE p."deletedAt" IS NULL AND p.status = 'PUBLISHED' AND p."publishedAt" >= ${r.from} AND p."publishedAt" < ${r.to}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      this.prisma.$queryRaw<{ name: string | null; value: number }[]>`
        SELECT (SELECT t.name FROM post_category_translations t WHERE t."categoryId" = c."categoryId" ORDER BY (t.locale = ${locale}) DESC, t.locale LIMIT 1) AS name, COUNT(*)::int AS value
        FROM post_category_on_post c JOIN posts p ON p.id = c."postId"
        WHERE p."deletedAt" IS NULL AND p.status = 'PUBLISHED' GROUP BY c."categoryId" ORDER BY 2 DESC LIMIT 15`,
      this.prisma.$queryRaw<{ name: string | null; value: number }[]>`
        SELECT (SELECT t.name FROM product_category_translations t WHERE t."categoryId" = c."categoryId" ORDER BY (t.locale = ${locale}) DESC, t.locale LIMIT 1) AS name, COUNT(*)::int AS value
        FROM product_category_on_product c JOIN products p ON p.id = c."productId"
        WHERE p."deletedAt" IS NULL AND p.status = 'PUBLISHED' GROUP BY c."categoryId" ORDER BY 2 DESC LIMIT 15`,
      this.prisma.media.aggregate({ where: { deletedAt: null }, _count: { _all: true }, _sum: { size: true } }),
      this.prisma.$queryRaw<{ type: string; count: number; bytes: number }[]>`
        SELECT split_part("mimeType", '/', 1) AS type, COUNT(*)::int AS count, COALESCE(SUM(size), 0)::float AS bytes
        FROM media WHERE "deletedAt" IS NULL GROUP BY 1 ORDER BY 3 DESC`,
    ]);
    return {
      range: this.meta(r),
      interval,
      counts: { pages, posts, products },
      series: this.fill(r, interval, seriesRows, ['pages', 'posts', 'products']),
      topPosts: topPosts.map((x) => ({ id: x.id, title: x.title ?? '(không tiêu đề)', viewCount: n(x.viewCount), commentCount: n(x.commentCount), publishedAt: x.publishedAt })),
      authors: authors.map((x) => ({ id: x.id, name: x.name ?? 'Không rõ tác giả', posts: n(x.posts) })),
      postCategories: postCategories.map((x) => ({ name: x.name ?? '—', value: n(x.value) })),
      productCategories: productCategories.map((x) => ({ name: x.name ?? '—', value: n(x.value) })),
      media: {
        total: media._count._all,
        bytes: n(media._sum.size),
        // trả mã loại (image, video, audio, application, text...) — admin tự đổi sang nhãn tiếng Việt
        byType: mediaTypes.map((x) => ({ name: x.type || 'other', count: n(x.count), bytes: n(x.bytes) })),
      },
    };
  }

  // ------------------------------------------------------------------ Thành viên

  private async newUsers(r: Range) {
    return this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: r.from, lt: r.to } } });
  }

  /** Thành viên có đăng nhập trong kỳ (theo nhật ký auth.login) */
  private async activeUsers(r: Range) {
    const [row] = await this.prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(DISTINCT a."userId")::int AS c FROM activity_logs a JOIN users u ON u.id = a."userId" AND u."deletedAt" IS NULL
      WHERE a.action = 'auth.login' AND a."createdAt" >= ${r.from} AND a."createdAt" < ${r.to}`;
    return n(row?.c);
  }

  /** `recent` (tên + email) chỉ trả khi người xem có quyền users.read */
  async members(q: SeriesQuery, permissions: string[] = []) {
    const r = await this.reports.range(q);
    const interval = q.interval ?? 'day';
    const [totals, newUsers, activeUsers, signups, logins, byRole, recent] = await Promise.all([
      this.prisma.$queryRaw<{ total: number; active: number; inactive: number; banned: number; pending: number; verified: number; twoFactor: number }[]>`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE status = 'INACTIVE')::int AS inactive,
          COUNT(*) FILTER (WHERE status = 'BANNED')::int AS banned,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE "emailVerified" IS NOT NULL)::int AS verified,
          COUNT(*) FILTER (WHERE "twoFactorEnabled")::int AS "twoFactor"
        FROM users WHERE "deletedAt" IS NULL`,
      this.newUsers(r),
      this.activeUsers(r),
      this.prisma.$queryRaw<{ period: string; signups: number }[]>`
        SELECT ${this.period('"createdAt"', interval, r.timezone)} AS period, COUNT(*)::int AS signups
        FROM users WHERE "deletedAt" IS NULL AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1`,
      this.prisma.$queryRaw<{ period: string; logins: number }[]>`
        SELECT ${this.period('"createdAt"', interval, r.timezone)} AS period, COUNT(*)::int AS logins
        FROM activity_logs WHERE action = 'auth.login' AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1`,
      this.prisma.$queryRaw<{ name: string; value: number }[]>`
        SELECT ro.name, COUNT(u.id)::int AS value FROM users u JOIN roles ro ON ro.id = u."roleId"
        WHERE u."deletedAt" IS NULL GROUP BY ro.name ORDER BY 2 DESC`,
      can(permissions, 'users.read')
        ? this.prisma.user.findMany({
        where: { deletedAt: null, createdAt: { gte: r.from, lt: r.to } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, name: true, email: true, createdAt: true, role: { select: { name: true } } },
      })
        : null,
    ]);
    const t = totals[0];
    const loginMap = new Map(logins.map((x) => [x.period, n(x.logins)]));
    const merged = signups.map((x) => ({ ...x, logins: loginMap.get(x.period) ?? 0 }));
    for (const l of logins) if (!signups.some((s) => s.period === l.period)) merged.push({ period: l.period, signups: 0, logins: n(l.logins) });
    return {
      range: this.meta(r),
      interval,
      totals: {
        total: n(t?.total),
        active: n(t?.active),
        inactive: n(t?.inactive),
        banned: n(t?.banned),
        pending: n(t?.pending),
        verified: n(t?.verified),
        twoFactor: n(t?.twoFactor),
        newUsers,
        activeUsers,
      },
      series: this.fill(r, interval, merged, ['signups', 'logins']),
      byRole: byRole.map((x) => ({ name: x.name, value: n(x.value) })),
      recent: recent ? recent.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role.name, createdAt: u.createdAt })) : null,
    };
  }

  // ------------------------------------------------------------------ Tương tác

  private async engagementCounts(r: Range) {
    const [row] = await this.prisma.$queryRaw<{ comments: number; reviews: number; rating: number | null }[]>`
      SELECT
        (SELECT COUNT(*) FROM comments WHERE status NOT IN ('SPAM', 'TRASH') AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to})::int AS comments,
        (SELECT COUNT(*) FROM product_reviews WHERE status NOT IN ('SPAM', 'REJECTED') AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to})::int AS reviews,
        (SELECT AVG(rating) FROM product_reviews WHERE status NOT IN ('SPAM', 'REJECTED') AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to})::float AS rating`;
    return { comments: n(row?.comments), reviews: n(row?.reviews), avgRating: row?.rating == null ? null : round1(Number(row.rating)) };
  }

  async engagement(q: SeriesQuery) {
    const r = await this.reports.range(q);
    const interval = q.interval ?? 'day';
    const locale = await this.languages.defaultLocale();
    const series = (table: string, cond: Prisma.Sql) => Prisma.sql`
      SELECT ${this.period('"createdAt"', interval, r.timezone)} AS period, COUNT(*)::int AS c
      FROM ${Prisma.raw(table)} WHERE ${cond} AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1`;
    const [seriesRows, commentStatus, ratings, topCommented] = await Promise.all([
      this.prisma.$queryRaw<{ period: string; comments: number; reviews: number }[]>`
        SELECT period, SUM(comments)::int AS comments, SUM(reviews)::int AS reviews FROM (
          SELECT period, c AS comments, 0 AS reviews FROM (${series('comments', Prisma.sql`status NOT IN ('SPAM', 'TRASH')`)}) a
          UNION ALL SELECT period, 0, c FROM (${series('product_reviews', Prisma.sql`status NOT IN ('SPAM', 'REJECTED')`)}) b
        ) u GROUP BY 1`,
      this.prisma.$queryRaw<{ status: string; value: number }[]>`
        SELECT status::text AS status, COUNT(*)::int AS value FROM comments WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1 ORDER BY 2 DESC`,
      this.prisma.$queryRaw<{ rating: number; count: number }[]>`
        SELECT rating, COUNT(*)::int AS count FROM product_reviews
        WHERE status NOT IN ('SPAM', 'REJECTED') AND "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1`,
      this.prisma.$queryRaw<{ id: string; title: string | null; comments: number }[]>`
        SELECT c."postId"::text AS id, (SELECT t.title FROM post_translations t WHERE t."postId" = c."postId" ORDER BY (t.locale = ${locale}) DESC, t.locale LIMIT 1) AS title, COUNT(*)::int AS comments
        FROM comments c WHERE c.status = 'APPROVED' AND c."createdAt" >= ${r.from} AND c."createdAt" < ${r.to}
        GROUP BY c."postId" ORDER BY 3 DESC LIMIT 10`,
    ]);
    const ratingMap = new Map(ratings.map((x) => [n(x.rating), n(x.count)]));
    return {
      range: this.meta(r),
      interval,
      series: this.fill(r, interval, seriesRows, ['comments', 'reviews']),
      commentStatus: commentStatus.map((x) => ({ name: COMMENT_STATUS[x.status] ?? x.status, value: n(x.value) })),
      ratings: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: ratingMap.get(rating) ?? 0 })),
      topCommented: topCommented.map((x) => ({ id: x.id, title: x.title ?? '(không tiêu đề)', comments: n(x.comments) })),
    };
  }

  // ------------------------------------------------------------------ Email

  private async emailCounts(r: Range) {
    const [row] = await this.prisma.$queryRaw<{ sent: number; failed: number; skipped: number }[]>`
      SELECT COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped
      FROM email_logs WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to}`;
    return { sent: n(row?.sent), failed: n(row?.failed), skipped: n(row?.skipped) };
  }

  /** `recentFailed` (địa chỉ người nhận, tiêu đề) chỉ trả khi có quyền settings.manage — như nhật ký email gốc */
  async emails(q: SeriesQuery, permissions: string[] = []) {
    const r = await this.reports.range(q);
    const interval = q.interval ?? 'day';
    const [totals, rows, templates, recentFailed] = await Promise.all([
      this.emailCounts(r),
      this.prisma.$queryRaw<{ period: string; sent: number; failed: number }[]>`
        SELECT ${this.period('"createdAt"', interval, r.timezone)} AS period,
          COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
        FROM email_logs WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1`,
      this.prisma.$queryRaw<{ key: string; sent: number; failed: number; skipped: number }[]>`
        SELECT COALESCE("templateKey", '(tuỳ chỉnh)') AS key,
          COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped
        FROM email_logs WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to} GROUP BY 1 ORDER BY 2 DESC, 3 DESC, 4 DESC`,
      can(permissions, 'settings.emails') || can(permissions, 'settings.mail')
        ? this.prisma.emailLog.findMany({
            where: { status: 'FAILED', createdAt: { gte: r.from, lt: r.to } },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { id: true, to: true, subject: true, error: true, createdAt: true },
          })
        : null,
    ]);
    return {
      range: this.meta(r),
      interval,
      totals,
      series: this.fill(r, interval, rows, ['sent', 'failed']),
      templates: templates.map((x) => ({ key: x.key, sent: n(x.sent), failed: n(x.failed), skipped: n(x.skipped) })),
      recentFailed,
    };
  }

  // ------------------------------------------------------------------ Tổng quan

  async overview(q: RangeQuery, permissions: string[]) {
    const r = await this.reports.range(q);
    const prev = { from: r.prevFrom, to: r.prevTo };
    const canSales = can(permissions, 'orders.read');
    const [traffic, trafficPrev, live, pages, posts, products, newPages, newPosts, newProducts, media, totalUsers, newUsers, newUsersPrev, activeUsers, eng, engPrev, pendingComments, emails, sales] =
      await Promise.all([
        this.trafficSummary(r),
        this.trafficSummary(prev),
        this.prisma.$queryRaw<{ c: number }[]>`SELECT COUNT(DISTINCT "visitorId")::int AS c FROM page_views WHERE "createdAt" >= ${new Date(Date.now() - 5 * 60_000)}`,
        this.prisma.page.count({ where: { deletedAt: null, status: 'PUBLISHED' } }),
        this.prisma.post.count({ where: { deletedAt: null, status: 'PUBLISHED' } }),
        this.prisma.product.count({ where: { deletedAt: null, status: 'PUBLISHED' } }),
        this.publishedIn('pages', r),
        this.publishedIn('posts', r),
        this.publishedIn('products', r),
        this.prisma.media.aggregate({ where: { deletedAt: null }, _count: { _all: true }, _sum: { size: true } }),
        this.prisma.user.count({ where: { deletedAt: null } }),
        this.newUsers(r),
        this.newUsers(prev),
        this.activeUsers(r),
        this.engagementCounts(r),
        this.engagementCounts(prev),
        this.prisma.comment.count({ where: { status: 'PENDING' } }),
        this.emailCounts(r),
        canSales ? this.reports.overview({ from: q.from, to: q.to, compare: '1' }) : null,
      ]);
    const keys = ['visitors', 'pageviews', 'sessions', 'bounceRate', 'avgDuration', 'pagesPerSession'] as const;
    return {
      range: this.meta(r),
      traffic,
      // tỉ lệ thoát là một tỉ lệ -> so sánh bằng chênh lệch điểm % (40% -> 50% = +10 điểm), các chỉ số khác dùng % thay đổi
      trafficChange: Object.fromEntries(keys.map((k) => [k, k === 'bounceRate' ? round1(traffic.bounceRate - trafficPrev.bounceRate) : pctChange(traffic[k], trafficPrev[k])])) as Record<(typeof keys)[number], number>,
      online: n(live[0]?.c),
      content: { pages, posts, products, newPages, newPosts, newProducts, media: media._count._all, mediaBytes: n(media._sum.size) },
      members: { total: totalUsers, newUsers, newUsersChange: pctChange(newUsers, newUsersPrev), activeUsers },
      engagement: {
        comments: eng.comments,
        commentsChange: pctChange(eng.comments, engPrev.comments),
        pendingComments,
        reviews: eng.reviews,
        reviewsChange: pctChange(eng.reviews, engPrev.reviews),
        avgRating: eng.avgRating,
      },
      emails: { sent: emails.sent, failed: emails.failed },
      sales: sales
        ? {
            revenue: sales.current.revenue,
            orders: sales.current.orders,
            revenueChange: sales.change?.revenue ?? 0,
            ordersChange: sales.change?.orders ?? 0,
            conversionRate: traffic.sessions ? round1((sales.current.orders / traffic.sessions) * 100) : null,
          }
        : null,
    };
  }

  // ------------------------------------------------------------------ Xuất CSV

  async exportCsv(q: RangeQuery & { report: 'traffic' | 'pages' | 'sources'; interval?: Interval }) {
    const r = await this.reports.range(q);
    const suffix = `${r.fromDay}_${r.toDay}`;
    if (q.report === 'traffic') {
      const { data } = await this.traffic(q);
      return { filename: `truy-cap-${suffix}.csv`, content: toCsv(['Kỳ', 'Khách', 'Lượt xem', 'Phiên'], data.map((x) => [x.period, x.visitors, x.pageviews, x.sessions])) };
    }
    if (q.report === 'pages') {
      const { data } = await this.pages({ ...q, limit: 500 });
      return {
        filename: `trang-xem-nhieu-${suffix}.csv`,
        content: toCsv(['Đường dẫn', 'Tiêu đề', 'Lượt xem', 'Khách', 'Lượt vào', 'Tỉ lệ thoát (%)'], data.map((x) => [x.path, x.title, x.pageviews, x.visitors, x.entries, x.bounceRate])),
      };
    }
    const { channels, referrers, campaigns } = await this.sources(q);
    const rows: unknown[][] = [
      ...channels.map((x) => ['Kênh', CHANNEL_LABEL[x.channel] ?? x.channel, '', '', x.sessions, x.visitors]),
      ...referrers.map((x) => ['Website giới thiệu', x.host, '', '', x.sessions, x.visitors]),
      ...campaigns.map((x) => ['Chiến dịch', x.source, x.medium, x.campaign, x.sessions, x.visitors]),
    ];
    return { filename: `nguon-truy-cap-${suffix}.csv`, content: toCsv(['Loại', 'Nguồn', 'Medium', 'Campaign', 'Phiên', 'Khách'], rows) };
  }
}
