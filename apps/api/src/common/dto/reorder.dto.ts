import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsUUID, ValidateNested } from 'class-validator';

export class ReorderItemDto {
  @IsUUID() id: string;
  @IsOptional() @IsUUID() parentId: string | null;
  @Type(() => Number) @IsInt() sortOrder: number;
}

export class ReorderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReorderItemDto) items: ReorderItemDto[];
}
