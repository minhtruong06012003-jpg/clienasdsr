'use client';

import Link from 'next/link';
import { MailOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Tab "Mẫu email" chỉ là lối vào trang quản lý mẫu email riêng (/settings/emails) */
export function EmailTemplatesLinkTab() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border bg-card p-6">
      <p className="text-sm text-muted-foreground">Chỉnh sửa nội dung, tiêu đề các email hệ thống gửi cho khách hàng và quản trị viên (đơn hàng, xác minh tài khoản, form liên hệ...), xem trước và gửi thử.</p>
      <Button asChild>
        <Link href="/settings/emails">
          <MailOpen /> Mở trang Mẫu email
        </Link>
      </Button>
    </div>
  );
}
