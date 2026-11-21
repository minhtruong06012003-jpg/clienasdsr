import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../../prisma/prisma.service.js';
import { STORAGE, type StorageDriver } from '../media/storage.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AiCallContext } from './ai.types.js';


export type TavtavvideoJobKind =
  | 'motion'
  | 'motion_15s'
  | 'motion_30s'
  | 'motion_eco'
  | 'image_to_video'
  | 'text_to_video'
  | 'text_to_image'
  | 'image_to_image'
  | 'virtual_tryon';
export type TavtavvideoFlowModel =
  | 'veo_fast'
  | 'veo_quality'
  | 'veo_lite'
  | 'omni_flash'
  | 'nano_banana'
  | 'nano_banana_pro'
  | 'nano_banana_lite';
export type TavtavvideoAudioMode = 'sound' | 'none';
export type TavtavvideoJobStatus = 'waiting_prev' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

/**
 * Giới hạn độ dài an toàn mỗi cảnh gửi xuống FlowStudio-Client (Client hiện cắt -t 9.8s để dưới ngưỡng 10s của Google Flow).
 * Với video 30.0s chia 3 cảnh 10.0s, mỗi cảnh được nén nhẹ 10.0s -> 9.80s (2%) khi đưa vào Flow để không mất bất kỳ frame nào,
 * sau đó giãn chuẩn xác về 10.00s × 3 = 30.00s khi ghép nhạc gốc.
 */
const MAX_FLOW_REFERENCE_CLIP_SEC = 9.8;
const MAX_MOTION_30S_TOTAL_SEC = 30.0;

export interface TavtavvideoDeviceInfo {
  deviceId: number;
  machineId: string;
  name: string;
  os: string;
  gpu: string;
  ramGb: number;
  version: string;
  capabilities?: string[];
  maxParallel: number;
  readyProfiles: number;
  totalProfiles: number;
  lastSeenAt: number;
}

export interface TavtavvideoBridgeJob {
  jobId: number;
  jobKind?: TavtavvideoJobKind;
  flowModel?: TavtavvideoFlowModel;
  audioMode?: TavtavvideoAudioMode;
  status: TavtavvideoJobStatus;
  percent: number;
  message: string;
  errorMessage?: string | null;
  templateId: string;
  backgroundMode: string;
  aspect: string;
  resolution: '720p' | '1080p' | '4k';
  userPrompt: string;
  resolvedPrompt: string;
  imageStoragePath?: string;
  imageLocalPath?: string;
  imageMime: string;
  extraImageStoragePaths?: string[];
  extraImageLocalPaths?: string[];
  extraImageMimes?: string[];
  videoStoragePath?: string;
  videoLocalPath?: string;
  videoMime: string;
  outputUrl?: string | null;
  outputStoragePath?: string | null;
  outputUrls?: string[];
  outputMimes?: string[];
  batchCount?: number;
  imageUpscaleRes?: '1k' | '2k' | '4k';
  outfitPart?: string;
  maxDurationSec?: number;
  previewLocalPaths?: Record<number, string>;
  autoApproveCount?: number;
  flowCreditsUsed?: number | null;
  claimedByDeviceId?: number | null;
  cancelCommandSent?: boolean;
  totalChunks?: number;
  aiTaskId?: string | null;
  aiUserId?: string | null;

  // --- Trường điều phối chuỗi 3 cảnh trên cùng 1 hồ sơ (Motion 30s) ---
  isMasterContainer?: boolean;
  isInternalSubScene?: boolean;
  parentJobId?: number | null;
  sceneIndex?: number;
  sceneTotal?: number;
  subSceneJobIds?: number[];
  sceneTargetDurations?: number[];
  origAudioLocalPath?: string | null;
  masterSourceVideoTempPath?: string | null;
  assembledOutputLocalPath?: string | null;
  sharedProjectId?: string | null;
  priority?: number;
  pinnedDeviceId?: number | null;
  pinnedProfileExtId?: string | null;
  pinnedFlowProjectUrl?: string | null;
  subRetryCount?: number;

  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
}

export interface PendingWorkerCommand {
  cmd_id: string;
  type: string;
  job_id?: number;
  profile_ext_id?: string;
  deviceId: number;
  createdAt: number;
}

let singletonBridge: TavtavvideoBridgeService | null = null;

export function getTavtavvideoBridge(): TavtavvideoBridgeService {
  if (!singletonBridge) {
    throw new Error('TavtavvideoBridgeService chưa khởi tạo');
  }
  return singletonBridge;
}

const monthFolder = () => new Date().toISOString().slice(0, 7).replace('-', '');

export function normalizeMotionResolution(raw: unknown): '720p' | '1080p' | '4k' {
  const r = String(raw ?? '').trim().toLowerCase();
  if (r === '4k' || r === '2160p' || r === 'uhd') return '4k';
  if (r === '1080p' || r === 'fhd' || r === 'fullhd') return '1080p';
  return '720p';
}

export function normalizeImageUpscaleRes(raw: unknown, fallback: '1k' | '2k' | '4k' = '1k'): '1k' | '2k' | '4k' {
  const r = String(raw ?? '').trim().toLowerCase();
  if (r === '4k' || r === '3840' || r === 'ultra') return '4k';
  if (r === '2k' || r === '2560' || r === 'hd') return '2k';
  if (r === '1k' || r === '1024' || r === 'standard') return '1k';
  return fallback;
}

function parseFlowCreditsUsed(raw: unknown, fallback: number | null = null): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function compareWorkerSemver(aRaw: string | undefined, bRaw: string): number {
  const pa = String(aRaw ?? '0.0.0')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => Number(x) || 0);
  const pb = String(bRaw)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export function normalizeMotionAspect(raw: unknown): '9:16' | '16:9' | '1:1' {
  const a = String(raw ?? '').trim();
  if (a === '16:9') return '16:9';
  if (a === '1:1') return '1:1';
  return '9:16';
}

export function normalizeGenVideoAspect(raw: unknown, fallback: '9:16' | '16:9' = '16:9'): '9:16' | '16:9' {
  const a = String(raw ?? '').trim();
  if (a === '9:16') return '9:16';
  if (a === '16:9') return '16:9';
  return fallback;
}

export function normalizeVideoModel(raw: unknown, fallback: TavtavvideoFlowModel = 'veo_fast'): TavtavvideoFlowModel {
  const m = String(raw ?? '').trim().toLowerCase();
  switch (m) {
    case 'veo_quality':
    case 'veo_3_1_quality':
    case 'quality':
      return 'veo_quality';
    case 'veo_lite':
    case 'veo_3_1_lite':
    case 'lite':
      return 'veo_lite';
    case 'omni_flash':
    case 'omni_1_2_flash':
    case 'omni_1_1_flash':
    case 'omni':
      return 'omni_flash';
    case 'veo_fast':
    case 'veo_3_1_fast':
    case 'fast':
      return 'veo_fast';
    default:
      return fallback;
  }
}

export function normalizeAudioMode(raw: unknown): TavtavvideoAudioMode {
  const a = String(raw ?? '').trim().toLowerCase();
  if (a === 'none' || a === 'mute' || a === 'silent' || a === 'false' || a === '0') {
    return 'none';
  }
  return 'sound';
}

export function normalizeMotionBgMode(raw: unknown): 'keep_photo_bg' | 'keep_video_bg' {
  return String(raw ?? '').trim().toLowerCase() === 'keep_video_bg' ? 'keep_video_bg' : 'keep_photo_bg';
}

export function normalizeMotionTemplate(_raw: unknown): string {
  return 'motion_dance_sync';
}

export function buildMotionControlPrompt(_rawTemplateId: unknown, rawBgMode: unknown, userNote: unknown): string {
  const bgMode = normalizeMotionBgMode(rawBgMode);
  const keepPhotoBg = bgMode === 'keep_photo_bg';

  let basePrompt = keepPhotoBg
    ? 'Ganti karakter di video referensi dengan karakter dari gambar referensi yang diberikan.\n\n- Penampilan karakter, gaya rambut, dan kostum pakaian harus mengikuti gambar referensi asli secara identik 100%, namun lepaskan pose diam pada gambar referensi agar kedua tangan karakter bebas bergerak mengikuti tarian.\n- Salin HANYA koreografi tarian dari video referensi secara presisi frame-by-frame dari detik pertama hingga detik terakhir: setiap gerakan kedua lengan, siku, telapak tangan, dan jari (seperti melambai, menyilang di dada, menopang dagu, menunjuk ke kamera, menutup mulut dengan kedua tangan, membuka kedua telapak tangan ke depan, hingga memiringkan kepala sambil mengangkat tangan di dekat pipi) wajib mengikuti gerakan di video referensi secara identik.\n- Wajah di video referensi mungkin diburamkan untuk privasi; JANGAN PERNAH memburamkan wajah karakter output! Render wajah karakter sangat tajam, tekstur kulit fotografi alami tanpa penghalusan berlebih, mata jernih, jari tangan presisi, dan detail pakaian sangat tajam sesuai gambar referensi.\n- Lokasi/latar/background WAJIB terkunci statis dan konsisten 100% menggunakan latar belakang asli pada gambar referensi secara terus-menerus sepanjang seluruh durasi video dari detik awal hingga detik akhir, tanpa pernah berubah, berkedip, atau berpindah ke latar ruangan video referensi di tengah maupun akhir video.\n- Pertahankan 100% seluruh struktur arsitektur, perabotan, objek, dan dekorasi asli yang ada di latar belakang gambar referensi tetap diam pada posisi aslinya beserta pencahayaan dan warnanya.\n- DILARANG KERAS mengubah struktur latar belakang gambar referensi, jangan menggantinya dengan pepohonan/latar lain, serta jangan menambahkan roda atau elemen baru yang tidak ada di gambar referensi.'
    : 'Ganti karakter di video referensi dengan karakter dari gambar referensi yang diberikan.\n\n- Penampilan karakter, gaya rambut, dan kostum pakaian harus mengikuti gambar referensi asli secara identik 100%, namun lepaskan pose diam pada gambar referensi agar kedua tangan karakter bebas bergerak mengikuti tarian.\n- Salin 100% koreografi tarian dari video referensi secara presisi frame-by-frame dari detik pertama hingga detik terakhir: setiap gerakan kedua lengan, siku, telapak tangan, dan jari (seperti melambai, menyilang di dada, menopang dagu, menyentuh dagu dengan jari, menunjuk ke kamera, menutup mulut dengan kedua tangan, membuka kedua telapak tangan ke depan, mengayunkan lengan ke bawah, hingga memiringkan kepala sambil mengangkat tangan di dekat pipi) wajib mengikuti gerakan di video referensi secara identik.\n- Wajah di video referensi mungkin diburamkan untuk privasi; JANGAN PERNAH memburamkan wajah karakter output! Render wajah karakter sangat tajam, tekstur kulit fotografi alami tanpa penghalusan berlebih, mata jernih, jari tangan presisi, dan detail pakaian sangat tajam sesuai gambar referensi.\n- Lokasi/latar/background TIDAK BOLEH diubah, WAJIB terkunci konsisten 100% mengikuti latar belakang asli pada video referensi dari awal hingga akhir video.\n- Pencahayaan, warna, dan atmosfer tetap mengikuti video referensi asli.\n- Jangan menambahkan elemen baru yang tidak ada di video maupun gambar referensi.';

  const cleanNote = String(userNote ?? '').trim();
  if (cleanNote) {
    basePrompt += `\nLưu ý bổ sung: ${cleanNote}`;
  }
  return basePrompt;
}

export function buildChainedMotionPrompt(_rawTemplateId: unknown, rawBgMode: unknown, userNote: unknown): string {
  const bgMode = normalizeMotionBgMode(rawBgMode);
  const keepPhotoBg = bgMode === 'keep_photo_bg';

  let basePrompt = keepPhotoBg
    ? 'LANJUTKAN adegan secara mulus dari gambar referensi (frame terakhir adegan sebelumnya yang sudah difilter bersih):\n\n- WAJIB pertahankan 100% gaya rambut/sanggul, kerah & potongan pakaian, aksesoris, proporsi tubuh, posisi kamera, dan latar ruangan persis seperti gambar referensi tanpa perubahan sedikit pun!\n- Salin HANYA koreografi tarian dari video referensi secara presisi frame-by-frame dari detik pertama hingga detik terakhir: setiap gerakan kedua lengan, siku, telapak tangan, jari, dan kemiringan kepala wajib mengikuti gerakan di video referensi secara identik.\n- Wajah di video referensi sengaja diburamkan untuk privasi; JANGAN PERNAH memburamkan wajah karakter output! Render wajah karakter sangat tajam, tekstur kulit fotografi alami tanpa penghalusan berlebih, mata jernih, jari tangan presisi, dan detail pakaian sangat tajam sesuai gambar referensi.\n- Lokasi/latar/background WAJIB terkunci statis 100% persis seperti latar pada gambar referensi dari detik pertama hingga detik terakhir tanpa pernah berubah atau berkedip.'
    : 'LANJUTKAN adegan secara mulus dari gambar referensi (frame terakhir adegan sebelumnya yang sudah difilter bersih):\n\n- WAJIB pertahankan 100% gaya rambut/sanggul, kerah & potongan pakaian, aksesoris, proporsi tubuh, posisi kamera, dan latar ruangan persis seperti gambar referensi tanpa perubahan sedikit pun!\n- Salin 100% koreografi tarian dari video referensi secara presisi frame-by-frame dari detik pertama hingga detik terakhir: setiap gerakan kedua lengan, siku, telapak tangan, jari, dan kemiringan kepala wajib mengikuti gerakan di video referensi secara identik.\n- Wajah di video referensi sengaja diburamkan untuk privasi; JANGAN PERNAH memburamkan wajah karakter output! Render wajah karakter sangat tajam, tekstur kulit fotografi alami tanpa penghalusan berlebih, mata jernih, jari tangan presisi, dan detail pakaian sangat tajam sesuai gambar referensi.\n- Lokasi/latar/background WAJIB terkunci konsisten 100% mengikuti ruangan pada gambar referensi dan video referensi dari detik pertama hingga detik terakhir.';

  const cleanNote = String(userNote ?? '').trim();
  if (cleanNote) {
    basePrompt += `\nLưu ý bổ sung: ${cleanNote}`;
  }
  return basePrompt;
}

