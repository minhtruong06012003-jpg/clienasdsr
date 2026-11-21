'use client';

/**
 * Tab "Số dư & AI" ở trang chi tiết thành viên (số dư chạy AI chính là số dư ví, đơn vị VND):
 * - Số dư ví, tổng tiền đã chi chạy AI, gói đang dùng + hạn, tổng đã chi mua gói nạp tiền (GET /admin/users/:id/credits);
 * - Cộng / trừ số dư ví thủ công (POST .../adjust, có khoá chống bấm trùng) và giảm giá riêng khi mua gói nạp tiền (PUT .../discount);
 * - Lịch sử biến động số dư do AI Studio ghi (GET .../transactions).
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Field, Section } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { DataTable, type Column } from '@/components/common/data-table';
import { CREDIT_TXN, ToneBadge, fmtCredits, type PaginatedWithCounts } from '@/components/ai/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { uuid } from '@/lib/uuid';

interface Summary {
  /** Số dư ví làm tròn (VND) — trường cũ, giữ tên từ thời credits */
  credits: number;
  /** Số dư ví (VND) */
  wallet: number;
  plan: { name: string; expiresAt: string | null; active: boolean } | null;
  concurrency: number;
  /** Tổng tiền (VND) đã chi chạy công cụ AI */
  totalUsed: number;
  /** Tổng đã chi mua gói nạp tiền, giảm giá riêng của khách, chiết khấu nâng cấp gói đang cài (%) */
  pricing: { spent: number; customDiscount: number };
}

interface Txn {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export function CreditsPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [discount, setDiscount] = useState<number | null>(null);
  // khoá chống trùng: đổi sau mỗi lần ghi thành công
  const [key, setKey] = useState(() => uuid());
  const summary = useQuery({ queryKey: ['user-credits', userId], queryFn: () => api.get<Summary>(`/admin/users/${userId}/credits`) });
  const txns = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['user-credit-txns', userId, page],
    queryFn: () => api.get<PaginatedWithCounts<Txn>>(`/admin/users/${userId}/credits/transactions`, { page, limit: 15 }),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['user-credits', userId] });
    qc.invalidateQueries({ queryKey: ['user-credit-txns', userId] });
    qc.invalidateQueries({ queryKey: ['user', userId] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const adjust = useMutation({
    mutationFn: (type: 'add' | 'subtract') => api.post(`/admin/users/${userId}/credits/adjust`, { type, amount, note: note.trim() || undefined, idempotencyKey: key }),
    onSuccess: () => {
      toast.success('Đã cập nhật số dư ví');
      setAmount(null);
      setNote('');
      setKey(uuid());
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const saveDiscount = useMutation({
    mutationFn: () => api.put(`/admin/users/${userId}/credits/discount`, { discount: discount ?? 0 }),
    onSuccess: () => {
      toast.success('Đã lưu giảm giá riêng');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = summary.data;
  const columns: Column<Txn>[] = useMemo(
    () => [
      { key: 'time', header: 'Thời gian', mobile: 'primary', cell: (r) => <span className="text-xs whitespace-nowrap">{formatDate(r.createdAt)}</span> },
      { key: 'type', header: 'Loại', cell: (r) => <ToneBadge map={CREDIT_TXN} value={r.type} /> },
      { key: 'note', header: 'Diễn giải', cell: (r) => <span className="line-clamp-1 text-sm">{r.note}</span> },
      { key: 'amount', header: 'Số tiền', cell: (r) => <span className={r.amount > 0 ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>{r.amount > 0 ? '+' : ''}{fmtCredits(r.amount)}</span> },
      { key: 'after', header: 'Số dư sau', cell: (r) => <span className="tabular-nums">{fmtCredits(r.balanceAfter)}</span> },
    ],
    [],
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Số dư ví" value={fmtCredits(s?.wallet ?? s?.credits)} />
          <Stat label="Đã chi chạy AI" value={fmtCredits(s?.totalUsed)} />
          <Stat label="Gói" value={s?.plan?.active ? `${s.plan.name}${s.plan.expiresAt ? ` · hết hạn ${formatDate(s.plan.expiresAt, 'dd/MM/yyyy')}` : ''}` : 'Chưa có'} />
          <Stat label="Tổng đã mua gói" value={formatMoney(s?.pricing.spent ?? 0)} />
        </div>
        <Section title="Lịch sử biến động (AI Studio)">
          <DataTable columns={columns} data={txns.data?.data} meta={txns.data?.meta} loading={txns.isLoading} error={txns.error} onPageChange={setPage} emptyTitle="Chưa có biến động" />
        </Section>
      </div>
      <div className="space-y-6">
        {can('users.wallet') && (
          <Section title="Cộng / trừ số dư (ví)">
            <Field label="Số tiền">
              <NumberInput integer suffix="đ" value={amount} onChange={setAmount} />
            </Field>
            <Field label="Ghi chú (khách nhìn thấy)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd: Tặng khuyến mãi" />
            </Field>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!amount || adjust.isPending} onClick={() => adjust.mutate('add')}>
                Cộng
              </Button>
              <Button className="flex-1" variant="outline" disabled={!amount || adjust.isPending} onClick={() => adjust.mutate('subtract')}>
                Trừ
              </Button>
            </div>
          </Section>
        )}
        {can('users.wallet') && (
          <Section title="Chiết khấu giảm giá (%)" description="Giảm trực tiếp % chi phí cho toàn bộ công cụ AI & sản phẩm trên website đối với thành viên này.">
            <Field label="Chiết khấu (%)">
              <NumberInput suffix="%" value={discount} onChange={setDiscount} placeholder={String(s?.pricing.customDiscount ?? 0)} />
            </Field>
            <Button variant="outline" disabled={discount === null || saveDiscount.isPending} onClick={() => saveDiscount.mutate()}>
              Lưu chiết khấu
            </Button>
          </Section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-semibold">{value}</div>
    </div>
  );
}
