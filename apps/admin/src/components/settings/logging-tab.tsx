'use client';

import Link from 'next/link';
import { ArrowRight, Info } from 'lucide-react';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

/** Các mức ghi log tối thiểu cho phép chọn */
const LEVEL_OPTIONS = [
  { value: 'error', label: 'Chỉ lỗi (error)' },
  { value: 'warn', label: 'Lỗi + cảnh báo (warn, khuyên dùng)' },
  { value: 'info', label: 'Thêm thông tin (info)' },
  { value: 'debug', label: 'Gỡ lỗi chi tiết (debug — chỉ bật khi cần, file lớn nhanh)' },
];

/** Ép giá trị ô số về số nguyên không âm */
const toInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

/** Cài đặt nhật ký lỗi (nhóm `logging`) — dữ liệu cho trang Nhật ký lỗi (/logs) */
export function LoggingTab({ onDirtyChange }: TabProps) {
  return (
    <SettingsGroup group="logging" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <Section
            title="Ghi nhật ký lỗi"
            description="Ghi lại lỗi phát sinh ở API, website và trang quản trị để tra cứu khi có sự cố"
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/system-logs/errors">
                  Xem nhật ký lỗi <ArrowRight />
                </Link>
              </Button>
            }
          >
            <Field label="Mức ghi tối thiểu" help="Chỉ những dòng có mức từ mức này trở lên mới được ghi vào file">
              <Select value={v.level ?? 'warn'} onValueChange={(level) => set({ level })}>
                <SelectTrigger className="w-full max-w-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <SwitchRow
              label="Ghi cả lỗi phía người dùng (4xx)"
              description="Yêu cầu sai, không tìm thấy, chưa đăng nhập... sẽ được ghi ở mức warn. Mặc định tắt để tránh nhiễu."
              checked={!!v.log4xx}
              onChange={(log4xx) => set({ log4xx })}
            />
            <SwitchRow
              label="Nhận lỗi JavaScript từ trình duyệt"
              description="Ghi lại lỗi xảy ra trên trình duyệt của khách (website) và của quản trị viên (trang quản trị)"
              checked={v.captureClient !== false}
              onChange={(captureClient) => set({ captureClient })}
            />
          </Section>

          <Section title="Lưu trữ">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Giữ file log (ngày)" help="0 = giữ vĩnh viễn; file cũ hơn sẽ bị xoá tự động hằng ngày">
                <Input type="number" min={0} max={3650} value={v.retentionDays ?? 14} onChange={(e) => set({ retentionDays: toInt(e.target.value) })} className="max-w-40" />
              </Field>
              <Field label="Dung lượng tối đa mỗi ngày (MB)" help="Khi file trong ngày vượt mức này, chỉ còn ghi lỗi nghiêm trọng (fatal)">
                <Input type="number" min={1} max={10240} value={v.maxFileMb ?? 50} onChange={(e) => set({ maxFileMb: Math.max(1, toInt(e.target.value)) })} className="max-w-40" />
              </Field>
            </div>
          </Section>

          <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/30">
            <Info className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
            <div className="space-y-1">
              <p className="font-medium text-blue-700 dark:text-blue-300">Về nhật ký lỗi</p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                <li>Log được lưu dạng file theo từng ngày trên máy chủ, có thể tải về hoặc xoá ở trang Nhật ký lỗi.</li>
                <li>Mật khẩu, token và các thông tin nhạy cảm được tự động che trước khi ghi.</li>
                <li>File log không nằm trong gói cập nhật phiên bản, cập nhật hệ thống không làm mất log.</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
