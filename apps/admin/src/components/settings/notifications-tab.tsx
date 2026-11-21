'use client';

/**
 * Tab Cài đặt › Thông báo email: email tự động khi có đơn hàng (nhóm `orderNotification`).
 * Nội dung / giao diện email sửa ở Cài đặt › Mẫu email (order.*).
 */
import Link from 'next/link';
import { Info, MailOpen } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFeatures } from '@/hooks/use-features';
import { SwitchRow } from './inputs';
import { MultiSettingsGroup, type Values } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

const GROUPS = ['orderNotification'] as const;

/** Nút mở trang Mẫu email (đặt ở góc tiêu đề mỗi khối) */
function TemplatesLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href="/settings/emails">
        <MailOpen /> Mẫu email
      </Link>
    </Button>
  );
}

export function NotificationsTab({ onDirtyChange }: TabProps) {
  const { isOn } = useFeatures();
  const shopOn = isOn('shop');

  return (
    <MultiSettingsGroup groups={GROUPS} onDirtyChange={onDirtyChange}>
      {(all, setGroup) => {
        const order: Values = all.orderNotification;
        const setOrder = (patch: Values) => setGroup('orderNotification', patch);
        const orderOn = order.enabled !== false;
        return (
          <>
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              <p>
                Email được gửi qua{' '}
                <Link href="/settings?tab=mail" className="font-medium text-primary hover:underline">
                  Cài đặt › Email SMTP
                </Link>{' '}
                — cần cấu hình máy chủ gửi mail trước. Tiêu đề và nội dung từng email chỉnh ở{' '}
                <Link href="/settings/emails" className="font-medium text-primary hover:underline">
                  Cài đặt › Mẫu email
                </Link>
                .
              </p>
            </div>

            <Section title="Đơn hàng" description="Báo cửa hàng khi có đơn mới / đã thanh toán, gửi email xác nhận và cập nhật trạng thái đơn cho khách (mẫu order.*)" actions={<TemplatesLink />}>
              {/* bán hàng đang tắt: vẫn cho cấu hình trước nhưng nhắc là chưa có tác dụng */}
              {!shopOn && (
                <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-muted-foreground dark:border-sky-900 dark:bg-sky-950/30">
                  <Info className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                  <p>
                    Tính năng <b className="text-foreground">Bán hàng</b> đang tắt nên thông báo đơn hàng chưa có tác dụng.{' '}
                    <Link href="/settings?tab=features" className="font-medium text-primary hover:underline">
                      Bật ở mục Tính năng
                    </Link>
                    .
                  </p>
                </div>
              )}
              <SwitchRow label="Bật thông báo đơn hàng" description="Tắt sẽ ngừng mọi email tự động liên quan tới đơn hàng (cửa hàng và khách)" checked={orderOn} onChange={(enabled) => setOrder({ enabled })} />
              <Field
                label="Email nhận thông báo đơn mới"
                help={
                  <>
                    Phân tách bằng dấu phẩy. Để trống thì dùng{' '}
                    <Link href="/settings?tab=commerce" className="text-primary hover:underline">
                      Cài đặt › Bán hàng › Email nhận thông báo đơn
                    </Link>
                    .
                  </>
                }
              >
                <Input value={order.adminEmails ?? ''} onChange={(e) => setOrder({ adminEmails: e.target.value })} placeholder="shop@example.com, ketoan@example.com" disabled={!orderOn} />
              </Field>
              <SwitchRow label="Gửi email xác nhận cho khách" description="Khi khách đặt hàng và khi đơn được thanh toán" checked={order.sendCustomerEmail !== false} onChange={(sendCustomerEmail) => setOrder({ sendCustomerEmail })} disabled={!orderOn} />
              <SwitchRow label="Báo khách khi đổi trạng thái đơn" description="Đã xác nhận, đang giao, hoàn tất, đã huỷ..." checked={order.notifyStatusChange !== false} onChange={(notifyStatusChange) => setOrder({ notifyStatusChange })} disabled={!orderOn} />
            </Section>

          </>
        );
      }}
    </MultiSettingsGroup>
  );
}
