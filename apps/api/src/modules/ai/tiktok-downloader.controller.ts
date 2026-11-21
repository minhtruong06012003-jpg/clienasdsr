import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Public } from '../../common/decorators/public.decorator.js';
import { ImportUrlDto } from './ai.dto.js';

/** Header Content-Disposition chuẩn RFC 6266 (ASCII fallback + UTF-8) */
function attachmentDisposition(fileName: string): string {
  const ascii =
    fileName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^\x20-\x7E]+/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'download';
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Chặn địa chỉ IPv4 nội bộ / đặc biệt */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function assertSafeHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException('Liên kết nguồn không hợp lệ');
  }
  if (u.protocol !== 'https:' || !u.hostname || u.hostname === 'localhost') {
    throw new BadRequestException('Liên kết nguồn bị từ chối');
  }
  const ipKind = isIP(u.hostname);
  if (ipKind === 6 || (ipKind === 4 && isPrivateIpv4(u.hostname))) {
    throw new BadRequestException('Địa chỉ nguồn bị từ chối');
  }
  return u;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Mở kết nối HTTPS ép IPv4 (`family: 4`) và tự động theo tối đa 5 bước redirect 3xx.
 * Máy chủ VPS không định tuyến IPv6 ra Cloudflare nên dùng `node:https` family=4 thay cho `fetch` mặc định để không bao giờ treo TLS.
 */
function openHttpsStreamIpv4(
  rawUrl: string,
  opts: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: Buffer;
    timeoutMs?: number;
    redirectsLeft?: number;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; stream: IncomingMessage; destroy: () => void }> {
  const u = assertSafeHttpsUrl(rawUrl);
  const redirectsLeft = opts.redirectsLeft ?? 5;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const method = opts.method ?? 'GET';

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method,
        family: 4,
        headers: {
          'User-Agent': UA,
          ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && redirectsLeft > 0) {
          res.resume();
          let nextUrl: string;
          try {
            nextUrl = new URL(loc, u).toString();
          } catch (e) {
            settled = true;
            reject(e);
            return;
          }
          settled = true;
          const nextHeaders = { ...(opts.headers ?? {}) };
          delete nextHeaders['Content-Type'];
          delete nextHeaders['Content-Length'];
          openHttpsStreamIpv4(nextUrl, {
            method: status === 303 ? 'GET' : method,
            headers: nextHeaders,
            body: status === 303 ? undefined : opts.body,
            timeoutMs,
            redirectsLeft: redirectsLeft - 1,
          }).then(resolve, reject);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          status,
          headers: res.headers,
          stream: res,
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy(new Error('HTTPS IPv4 timeout'));
        reject(new Error('HTTPS IPv4 timeout'));
      }
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchJsonIpv4<T = any>(
  rawUrl: string,
  opts: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null }> {
  const bodyBuf = opts.body !== undefined ? Buffer.from(opts.body, 'utf8') : undefined;
  const conn = await openHttpsStreamIpv4(rawUrl, {
    method: opts.method,
    headers: opts.headers,
    body: bodyBuf,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    conn.stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 2 * 1024 * 1024) chunks.push(chunk);
      else conn.destroy();
    });
    conn.stream.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: conn.status, data: text ? (JSON.parse(text) as T) : null });
      } catch {
        resolve({ status: conn.status, data: null });
      }
    });
    conn.stream.on('error', reject);
  });
}

/** Khoá HMAC ký link stream/download tạm thời (tránh SSRF & không lộ nguồn upstream ra trình duyệt) */
const hmacSecret = () => `${process.env.JWT_SECRET || 'novai-default-jwt-secret'}:tiktok-media:v1`;
const TOKEN_TTL_MS = 2 * 3600_000;

interface SignedMediaPayload {
  u: string;
  e: number;
}

