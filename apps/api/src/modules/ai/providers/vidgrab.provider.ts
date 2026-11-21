import { randomUUID } from 'node:crypto';
import { AiProviderError, type AiCallContext, type AiFieldOption, type AiInput, type AiOutputFile, type AiOutputType, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { backgroundState, sleep, startBackground } from './background.js';
import { joinUrl, pickMessage, str } from './http.js';

/**
 * VidGrab — https://dowloadvideo.io.vn/api-docs (máy chủ API thật: https://dvid-api.vibe1.tinhgon.xyz, header X-API-Key: vidgrab_...).
 * Tải video / nhạc từ TikTok, Douyin, Facebook, Instagram, YouTube... (xoá watermark).
 * - POST /api/v1/fetch-link { url, quality, remove_watermark, progress_token } — ĐỒNG BỘ (chờ tới khi tải xong);
 *   tự đặt progress_token rồi hỏi GET /api/v1/progress/{token} để lấy % tiến độ.
 * - Kết quả: file trên máy chủ VidGrab (local_file_id / local_mp3_file_id) tải qua /api/v1/download-local,
 *   hoặc link gốc direct_mp4_url (thường khoá theo IP máy chủ VidGrab) tải qua /api/v1/proxy-download.
 * - Key cá nhân (gói Pro/Team) giới hạn 30 lệnh/phút, lượt gọi mỗi tháng + lượt tải mỗi ngày theo gói.
 * Không có chi phí theo lượt -> công cụ dùng giá cố định (admin chỉnh ở AI Studio › Công cụ).
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

const URL_HELP = 'Hỗ trợ TikTok, Douyin, Facebook, Instagram, YouTube, Threads, X/Twitter, SoundCloud...';

const TOOLS: AiToolDef[] = [
  {
    key: 'video',
    name: 'Tải video không logo',
    category: 'tools',
    icon: 'video',
    description: 'Dán link để tải video TikTok, Douyin, Facebook, Instagram, YouTube... không watermark.',
    output: 'video',
    fields: [
      { name: 'url', label: 'Link video', type: 'text', required: true, max: 1000, placeholder: 'https://www.tiktok.com/@.../video/...', help: URL_HELP },
      {
        name: 'quality',
        label: 'Chất lượng',
        type: 'select',
        required: true,
        default: 'video',
        options: opts([
          ['video', 'Full HD 1080p'],
          ['video_720', 'HD 720p'],
          ['video_4k', 'Cao nhất (tới 4K)'],
          ['video_fast', 'Nhanh (chất lượng thấp hơn)'],
        ]),
      },
      { name: 'removeWatermark', label: 'Xoá watermark / logo', type: 'boolean', default: true },
    ],
    pricing: { mode: 'fixed', base: 500 },
  },
  {
    key: 'audio',
    name: 'Tách nhạc MP3 từ video',
    category: 'tools',
    icon: 'music',
    description: 'Dán link video hoặc bài hát để tải về file MP3.',
    output: 'audio',
    fields: [
      { name: 'url', label: 'Link video / bài hát', type: 'text', required: true, max: 1000, placeholder: 'https://...', help: URL_HELP },
      { name: 'quality', label: 'Chất lượng', type: 'select', required: true, default: 'mp3_320', options: opts([['mp3_320', 'MP3 320kbps'], ['mp3_128', 'MP3 128kbps']]) },
    ],
    pricing: { mode: 'fixed', base: 300 },
  },
];

const headers = (ctx: AiCallContext) => ({ 'X-API-Key': ctx.config.apiKey, Accept: 'application/json' });

/** Thông báo lỗi theo cấu trúc lỗi chung của VidGrab { error_code, user_message } hoặc { detail } */
function errorOf(status: number, data: any): { message: string; retryable: boolean } {
  const d = data?.detail && typeof data.detail === 'object' ? data.detail : data;
  // key sai / hết lượt tháng / hết lượt ngày của tài khoản VidGrab: lỗi phía website -> không lộ chi tiết
  if (status === 401 || status === 402 || status === 403 || /quota|api_monthly/i.test(String(d?.error_code ?? d?.code ?? ''))) {
    return { message: 'Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.', retryable: false };
  }
  const msg = (typeof d?.user_message === 'string' && d.user_message) || pickMessage(d) || pickMessage(data) || `Nhà cung cấp báo lỗi HTTP ${status}`;
  return { message: msg, retryable: d?.retryable === true || status === 429 || status >= 500 };
}

/** Gọi /fetch-link tới khi có kết quả; lỗi tạm thời (retryable, 429, 5xx) thử lại tối đa 3 lần có giãn cách */
async function fetchLink(ctx: AiCallContext, body: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    let data: any = null;
    try {
      const res = await fetch(joinUrl(ctx.config.baseUrl, '/api/v1/fetch-link'), {
        method: 'POST',
        headers: { ...headers(ctx), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // tải video dài có thể mất vài phút
        signal: AbortSignal.timeout(15 * 60_000),
      });
      status = res.status;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { body: text.slice(0, 2000) };
      }
    } catch (err) {
      // mất kết nối / quá giờ: VidGrab có thể đã tải xong (đã trừ lượt tải) -> không gửi lại, báo lỗi để hoàn credits
      throw new AiProviderError('Không nhận được kết quả từ máy chủ tải video, tiền đã được hoàn lại', { error: (err as Error).message });
    }
    if (status >= 200 && status < 300 && data?.success !== false && !data?.delayed && !data?.scheduled) return data;
    const e = status >= 200 && status < 300 ? { message: pickMessage(data) || 'Máy chủ tải video đang bận', retryable: true } : errorOf(status, data);
    if (!e.retryable || attempt >= 3) throw new AiProviderError(e.message, { status, data });
    await sleep((status === 429 ? 60_000 : 4_000) * attempt);
  }
}

