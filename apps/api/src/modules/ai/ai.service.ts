import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CreditsService } from '../credits/credits.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AiTask, AiTool, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { AI_PROVIDERS, providerCleanDomain, providerDefaultBadge, providerDisplayLabel } from './providers/index.js';
import { AI_UPLOAD_HARD_MB, AiFilesService } from './ai-files.service.js';
import { AiCategoriesService } from './ai-categories.service.js';
import { validateInput } from './ai-input.js';
import { hasProviderBrandLeak, hideProviderText, internalToolKey, maskPreviewUrl, providerAlias, providerFromAlias, publicToolKey, registerPublicTool, sanitizeToolDisplayName } from './ai-public-key.js';
import { isChildSite, shouldHideAiProviders } from '../../common/utils/tenant.js';
import { safeFetch, SafeFetchError } from '../../common/utils/safe-fetch.js';
import { AiProviderError, isDeletedTool, isMaintenanceTool, type AiCallContext, type AiFieldDef, type AiFieldOption, type AiOutputFile, type AiInput, type AiPricing, type AiProvider, type AiProviderConfig, type AiProviderResult, type AiToolDef, type AiUserClonedVoice } from './ai.types.js';
import type { AdminCommunityQueryDto, AdminTaskQueryDto, BulkCommunityModerateDto, CommunityQueryDto, CreateClonedVoiceDto, CreateCommunityShowcaseDto, DownloadTasksDto, FlagTaskViolationDto, TaskQueryDto, ToolRunStatsQueryDto, UpdateClonedVoiceDto, UpdateToolDto } from './ai.dto.js';
import { deleteVoiceOnIvoi, enrollVaultVoiceOnIvoi, normalizeIvoiRefAudio } from './providers/ivoi.provider.js';
import { cancelTaskUpstream } from './providers/cancel.js';
import { detectInputViolation, extractStoredViolationReview, inspectTaskViolation, type StoredViolationReview, type ViolationCategory } from './ai-moderation.js';
import { computeToolPriceBreakdown, type AiToolPriceBreakdown } from './ai-price-matrix.js';
import { canonicalModelSlug, slugModel } from './ai-model-api.js';
import type { ZipSourceEntry } from './zip-stream.js';
import { esc, sendMessage } from '../telegram/telegram.api.js';
import type { TelegramUserSettings } from '../telegram/telegram.service.js';

/** Cấu hình chung nhóm `ai` */
interface AiSettings {
  pollSeconds?: number;
  timeoutMinutes?: number;
}

/** Số lần thử gửi lại tối đa khi nhà cung cấp lỗi tạm thời */
const MAX_SUBMIT_ATTEMPTS = 5;
/** Số tác vụ tối đa xử lý mỗi lượt cron */
const BATCH = 120;
/** Chuẩn hoá từ khoá tìm kiếm model / công cụ AI: bỏ dấu tiếng Việt, tách ngoặc/dấu gạch nhưng giữ chấm phiên bản như 2.5 / 3.1 (T-480, T-481) */
function normAiSearchText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[()[\]{}·•–—―\-_/,:;|+~]+/g, ' ')
    .replace(/(?:^|\s)\.+|\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAiSearchParts(parts: (string | null | undefined)[], rawQuery: string): boolean {
  const kw = rawQuery.trim().toLowerCase();
  if (!kw) return true;
  for (const p of parts) {
    if (p && p.toLowerCase().includes(kw)) return true;
  }
  const normQ = normAiSearchText(rawQuery);
  if (!normQ) return true;
  const normHay = normAiSearchText(parts.filter(Boolean).join(' '));
  if (normHay.includes(normQ)) return true;
  const tokens = normQ.split(' ').filter(Boolean);
  return tokens.length > 1 && tokens.every((tok) => normHay.includes(tok));
}

/** Khoảng giờ của một ngày theo giờ Việt Nam (UTC+7): hôm nay / hôm qua / hôm kia — ô lọc ngày ở trang admin Tác vụ AI */
function vnDayRange(day: 'today' | 'yesterday' | 'daybefore'): { gte: Date; lt: Date } {
  const VN = 7 * 3_600_000;
  const back = { today: 0, yesterday: 1, daybefore: 2 }[day];
  const start = Math.floor((Date.now() + VN) / 86_400_000) * 86_400_000 - VN - back * 86_400_000;
  return { gte: new Date(start), lt: new Date(start + 86_400_000) };
}

/** Số tác vụ cron xử lý cùng lúc trong một lượt (hỏi trạng thái / gửi lại / tải kết quả) */
const POLL_CONCURRENCY = 60;
/** Số tác vụ Fable tối đa được phép đang gửi đồng thời (ảnh Grok đồng bộ giữ kết nối 45–120s trên mỗi luồng nguồn) */
const FABLE_MAX_CONCURRENT_SUBMITS = 12;
/** Nhịp giãn cách ngắn khi mở luồng gửi Fable kế tiếp: đủ để nguồn trả 429 ngay nếu đã kín luồng mà không làm nghẽn các luồng trống */
const FABLE_LAUNCH_PACE_MS = 1_500;
/** Thời gian "giữ" tác vụ khi đang gửi / đang xử lý (lớn hơn timeout dài nhất của adapter) để cron không xử lý trùng */
const SUBMIT_HOLD_MS = 10 * 60_000;
/** API tắt: chờ tối đa bấy lâu cho các lần gửi tác vụ đang dở (PM2 kill_timeout phải lớn hơn, xem ecosystem.config.cjs) */
const SHUTDOWN_WAIT_MS = 30_000;
/** Số file nghe thử giọng đọc giữ trong bộ nhớ (~30–90 KB mỗi file) */
const VOICE_CACHE_MAX = 400;
/** Thư mục lưu manifest tạm cho link tải .ZIP hàng loạt (tự dọn sau 2 giờ) */
const ZIP_MANIFEST_DIR = join(tmpdir(), 'novai-ai-zips');
mkdirSync(ZIP_MANIFEST_DIR, { recursive: true });
/** Thời hạn hiệu lực (giây) của link tải file / .ZIP có ký */
const DOWNLOAD_TTL_SEC = 2 * 3600;

/** Làm sạch phần tên file (giữ chữ tiếng Việt có dấu, số, khoảng trắng, gạch ngang) */
function sanitizeNamePart(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
}

/** Tên file tuỳ chọn khách đã đặt cho tác vụ (lưu trong `output.customName`) */
function taskCustomNameOf(output: unknown): string | null {
  const raw = (output as Record<string, unknown> | null)?.customName;
  if (typeof raw !== 'string') return null;
  const clean = sanitizeNamePart(raw.replace(/\.[a-z0-9]{2,5}$/i, ''));
  return clean || null;
}

/** Cờ đánh dấu khách xin đăng Cộng đồng đang chờ Admin kiểm duyệt (`output.__communityPending` — T-394) */
function taskCommunityPendingOf(output: unknown): boolean {
  return !!(output && typeof output === 'object' && (output as Record<string, unknown>).__communityPending === true);
}

/** Kết quả hệ thống tự động kiểm tra & tự xử lý đơn lỗi hoàn tiền (`output.__autoCheck` — T-417) */
export interface TaskAutoCheckInfo {
  checked: boolean;
  checkedAt: string;
  kind: 'auto_healed' | 'fixed_code' | 'upstream_policy' | 'upstream_transient' | 'input_invalid' | 'checked';
  summary: string;
}

/** Kết quả gọi sang API nguồn để huỷ đơn khi hoàn tiền / quá hạn (`output.__upstreamCancel` — T-427 & T-429) */
export interface TaskUpstreamCancelInfo {
  attemptedAt: string;
  trigger: 'admin' | 'user' | 'timeout' | 'retro_sync';
  ok: boolean;
  httpStatus?: number;
  upstreamStatus?: string;
  note: string;
}

/** Trạng thái quét trực tiếp từ nguồn cho các đơn Đang xử lý > 30p & đang chạy (`output.__stuckCheck` — T-428) */
export interface TaskStuckCheckInfo {
  checkedAt: string;
  updatedAt: string;
  upstreamStatus: string;
  progress?: number;
  checkCount: number;
  summary: string;
}

function extractTaskAutoCheck(output: unknown): TaskAutoCheckInfo | null {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__autoCheck;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.checked !== true) return null;
  return {
    checked: true,
    checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : '',
    kind: (o.kind as TaskAutoCheckInfo['kind']) || 'checked',
    summary: typeof o.summary === 'string' ? o.summary : 'Đã kiểm tra tự động',
  };
}

function extractTaskUpstreamCancel(output: unknown): TaskUpstreamCancelInfo | null {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__upstreamCancel;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.note !== 'string') return null;
  return {
    attemptedAt: typeof o.attemptedAt === 'string' ? o.attemptedAt : '',
    trigger: ((o.trigger as TaskUpstreamCancelInfo['trigger']) || 'admin'),
    ok: o.ok === true,
    httpStatus: typeof o.httpStatus === 'number' ? o.httpStatus : undefined,
    upstreamStatus: typeof o.upstreamStatus === 'string' ? o.upstreamStatus : undefined,
    note: o.note,
  };
}

function extractTaskStuckCheck(output: unknown): TaskStuckCheckInfo | null {
  if (!output || typeof output !== 'object') return null;
  const oRoot = output as Record<string, unknown>;
  const raw = oRoot.__stuckCheck;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.checkedAt === 'string') {
      return {
        checkedAt: o.checkedAt,
        updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : o.checkedAt,
        upstreamStatus: typeof o.upstreamStatus === 'string' ? o.upstreamStatus : 'processing',
        progress: typeof o.progress === 'number' ? o.progress : undefined,
        checkCount: typeof o.checkCount === 'number' ? o.checkCount : 1,
        summary: typeof o.summary === 'string' ? o.summary : 'Đang xử lý bên nguồn',
      };
    }
  }
  if (typeof oRoot.__lastPolledAt === 'string') {
    return {
      checkedAt: oRoot.__lastPolledAt,
      updatedAt: typeof oRoot.__lastChangedAt === 'string' ? oRoot.__lastChangedAt : oRoot.__lastPolledAt,
      upstreamStatus: typeof oRoot.__lastUpstreamStatus === 'string' ? oRoot.__lastUpstreamStatus : 'processing',
      checkCount: 1,
      summary: 'Đang theo dõi định kỳ',
    };
  }
  return null;
}

/** Trạng thái trực tiếp bên API nguồn cho cột "Trạng thái nguồn" ở các mục Đã hoàn tiền / Đã huỷ / Đang xử lý >30p (`output.__upstreamLive` — T-495, T-499) */
export interface TaskUpstreamLiveStatus {
  state: 'processing' | 'queued' | 'succeeded' | 'failed' | 'cancelled' | 'no_task_id' | 'not_supported' | 'unknown';
  refundState?: 'not_charged' | 'refunded' | 'charged' | 'holding' | 'unknown';
  refundNote?: string;
  rawStatus?: string;
  progress?: number;
  resultUrl?: string;
  message?: string;
  checkedAt: string;
}

function inferUpstreamRefund(
  provider: string,
  state: TaskUpstreamLiveStatus['state'],
  raw?: unknown,
  errMsg?: string | null,
): { refundState: NonNullable<TaskUpstreamLiveStatus['refundState']>; refundNote: string } {
  if (state === 'no_task_id') {
    return { refundState: 'not_charged', refundNote: 'Không tốn phí nguồn (chưa tạo job)' };
  }
  if (provider === 'fable' || provider === 'tavtavvideo') {
    return { refundState: 'not_charged', refundNote: 'Thuê luồng cố định (0đ/đơn)' };
  }
  const rawStr = raw ? JSON.stringify(raw) : '';
  const combined = `${errMsg ?? ''} ${rawStr}`;
  const explicitRefund = /đã hoàn xu|đã được hoàn|refunded"\s*:\s*true|is_refunded"\s*:\s*true|credit_refunded"\s*:\s*true/i.test(combined);

  if (state === 'succeeded') {
    return { refundState: 'charged', refundNote: 'Nguồn KHÔNG hoàn (đã tạo xong & trừ phí)' };
  }
  if (state === 'cancelled') {
    return {
      refundState: 'refunded',
      refundNote: explicitRefund ? 'Nguồn xác nhận đã hoàn phí' : 'Nguồn đã hoàn phí (đơn đã huỷ)',
    };
  }
  if (state === 'failed') {
    return {
      refundState: 'refunded',
      refundNote: explicitRefund ? 'Nguồn xác nhận đã hoàn phí' : 'Nguồn đã hoàn phí (job lỗi tự hoàn)',
    };
  }
  if (state === 'processing' || state === 'queued') {
    return { refundState: 'holding', refundNote: 'Nguồn đang giữ phí (chờ kết quả)' };
  }
  return { refundState: 'unknown', refundNote: 'Đang kiểm tra trạng thái phí nguồn' };
}

function extractStoredUpstreamLive(output: unknown, provider = ''): TaskUpstreamLiveStatus | null {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__upstreamLive;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== 'string' || typeof o.checkedAt !== 'string') return null;
  const state = o.state as TaskUpstreamLiveStatus['state'];
  const inferred = inferUpstreamRefund(provider, state, null, typeof o.message === 'string' ? o.message : null);
  return {
    state,
    refundState: (typeof o.refundState === 'string' ? (o.refundState as TaskUpstreamLiveStatus['refundState']) : undefined) ?? inferred.refundState,
    refundNote: (typeof o.refundNote === 'string' ? o.refundNote : undefined) ?? inferred.refundNote,
    rawStatus: typeof o.rawStatus === 'string' ? o.rawStatus : undefined,
    progress: typeof o.progress === 'number' ? o.progress : undefined,
    resultUrl: typeof o.resultUrl === 'string' ? o.resultUrl : undefined,
    message: typeof o.message === 'string' ? o.message : undefined,
    checkedAt: o.checkedAt,
  };
}

function extractRawStatusFromObj(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of ['status', 'state', 'task_status', 'job_status', 'pollStatus']) {
    if (typeof obj[k] === 'string' && obj[k]) return String(obj[k]);
  }
  if (obj.data && typeof obj.data === 'object') {
    const d = obj.data as Record<string, unknown>;
    for (const k of ['status', 'state', 'task_status']) {
      if (typeof d[k] === 'string' && d[k]) return String(d[k]);
    }
  }
  return undefined;
}

function extractTaskUpstreamLive(r: {
  provider?: string;
  status: string;
  providerTaskId: string | null;
  progress?: number;
  error?: string | null;
  completedAt?: Date | null;
  updatedAt?: Date;
  providerData?: unknown;
  output: unknown;
}): TaskUpstreamLiveStatus {
  const prov = r.provider ?? '';
  const stored = extractStoredUpstreamLive(r.output, prov);
  if (stored) return stored;
  const withRefund = (base: TaskUpstreamLiveStatus): TaskUpstreamLiveStatus => {
    const inf = inferUpstreamRefund(prov, base.state, r.providerData, base.message ?? r.error);
    return { ...base, refundState: inf.refundState, refundNote: inf.refundNote };
  };
  if (!r.providerTaskId) {
    if (r.status === 'PENDING') {
      return withRefund({ state: 'queued', message: 'Đang chờ gửi sang nguồn', checkedAt: '' });
    }
    return withRefund({ state: 'no_task_id', message: 'Chưa tạo đơn trên nguồn', checkedAt: (r.completedAt ?? r.updatedAt)?.toISOString() ?? '' });
  }
  const uc = extractTaskUpstreamCancel(r.output);
  if (uc) {
    if (uc.ok || (uc.upstreamStatus && /cancel|abort|stopped|deleted/i.test(uc.upstreamStatus))) {
      return withRefund({
        state: 'cancelled',
        rawStatus: uc.upstreamStatus || 'cancelled',
        message: 'Đã huỷ trên nguồn',
        checkedAt: uc.attemptedAt,
      });
    }
    if (uc.upstreamStatus && /succeed|complete|done|finish/i.test(uc.upstreamStatus)) {
      return withRefund({
        state: 'succeeded',
        rawStatus: uc.upstreamStatus,
        progress: 100,
        message: 'Đã tạo xong trên nguồn',
        checkedAt: uc.attemptedAt,
      });
    }
    if (uc.upstreamStatus && /fail|error|reject/i.test(uc.upstreamStatus)) {
      return withRefund({
        state: 'failed',
        rawStatus: uc.upstreamStatus,
        message: 'Đã dừng / lỗi trên nguồn',
        checkedAt: uc.attemptedAt,
      });
    }
    if (uc.upstreamStatus && /process|run|pending|queue/i.test(uc.upstreamStatus)) {
      return withRefund({
        state: /pending|queue/i.test(uc.upstreamStatus) ? 'queued' : 'processing',
        rawStatus: uc.upstreamStatus,
        progress: r.progress && r.progress > 0 ? r.progress : undefined,
        message: 'Nguồn vẫn đang xử lý',
        checkedAt: uc.attemptedAt,
      });
    }
  }
  const sc = extractTaskStuckCheck(r.output);
  if (sc && (r.status === 'PROCESSING' || r.status === 'PENDING')) {
    const isQueued = /queue|wait|pending/i.test(sc.upstreamStatus);
    return withRefund({
      state: isQueued ? 'queued' : 'processing',
      rawStatus: sc.upstreamStatus,
      progress: sc.progress ?? (r.progress && r.progress > 0 ? r.progress : undefined),
      message: sc.summary,
      checkedAt: sc.checkedAt,
    });
  }
  if (r.status === 'FAILED' && r.error && !/quá lâu|gián đoạn|không còn khả dụng/i.test(r.error)) {
    return withRefund({
      state: 'failed',
      rawStatus: 'failed',
      message: r.error.slice(0, 120),
      checkedAt: (r.completedAt ?? r.updatedAt)?.toISOString() ?? '',
    });
  }
  return withRefund({
    state: 'unknown',
    progress: r.progress && r.progress > 0 ? r.progress : undefined,
    message: 'Đang hỏi API nguồn...',
    checkedAt: '',
  });
}

/** Chuẩn hoá nhãn từ trang Tạo hàng loạt (vd "#1" -> "01", "Dự án A #3" -> "Dự án A - 03") */
function formatBatchLabel(raw: string | undefined, padLen: number): string {
  if (!raw) return '';
  const s = raw.trim().slice(0, 100);
  if (!s) return '';
  const onlyNum = /^#?(\d+)$/.exec(s);
  if (onlyNum) return onlyNum[1].padStart(padLen, '0');
  const projNum = /^(.*?)\s*#(\d+)$/.exec(s);
  if (projNum) {
    const prefix = sanitizeNamePart(projNum[1]);
    const num = projNum[2].padStart(padLen, '0');
    return prefix ? `${prefix} - ${num}` : num;
  }
  return sanitizeNamePart(s);
}

/** Đoán đuôi file kết quả từ tên, URL hoặc loại media */
function guessOutputExt(url: string, type?: unknown, name?: unknown): string {
  if (typeof name === 'string') {
    const m = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
    if (m) return m[1].toLowerCase();
  }
  const u = url.split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{2,5})$/i.exec(u);
  if (m) return m[1].toLowerCase();
  if (type === 'video') return 'mp4';
  if (type === 'audio') return 'mp3';
  if (type === 'image') return 'png';
  return 'bin';
}

type HealedParamKind = 'resolution' | 'duration' | 'aspectRatio';

interface UpstreamParamMismatch {
  paramKind: HealedParamKind;
  allowed: string[];
  labelVi: string;
}

function formatHealedOptionLabel(kind: HealedParamKind, val: string): string {
  if (kind === 'duration') return `${val.replace(/s$/i, '')} giây`;
  if (kind === 'aspectRatio') {
    if (val === '16:9') return '16:9 (Ngang)';
    if (val === '9:16') return '9:16 (Dọc)';
    if (val === '1:1') return '1:1 (Vuông)';
    if (/^auto$/i.test(val)) return 'Tự động';
    return val;
  }
  const l = val.toLowerCase();
  if (l === '4k') return '4K Ultra HD';
  if (l === '3k') return '3K Ultra';
  if (l === '2k') return '2K QHD';
  if (l === '1k') return '1K';
  if (l === '1080p') return '1080p Full HD';
  if (l === '768p') return '768p Tiết kiệm';
  if (l === '720p') return '720p HD';
  if (l === '480p') return '480p Tiết kiệm';
  return val.toUpperCase();
}

/**
 * T-507: Bóc tách tự động lỗi sai tham số từ phản hồi trực tiếp của API nguồn
 * (vd: `minimax-h3 resolution must be one of ['480p', '720p', '1080p', '2k'].`,
 *  `aspect_ratio must be one of ['16:9', '9:16']`, `duration must be one of [5, 10, 15]`,
 *  `Input should be '480p', '720p' or '1080p'`).
 */
function parseUpstreamParamMismatch(rawText: string): UpstreamParamMismatch | null {
  const s = String(rawText ?? '');
  if (!s) return null;

  const validateTokens = (kind: HealedParamKind, rawItems: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
      const clean = raw.replace(/^['"`\s]+|['"`\s.]+$/g, '').trim();
      if (!clean) continue;
      if (kind === 'resolution') {
        if (!/^(?:360p|480p|540p|576p|720p|768p|1080p|1440p|2160p|1k|2k|3k|4k|low|medium|high|standard|hd)$/i.test(clean)) return [];
      } else if (kind === 'duration') {
        if (!/^\d{1,3}s?$/i.test(clean)) return [];
      } else if (kind === 'aspectRatio') {
        if (!/^(?:auto|\d{1,2}(?:\.\d+)?:\d{1,2}(?:\.\d+)?)$/i.test(clean)) return [];
      }
      const key = clean.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(kind === 'duration' ? clean.replace(/s$/i, '') : clean);
      }
    }
    return out.length >= 1 && out.length <= 15 ? out : [];
  };

  const kindOfName = (name: string): { kind: HealedParamKind; labelVi: string } | null => {
    const n = name.toLowerCase();
    if (n === 'resolution' || n === 'quality' || n === 'res' || n === 'size') {
      return { kind: 'resolution', labelVi: 'độ phân giải' };
    }
    if (n === 'duration' || n === 'seconds' || n === 'duration_sec' || n === 'durationsec') {
      return { kind: 'duration', labelVi: 'thời lượng' };
    }
    if (n === 'aspect_ratio' || n === 'aspectratio' || n === 'ratio') {
      return { kind: 'aspectRatio', labelVi: 'tỉ lệ khung hình' };
    }
    return null;
  };

  const bracketRe =
    /\b(resolution|quality|res|size|duration|seconds|duration_sec|durationSec|aspect_ratio|aspectRatio|ratio)\b[^[\n]{0,90}?(?:must be one of|one of|in|allowed(?:\s+values)?\s*:?|supported(?:\s+values)?\s*:?)\s*\[([^\]]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = bracketRe.exec(s)) !== null) {
    const meta = kindOfName(m[1]);
    if (!meta) continue;
    const allowed = validateTokens(meta.kind, m[2].split(','));
    if (allowed.length) return { paramKind: meta.kind, allowed, labelVi: meta.labelVi };
  }

  const pydanticRe = /Input should be\s+((?:'[^']+'|"[^"]+"|\d+)(?:\s*,\s*(?:'[^']+'|"[^"]+"|\d+))*\s*(?:,?\s*or\s+(?:'[^']+'|"[^"]+"|\d+))?)/i.exec(s);
  if (pydanticRe) {
    const rawTokens = pydanticRe[1].split(/\s*(?:,|\bor\b)\s*/i);
    const fieldHit = /\b(resolution|quality|duration|seconds|aspect_ratio|aspectRatio|ratio)\b/i.exec(s);
    const meta = fieldHit ? kindOfName(fieldHit[1]) : null;
    if (meta) {
      const allowed = validateTokens(meta.kind, rawTokens);
      if (allowed.length) return { paramKind: meta.kind, allowed, labelVi: meta.labelVi };
    }
  }

  return null;
}

/**
 * T-507: Áp dụng trực tiếp danh sách tuỳ chọn đã tự sửa lỗi (`options.healedFieldOptions`) lên `AiToolDef.fields`
 * để gỡ tức thì các độ phân giải / thời lượng / tỉ lệ không hợp lệ khỏi form Studio khách & Admin mà không cần chờ deploy lại.
 */
function applyHealedFields(def: AiToolDef, options: unknown): AiToolDef {
  const rawHealed = (options as Record<string, unknown> | null)?.healedFieldOptions;
  if (!rawHealed || typeof rawHealed !== 'object') return def;
  const healed = rawHealed as Partial<Record<HealedParamKind, string[]>>;
  const resAllowed = Array.isArray(healed.resolution) && healed.resolution.length ? healed.resolution : null;
  const durAllowed = Array.isArray(healed.duration) && healed.duration.length ? healed.duration : null;
  const arAllowed = Array.isArray(healed.aspectRatio) && healed.aspectRatio.length ? healed.aspectRatio : null;
  if (!resAllowed && !durAllowed && !arAllowed) return def;

  let mutated = false;
  const nextFields = def.fields.map((f) => {
    if (f.type !== 'select' || !Array.isArray(f.options) || !f.options.length) return f;
    const fn = f.name.toLowerCase();

    const syncSelect = (kind: HealedParamKind, allowedList: string[]) => {
      const allowedLower = new Map(allowedList.map((v) => [v.toLowerCase(), v]));
      const existingByLower = new Map(
        f.options!.map((o) => [
          kind === 'duration' ? String(o.value).replace(/s$/i, '').toLowerCase() : String(o.value).toLowerCase(),
          o,
        ]),
      );
      const nextOpts: { value: string; label: string }[] = [];
      for (const [low, canonical] of allowedLower) {
        const prev = existingByLower.get(low);
        if (prev) nextOpts.push(prev);
        else nextOpts.push({ value: canonical, label: formatHealedOptionLabel(kind, canonical) });
      }
      if (!nextOpts.length) return f;
      const curDef = f.default !== undefined && f.default !== null ? String(f.default) : '';
      const hasDef = curDef && nextOpts.some((o) => String(o.value).toLowerCase() === curDef.toLowerCase());
      const nextDef = hasDef ? f.default : nextOpts[0].value;
      const sameOpts =
        nextOpts.length === f.options!.length &&
        nextOpts.every((o, i) => o.value === f.options![i].value && o.label === f.options![i].label) &&
        nextDef === f.default;
      if (sameOpts) return f;
      mutated = true;
      return { ...f, options: nextOpts, default: nextDef };
    };

    if (resAllowed && (fn === 'resolution' || fn === 'quality' || fn === 'res')) {
      return syncSelect('resolution', resAllowed);
    }
    if (durAllowed && (fn === 'duration' || fn === 'durationsec' || fn === 'seconds' || fn === 'dur')) {
      return syncSelect('duration', durAllowed);
    }
    if (arAllowed && (fn === 'aspectratio' || fn === 'aspect_ratio' || fn === 'ratio')) {
      return syncSelect('aspectRatio', arAllowed);
    }
    if ((resAllowed || durAllowed) && fn === 'option' && f.options.some((o) => /^\d+\|[a-z0-9]+$/i.test(String(o.value)))) {
      const resSet = resAllowed ? new Set(resAllowed.map((v) => v.toLowerCase())) : null;
      const durSet = durAllowed ? new Set(durAllowed.map((v) => v.replace(/s$/i, '').toLowerCase())) : null;
      const filtered = f.options.filter((o) => {
        const m = /^(\d+)\|([a-z0-9]+)$/i.exec(String(o.value));
        if (!m) return true;
        if (durSet && !durSet.has(m[1].toLowerCase())) return false;
        if (resSet && !resSet.has(m[2].toLowerCase())) return false;
        return true;
      });
      if (filtered.length > 0 && filtered.length !== f.options.length) {
        mutated = true;
        const curDef = f.default !== undefined ? String(f.default) : '';
        const keepDef = filtered.some((o) => o.value === curDef) ? f.default : filtered[0].value;
        return { ...f, options: filtered, default: keepDef };
      }
    }
    return f;
  });

  return mutated ? { ...def, fields: nextFields } : def;
}

/**
 * T-507: Ánh xạ thông minh tham số bị nguồn từ chối sang lựa chọn hợp lệ gần nhất trong `mismatch.allowed`
 * để tự động gửi lại ngay cho khách mà không làm rớt đơn.
 */
function remapInputForAllowedParam(
  input: AiInput,
  mismatch: UpstreamParamMismatch,
): { changed: boolean; nextInput: AiInput; fromVal: string; toVal: string } {
  const allowed = mismatch.allowed;
  if (!allowed.length) return { changed: false, nextInput: input, fromVal: '', toVal: '' };

  const pickBestRes = (raw: string): string => {
    const low = raw.trim().toLowerCase();
    const chain: Record<string, string[]> = {
      '768p': ['480p', '720p', '1080p'],
      '480p': ['768p', '720p', '1080p'],
      '4k': ['2k', '1080p', '720p'],
      '3k': ['2k', '4k', '1k'],
      '2k': ['1080p', '4k', '720p', '1k'],
      '1080p': ['720p', '2k', '480p'],
      '720p': ['1080p', '480p', '768p'],
    };
    for (const c of chain[low] ?? []) {
      const hit = allowed.find((a) => a.toLowerCase() === c);
      if (hit) return hit;
    }
    return allowed[0];
  };

  const pickBestDur = (raw: string): string => {
    const num = Number(raw.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(num) || num <= 0) return allowed[0];
    let best = allowed[0];
    let bestDiff = Infinity;
    for (const a of allowed) {
      const an = Number(a.replace(/[^\d.]/g, ''));
      if (Number.isFinite(an) && Math.abs(an - num) < bestDiff) {
        bestDiff = Math.abs(an - num);
        best = a;
      }
    }
    return best;
  };

  const pickBestRatio = (): string =>
    allowed.find((a) => a === '16:9') ?? allowed.find((a) => a === '9:16') ?? allowed.find((a) => a === '1:1') ?? allowed[0];

  const nextInput: AiInput = { ...input };
  const candidateKeys =
    mismatch.paramKind === 'resolution'
      ? ['resolution', 'quality', 'res', 'size']
      : mismatch.paramKind === 'duration'
        ? ['duration', 'durationSec', 'seconds', 'dur']
        : ['aspectRatio', 'aspect_ratio', 'ratio'];

  for (const k of candidateKeys) {
    if (typeof nextInput[k] === 'string' && String(nextInput[k]).trim()) {
      const cur = String(nextInput[k]).trim();
      if (allowed.some((a) => a.toLowerCase() === cur.toLowerCase())) continue;
      const target =
        mismatch.paramKind === 'resolution'
          ? pickBestRes(cur)
          : mismatch.paramKind === 'duration'
            ? pickBestDur(cur)
            : pickBestRatio();
      nextInput[k] = target;
      return { changed: true, nextInput, fromVal: cur, toVal: target };
    }
  }

  if (typeof nextInput.option === 'string' && /^\d+\|[a-z0-9]+$/i.test(nextInput.option.trim())) {
    const [dPart, rPart] = nextInput.option.trim().split('|');
    if (mismatch.paramKind === 'resolution' && !allowed.some((a) => a.toLowerCase() === rPart.toLowerCase())) {
      const target = pickBestRes(rPart);
      nextInput.option = `${dPart}|${target}`;
      return { changed: true, nextInput, fromVal: rPart, toVal: target };
    }
    if (mismatch.paramKind === 'duration' && !allowed.some((a) => a === dPart)) {
      const target = pickBestDur(dPart);
      nextInput.option = `${target}|${rPart}`;
      return { changed: true, nextInput, fromVal: dPart, toVal: target };
    }
  }

  return { changed: false, nextInput: input, fromVal: '', toVal: '' };
}

/**
 * T-479: Sinh tự động `Mô tả ngắn` chuẩn chỉnh, giàu thông tin kỹ thuật thực tế (độ phân giải, thời lượng,
 * số ảnh/video/âm thanh tham chiếu, tỉ lệ khung hình, giới hạn ký tự...) theo đúng `def.fields` live của từng model.
 */
function buildDetailedModelDescription(
  def: AiToolDef,
  toolKey: string,
  displayName: string,
  modelLabel?: string | null,
): string {
  const isSplitChild = toolKey.includes('~');
  const rawExisting = def.description ? hideProviderText(def.description).trim() : '';

  // Với các tiện ích chuyên biệt không phải model sinh ảnh/video (tải TikTok, xoá metadata, xoá nền, ghép video, dịch/viết/tóm tắt)
  // nếu adapter đã có mô tả chi tiết riêng (không phải câu mẫu ngắn) và không phải dòng con tách từ công cụ cha thì giữ mô tả chuẩn đó
  const isUtilityOrText =
    def.output === 'text' ||
    def.pricing.mode === 'free' ||
    /tiktok|bulk-download|xoa-meta|remove-bg|remove-logo|remove-ai-label|video-stitch/.test(toolKey);
  if (isUtilityOrText && !isSplitChild && rawExisting.length >= 55 && !/^tạo\s.*bằng\s+model\b/i.test(rawExisting)) {
    return rawExisting;
  }

  // Làm sạch tên hiển thị của model để đưa vào câu mở đầu tự nhiên
  const rawTitle = (modelLabel?.trim() || displayName || '')
    .replace(/^(?:Tạo ảnh AI|Sửa ảnh AI|Sửa & ghép ảnh[^·]*|Tạo ảnh đa model|Tạo video AI|Tạo video đa model|Seedance Video|Kling AI Video|Chuyển ảnh thành video|Ảnh thành video|Văn bản thành video|Khung đầu\s*[–-]\s*khung cuối)\s*[·•—-]\s*/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+-\s+(?=\d)/g, ' ')
    .replace(/^COLORS\s+(\d+(?:\.\d+)?)\s*-\s*Kling AI$/i, 'Kling COLORS $1')
    .replace(/-/g, (m, off, str) => {
      const prev = str[off - 1] ?? '';
      const next = str[off + 1] ?? '';
      if (/[A-Za-z]/.test(prev) && /[A-Za-z0-9]/.test(next) && /GPT-Image|Quality-Slow/i.test(str)) return ' ';
      return m;
    })
    .replace(/\s{2,}/g, ' ')
    .trim() || sanitizeToolDisplayName(displayName);

  // 1. Trích xuất độ phân giải & thời lượng thực tế từ `def.fields`
  const resSet = new Set<string>();
  const durNums = new Set<number>();
  const ratioSet = new Set<string>();
  let maxRefImages = 0;
  let hasSingleImage = false;
  let singleImageRequired = false;
  let hasEndFrame = false;
  let hasRefVideo = false;
  let hasRefAudio = false;
  let hasAudioToggle = false;
  let hasTransparentBg = false;
  let promptMax: number | null = null;

  const normResToken = (tok: string): string | null => {
    const clean = tok.trim().toUpperCase();
    if (/^(360P|480P|576P|720P|768P|1080P)$/.test(clean)) return clean.toLowerCase();
    if (/^1440P$/.test(clean)) return '2K';
    if (/^2160P$/.test(clean)) return '4K';
    if (/^(1K|2K|3K|4K)$/.test(clean)) return clean;
    if (/^4KP$/.test(clean)) return '4K+';
    return null;
  };

  for (const f of def.fields) {
    if (f.hidden) continue;
    const fn = f.name.toLowerCase();
    if ((f.type === 'textarea' || f.type === 'text') && (fn === 'prompt' || fn === 'text')) {
      if (typeof f.max === 'number' && f.max > 0) promptMax = f.max;
    }
    if (f.type === 'image') {
      if (fn.includes('end') || fn.includes('last')) {
        hasEndFrame = true;
      } else if (f.multiple) {
        maxRefImages = Math.max(maxRefImages, f.maxFiles ?? 4);
      } else {
        hasSingleImage = true;
        if (f.required) singleImageRequired = true;
      }
    }
    if (f.type === 'video') hasRefVideo = true;
    if (f.type === 'audio') hasRefAudio = true;
    if (fn === 'withaudio' || fn === 'audio' || fn === 'include_audio' || fn === 'sound') {
      if (f.type === 'boolean' || f.type === 'select') hasAudioToggle = true;
    }
    if (fn === 'transparent') hasTransparentBg = true;

    const allOpts = [
      ...(f.options ?? []),
      ...Object.values(f.optionsBy?.map ?? {}).flat(),
    ];
    if (!allOpts.length) continue;

    if (fn === 'option' || allOpts.some((o) => /^\d*\|/.test(String(o.value)))) {
      for (const o of allOpts) {
        const [dPart, rPart] = String(o.value).split('|');
        const dn = Number(dPart);
        if (Number.isFinite(dn) && dn > 0) durNums.add(dn);
        const nr = rPart ? normResToken(rPart) : null;
        if (nr) resSet.add(nr);
      }
      continue;
    }
    if (fn === 'resolution' || fn === 'quality' || fn === 'res' || fn === 'target') {
      for (const o of allOpts) {
        const nr = normResToken(String(o.value)) ?? normResToken(String(o.label).split(/\s/)[0] ?? '');
        if (nr) resSet.add(nr);
      }
    } else if (fn === 'size') {
      for (const o of allOpts) {
        const lbl = `${o.value} ${o.label}`;
        if (/\b4k\b|3840|4096/i.test(lbl)) resSet.add('4K');
        else if (/\b2k\b|2752|2048/i.test(lbl)) resSet.add('2K');
        else if (/\b1k\b|1024|1536/i.test(lbl)) resSet.add('1K');
        const rm = /\b(\d{1,2}:\d{1,2})\b/.exec(lbl);
        if (rm) ratioSet.add(rm[1]);
      }
    } else if (fn === 'duration' || fn === 'durationsec' || fn === 'seconds' || fn === 'targetduration' || fn === 'dur') {
      for (const o of allOpts) {
        const dn = Number(String(o.value).replace(/s$/i, ''));
        if (Number.isFinite(dn) && dn > 0) durNums.add(dn);
      }
    } else if (fn === 'aspectratio' || fn === 'aspect_ratio' || fn === 'ratio') {
      for (const o of allOpts) {
        const v = String(o.value).trim();
        if (/^\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(v)) ratioSet.add(v);
      }
    }
  }

  const RES_ORDER = ['360p', '480p', '576p', '720p', '768p', '1080p', '1K', '2K', '3K', '4K', '4K+'];
  const sortedRes = [...resSet].sort((a, b) => RES_ORDER.indexOf(a) - RES_ORDER.indexOf(b));
  const sortedDurs = [...durNums].sort((a, b) => a - b);

  const resPhrase =
    sortedRes.length > 1
      ? `chất lượng ${sortedRes[0]} – ${sortedRes[sortedRes.length - 1]} (${sortedRes.join(', ')})`
      : sortedRes.length === 1
        ? `chuẩn nét ${sortedRes[0]}`
        : '';

  const durPhrase =
    sortedDurs.length > 1
      ? `thời lượng linh hoạt ${sortedDurs[0]}s – ${sortedDurs[sortedDurs.length - 1]}s`
      : sortedDurs.length === 1
        ? `thời lượng ${sortedDurs[0]} giây`
        : '';

  const refPhrases: string[] = [];
  if (def.pairs?.fields?.includes('image') && def.pairs?.fields?.includes('video')) {
    refPhrases.push(`chạy đồng loạt tới ${def.pairs.max} cặp [ảnh nhân vật + video chuyển động mẫu]`);
  } else {
    if (hasEndFrame && hasSingleImage) {
      refPhrases.push('nội suy mượt mà từ cặp ảnh khung đầu & khung cuối');
    }
    if (maxRefImages > 0) {
      refPhrases.push(`hỗ trợ tới ${maxRefImages} ảnh tham chiếu giữ đồng nhất nhân vật/bối cảnh`);
    } else if (hasSingleImage && !hasEndFrame) {
      refPhrases.push(singleImageRequired ? 'chuyển đổi trực tiếp từ ảnh gốc' : 'hỗ trợ tải kèm ảnh tham chiếu');
    }
    if (hasRefVideo) refPhrases.push('nhận video tham chiếu góc máy/chuyển động');
    if (hasRefAudio) refPhrases.push('nhận file âm thanh/giọng thoại mẫu');
  }
  if (hasTransparentBg) refPhrases.push('hỗ trợ tách nền PNG trong suốt');

  const ratioArr = [...ratioSet];
  const ratioPhrase =
    ratioArr.length >= 3
      ? `đa tỉ lệ khung hình (${ratioArr.slice(0, 5).join(', ')}${ratioArr.length > 5 ? '...' : ''})`
      : ratioArr.length > 0
        ? `khung hình ${ratioArr.join(', ')}`
        : '';

  const hay = `${rawTitle} ${toolKey}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Audio tự nhiên trên các dòng video thế hệ mới
  const nativeAudio =
    hasAudioToggle ||
    (def.output === 'video' &&
      /seedance[\s._-]*2|veo[\s._-]*3|omni[\s._-]*flash|kling[\s._-]*(3|4)|minimax[\s._-]*h3|wan[\s._-]*3|grok.*1[._-]5|flux[\s._-]*3/.test(hay));
  if (nativeAudio && def.output === 'video' && !refPhrases.some((p) => p.includes('âm thanh'))) {
    refPhrases.push('tích hợp âm thanh & hiệu ứng tự nhiên');
  }

  const promptPhrase =
    promptMax && promptMax >= 10_000
      ? `prompt dài tới ${promptMax.toLocaleString('vi-VN')} ký tự`
      : !promptMax && def.fields.some((f) => !f.hidden && (f.name === 'prompt' || f.name === 'text'))
        ? 'không giới hạn ký tự mô tả'
        : '';

  const specsTail = [durPhrase, resPhrase, ...refPhrases, ratioPhrase, promptPhrase].filter(Boolean).join(', ');

  // 2. Ghép phần mở đầu đặc trưng theo đúng dòng công nghệ model
  const isEditOnly =
    def.category === 'chinh-sua-anh-ai' ||
    /\.(?:edit|grok-edit)(?:~|$)|sua-anh|image-outfit|body-edit/.test(toolKey);

  if (def.output === 'audio') {
    if (/suno|lyria|music|nhac/.test(hay)) {
      return `Sáng tác bài hát trọn vẹn có giọng hát tự nhiên & hòa âm phối khí chuyên nghiệp bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
    }
    return `Chuyển đổi văn bản thành giọng đọc AI truyền cảm, ngắt nghỉ tự nhiên chuẩn phòng thu bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
  }

  if (def.output === 'image') {
    if (/upscale|lam[\s-]*net|nang[\s-]*cap[\s-]*anh/.test(hay) && !/gpt|banana|seedream|dreamina/.test(hay)) {
      return `Phóng đại và phục chế độ sắc nét ảnh lên chất lượng cao bằng ${rawTitle} — tái tạo chi tiết viền cạnh, da mặt & chữ viết rõ nét${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (isEditOnly) {
      return `Chỉnh sửa chi tiết, thay đổi trang phục/phông nền và ghép nhiều chủ thể mượt mà bằng ${rawTitle} — giữ nguyên nét mặt & ánh sáng tự nhiên${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/dreamina/.test(hay)) {
      return `Tạo và chỉnh sửa ảnh AI nghệ thuật, chân dung & ấn phẩm thương mại sắc nét bằng ${rawTitle} — lên màu điện ảnh, chi tiết ánh sáng chân thực${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/seedream/.test(hay)) {
      return `Tạo và biến đổi ảnh AI độ chân thực cao bằng ${rawTitle} — bố cục thẩm mỹ chuẩn studio, dựng chữ viết sắc sảo${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/gpt[\s._-]*image|imagegen/.test(hay)) {
      return `Tạo và chỉnh sửa/ghép ảnh AI thông minh bằng ${rawTitle} — bám sát yêu cầu phức tạp, hiển thị chữ chuẩn xác trên ảnh${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/nano[\s._-]*banana|gemini/.test(hay)) {
      return `Tạo và chỉnh sửa ảnh AI tốc độ cao bằng ${rawTitle} — hiểu sâu mô tả tiếng Việt, giữ nét mặt & chi tiết chủ thể tự nhiên${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/midjourney|\bmj\b/.test(hay)) {
      return `Sáng tạo hình ảnh nghệ thuật, concept art & nhiếp ảnh điện ảnh đỉnh cao bằng ${rawTitle} — chiều sâu ánh sáng và chất liệu vượt trội${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/imagen/.test(hay)) {
      return `Tạo ảnh AI siêu thực chuẩn nhiếp ảnh thương mại bằng Google ${rawTitle.replace(/^google\s+/i, '')} — độ chi tiết sắc sảo, màu sắc sống động${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/kling|colors|\bo1\b/.test(hay)) {
      return `Tạo ảnh AI nhân vật & bối cảnh điện ảnh bằng ${rawTitle} — giữ đồng nhất gương mặt, trang phục và ánh sáng ấn tượng${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/flux/.test(hay)) {
      return `Tạo ảnh AI độ chi tiết cao & chuẩn giải phẫu tự nhiên bằng ${rawTitle} — xử lý ánh sáng phức tạp và chữ viết sắc nét${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/grok/.test(hay)) {
      return `Tạo và biến đổi ảnh AI sáng tạo tốc độ nhanh bằng ${rawTitle} — bám sát mô tả chi tiết, phong cách chân thực sống động${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/ideogram/.test(hay)) {
      return `Thiết kế poster, logo, typography & hình ảnh quảng cáo chuẩn xác bằng ${rawTitle} — dựng chữ nghệ thuật sắc nét${specsTail ? `, ${specsTail}` : ''}.`;
    }
    return `Tạo và chỉnh sửa ảnh AI sắc nét chất lượng cao bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
  }

  if (def.output === 'video') {
    if (/upscale|topaz|lam[\s-]*net/.test(hay)) {
      return `Nâng cấp độ phân giải, khử nhiễu và làm mượt khung hình video chuyên sâu bằng ${rawTitle} — giữ trọn chi tiết khuôn mặt & chuyển động gốc${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/motion[\s._-]*control|betamotion|dieu[\s-]*khien[\s-]*chuyen[\s-]*dong|sao[\s-]*chep/.test(hay)) {
      return `Sao chép chuẩn xác chuyển động cơ thể, vũ đạo & biểu cảm từ video mẫu sang nhân vật ảnh bằng ${rawTitle} — chống nhòe nền, giữ khung hình mượt mà${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/lipsync|avatar|heygen|talking/.test(hay)) {
      return `Tạo video nhân vật AI nói chuyện, nhép môi khớp chuẩn từng âm tiết & biểu cảm khuôn mặt tự nhiên bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
    }
    if (/genjutsu/.test(hay)) {
      return `Biến đổi nhân vật, trang phục hoặc đạo cụ trực tiếp trong video bằng ${rawTitle} — giữ nguyên chuyển động camera và ánh sáng cảnh gốc${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/seedance/.test(hay)) {
      return `Tạo video AI điện ảnh chuyển động mượt mà bằng ${rawTitle} — giữ đồng nhất nhân vật qua nhiều góc quay${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/omni[\s._-]*flash|veo/.test(hay)) {
      return `Tạo video AI sắc nét theo sát kịch bản chi tiết bằng ${rawTitle} — chuyển động vật lý và ánh sáng điện ảnh tự nhiên${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/kling/.test(hay)) {
      return `Dựng video AI chuyển động vật lý chân thực & biểu cảm nhân vật sống động bằng ${rawTitle} — điều khiển góc máy điện ảnh mượt mà${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/minimax|hailuo|\bh3\b/.test(hay)) {
      return `Dựng video AI giàu cảm xúc, diễn xuất nhân vật tự nhiên bằng ${rawTitle} — bám sát kịch bản hành động phức tạp${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/\bwan\b/.test(hay)) {
      return `Tạo video AI đa cảnh quay liền mạch bằng ${rawTitle} — hiệu ứng ánh sáng và chuyển động giàu tính điện ảnh${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/grok/.test(hay)) {
      return `Tạo video AI tốc độ nhanh, chuyển động sống động bằng ${rawTitle} — bám sát mô tả hành động và bối cảnh${specsTail ? `, ${specsTail}` : ''}.`;
    }
    if (/flux/.test(hay)) {
      return `Tạo video AI chất lượng điện ảnh giàu chi tiết bằng ${rawTitle} — màu sắc sâu, bố cục và chuyển động tự nhiên${specsTail ? `, ${specsTail}` : ''}.`;
    }
    return `Tạo video AI chuyển động mượt mà, sắc nét bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
  }

  return rawExisting || `Xử lý tác vụ AI chuyên nghiệp bằng ${rawTitle}${specsTail ? ` — ${specsTail}` : ''}.`;
}

/** Đọc % tiến độ thực tế từ adapter hoặc dữ liệu thô nguồn trả về (hỗ trợ cả số 45, số thập phân 0.45 và chuỗi "45%") */
function parsePctValue(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (val <= 0) return 0;
    if (val > 0 && val < 1) return Math.round(val * 100);
    return Math.min(99, Math.round(val));
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const isPct = trimmed.endsWith('%');
    const n = Number(trimmed.replace(/%$/, '').trim());
    if (!Number.isFinite(n) || n <= 0) return null;
    if (!isPct && n > 0 && n < 1 && trimmed.includes('.')) return Math.round(n * 100);
    return Math.min(99, Math.round(n));
  }
  return null;
}

function extractUpstreamProgress(resProgress?: number, raw?: unknown): number | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const sub = (k: string) => (r?.[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : null);
  const candidates: unknown[] = [
    r?.progress_percent,
    r?.percent,
    r?.progress,
    sub('data')?.progress_percent,
    sub('data')?.percent,
    sub('data')?.progress,
    sub('video')?.progress,
    sub('image')?.progress,
    sub('task')?.progress,
    sub('job')?.progress,
    resProgress,
  ];
  let best: number | null = null;
  for (const c of candidates) {
    const p = parsePctValue(c);
    if (p !== null && p > 0 && (best === null || p > best)) best = p;
  }
  return best;
}

/** Kiểm tra dữ liệu thô từ nguồn xem đơn còn đang xếp hàng chờ GPU bên nguồn (`QUEUED` / `PENDING`) hay đã vào chạy thật */
function isUpstreamQueued(raw?: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const data = r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : null;
  const st = String(r.status ?? r.state ?? data?.status ?? data?.state ?? '').trim().toLowerCase();
  return st === 'queued' || st === 'in_queue' || st === 'waiting' || st === 'pending';
}

/** Thời gian xử lý trung bình thực tế (giây) của từng nhóm công cụ để nội suy % mượt & sát thực tế (T-399) */
function estimateTaskDurationSec(toolKey: string, outputKind?: string | null): number {
  const k = toolKey.toLowerCase();
  if (/tts|voice|audio|remove-bg|chat|write|translate/.test(k) || outputKind === 'audio' || outputKind === 'text') return 25;
  if (/upscale/.test(k)) return /video/.test(k) ? 95 : 30;
  if (outputKind === 'image' || /image|banana|seedream|flux|midjourney/.test(k)) return 42;
  if (/motion|kling|seedance|veo|wan|sora/.test(k)) return 145;
  return 90;
}

/** Chạy lại transaction khi PostgreSQL báo deadlock / xung đột ghi (40P01, 40001, P2034) — tối đa 3 lần */
async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const retry = e.code === 'P2034' || /40P01|40001|deadlock detected|could not serialize/i.test(`${e.code} ${e.message}`);
      if (!retry || i >= 2) throw err;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
}

/** Mã tác vụ ngắn dễ đọc: T + 7 ký tự */
const taskCode = () => `T${randomBytes(5).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 7)}`;

/**
 * AI Studio: danh mục công cụ (từ adapter + phần admin chỉnh trong DB), chạy tác vụ, trừ / hoàn credits.
 *
 * Vòng đời tác vụ: khách gửi → kiểm tra form, tính credits, kiểm tra số luồng → trừ credits + tạo tác vụ (một transaction)
 * → gửi sang nhà cung cấp → PROCESSING (cron hỏi trạng thái mỗi `pollSeconds`) → SUCCEEDED (sao lưu file kết quả)
 * hoặc FAILED / quá hạn `timeoutMinutes` → hoàn credits.
 */
/** Công cụ tính được giá "theo chi phí NCC" (adapter có `cost()` và hỗ trợ công cụ này) */
const supportsCost = (provider: AiProvider, def: AiToolDef) => !!provider.cost && (def.supportsCost ?? def.pricing.mode === 'cost');

/** Số lượt chạy lịch sử đã lưu trữ của công cụ (khi tác vụ cũ bị dọn theo chu kỳ 24h hoặc khách xoá khỏi lịch sử) */
const archivedRunsOf = (options: unknown): number => {
  const n = Number((options as Record<string, unknown> | null)?.archivedRuns);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Công cụ tính theo độ dài văn bản (ký tự / 1.000 ký tự) để admin bật chế độ "Tính theo ký tự" tự đặt */
const supportsPerChar = (def: AiToolDef) => def.unitLabel === '1.000 ký tự' || def.unitLabel === 'ký tự';

/** Công cụ có thời lượng (video / audio / chọn giây) để admin bật chế độ "Tính theo giây" tự đặt (bỏ qua công cụ thuần nhập chữ như TTS) */
const supportsPerSecond = (def: AiToolDef) => {
  const hasTimeInput = def.fields.some((f) => ['duration', 'durationSec', 'seconds', 'targetDuration', 'option'].includes(f.name) || f.type === 'video' || f.type === 'audio');
  if (supportsPerChar(def) && !hasTimeInput) return false;
  return def.output === 'video' || def.output === 'audio' || def.unitLabel === 'giây' || hasTimeInput;
};

/** Danh sách lựa chọn độ phân giải cố định của công cụ (để admin tự đặt giá riêng từng độ phân giải ở Sửa công cụ) */
const resolutionOptionsOf = (def: AiToolDef): { value: string; label: string }[] => {
  const f = def.fields.find((x) => (x.name === 'resolution' || x.name === 'quality' || x.name === 'size') && x.type === 'select');
  if (!f) return [];
  // lựa chọn theo ô khác (vd độ phân giải theo model hoặc theo model → mode): chỉ dùng được khi model gốc đã cố định 1 giá trị
  let options = f.options;
  if (f.optionsBy) {
    const parent = def.fields.find((x) => x.name === f.optionsBy!.field);
    if (parent?.default !== undefined && (!parent.options || parent.options.length <= 1) && !parent.optionsBy) {
      options = f.optionsBy.map[String(parent.default)];
    } else if (parent?.optionsBy) {
      const grand = def.fields.find((x) => x.name === parent.optionsBy!.field);
      const pOpts = grand?.default !== undefined && (!grand.options || grand.options.length <= 1) ? parent.optionsBy.map[String(grand.default)] : undefined;
      if (pOpts?.length) {
        const seen = new Set<string>();
        options = pOpts.flatMap((po) => f.optionsBy!.map[String(po.value)] ?? []).filter((o) => (seen.has(String(o.value)) ? false : (seen.add(String(o.value)), true)));
      }
    } else {
      options = undefined;
    }
  }
  return options?.length ? options.map((o) => ({ value: String(o.value), label: o.label })) : [];
};

/** Giá admin đặt cho độ phân giải khách chọn (`resolutionPrices`), không có / không hợp lệ thì null */
function resolutionPriceOf(def: AiToolDef, p: AiPricing, input: AiInput): number | null {
  const opts = resolutionOptionsOf(def);
  const f = def.fields.find((x) => (x.name === 'resolution' || x.name === 'quality' || x.name === 'size') && x.type === 'select');
  const rawVal = String(input.resolution ?? input.quality ?? input.size ?? f?.default ?? opts[0]?.value ?? '').trim();
  const map = p.resolutionPrices ?? {};
  const n = Number(map[rawVal] ?? map[rawVal.toLowerCase()] ?? Object.entries(map).find(([k]) => k.toLowerCase() === rawVal.toLowerCase())?.[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Tỉ giá quy đổi: 1 credit / xu nhà cung cấp = bao nhiêu credits web.
 * Lấy cài đặt `ai_<key>.rate` (admin nhập ở tab Khoá API), bỏ trống / lỗi thì dùng mặc định của adapter, không có nữa thì 1.
 */
const providerRate = (provider: AiProvider, cfg: AiProviderConfig) => (Number(cfg.rate) > 0 ? Number(cfg.rate) : Number(provider.rate) > 0 ? Number(provider.rate) : 1);

/** Hệ số % lãi của giá công cụ: markup 20 -> 1,2 (âm / lỗi coi như 0) */
const markupFactor = (p: AiPricing) => 1 + Math.max(0, Number(p.markup) || 0) / 100;

/**
 * Input giả theo lựa chọn mặc định của form (để báo giá một lượt cho admin):
 * lấy `default`, không có thì lựa chọn đầu tiên (theo cả optionsBy), số lấy `min`; ô file bỏ trống.
 */
function defaultInput(fields: AiFieldDef[]): AiInput {
  const input: AiInput = {};
  for (const f of fields) {
    if (f.default !== undefined) input[f.name] = f.default;
    else if (f.type === 'select') {
      const opts = f.optionsBy ? f.optionsBy.map[String(input[f.optionsBy.field] ?? '')] ?? f.options : f.options;
      if (opts?.length) input[f.name] = opts[0].value;
    } else if (f.type === 'number' && f.min !== undefined) input[f.name] = f.min;
    else if (f.type === 'boolean') input[f.name] = false;
  }
  return input;
}

/** Ký tự ngăn khoá công cụ gốc và model con: `<provider>.<tool>~<model>` (vd kapend.kling-video~kling_video_4_0) */
const MODEL_SEP = '~';

/**
 * Ô "Model AI" tự tách được của công cụ: select tên `model`, nhãn có chữ "Model" / "Mô hình" (bỏ qua ô cùng tên khác nghĩa
 * như "Người mẫu", "Chế độ"), lựa chọn cố định và có từ 2 model trở lên. Công cụ khai báo `splitModels: false` thì không tách.
 */
function splitModelField(def: AiToolDef): (AiFieldDef & { options: NonNullable<AiFieldDef['options']> }) | null {
  if (def.splitModels === false) return null;
  const f = def.fields.find((x) => x.name === 'model' && x.type === 'select' && !x.optionsBy && /model|mô hình/i.test(x.label));
  return f?.options && f.options.length >= 2 ? (f as AiFieldDef & { options: NonNullable<AiFieldDef['options']> }) : null;
}

/**
 * Định nghĩa công cụ con của một model: ô Model AI ẩn, chỉ còn đúng model đó (là giá trị mặc định).
 * Giữ nguyên `key` gốc để adapter tính giá / gửi tác vụ như công cụ gốc (model vẫn nằm trong input).
 */
function modelDef(def: AiToolDef, field: AiFieldDef, value: string): AiToolDef {
  return {
    ...def,
    fields: def.fields
      .filter((f) => !(f.showIf && f.showIf.field === field.name && !f.showIf.in.includes(value)))
      .map((f) => {
        if (f === field) {
          return { ...f, options: (f.options ?? []).filter((o) => o.value === value), default: value, hidden: true };
        }
        if (f.name === 'server' && f.optionsBy?.field === field.name) {
          const sub = f.optionsBy.map[value] ?? [];
          if (sub.length <= 1) {
            return { ...f, ...(sub[0] ? { default: sub[0].value } : {}), hidden: true };
          }
        }
        return { ...f, ...(f.showIf ? { showIf: { ...f.showIf, in: [...f.showIf.in] } } : {}) };
      }),
  };
}

/** Lựa chọn của ô form: che tên nhà cung cấp trong nhãn / mô tả */
/** Câu hỏi Muse (AHiep muse-video) trên tác vụ lỗi còn trả lời được: nguồn trả `can_reply` + `muse_reply` trong dữ liệu tác vụ */
function museQuestion(t: AiTask): { text: string; replyTask: string | null } | null {
  const pd = t.providerData as Record<string, unknown> | null;
  if (t.provider !== 'ahiep' || t.status !== 'FAILED' || !t.providerTaskId?.startsWith('video:') || !pd || pd.can_reply !== true) return null;
  const text = typeof pd.muse_reply === 'string' ? pd.muse_reply.trim() : '';
  return text ? { text, replyTask: typeof pd.replyTask === 'string' ? pd.replyTask : null } : null;
}

/** Phần câu hỏi Muse gửi cho khách: `replyTask` = mã tác vụ trả lời (đã trả lời thì không trả lời lại) */
function museReplyView(t: AiTask) {
  const q = museQuestion(t);
  return q ? { museReply: { question: hideProviderText(q.text), replyTask: q.replyTask === 'pending' ? null : q.replyTask, replied: !!q.replyTask } } : {};
}

const publicOption = (o: AiFieldOption): AiFieldOption => ({ ...o, label: sanitizeToolDisplayName(o.label), ...(o.hint ? { hint: hideProviderText(o.hint) } : {}) });

/** Ô form gửi cho khách: link nghe thử dùng mã trung tính, chữ hướng dẫn / nhãn không lộ tên hay link nhà cung cấp */
function publicField(f: AiFieldDef): AiFieldDef {
  return {
    ...f,
    label: hideProviderText(f.label),
    ...(f.help ? { help: hideProviderText(f.help) } : {}),
    ...(f.placeholder ? { placeholder: hideProviderText(f.placeholder) } : {}),
    ...(f.preview ? { preview: maskPreviewUrl(f.preview) } : {}),
    ...(f.options ? { options: f.options.map(publicOption) } : {}),
    ...(f.optionsBy ? { optionsBy: { ...f.optionsBy, map: Object.fromEntries(Object.entries(f.optionsBy.map).map(([k, list]) => [k, list.map(publicOption)])) } } : {}),
  };
}

/** Danh sách nguồn đã ngừng kinh doanh & ẩn hoàn toàn khỏi giao diện Web + Admin (vẫn giữ trong AI_PROVIDERS để không đổi mã hash URL cũ — T-388) */
export const RETIRED_PROVIDERS = new Set(['prismforge']);

@Injectable()
export class AiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AiStudio');
  private readonly providers = new Map<string, AiProvider>(AI_PROVIDERS.map((p) => [p.key, p]));
  /** Cờ chống chạy chồng lượt cron trong cùng một process */
  private ticking = false;
  /** Khoá điều phối hàng đợi FIFO cho Fable Studio (đơn tạo trước vào luồng trước, nhưng cho phép chạy song song đủ hết số luồng nguồn) */
  private drainingFable = false;
  private drainFablePending = false;
  private drainFableForce = false;
  private fableLastFullAt = 0;
  private readonly activeFableSubmits = new Set<Promise<unknown>>();
  /** Các lần gửi tác vụ sang nhà cung cấp đang chờ phản hồi (API tắt thì chờ xong để không mất mã job) */
  private readonly submitting = new Set<Promise<unknown>>();
  /** Bộ nhớ đệm kết quả quét vi phạm theo taskId để chuyển tab / lọc realtime < 5ms không cần đọc lại JSONB (T-286) */
  private readonly taskViolationCache = new Map<string, ViolationCategory[]>();
  /** Đếm số lần lỗi bảo trì liên tiếp từ nguồn theo từng toolKey để tự bật autoMaintenance ngay lập tức (T-358) */
  private readonly consecutiveMaintErrors = new Map<string, number>();
  /** Đếm số chu kỳ liên tiếp website nguồn không phản hồi (502/503/timeout) để tự khoá bảo trì toàn nguồn tạm thời (T-502) */
  private readonly providerUnreachableStreaks = new Map<string, number>();
  private syncingMaint = false;
  private autoCheckingFailed = false;
  private scanningStuck = false;
  /** API đang tắt: cron không nhận thêm tác vụ */
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly credits: CreditsService,
    private readonly files: AiFilesService,
    private readonly events: EventEmitter2,
    private readonly categories: AiCategoriesService,
  ) {}

  /**
   * Khởi động: thêm vào DB các công cụ mới khai báo trong adapter (không ghi đè phần admin đã sửa).
   * Công cụ mới luôn ở trạng thái tắt (ẩn với khách) — admin kiểm tra giá rồi tự bật ở AI Studio › Công cụ AI.
   */
  private discoveringUpstream = false;
  private lastPushedMaintHash = '';

  async onModuleInit() {
    if (process.env.DISABLE_SCHEDULER === '1' || process.env.DISABLE_SCHEDULER === 'true') {
      await this.discoverAllProviderAdapters().catch(() => undefined);
      setInterval(() => void this.discoverAllProviderAdapters().catch(() => undefined), 15 * 60_000).unref();
      return;
    }
    if (isChildSite()) {
      // T-488: Web con nhận danh mục, giá & trạng thái bảo trì đồng bộ từ Web mẹ -> chỉ nạp adapter tối giản để giảm >50% RAM
      await this.discoverAllProviderAdapters().catch(() => undefined);
      setInterval(() => void this.discoverAllProviderAdapters().catch(() => undefined), 20 * 60_000).unref();
      await this.prisma.aiTask
        .updateMany({
          where: { status: 'PENDING', nextPollAt: { gt: new Date(Date.now() + 90_000) } },
          data: { nextPollAt: new Date() },
        })
        .catch(() => undefined);
      void this.drainFableQueue(true).catch(() => undefined);
      return;
    }
    try {
      await this.autoDiscoverUpstreamTools(true);
      await this.syncTools();
      await this.syncNames();
      await this.backfillArchivedRuns();
      const rescued = await this.prisma.aiTask
        .updateMany({
          where: { status: 'PENDING', nextPollAt: { gt: new Date(Date.now() + 90_000) } },
          data: { nextPollAt: new Date() },
        })
        .catch(() => ({ count: 0 }));
      if (rescued.count) this.logger.log(`Đã mở khoá ${rescued.count} tác vụ PENDING bị kẹt sau khi khởi động lại API`);
    } catch (err) {
      this.logger.warn(`Đồng bộ công cụ AI lỗi: ${(err as Error).message}`);
    }
    // tính sẵn bảng giá mặc định ở nền + khởi động ngay hàng đợi Fable + đồng bộ bảo trì real-time ngay lúc khởi động (T-487)
    void this.refreshPrices();
    void this.syncUpstreamMaintenance().catch(() => undefined);
    void this.drainFableQueue(true).catch(() => undefined);
    setTimeout(() => {
      void this.runFailedTasksAutoCheck(500).catch(() => undefined);
      void this.runStuckTasksLiveScan().catch(() => undefined);
    }, 3_000);
  }

  /** Quét danh mục live của các adapter có `discoverTools` để nạp công cụ động vào bộ nhớ + thu thập sản phẩm đã gỡ khỏi nguồn */
  private async discoverAllProviderAdapters(): Promise<{ anyChanged: boolean; removedKeys: string[]; discoveredKeys: Set<string> }> {
    let anyChanged = false;
    const removedSet = new Set<string>();
    const discoveredKeys = new Set<string>();
    await Promise.all(
      AI_PROVIDERS.map(async (p) => {
        if (RETIRED_PROVIDERS.has(p.key) || !p.discoverTools) return;
        try {
          const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 18_000));
          const ctx = await this.ctx(p.key);
          const res = await Promise.race([p.discoverTools(ctx), timeout]);
          if (!res) return;
          for (const def of res.addedTools ?? []) {
            registerPublicTool(p.key, def.key);
            discoveredKeys.add(`${p.key}.${def.key}`);
            anyChanged = true;
          }
          for (const splitParent of res.updatedSplits ?? []) {
            for (const k of [...this.modelDefs.keys()]) {
              if (k.startsWith(`${splitParent}${MODEL_SEP}`)) this.modelDefs.delete(k);
            }
            anyChanged = true;
          }
          for (const rk of res.removedKeys ?? []) {
            removedSet.add(rk);
            this.modelDefs.delete(rk);
            for (const k of [...this.modelDefs.keys()]) {
              if (k.startsWith(`${rk}${MODEL_SEP}`)) this.modelDefs.delete(k);
            }
            anyChanged = true;
          }
        } catch (err) {
          this.logger.warn(`Quét công cụ live từ ${p.key} lỗi: ${(err as Error).message}`);
        }
      }),
    );
    return { anyChanged, removedKeys: [...removedSet], discoveredKeys };
  }

  /**
   * T-474: Tự động xoá khỏi hệ thống các sản phẩm / model không còn tồn tại trên web nguồn (hoặc thuộc nguồn đã ngưng hẳn):
   * - Nếu công cụ chưa từng phát sinh đơn chạy lịch sử (`tasks === 0`): xoá hẳn khỏi bảng `ai_tools`.
   * - Nếu đã có đơn lịch sử cũ của khách: tắt hiển thị, gỡ khỏi nhóm model và đánh dấu `deleted: true, upstreamRemoved: true`
   *   để ẩn hoàn toàn trên cả Web khách, bảng Công cụ Admin và hộp "Đã xoá" mà vẫn giữ toàn vẹn lịch sử đơn cũ.
   */
  private async pruneDiscontinuedTools(explicitRemovedKeys: string[] = []): Promise<{ hard: number; soft: number; keys: string[] }> {
    const explicitSet = new Set(explicitRemovedKeys);
    const rows = await this.prisma.aiTool.findMany({
      include: { _count: { select: { tasks: true } } },
    });
    const toPrune = rows.filter((r) => {
      const opts = (r.options ?? {}) as Record<string, unknown>;
      if (isDeletedTool(r.options) && opts.upstreamRemoved === true) return false;
      if (RETIRED_PROVIDERS.has(r.provider)) return true;
      if (explicitSet.has(r.key)) return true;
      if (!this.resolve(r.key)) return true;
      return false;
    });
    if (!toPrune.length) return { hard: 0, soft: 0, keys: [] };

    const hardKeys = toPrune.filter((r) => r._count.tasks + archivedRunsOf(r.options) === 0).map((r) => r.key);
    const hardSet = new Set(hardKeys);
    const softRows = toPrune.filter((r) => !hardSet.has(r.key));

    await this.prisma.$transaction([
      ...(hardKeys.length ? [this.prisma.aiTool.deleteMany({ where: { key: { in: hardKeys } } })] : []),
      ...softRows.map((r) =>
        this.prisma.aiTool.update({
          where: { key: r.key },
          data: {
            enabled: false,
            featured: false,
            modelGroups: [],
            options: {
              ...((r.options ?? {}) as Record<string, unknown>),
              deleted: true,
              upstreamRemoved: true,
              upstreamRemovedAt: new Date().toISOString(),
            } as object,
          },
        }),
      ),
    ]);

    const prunedKeys = toPrune.map((r) => r.key);
    this.logger.log(
      `[AutoPrune T-474] Đã tự động gỡ ${prunedKeys.length} sản phẩm không còn trên web nguồn (xoá hẳn ${hardKeys.length}, ẩn lưu lịch sử ${softRows.length}): ${prunedKeys.slice(0, 15).join(', ')}`,
    );
    return { hard: hardKeys.length, soft: softRows.length, keys: prunedKeys };
  }

  /**
   * T-473 & T-474: Vòng lặp tự động 15 phút/lần:
   * 1. Tự động phát hiện & đấu nối mọi sản phẩm / model mới thêm từ các nguồn API (tự bật nếu Độc quyền hoặc Rẻ nhất <= 1.05x).
   * 2. Tự động gỡ bỏ mọi sản phẩm / model đã không còn hẳn ở web nguồn để giữ giao diện sạch gọn.
   */
  @Cron('0 */15 * * * *')
  async autoDiscoverUpstreamTools(forceSync = false) {
    if (process.env.DISABLE_SCHEDULER === '1' || process.env.DISABLE_SCHEDULER === 'true' || isChildSite()) {
      return;
    }
    if (this.discoveringUpstream) return;
    this.discoveringUpstream = true;
    try {
      const beforeKeys = new Set((await this.prisma.aiTool.findMany({ select: { key: true } })).map((r) => r.key));
      const { anyChanged, removedKeys, discoveredKeys } = await this.discoverAllProviderAdapters();

      const pruned = await this.pruneDiscontinuedTools(removedKeys);
      if (!anyChanged && !forceSync && pruned.keys.length === 0) return;

      await this.syncTools();
      await this.syncNames();

      if (isChildSite()) {
        if (pruned.keys.length > 0 || anyChanged) void this.refreshPrices();
        return;
      }

      const allRows = (await this.prisma.aiTool.findMany()).filter((r) => !isDeletedTool(r.options) && !RETIRED_PROVIDERS.has(r.provider));
      const evalCandidates = allRows.filter((r) => {
        if (!beforeKeys.has(r.key)) return true;
        const opts = (r.options ?? {}) as Record<string, unknown>;
        if (opts.reintroduced === true) return true;
        if (discoveredKeys.has(r.key) && opts.autoEvaluated !== true && !r.enabled && r.provider !== 'seedancebot') {
          return true;
        }
        return false;
      });
      if (!evalCandidates.length) {
        if (pruned.keys.length > 0) void this.refreshPrices();
        return;
      }

      const provStates = new Map<string, boolean>();
      for (const p of AI_PROVIDERS) {
        if (RETIRED_PROVIDERS.has(p.key)) continue;
        const cfg = await this.providerConfig(p.key);
        provStates.set(p.key, Boolean(cfg.enabled && cfg.apiKey?.trim()));
      }

      const superActor = { id: 'system', email: 'system@local', role: 'SUPER_ADMIN', permissions: ['*'] } as unknown as AuthUser;
      const priceTable = await this.adminToolPrices(superActor, false);
      const canonicalOf = (r: AiTool) => {
        const res = this.resolve(r.key);
        const media = res?.def.output || (r.category.includes('video') ? 'video' : r.category.includes('anh') || r.category === 'image' ? 'image' : r.category);
        const rawText = `${r.modelLabel || ''} ${r.name} ${r.key.replace(/^[^.]+\./, '')}`
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        const verOf = (re: RegExp, def: string) => {
          const m = re.exec(rawText);
          return m ? m[1].replace(/[-_]/g, '.') : def;
        };
        if (media === 'image') {
          if (/upscale|lam net|nang net|4k ultra/.test(rawText) && !/gpt|banana|seedream|flux|kling|grok/.test(rawText)) return 'image:upscale';
          if (/gpt[\s._-]*image|imagegen/.test(rawText)) {
            const v = verOf(/(?:gpt[\s._-]*image|imagegen)[\s._-]*(\d+(?:[._-]\d+)?)/, '2');
            const sub = /sunburst/.test(rawText) ? '-sunburst' : /flare/.test(rawText) ? '-flare' : '';
            return `image:gpt-image-${v}${sub}`;
          }
          if (/nano[\s._-]*banana|gemini.*(?:image|flash|pro)/.test(rawText)) {
            if (/\bpro\b|gemini[\s._-]*3[\s._-]*pro/.test(rawText)) return 'image:nano-banana-pro';
            if (/lite/.test(rawText)) return 'image:nano-banana-lite';
            if (/2[._-]1/.test(rawText)) return 'image:nano-banana-2.1';
            return 'image:nano-banana-2';
          }
          if (/seedream/.test(rawText)) return `image:seedream-${verOf(/seedream[\s._-]*(\d+(?:[._-]\d+)?)/, '5.0')}`;
          if (/grok/.test(rawText)) return `image:grok-${verOf(/grok(?:[\s._-]*imagine)?(?:[\s._-]*image)?[\s._-]*(\d+(?:[._-]\d+)?)/, '2.0')}`;
          if (/kling/.test(rawText)) return /o1|01/.test(rawText) ? 'image:kling-o1' : `image:kling-${verOf(/kling[\s._-]*(\d+(?:[._-]\d+)?)/, '3.0')}`;
          if (/flux/.test(rawText)) return `image:flux-${verOf(/flux[\s._-]*(\d+(?:[._-]\d+)?)/, '2.0')}`;
          if (/midjourney|\bmj\b/.test(rawText)) return `image:midjourney-${verOf(/(?:midjourney|mj)[\s._-]*v?(\d+(?:[._-]\d+)?)/, '7.0')}`;
          if (/imagen/.test(rawText)) return `image:imagen-${verOf(/imagen[\s._-]*(\d+(?:[._-]\d+)?)/, '4.0')}`;
          if (/ideogram/.test(rawText)) return `image:ideogram-${verOf(/ideogram[\s._-]*v?(\d+(?:[._-]\d+)?)/, '3.0')}`;
          if (/qwen/.test(rawText)) return `image:qwen-${verOf(/qwen(?:[\s._-]*image)?[\s._-]*(\d+(?:[._-]\d+)?)/, '2.0')}`;
          if (/z[\s._-]*image/.test(rawText)) return 'image:z-image';
          if (/muse/.test(rawText)) return 'image:muse-image';
        }
        if (media === 'video') {
          if (/upscale|lam net|nang net|topaz/.test(rawText)) return 'video:upscale';
          if (/motion[\s._-]*control|sao chep chuyen dong|dieu khien chuyen dong|betamotion/.test(rawText)) return 'video:motion-control';
          if (/seedance/.test(rawText)) {
            const v = /2[._-]?5/.test(rawText) ? '2.5' : verOf(/seedance[\s._-]*(\d+(?:[._-]\d+)?)/, '2.0');
            const sub = /flash/.test(rawText) ? '-flash' : /mini/.test(rawText) ? '-mini' : /fast/.test(rawText) ? '-fast' : '';
            return `video:seedance-${v}${sub}`;
          }
          if (/omni[\s._-]*flash|veo[\s._-]*omni|gemini[\s._-]*omni/.test(rawText)) {
            const v = /1[._-]2|omni12/.test(rawText) ? '1.2' : /1[._-]1/.test(rawText) ? '1.1' : '1.0';
            return `video:omni-flash-${v}`;
          }
          if (/\bveo\b/.test(rawText)) {
            const v = /3[._-]1/.test(rawText) ? '3.1' : verOf(/veo[\s._-]*(\d+(?:[._-]\d+)?)/, '3');
            const sub = /relax/.test(rawText) ? '-relaxed' : /lite/.test(rawText) ? '-lite' : '-fast';
            return `video:veo-${v}${sub}`;
          }
          if (/kling/.test(rawText)) {
            if (/o1/.test(rawText)) return 'video:kling-o1';
            const v = verOf(/kling(?:[\s._-]*video)?[\s._-]*(\d+(?:[._-]\d+)?)/, '3.0');
            const sub = /flash/.test(rawText) ? '-flash' : '';
            return `video:kling-${v}${sub}`;
          }
          if (/minimax|hailuo|\bh3\b/.test(rawText)) {
            if (/2[._-]3/.test(rawText)) return 'video:hailuo-2.3';
            return /max/.test(rawText) ? 'video:minimax-h3-max' : 'video:minimax-h3';
          }
          if (/\bwan\b/.test(rawText)) return `video:wan-${verOf(/wan[\s._-]*(\d+(?:[._-]\d+)?)/, '3.0')}`;
          if (/grok/.test(rawText)) return 'video:grok-video';
          if (/flux/.test(rawText)) return `video:flux-${verOf(/flux[\s._-]*(\d+(?:[._-]\d+)?)/, '3.0')}`;
          if (/genjutsu/.test(rawText)) return 'video:genjutsu';
          if (/muse/.test(rawText)) return 'video:muse-video';
        }
        const tail = r.key.replace(/^[^.]+\./, '').replace(/~/g, '/');
        return `${media}:${canonicalModelSlug(slugModel(r.modelLabel || r.name) || tail, r.modelLabel || r.name, r.category).split('/')[0]}`;
      };
      const costOf = (r: AiTool): number | null => {
        const tp = priceTable[r.key];
        if (!tp) return null;
        if (tp.benchCost !== undefined && tp.benchCost !== null && tp.benchCost > 0) return tp.benchCost;
        if (tp.providerCost !== null && tp.providerCost > 0) return tp.providerCost;
        return null;
      };

      let autoEnabledCount = 0;
      for (const nr of evalCandidates) {
        if (!nr.key.includes(MODEL_SEP) && allRows.some((x) => x.key.startsWith(`${nr.key}${MODEL_SEP}`))) continue;

        const cSlug = canonicalOf(nr);
        const siblings = allRows.filter((er) => er.key !== nr.key && canonicalOf(er) === cSlug);
        const siblingGroups = siblings.find((s) => s.modelGroups.length > 0)?.modelGroups ?? [];
        const activeSiblingCosts = siblings
          .filter((s) => s.enabled && provStates.get(s.provider))
          .map((s) => costOf(s))
          .filter((c): c is number => c !== null && c > 0);
        // So sánh cả với các ứng viên mới cùng canonicalModel để chỉ bật nguồn rẻ nhất nếu nhiều nguồn cùng thêm 1 model mới
        const allCandidateCostsSameModel = evalCandidates
          .filter((c) => canonicalOf(c) === cSlug && provStates.get(c.provider))
          .map((c) => costOf(c))
          .filter((c): c is number => c !== null && c > 0);

        const myCost = costOf(nr);
        const provActive = provStates.get(nr.provider) === true;
        const minActive = activeSiblingCosts.length ? Math.min(...activeSiblingCosts) : null;
        const minAmongNew = allCandidateCostsSameModel.length ? Math.min(...allCandidateCostsSameModel) : null;
        const bestBenchmark =
          minActive !== null && minAmongNew !== null
            ? Math.min(minActive, minAmongNew)
            : (minActive ?? minAmongNew);

        const shouldEnable =
          provActive &&
          myCost !== null &&
          myCost > 0 &&
          bestBenchmark !== null &&
          myCost <= bestBenchmark * 1.05;

        const nextOpts: Record<string, unknown> = { ...((nr.options ?? {}) as Record<string, unknown>), autoEvaluated: true };
        delete nextOpts.reintroduced;

        await this.prisma.aiTool.update({
          where: { key: nr.key },
          data: {
            ...(shouldEnable ? { enabled: true } : {}),
            ...(siblingGroups.length > 0 && nr.modelGroups.length === 0 ? { modelGroups: siblingGroups } : {}),
            options: nextOpts as object,
          },
        });
        if (shouldEnable) {
          nr.enabled = true;
          autoEnabledCount++;
        }
      }

      this.logger.log(
        `[AutoDiscover T-473] Đã đánh giá ${evalCandidates.length} sản phẩm mới từ nguồn API (tự bật ${autoEnabledCount} gói giá tối ưu/độc quyền, giữ tắt ${evalCandidates.length - autoEnabledCount} gói giá cao hơn).`,
      );
      void this.refreshPrices();
    } catch (err) {
      this.logger.warn(`AutoDiscover/Prune lỗi: ${(err as Error).message}`);
    } finally {
      this.discoveringUpstream = false;
    }
  }

  /**
   * Khôi phục 1 lần số lượt chạy lịch sử đã bị dọn ở các chu kỳ 24h trước đó từ sổ cái `credit_transactions`
   * (`type = 'USAGE' AND "taskId" IS NULL`, ghi chú `<tên công cụ> · <mã tác vụ>`) vào `ai_tools.options.archivedRuns`.
   */
  private async backfillArchivedRuns() {
    const marker = await this.prisma.setting.findUnique({ where: { key: 'ai_runs_backfill_v1' } });
    if (marker) return;
    const rows = await this.prisma.$queryRaw<{ tool_name: string; cnt: number }[]>`
      SELECT regexp_replace(note, ' · T[A-Za-z0-9]{6,8}$', '') AS tool_name, COUNT(*)::int AS cnt
      FROM credit_transactions
      WHERE type = 'USAGE' AND "taskId" IS NULL AND note LIKE '% · T%'
      GROUP BY 1
    `;
    let restored = 0;
    for (const { tool_name, cnt } of rows) {
      if (!tool_name || cnt <= 0) continue;
      const updated = await this.prisma.$executeRaw`
        UPDATE ai_tools
        SET options = jsonb_set(
          COALESCE(options::jsonb, '{}'::jsonb),
          '{archivedRuns}',
          to_jsonb(GREATEST(COALESCE((options::jsonb->>'archivedRuns')::int, 0), ${cnt}::int))
        )
        WHERE key = (
          SELECT key FROM ai_tools
          WHERE name = ${tool_name}
          ORDER BY enabled DESC, "createdAt" ASC
          LIMIT 1
        )
      `;
      if (updated) restored += cnt;
    }
    await this.prisma.setting.upsert({
      where: { key: 'ai_runs_backfill_v1' },
      create: { key: 'ai_runs_backfill_v1', value: { done: true, restored, at: new Date().toISOString() }, isPublic: false },
      update: { value: { done: true, restored, at: new Date().toISOString() } },
    });
    if (restored) this.logger.log(`Đã khôi phục ${restored} lượt chạy lịch sử vào ai_tools`);
  }

  /**
   * API tắt / khởi động lại (deploy): chờ các lần gửi tác vụ đang dở xong rồi mới tắt.
   * Nếu bị ngắt giữa chừng, nhà cung cấp vẫn tạo job (vẫn tính phí, vẫn ra kết quả) nhưng website mất mã job
   * nên không lấy được kết quả về và phải gửi lại sau 10 phút.
   */
  async onModuleDestroy() {
    this.stopping = true;
    if (!this.submitting.size) return;
    this.logger.log(`Đang chờ ${this.submitting.size} tác vụ AI gửi xong trước khi tắt...`);
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (this.submitting.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (this.submitting.size) this.logger.warn(`Hết thời gian chờ, còn ${this.submitting.size} tác vụ AI đang gửi dở`);
  }

  /**
   * Công cụ có ô "Model AI" (xem splitModelField) còn được tách thành từng công cụ con `<khoá>~<model>`, mỗi model một dòng
   * để admin đặt giá / bật tắt riêng, và gộp lại thành 1 nhóm model trên website (khách chọn model như sangtao.ai).
   * Lần tách đầu khi công cụ gốc đang bật: các model con kế thừa nhóm menu, icon, giá, trạng thái bật của công cụ gốc
   * rồi tắt công cụ gốc (giữ lại cho tác vụ cũ) -> khách vẫn thấy đúng 1 công cụ như trước. Model thêm sau thì tạo ở trạng thái tắt.
   */
  async syncTools() {
    const rows = new Map((await this.prisma.aiTool.findMany()).map((t) => [t.key, t]));
    let order = rows.size;
    for (const p of AI_PROVIDERS) {
      if (RETIRED_PROVIDERS.has(p.key)) continue;
      const autoBadge = providerDefaultBadge(p.key);
      for (const t of p.tools) {
        const key = `${p.key}.${t.key}`;
        const cleanParentName = sanitizeToolDisplayName(t.name);
        const cleanDesc = buildDetailedModelDescription(t, key, cleanParentName, null);
        let parent = rows.get(key);
        if (!parent) {
          parent = await this.prisma.aiTool.create({
            data: {
              key,
              provider: p.key,
              category: t.category,
              name: cleanParentName,
              description: cleanDesc,
              icon: t.icon ?? null,
              badge: autoBadge,
              featured: !!t.featured,
              sortOrder: order++,
              pricing: t.pricing as object,
              enabled: false,
              options: { lastSyncedName: cleanParentName, lastSyncedDesc: cleanDesc } as object,
            },
          });
          rows.set(key, parent);
        } else {
          const pOpts = (parent.options ?? {}) as Record<string, unknown>;
          if (pOpts.upstreamRemoved === true) {
            const { deleted: _d, upstreamRemoved: _ur, upstreamRemovedAt: _ura, ...restOpts } = pOpts;
            parent = await this.prisma.aiTool.update({
              where: { key },
              data: { badge: parent.badge?.trim() ? parent.badge : autoBadge, options: { ...restOpts, reintroduced: true } as object },
            });
            rows.set(key, parent);
          } else if (!parent.badge?.trim()) {
            parent = await this.prisma.aiTool.update({ where: { key }, data: { badge: autoBadge } });
            rows.set(key, parent);
          }
        }
        const field = splitModelField(t);
        for (const o of field?.options ?? []) {
          const childKey = `${key}${MODEL_SEP}${o.value}`;
          const existingChild = rows.get(childKey);
          if (existingChild) {
            const cOpts = (existingChild.options ?? {}) as Record<string, unknown>;
            if (cOpts.upstreamRemoved === true) {
              const { deleted: _d, upstreamRemoved: _ur, upstreamRemovedAt: _ura, ...restOpts } = cOpts;
              const updatedChild = await this.prisma.aiTool.update({
                where: { key: childKey },
                data: {
                  badge: existingChild.badge?.trim() ? existingChild.badge : autoBadge,
                  options: { ...restOpts, reintroduced: true } as object,
                },
              });
              rows.set(childKey, updatedChild);
            } else if (!existingChild.badge?.trim()) {
              const updatedChild = await this.prisma.aiTool.update({ where: { key: childKey }, data: { badge: autoBadge } });
              rows.set(childKey, updatedChild);
            }
          }
        }
        const missing = field?.options.filter((o) => !rows.has(`${key}${MODEL_SEP}${o.value}`)) ?? [];
        if (!missing.length) continue;
        const inherit = parent.enabled;
        const baseParentName = sanitizeToolDisplayName(parent.name);
        const cleanParentGroups = parent.modelGroups.map((g) => sanitizeToolDisplayName(g)).filter(Boolean);
        const now = Date.now();
        for (const [i, o] of missing.entries()) {
          const cleanModelLabel = sanitizeToolDisplayName(o.label);
          const cleanChildName = `${baseParentName} · ${cleanModelLabel}`;
          const childKey = `${key}${MODEL_SEP}${o.value}`;
          const childDef = field ? modelDef(t, field, o.value) : t;
          const childDesc = buildDetailedModelDescription(childDef, childKey, cleanChildName, cleanModelLabel);
          const childOpts: Record<string, unknown> = {
            lastSyncedName: `${cleanParentName} · ${cleanModelLabel}`,
            lastSyncedLabel: cleanModelLabel,
            lastSyncedDesc: childDesc,
            ...(isDeletedTool(parent.options) ? { deleted: true } : {}),
          };
          await this.prisma.aiTool.create({
            data: {
              // cùng sortOrder thì xếp theo thời điểm tạo -> cách nhau 1ms để giữ đúng thứ tự model trong adapter
              createdAt: new Date(now + i),
              key: childKey,
              provider: p.key,
              category: parent.category,
              name: cleanChildName,
              description: childDesc,
              icon: parent.icon,
              badge: autoBadge,
              featured: parent.featured,
              sortOrder: parent.sortOrder,
              pricing: parent.pricing as object,
              enabled: inherit,
              // model con vào các nhóm của công cụ gốc (gốc chưa có nhóm -> nhóm mang tên công cụ gốc đã lọc sạch)
              modelGroups: cleanParentGroups.length ? cleanParentGroups : [baseParentName],
              modelLabel: cleanModelLabel,
              options: childOpts as object,
            },
          });
        }
        if (inherit) {
          await this.prisma.aiTool.update({ where: { key }, data: { enabled: false } });
          this.logger.log(`Đã tách ${cleanParentName} thành ${missing.length} công cụ theo model (công cụ gốc đã tắt)`);
        }
      }
    }
  }

  /**
   * Tự động cập nhật & lọc sạch tên công cụ từ các nguồn AI (T-376):
   * 1. Luôn quét & tự sửa sạch mọi ký tự / tên thương hiệu / tên miền dính tới nguồn họ trên toàn bộ công cụ trước khi lưu lên web.
   * 2. Mặc định BẬT (`autoName !== false`) cho mọi nhà cung cấp: khi nguồn cập nhật tên công cụ / model mới (hoặc tên sạch ok),
   *    hệ thống tự cập nhật thẳng lên web; đồng thời tôn trọng các công cụ Admin đã tự đặt tên riêng (`options.customName`).
   */
  async syncNames(only?: string, forceOverwrite = false) {
    let changed = 0;
    for (const p of AI_PROVIDERS) {
      if (RETIRED_PROVIDERS.has(p.key)) continue;
      if (only && p.key !== only) continue;
      const autoName = (await this.providerConfig(p.key)).autoName !== false;
      const rows = await this.prisma.aiTool.findMany({
        where: { provider: p.key },
        select: { key: true, name: true, description: true, modelLabel: true, modelGroups: true, enabled: true, options: true },
      });
      const byKey = new Map(rows.map((r) => [r.key, r]));

      // Bước 1: Tự sửa sạch mọi tên / nhãn model / nhóm còn dính ký tự hoặc thương hiệu nguồn (dù autoName bật hay tắt)
      for (const row of rows) {
        const leakName = hasProviderBrandLeak(row.name);
        const leakLabel = hasProviderBrandLeak(row.modelLabel);
        const leakGroups = row.modelGroups.some((g) => hasProviderBrandLeak(g));
        const leakDesc = row.description ? hasProviderBrandLeak(row.description) : false;
        if (!leakName && !leakLabel && !leakGroups && !leakDesc) continue;
        const nextName = sanitizeToolDisplayName(row.name);
        const nextLabel = row.modelLabel ? sanitizeToolDisplayName(row.modelLabel) : row.modelLabel;
        const nextGroups = [...new Set(row.modelGroups.map((g) => sanitizeToolDisplayName(g)).filter(Boolean))];
        const nextDesc = row.description ? hideProviderText(row.description) : row.description;
        if (
          nextName !== row.name ||
          nextLabel !== row.modelLabel ||
          nextDesc !== row.description ||
          JSON.stringify(nextGroups) !== JSON.stringify(row.modelGroups)
        ) {
          await this.prisma.aiTool.update({
            where: { key: row.key },
            data: { name: nextName, description: nextDesc, modelLabel: nextLabel, modelGroups: nextGroups },
          });
          row.name = nextName;
          row.description = nextDesc;
          row.modelLabel = nextLabel;
          row.modelGroups = nextGroups;
          changed++;
        }
      }

      // Bước 2: Tự động cập nhật Tên công cụ (khi autoName bật) & Mô tả ngắn chuẩn chi tiết real-time cho TẤT CẢ model (T-479)
      for (const t of p.tools) {
        const key = `${p.key}.${t.key}`;
        const cleanParent = sanitizeToolDisplayName(t.name);
        const mField = splitModelField(t);
        const wanted: { key: string; name: string; modelLabel?: string; def: AiToolDef }[] = [
          { key, name: cleanParent, def: t },
        ];
        for (const o of mField?.options ?? []) {
          const cleanLabel = sanitizeToolDisplayName(o.label);
          const childDef = mField ? modelDef(t, mField, o.value) : t;
          wanted.push({
            key: `${key}${MODEL_SEP}${o.value}`,
            name: `${cleanParent} · ${cleanLabel}`,
            modelLabel: cleanLabel,
            def: childDef,
          });
        }
        for (const w of wanted) {
          const row = byKey.get(w.key);
          if (!row) continue;
          const opts = { ...((row.options ?? {}) as Record<string, unknown>) };

          // 2a. Xử lý đồng bộ Tên công cụ (tôn trọng customName & autoName)
          let nextName = row.name;
          let nextLabel = row.modelLabel;
          let optsChanged = false;
          if (autoName && (opts.customName !== true || forceOverwrite)) {
            if (opts.lastSyncedName === undefined && row.enabled && !forceOverwrite) {
              const differs = row.name !== w.name || (w.modelLabel !== undefined && row.modelLabel !== w.modelLabel);
              opts.lastSyncedName = w.name;
              if (w.modelLabel !== undefined) opts.lastSyncedLabel = w.modelLabel;
              optsChanged = true;
              if (!differs) {
                nextName = w.name;
                if (w.modelLabel !== undefined) nextLabel = w.modelLabel;
              }
            } else {
              const sourceNameChanged =
                forceOverwrite ||
                opts.lastSyncedName === undefined ||
                opts.lastSyncedName !== w.name ||
                (w.modelLabel !== undefined && opts.lastSyncedLabel !== w.modelLabel);
              if (sourceNameChanged) {
                opts.lastSyncedName = w.name;
                if (w.modelLabel !== undefined) opts.lastSyncedLabel = w.modelLabel;
                if (forceOverwrite) delete opts.customName;
                optsChanged = true;
                nextName = w.name;
                if (w.modelLabel !== undefined) nextLabel = w.modelLabel;
              }
            }
          }

          // 2b. T-479: Tự động sinh & đồng bộ Mô tả ngắn chuẩn - chi tiết theo thông số live của từng model
          let nextDesc = row.description;
          if (opts.customDesc !== true || forceOverwrite) {
            const targetDesc = buildDetailedModelDescription(w.def, w.key, nextName, nextLabel ?? w.modelLabel);
            if (forceOverwrite || opts.lastSyncedDesc !== targetDesc || row.description !== targetDesc) {
              opts.lastSyncedDesc = targetDesc;
              if (forceOverwrite) delete opts.customDesc;
              optsChanged = true;
              nextDesc = targetDesc;
            }
          }

          const needDataUpdate = nextName !== row.name || nextLabel !== row.modelLabel || nextDesc !== row.description;
          if (!needDataUpdate && !optsChanged) continue;

          await this.prisma.aiTool.update({
            where: { key: w.key },
            data: {
              ...(nextName !== row.name ? { name: nextName } : {}),
              ...(nextLabel !== row.modelLabel ? { modelLabel: nextLabel } : {}),
              ...(nextDesc !== row.description ? { description: nextDesc } : {}),
              options: opts as object,
            },
          });
          if (needDataUpdate) changed++;
        }
      }
    }
    if (changed) this.logger.log(`Đã tự động cập nhật & làm sạch tên ${changed} công cụ AI từ các nguồn`);
    return changed;
  }

  /** Admin lưu cài đặt nhà cung cấp `ai_<key>` (bật "Tự cập nhật tên", đổi "% Tăng giá so với giá gốc"...) -> đồng bộ ngay */
  @OnEvent('activity', { async: true })
  async onProviderSettingsSaved(e: { action?: string; entityId?: string; meta?: { keys?: string[]; changedKeys?: string[] } }) {
    if (e?.action !== 'settings.update' || !e.entityId?.startsWith('ai_')) return;
    const key = e.entityId.slice(3);
    const provider = this.providers.get(key);
    if (!provider) return;
    const changed = e.meta?.changedKeys ?? e.meta?.keys ?? [];
    if (!isChildSite() && (changed.includes('markup') || changed.includes('autoPrice') || changed.includes('applyMarkupAt'))) {
      await this.applyProviderPricingPolicy(provider).catch((err: Error) =>
        this.logger.warn(`Đồng bộ % tăng giá nguồn ${key} lỗi: ${err.message}`),
      );
    }
    this.priceMatrixCache = null;
    void this.refreshPrices();
    const forceNameSync = changed.includes('autoName') && (await this.providerConfig(key)).autoName !== false;
    await this.syncNames(key, forceNameSync).catch((err: Error) => this.logger.warn(`Cập nhật tên công cụ ${key} lỗi: ${err.message}`));
  }

  /**
   * Áp dụng `% Tăng giá so với giá gốc` (`markup`) và chế độ `Tự động cập nhật giá theo API nguồn` (`autoPrice`)
   * từ cài đặt nhà cung cấp `ai_<key>` xuống toàn bộ công cụ thuộc nguồn đó
   * (bỏ qua công cụ miễn phí `free`, đã xoá, hoặc đang bật `Tự custom giá riêng` `customPrice` — T-370).
   */
  private async applyProviderPricingPolicy(provider: AiProvider) {
    const cfg = await this.providerConfig(provider.key);
    const hasMarkup = cfg.markup !== undefined && cfg.markup !== null && cfg.markup !== '' && Number.isFinite(Number(cfg.markup));
    const nextMarkup = hasMarkup ? Math.max(0, Math.round(Number(cfg.markup) * 100) / 100) : null;
    const autoPrice = cfg.autoPrice !== false;

    const rows = await this.prisma.aiTool.findMany({ where: { provider: provider.key } });
    let updated = 0;
    let skippedCustom = 0;
    for (const row of rows) {
      if (isDeletedTool(row.options)) continue;
      const r = this.resolve(row.key);
      const curPricing = ((row.pricing ?? {}) as AiPricing);
      const merged = r ? this.pricingOf(r.def, row) : curPricing;
      if (merged.mode === 'free') continue;
      const isCustom =
        curPricing.customPrice === true ||
        (curPricing.customPrice === undefined &&
          !!curPricing.mode &&
          curPricing.mode !== 'cost' &&
          !!r &&
          supportsCost(provider, r.def));
      if (isCustom) {
        skippedCustom++;
        continue;
      }

      const nextPricing: AiPricing = { ...curPricing };
      if (nextMarkup !== null) nextPricing.markup = nextMarkup;
      if (autoPrice && r && supportsCost(provider, r.def)) {
        nextPricing.mode = 'cost';
      }

      if (JSON.stringify(nextPricing) !== JSON.stringify(curPricing)) {
        await this.prisma.aiTool.update({
          where: { key: row.key },
          data: { pricing: nextPricing as object },
        });
        updated++;
      }
    }
    if (updated > 0 || skippedCustom > 0) {
      this.logger.log(
        `Đã đồng bộ % tăng giá (${nextMarkup ?? 'giữ nguyên'}%) & tự động theo giá gốc cho ${updated} công cụ nguồn ${provider.key}${skippedCustom ? ` (giữ nguyên ${skippedCustom} model tự custom giá)` : ''}`,
      );
    }
  }

  /** Tự động làm mới bảng giá & đồng bộ làm sạch tên công cụ định kỳ mỗi 10 phút từ các nguồn */
  @Cron('40 */10 * * * *')
  autoRefreshProviderPrices() {
    this.priceMatrixCache = null;
    if (isChildSite() || process.env.DISABLE_SCHEDULER === '1' || process.env.DISABLE_SCHEDULER === 'true') return;
    void this.refreshPrices();
    void this.syncNames().catch(() => undefined);
  }

  // ---------------- tra cứu ----------------

  /** Định nghĩa công cụ con theo model đã dựng (khoá đầy đủ -> def), tránh dựng lại form mỗi lần gọi */
  private readonly modelDefs = new Map<string, AiToolDef>();

  /** Adapter + định nghĩa công cụ theo khoá đầy đủ `<provider>.<tool>` hoặc công cụ con `<provider>.<tool>~<model>` */
  private resolve(key: string): { provider: AiProvider; def: AiToolDef } | null {
    const dot = key.indexOf('.');
    const provider = this.providers.get(key.slice(0, dot));
    const rest = key.slice(dot + 1);
    const sep = rest.indexOf(MODEL_SEP);
    const base = provider?.tools.find((t) => t.key === (sep < 0 ? rest : rest.slice(0, sep)));
    if (!provider || !base) return null;
    if (sep < 0) return { provider, def: base };
    const cached = this.modelDefs.get(key);
    if (cached) return { provider, def: cached };
    // model đã bị gỡ khỏi adapter -> coi như công cụ không còn
    const field = splitModelField(base);
    const value = rest.slice(sep + 1);
    if (!field?.options.some((o) => o.value === value)) return null;
    const def = modelDef(base, field, value);
    this.modelDefs.set(key, def);
    return { provider, def };
  }

  /** Cấu hình nhà cung cấp (nhóm `ai_<key>`) */
  private async providerConfig(key: string): Promise<AiProviderConfig> {
    const s = await this.settings.get<Partial<AiProviderConfig>>(`ai_${key}`);
    return { ...s, enabled: s.enabled === true, baseUrl: String(s.baseUrl ?? ''), apiKey: String(s.apiKey ?? '') };
  }

  private async ctx(providerKey: string, userId?: string): Promise<AiCallContext> {
    return {
      config: await this.providerConfig(providerKey),
      userId,
      readUpload: (url) => this.files.read(url),
      uploadDuration: (url) => this.files.duration(url),
      trimVideoTail: (url, trimSec) => this.files.trimVideoTail(url, trimSec, userId),
      ensureVideoMaxBytes: (url, maxBytes) => this.files.ensureVideoMaxBytes(url, maxBytes, userId),
      ensureStandardImage: (url) => this.files.ensureStandardImageUrl(url, userId),
      ...(userId
        ? {
            getUserClonedVoice: (voiceId) => this.resolveUserClonedVoiceForCall(userId, voiceId),
            setUserClonedVoiceUpstream: (voiceId, upstreamVoiceId) => this.updateUserClonedVoiceUpstream(userId, voiceId, upstreamVoiceId),
          }
        : {}),
    };
  }

  /** Giá của công cụ = mặc định trong adapter, ghi đè bởi phần admin sửa trong DB */
  private pricingOf(def: AiToolDef, row: AiTool): AiPricing {
    return { ...def.pricing, ...((row.pricing ?? {}) as AiPricing) };
  }

  /** Tính credits cho một lần chạy */
  private async quoteCredits(provider: AiProvider, def: AiToolDef, row: AiTool, input: AiInput, ctx?: AiCallContext) {
    return (await this.quoteDetail(provider, def, row, input, ctx)).credits;
  }

  /**
   * Tính giá một lần chạy kèm chi phí nhà cung cấp (đã quy ra đồng theo tỉ giá, chỉ có khi giá theo chi phí NCC).
   * `providerCost` dùng cho admin xem lãi, không gửi cho khách; `providerRaw` = chi phí gốc theo đơn vị nhà cung cấp (chưa nhân tỉ giá).
   */
  private async quoteDetail(provider: AiProvider, def: AiToolDef, row: AiTool, input: AiInput, ctx?: AiCallContext) {
    const p = this.pricingOf(def, row);
    // công cụ miễn phí: khách chạy không mất credits
    if (p.mode === 'free') return { credits: 0, providerCost: null, providerRaw: null };
    let credits: number;
    let providerCost: number | null = null;
    let providerRaw: number | null = null;
    if (p.mode === 'tiers') {
      const t1 = Number(p.tier10to20) || Number(p.base) || 0;
      const t2 = Number(p.tier20to30) || t1;
      const videoUrl = typeof input.video === 'string' ? input.video.trim() : '';
      if (!videoUrl) {
        credits = t1;
      } else {
        const c = ctx ?? (await this.ctx(provider.key));
        const sec = await c.uploadDuration(videoUrl);
        if (sec === null || !Number.isFinite(sec) || sec <= 0) {
          throw new BadRequestException('Không đọc được thời lượng video mẫu, vui lòng tải lên file MP4 hoặc MOV hợp lệ');
        }
        if (sec <= 10.0) {
          throw new BadRequestException(
            `Video mẫu dài ${sec.toFixed(1)}s (từ 10s trở xuống) — vui lòng chuyển sang mục Motion Control max 10s để có giá rẻ hơn`,
          );
        }
        if (sec > 30.4) {
          throw new BadRequestException(
            `Video mẫu dài ${sec.toFixed(1)}s — mục trên 10s chỉ hỗ trợ video từ 10s đến tối đa 30s`,
          );
        }
        credits = sec <= 20.3 ? t1 : t2;
      }
    } else if (p.mode === 'by_resolution') {
      const resPrice = resolutionPriceOf(def, p, input);
      if (resPrice === null) throw new BadRequestException('Chưa cấu hình giá cho độ phân giải này, vui lòng chọn lại');
      credits = (Number(p.base) || 0) + resPrice;
    } else if (p.mode === 'per_second') {
      const sec = await this.resolveDurationSeconds(provider.key, def, input, ctx);
      // giá mỗi giây riêng của độ phân giải khách chọn (admin đặt), bỏ trống thì dùng giá mỗi giây chung
      const perSec = resolutionPriceOf(def, p, input) ?? (Number(p.perUnit) || 0);
      if (perSec <= 0) throw new BadRequestException('Chưa cấu hình giá cho độ phân giải này, vui lòng chọn lại');
      credits = (Number(p.base) || 0) + perSec * sec;
    } else if (p.mode === 'per_char') {
      const charsK = this.resolveCharThousands(def, input);
      const per1k = Number(p.perUnit) || 0;
      if (per1k <= 0) throw new BadRequestException('Chưa cấu hình giá cho mỗi 1.000 ký tự, vui lòng liên hệ quản trị viên');
      credits = (Number(p.base) || 0) + per1k * charsK;
    } else if (p.mode === 'cost' && provider.cost) {
      let c: number | null;
      try {
        c = await provider.cost(def, input, ctx ?? (await this.ctx(provider.key)));
      } catch (err) {
        if (err instanceof HttpException) throw err;
        const cleanMsg = hideProviderText(err instanceof Error ? err.message : '') || 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây';
        throw new BadRequestException(cleanMsg);
      }
      if (c === null || !Number.isFinite(c)) throw new BadRequestException('Không tính được giá cho lựa chọn này, vui lòng chọn lại');
      // quy đổi credit / xu nhà cung cấp ra credits web theo tỉ giá chung của nhà cung cấp (tab Khoá API), lãi % cộng ở dưới
      const cfg = ctx?.config ?? (await this.providerConfig(provider.key));
      providerRaw = c;
      providerCost = c * providerRate(provider, cfg);
      credits = providerCost + (Number(p.base) || 0);
    } else {
      const units = Math.max(0, def.units ? def.units(input) : 1);
      credits = (Number(p.base) || 0) + (Number(p.perUnit) || 0) * units;
    }
    // Với các gói đang đặt giá cố định / theo giây / theo độ phân giải / theo mốc thời lượng: vẫn tính giá gốc nguồn (nếu adapter có `cost()`) để Admin luôn thấy giá gốc dưới giá bán
    if (providerCost === null && !input.__retailOnly) {
      if (provider.cost) {
        const c = await provider.cost(def, input, ctx ?? (await this.ctx(provider.key))).catch(() => null);
        if (c !== null && Number.isFinite(c)) {
          const cfg = ctx?.config ?? (await this.providerConfig(provider.key));
          providerRaw = c;
          providerCost = c * providerRate(provider, cfg);
        }
      } else {
        providerCost = 0;
      }
    }
    credits *= markupFactor(p);
    return { credits: Math.max(Math.ceil(credits), Math.ceil(Number(p.min) || 0), 1), providerCost, providerRaw };
  }

  /**
   * Xác định số nghìn ký tự (`1.000 ký tự`) cho chế độ `per_char` (admin tự đặt giá / 1.000 ký tự):
   * Ưu tiên `def.units(input)` của adapter (đã tính sẵn trọng số CJK ×2,5 hoặc bóc lời thoại SRT), dự phòng đếm trực tiếp các ô chữ.
   */
  private resolveCharThousands(def: AiToolDef, input: AiInput): number {
    if (def.units) {
      const u = def.units(input);
      if (Number.isFinite(u) && u >= 0) return def.unitLabel === 'ký tự' ? u / 1000 : u;
    }
    const cjkRe = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
    const total = def.fields
      .filter((f) => f.type === 'text' || f.type === 'textarea')
      .reduce((sum, f) => {
        const s = typeof input[f.name] === 'string' ? (input[f.name] as string) : '';
        return sum + (cjkRe.test(s) ? Math.ceil(s.length * 2.5) : s.length);
      }, 0);
    if (input.__sample === true && total === 0) return 1;
    return total / 1000;
  }

  /**
   * Xác định số giây thời lượng cho chế độ `per_second` (admin tự đặt giá mỗi giây):
   * 1) Ưu tiên ô chọn thời lượng trực tiếp (`duration`, `durationSec`, `seconds`, `targetDuration`) hoặc ô gộp TMC (`option` dạng `10|1080p`);
   * 2) Nếu công cụ có ô thời lượng nhưng request bỏ trống -> lấy thời lượng mặc định của form;
   * 3) Nếu công cụ không có ô chọn thời lượng mà nhận file video / audio (`video`, `audio`, `media`...) -> đo độ dài thật của file tải lên (chưa tải file thì tạm tính 10s).
   */
  private async resolveDurationSeconds(providerKey: string, def: AiToolDef, input: AiInput, ctx?: AiCallContext): Promise<number> {
    const parseSec = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(String(v).replace(/s$/i, '').trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const direct =
      (typeof input.__sampleSec === 'number' && input.__sampleSec > 0 ? input.__sampleSec : null) ??
      parseSec(input.duration) ??
      parseSec(input.durationSec) ??
      parseSec(input.seconds) ??
      parseSec(input.targetDuration);
    if (direct !== null) {
      if (def.unitLabel === 'giây' && def.units) {
        const u = def.units(input);
        if (Number.isFinite(u) && u > 0) return u;
      }
      return direct;
    }
    if (typeof input.option === 'string') {
      const m = /^(\d+(?:\.\d+)?)\|/.exec(input.option.trim());
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    const hasDurField = def.fields.some((f) => ['duration', 'durationSec', 'seconds', 'targetDuration', 'option'].includes(f.name));
    if (hasDurField) {
      const defIn = defaultInput(def.fields);
      const defSec =
        parseSec(defIn.duration) ??
        parseSec(defIn.durationSec) ??
        parseSec(defIn.seconds) ??
        parseSec(defIn.targetDuration) ??
        (typeof defIn.option === 'string' && /^(\d+(?:\.\d+)?)\|/.test(defIn.option) ? Number(defIn.option.split('|')[0]) : null);
      if (defSec !== null) return defSec;
    }
    const mediaFieldNames = ['video', 'audio', 'media', ...def.fields.filter((f) => f.type === 'video' || f.type === 'audio').map((f) => f.name)];
    let mediaUrl = '';
    for (const k of mediaFieldNames) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) {
        mediaUrl = v.trim();
        break;
      }
    }
    if (mediaUrl) {
      const c = ctx ?? (await this.ctx(providerKey));
      const sec = await c.uploadDuration(mediaUrl);
      if (sec === null || !Number.isFinite(sec) || sec <= 0) {
        throw new BadRequestException('Không đọc được độ dài file, vui lòng dùng MP4 / MOV (video) hoặc MP3 / WAV / M4A (âm thanh)');
      }
      return Math.max(1, Math.ceil(sec));
    }
    if (def.unitLabel === 'giây' && def.units) {
      const u = def.units(input);
      if (Number.isFinite(u) && u > 0) return u;
    }
    return def.fields.some((f) => f.type === 'video' || f.type === 'audio') ? 10 : 8;
  }

  /** Áp dụng `provider.resolveFields` (nếu có) + `options.healedFieldOptions` (T-507) để nạp lựa chọn chuẩn thực tế từ nguồn */
  private async effectiveDef(provider: AiProvider, def: AiToolDef, ctx?: AiCallContext, rowOptions?: unknown): Promise<AiToolDef> {
    let nextDef = def;
    if (provider.resolveFields) {
      const c = ctx ?? (await this.ctx(provider.key));
      const fields = await provider.resolveFields(def, c).catch(() => def.fields);
      if (fields !== def.fields) nextDef = { ...def, fields };
    }
    return rowOptions ? applyHealedFields(nextDef, rowOptions) : nextDef;
  }

  /** Công cụ hiển thị cho khách: đang bật + nhà cung cấp đã bật + nhóm đang bật */
  async publicTools() {
    const off = await this.categories.disabledKeys();
    const rows = await this.prisma.aiTool.findMany({ where: { enabled: true, category: { notIn: [...off] } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { name: 'asc' }] });
    const out = [];
    for (const row of rows) {
      if (RETIRED_PROVIDERS.has(row.provider)) continue;
      const r = this.resolve(row.key);
      if (!r) continue;
      const cfg = await this.providerConfig(r.provider.key);
      if (!cfg.enabled) continue;
      const def = await this.effectiveDef(r.provider, r.def, undefined, row.options);
      out.push({ row, def, rate: providerRate(r.provider, cfg) });
    }
    // giá một lượt mặc định (bảng tính sẵn ở nền) để website xếp model rẻ nhất lên đầu
    const prices = await this.publicPrices();
    return out.map(({ row, def, rate }) => ({ ...this.presentTool(row, def, rate), price: prices[row.key] ?? null }));
  }

  /** Bảng giá một lượt mặc định của mọi công cụ (khoá nội bộ -> giá, null = không tính được) + lượt tính đang chạy */
  private priceTable: { at: number; prices: Record<string, number | null> } | null = null;
  private priceJob: Promise<void> | null = null;
  /** Bảng giá chi tiết từng lựa chọn cấu hình cho trang `/service-pricing` (cache 10 phút theo từng DB web chính / web con) */
  private priceMatrixCache: { at: number; data: Record<string, AiToolPriceBreakdown> } | null = null;
  private priceMatrixJob: Promise<void> | null = null;

  /**
   * Tính nhanh bảng giá mặc định cho các công cụ đang bật (làm nóng bảng giá nhà cung cấp trước rồi chạy song song).
   * Website dùng giá này để xếp model rẻ nhất lên đầu và mở model rẻ nhất khi khách bấm vào nhóm model.
   */
  private refreshPrices() {
    this.priceMatrixCache = null;
    this.priceJob ??= this.computeEnabledDefaultPrices()
      .then((prices) => void (this.priceTable = { at: Date.now(), prices }))
      .catch((err: Error) => this.logger.warn(`Không tính được bảng giá công cụ: ${err.message}`))
      .finally(() => (this.priceJob = null));
    return this.priceJob;
  }

  private async computeEnabledDefaultPrices(): Promise<Record<string, number | null>> {
    const rows = await this.prisma.aiTool.findMany({ where: { enabled: true } });
    const out: Record<string, number | null> = {};
    const byProvider = new Map<string, { row: AiTool; provider: AiProvider; def: AiToolDef }[]>();
    for (const row of rows) {
      if (isDeletedTool(row.options)) continue;
      const r = this.resolve(row.key);
      if (!r) continue;
      byProvider.set(r.provider.key, [...(byProvider.get(r.provider.key) ?? []), { row, ...r }]);
    }
    const one = async ({ row, provider, def: baseDef }: { row: AiTool; provider: AiProvider; def: AiToolDef }, ctx: AiCallContext) => {
      try {
        const def = applyHealedFields(baseDef, row.options);
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000));
        const res = await Promise.race([
          this.quoteDetail(provider, def, row, { ...defaultInput(def.fields), __sample: true, __retailOnly: true }, ctx),
          timeout,
        ]);
        out[row.key] = res.credits;
      } catch {
        out[row.key] = null;
      }
    };
    await Promise.all(
      [...byProvider.entries()].map(async ([providerKey, items]) => {
        const ctx = await this.ctx(providerKey);
        if (!ctx.config.enabled) return;
        await one(items[0], ctx);
        await Promise.all(items.slice(1).map((it) => one(it, ctx)));
      }),
    );
    return out;
  }

  /** Bảng giá cho danh sách công cụ: cũ hơn 10 phút thì tính lại ở nền (vẫn trả bảng cũ); chưa có thì chờ tối đa 10 giây */
  private async publicPrices() {
    if (!this.priceTable) await Promise.race([this.refreshPrices(), new Promise((r) => setTimeout(r, 10_000))]);
    else if (Date.now() - this.priceTable.at > 10 * 60_000) void this.refreshPrices();
    return this.priceTable?.prices ?? {};
  }

  /**
   * Bảng giá chi tiết từng lựa chọn (độ phân giải, thời lượng, server, âm thanh, giọng tiêu chuẩn / cao cấp...)
   * của mọi công cụ đang bật trên website hiện tại (tự động phản ánh đúng % lãi & cấu hình giá riêng của từng web con).
   */
  async publicPriceMatrix(): Promise<Record<string, AiToolPriceBreakdown>> {
    if (this.priceMatrixCache && Date.now() - this.priceMatrixCache.at <= 10 * 60_000) {
      return this.priceMatrixCache.data;
    }
    if (!this.priceMatrixCache) {
      await Promise.race([this.refreshPriceMatrix(), new Promise((r) => setTimeout(r, 15_000))]);
    } else {
      void this.refreshPriceMatrix();
    }
    return this.priceMatrixCache?.data ?? {};
  }

  private refreshPriceMatrix() {
    this.priceMatrixJob ??= this.computePublicPriceMatrix()
      .then((data) => void (this.priceMatrixCache = { at: Date.now(), data }))
      .catch((err: Error) => this.logger.warn(`Không tính được ma trận giá chi tiết: ${err.message}`))
      .finally(() => (this.priceMatrixJob = null));
    return this.priceMatrixJob;
  }

  private async computePublicPriceMatrix(): Promise<Record<string, AiToolPriceBreakdown>> {
    const off = await this.categories.disabledKeys();
    const rows = await this.prisma.aiTool.findMany({
      where: { enabled: true, category: { notIn: [...off] } },
    });
    const out: Record<string, AiToolPriceBreakdown> = {};
    const byProvider = new Map<string, { row: AiTool; provider: AiProvider; def: AiToolDef }[]>();
    for (const row of rows) {
      if (isDeletedTool(row.options)) continue;
      const r = this.resolve(row.key);
      if (!r) continue;
      byProvider.set(r.provider.key, [...(byProvider.get(r.provider.key) ?? []), { row, ...r }]);
    }

    const buildOne = async ({ row, provider, def: baseDef }: { row: AiTool; provider: AiProvider; def: AiToolDef }, ctx: AiCallContext) => {
      const pubKey = publicToolKey(row.key);
      try {
        const def = await this.effectiveDef(provider, baseDef, ctx, row.options);
        const pricing = this.pricingOf(def, row);
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000));
        const breakdown = await Promise.race([
          computeToolPriceBreakdown(def, provider.key, pricing, async (input) => {
            try {
              const res = await this.quoteDetail(provider, def, row, { ...input, __sample: true, __retailOnly: true }, ctx);
              return Number.isFinite(res.credits) ? res.credits : null;
            } catch {
              return null;
            }
          }),
          timeout,
        ]);
        out[pubKey] = breakdown;
      } catch {
        // bỏ qua nếu nguồn tạm gián đoạn
      }
    };

    await Promise.all(
      [...byProvider.entries()].map(async ([providerKey, items]) => {
        const ctx = await this.ctx(providerKey);
        if (!ctx.config.enabled) return;
        await buildOne(items[0], ctx);
        await Promise.all(items.slice(1).map((it) => buildOne(it, ctx)));
      }),
    );
    return out;
  }

  /** Bộ nhớ đệm số lượt dùng công cụ (10 phút), tránh đếm lại bảng tác vụ mỗi lần khách mở trang tổng quan */
  private popularCache: { at: number; data: { key: string; uses: number }[] } | null = null;

  /**
   * Tổng số lượt tạo tích luỹ của từng công cụ (cả tác vụ đang còn + lượt lịch sử đã dọn theo chu kỳ 24h), nhiều nhất trước —
   * mục "Tính năng dùng nhiều nhất" ở trang tổng quan. Trả khoá công khai; website tự lọc theo danh sách công cụ đang bật.
   */
  async popularTools() {
    if (this.popularCache && Date.now() - this.popularCache.at < 10 * 60_000) return this.popularCache.data;
    const rows = await this.prisma.aiTool.findMany({
      select: { key: true, options: true, _count: { select: { tasks: true } } },
    });
    const data = rows
      .filter((r) => !isDeletedTool(r.options))
      .map((r) => ({ key: publicToolKey(r.key), uses: r._count.tasks + archivedRunsOf(r.options) }))
      .filter((r) => r.uses > 0)
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 50);
    this.popularCache = { at: Date.now(), data };
    return data;
  }

  /** Chi tiết một công cụ (form) cho khách */
  async publicTool(publicKey: string) {
    // khách dùng khoá công khai (không có tên nhà cung cấp), vẫn nhận khoá nội bộ cũ
    const key = internalToolKey(publicKey);
    const row = await this.prisma.aiTool.findUnique({ where: { key } });
    const r = row && this.resolve(key);
    const cfg = r ? await this.providerConfig(r.provider.key) : null;
    if (!row || !r || !row.enabled || (await this.categories.disabledKeys()).has(row.category) || !cfg?.enabled) throw new NotFoundException('Công cụ không tồn tại hoặc đang tạm dừng');
    const def = await this.effectiveDef(r.provider, r.def, undefined, row.options);
    return this.presentTool(row, def, providerRate(r.provider, cfg));
  }

  /** File nghe thử đã tải về (giữ trong bộ nhớ, tối đa VOICE_CACHE_MAX file) */
  private readonly voiceCache = new Map<string, { data: Buffer; mimeType: string }>();

  /**
   * File nghe thử của một giọng đọc: tải hộ từ nhà cung cấp (URL do adapter quyết định, chỉ giọng có trong danh sách)
   * để khách không thấy địa chỉ nhà cung cấp; lưu tạm trong bộ nhớ cho lần sau.
   */
  async voicePreview(alias: string, voice: string) {
    if (voice.startsWith('uvoice_')) {
      const sample = await this.files.readVaultVoiceSample(voice.slice('uvoice_'.length));
      if (!sample) throw new NotFoundException('Không tìm thấy file nghe thử cho giọng nhân bản này');
      return sample;
    }
    // link nghe thử dùng mã thay cho tên nhà cung cấp (xem providerAlias)
    const providerKey = providerFromAlias(alias);
    const provider = this.providers.get(providerKey);
    const key = `${providerKey}:${voice}`;
    const hit = this.voiceCache.get(key);
    if (hit) return hit;
    // nhà cung cấp không có file mẫu công khai: tự tạo bằng API của họ (lưu storage, mỗi giọng một lần)
    if (provider?.voiceSample) return this.generatedVoiceSample(provider, voice, key);
    const url = provider?.voicePreview?.(voice);
    if (!url) throw new NotFoundException('Không có file nghe thử cho giọng này');
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) throw new NotFoundException('Không tải được file nghe thử');
    const file = { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'audio/mpeg' };
    // đầy thì bỏ file cũ nhất (Map giữ thứ tự thêm vào)
    if (this.voiceCache.size >= VOICE_CACHE_MAX) this.voiceCache.delete(this.voiceCache.keys().next().value!);
    this.voiceCache.set(key, file);
    return file;
  }

  /** Đang tạo file nghe thử (nhiều khách bấm cùng giọng một lúc thì chỉ gọi nhà cung cấp một lần) */
  private readonly voiceSampling = new Map<string, Promise<{ data: Buffer; mimeType: string }>>();

  /** File nghe thử tự tạo: storage có rồi thì dùng lại, chưa có thì gọi nhà cung cấp tạo rồi lưu lại */
  private generatedVoiceSample(provider: AiProvider, voice: string, key: string) {
    const running = this.voiceSampling.get(key);
    if (running) return running;
    const job = (async () => {
      const saved = await this.files.readVoiceSample(provider.key, voice);
      let file = saved ? { data: saved, mimeType: 'audio/mpeg' } : null;
      if (!file) {
        const ctx = await this.ctx(provider.key);
        if (!ctx.config.apiKey) throw new NotFoundException('Không có file nghe thử cho giọng này');
        file = await provider.voiceSample!(voice, ctx).catch((err) => {
          this.logger.warn(`Không tạo được file nghe thử ${key}: ${(err as Error).message}`);
          throw new NotFoundException('Không tạo được file nghe thử, vui lòng thử lại sau');
        });
        if (!file) throw new NotFoundException('Không có file nghe thử cho giọng này');
        await this.files.saveVoiceSample(provider.key, voice, file.data, file.mimeType);
      }
      if (this.voiceCache.size >= VOICE_CACHE_MAX) this.voiceCache.delete(this.voiceCache.keys().next().value!);
      this.voiceCache.set(key, file);
      return file;
    })().finally(() => this.voiceSampling.delete(key));
    this.voiceSampling.set(key, job);
    return job;
  }

  private presentTool(row: AiTool, def: AiToolDef, rate = 1) {
    const p = this.pricingOf(def, row);
    const hint = def.priceHint ? hideProviderText(def.priceHint) : undefined;
    const cleanGroups = row.modelGroups.map((g) => sanitizeToolDisplayName(g)).filter(Boolean);
    return {
      // khoá công khai: URL / API khách không lộ tên nhà cung cấp
      key: publicToolKey(row.key),
      // tên / mô tả / nhóm model: tự lọc sạch mọi ký tự thương hiệu nguồn mà không chèn chữ thừa
      name: sanitizeToolDisplayName(row.name),
      description: hideProviderText(row.description),
      category: row.category,
      icon: row.icon,
      badge: row.badge,
      featured: row.featured,
      maintenance: isMaintenanceTool(row.options),
      updatedAt: row.updatedAt,
      // nhóm model: website gộp các công cụ cùng nhóm thành 1, khách chọn model theo `modelLabel`.
      // Một công cụ có thể ở nhiều nhóm (`groups`); `group` = nhóm đầu tiên, giữ cho bản website cũ còn cache
      groups: cleanGroups,
      group: cleanGroups[0] ?? null,
      modelLabel: sanitizeToolDisplayName(row.modelLabel || row.name),
      output: def.output,
      // link nghe thử giọng đọc: thay tên nhà cung cấp bằng mã trung tính
      // chữ hướng dẫn trong form cũng che tên / link nhà cung cấp
      fields: def.fields.map((f) => publicField(f)),
      // form nhiều cặp + số lượng nhân bản (website tự nhân ra nhiều tác vụ)
      pairs: def.pairs ?? null,
      copies: def.copies ?? null,
      // ví dụ đầu ra hiện trên trang công cụ
      samples: def.samples ?? [],
      // video / ảnh mẫu admin tải lên hiện ngay đầu bảng Thiết lập trên trang khách
      demoVideo: this.publicDemoUrl(row.options),
      // ảnh bìa thẻ quy trình (null = công cụ thường)
      cover: def.cover ?? null,
      // khách chỉ cần biết cách tính, không cần biết chi phí phía nhà cung cấp
      // giá cố định gửi cho khách đã gồm % lãi (cùng công thức với quoteCredits)
      pricing:
        p.mode === 'free'
          ? { mode: 'free' as const, min: 0 }
          : p.mode === 'cost' || p.mode === 'by_resolution' || (p.mode === 'per_second' && Object.values(p.resolutionPrices ?? {}).some((v) => Number(v) > 0))
            ? {
                mode: 'dynamic' as const,
                min: p.min ?? 0,
                ...(p.mode === 'cost' && def.costPerUnit && def.unitLabel
                  ? { perUnit: Math.ceil(def.costPerUnit * rate * markupFactor(p)), unitLabel: def.unitLabel }
                  : {}),
                ...(hint ? { hint } : {}),
              }
            : p.mode === 'tiers'
              ? {
                  mode: 'tiers' as const,
                  base: Math.ceil((p.tier10to20 ?? p.base ?? 0) * markupFactor(p)),
                  tier10to20: Math.ceil((p.tier10to20 ?? p.base ?? 0) * markupFactor(p)),
                  tier20to30: Math.ceil((p.tier20to30 ?? p.tier10to20 ?? p.base ?? 0) * markupFactor(p)),
                  min: p.min ?? 0,
                }
              : p.mode === 'per_second'
                ? {
                    mode: 'fixed' as const,
                    base: (p.base ?? 0) * markupFactor(p),
                    perUnit: (p.perUnit ?? 0) * markupFactor(p),
                    unitLabel: 'giây',
                    min: p.min ?? 0,
                    ...(hint ? { hint } : {}),
                  }
                : p.mode === 'per_char'
                  ? {
                      mode: 'fixed' as const,
                      base: (p.base ?? 0) * markupFactor(p),
                      perUnit: (p.perUnit ?? 0) * markupFactor(p),
                      unitLabel: '1.000 ký tự',
                      min: p.min ?? 0,
                      ...(hint ? { hint } : {}),
                    }
                  : { mode: 'fixed' as const, base: (p.base ?? 0) * markupFactor(p), perUnit: (p.perUnit ?? 0) * markupFactor(p), unitLabel: (p.perUnit ?? 0) > 0 ? (def.unitLabel ?? null) : null, min: p.min ?? 0, ...(hint ? { hint } : {}) },
    };
  }

  /**
   * Gọi công cụ gốc đã tách theo model (vd khách API cũ gửi `tmc.image-to-video` kèm `model`) -> chuyển sang công cụ con
   * của model đó nếu đang bật, để tính đúng giá riêng từng model và không bị báo "tạm dừng" vì công cụ gốc đã tắt.
   */
  private async routeModelKey(key: string, raw: unknown) {
    if (key.includes(MODEL_SEP)) return key;
    const r = this.resolve(key);
    const field = r && splitModelField(r.def);
    if (!field) return key;
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).model : undefined;
    const child = `${key}${MODEL_SEP}${String(v || field.default || field.options[0].value)}`;
    const row = await this.prisma.aiTool.findUnique({ where: { key: child }, select: { enabled: true } });
    return row?.enabled ? child : key;
  }

  /** Phần trăm chiết khấu giảm giá riêng (0..100) admin cài cho thành viên */
  private async userDiscountOf(userId?: string | null): Promise<number> {
    if (!userId) return 0;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { customDiscount: true } });
    const n = Number(u?.customDiscount ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  }

  /** Áp dụng % chiết khấu giảm giá của thành viên lên giá gốc công cụ */
  private applyUserDiscount(baseCredits: number, discountPct: number): number {
    if (baseCredits <= 0 || discountPct <= 0) return baseCredits;
    if (discountPct >= 100) return 0;
    return Math.max(1, Math.round(baseCredits * (1 - discountPct / 100)));
  }

  /** Báo giá trước khi chạy (form gọi khi khách đổi lựa chọn) */
  async quote(userId: string, key: string, raw: unknown) {
    const { row, provider, def: baseDef } = await this.loadRunnable(await this.routeModelKey(internalToolKey(key), raw));
    const ctx = await this.ctx(provider.key, userId);
    const def = await this.effectiveDef(provider, baseDef, ctx, row.options);
    const input = validateInput(def.fields, raw, (url) => this.files.ownsInput(userId, url), true);
    const [originalCredits, discount] = await Promise.all([
      this.quoteCredits(provider, def, row, input, ctx),
      this.userDiscountOf(userId),
    ]);
    const credits = this.applyUserDiscount(originalCredits, discount);
    return { credits, originalCredits, discount };
  }

  /** Báo giá công khai cho khách chưa đăng nhập khi xem trang công cụ trong Studio (T-310) */
  async publicQuote(key: string, raw: unknown) {
    const { row, provider, def: baseDef } = await this.loadRunnable(await this.routeModelKey(internalToolKey(key), raw));
    const ctx = await this.ctx(provider.key);
    const def = await this.effectiveDef(provider, baseDef, ctx, row.options);
    const input = validateInput(def.fields, raw, () => false, true);
    const credits = await this.quoteCredits(provider, def, row, input, ctx);
    return { credits, originalCredits: credits, discount: 0 };
  }

  private async loadRunnable(key: string) {
    const row = await this.prisma.aiTool.findUnique({ where: { key } });
    const r = row && this.resolve(key);
    // nhóm đang tắt -> mọi công cụ trong nhóm cũng tạm dừng
    if (!row || !r || !row.enabled || (await this.categories.disabledKeys()).has(row.category)) throw new NotFoundException('Công cụ không tồn tại hoặc đang tạm dừng');
    return { row, ...r };
  }

  // ---------------- tải file đầu vào từ link ----------------

  /**
   * Ô "Dán link video" (vd Motion Control): tải video về storage như khách tự tải file lên.
   * - Link mạng xã hội (TikTok, Douyin, Facebook, Instagram, YouTube...) -> chưa hỗ trợ (đã gỡ VidGrab 2026-11-10), khách tải file lên;
   * - Link file trực tiếp (.mp4 / .mov / .webm) -> tải thẳng qua safeFetch (chặn địa chỉ nội bộ, giới hạn dung lượng).
   */
  async importFromUrl(userId: string, raw: string) {
    const url = String(raw ?? '').trim();
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new BadRequestException('Link không hợp lệ, vui lòng dán link bắt đầu bằng http:// hoặc https://');
    }
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('Link không hợp lệ, vui lòng dán link bắt đầu bằng http:// hoặc https://');
    const social = /(^|\.)(tiktok\.com|douyin\.com|iesdouyin\.com|facebook\.com|fb\.watch|instagram\.com|youtube\.com|youtu\.be|threads\.net|twitter\.com|x\.com|kuaishou\.com|bilibili\.com|xiaohongshu\.com|xhslink\.com)$/.test(host);
    if (social) throw new BadRequestException('Chưa hỗ trợ dán link mạng xã hội, vui lòng tải file video lên');
    try {
      const res = await safeFetch(url, { timeoutMs: 120_000, maxBytes: AI_UPLOAD_HARD_MB * 1024 * 1024, maxRedirects: 5 });
      if (!res.ok) throw new BadRequestException(`Không tải được video từ link (HTTP ${res.status})`);
      if (!res.mime.startsWith('video/')) throw new BadRequestException('Link không phải file video (cần link .mp4 / .mov hoặc link TikTok / Douyin)');
      const name = (new URL(res.url).pathname.split('/').pop() || 'video.mp4').slice(0, 120);
      return this.files.saveInput(userId, { buffer: res.body, mimetype: res.mime, originalname: name, size: res.body.length });
    } catch (err) {
      if (err instanceof SafeFetchError) throw new BadRequestException(err.code === 'TOO_LARGE' ? `Video quá lớn (tối đa ${AI_UPLOAD_HARD_MB}MB)` : `Không tải được video từ link: ${err.message}`);
      throw err;
    }
  }

  // ---------------- chạy tác vụ ----------------

  /** Khách chạy một công cụ */
  /** `extra`: khoá nội bộ do server tự thêm sau khi kiểm tra input của khách (vd `replyTo` khi trả lời Muse), khách không gửi được */
  async run(user: AuthUser, key: string, raw: unknown, meta: { ip?: string | null; viaApi?: boolean; isPublic?: boolean; requestId?: string } = {}, extra?: AiInput) {
    const { row, provider, def: baseDef } = await this.loadRunnable(await this.routeModelKey(internalToolKey(key), raw));
    if (isMaintenanceTool(row.options)) throw new BadRequestException('Gói này hiện đang bảo trì, vui lòng chọn model khác hoặc thử lại sau');
    const ctx = await this.ctx(provider.key, user.id);
    if (!ctx.config.enabled || !ctx.config.apiKey) throw new BadRequestException('Công cụ đang bảo trì, vui lòng thử lại sau');
    const def = await this.effectiveDef(provider, baseDef, ctx, row.options);
    const input = { ...validateInput(def.fields, raw, (url) => this.files.ownsInput(user.id, url)), ...extra };
    const [detail, discount] = await Promise.all([
      this.quoteDetail(provider, def, row, input, ctx),
      this.userDiscountOf(user.id),
    ]);
    const rawCredits = detail.credits;
    const credits = this.applyUserDiscount(rawCredits, discount);
    const p = this.pricingOf(def, row);
    const estimatedProviderCost = await (async () => {
      if (detail.providerCost !== null && Number.isFinite(detail.providerCost)) return Math.round(detail.providerCost);
      if (provider.cost && supportsCost(provider, def)) {
        const raw = await provider.cost(def, input, ctx).catch(() => null);
        if (raw !== null && Number.isFinite(raw)) return Math.round(raw * providerRate(provider, ctx.config));
      }
      if ((Number(p.markup) || 0) > 0 && provider.key !== 'fable' && provider.key !== 'tavtavvideo') {
        return Math.round(rawCredits / markupFactor(p));
      }
      return 0;
    })();

    const isFableQueue = provider.key === 'fable';
    const baseLimit = await this.credits.concurrencyOf(user.id);
    // T-420: mở 60 luồng chạy song song cho kết nối API của khách
    const limit = meta.viaApi ? Math.max(60, baseLimit) : baseLimit;
    const cleanReqId = meta.requestId?.trim().slice(0, 80) || '';
    const initOutput: Record<string, unknown> = {
      ...(meta.isPublic ? { __communityPending: true } : {}),
      ...(cleanReqId ? { __reqId: cleanReqId } : {}),
    };
    const task = await withDeadlockRetry(() => this.prisma.$transaction(async (tx) => {
      // khoá dòng user rồi mới đếm: nhiều request song song không cùng lọt qua giới hạn số luồng theo gói
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      // T-422: Chặn tuyệt đối Nginx `proxy_next_upstream non_idempotent` nhân đôi đơn khi cuộn tiến trình API
      if (cleanReqId) {
        const dup = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM ai_tasks
          WHERE "userId" = ${user.id}::uuid
            AND "createdAt" >= NOW() - INTERVAL '10 minutes'
            AND output->>'__reqId' = ${cleanReqId}
          LIMIT 1
        `;
        if (dup[0]?.id) {
          const existing = await tx.aiTask.findUnique({ where: { id: dup[0].id } });
          if (existing) return { t: existing, txn: null, deduplicated: true };
        }
      }
      const running = await tx.aiTask.count({ where: { userId: user.id, status: { in: ['PENDING', 'PROCESSING'] } } });
      if (running >= limit) throw new ConflictException(`Bạn đang có ${running} tác vụ đang chạy (tối đa ${limit} theo gói). Nâng cấp gói để chạy nhiều luồng hơn.`);
      const t = await tx.aiTask.create({
        // Fable xếp hàng FIFO theo createdAt ASC qua drainFableQueue; các nguồn khác giữ SUBMIT_HOLD_MS để tự gửi ngay bên dưới
        data: {
          code: taskCode(),
          userId: user.id,
          toolKey: row.key,
          provider: provider.key,
          status: 'PENDING',
          input: input as object,
          credits,
          ip: meta.ip ?? null,
          viaApi: !!meta.viaApi,
          // T-394: Không bao giờ tự động đẩy thẳng ảnh/video khách tạo lên Cộng đồng ngoài Website khi chưa qua kiểm duyệt Admin
          isPublic: false,
          ...(Object.keys(initOutput).length > 0 ? { output: initOutput as object } : {}),
          nextPollAt: isFableQueue ? new Date() : new Date(Date.now() + SUBMIT_HOLD_MS),
        },
      });
      // công cụ miễn phí (0 credits) không ghi giao dịch trừ credits
      const txn =
        credits > 0
          ? await this.credits.apply(tx, {
              userId: user.id,
              type: 'USAGE',
              amount: -credits,
              taskId: t.id,
              note: `${row.name} · ${t.code}`,
              meta: {
                provider: provider.key,
                toolKey: row.key,
                providerCost: estimatedProviderCost,
                originalCredits: rawCredits,
              },
              idempotencyKey: `usage:${t.id}`,
            })
          : null;
      return { t, txn, deduplicated: false };
    }, { maxWait: 10_000, timeout: 15_000 }));
    if (task.deduplicated) {
      return this.myTask(user.id, task.t.id);
    }
    if (task.txn) this.credits.afterChange(task.txn);

    // T-321 & T-422: Mọi lệnh tạo tác vụ (cả trên Web lẫn API) chỉ giữ HTTP tối đa 2.5s rồi trả ngay trạng thái PENDING / PROCESSING
    // để không bao giờ bị treo kết nối 30–45s khi cắt đuôi video ffmpeg / upload sang nguồn (tránh dính 502 / proxy_next_upstream)
    if (isFableQueue) {
      await Promise.race([
        this.drainFableQueue(false).catch((err) => this.logger.error(`Hàng đợi Fable lỗi (${task.t.code}): ${(err as Error).message}`)),
        new Promise<void>((r) => setTimeout(r, 2_200)),
      ]);
    } else {
      await Promise.race([
        this.submit(task.t, provider, def, ctx).catch((err) => this.logger.error(`Gửi tác vụ ${task.t.code} lỗi: ${(err as Error).message}`)),
        new Promise<void>((r) => setTimeout(r, 2_500)),
      ]);
    }
    return this.myTask(user.id, task.t.id);
  }

  /** Gửi tác vụ PENDING sang nhà cung cấp (ghi nhận lần gửi đang dở để API tắt thì chờ xong) */
  private async submit(task: AiTask, provider: AiProvider, def: AiToolDef, ctx: AiCallContext): Promise<'ok' | 'waiting_slot' | 'retry' | 'failed'> {
    const run = this.doSubmit(task, provider, def, ctx);
    this.submitting.add(run);
    try {
      return await run;
    } finally {
      this.submitting.delete(run);
    }
  }

  private async doSubmit(task: AiTask, provider: AiProvider, def: AiToolDef, ctx: AiCallContext): Promise<'ok' | 'waiting_slot' | 'retry' | 'failed'> {
    try {
      const res = await provider.submit(def, task.input as AiInput, ctx);
      if (res.status === 'failed' && res.error) {
        const recovered = await this.tryAutoHealAndRetrySubmit(task, provider, def, ctx, res.error, res.raw);
        if (recovered) return recovered;
      }
      await this.applyResult(task, res, true);
      return res.status === 'failed' ? 'failed' : 'ok';
    } catch (err) {
      const e = err as AiProviderError;
      const rawObj = (e?.raw && typeof e.raw === 'object' ? e.raw : null) as { waitingSlot?: boolean; retryMs?: number } | null;
      if (e instanceof AiProviderError && rawObj?.waitingSlot === true) {
        // chờ tới lượt luồng trống của nguồn (vd Fable / Vimo) -> không đốt số lần thử lỗi, chỉ lùi giờ gửi lại
        const delayMs = provider.key === 'fable' ? 10_000 : Math.min(90_000, Math.max(10_000, Number(rawObj.retryMs) || 20_000));
        await this.prisma.aiTask.update({ where: { id: task.id }, data: { nextPollAt: new Date(Date.now() + delayMs), providerData: e.raw as object } });
        return 'waiting_slot';
      }
      if (e instanceof AiProviderError) {
        const recovered = await this.tryAutoHealAndRetrySubmit(task, provider, def, ctx, e.message, e.raw);
        if (recovered) return recovered;
      }
      const attempts = task.pollCount + 1;
      if (e instanceof AiProviderError && e.retryable && attempts < MAX_SUBMIT_ATTEMPTS) {
        await this.prisma.aiTask.update({ where: { id: task.id }, data: { pollCount: attempts, nextPollAt: new Date(Date.now() + 30_000 * attempts), providerData: (e.raw ?? null) as object } });
        return 'retry';
      }
      if (!(e instanceof AiProviderError)) this.logger.error(`Gửi tác vụ ${task.code} lỗi: ${(err as Error).message}`);
      await this.fail(task, e instanceof AiProviderError ? e.message : 'Hệ thống AI đang gặp sự cố, tiền đã được hoàn lại', e instanceof AiProviderError ? e.raw : { error: (err as Error).message });
      return 'failed';
    }
  }

  /**
   * T-507: Ngay khi nguồn từ chối tham số (độ phân giải / thời lượng / tỉ lệ khung hình):
   * 1) Tự động sửa cấu hình `options.healedFieldOptions` của công cụ để khách tiếp theo thấy đúng tuỳ chọn chuẩn trên form;
   * 2) Tự động ánh xạ tham số sang giá trị hợp lệ gần nhất và gửi lại ngay 1 lần để đơn của khách thành công mượt mà không bị rớt!
   */
  private async tryAutoHealAndRetrySubmit(
    task: AiTask,
    provider: AiProvider,
    def: AiToolDef,
    ctx: AiCallContext,
    rawError: string,
    rawData?: unknown,
  ): Promise<'ok' | 'failed' | null> {
    const prevOut = task.output && typeof task.output === 'object' ? (task.output as Record<string, unknown>) : {};
    if (prevOut.__paramAutoRetried === true) return null;

    const combined = `${rawError ?? ''} ${rawData ? JSON.stringify(rawData).slice(0, 1000) : ''}`;
    const mismatch = parseUpstreamParamMismatch(combined);
    if (!mismatch) return null;

    await this.healToolParamMismatch(task.toolKey, mismatch, task.code, combined).catch(() => undefined);

    const remapped = remapInputForAllowedParam(task.input as AiInput, mismatch);
    if (!remapped.changed) return null;

    const nextOut = {
      ...prevOut,
      __paramAutoRetried: true,
      __healedParam: { kind: mismatch.paramKind, from: remapped.fromVal, to: remapped.toVal, allowed: mismatch.allowed },
    };
    await this.prisma.aiTask.update({
      where: { id: task.id },
      data: { input: remapped.nextInput as object, output: nextOut as object },
    });
    task.input = remapped.nextInput as unknown as Prisma.JsonValue;
    task.output = nextOut as unknown as Prisma.JsonValue;

    const toolRow = await this.prisma.aiTool.findUnique({ where: { key: task.toolKey }, select: { options: true } });
    const healedDef = toolRow ? applyHealedFields(def, toolRow.options) : def;
    try {
      const retryRes = await provider.submit(healedDef, remapped.nextInput, ctx);
      await this.applyResult(task, retryRes, true);
      this.logger.warn(
        `[AutoFix T-507] Đã tự động chuyển ${mismatch.labelVi} '${remapped.fromVal}' -> '${remapped.toVal}' & cứu sống đơn #${task.code} (${task.toolKey})`,
      );
      return retryRes.status === 'failed' ? 'failed' : 'ok';
    } catch {
      return null;
    }
  }

  /**
   * Hàng đợi FIFO đa luồng cho Fable Studio:
   * - Luôn nhận đơn theo đúng thứ tự tạo (`createdAt ASC, id ASC`), không nhảy cóc.
   * - Đẩy đơn vào luồng nguồn ở chế độ nền có giãn nhịp ngắn (`FABLE_LAUNCH_PACE_MS`), để các tác vụ ảnh đồng bộ
   *   (`grok-image` / `grok-edit` giữ kết nối 45–120s) chạy song song lấp đầy toàn bộ số luồng thuê ở nguồn thay vì chặn cứng 1 luồng.
   * - Ngay khi nguồn phản hồi 429 đầy luồng (`waiting_slot`), dừng ngay việc mở luồng mới để giữ nguyên thứ tự hàng đợi.
   */
  private async drainFableQueue(force = false): Promise<void> {
    if (this.stopping) return;
    if (force) this.fableLastFullAt = 0;
    if (!force && this.fableLastFullAt > 0 && Date.now() - this.fableLastFullAt < 8_000) return;
    if (this.drainingFable) {
      this.drainFablePending = true;
      if (force) this.drainFableForce = true;
      return;
    }
    this.drainingFable = true;
    try {
      let forcePass = force;
      for (;;) {
        this.drainFablePending = false;
        this.drainFableForce = false;
        if (this.stopping) break;
        if (!forcePass && this.fableLastFullAt > 0 && Date.now() - this.fableLastFullAt < 8_000) break;
        if (this.activeFableSubmits.size >= FABLE_MAX_CONCURRENT_SUBMITS) break;
        const s = await this.settings.get<AiSettings>('ai');
        const timeout = Math.min(10_080, Math.max(5, Number(s.timeoutMinutes) || 45)) * 60_000;
        const holdCutoff = new Date(Date.now() + 2 * 60_000);
        const queue = await this.prisma.aiTask.findMany({
          where: {
            provider: 'fable',
            status: 'PENDING',
            OR: [{ nextPollAt: null }, { nextPollAt: { lt: holdCutoff } }],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        if (!queue.length) break;
        let progressed = false;
        for (const item of queue) {
          if (this.stopping) break;
          if (this.activeFableSubmits.size >= FABLE_MAX_CONCURRENT_SUBMITS) break;
          if (!forcePass && this.fableLastFullAt > 0 && Date.now() - this.fableLastFullAt < 8_000) break;
          if (!forcePass && item.pollCount > 0 && item.nextPollAt && item.nextPollAt.getTime() > Date.now()) {
            break;
          }
          const claimed = await this.prisma.aiTask.updateMany({
            where: { id: item.id, status: 'PENDING', nextPollAt: item.nextPollAt },
            data: { nextPollAt: new Date(Date.now() + SUBMIT_HOLD_MS) },
          });
          if (!claimed.count) continue;
          progressed = true;
          if (Date.now() - item.createdAt.getTime() > timeout) {
            await this.fail(item, 'Tác vụ xử lý quá lâu nên đã được huỷ, tiền đã được hoàn lại');
            continue;
          }
          const r = this.resolve(item.toolKey);
          if (!r) {
            await this.fail(item, 'Công cụ không còn khả dụng, tiền đã được hoàn lại');
            continue;
          }
          const ctx = await this.ctx(r.provider.key, item.userId);
          const submitStartedAt = Date.now();
          const bgJob = this.submit(item, r.provider, r.def, ctx)
            .then((outcome) => {
              if (outcome === 'waiting_slot') {
                this.fableLastFullAt = Date.now();
              } else if (outcome === 'ok' && this.fableLastFullAt < submitStartedAt) {
                this.fableLastFullAt = 0;
              }
              return outcome;
            })
            .catch((err): 'failed' => {
              this.logger.warn(`Gửi tác vụ Fable ${item.code} lỗi: ${(err as Error).message}`);
              return 'failed';
            })
            .finally(() => {
              this.activeFableSubmits.delete(bgJob);
              if (!this.stopping && (this.fableLastFullAt === 0 || Date.now() - this.fableLastFullAt >= 8_000)) {
                void this.drainFableQueue(false).catch(() => undefined);
              }
            });
          this.activeFableSubmits.add(bgJob);

          // Chờ tối đa 1.5s: nếu nguồn báo 429 đầy luồng (~200–400ms) hoặc grok-video tạo job xong (~1s) thì biết ngay kết quả;
          // nếu là grok-image / grok-edit đồng bộ (chạy 45–120s) và đã lọt vào luồng trống thì tiếp tục đẩy đơn kế tiếp sang các luồng còn trống.
          const raced = await Promise.race([
            bgJob,
            new Promise<'paced'>((resolve) => setTimeout(() => resolve('paced'), FABLE_LAUNCH_PACE_MS)),
          ]);
          forcePass = false;
          if (raced === 'waiting_slot') {
            break;
          }
        }
        if (this.drainFablePending) {
          forcePass = this.drainFableForce;
        } else if (!progressed || (this.fableLastFullAt > 0 && Date.now() - this.fableLastFullAt < 8_000) || this.activeFableSubmits.size >= FABLE_MAX_CONCURRENT_SUBMITS) {
          break;
        }
      }
    } finally {
      this.drainingFable = false;
    }
  }

  /** Ghi kết quả gửi / hỏi trạng thái vào tác vụ */
  private async applyResult(task: AiTask, res: AiProviderResult, submitted = false) {
    if (res.status === 'failed') return this.fail(task, res.error || 'Nhà cung cấp AI không xử lý được yêu cầu, tiền đã được hoàn lại', res.raw);
    if (res.status === 'succeeded') {
      // sao lưu file có thể lâu -> gia hạn quyền xử lý để cron / instance khác không giành lại tác vụ
      if (res.files?.length) await this.prisma.aiTask.updateMany({ where: { id: task.id, status: { in: ['PENDING', 'PROCESSING'] } }, data: { nextPollAt: new Date(Date.now() + SUBMIT_HOLD_MS) } });
      const files = res.files?.length ? await this.files.mirror(task.userId, res.files) : [];
      const prevCustomName = taskCustomNameOf(task.output);
      const prevViolationReview = extractStoredViolationReview(task.output);
      const prevCommunityPending = taskCommunityPendingOf(task.output);
      const done = await this.prisma.aiTask.updateMany({
        where: { id: task.id, status: { in: ['PENDING', 'PROCESSING'] } },
        data: {
          status: 'SUCCEEDED',
          progress: 100,
          output: {
            files,
            ...(res.text ? { text: res.text } : {}),
            ...(prevCustomName ? { customName: prevCustomName } : {}),
            ...(prevViolationReview ? { __violationReview: prevViolationReview } : {}),
            ...(prevCommunityPending ? { __communityPending: true } : {}),
          } as object,
          providerTaskId: res.providerTaskId ?? task.providerTaskId,
          providerData: (res.raw ?? null) as object,
          completedAt: new Date(),
          nextPollAt: null,
          ...(submitted ? { startedAt: new Date() } : {}),
        },
      });
      if (done.count) {
        this.consecutiveMaintErrors.delete(task.toolKey);
        this.events.emit('ai.task.succeeded', { taskId: task.id, userId: task.userId });
        if (task.provider === 'fable') void this.drainFableQueue(true).catch(() => undefined);
        const flagged = inspectTaskViolation({ input: task.input, output: task.output, error: null, providerData: res.raw });
        if (!flagged && files[0]?.url && (files[0].type === 'video' || files[0].type === 'image')) {
          void this.autoAttachDemoIfMissing(task.toolKey, files[0].url).catch(() => undefined);
        }
      }
      return;
    }
    const s = await this.settings.get<AiSettings>('ai');
    const every = Math.max(5, Number(s.pollSeconds) || 10);
    const effectiveStart = submitted ? new Date() : (task.startedAt ?? task.createdAt);
    const rawPct = extractUpstreamProgress(res.progress, res.raw);
    let nextProgress: number;
    if (isUpstreamQueued(res.raw)) {
      nextProgress = Math.max(task.progress, 3);
    } else {
      const elapsedSec = Math.max(1, (Date.now() - effectiveStart.getTime()) / 1000);
      const estSec = estimateTaskDurationSec(task.toolKey, this.resolve(task.toolKey)?.def.output);
      const timeCurvePct = Math.min(95, Math.max(5, Math.round(95 * (1 - Math.exp(-elapsedSec / estSec)))));
      nextProgress = Math.min(97, Math.max(task.progress, rawPct ?? 0, timeCurvePct));
    }
    const nowIso = new Date().toISOString();
    const prevOutObj = task.output && typeof task.output === 'object' ? (task.output as Record<string, unknown>) : {};
    const rawStatusStr =
      res.raw && typeof res.raw === 'object' && typeof (res.raw as Record<string, unknown>).status === 'string'
        ? String((res.raw as Record<string, unknown>).status)
        : isUpstreamQueued(res.raw)
          ? 'queued'
          : 'processing';
    const statusChanged =
      submitted ||
      prevOutObj.__lastUpstreamStatus !== rawStatusStr ||
      (rawPct !== null && prevOutObj.__lastRawPct !== rawPct);
    const nextOutObj = {
      ...prevOutObj,
      __lastPolledAt: nowIso,
      __lastChangedAt: statusChanged ? nowIso : (prevOutObj.__lastChangedAt ?? nowIso),
      __lastUpstreamStatus: rawStatusStr,
      ...(rawPct !== null ? { __lastRawPct: rawPct } : {}),
    };
    await this.prisma.aiTask.updateMany({
      where: { id: task.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: {
        status: 'PROCESSING',
        progress: nextProgress,
        providerTaskId: res.providerTaskId ?? task.providerTaskId,
        providerData: (res.raw ?? null) as object,
        output: nextOutObj as object,
        nextPollAt: new Date(Date.now() + every * 1000),
        ...(submitted || !task.startedAt ? { startedAt: effectiveStart } : {}),
        ...(submitted ? { pollCount: 0 } : { pollCount: { increment: 1 } }),
      },
    });
  }

  /** Tự động gắn media mẫu vĩnh viễn cho công cụ chưa có mẫu ngay khi có lượt tạo thành công đầu tiên (T-232/T-234) */
  private async autoAttachDemoIfMissing(toolKey: string, outputUrl: string) {
    if (/download|tiktok|remove-bg/i.test(toolKey)) return;
    const tool = await this.prisma.aiTool.findUnique({ where: { key: toolKey }, select: { options: true } });
    if (!tool) return;
    const opts = ((tool.options as Record<string, unknown> | null) ?? {});
    if (typeof opts.demoVideo === 'string' && opts.demoVideo.trim()) return;
    const demoUrl = await this.files.mirrorDemoUrl(outputUrl);
    if (!demoUrl || !demoUrl.includes('/ai/demos/')) return;
    const latest = await this.prisma.aiTool.findUnique({ where: { key: toolKey }, select: { options: true } });
    const latestOpts = ((latest?.options as Record<string, unknown> | null) ?? {});
    if (typeof latestOpts.demoVideo === 'string' && latestOpts.demoVideo.trim()) return;
    await this.prisma.aiTool.update({
      where: { key: toolKey },
      data: { options: { ...latestOpts, demoVideo: demoUrl } as object },
    });
  }

  /** Đánh lỗi tác vụ và hoàn credits (chỉ một lần) */
  private async fail(task: AiTask, rawError: string, raw?: unknown, status: 'FAILED' | 'CANCELLED' = 'FAILED') {
    const error = hideProviderText(rawError) || 'Không xử lý được yêu cầu, tiền đã được hoàn lại vào ví';
    const autoCheck =
      status === 'FAILED'
        ? await this.diagnoseAndHealFailure(task.toolKey, rawError, raw, task.code).catch(() => null)
        : null;
    const prevOut = task.output && typeof task.output === 'object' ? (task.output as Record<string, unknown>) : {};
    const nextOutput = autoCheck ? ({ ...prevOut, __autoCheck: autoCheck } as object) : undefined;
    const txn = await withDeadlockRetry(() => this.prisma.$transaction(async (tx) => {
      // khoá dòng user TRƯỚC dòng tác vụ (cùng thứ tự với run() / CreditsService.apply) để không deadlock khi nhiều tác vụ cùng lỗi
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${task.userId}::uuid FOR UPDATE`;
      const done = await tx.aiTask.updateMany({
        where: { id: task.id, status: { in: ['PENDING', 'PROCESSING'] } },
        data: {
          status,
          error: error.slice(0, 500),
          providerData: (raw ?? null) as object,
          ...(nextOutput ? { output: nextOutput } : {}),
          completedAt: new Date(),
          nextPollAt: null,
        },
      });
      if (!done.count || task.credits <= 0) return null;
      // tài khoản đã xoá: đóng tác vụ nhưng không hoàn (hoàn sẽ lỗi và làm rollback, cron xử lý lại mãi)
      const owner = await tx.user.findFirst({ where: { id: task.userId, deletedAt: null }, select: { id: true } });
      if (!owner) return null;
      await tx.aiTask.update({ where: { id: task.id }, data: { refunded: true } });
      return this.credits.apply(tx, { userId: task.userId, type: 'REFUND', amount: task.credits, taskId: task.id, note: `Hoàn tiền tác vụ ${task.code}`, idempotencyKey: `refund:${task.id}` });
    }));
    if (txn) this.credits.afterChange(txn);
    this.events.emit('ai.task.failed', { taskId: task.id, userId: task.userId, error });
    if (!isChildSite() && (task.viaApi || task.providerTaskId)) {
      void this.cascadeRefundToChildSites(task, error).catch(() => undefined);
    }
    if (task.provider === 'fable') void this.drainFableQueue(true).catch(() => undefined);
    // T-358: nếu API nguồn trả lỗi bảo trì máy chủ rõ ràng 2 đơn liên tiếp -> tự bật autoMaintenance cho công cụ đó
    if (status === 'FAILED' && /\b503\b|đang bảo trì|tạm thời bảo trì|server_unverified|tạm đóng/i.test(rawError)) {
      const cnt = (this.consecutiveMaintErrors.get(task.toolKey) ?? 0) + 1;
      this.consecutiveMaintErrors.set(task.toolKey, cnt);
      if (cnt >= 2) {
        this.consecutiveMaintErrors.delete(task.toolKey);
        void this.setAutoMaintenance(task.toolKey, true).catch(() => undefined);
        void this.sendAutoFixReportToDevBot({
          taskCode: task.code,
          toolKey: task.toolKey,
          rawError,
          actionCmd: `setAutoMaintenance('${task.toolKey}', true) /* 2 đơn 503/bảo trì liên tiếp */`,
          summary: 'Nguồn trả lỗi 503 / bảo trì 2 đơn liên tiếp — đã tự bật bảo trì tạm thời',
        });
      }
    } else if (status === 'FAILED') {
      this.consecutiveMaintErrors.delete(task.toolKey);
    }
  }

  /** Chống báo trùng liên tục cùng 1 lệnh tự fix cho cùng 1 model trong vòng 15 phút */
  private readonly autoFixNotifyCooldown = new Map<string, number>();

  /** Đọc cấu hình bot Telegram kỹ thuật (`@devnovaivnbot` ở `/opt/novai-telebot/.env`) hoặc dự phòng `telegram_admin` để báo cáo mọi lệnh tự fix (T-417) */
  private async sendAutoFixReportToDevBot(payload: {
    taskCode?: string;
    toolKey: string;
    rawError: string;
    actionCmd: string;
    summary: string;
  }) {
    const cooldownKey = `${payload.toolKey}::${payload.actionCmd}`;
    const now = Date.now();
    const lastAt = this.autoFixNotifyCooldown.get(cooldownKey) ?? 0;
    if (now - lastAt < 15 * 60_000) return;
    this.autoFixNotifyCooldown.set(cooldownKey, now);
    if (this.autoFixNotifyCooldown.size > 300) {
      for (const [k, t] of this.autoFixNotifyCooldown) if (now - t > 3600_000) this.autoFixNotifyCooldown.delete(k);
    }

    try {
      let botToken = '';
      let chatIds: string[] = [];
      const devEnvFile = '/opt/novai-telebot/.env';
      if (existsSync(devEnvFile)) {
        const lines = readFileSync(devEnvFile, 'utf8').split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#') || !line.includes('=')) continue;
          const idx = line.indexOf('=');
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k === 'TELEGRAM_TOKEN') botToken = v;
          else if (k === 'ADMIN_IDS') {
            chatIds = v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
      }
      if (!botToken || !chatIds.length) {
        const tgAdmin = await this.settings.get<{ enabled?: boolean; botToken?: string; chatIds?: string }>('telegram_admin');
        if (tgAdmin?.botToken && tgAdmin?.chatIds) {
          botToken = tgAdmin.botToken.trim();
          chatIds = String(tgAdmin.chatIds)
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      if (!botToken || !chatIds.length) return;

      const toolRow = await this.prisma.aiTool.findUnique({ where: { key: payload.toolKey }, select: { name: true, provider: true, badge: true } });
      const siteHost = (process.env.WEB_URL || 'https://nov.ai.vn').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      const siteTag = isChildSite() ? `🌐 Web con: <code>${esc(siteHost)}</code>` : `🏠 Web mẹ: <code>${esc(siteHost)}</code>`;
      const searchLink = payload.taskCode
        ? `https://nov.ai.vn/admin/ai/tasks?search=${encodeURIComponent(payload.taskCode)}`
        : `https://nov.ai.vn/admin/ai/tasks?status=FAILED`;

      const html =
        `🛠️ <b>[Tự động Fix Lỗi Đơn Hàng]</b>\n` +
        `• Hệ thống: ${siteTag}\n` +
        (payload.taskCode ? `• Mã đơn: <code>#${esc(payload.taskCode)}</code>\n` : '') +
        `• Công cụ: <b>${esc(toolRow?.name ?? payload.toolKey)}</b> (<code>${esc(payload.toolKey)}</code>${toolRow?.badge ? ` · ${esc(toolRow.badge)}` : ''})\n` +
        `• Lỗi phát hiện: <code>${esc(String(payload.rawError || '').slice(0, 260))}</code>\n` +
        `• Lệnh tự fix đã chạy: <code>${esc(payload.actionCmd)}</code>\n` +
        `• Kết luận: <b>${esc(payload.summary)}</b>\n` +
        `🔗 Đối chiếu: ${esc(searchLink)}`;

      for (const cid of chatIds) {
        await sendMessage(botToken, cid, html).catch(() => undefined);
      }
    } catch {
      /* không để lỗi gửi thông báo Telegram ảnh hưởng luồng hoàn tiền */
    }
  }

  /**
   * T-507: Lưu cấu hình tham số chuẩn (`options.healedFieldOptions`) lên `ai_tools` ngay khi phát hiện nguồn từ chối độ phân giải / thời lượng / tỉ lệ,
   * làm mới bảng giá công khai, đẩy đồng bộ tức thì sang toàn bộ Website con và gửi biên bản tự fix về `@devnovaivnbot`.
   */
  private async healToolParamMismatch(
    toolKey: string,
    mismatch: UpstreamParamMismatch,
    taskCode?: string,
    rawError = '',
  ): Promise<{ changed: boolean; summary: string }> {
    const allowedText = `[${mismatch.allowed.map((x) => `'${x}'`).join(', ')}]`;
    const summary = `Đã tự động đồng bộ ${mismatch.labelVi} chuẩn ${allowedText} & gỡ tuỳ chọn không hợp lệ khỏi form`;

    const toolRow = await this.prisma.aiTool.findUnique({
      where: { key: toolKey },
      select: { name: true, modelLabel: true, description: true, options: true },
    });
    if (!toolRow || isDeletedTool(toolRow.options)) {
      return { changed: false, summary };
    }

    const opts = toolRow.options && typeof toolRow.options === 'object' ? (toolRow.options as Record<string, unknown>) : {};
    const prevHealed =
      opts.healedFieldOptions && typeof opts.healedFieldOptions === 'object'
        ? { ...(opts.healedFieldOptions as Record<string, string[]>) }
        : {};
    const prevList = Array.isArray(prevHealed[mismatch.paramKind]) ? prevHealed[mismatch.paramKind] : [];
    const sameList =
      prevList.length === mismatch.allowed.length &&
      prevList.every((v, i) => v.toLowerCase() === mismatch.allowed[i].toLowerCase());

    // Tự động chỉnh nhãn "tới 4K" -> "tới 2K" / "tới 1080p" nếu nguồn gỡ mốc 4K khỏi độ phân giải
    let nextName = toolRow.name;
    let nextLabel = toolRow.modelLabel;
    if (mismatch.paramKind === 'resolution' && !mismatch.allowed.some((v) => /4k|2160/i.test(v))) {
      const topTag = mismatch.allowed.some((v) => /2k|1440/i.test(v))
        ? '2K'
        : mismatch.allowed.some((v) => /1080/i.test(v))
          ? '1080p'
          : null;
      if (topTag) {
        if (/tới\s*4k/i.test(nextName)) nextName = nextName.replace(/tới\s*4k/gi, `tới ${topTag}`);
        if (nextLabel && /tới\s*4k/i.test(nextLabel)) nextLabel = nextLabel.replace(/tới\s*4k/gi, `tới ${topTag}`);
      }
    }

    if (sameList && nextName === toolRow.name && nextLabel === toolRow.modelLabel) {
      return { changed: false, summary };
    }

    const nextHealed = { ...prevHealed, [mismatch.paramKind]: mismatch.allowed };
    const nextOpts = { ...opts, healedFieldOptions: nextHealed, healedAt: new Date().toISOString() };
    await this.prisma.aiTool.update({
      where: { key: toolKey },
      data: {
        ...(nextName !== toolRow.name ? { name: nextName } : {}),
        ...(nextLabel !== toolRow.modelLabel ? { modelLabel: nextLabel } : {}),
        options: nextOpts as object,
      },
    });

    this.priceTable = null;
    this.priceMatrixCache = null;
    void this.refreshPrices();
    this.lastPushedMaintHash = '';

    // Đồng bộ ngay sang tất cả Web con nếu đang chạy trên Web mẹ
    if (!isChildSite()) {
      void (async () => {
        const allRows = await this.prisma.aiTool.findMany({ select: { key: true, options: true } });
        const activeAutoKeys = allRows
          .filter((r) => !isDeletedTool(r.options) && ((r.options ?? {}) as Record<string, unknown>).autoMaintenance === true)
          .map((r) => r.key);
        const healedFields: Record<string, Record<string, string[]>> = {};
        for (const r of allRows) {
          const h = ((r.options ?? {}) as Record<string, unknown>).healedFieldOptions;
          if (h && typeof h === 'object') healedFields[r.key] = h as Record<string, string[]>;
        }
        const children = await this.discoverChildSitesForTasks().catch(() => []);
        await Promise.allSettled(
          children.map((child) =>
            fetch(`${child.apiBase}/api/internal/hub-profit/sync-maint`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-server-secret': child.serverSecret },
              body: JSON.stringify({ maintKeys: activeAutoKeys, healedFields }),
              signal: AbortSignal.timeout(5_000),
            }),
          ),
        );
      })().catch(() => undefined);
    }

    this.logger.warn(`[AutoFix T-507] Đã tự động đồng bộ ${mismatch.labelVi} cho ${toolKey}: ${allowedText}`);
    void this.sendAutoFixReportToDevBot({
      taskCode,
      toolKey,
      rawError: rawError || `${mismatch.paramKind} -> ${allowedText}`,
      actionCmd: `healToolParamMismatch('${toolKey}', { ${mismatch.paramKind}: ${allowedText} })`,
      summary,
    });
    return { changed: true, summary };
  }

  /**
   * T-417 & T-507: Phân tích nguyên nhân đơn lỗi hoàn tiền & tự động sửa / đồng bộ tham số / khoá bảo trì model hỏng phía nguồn ngay lập tức:
   * - Nếu nguồn báo sai giá trị tham số (`resolution`/`duration`/`aspect_ratio must be one of [...]`) -> tự động cập nhật `healedFieldOptions` chuẩn hoá ngay form Studio & đồng bộ sang 9 Web con.
   * - Nếu nguồn báo model ngừng hoạt động / không khả dụng (`Model này hiện không khả dụng`, `model_not_found`, `engine_unavailable`...) -> tự động tắt `enabled = false` model con.
   * - Nếu là lỗi tương thích đã có cơ chế tự chuẩn hoá (`.webp`, `omni_v2v_quality_unsupported`, `maxContentLength`, `> 50MB`, `> 32 MB`, Grok 1.0 > 10s...) -> đánh dấu `fixed_code`.
   * - Nếu một model lỗi hệ thống liên tiếp >= 3 đơn trong 30 phút mà 0 đơn thành công -> tự bật `autoMaintenance` bảo vệ khách.
   * - Mọi lệnh tự fix thực thi (`healedTool === true`) đều bắn thông tin chi tiết về bot kỹ thuật (`@devnovaivnbot`) để Admin theo dõi & kiểm chứng.
   */
  private async diagnoseAndHealFailure(
    toolKey: string,
    rawError: string,
    raw?: unknown,
    taskCode?: string,
  ): Promise<TaskAutoCheckInfo & { healedTool?: boolean }> {
    const combined = `${rawError ?? ''} ${raw ? JSON.stringify(raw).slice(0, 1000) : ''}`;
    const checkedAt = new Date().toISOString();

    // 1. Tự động sửa ngay lỗi lệch danh sách độ phân giải / thời lượng / tỉ lệ khung hình từ nguồn (T-507)
    const paramMismatch = parseUpstreamParamMismatch(combined);
    if (paramMismatch) {
      const healed = await this.healToolParamMismatch(toolKey, paramMismatch, taskCode, combined);
      return {
        checked: true,
        checkedAt,
        kind: 'auto_healed',
        summary: healed.summary,
        healedTool: healed.changed,
      };
    }

    if (/model này hiện không khả dụng|model_not_found|model not found|engine_unavailable|đã ngừng nhận|không còn hỗ trợ model|does not exist/i.test(combined)) {
      let healedTool = false;
      const toolRow = await this.prisma.aiTool.findUnique({ where: { key: toolKey }, select: { enabled: true, options: true } });
      if (toolRow && !isDeletedTool(toolRow.options) && toolRow.enabled) {
        await this.prisma.aiTool.update({ where: { key: toolKey }, data: { enabled: false } });
        healedTool = true;
        this.logger.warn(`[AutoCheck T-417] Đã tự động tắt model ngừng hoạt động phía nguồn: ${toolKey}`);
        void this.sendAutoFixReportToDevBot({
          taskCode,
          toolKey,
          rawError: combined,
          actionCmd: `UPDATE ai_tools SET enabled = false WHERE key = '${toolKey}'`,
          summary: 'Đã tự tắt model không còn khả dụng phía nguồn',
        });
      }
      return {
        checked: true,
        checkedAt,
        kind: 'auto_healed',
        summary: 'Đã tự tắt model không còn khả dụng phía nguồn',
        healedTool,
      };
    }

    if (/còn\s*0\s*credit|bổ sung credit|seedance_credits|không đủ credit|plan_expired|your plan has expired/i.test(combined)) {
      await this.setAutoMaintenance(toolKey, true, 'runtime_failures').catch(() => undefined);
      void this.sendAutoFixReportToDevBot({
        taskCode,
        toolKey,
        rawError: combined,
        actionCmd: `setAutoMaintenance('${toolKey}', true, 'runtime_failures')`,
        summary: 'Nguồn tạm hết credit / gói thuê bao model này — đã tự bật bảo trì tạm thời',
      });
      return {
        checked: true,
        checkedAt,
        kind: 'auto_healed',
        summary: 'Nguồn tạm hết credit / gói thuê bao — đã tự bật bảo trì tạm thời',
        healedTool: true,
      };
    }

    if (
      /omni_v2v_quality_unsupported|\.webp trong adc|không hỗ trợ định dạng ảnh\s*\.webp|maxContentLength size of \d+ exceeded|dung lượng video vượt quá giới hạn 50mb|request body too large \(max 32 mb\)/i.test(combined) ||
      (toolKey.startsWith('fable.grok-video') && /yêu cầu không hợp lệ/i.test(combined))
    ) {
      return {
        checked: true,
        checkedAt,
        kind: 'fixed_code',
        summary: /maxContentLength|50mb|32 mb/i.test(combined)
          ? 'Đã bật tự động nén chuẩn hoá dung lượng ảnh/video đầu vào dưới trần giới hạn của nguồn'
          : 'Đã tự động chuyển đổi định dạng .webp -> .jpg/.png & chuẩn hoá tham số tương thích nguồn',
      };
    }

    if (/chính sách|bộ lọc|từ bị cấm|nhạy cảm|nsfw|safety|moderation|copyright|vi phạm|sensitive/i.test(combined)) {
      return {
        checked: true,
        checkedAt,
        kind: 'upstream_policy',
        summary: 'Bộ lọc nội dung phía nguồn từ chối (không phải lỗi hệ thống)',
      };
    }

    if (/ảnh tải lên|video tham chiếu|độ dài|tối đa|không đọc được kích thước|vượt quá giới hạn|quá hạn lưu trữ|liên kết url ngoại vi.*404/i.test(combined)) {
      return {
        checked: true,
        checkedAt,
        kind: 'input_invalid',
        summary: 'Tệp tham chiếu đầu vào đã hết hạn lưu trữ hoặc vượt giới hạn — đã hoàn tiền đủ',
      };
    }

    // T-502: Kiểm tra xem model này có đang lỗi liên tiếp bất thường trong 30 phút gần nhất không (kể cả lỗi quá tải / 502 / 503 / đang bảo trì)
    const since30m = new Date(Date.now() - 30 * 60_000);
    const [recentFails, recentOk] = await Promise.all([
      this.prisma.aiTask.count({ where: { toolKey, status: 'FAILED', createdAt: { gte: since30m } } }),
      this.prisma.aiTask.count({ where: { toolKey, status: 'SUCCEEDED', createdAt: { gte: since30m } } }),
    ]);
    if (recentFails >= 3 && recentOk === 0) {
      await this.setAutoMaintenance(toolKey, true, 'runtime_failures').catch(() => undefined);
      void this.sendAutoFixReportToDevBot({
        taskCode,
        toolKey,
        rawError: `${recentFails} đơn lỗi liên tiếp / 30p (${rawError.slice(0, 160)})`,
        actionCmd: `setAutoMaintenance('${toolKey}', true, 'runtime_failures') /* ${recentFails} lỗi liên tiếp, 0 thành công / 30p */`,
        summary: 'Model lỗi liên tiếp phía nguồn — đã tự bật bảo trì tạm thời (15p)',
      });
      return {
        checked: true,
        checkedAt,
        kind: 'auto_healed',
        summary: 'Model lỗi liên tiếp phía nguồn — đã tự bật bảo trì tạm thời',
        healedTool: true,
      };
    }

    if (/phản hồi quá lâu|timeout|timed out|quá tải|bị nghẽn|\b502\b|\b503\b|\b504\b|đang bảo trì|tạm đóng/i.test(combined)) {
      return {
        checked: true,
        checkedAt,
        kind: 'upstream_transient',
        summary: 'Nguồn AI nghẽn / phản hồi chậm cục bộ — đã hoàn tiền',
      };
    }

    return {
      checked: true,
      checkedAt,
      kind: 'checked',
      summary: 'Đã kiểm tra tự động & đối soát hoàn tiền',
    };
  }

  /** Cron mỗi 30 giây tự quét liên tục các đơn FAILED mới để tự động sửa cấu hình tham số & khoá model hỏng tức thì (T-417 & T-507) */
  @Cron('25,55 * * * * *')
  async autoCheckFailedTasksCron() {
    if (this.stopping || this.autoCheckingFailed) return;
    await this.runFailedTasksAutoCheck(200).catch(() => undefined);
  }

  async runFailedTasksAutoCheck(limit = 300, user?: AuthUser) {
    if (user && shouldHideAiProviders(user)) return { checkedCount: 0, healedCount: 0, healedTools: [] };
    if (this.autoCheckingFailed) return { checkedCount: 0, healedCount: 0, healedTools: [] };
    this.autoCheckingFailed = true;
    let checkedCount = 0;
    let healedCount = 0;
    try {
      const recheckRecentChecked = Boolean(user);
      const rows = await this.prisma.$queryRawUnsafe<
        { id: string; code: string; toolKey: string; error: string | null; output: unknown; providerData: unknown }[]
      >(
        recheckRecentChecked
          ? `SELECT id, code, "toolKey", error, output, "providerData"
             FROM ai_tasks
             WHERE status = 'FAILED'
               AND (
                 output IS NULL
                 OR (output->'__autoCheck'->>'checked') IS DISTINCT FROM 'true'
                 OR ("createdAt" > NOW() - INTERVAL '24 hours' AND (output->'__autoCheck'->>'kind') = 'checked')
               )
             ORDER BY "createdAt" DESC
             LIMIT $1`
          : `SELECT id, code, "toolKey", error, output, "providerData"
             FROM ai_tasks
             WHERE status = 'FAILED'
               AND (output IS NULL OR (output->'__autoCheck'->>'checked') IS DISTINCT FROM 'true')
             ORDER BY "createdAt" DESC
             LIMIT $1`,
        Math.max(1, Math.min(1000, limit)),
      );
      const healedSet = new Set<string>();
      for (const r of rows) {
        const res = await this.diagnoseAndHealFailure(r.toolKey, r.error ?? '', r.providerData, r.code);
        if (res.healedTool && !healedSet.has(r.toolKey)) {
          healedSet.add(r.toolKey);
          healedCount += 1;
        }
        const { healedTool: _h, ...info } = res;
        const prevOut = r.output && typeof r.output === 'object' ? (r.output as Record<string, unknown>) : {};
        await this.prisma.aiTask.update({
          where: { id: r.id },
          data: { output: { ...prevOut, __autoCheck: info } as object },
        });
        checkedCount += 1;
      }
      // T-429: Quét bổ sung các đơn FAILED / CANCELLED có mã NCC (đặc biệt maivideo) trong 24h gần nhất chưa có biên bản huỷ nguồn -> gọi huỷ / đối soát trạng thái nguồn ngay
      const uncancelled = await this.prisma.$queryRawUnsafe<
        { id: string; code: string; provider: string; toolKey: string; userId: string; providerTaskId: string; output: unknown; providerData: unknown }[]
      >(
        `SELECT id, code, provider, "toolKey", "userId", "providerTaskId", output, "providerData"
         FROM ai_tasks
         WHERE status IN ('FAILED', 'CANCELLED')
           AND "providerTaskId" IS NOT NULL
           AND "createdAt" > NOW() - INTERVAL '24 hours'
           AND (output IS NULL OR output->'__upstreamCancel' IS NULL)
           AND (status = 'CANCELLED' OR provider = 'maivideo' OR error ILIKE '%quá lâu%')
         ORDER BY "createdAt" DESC
         LIMIT 40`,
      );
      for (const u of uncancelled) {
        await this.cancelUpstreamForTask(u, 'retro_sync').catch(() => undefined);
      }
      return { checkedCount, healedCount, healedTools: [...healedSet] };
    } finally {
      this.autoCheckingFailed = false;
    }
  }

  /**
   * T-427 & T-429: Gọi sang API nguồn để huỷ đơn ngay khi hoàn tiền / quá hạn và ghi chú rõ phản hồi của API nguồn lên task.
   */
  private async cancelUpstreamForTask(
    t: { id: string; code: string; provider: string; toolKey: string; userId: string; providerTaskId: string | null; output?: unknown; providerData?: unknown },
    trigger: TaskUpstreamCancelInfo['trigger'],
  ): Promise<TaskUpstreamCancelInfo | null> {
    const pid = (t.providerTaskId ?? '').trim();
    if (!pid) return null;
    const r = this.resolve(t.toolKey);
    const provider = r?.provider ?? this.providers.get(t.provider);
    const ctx = await this.ctx(t.provider, t.userId);
    const res = await Promise.race([
      cancelTaskUpstream(t.provider, r?.def, pid, ctx, provider),
      new Promise<{ ok: false; upstreamStatus: string; note: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, upstreamStatus: 'timeout', note: 'Quá 10s chờ API nguồn phản hồi lệnh huỷ' }), 10_000),
      ),
    ]);
    const info: TaskUpstreamCancelInfo = {
      attemptedAt: new Date().toISOString(),
      trigger,
      ok: res.ok,
      ...('httpStatus' in res && res.httpStatus ? { httpStatus: res.httpStatus } : {}),
      ...(res.upstreamStatus ? { upstreamStatus: res.upstreamStatus } : {}),
      note: res.note,
    };
    const latest = await this.prisma.aiTask.findUnique({ where: { id: t.id }, select: { output: true, providerData: true } });
    if (latest) {
      const prevOut = latest.output && typeof latest.output === 'object' ? (latest.output as Record<string, unknown>) : {};
      const prevPd = latest.providerData && typeof latest.providerData === 'object' ? (latest.providerData as Record<string, unknown>) : {};
      await this.prisma.aiTask.update({
        where: { id: t.id },
        data: {
          output: { ...prevOut, __upstreamCancel: info } as object,
          providerData: { ...prevPd, upstreamCancel: { ...info, ...('raw' in res && res.raw ? { raw: res.raw } : {}) } } as object,
        },
      });
    }
    return info;
  }

  /**
   * T-428: Cron tự động mỗi 2 phút quét trực tiếp trạng thái chuẩn trên nguồn của toàn bộ các đơn `Đang xử lý > 30p`,
   * cập nhật ngay nếu đã xong / lỗi và lưu mốc giờ `checkedAt` + `updatedAt` lên từng đơn.
   */
  @Cron('20 */2 * * * *')
  async autoScanStuckTasksCron() {
    if (this.stopping || this.scanningStuck) return;
    await this.runStuckTasksLiveScan().catch(() => undefined);
  }

  async runStuckTasksLiveScan(user?: AuthUser) {
    if (user && shouldHideAiProviders(user)) return { scannedCount: 0, resolvedCount: 0 };
    if (this.scanningStuck) return { scannedCount: 0, resolvedCount: 0 };
    this.scanningStuck = true;
    let scannedCount = 0;
    let resolvedCount = 0;
    try {
      const stuckCutoff = new Date(Date.now() - 30 * 60_000);
      const tasks = await this.prisma.aiTask.findMany({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lte: stuckCutoff },
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      });
      for (const t of tasks) {
        if (this.stopping) break;
        scannedCount += 1;
        const nowIso = new Date().toISOString();
        const prevOut = t.output && typeof t.output === 'object' ? (t.output as Record<string, unknown>) : {};
        const prevStuck = extractTaskStuckCheck(prevOut);

        const r = this.resolve(t.toolKey);
        if (!r) {
          await this.fail(t, 'Công cụ không còn khả dụng, tiền đã được hoàn lại vào ví');
          resolvedCount += 1;
          continue;
        }
        if (t.status === 'PENDING' || !t.providerTaskId || !r.provider.poll) {
          const checkInfo: TaskStuckCheckInfo = {
            checkedAt: nowIso,
            updatedAt: prevStuck?.updatedAt || t.startedAt?.toISOString() || t.createdAt.toISOString(),
            upstreamStatus: t.status === 'PENDING' ? 'waiting_queue' : 'no_task_id',
            checkCount: (prevStuck?.checkCount ?? 0) + 1,
            summary: t.status === 'PENDING' ? 'Đang xếp hàng chờ luồng nguồn' : 'Chưa có mã job nguồn',
          };
          await this.prisma.aiTask.update({
            where: { id: t.id },
            data: { output: { ...prevOut, __stuckCheck: checkInfo } as object },
          });
          continue;
        }

        const ctx = await this.ctx(r.provider.key, t.userId);
        try {
          const live = await Promise.race([
            r.provider.poll(r.def, t.providerTaskId, ctx),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
          ]);
          if (!live) {
            const checkInfo: TaskStuckCheckInfo = {
              checkedAt: nowIso,
              updatedAt: prevStuck?.updatedAt || nowIso,
              upstreamStatus: 'poll_timeout',
              progress: t.progress,
              checkCount: (prevStuck?.checkCount ?? 0) + 1,
              summary: 'Nguồn phản hồi chậm (>15s)',
            };
            await this.prisma.aiTask.update({
              where: { id: t.id },
              data: { output: { ...prevOut, __stuckCheck: checkInfo } as object },
            });
            continue;
          }
          if (live.status === 'succeeded' || live.status === 'failed') {
            await this.applyResult(t, live);
            resolvedCount += 1;
            continue;
          }
          const rawSt =
            live.raw && typeof live.raw === 'object' && typeof (live.raw as Record<string, unknown>).status === 'string'
              ? String((live.raw as Record<string, unknown>).status)
              : 'processing';
          const changed = !prevStuck || prevStuck.upstreamStatus !== rawSt || (live.progress !== undefined && prevStuck.progress !== live.progress);
          const checkInfo: TaskStuckCheckInfo = {
            checkedAt: nowIso,
            updatedAt: changed ? nowIso : prevStuck.updatedAt,
            upstreamStatus: rawSt,
            progress: live.progress ?? t.progress,
            checkCount: (prevStuck?.checkCount ?? 0) + 1,
            summary: `Nguồn báo: ${rawSt}${live.progress ? ` (${live.progress}%)` : ''}`,
          };
          const fresh = await this.prisma.aiTask.findUnique({ where: { id: t.id }, select: { status: true, output: true } });
          if (fresh && (fresh.status === 'PROCESSING' || fresh.status === 'PENDING')) {
            const freshOut = fresh.output && typeof fresh.output === 'object' ? (fresh.output as Record<string, unknown>) : {};
            await this.prisma.aiTask.update({
              where: { id: t.id },
              data: {
                output: { ...freshOut, __stuckCheck: checkInfo, __lastPolledAt: nowIso } as object,
                providerData: (live.raw ?? t.providerData ?? null) as object,
              },
            });
          }
        } catch (err) {
          const e = err as AiProviderError;
          if (e instanceof AiProviderError && !e.retryable) {
            await this.fail(t, e.message, e.raw);
            resolvedCount += 1;
          } else {
            const checkInfo: TaskStuckCheckInfo = {
              checkedAt: nowIso,
              updatedAt: prevStuck?.updatedAt || nowIso,
              upstreamStatus: 'error_retry',
              progress: t.progress,
              checkCount: (prevStuck?.checkCount ?? 0) + 1,
              summary: `Lỗi mạng tạm thời khi hỏi nguồn`,
            };
            await this.prisma.aiTask.update({
              where: { id: t.id },
              data: { output: { ...prevOut, __stuckCheck: checkInfo } as object },
            });
          }
        }
      }
      return { scannedCount, resolvedCount };
    } finally {
      this.scanningStuck = false;
    }
  }

  private probingRefundedUpstream = false;

  /**
   * T-495: Định kỳ mỗi 30 giây tự động hỏi lại API nguồn đối với các đơn `Đã hoàn tiền` / `Đã huỷ` gần đây (4 giờ qua)
   * mà lúc huỷ bên nguồn vẫn còn `processing` / chưa rõ trạng thái, để cột "Trạng thái nguồn" luôn cập nhật realtime.
   */
  @Cron('12,42 * * * * *')
  async autoProbeRefundedUpstreamCron() {
    if (
      this.stopping ||
      this.probingRefundedUpstream ||
      process.env.DISABLE_SCHEDULER === '1' ||
      process.env.DISABLE_SCHEDULER === 'true' ||
      isChildSite()
    ) {
      return;
    }
    this.probingRefundedUpstream = true;
    try {
      const since = new Date(Date.now() - 4 * 3600_000);
      const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM ai_tasks
        WHERE status IN ('FAILED', 'CANCELLED')
          AND "providerTaskId" IS NOT NULL
          AND "createdAt" >= ${since}
          AND (
            output->'__upstreamLive' IS NULL
            OR (output->'__upstreamLive'->>'state') IN ('processing', 'queued', 'unknown')
          )
          AND (
            status = 'CANCELLED'
            OR error LIKE '%quá lâu%'
            OR (output->'__upstreamCancel'->>'upstreamStatus') IN ('processing', 'pending', 'queued', 'timeout')
            OR (output->'__upstreamLive'->>'state') IN ('processing', 'queued')
          )
        ORDER BY "createdAt" DESC
        LIMIT 12`;
      if (candidates.length) {
        await this.probeTasksUpstreamInternal(
          candidates.map((c) => c.id),
          false,
        );
      }
    } catch {
      /* bỏ qua lỗi mạng tạm */
    } finally {
      this.probingRefundedUpstream = false;
    }
  }

  /** Hỏi trực tiếp trạng thái bên API nguồn theo danh sách task ID cho trang Admin `/admin/ai/tasks` (T-495) */
  async probeTasksUpstreamLive(ids: string[], user: AuthUser, force = false) {
    if (shouldHideAiProviders(user)) return { items: {} as Record<string, TaskUpstreamLiveStatus> };
    return this.probeTasksUpstreamInternal(ids, force);
  }

  private async probeTasksUpstreamInternal(ids: string[], force = false) {
    const cleanIds = [...new Set((ids ?? []).map((x) => String(x).trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 30);
    const items: Record<string, TaskUpstreamLiveStatus> = {};
    if (!cleanIds.length) return { items };

    const tasks = await this.prisma.aiTask.findMany({
      where: { id: { in: cleanIds } },
    });
    const queue = [...tasks];
    const worker = async () => {
      for (let t = queue.shift(); t && !this.stopping; t = queue.shift()) {
        const nowIso = new Date().toISOString();
        const attachRefund = (base: TaskUpstreamLiveStatus, raw?: unknown, errMsg?: string | null): TaskUpstreamLiveStatus => {
          const inf = inferUpstreamRefund(t.provider, base.state, raw, errMsg ?? base.message);
          return { ...base, refundState: inf.refundState, refundNote: inf.refundNote };
        };
        if (!t.providerTaskId) {
          items[t.id] =
            t.status === 'PENDING'
              ? attachRefund({ state: 'queued', message: 'Đang chờ gửi sang nguồn', checkedAt: nowIso })
              : attachRefund({ state: 'no_task_id', message: 'Chưa tạo đơn trên nguồn', checkedAt: nowIso });
          continue;
        }

        const prevLive = extractStoredUpstreamLive(t.output, t.provider);
        if (!force && prevLive) {
          if (
            prevLive.state === 'succeeded' ||
            prevLive.state === 'failed' ||
            prevLive.state === 'cancelled' ||
            prevLive.state === 'not_supported'
          ) {
            items[t.id] = prevLive;
            continue;
          }
          const ageMs = Date.now() - (Date.parse(prevLive.checkedAt) || 0);
          if (ageMs >= 0 && ageMs < 6_000) {
            items[t.id] = prevLive;
            continue;
          }
        }

        const r = this.resolve(t.toolKey);
        if (!r || !r.provider.poll) {
          const info = attachRefund({
            state: 'not_supported',
            message: 'Nguồn chạy đồng bộ (không lưu job)',
            checkedAt: nowIso,
          });
          items[t.id] = info;
          await this.saveUpstreamLiveStatus(t.id, info);
          continue;
        }

        try {
          const ctx = await this.ctx(r.provider.key, t.userId);
          const live = await Promise.race([
            r.provider.poll(r.def, t.providerTaskId, ctx),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
          ]);
          if (!live) {
            const fallback = extractTaskUpstreamLive(t);
            const info = attachRefund({
              state: fallback.state === 'no_task_id' ? 'unknown' : fallback.state,
              rawStatus: fallback.rawStatus || 'poll_timeout',
              progress: fallback.progress ?? (t.progress > 0 ? t.progress : undefined),
              message: 'Nguồn phản hồi chậm (>10s)',
              checkedAt: nowIso,
            });
            items[t.id] = info;
            await this.saveUpstreamLiveStatus(t.id, info);
            continue;
          }

          const rawSt = extractRawStatusFromObj(live.raw);
          if (live.status === 'succeeded') {
            if (t.status === 'PROCESSING' || t.status === 'PENDING') {
              await this.applyResult(t, live).catch(() => undefined);
            }
            const info = attachRefund(
              {
                state: 'succeeded',
                rawStatus: rawSt || 'succeeded',
                progress: 100,
                resultUrl: live.files?.[0]?.url,
                message: 'Đã tạo xong trên nguồn',
                checkedAt: nowIso,
              },
              live.raw,
            );
            items[t.id] = info;
            await this.saveUpstreamLiveStatus(t.id, info);
            continue;
          }

          if (live.status === 'failed') {
            if (t.status === 'PROCESSING' || t.status === 'PENDING') {
              await this.applyResult(t, live).catch(() => undefined);
            }
            const errTxt = String(live.error ?? rawSt ?? '');
            const isCancel = /cancel|abort|huỷ|hủy|stopped/i.test(errTxt);
            const info = attachRefund(
              {
                state: isCancel ? 'cancelled' : 'failed',
                rawStatus: rawSt || (isCancel ? 'cancelled' : 'failed'),
                message: (live.error || (isCancel ? 'Đã huỷ trên nguồn' : 'Đã dừng / lỗi trên nguồn')).slice(0, 140),
                checkedAt: nowIso,
              },
              live.raw,
              live.error,
            );
            items[t.id] = info;
            await this.saveUpstreamLiveStatus(t.id, info);
            continue;
          }

          const isQueued = rawSt ? /^(pending|queued|waiting|submitted|init)/i.test(rawSt) : false;
          const pct = live.progress ?? (t.progress > 0 ? t.progress : undefined);
          const info = attachRefund(
            {
              state: isQueued ? 'queued' : 'processing',
              rawStatus: rawSt || 'processing',
              progress: pct,
              message: isQueued ? 'Đang chờ luồng trên nguồn' : `Đang chạy trên nguồn${pct ? ` (${pct}%)` : ''}`,
              checkedAt: nowIso,
            },
            live.raw,
          );
          items[t.id] = info;
          await this.saveUpstreamLiveStatus(t.id, info);
        } catch (err) {
          const e = err as AiProviderError;
          if (e instanceof AiProviderError && !e.retryable) {
            if (t.status === 'PROCESSING' || t.status === 'PENDING') {
              await this.fail(t, e.message, e.raw).catch(() => undefined);
            }
            const isCancel = /cancel|abort|huỷ|hủy|not found|404|không tồn tại|expired/i.test(e.message);
            const info = attachRefund(
              {
                state: isCancel ? 'cancelled' : 'failed',
                rawStatus: extractRawStatusFromObj(e.raw) || (isCancel ? 'cancelled' : 'failed'),
                message: e.message.slice(0, 140),
                checkedAt: nowIso,
              },
              e.raw,
              e.message,
            );
            items[t.id] = info;
            await this.saveUpstreamLiveStatus(t.id, info);
          } else {
            const fallback = extractTaskUpstreamLive(t);
            const info = attachRefund({
              state: fallback.state === 'no_task_id' ? 'unknown' : fallback.state,
              rawStatus: fallback.rawStatus,
              progress: fallback.progress,
              message: 'Lỗi kết nối nguồn tạm thời, sẽ hỏi lại',
              checkedAt: nowIso,
            });
            items[t.id] = info;
            await this.saveUpstreamLiveStatus(t.id, info);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return { items };
  }

  private async saveUpstreamLiveStatus(taskId: string, info: TaskUpstreamLiveStatus) {
    const fresh = await this.prisma.aiTask.findUnique({ where: { id: taskId }, select: { output: true } });
    if (!fresh) return;
    const freshOut = fresh.output && typeof fresh.output === 'object' ? (fresh.output as Record<string, unknown>) : {};
    await this.prisma.aiTask.update({
      where: { id: taskId },
      data: { output: { ...freshOut, __upstreamLive: info } as object },
    });
  }

  /**
   * T-501: Nút "Hoàn bên nguồn" trên `/admin/ai/tasks` — gửi trực tiếp lệnh huỷ/hoàn sang API nguồn
   * và hỏi lại ngay trạng thái live trên nguồn, giữ nguyên trạng thái đơn trên web để Admin xem kết quả phản hồi của nguồn rồi mới quyết định hoàn khách.
   */
  async adminCancelUpstreamOnly(id: string, actor: AuthUser) {
    if (shouldHideAiProviders(actor)) {
      throw new ForbiddenException('Chỉ quản trị viên website chính mới được thao tác trực tiếp với API nguồn');
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new BadRequestException('Đơn này thuộc web con — vui lòng thao tác trên đơn gốc của hệ thống chính');
    }
    const t = await this.prisma.aiTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    if (!t.providerTaskId) {
      const upstreamCancel: TaskUpstreamCancelInfo = {
        attemptedAt: new Date().toISOString(),
        trigger: 'admin',
        ok: true,
        upstreamStatus: 'not_submitted',
        note: 'Đơn chưa gửi sang nguồn (chưa phát sinh mã job bên NCC — không tốn phí nguồn)',
      };
      return {
        upstreamCancel,
        upstreamLive: extractTaskUpstreamLive(t),
      };
    }

    const upstreamCancel = await this.cancelUpstreamForTask(t, 'admin');
    const probed = await this.probeTasksUpstreamInternal([t.id], true);
    const refreshed = await this.prisma.aiTask.findUnique({ where: { id: t.id } });
    return {
      upstreamCancel: upstreamCancel ?? (refreshed ? extractTaskUpstreamCancel(refreshed.output) : null),
      upstreamLive: probed.items[t.id] ?? (refreshed ? extractTaskUpstreamLive(refreshed) : null),
      taskStatus: refreshed?.status ?? t.status,
    };
  }

  private async setAutoMaintenance(
    toolKey: string,
    active: boolean,
    source: 'upstream_api' | 'runtime_failures' = 'upstream_api',
  ) {
    const row = await this.prisma.aiTool.findUnique({ where: { key: toolKey }, select: { options: true } });
    if (!row || isDeletedTool(row.options)) return;
    const opts = { ...((row.options ?? {}) as Record<string, unknown>) };
    if (active) {
      if (opts.autoMaintenance === true && opts.autoMaintSource === source) return;
      opts.autoMaintenance = true;
      opts.autoMaintainedAt = Date.now();
      opts.autoMaintSource = source;
    } else {
      if (opts.autoMaintenance !== true) return;
      delete opts.autoMaintenance;
      delete opts.autoMaintainedAt;
      delete opts.autoMaintSource;
    }
    await this.prisma.aiTool.update({ where: { key: toolKey }, data: { options: opts as object } });
  }

  /**
   * T-358, T-487 & T-502: Cron liên tục mỗi 30 giây tự động quét tất cả model của mọi website nguồn realtime:
   * 1. Quét trực tiếp API danh mục / trạng thái model (`maintenanceCheck`) của tất cả các nguồn đang bật:
   *    - Model nào bị tắt / gỡ / đang bảo trì trên nguồn (hoặc toàn nguồn 502/503 liên tiếp >= 3 nhịp) -> tự bật `autoMaintenance = true` ngay lập tức.
   *    - Khi nguồn mở lại -> tự gỡ `autoMaintenance` để mở tạo lại tức thì.
   * 2. Quét sức khoẻ thực thi realtime (`runtime_failures`): nếu một model đang bật nhưng 3 đơn liên tiếp gần nhất (trong 30 phút)
   *    đều lỗi từ phía nguồn (quá tải GPU, hết tài nguyên, lỗi engine — bỏ qua lỗi chính sách/file đầu vào của khách) và chưa có đơn nào thành công sau đó
   *    -> tự bật `autoMaintenance = true` với thời gian làm mát 15 phút để bảo vệ khách ngay cả khi API `/models` của nguồn chưa kịp báo bảo trì.
   * 3. Đẩy tức thì (`<100ms`) danh sách bảo trì sang toàn bộ Website con qua loopback nội bộ, tuyệt đối không ghi đè `options.maintenance` do Admin gạt tay.
   */
  @Cron('*/30 * * * * *')
  async syncUpstreamMaintenance() {
    if (
      this.syncingMaint ||
      this.stopping ||
      isChildSite() ||
      process.env.DISABLE_SCHEDULER === '1' ||
      process.env.DISABLE_SCHEDULER === 'true'
    ) {
      return;
    }
    this.syncingMaint = true;
    try {
      const nowMs = Date.now();
      const RUNTIME_COOLDOWN_MS = 15 * 60_000;

      // 1) Tìm các model đang lỗi thực tế liên tiếp (>= 3 đơn lỗi nguồn liên tiếp trong 30 phút gần nhất, 0 đơn thành công xen kẽ)
      const since30m = new Date(nowMs - 30 * 60_000);
      const brokenByTasks = await this.prisma.$queryRaw<{ toolKey: string }[]>`
        WITH recent AS (
          SELECT
            "toolKey",
            status,
            COALESCE(error, '') AS err,
            ROW_NUMBER() OVER (PARTITION BY "toolKey" ORDER BY "createdAt" DESC) AS rn
          FROM ai_tasks
          WHERE "createdAt" >= ${since30m}
            AND status IN ('SUCCEEDED', 'FAILED')
        )
        SELECT "toolKey"
        FROM recent
        WHERE rn <= 3
        GROUP BY "toolKey"
        HAVING COUNT(*) = 3
          AND COUNT(*) FILTER (
            WHERE status = 'FAILED'
              AND err !~* '(chính sách|bộ lọc|từ bị cấm|nhạy cảm|nsfw|safety|moderation|copyright|vi phạm|sensitive|quá hạn lưu trữ|vượt quá giới hạn|tải lên ít nhất|không đọc được kích thước)'
          ) = 3`;
      const runtimeBrokenKeys = new Set(brokenByTasks.map((x) => x.toolKey));

      const rows = await this.prisma.aiTool.findMany({
        select: { key: true, provider: true, enabled: true, options: true },
      });
      const byProvider = new Map<string, typeof rows>();
      for (const r of rows) {
        if (isDeletedTool(r.options)) continue;
        const arr = byProvider.get(r.provider) ?? [];
        arr.push(r);
        byProvider.set(r.provider, arr);
      }

      await Promise.allSettled(
        [...byProvider.entries()].map(async ([pKey, pRows]) => {
          if (this.stopping) return;
          const provider = this.providers.get(pKey);
          if (!provider) return;
          const cfg = await this.providerConfig(pKey);
          if (!cfg.enabled || !cfg.apiKey) return;

          if (provider.maintenanceCheck) {
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000));
            const down = await Promise.race([
              provider.maintenanceCheck(await this.ctx(pKey)).catch(() => null),
              timeout,
            ]);
            let effectiveDown: Set<string> | 'ALL' | null = down;
            if (down === null) {
              const streak = (this.providerUnreachableStreaks.get(pKey) ?? 0) + 1;
              this.providerUnreachableStreaks.set(pKey, streak);
              if (streak >= 3) {
                effectiveDown = 'ALL';
              }
            } else {
              this.providerUnreachableStreaks.delete(pKey);
            }

            for (const r of pRows) {
              const opts = (r.options ?? {}) as Record<string, unknown>;
              if (runtimeBrokenKeys.has(r.key) && r.enabled) {
                if (opts.autoMaintenance !== true || opts.autoMaintSource !== 'runtime_failures') {
                  await this.setAutoMaintenance(r.key, true, 'runtime_failures');
                  this.logger.warn(`[AutoMaint T-502] Tự động BẬT bảo trì do 3 đơn lỗi nguồn liên tiếp: ${r.key}`);
                }
                continue;
              }

              if (effectiveDown === null) continue;
              const localKey = r.key.slice(pKey.length + 1);
              const baseKey = localKey.split(MODEL_SEP)[0];
              const shouldMaint = effectiveDown === 'ALL' || effectiveDown.has(localKey) || effectiveDown.has(baseKey);
              if (shouldMaint && opts.autoMaintenance !== true) {
                await this.setAutoMaintenance(r.key, true, 'upstream_api');
                this.logger.log(`[AutoMaint T-502] Tự động BẬT bảo trì theo nguồn: ${r.key}`);
              } else if (!shouldMaint && opts.autoMaintenance === true) {
                if (
                  opts.autoMaintSource === 'runtime_failures' &&
                  nowMs - Number(opts.autoMaintainedAt || 0) < RUNTIME_COOLDOWN_MS
                ) {
                  continue;
                }
                await this.setAutoMaintenance(r.key, false);
                this.consecutiveMaintErrors.delete(r.key);
                this.logger.log(`[AutoMaint T-502] Tự động TẮT bảo trì (nguồn đã mở lại): ${r.key}`);
              }
            }
          } else {
            for (const r of pRows) {
              const opts = (r.options ?? {}) as Record<string, unknown>;
              if (runtimeBrokenKeys.has(r.key) && r.enabled && opts.autoMaintenance !== true) {
                await this.setAutoMaintenance(r.key, true, 'runtime_failures');
                this.logger.warn(`[AutoMaint T-502] Tự động BẬT bảo trì do 3 đơn lỗi nguồn liên tiếp: ${r.key}`);
              }
            }
            const autoRows = pRows.filter((r) => ((r.options ?? {}) as Record<string, unknown>).autoMaintenance === true);
            if (!autoRows.length) return;
            const readyRows = autoRows.filter((r) => {
              if (runtimeBrokenKeys.has(r.key)) return false;
              const opts = (r.options ?? {}) as Record<string, unknown>;
              const waitMs = opts.autoMaintSource === 'runtime_failures' ? RUNTIME_COOLDOWN_MS : 5 * 60_000;
              return nowMs - Number(opts.autoMaintainedAt || 0) >= waitMs;
            });
            if (!readyRows.length) return;
            let healthy = true;
            if (provider.catalog) {
              const cat = await provider.catalog(await this.ctx(pKey)).catch(() => null);
              healthy = Array.isArray(cat) && cat.length > 0;
            } else if (provider.balance) {
              const bal = await provider.balance(await this.ctx(pKey)).catch(() => null);
              healthy = bal !== null && bal.balance >= 0;
            }
            if (healthy) {
              for (const r of readyRows) {
                await this.setAutoMaintenance(r.key, false);
                this.consecutiveMaintErrors.delete(r.key);
                this.logger.log(`[AutoMaint T-502] Tự động TẮT bảo trì sau khi nguồn ổn định: ${r.key}`);
              }
            }
          }
        }),
      );

      // Đồng bộ tức thì danh sách autoMaintenance & healedFieldOptions sang tất cả Website con nếu có thay đổi
      const afterRows = await this.prisma.aiTool.findMany({ select: { key: true, options: true } });
      const activeAutoKeys = afterRows
        .filter((r) => !isDeletedTool(r.options) && ((r.options ?? {}) as Record<string, unknown>).autoMaintenance === true)
        .map((r) => r.key)
        .sort();
      const healedFields: Record<string, Record<string, string[]>> = {};
      for (const r of afterRows) {
        if (isDeletedTool(r.options)) continue;
        const h = ((r.options ?? {}) as Record<string, unknown>).healedFieldOptions;
        if (h && typeof h === 'object') healedFields[r.key] = h as Record<string, string[]>;
      }
      const nextHash = `${activeAutoKeys.join('|')}::${JSON.stringify(healedFields)}`;
      if (nextHash !== this.lastPushedMaintHash) {
        this.lastPushedMaintHash = nextHash;
        const children = await this.discoverChildSitesForTasks().catch(() => []);
        await Promise.allSettled(
          children.map((child) =>
            fetch(`${child.apiBase}/api/internal/hub-profit/sync-maint`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-server-secret': child.serverSecret },
              body: JSON.stringify({ maintKeys: activeAutoKeys, healedFields }),
              signal: AbortSignal.timeout(5_000),
            }),
          ),
        );
      }
    } catch (err) {
      this.logger.warn(`Đồng bộ bảo trì nguồn lỗi: ${(err as Error).message}`);
    } finally {
      this.syncingMaint = false;
    }
  }

  /**
   * Cron mỗi 5 giây: gửi lại tác vụ PENDING lỗi tạm thời, hỏi trạng thái tác vụ PROCESSING, huỷ tác vụ quá hạn (tối đa 45 phút).
   * Đồng thời quét cả tác vụ mồ côi (`nextPollAt = null` quá 5 phút do khởi động lại máy chủ lúc gửi đồng bộ).
   */
  @Cron('*/5 * * * * *')
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const s = await this.settings.get<AiSettings>('ai');
      const timeout = Math.min(10_080, Math.max(5, Number(s.timeoutMinutes) || 45)) * 60_000;
      const now = new Date();
      const orphanCutoff = new Date(Date.now() - 5 * 60_000);
      // Fable PENDING xử lý riêng qua drainFableQueue tuần tự theo createdAt ASC để không nhảy cóc thứ tự
      void this.drainFableQueue(false).catch((err) => this.logger.warn(`Hàng đợi Fable lỗi: ${(err as Error).message}`));
      const due = await this.prisma.aiTask.findMany({
        where: {
          OR: [
            { status: 'PROCESSING', nextPollAt: { lte: now } },
            { status: 'PROCESSING', nextPollAt: null, createdAt: { lte: orphanCutoff } },
            { status: 'PENDING', provider: { not: 'fable' }, nextPollAt: { lte: now } },
            { status: 'PENDING', provider: { not: 'fable' }, nextPollAt: null, createdAt: { lte: orphanCutoff } },
          ],
        },
        // Bắt buộc xếp theo nextPollAt ASC (xoay vòng công bằng) để các job chạy lâu (vd Motion Control 10 phút) không chiếm hết lượt poll của các job nhanh
        orderBy: [{ nextPollAt: 'asc' }, { createdAt: 'asc' }],
        take: BATCH,
      });
      const queue = [...due];
      const worker = async () => {
        for (let task = queue.shift(); task && !this.stopping; task = queue.shift()) {
          // giành tác vụ: dời nextPollAt ra xa trong lúc xử lý
          const claimed = await this.prisma.aiTask.updateMany({ where: { id: task.id, nextPollAt: task.nextPollAt }, data: { nextPollAt: new Date(Date.now() + SUBMIT_HOLD_MS) } });
          if (!claimed.count) continue;
          const t = task;
          await this.process(t, timeout).catch((err) => this.logger.warn(`Xử lý tác vụ ${t.code} lỗi: ${(err as Error).message}`));
        }
      };
      await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));
    } finally {
      this.ticking = false;
    }
  }

  private async process(task: AiTask, timeout: number) {
    // Fable (thuê theo luồng không giới hạn lượt): 99% video xong trong 1.5–4 phút; nếu treo in_progress > 7 phút thì càng hỏi trạng thái Fable càng giữ cứng luồng (không hỏi 5p mới nhả luồng).
    // Tự bỏ job treo sau 7 phút -> tự gửi lại 1 lần miễn phí cho khách; nếu lần 2 vẫn treo > 8 phút thì tự huỷ & hoàn tiền ngay để nhả luồng.
    if (task.provider === 'fable' && task.status === 'PROCESSING') {
      const fableProcessingMs = Date.now() - (task.startedAt ?? task.createdAt).getTime();
      const prevOut = task.output && typeof task.output === 'object' ? (task.output as Record<string, unknown>) : {};
      const alreadyRetried = prevOut.__fableRetried === true;
      if (!alreadyRetried && fableProcessingMs > 7 * 60_000) {
        const requeued = await this.prisma.aiTask.updateMany({
          where: { id: task.id, status: 'PROCESSING' },
          data: {
            status: 'PENDING',
            providerTaskId: null,
            startedAt: null,
            pollCount: 0,
            progress: Math.min(task.progress, 15),
            nextPollAt: new Date(),
            output: { ...prevOut, __fableRetried: true, __abandonedProviderTaskId: task.providerTaskId ?? null } as object,
            providerData: { note: 'Auto-requeued after 7m upstream stall to release Fable slot', prevTaskId: task.providerTaskId ?? null } as object,
          },
        });
        if (requeued.count) {
          this.logger.warn(`Fable tác vụ ${task.code} treo > 7p (${task.providerTaskId}) -> ngừng hỏi để nhả luồng & tự xếp hàng chạy lại 1 lần`);
          void this.drainFableQueue(false).catch(() => undefined);
        }
        return;
      }
      if (alreadyRetried && fableProcessingMs > 8 * 60_000) {
        await this.fail(task, 'Tác vụ xử lý quá lâu nên đã tự động huỷ, tiền đã được hoàn lại vào ví');
        void this.cancelUpstreamForTask(task, 'timeout').catch(() => undefined);
        return;
      }
    }
    // Up4K xử lý video 4K Pro / Max hoặc video dài có cam kết SLA tới 120 phút và không cho huỷ khi đang render
    const effectiveTimeout = task.provider === 'up4k' ? Math.max(timeout, 120 * 60_000) : timeout;
    if (Date.now() - task.createdAt.getTime() > effectiveTimeout) {
      // T-428 & T-429: Trước khi huỷ quá hạn, kiểm tra trạng thái chuẩn bên nguồn lần cuối (nếu nguồn vừa xong thì giao file luôn không mất doanh thu; nếu vẫn treo thì gọi API huỷ nguồn ngay)
      const rTimeout = this.resolve(task.toolKey);
      if (task.status === 'PROCESSING' && task.providerTaskId && rTimeout?.provider.poll) {
        try {
          const ctxTimeout = await this.ctx(rTimeout.provider.key, task.userId);
          const finalPoll = await Promise.race([
            rTimeout.provider.poll(rTimeout.def, task.providerTaskId, ctxTimeout),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
          ]);
          if (finalPoll?.status === 'succeeded') {
            return this.applyResult(task, finalPoll);
          }
        } catch {
          /* tiếp tục huỷ hoàn tiền bên dưới */
        }
      }
      await this.fail(task, 'Tác vụ xử lý quá lâu nên đã được huỷ, tiền đã được hoàn lại vào ví');
      void this.cancelUpstreamForTask(task, 'timeout').catch(() => undefined);
      return;
    }
    const r = this.resolve(task.toolKey);
    if (!r) return this.fail(task, 'Công cụ không còn khả dụng, tiền đã được hoàn lại vào ví');
    const ctx = await this.ctx(r.provider.key, task.userId);
    if (task.status === 'PENDING') return this.submit(task, r.provider, r.def, ctx);
    // đang xử lý mà không có mã tác vụ phía nhà cung cấp: không gửi lại (tránh tạo job trùng), đánh lỗi + hoàn credits
    if (!task.providerTaskId) return this.fail(task, 'Tác vụ bị gián đoạn khi khởi tạo xử lý nên đã được huỷ, tiền đã được hoàn lại vào ví');
    if (!r.provider.poll) return;
    try {
      await this.applyResult(task, await r.provider.poll(r.def, task.providerTaskId, ctx));
    } catch (err) {
      const e = err as AiProviderError;
      if (e instanceof AiProviderError && !e.retryable) return this.fail(task, e.message, e.raw);
      // lỗi tạm thời: hỏi lại sau
      await this.prisma.aiTask.update({ where: { id: task.id }, data: { nextPollAt: new Date(Date.now() + 30_000), pollCount: { increment: 1 } } });
    }
  }

  // ---------------- khách xem tác vụ ----------------

  /** Khoá ký link tải hộ kết quả (dùng chung secret JWT, không lưu thêm cấu hình) */
  private readonly outputSecret = process.env.JWT_ACCESS_SECRET ?? 'dev-secret';
  /** Địa chỉ công khai của API — link proxy kết quả phải tuyệt đối vì website khách chạy ở domain / cổng khác */
  private readonly apiPublicUrl = (process.env.API_PUBLIC_URL ?? 'http://localhost:4317').replace(/\/$/, '');

  /** Chữ ký của link proxy file thứ `index` trong kết quả tác vụ */
  private outputSig(taskId: string, index: number) {
    return createHmac('sha256', this.outputSecret).update(`ai-output:${taskId}:${index}`).digest('base64url').slice(0, 22);
  }

  /**
   * Kết quả tác vụ trình bày cho khách: bỏ `sourceUrl` (link gốc ở nhà cung cấp); file chưa sao lưu được về storage
   * (tắt sao lưu, file quá lớn, tải lỗi) thì thay link nhà cung cấp bằng link proxy có ký của chính API.
   */
  publicOutput(taskId: string, raw: unknown): { files: { url: string; type: unknown; name?: unknown }[]; text?: string } {
    const output = (raw ?? {}) as { files?: { url?: unknown; sourceUrl?: unknown; type?: unknown; name?: unknown }[]; text?: string };
    const files = (Array.isArray(output.files) ? output.files : [])
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => typeof f?.url === 'string')
      .map(({ f, i }) => {
        const url = f.url as string;
        const ownPath = this.files.pathOf(url);
        const prunedWithBackup = !!ownPath && !this.files.resolveOutput(url) && typeof f.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl);
        const foreign = (/^https?:\/\//i.test(url) && !ownPath) || prunedWithBackup;
        return { url: foreign ? `${this.apiPublicUrl}/api/public/ai/output/${taskId}.${i}.${this.outputSig(taskId, i)}` : url, type: f.type, name: f.name };
      });
    return { ...(raw && typeof raw === 'object' ? { text: output.text } : {}), files };
  }

  /** Link proxy kết quả -> link gốc ở nhà cung cấp (chữ ký sai / file không còn thì báo không tìm thấy) */
  async outputSource(token: string) {
    const [taskId, idx, sig] = token.split('.');
    const index = Number(idx);
    const ok = !!taskId && !!sig && Number.isInteger(index) && index >= 0 && /^[0-9a-f-]{36}$/i.test(taskId);
    const expected = ok ? Buffer.from(this.outputSig(taskId, index)) : null;
    if (!expected || expected.length !== Buffer.byteLength(sig) || !timingSafeEqual(expected, Buffer.from(sig))) throw new NotFoundException('Không tìm thấy file');
    const t = await this.prisma.aiTask.findUnique({ where: { id: taskId }, select: { output: true } });
    const f = ((t?.output ?? {}) as { files?: AiOutputFile[] }).files?.[index];
    if (!f?.url) throw new NotFoundException('Không tìm thấy file');
    if (/^https?:\/\//i.test(f.url) && !this.files.pathOf(f.url)) {
      return { url: f.url, name: f.name };
    }
    if (typeof f.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl)) {
      return { url: f.sourceUrl, name: f.name };
    }
    throw new NotFoundException('Không tìm thấy file');
  }

  private downloadFileSig(taskId: string, index: number, exp: number) {
    return createHmac('sha256', this.outputSecret).update(`ai-dl-file:${taskId}:${index}:${exp}`).digest('base64url').slice(0, 24);
  }

  private downloadZipSig(zipId: string, exp: number) {
    return createHmac('sha256', this.outputSecret).update(`ai-dl-zip:${zipId}:${exp}`).digest('base64url').slice(0, 24);
  }

  private async cleanExpiredZipManifests() {
    const cutoff = Date.now() - (DOWNLOAD_TTL_SEC + 600) * 1000;
    const names = await readdir(ZIP_MANIFEST_DIR).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = join(ZIP_MANIFEST_DIR, name);
      const st = await stat(full).catch(() => null);
      if (st && st.mtimeMs < cutoff) await unlink(full).catch(() => undefined);
    }
  }

  /**
   * Tạo danh sách link tải từng file (kèm Content-Disposition: attachment) + link tải .ZIP nén gộp
   * cho các tác vụ hoàn thành thuộc về `userId`, giữ đúng thứ tự `dto.ids`.
   */
  async createDownloadLinks(userId: string, dto: DownloadTasksDto) {
    const orderedIds = [...new Set(dto.ids)];
    const rows = await this.prisma.aiTask.findMany({
      where: { userId, id: { in: orderedIds }, status: 'SUCCEEDED' },
      select: { id: true, code: true, output: true, createdAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tasks = orderedIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    const padLen = Math.max(2, String(tasks.length).length);
    const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SEC;
    const usedNames = new Set<string>();

    const uniqueName = (base: string, ext: string) => {
      const cleanBase = sanitizeNamePart(base) || 'tac-pham';
      let candidate = `${cleanBase}.${ext}`;
      let seq = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${cleanBase}-${seq++}.${ext}`;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    const files: { taskId: string; code: string; name: string; type: string; url: string }[] = [];
    const manifestItems: { taskId: string; index: number; name: string }[] = [];
    let taskWithFilesCount = 0;

    for (const t of tasks) {
      const rawFiles = ((t.output ?? {}) as { files?: AiOutputFile[] }).files;
      const valid = (Array.isArray(rawFiles) ? rawFiles : [])
        .map((f, index) => ({ f, index }))
        .filter(({ f }) => typeof f?.url === 'string' && /^(https?:\/\/|\/[^/])/i.test(f.url));
      if (!valid.length) continue;
      taskWithFilesCount++;

      const customName = taskCustomNameOf(t.output);
      const labelPrefix = formatBatchLabel(dto.labels?.[t.id], padLen);
      for (let pos = 0; pos < valid.length; pos++) {
        const { f, index } = valid[pos];
        const own = this.files.resolveOutput(f.url);
        const ext = own?.ext && own.ext !== 'bin' ? own.ext : guessOutputExt(f.url, f.type, f.name);
        const multiSuffix = valid.length > 1 ? `-${pos + 1}` : '';
        const base = customName ? `${customName}${multiSuffix}` : labelPrefix ? `${labelPrefix} - ${t.code}${multiSuffix}` : `${t.code}${multiSuffix}`;
        const name = uniqueName(base, ext);
        const sig = this.downloadFileSig(t.id, index, exp);
        const url = `/api/public/ai/download/file/${t.id}.${index}.${exp}.${sig}?name=${encodeURIComponent(name)}`;
        files.push({ taskId: t.id, code: t.code, name, type: String(f.type ?? 'file'), url });
        manifestItems.push({ taskId: t.id, index, name });
      }
    }

    if (!files.length) {
      throw new BadRequestException('Chưa có tác phẩm hoàn thành nào có file kết quả để tải về');
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const rawZipBase = sanitizeNamePart(dto.zipName ?? '') || (isChildSite() ? `tac-pham-ai-${dateStr}` : `novai-tac-pham-${dateStr}`);
    const zipName = rawZipBase.toLowerCase().endsWith('.zip') ? rawZipBase : `${rawZipBase}.zip`;
    const zipId = randomUUID();
    await writeFile(join(ZIP_MANIFEST_DIR, `${zipId}.json`), JSON.stringify({ userId, zipName, exp, items: manifestItems }), 'utf8');
    void this.cleanExpiredZipManifests();

    const zipSig = this.downloadZipSig(zipId, exp);
    return {
      zipUrl: `/api/public/ai/download/zip/${zipId}.${exp}.${zipSig}`,
      zipName,
      taskCount: taskWithFilesCount,
      fileCount: files.length,
      skippedCount: Math.max(0, orderedIds.length - taskWithFilesCount),
      files,
    };
  }

  /** Xác thực link tải lẻ một file kết quả kèm tên lưu về máy */
  async resolveDownloadFile(token: string, requestedName?: string) {
    const parts = token.split('.');
    if (parts.length !== 4) throw new NotFoundException('Link tải không hợp lệ');
    const [taskId, idxStr, expStr, sig] = parts;
    const index = Number(idxStr);
    const exp = Number(expStr);
    const ok =
      /^[0-9a-f-]{36}$/i.test(taskId) &&
      Number.isInteger(index) &&
      index >= 0 &&
      Number.isInteger(exp) &&
      exp >= Math.floor(Date.now() / 1000) &&
      !!sig;
    const expected = ok ? Buffer.from(this.downloadFileSig(taskId, index, exp)) : null;
    if (!expected || expected.length !== Buffer.byteLength(sig) || !timingSafeEqual(expected, Buffer.from(sig))) {
      throw new NotFoundException('Link tải đã hết hạn hoặc không hợp lệ');
    }
    const t = await this.prisma.aiTask.findUnique({ where: { id: taskId }, select: { code: true, status: true, output: true } });
    if (!t || t.status !== 'SUCCEEDED') throw new NotFoundException('Không tìm thấy tác phẩm');
    const f = ((t.output ?? {}) as { files?: AiOutputFile[] }).files?.[index];
    if (!f?.url || typeof f.url !== 'string') throw new NotFoundException('Không tìm thấy file kết quả');

    const own = this.files.resolveOutput(f.url);
    const ext = own?.ext && own.ext !== 'bin' ? own.ext : guessOutputExt(f.url, f.type, f.name);
    const cleanReq = requestedName ? sanitizeNamePart(requestedName.replace(/\.[a-z0-9]{2,5}$/i, '')) : '';
    const fileName = `${cleanReq || `${t.code}-${index + 1}`}.${ext}`;

    if (own) {
      return { fileName, mimeType: own.mimeType, localFile: own.localFile, readBuffer: own.readBuffer, remoteUrl: null as string | null };
    }
    const remoteUrl =
      !this.files.pathOf(f.url) && /^https?:\/\//i.test(f.url)
        ? f.url
        : typeof f.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl)
          ? f.sourceUrl
          : null;
    if (!remoteUrl) throw new NotFoundException('Không tìm thấy file kết quả');
    return { fileName, mimeType: 'application/octet-stream', localFile: null, readBuffer: null, remoteUrl };
  }

  /** Xác thực link tải gói .ZIP hàng loạt và dựng danh sách nguồn đọc */
  async resolveDownloadZip(token: string): Promise<{ zipName: string; entries: ZipSourceEntry[] }> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new NotFoundException('Link tải không hợp lệ');
    const [zipId, expStr, sig] = parts;
    const exp = Number(expStr);
    const ok = /^[0-9a-f-]{36}$/i.test(zipId) && Number.isInteger(exp) && exp >= Math.floor(Date.now() / 1000) && !!sig;
    const expected = ok ? Buffer.from(this.downloadZipSig(zipId, exp)) : null;
    if (!expected || expected.length !== Buffer.byteLength(sig) || !timingSafeEqual(expected, Buffer.from(sig))) {
      throw new NotFoundException('Link tải .ZIP đã hết hạn, vui lòng bấm tải lại');
    }
    const rawJson = await readFile(join(ZIP_MANIFEST_DIR, `${zipId}.json`), 'utf8').catch(() => null);
    if (!rawJson) throw new NotFoundException('Link tải .ZIP đã hết hạn, vui lòng bấm tải lại');
    const manifest = JSON.parse(rawJson) as { userId: string; zipName: string; items: { taskId: string; index: number; name: string }[] };
    const taskIds = [...new Set(manifest.items.map((x) => x.taskId))];
    const rows = await this.prisma.aiTask.findMany({
      where: { userId: manifest.userId, id: { in: taskIds }, status: 'SUCCEEDED' },
      select: { id: true, output: true, createdAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const entries: ZipSourceEntry[] = [];
    for (const item of manifest.items) {
      const t = byId.get(item.taskId);
      const f = ((t?.output ?? {}) as { files?: AiOutputFile[] }).files?.[item.index];
      if (!t || !f?.url || typeof f.url !== 'string') continue;
      const own = this.files.resolveOutput(f.url);
      if (own) {
        entries.push({
          name: item.name,
          mtime: t.createdAt,
          localFile: own.localFile,
          getBuffer: own.localFile ? undefined : own.readBuffer,
        });
      } else {
        const remoteUrl =
          !this.files.pathOf(f.url) && /^https?:\/\//i.test(f.url)
            ? f.url
            : typeof f.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl)
              ? f.sourceUrl
              : null;
        if (remoteUrl) {
          entries.push({
            name: item.name,
            mtime: t.createdAt,
            remoteUrl,
          });
        }
      }
    }
    if (!entries.length) throw new NotFoundException('Các file kết quả không còn tồn tại');
    return { zipName: manifest.zipName || (isChildSite() ? 'tac-pham-ai.zip' : 'novai-tac-pham.zip'), entries };
  }

  private presentTask(t: AiTask & { tool?: { name: string; icon: string | null; category: string } | null }) {
    const r = this.resolve(t.toolKey);
    return {
      id: t.id,
      code: t.code,
      toolKey: publicToolKey(t.toolKey),
      tool: t.tool ? { name: hideProviderText(t.tool.name), icon: t.tool.icon, category: t.tool.category, output: r?.def.output ?? 'image' } : null,
      status: t.status,
      progress: t.progress,
      input: t.input,
      // link kết quả không lộ địa chỉ nhà cung cấp (bỏ sourceUrl, link chưa sao lưu đi qua proxy)
      output: this.publicOutput(t.id, t.output),
      credits: t.credits,
      refunded: t.refunded,
      // câu lỗi nhà cung cấp trả về có thể chứa tên của họ
      error: hideProviderText(t.error),
      ...museReplyView(t),
      isPublic: t.isPublic,
      publicBlocked: t.publicBlocked,
      communityPending: !t.isPublic && !t.publicBlocked && taskCommunityPendingOf(t.output),
      customName: taskCustomNameOf(t.output),
      startedAt: t.startedAt,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    };
  }

  async myTasks(userId: string, q: TaskQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.AiTaskWhereInput = {
      userId,
      ...(q.status ? { status: q.status as AiTask['status'] } : {}),
      ...(q.tool ? { toolKey: internalToolKey(q.tool) } : {}),
      ...(q.category ? { tool: { category: q.category } } : {}),
      ...(q.ids ? { id: { in: q.ids.split(',') } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.aiTask.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { tool: { select: { name: true, icon: true, category: true } } } }),
      this.prisma.aiTask.count({ where }),
    ]);
    return paginate(rows.map((r) => this.presentTask(r)), total, page, limit);
  }

  /**
   * Trả lời câu hỏi của Muse: video AHiep bị từ chối nhưng Muse hỏi lại / đưa lựa chọn (A — …, B — …).
   * Tạo tác vụ mới cùng công cụ + thiết lập, prompt = câu trả lời, adapter gọi POST /videos/{id}/reply để Muse làm tiếp
   * cùng cuộc trò chuyện (cùng ảnh, cùng ngữ cảnh) -> tính tiền / hoàn tiền như một video mới.
   * Nguồn chỉ cho trả lời 1 lần mỗi tác vụ: ghi dấu `replyTask` lên tác vụ gốc trước khi gửi (2 request song song chỉ 1 cái qua).
   */
  async replyTask(user: AuthUser, id: string, message: string, meta: { ip?: string | null; viaApi?: boolean } = {}) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);
    const t = await this.prisma.aiTask.findFirst({ where: { userId: user.id, ...(isUuid ? { id } : { code: id.toUpperCase() }) } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    const q = museQuestion(t);
    if (!q) throw new BadRequestException('Tác vụ này không có câu hỏi để trả lời');
    if (q.replyTask) throw new ConflictException('Bạn đã trả lời câu hỏi này rồi');
    const raw = t.providerData as Record<string, unknown>;
    const claimed = await this.prisma.aiTask.updateMany({ where: { id: t.id, providerData: { equals: raw as Prisma.InputJsonValue } }, data: { providerData: { ...raw, replyTask: 'pending' } as object } });
    if (!claimed.count) throw new ConflictException('Bạn đã trả lời câu hỏi này rồi');
    try {
      // bỏ ảnh khởi đầu: Muse giữ ảnh trong cuộc trò chuyện (ảnh cũ có thể đã bị dọn theo hạn lưu trữ)
      const { image: _image, ...input } = (t.input ?? {}) as Record<string, unknown>;
      const next = await this.run(user, publicToolKey(t.toolKey), { ...input, prompt: message }, { ...meta, isPublic: t.isPublic }, { replyTo: t.providerTaskId!.slice('video:'.length) });
      await this.prisma.aiTask.update({ where: { id: t.id }, data: { providerData: { ...raw, replyTask: next.code } as object } });
      return next;
    } catch (err) {
      // không tạo được tác vụ (thiếu số dư, quá số luồng...) -> trả lại lượt trả lời
      await this.prisma.aiTask.update({ where: { id: t.id }, data: { providerData: raw as object } });
      throw err;
    }
  }

  async myTask(userId: string, id: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);
    const t = await this.prisma.aiTask.findFirst({ where: { userId, ...(isUuid ? { id } : { code: id.toUpperCase() }) }, include: { tool: { select: { name: true, icon: true, category: true } } } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    return this.presentTask(t);
  }

  /** Thống kê nhanh cho dashboard khách */
  async myStats(userId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [byStatus, recent] = await Promise.all([
      this.prisma.aiTask.groupBy({ by: ['status'], where: { userId, createdAt: { gte: since } }, _count: true }),
      this.prisma.aiTask.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 6, include: { tool: { select: { name: true, icon: true, category: true } } } }),
    ]);
    return { last30d: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), recent: recent.map((r) => this.presentTask(r)) };
  }

  // ---------------- trang Cộng đồng ----------------

  /** Điều kiện chung: tác vụ công khai, đã xong, công cụ còn bật */
  private readonly communityWhere: Prisma.AiTaskWhereInput = { isPublic: true, status: 'SUCCEEDED', tool: { enabled: true } };
  private readonly communityInclude = { tool: { select: { name: true, icon: true, category: true } }, user: { select: { name: true } } } as const;
  /** Địa chỉ nội bộ của API web mẹ trên cùng VPS để web con lấy Cộng đồng chung siêu tốc (<2ms, không qua Cloudflare) */
  private readonly parentApiInternalUrl = (process.env.PARENT_API_INTERNAL_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
  private readonly parentCommunityCache = new Map<string, { exp: number; data: unknown }>();

  /** Chữ ký HMAC bảo vệ đường dẫn proxy file Cộng đồng trên web con (không lộ domain web mẹ) */
  private communityMediaSig(payload: string) {
    return createHmac('sha256', this.outputSecret).update(`comm-media:${payload}`).digest('base64url').slice(0, 22);
  }

  /** Đổi URL file của web mẹ sang URL proxy ngay trên domain riêng của web con (mã hoá rút gọn không chứa domain web mẹ) */
  private rewriteParentCommunityFileUrl(code: string, index: number, rawUrl: string, type?: unknown, name?: unknown): string {
    let compact = rawUrl;
    try {
      const u = new URL(rawUrl);
      if (u.hostname === 'nov.ai.vn' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        if (u.pathname.startsWith('/uploads/')) compact = `u:${u.pathname.slice('/uploads/'.length)}`;
        else if (u.pathname.startsWith('/api/public/ai/output/')) compact = `o:${u.pathname.slice('/api/public/ai/output/'.length)}`;
      }
    } catch {
      // giữ nguyên nếu không phải URL đầy đủ
    }
    const payload = Buffer.from(compact, 'utf8').toString('base64url');
    const sig = this.communityMediaSig(payload);
    const ext = guessOutputExt(rawUrl, type, name);
    const cleanCode = sanitizeNamePart(code) || 'community';
    const fileName = `${cleanCode}-${index + 1}.${ext || 'mp4'}`;
    const basePrefix = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(this.apiPublicUrl) ? '' : this.apiPublicUrl;
    return `${basePrefix}/api/public/ai/community/media/${payload}.${sig}/${encodeURIComponent(fileName)}`;
  }

  /** Trả URL demo công cụ an toàn cho web con (đổi link nov.ai.vn sang link proxy ký trên chính domain web con — T-372) */
  private publicDemoUrl(options: unknown, forceMask = false): string | null {
    const raw = (options as Record<string, unknown> | null)?.demoVideo;
    const url = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (!url) return null;
    if ((isChildSite() || forceMask) && /^https?:\/\/(www\.)?nov\.ai\.vn\//i.test(url)) {
      return this.rewriteParentCommunityFileUrl('demo', 0, url);
    }
    return url;
  }

  /** Giải mã & kiểm tra chữ ký token media Cộng đồng trên web con (ưu tiên đọc thẳng ổ cứng local nếu cùng VPS) */
  async resolveCommunityMedia(token: string): Promise<{ localFile: string | null; remoteUrl: string | null }> {
    const dot = token.indexOf('.');
    if (dot <= 0) throw new NotFoundException('Không tìm thấy file');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = Buffer.from(this.communityMediaSig(payload));
    if (!sig || expected.length !== Buffer.byteLength(sig) || !timingSafeEqual(expected, Buffer.from(sig))) {
      throw new NotFoundException('Không tìm thấy file');
    }
    let decoded = '';
    try {
      decoded = Buffer.from(payload, 'base64url').toString('utf8');
    } catch {
      throw new NotFoundException('Không tìm thấy file');
    }
    if (decoded.startsWith('u:')) {
      const rel = decodeURIComponent(decoded.slice(2));
      if (!rel.includes('..')) {
        const root = resolve(process.cwd(), 'uploads');
        const full = resolve(join(root, rel));
        if (full.startsWith(root + sep)) {
          const st = await stat(full).catch(() => null);
          if (st?.isFile()) return { localFile: full, remoteUrl: null };
        }
      }
      return { localFile: null, remoteUrl: `${this.parentApiInternalUrl}/uploads/${decoded.slice(2)}` };
    }
    if (decoded.startsWith('o:')) {
      return { localFile: null, remoteUrl: `${this.parentApiInternalUrl}/api/public/ai/output/${decoded.slice(2)}` };
    }
    const rawUrl = decoded;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new NotFoundException('Không tìm thấy file');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NotFoundException('Không tìm thấy file');
    }
    const isParentHost = parsed.hostname === 'nov.ai.vn' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (isParentHost && parsed.pathname.startsWith('/uploads/')) {
      const rel = decodeURIComponent(parsed.pathname.slice('/uploads/'.length));
      if (!rel.includes('..')) {
        const root = resolve(process.cwd(), 'uploads');
        const full = resolve(join(root, rel));
        if (full.startsWith(root + sep)) {
          const st = await stat(full).catch(() => null);
          if (st?.isFile()) return { localFile: full, remoteUrl: null };
        }
      }
    }
    const remoteUrl = isParentHost ? `${this.parentApiInternalUrl}${parsed.pathname}${parsed.search}` : rawUrl;
    return { localFile: null, remoteUrl };
  }

  /** Gọi API Cộng đồng của web mẹ có bộ nhớ đệm ngắn hạn 20s để tải tức thì */
  private async fetchParentCommunityJson<T>(subpath: string, params?: Record<string, string | number | undefined>): Promise<T | null> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== '') sp.set(k, String(v));
    }
    const qs = sp.toString() ? `?${sp.toString()}` : '';
    const cacheKey = `${subpath}${qs}`;
    const now = Date.now();
    const hit = this.parentCommunityCache.get(cacheKey);
    if (hit && hit.exp > now) return hit.data as T;

    const bases = [this.parentApiInternalUrl, 'https://nov.ai.vn'];
    for (const base of bases) {
      if (base === this.apiPublicUrl) continue;
      const res = await fetch(`${base}/api/public/ai/community${subpath}${qs}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (res?.ok) {
        const data = (await res.json().catch(() => null)) as T | null;
        if (data) {
          if (this.parentCommunityCache.size > 150) {
            for (const [k, v] of this.parentCommunityCache) if (v.exp <= now) this.parentCommunityCache.delete(k);
            if (this.parentCommunityCache.size > 150) this.parentCommunityCache.clear();
          }
          this.parentCommunityCache.set(cacheKey, { exp: now + 20_000, data });
          return data;
        }
      }
    }
    return null;
  }

  /** Ánh xạ một tác phẩm Cộng đồng từ web mẹ sang chuẩn hiển thị & tên công cụ của web con */
  private mapParentCommunityItem(
    raw: Record<string, unknown>,
    localToolByPubKey: Map<string, { enabled: boolean; name: string; icon: string | null; category: string }>,
  ) {
    const pubKey = String(raw.toolKey ?? '');
    const basePubKey = pubKey.split(MODEL_SEP)[0];
    const localTool = localToolByPubKey.get(pubKey) ?? localToolByPubKey.get(basePubKey);
    if (localTool && !localTool.enabled) return null;
    const code = String(raw.code ?? '');
    const rawOut = (raw.output ?? {}) as { files?: { url?: unknown; type?: unknown; name?: unknown }[]; text?: string };
    const files = (Array.isArray(rawOut.files) ? rawOut.files : [])
      .filter((f) => typeof f?.url === 'string' && f.url)
      .map((f, idx) => ({
        url: this.rewriteParentCommunityFileUrl(code, idx, f.url as string, f.type, f.name),
        type: f.type,
        ...(f.name !== undefined ? { name: f.name } : {}),
      }));
    const rawTool = raw.tool as { name?: string; icon?: string | null; category?: string; output?: string } | null;
    const tool = localTool
      ? {
          name: hideProviderText(localTool.name),
          icon: localTool.icon,
          category: localTool.category,
          output: rawTool?.output ?? 'image',
        }
      : rawTool
        ? {
            name: hideProviderText(rawTool.name ?? ''),
            icon: rawTool.icon ?? null,
            category: rawTool.category ?? 'tools',
            output: rawTool.output ?? 'image',
          }
        : null;
    return {
      id: String(raw.id ?? code),
      code,
      toolKey: pubKey,
      tool,
      status: String(raw.status ?? 'SUCCEEDED'),
      input: (raw.input ?? {}) as Record<string, unknown>,
      output: { files, ...(rawOut.text !== undefined ? { text: rawOut.text } : {}) },
      author: typeof raw.author === 'string' ? raw.author : null,
      createdAt: raw.createdAt as Date | string,
    };
  }

  /** Bảng tra công cụ theo khoá công khai trên DB hiện tại (dùng cho web con đồng bộ Cộng đồng) */
  private async localToolMapByPublicKey() {
    const tools = await this.prisma.aiTool.findMany({ select: { key: true, enabled: true, name: true, icon: true, category: true } });
    const map = new Map<string, { enabled: boolean; name: string; icon: string | null; category: string }>();
    for (const t of tools) map.set(publicToolKey(t.key), t);
    return map;
  }

  /**
   * Trình bày tác phẩm công khai: chỉ lộ những gì cần để xem / dùng lại thiết kế.
   * Bỏ ô tải file (ảnh tham chiếu của chủ tác vụ — người khác không dùng lại được vì kiểm tra quyền sở hữu file),
   * không trả credits, lỗi, IP; tên tác giả chỉ lấy tên gọi (chữ cuối).
   */
  private presentCommunity(t: AiTask & { tool: { name: string; icon: string | null; category: string } | null; user: { name: string } | null }) {
    const r = this.resolve(t.toolKey);
    const fileFields = new Set((r?.def.fields ?? []).filter((f) => ['image', 'video', 'audio', 'file'].includes(f.type)).map((f) => f.name));
    const input = Object.fromEntries(Object.entries((t.input ?? {}) as Record<string, unknown>).filter(([k]) => !fileFields.has(k)));
    // chỉ giữ link file, bỏ sourceUrl (link nhà cung cấp kèm token) và dữ liệu thô khác; link chưa sao lưu đi qua proxy
    const output = this.publicOutput(t.id, t.output);
    return {
      id: t.id,
      code: t.code,
      toolKey: publicToolKey(t.toolKey),
      tool: t.tool ? { name: hideProviderText(t.tool.name), icon: t.tool.icon, category: t.tool.category, output: r?.def.output ?? 'image' } : null,
      status: t.status,
      input,
      output: { files: output.files, text: output.text },
      author: t.user?.name?.trim().split(/\s+/).pop() ?? null,
      createdAt: t.createdAt,
    };
  }

  /** Đọc danh sách ID tác vụ được Admin ghim lên đầu Cộng đồng (`settings.ai_community.pinnedIds` — T-324, T-325) */
  private async communityPinnedIds(): Promise<string[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'ai_community' } });
    const raw = (row?.value as { pinnedIds?: unknown } | null)?.pinnedIds;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  }

  private async saveCommunityPinnedIds(ids: string[]) {
    const unique = [...new Set(ids)].slice(0, 100);
    await this.prisma.setting.upsert({
      where: { key: 'ai_community' },
      create: { key: 'ai_community', value: { pinnedIds: unique }, isPublic: false },
      update: { value: { pinnedIds: unique } },
    });
    this.parentCommunityCache.clear();
  }

  /** Danh sách tác phẩm công khai mới nhất (ưu tiên tác phẩm Admin ghim đầu trang, lọc nhóm / công cụ / từ khoá; web con gộp cả Cộng đồng chung từ web mẹ) */
  async communityTasks(q: CommunityQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const kw = q.q?.trim();
    const where: Prisma.AiTaskWhereInput = {
      ...this.communityWhere,
      ...(q.tool ? { toolKey: internalToolKey(q.tool) } : {}),
      ...(q.category ? { tool: { enabled: true, category: q.category } } : {}),
      // prompt nằm ở input.prompt hoặc input.text tuỳ công cụ
      ...(kw ? { OR: [{ input: { path: ['prompt'], string_contains: kw, mode: 'insensitive' } }, { input: { path: ['text'], string_contains: kw, mode: 'insensitive' } }] } : {}),
    };
    const pinnedIds = await this.communityPinnedIds();
    const pinnedRows = pinnedIds.length
      ? await this.prisma.aiTask.findMany({ where: { ...where, id: { in: pinnedIds } }, include: this.communityInclude })
      : [];
    const pinnedById = new Map(pinnedRows.map((r) => [r.id, r]));
    const orderedPinned = pinnedIds.map((id) => pinnedById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    const activePinnedIds = orderedPinned.map((r) => r.id);

    const restWhere: Prisma.AiTaskWhereInput = activePinnedIds.length ? { ...where, id: { notIn: activePinnedIds } } : where;
    const pinnedSlice = orderedPinned.slice(skip, skip + take);
    const restSkip = Math.max(0, skip - orderedPinned.length);
    const restTake = Math.max(0, take - pinnedSlice.length);

    const [restRows, restTotal] = await Promise.all([
      restTake > 0 ? this.prisma.aiTask.findMany({ where: restWhere, orderBy: { createdAt: 'desc' }, skip: restSkip, take: restTake, include: this.communityInclude }) : Promise.resolve([]),
      this.prisma.aiTask.count({ where: restWhere }),
    ]);
    const total = orderedPinned.length + restTotal;
    const rows = [...pinnedSlice, ...restRows];
    const safeRows = rows.filter((r) => activePinnedIds.includes(r.id) || !inspectTaskViolation(r));
    const localItems = safeRows.map((r) => this.presentCommunity(r));

    if (!isChildSite()) {
      return paginate(localItems, total, page, limit);
    }

    type ParentCommunityRes = { data?: Record<string, unknown>[]; meta?: { total?: number } };
    const toolMap = await this.localToolMapByPublicKey();
    const mapList = (arr?: Record<string, unknown>[]) =>
      (Array.isArray(arr) ? arr : [])
        .map((it) => this.mapParentCommunityItem(it, toolMap))
        .filter((x): x is NonNullable<typeof x> => !!x);

    // Web con chưa có bài đăng riêng -> lấy trực tiếp trang tương ứng từ Cộng đồng chung của web mẹ
    if (total === 0) {
      const parentRes = await this.fetchParentCommunityJson<ParentCommunityRes>('', {
        category: q.category,
        tool: q.tool,
        q: kw,
        page,
        limit,
      });
      const parentItems = mapList(parentRes?.data);
      const parentTotal = Number(parentRes?.meta?.total ?? parentItems.length) || 0;
      return paginate(parentItems, parentTotal, page, limit);
    }

    // Web con vừa có bài đăng riêng vừa gộp Cộng đồng chung của web mẹ
    if (skip < total) {
      const need = Math.max(0, limit - localItems.length);
      const parentRes = await this.fetchParentCommunityJson<ParentCommunityRes>('', {
        category: q.category,
        tool: q.tool,
        q: kw,
        page: 1,
        limit: Math.max(1, need),
      });
      const parentTotal = Number(parentRes?.meta?.total ?? 0) || 0;
      const seenCodes = new Set(localItems.map((x) => x.code));
      const parentItems = need > 0 ? mapList(parentRes?.data).filter((x) => !seenCodes.has(x.code)).slice(0, need) : [];
      const merged = [...localItems, ...parentItems].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      return paginate(merged, total + parentTotal, page, limit);
    }

    const pOffset = skip - total;
    const pPage = Math.floor(pOffset / limit) + 1;
    const pRem = pOffset % limit;
    const [p1, p2] = await Promise.all([
      this.fetchParentCommunityJson<ParentCommunityRes>('', { category: q.category, tool: q.tool, q: kw, page: pPage, limit }),
      pRem > 0
        ? this.fetchParentCommunityJson<ParentCommunityRes>('', { category: q.category, tool: q.tool, q: kw, page: pPage + 1, limit })
        : Promise.resolve(null),
    ]);
    const parentTotal = Number(p1?.meta?.total ?? 0) || 0;
    const combinedRaw = [...(p1?.data ?? []), ...(p2?.data ?? [])].slice(pRem, pRem + limit);
    return paginate(mapList(combinedRaw), total + parentTotal, page, limit);
  }

  /** Một tác phẩm công khai theo mã (T...) — web con tự tra cứu sang Cộng đồng chung nếu là tác phẩm từ web mẹ */
  async communityTask(code: string) {
    const cleanCode = code.toUpperCase();
    const t = await this.prisma.aiTask.findFirst({ where: { ...this.communityWhere, code: cleanCode }, include: this.communityInclude });
    if (t && !inspectTaskViolation(t)) return this.presentCommunity(t);
    if (isChildSite()) {
      const [raw, toolMap] = await Promise.all([
        this.fetchParentCommunityJson<Record<string, unknown>>(`/${encodeURIComponent(cleanCode)}`),
        this.localToolMapByPublicKey(),
      ]);
      const mapped = raw ? this.mapParentCommunityItem(raw, toolMap) : null;
      if (mapped) return mapped;
    }
    throw new NotFoundException('Tác phẩm không tồn tại hoặc đã chuyển sang riêng tư');
  }

  /** Khách đổi chế độ hiển thị tác vụ của mình (Công khai sẽ vào mục Chờ kiểm duyệt của Admin thay vì đẩy thẳng lên Website — T-394) */
  async setVisibility(userId: string, id: string, wantPublic: boolean) {
    const t = await this.prisma.aiTask.findFirst({ where: { id, userId }, select: { isPublic: true, publicBlocked: true, output: true } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    if (wantPublic && t.publicBlocked) {
      throw new BadRequestException('Tác phẩm này đã bị quản trị viên từ chối khỏi Cộng đồng, không thể chuyển sang Công khai');
    }
    const prevOut = t.output && typeof t.output === 'object' ? { ...(t.output as Record<string, unknown>) } : {};
    if (wantPublic) {
      if (!t.isPublic) {
        prevOut.__communityPending = true;
        const res = await this.prisma.aiTask.updateMany({
          where: { id, userId, publicBlocked: false },
          data: { output: prevOut as object },
        });
        if (!res.count) throw new BadRequestException('Tác phẩm này đã bị quản trị viên ẩn khỏi Cộng đồng');
      }
    } else {
      delete prevOut.__communityPending;
      await this.prisma.aiTask.updateMany({
        where: { id, userId },
        data: { isPublic: false, output: prevOut as object },
      });
      this.parentCommunityCache.clear();
    }
    return this.myTask(userId, id);
  }

  /** Khách đặt tên riêng cho file video / ảnh kết quả để lúc tải về lưu đúng tên đã đặt */
  async renameTask(userId: string, id: string, rawName: string) {
    const t = await this.prisma.aiTask.findFirst({ where: { id, userId }, select: { id: true, output: true } });
    if (!t) throw new NotFoundException('Không tìm thấy tác phẩm');
    const clean = sanitizeNamePart(String(rawName ?? '').replace(/\.[a-z0-9]{2,5}$/i, ''));
    const nextOutput = { ...(((t.output as Record<string, unknown> | null) ?? {})) };
    if (clean) nextOutput.customName = clean;
    else delete nextOutput.customName;
    await this.prisma.aiTask.update({ where: { id: t.id }, data: { output: nextOutput as object } });
    return this.myTask(userId, id);
  }

  /** Khách huỷ tác vụ chưa gửi được sang nhà cung cấp (đã gửi thì nhà cung cấp vẫn tính phí nên không huỷ) */
  async cancelMine(userId: string, id: string) {
    const t = await this.prisma.aiTask.findFirst({ where: { id, userId } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    // chỉ huỷ được tác vụ đang chờ gửi lại sau lỗi tạm thời (pollCount > 0); giành tác vụ bằng cập nhật có điều kiện
    // để không huỷ đúng lúc cron đang gửi (nhà cung cấp vẫn tính phí job đã nhận)
    const claimed = await this.prisma.aiTask.updateMany({
      where: { id, userId, status: 'PENDING', pollCount: { gt: 0 }, nextPollAt: { gt: new Date(Date.now() + 5_000), lte: new Date(Date.now() + 5 * 60_000) } },
      data: { nextPollAt: new Date(Date.now() + SUBMIT_HOLD_MS) },
    });
    if (!claimed.count) throw new BadRequestException('Tác vụ đang được gửi xử lý, không huỷ được');
    await this.fail(t, 'Bạn đã huỷ tác vụ, tiền đã được hoàn lại', null, 'CANCELLED');
    if (t.providerTaskId) void this.cancelUpstreamForTask(t, 'user').catch(() => undefined);
    return this.myTask(userId, id);
  }

  // ---------------- quản trị ----------------

  /** Danh sách công cụ + trạng thái nhà cung cấp cho admin */
  async adminTools(user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const rows = (await this.prisma.aiTool.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { name: 'asc' }], include: { _count: { select: { tasks: true } } } })).filter((r) => !isDeletedTool(r.options) && !RETIRED_PROVIDERS.has(r.provider) && this.providers.has(r.provider));
    const providers = hide
      ? []
      : await Promise.all(
          AI_PROVIDERS.filter((p) => !RETIRED_PROVIDERS.has(p.key)).map(async (p) => {
            const cfg = await this.providerConfig(p.key);
            // Tìm mức % tăng giá đại diện đang áp trên các công cụ của nguồn này (dùng làm giá trị hiển thị mặc định khi chưa lưu riêng ở ai_<key>)
            const counts = new Map<number, number>();
            for (const row of rows) {
              if (row.provider !== p.key) continue;
              const hasChildren = rows.some((x) => x.key.startsWith(`${row.key}${MODEL_SEP}`));
              if (hasChildren) continue;
              const r = this.resolve(row.key);
              const pr = r ? this.pricingOf(r.def, row) : ((row.pricing ?? {}) as AiPricing);
              if (pr.mode === 'free') continue;
              const mk = Math.max(0, Number(pr.markup) || 0);
              counts.set(mk, (counts.get(mk) ?? 0) + 1);
            }
            let defaultMarkup = 0;
            let bestCnt = 0;
            for (const [mk, cnt] of counts) {
              if (cnt > bestCnt) {
                bestCnt = cnt;
                defaultMarkup = mk;
              }
            }
            const hasCfgMarkup = cfg.markup !== undefined && cfg.markup !== null && cfg.markup !== '' && Number.isFinite(Number(cfg.markup));
            const markup = hasCfgMarkup ? Math.max(0, Math.round(Number(cfg.markup) * 100) / 100) : defaultMarkup;
            return {
              key: p.key,
              name: p.name,
              website: p.website ?? null,
              defaultBadge: providerDefaultBadge(p.key),
              enabled: cfg.enabled,
              configured: !!cfg.apiKey,
              rate: providerRate(p, cfg),
              defaultRate: p.rate ?? null,
              costUnit: p.costUnit ?? null,
              markup,
              autoName: cfg.autoName !== false,
              autoPrice: p.cost ? cfg.autoPrice !== false : cfg.autoPrice === true,
              supportsCost: !!p.cost,
              tools: p.tools.length,
              note: typeof cfg.note === 'string' ? cfg.note : '',
              sourcePromo: typeof (cfg as Record<string, unknown>).sourcePromo === 'string' ? ((cfg as Record<string, unknown>).sourcePromo as string) : '',
              expiresAt: typeof (cfg as Record<string, unknown>).expiresAt === 'string' ? ((cfg as Record<string, unknown>).expiresAt as string) : '',
              manualCredits: Number.isFinite(Number((cfg as Record<string, unknown>).manualCredits))
                ? Number((cfg as Record<string, unknown>).manualCredits)
                : null,
            };
          }),
        );
    return {
      hideProviders: hide,
      providers,
      tools: rows.map((row) => {
        const r = this.resolve(row.key);
        // tỉ giá quy đổi đang dùng của nhà cung cấp (giá "theo chi phí NCC" = chi phí × tỉ giá)
        const pv = providers.find((x) => x.key === row.provider);
        // công cụ gốc đã tách theo model: số model con (admin thấy "đã tách thành N model")
        const models = rows.filter((x) => x.key.startsWith(`${row.key}${MODEL_SEP}`)).length;
        const demoVideo = this.publicDemoUrl(row.options, hide);
        const apiTail = row.key.replace(/^[^.]+\./, '').replace(/~/g, '/');
        const canonicalModel = hide ? null : canonicalModelSlug(apiTail, row.modelLabel || row.name, row.category);
        return {
          ...row,
          key: hide ? publicToolKey(row.key) : row.key,
          provider: hide ? '' : row.provider,
          name: hide ? hideProviderText(row.name) : row.name,
          description: hide ? hideProviderText(row.description) : row.description,
          modelLabel: hide ? hideProviderText(row.modelLabel) : row.modelLabel,
          canonicalModel,
          demoVideo,
          maintenance: isMaintenanceTool(row.options),
          models,
          available: !!r,
          output: r?.def.output ?? null,
          unitLabel: r?.def.unitLabel ?? null,
          defaultPricing: r?.def.pricing ?? null,
          supportsCost: !!r && supportsCost(r.provider, r.def),
          supportsDurationTiers: !!r?.def.supportsDurationTiers,
          supportsPerSecond: !!r && supportsPerSecond(r.def),
          supportsPerChar: !!r && supportsPerChar(r.def),
          resolutionOptions: r ? resolutionOptionsOf(applyHealedFields(r.def, row.options)) : [],
          rate: hide ? 1 : (pv?.rate ?? 1),
          costUnit: hide ? null : (pv?.costUnit ?? null),
          tasks: row._count.tasks + archivedRunsOf(row.options),
        };
      }),
    };
  }

  /**
   * Giá một lượt của từng công cụ cho bảng admin (đỡ phải ra website bấm thử):
   * tính theo lựa chọn mặc định của form, file chưa tải lên thì adapter tự tính tạm (vd 10 giây), chữ chưa nhập thì tạm tính 1.000 ký tự (`__sample: true`).
   * Tách riêng khỏi adminTools vì có thể phải gọi bảng giá nhà cung cấp (đã cache 10 phút) -> bảng không phải chờ.
   */
  async adminToolPrices(user?: AuthUser, fresh = false) {
    if (fresh) {
      await this.autoDiscoverUpstreamTools(false).catch(() => undefined);
    }
    const hide = shouldHideAiProviders(user);
    const rows = (await this.prisma.aiTool.findMany()).filter((r) => !isDeletedTool(r.options));
    const checkedAt = new Date().toISOString();
    const out: Record<
      string,
      {
        credits: number | null;
        providerCost: number | null;
        providerRaw: number | null;
        benchCost?: number | null;
        checkedAt?: string;
        error?: string;
      }
    > = {};
    // Chuẩn hoá mốc cấu hình đồng nhất (ưu tiên 720p · 5s/8s cho video) để so sánh ngang hàng giá vốn giữa các nhà cung cấp kể cả khi lựa chọn mặc định khác nhau
    const buildBenchInput = (def: AiToolDef, base: AiInput): { input: AiInput; changed: boolean } => {
      if (def.output !== 'video') return { input: base, changed: false };
      const next: AiInput = { ...base };
      let changed = false;
      for (const f of def.fields) {
        if (f.type !== 'select') continue;
        const opts = f.optionsBy ? f.optionsBy.map[String(next[f.optionsBy.field] ?? '')] ?? f.options : f.options;
        if (!opts?.length) continue;
        if (opts.some((o) => /^\d+\|\d+p$/i.test(String(o.value)))) {
          const hit = ['5|720p', '8|720p', '6|720p', '10|720p'].map((v) => opts.find((o) => String(o.value).toLowerCase() === v)).find(Boolean);
          if (hit && next[f.name] !== hit.value) {
            next[f.name] = hit.value;
            changed = true;
          }
          continue;
        }
        const fname = f.name.toLowerCase();
        if (fname === 'resolution' || fname === 'quality' || fname === 'res') {
          const hit720 =
            opts.find((o) => String(o.value).toLowerCase() === '720p') ??
            opts.find((o) => /\b720p\b/i.test(o.label));
          if (hit720 && next[f.name] !== hit720.value) {
            next[f.name] = hit720.value;
            changed = true;
          }
        } else if (fname === 'duration' || fname === 'seconds' || fname === 'dur') {
          const hitDur = ['5', '5s', '8', '8s', '6', '6s'].map((v) => opts.find((o) => String(o.value).toLowerCase() === v)).find(Boolean);
          if (hitDur && next[f.name] !== hitDur.value) {
            next[f.name] = hitDur.value;
            changed = true;
          }
        }
      }
      return { input: next, changed };
    };
    const rawCostOf = (res: { credits: number | null; providerCost: number | null }, def: AiToolDef, row: AiTool): number | null => {
      if (res.credits === null || !Number.isFinite(res.credits)) return null;
      if (res.credits <= 0) return 0;
      if (res.providerCost !== null && Number.isFinite(res.providerCost) && res.providerCost > 0) {
        return Math.round(res.providerCost * 100) / 100;
      }
      const p = this.pricingOf(def, row);
      const mk = Math.max(0, Number(p.markup) || 0);
      return Math.round((res.credits / (1 + mk / 100)) * 100) / 100;
    };
    // nhóm theo nhà cung cấp: chạy công cụ đầu tiên trước để làm nóng cache bảng giá, rồi mới chạy song song phần còn lại
    const byProvider = new Map<string, { row: AiTool; provider: AiProvider; def: AiToolDef }[]>();
    for (const row of rows) {
      if (RETIRED_PROVIDERS.has(row.provider)) continue;
      const r = this.resolve(row.key);
      if (!r) continue;
      byProvider.set(r.provider.key, [...(byProvider.get(r.provider.key) ?? []), { row, ...r }]);
    }
    const one = async ({ row, provider, def }: { row: AiTool; provider: AiProvider; def: AiToolDef }, ctx: AiCallContext, isFirst: boolean) => {
      const outKey = hide ? publicToolKey(row.key) : row.key;
      try {
        // giới hạn 25 giây mỗi công cụ để nhà cung cấp treo không làm treo cả bảng
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Hết thời gian chờ bảng giá')), 25_000));
        const defIn: AiInput = { ...defaultInput(def.fields), __sample: true, ...(fresh && isFirst ? { __fresh: true } : {}) };
        const res = await Promise.race([this.quoteDetail(provider, def, row, defIn, ctx), timeout]);
        if (hide) {
          out[outKey] = { credits: res.credits, providerCost: null, providerRaw: null };
          return;
        }
        let benchCost = rawCostOf(res, def, row);
        const bench = buildBenchInput(def, defIn);
        if (bench.changed) {
          const bRes = await this.quoteDetail(provider, def, row, { ...bench.input, __sample: true }, ctx).catch(() => null);
          if (bRes) {
            const bc = rawCostOf(bRes, def, row);
            if (bc !== null && bc > 0) benchCost = bc;
          }
        }
        out[outKey] = { ...res, benchCost, checkedAt };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out[outKey] = { credits: null, providerCost: null, providerRaw: null, error: hide ? hideProviderText(msg) : msg };
      }
    };
    await Promise.all(
      [...byProvider.entries()].map(async ([providerKey, items]) => {
        const ctx = await this.ctx(providerKey);
        await one(items[0], ctx, true);
        await Promise.all(items.slice(1).map((it) => one(it, ctx, false)));
      }),
    );
    return out;
  }

  /**
   * Thống kê lượt chạy theo ngày / khoảng ngày (giờ Việt Nam UTC+7) cho từng công cụ ở trang Admin › Công cụ AI.
   * Kết hợp sổ cái vĩnh viễn `credit_transactions` (giữ đủ lịch sử kể cả sau khi dọn `ai_tasks` 24h) + tác vụ 0đ trong `ai_tasks`.
   */
  async adminToolRunStats(q: ToolRunStatsQueryDto, user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const VN = 7 * 3_600_000;
    const DAY = 86_400_000;
    const vnTodayStr = new Date(Date.now() + VN).toISOString().slice(0, 10);
    const parseVnDayStart = (ymd: string): number | null => {
      const ms = Date.parse(`${ymd}T00:00:00Z`);
      return Number.isFinite(ms) ? ms - VN : null;
    };
    const fmtVnDay = (utcMs: number) => new Date(utcMs + VN).toISOString().slice(0, 10);

    const todayStart = parseVnDayStart(vnTodayStr)!;
    let startMs = todayStart;
    let endMs = todayStart + DAY;

    const period = q.period ?? 'today';
    if (period === 'all') {
      startMs = Date.parse('2024-01-01T00:00:00Z');
      endMs = todayStart + 2 * DAY;
    } else if (period === 'yesterday') {
      startMs = todayStart - DAY;
      endMs = todayStart;
    } else if (period === 'daybefore') {
      startMs = todayStart - 2 * DAY;
      endMs = todayStart - DAY;
    } else if (period === '7d') {
      startMs = todayStart - 6 * DAY;
      endMs = todayStart + DAY;
    } else if (period === '30d') {
      startMs = todayStart - 29 * DAY;
      endMs = todayStart + DAY;
    } else if (period === 'custom') {
      const a = q.from ? parseVnDayStart(q.from) : null;
      const b = q.to ? parseVnDayStart(q.to) : null;
      const s = a ?? b ?? todayStart;
      const e = b ?? a ?? todayStart;
      startMs = Math.min(s, e);
      endMs = Math.max(s, e) + DAY;
    }

    const gte = new Date(startMs);
    const lt = new Date(endMs);

    const rows = await this.prisma.$queryRaw<{ tool_key: string; runs: number; succeeded: number; refunded: number; revenue: number; cost: number }[]>`
      WITH name_map AS (
        SELECT DISTINCT ON (name) name, key
        FROM ai_tools
        ORDER BY name, enabled DESC, "createdAt" ASC
      ),
      usage_rows AS (
        SELECT
          COALESCE(
            t."toolKey",
            NULLIF(ct.meta::jsonb->>'toolKey', ''),
            nm.key
          ) AS tool_key,
          ABS(ct.amount)::numeric AS amount,
          CASE
            WHEN (ct.meta::jsonb->>'providerCost') ~ '^[0-9]+(\.[0-9]+)?$'
              THEN (ct.meta::jsonb->>'providerCost')::numeric
            ELSE 0::numeric
          END AS provider_cost,
          EXISTS (
            SELECT 1 FROM credit_transactions r
            WHERE r.type = 'REFUND'
              AND (
                (ct."taskId" IS NOT NULL AND r."taskId" = ct."taskId")
                OR (ct."idempotencyKey" LIKE 'usage:%' AND r."idempotencyKey" = 'refund:' || substr(ct."idempotencyKey", 7))
              )
          ) AS is_refunded
        FROM credit_transactions ct
        LEFT JOIN ai_tasks t ON t.id = ct."taskId"
        LEFT JOIN name_map nm ON ct."taskId" IS NULL AND NOT (COALESCE(ct.meta::jsonb, '{}'::jsonb) ? 'toolKey')
          AND nm.name = regexp_replace(COALESCE(ct.note, ''), ' · T[A-Za-z0-9]{6,8}$', '')
        WHERE ct.type = 'USAGE'
          AND ct."createdAt" >= ${gte}
          AND ct."createdAt" < ${lt}
      ),
      paid_agg AS (
        SELECT
          tool_key,
          COUNT(*)::int AS runs,
          COUNT(*) FILTER (WHERE NOT is_refunded)::int AS succeeded,
          COUNT(*) FILTER (WHERE is_refunded)::int AS refunded,
          COALESCE(SUM(CASE WHEN NOT is_refunded THEN amount ELSE 0 END), 0)::float AS revenue,
          COALESCE(SUM(CASE WHEN NOT is_refunded THEN provider_cost ELSE 0 END), 0)::float AS cost
        FROM usage_rows
        WHERE tool_key IS NOT NULL
        GROUP BY tool_key
      ),
      free_agg AS (
        SELECT
          "toolKey" AS tool_key,
          COUNT(*)::int AS runs,
          COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE status IN ('FAILED', 'CANCELLED'))::int AS refunded,
          0::float AS revenue,
          0::float AS cost
        FROM ai_tasks
        WHERE credits = 0
          AND "createdAt" >= ${gte}
          AND "createdAt" < ${lt}
        GROUP BY "toolKey"
      )
      SELECT
        tool_key,
        SUM(runs)::int AS runs,
        SUM(succeeded)::int AS succeeded,
        SUM(refunded)::int AS refunded,
        SUM(revenue)::float AS revenue,
        SUM(cost)::float AS cost
      FROM (
        SELECT * FROM paid_agg
        UNION ALL
        SELECT * FROM free_agg
      ) combined
      GROUP BY tool_key
    `;

    const byTool: Record<string, { runs: number; succeeded: number; refunded: number; revenue: number; cost: number; profit: number }> = {};
    const byProvider: Record<string, { runs: number; succeeded: number; refunded: number; revenue: number; cost: number; profit: number }> = {};
    let totalRuns = 0;
    let totalSucceeded = 0;
    let totalRefunded = 0;
    let totalRevenue = 0;
    let totalCost = 0;

    for (const r of rows) {
      if (!r.tool_key) continue;
      const rev = Math.round(Number(r.revenue) || 0);
      const cst = Math.round(Number(r.cost) || 0);
      const item = {
        runs: Number(r.runs) || 0,
        succeeded: Number(r.succeeded) || 0,
        refunded: Number(r.refunded) || 0,
        revenue: rev,
        cost: cst,
        profit: rev - cst,
      };
      byTool[hide ? publicToolKey(r.tool_key) : r.tool_key] = item;
      if (!hide) {
        const provKey = r.tool_key.split('.')[0];
        if (provKey) {
          const cur = byProvider[provKey] ?? { runs: 0, succeeded: 0, refunded: 0, revenue: 0, cost: 0, profit: 0 };
          cur.runs += item.runs;
          cur.succeeded += item.succeeded;
          cur.refunded += item.refunded;
          cur.revenue += item.revenue;
          cur.cost += item.cost;
          cur.profit = cur.revenue - cur.cost;
          byProvider[provKey] = cur;
        }
      }
      totalRuns += item.runs;
      totalSucceeded += item.succeeded;
      totalRefunded += item.refunded;
      totalRevenue += item.revenue;
      totalCost += item.cost;
    }

    return {
      from: period === 'all' ? 'all' : fmtVnDay(startMs),
      to: fmtVnDay(endMs - DAY),
      totals: {
        runs: totalRuns,
        succeeded: totalSucceeded,
        refunded: totalRefunded,
        revenue: totalRevenue,
        cost: totalCost,
        profit: totalRevenue - totalCost,
      },
      byTool,
      ...(hide ? {} : { byProvider }),
    };
  }

  /**
   * Xoá công cụ (kèm các model con `<khoá>~<model>` nếu là công cụ gốc đã tách).
   * - Dòng chưa có tác vụ và adapter không còn khai báo: xoá hẳn.
   * - Còn lại: giữ dòng để lịch sử tác vụ của khách vẫn mở được và đồng bộ không tạo lại -> tắt, bỏ khỏi nhóm model,
   *   đánh dấu `options.deleted` (ẩn khỏi admin, xem isDeletedTool).
   */
  async deleteTool(key: string) {
    const rows = await this.prisma.aiTool.findMany({
      where: { OR: [{ key }, { key: { startsWith: `${key}${MODEL_SEP}` } }] },
      include: { _count: { select: { tasks: true } } },
    });
    if (!rows.some((r) => r.key === key && !isDeletedTool(r.options))) throw new NotFoundException('Không tìm thấy công cụ');
    const hard = rows.filter((r) => !(r._count.tasks + archivedRunsOf(r.options)) && !this.resolve(r.key)).map((r) => r.key);
    const soft = rows.filter((r) => !hard.includes(r.key));
    await this.prisma.$transaction([
      ...(hard.length ? [this.prisma.aiTool.deleteMany({ where: { key: { in: hard } } })] : []),
      ...soft.map((r) =>
        this.prisma.aiTool.update({
          where: { key: r.key },
          data: { enabled: false, featured: false, modelGroups: [], options: { ...((r.options ?? {}) as Record<string, unknown>), deleted: true } as object },
        }),
      ),
    ]);
    void this.refreshPrices();
    return { deleted: rows.length, removed: hard.length, hidden: soft.length };
  }

  /** Công cụ admin đã xoá (đang ẩn) — hộp "Đã xoá" ở Công cụ AI để khôi phục kèm giá vốn & thông tin chuẩn hoá nhận định giá (T-470) */
  async adminDeletedTools(user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const rows = await this.prisma.aiTool.findMany({
      orderBy: [{ provider: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { tasks: true } } },
    });
    const deleted = rows.filter((r) => isDeletedTool(r.options) && !RETIRED_PROVIDERS.has(r.provider) && this.resolve(r.key));

    const priceMap = new Map<string, { credits: number | null; providerCost: number | null; benchCost: number | null }>();
    if (!hide && deleted.length) {
      const byProv = new Map<string, { row: AiTool; provider: AiProvider; def: AiToolDef }[]>();
      for (const r of deleted) {
        const res = this.resolve(r.key);
        if (!res) continue;
        byProv.set(res.provider.key, [...(byProv.get(res.provider.key) ?? []), { row: r, ...res }]);
      }
      const rawCostOf = (qRes: { credits: number | null; providerCost: number | null }, def: AiToolDef, row: AiTool): number | null => {
        if (qRes.credits === null || !Number.isFinite(qRes.credits)) return null;
        if (qRes.credits <= 0) return 0;
        if (qRes.providerCost !== null && Number.isFinite(qRes.providerCost) && qRes.providerCost > 0) {
          return Math.round(qRes.providerCost * 100) / 100;
        }
        const p = this.pricingOf(def, row);
        const mk = Math.max(0, Number(p.markup) || 0);
        return Math.round((qRes.credits / (1 + mk / 100)) * 100) / 100;
      };
      const evalOne = async ({ row, provider, def }: { row: AiTool; provider: AiProvider; def: AiToolDef }, ctx: AiCallContext) => {
        try {
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 12_000));
          const defIn: AiInput = { ...defaultInput(def.fields), __sample: true };
          const qRes = await Promise.race([this.quoteDetail(provider, def, row, defIn, ctx), timeout]);
          let benchCost = rawCostOf(qRes, def, row);
          if (def.output === 'video') {
            const nextIn: AiInput = { ...defIn };
            let changed = false;
            for (const f of def.fields) {
              if (f.type !== 'select') continue;
              const opts = f.optionsBy ? f.optionsBy.map[String(nextIn[f.optionsBy.field] ?? '')] ?? f.options : f.options;
              if (!opts?.length) continue;
              if (opts.some((o) => /^\d+\|\d+p$/i.test(String(o.value)))) {
                const hit = ['5|720p', '8|720p', '6|720p', '10|720p'].map((v) => opts.find((o) => String(o.value).toLowerCase() === v)).find(Boolean);
                if (hit && nextIn[f.name] !== hit.value) {
                  nextIn[f.name] = hit.value;
                  changed = true;
                }
                continue;
              }
              const fn = f.name.toLowerCase();
              if (fn === 'resolution' || fn === 'quality' || fn === 'res') {
                const hit720 = opts.find((o) => String(o.value).toLowerCase() === '720p') ?? opts.find((o) => /\b720p\b/i.test(o.label));
                if (hit720 && nextIn[f.name] !== hit720.value) {
                  nextIn[f.name] = hit720.value;
                  changed = true;
                }
              } else if (fn === 'duration' || fn === 'seconds' || fn === 'dur') {
                const hitDur = ['5', '5s', '8', '8s', '6', '6s'].map((v) => opts.find((o) => String(o.value).toLowerCase() === v)).find(Boolean);
                if (hitDur && nextIn[f.name] !== hitDur.value) {
                  nextIn[f.name] = hitDur.value;
                  changed = true;
                }
              }
            }
            if (changed) {
              const bRes = await this.quoteDetail(provider, def, row, { ...nextIn, __sample: true }, ctx).catch(() => null);
              if (bRes) {
                const bc = rawCostOf(bRes, def, row);
                if (bc !== null && bc > 0) benchCost = bc;
              }
            }
          }
          priceMap.set(row.key, { credits: qRes.credits, providerCost: qRes.providerCost, benchCost });
        } catch {
          priceMap.set(row.key, { credits: null, providerCost: null, benchCost: null });
        }
      };
      await Promise.all(
        [...byProv.entries()].map(async ([pKey, items]) => {
          const ctx = await this.ctx(pKey);
          await evalOne(items[0], ctx);
          await Promise.all(items.slice(1).map((it) => evalOne(it, ctx)));
        }),
      );
    }

    return deleted.map((r) => {
      const resolved = this.resolve(r.key);
      const childModels = rows.filter((x) => x.key.startsWith(`${r.key}${MODEL_SEP}`)).length;
      const apiTail = r.key.replace(/^[^.]+\./, '').replace(/~/g, '/');
      const canonicalModel = hide ? null : canonicalModelSlug(apiTail, r.modelLabel || r.name, r.category);
      const pr = priceMap.get(r.key);
      return {
        key: hide ? publicToolKey(r.key) : r.key,
        name: hide ? hideProviderText(r.name) : r.name,
        provider: hide ? '' : r.provider,
        badge: r.badge ?? (hide ? null : providerDefaultBadge(r.provider)),
        category: r.category,
        output: resolved?.def.output ?? null,
        modelGroups: r.modelGroups ?? [],
        modelLabel: hide ? hideProviderText(r.modelLabel) : r.modelLabel,
        canonicalModel,
        models: childModels,
        pricing: (r.pricing as object) ?? {},
        defaultPricing: resolved?.def.pricing ?? null,
        credits: hide ? null : (pr?.credits ?? null),
        providerCost: hide ? null : (pr?.providerCost ?? null),
        benchCost: hide ? null : (pr?.benchCost ?? null),
        tasks: r._count.tasks + archivedRunsOf(r.options),
        updatedAt: r.updatedAt,
      };
    });
  }

  /**
   * Khôi phục công cụ đã xoá (kèm model con đã xoá cùng). Công cụ hiện lại trong admin ở trạng thái TẮT,
   * admin xem giá rồi tự bật; nhóm model đã bị bỏ lúc xoá nên công cụ đứng riêng cho tới khi admin gộp lại.
   */
  async restoreTool(key: string) {
    const rows = await this.prisma.aiTool.findMany({ where: { OR: [{ key }, { key: { startsWith: `${key}${MODEL_SEP}` } }] } });
    const targets = rows.filter((r) => isDeletedTool(r.options) && this.resolve(r.key));
    if (!targets.some((r) => r.key === key)) throw new NotFoundException('Không tìm thấy công cụ đã xoá');
    await this.prisma.$transaction(
      targets.map((r) => {
        const { deleted: _deleted, ...options } = (r.options ?? {}) as Record<string, unknown>;
        return this.prisma.aiTool.update({ where: { key: r.key }, data: { enabled: false, options: options as object } });
      }),
    );
    void this.refreshPrices();
    return { restored: targets.length };
  }

  async updateTool(key: string, dto: UpdateToolDto) {
    const row = await this.prisma.aiTool.findUnique({ where: { key } });
    if (!row || isDeletedTool(row.options)) throw new NotFoundException('Không tìm thấy công cụ');
    // nhóm phải nằm trong danh sách nhóm admin quản lý (AI Studio › Công cụ AI › Nhóm)
    if (dto.category !== undefined && dto.category !== row.category) await this.categories.assertExists(dto.category);
    // không cho chọn "theo chi phí NCC" cho công cụ adapter không tính được chi phí (khách sẽ không chạy được)
    const r = this.resolve(key);
    if (dto.pricing?.mode === 'cost' && r && !supportsCost(r.provider, r.def)) throw new BadRequestException('Công cụ này chưa hỗ trợ tính giá theo chi phí nhà cung cấp');
    if (dto.pricing?.mode === 'per_second' && r && !supportsPerSecond(r.def)) throw new BadRequestException('Công cụ này không có thời lượng để tính giá theo giây');
    if (dto.pricing?.resolutionPrices !== undefined) {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(dto.pricing.resolutionPrices ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) clean[k] = n;
      }
      dto.pricing.resolutionPrices = clean;
    }
    if (dto.pricing?.mode === 'per_second' && (Number(dto.pricing.perUnit) || 0) <= 0) {
      // không có giá chung thì mọi độ phân giải phải có giá mỗi giây riêng
      const opts = r ? resolutionOptionsOf(r.def) : [];
      const map = dto.pricing.resolutionPrices ?? {};
      if (!opts.length || opts.some((o) => (Number(map[o.value]) || 0) <= 0)) throw new BadRequestException('Vui lòng nhập giá mỗi giây lớn hơn 0đ');
    }
    if (dto.pricing?.mode === 'by_resolution') {
      const opts = r ? resolutionOptionsOf(r.def) : [];
      if (!opts.length) throw new BadRequestException('Công cụ này không có lựa chọn độ phân giải để tính giá');
      const map = dto.pricing.resolutionPrices ?? {};
      if (opts.some((o) => (Number(map[o.value]) || 0) <= 0)) {
        throw new BadRequestException('Vui lòng nhập giá lớn hơn 0đ cho tất cả các mức độ phân giải');
      }
    }
    const resolvedDemo =
      dto.demoVideo !== undefined ? (dto.demoVideo.trim() ? await this.files.mirrorDemoUrl(dto.demoVideo.trim()) : '') : undefined;
    const sanitizedName = dto.name !== undefined ? sanitizeToolDisplayName(dto.name) : undefined;
    const sanitizedModelLabel =
      dto.modelLabel !== undefined ? (dto.modelLabel?.trim() ? sanitizeToolDisplayName(dto.modelLabel) : null) : undefined;
    const sanitizedGroups =
      dto.modelGroups !== undefined
        ? [...new Set(dto.modelGroups.map((g) => sanitizeToolDisplayName(g)).filter(Boolean))]
        : undefined;
    const sanitizedDesc =
      dto.description !== undefined
        ? dto.description?.trim()
          ? hideProviderText(dto.description.trim())
          : r
            ? buildDetailedModelDescription(
                r.def,
                key,
                sanitizedName ?? row.name,
                sanitizedModelLabel !== undefined ? sanitizedModelLabel : row.modelLabel,
              )
            : null
        : undefined;
    const descClearedToAuto = dto.description !== undefined && !dto.description?.trim();
    const descEditedManually =
      dto.description !== undefined && Boolean(dto.description?.trim()) && sanitizedDesc !== row.description;
    const nameEditedManually =
      (sanitizedName !== undefined && sanitizedName !== row.name) ||
      (sanitizedModelLabel !== undefined && sanitizedModelLabel !== row.modelLabel);
    const nextOptions = (() => {
      if (resolvedDemo === undefined && dto.maintenance === undefined && !nameEditedManually && !descEditedManually && !descClearedToAuto) return undefined;
      const base = { ...((row.options ?? {}) as Record<string, unknown>) };
      if (resolvedDemo !== undefined) {
        if (resolvedDemo) base.demoVideo = resolvedDemo;
        else delete base.demoVideo;
      }
      if (dto.maintenance !== undefined) {
        if (dto.maintenance) base.maintenance = true;
        else {
          delete base.maintenance;
          delete base.autoMaintenance;
          delete base.autoMaintainedAt;
        }
      }
      if (nameEditedManually) {
        base.customName = true;
      }
      if (descEditedManually) {
        base.customDesc = true;
      } else if (descClearedToAuto) {
        delete base.customDesc;
        if (sanitizedDesc) base.lastSyncedDesc = sanitizedDesc;
      }
      return base;
    })();
    const updated = await this.prisma.aiTool.update({
      where: { key },
      data: {
        ...(sanitizedName !== undefined ? { name: sanitizedName } : {}),
        ...(sanitizedDesc !== undefined ? { description: sanitizedDesc } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon || null } : {}),
        ...(dto.badge !== undefined ? { badge: dto.badge?.trim() || null } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.featured !== undefined ? { featured: dto.featured } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.pricing !== undefined ? { pricing: dto.pricing as object } : {}),
        // mảng rỗng = bỏ khỏi mọi nhóm model; bỏ tên trống / trùng; để trống tên model = dùng tên công cụ
        ...(sanitizedGroups !== undefined ? { modelGroups: sanitizedGroups } : {}),
        ...(sanitizedModelLabel !== undefined ? { modelLabel: sanitizedModelLabel } : {}),
        ...(nextOptions !== undefined ? { options: nextOptions as object } : {}),
      },
    });
    // đồng bộ cùng video mẫu cho cả nhóm model (theo tên nhóm cụ thể `applyDemoGroup` hoặc mọi nhóm của công cụ)
    const targetGroup = dto.applyDemoGroup?.trim();
    if (resolvedDemo !== undefined && (targetGroup || (dto.applyDemoToGroup && updated.modelGroups.length))) {
      const cleaned = resolvedDemo;
      const siblings = await this.prisma.aiTool.findMany({
        where: targetGroup
          ? { key: { not: key }, modelGroups: { has: targetGroup } }
          : { key: { not: key }, modelGroups: { hasSome: updated.modelGroups } },
        select: { key: true, options: true },
      });
      if (siblings.length) {
        await this.prisma.$transaction(
          siblings.map((s) => {
            const opts = { ...((s.options ?? {}) as Record<string, unknown>) };
            if (cleaned) opts.demoVideo = cleaned;
            else delete opts.demoVideo;
            return this.prisma.aiTool.update({ where: { key: s.key }, data: { options: opts as object } });
          }),
        );
      }
    }
    // admin đổi giá / bật công cụ: tính lại bảng giá mặc định ở nền để website xếp model theo giá mới
    if (dto.pricing !== undefined || dto.enabled !== undefined) void this.refreshPrices();
    return updated;
  }

  /**
   * Đặt lại thứ tự các công cụ theo đúng thứ tự `keys` (kéo thả nhóm model ở admin).
   * Giữ "khoảng" thứ tự cũ: sortOrder mới bắt đầu từ sortOrder nhỏ nhất của nhóm công cụ được gửi lên,
   * nên công cụ không nằm trong danh sách (nhóm khác) không bị xáo trộn. Chạy trong 1 transaction.
   */
  async reorderTools(keys: string[]) {
    const list = [...new Set(keys)];
    const rows = await this.prisma.aiTool.findMany({ where: { key: { in: list } }, select: { key: true, sortOrder: true } });
    if (rows.length !== list.length) throw new BadRequestException('Có công cụ không tồn tại');
    const base = Math.min(...rows.map((r) => r.sortOrder));
    const cur = new Map(rows.map((r) => [r.key, r.sortOrder]));
    // chỉ ghi công cụ có thứ tự thay đổi
    const ops = list.flatMap((key, i) => (cur.get(key) === base + i ? [] : [this.prisma.aiTool.update({ where: { key }, data: { sortOrder: base + i } })]));
    if (ops.length) await this.prisma.$transaction(ops);
    return { updated: ops.length };
  }

  /** Bật / tắt chế độ bảo trì hàng loạt cho danh sách công cụ (kèm model con nếu chọn công cụ gốc đã tách) */
  async bulkMaintenanceTools(keys: string[], maintenance: boolean) {
    const list = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
    if (!list.length) return { updated: 0 };
    const parentPrefixes = list.filter((k) => !k.includes(MODEL_SEP)).map((k) => `${k}${MODEL_SEP}`);
    const rows = await this.prisma.aiTool.findMany({
      where: {
        OR: [
          { key: { in: list } },
          ...parentPrefixes.map((p) => ({ key: { startsWith: p } })),
        ],
      },
      select: { key: true, options: true },
    });
    const targets = rows.filter((r) => !isDeletedTool(r.options));
    if (targets.length) {
      await this.prisma.$transaction(
        targets.map((r) => {
          const opts = { ...((r.options ?? {}) as Record<string, unknown>) };
          if (maintenance) opts.maintenance = true;
          else {
            delete opts.maintenance;
            delete opts.autoMaintenance;
            delete opts.autoMaintainedAt;
          }
          return this.prisma.aiTool.update({ where: { key: r.key }, data: { options: opts as object } });
        }),
      );
    }
    return { updated: targets.length };
  }

  /** Số dư tài khoản ở nhà cung cấp (nút "Kiểm tra kết nối" trong admin) */
  async providerBalance(key: string, user?: AuthUser) {
    if (shouldHideAiProviders(user)) throw new ForbiddenException('Chỉ quản lý nguồn trên website chính');
    const p = this.providers.get(key);
    if (!p) throw new NotFoundException('Không tìm thấy nhà cung cấp');
    if (!p.balance) return { supported: false };
    try {
      const ctx = await this.ctx(key);
      const b = await p.balance(ctx);
      if (b) return { supported: true, ok: true, ...b };
      if (p.costUnit) {
        const ledger = await this.computeManualCreditLedger(p, ctx.config);
        return { supported: true, ok: true, ...ledger };
      }
      return { supported: false };
    } catch (err) {
      return { supported: true, ok: false, error: (err as Error).message };
    }
  }

  /**
   * Sổ cái theo dõi tự động số dư credit cho nguồn không mở endpoint số dư qua Developer API Key (vd SV17 PlenxAI khi chưa dán token phiên web):
   * Lấy mốc `manualCredits` do Admin nhập trừ tự động chi phí gốc thực tế của mọi đơn hoàn thành kể từ `manualCreditsAt`.
   */
  private async computeManualCreditLedger(provider: AiProvider, cfg: AiProviderConfig) {
    const rawManual = (cfg as Record<string, unknown>).manualCredits;
    const baseCredits = Number.isFinite(Number(rawManual)) ? Math.max(0, Number(rawManual)) : 0;
    const rawSince = (cfg as Record<string, unknown>).manualCreditsAt;
    const sinceDate =
      typeof rawSince === 'string' && rawSince.trim() && Number.isFinite(Date.parse(rawSince))
        ? new Date(rawSince).toISOString()
        : null;
    const effRate = providerRate(provider, cfg);

    let usedCredits = 0;
    if (baseCredits > 0 && effRate > 0) {
      const prefix = `${provider.key}.%`;
      const rows = await this.prisma.$queryRawUnsafe<{ spent_cost: number }[]>(
        `
        SELECT COALESCE(SUM(
          CASE
            WHEN (ct.meta::jsonb->>'providerCost') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (ct.meta::jsonb->>'providerCost')::numeric
            ELSE 0::numeric
          END
        ), 0)::float AS spent_cost
        FROM credit_transactions ct
        LEFT JOIN ai_tasks t ON t.id = ct."taskId"
        WHERE ct.type = 'USAGE'
          AND COALESCE(t."toolKey", ct.meta::jsonb->>'toolKey', '') LIKE $1
          AND ($2::timestamptz IS NULL OR ct."createdAt" >= $2::timestamptz)
          AND COALESCE(t.refunded, false) = false
          AND NOT EXISTS (
            SELECT 1 FROM credit_transactions r
            WHERE r.type = 'REFUND'
              AND (
                (ct."taskId" IS NOT NULL AND r."taskId" = ct."taskId")
                OR (ct."idempotencyKey" LIKE 'usage:%' AND r."idempotencyKey" = 'refund:' || substr(ct."idempotencyKey", 7))
              )
          )
        `,
        prefix,
        sinceDate,
      );
      const spentVnd = Number(rows[0]?.spent_cost) || 0;
      usedCredits = spentVnd / effRate;
    }

    return {
      balance: Math.max(0, Math.round((baseCredits - usedCredits) * 100) / 100),
      unit: provider.costUnit || 'credit',
      manualLedger: true,
    };
  }

  /** Danh mục model / workflow nhà cung cấp đang bán (null = adapter không hỗ trợ); lỗi gọi API thì ném */
  async providerCatalog(key: string) {
    const p = this.providers.get(key);
    if (!p) throw new NotFoundException('Không tìm thấy nhà cung cấp');
    return p.catalog ? p.catalog(await this.ctx(key)) : null;
  }

  async adminTasks(q: AdminTaskQueryDto, user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const matchedToolKeys = search
      ? (
          await this.prisma.aiTool.findMany({
            select: { key: true, name: true, modelLabel: true, modelGroups: true, badge: true, provider: true },
          })
        )
          .filter((t) => {
            const safeKey = hide ? publicToolKey(t.key) : t.key;
            return matchesAiSearchParts(
              [
                t.name,
                t.modelLabel,
                safeKey,
                t.badge,
                ...t.modelGroups,
                !hide ? providerDisplayLabel(t.provider) : '',
                !hide ? t.provider : '',
              ],
              search,
            );
          })
          .map((t) => t.key)
      : [];
    const stuckCutoff = new Date(Date.now() - 30 * 60_000);
    const isStuckFilter = q.status === 'STUCK';
    const dayRange = q.day ? vnDayRange(q.day) : undefined;
    const baseFilterWhere: Prisma.AiTaskWhereInput = {
      ...(q.tool ? { toolKey: internalToolKey(q.tool) } : {}),
      ...(!hide && q.provider ? { provider: q.provider } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.visibility === 'public' ? { isPublic: true } : q.visibility === 'blocked' ? { publicBlocked: true } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search.toUpperCase() } },
              ...(!hide ? [{ providerTaskId: { contains: search, mode: 'insensitive' as const } }, { toolKey: { contains: search, mode: 'insensitive' as const } }] : []),
              { tool: { name: { contains: search, mode: 'insensitive' } } },
              ...(matchedToolKeys.length ? [{ toolKey: { in: matchedToolKeys } }] : []),
              { user: { email: { contains: search, mode: 'insensitive' } } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const stuckCreatedAt = { ...(dayRange ?? {}), lte: dayRange && dayRange.lt < stuckCutoff ? dayRange.lt : stuckCutoff };
    const where: Prisma.AiTaskWhereInput = {
      ...baseFilterWhere,
      ...(isStuckFilter
        ? { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: stuckCreatedAt }
        : {
            ...(q.status ? { status: q.status as AiTask['status'] } : {}),
            ...(dayRange ? { createdAt: dayRange } : {}),
          }),
    };
    const countBaseWhere: Prisma.AiTaskWhereInput = {
      ...baseFilterWhere,
      ...(dayRange ? { createdAt: dayRange } : {}),
    };
    // Quét nhẹ cột vô hướng (không đọc JSONB input/output từ DB cho các đơn đã cache) -> chuyển tab & cập nhật realtime < 5ms (T-286, T-289)
    const scanMeta = await this.prisma.aiTask.findMany({
      where: countBaseWhere,
      select: { id: true, status: true, createdAt: true, provider: true, isPublic: true, publicBlocked: true },
    });
    const statusCounts: Record<string, number> = {};
    let stuckCount = 0;
    let total = 0;
    let publicCount = 0;
    let blockedCount = 0;
    const providerCounts = new Map<string, number>();

    const matchesStatusTab = (c: { status: AiTask['status']; createdAt: Date }) => {
      if (isStuckFilter) {
        return (c.status === 'PENDING' || c.status === 'PROCESSING') && c.createdAt <= stuckCreatedAt.lte;
      }
      if (q.status) return c.status === q.status;
      return true;
    };

    for (const c of scanMeta) {
      if (!hide) {
        providerCounts.set(c.provider, (providerCounts.get(c.provider) ?? 0) + 1);
      }
      const inStatusTab = matchesStatusTab(c);
      statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
      if ((c.status === 'PENDING' || c.status === 'PROCESSING') && c.createdAt <= stuckCreatedAt.lte) {
        stuckCount++;
      }
      if (inStatusTab) {
        total++;
        if (c.isPublic) publicCount++;
        if (c.publicBlocked) blockedCount++;
      }
    }

    const extractDemo = (options: unknown) => this.publicDemoUrl(options, hide);
    const rawRows =
      total === 0 || skip >= total
        ? []
        : await this.prisma.aiTask.findMany({
            where,
            orderBy: { createdAt: isStuckFilter ? 'asc' : 'desc' },
            skip,
            take,
            include: { user: { select: { id: true, name: true, email: true } }, tool: { select: { name: true, options: true } } },
          });
    const rows = rawRows.map((r) => {
      const tool = r.tool ? { name: hide ? hideProviderText(r.tool.name) : r.tool.name, demoVideo: extractDemo(r.tool.options) } : null;
      if (!hide) {
        return {
          ...r,
          providerLabel: providerDisplayLabel(r.provider),
          providerDomain: providerCleanDomain(r.provider),
          tool,
          violation: null,
          autoCheck: extractTaskAutoCheck(r.output),
          upstreamCancel: extractTaskUpstreamCancel(r.output),
          stuckCheck: extractTaskStuckCheck(r.output),
          upstreamLive: extractTaskUpstreamLive(r),
        };
      }
      const { providerData: _pd, ...rest } = r;
      return {
        ...rest,
        toolKey: publicToolKey(r.toolKey),
        provider: '',
        providerLabel: '',
        providerDomain: '',
        providerTaskId: null,
        error: hideProviderText(r.error),
        output: this.publicOutput(r.id, r.output),
        tool,
        violation: null,
        autoCheck: null,
        upstreamCancel: null,
        stuckCheck: null,
        upstreamLive: null,
      };
    });
    // ô lọc "Nguồn" trên trang admin: mọi nhà cung cấp đã có tác vụ, kèm tên miền gọn không có http (ẩn hoàn toàn trên Web con / CTV — T-483, T-484)
    const providers = hide
      ? []
      : [...providerCounts.entries()]
          .map(([key, count]) => ({
            key,
            name: providerDisplayLabel(key),
            count,
          }))
          .sort((a, b) => b.count - a.count);

    // T-434: Khi Admin tìm kiếm mã đơn / email trên Web mẹ, tự gộp cả đơn khớp trên các Web con để bấm Hoàn 1 chạm ngay trên Web mẹ
    let mergedRows: any[] = rows;
    let mergedTotal = total;
    if (!isChildSite() && !hide && search && page === 1) {
      const childSites = await this.discoverChildSitesForTasks();
      if (childSites.length) {
        const childMatches = await Promise.all(
          childSites.map(async (child) => {
            try {
              const qs = new URLSearchParams({ q: search, ...(q.status && q.status !== 'STUCK' ? { status: q.status } : {}) });
              const res = await fetch(`${child.apiBase}/api/internal/hub-tickets/tasks-search?${qs.toString()}`, {
                headers: { Accept: 'application/json', 'X-Server-Secret': child.serverSecret },
                signal: AbortSignal.timeout(4_000),
              });
              if (!res.ok) return [];
              const body = (await res.json()) as { items?: any[] };
              return (body.items ?? []).map((it) => ({
                ...it,
                providerLabel: typeof it.provider === 'string' && it.provider ? providerDisplayLabel(it.provider) : '',
                providerDomain: typeof it.provider === 'string' && it.provider ? providerCleanDomain(it.provider) : '',
                id: `${child.code}__${it.id}`,
                rawId: it.id,
                siteCode: child.code,
                siteDomain: child.domain,
                isFromChildSite: true,
              }));
            } catch {
              return [];
            }
          }),
        );
        const flatChild = childMatches.flat();
        if (flatChild.length) {
          mergedRows = [...rows, ...flatChild].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
          mergedTotal = total + flatChild.length;
        }
      }
    }

    return {
      ...paginate(mergedRows, mergedTotal, page, limit),
      hideProviders: hide,
      counts: { ...statusCounts, STUCK: stuckCount },
      visibility: { public: publicCount, blocked: blockedCount },
      providers,
    };
  }

  private childSitesTaskCache: {
    at: number;
    items: { code: string; domain: string; apiBase: string; serverSecret: string }[];
  } | null = null;

  private async discoverChildSitesForTasks() {
    if (isChildSite()) return [];
    if (this.childSitesTaskCache && Date.now() - this.childSitesTaskCache.at < 30_000) {
      return this.childSitesTaskCache.items;
    }
    const sitesDir = process.env.NOVAI_SITES_DIR || '/var/www/novai-sites';
    const items: { code: string; domain: string; apiBase: string; serverSecret: string }[] = [];
    try {
      const entries = await readdir(sitesDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const code = ent.name.trim();
        if (!/^[a-z0-9_-]{1,40}$/i.test(code)) continue;
        try {
          const raw = await readFile(join(sitesDir, code, 'env.json'), 'utf8');
          const parsed = JSON.parse(raw) as {
            api?: { PORT?: string | number; API_PUBLIC_URL?: string; WEB_URL?: string; SERVER_API_SECRET?: string };
          };
          const port = Number(parsed.api?.PORT);
          const serverSecret = String(parsed.api?.SERVER_API_SECRET ?? '').trim();
          const publicOrigin = String(parsed.api?.API_PUBLIC_URL || parsed.api?.WEB_URL || '').replace(/\/$/, '');
          if (!port || !serverSecret || !publicOrigin) continue;
          items.push({
            code,
            domain: publicOrigin.replace(/^https?:\/\//, ''),
            apiBase: `http://127.0.0.1:${port}`,
            serverSecret,
          });
        } catch {
          /* bỏ qua */
        }
      }
    } catch {
      /* dev local */
    }
    this.childSitesTaskCache = { at: Date.now(), items };
    return items;
  }

  private parseAdminTaskId(rawId: string): { siteCode: string; taskId: string } {
    const clean = (rawId ?? '').trim();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const sepIdx = clean.indexOf('__');
    if (sepIdx > 0) {
      const siteCode = clean.slice(0, sepIdx).toLowerCase();
      const taskId = clean.slice(sepIdx + 2);
      if (/^[a-z0-9_-]{1,40}$/i.test(siteCode) && uuidRe.test(taskId)) {
        return { siteCode, taskId };
      }
    }
    if (!uuidRe.test(clean)) throw new BadRequestException('Mã định danh tác vụ không hợp lệ');
    return { siteCode: 'main', taskId: clean };
  }

  /**
   * T-434 + T-436: Khi hoàn một đơn trên Web mẹ, tự động quét & hoàn luôn mọi đơn con tương ứng trên các Web con
   * (khớp chính xác theo `parentCode` / `parentId` / `providerTaskId` — không khớp theo email khách để giữ độc lập T-435,
   * và dùng khoá `refund:<childId>` chống hoàn lặp 100%).
   */
  private async cascadeRefundToChildSites(t: Pick<AiTask, 'id' | 'code' | 'providerTaskId' | 'output'>, reason?: string) {
    if (isChildSite()) return [];
    const children = await this.discoverChildSitesForTasks();
    if (!children.length) return [];

    const cascaded: { siteDomain: string; code: string; credits: number }[] = [];
    await Promise.all(
      children.map(async (child) => {
        try {
          const res = await fetch(`${child.apiBase}/api/internal/hub-tickets/tasks/cascade-refund`, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Server-Secret': child.serverSecret,
            },
            body: JSON.stringify({
              parentId: t.id,
              parentCode: t.code,
              providerTaskId: t.providerTaskId || undefined,
              reason: reason || `Đơn gốc #${t.code} trên hệ thống tổng đã được hoàn tiền`,
            }),
            signal: AbortSignal.timeout(6_000),
          });
          if (!res.ok) return;
          const body = (await res.json()) as { refundedTasks?: { id: string; code: string; credits: number }[] };
          for (const rt of body.refundedTasks ?? []) {
            cascaded.push({ siteDomain: child.domain, code: rt.code, credits: rt.credits });
          }
        } catch {
          /* không chặn luồng chính nếu 1 web con đang khởi động lại */
        }
      }),
    );

    if (cascaded.length) {
      const prevOut = t.output && typeof t.output === 'object' ? (t.output as Record<string, unknown>) : {};
      await this.prisma.aiTask
        .update({
          where: { id: t.id },
          data: {
            output: {
              ...prevOut,
              __childCascadeRefund: {
                at: new Date().toISOString(),
                items: cascaded,
              },
            } as object,
          },
        })
        .catch(() => undefined);
    }
    return cascaded;
  }

  async adminTask(rawId: string, user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const { siteCode, taskId: id } = this.parseAdminTaskId(rawId);
    if (siteCode !== 'main' && !isChildSite() && !hide) {
      const children = await this.discoverChildSitesForTasks();
      const child = children.find((c) => c.code === siteCode);
      if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
      const res = await fetch(`${child.apiBase}/api/internal/hub-tickets/tasks/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json', 'X-Server-Secret': child.serverSecret },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) throw new NotFoundException('Không tìm thấy tác vụ trên web con');
      const d = (await res.json()) as Record<string, unknown>;
      const childProv = typeof d.provider === 'string' ? d.provider : '';
      return {
        ...d,
        providerLabel: childProv ? providerDisplayLabel(childProv) : '',
        providerDomain: childProv ? providerCleanDomain(childProv) : '',
        id: `${child.code}__${id}`,
        rawId: id,
        siteCode: child.code,
        siteDomain: child.domain,
        isFromChildSite: true,
      };
    }
    const t = await this.prisma.aiTask.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true } }, tool: { select: { name: true, options: true } }, creditTxns: { orderBy: { createdAt: 'asc' } } } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    const demoVideo = this.publicDemoUrl(t.tool?.options, hide);
    if (!hide) {
      return {
        ...t,
        providerLabel: providerDisplayLabel(t.provider),
        providerDomain: providerCleanDomain(t.provider),
        hideProviders: false,
        violation: null,
        autoCheck: extractTaskAutoCheck(t.output),
        upstreamCancel: extractTaskUpstreamCancel(t.output),
        stuckCheck: extractTaskStuckCheck(t.output),
        upstreamLive: extractTaskUpstreamLive(t),
        tool: t.tool ? { name: t.tool.name, demoVideo } : null,
      };
    }
    return {
      ...t,
      hideProviders: true,
      violation: null,
      autoCheck: null,
      upstreamCancel: null,
      stuckCheck: null,
      upstreamLive: null,
      toolKey: publicToolKey(t.toolKey),
      provider: '',
      providerLabel: '',
      providerDomain: '',
      providerTaskId: null,
      providerData: null,
      error: hideProviderText(t.error),
      output: this.publicOutput(t.id, t.output),
      tool: t.tool ? { name: hideProviderText(t.tool.name), demoVideo } : null,
      creditTxns: t.creditTxns.map((c) => ({ ...c, note: hideProviderText(c.note) })),
    };
  }

  /** Admin đánh dấu vi phạm thủ công (Nude/Sex, KYC, Vi phạm pháp luật) hoặc gỡ cảnh báo nhầm — chỉ hiện trên Admin web gốc nov.ai.vn (T-273, T-281, T-289, T-290) */
  async adminFlagViolation(id: string, dto: FlagTaskViolationDto, actor: AuthUser) {
    if (shouldHideAiProviders(actor)) throw new ForbiddenException('Chỉ quản trị viên website chính mới được gắn hoặc gỡ tag kiểm tra nội bộ');
    const t = await this.prisma.aiTask.findUnique({ where: { id }, select: { id: true, output: true } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    const review: StoredViolationReview = {
      status: dto.status,
      category: dto.status === 'flagged' ? (dto.category ?? 'nsfw') : undefined,
      note: dto.note?.trim() || undefined,
      actorId: actor.id,
      updatedAt: new Date().toISOString(),
    };
    const nextOutput = {
      ...(((t.output as Record<string, unknown> | null) ?? {})),
      __violationReview: review,
    };
    await this.prisma.aiTask.update({
      where: { id },
      data: {
        output: nextOutput as object,
      },
    });
    this.taskViolationCache.delete(id);
    this.events.emit('activity', {
      userId: actor.id,
      action: dto.status === 'flagged' ? 'ai.task_flagged_violation' : 'ai.task_dismissed_violation',
      entityType: 'ai_task',
      entityId: id,
    });
    return this.adminTask(id, actor);
  }

  /** Admin xác nhận vi phạm thực sự -> thu hồi đơn & xoá kết quả đầu ra nhưng KHÔNG hoàn tiền cho khách (T-281, T-289) */
  async adminRevokeViolation(id: string, actor: AuthUser, reason?: string) {
    if (shouldHideAiProviders(actor)) throw new ForbiddenException('Chỉ quản trị viên website chính mới được thu hồi đơn vi phạm');
    const t = await this.prisma.aiTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    const prevOut = ((t.output as Record<string, unknown> | null) ?? {});
    const existingReview = extractStoredViolationReview(prevOut);
    const review: StoredViolationReview = existingReview?.status === 'flagged'
      ? existingReview
      : {
          status: 'flagged',
          category: inspectTaskViolation(t)?.categories[0] ?? 'illegal',
          actorId: actor.id,
          updatedAt: new Date().toISOString(),
        };
    const msg = reason?.trim() || 'Tác vụ đã bị thu hồi do vi phạm chính sách nội dung';
    const prevData = t.providerData && typeof t.providerData === 'object' ? (t.providerData as Record<string, unknown>) : {};
    await this.prisma.aiTask.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        isPublic: false,
        publicBlocked: true,
        nextPollAt: null,
        error: msg.slice(0, 500),
        output: { ...prevOut, files: [], text: undefined, __violationReview: review } as object,
        providerData: { ...prevData, revokedForViolationBy: actor.id, revokedAt: new Date().toISOString() } as object,
      },
    });
    this.taskViolationCache.delete(id);
    this.events.emit('activity', { userId: actor.id, action: 'ai.task_revoked_violation', entityType: 'ai_task', entityId: id });
    return this.adminTask(id, actor);
  }

  /**
   * Kiểm duyệt Cộng đồng: hidden = true thì gỡ khỏi Cộng đồng và khoá (khách không bật Công khai lại được);
   * hidden = false thì mở khoá và trả về Công khai như trước khi bị ẩn.
   */
  async adminModerate(id: string, hidden: boolean, actor: AuthUser) {
    const res = await this.prisma.aiTask.updateMany({ where: { id }, data: hidden ? { isPublic: false, publicBlocked: true } : { isPublic: true, publicBlocked: false } });
    if (!res.count) throw new NotFoundException('Không tìm thấy tác vụ');
    if (hidden) {
      const pinned = await this.communityPinnedIds();
      if (pinned.includes(id)) await this.saveCommunityPinnedIds(pinned.filter((x) => x !== id));
    }
    this.parentCommunityCache.clear();
    this.events.emit('activity', { userId: actor.id, action: hidden ? 'ai.task_hidden' : 'ai.task_unhidden', entityType: 'ai_task', entityId: id });
    return this.adminTask(id, actor);
  }

  /** Danh sách quản lý trực quan Video & Ảnh Cộng đồng cho Admin (`/admin/ai/community` — T-324, T-325) */
  async adminCommunityList(q: AdminCommunityQueryDto, user: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const { skip, take, page, limit } = pageArgs({ ...q, limit: q.limit ?? 24 });
    const tab = q.tab ?? 'public';
    const search = q.search?.trim();
    const pinnedIds = await this.communityPinnedIds();
    const pinnedSet = new Set(pinnedIds);

    const mediaWhere: Prisma.AiTaskWhereInput =
      q.mediaType === 'video'
        ? { output: { path: ['files', '0', 'type'], equals: 'video' } }
        : q.mediaType === 'image'
          ? { output: { path: ['files', '0', 'type'], equals: 'image' } }
          : {
              OR: [
                { output: { path: ['files', '0', 'type'], equals: 'video' } },
                { output: { path: ['files', '0', 'type'], equals: 'image' } },
              ],
            };

    const filterBase: Prisma.AiTaskWhereInput = {
      status: 'SUCCEEDED',
      ...mediaWhere,
      ...(q.tool ? { toolKey: internalToolKey(q.tool) } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search.toUpperCase() } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
              { user: { email: { contains: search, mode: 'insensitive' } } },
              { tool: { name: { contains: search, mode: 'insensitive' } } },
              { input: { path: ['prompt'], string_contains: search, mode: 'insensitive' } },
              { input: { path: ['text'], string_contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const tabWhere: Prisma.AiTaskWhereInput =
      tab === 'public'
        ? { ...filterBase, isPublic: true, tool: { enabled: true } }
        : tab === 'blocked'
          ? { ...filterBase, publicBlocked: true }
          : { ...filterBase, isPublic: false, publicBlocked: false, tool: { enabled: true } };

    const [publicCount, candidatesCount, blockedCount] = await Promise.all([
      this.prisma.aiTask.count({ where: { status: 'SUCCEEDED', isPublic: true, tool: { enabled: true }, ...mediaWhere } }),
      this.prisma.aiTask.count({ where: { status: 'SUCCEEDED', isPublic: false, publicBlocked: false, tool: { enabled: true }, ...mediaWhere } }),
      this.prisma.aiTask.count({ where: { status: 'SUCCEEDED', publicBlocked: true, ...mediaWhere } }),
    ]);

    const include = {
      tool: { select: { key: true, name: true, category: true, icon: true } },
      user: { select: { id: true, name: true, email: true } },
    } as const;

    let rows: Prisma.AiTaskGetPayload<{ include: typeof include }>[] = [];
    let total = 0;

    if (tab === 'public' && pinnedIds.length) {
      const pinnedRows = await this.prisma.aiTask.findMany({ where: { ...tabWhere, id: { in: pinnedIds } }, include });
      const byId = new Map(pinnedRows.map((r) => [r.id, r]));
      const orderedPinned = pinnedIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      const activeIds = orderedPinned.map((r) => r.id);
      const restWhere: Prisma.AiTaskWhereInput = activeIds.length ? { ...tabWhere, id: { notIn: activeIds } } : tabWhere;
      const pinnedSlice = orderedPinned.slice(skip, skip + take);
      const restSkip = Math.max(0, skip - orderedPinned.length);
      const restTake = Math.max(0, take - pinnedSlice.length);
      const [restRows, restTotal] = await Promise.all([
        restTake > 0 ? this.prisma.aiTask.findMany({ where: restWhere, orderBy: { createdAt: 'desc' }, skip: restSkip, take: restTake, include }) : Promise.resolve([]),
        this.prisma.aiTask.count({ where: restWhere }),
      ]);
      rows = [...pinnedSlice, ...restRows];
      total = orderedPinned.length + restTotal;
    } else {
      [rows, total] = await Promise.all([
        this.prisma.aiTask.findMany({ where: tabWhere, orderBy: { createdAt: 'desc' }, skip, take, include }),
        this.prisma.aiTask.count({ where: tabWhere }),
      ]);
    }

    const extractPrompt = (inp: unknown) => {
      if (!inp || typeof inp !== 'object') return '';
      const o = inp as Record<string, unknown>;
      for (const k of ['prompt', 'text', 'description', 'script']) {
        if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
      }
      return '';
    };

    const data = rows.map((r) => {
      const out = this.publicOutput(r.id, r.output) as { files?: { url: string; type: string; name?: string }[] };
      return {
        id: r.id,
        code: r.code,
        toolKey: hide ? publicToolKey(r.toolKey) : r.toolKey,
        toolName: r.tool ? (hide ? hideProviderText(r.tool.name) : r.tool.name) : r.toolKey,
        category: r.tool?.category ?? 'tools',
        isPublic: r.isPublic,
        publicBlocked: r.publicBlocked,
        communityPending: !r.isPublic && !r.publicBlocked && taskCommunityPendingOf(r.output),
        pinned: pinnedSet.has(r.id),
        prompt: extractPrompt(r.input),
        files: out.files ?? [],
        user: r.user,
        createdAt: r.createdAt,
      };
    });

    return {
      ...paginate(data, total, page, limit),
      counts: { publicCount, candidatesCount, blockedCount, pinnedCount: pinnedIds.length },
      pinnedIds,
    };
  }

  /** Admin thao tác hàng loạt trên Cộng đồng: hiện lên Cộng đồng, gỡ về chờ duyệt, ẩn khỏi Cộng đồng, ghim / bỏ ghim đầu trang */
  async adminBulkCommunityModerate(dto: BulkCommunityModerateDto, actor: AuthUser) {
    const ids = [...new Set(dto.ids)];
    const curPinned = await this.communityPinnedIds();
    if (dto.action === 'hide') {
      await this.prisma.aiTask.updateMany({ where: { id: { in: ids } }, data: { isPublic: false, publicBlocked: true } });
      await this.saveCommunityPinnedIds(curPinned.filter((id) => !ids.includes(id)));
      this.parentCommunityCache.clear();
    } else if (dto.action === 'unpublish') {
      await this.prisma.aiTask.updateMany({ where: { id: { in: ids } }, data: { isPublic: false, publicBlocked: false } });
      await this.saveCommunityPinnedIds(curPinned.filter((id) => !ids.includes(id)));
      this.parentCommunityCache.clear();
    } else if (dto.action === 'publish' || dto.action === 'publish_pin' || dto.action === 'pin') {
      const toCheck = await this.prisma.aiTask.findMany({
        where: { id: { in: ids }, status: 'SUCCEEDED' },
        select: { id: true, output: true },
      });
      for (const row of toCheck) {
        const outObj = (row.output && typeof row.output === 'object' ? { ...(row.output as Record<string, unknown>) } : {});
        const rawFiles = Array.isArray(outObj.files) ? (outObj.files as AiOutputFile[]) : [];
        let changed = false;
        const nextFiles: AiOutputFile[] = [];
        for (const f of rawFiles) {
          if (f?.url && this.files.pathOf(f.url) && !this.files.resolveOutput(f.url) && typeof f.sourceUrl === 'string' && /^https?:\/\//i.test(f.sourceUrl)) {
            const permanentUrl = await this.files.mirrorDemoUrl(f.sourceUrl).catch(() => f.sourceUrl!);
            nextFiles.push({ ...f, url: permanentUrl });
            changed = true;
          } else {
            nextFiles.push(f);
          }
        }
        if (changed) {
          await this.prisma.aiTask.update({ where: { id: row.id }, data: { output: { ...outObj, files: nextFiles } as object } });
        }
      }
      await this.prisma.aiTask.updateMany({ where: { id: { in: ids }, status: 'SUCCEEDED' }, data: { isPublic: true, publicBlocked: false } });
      if (dto.action === 'publish_pin' || dto.action === 'pin') {
        await this.saveCommunityPinnedIds([...ids, ...curPinned.filter((id) => !ids.includes(id))]);
      }
      this.parentCommunityCache.clear();
    } else if (dto.action === 'unpin') {
      await this.saveCommunityPinnedIds(curPinned.filter((id) => !ids.includes(id)));
      this.parentCommunityCache.clear();
    }
    this.events.emit('activity', { userId: actor.id, action: `ai.community_${dto.action}`, entityType: 'ai_task', meta: { count: ids.length } });
    return { ok: true, count: ids.length };
  }

  /** Admin tải thẳng 1 Video / Ảnh mẫu đẹp lên Cộng đồng (gắn với Công cụ AI để khách bấm "Dùng lại thiết kế" là chạy ngay) */
  async adminCreateCommunityShowcase(dto: CreateCommunityShowcaseDto, actor: AuthUser) {
    const intKey = internalToolKey(dto.toolKey.trim());
    const tool = await this.prisma.aiTool.findUnique({ where: { key: intKey } });
    if (!tool) throw new BadRequestException('Không tìm thấy công cụ AI đã chọn');
    const prompt = dto.prompt?.trim() ?? '';
    const ext = dto.fileType === 'video' ? 'mp4' : 'jpg';
    const created = await this.prisma.aiTask.create({
      data: {
        code: taskCode(),
        userId: actor.id,
        toolKey: tool.key,
        provider: tool.provider,
        status: 'SUCCEEDED',
        progress: 100,
        credits: 0,
        isPublic: true,
        publicBlocked: false,
        input: prompt ? { prompt } : {},
        output: {
          files: [{ url: dto.fileUrl.trim(), type: dto.fileType, name: `showcase.${ext}` }],
        },
        completedAt: new Date(),
      },
    });
    if (dto.pin !== false) {
      const curPinned = await this.communityPinnedIds();
      await this.saveCommunityPinnedIds([created.id, ...curPinned]);
    } else {
      this.parentCommunityCache.clear();
    }
    this.events.emit('activity', { userId: actor.id, action: 'ai.community_showcase_create', entityType: 'ai_task', entityId: created.id });
    return { id: created.id, code: created.code };
  }

  /** Tự động phản hồi Ticket liên quan & báo Telegram cho khách ngay khi Admin bấm hoàn tiền (T-409) */
  private async notifyCustomerOnAdminRefund(
    t: { id: string; code: string; userId: string; credits: number },
    actor: AuthUser,
  ) {
    if (t.credits <= 0) return;
    const REFUND_MSG = 'Đơn hàng của sếp đã được hoàn tiền rồi ạ';
    const [staffUser, tgCfg, cust] = await Promise.all([
      actor.id && actor.id !== 'system'
        ? this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }).catch(() => null)
        : Promise.resolve(null),
      this.settings.get<TelegramUserSettings>('telegram_user').catch(() => null),
      this.prisma.user.findUnique({ where: { id: t.userId }, select: { telegramChatId: true } }).catch(() => null),
    ]);
    const authorName = staffUser?.name || 'Đội ngũ Hỗ trợ';
    const authorId = actor.id && actor.id !== 'system' ? actor.id : null;

    let tickets: { id: string; code: number; subject: string }[] = [];
    try {
      tickets = await this.prisma.$queryRawUnsafe<{ id: string; code: number; subject: string }[]>(
        `SELECT st.id, st.code, st.subject
         FROM support_tickets st
         WHERE st.user_id = $1::uuid
           AND st.status <> 'CLOSED'
           AND (
             COALESCE(st.order_codes, '') ILIKE '%' || $2 || '%'
             OR st.subject ILIKE '%' || $2 || '%'
             OR EXISTS (
               SELECT 1 FROM support_ticket_messages sm
               WHERE sm.ticket_id = st.id AND sm.body ILIKE '%' || $2 || '%'
             )
           )
         ORDER BY st.last_reply_at DESC`,
        t.userId,
        t.code,
      );
    } catch {
      /* bỏ qua nếu bảng support_tickets chưa khởi tạo */
    }

    let repliedTicket = false;
    for (const tk of tickets) {
      const lastRows = await this.prisma.$queryRawUnsafe<{ body: string; is_staff: boolean }[]>(
        `SELECT body, is_staff FROM support_ticket_messages WHERE ticket_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        tk.id,
      );
      if (lastRows[0]?.is_staff && /đã được hoàn tiền/i.test(lastRows[0].body)) {
        repliedTicket = true;
        continue;
      }
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO support_ticket_messages (ticket_id, author_id, author_name, is_staff, body, attachments)
         VALUES ($1::uuid, $2::uuid, $3, TRUE, $4, '[]'::jsonb)`,
        tk.id,
        authorId,
        authorName,
        REFUND_MSG,
      );
      await this.prisma.$executeRawUnsafe(
        `UPDATE support_tickets
         SET status = 'ANSWERED',
             customer_unread = TRUE,
             staff_unread = FALSE,
             closed_at = NULL,
             last_reply_at = NOW(),
             updated_at = NOW()
         WHERE id = $1::uuid`,
        tk.id,
      );
      repliedTicket = true;
      if (tgCfg?.enabled && tgCfg.botToken && cust?.telegramChatId) {
        await sendMessage(
          tgCfg.botToken.trim(),
          cust.telegramChatId,
          `💬 <b>Ticket hỗ trợ #${tk.code} đã có phản hồi mới!</b>\n📌 ${esc(tk.subject)}\n👉 ${esc(REFUND_MSG)}`,
        ).catch(() => undefined);
      }
    }

    if (!repliedTicket && tgCfg?.enabled && tgCfg.botToken && cust?.telegramChatId) {
      await sendMessage(
        tgCfg.botToken.trim(),
        cust.telegramChatId,
        `💳 <b>Thông báo đơn hàng #${esc(t.code)}</b>\n👉 ${esc(REFUND_MSG)} (+${t.credits.toLocaleString('vi-VN')}đ)`,
      ).catch(() => undefined);
    }
  }

  /** Admin huỷ tác vụ đang chạy hoặc hoàn tiền đơn đã hoàn thành bị lỗi kết quả (tránh cộng tay sai số & tự hoàn đồng bộ sang Web con — T-434, T-436) */
  async adminCancel(rawId: string, actor: AuthUser, reason?: string) {
    const { siteCode, taskId: id } = this.parseAdminTaskId(rawId);
    if (siteCode !== 'main' && !isChildSite() && !shouldHideAiProviders(actor)) {
      const children = await this.discoverChildSitesForTasks();
      const child = children.find((c) => c.code === siteCode);
      if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
      const res = await fetch(`${child.apiBase}/api/internal/hub-tickets/tasks/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Server-Secret': child.serverSecret,
        },
        body: '{}',
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new BadRequestException((errBody as { message?: string })?.message || `Không thể hoàn đơn trên web con ${child.domain}`);
      }
      const d = (await res.json()) as Record<string, unknown>;
      return {
        ...d,
        id: `${child.code}__${id}`,
        rawId: id,
        siteCode: child.code,
        siteDomain: child.domain,
        isFromChildSite: true,
      };
    }

    const t = await this.prisma.aiTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Không tìm thấy tác vụ');
    if (t.refunded) throw new ConflictException('Tác vụ này đã được hoàn tiền trước đó');
    if (t.status === 'PENDING' || t.status === 'PROCESSING') {
      const prev = t.providerData && typeof t.providerData === 'object' ? (t.providerData as Record<string, unknown>) : {};
      await this.fail(t, reason?.trim() || 'Tác vụ đã được quản trị viên huỷ, tiền đã được hoàn lại', { ...prev, cancelledBy: actor.id }, 'CANCELLED');
      if (t.providerTaskId) {
        await this.cancelUpstreamForTask(t, 'admin').catch(() => undefined);
      }
      await this.cascadeRefundToChildSites(t, reason).catch(() => undefined);
      await this.notifyCustomerOnAdminRefund(t, actor).catch(() => undefined);
      this.events.emit('activity', { userId: actor.id, action: 'ai.task_cancelled', entityType: 'ai_task', entityId: id });
      return this.adminTask(id, actor);
    }
    if (t.status !== 'SUCCEEDED') {
      throw new ForbiddenException('Chỉ có thể huỷ & hoàn tiền tác vụ đang xử lý hoặc đơn đã hoàn thành chưa hoàn tiền');
    }
    const msg = reason?.trim() || 'Kết quả phát sinh lỗi — quản trị viên đã huỷ & hoàn tiền';
    const prevData = t.providerData && typeof t.providerData === 'object' ? (t.providerData as Record<string, unknown>) : { prevProviderData: t.providerData ?? null };
    const txn = await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${t.userId}::uuid FOR UPDATE`;
        const done = await tx.aiTask.updateMany({
          where: { id: t.id, refunded: false, status: 'SUCCEEDED' },
          data: {
            status: 'CANCELLED',
            refunded: t.credits > 0,
            isPublic: false,
            error: msg.slice(0, 500),
            providerData: { ...prevData, cancelledBy: actor.id, refundedAfterSuccess: true, refundedAt: new Date().toISOString() } as object,
            nextPollAt: null,
          },
        });
        if (!done.count) throw new ConflictException('Tác vụ này đã được hoàn tiền hoặc vừa đổi trạng thái');
        if (t.credits <= 0) return null;
        const owner = await tx.user.findFirst({ where: { id: t.userId, deletedAt: null }, select: { id: true } });
        if (!owner) return null;
        return this.credits.apply(tx, {
          userId: t.userId,
          type: 'REFUND',
          amount: t.credits,
          taskId: t.id,
          note: `Hoàn tiền tác vụ ${t.code}`,
          idempotencyKey: `refund:${t.id}`,
        });
      }),
    );
    if (txn) this.credits.afterChange(txn);
    await this.cascadeRefundToChildSites(t, msg).catch(() => undefined);
    await this.notifyCustomerOnAdminRefund(t, actor).catch(() => undefined);
    this.events.emit('activity', { userId: actor.id, action: 'ai.task_cancelled', entityType: 'ai_task', entityId: id });
    return this.adminTask(id, actor);
  }

  /** Thống kê cho trang admin */
  async adminStats(user?: AuthUser) {
    const hide = shouldHideAiProviders(user);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [byStatus, byTool, credits] = await Promise.all([
      this.prisma.aiTask.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      this.prisma.aiTask.groupBy({ by: ['toolKey'], where: { createdAt: { gte: since }, status: 'SUCCEEDED' }, _count: true, _sum: { credits: true }, orderBy: { _count: { toolKey: 'desc' } }, take: 10 }),
      this.prisma.aiTask.aggregate({ where: { createdAt: { gte: since }, status: 'SUCCEEDED' }, _sum: { credits: true } }),
    ]);
    return {
      last30d: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      creditsUsed30d: Number(credits._sum.credits ?? 0),
      topTools: byTool.map((t) => ({ toolKey: hide ? publicToolKey(t.toolKey) : t.toolKey, count: t._count, credits: Number(t._sum.credits ?? 0) })),
    };
  }

  // ---------------- Kho giọng đã nhân bản cá nhân (T-301) ----------------

  private static readonly MAX_CLONED_VOICES_PER_USER = 20;

  private extractClonedVoices(meta: unknown): AiUserClonedVoice[] {
    if (!meta || typeof meta !== 'object') return [];
    const list = (meta as Record<string, unknown>).clonedVoices;
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is AiUserClonedVoice => !!x && typeof x === 'object' && typeof (x as AiUserClonedVoice).id === 'string');
  }

  private presentClonedVoice(v: AiUserClonedVoice) {
    const alias = providerAlias('ivoi');
    return {
      id: v.id,
      value: `uvoice_${v.id}`,
      name: v.name,
      description: v.description ?? '',
      language: v.language,
      gender: v.gender,
      refText: v.refText,
      previewUrl: `/api/public/ai/voice-preview/${alias}/uvoice_${v.id}`,
      createdAt: v.createdAt,
    };
  }

  async listMyClonedVoices(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { meta: true } });
    const list = this.extractClonedVoices(user?.meta);
    return {
      limit: AiService.MAX_CLONED_VOICES_PER_USER,
      items: list.map((v) => this.presentClonedVoice(v)),
    };
  }

  async createMyClonedVoice(userId: string, dto: CreateClonedVoiceDto) {
    const name = dto.name.trim();
    const refText = dto.refText.trim();
    const description = (dto.description ?? '').trim() || undefined;
    const language = (dto.language || 'vi').trim().toLowerCase();
    const gender: 'male' | 'female' = dto.gender === 'male' ? 'male' : 'female';
    if (!name) throw new BadRequestException('Vui lòng nhập tên giọng nói');
    if (refText.length < 4) throw new BadRequestException('Lời nói mẫu quá ngắn, vui lòng nhập đầy đủ câu thoại trong file mẫu');
    if (!this.files.ownsInput(userId, dto.refAudioUrl)) {
      throw new BadRequestException('File giọng mẫu không hợp lệ, vui lòng tải lên lại');
    }

    const dur = await this.files.duration(dto.refAudioUrl).catch(() => null);
    if (dur !== null && dur < 2.2) {
      throw new BadRequestException('File giọng mẫu quá ngắn (cần tối thiểu 3–5 giây giọng nói rõ ràng)');
    }
    if (dur !== null && dur > 60) {
      throw new BadRequestException('File giọng mẫu dài quá 60 giây, vui lòng cắt đoạn 5–25 giây rõ nhất để nhân bản chuẩn xác');
    }

    const uploaded = await this.files.read(dto.refAudioUrl);
    if (!uploaded || !uploaded.data.length) {
      throw new BadRequestException('Không đọc được file giọng mẫu, vui lòng tải lên lại');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { meta: true } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    const existing = this.extractClonedVoices(user.meta);
    if (existing.length >= AiService.MAX_CLONED_VOICES_PER_USER) {
      throw new BadRequestException(`Kho giọng của bạn đã đầy (${AiService.MAX_CLONED_VOICES_PER_USER}/${AiService.MAX_CLONED_VOICES_PER_USER} giọng). Vui lòng xoá bớt giọng cũ trước khi tạo thêm.`);
    }

    const norm = await normalizeIvoiRefAudio(uploaded.data, uploaded.filename, uploaded.mimeType);
    const voiceId = randomBytes(10).toString('hex');
    const samplePath = await this.files.saveVaultVoiceSample(voiceId, norm.data, norm.mimeType);

    let upstreamVoiceId: string | undefined;
    const cfg = await this.providerConfig('ivoi');
    if (cfg.enabled && cfg.apiKey) {
      try {
        upstreamVoiceId = await enrollVaultVoiceOnIvoi(cfg, voiceId, norm.data, refText, language, gender);
      } catch (err) {
        await this.files.deleteVaultVoiceSample(voiceId);
        const msg = err instanceof AiProviderError ? err.message : (err as Error).message;
        throw new BadRequestException(hideProviderText(msg) || 'Không khởi tạo được mẫu giọng nhân bản từ file âm thanh này, vui lòng chọn file rõ tiếng hơn');
      }
    }

    const created: AiUserClonedVoice = {
      id: voiceId,
      name,
      ...(description ? { description } : {}),
      language,
      gender,
      refText,
      samplePath,
      ...(upstreamVoiceId ? { upstreamVoiceId } : {}),
      createdAt: new Date().toISOString(),
    };

    await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { meta: true } });
        const metaObj = cur?.meta && typeof cur.meta === 'object' ? { ...(cur.meta as Record<string, unknown>) } : {};
        const curList = this.extractClonedVoices(metaObj);
        if (curList.length >= AiService.MAX_CLONED_VOICES_PER_USER) {
          throw new BadRequestException(`Kho giọng của bạn đã đạt giới hạn ${AiService.MAX_CLONED_VOICES_PER_USER} giọng`);
        }
        metaObj.clonedVoices = [created, ...curList];
        await tx.user.update({ where: { id: userId }, data: { meta: metaObj as Prisma.InputJsonValue } });
      }),
    );

    return this.presentClonedVoice(created);
  }

  async updateMyClonedVoice(userId: string, voiceId: string, dto: UpdateClonedVoiceDto) {
    const cleanId = voiceId.replace(/^uvoice_/, '').trim();
    let updatedItem: AiUserClonedVoice | null = null;
    await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { meta: true } });
        const metaObj = cur?.meta && typeof cur.meta === 'object' ? { ...(cur.meta as Record<string, unknown>) } : {};
        const list = this.extractClonedVoices(metaObj);
        const idx = list.findIndex((x) => x.id === cleanId);
        if (idx < 0) throw new NotFoundException('Không tìm thấy giọng nhân bản này');
        const prev = list[idx];
        const next: AiUserClonedVoice = {
          ...prev,
          ...(dto.name !== undefined ? { name: dto.name.trim() || prev.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() || undefined } : {}),
          ...(dto.language !== undefined ? { language: dto.language.trim().toLowerCase() || prev.language } : {}),
          ...(dto.gender !== undefined ? { gender: dto.gender === 'male' ? 'male' : 'female' } : {}),
        };
        list[idx] = next;
        updatedItem = next;
        metaObj.clonedVoices = list;
        await tx.user.update({ where: { id: userId }, data: { meta: metaObj as Prisma.InputJsonValue } });
      }),
    );
    return this.presentClonedVoice(updatedItem!);
  }

  async deleteMyClonedVoice(userId: string, voiceId: string) {
    const cleanId = voiceId.replace(/^uvoice_/, '').trim();
    let removed: AiUserClonedVoice | null = null;
    await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { meta: true } });
        const metaObj = cur?.meta && typeof cur.meta === 'object' ? { ...(cur.meta as Record<string, unknown>) } : {};
        const list = this.extractClonedVoices(metaObj);
        const hit = list.find((x) => x.id === cleanId);
        if (!hit) throw new NotFoundException('Không tìm thấy giọng nhân bản này');
        removed = hit;
        metaObj.clonedVoices = list.filter((x) => x.id !== cleanId);
        await tx.user.update({ where: { id: userId }, data: { meta: metaObj as Prisma.InputJsonValue } });
      }),
    );
    await this.files.deleteVaultVoiceSample(cleanId);
    if (removed && (removed as AiUserClonedVoice).upstreamVoiceId) {
      const cfg = await this.providerConfig('ivoi');
      await deleteVoiceOnIvoi(cfg, (removed as AiUserClonedVoice).upstreamVoiceId);
    }
    return { deleted: true, id: cleanId };
  }

  private async resolveUserClonedVoiceForCall(userId: string, voiceId: string): Promise<(AiUserClonedVoice & { audioData: Buffer }) | null> {
    const cleanId = voiceId.replace(/^uvoice_/, '').trim();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { meta: true } });
    const found = this.extractClonedVoices(user?.meta).find((x) => x.id === cleanId);
    if (!found) return null;
    const sample = await this.files.readVaultVoiceSample(cleanId);
    if (!sample) return null;
    return { ...found, audioData: sample.data };
  }

  private async updateUserClonedVoiceUpstream(userId: string, voiceId: string, upstreamVoiceId: string): Promise<void> {
    const cleanId = voiceId.replace(/^uvoice_/, '').trim();
    await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const cur = await tx.user.findUnique({ where: { id: userId }, select: { meta: true } });
        const metaObj = cur?.meta && typeof cur.meta === 'object' ? { ...(cur.meta as Record<string, unknown>) } : {};
        const list = this.extractClonedVoices(metaObj);
        const idx = list.findIndex((x) => x.id === cleanId);
        if (idx < 0) return;
        list[idx] = { ...list[idx], upstreamVoiceId };
        metaObj.clonedVoices = list;
        await tx.user.update({ where: { id: userId }, data: { meta: metaObj as Prisma.InputJsonValue } });
      }),
    );
  }
}
