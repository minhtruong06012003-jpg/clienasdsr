import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { CUSTOM_FIELD_ENTITIES, type CustomFieldEntity } from '@cmsnt/shared';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { ApplyPresetDto, FieldGroupQueryDto, ImportFieldGroupsDto, ReorderFieldGroupsDto, SaveFieldGroupDto } from './custom-fields.dto.js';

class ExportDto {
  @IsOptional() @IsArray() @IsString({ each: true }) ids?: string[];
}

/** Query lấy nhóm áp dụng cho một bản ghi đang soạn (admin) */
class ForEntityQueryDto {
  @IsIn(CUSTOM_FIELD_ENTITIES) entity: CustomFieldEntity;
  @IsOptional() @IsString() template?: string;
  /** danh sách id danh mục, cách nhau dấu phẩy */
  @IsOptional() @IsString() categoryIds?: string;
  @IsOptional() @IsString() productType?: string;
  @IsOptional() @IsString() roleSlug?: string;
  /** entry: key loại nội dung */
  @IsOptional() @IsString() contentType?: string;
  /** term: key taxonomy */
  @IsOptional() @IsString() taxonomy?: string;
}

/**
 * Quản trị nhóm trường tuỳ chỉnh (quyền fields.manage) + endpoint lấy form cho trang soạn thảo
 * (chỉ cần đăng nhập admin: người có quyền sửa nội dung cần thấy trường để nhập).
 */
@Controller('admin/custom-fields')
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  // ---- cho trang soạn thảo nội dung (mọi người dùng admin) ----
  @RequirePermissions('admin.access')
  @Get('for')
  forEntity(@Query() q: ForEntityQueryDto) {
    return this.service.groupsFor(q.entity, { template: q.template, categoryIds: q.categoryIds ? q.categoryIds.split(',').filter(Boolean) : undefined, productType: q.productType, roleSlug: q.roleSlug, contentType: q.contentType, taxonomy: q.taxonomy });
  }

  /** Mọi nhóm đang bật của entity (admin tự lọc rules phía client để đổi danh mục không cần gọi lại) */
  @RequirePermissions('admin.access')
  @Get('active')
  active(@Query() q: FieldGroupQueryDto) {
    return q.entity ? this.service.groups(q.entity) : [];
  }

  // ---- quản lý nhóm ----
  @RequirePermissions('fields.manage')
  @Get('groups')
  list(@Query() q: FieldGroupQueryDto) {
    return this.service.listAdmin(q.entity);
  }

  @RequirePermissions('fields.manage')
  @Get('presets')
  presets() {
    return this.service.presets();
  }

  @RequirePermissions('fields.manage')
  @Post('presets/apply')
  applyPreset(@Body() dto: ApplyPresetDto, @CurrentUser() user: AuthUser) {
    return this.service.applyPreset(dto.preset, dto.overwrite, user);
  }

  @RequirePermissions('fields.manage')
  @Post('export')
  export(@Body() dto: ExportDto) {
    return this.service.export(dto.ids);
  }

  @RequirePermissions('fields.manage')
  @Post('import')
  import(@Body() dto: ImportFieldGroupsDto, @CurrentUser() user: AuthUser) {
    return this.service.import(dto, user);
  }

  @RequirePermissions('fields.manage')
  @Post('groups/reorder')
  reorder(@Body() dto: ReorderFieldGroupsDto, @CurrentUser() user: AuthUser) {
    return this.service.reorder(dto.items, user);
  }

  @RequirePermissions('fields.manage')
  @Get('groups/:id')
  get(@Param('id') id: string) {
    return this.service.getAdmin(id);
  }

  @RequirePermissions('fields.manage')
  @Post('groups')
  create(@Body() dto: SaveFieldGroupDto, @CurrentUser() user: AuthUser) {
    return this.service.save(undefined, dto, user);
  }

  @RequirePermissions('fields.manage')
  @Patch('groups/:id')
  update(@Param('id') id: string, @Body() dto: SaveFieldGroupDto, @CurrentUser() user: AuthUser) {
    return this.service.save(id, dto, user);
  }

  @RequirePermissions('fields.manage')
  @Post('groups/:id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.duplicate(id, user);
  }

  @RequirePermissions('fields.manage')
  @Delete('groups/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }
}

/** Định nghĩa nhóm trường công khai (nhãn, loại) để theme / app ngoài render động */
@Controller('public')
export class PublicCustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Public()
  @Get('field-groups')
  async groups(@Query() q: FieldGroupQueryDto) {
    const entities = q.entity ? [q.entity] : [...CUSTOM_FIELD_ENTITIES].filter((e) => e !== 'user');
    const out = [];
    for (const entity of entities) {
      for (const g of await this.service.groups(entity)) {
        const fields = g.fields.filter((f) => f.public !== false);
        if (!fields.length) continue;
        out.push({ entity, key: g.key, name: g.name, placement: g.placement ?? 'main', rules: g.rules ?? {}, fields: fields.map(({ public: _p, help: _h, placeholder: _ph, ...f }) => ({ ...f, fields: f.fields?.filter((s) => s.public !== false).map(({ public: _p2, ...s }) => s) })) });
      }
    }
    return out;
  }
}
