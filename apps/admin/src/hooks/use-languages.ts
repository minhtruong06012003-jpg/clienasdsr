'use client';

import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/lib/api';
import type { Language } from '@/lib/types';

/** Danh sách ngôn ngữ (đang bật) + ngôn ngữ mặc định */
export function useLanguages() {
  const q = useQuery({ queryKey: ['languages'], queryFn: () => api.get<Language[]>('/admin/languages'), staleTime: 5 * 60_000 });
  const all = q.data ?? [];
  const languages = all.filter((l) => l.enabled);
  const defaultLocale = all.find((l) => l.isDefault)?.code ?? languages[0]?.code ?? 'vi';
  return { languages, all, defaultLocale, isLoading: q.isLoading };
}

/** Ngôn ngữ đang hiển thị ở các trang danh sách (ghi nhớ trong localStorage) */
export const useContentLocale = create<{ locale: string | null; setLocale: (l: string) => void }>()(
  persist((set) => ({ locale: null, setLocale: (locale) => set({ locale }) }), { name: 'cmsnt-content-locale' }),
);

export function useListLocale() {
  const { defaultLocale, languages } = useLanguages();
  const stored = useContentLocale((s) => s.locale);
  const setLocale = useContentLocale((s) => s.setLocale);
  const locale = stored && languages.some((l) => l.code === stored) ? stored : defaultLocale;
  return { locale, setLocale, languages, defaultLocale };
}
