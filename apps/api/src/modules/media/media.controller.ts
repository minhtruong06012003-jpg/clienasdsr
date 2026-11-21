import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { memoryStorage } from 'multer';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { MediaService } from './media.service.js';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1' || value === 1;

class MediaQuery extends PaginationQueryDto {
  @IsOptional() @Matches(/^(root|[0-9a-f-]{36})$/i) folderId?: string;
  @IsOptional() @IsIn(['image', 'video', 'document', 'all']) type?: string;
  /** trashed=1 -> chỉ xem file trong thùng rác (mặc định ẩn) */
  @IsOptional() @Transform(toBool) @IsBoolean() trashed?: boolean;
}

class UpdateMediaDto {
  @IsOptional() @IsObject() alt?: Record<string, string>;
  @IsOptional() @IsObject() caption?: Record<string, string>;
  @IsOptional() @IsString() originalName?: string;
  @IsOptional() @IsUUID() folderId?: string | null;
}

class IdsDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsOptional() @IsUUID() folderId?: string | null;
  /** Xoá kể cả khi file đang được dùng */
  @IsOptional() @Transform(toBool) @IsBoolean() force?: boolean;
}

class FolderDto {
  @IsString() name: string;
  @IsOptional() @IsUUID() parentId?: string | null;
}

class UpdateFolderDto {
  @IsOptional() @IsString() name?: string;
  /** null = chuyển lên gốc */
  @IsOptional() @Transform(({ value }) => (value === '' || value === 'root' ? null : value)) @IsUUID() parentId?: string | null;
}

class CropDto {
  @Type(() => Number) @IsInt() @Min(0) x: number;
  @Type(() => Number) @IsInt() @Min(0) y: number;
  @Type(() => Number) @IsInt() @Min(1) width: number;
  @Type(() => Number) @IsInt() @Min(1) height: number;
}

class ResizeDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) width?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) height?: number;
}

class EditImageDto {
  @IsOptional() @Type(() => Number) @IsIn([90, 180, 270]) rotate?: 90 | 180 | 270;
  @IsOptional() @IsIn(['h', 'v']) flip?: 'h' | 'v';
  @IsOptional() @ValidateNested() @Type(() => CropDto) crop?: CropDto;
  @IsOptional() @ValidateNested() @Type(() => ResizeDto) resize?: ResizeDto;
}

/**
 * Giới hạn upload: Multer đọc file vào RAM (memoryStorage) nên phải chặn NGAY khi đọc theo UPLOAD_MAX_MB
 * (cùng giá trị config upload.maxMb mà MediaService kiểm lại), không để tới 100MB × nhiều file rồi mới từ chối.
 * Đọc thẳng process.env vì decorator được khai báo lúc nạp module (main.ts đã nạp dotenv trước).
 */
const UPLOAD_MAX_MB = Math.max(1, parseInt(process.env.UPLOAD_MAX_MB ?? '20', 10) || 20);
/** Số file tối đa mỗi lần tải lên */
const MAX_FILES_PER_REQUEST = 20;
const UPLOAD_LIMITS = { storage: memoryStorage(), limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024, files: MAX_FILES_PER_REQUEST } };

@Controller('admin/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @RequirePermissions('media.read')
  @Get()
  list(@Query() q: MediaQuery) {
    return this.media.list(q);
  }

  @RequirePermissions('media.read')
  @Get('stats')
  stats() {
    return this.media.stats();
  }

  // ---- thư mục ----

  @RequirePermissions('media.read')
  @Get('folders')
  folders() {
    return this.media.folders();
  }

  @RequirePermissions('media.write')
  @Post('folders')
  createFolder(@Body() dto: FolderDto) {
    return this.media.createFolder(dto.name, dto.parentId);
  }

  @RequirePermissions('media.write')
  @Patch('folders/:id')
  updateFolder(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFolderDto) {
    return this.media.updateFolder(id, dto);
  }

  @RequirePermissions('media.delete')
  @Delete('folders/:id')
  removeFolder(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.removeFolder(id);
  }

  // ---- upload / thao tác hàng loạt ----

  @RequireAnyPermission('media.write', 'settings.general', 'settings.seo', 'settings.popup')
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_REQUEST, UPLOAD_LIMITS))
  async upload(@UploadedFiles() files: Express.Multer.File[], @Body('folderId') folderId: string | undefined, @CurrentUser() user: AuthUser) {
    const out = [];
    for (const f of files ?? []) out.push(await this.media.upload(f, { folderId, uploaderId: user.id }));
    return out;
  }

  @RequirePermissions('media.write')
  @Post('move')
  move(@Body() dto: IdsDto) {
    return this.media.move(dto.ids, dto.folderId ?? null);
  }

  /** Chuyển vào thùng rác. 409 kèm `usage` nếu file đang được dùng và không có force */
  @RequirePermissions('media.delete')
  @Post('delete')
  removeMany(@Body() dto: IdsDto, @CurrentUser() user: AuthUser) {
    return this.media.remove(dto.ids, { force: dto.force, userId: user.id });
  }

  @RequirePermissions('media.write')
  @Post('restore')
  restoreMany(@Body() dto: IdsDto, @CurrentUser() user: AuthUser) {
    return this.media.restore(dto.ids, user.id);
  }

  /** Xoá vĩnh viễn (chỉ áp dụng với file đã ở thùng rác) */
  @RequirePermissions('media.delete')
  @Post('destroy')
  destroyMany(@Body() dto: IdsDto, @CurrentUser() user: AuthUser) {
    return this.media.destroy(dto.ids, user.id);
  }

  @RequirePermissions('media.delete')
  @Post('empty-trash')
  emptyTrash(@CurrentUser() user: AuthUser) {
    return this.media.emptyTrash(user.id);
  }

  // ---- từng file ----

  @RequirePermissions('media.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.get(id);
  }

  @RequirePermissions('media.read')
  @Get(':id/usage')
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.usage(id);
  }

  @RequirePermissions('media.write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMediaDto) {
    return this.media.update(id, dto);
  }

  @RequirePermissions('media.write')
  @Post(':id/edit')
  edit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EditImageDto, @CurrentUser() user: AuthUser) {
    return this.media.edit(id, dto, user.id);
  }

  @RequirePermissions('media.write')
  @Post(':id/replace')
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  replace(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthUser) {
    return this.media.replace(id, file, user.id);
  }

  @RequirePermissions('media.write')
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.media.restore([id], user.id);
  }

  /** Chuyển vào thùng rác. ?force=1 để bỏ qua kiểm tra đang dùng */
  @RequirePermissions('media.delete')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Query('force') force: string | undefined, @CurrentUser() user: AuthUser) {
    return this.media.remove([id], { force: force === '1' || force === 'true', userId: user.id });
  }
}
