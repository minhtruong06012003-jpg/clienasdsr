'use client';

import { Field, Section } from '@/components/common/field';
import { providerName, type PaymentProviderInfo } from '@/components/commerce/payments';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { Values } from './settings-group';

/**
 * Cài đặt nhóm `wallet` dùng cho thanh toán gói cước qua cổng (website không có trang nạp tiền riêng).
 * - topupProviders rỗng = cho dùng mọi cổng đang bật; tick cổng nào thì trang thanh toán gói chỉ hiện các cổng đó.
 * - topupMin: số tiền tối thiểu mỗi lần thanh toán qua cổng (VND, API kẹp ≥ 1.000); gói rẻ hơn thì phần dư giữ trong ví.
 * - topupEnabled (cho khách tự nạp ví) giữ tắt và không hiện ở đây: thanh toán gói không phụ thuộc công tắc này.
 */
export function WalletTopupSection({ value, set, providers }: { value: Values; set: (patch: Values) => void; providers: PaymentProviderInfo[] | undefined }) {
  const selected: string[] = Array.isArray(value.topupProviders) ? value.topupProviders : [];
  // bật/tắt một cổng trong danh sách được phép
  const toggle = (key: string, on: boolean) => set({ topupProviders: on ? [...new Set([...selected, key])] : selected.filter((k) => k !== key) });
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  return (
    <Section title="Thanh toán gói cước" description="Khách chọn gói rồi trả thẳng qua cổng, gói tự kích hoạt khi cổng xác nhận đã nhận tiền">
      <div className="space-y-4">
        <Field label="Cổng hiện ở trang thanh toán" help="Không tick cổng nào = dùng mọi cổng đang bật.">
          {!providers?.length ? (
            <p className="text-sm text-muted-foreground">Chưa có cổng thanh toán online nào.</p>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {providers.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={selected.includes(p.key)} onCheckedChange={(v) => toggle(p.key, v === true)} />
                  {providerName(p.key, providers)}
                  {!p.enabled && <span className="text-xs text-muted-foreground">(đang tắt)</span>}
                </label>
              ))}
            </div>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Thanh toán tối thiểu (đ)" help="Gói rẻ hơn mức này: khách trả đúng mức tối thiểu, phần dư giữ trong ví cho lần mua sau.">
            <Input type="number" min={1000} step={1000} value={value.topupMin ?? 10000} onChange={(e) => set({ topupMin: num(e.target.value) })} />
          </Field>
        </div>
      </div>
    </Section>
  );
}
