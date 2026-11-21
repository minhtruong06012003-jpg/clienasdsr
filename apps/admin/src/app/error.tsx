'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { reportClientError } from '@/lib/report-error';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    // lỗi làm hỏng cả trang -> ghi vào Nhật ký lỗi (kèm digest để khớp với log máy chủ)
    reportClientError(error, { digest: error.digest });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <EmptyState
          icon={AlertTriangle}
          title="Đã xảy ra lỗi"
          description={error.message || 'Có lỗi không mong muốn khi hiển thị trang này.'}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => reset()}>
                <RotateCcw /> Thử lại
              </Button>
              <Button variant="outline" asChild>
                <Link href="/dashboard">Về bảng điều khiển</Link>
              </Button>
            </div>
          }
        />
        {error.digest && <p className="mt-3 text-center font-mono text-xs text-muted-foreground">Mã lỗi: {error.digest}</p>}
      </div>
    </div>
  );
}
