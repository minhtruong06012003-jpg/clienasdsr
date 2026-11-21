'use client';

import type { BlockNode } from '@cmsnt/blocks';

const KEY = 'cmsnt-block-clipboard';

/** Sao chép block để dán sang trang khác (lưu localStorage) */
export function copyBlock(block: BlockNode) {
  const { resolved: _r, ...rest } = block;
  localStorage.setItem(KEY, JSON.stringify(rest));
  window.dispatchEvent(new Event('cmsnt-clipboard'));
}

export function readClipboard(): BlockNode | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as BlockNode) : null;
  } catch {
    return null;
  }
}
