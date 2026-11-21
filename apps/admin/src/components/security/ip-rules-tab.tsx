'use client';

/**
 * Tab Danh sách IP: quản lý IP bị chặn (toàn site) và danh sách IP được phép vào trang quản trị.
 * Kiểm tra định dạng IP/CIDR phía client bằng normalizeIpRule trước khi gửi API.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, Loader2, LockKeyhole, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { normalizeIpRule, type IpRuleType, type IpRuleView } from '@cmsnt/shared';
import { useConfirm } from '@/components/common/confirm-dialog';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { DURATION_OPTIONS, SECURITY_KEYS, ToneBadge, WARN_BOX, useInvalidateSecurity, type AddIpRulesResult } from './shared';

/** Phản hồi GET /admin/security/ip-rules */
interface IpRulesResponse {
  rules: IpRuleView[];
  adminAllowlistEnabled: boolean;
  yourIp: string | null;
}

/** Tách chuỗi nhập (xuống dòng / dấu phẩy / chấm phẩy / khoảng trắng) thành danh sách giá trị */
function splitValues(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Danh sách giá trị không hợp lệ theo normalizeIpRule (kiểm tra trước khi gửi) */
function invalidValues(input: string): string[] {
  return splitValues(input).filter((v) => normalizeIpRule(v) === null);
}

/** Hook tải danh sách quy tắc theo loại */
function useIpRules(type: IpRuleType) {
  return useQuery({
    queryKey: [...SECURITY_KEYS.ipRules, type],
    queryFn: () => api.get<IpRulesResponse>('/admin/security/ip-rules', { type }),
  });
}

/** Hiện danh sách lỗi từng dòng (từ client hoặc server) */
function LineErrors({ errors }: { errors: { value: string; message: string }[] }) {
  if (!errors.length) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      {errors.map((e, i) => (
        <li key={`${e.value}-${i}`}>
          <span className="font-mono font-medium">{e.value}</span>: {e.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * Hook thêm quy tắc: validate client → POST → báo kết quả (toast) + giữ lỗi từng dòng.
 * Trả `submit(value, extra)` → true nếu đã thêm được ít nhất 1 giá trị.
 */
function useAddRules(type: IpRuleType) {
  const invalidate = useInvalidateSecurity();
  const [errors, setErrors] = useState<{ value: string; message: string }[]>([]);
  const mutation = useMutation({
    mutationFn: (body: { value: string; note?: string; durationMinutes?: number }) => api.post<AddIpRulesResult>('/admin/security/ip-rules', { type, ...body }),
  });
  const submit = async (value: string, extra: { note?: string; durationMinutes?: number } = {}) => {
    const values = splitValues(value);
    if (!values.length) {
      setErrors([{ value: '(trống)', message: 'Nhập ít nhất một IP hoặc dải CIDR' }]);
      return false;
    }
    const bad = invalidValues(value);
    if (bad.length) {
      setErrors(bad.map((v) => ({ value: v, message: 'Không phải IP hoặc dải CIDR hợp lệ (vd 1.2.3.4, 1.2.3.0/24, 2001:db8::/32)' })));
      return false;
    }
    setErrors([]);
    try {
      const res = await mutation.mutateAsync({ value: values.join('\n'), note: extra.note?.trim() || undefined, durationMinutes: extra.durationMinutes });
      setErrors(res.errors);
      if (res.added.length) toast.success(`Đã thêm ${res.added.length} quy tắc`);
      if (res.errors.length) toast.warning(`${res.errors.length} giá trị không thêm được`);
      invalidate();
      return res.added.length > 0;
    } catch (err) {
      // 400 khi chỉ gửi 1 giá trị và giá trị đó lỗi
      setErrors([{ value: values[0], message: errorMessage(err) }]);
      toast.error(errorMessage(err));
      return false;
    }
  };
  return { submit, errors, setErrors, pending: mutation.isPending };
}

/** Hook gỡ quy tắc có xác nhận; lỗi server (vd tự khoá mình) hiện bằng toast */
function useRemoveRule(type: IpRuleType) {
  const confirm = useConfirm();
  const invalidate = useInvalidateSecurity();
  const mutation = useMutation({
    mutationFn: (id: string) => api.delete<{ success: true }>(`/admin/security/ip-rules/${id}`),
    onSuccess: () => {
      toast.success(type === 'block' ? 'Đã gỡ chặn IP' : 'Đã xoá IP khỏi danh sách cho phép');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = async (rule: IpRuleView) => {
    const ok = await confirm(
      type === 'block'
        ? { title: `Gỡ chặn ${rule.value}?`, description: 'IP này sẽ truy cập lại được website và trang quản trị ngay lập tức.', confirmText: 'Gỡ chặn' }
        : { title: `Xoá ${rule.value} khỏi danh sách cho phép?`, description: 'Các máy dùng IP này sẽ không vào được trang quản trị nữa khi danh sách cho phép đang bật.', confirmText: 'Xoá', destructive: true },
    );
    if (ok) mutation.mutate(rule.id);
  };
  return { remove, pendingId: mutation.isPending ? mutation.variables : undefined };
}

/**
 * Hook tích chọn + gỡ hàng loạt quy tắc IP (gọi DELETE đơn lẻ cho từng id, nên server vẫn chặn trường hợp tự khoá mình).
 * Trả về state chọn cho DataTable và thanh ListToolbar chứa nút gỡ.
 */
function useBulkRemoveRules(type: IpRuleType) {
  const confirm = useConfirm();
  const invalidate = useInvalidateSecurity();
  const bulk = useBulkAction();
  const [selected, setSelected] = useState<string[]>([]);
  const isBlock = type === 'block';

  const removeSelected = async () => {
    const n = selected.length;
    const ok = await confirm(
      isBlock
        ? { title: `Gỡ chặn ${n} IP?`, description: 'Các IP này sẽ truy cập lại được website và trang quản trị ngay lập tức.', confirmText: 'Gỡ chặn', destructive: true }
        : { title: `Xoá ${n} IP khỏi danh sách cho phép?`, description: 'Các máy dùng những IP này sẽ không vào được trang quản trị nữa khi danh sách cho phép đang bật.', confirmText: 'Xoá', destructive: true },
    );
    if (!ok) return;
    void bulk.run({
      ids: selected,
      action: (id) => api.delete(`/admin/security/ip-rules/${id}`),
      doneLabel: isBlock ? 'Đã gỡ chặn' : 'Đã xoá',
      onDone: () => {
        setSelected([]);
        invalidate();
      },
    });
  };

  const toolbar = (
    <ListToolbar
      selectedCount={selected.length}
      onClearSelection={() => setSelected([])}
      bulkActions={
        <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={() => void removeSelected()}>
          {bulk.pending ? <Loader2 className="animate-spin" /> : <Trash2 />} {isBlock ? 'Gỡ chặn' : 'Xoá'}
        </Button>
      }
    />
  );
  return { selected, setSelected, toolbar };
}

/** Ô "người thêm + thời điểm thêm" */
function CreatedCell({ rule }: { rule: IpRuleView }) {
  return (
    <div className="whitespace-nowrap text-xs">
      <p>{rule.createdBy?.name ?? (rule.source === 'auto' ? 'Hệ thống' : '—')}</p>
      <p className="text-muted-foreground" title={formatDate(rule.createdAt)}>
        {timeAgo(rule.createdAt)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------- IP bị chặn

function BlockSection() {
  const { data, isLoading, error, refetch } = useIpRules('block');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [duration, setDuration] = useState('1440');
  const add = useAddRules('block');
  const { remove, pendingId } = useRemoveRule('block');
  const bulkRemove = useBulkRemoveRules('block');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await add.submit(value, { note, durationMinutes: duration === 'forever' ? undefined : Number(duration) });
    if (ok) {
      setValue('');
      setNote('');
    }
  };

  const columns: Column<IpRuleView>[] = [
    { key: 'value', header: 'IP / CIDR', cell: (r) => <span className="font-mono text-sm font-medium">{r.value}</span> },
    {
      key: 'source',
      header: 'Nguồn',
      cell: (r) => (r.source === 'auto' ? <ToneBadge tone="amber" title="Tự chặn do đăng nhập sai quá nhiều lần">Tự động</ToneBadge> : <ToneBadge tone="slate">Thủ công</ToneBadge>),
    },
    { key: 'note', header: 'Ghi chú', cell: (r) => <span className="line-clamp-2 max-w-56 text-xs text-muted-foreground">{r.note || '—'}</span> },
    {
      key: 'expiresAt',
      header: 'Hết hạn',
      cell: (r) =>
        r.expiresAt ? (
          <span className="whitespace-nowrap text-xs" title={formatDate(r.expiresAt)}>
            {formatDate(r.expiresAt, 'dd/MM HH:mm')} <span className="text-muted-foreground">({timeAgo(r.expiresAt)})</span>
          </span>
        ) : (
          <ToneBadge tone="red">Vĩnh viễn</ToneBadge>
        ),
    },
    {
      key: 'hits',
      header: 'Lượt chặn',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <p className="font-medium tabular-nums">{r.hits.toLocaleString('vi-VN')}</p>
          {r.lastHitAt && <p className="text-muted-foreground" title={formatDate(r.lastHitAt)}>Gần nhất {timeAgo(r.lastHitAt)}</p>}
        </div>
      ),
    },
    { key: 'createdBy', header: 'Người thêm', cell: (r) => <CreatedCell rule={r} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cell: (r) => (
        <Button size="sm" variant="outline" disabled={pendingId === r.id} onClick={() => remove(r)}>
          {pendingId === r.id ? <Loader2 className="animate-spin" /> : <Trash2 />} Gỡ chặn
        </Button>
      ),
    },
  ];

  return (
    <Section title="IP bị chặn" description="IP / dải CIDR bị chặn không truy cập được cả website lẫn trang quản trị. Hệ thống cũng tự thêm IP dò mật khẩu vào đây.">
      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <Field label="IP hoặc dải CIDR" htmlFor="block-value" help="Mỗi dòng một giá trị, hoặc cách nhau bằng dấu phẩy. Ví dụ: 203.0.113.5, 198.51.100.0/24, 2001:db8::/32">
          <Textarea
            id="block-value"
            rows={4}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (add.errors.length) add.setErrors([]);
            }}
            placeholder={'203.0.113.5\n198.51.100.0/24'}
            className="font-mono text-sm"
          />
        </Field>
        <div className="space-y-4">
          <Field label="Thời hạn chặn" htmlFor="block-duration">
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger id="block-duration" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Ghi chú" htmlFor="block-note">
            <Input id="block-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vd: spam đơn hàng, dò mật khẩu..." maxLength={200} />
          </Field>
          <Button type="submit" className="w-full" disabled={add.pending || !value.trim()}>
            {add.pending ? <Loader2 className="animate-spin" /> : <Ban />} Chặn IP
          </Button>
        </div>
        <div className="lg:col-span-2">
          <LineErrors errors={add.errors} />
        </div>
      </form>

      {bulkRemove.toolbar}
      <DataTable
        columns={columns}
        data={data?.rules}
        loading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        selectable
        selected={bulkRemove.selected}
        onSelectedChange={bulkRemove.setSelected}
        emptyTitle="Chưa chặn IP nào"
        emptyDescription="Các IP bị chặn thủ công hoặc tự động sẽ hiện ở đây."
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------- Chỉ cho phép IP vào quản trị

function AllowlistSection() {
  const { data, isLoading, error, refetch } = useIpRules('allow_admin');
  const invalidate = useInvalidateSecurity();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const add = useAddRules('allow_admin');
  const { remove, pendingId } = useRemoveRule('allow_admin');
  const bulkRemove = useBulkRemoveRules('allow_admin');
  const enabled = !!data?.adminAllowlistEnabled;
  const yourIp = data?.yourIp ?? null;
  const rules = data?.rules ?? [];

  // bật/tắt danh sách cho phép — server từ chối (400) nếu IP hiện tại không nằm trong danh sách
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.put<{ enabled: boolean }>('/admin/security/admin-allowlist', { enabled: next }),
    onSuccess: (res) => {
      toast.success(res.enabled ? 'Đã bật giới hạn IP vào trang quản trị' : 'Đã tắt giới hạn IP vào trang quản trị');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** Điền IP hiện tại vào ô nhập (nối thêm nếu ô đã có nội dung) */
  const addMyIp = () => {
    if (!yourIp) return;
    if (splitValues(value).includes(yourIp)) return;
    setValue((v) => (v.trim() ? `${v.trim()}\n${yourIp}` : yourIp));
    if (!note.trim()) setNote('IP của tôi');
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await add.submit(value, { note })) {
      setValue('');
      setNote('');
    }
  };

  const columns: Column<IpRuleView>[] = [
    {
      key: 'value',
      header: 'IP / CIDR',
     
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{r.value}</span>
          {yourIp && r.value === yourIp && <ToneBadge tone="green">IP của bạn</ToneBadge>}
        </span>
      ),
    },
    { key: 'note', header: 'Ghi chú', cell: (r) => <span className="line-clamp-2 max-w-64 text-xs text-muted-foreground">{r.note || '—'}</span> },
    { key: 'createdBy', header: 'Người thêm', cell: (r) => <CreatedCell rule={r} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cell: (r) => (
        <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400" disabled={pendingId === r.id} onClick={() => remove(r)} aria-label={`Xoá ${r.value}`} title="Xoá khỏi danh sách">
          {pendingId === r.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Chỉ cho phép IP vào trang quản trị"
      description="Khi bật, chỉ các IP trong danh sách dưới đây mới mở được trang quản trị và đăng nhập quản trị. Website bán hàng không bị ảnh hưởng."
      actions={
        <div className="flex shrink-0 items-center gap-2">
          {toggle.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Switch checked={enabled} disabled={isLoading || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Bật giới hạn IP vào trang quản trị" />
        </div>
      }
    >
      {enabled ? (
        <div className={cn(WARN_BOX, 'flex gap-2.5')}>
          <LockKeyhole className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Đang bật: chỉ {rules.length} IP / dải IP trong danh sách được vào trang quản trị.</p>
            <p className="mt-0.5 text-xs opacity-90">Nếu IP mạng của bạn thay đổi (đổi wifi, 4G, nhà mạng cấp IP động), bạn sẽ bị chặn khỏi trang quản trị. Khi đó cần sửa trực tiếp trên máy chủ để mở lại.</p>
          </div>
        </div>
      ) : (
        <div className="flex gap-2.5 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>
            Rủi ro tự khoá mình: chỉ nên bật khi bạn có IP tĩnh (văn phòng, VPN công ty). Hãy thêm <b className="text-foreground">IP hiện tại của bạn</b> trước khi bật — hệ thống sẽ từ chối bật nếu IP của bạn chưa có trong danh sách.
          </p>
        </div>
      )}

      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <Field
          label="IP hoặc dải CIDR được phép"
          htmlFor="allow-value"
          help="Mỗi dòng một giá trị, hoặc cách nhau bằng dấu phẩy."
          action={
            yourIp ? (
              <Button type="button" size="xs" variant="outline" onClick={addMyIp}>
                <UserPlus /> Thêm IP của tôi
              </Button>
            ) : undefined
          }
        >
          <Textarea
            id="allow-value"
            rows={3}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (add.errors.length) add.setErrors([]);
            }}
            placeholder={yourIp ?? '203.0.113.5'}
            className="font-mono text-sm"
          />
        </Field>
        <div className="space-y-4">
          <Field label="Ghi chú" htmlFor="allow-note">
            <Input id="allow-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vd: văn phòng, VPN..." maxLength={200} />
          </Field>
          <Button type="submit" className="w-full" disabled={add.pending || !value.trim()}>
            {add.pending ? <Loader2 className="animate-spin" /> : <Plus />} Thêm vào danh sách
          </Button>
        </div>
        <div className="space-y-2 lg:col-span-2">
          <LineErrors errors={add.errors} />
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              IP của bạn: <span className="font-mono font-medium text-foreground">{yourIp ?? 'không xác định'}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3.5" /> Địa chỉ nội bộ máy chủ (127.0.0.1) luôn được phép
            </span>
          </p>
        </div>
      </form>

      {bulkRemove.toolbar}
      <DataTable
        columns={columns}
        data={rules}
        loading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        selectable
        selected={bulkRemove.selected}
        onSelectedChange={bulkRemove.setSelected}
        emptyTitle="Danh sách cho phép đang trống"
        emptyDescription="Thêm ít nhất IP của bạn trước khi bật giới hạn."
      />
    </Section>
  );
}

export function IpRulesTab() {
  return (
    <div className="space-y-6">
      <BlockSection />
      <AllowlistSection />
    </div>
  );
}
