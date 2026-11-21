/**
 * Bộ quét & đánh dấu cảnh báo vi phạm nội dung cho tác vụ AI (T-273):
 * 1. Quét tự động theo thời gian thực trên prompt / dữ liệu văn bản khách nhập:
 *    - `nsfw`: Nội dung nhạy cảm 18+ / Nude - Sex / Khiêu dâm
 *    - `kyc`: Làm giả giấy tờ tuỳ thân / CCCD / CMND / Hộ chiếu / Bypass KYC / Sao kê giả
 *    - `illegal`: Nội dung vi phạm pháp luật (mạo danh công an/nhà nước, lừa đảo, cờ bạc, ma tuý, bạo lực/ấu dâm)
 * 2. Quét tự động phản hồi chặn từ bộ lọc an toàn (`policy_blocked`) khi đơn bị từ chối bởi chính sách nội dung.
 * 3. Hỗ trợ Quản trị viên đánh dấu vi phạm thủ công (đối với đơn tải ảnh/video nhạy cảm nhưng prompt bình thường) hoặc gỡ cảnh báo nhầm.
 */

export type ViolationCategory = 'nsfw' | 'kyc' | 'illegal' | 'policy_blocked';

export interface StoredViolationReview {
  status: 'flagged' | 'dismissed';
  category?: ViolationCategory;
  note?: string;
  actorId?: string;
  updatedAt: string;
}

export interface TaskViolationInfo {
  flagged: boolean;
  source: 'auto' | 'manual';
  categories: ViolationCategory[];
  label: string;
  matches: string[];
  note?: string;
  updatedAt?: string;
}

export const VIOLATION_CATEGORY_LABELS: Record<ViolationCategory, string> = {
  nsfw: 'Nude / Sex',
  kyc: 'Giấy tờ / KYC',
  illegal: 'Vi phạm pháp luật',
  policy_blocked: 'Bộ lọc chặn',
};

interface Rule {
  category: Exclude<ViolationCategory, 'policy_blocked'>;
  re: RegExp;
}

/**
 * Loại bỏ các cụm phủ định / negative prompt (vd "no nudity", "avoid: ..., nudity, ...", "không khỏa thân")
 * và màu thời trang "nude" (vd "nude heels", "nude lipstick", "váy màu nude") trước khi quét Nude / Sex (T-290).
 */
function sanitizeForNsfwScan(raw: string): string {
  return raw
    // Xoá nguyên dòng/mệnh đề negative prompt / avoid / restrictions
    .replace(/(?:negative\s*prompt|avoid|restrictions?|prohibited|forbidden|strictly\s+no|do\s+not\s+(?:include|show|generate|render)|không\s+(?:được|có|chứa))\s*[:\-–]\s*[^\n.!?]*/gi, ' ')
    // Xoá cụm phủ định trực tiếp (vd "no explicit nudity", "without nudity", "avoid nudity", "không khỏa thân")
    .replace(/\b(?:no|not|without|non|never|zero|avoid(?:ing)?|free\s+of|không\s+có|không)\s+(?:[a-z_]+\s+){0,3}(?:nudity|nude|naked|porn\w*|sex\w*|explicit\w*|khỏa\s*thân|khoả\s*thân|lõa\s*thể|loã\s*thể|trần\s*truồng|khiêu\s*dâm)\b/gi, ' ')
    // Xoá thuật ngữ màu da / thời trang / mỹ phẩm "nude" (nude heels, nude lipstick, nude dress, màu nude...)
    .replace(/\bnude\s*[- ]?(?:heels?|shoes?|pumps?|sandals?|stilettos?|boots?|flats?|sneakers?|lipstick|lip\s*gloss|lip\s*liner|lips?|makeup|eyeshadow|blush|nails?|nail\s*polish|manicure|pedicure|tones?|shades?|colors?|colours?|palette|beige|pink|rose|taupe|tan|peach|brown|cream|dress|gown|skirt|top|blouse|suit|coat|jacket|bag|handbag|clutch|purse|belt|stockings?|tights?|fabric|silk|satin|lace|leather|suede|matte|glossy|look|style)\b/gi, ' ')
    .replace(/(?:màu|tông|tone|son|giày|cao\s*gót|váy|đầm|áo|túi|sơn\s*móng|trang\s*điểm|makeup)\s+(?:màu\s+)?nude\b/gi, ' ');
}

