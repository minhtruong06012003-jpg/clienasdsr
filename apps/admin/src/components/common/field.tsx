import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Bọc label + control + mô tả + lỗi cho form */
export function Field({ label, htmlFor, help, error, required, children, className, action }: { label?: ReactNode; htmlFor?: string; help?: ReactNode; error?: string; required?: boolean; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      {(label || action) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <Label htmlFor={htmlFor} className="text-sm">
              {label} {required && <span className="text-destructive">*</span>}
            </Label>
          )}
          {action}
        </div>
      )}
      {children}
      {help && !error && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Thẻ nhóm field trong trang chỉnh sửa */
export function Section({ title, description, children, actions, className }: { title?: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      {(title || actions) && (
        // flex-wrap + basis 12rem: màn hẹp thì cụm nút xuống dòng dưới tiêu đề thay vì tràn khỏi thẻ
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-[1_1_12rem] [overflow-wrap:anywhere]">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}
