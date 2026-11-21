'use client';

import { ArrowDown, ArrowUp, EyeOff, Plus, Trash2, Wand2 } from 'lucide-react';
import { CODE_PART_SEPARATOR, slugify, type CodeFieldDef } from '@cmsnt/shared';
import { I18nInput } from '@/components/common/i18n-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useLanguages } from '@/hooks/use-languages';
import { i18n } from '@/lib/format';
import type { I18nText } from '@/lib/types';
import { cn } from '@/lib/utils';
import { uid } from './variants-editor';

/** Khoá hợp lệ của một phần mã / ô nhập (giống KEY_RE trong @cmsnt/shared/digital) */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Sinh khoá từ nhãn: "ID game" -> "id_game"; bắt đầu bằng số -> thêm tiền tố "f_" */
export function fieldKeyFrom(label: string): string {
  const k = slugify(label).replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!k) return '';
  return (/^[a-z]/.test(k) ? k : `f_${k}`).slice(0, 40);
}

/** Một phần của mã trong form (thêm _key để React giữ đúng dòng khi đổi thứ tự) */
export type CodeFieldForm = CodeFieldDef & { _key: string };

export const toCodeFieldForms = (list: CodeFieldDef[]): CodeFieldForm[] => list.map((f) => ({ ...f, _key: uid() }));
/** Bỏ _key và dòng rỗng trước khi gửi lên API */
export const fromCodeFieldForms = (list: CodeFieldForm[]): CodeFieldDef[] =>
  list.filter((f) => f.key.trim()).map(({ key, label, secret }) => ({ key: key.trim(), label, ...(secret ? { secret: true } : {}) }));

/** Lỗi đầu tiên của danh sách phần mã (khoá sai định dạng / trùng), null = hợp lệ */
export function codeFieldsError(list: CodeFieldForm[]): string | null {
  const keys = new Set<string>();
  for (const f of list) {
    const k = f.key.trim();
    if (!k && !Object.values(f.label ?? {}).some(Boolean)) continue;
    if (!FIELD_KEY_RE.test(k)) return `Mã phần "${k || '(trống)'}" không hợp lệ: chỉ chữ thường a-z, số, gạch dưới và bắt đầu bằng chữ`;
    if (keys.has(k)) return `Mã phần "${k}" bị trùng`;
    keys.add(k);
  }
  return null;
}

const L = (vi: string, en: string): I18nText => ({ vi, en });

/** Mẫu nhanh cho các loại hàng số hay gặp */
const PRESETS: { label: string; fields: CodeFieldDef[] }[] = [
  { label: 'Tài khoản | Mật khẩu', fields: [{ key: 'username', label: L('Tài khoản', 'Username') }, { key: 'password', label: L('Mật khẩu', 'Password'), secret: true }] },
  {
    label: 'Tài khoản | Mật khẩu | 2FA',
    fields: [{ key: 'username', label: L('Tài khoản', 'Username') }, { key: 'password', label: L('Mật khẩu', 'Password'), secret: true }, { key: 'twofa', label: L('Mã 2FA', '2FA code'), secret: true }],
  },
  { label: 'Serial | Mã thẻ (PIN)', fields: [{ key: 'serial', label: L('Serial', 'Serial') }, { key: 'pin', label: L('Mã thẻ', 'PIN'), secret: true }] },
  { label: 'Key bản quyền', fields: [{ key: 'license_key', label: L('Key bản quyền', 'License key'), secret: true }] },
];

/**
 * Trình sửa "Các phần của mã" (Product.codeFields): mỗi mã nhập dạng "phần1|phần2|..." được tách
 * và hiển thị cho khách theo nhãn ở đây; phần đánh dấu "che" chỉ hiện khi khách bấm xem.
 */
export function CodeFieldsEditor({ value, onChange, disabled }: { value: CodeFieldForm[]; onChange: (v: CodeFieldForm[]) => void; disabled?: boolean }) {
  const { defaultLocale } = useLanguages();
  const update = (key: string, patch: Partial<CodeFieldForm>) => onChange(value.map((f) => (f._key === key ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  /** Đổi nhãn: tự sinh khoá nếu khoá đang trống hoặc đang khớp nhãn cũ */
  const setLabel = (f: CodeFieldForm, label: I18nText) => {
    const auto = !f.key || f.key === fieldKeyFrom(i18n(f.label, defaultLocale));
    update(f._key, { label, ...(auto ? { key: fieldKeyFrom(i18n(label, defaultLocale)) } : {}) });
  };
  const err = codeFieldsError(value);
  const format = value.length ? value.map((f) => i18n(f.label, defaultLocale) || f.key || '?').join(CODE_PART_SEPARATOR) : 'nội dung mã';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              <Wand2 /> Mẫu nhanh
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Thay toàn bộ các phần hiện tại</DropdownMenuLabel>
            {PRESETS.map((p) => (
              <DropdownMenuItem key={p.label} onClick={() => onChange(toCodeFieldForms(p.fields))}>
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {value.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onChange([])} disabled={disabled}>
            Bỏ chia phần
          </Button>
        )}
      </div>

      {value.map((f, i) => (
        <div key={f._key} className="grid items-start gap-2 rounded-lg border bg-muted/20 p-2 sm:grid-cols-[auto_1fr_150px_auto_auto]">
          <span className="hidden h-9 w-6 items-center justify-center text-xs font-semibold text-muted-foreground sm:flex">{i + 1}</span>
          <I18nInput value={f.label} onChange={(label) => setLabel(f, label)} placeholder="Nhãn (vd: Tài khoản)" />
          <Input
            value={f.key}
            onChange={(e) => update(f._key, { key: e.target.value })}
            onBlur={(e) => update(f._key, { key: fieldKeyFrom(e.target.value) })}
            placeholder="username"
            className={cn('font-mono text-xs', f.key && !FIELD_KEY_RE.test(f.key) && 'border-destructive')}
            aria-label="Mã phần"
            disabled={disabled}
          />
          <label className="flex h-9 items-center gap-2 whitespace-nowrap rounded-md border bg-background px-2 text-xs" title="Che khi hiển thị cho khách (mật khẩu, PIN)">
            <EyeOff className="size-3.5 text-muted-foreground" /> Che
            <Switch checked={!!f.secret} onCheckedChange={(secret) => update(f._key, { secret })} disabled={disabled} />
          </label>
          <div className="flex items-center">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={disabled || i === 0} aria-label="Lên">
              <ArrowUp />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={disabled || i === value.length - 1} aria-label="Xuống">
              <ArrowDown />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => onChange(value.filter((x) => x._key !== f._key))} disabled={disabled} aria-label="Xoá phần">
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}

      {value.length < 10 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...value, { _key: uid(), key: '', label: {} }])} disabled={disabled}>
          <Plus /> Thêm phần
        </Button>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <p className="text-xs text-muted-foreground">
        Mỗi dòng khi nhập mã có dạng <code className="rounded bg-muted px-1 font-mono text-foreground">{format}</code>
        {value.length === 0 ? ' — để trống nếu mỗi mã chỉ là một chuỗi (key, mã thẻ...).' : '. Phần thừa được gộp vào phần cuối.'}
      </p>
    </div>
  );
}
