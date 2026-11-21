import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

/** Thêm sản phẩm vào danh sách yêu thích: 1 sản phẩm (`productId`) hoặc gộp nhiều (`productIds` — khi khách vừa đăng nhập) */
export class AddWishlistDto {
  @IsOptional() @IsUUID() productId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) productIds?: string[];

  /** ngôn ngữ để trả tên/slug sản phẩm */
  @IsOptional() @IsString() locale?: string;
}
