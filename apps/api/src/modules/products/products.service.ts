import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hasPermission, isVirtualProduct, localizePurchaseFields, normalizeCodeFields, normalizePurchaseFields, slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { attrWhere } from './attributes.filter.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { DigitalCodesService } from '../digital-codes/digital-codes.service.js';
import { resolvePublishedAt } from '../../common/utils/publish.util.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { flatten, prepareTranslations } from '../../common/utils/translation.util.js';
import { descendantIds } from '../../common/utils/tree.util.js';
import { attachRevisionAuthors, countByStatus } from '../../common/utils/status-counts.util.js';
import { cleanHtmlFor } from '../../common/utils/sanitize-html.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { effectivePrice, PRODUCT_CARD_INCLUDE, presentProductCard, publishedProductWhere } from './products.presenter.js';
import type { ProductQueryDto, PublicProductQueryDto, SaveBrandDto, SaveProductDto, VariantDto } from './products.dto.js';

/** Số phiên bản cũ giữ lại cho mỗi sản phẩm */
const MAX_REVISIONS = 20;

const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Ảnh chụp toàn bộ dữ liệu sản phẩm (dùng cho lịch sử phiên bản) */
export interface ProductSnapshot {
  type: string;
  status: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  salePrice: number | null;
  saleStart: string | null;
  saleEnd: string | null;
  costPrice: number | null;
  manageStock: boolean;
  stockQuantity: number;
  stockStatus: string;
  lowStockThreshold: number | null;
  weight: number | null;
  vatRate: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  brandId: string | null;
  featuredImageId: string | null;
  galleryIds: string[];
  options: unknown;
  specs: unknown;
  customFields?: unknown;
  /** sản phẩm ảo / kho mã (bản chụp cũ có thể thiếu -> khôi phục giữ nguyên giá trị hiện tại) */
  isVirtual?: boolean;
  codeDelivery?: boolean;
  codeFields?: unknown;
  codeWarrantyDays?: number | null;
  purchaseFields?: unknown;
  isFeatured: boolean;
  sortOrder: number;
  relatedIds: string[];
  publishedAt: string | null;
  categoryIds: string[];
  variants: {
    id: string;
    sku: string | null;
    optionValues: Record<string, string>;
    price: number;
    salePrice: number | null;
    stockQuantity: number;
    stockStatus: string;
    imageId: string | null;
    weight: number | null;
    isActive: boolean;
  }[];
  translations: Record<string, unknown>[];
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
    private readonly digitalCodes: DigitalCodesService,
  ) {}

  async list(q: ProductQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.ProductWhereInput = { deletedAt: q.trashed === '1' ? { not: null } : null };
    if (q.status) where.status = q.status as Prisma.ProductWhereInput['status'];
    if (q.type) where.type = q.type as Prisma.ProductWhereInput['type'];
    if (q.stockStatus) where.stockStatus = q.stockStatus as Prisma.ProductWhereInput['stockStatus'];
    if (q.brandId) where.brandId = q.brandId;
    if (q.categoryId) where.categories = { some: { categoryId: q.categoryId } };
    const uuids = (v: string) => v.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    if (q.ids) where.id = { in: uuids(q.ids) };
    else if (q.exclude) where.id = { notIn: uuids(q.exclude) };
    if (q.search) {
      where.OR = [
        { sku: { contains: q.search, mode: 'insensitive' } },
        { translations: { some: { name: { contains: q.search, mode: 'insensitive' } } } },
        { variants: { some: { sku: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }
    const sortable = ['createdAt', 'updatedAt', 'price', 'stockQuantity', 'soldCount', 'sortOrder'];
    const orderBy = { [sortable.includes(q.sort ?? '') ? q.sort! : 'createdAt']: q.order ?? 'desc' };
    const [rows, total, statusCounts] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          translations: { select: { locale: true, name: true, slug: true } },
          brand: { select: { id: true, name: true } },
          categories: { include: { category: { include: { translations: { select: { locale: true, name: true } } } } } },
          _count: { select: { variants: true } },
        },
      }),
      this.prisma.product.count({ where }),
      countByStatus(this.prisma, 'product'),
    ]);
    return { ...paginate(await this.media.attach(rows, ['featuredImageId']), total, page, limit), statusCounts };
  }

  async get(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: { translations: true, variants: { orderBy: { sortOrder: 'asc' } }, categories: { select: { categoryId: true } }, brand: true, downloads: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!p) throw new NotFoundException('Không tìm thấy sản phẩm');
    const { categories, downloads, ...rest } = p;
    const withMedia = await this.media.attachOne({ ...rest, categoryIds: categories.map((c) => c.categoryId) }, ['featuredImageId'], 'galleryIds');
    const variantMedia = await this.media.findMany(p.variants.map((v) => v.imageId));
    return {
      ...withMedia,
      // thống kê kho mã (tab "Kho mã" trong trang sửa sản phẩm) — chỉ khi bán theo kho mã
      codeStats: p.codeDelivery ? await this.digitalCodes.productStats(p.id) : [],
      variants: p.variants.map((v) => ({ ...v, image: variantMedia.get(v.imageId ?? '') ?? null })),
      // file tải về (sản phẩm số) kèm object media để admin hiển thị tên/kích thước file
      downloads: await this.media.attach(downloads, ['mediaId']),
    };
  }

  async save(id: string | undefined, dto: SaveProductDto, user: AuthUser) {
    const existing = id ? await this.prisma.product.findUniqueOrThrow({ where: { id }, include: { categories: { select: { categoryId: true } } } }) : null;
    // ảnh chụp trước khi sửa -> lưu thành phiên bản nếu dữ liệu thực sự thay đổi
    const before = id ? await this.snapshot(id) : null;
    const canPublish = hasPermission(user.permissions, 'products.publish');
    // hẹn giờ cũng là xuất bản (tự hiển thị khi tới giờ) -> cần cùng quyền
    if ((dto.status === 'PUBLISHED' || dto.status === 'SCHEDULED') && !canPublish) throw new ForbiddenException('Bạn không có quyền xuất bản sản phẩm');
    if (existing?.status === 'PUBLISHED' && !canPublish) throw new ForbiddenException('Sản phẩm đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    const translations = (await prepareTranslations(this.prisma, 'productTranslation', 'productId', id, dto.translations, await this.languages.codes())).map((t) => ({
      ...t,
      // chống XSS lưu trữ: không có quyền "content.unfiltered_html" -> lọc HTML mô tả chi tiết trước khi lưu
      // (áp cho tạo / sửa / nhân bản / khôi phục phiên bản / nhập CSV vì đều đi qua save()).
      // shortDescription là text thuần (storefront render dạng text, React tự escape) nên không lọc để khỏi đổi & < > thành entity.
      description: cleanHtmlFor(user, t.description),
      schemaJson: (t.schemaJson ?? undefined) as object | undefined,
    }));
    const data = await this.hooks.applyFilters('product.beforeSave', { ...dto, translations }, { user, id });
    if (data.salePrice != null && data.price != null && data.salePrice >= data.price) throw new BadRequestException('Giá khuyến mãi phải nhỏ hơn giá gốc');
    // trường tuỳ chỉnh: nhóm áp dụng theo loại sản phẩm + danh mục
    const customFields = await this.customFields.sanitize('product', data.customFields, { productType: data.type ?? existing?.type ?? 'SIMPLE', categoryIds: data.categoryIds ?? existing?.categories.map((c) => c.categoryId) ?? [] }, existing?.customFields, { user, id });

    // Bán theo kho mã: luôn quản lý tồn kho, số lượng = số mã còn trong kho (DigitalCodesService.syncStock tính sau khi lưu)
    // -> bỏ qua stockQuantity admin gửi lên (cả sản phẩm lẫn biến thể)
    const codeDelivery = data.codeDelivery ?? existing?.codeDelivery ?? false;
    if (codeDelivery) {
      data.manageStock = true;
      data.stockQuantity = undefined;
    }

    // Trạng thái kho tự động khi quản lý tồn kho
    let stockStatus = data.stockStatus;
    if (data.manageStock && data.stockQuantity != null && stockStatus !== 'BACKORDER') stockStatus = data.stockQuantity > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';

    // Sản phẩm biến thể: giá/tồn kho cấp sản phẩm = tổng hợp từ biến thể đang bật (dùng cho lọc & sắp xếp theo giá)
    const activeVariants = (data.variants ?? []).filter((v) => v.isActive !== false);
    if ((data.type ?? existing?.type) === 'VARIABLE' && activeVariants.length) {
      data.price = Math.min(...activeVariants.map((v) => Number(v.price)));
      data.salePrice = null;
      if ((data.manageStock ?? existing?.manageStock) && !codeDelivery) data.stockQuantity = activeVariants.reduce((sum, v) => sum + (v.stockQuantity ?? 0), 0);
    }
    const base = {
      type: data.type,
      status: data.status,
      sku: data.sku || null,
      barcode: data.barcode,
      price: data.price,
      salePrice: data.salePrice,
      saleStart: data.saleStart === undefined ? undefined : data.saleStart ? new Date(data.saleStart) : null,
      saleEnd: data.saleEnd === undefined ? undefined : data.saleEnd ? new Date(data.saleEnd) : null,
      costPrice: data.costPrice,
      manageStock: data.manageStock,
      stockQuantity: data.stockQuantity,
      stockStatus,
      lowStockThreshold: data.lowStockThreshold,
      weight: data.weight,
      vatRate: data.vatRate,
      // lớp thuế (nhánh thuế theo vùng): chuỗi rỗng = null (standard)
      taxClass: data.taxClass === undefined ? undefined : data.taxClass?.trim().toLowerCase() || null,
      length: data.length,
      width: data.width,
      height: data.height,
      brandId: data.brandId,
      featuredImageId: data.featuredImageId,
      galleryIds: data.galleryIds,
      options: data.options as object | undefined,
      specs: data.specs as object | undefined,
      customFields: customFields as object | undefined,
      // sản phẩm ảo / kho mã: JSON cấu hình được chuẩn hoá (bỏ phần tử hỏng, giới hạn số lượng)
      isVirtual: data.isVirtual,
      codeDelivery: data.codeDelivery,
      codeFields: data.codeFields === undefined ? undefined : (normalizeCodeFields(data.codeFields) as unknown as object),
      codeWarrantyDays: data.codeWarrantyDays === undefined ? undefined : data.codeWarrantyDays,
      purchaseFields: data.purchaseFields === undefined ? undefined : (normalizePurchaseFields(data.purchaseFields) as unknown as object),
      isFeatured: data.isFeatured,
      sortOrder: data.sortOrder,
      relatedIds: data.relatedIds,
      publishedAt: resolvePublishedAt(data.publishedAt, data.status ?? existing?.status, existing?.publishedAt),
    };

    const productId = await this.prisma.$transaction(async (tx) => {
      const product = id ? await tx.product.update({ where: { id }, data: base }) : await tx.product.create({ data: { ...base, status: base.status ?? 'DRAFT' } });
      for (const t of data.translations) {
        await tx.productTranslation.upsert({ where: { productId_locale: { productId: product.id, locale: t.locale } }, create: { ...t, productId: product.id }, update: t });
      }
      if (data.categoryIds) {
        await tx.productCategoryOnProduct.deleteMany({ where: { productId: product.id } });
        await tx.productCategoryOnProduct.createMany({ data: data.categoryIds.map((categoryId) => ({ productId: product.id, categoryId })) });
      }
      if (data.variants) {
        const keep = data.variants.filter((v) => v.id).map((v) => v.id!);
        // kho mã: mã còn trong kho của biến thể sắp xoá -> khoá lại (DISABLED) để không bị bán nhầm thành "mã không biến thể"
        // (FK variantId SET NULL khi xoá biến thể); mã đã bán / thu hồi giữ nguyên lịch sử
        await tx.digitalCode.updateMany({
          where: { productId: product.id, variantId: { not: null, notIn: keep }, status: 'AVAILABLE' },
          data: { status: 'DISABLED', note: 'Biến thể đã bị xoá' },
        });
        await tx.productVariant.deleteMany({ where: { productId: product.id, id: { notIn: keep } } });
        for (const [i, v] of data.variants.entries()) {
          // kho mã: tồn kho biến thể do syncStock tính -> không ghi số admin gửi (biến thể mới tạm 0)
          const stockQuantity = codeDelivery ? (v.id ? undefined : 0) : (v.stockQuantity ?? 0);
          const row = {
            sku: v.sku || null,
            optionValues: v.optionValues,
            price: v.price,
            salePrice: v.salePrice,
            stockQuantity,
            stockStatus: codeDelivery ? (v.stockStatus ?? (v.id ? undefined : 'OUT_OF_STOCK')) : (v.stockStatus ?? ((v.stockQuantity ?? 0) > 0 || !data.manageStock ? 'IN_STOCK' : 'OUT_OF_STOCK')),
            imageId: v.imageId,
            weight: v.weight,
            isActive: v.isActive ?? true,
            sortOrder: i,
          };
          if (v.id) await tx.productVariant.update({ where: { id: v.id, productId: product.id }, data: row });
          else await tx.productVariant.create({ data: { ...row, stockQuantity: row.stockQuantity ?? 0, productId: product.id } });
        }
      }
      // File tải về: chỉ ghi khi là sản phẩm số; đổi sang loại khác thì giữ dữ liệu cũ (không cấp quyền tải)
      if (data.downloads && (data.type ?? existing?.type) === 'DIGITAL') {
        const keep = data.downloads.filter((d) => d.id).map((d) => d.id!);
        await tx.productDownload.deleteMany({ where: { productId: product.id, id: { notIn: keep } } });
        for (const [i, d] of data.downloads.entries()) {
          if (!d.mediaId && !d.url?.trim()) throw new BadRequestException(`File tải về "${d.name}" cần chọn file hoặc nhập URL`);
          const row = { name: d.name.trim(), mediaId: d.mediaId || null, url: d.mediaId ? null : d.url?.trim() || null, downloadLimit: d.downloadLimit ?? null, expiryDays: d.expiryDays ?? null, sortOrder: i };
          if (d.id) await tx.productDownload.update({ where: { id: d.id, productId: product.id }, data: row });
          else await tx.productDownload.create({ data: { ...row, productId: product.id } });
        }
      }
      return product.id;
    });
    // kho mã: tính lại tồn kho sản phẩm + biến thể từ số mã còn trong kho
    if (codeDelivery) await this.digitalCodes.syncStock(productId);
    if (id && before) await this.saveRevisionIfChanged(id, before, user);
    this.afterChange(productId, id ? 'product.updated' : 'product.created', user);
    if (data.status === 'PUBLISHED' && existing?.status !== 'PUBLISHED') {
      this.events.emit('product.published', { id: productId });
      await this.hooks.doAction('product.published', { id: productId });
    }
    return this.get(productId);
  }

  // ---------------- revisions ----------------

  /** Chụp toàn bộ dữ liệu sản phẩm (base + bản dịch + biến thể + danh mục), thứ tự ổn định để so sánh JSON */
  private async snapshot(id: string): Promise<ProductSnapshot | null> {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: { translations: { orderBy: { locale: 'asc' } }, variants: { orderBy: { sortOrder: 'asc' } }, categories: { select: { categoryId: true } } },
    });
    if (!p) return null;
    return {
      type: p.type,
      status: p.status,
      sku: p.sku,
      barcode: p.barcode,
      price: Number(p.price),
      salePrice: num(p.salePrice),
      saleStart: iso(p.saleStart),
      saleEnd: iso(p.saleEnd),
      costPrice: num(p.costPrice),
      manageStock: p.manageStock,
      stockQuantity: p.stockQuantity,
      stockStatus: p.stockStatus,
      lowStockThreshold: p.lowStockThreshold,
      weight: num(p.weight),
      vatRate: p.vatRate,
      length: num(p.length),
      width: num(p.width),
      height: num(p.height),
      brandId: p.brandId,
      featuredImageId: p.featuredImageId,
      galleryIds: p.galleryIds,
      options: p.options ?? null,
      specs: p.specs ?? null,
      customFields: p.customFields ?? {},
      isVirtual: p.isVirtual,
      codeDelivery: p.codeDelivery,
      codeFields: p.codeFields ?? [],
      codeWarrantyDays: p.codeWarrantyDays,
      purchaseFields: p.purchaseFields ?? [],
      isFeatured: p.isFeatured,
      sortOrder: p.sortOrder,
      relatedIds: p.relatedIds,
      publishedAt: iso(p.publishedAt),
      categoryIds: p.categories.map((c) => c.categoryId).sort(),
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        optionValues: (v.optionValues ?? {}) as Record<string, string>,
        price: Number(v.price),
        salePrice: num(v.salePrice),
        stockQuantity: v.stockQuantity,
        stockStatus: v.stockStatus,
        imageId: v.imageId,
        weight: num(v.weight),
        isActive: v.isActive,
      })),
      translations: p.translations.map(({ id: _i, productId: _p, ...t }) => t as Record<string, unknown>),
    };
  }

  private snapshotTitle(snap: ProductSnapshot, fallback: string) {
    const trs = snap.translations as { locale: string; name: string }[];
    return (trs.find((t) => t.locale === fallback) ?? trs[0])?.name ?? '';
  }

  private async saveRevisionIfChanged(id: string, before: ProductSnapshot, user: AuthUser) {
    const after = await this.snapshot(id);
    if (!after || JSON.stringify(before) === JSON.stringify(after)) return;
    await this.prisma.productRevision.create({ data: { productId: id, title: this.snapshotTitle(before, await this.languages.defaultLocale()), snapshot: before as unknown as object, authorId: user.id } });
    const old = await this.prisma.productRevision.findMany({ where: { productId: id }, orderBy: { createdAt: 'desc' }, skip: MAX_REVISIONS, select: { id: true } });
    if (old.length) await this.prisma.productRevision.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  async revisions(id: string) {
    const rows = await this.prisma.productRevision.findMany({
      where: { productId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, authorId: true, createdAt: true, snapshot: true },
    });
    return attachRevisionAuthors(
      this.prisma,
      rows.map(({ snapshot, ...r }) => {
        const snap = snapshot as unknown as ProductSnapshot;
        return { ...r, status: snap.status, price: snap.price, salePrice: snap.salePrice, stockQuantity: snap.stockQuantity, variantCount: snap.variants?.length ?? 0 };
      }),
    );
  }

  async revision(revisionId: string) {
    const rev = await this.prisma.productRevision.findUnique({ where: { id: revisionId } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const [withAuthor] = await attachRevisionAuthors(this.prisma, [rev]);
    return withAuthor;
  }

  /** Dựng lại dto từ ảnh chụp rồi lưu qua save() (save() tự lưu phiên bản hiện tại trước khi ghi đè). */
  async restoreRevision(id: string, revisionId: string, user: AuthUser) {
    const rev = await this.prisma.productRevision.findFirst({ where: { id: revisionId, productId: id } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const snap = rev.snapshot as unknown as ProductSnapshot;
    // biến thể đã bị xoá sau khi chụp -> bỏ id để tạo mới
    const existingVariantIds = new Set((await this.prisma.productVariant.findMany({ where: { productId: id }, select: { id: true } })).map((v) => v.id));
    const variants: VariantDto[] = (snap.variants ?? []).map((v) => ({
      id: existingVariantIds.has(v.id) ? v.id : undefined,
      sku: v.sku,
      optionValues: v.optionValues,
      price: v.price,
      salePrice: v.salePrice,
      stockQuantity: v.stockQuantity,
      stockStatus: v.stockStatus as VariantDto['stockStatus'],
      imageId: v.imageId,
      weight: v.weight,
      isActive: v.isActive,
    }));
    const dto: SaveProductDto = {
      type: snap.type as SaveProductDto['type'],
      status: snap.status as SaveProductDto['status'],
      sku: snap.sku,
      barcode: snap.barcode,
      price: snap.price,
      salePrice: snap.salePrice,
      saleStart: snap.saleStart,
      saleEnd: snap.saleEnd,
      costPrice: snap.costPrice,
      manageStock: snap.manageStock,
      stockQuantity: snap.stockQuantity,
      stockStatus: snap.stockStatus as SaveProductDto['stockStatus'],
      lowStockThreshold: snap.lowStockThreshold,
      weight: snap.weight,
      length: snap.length,
      width: snap.width,
      height: snap.height,
      brandId: snap.brandId,
      featuredImageId: snap.featuredImageId,
      galleryIds: snap.galleryIds ?? [],
      options: Array.isArray(snap.options) ? snap.options : [],
      specs: Array.isArray(snap.specs) ? snap.specs : [],
      customFields: (snap.customFields ?? undefined) as Record<string, unknown> | undefined,
      // bản chụp trước khi có kho mã không có các trường này -> undefined = giữ nguyên hiện tại
      isVirtual: snap.isVirtual,
      codeDelivery: snap.codeDelivery,
      codeFields: Array.isArray(snap.codeFields) ? snap.codeFields : undefined,
      codeWarrantyDays: snap.codeWarrantyDays,
      purchaseFields: Array.isArray(snap.purchaseFields) ? snap.purchaseFields : undefined,
      isFeatured: snap.isFeatured,
      sortOrder: snap.sortOrder,
      publishedAt: snap.publishedAt,
      categoryIds: snap.categoryIds ?? [],
      relatedIds: snap.relatedIds ?? [],
      variants,
      translations: (snap.translations as unknown as SaveProductDto['translations']).map((t) => ({ ...t, schemaJson: (t.schemaJson as Record<string, unknown>) ?? undefined })),
    };
    const result = await this.save(id, dto, user);
    this.events.emit('activity', { userId: user.id, action: 'product.restored_revision', entityType: 'product', entityId: id });
    return result;
  }

  // ---------------- thùng rác ----------------

  async trash(id: string, user: AuthUser) {
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });
    this.afterChange(id, 'product.trash', user);
    return { success: true };
  }

  async restore(id: string, user: AuthUser) {
    await this.prisma.product.update({ where: { id }, data: { deletedAt: null } });
    this.afterChange(id, 'product.restore', user);
    return { success: true };
  }

  /** Sản phẩm (trong danh sách) đã có mã giao / giữ cho khách — xoá vĩnh viễn sẽ cascade xoá mất mã của khách */
  private async productsWithDeliveredCodes(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.digitalCode.findMany({
      where: { productId: { in: ids }, status: { in: ['SOLD', 'RESERVED', 'REVOKED'] } },
      distinct: ['productId'],
      select: { productId: true },
    });
    return new Set(rows.map((r) => r.productId));
  }

  /** Xoá vĩnh viễn - chỉ áp dụng cho sản phẩm đã ở trong thùng rác và chưa có mã giao cho khách */
  async destroy(id: string, user: AuthUser) {
    const p = await this.prisma.product.findUniqueOrThrow({ where: { id } });
    if (!p.deletedAt) throw new ForbiddenException('Hãy chuyển sản phẩm vào thùng rác trước khi xoá vĩnh viễn');
    // mã AVAILABLE / DISABLED được xoá theo; mã đã giao / đang giữ / đã thu hồi thì chặn để không mất mã của khách
    if ((await this.productsWithDeliveredCodes([id])).size) throw new BadRequestException('Sản phẩm đã có mã giao cho khách, không thể xoá vĩnh viễn — hãy để trong thùng rác');
    await this.prisma.product.delete({ where: { id } });
    this.afterChange(id, 'product.destroy', user);
    return { success: true };
  }

  private afterChange(id: string, action: string, user?: AuthUser) {
    this.events.emit(action, { id });
    this.events.emit('content.changed', { type: 'product', id, tags: ['products', `product:${id}`, 'pages'] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'product', entityId: id });
  }

  async duplicate(id: string, user: AuthUser) {
    const src = await this.prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true, variants: true, categories: true, downloads: { orderBy: { sortOrder: 'asc' } } } });
    return this.save(
      undefined,
      {
        type: src.type,
        downloads: src.downloads.map((d) => ({ name: d.name, mediaId: d.mediaId, url: d.url, downloadLimit: d.downloadLimit, expiryDays: d.expiryDays })),
        status: 'DRAFT',
        price: Number(src.price),
        salePrice: src.salePrice != null ? Number(src.salePrice) : null,
        manageStock: src.manageStock,
        stockQuantity: src.stockQuantity,
        stockStatus: src.stockStatus,
        brandId: src.brandId,
        featuredImageId: src.featuredImageId,
        galleryIds: src.galleryIds,
        options: src.options as unknown[],
        specs: src.specs as unknown[],
        customFields: (src.customFields ?? {}) as Record<string, unknown>,
        // cấu hình sản phẩm ảo / kho mã được sao chép, nhưng KHÔNG sao chép mã trong kho (bản sao bắt đầu với kho rỗng)
        isVirtual: src.isVirtual,
        codeDelivery: src.codeDelivery,
        codeFields: src.codeFields as unknown[],
        codeWarrantyDays: src.codeWarrantyDays,
        purchaseFields: src.purchaseFields as unknown[],
        categoryIds: src.categories.map((c) => c.categoryId),
        variants: src.variants.map((v) => ({
          optionValues: v.optionValues as Record<string, string>,
          price: Number(v.price),
          salePrice: v.salePrice != null ? Number(v.salePrice) : null,
          stockQuantity: v.stockQuantity,
          stockStatus: v.stockStatus,
          imageId: v.imageId,
        })),
        translations: src.translations.map(({ id: _i, productId: _p, ...t }) => ({
          ...t,
          name: `${t.name} (bản sao)`,
          slug: `${t.slug}-copy`,
          schemaJson: (t.schemaJson as Record<string, unknown>) ?? undefined,
        })),
      },
      user,
    );
  }

  async bulk(ids: string[], action: 'trash' | 'restore' | 'publish' | 'draft' | 'destroy' | 'feature' | 'unfeature', user: AuthUser) {
    if (['trash', 'restore', 'destroy'].includes(action) && !hasPermission(user.permissions, 'products.delete')) throw new ForbiddenException('Bạn không có quyền xoá sản phẩm');
    if ((action === 'publish' || action === 'draft') && !hasPermission(user.permissions, 'products.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản / gỡ sản phẩm');
    const where = { id: { in: ids } };
    // số sản phẩm bị bỏ qua khi xoá vĩnh viễn (đã có mã giao cho khách)
    let skipped = 0;
    let affectedIds = ids;
    switch (action) {
      case 'trash':
        await this.prisma.product.updateMany({ where, data: { deletedAt: new Date() } });
        break;
      case 'restore':
        await this.prisma.product.updateMany({ where, data: { deletedAt: null } });
        break;
      case 'publish': {
        const newly = await this.prisma.product.findMany({ where: { ...where, status: { not: 'PUBLISHED' } }, select: { id: true } });
        await this.prisma.product.updateMany({ where: { ...where, publishedAt: null }, data: { publishedAt: new Date() } });
        await this.prisma.product.updateMany({ where, data: { status: 'PUBLISHED' } });
        for (const { id } of newly) {
          this.events.emit('product.published', { id });
          await this.hooks.doAction('product.published', { id });
        }
        break;
      }
      case 'draft':
        await this.prisma.product.updateMany({ where, data: { status: 'DRAFT' } });
        break;
      case 'feature':
      case 'unfeature':
        await this.prisma.product.updateMany({ where, data: { isFeatured: action === 'feature' } });
        break;
      case 'destroy': {
        // bỏ qua sản phẩm đã có mã giao / giữ / thu hồi cho khách (xoá sẽ cascade mất mã) — để nguyên trong thùng rác
        const blocked = await this.productsWithDeliveredCodes(ids);
        skipped = blocked.size;
        affectedIds = ids.filter((id) => !blocked.has(id));
        if (affectedIds.length) await this.prisma.product.deleteMany({ where: { id: { in: affectedIds }, deletedAt: { not: null } } });
        break;
      }
    }
    for (const id of affectedIds) this.afterChange(id, `product.${action}`, user);
    return {
      success: true,
      skipped,
      ...(skipped ? { message: `Bỏ qua ${skipped} sản phẩm đã có mã giao cho khách (không thể xoá vĩnh viễn, vẫn ở thùng rác)` } : {}),
    };
  }

  async removeTranslation(id: string, locale: string) {
    if ((await this.prisma.productTranslation.count({ where: { productId: id } })) <= 1) throw new BadRequestException('Sản phẩm phải có ít nhất một bản dịch');
    await this.prisma.productTranslation.delete({ where: { productId_locale: { productId: id, locale } } });
    this.afterChange(id, 'product.updated');
    return this.get(id);
  }

  // ---- brands ----
  brands() {
    return this.prisma.brand.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } }).then((rows) => this.media.attach(rows, ['logoId']));
  }

  async saveBrand(id: string | undefined, dto: SaveBrandDto) {
    const data = { ...dto, slug: slugify(dto.slug || dto.name) };
    const brand = id ? await this.prisma.brand.update({ where: { id }, data }) : await this.prisma.brand.create({ data });
    this.events.emit('content.changed', { type: 'brand', tags: ['products'] });
    return brand;
  }

  async removeBrand(id: string) {
    await this.prisma.brand.delete({ where: { id } });
    return { success: true };
  }

  // ---------------- public ----------------

  async publicList(q: PublicProductQueryDto) {
    const locale = await this.languages.resolve(q.locale);
    const fallback = await this.languages.defaultLocale();
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.ProductWhereInput = { ...publishedProductWhere(), translations: { some: { locale } } };
    const and: Prisma.ProductWhereInput[] = [];
    if (q.category) {
      // gồm cả danh mục con
      const cat = await this.prisma.productCategory.findFirst({ where: { translations: { some: { slug: q.category } } }, select: { id: true } });
      const ids = cat ? await this.descendantIds(cat.id) : [];
      and.push({ categories: { some: { categoryId: { in: ids } } } });
    }
    if (q.brand) and.push({ brand: { slug: q.brand } });
    if (q.minPrice != null) and.push({ price: { gte: q.minPrice } });
    if (q.maxPrice != null) and.push({ price: { lte: q.maxPrice } });
    if (q.inStock === '1') and.push({ stockStatus: { not: 'OUT_OF_STOCK' } });
    if (q.onSale === '1') and.push({ salePrice: { not: null } });
    if (q.featured === '1') and.push({ isFeatured: true });
    if (q.ids) and.push({ id: { in: q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)) } });
    // lọc theo trường tuỳ chỉnh ?cf[key]=value (vd ?cf[platform]=netflix)
    and.push(...(await this.customFields.publicWhere<Prisma.ProductWhereInput>('product', q.cf)));
    // lọc theo thuộc tính biến thể ?attr[color]=red,blue (attributes.filter.ts)
    and.push(...attrWhere(q.attr));
    if (q.search) {
      and.push({
        OR: [
          { sku: { contains: q.search, mode: 'insensitive' } },
          { translations: { some: { locale, OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { shortDescription: { contains: q.search, mode: 'insensitive' } }] } } },
        ],
      });
    }
    if (and.length) where.AND = and;
    const sortMap: Record<string, Prisma.ProductOrderByWithRelationInput> = {
      newest: { createdAt: 'desc' },
      price_asc: { price: 'asc' },
      price_desc: { price: 'desc' },
      best_selling: { soldCount: 'desc' },
      rating: { ratingAverage: 'desc' },
      manual: { sortOrder: 'asc' },
    };
    const orderBy = q.sort && Object.hasOwn(sortMap, q.sort) ? sortMap[q.sort] : [{ sortOrder: 'asc' as const }, { createdAt: 'desc' as const }];
    const [rows, total, priceRange] = await Promise.all([
      this.prisma.product.findMany({ where, skip, take, orderBy, include: PRODUCT_CARD_INCLUDE }),
      this.prisma.product.count({ where }),
      this.prisma.product.aggregate({ where: publishedProductWhere(), _min: { price: true }, _max: { price: true } }),
    ]);
    const media = await this.media.findMany(rows.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]));
    const result = paginate(rows.map((r) => presentProductCard(r, locale, fallback, media)), total, page, limit);
    return { ...result, filters: { minPrice: Number(priceRange._min.price ?? 0), maxPrice: Number(priceRange._max.price ?? 0) } };
  }

  private async descendantIds(rootId: string): Promise<string[]> {
    return descendantIds(await this.prisma.productCategory.findMany({ select: { id: true, parentId: true } }), rootId);
  }


  async publicBySlug(slug: string, localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    return this.presentPublic({ ...publishedProductWhere(), translations: { some: { slug, locale } } }, locale);
  }

  /** Xem trước theo id (kể cả bản nháp / hẹn giờ) */
  async publicById(id: string, localeInput?: string, preview = false) {
    const locale = await this.languages.resolve(localeInput);
    return this.presentPublic({ id, ...(preview ? { deletedAt: null } : publishedProductWhere()) }, locale);
  }

  private async presentPublic(where: Prisma.ProductWhereInput, locale: string) {
    const fallback = await this.languages.defaultLocale();
    const p = await this.prisma.product.findFirst({
      where,
      include: {
        translations: true,
        variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        brand: true,
        categories: { include: { category: { include: { translations: { select: { locale: true, name: true, slug: true } } } } } },
      },
    });
    if (!p) throw new NotFoundException('Không tìm thấy sản phẩm');
    const flat = flatten({ ...p, categories: undefined, variants: undefined }, locale, fallback) as Record<string, unknown>;
    const media = await this.media.findMany([p.featuredImageId, (flat.ogImageId as string) ?? null, ...p.galleryIds, ...p.variants.map((v) => v.imageId)]);
    const pricing = effectivePrice(p);

    const relatedWhere: Prisma.ProductWhereInput = p.relatedIds.length
      ? { id: { in: p.relatedIds } }
      : { id: { not: p.id }, categories: { some: { categoryId: { in: p.categories.map((c) => c.categoryId) } } } };
    const related = await this.prisma.product.findMany({ where: { ...publishedProductWhere(), ...relatedWhere }, take: 8, include: PRODUCT_CARD_INCLUDE });
    const relMedia = await this.media.findMany(related.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]));
    const pickCat = (list: { locale: string; name: string; slug: string }[]) => list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];

    const result = {
      ...flat,
      ...(await this.customFields.present('product', p.customFields, locale, fallback, { productType: p.type, categoryIds: p.categories.map((c) => c.categoryId) })),
      ...pricing,
      discountPercent: pricing.salePrice != null && pricing.price > 0 ? Math.round((1 - pricing.salePrice / pricing.price) * 100) : 0,
      inStock: p.type === 'VARIABLE' ? p.variants.some((v) => v.stockStatus !== 'OUT_OF_STOCK') : p.stockStatus !== 'OUT_OF_STOCK',
      featuredImage: media.get(p.featuredImageId ?? '') ?? null,
      ogImage: media.get((flat.ogImageId as string) ?? '') ?? null,
      gallery: p.galleryIds.map((id) => media.get(id)).filter(Boolean),
      variants: p.variants.map((v) => ({ ...v, ...effectivePrice({ price: v.price, salePrice: v.salePrice }), image: media.get(v.imageId ?? '') ?? null })),
      categories: p.categories.map((c) => ({ id: c.categoryId, ...pickCat(c.category.translations) })),
      related: related.map((r) => presentProductCard(r, locale, fallback, relMedia)),
      // sản phẩm ảo / kho mã: không lộ kho mã, chỉ cờ + ô khách cần nhập (đã chọn ngôn ngữ)
      isVirtual: isVirtualProduct(p),
      codeDelivery: p.codeDelivery,
      purchaseFields: localizePurchaseFields(normalizePurchaseFields(p.purchaseFields), locale),
      codeWarrantyDays: p.codeWarrantyDays,
      codeFields: undefined,
      // hướng dẫn sử dụng chỉ gửi kèm mã sau khi mua
      deliveryNote: undefined,
      costPrice: undefined,
      barcode: undefined,
      lowStockThreshold: undefined,
      status: undefined,
      deletedAt: undefined,
      sortOrder: undefined,
      soldCount: p.soldCount,
    };
    return this.hooks.applyFilters('product.public', result, { locale });
  }

  sitemapEntries() {
    return this.prisma.product.findMany({
      where: publishedProductWhere(),
      select: { id: true, updatedAt: true, featuredImageId: true, translations: { select: { locale: true, slug: true, noindex: true, name: true } } },
      // thứ tự cố định để sitemap chia trang không xáo trộn giữa các lần dựng
      orderBy: { createdAt: 'asc' },
    });
  }
}
