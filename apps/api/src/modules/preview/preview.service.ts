import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hasPermission, localePrefix } from '@cmsnt/shared';
import { LanguagesService } from '../languages/languages.service.js';
import { PagesService } from '../pages/pages.service.js';
import { PostsService } from '../posts/posts.service.js';
import { ProductsService } from '../products/products.service.js';
import { ContentPublicService } from '../content/content-public.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { frontendBaseUrl } from '../../common/utils/frontend-url.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';

export const PREVIEW_TYPES = ['page', 'post', 'product', 'entry'] as const;
export type PreviewType = (typeof PREVIEW_TYPES)[number];

/** Quyền xem cần có theo loại nội dung */
const READ_PERMISSION: Record<PreviewType, string> = { page: 'pages.read', post: 'posts.read', product: 'products.read', entry: 'entries.read' };

/** Token xem trước sống 30 phút */
const PREVIEW_TTL = '30m';

interface PreviewPayload {
  purpose: 'preview';
  type: PreviewType;
  id: string;
  locale: string;
  sub: string;
}

/**
 * Xem trước bản nháp: admin xin token ngắn hạn (ký bằng JWT_ACCESS_SECRET, purpose = 'preview'),
 * frontend riêng của dự án gọi GET /public/preview/:type/:id?token= để lấy dữ liệu kể cả khi chưa xuất bản.
 * Link xem trước trỏ về frontend nên bắt buộc đã cấu hình địa chỉ website (WEB_URL hoặc Cài đặt › Chung).
 */
@Injectable()
export class PreviewService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly languages: LanguagesService,
    private readonly pages: PagesService,
    private readonly posts: PostsService,
    private readonly products: ProductsService,
    private readonly content: ContentPublicService,
    private readonly settings: SettingsService,
  ) {}

  async createToken(user: AuthUser, type: PreviewType, id: string, localeInput?: string) {
    if (!hasPermission(user.permissions, READ_PERMISSION[type])) throw new ForbiddenException('Bạn không có quyền xem nội dung này');
    // chưa có frontend thì không có trang nào để xem trước -> báo rõ cho admin thay vì trả URL tương đối (mở ra 404)
    const webUrl = await frontendBaseUrl(this.config, this.settings);
    if (!webUrl) throw new BadRequestException('Chưa cấu hình địa chỉ website (Cài đặt › Chung › Địa chỉ website hoặc biến WEB_URL) nên không mở được trang xem trước');
    const locale = await this.languages.resolve(localeInput);
    const defaultLocale = await this.languages.defaultLocale();
    const payload: PreviewPayload = { purpose: 'preview', type, id, locale, sub: user.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: PREVIEW_TTL });
    const url = `${webUrl}${localePrefix(locale, defaultLocale)}/preview/${type}/${id}?token=${encodeURIComponent(token)}`;
    return { url, token, locale, expiresIn: PREVIEW_TTL };
  }

  async resolve(type: string, id: string, token: string | undefined, localeInput?: string) {
    if (!PREVIEW_TYPES.includes(type as PreviewType)) throw new BadRequestException('Loại nội dung không hợp lệ');
    if (!token) throw new UnauthorizedException('Thiếu token xem trước');
    let payload: PreviewPayload;
    try {
      payload = await this.jwt.verifyAsync<PreviewPayload>(token);
    } catch {
      throw new UnauthorizedException('Liên kết xem trước không hợp lệ hoặc đã hết hạn');
    }
    if (payload.purpose !== 'preview' || payload.type !== type || payload.id !== id) throw new UnauthorizedException('Token xem trước không khớp nội dung');
    const locale = localeInput || payload.locale;
    const data =
      type === 'page'
        ? await this.pages.publicById(id, locale, true)
        : type === 'post'
          ? await this.posts.publicById(id, locale, true)
          : type === 'product'
            ? await this.products.publicById(id, locale, true)
            : // bài của loại nội dung tuỳ biến: frontend dựng theo data.type / data.contentType
              await this.content.publicById(id, locale, true);
    return { ...(data as Record<string, unknown>), preview: true };
  }
}
