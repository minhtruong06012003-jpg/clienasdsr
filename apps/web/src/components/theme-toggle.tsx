"use client";

/** Nút chuyển chế độ sáng / tối */
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const t = useT();
  return (
    <Button variant="ghost" size="icon" className={className} aria-label={t("Đổi giao diện sáng/tối")} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
      {/* hiển thị cả hai icon, ẩn/hiện bằng class dark để không lệch khi hydrate */}
      <Sun className="size-4.5 dark:hidden" />
      <Moon className="hidden size-4.5 dark:block" />
    </Button>
  );
}
