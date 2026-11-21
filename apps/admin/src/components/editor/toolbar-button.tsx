'use client';

import type { LucideIcon } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

/** Nút icon nhỏ dùng trong thanh công cụ trình soạn thảo */
export function Btn({ icon: Icon, label, active, onClick, disabled, className, children }: { icon: LucideIcon; label: string; active?: boolean; onClick?: () => void; disabled?: boolean; className?: string; children?: React.ReactNode }) {
  return (
    <Toggle size="sm" pressed={!!active} onPressedChange={() => onClick?.()} aria-label={label} title={label} disabled={disabled} className={cn('size-7 min-w-7 p-0', className)}>
      <Icon className="size-4" />
      {children}
    </Toggle>
  );
}
