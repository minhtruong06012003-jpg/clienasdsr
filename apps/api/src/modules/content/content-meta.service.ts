import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { ContentTypeOrder, ContentTypeSupport, TypeLabels } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Loại nội dung đã đọc từ DB (dạng gọn để tra cứu nhanh) */
export interface TypeMeta {
  id: string;
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string | null;
  icon: string;
  supports: ContentTypeSupport[];
  isPublic: boolean;
  hasArchive: boolean;
  searchable: boolean;
  perPage: number;
  orderBy: ContentTypeOrder;
  listColumns: string[];
  source: string;
  isActive: boolean;
  sortOrder: number;
}

export interface TaxonomyMeta {
  id: string;
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string | null;
  hierarchical: boolean;
  contentTypes: string[];
  isPublic: boolean;
  showInFilter: boolean;
  source: string;
  sortOrder: number;
}

/**
 * Bộ nhớ đệm khai báo loại nội dung + taxonomy (ít đổi, đọc rất nhiều ở API công khai).
 * Xoá cache khi admin sửa (gọi clear()) hoặc khi có event `content.meta.changed` (vd bộ website mẫu).
 */
@Injectable()
export class ContentMetaService {
  private cache: { types: TypeMeta[]; taxonomies: TaxonomyMeta[]; at: number } | null = null;
  /** an toàn khi nhiều tiến trình: cache tự hết hạn sau 60 giây */
  private readonly ttl = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('content.meta.changed')
  clear() {
    this.cache = null;
  }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < this.ttl) return this.cache;
    const [types, taxonomies] = await Promise.all([
      this.prisma.contentType.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.taxonomy.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    this.cache = {
      at: Date.now(),
      types: types.map((t) => ({
        id: t.id,
        key: t.key,
        labels: (t.labels ?? {}) as TypeLabels,
        slugs: (t.slugs ?? {}) as Record<string, string>,
        description: t.description,
        icon: t.icon,
        supports: t.supports as ContentTypeSupport[],
        isPublic: t.isPublic,
        hasArchive: t.hasArchive,
        searchable: t.searchable,
        perPage: t.perPage,
        orderBy: t.orderBy as ContentTypeOrder,
        listColumns: t.listColumns,
        source: t.source,
        isActive: t.isActive,
        sortOrder: t.sortOrder,
      })),
      taxonomies: taxonomies.map((t) => ({
        id: t.id,
        key: t.key,
        labels: (t.labels ?? {}) as TypeLabels,
        slugs: (t.slugs ?? {}) as Record<string, string>,
        description: t.description,
        hierarchical: t.hierarchical,
        contentTypes: t.contentTypes,
        isPublic: t.isPublic,
        showInFilter: t.showInFilter,
        source: t.source,
        sortOrder: t.sortOrder,
      })),
    };
    return this.cache;
  }

  async types(): Promise<TypeMeta[]> {
    return (await this.load()).types;
  }

  async taxonomies(): Promise<TaxonomyMeta[]> {
    return (await this.load()).taxonomies;
  }

  async type(key: string): Promise<TypeMeta | undefined> {
    return (await this.types()).find((t) => t.key === key);
  }

  async typeById(id: string): Promise<TypeMeta | undefined> {
    return (await this.types()).find((t) => t.id === id);
  }

  async taxonomy(key: string): Promise<TaxonomyMeta | undefined> {
    return (await this.taxonomies()).find((t) => t.key === key);
  }

  /** key các taxonomy gắn với một loại */
  async taxonomiesOf(typeKey: string): Promise<TaxonomyMeta[]> {
    return (await this.taxonomies()).filter((t) => t.contentTypes.includes(typeKey));
  }
}
