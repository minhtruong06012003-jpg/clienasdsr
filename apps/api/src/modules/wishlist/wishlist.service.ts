import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { PRODUCT_CARD_INCLUDE, presentProductCard, publishedProductWhere } from '../products/products.presenter.js';

/** Giới hạn số sản phẩm yêu thích mỗi tài khoản (tránh lạm dụng) */
const MAX_ITEMS = 200;

/**
 * Danh sách yêu thích của thành viên (bảng wishlist_items, khoá userId + productId).
 * Khách chưa đăng nhập lưu ở localStorage trình duyệt; khi đăng nhập storefront gộp lên đây qua `add({ productIds })`.
 */
@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
  ) {}

  /** Mã sản phẩm yêu thích (mới nhất trước) */
  async ids(userId: string): Promise<string[]> {
    const rows = await this.prisma.wishlistItem.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { productId: true } });
    return rows.map((r) => r.productId);
  }

  /** Danh sách + thẻ sản phẩm đang bán (sản phẩm đã ẩn/xoá vẫn giữ id nhưng không trả thẻ) */
  async list(userId: string, localeInput?: string) {
    const ids = await this.ids(userId);
    if (!ids.length) return { ids, data: [] };
    const [locale, fallback] = await Promise.all([this.languages.resolve(localeInput), this.languages.defaultLocale()]);
    const rows = await this.prisma.product.findMany({ where: { id: { in: ids }, ...publishedProductWhere() }, include: PRODUCT_CARD_INCLUDE });
    const media = await this.media.findMany(rows.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]));
    const order = new Map(ids.map((id, i) => [id, i]));
    const data = rows.map((r) => presentProductCard(r, locale, fallback, media)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { ids, data };
  }

  /** Thêm 1 hoặc nhiều sản phẩm (bỏ qua id không tồn tại / đã có) */
  async add(userId: string, productIds: string[], locale?: string) {
    const wanted = [...new Set(productIds)];
    if (!wanted.length) throw new BadRequestException('Thiếu sản phẩm');
    const existing = await this.ids(userId);
    const fresh = wanted.filter((id) => !existing.includes(id));
    if (existing.length + fresh.length > MAX_ITEMS) throw new BadRequestException(`Danh sách yêu thích tối đa ${MAX_ITEMS} sản phẩm`);
    if (fresh.length) {
      const valid = await this.prisma.product.findMany({ where: { id: { in: fresh }, deletedAt: null }, select: { id: true } });
      if (valid.length) await this.prisma.wishlistItem.createMany({ data: valid.map((p) => ({ userId, productId: p.id })), skipDuplicates: true });
    }
    return this.list(userId, locale);
  }

  async remove(userId: string, productId: string) {
    await this.prisma.wishlistItem.deleteMany({ where: { userId, productId } });
    return { ids: await this.ids(userId) };
  }
}
