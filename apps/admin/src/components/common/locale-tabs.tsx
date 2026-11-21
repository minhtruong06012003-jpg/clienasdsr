'use client';

import { cn } from '@/lib/utils';
import type { Language } from '@/lib/types';

/** Chọn ngôn ngữ đang chỉnh sửa. Chấm xanh = đã có bản dịch. */
export function LocaleTabs({ languages, value, onChange, has, className }: { languages: Language[]; value: string; onChange: (code: string) => void; has?: (code: string) => boolean; className?: string }) {
  if (languages.length <= 1) return null;
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-lg bg-muted p-1', className)}>
      {languages.map((l) => (
        <button
          key={l.code}
          type="button"
          onClick={() => onChange(l.code)}
          className={cn('relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition', value === l.code ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          <span>{l.flag}</span>
          <span className="uppercase">{l.code}</span>
          {has && <span className={cn('size-1.5 rounded-full', has(l.code) ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />}
        </button>
      ))}
    </div>
  );
}
