'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, MapPin, Search, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/common/field';
import { api, type Paginated } from '@/lib/api';
import { useDebounce } from '@/hooks/use-debounce';
import { formatAddress, type Address } from './utils';

export interface CustomerForm {
  userId: string | null;
  name: string;
  email: string;
  phone: string;
}

interface UserLite {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  _count?: { orders: number };
}

interface UserDetail extends UserLite {
  addresses: (Address & { id: string; isDefault: boolean })[];
}

/**
 * Chọn khách hàng cho đơn tạo thủ công: tìm thành viên (vai trò khách hàng) hoặc nhập khách lẻ.
 * Chọn thành viên -> gợi ý sổ địa chỉ (bấm để điền địa chỉ giao hàng).
 */
export function CustomerPicker({ value, onChange, onPickAddress, disabled }: { value: CustomerForm; onChange: (v: CustomerForm) => void; onPickAddress?: (a: Address) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const q = useDebounce(search.trim(), 300);
  const results = useQuery({
    queryKey: ['users', 'customer-picker', q],
    queryFn: () => api.get<Paginated<UserLite>>('/admin/users', { type: 'customer', search: q, limit: 8 }),
    enabled: !value.userId && (focused || !!q),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({ queryKey: ['user', value.userId], queryFn: () => api.get<UserDetail>(`/admin/users/${value.userId}`), enabled: !!value.userId });

  const pick = (u: UserLite) => {
    onChange({ userId: u.id, name: u.name, email: u.email ?? '', phone: u.phone ?? '' });
    setSearch('');
  };
  const clear = () => onChange({ userId: null, name: '', email: '', phone: '' });

  return (
    <div className="space-y-3">
      {value.userId ? (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRound className="size-4" />
          </div>
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{detail.data?.name ?? value.name}</div>
            <div className="text-xs text-muted-foreground">
              {detail.data?.email ?? value.email}
              {detail.data?._count && ` · ${detail.data._count.orders} đơn trước`}
            </div>
          </div>
          <Badge variant="secondary">Thành viên</Badge>
          {!disabled && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label="Bỏ chọn khách">
              <X />
            </Button>
          )}
        </div>
      ) : (
        !disabled && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Tìm thành viên theo tên, email, SĐT (bỏ trống = khách lẻ)" className="pl-8" />
            {(focused || q) && (
              <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
                {results.isLoading ? (
                  <div className="flex justify-center p-4">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : !results.data?.data.length ? (
                  <p className="p-3 text-center text-sm text-muted-foreground">Không tìm thấy thành viên — nhập thông tin khách lẻ bên dưới</p>
                ) : (
                  results.data.data.map((u) => (
                    <button key={u.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(u)} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1 font-medium">{u.name}</span>
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {u.email}
                          {u.phone && ` · ${u.phone}`}
                        </span>
                      </span>
                      {u._count && <span className="text-xs text-muted-foreground">{u._count.orders} đơn</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tên khách hàng" required>
          <Input value={value.name} disabled={disabled} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Nguyễn Văn A" />
        </Field>
        <Field label="Điện thoại" required>
          <Input value={value.phone} disabled={disabled} onChange={(e) => onChange({ ...value, phone: e.target.value })} placeholder="09xx xxx xxx" inputMode="tel" />
        </Field>
        <Field label="Email" help="Cần có email để gửi xác nhận / hoá đơn">
          <Input value={value.email} disabled={disabled} onChange={(e) => onChange({ ...value, email: e.target.value })} placeholder="khach@example.com" type="email" />
        </Field>
      </div>

      {value.userId && onPickAddress && (detail.data?.addresses.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Sổ địa chỉ của khách — bấm để dùng làm địa chỉ giao hàng</p>
          <div className="flex flex-wrap gap-2">
            {detail.data!.addresses.map((a) => (
              <button key={a.id} type="button" disabled={disabled} onClick={() => onPickAddress({ fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2 ?? '', ward: a.ward ?? '', district: a.district ?? '', city: a.city ?? '', country: a.country ?? 'VN' })} className="flex max-w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs hover:bg-muted">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="font-medium">
                    {a.fullName} · {a.phone}
                  </span>
                  {a.isDefault && <Badge variant="outline" className="ml-1.5 h-4 px-1 text-[10px]">Mặc định</Badge>}
                  <span className="block text-muted-foreground">{formatAddress(a)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
