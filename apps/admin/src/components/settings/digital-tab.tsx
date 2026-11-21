'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, KeyRound, ShieldAlert } from 'lucide-react';
import { DEFAULT_DIGITAL_SETTINGS } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { NumberInput } from '@/components/commerce/number-input';
import { useAuth } from '@/lib/auth';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/**
 * Cài đặt › Sản phẩm số (nhóm `digital`): giao mã tự động qua email, tự hoàn thành đơn,
 * giao bù đơn đặt trước, cảnh báo sắp hết mã, bảo hành / báo lỗi, khách vãng lai xem mã.
 * Giá trị thiếu được hiểu như mặc định của `readDigitalSettings` (công tắc mặc định bật).
 */
export function DigitalTab({ onDirtyChange }: TabProps) {
  const { can } = useAuth();
  // chỉ hiện link mở Kho mã số khi có quyền xem kho
  const canOpenCodes = can('digital_codes.read');
  return (
    <SettingsGroup group="digital" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          {canOpenCodes && (
          <Link href="/digital-codes" className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm transition hover:border-primary/40">
            <KeyRound className="size-5 shrink-0 text-primary" />
            <span className="flex-1">
              <span className="font-medium">Mở Kho mã số</span>
              <span className="block text-xs text-muted-foreground">Nhập key / tài khoản / thẻ cào, xem tồn kho theo sản phẩm, xử lý báo lỗi bảo hành.</span>
            </span>
            <ArrowRight className="size-4 text-primary" />
          </Link>
          )}

          <Section title="Giao mã" description="Áp dụng cho sản phẩm bật “Bán theo kho mã” (key bản quyền, tài khoản, acc game, thẻ cào, gift card...)">
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow
                label="Gửi mã qua email"
                description="Khi đơn được thanh toán, gửi email chứa mã / tài khoản cho khách (mẫu email “digital.delivered”). Khách luôn xem được mã ở trang đơn hàng."
                checked={v.emailCodes !== false}
                onChange={(emailCodes) => set({ emailCodes })}
              />
              <SwitchRow
                label="Tự hoàn thành đơn toàn hàng ảo"
                description="Đơn chỉ gồm sản phẩm ảo / bán theo kho mã, đã thanh toán và giao đủ mã sẽ tự chuyển sang “Hoàn thành”."
                checked={v.autoCompleteOrders !== false}
                onChange={(autoCompleteOrders) => set({ autoCompleteOrders })}
              />
              <SwitchRow
                label="Tự giao bù khi nhập thêm mã"
                description="Đơn đã thanh toán còn thiếu mã (đặt trước khi hết hàng) được giao bù ngay khi nhập mã mới, đơn cũ nhất trước."
                checked={v.autoFulfillBackorders !== false}
                onChange={(autoFulfillBackorders) => set({ autoFulfillBackorders })}
              />
            </div>
            <Field label="Cảnh báo sắp hết mã khi còn ≤" help="Sản phẩm / biến thể còn ít mã hơn ngưỡng này được đánh dấu “sắp hết” trong Kho mã số và báo cho admin. 0 = chỉ báo khi hết hẳn mã.">
              <NumberInput value={v.lowStockAlert ?? DEFAULT_DIGITAL_SETTINGS.lowStockAlert} onChange={(n) => set({ lowStockAlert: Math.max(0, Math.floor(n ?? 0)) })} integer min={0} suffix="mã" className="w-40" />
            </Field>
          </Section>

          <Section title="Khách xem mã & bảo hành">
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow
                label="Cho khách vãng lai tra cứu mã"
                description="Khách không đăng nhập xem lại mã đã mua bằng mã đơn + số điện thoại đặt hàng. Tắt: chỉ thành viên xem được trong tài khoản."
                checked={v.guestAccess !== false}
                onChange={(guestAccess) => set({ guestAccess })}
              />
              <SwitchRow
                label="Cho khách báo lỗi mã (bảo hành)"
                description="Trong số ngày bảo hành đặt ở từng sản phẩm, khách bấm “Báo lỗi” để yêu cầu đổi mã. Quản trị viên xử lý ở Kho mã số."
                checked={v.allowReports !== false}
                onChange={(allowReports) => set({ allowReports })}
              />
            </div>
            {/* tắt cả tra cứu vãng lai lẫn email -> khách vãng lai không có cách nào xem mã */}
            {v.guestAccess === false && v.emailCodes === false && (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>Khách vãng lai sẽ không xem được mã — hệ thống sẽ yêu cầu đăng nhập khi mua sản phẩm giao mã.</p>
              </div>
            )}
          </Section>

          <Section title="Bảo mật nội dung mã">
            {/* Hộp thông tin về khoá mã hoá: mọi mã lưu dạng mã hoá AES-256-GCM */}
            <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1.5 text-muted-foreground">
                <p className="font-medium text-amber-700 dark:text-amber-300">Mã được mã hoá AES-256-GCM trước khi lưu vào cơ sở dữ liệu</p>
                <p>
                  Nên đặt biến môi trường riêng <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">DIGITAL_CODES_KEY</code> (chuỗi ngẫu nhiên dài, vd. <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">openssl rand -base64 32</code>) cho API và giữ bản sao an toàn.
                </p>
                <p>
                  Khi chưa đặt, khoá được dẫn xuất từ <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">JWT_ACCESS_SECRET</code> — đổi JWT secret lúc đó sẽ <strong className="text-foreground">không đọc được các mã đã nhập trước</strong>. Không đổi <code className="font-mono text-xs">DIGITAL_CODES_KEY</code> sau khi đã có mã trong kho.
                </p>
              </div>
            </div>
          </Section>
        </>
      )}
    </SettingsGroup>
  );
}
