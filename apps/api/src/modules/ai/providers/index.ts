import type { AiProvider } from '../ai.types.js';
import { ahiepProvider } from './ahiep.provider.js';
import { aideepcutProvider } from './aideepcut.provider.js';
import { imgstudioProvider } from './imgstudio.provider.js';
import { kapendProvider } from './kapend.provider.js';
import { runupProvider } from './runup.provider.js';
import { tavtavvideoProvider } from './tavtavvideo.provider.js';
import { tmcProvider } from './tmc.provider.js';
import { fableProvider } from './fable.provider.js';
import { prismforgeProvider } from './prismforge.provider.js';
import { up4kProvider } from './up4k.provider.js';
import { ivoiProvider } from './ivoi.provider.js';
import { tramsangtaoProvider } from './tramsangtao.provider.js';
import { gommoProvider } from './gommo.provider.js';
import { botsdProvider } from './botsd.provider.js';
import { maivideoProvider } from './maivideo.provider.js';
import { aishop24Provider } from './aishop24.provider.js';
import { plenxaiProvider } from './plenxai.provider.js';
import { seedancebotProvider } from './seedancebot.provider.js';

/**
 * Danh sách nhà cung cấp AI đã tích hợp. Thêm nhà cung cấp mới:
 * 1. viết `<key>.provider.ts` triển khai AiProvider (khai báo tools + submit/poll);
 * 2. thêm vào mảng dưới đây;
 * 3. thêm nhóm cài đặt `ai_<key>` (settings.defaults.ts) và `apiKey` vào SECRET_FIELDS (settings.controller.ts).
 * Công cụ mới tự xuất hiện ở Admin › AI Studio › Công cụ khi API khởi động lại.
 */
export const AI_PROVIDERS: AiProvider[] = [tmcProvider, kapendProvider, aideepcutProvider, imgstudioProvider, ahiepProvider, tavtavvideoProvider, runupProvider, fableProvider, prismforgeProvider, up4kProvider, ivoiProvider, tramsangtaoProvider, gommoProvider, botsdProvider, maivideoProvider, aishop24Provider, plenxaiProvider, seedancebotProvider];

/**
 * Nhãn máy chủ (SV1..SV12+) tự động gắn cho mọi công cụ & model con của từng nguồn AI (T-316).
 * - Các nguồn hiện tại giữ cố định đúng mã SV1..SV12 theo bảng quy ước.
 * - Nguồn mới thêm vào `AI_PROVIDERS` về sau tự động được cấp tiếp SV13, SV14... mà không cần cấu hình tay.
 */
export const PROVIDER_DEFAULT_BADGES: Record<string, string> = {
  tmc: 'SV1',
  up4k: 'SV2',
  kapend: 'SV3',
  aideepcut: 'SV4',
  prismforge: 'SV5',
  ivoi: 'SV6',
  ahiep: 'SV7',
  tavtavvideo: 'SV8',
  fable: 'SV9',
  runup: 'SV10',
  imgstudio: 'SV11',
  tramsangtao: 'SV12',
  gommo: 'SV13',
  botsd: 'SV14',
  maivideo: 'SV15',
  aishop24: 'SV16',
  plenxai: 'SV17',
  seedancebot: 'SV18',
};

export function providerDefaultBadge(providerKey: string): string {
  const fixed = PROVIDER_DEFAULT_BADGES[providerKey];
  if (fixed) return fixed;
  const maxFixed = Object.values(PROVIDER_DEFAULT_BADGES).reduce((m, v) => {
    const n = Number(v.replace(/^SV/i, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 15);
  const extraKeys = AI_PROVIDERS.map((p) => p.key).filter((k) => !PROVIDER_DEFAULT_BADGES[k]);
  const idx = extraKeys.indexOf(providerKey);
  return `SV${maxFixed + 1 + (idx >= 0 ? idx : extraKeys.length)}`;
}

const LEGACY_PROVIDER_DOMAINS: Record<string, string> = {
  tavtavvideo: 'nov.ai.vn',
  yupvox: 'yupvox.com',
  vidgrab: 'dowloadvideo.io.vn',
  vimo: 'vimovideo.com',
};

/** Tên miền gọn không có http/https của nguồn AI để hiển thị nội bộ cho Admin trên Web mẹ (T-483, T-484) */
export function providerCleanDomain(providerKey: string): string {
  const p = AI_PROVIDERS.find((x) => x.key === providerKey);
  const raw = p?.website || LEGACY_PROVIDER_DOMAINS[providerKey] || '';
  if (!raw) return providerKey;
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '') || providerKey;
}

/** Nhãn hiển thị chuẩn `<domain> (SVx)` trên bộ lọc và bảng quản trị Web mẹ (T-483, T-484) */
export function providerDisplayLabel(providerKey: string): string {
  if (!providerKey) return '';
  const domain = providerCleanDomain(providerKey);
  const isActiveOrKnown = Boolean(PROVIDER_DEFAULT_BADGES[providerKey] || AI_PROVIDERS.some((x) => x.key === providerKey));
  const badge = isActiveOrKnown ? providerDefaultBadge(providerKey) : '';
  return badge ? `${domain} (${badge})` : domain;
}
