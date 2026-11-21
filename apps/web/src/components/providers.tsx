"use client";

/** Bọc toàn bộ app: chủ đề sáng/tối, bảng phối màu, React Query, trạng thái đăng nhập, ngôn ngữ / tiền tệ, toast, tooltip */
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { PaletteProvider } from "@/components/palette-provider";
import { MaintenanceGate } from "@/components/maintenance-gate";
import { ApiError, errorMessage } from "@/lib/api";
import { saveReferral } from "@/lib/referral";
import { I18nProvider, type I18nInitial } from "@/lib/i18n/provider";
import { SiteThemeProvider, type AppearanceConfig } from "@/lib/site-theme";
import { tNow } from "@/lib/i18n/translate";
import type { Bootstrap } from "@/lib/types";

export function Providers({
  i18n,
  appearance,
  bootstrap,
  children,
}: {
  i18n: I18nInitial;
  appearance?: AppearanceConfig;
  bootstrap?: Bootstrap;
  children: ReactNode;
}) {
  const [client] = useState(() => {
    const qc = new QueryClient({
      // Lỗi tải lại (đã có dữ liệu trước đó) -> toast một lần; query tự hiện lỗi thì đặt meta.silentError
      queryCache: new QueryCache({
        onError: (error, query) => {
          if (query.state.data === undefined || query.meta?.silentError) return;
          if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return;
          toast.error(tNow("Không tải lại được dữ liệu: {error}", { error: errorMessage(error) }), { id: `query-error:${query.queryHash}` });
        },
      }),
      defaultOptions: {
        queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });
    // Nạp sẵn bootstrap từ SSR để Logo, Header, Footer render đúng tên thương hiệu của từng web con ngay trên HTML máy chủ (T-372)
    if (bootstrap) {
      qc.setQueryData(["public", "bootstrap", i18n.locale], bootstrap);
      if (i18n.locale !== "vi") qc.setQueryData(["public", "bootstrap", "vi"], bootstrap);
    }
    return qc;
  });
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="smm-web-theme">
      <PaletteProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            {/* ngôn ngữ / tiền tệ / múi giờ: cần trạng thái đăng nhập để đồng bộ với tài khoản */}
            <I18nProvider initial={i18n}>
              <SiteThemeProvider initial={appearance}>
                <TooltipProvider delayDuration={300}>
                  {/* bảo trì website: khách thấy trang thông báo, quản trị viên vẫn dùng bình thường */}
                  <MaintenanceGate>{children}</MaintenanceGate>
                </TooltipProvider>
              </SiteThemeProvider>
            </I18nProvider>
            {/* đồng bộ bảng phối màu với tài khoản khi đã đăng nhập */}
          </AuthProvider>
          <ThemedToaster />
          <ReferralCapture />
        </QueryClientProvider>
      </PaletteProvider>
    </ThemeProvider>
  );
}

/** Toast theo chủ đề sáng/tối hiện tại */
function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster richColors position="top-right" closeButton theme={resolvedTheme === "dark" ? "dark" : "light"} />;
}

/** Ghi nhận mã giới thiệu khi khách vào bất kỳ trang nào bằng link `?ref=CODE` */
function ReferralCapture() {
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) saveReferral(ref);
  }, []);
  return null;
}
