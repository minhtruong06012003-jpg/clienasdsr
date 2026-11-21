'use client';

import { Field, Section } from '@/components/common/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

const DEPTHS = [
  { value: 1, label: '1 — không lồng (chỉ bình luận gốc)' },
  { value: 2, label: '2 — gốc + 1 cấp trả lời' },
  { value: 3, label: '3 cấp' },
  { value: 4, label: '4 cấp' },
  { value: 5, label: '5 cấp' },
];

/** Cài đặt bình luận bài viết (nhóm `comments`) */
export function CommentsTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="comments" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const enabled = v.enabled !== false;
        return (
          <>
            <Section title="Bình luận bài viết" description="Áp dụng cho mọi bài viết; từng bài vẫn có thể tắt riêng bằng công tắc “Cho phép bình luận” trong trình soạn thảo">
              <SwitchRow label="Bật bình luận" description="Tắt sẽ ẩn toàn bộ bình luận và form gửi trên website (dữ liệu vẫn được giữ)" checked={enabled} onChange={(enabled) => set({ enabled })} />
              <SwitchRow label="Yêu cầu đăng nhập" description="Chỉ thành viên đã đăng nhập mới được bình luận; khách vãng lai phải nhập tên và email" checked={!!v.requireLogin} onChange={(requireLogin) => set({ requireLogin })} disabled={!enabled} />
              <SwitchRow label="Tự động duyệt" description="Bình luận hiển thị ngay, không cần quản trị viên duyệt (dễ bị spam hơn)" checked={!!v.autoApprove} onChange={(autoApprove) => set({ autoApprove })} disabled={!enabled} />
            </Section>
            <Section title="Trả lời lồng nhau">
              <SwitchRow label="Cho phép trả lời bình luận" description="Hiện nút “Trả lời” dưới mỗi bình luận đã duyệt" checked={v.allowReplies !== false} onChange={(allowReplies) => set({ allowReplies })} disabled={!enabled} />
              <Field label="Độ sâu tối đa" help="Giới hạn số cấp lồng nhau để giao diện không bị quá hẹp trên điện thoại">
                <Select value={String(Number(v.maxDepth) || 2)} onValueChange={(d) => set({ maxDepth: Number(d) })} disabled={!enabled || v.allowReplies === false}>
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPTHS.map((d) => (
                      <SelectItem key={d.value} value={String(d.value)}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </Section>
            <Section title="Thông báo & tự đóng">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Email nhận thông báo" help="Nhận email mỗi khi có bình luận mới (cần cấu hình SMTP). Để trống = không gửi">
                  <Input type="email" value={v.notifyEmail ?? ''} onChange={(e) => set({ notifyEmail: e.target.value.trim() })} placeholder="admin@example.com" disabled={!enabled} />
                </Field>
                <Field label="Đóng bình luận sau (ngày)" help="Bài viết đăng quá số ngày này sẽ không nhận bình luận mới. 0 = không đóng">
                  <Input type="number" min={0} max={3650} value={v.closeAfterDays ?? 0} onChange={(e) => set({ closeAfterDays: Math.max(0, Number(e.target.value) || 0) })} disabled={!enabled} />
                </Field>
              </div>
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}
