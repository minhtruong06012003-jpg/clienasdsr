import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from '@cmsnt/shared';

export const FEATURES_KEY = 'requiredFeatures';

/**
 * Route chỉ hoạt động khi các tính năng này đang BẬT (Cài đặt › Tính năng, nhóm settings "features").
 * Tắt -> FeatureGuard trả 404 "Tính năng đã tắt". Đặt trên class hoặc từng handler (gộp cả hai, cần bật TẤT CẢ).
 * Chỉ dùng cho route công khai / thành viên — KHÔNG đặt lên route admin hay /auth/login (admin vẫn cần).
 */
export const RequireFeature = (...features: FeatureKey[]) => SetMetadata(FEATURES_KEY, features);