function signMediaToken(url: string): string {
  const body = Buffer.from(JSON.stringify({ u: url, e: Date.now() + TOKEN_TTL_MS } satisfies SignedMediaPayload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', hmacSecret()).update(body).digest('base64url').slice(0, 32);
  return `${body}.${sig}`;
}

function verifyMediaToken(token: string): string {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) throw new BadRequestException('Liên kết tải không hợp lệ');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', hmacSecret()).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('Liên kết tải không hợp lệ hoặc đã hết hạn');
  let parsed: SignedMediaPayload;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedMediaPayload;
  } catch {
    throw new BadRequestException('Liên kết tải không hợp lệ');
  }
  if (!parsed?.u || typeof parsed.e !== 'number' || Date.now() > parsed.e) {
    throw new BadRequestException('Liên kết tải đã hết hạn, vui lòng bấm Lấy Video lại');
  }
  return assertSafeHttpsUrl(parsed.u).toString();
}

/** Danh sách tên miền hợp lệ cho link đầu vào TikTok / Douyin */
const ALLOWED_INPUT_HOSTS = ['tiktok.com', 'douyin.com', 'iesdouyin.com'];

function extractTikTokUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new BadRequestException('Vui lòng dán link video TikTok vào ô tìm kiếm');
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  const candidate = (match ? match[0] : trimmed).replace(/[),.;!?]+$/, '').trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BadRequestException('Đường link không hợp lệ. Hãy dán link từ TikTok (vt.tiktok.com hoặc tiktok.com)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Đường link không hợp lệ');
  }
  const host = parsed.hostname.toLowerCase();
  const ok = ALLOWED_INPUT_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) {
    throw new BadRequestException('Chỉ hỗ trợ đường link video TikTok hoặc Douyin (vt.tiktok.com / tiktok.com)');
  }
  return parsed.toString();
}

export interface RawExtractedTikTok {
  id: string;
  title: string;
  authorName: string;
  authorAvatar: string;
  cover: string;
  duration: number;
  hdUrl: string;
  stdUrl: string;
  musicUrl: string;
  musicTitle: string;
  stats: {
    plays: number;
    likes: number;
    comments: number;
    shares: number;
  };
}

/** Cache ngắn hạn 10 phút trong RAM (tránh gọi lặp khi nhiều người dán chung link xu hướng, tốn 0 byte ổ đĩa) */
const EXTRACT_CACHE_TTL_MS = 10 * 60_000;
const EXTRACT_CACHE_MAX = 300;
const extractCache = new Map<string, { exp: number; data: RawExtractedTikTok }>();

function getCached(url: string): RawExtractedTikTok | null {
  const hit = extractCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    extractCache.delete(url);
    return null;
  }
  return hit.data;
}

function setCached(url: string, data: RawExtractedTikTok) {
  if (extractCache.size >= EXTRACT_CACHE_MAX) {
    const oldest = extractCache.keys().next().value;
    if (oldest) extractCache.delete(oldest);
  }
  extractCache.set(url, { exp: Date.now() + EXTRACT_CACHE_TTL_MS, data });
}

/** Điều phối nhịp gọi tikwm (giới hạn miễn phí 1 req/giây/IP) */
let tikwmChain: Promise<void> = Promise.resolve();
let lastTikwmAt = 0;
const TIKWM_INTERVAL_MS = 1050;

