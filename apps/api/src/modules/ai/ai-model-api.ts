import { BadRequestException } from '@nestjs/common';
import type { AiFieldDef, AiInput } from './ai.types.js';

/**
 * Chuẩn hoá công cụ AI thành "model" cho API khách `/v1` (giống quy ước của OpenAI / fal.ai):
 * - Mã model = tên model chuẩn, không lộ nhà cung cấp (vd `kling-2.6`, `gpt-image-2`, `seedream-5.0`);
 *   cùng một model có ở nhiều công cụ thì thêm tác vụ phía sau (vd `kling-2.6/first-last-frame`).
 * - Tên tham số snake_case theo cách gọi phổ biến của model gốc (vd `aspectRatio` -> `aspect_ratio`,
 *   `voiceId` -> `voice`, ô ảnh -> `image_url`); ô gộp "thời lượng|độ phân giải" tách thành `duration` + `resolution`.
 * - Lựa chọn phụ thuộc ô Model AI đã ẩn (công cụ con theo model) được rút gọn về đúng lựa chọn của model đó.
 * File này chỉ chứa hàm thuần (không đụng DB) để dễ kiểm thử.
 */

const FILE_TYPES = new Set(['image', 'video', 'audio', 'file']);

/** Bỏ dấu tiếng Việt + đưa về chữ thường */
const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/**
 * Tên hiển thị của model -> mã model chuẩn: bỏ phần mô tả sau " · " / " - " / "(", bỏ dấu, nối bằng gạch ngang.
 * Vd "Kling 2.6" -> `kling-2.6`, "ElevenLabs v3 (Giọng AI cao cấp)" -> `elevenlabs-v3`, "Google Lyria 2 · Nhạc..." -> `google-lyria-2`.
 */
