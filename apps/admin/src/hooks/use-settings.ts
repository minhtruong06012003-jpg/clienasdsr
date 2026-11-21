'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Đọc một nhóm cài đặt (cần quyền settings.manage). */
export function useSettingGroup<T = Record<string, any>>(group: string, enabled = true) {
  return useQuery({ queryKey: ['settings', group], queryFn: () => api.get<T>(`/admin/settings/${group}`), enabled });
}