async function withTikwmPace<T>(fn: () => Promise<T>): Promise<T> {
  const prev = tikwmChain;
  let release!: () => void;
  tikwmChain = new Promise<void>((r) => {
    release = r;
  });
  await prev.catch(() => undefined);
  try {
    const wait = TIKWM_INTERVAL_MS - (Date.now() - lastTikwmAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastTikwmAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

const resolveTikwmUrl = (u: unknown): string => {
  if (typeof u !== 'string' || !u.trim()) return '';
  const s = u.trim();
  if (s.startsWith('https://')) return s;
  if (s.startsWith('http://')) return `https://${s.slice(7)}`;
  return `https://www.tikwm.com${s.startsWith('/') ? '' : '/'}${s}`;
};

type TikwmAttempt = { rateLimited?: boolean; data?: RawExtractedTikTok };

/** Nguồn chính: tikwm.com qua IPv4 (đầy đủ HD + chuẩn H.264 + nhạc MP3 gốc + thống kê lượt xem/tim/chia sẻ) */
async function fetchTikwmIpv4(cleanUrl: string, usePost = false): Promise<TikwmAttempt> {
  const res = usePost
    ? await fetchJsonIpv4<{ code?: number; msg?: string; data?: Record<string, any> }>('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ url: cleanUrl, hd: '1' }).toString(),
        timeoutMs: 12_000,
      })
    : await fetchJsonIpv4<{ code?: number; msg?: string; data?: Record<string, any> }>(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs: 12_000,
        },
      );

  if (res.status === 429) return { rateLimited: true };
  const json = res.data;
  if (!json) return {};
  if (json.code !== 0 || !json.data) {
    if (/limit|1\s*second|too many|busy/i.test(String(json.msg ?? ''))) return { rateLimited: true };
    return {};
  }
  const t = json.data;
  const hdUrl = resolveTikwmUrl(t.hdplay);
  const stdUrl = resolveTikwmUrl(t.play);
  if (Array.isArray(t.images) && t.images.length > 0 && !hdUrl && (!stdUrl || /\.mp3(\?|$)/i.test(stdUrl))) {
    throw new BadRequestException('Bài đăng này là dạng album ảnh trượt (không phải video MP4)');
  }
  if (!hdUrl && !stdUrl) return {};
  return {
    data: {
      id: String(t.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, ''),
      title: String(t.title || 'Video TikTok').trim() || 'Video TikTok',
      authorName: String(t.author?.nickname || t.author?.unique_id || 'TikTok User').trim(),
      authorAvatar: resolveTikwmUrl(t.author?.avatar),
      cover: resolveTikwmUrl(t.origin_cover || t.cover),
      duration: Number(t.duration) || 0,
      hdUrl: hdUrl || stdUrl,
      stdUrl: stdUrl || hdUrl,
      musicUrl: resolveTikwmUrl(t.music),
      musicTitle: String(t.music_info?.title || '').trim(),
      stats: {
        plays: Number(t.play_count) || 0,
        likes: Number(t.digg_count) || 0,
        comments: Number(t.comment_count) || 0,
        shares: Number(t.share_count) || 0,
      },
    },
  };
}

/** Nguồn dự phòng siêu nhanh (~1.1s): api.tikmate.app qua IPv4 */
async function fetchTikmateFallbackIpv4(cleanUrl: string): Promise<RawExtractedTikTok | null> {
  try {
    const res = await fetchJsonIpv4<Record<string, any>>('https://api.tikmate.app/api/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ url: cleanUrl }).toString(),
      timeoutMs: 10_000,
    });
    const d = res.data;
    if (!d?.success || !d?.id || (!d?.hd_token && !d?.token)) return null;
    const id = String(d.id).replace(/[^a-zA-Z0-9_-]/g, '');
    const hdUrl = d.hd_token ? `https://tikmate.app/download/${encodeURIComponent(String(d.hd_token))}/${id}.mp4?hd=1` : '';
    const stdUrl = d.token ? `https://tikmate.app/download/${encodeURIComponent(String(d.token))}/${id}.mp4` : '';
    const best = hdUrl || stdUrl;
    if (!best) return null;
    return {
      id,
      title: String(d.desc || 'Video TikTok').trim() || 'Video TikTok',
      authorName: String(d.author_name || d.author_id || 'TikTok User').trim(),
      authorAvatar: typeof d.author_avatar === 'string' && d.author_avatar.startsWith('https://') ? d.author_avatar : '',
      cover: typeof d.cover === 'string' && d.cover.startsWith('https://') ? d.cover : '',
      duration: 0,
      hdUrl: best,
      stdUrl: stdUrl || best,
      musicUrl: '',
      musicTitle: '',
      stats: {
        plays: Number(d.play_count) || 0,
        likes: Number(d.like_count) || 0,
        comments: Number(d.comment_count) || 0,
        shares: Number(d.share_count) || 0,
      },
    };
  } catch {
    return null;
  }
}

