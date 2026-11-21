import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Public } from '../../common/decorators/public.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { BulkCreateJobDto, BulkExtractDto } from './ai.dto.js';
import { hideProviderText } from './ai-public-key.js';

const DEFAULT_UPSTREAM = 'https://maivideo.top';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOKEN_TTL_MS = 2 * 3600_000;

function attachmentDisposition(fileName: string): string {
  const ascii =
    fileName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^\x20-\x7E]+/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'video.mp4';
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

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
    throw new BadRequestException('Liên kết không hợp lệ');
  }
  if (u.protocol !== 'https:' || !u.hostname || u.hostname === 'localhost') {
    throw new BadRequestException('Liên kết bị từ chối');
  }
  const ipKind = isIP(u.hostname);
  if (ipKind === 6 || (ipKind === 4 && isPrivateIpv4(u.hostname))) {
    throw new BadRequestException('Địa chỉ bị từ chối');
  }
  return u;
}

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
  const timeoutMs = opts.timeoutMs ?? 20_000;
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
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    conn.stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 4 * 1024 * 1024) chunks.push(chunk);
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

const hmacSecret = () => `${process.env.JWT_SECRET || 'novai-default-jwt-secret'}:bulk-dl:v1`;

function signPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', hmacSecret()).update(body).digest('base64url').slice(0, 32);
  return `${body}.${sig}`;
}

function verifyPayload<T extends Record<string, unknown>>(token: string): T {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) throw new BadRequestException('Phiên tải không hợp lệ');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', hmacSecret()).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('Phiên tải không hợp lệ hoặc đã hết hạn');
  let parsed: T & { exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
  } catch {
    throw new BadRequestException('Phiên tải không hợp lệ');
  }
  if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
    throw new BadRequestException('Phiên tải đã hết hạn, vui lòng tạo lượt tải mới');
  }
  return parsed;
}

