'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLanguages } from '@/hooks/use-languages';
import type { I18nText } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Ô nhập chuỗi đa ngôn ngữ dạng { vi: '', en: '' } với nút chuyển ngôn ngữ nhỏ */
export function I18nInput({ value, onChange, multiline, placeholder, rows = 3, className }: { value: I18nText | string | null | undefined; onChange: (v: I18nText) => void; multiline?: boolean; placeholder?: string; rows?: number; className?: string }) {
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const active = locale ?? defaultLocale;
  const obj: I18nText = typeof value === 'string' ? { [defaultLocale]: value } : (value ?? {});
  const set = (v: string) => onChange({ ...obj, [active]: v });
  return (
    <div className={cn('relative', className)}>
      {multiline ? (
        <Textarea value={obj[active] ?? ''} onChange={(e) => set(e.target.value)} placeholder={placeholder ?? obj[defaultLocale]} rows={rows} className="pr-14" />
      ) : (
        <Input value={obj[active] ?? ''} onChange={(e) => set(e.target.value)} placeholder={placeholder ?? obj[defaultLocale]} className="pr-14" />
      )}
      {languages.length > 1 && (
        <div className="absolute right-1.5 top-1.5 flex gap-0.5">
          {languages.map((l) => (
            <button
              key={l.code}
              type="button"
              title={l.name}
              onClick={() => setLocale(l.code)}
              className={cn('rounded px-1 text-[10px] font-semibold uppercase leading-5', active === l.code ? 'bg-primary text-primary-foreground' : obj[l.code] ? 'bg-muted text-foreground' : 'text-muted-foreground')}
            >
              {l.code}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
