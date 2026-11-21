import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import sharp, { type Sharp } from 'sharp';
import { slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { Prisma, type Media } from '../../generated/prisma/client.js';
import { STORAGE, type StorageDriver } from './storage.service.js';
import { sanitizeSvg } from './svg-sanitize.js';

const IMAGE_SIZES = { thumb: 320, medium: 768, large: 1600 } as const;
const RESIZABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'];
/** Mime được phép -> phần mở rộng lưu trên đĩa (không dùng đuôi từ tên file client gửi lên) */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/epub+zip': '.epub',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
};
const ALLOWED = Object.keys(MIME_EXT);
/** Số ngày file nằm trong thùng rác trước khi cron xoá vĩnh viễn */
const TRASH_RETENTION_DAYS = 30;

export type MediaDto = Media & { url: string; urls: Record<string, string> };

export type MediaUsageType = 'page' | 'post' | 'product' | 'product_variant' | 'post_category' | 'product_category' | 'brand' | 'global_block' | 'setting' | 'user' | 'menu';

export interface MediaUsage {
  type: MediaUsageType;
  id: string;
  title: string;
  /** Đường dẫn trong admin (không gồm basePath) */
  href: string;
}

export interface EditImageOps {
  rotate?: 90 | 180 | 270;
  flip?: 'h' | 'v';
  /** Toạ độ pixel theo ảnh gốc */
  crop?: { x: number; y: number; width: number; height: number };
  resize?: { width?: number; height?: number };
}

type ImageBuild = { buffer: Buffer; width: number | null; height: number | null; variants: Record<string, string> };

