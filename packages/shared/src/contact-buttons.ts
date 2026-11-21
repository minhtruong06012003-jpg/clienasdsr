/**
 * Nút liên hệ nổi ở góc website khách (Cài đặt › Nút liên hệ, nhóm cài đặt public `contactButtons`).
 * Dùng chung cho admin (form cấu hình) và web (vẽ nút): danh sách kênh có sẵn, chuẩn hoá dữ liệu, tạo link từ giá trị admin nhập.
 */

/** Một kênh liên hệ admin cấu hình */
export interface ContactButtonItem {
  /** Mã kênh: mã có sẵn (zalo, telegram...) hoặc `custom-xxxx` cho kênh admin tự thêm */
  key: string;
  /** Tên hiển thị (tooltip / nhãn cạnh nút) */
  label: string;
  /** Giá trị admin nhập: link, số điện thoại, username... (web tự đổi sang link đúng theo kênh) */
  url: string;
  /** URL ảnh icon admin tải lên; trống = icon mặc định của kênh */
  icon: string;
  /** Bật/tắt riêng từng kênh */
  enabled: boolean;
}

export interface ContactButtonsSettings {
  /** Công tắc tổng: tắt = ẩn toàn bộ nút liên hệ */
  enabled: boolean;
  /** Góc màn hình đặt nút */
  position: 'left' | 'right';
  /** Mở sẵn danh sách kênh khi vào trang (tắt = chỉ hiện nút tròn, bấm mới xổ ra) */
  defaultOpen: boolean;
  items: ContactButtonItem[];
}

/** Kênh có sẵn: `icon` = tên file trong thư viện icon API (/uploads/icons/social/<icon>.svg), null = web dùng icon vẽ sẵn */
export interface ContactChannel {
  key: string;
  label: string;
  icon: string | null;
  /** Màu nền icon vẽ sẵn (kênh không có icon thư viện) */
  color: string;
  placeholder: string;
}

export const CONTACT_CHANNELS: ContactChannel[] = [
  { key: 'telegram', label: 'Telegram', icon: 'telegram', color: '#26A5E4', placeholder: 'username hoặc https://t.me/username' },
  { key: 'zalo', label: 'Zalo', icon: 'zalo', color: '#0068FF', placeholder: '0900000000 hoặc https://zalo.me/...' },
  { key: 'messenger', label: 'Messenger', icon: 'messenger', color: '#0866FF', placeholder: 'https://m.me/tentrang' },
  { key: 'facebook', label: 'Facebook', icon: 'facebook', color: '#1877F2', placeholder: 'https://facebook.com/...' },
  { key: 'phone', label: 'Gọi điện', icon: null, color: '#16A34A', placeholder: '0900 000 000' },
  { key: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp', color: '#25D366', placeholder: '+84900000000 hoặc https://wa.me/...' },
  { key: 'email', label: 'Email', icon: null, color: '#EA580C', placeholder: 'hotro@tenmien.com' },
  { key: 'tiktok', label: 'TikTok', icon: 'tiktok', color: '#000000', placeholder: 'https://tiktok.com/@...' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube', color: '#FF0000', placeholder: 'https://youtube.com/@...' },
  { key: 'discord', label: 'Discord', icon: 'discord', color: '#5865F2', placeholder: 'https://discord.gg/...' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram', color: '#E4405F', placeholder: 'https://instagram.com/...' },
];

export const findContactChannel = (key: string) => CONTACT_CHANNELS.find((c) => c.key === key);

/** URL icon mặc định của kênh (thư viện icon API); null = kênh tự thêm / kênh dùng icon vẽ sẵn */
export const contactChannelIcon = (key: string) => {
  const icon = findContactChannel(key)?.icon;
  return icon ? `/uploads/icons/social/${icon}.svg` : null;
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Chuẩn hoá cài đặt đã lưu: giữ thứ tự admin sắp xếp, bỏ phần tử hỏng / trùng mã, bù kênh có sẵn còn thiếu (tắt, để cuối).
 * Dữ liệu kiểu cũ (phone / zalo / messenger nằm thẳng trong nhóm) được chuyển vào kênh tương ứng.
 */
export function normalizeContactButtons(raw: unknown): ContactButtonsSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const items: ContactButtonItem[] = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const key = str(o.key);
    if (!key || seen.has(key) || (!findContactChannel(key) && !key.startsWith('custom-'))) continue;
    seen.add(key);
    // tên / link giữ nguyên như admin đang gõ (không trim, kẻo không gõ được dấu cách); API trim khi lưu, web trim khi tạo link
    items.push({ key, label: typeof o.label === 'string' ? o.label : findContactChannel(key)?.label || 'Liên hệ', url: typeof o.url === 'string' ? o.url : '', icon: str(o.icon), enabled: o.enabled === true });
  }
  for (const c of CONTACT_CHANNELS) {
    if (seen.has(c.key)) continue;
    const legacy = str(v[c.key]);
    items.push({ key: c.key, label: c.label, url: legacy, icon: '', enabled: !!legacy });
  }
  return { enabled: v.enabled !== false, position: v.position === 'left' ? 'left' : 'right', defaultOpen: v.defaultOpen === true, items };
}

/** Link mở khi bấm nút, đổi từ giá trị admin nhập theo kênh (số điện thoại -> tel:, username Telegram -> t.me...). Trống = không có link */
export function contactHref(key: string, value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|sms:|zalo:|tg:|viber:|skype:)/i.test(v)) return v;
  const digits = v.replace(/[^\d+]/g, '');
  switch (key) {
    case 'phone':
      return `tel:${digits}`;
    case 'email':
      return `mailto:${v}`;
    case 'zalo':
      // nhập số điện thoại -> zalo.me/<số> (đổi +84 về 0); còn lại coi là link (zalo.me/..., OA)
      return /^\+?[\d\s.-]{8,}$/.test(v) ? `https://zalo.me/${digits.replace(/^\+84/, '0')}` : `https://${v.replace(/^\/+/, '')}`;
    case 'telegram':
      return /^@?[\w]{4,}$/.test(v) ? `https://t.me/${v.replace(/^@/, '')}` : `https://${v.replace(/^\/+/, '')}`;
    case 'whatsapp':
      return /^\+?[\d\s.-]{8,}$/.test(v) ? `https://wa.me/${digits.replace(/^\+/, '')}` : `https://${v.replace(/^\/+/, '')}`;
    default:
      // thiếu giao thức (vd "facebook.com/abc") -> thêm https://
      return `https://${v.replace(/^\/+/, '')}`;
  }
}
