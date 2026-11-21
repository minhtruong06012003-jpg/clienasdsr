import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Bỏ qua xác thực JWT (vẫn đọc user nếu có token). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const IGNORE_AUTH_HEADER_KEY = 'ignoreAuthHeader';
/**
 * Route công khai mà header Authorization KHÔNG phải token đăng nhập (vd webhook cổng thanh toán
 * gửi "Bearer <token của cổng>") -> guard bỏ qua hoàn toàn, không cố giải mã JWT.
 */
export const IgnoreAuthHeader = () => SetMetadata(IGNORE_AUTH_HEADER_KEY, true);
