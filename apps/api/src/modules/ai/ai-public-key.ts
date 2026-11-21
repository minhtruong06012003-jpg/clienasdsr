import { createHash } from 'node:crypto';
import { AI_PROVIDERS } from './providers/index.js';

/**
 * Khoá công khai của công cụ AI (dùng trên URL website, API khách, lịch sử tác vụ) để khách không thấy tên nhà cung cấp.
 * - Khoá nội bộ `<provider>.<tool>[~<model>]` (vd `aideepcut.ai-video-v1`) -> khoá công khai `<tool>[~<model>]` (vd `ai-video-v1`).
 * - Hai nhà cung cấp trùng tên công cụ: nhà cung cấp đứng trước trong AI_PROVIDERS giữ tên gốc, nhà sau thêm hậu tố
 *   băm ngắn (vd `text-to-speech-3f2a`) — nhà cung cấp mới luôn thêm vào cuối nên khoá công khai cũ không bị đổi.
 * - API vẫn nhận khoá nội bộ cũ (link đã chia sẻ, khách tích hợp API trước đây).
 */

/** Ký tự ngăn công cụ gốc và model con (giống MODEL_SEP của ai.service.ts) */
const MODEL_SEP = '~';

/** Băm ngắn, không đoán ngược được tên nhà cung cấp */
const shortHash = (s: string, len = 4) => createHash('sha1').update(s).digest('hex').slice(0, len);

/** Khoá gốc nội bộ `<provider>.<tool>` <-> khoá gốc công khai */
const toPublicBase = new Map<string, string>();
const toInternalBase = new Map<string, string>();
for (const p of AI_PROVIDERS) {
  for (const t of p.tools) {
    const internal = `${p.key}.${t.key}`;
    let slug = t.key;
    if (toInternalBase.has(slug)) slug = `${t.key}-${shortHash(internal)}`;
    toPublicBase.set(internal, slug);
    toInternalBase.set(slug, internal);
  }
}

/** Đăng ký khoá công khai cho công cụ được tự động phát hiện động lúc chạy (T-473) */
export function registerPublicTool(providerKey: string, toolKey: string): string {
  const internal = `${providerKey}.${toolKey}`;
  const existing = toPublicBase.get(internal);
  if (existing) return existing;
  let slug = toolKey;
  if (toInternalBase.has(slug)) slug = `${toolKey}-${shortHash(internal)}`;
  toPublicBase.set(internal, slug);
  toInternalBase.set(slug, internal);
  return slug;
}

/** Tách `<gốc>~<model>` (model có thể chứa dấu chấm nên tách theo `~` trước) */
const split = (key: string): [string, string] => {
  const i = key.indexOf(MODEL_SEP);
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i)];
};

/** Khoá nội bộ -> khoá công khai (khoá lạ thì giữ nguyên; ẩn luôn tiền tố nhà cung cấp bên trong nhánh `~model` — T-506) */
export function publicToolKey(key: string): string {
  const [base, model] = split(key);
  const slug = toPublicBase.get(base);
  const cleanModel = model.replace(/^~kapend_/i, '~kp_');
  return slug ? `${slug}${cleanModel}` : key;
}

/** Khoá khách gửi lên (công khai hoặc nội bộ cũ) -> khoá nội bộ (khoá lạ thì giữ nguyên, nơi gọi tự báo không tồn tại) */
export function internalToolKey(key: string): string {
  const [base, model] = split(key);
  const internal = toInternalBase.get(base);
  const resolvedBase = internal ?? base;
  const restoredModel = resolvedBase.startsWith('kapend.') ? model.replace(/^~kp_/i, '~kapend_') : model;
  return internal ? `${internal}${restoredModel}` : `${base}${restoredModel}`;
}

/** Mã thay cho tên nhà cung cấp trên link nghe thử giọng đọc (`/public/ai/voice-preview/<mã>/<giọng>`) */
export const providerAlias = (providerKey: string) => `v${shortHash(`voice:${providerKey}`, 6)}`;

