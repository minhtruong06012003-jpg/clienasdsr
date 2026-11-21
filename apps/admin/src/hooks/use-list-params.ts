'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Trạng thái danh sách (page, limit, search, status, sort...) lưu trên URL
 * để F5 / quay lại không mất bộ lọc.
 * Cập nhật state đồng bộ 0ms + `history.replaceState` thay vì chờ Next.js App Router RSC roundtrip (`T-286`).
 */
export function useListParams<T extends Record<string, string>>(defaults: T & { page?: string; limit?: string }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const spString = sp.toString();
  const [queryStr, setQueryStr] = useState(spString);
  const queryRef = useRef(queryStr);
  queryRef.current = queryStr;

  useEffect(() => {
    setQueryStr(spString);
  }, [spString]);

  useEffect(() => {
    const onPopState = () => {
      setQueryStr(window.location.search.replace(/^\?/, ''));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const params = useMemo(() => {
    const out: Record<string, string> = { page: '1', limit: '20', ...defaults };
    const parsed = new URLSearchParams(queryStr);
    parsed.forEach((v, k) => (out[k] = v));
    return out as T & { page: string; limit: string };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryStr]);

  const set = useCallback(
    (patch: Partial<Record<string, string | number | undefined>>) => {
      const next = new URLSearchParams(queryRef.current);
      // đổi bộ lọc -> về trang 1
      if (!('page' in patch)) next.delete('page');
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '' || v === (defaults as Record<string, unknown>)[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const s = next.toString();
      queryRef.current = s;
      setQueryStr(s);
      if (typeof window !== 'undefined') {
        // Giữ nguyên `window.location.pathname` (bao gồm cả `basePath: '/admin'`) thay vì `usePathname()` đã bị cắt `/admin` (`T-330`)
        const browserPath = window.location.pathname;
        const nextUrl = s ? `${browserPath}?${s}` : browserPath;
        window.history.replaceState(window.history.state, '', nextUrl);
      }
    },
    [pathname, defaults],
  );

  return { params, set, page: Number(params.page) || 1, limit: Number(params.limit) || 20 };
}
