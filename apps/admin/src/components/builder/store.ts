'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { getBlock, setPath, type BlockNode, type BlockSettings } from '@cmsnt/blocks';

export type Device = 'desktop' | 'tablet' | 'mobile';

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** Tạo block mới từ định nghĩa (deep copy defaults) */
export function createBlock(type: string): BlockNode {
  const def = getBlock(type);
  return { id: uid(), type, data: structuredClone(def?.defaults ?? {}), settings: structuredClone(def?.defaultSettings ?? {}) };
}

function cloneWithNewIds(b: BlockNode): BlockNode {
  const { resolved: _r, ...rest } = b;
  return { ...structuredClone(rest), id: uid() };
}

interface BuilderState {
  blocks: BlockNode[];
  selectedId: string | null;
  hoveredId: string | null;
  device: Device;
  /** tăng mỗi lần thay đổi -> phát hiện chưa lưu */
  version: number;
  past: BlockNode[][];
  future: BlockNode[][];
  lastKey: string | null;
  lastAt: number;

  load: (blocks: BlockNode[]) => void;
  /** Xoá sạch trạng thái editor (khi rời editor) để editor khác không bị báo "chưa lưu" sai */
  reset: () => void;
  setDevice: (d: Device) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  add: (type: string, index?: number) => string;
  insert: (block: BlockNode, index?: number) => void;
  updateData: (id: string, path: string, value: unknown) => void;
  updateSettings: (id: string, patch: Partial<BlockSettings>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  move: (from: number, to: number) => void;
  replaceAll: (blocks: BlockNode[]) => void;
  undo: () => void;
  redo: () => void;
}

const HISTORY_LIMIT = 100;

/**
 * Trạng thái Page Builder. Thay đổi liên tiếp trên cùng 1 trường trong 800ms được gộp
 * thành 1 bước undo (tránh mỗi phím gõ là 1 bước).
 */
export const useBuilder = create<BuilderState>((set, get) => {
  const commit = (blocks: BlockNode[], key: string | null = null) => {
    const s = get();
    const now = Date.now();
    const merge = key && key === s.lastKey && now - s.lastAt < 800;
    set({
      blocks,
      past: merge ? s.past : [...s.past, s.blocks].slice(-HISTORY_LIMIT),
      future: [],
      version: s.version + 1,
      lastKey: key,
      lastAt: now,
    });
  };

  return {
    blocks: [],
    selectedId: null,
    hoveredId: null,
    device: 'desktop',
    version: 0,
    past: [],
    future: [],
    lastKey: null,
    lastAt: 0,

    load: (blocks) => set({ blocks: Array.isArray(blocks) ? blocks : [], selectedId: null, past: [], future: [], version: 0, lastKey: null }),
    reset: () => set({ blocks: [], selectedId: null, hoveredId: null, past: [], future: [], version: 0, lastKey: null, lastAt: 0 }),
    setDevice: (device) => set({ device }),
    select: (selectedId) => set({ selectedId }),
    hover: (hoveredId) => set({ hoveredId }),

    add: (type, index) => {
      const block = createBlock(type);
      get().insert(block, index);
      return block.id;
    },

    insert: (block, index) => {
      const blocks = [...get().blocks];
      blocks.splice(index ?? blocks.length, 0, block);
      commit(blocks);
      set({ selectedId: block.id });
    },

    updateData: (id, path, value) => {
      commit(
        get().blocks.map((b) => (b.id === id ? { ...b, data: setPath(b.data ?? {}, path, value) } : b)),
        `${id}:${path}`,
      );
    },

    updateSettings: (id, patch) => {
      commit(
        get().blocks.map((b) => (b.id === id ? { ...b, settings: { ...(b.settings ?? {}), ...patch } } : b)),
        `${id}:settings:${Object.keys(patch).join(',')}`,
      );
    },

    remove: (id) => {
      const s = get();
      commit(s.blocks.filter((b) => b.id !== id));
      if (s.selectedId === id) set({ selectedId: null });
    },

    duplicate: (id) => {
      const blocks = [...get().blocks];
      const i = blocks.findIndex((b) => b.id === id);
      if (i < 0) return;
      const copy = cloneWithNewIds(blocks[i]);
      blocks.splice(i + 1, 0, copy);
      commit(blocks);
      set({ selectedId: copy.id });
    },

    move: (from, to) => {
      const blocks = [...get().blocks];
      if (to < 0 || to >= blocks.length || from === to) return;
      const [item] = blocks.splice(from, 1);
      blocks.splice(to, 0, item);
      commit(blocks);
    },

    replaceAll: (blocks) => commit(blocks),

    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({ blocks: prev, past: s.past.slice(0, -1), future: [s.blocks, ...s.future], version: s.version + 1, lastKey: null });
    },

    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ blocks: next, past: [...s.past, s.blocks], future: s.future.slice(1), version: s.version + 1, lastKey: null });
    },
  };
});

/** Store là toàn cục: gọi trong trang editor để reset khi rời trang (unmount) */
export function useBuilderSession() {
  useEffect(() => () => useBuilder.getState().reset(), []);
}

/** Trích text từ block để phân tích SEO */
export function blocksToText(blocks: BlockNode[]): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (!/^(https?:|\/|#)/.test(v) && !/^[0-9a-f-]{36}$/.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => k !== 'url' && k !== 'id' && walk(x));
  };
  blocks.forEach((b) => walk(b.data));
  return out.join(' ');
}
