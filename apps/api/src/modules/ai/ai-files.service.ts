import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { copyFile, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { STORAGE, type StorageDriver } from '../media/storage.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AiProviderError, type AiOutputFile } from './ai.types.js';
import { mediaDuration, mediaDurationFile } from './media-duration.js';

const execFileAsync = promisify(execFile);
const MIRROR_TMP_DIR = join(tmpdir(), 'novai-ai-mirror');
mkdirSync(MIRROR_TMP_DIR, { recursive: true });

/** Định dạng file khách được tải lên làm đầu vào cho công cụ AI */
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'text/plain': 'txt',
  'text/srt': 'srt',
  'application/x-subrip': 'srt',
  'text/vtt': 'vtt',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(ALLOWED).map(([m, e]) => [e, m]));

/** Trần dung lượng file nạp vào RAM (tải từ link, ảnh / phụ đề tải lên) — cài đặt "file tối đa" không vượt mức này */
export const AI_UPLOAD_HARD_MB = 100;

/**
 * Trần dung lượng video / âm thanh khách tải lên (MB): multer ghi thẳng ra file tạm trên đĩa nên nhận được file lớn
 * (vd video 60 phút cần lồng tiếng, nhà cung cấp nhận tới 1GB). Nginx phải cho `client_max_body_size` ≥ mức này ở /api/account/ai/uploads.
 */
export const AI_MEDIA_UPLOAD_HARD_MB = 1024;

