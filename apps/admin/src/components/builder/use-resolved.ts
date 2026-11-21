'use client';

import { useEffect, useRef, useState } from 'react';
import type { BlockNode } from '@cmsnt/blocks';
import { api } from '@/lib/api';
import { isDataBlock, type BuilderDataContext } from './builder-context';

const CORE_DYNAMIC = new Set(['product-grid', 'product-carousel', 'post-list', 'category-grid', 'form', 'global-block']);
/** Block cần API gắn `resolved`: block lõi có dữ liệu, và block động Theme Builder (dynamic-*, query-loop...) */
const isDynamic = (type: string) => CORE_DYNAMIC.has(type) || isDataBlock(type);

/**
 * Lấy dữ liệu động (sản phẩm, bài viết, form, bản ghi mẫu...) cho block trong canvas.
 * Chỉ gọi API cho block có dữ liệu thay đổi (cache theo JSON của data + ngữ cảnh mẫu).
 * `context` (Theme Builder): target + bản ghi mẫu để block động hiển thị bằng dữ liệu thật.
 */
export function useResolvedBlocks(blocks: BlockNode[], locale: string, context?: BuilderDataContext): Record<string, BlockNode['resolved']> {
  const cache = useRef(new Map<string, BlockNode['resolved']>());
  const [resolved, setResolved] = useState<Record<string, BlockNode['resolved']>>({});
  const ctxKey = context ? `${context.target}|${context.id ?? ''}` : '';

  useEffect(() => {
    const keyOf = (b: BlockNode) => `${locale}:${ctxKey}:${b.type}:${JSON.stringify(b.data)}`;
    const missing = blocks.filter((b) => isDynamic(b.type) && !cache.current.has(keyOf(b)));
    const apply = () => {
      const out: Record<string, BlockNode['resolved']> = {};
      for (const b of blocks) if (isDynamic(b.type)) out[b.id] = cache.current.get(keyOf(b));
      setResolved(out);
    };
    if (!missing.length) {
      apply();
      return;
    }
    const t = setTimeout(async () => {
      try {
        const body: Record<string, unknown> = { blocks: missing, locale };
        if (context) body.context = { target: context.target, ...(context.id ? { id: context.id } : {}) };
        const res = await api.post<BlockNode[]>('/admin/blocks/resolve', body);
        res.forEach((r, i) => {
          const src = missing[i];
          cache.current.set(keyOf(src), r.resolved ?? {});
        });
      } catch {
        missing.forEach((b) => cache.current.set(keyOf(b), {}));
      }
      apply();
    }, 500);
    return () => clearTimeout(t);
    // context đã gói trong ctxKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, locale, ctxKey]);

  return resolved;
}