function cleanFileName(title: string, idx: number): string {
  const safe = String(title || `Video_${idx + 1}`)
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || `Video_${idx + 1}`}.mp4`;
}

function sanitizeErrorMsg(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return (
    hideProviderText(s)
      .replace(/\/Users\/[^\s"']+/gi, '')
      .replace(/cookie-exporter/gi, 'phiên đăng nhập')
      .trim() || 'Không thể tải video từ liên kết này (video riêng tư hoặc nền tảng tạm chặn)'
  );
}

/**
 * Tải Video Hàng Loạt Không Logo (T-382 — MIỄN PHÍ 0đ, 0 byte ổ đĩa VPS):
 * Hỗ trợ TikTok, Douyin, YouTube Shorts/Video, Facebook Reels, Instagram Reels, Bilibili, Xiaohongshu, Kuaishou.
 * Toàn bộ API & luồng MP4 / ZIP đều đi qua proxy IPv4 ký HMAC ẩn danh 100% tên miền nguồn.
 */
@Controller('public/ai/bulk-download')
export class PublicAiBulkDownloadController {
  constructor(private readonly settings: SettingsService) {}

  private async upstreamBase(): Promise<string> {
    const cfg = await this.settings.get<{ baseUrl?: string }>('ai_maivideo').catch(() => ({ baseUrl: DEFAULT_UPSTREAM }));
    const raw = (cfg?.baseUrl || DEFAULT_UPSTREAM).trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
    return raw.startsWith('https://') ? raw : DEFAULT_UPSTREAM;
  }

  private buildStaticUpstreamUrl(base: string, itemVideo: Record<string, any>, sessionId: string): string | null {
    const fp = typeof itemVideo?.file_path === 'string' ? itemVideo.file_path : '';
    const fn = typeof itemVideo?.file_name === 'string' ? itemVideo.file_name : '';
    if (!fp && !fn) return null;
    let rel = '';
    const dataIdx = fp.indexOf('/data/');
    if (dataIdx >= 0) {
      rel = fp.slice(dataIdx + 6).replace(/^\/+/, '');
    } else if (fn) {
      rel = `downloads/${fn.replace(/^\/+/, '')}`;
    }
    if (!rel) return null;
    const encodedRel = rel
      .split('/')
      .filter(Boolean)
      .map((p) => encodeURIComponent(p))
      .join('/');
    const sid = encodeURIComponent(sessionId || 'global');
    return `${base}/static/${encodedRel}?session_id=${sid}`;
  }

  private formatJobResponse(base: string, job: Record<string, any>, jobToken: string, fallbackSid: string) {
    const sid = String(job.session_id || fallbackSid || 'global');
    const rawItems = Array.isArray(job.items) ? job.items : [];
    const items = rawItems.map((it: Record<string, any>, idx: number) => {
      const vid = it?.video && typeof it.video === 'object' ? (it.video as Record<string, any>) : null;
      const upstreamStatic = vid && it.status === 'done' ? this.buildStaticUpstreamUrl(base, vid, sid) : null;
      const mediaToken = upstreamStatic ? signPayload({ u: upstreamStatic }) : null;
      const dlName = cleanFileName(String(vid?.title || `Video_${idx + 1}`), idx);
      const rawThumb = typeof vid?.thumbnail === 'string' && vid.thumbnail.startsWith('https://') ? vid.thumbnail : null;
      const thumbToken = rawThumb ? signPayload({ u: rawThumb }) : null;
      const meta = vid?.metadata && typeof vid.metadata === 'object' ? vid.metadata : null;

      return {
        id: String(it?.id || idx),
        url: typeof it?.url === 'string' ? it.url : '',
        sourceLabel: typeof it?.source_label === 'string' ? it.source_label : `#${idx + 1}`,
        status: String(it?.status || 'queued'),
        percent: Number(it?.progress?.percent ?? (it?.status === 'done' ? 100 : 0)) || 0,
        error: it?.error ? sanitizeErrorMsg(it.error) : '',
        video: vid
          ? {
              title: String(vid.title || `Video #${idx + 1}`),
              platform: typeof vid.platform === 'string' ? vid.platform : '',
              duration: Number(vid.duration ?? meta?.duration ?? 0) || 0,
              size: Number(meta?.size ?? 0) || 0,
              width: Number(meta?.video?.width ?? 0) || 0,
              height: Number(meta?.video?.height ?? 0) || 0,
              thumbnailUrl: thumbToken ? `/api/public/ai/bulk-download/media/${thumbToken}` : null,
              streamUrl: mediaToken ? `/api/public/ai/bulk-download/media/${mediaToken}` : null,
              downloadUrl: mediaToken ? `/api/public/ai/bulk-download/file/${mediaToken}?name=${encodeURIComponent(dlName)}` : null,
              fileName: dlName,
            }
          : null,
      };
    });

    const summary = job.summary ?? {};
    const done = Number(summary.done ?? items.filter((x) => x.status === 'done').length) || 0;
    const error = Number(summary.error ?? items.filter((x) => x.status === 'error').length) || 0;
    const running = Number(summary.running ?? items.filter((x) => x.status === 'running' || x.status === 'downloading').length) || 0;
    const queued = Number(summary.queued ?? items.filter((x) => x.status === 'queued').length) || 0;
    const canceled = Number(summary.canceled ?? items.filter((x) => x.status === 'canceled').length) || 0;
    const total = Number(summary.total ?? items.length) || items.length;
    const progress = total > 0 ? Math.round(((done + error + canceled) / total) * 100) : 0;

    return {
      jobToken,
      status: String(job.status || 'queued'),
      quality: String(job.quality || 'best'),
      items,
      summary: { total, done, error, running, queued, canceled, progress },
      zipUrl: done > 0 ? `/api/public/ai/bulk-download/jobs/${jobToken}/zip` : null,
    };
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('extract')
  @HttpCode(200)
  async extractChannel(@Body() dto: BulkExtractDto) {
    const query = dto.query.trim();
    if (!/^https?:\/\/\S+$/i.test(query)) {
      throw new BadRequestException('Vui lòng nhập đường dẫn URL Kênh / Trang cá nhân hợp lệ (bắt đầu bằng https://)');
    }
    const base = await this.upstreamBase();
    const res = await fetchJsonIpv4<any>(`${base}/api/remix/extract-videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: base,
        Referer: `${base}/tools/bulk-download`,
      },
      body: JSON.stringify({ query, limit: Math.min(50, Math.max(1, dto.limit ?? 20)) }),
      timeoutMs: 45_000,
    }).catch(() => ({ status: 0, data: null }));

    if (res.status < 200 || res.status >= 300 || !res.data?.success || !Array.isArray(res.data?.items)) {
      const msg = sanitizeErrorMsg(res.data?.detail || res.data?.error || 'Không thể quét danh sách video từ đường dẫn này.');
      throw new BadRequestException(msg);
    }

    return {
      items: res.data.items
        .filter((x: any) => typeof x?.url === 'string' && /^https?:\/\//i.test(x.url))
        .map((x: any, idx: number) => {
          const thumb = typeof x?.thumbnail === 'string' && x.thumbnail.startsWith('https://') ? signPayload({ u: x.thumbnail }) : null;
          return {
            id: String(x.id || idx),
            url: String(x.url),
            title: String(x.title || `Video #${idx + 1}`),
            duration: Number(x.duration) || 0,
            platform: typeof x.platform === 'string' ? x.platform : '',
            thumbnailUrl: thumb ? `/api/public/ai/bulk-download/media/${thumb}` : null,
          };
        }),
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('jobs')
  @HttpCode(200)
  async createJob(@Body() dto: BulkCreateJobDto) {
    const seen = new Set<string>();
    const cleanUrls: string[] = [];
    for (const raw of dto.urls) {
      const m = String(raw ?? '').match(/https?:\/\/[^\s"'<>]+/i);
      if (!m) continue;
      const u = m[0].replace(/[),.;!?]+$/, '').trim();
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const norm = parsed.toString();
        const key = norm.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          cleanUrls.push(norm);
        }
      } catch {
        continue;
      }
      if (cleanUrls.length >= 30) break;
    }

    if (!cleanUrls.length) {
      throw new BadRequestException('Vui lòng dán ít nhất 1 đường link video hợp lệ (mỗi dòng 1 link)');
    }

    const base = await this.upstreamBase();
    const clientSid = `nov-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const quality = dto.quality || 'best';

    const res = await fetchJsonIpv4<any>(`${base}/api/remix/download-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Session-ID': clientSid,
        Origin: base,
        Referer: `${base}/tools/bulk-download`,
      },
      body: JSON.stringify({ urls: cleanUrls, quality, concurrency: 2, download_all: false }),
      timeoutMs: 25_000,
    }).catch(() => ({ status: 0, data: null }));

    const job = res.data?.job;
    if (res.status < 200 || res.status >= 300 || !res.data?.success || !job?.id) {
      const msg = sanitizeErrorMsg(res.data?.detail || res.data?.error || 'Máy chủ tải video đang bận tạm thời, vui lòng thử lại sau ít giây.');
      throw new BadRequestException(msg);
    }

    const effectiveSid = String(job.session_id || clientSid);
    const jobToken = signPayload({ jid: String(job.id), sid: effectiveSid, urls: cleanUrls });
    // Đính kèm lại danh sách URL gốc theo thứ tự để giao diện hiển thị rõ ràng
    if (Array.isArray(job.items)) {
      job.items = job.items.map((it: any, idx: number) => ({ ...it, url: it?.url || cleanUrls[idx] || '' }));
    }
    return this.formatJobResponse(base, job, jobToken, effectiveSid);
  }

  @Public()
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @Get('jobs/:jobToken')
  async getJob(@Param('jobToken') jobToken: string) {
    const { jid, sid, urls } = verifyPayload<{ jid: string; sid: string; urls?: string[] }>(jobToken);
    const base = await this.upstreamBase();
    const res = await fetchJsonIpv4<any>(`${base}/api/remix/download-jobs/${encodeURIComponent(jid)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Session-ID': sid,
      },
      timeoutMs: 15_000,
    }).catch(() => ({ status: 0, data: null }));

    const job = res.data?.job;
    if (!job?.id) {
      throw new NotFoundException('Không tìm thấy tiến trình tải hoặc phiên đã kết thúc');
    }
    if (Array.isArray(job.items) && Array.isArray(urls)) {
      job.items = job.items.map((it: any, idx: number) => ({ ...it, url: it?.url || urls[idx] || '' }));
    }
    return this.formatJobResponse(base, job, jobToken, sid);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('jobs/:jobToken/cancel')
  @HttpCode(200)
  async cancelJob(@Param('jobToken') jobToken: string) {
    const { jid, sid, urls } = verifyPayload<{ jid: string; sid: string; urls?: string[] }>(jobToken);
    const base = await this.upstreamBase();
    const res = await fetchJsonIpv4<any>(`${base}/api/remix/download-jobs/${encodeURIComponent(jid)}/cancel`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Session-ID': sid, Origin: base },
      timeoutMs: 15_000,
    }).catch(() => ({ status: 0, data: null }));
    if (!res.data?.job) throw new BadRequestException('Không thể huỷ tiến trình tải lúc này');
    if (Array.isArray(res.data.job.items) && Array.isArray(urls)) {
      res.data.job.items = res.data.job.items.map((it: any, idx: number) => ({ ...it, url: it?.url || urls[idx] || '' }));
    }
    return this.formatJobResponse(base, res.data.job, jobToken, sid);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('jobs/:jobToken/retry-failed')
  @HttpCode(200)
  async retryFailed(@Param('jobToken') jobToken: string) {
    const { jid, sid, urls } = verifyPayload<{ jid: string; sid: string; urls?: string[] }>(jobToken);
    const base = await this.upstreamBase();
    const res = await fetchJsonIpv4<any>(`${base}/api/remix/download-jobs/${encodeURIComponent(jid)}/retry-failed`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Session-ID': sid, Origin: base },
      timeoutMs: 15_000,
    }).catch(() => ({ status: 0, data: null }));
    if (!res.data?.job) throw new BadRequestException('Không thể thử lại các video lỗi lúc này');
    if (Array.isArray(res.data.job.items) && Array.isArray(urls)) {
      res.data.job.items = res.data.job.items.map((it: any, idx: number) => ({ ...it, url: it?.url || urls[idx] || '' }));
    }
    return this.formatJobResponse(base, res.data.job, jobToken, sid);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('jobs/:jobToken/zip')
  async downloadZip(@Param('jobToken') jobToken: string, @Req() req: Request, @Res() res: Response) {
    const { jid, sid } = verifyPayload<{ jid: string; sid: string }>(jobToken);
    const base = await this.upstreamBase();
    const upstream = await openHttpsStreamIpv4(`${base}/api/remix/download-jobs/${encodeURIComponent(jid)}/zip`, {
      headers: { 'X-Session-ID': sid },
      timeoutMs: 120_000,
    }).catch(() => null);

    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      upstream?.destroy();
      throw new NotFoundException('Không thể đóng gói file ZIP lúc này, vui lòng tải lẻ từng video');
    }

    const zipName = `Video_Hang_Loat_${jid.slice(0, 8)}.zip`;
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    const cl = upstream.headers['content-length'];
    if (cl !== undefined) res.setHeader('Content-Length', cl);
    res.setHeader('Content-Disposition', attachmentDisposition(zipName));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');

    req.on('close', () => upstream.destroy());
    upstream.stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    upstream.stream.pipe(res);
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('media/:token')
  async streamMedia(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const { u } = verifyPayload<{ u: string }>(token);
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const upstream = await openHttpsStreamIpv4(u, {
      headers: { ...(range ? { Range: range } : {}) },
      timeoutMs: 45_000,
    }).catch(() => null);

    if (!upstream || (upstream.status !== 200 && upstream.status !== 206)) {
      upstream?.destroy();
      throw new NotFoundException('Luồng video không còn khả dụng');
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
  @Throttle({ default: { limit: 150, ttl: 60_000 } })
  @Get('file/:token')
  async downloadFile(@Param('token') token: string, @Query('name') name: string | undefined, @Req() req: Request, @Res() res: Response) {
    const { u } = verifyPayload<{ u: string }>(token);
    const safeName = String(name || 'Video_Clean_HD.mp4')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
      .slice(0, 120);

    const upstream = await openHttpsStreamIpv4(u, { timeoutMs: 60_000 }).catch(() => null);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      upstream?.destroy();
      throw new NotFoundException('File video không còn khả dụng, vui lòng bấm tải lại');
    }

    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
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