export function slugModel(label: string): string {
  const head = label.split(/\s[·•|]\s|\s[-–—]\s|\s?\(/)[0] || label;
  return plain(head)
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

/** Chuẩn hoá dấu gạch giữa số phiên bản kiểu `5-5` -> `5.5`, `3-0` -> `3.0` khi đi sau tên chữ */
const normVersionDots = (s: string) => s.replace(/([a-z]-)(\d)-(\d)(?=-|\/|$)/g, '$1$2.$3');

/** Bảng gộp tên biến thể khác nguồn về chung 1 mã canonical_model chuẩn để khách gọi `model + server` cho TẤT CẢ model */
const CANONICAL_MODEL_ALIASES: Record<string, string> = {
  'gemini-nano-banana-2.1': 'nano-banana-2.1',
  'nano-banana2-lowcost': 'nano-banana-2.1',
  'nano-banana-2.2': 'nano-banana-2',
  'gemini-3-pro-image': 'nano-banana-pro',
  'gemini-3.1-flash-image': 'nano-banana-2',
  'gemini-3.1-flash-lite-image': 'nano-banana-2-lite',
  'gpt-image-2-lowcost': 'gpt-image-2',
  'grok-imagine-video-1.5': 'grok-video-1.5',
  'grok-image': 'grok-imagine-2.0',
  'veo-3.1-lite': 'google-veo-3.1',
  'veo-3.1': 'google-veo-3.1',
  'veo-3-relaxed': 'google-veo-3-relaxed',
  'veo-3-fast': 'google-veo-3-fast',
  'omni-flash': 'google-omni-1.1-flash',
  'omni-flash-12': 'google-omni-1.2-flash',
  'omni-flash-1.2': 'google-omni-1.2-flash',
  'gemini-omni-1.2': 'google-omni-1.2-flash',
  'seedance-2.5-720p': 'seedance-2.5',
  'seedance-2.5-1080p': 'seedance-2.5',
  'wan-3.0-cheap': 'wan-3.0',
  'minimax-h3-enhanced': 'minimax-h3',
  'kling-3.0-sieu-net': 'kling-3.0',
  'kling-3-omni-image': 'kling-3.0-omni-image',
  'kling-avatar': 'avatar',
  'meta-muse-video': 'muse-video',
  'muse-ai': 'muse-video',
  'video': 'muse-video',
  'topaz-upscale-maxx': 'video-upscale-4k',
  'upscale': 'image-upscale-4k',
  'wf-upscale-ultra': 'image-upscale-4k',
  'remove-bg': 'remove-background',
  'voice': 'tts',
};

/**
 * Chuẩn hoá mã route lẻ (vd `seedream-5.5-2`, `seedream-5-5`, `wan-3-0`, `nano-banana-pro/image`)
 * về mã `canonical_model` chung (vd `seedream-5.5`, `wan-3.0`, `nano-banana-pro`) cho cấu trúc `Model -> Server (SV)`.
 */
export function canonicalModelSlug(apiId: string, label: string, category?: string): string {
  const normApi = String(apiId ?? '').trim().toLowerCase();
  const [idHeadRaw, idSubRaw = ''] = normApi.split('/', 2);
  const idSubClean = idSubRaw.replace(/-\d+$/, '');

  let lbl = normVersionDots(slugModel(label || idHeadRaw));
  lbl = lbl
    .replace(/^(tao-va-ghep-anh|tao-ghep-anh|tao-anh|tao-video|cong-cu)-/, '')
    .replace(/-(video|image-ai-studio-4k)$/, '');

  let head = normVersionDots(idHeadRaw);
  if (CANONICAL_MODEL_ALIASES[head]) {
    head = CANONICAL_MODEL_ALIASES[head];
  } else {
    const m = /^(.+)-(\d+)$/.exec(head);
    if (m && Number(m[2]) >= 2 && Number(m[2]) <= 9 && !lbl.endsWith(`-${m[2]}`)) {
      head = m[1];
    }
    head = CANONICAL_MODEL_ALIASES[head] ?? head;
  }

  if (idSubClean === 'edit' || idSubClean === 'grok-edit' || (category === 'chinh-sua-anh-ai' && idSubClean && !idSubClean.includes('upscale'))) {
    return `${head}/edit`;
  }
  if (idSubClean.includes('upscale')) {
    return `${head}/upscale`;
  }
  if (idSubClean === 'first-last-frame') {
    return `${head}/first-last-frame`;
  }
  return head;
}

/** Chuẩn hoá tên nhóm model sang slug `group_id` */
export function slugGroup(group: string | null | undefined): string | null {
  if (!group || !group.trim()) return null;
  const s = slugModel(group);
  return s || null;
}

/** Mã model hợp lệ do admin tự đặt: chữ thường, số, `.`, `-`, `_`, tối đa một dấu `/` ngăn tác vụ */
export const API_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,59}(\/[a-z0-9][a-z0-9._-]{0,59})?$/;

/** camelCase -> snake_case (vd `targetDurationSeconds` -> `target_duration_seconds`) */
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Tên nội bộ -> tên tham số chuẩn (chưa tính hậu tố `_url` của ô file) */
const ALIAS: Record<string, string> = {
  aspectRatio: 'aspect_ratio',
  ratio: 'aspect_ratio',
  voiceId: 'voice',
  voiceName: 'voice',
  voiceCode: 'voice',
  speaker: 'voice',
  count: 'n',
  num_images: 'n',
  refs: 'reference_images',
  srtText: 'srt',
  targetLang: 'target_language',
  negativePrompt: 'negative_prompt',
  // tránh trùng với khoá `model` của body (ô model chưa tách thành model riêng)
  model: 'model_variant',
};

type Option = { value: string; label: string };

/** Một tham số đầu vào của model trên API `/v1` */
export interface ApiParam {
  /** Tên tham số gửi lên API */
  name: string;
  /** Kiểu dữ liệu: string | integer | number | boolean | enum | file_url */
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'file_url';
  /** Ô file: loại file nhận (image | video | audio | file) */
  file_type?: string;
  required: boolean;
  description: string;
  default?: string | number | boolean;
  /** enum: các giá trị hợp lệ (kèm nhãn hiển thị) */
  options?: Option[];
  /** enum phụ thuộc tham số khác: { param, map: { "<giá trị tham số cha>": options } } */
  options_by?: { param: string; map: Record<string, Option[]> };
  /** string: độ dài tối đa; number: giới hạn */
  min?: number;
  max?: number;
  /** file_url: nhận mảng nhiều URL */
  multiple?: boolean;
  max_files?: number;
  /** Chỉ có hiệu lực khi tham số khác nằm trong danh sách giá trị */
  only_if?: { param: string; in: string[] };
  /** duration / resolution tách từ một ô gộp: các tổ hợp hợp lệ (vd ["5s · 720p", "10s · 720p"]) */
  combinations?: string[];
}

/** Ô gộp "thời lượng|độ phân giải" (vd `5|720p`, `10|`, `|2K`) */
const COMBO_RE = /^(\d*)\|(\d+(?:p|k)?|)$/i;

/** Cách ánh xạ một ô nội bộ ra tham số API */
type Spec =
  /** ô thường: một tham số */
  | { kind: 'plain'; field: AiFieldDef; name: string }
  /** ô cố định (ẩn hoặc chỉ một lựa chọn): không nhận từ khách, luôn gửi giá trị này */
  | { kind: 'fixed'; field: AiFieldDef; value: unknown }
  /** ô gộp thời lượng|độ phân giải: tách thành 2 tham số */
  | { kind: 'combo'; field: AiFieldDef; options: Option[]; duration: string | null; resolution: string | null }
  /** ô không có hiệu lực với model này (showIf phụ thuộc ô cố định không thoả) */
  | { kind: 'skip'; field: AiFieldDef };

const parseCombo = (v: string) => {
  const m = COMBO_RE.exec(v);
  return { dur: m?.[1] ?? '', res: m?.[2] ?? '' };
};

/**
 * Lập bảng ánh xạ ô nội bộ -> tham số API của một công cụ.
 * Hai ô cùng ra một tên chuẩn (vd `voice` và `voiceId`) thì ô sau giữ tên snake_case gốc để không đè nhau.
 */
function specs(fields: AiFieldDef[]): Spec[] {
  // giá trị các ô ẩn (vd ô Model AI của công cụ con) để rút gọn lựa chọn phụ thuộc
  const fixed = new Map<string, string>();
  for (const f of fields) if (f.hidden && f.default !== undefined) fixed.set(f.name, String(f.default));
  const used = new Set<string>(['model']);
  const take = (base: string, alt: string) => {
    let n = used.has(base) ? alt : base;
    for (let i = 2; used.has(n); i++) n = `${alt}_${i}`;
    used.add(n);
    return n;
  };
  const out: Spec[] = [];
  for (const orig of fields) {
    if (orig.hidden) {
      out.push({ kind: 'fixed', field: orig, value: orig.default });
      continue;
    }
    const f: AiFieldDef = { ...orig };
    if (f.showIf && fixed.has(f.showIf.field)) {
      if (!f.showIf.in.includes(fixed.get(f.showIf.field)!)) {
        out.push({ kind: 'skip', field: orig });
        continue;
      }
      delete f.showIf;
    }
    if (f.optionsBy && fixed.has(f.optionsBy.field)) {
      f.options = f.optionsBy.map[fixed.get(f.optionsBy.field)!] ?? [];
      delete f.optionsBy;
    }
    if (f.type === 'select' && !f.optionsBy && f.options?.length === 1) {
      out.push({ kind: 'fixed', field: orig, value: f.options[0].value });
      continue;
    }
    if (f.type === 'select' && !f.optionsBy && f.options && f.options.length > 1 && f.options.every((o) => COMBO_RE.test(o.value))) {
      const hasDur = f.options.some((o) => parseCombo(o.value).dur);
      const hasRes = f.options.some((o) => parseCombo(o.value).res);
      if ((!hasDur || !used.has('duration')) && (!hasRes || !used.has('resolution'))) {
        if (hasDur) used.add('duration');
        if (hasRes) used.add('resolution');
        out.push({ kind: 'combo', field: f, options: f.options, duration: hasDur ? 'duration' : null, resolution: hasRes ? 'resolution' : null });
        continue;
      }
    }
    let base = ALIAS[f.name] ?? snake(f.name);
    const isFile = FILE_TYPES.has(f.type);
    const suffix = f.multiple ? 'urls' : 'url';
    if (isFile && !/_?urls?$/.test(base)) base = f.multiple ? `${base.replace(/s$/, '')}_urls` : `${base}_url`;
    out.push({ kind: 'plain', field: f, name: take(base, isFile ? `${snake(f.name)}_${suffix}` : snake(f.name)) });
  }
  return out;
}

/** Tên tham số API của một ô nội bộ (dùng cho only_if / options_by trỏ tới ô khác) */
const nameOf = (list: Spec[], internal: string) => {
  const s = list.find((x) => x.field.name === internal);
  return s?.kind === 'plain' ? s.name : internal;
};

const opt = (o: Option) => ({ value: o.value, label: o.label });

/** Danh sách tham số chuẩn của một công cụ (mô tả cho tài liệu / `GET /v1/models/{id}`) */
export function apiParams(fields: AiFieldDef[]): ApiParam[] {
  const list = specs(fields);
  const params: ApiParam[] = [];
  for (const s of list) {
    if (s.kind === 'combo') {
      const parsed = s.options.map((o) => parseCombo(o.value));
      const first = parsed[0];
      const combinations = s.options.map((o) => o.label);
      const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
      if (s.duration) {
        const durs = uniq(parsed.map((p) => p.dur));
        params.push({ name: s.duration, type: 'integer', required: false, description: 'Thời lượng (giây)', default: first.dur ? Number(first.dur) : undefined, options: durs.map((d) => ({ value: d, label: `${d} giây` })), combinations });
      }
      if (s.resolution) {
        const ress = uniq(parsed.map((p) => p.res));
        params.push({ name: s.resolution, type: 'enum', required: false, description: 'Độ phân giải', default: first.res || undefined, options: ress.map((r) => ({ value: r, label: r })), combinations });
      }
      continue;
    }
    if (s.kind !== 'plain') continue;
    const f = s.field;
    const p: ApiParam = {
      name: s.name,
      type:
        f.type === 'select'
          ? 'enum'
          : f.type === 'number'
            ? Number.isInteger(f.step ?? 1) && Number.isInteger(f.min ?? 0)
              ? 'integer'
              : 'number'
            : f.type === 'boolean'
              ? 'boolean'
              : FILE_TYPES.has(f.type)
                ? 'file_url'
                : 'string',
      required: !!f.required,
      description: [f.label, f.help].filter(Boolean).join(' — '),
    };
    if (FILE_TYPES.has(f.type)) p.file_type = f.type;
    if (f.default !== undefined && f.default !== '') p.default = f.default;
    if (f.options?.length) p.options = f.options.map(opt);
    if (f.optionsBy) {
      p.options_by = { param: nameOf(list, f.optionsBy.field), map: Object.fromEntries(Object.entries(f.optionsBy.map).map(([k, v]) => [k, v.map(opt)])) };
    }
    // text / textarea: chỉ gắn max khi công cụ có giới hạn thực từ nguồn (bỏ trống = không giới hạn ký tự)
    if (f.type === 'text' || f.type === 'textarea') {
      if (f.max !== undefined && f.max > 0) p.max = f.max;
      else if (f.type === 'text') p.max = 2000;
    } else {
      if (f.min !== undefined) p.min = f.min;
      if (f.max !== undefined) p.max = f.max;
    }
    if (f.multiple) p.multiple = true;
    if (f.maxFiles) p.max_files = f.maxFiles;
    if (f.showIf) p.only_if = { param: nameOf(list, f.showIf.field), in: f.showIf.in };
    params.push(p);
  }
  return params;
}

/**
 * Body khách gửi (tên chuẩn) -> input nội bộ của công cụ. Vẫn nhận tên nội bộ cũ (vd `aspectRatio`, `option`) để khách
 * đã quen form web không bị lỗi; tham số lạ thì báo lại để khách biết gõ sai tên. Kiểm tra chi tiết giá trị do validateInput làm.
 */
export function toInternalInput(fields: AiFieldDef[], body: Record<string, unknown>): { input: AiInput; unknown: string[] } {
  const input: AiInput = {};
  const known = new Set<string>();
  for (const s of specs(fields)) {
    const f = s.field;
    known.add(f.name);
    if (s.kind === 'fixed') {
      if (s.value !== undefined) input[f.name] = s.value;
      continue;
    }
    if (s.kind === 'skip') continue;
    if (s.kind === 'plain') {
      known.add(s.name);
      if (body[s.name] !== undefined) input[f.name] = body[s.name];
      else if (body[f.name] !== undefined) input[f.name] = body[f.name];
      // ô nhiều file vốn là các ô một file (vd Minimax H3: image_url + image2_url -> image_urls): vẫn nhận tên cũ, ghép theo thứ tự
      if (f.multiple && FILE_TYPES.has(f.type) && s.name.endsWith('_urls')) {
        const stem = s.name.slice(0, -5);
        const taken = new Set(specs(fields).flatMap((x) => (x.kind === 'plain' ? [x.name] : [])));
        const legacy: unknown[] = [];
        for (let n = 1; n <= (f.maxFiles ?? 8); n++) {
          const k = `${stem}${n === 1 ? '' : n}_url`;
          if (taken.has(k)) continue;
          known.add(k);
          const v = body[k];
          if (v !== undefined && v !== null && v !== '') legacy.push(...(Array.isArray(v) ? v : [v]));
        }
        if (legacy.length) {
          const cur = input[f.name];
          input[f.name] = [...legacy, ...(cur === undefined || cur === null || cur === '' ? [] : Array.isArray(cur) ? cur : [cur])];
        }
      }
      continue;
    }
    // ô gộp: ghép duration + resolution thành giá trị nội bộ (vd 10 + "720p" -> "10|720p")
    if (s.duration) known.add(s.duration);
    if (s.resolution) known.add(s.resolution);
    const empty = (v: unknown) => v === undefined || v === null || v === '';
    const dur = s.duration && !empty(body[s.duration]) ? String(body[s.duration]) : null;
    const res = s.resolution && !empty(body[s.resolution]) ? String(body[s.resolution]).toLowerCase() : null;
    if (dur === null && res === null) {
      if (body[f.name] !== undefined) input[f.name] = body[f.name];
      continue;
    }
    const hit = s.options.find((o) => {
      const p = parseCombo(o.value);
      return (dur === null || p.dur === dur) && (res === null || p.res.toLowerCase() === res);
    });
    if (!hit) {
      const asked = [dur !== null && `${s.duration}=${dur}`, res !== null && `${s.resolution}=${res}`].filter(Boolean).join(', ');
      throw new BadRequestException(`Không có lựa chọn ${asked}. Các tổ hợp hợp lệ: ${s.options.map((o) => o.label).join('; ')}`);
    }
    input[f.name] = hit.value;
  }
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  return { input, unknown };
}

/** Các ô file khách điền được (để tải URL ngoài về máy chủ trước khi kiểm tra) */
export const fileFields = (fields: AiFieldDef[]) => fields.filter((f) => !f.hidden && FILE_TYPES.has(f.type));
