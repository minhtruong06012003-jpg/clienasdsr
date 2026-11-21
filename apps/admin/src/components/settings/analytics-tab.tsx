'use client';

import Link from 'next/link';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/** Cài đặt thống kê truy cập website (nhóm `analytics`) — dữ liệu cho trang Báo cáo website */
export function AnalyticsTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="analytics" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const enabled = v.enabled !== false;
        return (
          <>
            <Section
              title="Thống kê truy cập"
              description="Ghi nhận lượt xem trang trên website để xem trong Báo cáo website (khách, phiên, trang xem nhiều, nguồn truy cập, thiết bị)"
              actions={
                <Button variant="outline" size="sm" asChild>
                  <Link href="/reports?tab=traffic">
                    Xem báo cáo <ArrowRight />
                  </Link>
                </Button>
              }
            >
              <SwitchRow label="Bật thống kê truy cập" description="Tắt sẽ ngừng ghi nhận lượt xem mới; số liệu đã có vẫn được giữ" checked={enabled} onChange={(enabled) => set({ enabled })} />
              <SwitchRow label="Bỏ qua quản trị viên" description="Không tính lượt xem của tài khoản đang đăng nhập trang quản trị để số liệu phản ánh khách thật" checked={v.excludeAdmins !== false} onChange={(excludeAdmins) => set({ excludeAdmins })} disabled={!enabled} />
              <SwitchRow label="Tôn trọng “Do Not Track”" description="Không ghi nhận trình duyệt bật tuỳ chọn Do Not Track / Global Privacy Control" checked={!!v.respectDnt} onChange={(respectDnt) => set({ respectDnt })} disabled={!enabled} />
            </Section>
            <Section title="Loại trừ & lưu trữ">
              <Field label="Đường dẫn không thống kê" help="Mỗi dòng một tiền tố đường dẫn; mọi trang bắt đầu bằng tiền tố này sẽ không được ghi nhận (vd. /tai-khoan, /gio-hang)">
                <Textarea value={v.excludePaths ?? ''} onChange={(e) => set({ excludePaths: e.target.value })} rows={5} className="font-mono text-xs" placeholder={'/tai-khoan\n/gio-hang'} spellCheck={false} disabled={!enabled} />
              </Field>
              <Field label="Giữ dữ liệu chi tiết (ngày)" help="0 = giữ vĩnh viễn; dữ liệu cũ hơn sẽ bị xoá hằng ngày">
                <Input type="number" min={0} max={3650} value={v.retentionDays ?? 0} onChange={(e) => set({ retentionDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} className="max-w-40" />
              </Field>
            </Section>
            <div className="flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="space-y-1">
                <p className="font-medium text-emerald-700 dark:text-emerald-300">Thân thiện với quyền riêng tư</p>
                <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                  <li>Không dùng cookie, không cần banner xin đồng ý cookie cho việc thống kê.</li>
                  <li>Không lưu địa chỉ IP của khách.</li>
                  <li>Mã khách là chuỗi ẩn danh và đổi mỗi ngày, không thể dùng để theo dõi một người qua nhiều ngày.</li>
                </ul>
              </div>
            </div>
          </>
        );
      }}
    </SettingsGroup>
  );
}
