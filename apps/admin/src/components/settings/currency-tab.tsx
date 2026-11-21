'use client';

/**
 * Tab Cài đặt › Tiền tệ (nhóm `currency`): cho khách xem giá / số dư theo USD.
 * - Số dư, giá gói, nạp tiền luôn lưu và thanh toán bằng VNĐ; USD chỉ là quy đổi khi hiển thị trên website khách.
 * - `usdRate`: 1 USD = ? đồng; `currencies[USD]`: bật/tắt + số chữ số lẻ hiển thị.
 */
import { Field, Section } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

/** Một dòng tiền tệ phụ trong mảng `currencies` (khớp RawCurrencySettings ở web) */
interface CurrencyRow {
  code: string;
  name?: string;
  rate?: number;
  decimals?: number;
  enabled?: boolean;
}

/** Dòng USD mặc định khi DB chưa có */
const USD_DEFAULT: CurrencyRow = { code: 'USD', name: 'US Dollar', rate: 26000, decimals: 2, enabled: true };

export function CurrencyTab({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  return (
    <SettingsGroup group="currency" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const rows = Array.isArray(v.currencies) ? (v.currencies as CurrencyRow[]) : [];
        const usd = rows.find((r) => r.code === 'USD') ?? USD_DEFAULT;
        const rate = Number(v.usdRate) > 0 ? Number(v.usdRate) : (usd.rate ?? USD_DEFAULT.rate!);
        // sửa dòng USD trong mảng (giữ nguyên các dòng khác nếu có)
        const patchUsd = (patch: Partial<CurrencyRow>) => {
          const next = { ...usd, ...patch };
          set({ currencies: rows.some((r) => r.code === 'USD') ? rows.map((r) => (r.code === 'USD' ? next : r)) : [...rows, next] });
        };
        return (
          <Section title="Đô la Mỹ (USD)" description="Khách chọn tiền tệ ở nút quả địa cầu trên thanh trên. Số dư, giá gói và tiền nạp vẫn tính bằng VNĐ; USD chỉ quy đổi để hiển thị.">
            <SwitchRow label="Cho khách xem giá theo USD" description="Tắt thì website chỉ hiển thị VNĐ" checked={usd.enabled !== false} onChange={(enabled) => patchUsd({ enabled })} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Tỉ giá: 1 USD = ? VNĐ" help="Giá USD khách thấy = giá VNĐ ÷ tỉ giá">
                {/* ghi cả usdRate (web ưu tiên) lẫn rate trong dòng USD cho đồng bộ */}
                <NumberInput
                  suffix="đ"
                  min={1}
                  value={rate}
                  onChange={(n) => {
                    const r = n && n > 0 ? n : USD_DEFAULT.rate!;
                    set({ usdRate: r, currencies: (rows.some((x) => x.code === 'USD') ? rows : [...rows, usd]).map((x) => (x.code === 'USD' ? { ...x, rate: r } : x)) });
                  }}
                />
              </Field>
              <Field label="Số chữ số lẻ" help="Vd 2 → $3.85">
                <NumberInput min={0} integer value={usd.decimals ?? 2} onChange={(n) => patchUsd({ decimals: Math.min(Math.max(Math.round(n ?? 2), 0), 6) })} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">Ví dụ: gói 100.000đ ≈ ${(100000 / rate).toFixed(usd.decimals ?? 2)}</p>
          </Section>
        );
      }}
    </SettingsGroup>
  );
}
