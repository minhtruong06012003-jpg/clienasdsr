"use client";

/**
 * Ngữ cảnh giao diện chủ đề của website (`default` = AI Studio, `shopclone` = ShopClone MMO).
 * Nhận giá trị khởi tạo từ `RootLayout` (server đã đọc `/public/bootstrap`) nên render đúng ngay từ byte HTML đầu tiên,
 * không nháy giao diện cũ khi tải trang, đồng thời tự cập nhật nếu admin vừa lưu ở Cài đặt › Giao diện.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useBootstrap } from "./queries";

export type SiteThemeName = "default" | "shopclone";

export interface AppearanceConfig {
  theme?: SiteThemeName | string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  showTopbar?: boolean;
  topbarText?: Record<string, string> | string;
  stickyHeader?: boolean;
}

export interface SiteThemeValue {
  theme: SiteThemeName;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  showTopbar: boolean;
  topbarText?: Record<string, string> | string;
  stickyHeader: boolean;
}

const DEFAULT_VALUE: SiteThemeValue = {
  theme: "default",
  primaryColor: "#119744",
  secondaryColor: "#0d7a36",
  accentColor: "#f59e0b",
  showTopbar: true,
  stickyHeader: true,
};

const SiteThemeContext = createContext<SiteThemeValue>(DEFAULT_VALUE);

function normalizeAppearance(raw?: AppearanceConfig | null): SiteThemeValue {
  const theme: SiteThemeName = raw?.theme === "shopclone" ? "shopclone" : "default";
  const defaultPrimary = theme === "shopclone" ? "#119744" : "#2563eb";
  const defaultSecondary = theme === "shopclone" ? "#0d7a36" : "#0f172a";
  const primaryColor =
    typeof raw?.primaryColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.primaryColor.trim())
      ? raw.primaryColor.trim()
      : defaultPrimary;
  const secondaryColor =
    typeof raw?.secondaryColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.secondaryColor.trim())
      ? raw.secondaryColor.trim()
      : defaultSecondary;
  const accentColor =
    typeof raw?.accentColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.accentColor.trim())
      ? raw.accentColor.trim()
      : "#f59e0b";
  return {
    theme,
    primaryColor,
    secondaryColor,
    accentColor,
    showTopbar: raw?.showTopbar !== false,
    topbarText: raw?.topbarText,
    stickyHeader: raw?.stickyHeader !== false,
  };
}

export function SiteThemeProvider({
  initial,
  children,
}: {
  initial?: AppearanceConfig | null;
  children: ReactNode;
}) {
  const boot = useBootstrap();
  const liveAppearance = boot.data?.settings?.appearance as AppearanceConfig | undefined;
  const value = useMemo(
    () => normalizeAppearance(liveAppearance ?? initial),
    [liveAppearance, initial],
  );
  return <SiteThemeContext.Provider value={value}>{children}</SiteThemeContext.Provider>;
}

export function useSiteTheme(): SiteThemeValue {
  return useContext(SiteThemeContext);
}
