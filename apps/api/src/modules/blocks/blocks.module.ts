import { Body, Controller, Delete, Get, Global, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { cleanBlocksFor } from '../../common/utils/sanitize-html.js';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { LanguagesService } from '../languages/languages.service.js';
import { BlockResolverService } from './block-resolver.service.js';
import { TemplateContextService } from '../theme-templates/template-context.service.js';

class BlockTranslationDto {
  @IsString() locale: string;
  @IsArray() blocks: unknown[];
}

class SaveGlobalBlockDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-_]*$/, { message: 'Key chỉ gồm chữ thường, số, - và _' }) key: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockTranslationDto) translations: BlockTranslationDto[];
}

/** Ngữ cảnh xem trước block động trong builder: bản ghi mẫu theo target (không id → bản mới nhất) */
class ResolveContextDto {
  @IsString() @MaxLength(80) target: string;
  @IsOptional() @IsString() @MaxLength(80) id?: string;
  @IsOptional() @IsString() @MaxLength(20) kind?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

class ResolveDto {
  @IsArray() blocks: unknown[];
  @IsOptional() @IsString() locale?: string;
  @IsOptional() @ValidateNested() @Type(() => ResolveContextDto) context?: ResolveContextDto;
}

@Injectable()
export class GlobalBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly resolver: BlockResolverService,
    private readonly events: EventEmitter2,
  ) {}

  async list(q: PaginationQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' as const } }, { key: { contains: q.search, mode: 'insensitive' as const } }] } : {};
    const [data, total] = await Promise.all([
      this.prisma.globalBlock.findMany({ where, skip, take, orderBy: { updatedAt: 'desc' }, include: { translations: { select: { locale: true } } } }),
      this.prisma.globalBlock.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  get(id: string) {
    return this.prisma.globalBlock.findUniqueOrThrow({ where: { id }, include: { translations: true } });
  }

  /**
   * `user`: người lưu — không có quyền "content.unfiltered_html" thì block (richtext, HTML tuỳ chỉnh...) bị lọc XSS
   * trước khi lưu; không truyền (gọi nội bộ) -> luôn lọc.
   */
  async create(dto: SaveGlobalBlockDto, user?: AuthUser) {
    const codes = await this.languages.codes();
    const block = await this.prisma.globalBlock.create({
      data: {
        name: dto.name,
        key: dto.key,
        type: dto.type ?? 'section',
        isActive: dto.isActive ?? true,
        translations: { create: dto.translations.filter((t) => codes.includes(t.locale)).map((t) => ({ locale: t.locale, blocks: cleanBlocksFor(user, t.blocks) as object })) },
      },
    });
    this.changed(block.key);
    return this.get(block.id);
  }

  async update(id: string, dto: SaveGlobalBlockDto, user?: AuthUser) {
    const codes = await this.languages.codes();
    const old = await this.prisma.globalBlock.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction(async (tx) => {
      await tx.globalBlock.update({ where: { id }, data: { name: dto.name, key: dto.key, type: dto.type, isActive: dto.isActive } });
      for (const t of dto.translations.filter((x) => codes.includes(x.locale))) {
        const blocks = cleanBlocksFor(user, t.blocks) as object;
        await tx.globalBlockTranslation.upsert({
          where: { blockId_locale: { blockId: id, locale: t.locale } },
          create: { blockId: id, locale: t.locale, blocks },
          update: { blocks },
        });
      }
    });
    this.changed(old.key, dto.key);
    return this.get(id);
  }

  async duplicate(id: string, user?: AuthUser) {
    const src = await this.get(id);
    let key = `${src.key}-copy`;
    for (let i = 2; await this.prisma.globalBlock.findUnique({ where: { key } }); i++) key = `${src.key}-copy-${i}`;
    const block = await this.prisma.globalBlock.create({
      data: { name: `${src.name} (bản sao)`, key, type: src.type, isActive: false, translations: { create: src.translations.map((t) => ({ locale: t.locale, blocks: cleanBlocksFor(user, t.blocks) as object })) } },
    });
    return this.get(block.id);
  }

  async remove(id: string) {
    const b = await this.prisma.globalBlock.delete({ where: { id } });
    this.changed(b.key);
    return { success: true };
  }

  private changed(...keys: string[]) {
    // global block có thể được dùng trong mọi trang -> làm mới toàn bộ trang
    this.events.emit('content.changed', { type: 'block', tags: ['blocks', 'pages', ...keys.map((k) => `block:${k}`)] });
  }

  async publicByKey(key: string, locale?: string) {
    const loc = await this.languages.resolve(locale);
    const fallback = await this.languages.defaultLocale();
    const block = await this.prisma.globalBlock.findFirst({ where: { key, isActive: true }, include: { translations: true } });
    if (!block) throw new NotFoundException('Không tìm thấy block');
    const tr = block.translations.find((t) => t.locale === loc) ?? block.translations.find((t) => t.locale === fallback);
    return { key: block.key, name: block.name, type: block.type, locale: loc, blocks: await this.resolver.resolve(tr?.blocks ?? [], loc) };
  }
}

@Controller('admin/blocks')
export class GlobalBlocksController {
  constructor(
    private readonly blocks: GlobalBlocksService,
    private readonly resolver: BlockResolverService,
    private readonly templateData: TemplateContextService,
  ) {}

  /**
   * Canvas của page builder gọi để lấy dữ liệu động cho block.
   * Có `context` (Theme Builder) → dựng record/listing mẫu rồi gắn cho block động.
   */
  @RequirePermissions('admin.access')
  @Post('resolve')
  async resolve(@Body() dto: ResolveDto) {
    if (!dto.context?.target) return this.resolver.resolve(dto.blocks, dto.locale, 0, 'edit');
    const c = await this.templateData.build({ kind: dto.context.kind, target: dto.context.target, id: dto.context.id, q: dto.context.q, locale: dto.locale, admin: true });
    return this.resolver.resolve(dto.blocks, c.locale, 0, 'edit', {
      entity: c.record?.entity,
      record: c.record,
      listing: c.listing,
      page: c.page,
      customFields: c.record?.customFields,
      customFieldGroups: c.record?.customFieldGroups,
    });
  }

  @RequirePermissions('admin.access')
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.blocks.list(q);
  }

  @RequirePermissions('admin.access')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.get(id);
  }

  @RequirePermissions('blocks.manage')
  @Post()
  create(@Body() dto: SaveGlobalBlockDto, @CurrentUser() user: AuthUser) {
    return this.blocks.create(dto, user);
  }

  @RequirePermissions('blocks.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveGlobalBlockDto, @CurrentUser() user: AuthUser) {
    return this.blocks.update(id, dto, user);
  }

  @RequirePermissions('blocks.manage')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.blocks.duplicate(id, user);
  }

  @RequirePermissions('blocks.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.remove(id);
  }
}

@Controller('public/blocks')
export class PublicBlocksController {
  constructor(private readonly blocks: GlobalBlocksService) {}

  @Public()
  @Get(':key')
  get(@Param('key') key: string, @Query('locale') locale?: string) {
    return this.blocks.publicByKey(key, locale);
  }
}

@Global()
@Module({
  controllers: [GlobalBlocksController, PublicBlocksController],
  // TemplateContextService (thuộc Theme Builder) đặt ở module global này để resolver, theme-templates
  // và menus cùng dùng mà không tạo vòng phụ thuộc giữa các module
  providers: [GlobalBlocksService, BlockResolverService, TemplateContextService],
  exports: [BlockResolverService, GlobalBlocksService, TemplateContextService],
})
export class BlocksModule {}
