'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useQuery } from '@tanstack/react-query';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { ClipboardPaste, Search } from 'lucide-react';
import { BLOCK_CATEGORIES, getBlocks, type BlockDefinition } from '@cmsnt/blocks';
import type { StorefrontStatusView } from '@cmsnt/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { readClipboard } from './clipboard';
import { useBuilder } from './store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { isDataBlock, isTemplateBlock, useBuilderEnv } from './builder-context';

const UNSUPPORTED_HINT = 'Frontend của website chưa hỗ trợ block này (cần cập nhật frontend)';

/**
 * Tập block frontend riêng render được (từ `/api/capabilities` của frontend,
 * API chuyển tiếp). Null khi không có frontend hoặc frontend không trả lời — lúc đó
 * không đánh dấu gì để tránh cảnh báo sai.
 */
function useStorefrontBlocks(): Set<string> | null {
  const q = useQuery({
    queryKey: ['storefront-capabilities'],
    queryFn: () => api.get<StorefrontStatusView>('/admin/storefront/status'),
    staleTime: 10 * 60_000,
    retry: false,
  });
  return useMemo(() => (q.data?.reachable && q.data.capabilities ? new Set(q.data.capabilities.blocks) : null), [q.data]);
}

function LibraryItem({ def, onPick, draggable, unsupported }: { def: BlockDefinition; onPick: (type: string) => void; draggable: boolean; unsupported: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${def.type}`, data: { from: 'library', type: def.type }, disabled: !draggable });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onPick(def.type)}
      title={unsupported ? UNSUPPORTED_HINT : (def.description ?? def.label)}
      className={cn('relative flex flex-col items-center gap-1.5 rounded-lg border bg-background p-2.5 text-center text-xs transition hover:border-primary hover:bg-primary/5 hover:text-primary', isDragging && 'opacity-50')}
      {...(draggable ? { ...attributes, ...listeners } : {})}
    >
      {/* Chấm vàng: frontend chưa hỗ trợ block này — vẫn cho thêm, chỉ nhắc cần cập nhật */}
      {unsupported && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-500" />}
      <DynamicIcon name={def.icon as IconName} className="size-5" fallback={() => <span className="size-5" />} />
      <span className="line-clamp-2 leading-tight">{def.label}</span>
    </button>
  );
}

/** Thư viện block: tìm kiếm, nhóm theo danh mục, bấm để thêm hoặc kéo vào canvas */
function PasteButton() {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const sync = () => setHas(!!readClipboard());
    sync();
    window.addEventListener('cmsnt-clipboard', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('cmsnt-clipboard', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  if (!has) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-2 w-full"
      onClick={() => {
        const b = readClipboard();
        if (!b) return;
        const s = useBuilder.getState();
        const i = s.blocks.findIndex((x) => x.id === s.selectedId);
        s.insert({ ...structuredClone(b), id: crypto.randomUUID() }, i >= 0 ? i + 1 : s.blocks.length);
      }}
    >
      <ClipboardPaste /> Dán block đã sao chép
    </Button>
  );
}

export function BlockLibrary({ onPick, compact }: { onPick: (type: string) => void; compact?: boolean }) {
  const [q, setQ] = useState('');
  const supported = useStorefrontBlocks();
  const { isTemplate } = useBuilderEnv();
  const blocks = useMemo(() => {
    const term = q.trim().toLowerCase();
    return getBlocks().filter((b) => !term || b.label.toLowerCase().includes(term) || b.type.includes(term) || b.description?.toLowerCase().includes(term));
  }, [q]);
  /**
   * Nhóm hiển thị: khi soạn mẫu Theme Builder, mọi block dữ liệu động đưa lên đầu (nhóm "Dữ liệu động").
   * Ở trang thường: block chỉ dành cho mẫu (dynamic-*, query-loop, storefront-slot) dồn xuống cuối,
   * còn entry-list / term-list / breadcrumbs vẫn nằm ở danh mục gốc vì dùng được mọi nơi.
   */
  const groups = useMemo(() => {
    const inDataGroup = (b: BlockDefinition) => (isTemplate ? isDataBlock(b.type) : isTemplateBlock(b.type));
    const data = blocks.filter(inDataGroup);
    const dataGroup = data.length
      ? [{ key: '__data', label: isTemplate ? 'Dữ liệu động' : 'Dữ liệu động (dành cho mẫu Theme Builder)', items: data }]
      : [];
    const rest = BLOCK_CATEGORIES.map((cat) => ({ key: cat.key as string, label: cat.label, items: blocks.filter((b) => b.category === cat.key && !inDataGroup(b)) })).filter((g) => g.items.length);
    return isTemplate ? [...dataGroup, ...rest] : [...rest, ...dataGroup];
  }, [blocks, isTemplate]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm block..." className="h-8 pl-8" autoFocus={compact} />
        </div>
        {!compact && <PasteButton />}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {groups.map((g) => (
            <div key={g.key}>
              <div className={cn('mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', g.key === '__data' && isTemplate && 'text-primary')}>{g.label}</div>
              <div className="grid grid-cols-3 gap-2">
                {g.items.map((def) => (
                  <LibraryItem key={def.type} def={def} onPick={onPick} draggable={!compact} unsupported={!!supported && !supported.has(def.type)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
