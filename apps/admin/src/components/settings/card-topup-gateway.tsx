'use client';

/**
 * Phần cấu hình "Nạp thẻ cào" trong Cài đặt › Cổng thanh toán (nhóm cài đặt `card_topup`).
 * Danh sách nhà cung cấp đổi thẻ lấy từ API `/admin/card-topup/providers` (khai báo ở
 * apps/api/src/modules/card-topup/providers/index.ts) nên thêm nhà cung cấp mới không phải sửa file này.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react';
import { Field } from '@/components/common/field';
import { CopyButton } from '@/components/common/copy-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SecretInput } from './inputs';
import type { Values } from './settings-group';

export interface CardProviderOption {
  key: string;
  label: string;
  website: string;
  /** Nhà cung cấp "tuỳ chỉnh" — admin tự nhập tên miền */
  needsDomain: boolean;
  callbackUrl: string;
}
export interface CardProvidersInfo {
  enabled: boolean;
  configured: boolean;
  active: string | null;
  providers: CardProviderOption[];
}

interface TelcoRow {
  code: string;
  name: string;
  enabled: boolean;
  discount?: number | null;
  serialLength?: string;
  pinLength?: string;
}

/** Mệnh giá thường gặp — admin bấm để bật/tắt */
const AMOUNT_PRESETS = [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000, 2000000, 5000000];
const shortMoney = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}tr` : `${n / 1000}k`);

export function useCardProviders(enabled = true) {
  return useQuery({ queryKey: ['card-topup-providers'], queryFn: () => api.get<CardProvidersInfo>('/admin/card-topup/providers'), enabled, staleTime: 5 * 60_000 });
}

/** Trường còn thiếu để nạp thẻ chạy được */
export function validateCardTopup(v: Values, providers?: CardProviderOption[]): string[] {
  const m: string[] = [];
  const p = providers?.find((x) => x.key === v.provider);
  if (!v.provider) m.push('Nhà cung cấp');
  if (p?.needsDomain && !v.domain) m.push('Tên miền');
  if (!v.partnerId) m.push('Partner ID');
  if (!v.partnerKey) m.push('Partner Key');
  if (!((v.telcos as TelcoRow[] | undefined) ?? []).some((t) => t.enabled && t.code)) m.push('Loại thẻ');
  if (!((v.amounts as number[] | undefined) ?? []).length) m.push('Mệnh giá');
  return m;
}

/** URL callback của nhà cung cấp đang chọn (khai báo bên site đổi thẻ) */
export function CardCallbackUrl({ provider, info, loading, canRead }: { provider?: string; info?: CardProvidersInfo; loading: boolean; canRead: boolean }) {
  if (!canRead) return <p className="text-xs text-muted-foreground">Cần quyền “Cài đặt”.</p>;
  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const url = info?.providers.find((p) => p.key === provider)?.callbackUrl;
  if (!url) return <p className="text-xs text-muted-foreground">Chọn nhà cung cấp để lấy URL.</p>;
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 select-all truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs">{url}</code>
      <CopyButton text={url} size="xs" />
    </div>
  );
}

/** Form cấu hình nạp thẻ cào */
export function CardTopupFields({ value: v, set, providers }: { value: Values; set: (patch: Values) => void; providers?: CardProviderOption[] }) {
  const current = providers?.find((p) => p.key === v.provider);
  const telcos: TelcoRow[] = (v.telcos as TelcoRow[] | undefined) ?? [];
  const amounts: number[] = ((v.amounts as number[] | undefined) ?? []).map(Number);
  const creditMode = v.creditMode || 'discount';
  const setTelco = (i: number, patch: Partial<TelcoRow>) => set({ telcos: telcos.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const toggleAmount = (a: number) => set({ amounts: amounts.includes(a) ? amounts.filter((x) => x !== a) : [...amounts, a].sort((x, y) => x - y) });

  return (
    <div className="space-y-4">
      {/* Kết nối nhà cung cấp */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Nhà cung cấp" help={current?.website ? <a href={current.website} target="_blank" rel="noreferrer" className="hover:underline">{current.website.replace(/^https?:\/\//, '')}</a> : undefined}>
          <Select value={v.provider || ''} onValueChange={(provider) => set({ provider })}>
            <SelectTrigger>
              <SelectValue placeholder="Chọn nhà cung cấp" />
            </SelectTrigger>
            <SelectContent>
              {(providers ?? []).map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Partner ID">
          <Input value={v.partnerId ?? ''} onChange={(e) => set({ partnerId: e.target.value.trim() })} className="font-mono text-sm" autoComplete="off" />
        </Field>
        <Field label="Partner Key">
          <SecretInput value={v.partnerKey} onChange={(partnerKey) => set({ partnerKey: partnerKey.trim() })} />
        </Field>
      </div>
      {current?.needsDomain && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tên miền site đổi thẻ" className="sm:col-span-2" help="Site theo chuẩn /chargingws/v2, vd https://doithe.vn">
            <Input value={v.domain ?? ''} onChange={(e) => set({ domain: e.target.value.trim() })} placeholder="https://..." className="font-mono text-sm" />
          </Field>
          <Field label="Cách gửi thẻ">
            <Select value={v.method || 'POST'} onValueChange={(method) => set({ method })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="POST">POST (form)</SelectItem>
                <SelectItem value="GET">GET (query)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}

      {/* Cách cộng tiền vào ví */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Cộng vào ví">
          <Select value={creditMode} onValueChange={(c) => set({ creditMode: c })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="discount">Mệnh giá − chiết khấu của shop</SelectItem>
              <SelectItem value="provider">Đúng số tiền nhà cung cấp trả</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {creditMode === 'discount' && (
          <>
            <Field label="Chiết khấu chung (%)" help="Vd 20% → thẻ 100k cộng 80k">
              <Input type="number" min={0} max={100} step={0.5} value={v.discount ?? 0} onChange={(e) => set({ discount: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Phạt sai mệnh giá (%)" help="Trừ thêm trên mệnh giá thật">
              <Input type="number" min={0} max={100} step={1} value={v.wrongValuePenalty ?? 50} onChange={(e) => set({ wrongValuePenalty: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
            </Field>
          </>
        )}
      </div>

      {/* Loại thẻ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Loại thẻ nhận</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => set({ telcos: [...telcos, { code: '', name: '', enabled: true, discount: null, serialLength: '', pinLength: '' }] })}>
            <Plus /> Thêm loại thẻ
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-10 px-2 py-1.5 text-left font-medium">Bật</th>
                <th className="px-2 py-1.5 text-left font-medium">Mã gửi đi</th>
                <th className="px-2 py-1.5 text-left font-medium">Tên hiển thị</th>
                {creditMode === 'discount' && <th className="w-28 px-2 py-1.5 text-left font-medium">CK riêng %</th>}
                <th className="w-24 px-2 py-1.5 text-left font-medium" title="Độ dài serial hợp lệ, phân tách dấu phẩy">Độ dài serial</th>
                <th className="w-24 px-2 py-1.5 text-left font-medium" title="Độ dài mã thẻ hợp lệ, phân tách dấu phẩy">Độ dài mã</th>
                <th className="w-9" />
              </tr>
            </thead>
            <tbody>
              {telcos.map((t, i) => (
                <tr key={i} className={cn('border-t', !t.enabled && 'text-muted-foreground')}>
                  <td className="px-2 py-1">
                    <Checkbox checked={!!t.enabled} onCheckedChange={(c) => setTelco(i, { enabled: c === true })} aria-label={`Bật ${t.name || t.code}`} />
                  </td>
                  <td className="px-2 py-1">
                    <Input value={t.code} onChange={(e) => setTelco(i, { code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} className="h-8 font-mono text-xs" placeholder="VIETTEL" />
                  </td>
                  <td className="px-2 py-1">
                    <Input value={t.name} onChange={(e) => setTelco(i, { name: e.target.value })} className="h-8 text-xs" placeholder="Viettel" />
                  </td>
                  {creditMode === 'discount' && (
                    <td className="px-2 py-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={t.discount ?? ''}
                        placeholder={String(v.discount ?? 0)}
                        onChange={(e) => setTelco(i, { discount: e.target.value === '' ? null : Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                        className="h-8 text-xs"
                      />
                    </td>
                  )}
                  <td className="px-2 py-1">
                    <Input value={t.serialLength ?? ''} onChange={(e) => setTelco(i, { serialLength: e.target.value.replace(/[^0-9,]/g, '') })} className="h-8 font-mono text-xs" placeholder="—" />
                  </td>
                  <td className="px-2 py-1">
                    <Input value={t.pinLength ?? ''} onChange={(e) => setTelco(i, { pinLength: e.target.value.replace(/[^0-9,]/g, '') })} className="h-8 font-mono text-xs" placeholder="—" />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => set({ telcos: telcos.filter((_, j) => j !== i) })} aria-label="Xoá loại thẻ">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
              {telcos.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Chưa có loại thẻ nào.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">“Mã gửi đi” phải đúng mã nhà cung cấp quy định. Để trống độ dài nếu không muốn kiểm tra.</p>
      </div>

      {/* Mệnh giá */}
      <Field label="Mệnh giá nhận">
        <div className="flex flex-wrap gap-1.5">
          {AMOUNT_PRESETS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => toggleAmount(a)}
              aria-pressed={amounts.includes(a)}
              className={cn('rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition', amounts.includes(a) ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted')}
            >
              {shortMoney(a)}
            </button>
          ))}
        </div>
      </Field>

      {/* Chống spam */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Thẻ chờ tối đa / người">
          <Input type="number" min={1} max={50} value={v.maxPending ?? 5} onChange={(e) => set({ maxPending: Math.min(50, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} />
        </Field>
        <Field label="Thẻ lỗi tối đa / ngày" help="Vượt thì khoá tới hết ngày · 0 = không giới hạn">
          <Input type="number" min={0} max={100} value={v.dailyFailLimit ?? 5} onChange={(e) => set({ dailyFailLimit: Math.min(100, Math.max(0, Math.floor(Number(e.target.value) || 0))) })} />
        </Field>
      </div>

      <Field label="Lưu ý hiển thị cho khách" help="Hiện ở form nạp thẻ trên website (API public/card-topup/config)">
        <Textarea value={v.notice ?? ''} onChange={(e) => set({ notice: e.target.value })} rows={2} placeholder="Chọn đúng mệnh giá, sai mệnh giá sẽ bị trừ 50%..." />
      </Field>

      <Link href="/orders/card-topups" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        Xem lịch sử nạp thẻ <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
