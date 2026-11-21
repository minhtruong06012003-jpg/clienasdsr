'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * RichTextEditor (TipTap + các extension, khá nặng) nạp động, không render phía server.
 * Dùng ở nơi trình soạn thảo chỉ thỉnh thoảng xuất hiện (trường tuỳ chỉnh, ô thuộc tính block trong page builder)
 * để bundle của trang không phải tải sẵn TipTap. Trong lúc tải hiện khung xương cao bằng vùng soạn thảo.
 */
export const LazyRichTextEditor = dynamic(() => import('./rich-text-editor').then((m) => m.RichTextEditor), {
  ssr: false,
  loading: () => <Skeleton className="h-40 w-full rounded-lg" />,
});
