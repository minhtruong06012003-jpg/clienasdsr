import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFeatures, type FeatureKey } from '@cmsnt/shared';
import { FEATURES_KEY } from '../decorators/feature.decorator.js';
import { SettingsService } from '../../modules/settings/settings.service.js';

/**
 * Guard toàn cục cho công tắc tính năng (@RequireFeature).
 * Đọc nhóm settings "features" qua SettingsService (đã cache trong bộ nhớ, tự xoá khi cài đặt đổi);
 * thiếu khoá = bật (readFeatures) để website cũ không bị ảnh hưởng.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndMerge<FeatureKey[]>(FEATURES_KEY, [context.getClass(), context.getHandler()]);
    // route không gắn decorator -> bỏ qua, không tốn truy vấn
    if (!required?.length) return true;
    const flags = readFeatures(await this.settings.get('features'));
    if (required.some((k) => !flags[k])) throw new NotFoundException('Tính năng đã tắt');
    return true;
  }
}
