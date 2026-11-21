import { SetMetadata } from '@nestjs/common';

export const DENY_API_KEY_KEY = 'denyApiKey';
/**
 * Đánh dấu route chỉ dùng được với phiên đăng nhập thật (JWT), không dùng được bằng API key
 * — vd tạo/thu hồi key. Guard toàn cục trả 403 nếu request xác thực bằng key.
 */
export const DenyApiKey = () => SetMetadata(DENY_API_KEY_KEY, true);