/** Nguồn dự phòng thứ 3: aideepcut.com/api/tiktok/download qua IPv4 */
async function fetchAiDeepCutFallbackIpv4(cleanUrl: string): Promise<RawExtractedTikTok | null> {
  try {
    const res = await fetchJsonIpv4<{ ok?: boolean; data?: Record<string, any> }>('https://aideepcut.com/api/tiktok/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://aideepcut.com',
        Referer: 'https://aideepcut.com/',
      },
      body: JSON.stringify({ url: cleanUrl }),
      timeoutMs: 8_000,
    });
    const d = res.data?.data;
    if (!res.data?.ok || !d) return null;
    const hdUrl = typeof d.hdVideoUrl === 'string' && d.hdVideoUrl.startsWith('https://') ? d.hdVideoUrl : '';
    const stdUrl = typeof d.standardVideoUrl === 'string' && d.standardVideoUrl.startsWith('https://') ? d.standardVideoUrl : '';
    const fallbackVideo = typeof d.videoUrl === 'string' && d.videoUrl.startsWith('https://') ? d.videoUrl : '';
    const best = hdUrl || fallbackVideo || stdUrl;
    if (!best) return null;
    return {
      id: String(d.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, ''),
      title: String(d.title || 'Video TikTok').trim() || 'Video TikTok',
      authorName: String(d.authorName || 'TikTok User').trim(),
      authorAvatar: typeof d.authorAvatar === 'string' && d.authorAvatar.startsWith('https://') ? d.authorAvatar : '',
      cover: typeof d.cover === 'string' && d.cover.startsWith('https://') ? d.cover : '',
      duration: Number(d.duration) || 0,
      hdUrl: best,
      stdUrl: stdUrl || best,
      musicUrl: typeof d.musicUrl === 'string' && d.musicUrl.startsWith('https://') ? d.musicUrl : '',
      musicTitle: String(d.musicTitle || '').trim(),
      stats: {
        plays: Number(d.stats?.plays) || 0,
        likes: Number(d.stats?.likes) || 0,
        comments: Number(d.stats?.comments) || 0,
        shares: Number(d.stats?.shares) || 0,
      },
    };
  } catch {
    return null;
  }
}

/** Trích xuất luồng video TikTok không logo (dùng chung cho cả controller web và công cụ AI `aideepcut.tiktok-download`) */
export async function extractTikTokMedia(rawInput: string): Promise<RawExtractedTikTok> {
  const cleanUrl = extractTikTokUrl(rawInput);
  let item = getCached(cleanUrl);
  if (!item) {
    const [tikwmFirst, tikmateRes] = await Promise.all([
      withTikwmPace(() =>
        fetchTikwmIpv4(cleanUrl, false).catch((e): TikwmAttempt => {
          if (e instanceof BadRequestException) throw e;
          return {};
        }),
      ),
      fetchTikmateFallbackIpv4(cleanUrl),
    ]);

    let tikwmData = tikwmFirst.data;
    if (!tikwmData && tikwmFirst.rateLimited && !tikmateRes) {
      const retry = await withTikwmPace(() =>
        fetchTikwmIpv4(cleanUrl, true).catch((e): TikwmAttempt => {
          if (e instanceof BadRequestException) throw e;
          return {};
        }),
      );
      tikwmData = retry.data;
    }

    item = tikwmData ?? tikmateRes ?? (await fetchAiDeepCutFallbackIpv4(cleanUrl)) ?? null;
    if (!item) {
      throw new BadRequestException('Không tìm thấy luồng video hợp lệ. Hãy kiểm tra lại đường link và đảm bảo video ở chế độ công khai.');
    }
    setCached(cleanUrl, item);
  }
  return item;
}

/**
 * Tải Video TikTok Không Logo (MIỄN PHÍ, 0 credits, 0 byte ổ đĩa VPS):
 * - POST /public/ai/tiktok/extract: bóc tách video MP4 HD không logo + bản H.264 + nhạc MP3 gốc
 * - GET  /public/ai/tiktok/stream/:token: phát xem trước trực tiếp hỗ trợ tua (Range 206)
 * - GET  /public/ai/tiktok/download/:token: stream tải thẳng về máy khách (Content-Disposition: attachment)
 */