/** Giới hạn file tự tải về (lớn hơn thì trả link proxy cho khách tải thẳng) */
const MAX_BYTES = 300 * 1024 * 1024;

/**
 * Các link tải file kết quả, theo thứ tự ưu tiên: file đã lưu trên máy chủ VidGrab -> proxy của VidGrab -> link gốc.
 * Link gốc YouTube thường khoá theo IP nên proxy có thể bị từ chối -> thử lần lượt tới khi được.
 */
function fileUrlsOf(ctx: AiCallContext, res: any, audio: boolean): string[] {
  const name = (p: unknown) => (typeof p === 'string' && p ? p.split(/[\\/]/).pop() || null : null);
  const videoFile = res?.local_file_id || name(res?.local_file_path);
  const mp3File = res?.local_mp3_file_id || name(res?.local_mp3_path);
  const file = audio ? mp3File || videoFile : videoFile || mp3File;
  const title = String(res?.title || (audio ? 'audio' : 'video')).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80);
  const urls: string[] = [];
  if (file) urls.push(joinUrl(ctx.config.baseUrl, `/api/v1/download-local?file=${encodeURIComponent(file)}&filename=${encodeURIComponent(title)}`));
  if (res?.direct_mp4_url) {
    urls.push(joinUrl(ctx.config.baseUrl, `/api/v1/proxy-download?url=${encodeURIComponent(res.direct_mp4_url)}&filename=${encodeURIComponent(title)}&ext=${audio ? 'mp3' : 'mp4'}`));
    urls.push(String(res.direct_mp4_url));
  }
  return urls;
}

/** Tải file kết quả về (trả nội dung để lưu vào storage của mình); file quá lớn thì trả link để khách tải thẳng */
async function downloadResult(ctx: AiCallContext, urls: string[], type: AiOutputType): Promise<AiOutputFile | null> {
  for (const url of urls) {
    try {
      const own = url.startsWith(joinUrl(ctx.config.baseUrl, '/'));
      const res = await fetch(url, { headers: own ? headers(ctx) : {}, signal: AbortSignal.timeout(10 * 60_000) });
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
      // lỗi của VidGrab trả JSON { detail } -> thử link tiếp theo
      if (!res.ok || mime.includes('json') || mime.includes('html')) continue;
      if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return { url, type };
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 1024) continue;
      return { url: '', type, data, mimeType: mime.startsWith(type) ? mime : type === 'audio' ? 'audio/mpeg' : 'video/mp4', sourceUrl: url };
    } catch {
      // thử link tiếp theo
    }
  }
  return null;
}