const NSFW_RULES: RegExp[] = [
  // Chỉ lọc Nude (khỏa thân hoàn toàn / lộ bộ phận nhạy cảm) hoặc Sex / Khiêu dâm trực diện — KHÔNG lọc 18+ thông thường / gợi cảm / bikini (T-290)
  /\b(nude|nudity|completely\s+naked|fully\s+naked|stark\s+naked|strip\s+naked|naked\s+(?:body|woman|women|girl|man|men|people|couple|breasts?)|naked(?!\s+(?:eye|eyes|truth|fact|cake|bike|motorcycle|flame|wire|ambition|mole))|porn|pornography|pornographic|hentai|explicit\s+sex|sexual\s+intercourse|having\s+sex|make\s+love\s+naked|blowjob|fellatio|cunnilingus|handjob|gangbang|threesome\s+sex|orgy|masturbat\w*|cumshot|creampie|genitals?|vagina|penis|pussy|cock\s+suck\w*|sex\s*tape|deepnude|uncensored\s+nude)\b/gi,
  /(khỏa\s*thân|khoả\s*thân|lõa\s*thể|loã\s*thể|trần\s*truồng|cởi\s*truồng|lột\s*sạch\s*(?:quần\s*áo|đồ)|cởi\s*hết\s*(?:quần\s*áo|đồ)|không\s*mặc\s*(?:quần\s*áo|gì)|phim\s*sex|video\s*sex|clip\s*sex|ảnh\s*sex|làm\s*tình|quan\s*hệ\s*tình\s*dục|giao\s*hợp|khẩu\s*dâm|thủ\s*dâm|khiêu\s*dâm|kích\s*dục|dâm\s*dục|bộ\s*phận\s*sinh\s*dục|dương\s*vật|âm\s*đạo|lộ\s*(?:nhũ\s*hoa|vùng\s*kín|bộ\s*phận\s*sinh\s*dục))/gi,
  /\b(khoa\s+than|loa\s+the|tran\s+truong|coi\s+truong|coi\s+het\s+quan\s+ao|phim\s+sex|clip\s+sex|anh\s+sex|lam\s+tinh|quan\s+he\s+tinh\s+duc|thu\s+dam|khieu\s+dam|kich\s+duc)\b/gi,
];

const INPUT_RULES: Rule[] = [
  // Vi phạm pháp luật / Mạo danh / Lừa đảo / Cờ bạc / Ấu dâm / Chất cấm
  {
    category: 'illegal',
    re: /\b(csam|child\s*(?:porn|abuse|sexual)|underage\s*(?:nude|sex|naked)|minor\s*(?:nude|sex|naked)|terroris[mt]|bomb\s*making|money\s*laundering)\b/gi,
  },
  {
    category: 'illegal',
    re: /(ấu\s*dâm|trẻ\s*em\s*khỏa\s*thân|mạo\s*danh\s*(?:công\s*an|cảnh\s*sát|toà\s*án|viện\s*kiểm\s*sát|quân\s*đội|ngân\s*hàng)|giả\s*danh\s*(?:công\s*an|cảnh\s*sát)|lừa\s*đảo\s*(?:chuyển\s*khoản|chiếm\s*đoạt)|cờ\s*bạc\s*bịp|cá\s*độ\s*bóng\s*đá|tài\s*xỉu\s*online|nổ\s*hũ\s*đổi\s*thưởng|buôn\s*bán\s*ma\s*túy|sử\s*dụng\s*ma\s*túy|chế\s*tạo\s*(?:bom|thuốc\s*nổ|súng\s*đạn)|chống\s*phá\s*nhà\s*nước)/gi,
  },
  {
    category: 'illegal',
    re: /\b(au\s+dam|mao\s+danh\s+cong\s+an|gia\s+danh\s+cong\s+an|lua\s+dao\s+chiem\s+doat|tai\s+xiu\s+online|ca\s+do\s+bong\s+da|chong\s+pha\s+nha\s+nuoc)\b/gi,
  },
];

