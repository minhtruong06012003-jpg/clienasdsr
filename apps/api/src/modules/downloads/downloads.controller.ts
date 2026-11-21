import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { DownloadsService } from './downloads.service.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

class RegrantDto {
  /** số ngày kể từ bây giờ; null = vĩnh viễn; bỏ trống = theo cấu hình của sản phẩm */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) expiryDays?: number | null;
  @IsOptional() @IsBoolean() resetCount?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) downloadLimit?: number | null;
}

/** Body tra cứu file của đơn cho khách vãng lai: SĐT đặt hàng (gửi trong body, không nằm trên URL) */
class GuestDownloadsDto {
  @IsString() @MaxLength(30) phone: string;
}

/** Tên file cho Content-Disposition: bản ASCII dự phòng + bản UTF-8 (giữ tiếng Việt) */
function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller()
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  /**
   * Tải file theo token (gửi trong email / trang tài khoản). Tăng lượt tải, kiểm tra hạn.
   * Dùng @Res() trực tiếp để SerializeInterceptor không bọc buffer thành JSON.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequireFeature('shop')
  @Get('public/downloads/:token')
  async download(@Param('token') token: string, @Res() res: Response) {
    const result = await this.downloads.consume(token);
    if (result.kind === 'redirect') return res.redirect(302, result.url);
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(result.buffer.length));
    res.setHeader('Content-Disposition', contentDisposition(result.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(result.buffer);
  }

  /**
   * Khách vãng lai: file của đơn đã thanh toán, xác thực bằng SĐT đặt hàng (như tra cứu đơn).
   * SĐT gửi trong body -> không lộ trong URL / access log / lịch sử trình duyệt. 20 lần/phút/IP.
   * Cache-Control `private, no-store` do PublicCacheInterceptor gắn cho mọi request ghi dưới /api/public.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequireFeature('shop')
  @Post('public/orders/:code/downloads')
  @HttpCode(200)
  guestPost(@Param('code') code: string, @Body() dto: GuestDownloadsDto) {
    return this.downloads.guestDownloads(code ?? '', (dto.phone ?? '').trim());
  }

  /**
   * @deprecated Bản cũ, SĐT nằm trên query (`?phone=`). Giữ để tương thích, dùng `POST public/orders/:code/downloads`.
   * Trả thêm header `Deprecation: true` để frontend/nhà tích hợp nhận biết.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequireFeature('shop')
  @Get('public/orders/:code/downloads')
  @Header('Deprecation', 'true')
  @ApiOperation({ deprecated: true, summary: 'Đã thay bằng POST /api/public/orders/:code/downloads (SĐT trong body)' })
  guest(@Param('code') code: string, @Query('phone') phone?: string) {
    return this.downloads.guestDownloads(code ?? '', (phone ?? '').trim());
  }

  /** Thành viên: toàn bộ file của các đơn đã thanh toán */
  @RequireFeature('shop', 'accounts')
  @Get('account/downloads')
  mine(@CurrentUser() user: AuthUser) {
    return this.downloads.myDownloads(user.id);
  }

  /** Thành viên: file của một đơn */
  @RequireFeature('shop', 'accounts')
  @Get('account/orders/:code/downloads')
  mineByOrder(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.downloads.myOrderDownloads(user.id, code);
  }

  // ---- admin (tách khỏi orders controller) ----

  @RequirePermissions('orders.read')
  @Get('admin/downloads/by-order/:id')
  byOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.downloads.listForOrder(id);
  }

  /** Cấp lại / gia hạn / đặt lại lượt tải cho đơn */
  @RequirePermissions('orders.write')
  @Post('admin/downloads/by-order/:id/regrant')
  regrant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RegrantDto, @CurrentUser() user: AuthUser) {
    return this.downloads.regrant(id, dto, user.id);
  }
}
