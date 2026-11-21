/**
 * Menu bên trái của website khách (khu vực thành viên — apps/web/src/components/member/member-shell.tsx).
 * Lưu trong nhóm cài đặt `web_menu` ({ items: WebMenuItem[] }), admin sửa ở trang Menu website (/web-menu).
 * Thứ tự trong `items` = thứ tự hiển thị. Ba loại mục:
 * - `link`: một dòng menu (tên, đường dẫn, icon, nhãn nhỏ, mở tab mới);
 * - `heading`: tiêu đề phân nhóm (menu thu gọn thì thành đường kẻ);
 * - `ai_tools`: khối "Công cụ AI" (tiêu đề + các nhóm công cụ quản lý ở AI Studio › Công cụ AI). Chỉ có đúng một khối.
 */
export type WebMenuItemType = 'link' | 'heading' | 'ai_tools';

export interface WebMenuItem {
  id: string;
  type: WebMenuItemType;
  label: string;
  href: string;
  icon: string;
  badge: string;
  newTab: boolean;
  enabled: boolean;
}

/** Menu mặc định = đúng menu đang viết cứng trước đây */
export const WEB_MENU_DEFAULT_ITEMS: WebMenuItem[] = [
  { id: 'dashboard', type: 'link', label: 'Bảng điều khiển', href: '/dashboard', icon: 'layout-dashboard', badge: '', newTab: false, enabled: true },
  { id: 'history', type: 'link', label: 'Lịch sử tạo', href: '/history', icon: 'history', badge: '', newTab: false, enabled: true },
  { id: 'community', type: 'link', label: 'Cộng đồng', href: '/community', icon: 'globe', badge: '', newTab: false, enabled: true },
  { id: 'support', type: 'link', label: 'Ticket hỗ trợ', href: '/support', icon: 'ticket', badge: '24/7', newTab: false, enabled: true },
  { id: 'ai-tools', type: 'ai_tools', label: 'Công cụ AI', href: '', icon: '', badge: '', newTab: false, enabled: true },
  { id: 'account-heading', type: 'heading', label: 'Tài khoản', href: '', icon: '', badge: '', newTab: false, enabled: true },
  { id: 'pricing', type: 'link', label: 'Nạp tiền', href: '/pricing', icon: 'credit-card', badge: '', newTab: false, enabled: true },
  { id: 'transactions', type: 'link', label: 'Lịch sử giao dịch', href: '/transactions', icon: 'receipt-text', badge: '', newTab: false, enabled: true },
  { id: 'affiliate', type: 'link', label: 'Tiếp thị liên kết', href: '/affiliate', icon: 'gift', badge: '%', newTab: false, enabled: true },
  { id: 'api-keys', type: 'link', label: 'API cho nhà phát triển', href: '/api-keys', icon: 'key-round', badge: '', newTab: false, enabled: true },
  { id: 'account', type: 'link', label: 'Cài đặt tài khoản', href: '/account', icon: 'settings', badge: '', newTab: false, enabled: true },
];

const TYPES: WebMenuItemType[] = ['link', 'heading', 'ai_tools'];
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** 2 mục liên kết cộng đồng (Telegram & Nhóm Facebook) mà Cộng tác viên (CTV) được phép tự sửa trên /admin/web-menu */
export const CTV_EDITABLE_MENU_IDS = new Set(['4g0eq2pg', 'fwqk2cbf', '6stz8x1x']);

