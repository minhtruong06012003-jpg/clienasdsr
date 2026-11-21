import { createHash, timingSafeEqual } from 'node:crypto';
import type { CardCallbackResult, CardInput, CardProvider, CardProviderConfig, CardResult, CardResultStatus } from '../card-provider.interface.js';

/**
 * Giao thức `chargingws/v2` — chuẩn chung của phần lớn site đổi thẻ cào ở VN (Card24h, TheSieuRe, Doithe1s, Trumthe...).
 *
 * Gửi thẻ:   {domain}/chargingws/v2?command=charging&telco&code(=mã thẻ)&serial&amount&request_id&partner_id&sign
 * Kiểm tra:  cùng tham số với command=check
 * Chữ ký:    sign = md5(partner_key + mã thẻ + serial)
 * Callback:  status, message, request_id, declared_value, value, amount, code, serial, telco, trans_id,
 *            callback_sign = md5(partner_key + mã thẻ + serial)
 * Trạng thái: 1 thẻ đúng · 2 sai mệnh giá · 3 thẻ lỗi · 4 bảo trì · 99 chờ xử lý · 100 gửi thẻ thất bại
 * (tham khảo SHOPCLONE7: libs/helper.php card24h() + api/callback_card.php)
 */

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** So sánh chữ ký chống timing attack */
function sameSign(a: string, b: string) {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown) => (v == null ? '' : String(v).trim());

/** Đổi mã trạng thái chargingws → trạng thái chuẩn */
export function mapChargingStatus(code: unknown): CardResultStatus {
  switch (Number(code)) {
    case 1:
      return 'SUCCESS';
    case 2:
      return 'WRONG_VALUE';
    case 99:
      return 'PENDING';
    default:
      return 'FAILED';
  }
}

/** Chuẩn hoá phản hồi / callback chargingws thành CardResult */
function toResult(d: Record<string, unknown>): CardResult {
  const status = mapChargingStatus(d.status);
  return {
    status,
    realValue: num(d.value) || undefined,
    providerAmount: num(d.amount),
    providerRef: str(d.trans_id) || undefined,
    message: str(d.message) || (status === 'FAILED' ? `Mã trạng thái ${str(d.status) || '?'}` : undefined),
    raw: d,
  };
}

export interface ChargingwsPreset {
  key: string;
  label: string;
  /** Tên miền API, vd https://card24h.com */
  baseUrl?: string;
  /** Cách gửi request mà nhà cung cấp chấp nhận chắc chắn */
  method?: 'GET' | 'POST';
}

/** Tạo một nhà cung cấp chuẩn chargingws/v2. Preset không có baseUrl = "tuỳ chỉnh" (admin nhập tên miền). */
export function chargingwsProvider(preset: ChargingwsPreset): CardProvider {
  const endpoint = (cfg: CardProviderConfig) => {
    const base = (preset.baseUrl ?? cfg.domain ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('Chưa cấu hình tên miền nhà cung cấp');
    return `${/^https?:\/\//i.test(base) ? base : `https://${base}`}/chargingws/v2`;
  };

  /** Gọi API chargingws (timeout 20s), trả JSON */
  async function call(cfg: CardProviderConfig, card: CardInput, command: 'charging' | 'check'): Promise<CardResult> {
    const params = new URLSearchParams({
      telco: card.telco,
      code: card.pin,
      serial: card.serial,
      amount: String(card.amount),
      request_id: card.code,
      partner_id: cfg.partnerId,
      sign: md5(cfg.partnerKey + card.pin + card.serial),
      command,
    });
    const method = preset.method ?? cfg.method ?? 'POST';
    const url = endpoint(cfg);
    const res = await fetch(method === 'GET' ? `${url}?${params.toString()}` : url, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
      body: method === 'POST' ? params.toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Phản hồi không hợp lệ (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    // một số site bọc lỗi trong data.msg
    const data = json.data as Record<string, unknown> | undefined;
    if (!json.message && data?.msg) json.message = data.msg;
    const result = toResult(json);
    // 4 = bảo trì, 100 = gửi thẻ thất bại (sai partner / tham số...) — nhà cung cấp chưa xử lý thẻ; chỉ 3 mới là thẻ lỗi
    if (command === 'charging' && [4, 100].includes(Number(json.status))) return { ...result, rejected: true };
    // khi kiểm tra: 100 = không tìm thấy giao dịch → nhà cung cấp chưa từng nhận thẻ (vd lúc gửi bị lỗi mạng)
    if (command === 'check' && Number(json.status) === 100) return { ...result, rejected: true };
    // khi kiểm tra: "bảo trì" (4) không có nghĩa thẻ lỗi — giữ chờ để lần sau hỏi lại
    if (command === 'check' && Number(json.status) === 4) return { ...result, status: 'PENDING' };
    return result;
  }

  return {
    key: preset.key,
    label: preset.label,
    website: preset.baseUrl ?? '',
    needsDomain: !preset.baseUrl,

    submit: (cfg, card) => call(cfg, card, 'charging'),
    check: (cfg, card) => call(cfg, card, 'check'),

    parseCallback(cfg, { query, body }): CardCallbackResult {
      // nhà cung cấp gửi GET (query) hoặc POST (form/JSON) — gộp cả hai
      const d: Record<string, unknown> = { ...(query ?? {}), ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) };
      const pin = str(d.code);
      const serial = str(d.serial);
      const sign = str(d.callback_sign);
      const code = str(d.request_id);
      if (!sign || !pin || !serial || !code) return { valid: false, status: 'FAILED', message: 'Thiếu tham số callback' };
      if (!sameSign(md5(cfg.partnerKey + pin + serial), sign)) return { valid: false, status: 'FAILED', message: 'Sai chữ ký callback', code };
      return { ...toResult(d), valid: true, code, pin, serial };
    },
  };
}
