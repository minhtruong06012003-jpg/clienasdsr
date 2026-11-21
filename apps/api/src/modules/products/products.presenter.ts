import { isVirtualProduct, normalizePurchaseFields } from '@cmsnt/shared';
import { publishedCondition } from '../../common/utils/publish.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { MediaDto } from '../media/media.service.js';

export const publishedProductWhere = (): Prisma.ProductWhereInput => ({
  deletedAt: null,
  ...publishedCondition(),
});

export const PRODUCT_CARD_INCLUDE = {
  translations: { select: { locale: true, name: true, slug: true, shortDescription: true } },
  variants: { where: { isActive: true }, select: { price: true, salePrice: true, stockStatus: true } },
  brand: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ProductInclude;

type CardRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_CARD_INCLUDE }>;

/** Giá đang áp dụng: giá khuyến mãi nếu còn trong thời gian sale */
export function effectivePrice(p: { price: unknown; salePrice: unknown; saleStart?: Date | null; saleEnd?: Date | null }) {
  const price = Number(p.price);
  const sale = p.salePrice != null ? Number(p.salePrice) : null;
  const now = new Date();
  const active = sale != null && sale < price && (!p.saleStart || p.saleStart <= now) && (!p.saleEnd || p.saleEnd >= now);
  return { price, salePrice: active ? sale : null, finalPrice: active ? sale! : price };
}

export function presentProductCard(p: CardRow, locale: string, fallback: string, media: Map<string, MediaDto>) {
  const tr = p.translations.find((t) => t.locale === locale) ?? p.translations.find((t) => t.locale === fallback) ?? p.translations[0];
  let { price, salePrice, finalPrice } = effectivePrice(p);
  let maxPrice: number | null = null;
  if (p.type === 'VARIABLE' && p.variants.length) {
    const finals = p.variants.map((v) => effectivePrice({ price: v.price, salePrice: v.salePrice }).finalPrice);
    finalPrice = Math.min(...finals);
    maxPrice = Math.max(...finals);
    price = Math.min(...p.variants.map((v) => Number(v.price)));
    salePrice = finalPrice < price ? finalPrice : null;
  }
  const inStock = p.type === 'VARIABLE' ? p.variants.some((v) => v.stockStatus !== 'OUT_OF_STOCK') : p.stockStatus !== 'OUT_OF_STOCK';
  return {
    id: p.id,
    type: p.type,
    sku: p.sku,
    name: tr?.name ?? '',
    slug: tr?.slug ?? '',
    shortDescription: tr?.shortDescription ?? '',
    price,
    salePrice,
    finalPrice,
    maxPrice: maxPrice !== finalPrice ? maxPrice : null,
    discountPercent: salePrice != null && price > 0 ? Math.round((1 - salePrice / price) * 100) : 0,
    inStock,
    isFeatured: p.isFeatured,
    /** không cần giao hàng (isVirtual / DIGITAL / bán theo kho mã) — storefront hiện nhãn "Giao tự động"... */
    isVirtual: isVirtualProduct(p),
    codeDelivery: p.codeDelivery,
    /** có ô BẮT BUỘC khách phải nhập khi mua (ID game, email cần nâng cấp...) — storefront chuyển nút "Thêm vào giỏ" thành "Chọn / nhập thông tin" */
    hasPurchaseFields: normalizePurchaseFields(p.purchaseFields).some((f) => f.required),
    ratingAverage: Number(p.ratingAverage),
    ratingCount: p.ratingCount,
    soldCount: p.soldCount,
    brand: p.brand,
    image: media.get(p.featuredImageId ?? '') ?? null,
    hoverImage: media.get(p.galleryIds[0] ?? '') ?? null,
  };
}