/**
 * Tải video từ link mạng xã hội (TikTok, Douyin...) về thành nội dung file — dùng cho ô "Dán link video"
 * của công cụ khác (vd Motion Control). Không tải được hoặc file quá lớn -> ném lỗi để báo khách.
 */
export async function grabVideo(ctx: AiCallContext, url: string): Promise<{ data: Buffer; mimeType: string; title: string }> {
  const res = await fetchLink(ctx, { url, quality: 'video_720', remove_watermark: true, progress_token: `nov-${randomUUID()}` });
  const file = await downloadResult(ctx, fileUrlsOf(ctx, res, false), 'video');
  if (!file?.data) throw new AiProviderError('Không tải được video từ link này (video quá lớn hoặc link không hỗ trợ)');
  return { data: file.data, mimeType: file.mimeType || 'video/mp4', title: String(res?.title || 'video').slice(0, 120) };
}

export const vidgrabProvider: AiProvider = {
  key: 'vidgrab',
  name: 'VidGrab (dowloadvideo.io.vn)',
  website: 'https://dowloadvideo.io.vn',
  tools: TOOLS,

  async submit(tool, input: AiInput, ctx) {
    if (!ctx.config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
    const url = str(input.url);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new AiProviderError('Link không hợp lệ, vui lòng dán link bắt đầu bằng http:// hoặc https://');
    const audio = tool.key === 'audio';
    const type: AiOutputType = audio ? 'audio' : 'video';
    // progress_token do mình đặt: dùng luôn làm mã theo dõi tác vụ
    const token = `nov-${randomUUID()}`;
    const body = { url, quality: str(input.quality) || (audio ? 'mp3_320' : 'video'), remove_watermark: audio ? false : input.removeWatermark !== false, progress_token: token };

    startBackground(
      token,
      async (setProgress) => {
        // hỏi tiến độ song song trong lúc chờ /fetch-link
        let done = false;
        const watch = (async () => {
          while (!done) {
            await sleep(3000);
            const p = await fetch(joinUrl(ctx.config.baseUrl, `/api/v1/progress/${encodeURIComponent(token)}`), { headers: headers(ctx), signal: AbortSignal.timeout(10_000) })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null);
            if (p && Number(p.percent) > 0) setProgress(Number(p.percent));
          }
        })();
        try {
          const res = await fetchLink(ctx, body);
          // tải file ngay: link của VidGrab chỉ sống ngắn
          const file = await downloadResult(ctx, fileUrlsOf(ctx, res, audio), type);
          if (!file) return { status: 'failed', providerTaskId: token, error: 'Không tải được file từ link này, tiền đã được hoàn lại', raw: res };
          return { status: 'succeeded', providerTaskId: token, files: [{ ...file, name: res?.title ? String(res.title).slice(0, 120) : undefined }], raw: res } satisfies AiProviderResult;
        } finally {
          done = true;
          await watch;
        }
      },
      audio ? 30_000 : 45_000,
    );
    return { status: 'processing', providerTaskId: token };
  },

  async poll(_tool, id) {
    return backgroundState(id);
  },

  /** Lượt gọi API còn lại trong tháng — GET /api/v1/api-keys/usage */
  async balance(ctx) {
    const res = await fetch(joinUrl(ctx.config.baseUrl, '/api/v1/api-keys/usage'), { headers: headers(ctx), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const u: any = res?.ok ? await res.json().catch(() => null) : null;
    if (!u) return null;
    const limit = Number(u.limit ?? u.monthly_limit ?? u.quota);
    const used = Number(u.used ?? u.calls ?? u.count);
    if (Number.isFinite(limit) && Number.isFinite(used)) return { balance: Math.max(0, limit - used), unit: 'lượt gọi còn lại tháng này' };
    return null;
  },
};
