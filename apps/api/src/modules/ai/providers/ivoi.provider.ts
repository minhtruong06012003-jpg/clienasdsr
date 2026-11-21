import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import {
  AiProviderError,
  type AiCallContext,
  type AiFieldOption,
  type AiInput,
  type AiProvider,
  type AiProviderConfig,
  type AiToolDef,
} from '../ai.types.js';
import { loadInputFile } from './background.js';
import { pickMessage, str } from './http.js';

const execFileAsync = promisify(execFile);

/**
 * iVoi — https://ivoi.io/app/api (Base API: `https://ivoi.io/api`, REST v1: `/api/v1/*`)
 * Xác thực: `Authorization: Bearer <API_KEY>`
 * - Danh sách giọng đọc: `GET /api/v1/voices` -> `{ voices: [{ id, name, language, gender, is_cloned, is_public, is_premium, price_multiplier, sample_audio_url, description }] }`
 * - Tạo giọng đọc (TTS): `POST /api/v1/tts/synthesize` `{ text, voice_id, format, speed, language, pause_settings? }` -> `{ job_id, status, audio_url }`
 * - Chuyển phụ đề (.SRT): `POST /api/v1/tts/synthesize-srt` (`multipart/form-data`: `file` đuôi `.srt`, `voice_id`, `format`, `language`, `speed`) -> `{ job_id, status }`
 * - Hỏi trạng thái TTS / SRT: `GET /api/v1/tts/jobs/{job_id}` -> `{ job_id, status: 'processing' | 'completed' | 'failed', audio_url, duration_seconds }`
 * - Nhân bản giọng (Voice Clone): `POST /api/v1/voices/clone` (`multipart/form-data`: `ref_audio`, `name`, `ref_text`, `language`, `gender`) -> `{ voice_id }`
 *   + Giọng trong Kho giọng nhân bản cá nhân của khách đặt tiền tố `nov_uv_<id>` (ẩn khỏi danh sách công khai, tự động quản lý suất trên nguồn).
 */