const RESERVED_FLOW_OPTION_WORDS = new Set([
  'phê duyệt',
  'luôn phê duyệt',
  'từ chối',
  'approve',
  'always approve',
  'reject',
  'decline',
]);

function sanitizeDirectVideoPrompt(raw: unknown): string {
  let clean = String(raw ?? '')
    .replace(/\[\[FLOW_UPSCALE:[^\]]*\]\]/gi, '')
    .replace(/edit_video/gi, 'chỉnh cảnh video')
    .trim();
  if (RESERVED_FLOW_OPTION_WORDS.has(clean.toLowerCase())) {
    clean = `Cảnh quay chuyển động điện ảnh: ${clean}`;
  }
  return clean.slice(0, 4000);
}

export const DEFAULT_IMAGE_TO_VIDEO_PROMPT =
  'Chuyển động tự nhiên, mượt mà, giữ nguyên khuôn mặt, trang phục và chi tiết bối cảnh trong ảnh tham chiếu, ánh sáng điện ảnh sắc nét.';

export function buildImageToVideoPrompt(rawPrompt: unknown): string {
  const clean = sanitizeDirectVideoPrompt(rawPrompt);
  return clean || DEFAULT_IMAGE_TO_VIDEO_PROMPT;
}

export function buildTextToVideoPrompt(rawPrompt: unknown): string {
  const clean = sanitizeDirectVideoPrompt(rawPrompt);
  return clean || 'Chuyển động điện ảnh mượt mà, ánh sáng tự nhiên, chi tiết sắc nét.';
}

export function normalizeGenImageAspect(
  raw: unknown,
  fallback: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' = '1:1',
): '1:1' | '16:9' | '9:16' | '4:3' | '3:4' {
  const a = String(raw ?? '').trim();
  if (a === '1:1' || a === '16:9' || a === '9:16' || a === '4:3' || a === '3:4') {
    return a;
  }
  return fallback;
}

export function normalizeImageModel(
  raw: unknown,
  fallback: 'nano_banana' | 'nano_banana_pro' | 'nano_banana_lite' = 'nano_banana',
): 'nano_banana' | 'nano_banana_pro' | 'nano_banana_lite' {
  const m = String(raw ?? '').trim().toLowerCase();
  switch (m) {
    case 'nano_banana_pro':
    case 'pro':
    case 'imagen_4':
      return 'nano_banana_pro';
    case 'nano_banana_lite':
    case 'lite':
      return 'nano_banana_lite';
    case 'nano_banana':
    case 'nano_banana_2_1':
    case 'standard':
    case 'fast':
      return 'nano_banana';
    default:
      return fallback;
  }
}

export function buildImagePrompt(rawPrompt: unknown, hasRefImages = false): string {
  const clean = sanitizeDirectVideoPrompt(rawPrompt);
  if (!clean) {
    return hasRefImages
      ? 'Tạo hình ảnh chất lượng cao, sắc nét dựa trên ảnh tham chiếu đính kèm.'
      : 'Tạo hình ảnh chất lượng cao, sắc nét, ánh sáng điện ảnh.';
  }
  if (/^(tạo\s*(ngay\s*)?\d*\s*(hình|ảnh|bức ảnh)|vẽ\s|generate\s|create\s)/iu.test(clean)) {
    return clean;
  }
  return hasRefImages
    ? `Tạo hình ảnh dựa trên ảnh tham chiếu đính kèm: ${clean}`
    : `Tạo hình ảnh: ${clean}`;
}

export function buildImageRestore4kPrompt(rawRestoreMode: unknown, rawUserNote: unknown): string {
  const mode = String(rawRestoreMode ?? 'faithful').trim().toLowerCase();
  const cleanNote = sanitizeDirectVideoPrompt(rawUserNote);

  let coreInstruction: string;
  if (mode === 'portrait_restore') {
    coreInstruction =
      'High-fidelity 4K portrait photo restoration and super-resolution enhancement: Keep the EXACT facial identity, eyes, nose, lips, expression, skin tone, hairstyle, outfit, pose, camera angle, and background from the attached reference photo 100% unchanged. Eliminate blur, motion softness, compression blocks, and low-light grain while reconstructing crisp natural 4K skin micro-texture, eyelashes, hair strands, fabric details, and balanced photographic clarity.';
  } else if (mode === 'product_sharp') {
    coreInstruction =
      'High-fidelity 4K commercial product & fashion super-resolution enhancement: Keep the EXACT product shape, logos, printed typography, stitching, colors, proportions, and composition from the attached reference photo 100% unchanged. Remove all blur, pixelation, and JPEG compression artifacts while reconstructing razor-sharp 4K edges, surface material micro-textures, clean label text, and crisp studio clarity.';
  } else {
    coreInstruction =
      'Faithful 1:1 4K Ultra HD image restoration and super-resolution upscale: Preserve 100% of the exact subjects, facial identity, composition, colors, lighting, text, and background from the attached reference image without altering or adding new elements. Remove blur, noise, and compression artifacts and reconstruct razor-sharp 4K micro-details, crisp edges, and natural photographic clarity.';
  }

  return cleanNote ? `${coreInstruction} Additional note: ${cleanNote}` : coreInstruction;
}