/** File tải lên: nội dung trong RAM (`buffer`) hoặc file tạm trên đĩa (`path`, multer diskStorage) */
export interface AiInputFile {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Đuôi file an toàn lấy từ phần cuối đường dẫn URL (vd .../a/b.mp4?x=1 -> mp4), không hợp lệ -> null */
const extFromUrl = (url: string) => {
  try {
    const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Thư mục theo tháng: 202610 */
const month = () => new Date().toISOString().slice(0, 7).replace('-', '');

/**
 * File của AI Studio trên storage (local / S3 như thư viện media):
 * - `ai/inputs/<userId>/...`: file khách tải lên làm đầu vào (ảnh mẫu, video cần lồng tiếng, file phụ đề…);
 * - `ai/outputs/<userId>/...`: bản sao kết quả tải về từ nhà cung cấp (link của nhà cung cấp thường hết hạn).
 */
@Injectable()
export class AiFilesService {
  private readonly logger = new Logger('AiFiles');
  /** Bộ nhớ đệm video đã cắt đuôi theo `<url>::<trimSec>` để khách nhân bản nhiều bản (`copies: 4`) không phải chạy lại ffmpeg */
  private readonly trimmedVideoCache = new Map<string, { url: string; destPath: string; at: number }>();
  private readonly trimmingInFlight = new Map<string, Promise<string>>();
  private activeTrims = 0;
  private readonly trimWaiters: (() => void)[] = [];

  constructor(
    @Inject(STORAGE) private readonly storage: StorageDriver,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Khách tải lên file đầu vào -> URL công khai để gửi cho nhà cung cấp.
   * Giới hạn dung lượng ở Cài đặt › AI: video / âm thanh theo `maxMediaUploadMb` (mặc định 1024MB), file khác theo `maxUploadMb`.
   */
  async saveInput(userId: string, file: AiInputFile) {
    // .srt thường được trình duyệt gửi là application/octet-stream -> nhận theo đuôi file; ảnh gửi nhầm text/plain -> nhận theo chữ ký byte đầu
    const extFromName = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    let mime = ALLOWED[file.mimetype] ? file.mimetype : EXT_MIME[extFromName] ?? '';
    if ((!mime || mime === 'text/plain') && file.buffer && file.buffer.length >= 12) {
      if (file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff) mime = 'image/jpeg';
      else if (file.buffer[0] === 0x89 && file.buffer[1] === 0x50 && file.buffer[2] === 0x4e && file.buffer[3] === 0x47) mime = 'image/png';
      else if (file.buffer.subarray(0, 4).toString('ascii') === 'RIFF' && file.buffer.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
    }
    const ext = ALLOWED[mime];
    if (!ext) throw new BadRequestException('Định dạng file không được hỗ trợ (ảnh PNG/JPG/WEBP, video MP4/MOV/WEBM, âm thanh MP3/WAV/M4A, phụ đề SRT/VTT)');
    const s = await this.settings.get<{ maxUploadMb?: number; maxMediaUploadMb?: number }>('ai');
    const media = /^(video|audio)\//.test(mime);
    // file trong RAM (tải từ link) luôn giữ trần 100MB; file video / âm thanh ghi ra đĩa được tới 1GB
    const hard = media && file.path ? AI_MEDIA_UPLOAD_HARD_MB : AI_UPLOAD_HARD_MB;
    const maxMb = Math.min(hard, Math.max(1, Number(media ? s.maxMediaUploadMb : s.maxUploadMb) || (media ? AI_MEDIA_UPLOAD_HARD_MB : 50)));
    if (file.size > maxMb * 1024 * 1024) throw new BadRequestException(`File tối đa ${maxMb >= 1024 ? `${+(maxMb / 1024).toFixed(1)}GB` : `${maxMb}MB`}`);
    // Tự động chuẩn hoá ảnh .webp sang .png (nếu có kênh trong suốt) hoặc .jpg nét cao (q=95) ngay lúc tải lên để không nguồn AI nào báo lỗi từ chối .webp (T-417)
    if (mime === 'image/webp') {
      try {
        const rawBuf = file.buffer ?? (file.path ? await readFile(file.path) : null);
        if (rawBuf) {
          const meta = await sharp(rawBuf).metadata();
          const usePng = Boolean(meta.hasAlpha);
          const convBuf = usePng ? await sharp(rawBuf).png().toBuffer() : await sharp(rawBuf).jpeg({ quality: 95 }).toBuffer();
          const convMime = usePng ? 'image/png' : 'image/jpeg';
          const convExt = usePng ? 'png' : 'jpg';
          const convPath = `ai/inputs/${userId}/${month()}/${randomUUID()}.${convExt}`;
          await this.storage.put(convPath, convBuf, convMime);
          return { url: this.storage.url(convPath), name: file.originalname.slice(0, 200), mimeType: convMime, size: convBuf.length };
        }
      } catch {
        /* nếu file .webp đặc biệt không chuyển được thì lưu nguyên bản bên dưới */
      }
    }
    const path = `ai/inputs/${userId}/${month()}/${randomUUID()}.${ext}`;
    if (file.path) await this.storage.putFile(path, file.path, mime);
    else if (file.buffer) await this.storage.put(path, file.buffer, mime);
    else throw new BadRequestException('Chưa chọn file');
    return { url: this.storage.url(path), name: file.originalname.slice(0, 200), mimeType: mime, size: file.size };
  }

  /** Chuẩn hoá URL ảnh đầu vào `.webp` (kể cả URL ảnh trên web con gửi qua API) sang `.jpg` / `.png` để tương thích mọi workflow nguồn (T-417 / T-507) */
  async ensureStandardImageUrl(url: string, userId?: string): Promise<string> {
    if (!url || !/\.webp(\?|$)/i.test(url)) return url;
    let tmpPath: string | null = null;
    try {
      let rawBuf: Buffer | null = null;
      const f = await this.read(url).catch(() => null);
      if (f?.data) {
        rawBuf = f.data;
      } else if (/^https?:\/\//i.test(url)) {
        const dl = await this.downloadToTempFile(url, 50 * 1024 * 1024, 30_000);
        tmpPath = dl.tmpPath;
        rawBuf = await readFile(tmpPath);
      }
      if (!rawBuf || !rawBuf.length) return url;
      const meta = await sharp(rawBuf).metadata();
      const usePng = Boolean(meta.hasAlpha);
      const convBuf = usePng ? await sharp(rawBuf).png().toBuffer() : await sharp(rawBuf).jpeg({ quality: 95 }).toBuffer();
      const convMime = usePng ? 'image/png' : 'image/jpeg';
      const convExt = usePng ? 'png' : 'jpg';
      const convPath = `ai/inputs/${userId || 'converted'}/${month()}/${randomUUID()}.${convExt}`;
      await this.storage.put(convPath, convBuf, convMime);
      return this.storage.url(convPath);
    } catch {
      return url;
    } finally {
      if (tmpPath) await unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * Lưu ảnh / video đính kèm trong Ticket hỗ trợ vào thư mục riêng `tickets/<YYYYMM>/...`
   * để vĩnh viễn không bị cron dọn dẹp tác vụ AI (`AiCleanupService`) xoá mất.
   */
  async saveTicketMedia(file: AiInputFile) {
    const TICKET_ALLOWED: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
    };
    const TICKET_EXT: Record<string, string> = Object.fromEntries(Object.entries(TICKET_ALLOWED).map(([m, e]) => [e, m]));
    const extFromName = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const mime = TICKET_ALLOWED[file.mimetype] ? file.mimetype : TICKET_EXT[extFromName] ?? '';
    const ext = TICKET_ALLOWED[mime];
    if (!ext) throw new BadRequestException('Định dạng không hỗ trợ (chỉ nhận ảnh PNG/JPG/WEBP/GIF hoặc video MP4/WEBM/MOV)');
    if (file.size > 200 * 1024 * 1024) throw new BadRequestException('Tệp đính kèm ticket tối đa 200MB');
    const path = `tickets/${month()}/${randomUUID()}.${ext}`;
    if (file.path) await this.storage.putFile(path, file.path, mime);
    else if (file.buffer) await this.storage.put(path, file.buffer, mime);
    else throw new BadRequestException('Chưa chọn file');
    const kind: 'image' | 'video' = mime.startsWith('video/') ? 'video' : 'image';
    return { url: this.storage.url(path), name: file.originalname.slice(0, 200), mimeType: mime, size: file.size, kind };
  }

  /** Đường dẫn trong storage của một URL do mình cấp (null nếu không phải file của mình) */
  pathOf(url: string) {
    const base = this.storage.url('');
    return typeof url === 'string' && url.startsWith(base) ? url.slice(base.length).split('?')[0] : null;
  }

  /** URL đầu vào có đúng là file của khách này tải lên không (chặn dùng file của người khác) */
  ownsInput(userId: string, url: string) {
    const p = this.pathOf(url);
    // ảnh / video khách đã tạo (kết quả đã sao lưu về storage) cũng dùng làm đầu vào được, vd tạo video hàng loạt "Từ dự án ảnh"
    return !!p && (p.startsWith(`ai/inputs/${userId}/`) || p.startsWith(`ai/outputs/${userId}/`)) && !p.includes('..');
  }

  /** Đọc nội dung file đầu vào (adapter cần upload trực tiếp lên nhà cung cấp) */
  async read(url: string) {
    const p = this.pathOf(url);
    if (!p || !(p.startsWith('ai/inputs/') || p.startsWith('ai/outputs/')) || p.includes('..')) return null;
    let data: Buffer;
    try {
      data = await this.storage.get(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || /ENOENT|no such file/i.test(String((err as Error)?.message ?? ''))) {
        throw new AiProviderError(
          'Ảnh hoặc tệp đầu vào tham chiếu đã quá hạn lưu trữ — vui lòng tải lại tệp tham chiếu mới (tiền đã được hoàn lại vào ví)',
          false,
        );
      }
      throw err;
    }
    const ext = p.split('.').pop() ?? '';
    return { data, mimeType: EXT_MIME[ext] ?? 'application/octet-stream', filename: p.split('/').pop() ?? `file.${ext}` };
  }

  /**
   * Tra cứu file kết quả thuộc storage của hệ thống để tải trực tiếp / đóng gói .ZIP hàng loạt:
   * storage local trả đường dẫn tuyệt đối trên đĩa (stream 0-RAM); storage S3 trả hàm đọc Buffer.
   */
  resolveOutput(url: string): { path: string; localFile: string | null; mimeType: string; ext: string; readBuffer: () => Promise<Buffer> } | null {
    const p = this.pathOf(url);
    if (!p || !p.startsWith('ai/outputs/') || p.includes('..')) return null;
    const ext = (p.split('.').pop() ?? '').toLowerCase();
    const mimeType = EXT_MIME[ext] ?? 'application/octet-stream';
    const localFile = this.storage.localPath ? this.storage.localPath(p) : null;
    if (localFile && !existsSync(localFile)) return null;
    return { path: p, localFile, mimeType, ext: ext || 'bin', readBuffer: () => this.storage.get(p) };
  }

  /**
   * Thời lượng (giây) của file đầu vào khách đã tải lên; null khi không phải file của mình hoặc không nhận ra định dạng.
   * Storage local thì chỉ đọc phần cần thiết của file (video lớn tới 1GB), S3 thì tải cả file.
   */
  async duration(url: string): Promise<number | null> {
    const p = this.pathOf(url);
    if (!p || !(p.startsWith('ai/inputs/') || p.startsWith('ai/outputs/')) || !p.trim() || p.includes('..')) return null;
    if (this.storage.localPath) {
      const abs = this.storage.localPath(p);
      const parsed = await mediaDurationFile(abs).catch(() => null);
      if (parsed !== null && Number.isFinite(parsed) && parsed > 0) return parsed;
      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs],
          { timeout: 10_000 },
        );
        const probed = Number(String(stdout ?? '').trim());
        return Number.isFinite(probed) && probed > 0 ? probed : null;
      } catch {
        return null;
      }
    }
    return mediaDuration(await this.storage.get(p));
  }

  /**
   * Tải một URL về file tạm trên đĩa theo luồng (stream 0-RAM), kiểm tra trần dung lượng ngay khi đang nhận dữ liệu.
   * Tránh nạp cả video 100–300MB vào `ArrayBuffer` trong RAM khiến tiến trình API chạm ngưỡng bộ nhớ khi nhiều tác vụ về đích cùng lúc.
   */
  private async downloadToTempFile(url: string, maxBytes: number, timeoutMs: number): Promise<{ tmpPath: string; contentType: string; size: number }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new Error('file quá lớn');
    }
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const tmpPath = join(MIRROR_TMP_DIR, `${randomUUID()}.part`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) {
          cb(new Error('file quá lớn'));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), limiter, createWriteStream(tmpPath));
      if (received <= 0) throw new Error('file rỗng');
      return { tmpPath, contentType, size: received };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Sao kết quả của nhà cung cấp về storage của mình (link gốc thường hết hạn sau vài giờ / ngày).
   * Lỗi hoặc file quá lớn thì giữ nguyên link gốc — không làm hỏng tác vụ.
   */
  async mirror(userId: string, files: AiOutputFile[]): Promise<AiOutputFile[]> {
    const s = await this.settings.get<{ mirrorOutputs?: boolean; mirrorMaxMb?: number }>('ai');
    const maxBytes = Math.max(1, Number(s.mirrorMaxMb) || 300) * 1024 * 1024;
    return Promise.all(
      files.map(async (f): Promise<AiOutputFile> => {
        // nhà cung cấp trả thẳng nội dung file -> luôn phải lưu
        if (f.data) {
          const mime = f.mimeType || 'application/octet-stream';
          const path = `ai/outputs/${userId}/${month()}/${randomUUID()}.${ALLOWED[mime] ?? 'bin'}`;
          await this.storage.put(path, f.data, mime);
          return { url: this.storage.url(path), type: f.type, name: f.name };
        }
        if (s.mirrorOutputs === false) return f;
        if (this.pathOf(f.url) || !/^https?:\/\//i.test(f.url)) return f;
        let tmpPath: string | null = null;
        try {
          const timeoutMs = f.type === 'image' ? 60_000 : 180_000;
          const dl = await this.downloadToTempFile(f.url, maxBytes, timeoutMs);
          tmpPath = dl.tmpPath;
          const mime = dl.contentType;
          const ext = ALLOWED[mime] ?? extFromUrl(f.url) ?? 'bin';
          const path = `ai/outputs/${userId}/${month()}/${randomUUID()}.${ext}`;
          await this.storage.putFile(path, tmpPath, mime || undefined);
          return { ...f, url: this.storage.url(path), sourceUrl: f.url };
        } catch (err) {
          this.logger.warn(`Không sao lưu được kết quả ${f.url}: ${(err as Error).message}`);
          return f;
        } finally {
          if (tmpPath) await unlink(tmpPath).catch(() => undefined);
        }
      }),
    );
  }

  /** Đường dẫn file nghe thử giọng đọc do API tự tạo (vd ai/voice-samples/kapend/BV421_vivn_streaming.mp3) */
  private samplePath(provider: string, voice: string) {
    const safe = voice.replace(/[^\w.-]/g, '_');
    const suffix = /[^\w.-]/.test(voice) ? `_${createHash('sha1').update(voice).digest('hex').slice(0, 8)}` : '';
    return `ai/voice-samples/${provider}/${safe}${suffix}.mp3`;
  }

  /** Đọc file nghe thử đã tạo trước đó, chưa có -> null */
  async readVoiceSample(provider: string, voice: string) {
    return this.storage.get(this.samplePath(provider, voice)).catch(() => null);
  }

  /** Lưu file nghe thử vừa tạo để lần sau không phải gọi nhà cung cấp nữa */
  async saveVoiceSample(provider: string, voice: string, data: Buffer, mimeType: string) {
    await this.storage.put(this.samplePath(provider, voice), data, mimeType);
  }

  /** Đường dẫn file giọng mẫu chuẩn hoá trong Kho giọng nhân bản cá nhân (`ai/voice-vault/<voiceId>.wav` — giữ lâu dài tới khi khách xoá) */
  private vaultSamplePath(voiceId: string) {
    return `ai/voice-vault/${voiceId.replace(/[^a-f0-9]/gi, '')}.wav`;
  }

  async saveVaultVoiceSample(voiceId: string, data: Buffer, mimeType = 'audio/wav') {
    const path = this.vaultSamplePath(voiceId);
    await this.storage.put(path, data, mimeType);
    return path;
  }

  async readVaultVoiceSample(voiceId: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const data = await this.storage.get(this.vaultSamplePath(voiceId)).catch(() => null);
    return data && data.length > 128 ? { data, mimeType: 'audio/wav' } : null;
  }

  async deleteVaultVoiceSample(voiceId: string) {
    await this.storage.delete(this.vaultSamplePath(voiceId)).catch(() => undefined);
  }

  /**
   * Admin tải lên video / ảnh mẫu hướng dẫn hiển thị trên trang công cụ khách (lưu tại `ai/demos/...`, không bị dọn bởi AiCleanupService).
   */
  async saveDemoMedia(file: AiInputFile) {
    const DEMO_ALLOWED: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
    };
    const DEMO_EXT: Record<string, string> = Object.fromEntries(Object.entries(DEMO_ALLOWED).map(([m, e]) => [e, m]));
    const extFromName = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const mime = DEMO_ALLOWED[file.mimetype] ? file.mimetype : DEMO_EXT[extFromName] ?? '';
    const ext = DEMO_ALLOWED[mime];
    if (!ext) throw new BadRequestException('Định dạng không hỗ trợ (chỉ nhận video MP4/WEBM/MOV hoặc ảnh GIF/WEBP/PNG/JPG)');
    if (file.size > 200 * 1024 * 1024) throw new BadRequestException('Video / ảnh mẫu tối đa 200MB');
    const path = `ai/demos/${month()}/${randomUUID()}.${ext}`;
    if (file.path) await this.storage.putFile(path, file.path, mime);
    else if (file.buffer) await this.storage.put(path, file.buffer, mime);
    else throw new BadRequestException('Chưa chọn file');
    return { url: this.storage.url(path), name: file.originalname.slice(0, 200), mimeType: mime, size: file.size };
  }

  /**
   * Sao chép / tải URL kết quả tác vụ sang thư mục `ai/demos/...` để làm video / ảnh mẫu vĩnh viễn
   * (không bị hết hạn link nhà cung cấp và không bị AiCleanupService xoá theo ngày lưu trữ tác vụ).
   */
  async mirrorDemoUrl(rawUrl: string): Promise<string> {
    const clean = rawUrl.trim();
    if (!clean || clean.includes('/ai/demos/')) return clean;
    const DEMO_MIMES: Record<string, string> = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      gif: 'image/gif',
      webp: 'image/webp',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    };
    try {
      const localMatch = /\/uploads\/(.+?)(?:\?|$)/.exec(clean);
      if (localMatch?.[1]) {
        const srcKey = decodeURIComponent(localMatch[1]);
        const rawExt = (srcKey.split('.').pop() ?? '').toLowerCase();
        const mime = DEMO_MIMES[rawExt] ?? 'video/mp4';
        const ext = rawExt === 'jpeg' ? 'jpg' : DEMO_MIMES[rawExt] ? rawExt : 'mp4';
        const dest = `ai/demos/${month()}/${randomUUID()}.${ext}`;
        if (this.storage.localPath) {
          const srcAbs = this.storage.localPath(srcKey);
          if (existsSync(srcAbs)) {
            const tmpCopy = join(MIRROR_TMP_DIR, `${randomUUID()}.${ext}`);
            try {
              await copyFile(srcAbs, tmpCopy);
              await this.storage.putFile(dest, tmpCopy, mime);
              return this.storage.url(dest);
            } finally {
              await unlink(tmpCopy).catch(() => undefined);
            }
          }
        } else {
          const buf = await this.storage.get(srcKey).catch(() => null);
          if (buf && buf.length > 0) {
            await this.storage.put(dest, buf, mime);
            return this.storage.url(dest);
          }
        }
      }
      if (/^https?:\/\//i.test(clean)) {
        let tmpPath: string | null = null;
        try {
          const dl = await this.downloadToTempFile(clean, 200 * 1024 * 1024, 60_000);
          tmpPath = dl.tmpPath;
          const ct = dl.contentType.toLowerCase();
          const urlExt = (extFromUrl(clean) ?? '').toLowerCase();
          const ext =
            ct === 'video/webm' || urlExt === 'webm'
              ? 'webm'
              : ct === 'video/quicktime' || urlExt === 'mov'
                ? 'mov'
                : ct === 'image/gif' || urlExt === 'gif'
                  ? 'gif'
                  : ct === 'image/webp' || urlExt === 'webp'
                    ? 'webp'
                    : ct === 'image/png' || urlExt === 'png'
                      ? 'png'
                      : ct === 'image/jpeg' || urlExt === 'jpg' || urlExt === 'jpeg'
                        ? 'jpg'
                        : 'mp4';
          const dest = `ai/demos/${month()}/${randomUUID()}.${ext}`;
          await this.storage.putFile(dest, tmpPath, DEMO_MIMES[ext] ?? 'video/mp4');
          return this.storage.url(dest);
        } finally {
          if (tmpPath) await unlink(tmpPath).catch(() => undefined);
        }
      }
    } catch (err) {
      this.logger.warn(`mirrorDemoUrl fallback for ${clean}: ${(err as Error).message}`);
    }
    return clean;
  }

