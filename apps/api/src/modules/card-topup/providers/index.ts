import type { CardProvider } from '../card-provider.interface.js';
import { chargingwsProvider } from './chargingws.provider.js';

/**
 * Danh sách nhà cung cấp đổi thẻ có sẵn. Admin chọn MỘT nhà cung cấp trong Cài đặt › Cổng thanh toán › Nạp thẻ cào.
 * - Site dùng chuẩn chargingws/v2: thêm một dòng `chargingwsProvider({ key, label, baseUrl })`.
 * - Site giao thức riêng: viết file provider triển khai `CardProvider` rồi thêm vào mảng.
 * Đồng bộ danh sách hiển thị ở admin: `apps/admin/src/components/settings/card-topup-gateway.tsx` lấy từ API
 * `/admin/card-topup/providers` nên không cần sửa thêm.
 */
export const CARD_PROVIDERS: CardProvider[] = [
  // Card24h: đã dùng thực tế trong SHOPCLONE7 (gửi GET)
  chargingwsProvider({ key: 'card24h', label: 'Card24h', baseUrl: 'https://card24h.com', method: 'GET' }),
  chargingwsProvider({ key: 'thesieure', label: 'TheSieuRe', baseUrl: 'https://thesieure.com' }),
  chargingwsProvider({ key: 'doithe1s', label: 'Doithe1s', baseUrl: 'https://doithe1s.vn' }),
  chargingwsProvider({ key: 'trumthe', label: 'Trumthe', baseUrl: 'https://trumthe.vn' }),
  chargingwsProvider({ key: 'gachthe1s', label: 'Gachthe1s', baseUrl: 'https://gachthe1s.com' }),
  // Bất kỳ site nào khác theo chuẩn chargingws/v2: admin tự nhập tên miền + cách gửi
  chargingwsProvider({ key: 'chargingws', label: 'Site khác (chuẩn chargingws/v2)' }),
];

export const findCardProvider = (key: string | undefined) => CARD_PROVIDERS.find((p) => p.key === key);
