import { BadRequestException } from '@nestjs/common';
import type { AiFieldDef, AiFieldOption, AiInput } from './ai.types.js';

const FILE_TYPES = new Set(['image', 'video', 'audio', 'file']);

/** Ô có đang hiện không (theo điều kiện showIf) */
function visible(f: AiFieldDef, input: AiInput) {
  if (!f.showIf) return true;
  return f.showIf.in.includes(String(input[f.showIf.field] ?? ''));
}

/** Danh sách lựa chọn thực tế của ô select (có thể phụ thuộc ô khác) */
export function optionsOf(f: AiFieldDef, input: AiInput): AiFieldOption[] {
  if (f.optionsBy) return f.optionsBy.map[String(input[f.optionsBy.field] ?? '')] ?? [];
  return f.options ?? [];
}

/**
 * Kiểm tra + chuẩn hoá dữ liệu khách nhập theo form của công cụ.
 * - Bỏ các khoá không khai báo; điền giá trị mặc định; ép kiểu số / boolean.
 * - File: phải là URL do chính khách tải lên (`ownsFile`), chặn dùng file của người khác / URL lạ.
 */
/** `partial` = báo giá trước khi chạy: bỏ qua ô bắt buộc còn trống (vd chưa tải ảnh) */
export function validateInput(fields: AiFieldDef[], raw: unknown, ownsFile: (url: string) => boolean, partial = false): AiInput {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: AiInput = {};
  // lượt 1: lấy giá trị thô + mặc định (để showIf / optionsBy đọc được ô cha)
  for (const f of fields) {
    const v = src[f.name];
    out[f.name] = v === undefined || v === null || v === '' ? f.default : v;
    // select bắt buộc bị bỏ trống -> lấy lựa chọn đầu tiên như website (vd ô "Máy chủ" thêm sau: khách API cũ không gửi)
    if (f.type === 'select' && f.required && (out[f.name] === undefined || out[f.name] === '')) out[f.name] = optionsOf(f, out)[0]?.value;
    // Tự nâng chế độ video (`t2v` -> `i2v` / `flf` / `ref`) khi khách chạy Tạo hàng loạt hoặc gọi API gửi kèm ảnh/video mà để nguyên mode mặc định
    if (f.name === 'mode' && f.type === 'select') {
      const opts = optionsOf(f, out);
      const cur = String(out[f.name] ?? '');
      const hasRef = ['images', 'videos', 'audios'].some((k) => (Array.isArray(src[k]) ? (src[k] as unknown[]).length > 0 : !!src[k]));
      const hasStart = !!src.image;
      const hasEnd = !!src.lastFrame;
      if ((!src.mode || cur === 't2v' || cur.endsWith(':t2v')) && (hasRef || hasStart || hasEnd)) {
        const want = hasRef ? 'ref' : hasStart && hasEnd && opts.some((o) => o.value === 'flf' || o.value.endsWith(':flf')) ? 'flf' : 'i2v';
        const hit = opts.find((o) => o.value === want || o.value.endsWith(`:${want}`));
        if (hit) out[f.name] = hit.value;
      }
    }
  }
  for (const f of fields) {
    let v = out[f.name];
    if (!visible(f, out)) {
      delete out[f.name];
      continue;
    }
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required && !partial) throw new BadRequestException(`Vui lòng nhập "${f.label}"`);
      delete out[f.name];
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'textarea': {
        v = String(v).trim();
        if (f.max !== undefined && f.max > 0) {
          if ((v as string).length > f.max) throw new BadRequestException(`"${f.label}" tối đa ${f.max.toLocaleString('vi-VN')} ký tự`);
        } else {
          // Công cụ không giới hạn ký tự từ nguồn: chỉ chặn trần kỹ thuật chống tràn bộ nhớ (1.000.000 ký tự cho textarea)
          const hardMax = f.type === 'text' ? 10_000 : 1_000_000;
          if ((v as string).length > hardMax) throw new BadRequestException(`"${f.label}" vượt quá độ dài tối đa cho phép (${hardMax.toLocaleString('vi-VN')} ký tự)`);
        }
        if (f.required && !(v as string)) throw new BadRequestException(`Vui lòng nhập "${f.label}"`);
        break;
      }
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new BadRequestException(`"${f.label}" phải là số`);
        if (f.min !== undefined && n < f.min) throw new BadRequestException(`"${f.label}" tối thiểu ${f.min}`);
        if (f.max !== undefined && n > f.max) throw new BadRequestException(`"${f.label}" tối đa ${f.max}`);
        v = n;
        break;
      }
      case 'boolean':
        v = v === true || v === 'true' || v === 1 || v === '1';
        break;
      case 'select': {
        const opts = optionsOf(f, out);
        const s = String(v);
        v = s;
        if (f.allowClonedVoices && /^uvoice_[a-f0-9]{12,40}$/i.test(s)) {
          break;
        }
        if (!opts.some((o) => o.value === s)) {
          const lower = String(v).toLowerCase();
          const ci = opts.find((o) => o.value.toLowerCase() === lower || o.value.toLowerCase().endsWith(`:${lower}`));
          // giá trị khớp không phân biệt hoa thường hoặc hậu tố chế độ (vd API gửi "2K" / "i2v") -> chuẩn hoá hợp lệ
          if (ci) v = ci.value;
          else if (opts.length && !f.required) v = opts[0].value;
          else throw new BadRequestException(`Lựa chọn "${f.label}" không hợp lệ`);
        }
        break;
      }
      default:
        if (FILE_TYPES.has(f.type)) {
          const list = (Array.isArray(v) ? v : [v]).map((x) => String(x));
          if (!f.multiple && list.length > 1) throw new BadRequestException(`"${f.label}" chỉ nhận một file`);
          if (f.maxFiles && list.length > f.maxFiles) throw new BadRequestException(`"${f.label}" tối đa ${f.maxFiles} file`);
          for (const url of list) if (!ownsFile(url)) throw new BadRequestException(`File của "${f.label}" không hợp lệ, vui lòng tải lên lại`);
          v = f.multiple ? list : list[0];
        }
    }
    out[f.name] = v;
  }
  return out;
}

/** Số ký tự của các ô văn bản (đơn vị tính giá của công cụ đọc văn bản) */
export const charCount = (input: AiInput, field = 'text') => String(input[field] ?? '').length;