const DEFAULT_BASE = 'https://ivoi.io/api';
const TMP_VOICE_PREFIX = 'nov_tmp_';
const VAULT_VOICE_PREFIX = 'nov_uv_';
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** Che tên nguồn nội bộ ngay trong adapter (không import ai-public-key.ts để tránh vòng lặp ESM với providers/index.ts) */
const hideProviderText = (raw?: string | null) =>
  (raw ?? '')
    .replace(/(?:https?:\/\/)?[\w.-]*ivoi\.io(?:\/[^\s"',;)]*)?/gi, '')
    .replace(/\biVoi\b/gi, 'Hệ thống AI')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

interface IvoiVoiceItem {
  id: string;
  name: string;
  language: string;
  gender: 'male' | 'female' | 'neutral';
  description?: string;
  isCloned: boolean;
  isPublic: boolean;
  isPremium: boolean;
  priceMultiplier: number;
  sampleUrl?: string;
}

/** Toàn bộ 30 ngôn ngữ đa quốc gia chuẩn trên hệ thống giọng nói AI */
export const IVOI_LANGUAGES: AiFieldOption[] = [
  { value: 'vi', label: 'Tiếng Việt (vi)' },
  { value: 'en', label: 'Tiếng Anh (en)' },
  { value: 'zh', label: 'Tiếng Trung (zh)' },
  { value: 'es', label: 'Tiếng Tây Ban Nha (es)' },
  { value: 'fr', label: 'Tiếng Pháp (fr)' },
  { value: 'de', label: 'Tiếng Đức (de)' },
  { value: 'ja', label: 'Tiếng Nhật (ja)' },
  { value: 'ko', label: 'Tiếng Hàn (ko)' },
  { value: 'it', label: 'Tiếng Ý (it)' },
  { value: 'pt', label: 'Tiếng Bồ Đào Nha (pt)' },
  { value: 'ru', label: 'Tiếng Nga (ru)' },
  { value: 'ar', label: 'Tiếng Ả Rập (ar)' },
  { value: 'hi', label: 'Tiếng Hindi (hi)' },
  { value: 'bn', label: 'Tiếng Bengal (bn)' },
  { value: 'id', label: 'Tiếng Indonesia (id)' },
  { value: 'ms', label: 'Tiếng Mã Lai (ms)' },
  { value: 'th', label: 'Tiếng Thái (th)' },
  { value: 'tl', label: 'Tiếng Philippines (tl)' },
  { value: 'nl', label: 'Tiếng Hà Lan (nl)' },
  { value: 'tr', label: 'Tiếng Thổ Nhĩ Kỳ (tr)' },
  { value: 'pl', label: 'Tiếng Ba Lan (pl)' },
  { value: 'sv', label: 'Tiếng Thụy Điển (sv)' },
  { value: 'da', label: 'Tiếng Đan Mạch (da)' },
  { value: 'no', label: 'Tiếng Na Uy (no)' },
  { value: 'fi', label: 'Tiếng Phần Lan (fi)' },
  { value: 'el', label: 'Tiếng Hy Lạp (el)' },
  { value: 'he', label: 'Tiếng Do Thái (he)' },
  { value: 'cs', label: 'Tiếng Séc (cs)' },
  { value: 'hu', label: 'Tiếng Hungary (hu)' },
  { value: 'ro', label: 'Tiếng Romania (ro)' },
];

export const IVOI_LANG_CODES: string[] = IVOI_LANGUAGES.map((l) => l.value);

const READING_LANGUAGE_OPTIONS: AiFieldOption[] = [
  { value: 'auto', label: 'Tự động theo giọng đọc đã chọn' },
  ...IVOI_LANGUAGES,
];

const FALLBACK_VOICE_OPTIONS: AiFieldOption[] = [
  {
    value: 'default',
    label: 'Giọng đọc AI tự nhiên (Tự động tải danh sách giọng khi bật khoá API)',
    gender: 'female',
    langs: ['vi'],
  },
];

const SPEED_OPTIONS: AiFieldOption[] = [
  { value: '0.75', label: '0.75× · Chậm rãi, truyền cảm' },
  { value: '0.9', label: '0.9× · Hơi chậm' },
  { value: '1.0', label: '1.0× · Tự nhiên (Mặc định)' },
  { value: '1.1', label: '1.1× · Hơi nhanh' },
  { value: '1.25', label: '1.25× · Nhanh vừa (Review / Tin tức)' },
  { value: '1.5', label: '1.5× · Nhanh' },
  { value: '1.75', label: '1.75× · Rất nhanh' },
  { value: '2.0', label: '2.0× · Tốc độ tối đa' },
];

const SRT_SPEED_OPTIONS: AiFieldOption[] = [
  { value: '0.75', label: '0.75× · Chậm rãi' },
  { value: '0.9', label: '0.9× · Hơi chậm' },
  { value: '1.0', label: '1.0× · Chuẩn tự động khớp khung giờ (Mặc định)' },
  { value: '1.1', label: '1.1× · Hơi nhanh' },
  { value: '1.25', label: '1.25× · Nhanh vừa (Review phim)' },
  { value: '1.5', label: '1.5× · Nhanh' },
  { value: '1.75', label: '1.75× · Rất nhanh' },
  { value: '2.0', label: '2.0× · Cực nhanh (2.0×)' },
  { value: '2.5', label: '2.5× · Tối đa cho phụ đề dày (2.5×)' },
];

const FORMAT_OPTIONS: AiFieldOption[] = [
  { value: 'mp3', label: 'MP3 · Nhẹ, tương thích mọi thiết bị' },
  { value: 'wav', label: 'WAV · Âm thanh gốc không nén (Chất lượng cao)' },
];

const PAUSE_OPTIONS: AiFieldOption[] = [
  { value: 'default', label: 'Tự động mặc định theo ngữ cảnh' },
  { value: 'natural', label: 'Chuẩn tự nhiên (phẩy 0.25s · chấm 0.45s · xuống dòng 0.6s)' },
  { value: 'story', label: 'Kể chuyện / Audiobook sâu lắng (phẩy 0.35s · chấm 0.65s · xuống dòng 0.9s)' },
  { value: 'fast', label: 'Review / Tin tức nhịp nhanh (phẩy 0.15s · chấm 0.3s · xuống dòng 0.4s)' },
];

function pauseSettingsOf(preset: string): Record<string, unknown> | undefined {
  if (preset === 'natural') {
    return {
      use_punctuation_pauses: true,
      punctuation_pauses: { '.': 0.45, ',': 0.25, '?': 0.45, '!': 0.45, ';': 0.3, '\n': 0.6 },
    };
  }
  if (preset === 'story') {
    return {
      use_punctuation_pauses: true,
      punctuation_pauses: { '.': 0.65, ',': 0.35, '?': 0.65, '!': 0.65, ';': 0.45, '\n': 0.9 },
    };
  }
  if (preset === 'fast') {
    return {
      use_punctuation_pauses: true,
      punctuation_pauses: { '.': 0.3, ',': 0.15, '?': 0.3, '!': 0.3, ';': 0.2, '\n': 0.4 },
    };
  }
  return undefined;
}

/** Chuẩn hoá baseUrl về dạng `https://ivoi.io/api` dù admin nhập `https://ivoi.io`, `https://ivoi.io/api` hay `https://ivoi.io/api/api/v1` */
function apiRoot(cfg: AiProviderConfig): string {
  let u = (str(cfg.baseUrl) || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (u.endsWith('/api/v1')) u = u.slice(0, -7);
  if (!u.endsWith('/api')) u = `${u}/api`;
  return u;
}

const v1Url = (cfg: AiProviderConfig, path: string) => `${apiRoot(cfg)}/api/v1${path.startsWith('/') ? path : `/${path}`}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Đếm số ký tự quy đổi sang token an toàn (chữ tượng hình CJK tính hệ số 2.5, chữ Việt/Latin tính 1.0) */
function weightedChars(rawText: unknown, isSample = false): number {
  const s = typeof rawText === 'string' ? rawText.trim() : '';
  if (!s) return isSample ? 1000 : 0;
  const cjkMatches = s.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return Math.ceil((s.length - cjkCount) + cjkCount * 2.5);
}

function parseCueTimeMs(raw: string): number | null {
  const clean = raw.trim().replace(',', '.');
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(clean);
  if (!m) return null;
  const hh = Number(m[1] ?? 0);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number((m[4] ?? '0').padEnd(3, '0').slice(0, 3));
  if (mm >= 60 || ss >= 60) return null;
  return ((hh * 3600 + mm * 60 + ss) * 1000) + ms;
}

function formatSrtTime(msTotal: number): string {
  const clamped = Math.max(0, Math.round(msTotal));
  const hh = Math.floor(clamped / 3_600_000);
  const mm = Math.floor((clamped % 3_600_000) / 60_000);
  const ss = Math.floor((clamped % 60_000) / 1_000);
  const ms = clamped % 1_000;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Đọc & chuẩn hoá nội dung phụ đề .SRT / .VTT thành chuỗi .SRT hợp lệ cho `/api/v1/tts/synthesize-srt`,
 * đồng thời bóc tách phần lời thoại thực tế để tính đúng số ký tự / token (không tính số thứ tự & mốc thời gian).
 */
function parseAndNormalizeSrt(rawContent: string): { srtText: string; spokenText: string; cueCount: number } {
  const cleaned = rawContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^WEBVTT[^\n]*\n+/i, '')
    .trim();
  if (!cleaned) {
    throw new BadRequestException('Nội dung phụ đề đang trống, vui lòng tải file .SRT/.VTT hoặc dán nội dung phụ đề hợp lệ');
  }
  const blocks = cleaned.split(/\n{2,}/);
  const cues: { startMs: number; endMs: number; text: string }[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const timeLine = lines[arrowIdx];
    const [leftRaw, rightPart] = timeLine.split('-->');
    const rightRaw = (rightPart ?? '').trim().split(/\s+/)[0] ?? '';
    const startMs = parseCueTimeMs(leftRaw ?? '');
    const endMs = parseCueTimeMs(rightRaw);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const bodyText = lines
      .slice(arrowIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!bodyText) continue;
    cues.push({ startMs, endMs, text: bodyText });
  }
  if (!cues.length) {
    throw new BadRequestException(
      'Không tìm thấy dòng phụ đề hợp lệ (cần đúng định dạng mốc thời gian `00:00:01,500 --> 00:00:04,200` kèm lời thoại bên dưới)',
    );
  }
  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const normalizedCues: string[] = [];
  const spokenParts: string[] = [];
  let prevEnd = 0;
  for (const cue of cues) {
    let s = cue.startMs;
    const e = cue.endMs;
    if (s < prevEnd) {
      if (e <= prevEnd + 40) continue;
      s = prevEnd;
    }
    prevEnd = e;
    normalizedCues.push(`${normalizedCues.length + 1}\n${formatSrtTime(s)} --> ${formatSrtTime(e)}\n${cue.text}`);
    spokenParts.push(cue.text);
  }
  if (!normalizedCues.length) {
    throw new BadRequestException('Các mốc thời gian trong file phụ đề bị chồng chéo không hợp lệ, vui lòng kiểm tra lại file .SRT');
  }
  const spokenText = spokenParts.join('\n');
  if (spokenText.length > 300_000) {
    throw new BadRequestException('Tổng lời thoại trong phụ đề vượt quá giới hạn 300.000 ký tự mỗi lượt, vui lòng chia nhỏ file .SRT');
  }
  return {
    srtText: `${normalizedCues.join('\n\n')}\n`,
    spokenText,
    cueCount: normalizedCues.length,
  };
}

function parseSrtSpokenSafe(rawContent: string): string {
  try {
    return parseAndNormalizeSrt(rawContent).spokenText;
  } catch {
    return '';
  }
}

async function resolveSubtitleInput(input: AiInput, ctx: AiCallContext): Promise<{ srtText: string; spokenText: string; cueCount: number } | null> {
  const fileUrl = str(input.subtitleFile).trim();
  if (fileUrl) {
    const uploaded = await loadInputFile(ctx.readUpload, fileUrl);
    return parseAndNormalizeSrt(uploaded.data.toString('utf8'));
  }
  const pasted = str(input.srtText).trim();
  if (pasted) {
    return parseAndNormalizeSrt(pasted);
  }
  return null;
}

async function ivoiJson<T = any>(
  cfg: AiProviderConfig,
  url: string,
  init: RequestInit & { timeoutMs?: number; auth?: boolean } = {},
): Promise<T> {
  const { timeoutMs = 45_000, auth = true, headers: extraHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
    ...(auth && cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(extraHeaders as Record<string, string> | undefined),
  };
  let res: Response;
  try {
    res = await fetch(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AiProviderError('Không kết nối được máy chủ xử lý giọng đọc, vui lòng thử lại sau ít giây', { error: (err as Error).message }, true);
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    if (res.status === 429) {
      throw new AiProviderError(
        'Hệ thống giọng đọc đang xử lý nhiều yêu cầu cùng lúc, vui lòng chờ vài giây',
        { status: 429, data, waitingSlot: true, retryMs: 12_000 },
        true,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new AiProviderError('Cấu hình kết nối giọng đọc chưa sẵn sàng, vui lòng báo quản trị viên kiểm tra khoá API', { status: res.status, data }, false);
    }
    if (res.status === 402 || /insufficient|not enough|hết token|không đủ token/i.test(JSON.stringify(data))) {
      throw new AiProviderError('Hạn mức xử lý giọng đọc đang tạm hết, vui lòng thử lại sau ít phút', { status: res.status, data }, false);
    }
    const rawMsg = hideProviderText(str(data?.detail ?? data?.message ?? data?.error) || pickMessage(data));
    throw new AiProviderError(
      rawMsg || `Yêu cầu xử lý giọng đọc thất bại (HTTP ${res.status})`,
      { status: res.status, data },
      res.status >= 500,
    );
  }
  return data as T;
}

/** Bộ nhớ đệm danh sách giọng đọc theo từng API key (5 phút) + tra cứu toàn cục cho preview giọng */
const voicesCache = new Map<string, { at: number; items: IvoiVoiceItem[]; options: AiFieldOption[]; rawIds: Set<string> }>();
const globalVoiceById = new Map<string, IvoiVoiceItem>();

function toVoiceOption(v: IvoiVoiceItem): AiFieldOption {
  let badge: string | undefined;
  if (v.isPremium && v.priceMultiplier > 1) badge = `Cao cấp ×${v.priceMultiplier}`;
  else if (v.isCloned && !v.isPublic) badge = 'Nhân bản';
  return {
    value: v.id,
    label: hideProviderText(v.name) || v.id,
    hint: v.description ? hideProviderText(v.description) : undefined,
    gender: v.gender,
    langs: [v.language],
    tags: v.isPremium ? ['Giọng cao cấp'] : ['Giọng hệ thống'],
    ...(badge ? { badge } : {}),
  };
}

async function fetchVoices(cfg: AiProviderConfig, force = false): Promise<{ items: IvoiVoiceItem[]; options: AiFieldOption[]; rawIds: Set<string> }> {
  if (!cfg.apiKey) return { items: [], options: FALLBACK_VOICE_OPTIONS, rawIds: new Set() };
  const cacheKey = `${apiRoot(cfg)}|${cfg.apiKey}`;
  const hit = voicesCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < 5 * 60_000 && hit.options.length) return hit;

  const data = await ivoiJson<{ voices?: any[] }>(cfg, v1Url(cfg, '/voices'), { timeoutMs: 20_000 });
  const rawList = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
  const items: IvoiVoiceItem[] = [];
  const rawIds = new Set<string>();

  for (const r of rawList) {
    const id = str(r?.id ?? r?.voice_id).trim();
    const name = str(r?.name).trim();
    if (!id || !name) continue;
    rawIds.add(id);
    // Ẩn các giọng nhân bản tạm (`nov_tmp_*`) và giọng trong Kho cá nhân của từng khách (`nov_uv_*`) khỏi danh sách chung
    if (name.startsWith(TMP_VOICE_PREFIX) || name.startsWith(VAULT_VOICE_PREFIX)) continue;

    const g = str(r?.gender).toLowerCase();
    const gender: 'male' | 'female' | 'neutral' = g === 'male' ? 'male' : g === 'female' ? 'female' : 'neutral';
    const language = (str(r?.language) || 'vi').toLowerCase();
    const isCloned = Boolean(r?.is_cloned);
    const isPublic = r?.is_public !== false;
    const isPremium = Boolean(r?.is_premium);
    const mult = Number(r?.price_multiplier);
    const priceMultiplier = Number.isFinite(mult) && mult > 0 ? mult : 1;
    const sampleUrl = str(r?.sample_audio_url ?? r?.preview_url ?? r?.ref_audio_s3).trim() || undefined;
    const description = str(r?.description).trim() || undefined;

    const item: IvoiVoiceItem = { id, name, language, gender, description, isCloned, isPublic, isPremium, priceMultiplier, sampleUrl };
    items.push(item);
    globalVoiceById.set(id, item);
  }

  // Ưu tiên giọng tiếng Việt chuẩn lên đầu để khách dễ chọn ngay
  items.sort((a, b) => {
    const aVi = a.language === 'vi' ? 0 : 1;
    const bVi = b.language === 'vi' ? 0 : 1;
    if (aVi !== bVi) return aVi - bVi;
    const aPrem = a.isPremium ? 1 : 0;
    const bPrem = b.isPremium ? 1 : 0;
    if (aPrem !== bPrem) return aPrem - bPrem;
    return a.name.localeCompare(b.name, 'vi');
  });

  const options = items.length ? items.map(toVoiceOption) : FALLBACK_VOICE_OPTIONS;
  const entry = { at: Date.now(), items, options, rawIds };
  voicesCache.set(cacheKey, entry);
  return entry;
}

/** Cache hệ số nhân token của giọng nhân bản (`cloned_voice_token_multiplier`, mặc định an toàn >= 2.5) */
let cloneMultCache: { at: number; root: string; value: number } | null = null;

export async function getIvoiCloneMultiplier(cfg: AiProviderConfig): Promise<number> {
  const root = apiRoot(cfg);
  if (cloneMultCache && cloneMultCache.root === root && Date.now() - cloneMultCache.at < 10 * 60_000) {
    return cloneMultCache.value;
  }
  try {
    const res = await ivoiJson<{ cloned_voice_token_multiplier?: number }>(
      cfg,
      `${root}/settings/cloned-voice-token-multiplier`,
      { auth: false, timeoutMs: 8_000 },
    );
    const n = Number(res?.cloned_voice_token_multiplier);
    const val = Number.isFinite(n) && n > 0 ? Math.max(2.5, n) : 2.5;
    cloneMultCache = { at: Date.now(), root, value: val };
    return val;
  } catch {
    return cloneMultCache?.value ?? 2.5;
  }
}

/** Xoá giọng nhân bản trên nguồn để giải phóng hạn mức */
export async function deleteVoiceOnIvoi(cfg: AiProviderConfig, voiceId: string | undefined) {
  if (!voiceId || !cfg.apiKey) return;
  try {
    await fetch(v1Url(cfg, `/voices/${encodeURIComponent(voiceId)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    /* bỏ qua lỗi xoá giọng */
  }
}

/** Dọn các giọng nhân bản tạm (`nov_tmp_<timestamp>_*`) bị kẹt quá 20 phút, hoặc giải phóng 1 suất `nov_uv_*` cũ nhất khi đầy hạn mức nguồn */
async function freeUpstreamCloneSlots(cfg: AiProviderConfig, evictOldestVaultSlot = false) {
  if (!cfg.apiKey) return;
  try {
    const data = await ivoiJson<{ voices?: any[] }>(cfg, v1Url(cfg, '/voices'), { timeoutMs: 15_000 });
    const list = Array.isArray(data?.voices) ? data.voices : [];
    const now = Date.now();
    const vaultVoices: { id: string; ts: number }[] = [];
    for (const v of list) {
      const id = str(v?.id ?? v?.voice_id).trim();
      const name = str(v?.name).trim();
      if (!id) continue;
      if (name.startsWith(TMP_VOICE_PREFIX)) {
        const tsPart = Number(name.slice(TMP_VOICE_PREFIX.length).split('_')[0]);
        if (evictOldestVaultSlot || !Number.isFinite(tsPart) || now - tsPart > 20 * 60_000) {
          await deleteVoiceOnIvoi(cfg, id);
        }
      } else if (name.startsWith(VAULT_VOICE_PREFIX)) {
        const tsPart = Number(name.slice(VAULT_VOICE_PREFIX.length).split('_')[0]) || 0;
        vaultVoices.push({ id, ts: tsPart });
      }
    }
    if (evictOldestVaultSlot && vaultVoices.length > 0) {
      vaultVoices.sort((a, b) => a.ts - b.ts);
      for (const old of vaultVoices.slice(0, Math.min(2, vaultVoices.length))) {
        await deleteVoiceOnIvoi(cfg, old.id);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Chuẩn hoá file thu âm mẫu (đặc biệt .m4a / .mp4 / .aac trên iPhone) về WAV PCM 24kHz mono sạch rõ cho Voice Clone */
export async function normalizeIvoiRefAudio(
  buf: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ data: Buffer; filename: string; mimeType: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ivoi-ref-'));
  const inPath = join(dir, `in_${filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'sample.bin'}`);
  const outPath = join(dir, 'sample.wav');
  try {
    await writeFile(inPath, buf);
    await execFileAsync('ffmpeg', ['-y', '-i', inPath, '-vn', '-ac', '1', '-ar', '24000', '-t', '35', '-c:a', 'pcm_s16le', outPath], {
      timeout: 30_000,
    });
    const wav = await readFile(outPath);
    if (wav.length > 512) return { data: wav, filename: 'sample.wav', mimeType: 'audio/wav' };
  } catch {
    const lower = filename.toLowerCase();
    const isCleanWavOrMp3 = (lower.endsWith('.wav') || lower.endsWith('.mp3')) && buf.length <= 15 * 1024 * 1024;
    if (isCleanWavOrMp3) return { data: buf, filename, mimeType };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { data: buf, filename: filename || 'sample.wav', mimeType: mimeType || 'audio/wav' };
}

/** Đăng ký mẫu giọng từ Kho cá nhân lên máy chủ nguồn (tự động giải phóng suất cũ nếu nguồn đầy hạn mức 10 giọng) */
export async function enrollVaultVoiceOnIvoi(
  cfg: AiProviderConfig,
  voiceId: string,
  wavData: Buffer,
  refText: string,
  language: string,
  gender: 'male' | 'female',
): Promise<string> {
  if (!cfg.apiKey) throw new AiProviderError('Cấu hình kết nối giọng đọc chưa sẵn sàng', {}, false);
  await freeUpstreamCloneSlots(cfg, false);
  const tagName = `${VAULT_VOICE_PREFIX}${Date.now()}_${voiceId.slice(0, 10)}`;
  const sendClone = async () => {
    const form = new FormData();
    form.append('ref_audio', new Blob([new Uint8Array(wavData)], { type: 'audio/wav' }), 'sample.wav');
    form.append('name', tagName);
    form.append('ref_text', refText);
    form.append('language', (language || 'vi').toLowerCase());
    form.append('gender', gender === 'male' ? 'male' : 'female');
    return ivoiJson<{ voice_id?: string; id?: string }>(cfg, v1Url(cfg, '/voices/clone'), {
      method: 'POST',
      body: form,
      timeoutMs: 60_000,
    });
  };

  let cloned: { voice_id?: string; id?: string };
  try {
    cloned = await sendClone();
  } catch (err) {
    await freeUpstreamCloneSlots(cfg, true);
    cloned = await sendClone().catch(() => {
      throw err;
    });
  }
  const upstreamId = str(cloned?.voice_id ?? cloned?.id).trim();
  if (!upstreamId) {
    throw new AiProviderError('Không khởi tạo được mẫu giọng nhân bản từ file âm thanh này, vui lòng chọn đoạn thu âm rõ tiếng hơn', { cloned }, false);
  }
  return upstreamId;
}

/** Đảm bảo mẫu giọng `uvoice_<id>` của khách đã sẵn sàng trên nguồn và trả về `{ upstreamVoiceId, defaultLanguage }` */
async function resolveTargetVoice(
  rawVoice: string,
  ctx: AiCallContext,
): Promise<{ upstreamVoiceId: string; voiceLanguage: string }> {
  if (rawVoice.startsWith('uvoice_')) {
    const cleanId = rawVoice.slice('uvoice_'.length).replace(/[^a-f0-9]/gi, '');
    if (!cleanId || !ctx.getUserClonedVoice) {
      throw new BadRequestException('Không tìm thấy giọng nhân bản này trong kho giọng của bạn');
    }
    const saved = await ctx.getUserClonedVoice(cleanId);
    if (!saved) {
      throw new BadRequestException('Giọng nhân bản không tồn tại hoặc đã bị xoá khỏi kho giọng của bạn');
    }
    let upstreamId = str(saved.upstreamVoiceId).trim();
    if (upstreamId) {
      const { rawIds } = await fetchVoices(ctx.config, false).catch(() => ({ rawIds: new Set<string>() }));
      if (!rawIds.has(upstreamId)) {
        const refreshed = await fetchVoices(ctx.config, true).catch(() => ({ rawIds: new Set<string>() }));
        if (!refreshed.rawIds.has(upstreamId)) upstreamId = '';
      }
    }
    if (!upstreamId) {
      upstreamId = await enrollVaultVoiceOnIvoi(
        ctx.config,
        cleanId,
        saved.audioData,
        saved.refText,
        saved.language,
        saved.gender,
      );
      await ctx.setUserClonedVoiceUpstream?.(cleanId, upstreamId);
      await sleep(2_200);
    }
    return { upstreamVoiceId: upstreamId, voiceLanguage: saved.language || 'vi' };
  }

  if (!rawVoice || rawVoice === 'default') {
    const { items } = await fetchVoices(ctx.config);
    if (!items.length) throw new AiProviderError('Chưa tải được danh sách giọng đọc, vui lòng thử lại sau ít giây', {}, true);
    return { upstreamVoiceId: items[0].id, voiceLanguage: items[0].language || 'vi' };
  }

  let v = globalVoiceById.get(rawVoice);
  if (!v && ctx.config.apiKey) {
    const { items } = await fetchVoices(ctx.config).catch(() => ({ items: [] as IvoiVoiceItem[] }));
    v = items.find((x) => x.id === rawVoice);
  }
  return { upstreamVoiceId: rawVoice, voiceLanguage: v?.language || 'vi' };
}

/** Tải file kết quả MP3/WAV từ S3 về Buffer để lưu trên máy chủ của mình (không lộ URL nguồn và không hết hạn) */
async function downloadAudioOutput(audioUrl: string, jobId: string, fmt: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
  let res: Response;
  try {
    res = await fetch(audioUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new AiProviderError('Không tải được file âm thanh kết quả, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
  }
  if (!res.ok) {
    throw new AiProviderError(
      'Không tải được file âm thanh kết quả, hệ thống sẽ thử lại',
      { status: res.status },
      res.status >= 500 || res.status === 404 || res.status === 429,
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) throw new AiProviderError('File âm thanh kết quả đang được đồng bộ, hệ thống sẽ thử lại', {}, true);
  const ext = fmt === 'wav' || /\.wav(\?|$)/i.test(audioUrl) ? 'wav' : 'mp3';
  const mimeType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
  return { data, mimeType, name: `${jobId}.${ext}` };
}

const TOOLS: AiToolDef[] = [
  {
    key: 'tts',
    name: 'Chuyển văn bản thành giọng nói AI',
    category: 'giong-noi-ai',
    icon: 'mic',
    badge: 'HOT',
    featured: true,
    splitModels: false,
    description: 'Chuyển văn bản dài tới 100.000 ký tự thành giọng đọc AI 30 ngôn ngữ tự nhiên như người thật, tích hợp sẵn Kho giọng nhân bản cá nhân.',
    output: 'audio',
    fields: [
      {
        name: 'voice',
        label: 'Giọng đọc AI',
        type: 'select',
        picker: 'voice',
        allowClonedVoices: true,
        filterLangs: IVOI_LANG_CODES,
        preview: '/api/public/ai/voice-preview/ivoi/{value}',
        required: true,
        default: FALLBACK_VOICE_OPTIONS[0].value,
        options: FALLBACK_VOICE_OPTIONS,
      },
      {
        name: 'text',
        label: 'Văn bản cần chuyển thành giọng nói',
        type: 'textarea',
        required: true,
        max: 100_000,
        placeholder: 'Nhập hoặc dán nội dung văn bản cần đọc tại đây...',
        help: 'Hỗ trợ tới 100.000 ký tự mỗi lượt. Nên dùng dấu chấm, dấu phẩy và xuống dòng rõ ràng để AI ngắt nhịp tự nhiên nhất.',
      },
      {
        name: 'language',
        label: 'Ngôn ngữ đọc',
        type: 'select',
        required: true,
        default: 'auto',
        options: READING_LANGUAGE_OPTIONS,
      },
      {
        name: 'speed',
        label: 'Tốc độ đọc',
        type: 'select',
        required: true,
        default: '1.0',
        options: SPEED_OPTIONS,
      },
      {
        name: 'pausePreset',
        label: 'Nhịp ngắt nghỉ dấu câu',
        type: 'select',
        required: true,
        default: 'default',
        options: PAUSE_OPTIONS,
      },
      {
        name: 'format',
        label: 'Định dạng xuất âm thanh',
        type: 'select',
        required: true,
        default: 'mp3',
        options: FORMAT_OPTIONS,
      },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1,
    priceHint: 'Tính theo độ dài văn bản thực tế (giọng cao cấp & giọng nhân bản nhân hệ số ×2.5)',
    units: (input) => weightedChars(input.text, input.__sample === true) / 1000,
    pricing: { mode: 'cost', markup: 40, min: 100 },
    supportsCost: true,
  },
  {
    key: 'convert-subtitles',
    name: 'Chuyển phụ đề thành giọng nói (.SRT)',
    category: 'giong-noi-ai',
    icon: 'file-audio',
    badge: 'NEW',
    featured: true,
    splitModels: false,
    description: 'Tải lên file phụ đề .SRT / .VTT (hoặc dán nội dung phụ đề) để tự động lồng tiếng khớp chính xác từng mốc thời gian khung hình video.',
    output: 'audio',
    fields: [
      {
        name: 'voice',
        label: 'Giọng đọc AI',
        type: 'select',
        picker: 'voice',
        allowClonedVoices: true,
        filterLangs: IVOI_LANG_CODES,
        preview: '/api/public/ai/voice-preview/ivoi/{value}',
        required: true,
        default: FALLBACK_VOICE_OPTIONS[0].value,
        options: FALLBACK_VOICE_OPTIONS,
      },
      {
        name: 'subtitleFile',
        label: 'File phụ đề (.SRT / .VTT)',
        type: 'file',
        required: false,
        accept: '.srt,.vtt,application/x-subrip,text/srt,text/vtt,text/plain',
        help: 'Hỗ trợ chuẩn SubRip (.srt) và WebVTT (.vtt). Hệ thống tự chèn khoảng lặng và căn chỉnh tốc độ khớp timeline video.',
      },
      {
        name: 'srtText',
        label: 'Hoặc dán trực tiếp nội dung phụ đề (.SRT)',
        type: 'textarea',
        required: false,
        max: 300_000,
        placeholder: '1\n00:00:01,000 --> 00:00:04,200\nXin chào các bạn đến với tập phim hôm nay...\n\n2\n00:00:04,500 --> 00:00:08,000\nHãy cùng khám phá ngay sau đây!',
        help: 'Chỉ tính phí phần lời thoại thực tế (không tính số thứ tự câu và dòng mốc thời gian).',
      },
      {
        name: 'language',
        label: 'Ngôn ngữ đọc',
        type: 'select',
        required: true,
        default: 'auto',
        options: READING_LANGUAGE_OPTIONS,
      },
      {
        name: 'speed',
        label: 'Tốc độ đọc cơ sở',
        type: 'select',
        required: true,
        default: '1.0',
        options: SRT_SPEED_OPTIONS,
      },
      {
        name: 'format',
        label: 'Định dạng xuất âm thanh',
        type: 'select',
        required: true,
        default: 'mp3',
        options: FORMAT_OPTIONS,
      },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1,
    priceHint: 'Chỉ tính ký tự lời thoại trong phụ đề (giọng cao cấp & giọng nhân bản nhân hệ số ×2.5)',
    units: (input) => {
      if (input.__sample === true) return 1;
      const pasted = str(input.srtText).trim();
      if (pasted) {
        const spoken = parseSrtSpokenSafe(pasted);
        return spoken ? weightedChars(spoken, false) / 1000 : 0;
      }
      return 1;
    },
    pricing: { mode: 'cost', markup: 40, min: 100 },
    supportsCost: true,
  },
  {
    key: 'voice-clone',
    name: 'Nhân bản giọng nói AI',
    category: 'giong-noi-ai',
    icon: 'audio-lines',
    badge: 'NEW',
    featured: true,
    splitModels: false,
    description: 'Tạo và quản lý Kho giọng nói nhân bản từ đoạn thu âm mẫu 5–25 giây để sử dụng trực tiếp trong Chuyển văn bản & Chuyển phụ đề (.SRT).',
    output: 'audio',
    fields: [
      {
        name: 'refAudio',
        label: 'File giọng mẫu (5–25 giây)',
        type: 'audio',
        required: true,
        accept: 'audio/wav,audio/mpeg,audio/mp3,audio/flac,audio/ogg,audio/mp4,audio/x-m4a',
        help: 'Chọn đoạn thu âm 1 người nói rõ ràng, không dính nhạc nền hay tiếng ồn (hỗ trợ WAV, MP3, M4A thu âm điện thoại, FLAC, OGG).',
      },
      {
        name: 'refText',
        label: 'Lời nói chính xác trong file mẫu',
        type: 'textarea',
        required: true,
        max: 2_000,
        placeholder: 'Gõ đúng nguyên văn từng chữ người nói đã đọc trong file giọng mẫu ở trên...',
        help: 'Càng khớp chính xác lời trong file mẫu thì giọng nhân bản ra càng giống và tròn chữ.',
      },
      {
        name: 'text',
        label: 'Văn bản muốn đọc bằng giọng nhân bản',
        type: 'textarea',
        required: true,
        max: 100_000,
        placeholder: 'Nhập nội dung kịch bản mới bạn muốn giọng nhân bản đọc...',
      },
      {
        name: 'language',
        label: 'Ngôn ngữ giọng mẫu',
        type: 'select',
        required: true,
        default: 'vi',
        options: IVOI_LANGUAGES,
      },
      {
        name: 'gender',
        label: 'Giới tính giọng mẫu',
        type: 'select',
        required: true,
        default: 'female',
        options: [
          { value: 'female', label: 'Giọng Nữ' },
          { value: 'male', label: 'Giọng Nam' },
        ],
      },
      {
        name: 'speed',
        label: 'Tốc độ đọc',
        type: 'select',
        required: true,
        default: '1.0',
        options: SPEED_OPTIONS,
      },
      {
        name: 'pausePreset',
        label: 'Nhịp ngắt nghỉ dấu câu',
        type: 'select',
        required: true,
        default: 'default',
        options: PAUSE_OPTIONS,
      },
      {
        name: 'format',
        label: 'Định dạng xuất âm thanh',
        type: 'select',
        required: true,
        default: 'mp3',
        options: FORMAT_OPTIONS,
      },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 2.5,
    priceHint: 'Miễn phí lưu giọng vào Kho giọng nhân bản — tính phí khi đọc văn bản hoặc phụ đề (×2.5)',
    units: (input) => weightedChars(input.text, input.__sample === true) / 1000,
    pricing: { mode: 'free', min: 0 },
    supportsCost: true,
  },
];

async function voiceMultiplierOf(voiceId: string, ctx: AiCallContext): Promise<number> {
  if (!voiceId || voiceId === 'default') return 1;
  if (voiceId.startsWith('uvoice_')) {
    return getIvoiCloneMultiplier(ctx.config);
  }
  let voice = globalVoiceById.get(voiceId);
  if (!voice && ctx.config.apiKey) {
    const { items } = await fetchVoices(ctx.config).catch(() => ({ items: [] as IvoiVoiceItem[] }));
    voice = items.find((x) => x.id === voiceId);
  }
  if (voice) {
    if (voice.isCloned && !voice.isPublic) return getIvoiCloneMultiplier(ctx.config);
    if (voice.isPremium && voice.priceMultiplier > 1) return voice.priceMultiplier;
  }
  return 1;
}

export const ivoiProvider: AiProvider = {
  key: 'ivoi',
  name: 'iVoi TTS (ivoi.io)',
  website: 'https://ivoi.io',
  tools: TOOLS,
  costUnit: 'nghìn token',
  // Mốc mặc định 350đ / 1.000 token (khớp gói CREATOR 349đ; gói PRO 254đ, BUSINESS 149đ, BASIC 499đ)
  rate: 350,

  async resolveFields(tool, ctx) {
    if ((tool.key !== 'tts' && tool.key !== 'convert-subtitles') || !ctx.config.apiKey) return tool.fields;
    const { options } = await fetchVoices(ctx.config);
    if (!options.length) return tool.fields;
    return tool.fields.map((f) =>
      f.name === 'voice'
        ? { ...f, default: options[0].value, options }
        : f,
    );
  },

  async cost(tool, input, ctx) {
    const isSample = input.__sample === true;
    if (tool.key === 'voice-clone') {
      const chars = weightedChars(input.text, isSample);
      if (chars <= 0) return 0;
      const cloneMult = await getIvoiCloneMultiplier(ctx.config);
      return (chars * cloneMult) / 1000;
    }

    const mult = await voiceMultiplierOf(str(input.voice).trim(), ctx);

    if (tool.key === 'convert-subtitles') {
      if (isSample) return mult;
      const parsed = await resolveSubtitleInput(input, ctx);
      if (!parsed) return 0;
      const chars = weightedChars(parsed.spokenText, false);
      return chars > 0 ? (chars * mult) / 1000 : 0;
    }

    const chars = weightedChars(input.text, isSample);
    if (chars <= 0) return 0;
    return (chars * mult) / 1000;
  },

  async submit(tool, input, ctx) {
    const format = str(input.format) === 'wav' ? 'wav' : 'mp3';
    const maxSpeed = tool.key === 'convert-subtitles' ? 3.0 : 2.0;
    const speed = Math.min(maxSpeed, Math.max(0.5, Number(input.speed) || 1.0));
    const reqLang = str(input.language).trim().toLowerCase();

    if (tool.key === 'convert-subtitles') {
      const parsed = await resolveSubtitleInput(input, ctx);
      if (!parsed) {
        throw new BadRequestException('Vui lòng tải lên file phụ đề (.SRT / .VTT) hoặc dán nội dung phụ đề vào ô bên dưới');
      }
      const { upstreamVoiceId, voiceLanguage } = await resolveTargetVoice(str(input.voice).trim(), ctx);
      const language = reqLang && reqLang !== 'auto' ? reqLang : voiceLanguage || 'vi';

      const form = new FormData();
      form.append('file', new Blob([Buffer.from(parsed.srtText, 'utf8')], { type: 'text/plain' }), 'subtitles.srt');
      form.append('voice_id', upstreamVoiceId);
      form.append('format', format);
      form.append('language', language);
      form.append('speed', String(speed));

      const res = await ivoiJson<any>(ctx.config, v1Url(ctx.config, '/tts/synthesize-srt'), {
        method: 'POST',
        body: form,
        timeoutMs: 90_000,
      });

      const jobId = str(res?.job_id ?? res?.id).trim();
      const directUrl = str(res?.audio_url).trim();
      const status = str(res?.status).toLowerCase();

      if (directUrl && (status === 'completed' || status === 'succeeded' || status === 'done' || !jobId)) {
        const file = await downloadAudioOutput(directUrl, jobId || `srt_${Date.now()}`, format);
        return {
          status: 'succeeded',
          providerTaskId: jobId || undefined,
          files: [{ url: '', type: 'audio', name: file.name, data: file.data, mimeType: file.mimeType }],
          raw: res,
        };
      }
      if (!jobId) {
        throw new AiProviderError('Máy chủ xử lý phụ đề chưa trả mã tác vụ hợp lệ, vui lòng thử lại', { res }, true);
      }
      return { status: 'processing', providerTaskId: `${jobId}::::${format}`, progress: 15, raw: res };
    }

    const pauseSettings = pauseSettingsOf(str(input.pausePreset));
    const text = str(input.text).trim();
    if (!text) throw new BadRequestException('Vui lòng nhập nội dung văn bản cần chuyển thành giọng nói');

    let voiceId = str(input.voice).trim();
    let tempCloneId = '';
    let language = reqLang && reqLang !== 'auto' ? reqLang : '';

    if (tool.key === 'voice-clone') {
      const refAudioUrl = str(input.refAudio).trim();
      const refText = str(input.refText).trim();
      if (!refAudioUrl) throw new BadRequestException('Vui lòng tải lên file giọng mẫu');
      if (!refText) throw new BadRequestException('Vui lòng nhập lời nói tương ứng trong file giọng mẫu');

      const uploaded = await loadInputFile(ctx.readUpload, refAudioUrl);
      const norm = await normalizeIvoiRefAudio(uploaded.data, uploaded.filename, uploaded.mimeType);
      await freeUpstreamCloneSlots(ctx.config, false);

      const cloneName = `${TMP_VOICE_PREFIX}${Date.now()}_${randomBytes(3).toString('hex')}`;
      const gender = str(input.gender) === 'male' ? 'male' : 'female';
      language = language || 'vi';

      const doClone = async () => {
        const form = new FormData();
        form.append('ref_audio', new Blob([new Uint8Array(norm.data)], { type: norm.mimeType }), norm.filename);
        form.append('name', cloneName);
        form.append('ref_text', refText);
        form.append('language', language);
        form.append('gender', gender);
        return ivoiJson<{ voice_id?: string; id?: string }>(ctx.config, v1Url(ctx.config, '/voices/clone'), {
          method: 'POST',
          body: form,
          timeoutMs: 60_000,
        });
      };

      let cloned: { voice_id?: string; id?: string };
      try {
        cloned = await doClone();
      } catch (err) {
        await freeUpstreamCloneSlots(ctx.config, true);
        cloned = await doClone().catch(() => {
          throw err;
        });
      }

      tempCloneId = str(cloned?.voice_id ?? cloned?.id).trim();
      if (!tempCloneId) {
        throw new AiProviderError('Không tạo được mẫu giọng nhân bản từ file âm thanh này, vui lòng chọn đoạn thu âm rõ tiếng hơn', { cloned }, false);
      }
      voiceId = tempCloneId;
      await sleep(2_500);
    } else {
      const resolved = await resolveTargetVoice(voiceId, ctx);
      voiceId = resolved.upstreamVoiceId;
      if (!language) language = resolved.voiceLanguage;
    }

    const payload: Record<string, unknown> = {
      text,
      voice_id: voiceId,
      format,
      speed,
      ...(language ? { language } : {}),
      ...(pauseSettings ? { pause_settings: pauseSettings } : {}),
    };

    let res: any;
    try {
      res = await ivoiJson<any>(ctx.config, v1Url(ctx.config, '/tts/synthesize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
      });
    } catch (err) {
      if (tempCloneId) await deleteVoiceOnIvoi(ctx.config, tempCloneId);
      throw err;
    }

    const jobId = str(res?.job_id ?? res?.id).trim();
    const directUrl = str(res?.audio_url).trim();
    const status = str(res?.status).toLowerCase();

    if (directUrl && (status === 'completed' || status === 'succeeded' || status === 'done' || !jobId)) {
      try {
        const file = await downloadAudioOutput(directUrl, jobId || `tts_${Date.now()}`, format);
        return {
          status: 'succeeded',
          providerTaskId: jobId || undefined,
          files: [{ url: '', type: 'audio', name: file.name, data: file.data, mimeType: file.mimeType }],
          raw: res,
        };
      } finally {
        if (tempCloneId) await deleteVoiceOnIvoi(ctx.config, tempCloneId);
      }
    }

    if (!jobId) {
      if (tempCloneId) await deleteVoiceOnIvoi(ctx.config, tempCloneId);
      throw new AiProviderError('Máy chủ giọng đọc chưa trả mã xử lý hợp lệ, vui lòng thử lại', { res }, true);
    }

    const compositeId = `${jobId}::${tempCloneId}::${format}`;
    return { status: 'processing', providerTaskId: compositeId, progress: 15, raw: res };
  },

  async poll(_tool, providerTaskId, ctx) {
    const [jobId, tempCloneId = '', fmt = 'mp3'] = providerTaskId.split('::');
    if (!jobId) return { status: 'failed', error: 'Mã tác vụ giọng đọc không hợp lệ' };

    const job = await ivoiJson<any>(ctx.config, v1Url(ctx.config, `/tts/jobs/${encodeURIComponent(jobId)}`), {
      timeoutMs: 30_000,
    });

    const status = str(job?.status).toLowerCase();
    const audioUrl = str(job?.audio_url).trim();

    if ((status === 'completed' || status === 'succeeded' || status === 'done') && audioUrl) {
      const file = await downloadAudioOutput(audioUrl, jobId, fmt);
      if (tempCloneId) await deleteVoiceOnIvoi(ctx.config, tempCloneId);
      return {
        status: 'succeeded',
        providerTaskId,
        files: [{ url: '', type: 'audio', name: file.name, data: file.data, mimeType: file.mimeType }],
        raw: job,
      };
    }

    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      if (tempCloneId) await deleteVoiceOnIvoi(ctx.config, tempCloneId);
      const errMsg = hideProviderText(str(job?.error_message ?? job?.error ?? job?.detail ?? job?.message));
      return {
        status: 'failed',
        providerTaskId,
        error: errMsg ? `${errMsg}. Tiền đã được hoàn lại vào ví` : 'Xử lý giọng đọc thất bại, tiền đã được hoàn lại vào ví',
        raw: job,
      };
    }

    return {
      status: 'processing',
      providerTaskId,
      progress: Number(job?.progress) || 55,
      raw: job,
    };
  },

  async voiceSample(voiceId, ctx) {
    if (!voiceId || voiceId === 'default' || voiceId.startsWith('uvoice_')) return null;
    let voice = globalVoiceById.get(voiceId);
    if (!voice && ctx.config.apiKey) {
      const { items } = await fetchVoices(ctx.config).catch(() => ({ items: [] as IvoiVoiceItem[] }));
      voice = items.find((x) => x.id === voiceId);
    }
    if (!voice) return null;

    if (voice.sampleUrl) {
      const r = await fetch(voice.sampleUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (r?.ok) {
        const data = Buffer.from(await r.arrayBuffer());
        if (data.length > 256) {
          return { data, mimeType: r.headers.get('content-type') || 'audio/mpeg' };
        }
      }
    }

    if (!ctx.config.apiKey) return null;
    const sampleText =
      voice.language === 'en'
        ? 'Hello, this is a natural AI voice preview.'
        : 'Xin chào, đây là giọng đọc mẫu tự nhiên của hệ thống.';

    const created = await ivoiJson<any>(ctx.config, v1Url(ctx.config, '/tts/synthesize'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sampleText, voice_id: voice.id, format: 'mp3', speed: 1.0, language: voice.language || 'vi' }),
      timeoutMs: 30_000,
    });
    const direct = str(created?.audio_url).trim();
    if (direct) {
      const out = await downloadAudioOutput(direct, 'sample', 'mp3');
      return { data: out.data, mimeType: out.mimeType };
    }
    const jid = str(created?.job_id ?? created?.id).trim();
    if (!jid) return null;
    for (let i = 0; i < 12; i++) {
      await sleep(2_000);
      const job = await ivoiJson<any>(ctx.config, v1Url(ctx.config, `/tts/jobs/${encodeURIComponent(jid)}`), { timeoutMs: 15_000 }).catch(() => null);
      const st = str(job?.status).toLowerCase();
      const url = str(job?.audio_url).trim();
      if ((st === 'completed' || st === 'done' || st === 'succeeded') && url) {
        const out = await downloadAudioOutput(url, 'sample', 'mp3');
        return { data: out.data, mimeType: out.mimeType };
      }
      if (st === 'failed' || st === 'error') break;
    }
    return null;
  },

  async balance(ctx) {
    if (!ctx.config.apiKey) return null;
    for (const path of ['/api/v1/account', '/users/me']) {
      try {
        const url = path.startsWith('/api/v1') ? v1Url(ctx.config, path.slice(7)) : `${apiRoot(ctx.config)}${path}`;
        const res = await ivoiJson<any>(ctx.config, url, { timeoutMs: 12_000 });
        const rawTokens = Number(
          res?.total_tokens ?? res?.remaining_tokens ?? res?.tokens ?? res?.balance ?? res?.data?.total_tokens ?? NaN,
        );
        if (Number.isFinite(rawTokens)) {
          return { balance: Math.round((rawTokens / 1000) * 10) / 10, unit: 'nghìn token' };
        }
      } catch {
        /* thử tiếp đường dẫn kế tiếp */
      }
    }
    return null;
  },

  async catalog(ctx) {
    if (!ctx.config.apiKey) return [];
    const { items } = await fetchVoices(ctx.config, true);
    return items.map((v) => ({ id: v.id, label: `${v.name} (${v.language.toUpperCase()})` }));
  },

  async maintenanceCheck(ctx) {
    if (!ctx.config.apiKey?.trim()) return null;
    const { items } = await fetchVoices(ctx.config, false).catch(() => ({ items: [] as any[] }));
    if (!items.length) return null;
    return new Set<string>();
  },
};
