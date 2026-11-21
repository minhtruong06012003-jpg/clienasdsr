'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { ConfirmHost } from '@/components/common/confirm-dialog';
import { PromptHost } from '@/components/common/prompt-dialog';
import { CommandPaletteProvider } from '@/components/layout/command-palette';
import { AppTopbar, PageMetaProvider } from '@/components/layout/app-topbar';
import { ErrorReporter } from '@/components/layout/error-reporter';
import { DemoBanner } from '@/components/layout/demo-banner';
import { useAuth } from '@/lib/auth';
import { isDevOnlyPath } from '@/lib/nav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, isDeveloper } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // trang cấu hình kỹ thuật (loại nội dung, trường tuỳ chỉnh...) chỉ dành cho vai trò Nhà phát triển
  const blocked = !!user && !isDeveloper && isDevOnlyPath(pathname);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (blocked) router.replace('/dashboard');
  }, [loading, user, blocked, router, pathname]);

  if (loading || !user || blocked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <CommandPaletteProvider>
      <PageMetaProvider>
        {/* sidebar hẹp hơn mặc định (16rem) để dành chỗ cho nội dung */}
        <SidebarProvider style={{ '--sidebar-width': '14rem' } as React.CSSProperties}>
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-x-clip">
            <AppTopbar />
            {/* chế độ demo đang bật -> báo người xem rằng thao tác ghi đã bị khoá */}
            <DemoBanner />
            {children}
          </SidebarInset>
          <ConfirmHost />
          <PromptHost />
          {/* gửi lỗi JavaScript của trang quản trị vào Nhật ký lỗi */}
          <ErrorReporter />
        </SidebarProvider>
      </PageMetaProvider>
    </CommandPaletteProvider>
  );
}
