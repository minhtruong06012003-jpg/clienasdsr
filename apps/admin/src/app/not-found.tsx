import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <EmptyState
          icon={FileQuestion}
          title="Không tìm thấy trang (404)"
          description="Đường dẫn không tồn tại hoặc đã bị xoá. Kiểm tra lại địa chỉ hoặc quay về bảng điều khiển."
          action={
            <Button asChild>
              <Link href="/dashboard">Về bảng điều khiển</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