const INTERNAL_TERMS_RE =
  /google|flow|gemini|maxlogin|hồ sơ|máy trạm|trình duyệt|proxy|cdp|profile|tavvideo|tavtavvideo|tác nhân|playwright|chrome|locator\(|call log:|timeout \d+ms exceeded|waiting for element|_ngcontent|jslog=|bardvemetadatakey|target page, context or browser|execution context was destroyed|protocol error|net::err_/i;

export function sanitizeProgressMessage(raw: unknown, percent: number, resolution: string): string {
  const msg = String(raw ?? '').trim();
  const clamped = Math.min(99, Math.max(1, Math.round(percent || 1)));
  if (!msg) return percent >= 100 ? 'Hoàn tất tạo video!' : `Đang xử lý video (${clamped}%)...`;
  if (/nâng cấp chất lượng|upscale/i.test(msg)) {
    return `Đang nâng cấp chất lượng ${(resolution || '1080p').toUpperCase()}...`;
  }
  if (INTERNAL_TERMS_RE.test(msg)) {
    if (clamped < 20) return 'Đang chuẩn bị dữ liệu đầu vào...';
    if (clamped < 88) return `Đang dựng chuyển động video (${clamped}%)...`;
    return 'Đang hoàn thiện chất lượng & âm thanh video...';
  }
  return msg;
}

export function sanitizeErrorMessage(raw: unknown, jobKind?: TavtavvideoJobKind): string {
  const isImg =
    jobKind === 'text_to_image' ||
    jobKind === 'image_to_image' ||
    jobKind === 'virtual_tryon';
  const msg = String(raw ?? '').trim();
  if (!msg) {
    return isImg
      ? 'Không thể tạo hình ảnh từ dữ liệu này, tiền đã được hoàn lại.'
      : 'Không thể tạo video từ dữ liệu này, tiền đã được hoàn lại.';
  }
  if (/FLOW_UPLOAD_REJECTED_VIDEO|Video chuyển động mẫu đầu vào bị bộ lọc an toàn|Không tải được video lên|Không tải lên được video|speech for people in uploaded videos/i.test(msg)) {
    return 'Video chuyển động mẫu đầu vào bị bộ lọc an toàn từ chối tải lên, tiền đã được hoàn lại - vui lòng đổi video khác';
  }
  if (/FLOW_UPLOAD_REJECTED_IMAGE|FLOW_UPLOAD_REJECTED|Ảnh nhân vật đầu vào bị bộ lọc an toàn|bộ lọc an toàn từ chối tải lên|Không tải được hình ảnh lên|Không tải lên được hình ảnh/i.test(msg)) {
    return 'Ảnh nhân vật đầu vào bị bộ lọc an toàn từ chối tải lên, tiền đã được hoàn lại - vui lòng đổi ảnh khác';
  }
  if (/chính sách|policy|vi phạm|nhạy cảm|safety|blocked/i.test(msg)) {
    return 'Nội dung mô tả hoặc tệp đầu vào bị bộ lọc an toàn từ chối, tiền đã được hoàn lại.';
  }
  if (/credit|hết lượt|quota/i.test(msg)) {
    return 'Hệ thống xử lý đang quá tải tạm thời, tiền đã được hoàn lại.';
  }
  if (INTERNAL_TERMS_RE.test(msg)) {
    return isImg
      ? 'Hệ thống xử lý gặp sự cố tạm thời khi tạo ảnh, tiền đã được hoàn lại - vui lòng tạo lại đơn'
      : 'Hệ thống xử lý gặp sự cố tạm thời khi dựng video, tiền đã được hoàn lại. - vui lòng tạo lại đơn';
  }
  return msg.endsWith('hoàn lại') || msg.endsWith('hoàn lại.') ? msg : `${msg}. Tiền đã được hoàn lại`;
}

function isHardPolicyFailure(raw: unknown): boolean {
  return /FLOW_UPLOAD_REJECTED|từ chối tải lên|Không tải được video lên|Không tải lên được video|Không tải được hình ảnh lên|Không tải lên được hình ảnh|chính sách|policy|vi phạm|nhạy cảm|safety|blocked/i.test(String(raw ?? ''));
}

@Injectable()
export class TavtavvideoBridgeService implements OnModuleInit {
  private readonly logger = new Logger('TavtavvideoBridge');
  private readonly privateRoot: string;
  private readonly jobsDir: string;
  private readonly chunksRoot: string;
  private readonly tmpDir: string;
  private readonly inputsDir: string;
  private readonly stateFile: string;
  private readonly devicesFile: string;
  private readonly tokenSecret: string;

  private nextJobId = 1001;
  private nextDeviceId = 1;
  private readonly jobs = new Map<number, TavtavvideoBridgeJob>();
  private readonly devices = new Map<number, TavtavvideoDeviceInfo>();
  private readonly deviceByMachine = new Map<string, number>();
  private readonly pendingCommands = new Map<string, PendingWorkerCommand>();
  private readonly stitchingMasterIds = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    config: ConfigService,
  ) {
    const dir = config.get<string>('upload.dir') ?? process.env.UPLOAD_DIR ?? 'uploads';
    const uploadRoot = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    this.privateRoot = join(uploadRoot, 'private', 'tavtavvideo');
    this.jobsDir = join(this.privateRoot, 'jobs');
    this.chunksRoot = join(this.privateRoot, 'chunks');
    this.tmpDir = join(this.privateRoot, 'tmp');
    this.inputsDir = join(this.privateRoot, 'inputs');
    this.stateFile = join(this.privateRoot, 'state.json');
    this.devicesFile = join(this.privateRoot, 'devices.json');
    this.tokenSecret = process.env.JWT_ACCESS_SECRET ?? 'tavtavvideo-bridge-secret';

    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.chunksRoot, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    mkdirSync(this.inputsDir, { recursive: true });
    singletonBridge = this;
  }

  async onModuleInit() {
    singletonBridge = this;
    await this.loadFromDisk();
  }

  private async loadFromDisk() {
    try {
      if (existsSync(this.stateFile)) {
        const st = JSON.parse(await readFile(this.stateFile, 'utf8')) as { nextJobId?: number; nextDeviceId?: number };
        if (Number(st.nextJobId) > this.nextJobId) this.nextJobId = Number(st.nextJobId);
        if (Number(st.nextDeviceId) > this.nextDeviceId) this.nextDeviceId = Number(st.nextDeviceId);
      }
    } catch {
      // ignore corrupted state file
    }

    try {
      if (existsSync(this.devicesFile)) {
        const list = JSON.parse(await readFile(this.devicesFile, 'utf8')) as TavtavvideoDeviceInfo[];
        if (Array.isArray(list)) {
          for (const d of list) {
            if (d?.deviceId > 0 && d.machineId) {
              this.devices.set(d.deviceId, d);
              this.deviceByMachine.set(d.machineId, d.deviceId);
              if (d.deviceId >= this.nextDeviceId) this.nextDeviceId = d.deviceId + 1;
            }
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      const files = await readdir(this.jobsDir);
      const cutoffSec = Math.floor(Date.now() / 1000) - 7 * 86_400;
      for (const f of files) {
        if (!f.startsWith('job_') || !f.endsWith('.json')) continue;
        const full = join(this.jobsDir, f);
        try {
          const job = JSON.parse(await readFile(full, 'utf8')) as TavtavvideoBridgeJob;
          if (!job?.jobId) continue;
          if (job.jobId >= this.nextJobId && job.jobId < 90_000_000) {
            this.nextJobId = job.jobId + 1;
          }
          if ((job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') && job.updatedAt < cutoffSec) {
            await unlink(full).catch(() => undefined);
            continue;
          }
          this.jobs.set(job.jobId, job);
        } catch {
          // ignore single file parse error
        }
      }
    } catch {
      // ignore
    }
  }

  private async saveState() {
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ nextJobId: this.nextJobId, nextDeviceId: this.nextDeviceId }), 'utf8');
    await rename(tmp, this.stateFile).catch(() => copyFile(tmp, this.stateFile));
  }

  private async saveDevices() {
    const tmp = `${this.devicesFile}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.devices.values()], null, 2), 'utf8');
    await rename(tmp, this.devicesFile).catch(() => copyFile(tmp, this.devicesFile));
  }

  private async saveJob(job: TavtavvideoBridgeJob) {
    job.updatedAt = Math.floor(Date.now() / 1000);
    this.jobs.set(job.jobId, job);
    const dest = join(this.jobsDir, `job_${job.jobId}.json`);
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
    await rename(tmp, dest).catch(() => copyFile(tmp, dest));
  }

  private allocateJobId(): number {
    if (this.nextJobId >= 90_000_000) this.nextJobId = 1001;
    while (this.jobs.has(this.nextJobId)) this.nextJobId++;
    const id = this.nextJobId++;
    void this.saveState().catch(() => undefined);
    return id;
  }

  private async configuredApiKey(): Promise<string> {
    const cfg = await this.settings.get<{ apiKey?: string }>('ai_tavtavvideo');
    return String(cfg?.apiKey ?? '').trim();
  }

  private keyFingerprint(apiKey: string): string {
    return createHash('sha256').update(`tavtavvideo-key:${apiKey}`).digest('hex').slice(0, 12);
  }

  private signDeviceToken(deviceId: number, machineId: string, apiKey: string): string {
    const payload = Buffer.from(JSON.stringify({ did: deviceId, mid: machineId, kh: this.keyFingerprint(apiKey) }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.tokenSecret).update(`fmd:${payload}`).digest('base64url');
    return `fmd.${payload}.${sig}`;
  }

  async requireDeviceAuth(headers: Record<string, string | string[] | undefined>): Promise<TavtavvideoDeviceInfo> {
    const apiKey = await this.configuredApiKey();
    if (!apiKey) throw new UnauthorizedException('Nguồn tavtavvideo chưa cấu hình khoá API');

    const authHeader = String(headers.authorization ?? '').trim();
    const rawBearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const motionKeyHeader = String(headers['x-motion-key'] ?? '').trim();

    if (rawBearer.startsWith('fmd.')) {
      const parts = rawBearer.split('.');
      if (parts.length !== 3) throw new UnauthorizedException('Device token không hợp lệ');
      const [, payloadB64, sig] = parts;
      const expectedSig = createHmac('sha256', this.tokenSecret).update(`fmd:${payloadB64}`).digest('base64url');
      if (Buffer.byteLength(sig) !== Buffer.byteLength(expectedSig) || !timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
        throw new UnauthorizedException('Chữ ký device token không hợp lệ');
      }
      let parsed: { did?: number; mid?: string; kh?: string };
      try {
        parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { did?: number; mid?: string; kh?: string };
      } catch {
        throw new UnauthorizedException('Payload device token lỗi');
      }
      if (!parsed.did || parsed.kh !== this.keyFingerprint(apiKey)) {
        throw new UnauthorizedException('Khoá API đã thay đổi, cần đăng ký lại');
      }
      let dev = this.devices.get(parsed.did);
      if (!dev) {
        dev = {
          deviceId: parsed.did,
          machineId: String(parsed.mid ?? `machine-${parsed.did}`),
          name: `Worker #${parsed.did}`,
          os: '',
          gpu: '',
          ramGb: 16,
          version: '2.0.1',
          maxParallel: 2,
          readyProfiles: 1,
          totalProfiles: 1,
          lastSeenAt: Math.floor(Date.now() / 1000),
        };
        this.devices.set(dev.deviceId, dev);
      }
      return dev;
    }

    const candidate = motionKeyHeader || rawBearer;
    if (candidate && Buffer.byteLength(candidate) === Buffer.byteLength(apiKey) && timingSafeEqual(Buffer.from(candidate), Buffer.from(apiKey))) {
      const fallbackDev = [...this.devices.values()][0] ?? {
        deviceId: 1,
        machineId: 'direct-key',
        name: 'Direct Key Client',
        os: '',
        gpu: '',
        ramGb: 16,
        version: '2.0.1',
        maxParallel: 2,
        readyProfiles: 1,
        totalProfiles: 1,
        lastSeenAt: Math.floor(Date.now() / 1000),
      };
      return fallbackDev;
    }

    throw new UnauthorizedException('Thiếu hoặc sai thông tin xác thực thiết bị');
  }

  async enrollDevice(body: Record<string, unknown>, headers: Record<string, string | string[] | undefined>) {
    const expectedKey = await this.configuredApiKey();
    if (!expectedKey) throw new UnauthorizedException('Nguồn tavtavvideo chưa cấu hình khoá API trên trang quản trị');

    const headerKey = String(headers['x-motion-key'] ?? '').trim();
    const authHeader = String(headers.authorization ?? '').trim();
    const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const bodyKey = String(body.motion_api_key ?? body.api_key ?? body.secret ?? '').trim();
    const candidate = headerKey || bodyKey || bearerKey;

    if (!candidate || Buffer.byteLength(candidate) !== Buffer.byteLength(expectedKey) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedKey))) {
      throw new UnauthorizedException('Khoá kết nối (Motion API Key) không khớp với cấu hình nguồn tavtavvideo');
    }

    const machineId = String(body.machine_id ?? '').trim().slice(0, 120) || `worker-${randomUUID().slice(0, 8)}`;
    let deviceId = this.deviceByMachine.get(machineId);
    if (!deviceId) {
      deviceId = this.nextDeviceId++;
      this.deviceByMachine.set(machineId, deviceId);
      await this.saveState().catch(() => undefined);
    }

    const existing = this.devices.get(deviceId);
    const info: TavtavvideoDeviceInfo = {
      deviceId,
      machineId,
      name: String(body.name ?? existing?.name ?? `Worker #${deviceId}`).slice(0, 120),
      os: String(body.os ?? existing?.os ?? '').slice(0, 120),
      gpu: String(body.gpu ?? existing?.gpu ?? '').slice(0, 120),
      ramGb: Math.max(1, Number(body.ram_gb ?? existing?.ramGb) || 16),
      version: typeof body.version === 'string' && body.version.trim() ? body.version.trim().slice(0, 40) : (existing?.version ?? '2.0.1'),
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.map((c) => String(c)).slice(0, 20)
        : existing?.capabilities,
      maxParallel: existing?.maxParallel ?? 2,
      readyProfiles: existing?.readyProfiles ?? 1,
      totalProfiles: existing?.totalProfiles ?? 1,
      lastSeenAt: Math.floor(Date.now() / 1000),
    };
    this.devices.set(deviceId, info);
    await this.saveDevices().catch(() => undefined);

    const token = this.signDeviceToken(deviceId, machineId, expectedKey);
    this.logger.log(`Thiết bị worker tavtavvideo đã kết nối: #${deviceId} (${info.name}, machine=${machineId.slice(0, 12)}...)`);
    return { ok: true, device_token: token, device_id: deviceId };
  }

  async handleHello(dev: TavtavvideoDeviceInfo, body: Record<string, unknown>) {
    const nowSec = Math.floor(Date.now() / 1000);
    dev.lastSeenAt = nowSec;
    if (typeof body.version === 'string' && body.version.trim()) dev.version = body.version.trim().slice(0, 40);
    if (Array.isArray(body.capabilities)) dev.capabilities = body.capabilities.map((c) => String(c)).slice(0, 20);
    if (typeof body.os === 'string' && body.os.trim()) dev.os = body.os.trim().slice(0, 120);
    if (typeof body.gpu === 'string' && body.gpu.trim()) dev.gpu = body.gpu.trim().slice(0, 120);
    if (Number(body.ram_gb) > 0) dev.ramGb = Number(body.ram_gb);
    if (Number(body.max_parallel) > 0) dev.maxParallel = Number(body.max_parallel);

    if (Array.isArray(body.profiles)) {
      dev.totalProfiles = body.profiles.length;
      const ready = body.profiles.filter((p) => {
        if (!p || typeof p !== 'object') return false;
        const status = String((p as Record<string, unknown>).status ?? '').toLowerCase();
        return status !== 'disabled' && status !== 'flowcreditreserve';
      }).length;
      dev.readyProfiles = Math.max(ready, dev.maxParallel > 0 ? 1 : 0);
    }

    // Kiểm tra các job đang chạy trên thiết bị này xem có đơn nào đã bị huỷ ở trang quản trị không
    for (const job of this.jobs.values()) {
      if (job.claimedByDeviceId === dev.deviceId && job.status === 'running' && !job.cancelCommandSent) {
        const cancelled = await this.isAiTaskCancelled(job);
        if (cancelled) {
          job.status = 'canceled';
          job.cancelCommandSent = true;
          job.finishedAt = nowSec;
          await this.saveJob(job);
          if (job.isInternalSubScene && job.parentJobId) {
            await this.cancelMasterAndSiblings(job.parentJobId, job.jobId, 'Đơn đã được huỷ.');
          }
          const cmdId = `cancel_${job.jobId}_${nowSec}`;
          this.pendingCommands.set(cmdId, {
            cmd_id: cmdId,
            type: 'cancel_job',
            job_id: job.jobId,
            deviceId: dev.deviceId,
            createdAt: nowSec,
          });
        }
      }
    }

    const commands = [...this.pendingCommands.values()]
      .filter((c) => c.deviceId === dev.deviceId)
      .map(({ cmd_id, type, job_id, profile_ext_id }) => ({
        cmd_id,
        type,
        ...(job_id ? { job_id } : {}),
        ...(profile_ext_id ? { profile_ext_id } : {}),
      }));

    return {
      ok: true,
      commands,
      voices_version: '1.0.0',
      styles_version: '1.0.0',
    };
  }

  ackCommand(body: Record<string, unknown>) {
    const cmdId = String(body.cmd_id ?? '').trim();
    if (cmdId) this.pendingCommands.delete(cmdId);
    return { ok: true };
  }

  syncProfiles(dev: TavtavvideoDeviceInfo, body: Record<string, unknown>) {
    dev.lastSeenAt = Math.floor(Date.now() / 1000);
    if (Array.isArray(body.profiles)) {
      dev.totalProfiles = body.profiles.length;
    }
    return { ok: true };
  }

  getHealthSummary() {
    const nowSec = Math.floor(Date.now() / 1000);
    const online = [...this.devices.values()].filter((d) => nowSec - d.lastSeenAt <= 120);
    const queuedJobs = [...this.jobs.values()].filter((j) => !j.isMasterContainer && (j.status === 'queued' || j.status === 'waiting_prev')).length;
    const runningJobs = [...this.jobs.values()].filter((j) => !j.isMasterContainer && j.status === 'running').length;
    const maxParallel = online.reduce((sum, d) => sum + Math.max(1, d.maxParallel || 1), 0);
    const readyProfiles = online.reduce((sum, d) => sum + Math.max(1, d.readyProfiles || 1), 0);
    return {
      ok: true,
      provider: 'tavtavvideo',
      online_devices: online.length,
      v21_devices: online.filter((d) => this.isWorkerV21OrNewer(d)).length,
      v22_devices: online.filter((d) => this.isWorkerV22OrNewer(d)).length,
      max_parallel: maxParallel,
      ready_profiles: readyProfiles,
      queued_jobs: queuedJobs,
      running_jobs: runningJobs,
    };
  }

  isWorkerV21OrNewer(dev: TavtavvideoDeviceInfo): boolean {
    if (dev.capabilities?.includes('v2_nhom_a')) return true;
    return compareWorkerSemver(dev.version, '2.1.0') >= 0;
  }

  isWorkerV22OrNewer(dev: TavtavvideoDeviceInfo): boolean {
    if (dev.capabilities?.includes('flow_image_4k')) return true;
    return compareWorkerSemver(dev.version, '2.2.0') >= 0;
  }

  hasCapableWorker(minVersion = '2.1.0'): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    return [...this.devices.values()].some((d) => {
      if (nowSec - d.lastSeenAt > 120) return false;
      if (compareWorkerSemver(d.version, minVersion) >= 0) return true;
      if (compareWorkerSemver('2.2.0', minVersion) >= 0 && d.capabilities?.includes('flow_image_4k')) return true;
      if (compareWorkerSemver('2.1.0', minVersion) >= 0 && d.capabilities?.includes('v2_nhom_a')) return true;
      return false;
    });
  }

  private extractStoragePath(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    const base = this.storage.url('');
    if (base && url.startsWith(base)) {
      const rel = url.slice(base.length).split('?')[0].replace(/^\/+/, '');
      if (rel && !rel.includes('..')) return rel;
    }
    try {
      const u = new URL(url);
      if (u.pathname.startsWith('/uploads/')) {
        const rel = decodeURIComponent(u.pathname.slice('/uploads/'.length)).replace(/^\/+/, '');
        if (rel && !rel.includes('..')) return rel;
      }
    } catch {
      // ignore invalid URL
    }
    return null;
  }

  private guessMimeFromPath(p: string, fallback: string): string {
    const ext = extname(p).toLowerCase();
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.webp':
        return 'image/webp';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.mov':
        return 'video/quicktime';
      case '.webm':
        return 'video/webm';
      case '.mp4':
        return 'video/mp4';
      default:
        return fallback;
    }
  }

  /**
   * Chu?n b? ?nh ??u v?o nguy?n g?c ?? chuy?n xu?ng m?y ch?y Client (to?n b? gi?i m?/chuy?n ??i WebP/PNG & FFmpeg ch?y 100% ? Client).
   */
  private async prepareInputImage(
    jobId: number,
    imageUrl: string,
    slotIndex: number,
    ctx: AiCallContext,
  ): Promise<{ storagePath?: string; localPath?: string; mimeType: string }> {
    const suffix = slotIndex <= 1 ? 'img' : `img${slotIndex}`;
    const storagePath = this.extractStoragePath(imageUrl) ?? undefined;
    if (storagePath) {
      const guessedMime = this.guessMimeFromPath(storagePath, 'image/jpeg');
      return {
        storagePath,
        mimeType: guessedMime,
      };
    }

    const uploaded = await ctx.readUpload(imageUrl);
    if (!uploaded) {
      throw new Error(slotIndex === 1 ? 'Kh?ng ??c ???c ?nh ??u v?o' : `Kh?ng ??c ???c ?nh tham chi?u #${slotIndex}`);
    }
    const mimeType = uploaded.mimeType || 'image/jpeg';
    const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
    const normMime = mimeType.includes('png') ? 'image/png' : mimeType.includes('webp') ? 'image/webp' : 'image/jpeg';
    const localPath = join(this.inputsDir, `job_${jobId}_${suffix}${ext}`);
    await writeFile(localPath, uploaded.data);
    return { localPath, mimeType: normMime };
  }

  async enqueueMotionJob(
    params: {
      imageUrl: string;
      videoUrl: string;
      templateId: unknown;
      backgroundMode: unknown;
      aspect: unknown;
      resolution: '720p' | '1080p' | '4k';
      prompt: unknown;
      maxSingleSec?: 10 | 15;
      audioMode?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const is15s = params.maxSingleSec === 15;
    const templateId = normalizeMotionTemplate(params.templateId);
    const backgroundMode = normalizeMotionBgMode(params.backgroundMode);
    const aspect = normalizeMotionAspect(params.aspect);
    const resolution = normalizeMotionResolution(params.resolution);
    const audioMode = params.audioMode !== undefined ? normalizeAudioMode(params.audioMode) : 'sound';
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 2000);
    const resolvedPrompt = buildMotionControlPrompt(templateId, backgroundMode, userPrompt);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);

    let videoStoragePath = this.extractStoragePath(params.videoUrl) ?? undefined;
    let videoLocalPath: string | undefined;
    let videoMime = videoStoragePath ? this.guessMimeFromPath(videoStoragePath, 'video/mp4') : 'video/mp4';
    if (!videoStoragePath) {
      const uploaded = await ctx.readUpload(params.videoUrl);
      if (!uploaded) throw new Error('Không đọc được video chuyển động mẫu đầu vào');
      videoMime = uploaded.mimeType || 'video/mp4';
      const ext = videoMime.includes('quicktime') ? '.mov' : '.mp4';
      videoLocalPath = join(this.inputsDir, `job_${jobId}_vid${ext}`);
      await writeFile(videoLocalPath, uploaded.data);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: is15s ? 'motion_15s' : 'motion',
      flowModel: 'omni_flash',
      audioMode,
      status: 'queued',
      percent: 2,
      message: is15s ? 'Đang xếp hàng xử lý Motion 15s...' : 'Đang xếp hàng xử lý...',
      templateId,
      backgroundMode,
      aspect,
      resolution,
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      videoStoragePath,
      videoLocalPath,
      videoMime,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  /**
   * Khởi tạo đơn Motion Control 30s (CrispChainV6.1 GPU Worker):
   * - Kiểm tra thời lượng video mẫu <= 30.4s rồi đẩy nguyên vẹn 1 đơn `motion_30s` duy nhất xuống máy trạm RTX GPU.
   * - Máy trạm tự động chạy trọn vẹn quy trình CrispChainV6.1: lọc Clean Plate trên toàn bộ video 0..30s (hoặc chế độ Dynamic Camera),
   *   chọn điểm cắt có mặt rõ bằng SCRFD (`f_conf >= 0.45`), truyền 2K Relay Anchor chống trôi sang Cảnh 2/3 với tên file băm SHA256,
   *   và ghép nối sub-pixel + âm thanh gốc trong 1 lượt encode duy nhất.
   */
  async enqueueMotion30sJob(
    params: {
      imageUrl: string;
      videoUrl: string;
      templateId: unknown;
      backgroundMode: unknown;
      aspect: unknown;
      resolution: '720p' | '1080p' | '4k';
      prompt: unknown;
      audioMode?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const templateId = normalizeMotionTemplate(params.templateId);
    const backgroundMode = normalizeMotionBgMode(params.backgroundMode);
    const aspect = normalizeMotionAspect(params.aspect);
    const resolution = normalizeMotionResolution(params.resolution);
    const audioMode = normalizeAudioMode(params.audioMode);
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 2000);
    const resolvedPrompt = buildMotionControlPrompt(templateId, backgroundMode, userPrompt);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);
    const videoStoragePath = this.extractStoragePath(params.videoUrl) ?? undefined;
    let videoLocalPath: string | undefined;
    let videoMime = videoStoragePath ? this.guessMimeFromPath(videoStoragePath, 'video/mp4') : 'video/mp4';
    if (!videoStoragePath) {
      const uploaded = await ctx.readUpload(params.videoUrl);
      if (!uploaded) {
        if (primaryImg.localPath) {
          await unlink(primaryImg.localPath).catch(() => undefined);
        }
        throw new Error('Kh?ng ??c ???c video chuy?n ??ng m?u ??u v?o');
      }
      videoMime = uploaded.mimeType || 'video/mp4';
      const ext = videoMime.includes('quicktime') ? '.mov' : '.mp4';
      videoLocalPath = join(this.inputsDir, `job_${jobId}_vid${ext}`);
      await writeFile(videoLocalPath, uploaded.data);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const sharedProjectId = `novai-mc30-${jobId}`;
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'motion_30s',
      flowModel: 'omni_flash',
      audioMode,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng xử lý video Motion 30s...',
      templateId,
      backgroundMode,
      aspect,
      resolution,
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      videoStoragePath,
      videoLocalPath,
      videoMime,
      sharedProjectId,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    this.logger.log(
      `Khởi tạo đơn Motion 30s CrispChainV6.1 #${jobId} (${resolution.toUpperCase()}, bg=${backgroundMode}) trên dự án ${sharedProjectId}`,
    );
    return job;
  }

  async enqueueImageToVideoJob(
    params: {
      imageUrl: string;
      extraImageUrls?: string[];
      prompt: unknown;
      aspect: unknown;
      resolution: '720p' | '1080p' | '4k';
      model?: unknown;
      audioMode?: unknown;
      durationSec?: number;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const aspect = normalizeGenVideoAspect(params.aspect, '9:16');
    const resolution = normalizeMotionResolution(params.resolution);
    const is15s =
      (params.durationSec ?? 8) > 10 ||
      String(params.model ?? '').trim().toLowerCase() === 'omni_flash';
    const flowModel: TavtavvideoFlowModel = is15s ? 'omni_flash' : 'veo_fast';
    const audioMode = normalizeAudioMode(params.audioMode);
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 4000);
    const resolvedPrompt = buildImageToVideoPrompt(userPrompt);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);

    const extraImageStoragePaths: string[] = [];
    const extraImageLocalPaths: string[] = [];
    const extraImageMimes: string[] = [];

    const extraUrls = (params.extraImageUrls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean).slice(0, 2);
    for (let i = 0; i < extraUrls.length; i++) {
      const extraImg = await this.prepareInputImage(jobId, extraUrls[i], i + 2, ctx);
      extraImageStoragePaths.push(extraImg.storagePath ?? '');
      extraImageLocalPaths.push(extraImg.localPath ?? '');
      extraImageMimes.push(extraImg.mimeType);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'image_to_video',
      flowModel,
      audioMode,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng xử lý...',
      templateId: is15s ? 'image_to_video_15s' : 'image_to_video',
      backgroundMode: 'keep_photo_bg',
      aspect,
      resolution,
      ...(is15s ? { maxDurationSec: 15 } : {}),
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      ...(extraUrls.length > 0
        ? {
            extraImageStoragePaths,
            extraImageLocalPaths,
            extraImageMimes,
          }
        : {}),
      videoMime: 'video/mp4',
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueTextToVideoJob(
    params: {
      prompt: unknown;
      aspect: unknown;
      resolution: '720p' | '1080p' | '4k';
      model?: unknown;
      audioMode?: unknown;
      durationSec?: number;
    },
    _ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const resolvedPrompt = buildTextToVideoPrompt(params.prompt);
    if (!resolvedPrompt) {
      throw new Error('Vui lòng nhập nội dung mô tả cảnh quay video');
    }

    const jobId = this.allocateJobId();
    const aspect = normalizeGenVideoAspect(params.aspect, '16:9');
    const resolution = normalizeMotionResolution(params.resolution);
    const is15s =
      (params.durationSec ?? 8) > 10 ||
      String(params.model ?? '').trim().toLowerCase() === 'omni_flash';
    const flowModel: TavtavvideoFlowModel = is15s ? 'omni_flash' : 'veo_fast';
    const audioMode = normalizeAudioMode(params.audioMode);
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 4000);
    const nowSec = Math.floor(Date.now() / 1000);

    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'text_to_video',
      flowModel,
      audioMode,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng xử lý...',
      templateId: is15s ? 'text_to_video_15s' : 'text_to_video',
      backgroundMode: 'keep_photo_bg',
      aspect,
      resolution,
      ...(is15s ? { maxDurationSec: 15 } : {}),
      userPrompt,
      resolvedPrompt,
      imageMime: 'image/jpeg',
      videoMime: 'video/mp4',
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueTextToImageJob(
    params: {
      prompt: unknown;
      aspect?: unknown;
      model?: unknown;
      batchCount?: unknown;
      imageResolution?: unknown;
    },
    _ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 4000);
    if (!userPrompt) {
      throw new Error('Vui lòng nhập nội dung mô tả hình ảnh cần tạo');
    }

    const jobId = this.allocateJobId();
    const aspect = normalizeGenImageAspect(params.aspect, '1:1');
    const flowModel = normalizeImageModel(params.model, 'nano_banana');
    const batchCount = Math.max(1, Math.min(4, Math.floor(Number(params.batchCount) || 1)));
    const imageUpscaleRes = normalizeImageUpscaleRes(params.imageResolution, '1k');
    const resolvedPrompt = buildImagePrompt(userPrompt, false);
    const nowSec = Math.floor(Date.now() / 1000);

    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'text_to_image',
      flowModel,
      batchCount,
      imageUpscaleRes,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng tạo ảnh...',
      templateId: 'text_to_image',
      backgroundMode: 'keep_photo_bg',
      aspect,
      resolution: imageUpscaleRes === '4k' ? '4k' : '1080p',
      userPrompt,
      resolvedPrompt,
      imageMime: 'image/jpeg',
      videoMime: 'video/mp4',
      sharedProjectId: `novai-img-${jobId}`,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueImageToImageJob(
    params: {
      imageUrl: string;
      extraImageUrls?: string[];
      prompt: unknown;
      aspect?: unknown;
      model?: unknown;
      batchCount?: unknown;
      imageResolution?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const aspect = normalizeGenImageAspect(params.aspect, '1:1');
    const flowModel = normalizeImageModel(params.model, 'nano_banana');
    const batchCount = Math.max(1, Math.min(4, Math.floor(Number(params.batchCount) || 1)));
    const imageUpscaleRes = normalizeImageUpscaleRes(params.imageResolution, '1k');
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 4000);
    const resolvedPrompt = buildImagePrompt(userPrompt, true);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);

    const extraImageStoragePaths: string[] = [];
    const extraImageLocalPaths: string[] = [];
    const extraImageMimes: string[] = [];

    // Hỗ trợ tối đa 4 ảnh tham chiếu (1 ảnh chính + 3 ảnh phụ)
    const extraUrls = (params.extraImageUrls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean).slice(0, 3);
    for (let i = 0; i < extraUrls.length; i++) {
      const extraImg = await this.prepareInputImage(jobId, extraUrls[i], i + 2, ctx);
      extraImageStoragePaths.push(extraImg.storagePath ?? '');
      extraImageLocalPaths.push(extraImg.localPath ?? '');
      extraImageMimes.push(extraImg.mimeType);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'image_to_image',
      flowModel,
      batchCount,
      imageUpscaleRes,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng xử lý ảnh...',
      templateId: 'image_to_image',
      backgroundMode: 'keep_photo_bg',
      aspect,
      resolution: imageUpscaleRes === '4k' ? '4k' : '1080p',
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      ...(extraUrls.length > 0
        ? {
            extraImageStoragePaths,
            extraImageLocalPaths,
            extraImageMimes,
          }
        : {}),
      videoMime: 'video/mp4',
      sharedProjectId: `novai-img-${jobId}`,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueImageRestore4kJob(
    params: {
      imageUrl: string;
      restoreMode?: unknown;
      aspect?: unknown;
      prompt?: unknown;
      batchCount?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const aspect = normalizeGenImageAspect(params.aspect, '9:16');
    const batchCount = Math.max(1, Math.min(4, Math.floor(Number(params.batchCount) || 1)));
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 2000);
    const resolvedPrompt = buildImageRestore4kPrompt(params.restoreMode, userPrompt);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);
    const nowSec = Math.floor(Date.now() / 1000);

    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'image_to_image',
      flowModel: 'nano_banana_pro',
      batchCount,
      imageUpscaleRes: '4k',
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng phục hồi & nâng nét ảnh 4K...',
      templateId: 'image_restore_4k',
      backgroundMode: String(params.restoreMode ?? 'faithful').trim().toLowerCase() || 'faithful',
      aspect,
      resolution: '4k',
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      videoMime: 'video/mp4',
      sharedProjectId: `novai-restore4k-${jobId}`,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueVirtualTryOnJob(
    params: {
      imageUrl: string;
      garmentUrl: string;
      outfitPart?: unknown;
      backgroundMode?: unknown;
      aspect?: unknown;
      imageResolution?: unknown;
      prompt?: unknown;
      batchCount?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const aspect = normalizeGenImageAspect(params.aspect, '9:16');
    const outfitPartRaw = String(params.outfitPart ?? 'full').trim().toLowerCase();
    const outfitPart = ['full', 'top', 'bottom', 'dress', 'accessory'].includes(outfitPartRaw) ? outfitPartRaw : 'full';
    const bgRaw = String(params.backgroundMode ?? 'keep_original').trim().toLowerCase();
    const backgroundMode = bgRaw === 'studio' ? 'studio' : 'keep_original';
    const imageUpscaleRes = normalizeImageUpscaleRes(params.imageResolution, '2k');
    const batchCount = Math.max(1, Math.min(4, Math.floor(Number(params.batchCount) || 1)));
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 2000);

    const partEn =
      outfitPart === 'top'
        ? 'only the upper-body top/shirt/jacket (keep original lower-body pants/skirt unchanged)'
        : outfitPart === 'bottom'
          ? 'only the lower-body pants/skirt/trousers (keep original upper-body top unchanged)'
          : outfitPart === 'dress'
            ? 'the full dress/gown'
            : outfitPart === 'accessory'
              ? 'the fashion accessory/bag/hat/glasses naturally'
              : 'the complete outfit/clothing';
    const bgEn =
      backgroundMode === 'studio'
        ? 'Place the person in a clean, softly lit luxury fashion studio background.'
        : 'Keep the EXACT original background, room lighting, camera framing, body proportions, hands, hairstyle, and facial identity from IMAGE 1 completely unchanged.';
    const resolvedPrompt =
      `Virtual Try-On photorealistic fashion edit: Keep the EXACT person, face identity, hairstyle, skin tone, and body pose from IMAGE 1, and dress them in ${partEn} from IMAGE 2 with faithful fabric texture, color, stitching, and natural drape. ${bgEn}` +
      (userPrompt ? ` Additional details: ${userPrompt}` : '');

    const modelImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);
    const garmentImg = await this.prepareInputImage(jobId, params.garmentUrl, 2, ctx);

    const nowSec = Math.floor(Date.now() / 1000);
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'virtual_tryon',
      flowModel: 'nano_banana_pro',
      batchCount,
      imageUpscaleRes,
      outfitPart,
      status: 'queued',
      percent: 2,
      message: 'Đang xếp hàng thay đồ ảnh AI...',
      templateId: 'virtual_tryon',
      backgroundMode,
      aspect,
      resolution: imageUpscaleRes === '4k' ? '4k' : '1080p',
      userPrompt: userPrompt || resolvedPrompt,
      resolvedPrompt,
      imageStoragePath: modelImg.storagePath,
      imageLocalPath: modelImg.localPath,
      imageMime: modelImg.mimeType,
      extraImageStoragePaths: [garmentImg.storagePath ?? ''],
      extraImageLocalPaths: [garmentImg.localPath ?? ''],
      extraImageMimes: [garmentImg.mimeType],
      videoMime: 'video/mp4',
      sharedProjectId: `novai-tryon-${jobId}`,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  async enqueueMotionEcoJob(
    params: {
      imageUrl: string;
      videoUrl: string;
      maxDurationSec?: unknown;
      backgroundMode?: unknown;
      aspect?: unknown;
      resolution: '720p' | '1080p' | '4k';
      audioMode?: unknown;
      prompt?: unknown;
    },
    ctx: AiCallContext,
  ): Promise<TavtavvideoBridgeJob> {
    const jobId = this.allocateJobId();
    const backgroundMode = normalizeMotionBgMode(params.backgroundMode);
    const aspect = normalizeMotionAspect(params.aspect);
    const resolution = normalizeMotionResolution(params.resolution);
    const audioMode = normalizeAudioMode(params.audioMode);
    const rawDur = Math.floor(Number(String(params.maxDurationSec ?? '10').replace(/[^0-9]/g, '')) || 10);
    const maxDurationSec = [5, 8, 10, 15].includes(rawDur) ? rawDur : Math.min(15, Math.max(5, rawDur));
    const userPrompt = String(params.prompt ?? '').trim().slice(0, 2000);
    const resolvedPrompt = buildMotionControlPrompt('motion_dance_sync', backgroundMode, userPrompt);

    const primaryImg = await this.prepareInputImage(jobId, params.imageUrl, 1, ctx);

    let videoStoragePath = this.extractStoragePath(params.videoUrl) ?? undefined;
    let videoLocalPath: string | undefined;
    let videoMime = videoStoragePath ? this.guessMimeFromPath(videoStoragePath, 'video/mp4') : 'video/mp4';
    if (!videoStoragePath) {
      const uploaded = await ctx.readUpload(params.videoUrl);
      if (!uploaded) throw new Error('Không đọc được video chuyển động mẫu đầu vào');
      videoMime = uploaded.mimeType || 'video/mp4';
      const ext = videoMime.includes('quicktime') ? '.mov' : '.mp4';
      videoLocalPath = join(this.inputsDir, `job_${jobId}_vid${ext}`);
      await writeFile(videoLocalPath, uploaded.data);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const job: TavtavvideoBridgeJob = {
      jobId,
      jobKind: 'motion_eco',
      flowModel: 'omni_flash',
      audioMode,
      maxDurationSec,
      sceneTotal: 1,
      status: 'queued',
      percent: 2,
      message: `Đang xếp hàng Motion Control (mốc tự cắt ${maxDurationSec}s)...`,
      templateId: 'motion_dance_sync',
      backgroundMode,
      aspect,
      resolution,
      userPrompt,
      resolvedPrompt,
      imageStoragePath: primaryImg.storagePath,
      imageLocalPath: primaryImg.localPath,
      imageMime: primaryImg.mimeType,
      videoStoragePath,
      videoLocalPath,
      videoMime,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    await this.saveJob(job);
    return job;
  }

  getJob(rawId: number | string): TavtavvideoBridgeJob | null {
    const n = Number(rawId);
    if (!Number.isInteger(n) || n <= 0) return null;
    const direct = this.jobs.get(n);
    if (direct) return direct;
    if (n >= 100_000_000 && n < 900_000_000) {
      return this.jobs.get(n % 100_000_000) ?? null;
    }
    return null;
  }

  async claimJobs(dev: TavtavvideoDeviceInfo, body: Record<string, unknown>) {
    const nowSec = Math.floor(Date.now() / 1000);
    dev.lastSeenAt = nowSec;

    const want = Math.max(0, Math.min(10, Math.floor(Number(body.slots) || 0)));
    if (want <= 0) return { ok: true, jobs: [] };

    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && !j.isMasterContainer)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt || a.jobId - b.jobId);

    const claimedDtos: Record<string, unknown>[] = [];
    for (const job of queued) {
      if (claimedDtos.length >= want) break;

      const kindCheck: TavtavvideoJobKind = job.jobKind ?? 'motion';
      if (kindCheck === 'motion_eco' && !this.isWorkerV21OrNewer(dev)) {
        // Chỉ giao tác vụ Motion tự cắt 5s–15s cho máy trạm FlowStudio-Client v2.1.0+ (Portable mới)
        continue;
      }
      if (
        (kindCheck === 'text_to_image' || kindCheck === 'image_to_image' || kindCheck === 'virtual_tryon') &&
        job.imageUpscaleRes === '4k' &&
        !this.isWorkerV22OrNewer(dev)
      ) {
        // Chỉ giao tác vụ Ảnh 4K Ultra HD (Google Flow Nano Banana Pro) cho máy trạm FlowStudio-Client v2.2.0+
        continue;
      }

      // Nếu là phân cảnh tiếp theo (Cảnh 2 / Cảnh 3) đã ghim vào máy trạm đang giữ hồ sơ của Cảnh 1:
      // chỉ giao cho đúng máy trạm đó (trừ khi máy trạm đó đã mất kết nối > 90 giây mới gỡ ghim cứu đơn).
      if (job.pinnedDeviceId && job.pinnedDeviceId !== dev.deviceId) {
        const pinnedDev = this.devices.get(job.pinnedDeviceId);
        if (pinnedDev && nowSec - pinnedDev.lastSeenAt <= 90) {
          continue;
        }
        job.pinnedDeviceId = null;
        job.pinnedProfileExtId = null;
        job.pinnedFlowProjectUrl = null;
      }

      if (await this.isAiTaskCancelled(job)) {
        job.status = 'canceled';
        job.finishedAt = nowSec;
        await this.saveJob(job);
        if (job.isInternalSubScene && job.parentJobId) {
          await this.cancelMasterAndSiblings(job.parentJobId, job.jobId, 'Đơn đã được huỷ.');
        }
        continue;
      }

      job.status = 'running';
      job.percent = Math.max(5, job.percent);
      job.message = 'Đang chuẩn bị dữ liệu đầu vào...';
      job.claimedByDeviceId = dev.deviceId;
      await this.saveJob(job);

      if (job.isInternalSubScene && job.parentJobId) {
        const master = this.jobs.get(job.parentJobId);
        if (master && (master.status === 'queued' || master.status === 'running')) {
          const sIdx = job.sceneIndex ?? 1;
          const sTot = job.sceneTotal ?? 3;
          const basePct = Math.round(8 + ((sIdx - 1) * 84) / sTot);
          master.status = 'running';
          master.percent = Math.max(master.percent, basePct);
          master.message = `Đang dựng chuyển động cảnh ${sIdx}/${sTot} (${master.percent}%)...`;
          await this.saveJob(master);
        }
      }

      const kind: TavtavvideoJobKind = job.jobKind ?? 'motion';

      if (kind === 'virtual_tryon') {
        const batchCount = Math.max(1, Math.min(4, job.batchCount ?? 1));
        claimedDtos.push({
          job_id: job.jobId,
          order_id: job.parentJobId ?? job.jobId,
          user_id: job.parentJobId ?? job.jobId,
          job_type: 'product_photo',
          title: `[Try-On nov.ai.vn] #${job.parentJobId ?? job.jobId}`,
          script: job.resolvedPrompt,
          created_at: job.createdAt,
          settings: {
            flow_studio: false,
            scene_style: 'flow_image',
            photo_style: 'virtual_tryon',
            tryon_mode: true,
            outfit_part: job.outfitPart ?? 'full',
            background_mode: job.backgroundMode,
            upscale_resolution: job.imageUpscaleRes ?? '2k',
            aspect: job.aspect,
            batch_count: batchCount,
            photo_count: batchCount,
            photo: {
              count: batchCount,
              scene_style: 'flow_image',
            },
            highlights: job.resolvedPrompt,
            user_prompt: job.userPrompt,
            owner_token: `novai_job=${job.parentJobId ?? job.jobId};created=${job.createdAt}`,
            source_images: { count: 2 },
            source_image: { has_image: true },
            dance_video: { has_video: false },
          },
        });
      } else if (kind === 'text_to_image' || kind === 'image_to_image') {
        const hasInputImg = kind === 'image_to_image';
        const extraCount = hasInputImg
          ? Math.max(job.extraImageStoragePaths?.length ?? 0, job.extraImageLocalPaths?.length ?? 0)
          : 0;
        const totalImages = hasInputImg ? 1 + extraCount : 0;
        const batchCount = Math.max(1, Math.min(4, job.batchCount ?? 1));
        const rawPrompt = (
          job.templateId === 'image_restore_4k'
            ? job.resolvedPrompt || job.userPrompt || ''
            : job.userPrompt || job.resolvedPrompt || ''
        ).trim();

        claimedDtos.push({
          job_id: job.jobId,
          order_id: job.parentJobId ?? job.jobId,
          user_id: job.parentJobId ?? job.jobId,
          job_type: 'product_photo',
          title: `[IMG nov.ai.vn] #${job.parentJobId ?? job.jobId}`,
          script: rawPrompt,
          created_at: job.createdAt,
          settings: {
            flow_studio: false,
            scene_style: 'flow_image',
            photo_style: 'flow_image',
            flow_model: job.flowModel ?? 'nano_banana',
            style_id: job.templateId,
            upscale_resolution: job.imageUpscaleRes ?? '1k',
            aspect: job.aspect,
            batch_count: batchCount,
            photo_count: batchCount,
            photo: {
              count: batchCount,
              scene_style: 'flow_image',
            },
            highlights: rawPrompt,
            user_prompt: job.userPrompt || rawPrompt,
            owner_token: `novai_job=${job.parentJobId ?? job.jobId};created=${job.createdAt}`,
            source_images: { count: totalImages },
            source_image: { has_image: hasInputImg },
            dance_video: { has_video: false },
          },
        });
      } else if (kind === 'text_to_video') {
        const is15sT2v =
          (job.maxDurationSec ?? 8) >= 15 ||
          job.flowModel === 'omni_flash' ||
          job.templateId === 'text_to_video_15s';
        const projId = job.sharedProjectId || `novai-t2v-${job.parentJobId ?? job.jobId}`;
        claimedDtos.push({
          job_id: job.jobId,
          order_id: job.parentJobId ?? job.jobId,
          user_id: job.parentJobId ?? job.jobId,
          job_type: 'image_to_video',
          title: `[${is15sT2v ? 'T2V 15s' : 'T2V'} nov.ai.vn] #${job.parentJobId ?? job.jobId} (${job.resolution.toUpperCase()})`,
          script: job.resolvedPrompt,
          created_at: job.createdAt,
          settings: {
            flow_studio: true,
            flow_mode: 'video',
            flow_model: is15sT2v ? 'omni_flash' : 'veo_fast',
            audio_mode: job.audioMode ?? 'sound',
            aspect: job.aspect,
            resolution: job.resolution,
            upscale_resolution: job.resolution,
            duration_sec: is15sT2v ? 15 : 8,
            ...(is15sT2v ? { max_duration_sec: 15 } : {}),
            batch_count: 1,
            confirm_mode: 'auto',
            project_id: projId,
            session_id: `novai-sess-${job.parentJobId ?? job.jobId}`,
            motion_prompt: job.resolvedPrompt,
            fallback_prompt: buildTextToVideoPrompt(job.userPrompt),
            user_prompt: job.userPrompt,
            owner_token: `novai_job=${job.parentJobId ?? job.jobId};created=${job.createdAt}`,
            ...(job.pinnedProfileExtId ? { assigned_profile_ext_id: job.pinnedProfileExtId } : {}),
            ...(job.pinnedFlowProjectUrl ? { flow_project_url: job.pinnedFlowProjectUrl } : {}),
            source_images: { count: 0 },
            source_image: { has_image: false },
            dance_video: { has_video: false },
          },
        });
      } else if (kind === 'image_to_video') {
        const is15sI2v =
          (job.maxDurationSec ?? 8) >= 15 ||
          job.flowModel === 'omni_flash' ||
          job.templateId === 'image_to_video_15s';
        const extraCount = Math.max(job.extraImageStoragePaths?.length ?? 0, job.extraImageLocalPaths?.length ?? 0);
        const totalImages = 1 + extraCount;
        claimedDtos.push({
          job_id: job.jobId,
          order_id: job.jobId,
          user_id: job.jobId,
          job_type: 'image_to_video',
          title: `[${is15sI2v ? 'I2V 15s' : 'I2V'} nov.ai.vn] #${job.jobId} (${job.resolution.toUpperCase()})`,
          script: job.resolvedPrompt,
          created_at: job.createdAt,
          settings: {
            flow_studio: true,
            flow_mode: 'video',
            flow_model: is15sI2v ? 'omni_flash' : 'veo_fast',
            audio_mode: job.audioMode ?? 'sound',
            aspect: job.aspect,
            resolution: job.resolution,
            upscale_resolution: job.resolution,
            duration_sec: is15sI2v ? 15 : 8,
            ...(is15sI2v ? { max_duration_sec: 15 } : {}),
            batch_count: 1,
            confirm_mode: 'auto',
            project_id: `novai-i2v-${job.jobId}`,
            session_id: `novai-sess-${job.jobId}`,
            motion_prompt: job.resolvedPrompt,
            user_prompt: job.userPrompt,
            owner_token: `novai_job=${job.jobId};created=${job.createdAt}`,
            source_images: { count: totalImages },
            source_image: { has_image: true },
            dance_video: { has_video: false },
          },
        });
      } else {
        const projId = job.sharedProjectId || `novai-mc-${job.jobId}`;
        const sessId = job.parentJobId ? `novai-sess-mc30-${job.parentJobId}` : `novai-sess-${job.jobId}`;
        const sceneBadge = job.isInternalSubScene ? ` [Cảnh ${job.sceneIndex ?? 1}/${job.sceneTotal ?? 3}]` : '';
        const motionPkgTag = kind === 'motion_15s' ? 'Motion 15s' : kind === 'motion_30s' ? 'Motion 30s' : 'Motion';
        const resolvedDurationSec =
          kind === 'motion_30s' && !job.isInternalSubScene
            ? 30
            : kind === 'motion_15s'
              ? 15
              : kind === 'motion_eco'
                ? (job.maxDurationSec ?? 10)
                : 10;
        claimedDtos.push({
          job_id: job.jobId,
          order_id: job.parentJobId ?? job.jobId,
          user_id: job.parentJobId ?? job.jobId,
          job_type: 'image_to_video',
          title: `[${motionPkgTag} nov.ai.vn] #${job.parentJobId ?? job.jobId}${sceneBadge} (${job.resolution.toUpperCase()})`,
          script: job.resolvedPrompt,
          created_at: job.createdAt,
          settings: {
            flow_studio: true,
            flow_mode: 'video',
            flow_model: 'omni_flash',
            audio_mode: job.audioMode ?? 'sound',
            aspect: job.aspect,
            resolution: job.resolution,
            upscale_resolution: job.resolution,
            background_mode: job.backgroundMode,
            duration_sec: resolvedDurationSec,
            ...(kind === 'motion_eco' && job.maxDurationSec ? { max_duration_sec: job.maxDurationSec } : {}),
            batch_count: 1,
            confirm_mode: 'auto',
            project_id: projId,
            session_id: sessId,
            scene_index: job.sceneIndex ?? 1,
            scene_total: kind === 'motion_eco' ? 1 : (job.sceneTotal ?? 1),
            motion_prompt: job.resolvedPrompt,
            user_prompt: job.userPrompt,
            owner_token: `novai_job=${job.parentJobId ?? job.jobId};created=${job.createdAt}`,
            ...(job.pinnedProfileExtId ? { assigned_profile_ext_id: job.pinnedProfileExtId } : {}),
            ...(job.pinnedFlowProjectUrl ? { flow_project_url: job.pinnedFlowProjectUrl } : {}),
            source_images: { count: 1 },
            source_image: { has_image: true },
            dance_video: { has_video: true },
          },
        });
      }
    }

    return { ok: true, jobs: claimedDtos };
  }

  async resolveJobMediaSource(
    job: TavtavvideoBridgeJob,
    kind: 'image' | 'video',
    imageIndex = 1,
  ): Promise<{ localFile?: string; buffer?: Buffer; mimeType: string; size?: number } | null> {
    let localOverride: string | undefined;
    let storagePath: string | undefined;
    let mimeType: string;

    if (kind === 'video') {
      localOverride = job.videoLocalPath;
      storagePath = job.videoStoragePath;
      mimeType = job.videoMime || 'video/mp4';
    } else if (imageIndex >= 2) {
      const extraIdx = imageIndex - 2;
      localOverride = job.extraImageLocalPaths?.[extraIdx] || undefined;
      storagePath = job.extraImageStoragePaths?.[extraIdx] || undefined;
      mimeType = job.extraImageMimes?.[extraIdx] || 'image/jpeg';
    } else {
      localOverride = job.imageLocalPath;
      storagePath = job.imageStoragePath;
      mimeType = job.imageMime || 'image/jpeg';
    }

    if (localOverride && existsSync(localOverride)) {
      const st = await stat(localOverride);
      return { localFile: localOverride, mimeType, size: st.size };
    }
    if (!storagePath) return null;

    if (this.storage.localPath) {
      const abs = this.storage.localPath(storagePath);
      if (existsSync(abs)) {
        const st = await stat(abs);
        return { localFile: abs, mimeType, size: st.size };
      }
    }

    const buffer = await this.storage.get(storagePath).catch(() => null);
    if (!buffer) return null;
    return { buffer, mimeType, size: buffer.length };
  }

  private async resolveLinkedAiTask(job: TavtavvideoBridgeJob) {
    const lookupJob = job.parentJobId ? (this.jobs.get(job.parentJobId) ?? job) : job;
    if (lookupJob.aiTaskId) {
      const byId = await this.prisma.aiTask.findUnique({
        where: { id: lookupJob.aiTaskId },
        select: { id: true, userId: true, status: true, progress: true },
      });
      if (byId) return byId;
    }
    const found = await this.prisma.aiTask.findFirst({
      where: { provider: 'tavtavvideo', providerTaskId: String(lookupJob.jobId) },
      select: { id: true, userId: true, status: true, progress: true },
    });
    if (found) {
      lookupJob.aiTaskId = found.id;
      lookupJob.aiUserId = found.userId;
    }
    return found;
  }

  private async isAiTaskCancelled(job: TavtavvideoBridgeJob): Promise<boolean> {
    if (job.parentJobId) {
      const master = this.jobs.get(job.parentJobId);
      if (master && (master.status === 'canceled' || master.status === 'failed')) {
        return true;
      }
    }
    const task = await this.resolveLinkedAiTask(job);
    if (!task) return false;
    return task.status === 'FAILED' || task.status === 'CANCELLED';
  }

  async reportProgress(job: TavtavvideoBridgeJob, body: Record<string, unknown>) {
    const cancelled = await this.isAiTaskCancelled(job);
    if (cancelled || job.status === 'canceled') {
      job.status = 'canceled';
      await this.saveJob(job);
      return { ok: true, cancel: true };
    }

    const rawPct = Number(body.percent ?? job.percent ?? 5);
    const pct = Math.min(99, Math.max(job.percent || 5, Math.round(Number.isFinite(rawPct) ? rawPct : 5)));
    const msg = sanitizeProgressMessage(body.log, pct, job.resolution);

    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'running';
      job.percent = pct;
      job.message = msg;
      await this.saveJob(job);
    }

    if (job.isInternalSubScene && job.parentJobId) {
      const master = this.jobs.get(job.parentJobId);
      if (master && master.status !== 'completed' && master.status !== 'failed' && master.status !== 'canceled') {
        const sIdx = Math.max(1, job.sceneIndex ?? 1);
        const sTot = Math.max(1, job.sceneTotal ?? 3);
        const sceneSpan = 84 / sTot;
        const mappedPct = Math.min(92, Math.max(master.percent || 6, Math.round(8 + (sIdx - 1) * sceneSpan + (Math.min(99, pct) / 100) * sceneSpan)));
        master.status = 'running';
        master.percent = mappedPct;
        master.message = `Đang dựng chuyển động cảnh ${sIdx}/${sTot} (${mappedPct}%)...`;
        await this.saveJob(master);

        const task = await this.resolveLinkedAiTask(master);
        if (task && task.status === 'PROCESSING' && mappedPct > task.progress) {
          await this.prisma.aiTask
            .updateMany({
              where: { id: task.id, status: 'PROCESSING' },
              data: { progress: mappedPct },
            })
            .catch(() => undefined);
        }
      }
      return { ok: true, cancel: false };
    }

    const task = await this.resolveLinkedAiTask(job);
    if (task && task.status === 'PROCESSING' && pct > task.progress) {
      await this.prisma.aiTask
        .updateMany({
          where: { id: task.id, status: 'PROCESSING' },
          data: { progress: pct },
        })
        .catch(() => undefined);
    }

    return { ok: true, cancel: false };
  }

  async saveVideoChunk(
    job: TavtavvideoBridgeJob,
    index: number,
    total: number,
    chunkFile: { path?: string; buffer?: Buffer; size: number },
  ) {
    if (job.status === 'completed') {
      if (chunkFile.path) await unlink(chunkFile.path).catch(() => undefined);
      return { ok: true, already_final: true };
    }

    const jobChunkDir = join(this.chunksRoot, String(job.jobId));
    await mkdir(jobChunkDir, { recursive: true });
    const partPath = join(jobChunkDir, `part_${String(index).padStart(5, '0')}`);

    if (chunkFile.path) {
      await rename(chunkFile.path, partPath).catch(async () => {
        await copyFile(chunkFile.path!, partPath);
        await unlink(chunkFile.path!).catch(() => undefined);
      });
    } else if (chunkFile.buffer) {
      await writeFile(partPath, chunkFile.buffer);
    }

    if (total > 0 && job.totalChunks !== total) {
      job.totalChunks = total;
      await this.saveJob(job);
    }
    return { ok: true, index, total };
  }

  async savePreviewImage(
    job: TavtavvideoBridgeJob,
    sceneIndex: number,
    previewFile: { path?: string; buffer?: Buffer; size: number } | undefined,
  ) {
    const isImageJob =
      job.jobKind === 'text_to_image' ||
      job.jobKind === 'image_to_image' ||
      job.jobKind === 'virtual_tryon';
    if (!previewFile || (!previewFile.path && !previewFile.buffer) || !isImageJob || job.status === 'completed') {
      if (previewFile?.path) await unlink(previewFile.path).catch(() => undefined);
      return { ok: true };
    }

    const idx = Math.max(1, Math.min(8, Math.floor(Number(sceneIndex) || 1)));
    const savedPath = join(this.tmpDir, `img_preview_${job.jobId}_${idx}_${Date.now()}.img`);
    if (previewFile.path) {
      await rename(previewFile.path, savedPath).catch(async () => {
        await copyFile(previewFile.path!, savedPath);
        await unlink(previewFile.path!).catch(() => undefined);
      });
    } else if (previewFile.buffer) {
      await writeFile(savedPath, previewFile.buffer);
    }

    const prevPath = job.previewLocalPaths?.[idx];
    if (prevPath && prevPath !== savedPath) {
      await unlink(prevPath).catch(() => undefined);
    }
    job.previewLocalPaths = { ...(job.previewLocalPaths ?? {}), [idx]: savedPath };
    await this.saveJob(job);

    const targetJob = job.parentJobId ? (this.jobs.get(job.parentJobId) ?? job) : job;
    if (targetJob !== job) {
      targetJob.previewLocalPaths = { ...(targetJob.previewLocalPaths ?? {}), [idx]: savedPath };
      await this.saveJob(targetJob);
    }

    return { ok: true, scene: idx };
  }

  private async detectImageFormat(filePath: string): Promise<{ ext: 'png' | 'webp' | 'jpg'; mime: string }> {
    try {
      const buf = await readFile(filePath);
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { ext: 'png', mime: 'image/png' };
      }
      if (
        buf.length >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      ) {
        return { ext: 'webp', mime: 'image/webp' };
      }
    } catch {
      // fallback jpeg
    }
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  private extractPostContentCaption(rawPostContent: unknown): string {
    if (!rawPostContent) return '';
    if (typeof rawPostContent === 'string') {
      const trimmed = rawPostContent.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          return String(parsed.Caption ?? parsed.caption ?? '').trim();
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    }
    if (typeof rawPostContent === 'object') {
      const rec = rawPostContent as Record<string, unknown>;
      return String(rec.Caption ?? rec.caption ?? '').trim();
    }
    return '';
  }

  async finishJob(
    job: TavtavvideoBridgeJob,
    body: Record<string, unknown>,
  ): Promise<{ httpStatus: number; payload: Record<string, unknown> }> {
    if (job.status === 'completed') {
      return { httpStatus: 200, payload: { ok: true, already_final: true } };
    }

    const status = String(body.status ?? '').trim().toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const jobChunkDir = join(this.chunksRoot, String(job.jobId));

    if (status !== 'success') {
      await rm(jobChunkDir, { recursive: true, force: true }).catch(() => undefined);

      // Nếu là phân cảnh con của Motion 30s gặp lỗi tạm thời (không phải lỗi vi phạm chính sách / bị huỷ):
      // thử lại thêm 1 lượt trên hồ sơ mới mà không làm mất kết quả các cảnh trước đó!
      if (
        job.isInternalSubScene &&
        job.parentJobId &&
        (job.subRetryCount ?? 0) < 1 &&
        !isHardPolicyFailure(body.error_message) &&
        !(await this.isAiTaskCancelled(job))
      ) {
        job.subRetryCount = (job.subRetryCount ?? 0) + 1;
        job.status = 'queued';
        job.percent = 3;
        job.pinnedProfileExtId = null;
        job.pinnedFlowProjectUrl = null;
        job.claimedByDeviceId = null;
        job.totalChunks = 0;
        if (job.jobKind === 'text_to_image' || job.jobKind === 'image_to_image') {
          job.resolvedPrompt = buildImagePrompt(job.userPrompt, job.jobKind === 'image_to_image');
        }
        await this.saveJob(job);
        this.logger.warn(
          `Phân cảnh ${job.sceneIndex}/${job.sceneTotal} của đơn Motion 30s #${job.parentJobId} lỗi tạm thời -> tự động xếp hàng thử lại trên hồ sơ mới`,
        );
        return { httpStatus: 200, payload: { ok: true } };
      }

      if (body.error_message) {
        this.logger.warn(
          `Đơn tavtavvideo #${job.jobId} (${job.jobKind ?? 'motion'}) thất bại từ worker: ${String(body.error_message).slice(0, 500)}`,
        );
      }
      const cleanErr = sanitizeErrorMessage(body.error_message, job.jobKind);
      job.status = 'failed';
      job.errorMessage = cleanErr;
      job.message = cleanErr;
      job.finishedAt = nowSec;
      await this.saveJob(job);
      await this.cleanupSubJobOnlyInputs(job);

      if (job.isInternalSubScene && job.parentJobId) {
        await this.failMasterAndSiblings(job.parentJobId, job.jobId, cleanErr);
      } else {
        await this.cleanupLocalInputs(job);
        await this.nudgeAiTaskPoll(job);
      }
      return { httpStatus: 200, payload: { ok: true } };
    }

    // =========================================================================
    // NHÁNH ĐƠN HÌNH ẢNH CHROME (TEXT-TO-IMAGE / IMAGE-TO-IMAGE / VIRTUAL-TRYON) QUA /PREVIEW + /FINISH
    // =========================================================================
    if (
      job.jobKind === 'text_to_image' ||
      job.jobKind === 'image_to_image' ||
      job.jobKind === 'virtual_tryon'
    ) {
      const targetJob = job.parentJobId ? (this.jobs.get(job.parentJobId) ?? job) : job;
      const mergedMap: Record<number, string> = {
        ...(targetJob.previewLocalPaths ?? {}),
        ...(job.previewLocalPaths ?? {}),
      };
      const previewFiles = Object.entries(mergedMap)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, p]) => p)
        .filter((p) => Boolean(p) && existsSync(p));

      if (previewFiles.length > 0) {
        const task = await this.resolveLinkedAiTask(targetJob);
        const userId = task?.userId ?? targetJob.aiUserId ?? 'system';
        const outputUrls: string[] = [];
        const outputMimes: string[] = [];
        let firstStoragePath: string | null = null;

        for (const filePath of previewFiles) {
          const fmt = await this.detectImageFormat(filePath);
          const outStoragePath = `ai/outputs/${userId}/${monthFolder()}/${randomUUID()}.${fmt.ext}`;
          await this.storage.putFile(outStoragePath, filePath, fmt.mime);
          if (!firstStoragePath) firstStoragePath = outStoragePath;
          outputUrls.push(this.storage.url(outStoragePath));
          outputMimes.push(fmt.mime);
          await unlink(filePath).catch(() => undefined);
        }

        const usedCredits = parseFlowCreditsUsed(body.flow_credits_used, 0);
        if (job !== targetJob) {
          job.previewLocalPaths = {};
          job.status = 'completed';
          job.percent = 100;
          job.finishedAt = nowSec;
          await this.saveJob(job);
        }

        targetJob.previewLocalPaths = {};
        targetJob.outputStoragePath = firstStoragePath;
        targetJob.outputUrl = outputUrls[0] ?? null;
        targetJob.outputUrls = outputUrls;
        targetJob.outputMimes = outputMimes;
        targetJob.flowCreditsUsed = usedCredits;
        targetJob.status = 'completed';
        targetJob.percent = 100;
        targetJob.message = 'Hoàn tất tạo hình ảnh!';
        targetJob.errorMessage = null;
        targetJob.finishedAt = nowSec;
        await this.saveJob(targetJob);

        await this.cleanupLocalInputs(targetJob);
        await this.nudgeAiTaskPoll(targetJob);
        this.logger.log(
          `Đơn Ảnh tavtavvideo #${targetJob.jobId} (${targetJob.jobKind}, ${outputUrls.length} ảnh) hoàn tất`,
        );
        return { httpStatus: 200, payload: { ok: true } };
      }

      const caption = this.extractPostContentCaption(body.post_content);
      const asksApproval = /\[\[OPTION\]\]|phê duyệt|approve/i.test(caption);
      if (asksApproval && (targetJob.autoApproveCount ?? 0) < 2 && !(await this.isAiTaskCancelled(targetJob))) {
        const usedProfileExtId = String(body.assigned_profile_ext_id ?? '').trim() || job.pinnedProfileExtId || null;
        const usedProjectUrl = String(body.flow_project_url ?? '').trim() || job.pinnedFlowProjectUrl || null;
        const approveCmd = /luôn phê duyệt/i.test(caption)
          ? 'Luôn phê duyệt'
          : /always approve/i.test(caption)
            ? 'Always approve'
            : /approve/i.test(caption) && !/phê duyệt/i.test(caption)
              ? 'Approve'
              : 'Phê duyệt';

        if (job !== targetJob) {
          job.status = 'completed';
          job.percent = 100;
          job.finishedAt = nowSec;
          await this.saveJob(job);
        }

        const subId = this.allocateJobId();
        const sharedProj = targetJob.sharedProjectId || `novai-img-${targetJob.jobId}`;
        targetJob.isMasterContainer = true;
        targetJob.sharedProjectId = sharedProj;
        targetJob.autoApproveCount = (targetJob.autoApproveCount ?? 0) + 1;
        targetJob.subSceneJobIds = [...(targetJob.subSceneJobIds ?? []), subId];
        targetJob.status = 'running';
        targetJob.percent = Math.max(targetJob.percent || 10, 45);
        targetJob.message = 'Đang kết xuất hình ảnh...';
        await this.saveJob(targetJob);

        const subJob: TavtavvideoBridgeJob = {
          jobId: subId,
          jobKind: targetJob.jobKind,
          flowModel: targetJob.flowModel ?? 'nano_banana',
          batchCount: targetJob.batchCount ?? 1,
          imageUpscaleRes: targetJob.imageUpscaleRes,
          status: 'queued',
          percent: 45,
          message: 'Đang kết xuất hình ảnh...',
          templateId: targetJob.templateId,
          backgroundMode: targetJob.backgroundMode,
          aspect: targetJob.aspect,
          resolution: targetJob.resolution,
          userPrompt: targetJob.userPrompt,
          resolvedPrompt: approveCmd,
          imageStoragePath: targetJob.imageStoragePath,
          imageLocalPath: targetJob.imageLocalPath,
          imageMime: targetJob.imageMime,
          extraImageStoragePaths: targetJob.extraImageStoragePaths,
          extraImageLocalPaths: targetJob.extraImageLocalPaths,
          extraImageMimes: targetJob.extraImageMimes,
          videoMime: 'video/mp4',
          isInternalSubScene: true,
          parentJobId: targetJob.jobId,
          sharedProjectId: sharedProj,
          priority: 100,
          pinnedDeviceId: job.claimedByDeviceId ?? null,
          pinnedProfileExtId: usedProfileExtId,
          pinnedFlowProjectUrl: usedProjectUrl,
          createdAt: nowSec,
          updatedAt: nowSec,
        };
        await this.saveJob(subJob);
        this.logger.log(
          `Đơn Ảnh #${targetJob.jobId}: Tự động xác nhận "${approveCmd}" (#${subId}) trên hồ sơ ${usedProfileExtId ?? 'auto'}`,
        );
        return { httpStatus: 200, payload: { ok: true } };
      }

      const failText = sanitizeErrorMessage(
        caption || 'Không tạo được hình ảnh từ nội dung mô tả này, tiền đã được hoàn lại.',
      );
      if (job !== targetJob) {
        job.status = 'failed';
        job.errorMessage = failText;
        job.finishedAt = nowSec;
        await this.saveJob(job);
      }
      targetJob.status = 'failed';
      targetJob.errorMessage = failText;
      targetJob.message = failText;
      targetJob.finishedAt = nowSec;
      await this.saveJob(targetJob);
      await this.cleanupLocalInputs(targetJob);
      await this.nudgeAiTaskPoll(targetJob);
      return { httpStatus: 200, payload: { ok: true } };
    }

    const totalChunks = Math.max(0, Math.floor(Number(body.chunks_total ?? job.totalChunks) || 0));
    if (totalChunks <= 0) {
      if (job.jobKind === 'text_to_video') {
        const targetJob = job.parentJobId ? (this.jobs.get(job.parentJobId) ?? job) : job;
        const caption = this.extractPostContentCaption(body.post_content);
        const asksApproval = /\[\[OPTION\]\]|phê duyệt|approve/i.test(caption);
        if (asksApproval && (targetJob.autoApproveCount ?? 0) < 2 && !(await this.isAiTaskCancelled(targetJob))) {
          const usedProfileExtId = String(body.assigned_profile_ext_id ?? '').trim() || job.pinnedProfileExtId || null;
          const usedProjectUrl = String(body.flow_project_url ?? '').trim() || job.pinnedFlowProjectUrl || null;
          const approveCmd = /luôn phê duyệt/i.test(caption)
            ? 'Luôn phê duyệt'
            : /always approve/i.test(caption)
              ? 'Always approve'
              : /approve/i.test(caption) && !/phê duyệt/i.test(caption)
                ? 'Approve'
                : 'Phê duyệt';

          if (job !== targetJob) {
            job.status = 'completed';
            job.percent = 100;
            job.finishedAt = nowSec;
            await this.saveJob(job);
          }

          const subId = this.allocateJobId();
          const sharedProj = targetJob.sharedProjectId || `novai-t2v-${targetJob.jobId}`;
          targetJob.isMasterContainer = true;
          targetJob.sharedProjectId = sharedProj;
          targetJob.autoApproveCount = (targetJob.autoApproveCount ?? 0) + 1;
          targetJob.subSceneJobIds = [...(targetJob.subSceneJobIds ?? []), subId];
          targetJob.status = 'running';
          targetJob.percent = Math.max(targetJob.percent || 10, 45);
          targetJob.message = 'Đang kết xuất video...';
          await this.saveJob(targetJob);

          const subJob: TavtavvideoBridgeJob = {
            jobId: subId,
            jobKind: 'text_to_video',
            flowModel: targetJob.flowModel ?? 'veo_fast',
            audioMode: targetJob.audioMode ?? 'sound',
            status: 'queued',
            percent: 45,
            message: 'Đang kết xuất video...',
            templateId: targetJob.templateId,
            backgroundMode: targetJob.backgroundMode,
            aspect: targetJob.aspect,
            resolution: targetJob.resolution,
            ...(targetJob.maxDurationSec ? { maxDurationSec: targetJob.maxDurationSec } : {}),
            userPrompt: targetJob.userPrompt,
            resolvedPrompt: approveCmd,
            imageMime: 'image/jpeg',
            videoMime: 'video/mp4',
            isInternalSubScene: true,
            parentJobId: targetJob.jobId,
            sharedProjectId: sharedProj,
            priority: 100,
            pinnedDeviceId: job.claimedByDeviceId ?? null,
            pinnedProfileExtId: usedProfileExtId,
            pinnedFlowProjectUrl: usedProjectUrl,
            createdAt: nowSec,
            updatedAt: nowSec,
          };
          await this.saveJob(subJob);
          this.logger.log(
            `Đơn T2V #${targetJob.jobId}: Tự động xác nhận "${approveCmd}" (#${subId}) trên hồ sơ ${usedProfileExtId ?? 'auto'}`,
          );
          return { httpStatus: 200, payload: { ok: true } };
        }

        const failText = sanitizeErrorMessage(
          caption || 'Không tạo được video từ nội dung mô tả này, tiền đã được hoàn lại.',
        );
        if (job !== targetJob) {
          job.status = 'failed';
          job.errorMessage = failText;
          job.finishedAt = nowSec;
          await this.saveJob(job);
        }
        targetJob.status = 'failed';
        targetJob.errorMessage = failText;
        targetJob.message = failText;
        targetJob.finishedAt = nowSec;
        await this.saveJob(targetJob);
        await this.cleanupLocalInputs(targetJob);
        await this.nudgeAiTaskPoll(targetJob);
        return { httpStatus: 200, payload: { ok: true } };
      }

      return { httpStatus: 400, payload: { ok: false, error: 'INVALID_CHUNKS', message: 'Thiếu số lượng mảnh video (chunks_total).' } };
    }

    const missing: number[] = [];
    const partPaths: string[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const p = join(jobChunkDir, `part_${String(i).padStart(5, '0')}`);
      if (!existsSync(p)) missing.push(i);
      partPaths.push(p);
    }
    if (missing.length > 0) {
      return { httpStatus: 409, payload: { ok: false, error: 'UPLOAD_INCOMPLETE', missing } };
    }

    const tmpAssembled = join(this.tmpDir, `assembled_${job.jobId}_${Date.now()}.mp4`);
    const hash = createHash('sha256');
    let assembledBytes = 0;

    try {
      const ws = createWriteStream(tmpAssembled);
      for (const partPath of partPaths) {
        await new Promise<void>((resolvePart, rejectPart) => {
          const rs = createReadStream(partPath);
          rs.on('data', (chunk: string | Buffer) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            hash.update(buf);
            assembledBytes += buf.length;
          });
          rs.on('error', rejectPart);
          rs.on('end', () => resolvePart());
          rs.pipe(ws, { end: false });
        });
      }
      await new Promise<void>((resEnd, rejEnd) => {
        ws.end(() => resEnd());
        ws.on('error', rejEnd);
      });
    } catch (err) {
      await unlink(tmpAssembled).catch(() => undefined);
      return { httpStatus: 500, payload: { ok: false, error: 'ASSEMBLE_ERROR', message: (err as Error).message } };
    }

    const expectedSha = String(body.sha256 ?? '').trim().toLowerCase();
    const actualSha = hash.digest('hex').toLowerCase();
    if (assembledBytes <= 0 || (expectedSha && expectedSha !== actualSha)) {
      await unlink(tmpAssembled).catch(() => undefined);
      await rm(jobChunkDir, { recursive: true, force: true }).catch(() => undefined);
      const allIndices = Array.from({ length: totalChunks }, (_, i) => i);
      return { httpStatus: 409, payload: { ok: false, error: 'UPLOAD_INCOMPLETE', missing: allIndices } };
    }

    await rm(jobChunkDir, { recursive: true, force: true }).catch(() => undefined);

    // =========================================================================
    // NHÁNH ĐIỀU PHỐI CHUỖI PHÂN CẢNH MOTION 30S TRÊN CÙNG 1 HỒ SƠ
    // =========================================================================
    if (job.isInternalSubScene && job.parentJobId && (!job.jobKind || job.jobKind === 'motion')) {
      const usedProfileExtId = String(body.assigned_profile_ext_id ?? '').trim() || job.pinnedProfileExtId || null;
      const usedProjectUrl = String(body.flow_project_url ?? '').trim() || job.pinnedFlowProjectUrl || null;
      const usedCredits = Number(body.flow_credits_used) >= 0 ? Number(body.flow_credits_used) : 0;

      job.assembledOutputLocalPath = tmpAssembled;
      job.pinnedProfileExtId = usedProfileExtId;
      job.pinnedFlowProjectUrl = usedProjectUrl;
      job.flowCreditsUsed = usedCredits;
      job.status = 'completed';
      job.percent = 100;
      job.message = `Hoàn tất phân cảnh ${job.sceneIndex}/${job.sceneTotal}`;
      job.errorMessage = null;
      job.finishedAt = nowSec;
      await this.saveJob(job);
      await this.cleanupSubJobOnlyInputs(job);

      await this.advanceOrFinalizeMotion30sMaster(
        job.parentJobId,
        job.claimedByDeviceId ?? null,
        usedProfileExtId,
        usedProjectUrl,
      );
      return { httpStatus: 200, payload: { ok: true } };
    }

    // =========================================================================
    // NHÁNH ĐƠN ĐƠN LẺ (MOTION 10S / I2V / T2V)
    // =========================================================================
    const targetVideoJob = job.parentJobId ? (this.jobs.get(job.parentJobId) ?? job) : job;
    const task = await this.resolveLinkedAiTask(targetVideoJob);
    const userId = task?.userId ?? targetVideoJob.aiUserId ?? 'system';
    const outStoragePath = `ai/outputs/${userId}/${monthFolder()}/${randomUUID()}.mp4`;

    await this.storage.putFile(outStoragePath, tmpAssembled, 'video/mp4');
    await unlink(tmpAssembled).catch(() => undefined);
    await this.cleanupLocalInputs(targetVideoJob);

    if (job !== targetVideoJob) {
      job.status = 'completed';
      job.percent = 100;
      job.finishedAt = nowSec;
      await this.saveJob(job);
    }

    targetVideoJob.outputStoragePath = outStoragePath;
    targetVideoJob.outputUrl = this.storage.url(outStoragePath);
    targetVideoJob.status = 'completed';
    targetVideoJob.percent = 100;
    targetVideoJob.message = 'Hoàn tất tạo video!';
    targetVideoJob.errorMessage = null;
    targetVideoJob.flowCreditsUsed = parseFlowCreditsUsed(body.flow_credits_used, null);
    targetVideoJob.finishedAt = nowSec;
    await this.saveJob(targetVideoJob);

    await this.nudgeAiTaskPoll(targetVideoJob);
    const kindLabel =
      targetVideoJob.jobKind === 'text_to_video'
        ? (targetVideoJob.maxDurationSec ?? 8) >= 15
          ? 'T2V15s'
          : 'T2V'
        : targetVideoJob.jobKind === 'image_to_video'
          ? (targetVideoJob.maxDurationSec ?? 8) >= 15
            ? 'I2V15s'
            : 'I2V'
          : targetVideoJob.jobKind === 'motion_eco'
            ? 'MotionEco'
            : targetVideoJob.jobKind === 'motion_15s'
              ? 'Motion15s'
              : 'Motion';
    this.logger.log(`Đơn ${kindLabel} tavtavvideo #${targetVideoJob.jobId} (${targetVideoJob.resolution.toUpperCase()}) hoàn tất (${(assembledBytes / 1048576).toFixed(1)} MB)`);
    return { httpStatus: 200, payload: { ok: true } };
  }

  /**
   * Mở khoá phân cảnh kế tiếp trên đúng hồ sơ vừa chạy xong, hoặc ghép nối toàn bộ khi đã đủ cả 3 cảnh.
   */
  private async advanceOrFinalizeMotion30sMaster(
    masterJobId: number,
    lastDeviceId: number | null,
    lastProfileExtId: string | null,
    lastFlowProjectUrl: string | null,
  ) {
    const master = this.jobs.get(masterJobId);
    if (!master || master.status === 'completed' || master.status === 'failed' || master.status === 'canceled') {
      return;
    }

    if (await this.isAiTaskCancelled(master)) {
      await this.cancelMasterAndSiblings(masterJobId, 0, 'Đơn đã được huỷ.');
      return;
    }

    const subIds = master.subSceneJobIds ?? [];
    const subJobs = subIds.map((id) => this.jobs.get(id)).filter((x): x is TavtavvideoBridgeJob => Boolean(x));

    // Tìm phân cảnh kế tiếp đang chờ ('waiting_prev') và mở khoá với độ ưu tiên cao nhất trên CÙNG 1 HỒ SƠ + truyền frame cuối nền sạch làm Relay Anchor
    const nextWaiting = subJobs.find((sj) => sj.status === 'waiting_prev');
    if (nextWaiting) {
      const sIdx = nextWaiting.sceneIndex ?? 2;
      const sTot = nextWaiting.sceneTotal ?? subJobs.length;

      nextWaiting.status = 'queued';
      nextWaiting.priority = 100;
      nextWaiting.pinnedDeviceId = lastDeviceId;
      nextWaiting.pinnedProfileExtId = lastProfileExtId;
      nextWaiting.pinnedFlowProjectUrl = lastFlowProjectUrl;
      nextWaiting.message = `Đang chuyển sang phân cảnh ${sIdx}/${sTot}...`;
      await this.saveJob(nextWaiting);

      const nextPct = Math.round(8 + ((sIdx - 1) * 84) / sTot);
      master.percent = Math.max(master.percent, nextPct);
      master.message = `Hoàn tất cảnh ${sIdx - 1}/${sTot} · đang dựng tiếp cảnh ${sIdx}/${sTot}...`;
      await this.saveJob(master);

      const task = await this.resolveLinkedAiTask(master);
      if (task && task.status === 'PROCESSING' && master.percent > task.progress) {
        await this.prisma.aiTask
          .updateMany({
            where: { id: task.id, status: 'PROCESSING' },
            data: { progress: master.percent },
          })
          .catch(() => undefined);
      }

      this.logger.log(
        `Đơn Motion 30s #${masterJobId}: Mở khoá phân cảnh ${sIdx}/${sTot} (#${nextWaiting.jobId}) ghim trên cùng hồ sơ ${lastProfileExtId ?? 'auto'}`,
      );
      return;
    }

    // Kiểm tra xem tất cả phân cảnh đã hoàn tất chưa
    const allCompleted = subJobs.length > 0 && subJobs.every((sj) => sj.status === 'completed' && sj.assembledOutputLocalPath);
    if (!allCompleted || this.stitchingMasterIds.has(masterJobId)) {
      return;
    }

    this.stitchingMasterIds.add(masterJobId);
    try {
      master.percent = 95;
      master.message = `Đang ghép nối ${subJobs.length} phân cảnh & đồng bộ âm thanh gốc...`;
      await this.saveJob(master);

      const task = await this.resolveLinkedAiTask(master);
      if (task && task.status === 'PROCESSING' && task.progress < 95) {
        await this.prisma.aiTask
          .updateMany({
            where: { id: task.id, status: 'PROCESSING' },
            data: { progress: 95 },
          })
          .catch(() => undefined);
      }

      const firstOut = subJobs[0].assembledOutputLocalPath!;
      const stitchedStat = await stat(firstOut);

      const userId = task?.userId ?? master.aiUserId ?? 'system';
      const outStoragePath = `ai/outputs/${userId}/${monthFolder()}/${randomUUID()}.mp4`;
      await this.storage.putFile(outStoragePath, firstOut, 'video/mp4');

      const totalCredits = subJobs.reduce((acc, sj) => acc + (sj.flowCreditsUsed ?? 0), 0);
      const nowSec = Math.floor(Date.now() / 1000);

      master.outputStoragePath = outStoragePath;
      master.outputUrl = this.storage.url(outStoragePath);
      master.flowCreditsUsed = totalCredits > 0 ? totalCredits : null;
      master.status = 'completed';
      master.percent = 100;
      master.message = 'Hoàn tất tạo video Motion 30s!';
      master.errorMessage = null;
      master.finishedAt = nowSec;
      await this.saveJob(master);

      await this.cleanupMasterAndSubArtifacts(master, subJobs);
      await this.nudgeAiTaskPoll(master);

      this.logger.log(
        `Đơn Motion 30s tavtavvideo #${masterJobId} (${master.resolution.toUpperCase()}, ${subJobs.length} cảnh) hoàn tất (${(stitchedStat.size / 1048576).toFixed(1)} MB)`,
      );
    } catch (err) {
      const errText = sanitizeErrorMessage((err as Error).message);
      this.logger.error(`Lỗi ghép nối đơn Motion 30s #${masterJobId}: ${(err as Error).message}`);
      await this.failMasterAndSiblings(masterJobId, 0, errText);
    } finally {
      this.stitchingMasterIds.delete(masterJobId);
    }
  }

  private async failMasterAndSiblings(masterJobId: number, excludeJobId: number, cleanErr: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const master = this.jobs.get(masterJobId);
    const subIds = master?.subSceneJobIds ?? [];
    const subJobs: TavtavvideoBridgeJob[] = [];

    for (const sid of subIds) {
      const sj = this.jobs.get(sid);
      if (!sj) continue;
      subJobs.push(sj);
      if (sj.jobId !== excludeJobId && (sj.status === 'waiting_prev' || sj.status === 'queued' || sj.status === 'running')) {
        if (sj.status === 'running' && sj.claimedByDeviceId && !sj.cancelCommandSent) {
          const cmdId = `cancel_${sj.jobId}_${nowSec}`;
          this.pendingCommands.set(cmdId, {
            cmd_id: cmdId,
            type: 'cancel_job',
            job_id: sj.jobId,
            deviceId: sj.claimedByDeviceId,
            createdAt: nowSec,
          });
          sj.cancelCommandSent = true;
        }
        sj.status = 'canceled';
        sj.finishedAt = nowSec;
        await this.saveJob(sj);
      }
    }

    if (master && master.status !== 'failed' && master.status !== 'completed') {
      master.status = 'failed';
      master.errorMessage = cleanErr;
      master.message = cleanErr;
      master.finishedAt = nowSec;
      await this.saveJob(master);
      await this.cleanupMasterAndSubArtifacts(master, subJobs);
      await this.nudgeAiTaskPoll(master);
    }
  }

  private async cancelMasterAndSiblings(masterJobId: number, excludeJobId: number, reason: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const master = this.jobs.get(masterJobId);
    const subIds = master?.subSceneJobIds ?? [];
    const subJobs: TavtavvideoBridgeJob[] = [];

    for (const sid of subIds) {
      const sj = this.jobs.get(sid);
      if (!sj) continue;
      subJobs.push(sj);
      if (sj.jobId !== excludeJobId && (sj.status === 'waiting_prev' || sj.status === 'queued' || sj.status === 'running')) {
        if (sj.status === 'running' && sj.claimedByDeviceId && !sj.cancelCommandSent) {
          const cmdId = `cancel_${sj.jobId}_${nowSec}`;
          this.pendingCommands.set(cmdId, {
            cmd_id: cmdId,
            type: 'cancel_job',
            job_id: sj.jobId,
            deviceId: sj.claimedByDeviceId,
            createdAt: nowSec,
          });
          sj.cancelCommandSent = true;
        }
        sj.status = 'canceled';
        sj.finishedAt = nowSec;
        await this.saveJob(sj);
      }
    }

    if (master && master.status !== 'canceled' && master.status !== 'completed') {
      master.status = 'canceled';
      master.errorMessage = reason;
      master.message = reason;
      master.finishedAt = nowSec;
      await this.saveJob(master);
      await this.cleanupMasterAndSubArtifacts(master, subJobs);
    }
  }

  private async cleanupSubJobOnlyInputs(subJob: TavtavvideoBridgeJob) {
    // Chỉ xoá clip tham chiếu đã cắt riêng cho phân cảnh này; giữ ảnh gốc dùng chung cho tới khi Master kết thúc
    if (subJob.videoLocalPath) {
      await unlink(subJob.videoLocalPath).catch(() => undefined);
    }
  }

  private async cleanupMasterAndSubArtifacts(master: TavtavvideoBridgeJob, subJobs: TavtavvideoBridgeJob[]) {
    for (const sj of subJobs) {
      if (sj.videoLocalPath) await unlink(sj.videoLocalPath).catch(() => undefined);
      if (sj.imageLocalPath && sj.imageLocalPath !== master.imageLocalPath) {
        await unlink(sj.imageLocalPath).catch(() => undefined);
      }
      if (sj.assembledOutputLocalPath) await unlink(sj.assembledOutputLocalPath).catch(() => undefined);
      const chunkDir = join(this.chunksRoot, String(sj.jobId));
      await rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (master.origAudioLocalPath) {
      await unlink(master.origAudioLocalPath).catch(() => undefined);
    }
    if (master.masterSourceVideoTempPath) {
      await unlink(master.masterSourceVideoTempPath).catch(() => undefined);
    }
    await this.cleanupLocalInputs(master);
  }

  private async cleanupLocalInputs(job: TavtavvideoBridgeJob) {
    if (job.imageLocalPath) await unlink(job.imageLocalPath).catch(() => undefined);
    if (job.videoLocalPath) await unlink(job.videoLocalPath).catch(() => undefined);
    if (Array.isArray(job.extraImageLocalPaths)) {
      for (const p of job.extraImageLocalPaths) {
        if (p) await unlink(p).catch(() => undefined);
      }
    }
  }

  /** Đánh thức cron của AiService thu hoạch kết quả ngay ở nhịp tiếp theo (không đụng đơn đang giữ bởi SUBMIT_HOLD_MS) */
  private async nudgeAiTaskPoll(job: TavtavvideoBridgeJob) {
    const task = await this.resolveLinkedAiTask(job);
    if (!task) return;
    await this.prisma.aiTask
      .updateMany({
        where: {
          id: task.id,
          status: 'PROCESSING',
          nextPollAt: { lte: new Date(Date.now() + 90_000) },
        },
        data: { nextPollAt: new Date() },
      })
      .catch(() => undefined);
  }

  getMinimalVoicesCatalog() {
    return {
      version: '1.0.0',
      default: 'hai-dang',
      default_voice: 'hai-dang',
      voices: [
        {
          id: 'hai-dang',
          order: 1,
          name: 'Hải Đăng',
          vieneu: 'hai-dang',
          gender: 'male',
          region: 'north',
          style: 'warm',
          featured: true,
          enabled: true,
        },
      ],
    };
  }

  getMinimalStylesCatalog() {
    return {
      version: '1.0.0',
      default_style: 'cinematic_realistic',
      styles: [
        {
          id: 'cinematic_realistic',
          name: 'Cinematic Realistic',
          prompt: 'cinematic realistic lighting, ultra detailed',
          enabled: true,
        },
      ],
    };
  }
}

export { pipeline };
