'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { FEATURE_KEYS, FEATURE_LABELS, readFeatures, type FeatureKey } from '@cmsnt/shared';
import { Section } from '@/components/common/field';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/** Tính năng phụ thuộc: tắt tính năng cha thì tính năng con không còn tác dụng */
const PARENT: Partial<Record<FeatureKey, FeatureKey>> = {
  reviews: 'shop',
  wishlist: 'shop',
  wallet: 'accounts',
  comments: 'blog',
};

/** Cảnh báo khi tắt các mảng lớn của website */
const OFF_WARNINGS: Partial<Record<FeatureKey, string>> = {
  shop: 'Website sẽ trả 404 cho trang sản phẩm, danh mục, giỏ hàng, thanh toán, tra cứu đơn; API công khai bán hàng bị từ chối và menu Bán hàng trong quản trị bị ẩn. Dữ liệu sản phẩm, đơn hàng vẫn được giữ nguyên.',
  blog: 'Website sẽ trả 404 cho trang blog, bài viết, chuyên mục, thẻ và RSS; menu Bài viết trong quản trị bị ẩn. Bài viết đã có vẫn được giữ nguyên.',
  accounts: 'Khách không thể đăng ký / đăng nhập trên website (đăng nhập trang quản trị không bị ảnh hưởng).',
};

/**
 * Cài đặt › Tính năng (nhóm settings `features`, public): bật/tắt cả mảng tính năng theo loại website
 * (giới thiệu công ty, tin tức, bất động sản... không cần bán hàng).
 */
export function FeaturesTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="features" onDirtyChange={onDirtyChange}>
      {(v, set, original) => {
        const flags = readFeatures(v);
        const before = readFeatures(original);
        const turningOff = FEATURE_KEYS.filter((k) => before[k] && !flags[k] && OFF_WARNINGS[k]);
        return (
          <>
            <Section title="Tính năng website" description="Tắt những mảng không dùng tới để website và trang quản trị gọn hơn. Có thể bật lại bất cứ lúc nào — dữ liệu không bị xoá.">
              {FEATURE_KEYS.map((k) => {
                const parent = PARENT[k];
                const parentOff = !!parent && !flags[parent];
                return (
                  <SwitchRow
                    key={k}
                    label={FEATURE_LABELS[k].label}
                    description={
                      <>
                        {FEATURE_LABELS[k].description}
                        {parentOff && <span className="mt-1 block text-amber-600 dark:text-amber-400">Không có tác dụng khi “{FEATURE_LABELS[parent].label}” đang tắt.</span>}
                      </>
                    }
                    checked={flags[k]}
                    onChange={(on) => set({ [k]: on })}
                  />
                );
              })}
            </Section>
            {turningOff.length > 0 && (
              <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-2">
                  <p className="font-medium text-amber-700 dark:text-amber-300">Lưu ý khi tắt tính năng</p>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {turningOff.map((k) => (
                      <li key={k}>
                        <b className="text-foreground">{FEATURE_LABELS[k].label}:</b> {OFF_WARNINGS[k]}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">Nhớ gỡ các liên kết tới những trang này khỏi menu để khách không gặp trang 404.</p>
                </div>
              </div>
            )}
            <div className="flex gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">Website cần vài giây để cập nhật sau khi lưu. Giao diện được build trước khi có tính năng này sẽ bỏ qua công tắc cho tới khi cập nhật.</p>
            </div>
          </>
        );
      }}
    </SettingsGroup>
  );
}
