'use client';

/**
 * Cài đặt › Chế độ demo (nhóm `demo`): bật thì API từ chối mọi thao tác thêm/sửa/xoá
 * (guard apps/api/src/common/guards/demo-mode.guard.ts), trừ tài khoản vai trò Nhà phát triển.
 */
import { AlertTriangle } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { Textarea } from '@/components/ui/textarea';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

export function DemoTab({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }) {
  return (
    <SettingsGroup group="demo" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <Section title="Chế độ demo" description="Dùng khi đưa trang quản trị cho khách xem thử: khách xem được mọi trang nhưng không thể thêm, sửa, xoá hay đổi cài đặt.">
            <SwitchRow
              label="Bật chế độ demo"
              description="Khoá mọi thao tác ghi dữ liệu: thêm/sửa/xoá nội dung, tải file lên, đổi cài đặt, đổi hồ sơ/mật khẩu, đăng ký, đặt hàng… Đăng nhập và đăng xuất vẫn dùng được."
              checked={!!v.enabled}
              onChange={(enabled) => set({ enabled })}
            />
            <Field label="Thông báo hiển thị" help="Hiện trên thanh đầu trang quản trị và trong thông báo lỗi khi người xem bấm lưu/xoá.">
              <Textarea value={v.message ?? ''} onChange={(e) => set({ message: e.target.value })} rows={2} maxLength={300} />
            </Field>
          </Section>
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              Tài khoản vai trò <b>Nhà phát triển</b> không bị khoá (để còn tắt được chế độ này). Tài khoản demo đưa cho khách phải dùng vai trò khác,
              ví dụ Quản trị viên.
            </p>
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