/** Nhóm MIME để kiểm tra khi thay file: ảnh chỉ thay bằng ảnh, video bằng video... */
function mimeGroup(mime: string) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return mime;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger('Media');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** Thêm url tuyệt đối cho bản ghi media */
  present(m: Media): MediaDto;
  present(m: Media | null | undefined): MediaDto | null;
  present(m: Media | null | undefined): MediaDto | null {
    if (!m) return null;
    const variants = (m.variants ?? {}) as Record<string, string>;
    const urls: Record<string, string> = { original: this.storage.url(m.path) };
    for (const [k, p] of Object.entries(variants)) urls[k] = this.storage.url(p);
    return { ...m, url: this.storage.url(m.path), urls };
  }

  /**
   * Lấy nhiều media theo id (kể cả đang trong thùng rác — nội dung đang dùng vẫn hiển thị
   * cho tới khi file bị xoá vĩnh viễn).
   */
  async findMany(ids: (string | null | undefined)[]): Promise<Map<string, MediaDto>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await this.prisma.media.findMany({ where: { id: { in: unique } } });
    return new Map(rows.map((r) => [r.id, this.present(r)]));
  }

  /**
   * Gắn object media vào danh sách bản ghi. Vd attach(products, ['featuredImageId'], 'galleryIds')
   * -> product.featuredImage, product.gallery
   */
  async attach<T extends Record<string, unknown>>(items: T[], fields: string[], arrayField?: string): Promise<T[]> {
    const ids: string[] = [];
    for (const it of items) {
      for (const f of fields) ids.push(it[f] as string);
      if (arrayField) ids.push(...((it[arrayField] as string[]) ?? []));
    }
    const map = await this.findMany(ids);
    return items.map((it) => {
      const out: Record<string, unknown> = { ...it };
      for (const f of fields) out[f.replace(/Id$/, '')] = map.get(it[f] as string) ?? null;
      if (arrayField) out[arrayField.replace(/Ids$/, '')] = ((it[arrayField] as string[]) ?? []).map((id) => map.get(id)).filter(Boolean);
      return out as T;
    });
  }

  async attachOne<T extends Record<string, unknown>>(item: T, fields: string[], arrayField?: string): Promise<T> {
    return (await this.attach([item], fields, arrayField))[0];
  }

  // ---------------------------------------------------------------------------
  // Danh sách / chi tiết
  // ---------------------------------------------------------------------------

  async list(q: { page?: number; limit?: number; search?: string; folderId?: string; type?: string; sort?: string; order?: 'asc' | 'desc'; trashed?: boolean }) {
    const { skip, take, page, limit } = pageArgs(q);
    // Mặc định ẩn file trong thùng rác (picker, storefront...). trashed=1 -> chỉ xem thùng rác
    const where: Prisma.MediaWhereInput = q.trashed ? { deletedAt: { not: null } } : { deletedAt: null };
    if (q.search) where.OR = [{ originalName: { contains: q.search, mode: 'insensitive' } }, { filename: { contains: q.search, mode: 'insensitive' } }];
    if (!q.trashed) {
      // Chỉ lấy đúng thư mục được chọn (không gồm thư mục con)
      if (q.folderId === 'root') where.folderId = null;
      else if (q.folderId) where.folderId = q.folderId;
    }
    if (q.type === 'image') where.mimeType = { startsWith: 'image/' };
    else if (q.type === 'video') where.mimeType = { startsWith: 'video/' };
    else if (q.type === 'document') where.NOT = [{ mimeType: { startsWith: 'image/' } }, { mimeType: { startsWith: 'video/' } }];
    const sortable = ['createdAt', 'size', 'originalName', 'deletedAt'];
    const sort = sortable.includes(q.sort ?? '') ? q.sort! : q.trashed ? 'deletedAt' : 'createdAt';
    const orderBy: Prisma.MediaOrderByWithRelationInput[] = [{ [sort]: q.order ?? 'desc' }, { id: 'asc' }];
    const [rows, total] = await Promise.all([
      this.prisma.media.findMany({ where, skip, take, orderBy, include: { uploader: { select: { id: true, name: true } } } }),
      this.prisma.media.count({ where }),
    ]);
    return paginate(rows.map((r) => this.present(r)), total, page, limit);
  }

  async get(id: string) {
    return this.present(await this.prisma.media.findUniqueOrThrow({ where: { id }, include: { uploader: { select: { id: true, name: true } } } }));
  }

  // ---------------------------------------------------------------------------
  // Xử lý ảnh dùng chung cho upload / chỉnh / thay file
  // ---------------------------------------------------------------------------

  /**
   * Với ảnh raster: xoay theo EXIF, bỏ metadata, sinh các biến thể webp (thumb/medium/large + webp gốc).
   * Trả về buffer ảnh gốc đã làm sạch + kích thước + map variants (đã ghi vào storage).
   */
  private async buildImage(input: Buffer, mimeType: string, dir: string, name: string): Promise<ImageBuild> {
    if (!RESIZABLE.includes(mimeType)) return { buffer: input, width: null, height: null, variants: {} };
    const img = sharp(input, { failOn: 'none' }).rotate(); // xoay theo EXIF
    const meta = await img.metadata().catch(() => {
      throw new BadRequestException('File ảnh không hợp lệ');
    });
    const width = meta.autoOrient?.width ?? meta.width ?? null;
    const height = meta.autoOrient?.height ?? meta.height ?? null;
    // loại bỏ EXIF (GPS...) khỏi ảnh gốc
    const buffer = await img.toBuffer();
    const variants: Record<string, string> = {};
    for (const [key, size] of Object.entries(IMAGE_SIZES)) {
      if (width && width <= size) continue;
      const out = await sharp(buffer).resize({ width: size, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      const vPath = `${dir}/${name}-${key}.webp`;
      await this.storage.put(vPath, out);
      variants[key] = vPath;
    }
    // luôn có bản webp kích thước gốc để frontend dùng
    const webp = await sharp(buffer).webp({ quality: 85 }).toBuffer();
    variants.webp = `${dir}/${name}.webp`;
    await this.storage.put(variants.webp, webp);
    return { buffer, width, height, variants };
  }

  /**
   * SVG: làm sạch bằng allowlist (svg-sanitize.ts) rồi lưu BẢN ĐÃ LÀM SẠCH thay cho file gốc — áp dụng cho mọi driver
   * (S3/CDN không gắn được CSP sandbox như /uploads của driver local). File không còn phần tử <svg> sau khi làm sạch thì từ chối.
   */
  private sanitizeSvgFile(file: Express.Multer.File) {
    const clean = sanitizeSvg(file.buffer.toString('utf8'));
    if (!clean) throw new BadRequestException('File SVG không hợp lệ hoặc chứa mã không an toàn');
    file.buffer = Buffer.from(clean, 'utf8');
    file.size = file.buffer.length;
  }

  private validateFile(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Không có file');
    const maxMb = this.config.get<number>('upload.maxMb') ?? 20;
    if (file.size > maxMb * 1024 * 1024) throw new BadRequestException(`File vượt quá ${maxMb}MB`);
    if (!ALLOWED.includes(file.mimetype)) throw new BadRequestException(`Định dạng ${file.mimetype} không được hỗ trợ`);
    if (file.mimetype === 'image/svg+xml') this.sanitizeSvgFile(file);
  }

  /** Tên file gốc do multer giải mã theo latin1 -> đổi về utf8 để giữ tiếng Việt */
  private originalName(file: Express.Multer.File) {
    return Buffer.from(file.originalname, 'latin1').toString('utf8');
  }

  private async deleteFiles(m: Pick<Media, 'path' | 'variants'>) {
    await this.storage.delete(m.path);
    for (const p of Object.values((m.variants ?? {}) as Record<string, string>)) await this.storage.delete(p);
  }

  private activity(userId: string | undefined, action: string, entityId: string, meta?: Record<string, unknown>) {
    if (!userId) return;
    this.events.emit('activity', { userId, action, entityType: 'media', entityId, meta });
  }

  private changed(id?: string) {
    this.events.emit('content.changed', { type: 'media', id, tags: id ? ['media', `media:${id}`] : ['media'] });
  }

  // ---------------------------------------------------------------------------
  // Upload / cập nhật
  // ---------------------------------------------------------------------------

  async upload(file: Express.Multer.File, opts: { folderId?: string | null; uploaderId?: string; alt?: Record<string, string> }) {
    this.validateFile(file);
    const originalName = this.originalName(file);
    const ext = MIME_EXT[file.mimetype];
    const base = slugify(originalName.replace(/\.[^.]+$/, ''), 80) || 'file';
    const now = new Date();
    const dir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    // hậu tố ngẫu nhiên 8 byte (16 hex): file dưới /uploads phục vụ công khai (kể cả file sản phẩm số) -> không đoán/dò được tên
    const name = `${base}-${randomBytes(8).toString('hex')}`;
    const path = `${dir}/${name}${ext}`;

    const built = await this.buildImage(file.buffer, file.mimetype, dir, name);
    await this.storage.put(path, built.buffer, file.mimetype);
    const media = await this.prisma.media.create({
      data: {
        filename: `${name}${ext}`,
        originalName,
        path,
        mimeType: file.mimetype,
        size: built.buffer.length,
        width: built.width,
        height: built.height,
        variants: built.variants,
        alt: opts.alt ?? {},
        folderId: opts.folderId || null,
        uploaderId: opts.uploaderId,
        storage: this.storage.name,
      },
    });
    this.activity(opts.uploaderId, 'media.upload', media.id, { name: originalName, size: media.size });
    return this.present(media);
  }

  async update(id: string, data: { alt?: Record<string, string>; caption?: Record<string, string>; folderId?: string | null; originalName?: string }) {
    const media = await this.prisma.media.update({ where: { id }, data });
    this.changed(id);
    return this.present(media);
  }

  async move(ids: string[], folderId: string | null) {
    if (folderId) await this.prisma.mediaFolder.findUniqueOrThrow({ where: { id: folderId } });
    await this.prisma.media.updateMany({ where: { id: { in: ids } }, data: { folderId } });
    return { success: true };
  }

  /**
   * Chỉnh ảnh gốc (cắt / xoay / lật / đổi cỡ) rồi sinh lại variants. Giữ nguyên id;
   * tên file thêm hậu tố -v2, -v3... để trình duyệt/CDN không dùng cache cũ.
   */
  async edit(id: string, ops: EditImageOps, userId?: string) {
    const m = await this.prisma.media.findUniqueOrThrow({ where: { id } });
    if (!RESIZABLE.includes(m.mimeType)) throw new BadRequestException('Chỉ chỉnh sửa được ảnh (JPG, PNG, WebP, AVIF, TIFF)');
    if (!ops.rotate && !ops.flip && !ops.crop && !ops.resize) throw new BadRequestException('Chưa chọn thao tác chỉnh sửa');

    let buffer = await this.storage.get(m.path).catch(() => {
      throw new NotFoundException('Không tìm thấy file gốc trên máy chủ');
    });
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;

    // Mỗi bước là một pipeline sharp riêng để thứ tự cắt -> xoay -> lật -> đổi cỡ luôn đúng
    const encode = (img: Sharp) => {
      switch (m.mimeType) {
        case 'image/jpeg':
          return img.jpeg({ quality: 90, mozjpeg: true });
        case 'image/png':
          return img.png();
        case 'image/webp':
          return img.webp({ quality: 90 });
        case 'image/avif':
          return img.avif({ quality: 70 });
        default:
          return img.tiff();
      }
    };
    if (ops.crop) {
      const c = { left: Math.round(ops.crop.x), top: Math.round(ops.crop.y), width: Math.round(ops.crop.width), height: Math.round(ops.crop.height) };
      if (c.width < 1 || c.height < 1 || c.left < 0 || c.top < 0 || c.left + c.width > srcW || c.top + c.height > srcH) throw new BadRequestException('Vùng cắt nằm ngoài ảnh');
      buffer = await encode(sharp(buffer, { failOn: 'none' }).extract(c)).toBuffer();
    }
    if (ops.rotate) buffer = await encode(sharp(buffer, { failOn: 'none' }).rotate(ops.rotate)).toBuffer();
    if (ops.flip === 'h') buffer = await encode(sharp(buffer, { failOn: 'none' }).flop()).toBuffer();
    else if (ops.flip === 'v') buffer = await encode(sharp(buffer, { failOn: 'none' }).flip()).toBuffer();
    if (ops.resize && (ops.resize.width || ops.resize.height)) {
      const w = ops.resize.width ? Math.round(ops.resize.width) : undefined;
      const h = ops.resize.height ? Math.round(ops.resize.height) : undefined;
      if ((w !== undefined && w < 1) || (h !== undefined && h < 1)) throw new BadRequestException('Kích thước không hợp lệ');
      buffer = await encode(sharp(buffer, { failOn: 'none' }).resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })).toBuffer();
    }

    // Tên file mới: bỏ hậu tố -vN cũ (nếu có) rồi tăng số phiên bản
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
    const ext = MIME_EXT[m.mimeType] ?? '';
    const stem = m.filename.replace(/\.[^.]+$/, '');
    const match = stem.match(/^(.*)-v(\d+)$/);
    const version = match ? Number(match[2]) + 1 : 2;
    const name = `${match ? match[1] : stem}-v${version}`;
    const path = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;

    const built = await this.buildImage(buffer, m.mimeType, dir, name);
    await this.storage.put(path, built.buffer, m.mimeType);
    const old = { path: m.path, variants: m.variants };
    const media = await this.prisma.media.update({
      where: { id },
      data: { filename: `${name}${ext}`, path, size: built.buffer.length, width: built.width, height: built.height, variants: built.variants },
    });
    await this.deleteFiles(old);
    this.changed(id);
    this.activity(userId, 'media.edit', id, { ops: ops as unknown as Record<string, unknown>, version });
    return this.present(media);
  }

  /** Thay file mới cho bản ghi media (giữ id/alt/caption/thư mục). Phải cùng nhóm MIME (ảnh -> ảnh...). */
  async replace(id: string, file: Express.Multer.File, userId?: string) {
    const m = await this.prisma.media.findUniqueOrThrow({ where: { id } });
    this.validateFile(file);
    if (mimeGroup(file.mimetype) !== mimeGroup(m.mimeType)) throw new BadRequestException(`File thay thế phải cùng loại với file cũ (${mimeGroup(m.mimeType)})`);

    const originalName = this.originalName(file);
    const ext = MIME_EXT[file.mimetype];
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
    const base = slugify(originalName.replace(/\.[^.]+$/, ''), 80) || 'file';
    // hậu tố ngẫu nhiên 8 byte (16 hex): file dưới /uploads phục vụ công khai (kể cả file sản phẩm số) -> không đoán/dò được tên
    const name = `${base}-${randomBytes(8).toString('hex')}`;
    const path = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;

    const built = await this.buildImage(file.buffer, file.mimetype, dir, name);
    await this.storage.put(path, built.buffer, file.mimetype);
    const old = { path: m.path, variants: m.variants };
    const media = await this.prisma.media.update({
      where: { id },
      data: { filename: `${name}${ext}`, originalName, path, mimeType: file.mimetype, size: built.buffer.length, width: built.width, height: built.height, variants: built.variants },
    });
    await this.deleteFiles(old);
    this.changed(id);
    this.activity(userId, 'media.replace', id, { name: originalName, size: media.size });
    return this.present(media);
  }

  // ---------------------------------------------------------------------------
  // Đang dùng ở đâu
  // ---------------------------------------------------------------------------

  /** Tìm các nơi đang dùng media (theo id trong cột/JSON hoặc đường dẫn file trong HTML) */
  async usage(id: string): Promise<MediaUsage[]> {
    const m = await this.prisma.media.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Không tìm thấy media');
    const idLike = `%${id}%`;
    // stem = đường dẫn bỏ phần mở rộng -> khớp cả file gốc lẫn các biến thể (-thumb.webp...)
    const pathLike = `%${m.path.replace(/\.[^.]+$/, '')}%`;
    type Row = { id: string; title: string | null; ref?: string | null };
    const q = <T = Row>(sql: Prisma.Sql) => this.prisma.$queryRaw<T[]>(sql).catch((e: Error) => {
      this.logger.warn(`Truy vấn usage lỗi: ${e.message}`);
      return [] as T[];
    });

    const [pages, posts, products, variants, postCats, productCats, brands, globalBlocks, settings, users, menus] = await Promise.all([
      q(Prisma.sql`
        SELECT DISTINCT p.id::text AS id,
          (SELECT t2.title FROM page_translations t2 WHERE t2."pageId" = p.id ORDER BY t2.locale LIMIT 1) AS title
        FROM pages p LEFT JOIN page_translations t ON t."pageId" = p.id
        WHERE p."deletedAt" IS NULL AND (
          p."featuredImageId"::text = ${id} OR t."ogImageId"::text = ${id}
          OR t.blocks::text LIKE ${idLike} OR t.blocks::text LIKE ${pathLike})`),
      q(Prisma.sql`
        SELECT DISTINCT p.id::text AS id,
          (SELECT t2.title FROM post_translations t2 WHERE t2."postId" = p.id ORDER BY t2.locale LIMIT 1) AS title
        FROM posts p LEFT JOIN post_translations t ON t."postId" = p.id
        WHERE p."deletedAt" IS NULL AND (
          p."featuredImageId"::text = ${id} OR t."ogImageId"::text = ${id}
          OR t.content LIKE ${idLike} OR t.content LIKE ${pathLike})`),
      q(Prisma.sql`
        SELECT DISTINCT p.id::text AS id,
          (SELECT t2.name FROM product_translations t2 WHERE t2."productId" = p.id ORDER BY t2.locale LIMIT 1) AS title
        FROM products p LEFT JOIN product_translations t ON t."productId" = p.id
        WHERE p."deletedAt" IS NULL AND (
          p."featuredImageId"::text = ${id} OR ${id} = ANY(p."galleryIds"::text[]) OR t."ogImageId"::text = ${id}
          OR t.description LIKE ${idLike} OR t.description LIKE ${pathLike}
          OR t."shortDescription" LIKE ${idLike} OR t."shortDescription" LIKE ${pathLike})`),
      q(Prisma.sql`
        SELECT v.id::text AS id, v."productId"::text AS ref,
          COALESCE((SELECT t2.name FROM product_translations t2 WHERE t2."productId" = v."productId" ORDER BY t2.locale LIMIT 1), '') || COALESCE(' — ' || v.sku, '') AS title
        FROM product_variants v JOIN products p ON p.id = v."productId"
        WHERE p."deletedAt" IS NULL AND v."imageId"::text = ${id}`),
      q(Prisma.sql`
        SELECT c.id::text AS id, (SELECT t.name FROM post_category_translations t WHERE t."categoryId" = c.id ORDER BY t.locale LIMIT 1) AS title
        FROM post_categories c WHERE c."imageId"::text = ${id}`),
      q(Prisma.sql`
        SELECT c.id::text AS id, (SELECT t.name FROM product_category_translations t WHERE t."categoryId" = c.id ORDER BY t.locale LIMIT 1) AS title
        FROM product_categories c WHERE c."imageId"::text = ${id}`),
      q(Prisma.sql`SELECT b.id::text AS id, b.name AS title FROM brands b WHERE b."logoId"::text = ${id}`),
      q(Prisma.sql`
        SELECT DISTINCT g.id::text AS id, g.name AS title
        FROM global_blocks g JOIN global_block_translations t ON t."blockId" = g.id
        WHERE t.blocks::text LIKE ${idLike} OR t.blocks::text LIKE ${pathLike}`),
      q(Prisma.sql`SELECT s.key AS id, s.key AS title FROM settings s WHERE s.value::text LIKE ${idLike} OR s.value::text LIKE ${pathLike}`),
      q(Prisma.sql`SELECT u.id::text AS id, u.name AS title FROM users u WHERE u."avatarId"::text = ${id}`),
      q(Prisma.sql`SELECT m.id::text AS id, m.name AS title FROM menus m WHERE m.items::text LIKE ${idLike} OR m.items::text LIKE ${pathLike}`),
    ]);

    const out: MediaUsage[] = [];
    const push = (type: MediaUsageType, rows: Row[], href: (r: Row) => string, fallback: string) => {
      for (const r of rows) out.push({ type, id: r.id, title: r.title || fallback, href: href(r) });
    };
    push('page', pages, (r) => `/pages/${r.id}`, 'Trang');
    push('post', posts, (r) => `/posts/${r.id}`, 'Bài viết');
    push('product', products, (r) => `/products/${r.id}`, 'Sản phẩm');
    push('product_variant', variants, (r) => `/products/${r.ref}`, 'Biến thể sản phẩm');
    push('post_category', postCats, () => '/posts/categories', 'Chuyên mục bài viết');
    push('product_category', productCats, () => '/products/categories', 'Danh mục sản phẩm');
    push('brand', brands, () => '/products/brands', 'Thương hiệu');
    push('global_block', globalBlocks, (r) => `/blocks/${r.id}`, 'Global block');
    push('setting', settings, () => '/settings', 'Cài đặt');
    push('user', users, (r) => `/users/${r.id}`, 'Người dùng');
    push('menu', menus, () => '/menus', 'Menu');
    return out;
  }

  // ---------------------------------------------------------------------------
  // Thùng rác
  // ---------------------------------------------------------------------------

  /**
   * Chuyển vào thùng rác (file giữ trên đĩa). Nếu có nơi đang dùng và không force -> 409 kèm danh sách.
   */
  async remove(ids: string[], opts: { force?: boolean; userId?: string } = {}) {
    const rows = await this.prisma.media.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, originalName: true } });
    if (!rows.length) return { deleted: 0 };
    if (!opts.force) {
      const usages: Record<string, MediaUsage[]> = {};
      for (const r of rows) {
        const u = await this.usage(r.id);
        if (u.length) usages[r.id] = u;
      }
      if (Object.keys(usages).length) {
        throw new ConflictException({
          statusCode: 409,
          message: 'File đang được sử dụng. Thêm force=1 để vẫn chuyển vào thùng rác.',
          error: 'MediaInUse',
          usage: usages,
        });
      }
    }
    const idList = rows.map((r) => r.id);
    await this.prisma.media.updateMany({ where: { id: { in: idList } }, data: { deletedAt: new Date() } });
    this.changed();
    for (const r of rows) this.activity(opts.userId, 'media.trash', r.id, { name: r.originalName, force: !!opts.force });
    return { deleted: rows.length };
  }

  async restore(ids: string[], userId?: string) {
    const rows = await this.prisma.media.findMany({ where: { id: { in: ids }, deletedAt: { not: null } }, select: { id: true, originalName: true } });
    if (!rows.length) return { restored: 0 };
    await this.prisma.media.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: null } });
    this.changed();
    for (const r of rows) this.activity(userId, 'media.restore', r.id, { name: r.originalName });
    return { restored: rows.length };
  }

  /** Xoá vĩnh viễn (file + variants) — chỉ với bản ghi đã nằm trong thùng rác */
  async destroy(ids: string[], userId?: string) {
    const rows = await this.prisma.media.findMany({ where: { id: { in: ids }, deletedAt: { not: null } } });
    return this.purge(rows, userId);
  }

  async emptyTrash(userId?: string) {
    const rows = await this.prisma.media.findMany({ where: { deletedAt: { not: null } } });
    return this.purge(rows, userId);
  }

  private async purge(rows: Media[], userId?: string) {
    if (!rows.length) return { destroyed: 0 };
    for (const m of rows) await this.deleteFiles(m);
    await this.prisma.media.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    this.changed();
    for (const r of rows) this.activity(userId, 'media.destroy', r.id, { name: r.originalName, path: r.path });
    return { destroyed: rows.length };
  }

  /** Dọn thùng rác: xoá vĩnh viễn file đã nằm trong thùng rác quá 30 ngày (chạy 3h sáng mỗi ngày) */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredTrash() {
    if (process.env.NODE_ENV === 'test') return;
    const before = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.media.findMany({ where: { deletedAt: { lt: before } } });
    if (!rows.length) return;
    const res = await this.purge(rows);
    this.logger.log(`Đã dọn ${res.destroyed} file trong thùng rác quá ${TRASH_RETENTION_DAYS} ngày`);
  }

  // ---------------------------------------------------------------------------
  // Thư mục (cây lồng nhau)
  // ---------------------------------------------------------------------------

  /** Danh sách phẳng kèm parentId + số file (không tính thùng rác); admin tự dựng cây */
  async folders() {
    const rows = await this.prisma.mediaFolder.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { media: { where: { deletedAt: null } }, children: true } } } });
    return rows.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, createdAt: f.createdAt, _count: { media: f._count.media, children: f._count.children } }));
  }

  async createFolder(name: string, parentId?: string | null) {
    name = name.trim();
    if (!name) throw new BadRequestException('Tên thư mục không được để trống');
    if (parentId) await this.prisma.mediaFolder.findUniqueOrThrow({ where: { id: parentId } });
    return this.prisma.mediaFolder.create({ data: { name, parentId: parentId || null } });
  }

  /** Đổi tên và/hoặc di chuyển thư mục (parentId: null = lên gốc) */
  async updateFolder(id: string, data: { name?: string; parentId?: string | null }) {
    const patch: Prisma.MediaFolderUpdateInput = {};
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Tên thư mục không được để trống');
      patch.name = name;
    }
    if (data.parentId !== undefined) {
      const parentId = data.parentId || null;
      if (parentId === id) throw new BadRequestException('Không thể chuyển thư mục vào chính nó');
      if (parentId) {
        const descendants = await this.descendantIds(id);
        if (descendants.has(parentId)) throw new BadRequestException('Không thể chuyển thư mục vào thư mục con của nó');
        await this.prisma.mediaFolder.findUniqueOrThrow({ where: { id: parentId } });
      }
      patch.parent = parentId ? { connect: { id: parentId } } : { disconnect: true };
    }
    return this.prisma.mediaFolder.update({ where: { id }, data: patch });
  }

  /** Giữ tương thích: đổi tên thư mục */
  renameFolder(id: string, name: string) {
    return this.updateFolder(id, { name });
  }

  /** Xoá thư mục: file và thư mục con được chuyển lên thư mục cha (không mất dữ liệu) */
  async removeFolder(id: string) {
    const folder = await this.prisma.mediaFolder.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction([
      this.prisma.media.updateMany({ where: { folderId: id }, data: { folderId: folder.parentId } }),
      this.prisma.mediaFolder.updateMany({ where: { parentId: id }, data: { parentId: folder.parentId } }),
      this.prisma.mediaFolder.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  private async descendantIds(id: string) {
    const all = await this.prisma.mediaFolder.findMany({ select: { id: true, parentId: true } });
    const byParent = new Map<string | null, string[]>();
    for (const f of all) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f.id]);
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of byParent.get(cur) ?? []) if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Thống kê
  // ---------------------------------------------------------------------------

  async stats() {
    const sum = (where: Prisma.MediaWhereInput) => this.prisma.media.aggregate({ where, _count: true, _sum: { size: true } });
    const live: Prisma.MediaWhereInput = { deletedAt: null };
    const [all, images, videos, trash, folders] = await Promise.all([
      sum(live),
      sum({ ...live, mimeType: { startsWith: 'image/' } }),
      sum({ ...live, mimeType: { startsWith: 'video/' } }),
      sum({ deletedAt: { not: null } }),
      this.prisma.mediaFolder.count(),
    ]);
    const pick = (a: { _count: number; _sum: { size: number | null } }) => ({ count: a._count, size: a._sum.size ?? 0 });
    const image = pick(images);
    const video = pick(videos);
    const total = pick(all);
    return {
      count: total.count,
      totalSize: total.size,
      folders,
      trash: pick(trash),
      byType: { image, video, document: { count: total.count - image.count - video.count, size: total.size - image.size - video.size } },
    };
  }
}