@Controller('public/ai/tiktok')
export class PublicAiTikTokController {
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('extract')
  @HttpCode(200)
  async extract(@Body() dto: ImportUrlDto) {
    const item = await extractTikTokMedia(dto.url);

    const safeId = item.id || String(Date.now());
    const hdToken = signMediaToken(item.hdUrl);
    const stdDiffers = Boolean(item.stdUrl && item.stdUrl !== item.hdUrl);
    const stdToken = stdDiffers ? signMediaToken(item.stdUrl) : null;
    const musicToken = item.musicUrl ? signMediaToken(item.musicUrl) : null;
    const coverToken = item.cover ? signMediaToken(item.cover) : null;
    const avatarToken = item.authorAvatar ? signMediaToken(item.authorAvatar) : null;

    return {
      id: safeId,
      title: item.title,
      authorName: item.authorName,
      authorAvatar: avatarToken ? `/api/public/ai/tiktok/stream/${avatarToken}` : null,
      cover: coverToken ? `/api/public/ai/tiktok/stream/${coverToken}` : null,
      duration: item.duration,
      videoUrl: `/api/public/ai/tiktok/stream/${hdToken}`,
      hdDownloadUrl: `/api/public/ai/tiktok/download/${hdToken}?name=${encodeURIComponent(`TikTok_Clean_HD_${safeId}.mp4`)}`,
      standardDownloadUrl: stdToken
        ? `/api/public/ai/tiktok/download/${stdToken}?name=${encodeURIComponent(`TikTok_Clean_Standard_${safeId}.mp4`)}`
        : null,
      musicDownloadUrl: musicToken
        ? `/api/public/ai/tiktok/download/${musicToken}?name=${encodeURIComponent(`TikTok_Audio_${safeId}.mp3`)}`
        : null,
      musicTitle: item.musicTitle || null,
      stats: item.stats,
    };
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('stream/:token')
  async stream(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const targetUrl = verifyMediaToken(token);
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const upstream = await openHttpsStreamIpv4(targetUrl, {
      headers: {
        Referer: 'https://www.tiktok.com/',
        ...(range ? { Range: range } : {}),
      },
      timeoutMs: 25_000,
    }).catch(() => null);

    if (!upstream || (upstream.status !== 200 && upstream.status !== 206)) {
      upstream?.destroy();
      throw new NotFoundException('Luồng media không còn khả dụng, vui lòng bấm Lấy Video lại');
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const) {
      const v = upstream.headers[h];
      if (v !== undefined) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');

    req.on('close', () => upstream.destroy());
    upstream.stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    upstream.stream.pipe(res);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('download/:token')
  async download(@Param('token') token: string, @Query('name') name: string | undefined, @Req() req: Request, @Res() res: Response) {
    const targetUrl = verifyMediaToken(token);
    const safeName = String(name || 'TikTok_Clean_HD.mp4')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
      .slice(0, 120);

    const upstream = await openHttpsStreamIpv4(targetUrl, {
      headers: {
        Referer: 'https://www.tiktok.com/',
      },
      timeoutMs: 25_000,
    }).catch(() => null);

    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      upstream?.destroy();
      throw new NotFoundException('File tải không còn khả dụng, vui lòng bấm Lấy Video lại');
    }

    const isMp3 = /\.mp3$/i.test(safeName);
    const rawCt = Array.isArray(upstream.headers['content-type']) ? upstream.headers['content-type'][0] : upstream.headers['content-type'];
    const ct = rawCt && !rawCt.includes('octet-stream') ? rawCt : isMp3 ? 'audio/mpeg' : 'video/mp4';
    res.status(200);
    res.setHeader('Content-Type', ct);
    const cl = upstream.headers['content-length'];
    if (cl !== undefined) res.setHeader('Content-Length', cl);
    res.setHeader('Content-Disposition', attachmentDisposition(safeName));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');

    req.on('close', () => upstream.destroy());
    upstream.stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    upstream.stream.pipe(res);
  }
}
