import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Mã hoá nội dung kho mã số (key, tài khoản, thẻ cào...) trước khi cất vào bảng digital_codes.
 *
 * - Thuật toán AES-256-GCM, định dạng lưu `v1:<iv hex>:<tag hex>:<ciphertext hex>`.
 * - Khoá: biến môi trường `DIGITAL_CODES_KEY` (khuyên dùng, độc lập với JWT); không có thì dẫn xuất từ
 *   `JWT_ACCESS_SECRET` — khi đó ĐỔI JWT secret sẽ làm mọi mã cũ không giải mã được (Site Health cảnh báo).
 *   `DIGITAL_CODES_KEY` dạng 64 ký tự hex được dùng trực tiếp làm khoá 32 byte, dạng khác được băm sha256.
 * - `contentHash` = HMAC-SHA256 (khoá riêng dẫn xuất từ cùng bí mật) của nội dung đã chuẩn hoá:
 *   chống nhập trùng mà không lộ nội dung qua hash (không thể dò bằng bảng băm sẵn).
 */

export interface CodeKeys {
  /** khoá AES 32 byte */
  enc: Buffer;
  /** khoá HMAC cho contentHash */
  mac: Buffer;
  /** nguồn khoá: env DIGITAL_CODES_KEY hay dẫn xuất từ JWT_ACCESS_SECRET */
  source: 'env' | 'jwt';
}

/** Dựng bộ khoá từ bí mật cấu hình. `dedicated` = DIGITAL_CODES_KEY (rỗng -> dùng `jwtSecret`) */
export function deriveCodeKeys(dedicated: string | null | undefined, jwtSecret: string): CodeKeys {
  const own = (dedicated ?? '').trim();
  if (own) {
    const enc = /^[0-9a-f]{64}$/i.test(own) ? Buffer.from(own, 'hex') : createHash('sha256').update(`cmsnt-digital-codes:${own}`).digest();
    return { enc, mac: createHash('sha256').update(`cmsnt-digital-codes-hash:${own}`).digest(), source: 'env' };
  }
  return {
    enc: createHash('sha256').update(`cmsnt-digital-codes:jwt:${jwtSecret}`).digest(),
    mac: createHash('sha256').update(`cmsnt-digital-codes-hash:jwt:${jwtSecret}`).digest(),
    source: 'jwt',
  };
}

/** Mã hoá một nội dung (mỗi lần một IV ngẫu nhiên) */
export function encryptCode(plain: string, keys: Pick<CodeKeys, 'enc'>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

/** Giải mã; trả null khi chuỗi hỏng hoặc được mã hoá bằng khoá khác (đổi khoá) */
export function decryptCode(stored: string | null | undefined, keys: Pick<CodeKeys, 'enc'>): string | null {
  if (!stored || typeof stored !== 'string') return null;
  const [v, ivHex, tagHex, dataHex] = stored.split(':');
  if (v !== 'v1' || !ivHex || !tagHex || dataHex === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** HMAC-SHA256 (hex) của nội dung ĐÃ chuẩn hoá — dùng cho contentHash và tìm kiếm khớp chính xác */
export function hashCode(normalized: string, keys: Pick<CodeKeys, 'mac'>): string {
  return createHmac('sha256', keys.mac).update(normalized, 'utf8').digest('hex');
}

/**
 * Chuẩn hoá nội dung mã trước khi băm / lưu:
 * - bỏ \r, cắt khoảng trắng đầu/cuối mỗi dòng và cả chuỗi, gộp khoảng trắng / tab liên tiếp thành 1 dấu cách
 * - cắt khoảng trắng quanh dấu "|" phân tách các phần ("user | pass" -> "user|pass")
 * - bỏ dòng trống thừa
 */
export function normalizeCode(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t ]+/g, ' ')
        .split('|')
        .map((p) => p.trim())
        .join('|')
        .trim(),
    )
    .filter((line, i, arr) => line !== '' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}
