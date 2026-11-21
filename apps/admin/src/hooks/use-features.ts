'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_FEATURES, readFeatures, type FeatureFlags, type FeatureKey } from '@cmsnt/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Công tắc tính năng (Cài đặt › Tính năng, nhóm settings `features`).
 * - Có quyền settings.manage: đọc GET /admin/settings/features (cùng query key với trang Cài đặt → lưu xong tự làm mới).
 * - Không có quyền: nhóm `features` là public nên đọc từ GET /public/bootstrap (settings.features).
 * Chưa tải xong / lỗi → coi như bật hết (không ẩn nhầm menu của website cũ).
 */
export function useFeatures() {
  const { can, user } = useAuth();
  const canSettings = !!user && can('settings.features');
  const admin = useQuery({
    queryKey: ['settings', 'features'],
    queryFn: () => api.get<Record<string, unknown>>('/admin/settings/features'),
    enabled: canSettings,
    staleTime: 60_000,
    retry: false,
  });
  const boot = useQuery({
    queryKey: ['public-bootstrap-features'],
    queryFn: async () => (await api.get<{ settings?: { features?: unknown } }>('/public/bootstrap')).settings?.features ?? {},
    enabled: !!user && !canSettings,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const raw = canSettings ? admin.data : boot.data;
  const features: FeatureFlags = useMemo(() => (raw ? readFeatures(raw) : DEFAULT_FEATURES), [raw]);
  /** Tính năng đang bật? (không truyền key = luôn bật) */
  const isOn = useCallback((key?: FeatureKey | null) => !key || features[key] !== false, [features]);
  return { features, isOn, isLoading: canSettings ? admin.isLoading : boot.isLoading };
}
