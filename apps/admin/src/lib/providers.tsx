'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster, toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeHotkey } from '@/components/common/theme-toggle';
import { AuthProvider } from './auth';
import { ApiError, errorMessage } from './api';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        // Báo lỗi tải lại (refetch) thất bại bằng toast — chỉ với query ĐÃ có dữ liệu trước đó:
        // query chưa có dữ liệu thì lỗi đã hiện ngay trong bảng/khối nội dung (DataTable `error`), không toast trùng.
        // Dùng id theo queryHash để lỗi lặp lại (vd. refetchInterval khi mất mạng) chỉ giữ một toast.
        // Query muốn tự xử lý lỗi có thể đặt `meta: { silentError: true }`.
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (query.state.data === undefined || query.meta?.silentError) return;
            // 401 = hết phiên: luồng đăng nhập tự chuyển hướng, không cần toast
            if (error instanceof ApiError && error.status === 401) return;
            toast.error(`Không tải lại được dữ liệu: ${errorMessage(error)}`, { id: `query-error:${query.queryHash}` });
          },
        }),
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    // Giao diện sáng/tối lưu ở localStorage (cmsnt-admin-theme), mặc định theo hệ điều hành
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="cmsnt-admin-theme">
      <QueryClientProvider client={client}>
        <AuthProvider>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        </AuthProvider>
        <ThemedToaster />
        <ThemeHotkey />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster richColors position="top-right" closeButton theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />;
}
