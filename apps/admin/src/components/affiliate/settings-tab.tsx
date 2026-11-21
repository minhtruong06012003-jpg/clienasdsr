'use client';

/** Tab Cài đặt của trang Tiếp thị liên kết: nhóm cài đặt `affiliate` (PUT /admin/settings/affiliate) */
import { Field, Section } from '@/components/common/field';
import { MoneyInput, NumberInput } from '@/components/common/number-input';
import { SwitchRow } from '@/components/settings/inputs';
import { SettingsGroup } from '@/components/settings/settings-group';

export function AffiliateSettingsTab() {
  return (
    <SettingsGroup group="affiliate">
      {(v, set) => (
        <>
          <Section title="Hoa hồng" description="Mỗi khách có link giới thiệu riêng; người được giới thiệu nạp tiền qua cổng thanh toán hoặc thẻ cào thì người giới thiệu nhận hoa hồng vào ví hoa hồng">
            <SwitchRow label="Bật chương trình giới thiệu" description="Tắt thì không cộng hoa hồng mới và khách không gửi được yêu cầu rút" checked={v.enabled !== false} onChange={(enabled) => set({ enabled })} />
            <Field label="Tỉ lệ hoa hồng" help="% trên mỗi lần người được giới thiệu nạp tiền" className="max-w-xs">
              <NumberInput min={0} suffix="%" value={v.commission ?? 0} onChange={(n) => set({ commission: Math.min(100, Math.max(0, n ?? 0)) })} disabled={v.enabled === false} />
            </Field>
          </Section>

          <Section title="Rút hoa hồng" description="Khách gửi yêu cầu rút ở trang Tiếp thị liên kết; số tiền bị giữ lại (trừ khỏi ví hoa hồng) tới khi admin duyệt hoặc từ chối">
            <Field label="Số tiền rút tối thiểu" help="Mỗi lần gửi yêu cầu, 0 = không giới hạn" className="max-w-xs">
              <MoneyInput value={v.minPayout ?? 50000} onChange={(n) => set({ minPayout: Math.max(0, n ?? 0) })} />
            </Field>
            <SwitchRow label="Cho rút vào số dư ví" description="Duyệt là cộng ngay vào số dư ví để khách mua gói" checked={v.walletPayout !== false} onChange={(walletPayout) => set({ walletPayout })} />
            <SwitchRow label="Cho rút về ngân hàng" description="Khách nhập ngân hàng, số tài khoản, tên chủ tài khoản; admin chuyển khoản tay rồi bấm duyệt" checked={v.bankPayout !== false} onChange={(bankPayout) => set({ bankPayout })} />
            <SwitchRow
              label="Chặn tự giới thiệu cùng IP lúc đăng ký"
              description="Không gắn người giới thiệu nếu tài khoản mới đăng ký từ IP người giới thiệu từng đăng nhập / đăng nhập OAuth / chạy AI trong 30 ngày."
              checked={v.blockSameIp !== false}
              onChange={(blockSameIp) => set({ blockSameIp })}
            />
            <SwitchRow
              label="Tự động chặn cộng hoa hồng Aff 2 nick (lúc nạp tiền)"
              description="Ngay cả khi khách dùng 4G khác mạng lúc đăng ký nhưng sau đó đăng nhập / chạy AI cùng IP, trùng STK ngân hàng, trùng Telegram hoặc trùng họ tên với nick giới thiệu thì tự ngưng cộng hoa hồng."
              checked={v.blockSelfReferral !== false}
              onChange={(blockSelfReferral) => set({ blockSelfReferral })}
            />
            <p className="text-xs text-muted-foreground">
              Người giới thiệu bị khoá tài khoản sẽ không nhận hoa hồng mới. Khi trừ tiền khách ở trang thành viên với tuỳ chọn “Rút lại tiền nạp”, phần hoa hồng tương ứng được thu hồi.
            </p>
          </Section>
        </>
      )}
    </SettingsGroup>
  );
}
