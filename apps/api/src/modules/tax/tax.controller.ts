import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { TaxService } from './tax.service.js';
import { PreviewTaxDto, SaveTaxRateDto } from './tax.dto.js';

/** Bảng thuế suất theo lớp thuế + vùng (dùng khi commerce.taxMode = "rates") */
/** Quyền khai báo theo từng route (guard gộp quyền class + method nên không đặt ở class) */
@Controller('admin/tax-rates')
export class TaxRatesController {
  constructor(private readonly tax: TaxService) {}

  @RequirePermissions('settings.tax')
  @Get()
  list() {
    return this.tax.list();
  }

  /** Danh sách lớp thuế đang dùng (gợi ý cho form sản phẩm / thuế suất) */
  @Get('classes')
  @RequirePermissions('products.read')
  classes() {
    return this.tax.classes();
  }

  /** Thử tính thuế theo cài đặt hiện tại: { taxClass?, country?, province?, amount, shipping? } */
  @RequirePermissions('settings.tax')
  @Post('preview')
  preview(@Body() dto: PreviewTaxDto) {
    return this.tax.preview(dto);
  }

  @RequirePermissions('settings.tax')
  @Post()
  create(@Body() dto: SaveTaxRateDto, @CurrentUser() user: AuthUser) {
    return this.tax.create(dto, user.id);
  }

  @RequirePermissions('settings.tax')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTaxRateDto, @CurrentUser() user: AuthUser) {
    return this.tax.update(id, dto, user.id);
  }

  @RequirePermissions('settings.tax')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.tax.remove(id, user.id);
  }
}
