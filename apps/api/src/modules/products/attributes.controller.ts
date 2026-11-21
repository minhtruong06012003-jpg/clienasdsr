import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { ProductAttributesService } from './attributes.service.js';
import { SaveAttributeDto } from './attributes.dto.js';

class ReorderAttributesDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
}

/** Quản lý thuộc tính dùng chung (Sản phẩm › Thuộc tính). Xem: products.read; sửa: products.taxonomy */
@Controller('admin/product-attributes')
export class ProductAttributesController {
  constructor(private readonly attributes: ProductAttributesService) {}

  @RequirePermissions('products.read')
  @Get()
  list() {
    return this.attributes.list();
  }

  /** { [key]: số sản phẩm đang dùng } */
  @RequirePermissions('products.read')
  @Get('usage')
  usage() {
    return this.attributes.usage();
  }

  @RequirePermissions('products.taxonomy')
  @Post('reorder')
  reorder(@Body() dto: ReorderAttributesDto) {
    return this.attributes.reorder(dto.ids);
  }

  @RequirePermissions('products.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.attributes.get(id);
  }

  @RequirePermissions('products.taxonomy')
  @Post()
  create(@Body() dto: SaveAttributeDto, @CurrentUser() user: AuthUser) {
    return this.attributes.create(dto, user.id);
  }

  @RequirePermissions('products.taxonomy')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveAttributeDto, @CurrentUser() user: AuthUser) {
    return this.attributes.update(id, dto, user.id);
  }

  @RequirePermissions('products.taxonomy')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.attributes.remove(id, user.id);
  }
}

/** Storefront: định nghĩa thuộc tính (swatch ở trang sản phẩm, bộ lọc ở trang danh sách) */
@Controller('public/product-attributes')
@RequireFeature('shop')
export class PublicProductAttributesController {
  constructor(private readonly attributes: ProductAttributesService) {}

  /** ?filterable=1 -> chỉ thuộc tính dùng làm bộ lọc */
  @Public()
  @Get()
  list(@Query('filterable') filterable?: string) {
    return this.attributes.publicList(filterable === '1' || filterable === 'true');
  }
}
