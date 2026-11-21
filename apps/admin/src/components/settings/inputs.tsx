'use client';

import { useState, type ReactNode } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Danh sách email dạng tag: gõ rồi Enter / dấu phẩy để thêm */
export function EmailListInput({ value, onChange, placeholder = 'Nhập email rồi Enter' }: { value: string[] | null | undefined; onChange: (v: string[]) => void; placeholder?: string }) {
  const list = value ?? [];
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const commit = (raw: string) => {
    const items = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!items.length) return;
    const bad = items.find((e) => !EMAIL_RE.test(e));
    if (bad) {
      setError(`"${bad}" không phải email hợp lệ`);
      return;
    }
    onChange([...new Set([...list, ...items])]);
    setText('');
    setError('');
  };
  return (
    <div className="space-y-1">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border bg-transparent px-2 py-1.5 focus-within:ring-3 focus-within:ring-ring/50">
        {list.map((e) => (
          <span key={e} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
            {e}
            <button type="button" onClick={() => onChange(list.filter((x) => x !== e))} aria-label={`Gỡ ${e}`} className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && !text && list.length) onChange(list.slice(0, -1));
          }}
          onBlur={() => text && commit(text)}
          placeholder={list.length ? '' : placeholder}
          className="min-w-40 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Ô chọn màu: input type=color + mã hex */
export function ColorInput({ value, onChange }: { value: string | null | undefined; onChange: (v: string) => void }) {
  const v = value || '#000000';
  return (
    <div className="flex items-center gap-2">
      <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border shadow-sm" style={{ background: v }}>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="w-28 font-mono text-sm uppercase" maxLength={9} placeholder="#2563EB" />
    </div>
  );
}

/** Dòng bật/tắt có tiêu đề + mô tả */
export function SwitchRow({ label, description, checked, onChange, className, disabled }: { label: ReactNode; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; className?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3', disabled && 'cursor-not-allowed opacity-60', className)}>
      <div>
        <Label className="cursor-[inherit]">{label}</Label>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

/** Ký hiệu API trả về thay cho trường bí mật đã lưu (gửi lại nguyên ký hiệu = giữ giá trị cũ) */
export const SECRET_MASK = '••••••••';

/**
 * Ô nhập khoá bí mật (API key, secret...): ẩn ký tự + nút hiện/ẩn.
 * Giá trị đang là mask → bấm vào ô sẽ bôi đen sẵn để gõ đè; để nguyên thì API giữ khoá cũ.
 */
export function SecretInput({ value, onChange, placeholder, disabled, className }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; className?: string }) {
  const [show, setShow] = useState(false);
  const str = value ?? '';
  const masked = str === SECRET_MASK;
  return (
    <div className={cn('relative', className)}>
      <Input
        type={show && !masked ? 'text' : 'password'}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => masked && e.target.select()}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        className="pr-9 font-mono text-sm"
      />
      {/* mask không phải giá trị thật nên không cho "hiện" */}
      {!masked && (
        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShow((x) => !x)} aria-label={show ? 'Ẩn' : 'Hiện'} disabled={disabled}>
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
    </div>
  );
}
