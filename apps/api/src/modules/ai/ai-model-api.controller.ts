import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { trustedClientIp } from '../../common/utils/client-ip.js';
import { AiModelApiService } from './ai-model-api.service.js';
import { CATEGORY_KEY } from './ai.dto.js';

/** Lọc danh mục model */
class ModelQueryDto {
  @IsOptional() @Matches(CATEGORY_KEY) type?: string;
  @IsOptional() @IsIn(['image', 'video', 'audio', 'text']) output?: string;
  @IsOptional() @IsString() @MaxLength(20) server?: string;
  @IsOptional() @IsIn(['healthy', 'maintenance', 'all']) status?: 'healthy' | 'maintenance' | 'all';
  @IsOptional() @IsString() @MaxLength(130) canonical_model?: string;
}

/** Lọc lịch sử tác vụ của API `/v1` */
class GenerationQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['queued', 'processing', 'succeeded', 'failed', 'cancelled']) declare status?: string;
  @IsOptional() @IsString() @MaxLength(130) model?: string;
}

/** Admin đặt mã model API (để trống = sinh tự động) */
class SetApiModelDto {
  @IsOptional() @IsString() @MaxLength(130) apiModel?: string | null;
}

/** Body phải là object JSON (tham số kiểm tra chi tiết theo từng model trong service) */
const asBody = (b: unknown) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequestException('Body phải là object JSON, vd { "model": "...", "prompt": "..." }');
  return b as Record<string, unknown>;
};

/** Mã model có thể chứa dấu `/` (vd `kling-2.6/image-to-video`) nên route dùng wildcard, Express 5 trả mảng đoạn đường dẫn */
const joinId = (v: string | string[]) => (Array.isArray(v) ? v.join('/') : v);

/**
 * API khách theo model chuẩn (`/api/v1`): gọi bằng tên model gốc + tham số chuẩn, xác thực bằng API key như các API AI Studio khác.
 * Danh mục model công khai (không cần key); tạo / xem tác vụ cần key, tiền trừ vào số dư ví.
 */
@Controller('v1')
export class AiModelApiController {
  constructor(private readonly api: AiModelApiService) {}

  @Public()
  @Get('models')
  models(@Query() q: ModelQueryDto) {
    return this.api.listModels(q);
  }

  /** Danh mục gộp chuẩn `Model -> Server (SV1..SV15+)` để đối tác tra cứu model -> check SV sống -> confirm */
  @Public()
  @Get('models/groups')
  modelGroups(@Query() q: ModelQueryDto) {
    return this.api.listModelGroups(q);
  }

  @Public()
  @Get('models/*id')
  model(@Param('id') id: string | string[], @Query() q: ModelQueryDto) {
    const joined = joinId(id);
    if (joined === 'groups') return this.api.listModelGroups(q);
    if (joined.endsWith('/servers') && joined.length > '/servers'.length) {
      return this.api.getModelServers(joined.slice(0, -'/servers'.length));
    }
    return this.api.getModel(joined);
  }

  /** Báo giá (đặt trước `generations/:id` để không bị hiểu là mã tác vụ) */
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('generations/estimate')
  @HttpCode(200)
  estimate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.api.estimate(user, asBody(body));
  }

  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('generations')
  @HttpCode(200)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.api.create(user, asBody(body), trustedClientIp(req));
  }

  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @Get('generations')
  list(@CurrentUser() user: AuthUser, @Query() q: GenerationQueryDto) {
    return this.api.list(user, q);
  }

  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @Get('generations/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.api.get(user, id);
  }
}

/** Admin: xem / đổi mã model API của công cụ */
@Controller('admin/ai/api-models')
export class AdminAiModelApiController {
  constructor(private readonly api: AiModelApiService) {}

  @RequirePermissions('ai.tools')
  @Get()
  list() {
    return this.api.adminApiModels();
  }

  @RequirePermissions('ai.tools')
  @Put(':key')
  set(@Param('key') key: string, @Body() dto: SetApiModelDto) {
    return this.api.setApiModel(key, dto.apiModel);
  }
}
