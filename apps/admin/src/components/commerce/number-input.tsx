'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const fmt = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '' : n.toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
const parse = (s: string): number | null => {
  const clean = s.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!clean || clean === '-') return null;
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
};

/** Ô nhập tiền: hiển thị phân tách hàng nghìn kiểu Việt Nam, có hậu tố đơn vị */
export function MoneyInput({ value, onChange, placeholder, suffix = '₫', className, disabled }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; suffix?: string; className?: string; disabled?: boolean }) {
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
  }, [value, focused]);
  return (
    <div className={cn('relative', className)}>
      <Input
        inputMode="decimal"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        className="pr-8 tabular-nums"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setText(fmt(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parse(e.target.value));
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** Ô nhập số (cho phép để trống = null) */
export function NumberInput({ value, onChange, placeholder, suffix, min, step, integer, className, disabled }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; suffix?: string; min?: number; step?: number; integer?: boolean; className?: string; disabled?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <Input
        type="number"
        value={value ?? ''}
        min={min}
        step={step ?? (integer ? 1 : 'any')}
        disabled={disabled}
        placeholder={placeholder}
        className={cn('tabular-nums', suffix && 'pr-9')}
        onChange={(e) => {
          if (e.target.value === '') return onChange(null);
          const n = integer ? parseInt(e.target.value, 10) : Number(e.target.value);
          onChange(Number.isNaN(n) ? null : n);
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