  /**
   * Cắt bỏ chính xác `trimSec` giây ở cuối video đầu vào (vd 0.3s cuối chứa frame logo/chuyển cảnh rác làm lỗi Motion Control),
   * chuẩn hoá H.264 MP4 `yuv420p` khớp frame và lưu vào `ai/inputs/...` để cấp URL công khai gửi sang nhà cung cấp.
   * Video quá ngắn (≤ trimSec + 0.3s) hoặc lỗi đọc hiếm gặp thì giữ nguyên URL gốc an toàn.
   */
  async trimVideoTail(rawUrl: string, trimSec: number, userId = 'system'): Promise<string> {
    const clean = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!clean || !(trimSec > 0)) return clean;

    const cacheKey = `${clean}::${trimSec.toFixed(3)}`;
    const hit = this.trimmedVideoCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) {
      const localOk = !this.storage.localPath || existsSync(this.storage.localPath(hit.destPath));
      if (localOk) return hit.url;
      this.trimmedVideoCache.delete(cacheKey);
    }

    const inflight = this.trimmingInFlight.get(cacheKey);
    if (inflight) return inflight;

    const job = this.runTrimVideoTail(clean, trimSec, userId, cacheKey).finally(() => {
      this.trimmingInFlight.delete(cacheKey);
    });
    this.trimmingInFlight.set(cacheKey, job);
    return job;
  }

  private async runTrimVideoTail(clean: string, trimSec: number, userId: string, cacheKey: string): Promise<string> {
    if (this.activeTrims < 2) {
      this.activeTrims++;
    } else {
      await new Promise<void>((r) => this.trimWaiters.push(r));
    }

    let srcFile: string | null = null;
    let cleanupSrc = false;
    let tmpOut: string | null = null;
    try {
      const p = this.pathOf(clean);
      if (p && (p.startsWith('ai/inputs/') || p.startsWith('ai/outputs/')) && !p.includes('..') && this.storage.localPath) {
        const abs = this.storage.localPath(p);
        if (existsSync(abs)) srcFile = abs;
      }
      if (!srcFile) {
        if (!/^https?:\/\//i.test(clean)) return clean;
        const dl = await this.downloadToTempFile(clean, AI_MEDIA_UPLOAD_HARD_MB * 1024 * 1024, 120_000);
        srcFile = dl.tmpPath;
        cleanupSrc = true;
      }

      let rawDur = 0;
      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', srcFile],
          { timeout: 15_000 },
        );
        const info = JSON.parse(String(stdout || '{}')) as {
          streams?: { duration?: string | number }[];
          format?: { duration?: string | number };
        };
        const sDur = Number(info.streams?.[0]?.duration);
        const fDur = Number(info.format?.duration);
        if (Number.isFinite(sDur) && sDur > 0 && Number.isFinite(fDur) && fDur > 0) {
          rawDur = Math.min(sDur, fDur);
        } else if (Number.isFinite(sDur) && sDur > 0) {
          rawDur = sDur;
        } else if (Number.isFinite(fDur) && fDur > 0) {
          rawDur = fDur;
        }
      } catch {
        /* fallback bên dưới */
      }
      if (!(rawDur > 0)) {
        rawDur = (await mediaDurationFile(srcFile).catch(() => null)) ?? 0;
      }
      // Chỉ cắt khi video đủ dài hơn trimSec + 0.3s (tránh video < 0.6s bị cắt rỗng)
      if (!(rawDur > trimSec + 0.3)) return clean;

      const targetDur = Math.max(0.3, +(rawDur - trimSec).toFixed(3));
      // Giới hạn bitrate động để video đầu ra luôn < ~23MB (dưới xa trần 30MB = 31.457.280 bytes của AI DeepCut — T-437)
      const maxKbps = Math.min(8000, Math.max(750, Math.floor((22 * 8 * 1024) / Math.max(1, targetDur)) - 192));
      tmpOut = join(MIRROR_TMP_DIR, `trim-${randomUUID()}.mp4`);
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          srcFile,
          '-t',
          targetDur.toFixed(3),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c:v',
          'libx264',
          '-preset',
          'superfast',
          '-crf',
          '22',
          '-maxrate',
          `${maxKbps}k`,
          '-bufsize',
          `${maxKbps * 2}k`,
          '-pix_fmt',
          'yuv420p',
          '-vf',
          "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
          '-c:a',
          'aac',
          '-b:a',
          '160k',
          '-movflags',
          '+faststart',
          '-threads',
          '2',
          tmpOut,
        ],
        { timeout: 120_000 },
      );

      const safeUser = (userId || 'system').replace(/[^a-zA-Z0-9_-]/g, '') || 'system';
      const destPath = `ai/inputs/${safeUser}/${month()}/${randomUUID()}.mp4`;
      await this.storage.putFile(destPath, tmpOut, 'video/mp4');
      const finalUrl = this.storage.url(destPath);

      if (this.trimmedVideoCache.size >= 500) {
        const oldest = this.trimmedVideoCache.keys().next().value;
        if (oldest) this.trimmedVideoCache.delete(oldest);
      }
      this.trimmedVideoCache.set(cacheKey, { url: finalUrl, destPath, at: Date.now() });
      this.logger.log(`Đã cắt ${trimSec}s cuối video Motion (${rawDur.toFixed(2)}s → ${targetDur.toFixed(2)}s): ${destPath}`);
      return finalUrl;
    } catch (err) {
      this.logger.warn(`Không cắt được ${trimSec}s cuối video ${clean}, giữ bản gốc: ${(err as Error).message}`);
      return clean;
    } finally {
      if (tmpOut) await unlink(tmpOut).catch(() => undefined);
      if (cleanupSrc && srcFile) await unlink(srcFile).catch(() => undefined);
      const next = this.trimWaiters.shift();
      if (next) next();
      else this.activeTrims--;
    }
  }

  /**
   * Đảm bảo video gửi sang nguồn có giới hạn tải URL ngoại vi (vd AI DeepCut giới hạn cứng 30MB = 31.457.280 bytes — T-437)
   * luôn nhỏ hơn `maxBytes` (mặc định 25MB). Nếu file đã ≤ `maxBytes` thì trả lại ngay tức thì (<1ms).
   */
  async ensureVideoMaxBytes(rawUrl: string, maxBytes = 25 * 1024 * 1024, userId = 'system'): Promise<string> {
    const clean = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!clean) return clean;

    const cacheKey = `maxb::${clean}::${maxBytes}`;
    const hit = this.trimmedVideoCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) {
      const localOk = !this.storage.localPath || existsSync(this.storage.localPath(hit.destPath));
      if (localOk) return hit.url;
      this.trimmedVideoCache.delete(cacheKey);
    }

    const p = this.pathOf(clean);
    let localAbs: string | null = null;
    if (p && (p.startsWith('ai/inputs/') || p.startsWith('ai/outputs/')) && !p.includes('..') && this.storage.localPath) {
      const abs = this.storage.localPath(p);
      if (existsSync(abs)) {
        const st = await stat(abs).catch(() => null);
        if (st && st.size <= maxBytes && /\.mp4$/i.test(abs)) {
          return clean;
        }
        localAbs = abs;
      }
    }

    const inflight = this.trimmingInFlight.get(cacheKey);
    if (inflight) return inflight;

    const job = (async () => {
      if (this.activeTrims < 2) {
        this.activeTrims++;
      } else {
        await new Promise<void>((r) => this.trimWaiters.push(r));
      }
      let srcFile = localAbs;
      let cleanupSrc = false;
      let tmpOut: string | null = null;
      try {
        if (!srcFile) {
          if (!/^https?:\/\//i.test(clean)) return clean;
          const head = await fetch(clean, { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).catch(() => null);
          const cl = Number(head?.headers.get('content-length') || 0);
          if (cl > 0 && cl <= maxBytes && /\.mp4(\?|$)/i.test(clean)) return clean;
          const dl = await this.downloadToTempFile(clean, AI_MEDIA_UPLOAD_HARD_MB * 1024 * 1024, 120_000);
          srcFile = dl.tmpPath;
          cleanupSrc = true;
          const st = await stat(srcFile).catch(() => null);
          if (st && st.size <= maxBytes && /\.mp4(\?|$)/i.test(clean)) return clean;
        }

        const dur = Math.max(1, (await mediaDurationFile(srcFile).catch(() => null)) ?? 15);
        const targetMb = Math.max(5, Math.floor(maxBytes / (1024 * 1024)) - 3);
        const maxKbps = Math.min(8000, Math.max(600, Math.floor((targetMb * 8 * 1024) / dur) - 160));
        tmpOut = join(MIRROR_TMP_DIR, `shrink-${randomUUID()}.mp4`);
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            srcFile,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-c:v',
            'libx264',
            '-preset',
            'superfast',
            '-crf',
            '24',
            '-maxrate',
            `${maxKbps}k`,
            '-bufsize',
            `${maxKbps * 2}k`,
            '-pix_fmt',
            'yuv420p',
            '-vf',
            "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            '-threads',
            '2',
            tmpOut,
          ],
          { timeout: 150_000 },
        );

        const safeUser = (userId || 'system').replace(/[^a-zA-Z0-9_-]/g, '') || 'system';
        const destPath = `ai/inputs/${safeUser}/${month()}/${randomUUID()}.mp4`;
        await this.storage.putFile(destPath, tmpOut, 'video/mp4');
        const finalUrl = this.storage.url(destPath);
        if (this.trimmedVideoCache.size >= 500) {
          const oldest = this.trimmedVideoCache.keys().next().value;
          if (oldest) this.trimmedVideoCache.delete(oldest);
        }
        this.trimmedVideoCache.set(cacheKey, { url: finalUrl, destPath, at: Date.now() });
        this.logger.log(`Đã tự động nén video vượt trần ${(maxBytes / 1048576).toFixed(0)}MB xuống chuẩn HD MP4 gọn nhẹ: ${destPath}`);
        return finalUrl;
      } catch (err) {
        this.logger.warn(`Không nén được video lớn ${clean}, giữ bản gốc: ${(err as Error).message}`);
        return clean;
      } finally {
        if (tmpOut) await unlink(tmpOut).catch(() => undefined);
        if (cleanupSrc && srcFile) await unlink(srcFile).catch(() => undefined);
        const next = this.trimWaiters.shift();
        if (next) next();
        else this.activeTrims--;
      }
    })().finally(() => {
      this.trimmingInFlight.delete(cacheKey);
    });

    this.trimmingInFlight.set(cacheKey, job);
    return job;
  }
}