/** Mã trên link nghe thử -> khoá nhà cung cấp (vẫn nhận tên nhà cung cấp cũ để link trình duyệt đã lưu còn chạy) */
export function providerFromAlias(alias: string): string {
  return AI_PROVIDERS.find((p) => providerAlias(p.key) === alias)?.key ?? alias;
}

/** Đổi link nghe thử trong định nghĩa ô form từ tên nhà cung cấp sang mã trung tính */
export function maskPreviewUrl(url: string): string {
  return url.replace(/\/voice-preview\/([^/]+)\//, (_m, p: string) => `/voice-preview/${providerAlias(p)}/`);
}

/**
 * Tên / tên miền nhà cung cấp API AI có thể lọt vào chữ khách thấy (tên công cụ admin đặt, câu báo lỗi nhà cung cấp trả về...).
 * Cụm dài đứng trước để "AI DeepCut" không bị thay thành "AI Hệ thống AI".
 */
const BRAND = String.raw`(?:TMC\s*Video\s*AI|tmcvideoai|AI\s*DeepCut|aideepcut|DeepCut|Trạm\s*Sáng\s*Tạo|Tram\s*Sang\s*Tao|tramsangtao|SangTao(?:\.ai)?|sangtaoai|79AI(?:\.net)?|79ai|79router|GoMMO|gommo|go-mmo|BOTSD(?:\.PRO)?|\bBotSD\b|botsd(?:\.pro)?|AIShop24|aishop24(?:\.io\.vn)?|PlenxAI|plenxai(?:\.com)?|\bPlenX\b|Seedance\s*AI\s*Studio|SeedanceCreationBot|seedancecreationbot(?:\.online)?|\bSeedanceBot\b|Mai\s*Video(?:\s*Studio)?|maivideo(?:\.top)?|11lab\.id\.vn|\b11lab\b|Kapend|YupVox|VidGrab|Vimo\s*Video|vimovideo|\bVimo\b|IMG\s*Studio|\bimgstudio\b|\bIMGAPI\b|\bimgapi\b|dowloadvideo|AHiep|LamClip|tavtavvideo|FableMedical|fablemedical|Fable\s*Studio|\bFable\b|Prism\s*Forge|prismforge|Runup\s*Studio|\brunup(?:\.studio)?\b|ChugAx(?:\s*AI)?|chugax(?:ai)?|\bUp4K\b|\bup4k\b|ivoi\.io|\biVoi\b|\bivoi\b|\bTMC\b)`;
/** Cụm trong ngoặc tròn / ngoặc vuông có tên nhà cung cấp, vd " (YupVox)", " (IMG Studio)", " [11lab]" -> bỏ hẳn */
const BRAND_PAREN = new RegExp(
  String.raw`\s*(?:\([^()]*${BRAND}[^()]*\)|\[[^\[\]]*(?:${BRAND}|\bKIE\b|\bIMGAPI\b)[^\[\]]*\]|【[^【】]*${BRAND}[^【】]*】)`,
  'gi',
);
/** Link / tên miền của nhà cung cấp, vd https://cdn.yupvox.com/a.mp3, yupvox.com/voices -> bỏ hẳn */
const BRAND_URL = new RegExp(String.raw`(?:https?:\/\/)?[\w.-]*${BRAND}[\w.-]*\.[a-z]{2,}(?:\/[^\s"',;)]*[^\s"',;).])?`, 'gi');
/** "SangTao.ai" đứng một mình là tên thương hiệu (không phải link) -> thay như tên */
const BRAND_NAME_DOMAIN = /\bSangTao\.ai\b(?![\w/.-])/gi;
const BRAND_WORD = new RegExp(BRAND, 'gi');

/** Kiểm tra chuỗi tên công cụ / nhãn model có chứa ký tự, tên thương hiệu hoặc tên miền của nguồn hay không (T-376) */
export function hasProviderBrandLeak(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  BRAND_PAREN.lastIndex = 0;
  BRAND_URL.lastIndex = 0;
  BRAND_NAME_DOMAIN.lastIndex = 0;
  BRAND_WORD.lastIndex = 0;
  return BRAND_PAREN.test(raw) || BRAND_URL.test(raw) || BRAND_NAME_DOMAIN.test(raw) || BRAND_WORD.test(raw);
}

/**
 * Tự động làm sạch tên công cụ / tên model / tên nhóm từ các nguồn trước khi lưu hoặc hiển thị lên web (T-376):
 * - Nếu tên từ nguồn dính tên thương hiệu, tên miền, hoặc hậu tố ngoặc của họ (vd `(IMG Studio)`, `[11lab]`, `79AI - ...`, `... - GoMMO`, `maivideo.top`, `botsd.pro`...) -> tự gỡ sạch cả cụm và dọn dấu phân cách thừa.
 * - Nếu tên đã chuẩn (không dính ký tự liên quan tới nguồn) -> giữ nguyên tên để cập nhật thẳng lên web.
 */
export function sanitizeToolDisplayName(raw: string): string {
  const orig = (raw ?? '').trim();
  if (!orig) return orig;
  const cleaned = orig
    .replace(BRAND_PAREN, '')
    .replace(BRAND_URL, '')
    .replace(BRAND_NAME_DOMAIN, '')
    .replace(BRAND_WORD, '')
    .replace(/\(\s*\)|\[\s*\]|【\s*】/g, '')
    .replace(/(?:\s*[·•|]\s*){2,}/g, ' · ')
    .replace(/(?:\s*[-–—]\s*){2,}/g, ' - ')
    .replace(/\s*[·•|]\s*[-–—]\s*|\s*[-–—]\s*[·•|]\s*/g, ' · ')
    .replace(/^[\s·•|\-–—/:;,]+|[\s·•|\-–—/:;,]+$/g, '')
    .replace(/\bAI\s+AI\b/gi, 'AI')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return cleaned || 'Công cụ AI';
}

/** Chuẩn hoá các thông báo lỗi tiếng Trung / tiếng Anh hạ tầng / thuật ngữ "Xu" từ đầu nguồn sang tiếng Việt thân thiện */
export function normalizeAiErrorText(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  if (/所有\s*Muse\s*账号都在忙|等待超时|请稍后重试/i.test(s)) {
    return 'Hệ thống tạo video đang quá tải tạm thời, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
  }
  if (/[\u4e00-\u9fff]/.test(s)) {
    if (/敏感|违规|审核|安全|禁止|色情|政治|不当|拦截/.test(s)) {
      return 'Nội dung mô tả hoặc file tham chiếu chưa phù hợp chính sách kiểm duyệt AI, vui lòng chỉnh sửa rồi thử lại. Tiền đã được hoàn lại vào ví.';
    }
    if (/超时|繁忙|都在忙|拥堵|队列|限流/.test(s)) {
      return 'Hệ thống AI đang quá tải tạm thời, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
    }
    if (/[\u4e00-\u9fff]{2,}/.test(s)) {
      return 'Hệ thống xử lý AI gặp gián đoạn tạm thời, vui lòng thử lại sau ít phút. Tiền đã được hoàn lại vào ví.';
    }
  }
  if (/cloudflare\s*tunnel|unable to reach|bad gateway|gateway time-?out|service temporarily unavailable|502 bad gateway|504 gateway/i.test(s)) {
    return 'Máy chủ xử lý đang bận tạm thời, vui lòng thử lại sau ít giây.';
  }

  s = s
    .replace(/\bXu đã được hoàn lại(?:\s+cho bạn)?/gi, 'Tiền đã được hoàn lại vào ví')
    .replace(/vi phạm chính sách(?:\s+nội dung)?\s+của\s+Grok/gi, 'chưa phù hợp chính sách kiểm duyệt nội dung AI');

  return s;
}

/** Che tên / link nhà cung cấp trong chữ hiển thị cho khách (tên công cụ, mô tả, hướng dẫn ô form, câu báo lỗi) */
export function hideProviderText<T extends string | null | undefined>(text: T): T {
  if (typeof text !== 'string' || !text) return text;
  return normalizeAiErrorText(text)
    .replace(BRAND_PAREN, '')
    .replace(BRAND_NAME_DOMAIN, 'Hệ thống AI')
    .replace(BRAND_URL, '')
    .replace(BRAND_WORD, 'Hệ thống AI')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim() as T;
}
