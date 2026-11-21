"use client";

/**
 * Bộ icon tròn chuẩn cho 2 phương thức nạp tiền (`Ngân hàng` & `Crypto` USDT):
 * - `BankCircleIcon`: vòng tròn xanh đen đậm (#1e2d3d) + tờ tiền xanh bạc hà (#7ee8d8), giống ảnh mẫu quản trị gửi.
 * - `CryptoCircleIcon`: vòng tròn xanh ngọc Tether (#26A17B) + chữ ₮ trắng chuẩn.
 */
import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function BankCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("shrink-0", className)}>
      <circle cx="16" cy="16" r="16" fill="#1E2D3D" />
      <rect x="7" y="10.5" width="18" height="11" rx="2" fill="#8CEAD8" />
      <rect x="8.8" y="12.2" width="14.4" height="7.6" rx="1" stroke="#1E2D3D" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="2.3" fill="#1E2D3D" />
      <circle cx="10.8" cy="16" r="0.85" fill="#1E2D3D" />
      <circle cx="21.2" cy="16" r="0.85" fill="#1E2D3D" />
    </svg>
  );
}

export function CryptoCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("shrink-0", className)}>
      <circle cx="16" cy="16" r="16" fill="#26A17B" />
      <path
        fill="#FFFFFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.922 17.383v-.002c-.11.008-.677.042-1.942.042-1.01 0-1.721-.03-1.971-.042v.003c-3.888-.171-6.79-.848-6.79-1.658 0-.809 2.902-1.486 6.79-1.66v2.644c.254.018.982.061 1.988.061 1.207 0 1.812-.05 1.925-.06v-2.643c3.88.173 6.775.85 6.775 1.658 0 .81-2.895 1.485-6.775 1.657m0-3.59v-2.366h5.414V7.819H8.595v3.608h5.414v2.365c-4.4.202-7.709 1.074-7.709 2.118 0 1.044 3.309 1.915 7.709 2.118v7.582h3.913v-7.584c4.393-.202 7.694-1.073 7.694-2.116 0-1.043-3.301-1.914-7.694-2.117"
      />
    </svg>
  );
}

/** Menu thả xuống 2 lựa chọn `Ngân hàng` & `Crypto` khi bấm các nút Nạp tiền nhanh */
export function TopupMethodMenu({
  children,
  align = "end",
  side,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} sideOffset={6} className="w-44 rounded-xl p-1 shadow-lg">
        <DropdownMenuItem asChild className="cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium">
          <Link href="/pricing?method=bank">
            <BankCircleIcon className="size-5" />
            <span>{t("Ngân hàng")}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="mt-0.5 cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium">
          <Link href="/pricing?method=crypto">
            <CryptoCircleIcon className="size-5" />
            <span>{t("Crypto")}</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
