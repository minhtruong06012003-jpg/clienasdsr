'use client';

import { createContext, useContext } from 'react';

/**
 * Ngữ cảnh dữ liệu mẫu khi soạn mẫu Theme Builder: đối tượng áp dụng (target) + bản ghi mẫu (id).
 * Canvas gửi kèm khi gọi POST /admin/blocks/resolve để block động (dynamic-title, query-loop...)
 * hiển thị bằng dữ liệu thật. Trang thường (Page Builder, global block) không có ngữ cảnh này.
 */
export interface BuilderDataContext {
  /** vd "post", "entry:project", "term:linh_vuc", "*" */
  target: string;
  /** id bản ghi mẫu; không có -> API lấy bản ghi mới nhất của target */
  id?: string;
}

export interface BuilderEnv {
  /** đang soạn mẫu Theme Builder (thư viện block đưa nhóm "Dữ liệu động" lên đầu) */
  isTemplate: boolean;
  /** dữ liệu mẫu cho block động */
  context?: BuilderDataContext;
}

const BuilderEnvCtx = createContext<BuilderEnv>({ isTemplate: false });

export const BuilderEnvProvider = BuilderEnvCtx.Provider;

/** Đọc môi trường soạn thảo hiện tại của builder */
export function useBuilderEnv() {
  return useContext(BuilderEnvCtx);
}

/**
 * Block cần dữ liệu từ ngữ cảnh mẫu (bản ghi / danh sách đang xem) — chỉ có ý nghĩa đầy đủ trong Theme Builder.
 * Mọi block có tiền tố "dynamic-" cũng được coi là block động.
 */
export const TEMPLATE_DYNAMIC_TYPES = new Set(['query-loop', 'storefront-slot']);

/** Block động dùng được ở mọi nơi (trang thường lẫn mẫu) */
export const SHARED_DYNAMIC_TYPES = new Set(['breadcrumbs', 'term-list', 'entry-list']);

/** Block chỉ dành cho mẫu Theme Builder (lấy dữ liệu của bản ghi đang xem) */
export function isTemplateBlock(type: string) {
  return type.startsWith('dynamic-') || TEMPLATE_DYNAMIC_TYPES.has(type);
}

/** Block thuộc nhóm "Dữ liệu động" của thư viện */
export function isDataBlock(type: string) {
  return isTemplateBlock(type) || SHARED_DYNAMIC_TYPES.has(type);
}
