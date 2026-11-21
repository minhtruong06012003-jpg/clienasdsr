import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { parseCfQuery } from '../custom-fields/cf-query.util.js';
import { parseAttrQuery } from './attributes.filter.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ReorderDto } from '../../common/dto/reorder.dto.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { SaveTermDto } from '../posts/posts.dto.js';
import { ProductsService } from './products.service.js';
import { ProductCategoriesService } from './product-categories.service.js';
import { ProductsCsvService } from './products-csv.service.js';
import { ProductQueryDto, PublicProductQueryDto, SaveBrandDto, SaveProductDto } from './products.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

const BULK = ['trash', 'restore', 'publish', 'draft', 'destroy', 'feature', 'unfeature'] as const;

class BulkDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn(BULK) action: (typeof BULK)[number];
}

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1' || value === 1;

class ImportDto {
  @IsOptional() @IsIn(['upsert', 'insert']) mode?: 'upsert' | 'insert';
  @IsOptional() @IsString() locale?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() dryRun?: boolean;
  @IsOptional() @Transform(toBool) @IsBoolean() createCategories?: boolean;
  @IsOptional() @Transform(toBool) @IsBoolean() downloadImages?: boolean;
}

const CSV_UPLOAD = { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } };

function sendCsv(res: Response, file: { filename: string; content: string }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.content);
}

@Controller('admin/products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: ProductCategoriesService,
    private readonly csv: ProductsCsvService,
  ) {}

  // ---- CSV (khai báo trước ':id') ----
  /** Xuất CSV theo bộ lọc hiện tại của danh sách (locale, status, categoryId, brandId, type, search, ids) */
  @RequirePermissions('products.write')
  @Get('export.csv')
  async exportCsv(@Query() q: ProductQueryDto, @Res() res: Response) {
    sendCsv(res, await this.csv.export(q));
  }

  @RequirePermissions('products.write')
  @Get('import-template.csv')
  async importTemplate(@Res() res: Response) {
    sendCsv(res, await this.csv.template());
  }

  /** multipart: file + mode=upsert|insert + locale + dryRun=1 + createCategories=1 + downloadImages=1 */
  @RequirePermissions('products.write')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', CSV_UPLOAD))
  importCsv(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ImportDto, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('Vui lòng chọn file CSV');
    return this.csv.import(file.buffer, { mode: dto.mode ?? 'upsert', locale: dto.locale, dryRun: !!dto.dryRun, createCategories: !!dto.createCategories, downloadImages: !!dto.downloadImages }, user);
  }

  // ---- categories ----
  @RequirePermissions('products.read')
  @Get('categories')
  categoryList() {
    return this.categories.list();
  }

  @RequirePermissions('products.taxonomy')
  @Post('categories')
  createCategory(@Body() dto: SaveTermDto, @CurrentUser() user: AuthUser) {
    return this.categories.save(undefined, dto, user);
  }

  @RequirePermissions('products.taxonomy')
  @Post('categories/reorder')
  reorder(@Body() dto: ReorderDto) {
    return this.categories.reorder(dto.items);
  }

  @RequirePermissions('products.read')
  @Get('categories/:id')
  category(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(id);
  }

  @RequirePermissions('products.taxonomy')
  @Patch('categories/:id')
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTermDto, @CurrentUser() user: AuthUser) {
    return this.categories.save(id, dto, user);
  }

  @RequirePermissions('products.taxonomy')
  @Delete('categories/:id')
  removeCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(id);
  }

  // ---- brands ----
  @RequirePermissions('products.read')
  @Get('brands')
  brands() {
    return this.products.brands();
  }

  @RequirePermissions('products.taxonomy')
  @Post('brands')
  createBrand(@Body() dto: SaveBrandDto) {
    return this.products.saveBrand(undefined, dto);
  }

  @RequirePermissions('products.taxonomy')
  @Patch('brands/:id')
  updateBrand(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveBrandDto) {
    return this.products.saveBrand(id, dto);
  }

  @RequirePermissions('products.taxonomy')
  @Delete('brands/:id')
  removeBrand(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.removeBrand(id);
  }

  // ---- products ----
  @RequirePermissions('products.read')
  @Get()
  list(@Query() q: ProductQueryDto) {
    return this.products.list(q);
  }

  @RequirePermissions('products.write')
  @Post('bulk')
  bulk(@Body() dto: BulkDto, @CurrentUser() user: AuthUser) {
    return this.products.bulk(dto.ids, dto.action, user);
  }

  // ---- lịch sử phiên bản (khai báo 'revisions/:revisionId' trước ':id') ----
  @RequirePermissions('products.read')
  @Get('revisions/:revisionId')
  revision(@Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.products.revision(revisionId);
  }

  @RequirePermissions('products.read')
  @Get(':id/revisions')
  revisions(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.revisions(id);
  }

  @RequirePermissions('products.write')
  @Post(':id/revisions/:revisionId/restore')
  restoreRevision(@Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string, @CurrentUser() user: AuthUser) {
    return this.products.restoreRevision(id, revisionId, user);
  }

  // ---- thùng rác từng sản phẩm ----
  @RequirePermissions('products.delete')
  @Post(':id/trash')
  trash(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.products.trash(id, user);
  }

  @RequirePermissions('products.delete')
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.products.restore(id, user);
  }

  @RequirePermissions('products.delete')
  @Delete(':id')
  destroy(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.products.destroy(id, user);
  }

  @RequirePermissions('products.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(id);
  }

  @RequirePermissions('products.write')
  @Post()
  create(@Body() dto: SaveProductDto, @CurrentUser() user: AuthUser) {
    return this.products.save(undefined, dto, user);
  }

  @RequirePermissions('products.write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveProductDto, @CurrentUser() user: AuthUser) {
    return this.products.save(id, dto, user);
  }

  @RequirePermissions('products.write')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.products.duplicate(id, user);
  }

  @RequirePermissions('products.write')
  @Delete(':id/translations/:locale')
  removeTranslation(@Param('id', ParseUUIDPipe) id: string, @Param('locale') locale: string) {
    return this.products.removeTranslation(id, locale);
  }
}

@Controller('public')
@RequireFeature('shop')
export class PublicProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: ProductCategoriesService,
  ) {}

  @Public()
  @Get('products')
  list(@Query() q: PublicProductQueryDto, @Req() req: Request) {
    // lọc theo trường tuỳ chỉnh ?cf[key]=value (đọc từ query thô vì whitelist bỏ key lạ)
    // + lọc thuộc tính ?attr[color]=red,blue (đọc query thô)
    return this.products.publicList({ ...q, cf: parseCfQuery(req.query), attr: parseAttrQuery(req.query) });
  }

  @Public()
  @Get('products/:slug')
  get(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.products.publicBySlug(slug, locale);
  }

  @Public()
  @Get('product-categories')
  tree(@Query('locale') locale?: string) {
    return this.categories.publicTree(locale);
  }

  @Public()
  @Get('product-categories/:slug')
  category(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.categories.publicBySlug(slug, locale);
  }

  @Public()
  @Get('brands')
  brands() {
    return this.products.brands();
  }
}
