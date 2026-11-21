'use client';

/**
 * Menu website (/web-menu): sửa menu bên trái khu vực thành viên của website khách — thêm / xoá / đổi tên / đổi icon /
 * sắp xếp / ẩn mục, thêm tiêu đề nhóm và link ngoài. Lưu vào nhóm cài đặt `web_menu` (PUT /admin/settings/web_menu,
 * quyền settings.manage); API chuẩn hoá ở apps/api/src/modules/settings/web-menu.ts.
 */
import { PageBody, PageHeader } from '@/components/common/page-header';
import { PermissionGate } from '@/components/ai/shared';
import { SettingsGroup } from '@/components/settings/settings-group';
import { MenuEditor, type MenuItem } from '@/components/web-menu/menu-editor';
import { useAuth } from '@/lib/auth';

/** Menu mặc định — giữ khớp WEB_MENU_DEFAULT_ITEMS ở apps/api/src/modules/settings/web-menu.ts (dùng cho nút "Về mặc định") */
const DEFAULT_ITEMS: MenuItem[] = [
  { id: 'dashboard', type: 'link', label: 'Tổng quan', href: '/dashboard', icon: 'layout-dashboard', badge: '', newTab: false, enabled: true },
  { id: 'history', type: 'link', label: 'Lịch sử tạo', href: '/history', icon: 'history', badge: '', newTab: false, enabled: true },
  { id: 'community', type: 'link', label: 'Cộng đồng', href: '/community', icon: 'globe', badge: '', newTab: false, enabled: true },
  { id: 'ai-tools', type: 'ai_tools', label: 'Công cụ AI', href: '', icon: '', badge: '', newTab: false, enabled: true },
  { id: 'account-heading', type: 'heading', label: 'Tài khoản', href: '', icon: '', badge: '', newTab: false, enabled: true },
  { id: 'pricing', type: 'link', label: 'Nạp tiền', href: '/pricing', icon: 'credit-card', badge: '', newTab: false, enabled: true },
  { id: 'transactions', type: 'link', label: 'Lịch sử giao dịch', href: '/transactions', icon: 'receipt-text', badge: '', newTab: false, enabled: true },
  { id: 'affiliate', type: 'link', label: 'Tiếp thị liên kết', href: '/affiliate', icon: 'gift', badge: '%', newTab: false, enabled: true },
  { id: 'api-keys', type: 'link', label: 'API cho nhà phát triển', href: '/api-keys', icon: 'key-round', badge: '', newTab: false, enabled: true },
  { id: 'account', type: 'link', label: 'Cài đặt tài khoản', href: '/account', icon: 'settings', badge: '', newTab: false, enabled: true },
];

export default function WebMenuPage() {
  const { can } = useAuth();
  const restricted = !can('web_menu.manage');
  return (
    <>
      <PageHeader title="Menu website" description="Menu bên trái khu vực thành viên của website khách. Lưu xong, website cập nhật sau tối đa khoảng 1 phút." breadcrumbs={[{ label: 'AI Studio' }, { label: 'Menu website' }]} />
      <PageBody>
        <PermissionGate permission={['web_menu.manage', 'settings.general', 'settings.appearance']}>
          <SettingsGroup group="web_menu">{(v, set) => <MenuEditor v={v} set={set} defaults={DEFAULT_ITEMS} restricted={restricted} />}</SettingsGroup>
        </PermissionGate>
      </PageBody>
    </>
  );
}
