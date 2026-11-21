import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PREVIEW_TYPES, PreviewService, type PreviewType } from './preview.service.js';

class PreviewTokenDto {
  @IsIn(PREVIEW_TYPES) type: PreviewType;
  @IsUUID() id: string;
  @IsOptional() @IsString() locale?: string;
}

/** Admin xin token xem trước (quyền pages.read / posts.read / products.read / entries.read kiểm tra trong service theo type) */
@Controller('admin/preview')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Post('token')
  token(@Body() dto: PreviewTokenDto, @CurrentUser() user: AuthUser) {
    return this.preview.createToken(user, dto.type, dto.id, dto.locale);
  }
}

@Controller('public/preview')
export class PublicPreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Public()
  @Get(':type/:id')
  get(@Param('type') type: string, @Param('id', ParseUUIDPipe) id: string, @Query('token') token?: string, @Query('locale') locale?: string) {
    return this.preview.resolve(type, id, token, locale);
  }
}
