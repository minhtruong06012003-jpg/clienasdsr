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
export function MoneyInput({ value, onChange, placeholder, suffix = 'đ', className, disabled }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; suffix?: string; className?: string; disabled?: boolean }) {
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

/** Chuỗi giá USD đang hiển thị: dấu chấm thập phân, không phân tách hàng nghìn (giá / 1000 thường rất nhỏ) */
const fmtUsd = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '' : String(Math.round(n * 1_000_000) / 1_000_000));
/** Đọc giá USD: nhận cả dấu chấm lẫn dấu phẩy làm dấu thập phân, bỏ ký tự $ / khoảng trắng */
const parseUsd = (s: string): number | null => {
  const clean = s.replace(/[\s$]/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!clean || clean === '-' || clean === '.') return null;
  const n = Number(clean);
  return Number.isNaN(n) ? null : n;
};

/** Ô nhập giá USD (giá dịch vụ SMM): tới 6 số lẻ, dấu chấm thập phân, hậu tố $ */
export function UsdInput({ value, onChange, placeholder, className, disabled }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; className?: string; disabled?: boolean }) {
  const [text, setText] = useState(fmtUsd(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmtUsd(value));
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
          setText(fmtUsd(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseUsd(e.target.value));
        }}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
    </div>
  );
}

/** Chuỗi số đang hiển thị trong NumberInput (dấu chấm thập phân, không phân tách hàng nghìn) */
const fmtNum = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '' : String(n));

/**
 * Ô nhập số (cho phép để trống = null).
 * Giữ nguyên chữ đang gõ trong state riêng khi ô đang được focus: nếu không, gõ "0" hay "0." (bước đầu của "0.4")
 * sẽ bị form cha đổi thành null/0 và xoá mất, khiến không nhập được số thập phân nhỏ hơn 1.
 * Nhận cả dấu phẩy lẫn dấu chấm làm dấu thập phân.
 */
export function NumberInput({ value, onChange, placeholder, suffix, min, integer, className, disabled }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; suffix?: string; min?: number; /** giữ để tương thích, không còn dùng */ step?: number; integer?: boolean; className?: string; disabled?: boolean }) {
  const [text, setText] = useState(fmtNum(value));
  const [focused, setFocused] = useState(false);
  // chỉ đồng bộ từ giá trị ngoài khi người dùng không gõ
  useEffect(() => {
    if (!focused) setText(fmtNum(value));
  }, [value, focused]);
  return (
    <div className={cn('relative', className)}>
      <Input
        inputMode={integer ? 'numeric' : 'decimal'}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        className={cn('tabular-nums', suffix && 'pr-9')}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setText(fmtNum(value));
        }}
        onChange={(e) => {
          // chỉ giữ chữ số, dấu trừ và một dấu thập phân (phẩy đổi thành chấm)
          const raw = e.target.value.replace(',', '.').replace(integer ? /[^\d-]/g : /[^\d.-]/g, '');
          setText(raw);
          if (raw === '' || raw === '-' || raw === '.') return onChange(null);
          let n = integer ? parseInt(raw, 10) : Number(raw);
          if (Number.isNaN(n)) return onChange(null);
          if (min != null && n < min) n = min;
          onChange(n);
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
