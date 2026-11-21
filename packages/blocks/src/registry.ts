import type { BlockDefinition, BlockCategory } from './types';
import { cta, faq, features, heading, imageText, logos, richText, stats, testimonials } from './blocks/content';
import { bannerGrid, gallery, hero, image, map, slider, video } from './blocks/media';
import { categoryGrid, postList, productCarousel, productGrid } from './blocks/commerce';
import { columns, globalBlock, html, spacer } from './blocks/advanced';
import { customFields } from './custom-fields';
import { breadcrumbs, dynamicContent, dynamicField, dynamicImage, dynamicMeta, dynamicTitle, entryList, queryLoop, storefrontSlot, termList } from './blocks/dynamic';

const registry = new Map<string, BlockDefinition<any>>();

/**
 * Đăng ký block. Dự án khách hàng có thể thêm block riêng:
 *   registerBlock({ type: 'my-block', label: '...', fields: [...], defaults: {...}, component: MyBlock })
 * (gọi trong file được import bởi cả admin và web, vd packages/blocks/src/custom/index.ts)
 */
export function registerBlock(def: BlockDefinition<any>) {
  registry.set(def.type, def);
}

export function getBlock(type: string) {
  return registry.get(type);
}

export function getBlocks() {
  return [...registry.values()];
}

export const BLOCK_CATEGORIES: { key: BlockCategory; label: string }[] = [
  { key: 'media', label: 'Banner & Media' },
  { key: 'content', label: 'Nội dung' },
  { key: 'commerce', label: 'Bán hàng' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'layout', label: 'Bố cục' },
  { key: 'advanced', label: 'Nâng cao' },
];

[
  hero,
  slider,
  heading,
  richText,
  imageText,
  image,
  gallery,
  video,
  bannerGrid,
  features,
  stats,
  testimonials,
  cta,
  logos,
  faq,
  productGrid,
  productCarousel,
  categoryGrid,
  postList,
  map,
  columns,
  spacer,
  html,
  globalBlock,
  customFields,
  // dữ liệu động (Theme Builder + loại nội dung tuỳ biến)
  entryList,
  termList,
  breadcrumbs,
  queryLoop,
  dynamicTitle,
  dynamicContent,
  dynamicMeta,
  dynamicImage,
  dynamicField,
  storefrontSlot,
].forEach(registerBlock);