export function isCtvEditableMenuItem(item: Pick<WebMenuItem, 'id' | 'type' | 'href'>): boolean {
  return CTV_EDITABLE_MENU_IDS.has(item.id) || (item.type === 'link' && /^https?:\/\//i.test(item.href));
}

export const CTV_DEFAULT_COMMUNITY_ITEMS: WebMenuItem[] = [
  { id: 'gvqqls7g', type: 'heading', label: 'Liên hệ', href: '', icon: '', badge: '', newTab: false, enabled: true },
  { id: '4g0eq2pg', type: 'link', label: 'Telegram', href: 'https://t.me/', icon: 'link', badge: '', newTab: true, enabled: true },
  { id: 'fwqk2cbf', type: 'link', label: 'Cộng đồng Video AI trên FB', href: 'https://www.facebook.com/', icon: 'link', badge: '', newTab: true, enabled: true },
];

/**
 * Dành cho tài khoản Cộng tác viên (không có quyền `web_menu.manage`):
 * Giữ nguyên 100% thứ tự và cấu hình các mục hệ thống hiện có; chỉ cho phép cập nhật nội dung của đúng 2 mục liên kết cộng đồng.
 */
export function mergeRestrictedWebMenu(existingRaw: Record<string, unknown>, incomingRaw: Record<string, unknown>): { items: WebMenuItem[] } {
  const base = normalizeWebMenu(Array.isArray(existingRaw?.items) && existingRaw.items.length ? existingRaw : { items: WEB_MENU_DEFAULT_ITEMS });
  // Nếu DB web con thiếu tiêu đề Liên hệ hoặc chưa đủ 2 mục liên kết cộng đồng thì tự bổ sung vào cuối để CTV luôn có đủ 2 mục sửa được
  if (!base.items.some((x) => x.id === 'gvqqls7g')) {
    base.items.push({ ...CTV_DEFAULT_COMMUNITY_ITEMS[0] });
  }
  if (!base.items.some((x) => x.id === '4g0eq2pg')) {
    base.items.push({ ...CTV_DEFAULT_COMMUNITY_ITEMS[1] });
  }
  const editableCount = base.items.filter(isCtvEditableMenuItem).length;
  if (editableCount < 2 && !base.items.some((x) => x.id === 'fwqk2cbf')) {
    base.items.push({ ...CTV_DEFAULT_COMMUNITY_ITEMS[2] });
  }
  const editableIds = new Set(base.items.filter(isCtvEditableMenuItem).map((x) => x.id));
  const incomingList = Array.isArray(incomingRaw?.items) ? (incomingRaw.items as Record<string, unknown>[]) : [];
  const incomingById = new Map<string, Record<string, unknown>>();
  for (const r of incomingList) {
    if (r && typeof r === 'object' && typeof r.id === 'string' && editableIds.has(r.id)) {
      incomingById.set(r.id, r);
    }
  }
  const items = base.items.map((cur) => {
    if (!editableIds.has(cur.id)) return cur;
    const patch = incomingById.get(cur.id);
    if (!patch) return cur;
    const rawHref = str(patch.href, 500);
    // Chỉ nhận link ngoài http(s):// hợp lệ (nếu nhập sai giữ nguyên link cũ)
    const href = /^https?:\/\/[^\s]+$/i.test(rawHref) ? rawHref : cur.href;
    return {
      ...cur,
      label: str(patch.label, 60) || cur.label,
      href,
      icon: str(patch.icon, 40) || cur.icon,
      badge: str(patch.badge, 12),
      newTab: patch.newTab === true,
      enabled: patch.enabled !== false,
    };
  });
  return { items };
}
export function safeMenuHref(raw: unknown): string {
  const href = str(raw, 500);
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  return '';
}

/**
 * Chuẩn hoá trước khi lưu: chỉ nhận đúng các trường, cắt độ dài, bỏ link thiếu đường dẫn hợp lệ,
 * id trùng thì đánh lại, luôn giữ đúng một khối `ai_tools` (mất thì thêm lại ở vị trí mặc định).
 */
export function normalizeWebMenu(value: Record<string, unknown>): { items: WebMenuItem[] } {
  const raw = Array.isArray(value.items) ? value.items.slice(0, 60) : [];
  const seen = new Set<string>();
  const items: WebMenuItem[] = [];
  let hasAi = false;
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const type = TYPES.includes(r.type as WebMenuItemType) ? (r.type as WebMenuItemType) : 'link';
    if (type === 'ai_tools') {
      if (hasAi) continue;
      hasAi = true;
    }
    const href = type === 'link' ? safeMenuHref(r.href) : '';
    if (type === 'link' && !href) continue;
    let id = str(r.id, 40).replace(/[^a-zA-Z0-9_-]/g, '') || Math.random().toString(36).slice(2, 10);
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    seen.add(id);
    items.push({
      id,
      type,
      label: str(r.label, 60) || (type === 'ai_tools' ? 'Công cụ AI' : type === 'heading' ? '' : href),
      href,
      icon: type === 'link' ? str(r.icon, 40) : '',
      badge: type === 'link' ? str(r.badge, 12) : '',
      newTab: type === 'link' && r.newTab === true,
      enabled: r.enabled !== false,
    });
  }
  // khối Công cụ AI là bắt buộc (chỉ ẩn được, không xoá) -> thiếu thì chèn lại trước tiêu đề đầu tiên / cuối danh sách
  if (!hasAi) {
    const at = items.findIndex((i) => i.type === 'heading');
    items.splice(at < 0 ? items.length : at, 0, { ...WEB_MENU_DEFAULT_ITEMS.find((i) => i.type === 'ai_tools')! });
  }
  return { items };
}
