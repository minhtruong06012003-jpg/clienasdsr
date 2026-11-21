import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';

export interface ContentChangedEvent {
  type: string;
  id?: string;
  /** Cache tag của frontend riêng (nếu có) cần làm mới, vd ['pages', 'page:abc'] */
  tags?: string[];
}

/**
 * Toàn bộ tag cache gốc mà API phát ra trong sự kiện `content.changed` — dùng khi "Xoá cache" từ admin
 * và khi khôi phục bản sao lưu. Lập từ mọi `tags: [...]` trong apps/api (grep "content.changed"); thêm tag mới
 * ở đâu thì bổ sung vào đây. Tag con có id (`page:<id>`, `post:<id>`, `product:<id>`, `entry:<id>`,
 * `entries:<type>`, `terms:<taxonomy>`, `block:<key>`, `media:<id>`) được làm mới qua tag gốc tương ứng.
 */
export const ALL_CACHE_TAGS = [
  'pages', 'posts', 'products', 'settings', 'menus', 'languages', 'blocks', 'media', 'reviews', 'sitemap',
  // danh mục / thuộc tính / bình luận / trường tuỳ chỉnh
  'post-categories', 'product-categories', 'product-attributes', 'comments', 'custom-fields',
  // loại nội dung tuỳ biến
  'entries', 'terms', 'content-types', 'bootstrap', 'theme-templates', 'redirects', 'field-groups',
];

/**
 * Khi nội dung thay đổi -> gọi `<frontend riêng (nếu có)>/api/revalidate` để làm mới cache ISR.
 * Frontend là tuỳ chọn (Panel không kèm website khách): chưa cấu hình WEB_URL/WEB_INTERNAL_URL + REVALIDATE_SECRET
 * thì không gửi gì và không ghi lỗi.
 */
@Injectable()
export class RevalidateListener {
  private readonly logger = new Logger('Revalidate');
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {}

  @OnEvent('content.changed')
  onChanged(e: ContentChangedEvent) {
    for (const tag of e.tags ?? [e.type]) this.pending.add(tag);
    if (this.timer) return;
    // gom nhiều thay đổi liên tiếp thành 1 request
    this.timer = setTimeout(() => void this.flush(), 500);
  }

  private async flush() {
    const tags = [...this.pending];
    this.pending.clear();
    this.timer = null;
    // chưa cấu hình frontend -> bỏ qua hoàn toàn (không phải lỗi)
    if (!this.configured()) return;
    const r = await this.send(tags);
    if (!r.ok && r.error) this.logger.debug(`Không gọi được revalidate: ${r.error}`);
  }

  /** Đã cấu hình frontend riêng để nhận revalidate chưa */
  configured(): boolean {
    return !!this.config.get<string>('web.internalUrl') && !!this.config.get<string>('web.revalidateSecret');
  }

  /**
   * Gọi frontend riêng (nếu có) revalidate ngay (không gom), trả kết quả để hiển thị cho admin.
   * Chưa cấu hình -> `ok: false` không có `status`, `error` chứa "Chưa cấu hình": admin (Công cụ › Cache) nhận
   * diện câu này để chỉ báo "Đã xoá cache API", không coi là lỗi. Không ghi log.
   */
  async send(tags: string[]): Promise<{ ok: boolean; tags: string[]; error?: string; status?: number }> {
    const url = this.config.get<string>('web.internalUrl');
    const secret = this.config.get<string>('web.revalidateSecret');
    if (!tags.length) return { ok: true, tags };
    if (!url || !secret) return { ok: false, tags, error: 'Chưa cấu hình frontend riêng (WEB_URL/WEB_INTERNAL_URL + REVALIDATE_SECRET) — không cần làm mới' };
    try {
      const res = await fetch(`${url}/api/revalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, tags }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true, tags, status: res.status } : { ok: false, tags, status: res.status, error: `Frontend trả về HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, tags, error: (err as Error).message };
    }
  }

  /** Làm mới toàn bộ cache của frontend riêng (nếu có) */
  revalidateAll() {
    return this.send(ALL_CACHE_TAGS);
  }
}

@Module({ providers: [RevalidateListener], exports: [RevalidateListener] })
export class EventsModule {}
