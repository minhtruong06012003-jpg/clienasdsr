'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface DemoSettings {
  enabled?: boolean;
  message?: string;
}

/**
 * Trạng thái chế độ demo (Cài đặt › Chế độ demo, nhóm settings `demo`) — cùng cách đọc với useFeatures:
 * - Có quyền settings.manage: GET /admin/settings/demo (cùng query key với trang Cài đặt → lưu xong tự làm mới).
 * - Không có quyền: nhóm `demo` là public nên đọc từ GET /public/bootstrap.
 */
export function useDemoMode() {
  const { can, user, isDeveloper } = useAuth();
  const canSettings = !!user && can('settings.demo');
  const admin = useQuery({
    queryKey: ['settings', 'demo'],
    queryFn: () => api.get<DemoSettings>('/admin/settings/demo'),
    enabled: canSettings,
    staleTime: 60_000,
    retry: false,
  });
  const boot = useQuery({
    queryKey: ['public-bootstrap-demo'],
    queryFn: async () => (await api.get<{ settings?: { demo?: DemoSettings } }>('/public/bootstrap')).settings?.demo ?? {},
    enabled: !!user && !canSettings,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const demo = (canSettings ? admin.data : boot.data) ?? {};
  return {
    enabled: !!demo.enabled,
    message: demo.message?.trim() || 'Bạn đang xem bản demo — mọi thao tác thêm, sửa, xoá đã bị khoá.',
    /** Nhà phát triển được miễn khoá (API cũng miễn) */
    exempt: isDeveloper,
  };
}