function extractInputStrings(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k.startsWith('__')) continue;
    // Bỏ qua các trường chỉ chứa đường dẫn file upload, thông số kỹ thuật ngắn, hoặc negative prompt (T-290)
    if (/^(image|images|refs|video|videos|audio|audios|refAudio|lastFrame|endImage|image2|model|mode|aspect|aspectRatio|aspect_ratio|ratio|size|resolution|quality|duration|option|format|speed|count|n|server|negativePrompt|negative_prompt|negPrompt|neg_prompt)$/i.test(k)) {
      continue;
    }
    if (typeof v === 'string' && v.trim()) {
      parts.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim() && !item.startsWith('/uploads/') && !/^https?:\/\//i.test(item)) {
          parts.push(item.trim());
        }
      }
    }
  }
  return parts.join('\n');
}

export function extractStoredViolationReview(output: unknown): StoredViolationReview | null {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__violationReview;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.status !== 'flagged' && r.status !== 'dismissed') return null;
  const cat = r.category;
  return {
    status: r.status,
    category: cat === 'nsfw' || cat === 'kyc' || cat === 'illegal' || cat === 'policy_blocked' ? cat : undefined,
    note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
    actorId: typeof r.actorId === 'string' ? r.actorId : undefined,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
  };
}

export function detectInputViolation(input: unknown): { categories: ViolationCategory[]; matches: string[] } | null {
  const text = extractInputStrings(input);
  if (!text) return null;
  const categories = new Set<ViolationCategory>();
  const matches = new Set<string>();
  const nsfwSafeText = sanitizeForNsfwScan(text);
  for (const re of NSFW_RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(nsfwSafeText)) !== null) {
      categories.add('nsfw');
      const hit = m[0].trim().toLowerCase();
      if (hit && matches.size < 8) matches.add(hit);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  for (const rule of INPUT_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      categories.add(rule.category);
      const hit = m[0].trim().toLowerCase();
      if (hit && matches.size < 8) matches.add(hit);
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  if (!categories.size) return null;
  return { categories: [...categories], matches: [...matches] };
}

export function inspectTaskViolation(task: {
  input?: unknown;
  output?: unknown;
  error?: string | null;
  providerData?: unknown;
}): TaskViolationInfo | null {
  const review = extractStoredViolationReview(task.output);
  if (review?.status === 'dismissed') return null;
  if (review?.status === 'flagged') {
    const cat: ViolationCategory = review.category ?? 'nsfw';
    if (cat === 'kyc') return null;
    return {
      flagged: true,
      source: 'manual',
      categories: [cat],
      label: VIOLATION_CATEGORY_LABELS[cat],
      matches: review.note ? [review.note] : ['Đánh dấu thủ công bởi Quản trị viên'],
      note: review.note,
      updatedAt: review.updatedAt,
    };
  }

  const inputHit = detectInputViolation(task.input);
  const categories = new Set<ViolationCategory>(inputHit?.categories ?? []);
  const matches = new Set<string>(inputHit?.matches ?? []);

  if (!categories.size) return null;
  const catList = [...categories];
  const primary = catList.find((c) => c === 'illegal') ?? catList.find((c) => c === 'kyc') ?? catList.find((c) => c === 'nsfw') ?? catList[0];
  return {
    flagged: true,
    source: 'auto',
    categories: catList,
    label: catList.length > 1 ? `${VIOLATION_CATEGORY_LABELS[primary]} +${catList.length - 1}` : VIOLATION_CATEGORY_LABELS[primary],
    matches: [...matches],
  };
}
