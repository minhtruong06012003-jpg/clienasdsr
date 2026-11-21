'use client';

/**
 * Các tab Cài đặt › Bot Telegram (API: modules/telegram):
 * - TelegramUserTab: bot báo khách (nhóm `telegram_user`) — khách liên kết ở trang Tài khoản trên website,
 *   admin chọn loại thông báo được gửi (khách tự tắt bớt).
 * - TelegramAdminTab: bot báo quản trị (nhóm `telegram_admin`) — chat nhận, loại sự kiện, ngưỡng cảnh báo số dư từng nguồn API AI.
 * Token bot là trường bí mật (API che "••••••••"). Tạo bot ở @BotFather, lấy Chat ID bằng lệnh /id với bot.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, Loader2, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Field, Section } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SecretInput, SwitchRow } from './inputs';
import { SettingsGroup, type SetValues, type Values } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

interface BotStatus {
  enabled: boolean;
  ok: boolean;
  username?: string;
  name?: string;
  error?: string;
  pollError: string | null;
}
interface TelegramStatus {
  polling: boolean;
  user: BotStatus & { linkedUsers: number };
  admin: BotStatus & { chats: number; sharedToken: boolean };
}
interface BalanceRow {
  key: string;
  name: string;
  balance: number | null;
  unit: string | null;
  threshold: number | null;
  level: 'ok' | 'low' | 'empty' | 'error';
  error?: string;
}

/** Loại thông báo gửi khách (khớp USER_EVENTS ở API) */
const USER_EVENTS: { key: string; label: string; desc: string }[] = [
  { key: 'taskSucceeded', label: 'Tác vụ AI hoàn thành', desc: 'Kèm link xem kết quả' },
  { key: 'taskFailed', label: 'Tác vụ AI lỗi / bị huỷ', desc: 'Kèm lý do và số tiền đã hoàn vào ví' },
  { key: 'topup', label: 'Nạp tiền vào ví', desc: 'Số tiền đã nạp và số dư ví' },
  { key: 'plan', label: 'Mua gói nạp tiền', desc: 'Tên gói, số tiền cộng vào ví, số dư ví' },
  { key: 'affiliate', label: 'Tiếp thị liên kết', desc: 'Nhận hoa hồng, kết quả duyệt yêu cầu rút' },
];

/** Loại thông báo gửi quản trị (khớp ADMIN_EVENTS ở API) */
const ADMIN_EVENTS: { key: string; label: string; desc: string; off?: boolean }[] = [
  { key: 'lowBalance', label: 'Nguồn API sắp hết / hết tiền', desc: 'Kiểm tra số dư định kỳ theo ngưỡng bên dưới, báo cả khi đã nạp lại' },
  { key: 'newModel', label: 'Nguồn API thêm / gỡ model', desc: 'So danh mục model của nguồn định kỳ, báo model mới để thêm lên web' },
  { key: 'providerError', label: 'Nguồn API báo lỗi hết tiền', desc: 'Báo ngay khi tác vụ lỗi do nhà cung cấp hết credit / số dư' },
  { key: 'newUser', label: 'Thành viên mới đăng ký', desc: '' },
  { key: 'topup', label: 'Khách nạp tiền', desc: 'Nạp ví / thanh toán gói qua cổng' },
  { key: 'plan', label: 'Khách mua gói nạp tiền', desc: '' },
  { key: 'payout', label: 'Yêu cầu rút hoa hồng', desc: 'Cần duyệt ở AI Studio › Tiếp thị liên kết' },
  { key: 'needsRefund', label: 'Giao dịch cần hoàn tiền', desc: 'Tiền vào nhưng tài khoản nạp không còn tồn tại' },
  { key: 'security', label: 'Cảnh báo bảo mật', desc: 'Tự chặn IP, khoá tài khoản do sai mật khẩu nhiều lần' },
  { key: 'taskFailed', label: 'Mọi tác vụ AI lỗi', desc: 'Có thể nhiều tin — mặc định tắt', off: true },
];

const fmt = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

function useTelegramStatus() {
  return useQuery({ queryKey: ['telegram-status'], queryFn: () => api.get<TelegramStatus>('/admin/telegram/status') });
}

/** Hướng dẫn tạo bot (chung cho hai tab) */
function SetupGuide({ admin }: { admin?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p>
          Tạo bot: mở Telegram, chat với <b className="text-foreground">@BotFather</b> → gõ <code>/newbot</code> → đặt tên → copy <b className="text-foreground">token</b> dán vào ô dưới rồi Lưu.
        </p>
        {admin ? (
          <p>
            Lấy Chat ID: nhắn <code>/id</code> cho bot (hoặc thêm bot vào nhóm rồi gõ <code>/id</code>, Chat ID nhóm bắt đầu bằng dấu trừ). Trong chat đã khai báo gõ <code>/sources</code> xem số dư nguồn API,{' '}
            <code>/stats</code> xem thống kê hôm nay.
          </p>
        ) : (
          <p>
            Khách vào <b className="text-foreground">Tài khoản › Thông báo Telegram</b> trên website, bấm Liên kết để mở bot. Trong bot khách gõ <code>/me</code> xem số dư, <code>/stop</code> huỷ liên kết.
          </p>
        )}
      </div>
    </div>
  );
}

/** Trạng thái bot: token hợp lệ chưa, lỗi vòng nhận lệnh, nút gửi tin thử */
function BotStatusCard({ kind }: { kind: 'user' | 'admin' }) {
  const status = useTelegramStatus();
  const test = useMutation({
    mutationFn: () => api.post<{ sent: number; errors: string[] }>('/admin/telegram/test', { bot: kind }),
    onSuccess: (r) => (r.errors.length ? toast.warning(`Đã gửi ${r.sent} chat, lỗi: ${r.errors.join('; ')}`) : toast.success(`Đã gửi tin thử tới ${r.sent} chat`)),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const s = status.data?.[kind];
  return (
    <Section
      title="Trạng thái"
      actions={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => status.refetch()} disabled={status.isFetching}>
            <RefreshCw className={cn(status.isFetching && 'animate-spin')} /> Kiểm tra
          </Button>
          <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending || !s?.enabled || !s?.ok}>
            {test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Gửi tin thử
          </Button>
        </div>
      }
    >
      {status.isLoading ? (
        <p className="text-sm text-muted-foreground">Đang kiểm tra…</p>
      ) : !s ? (
        <p className="text-sm text-destructive">{errorMessage(status.error)}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2">
            {s.ok ? <CircleCheck className="size-4 text-emerald-600" /> : <CircleAlert className="size-4 text-amber-600" />}
            {s.ok ? (
              <span>
                Bot <b>@{s.username}</b> ({s.name}) — {s.enabled ? 'đang bật' : 'đang tắt'}
              </span>
            ) : (
              <span>{s.error}</span>
            )}
          </p>
          {kind === 'user' && status.data && <p className="text-muted-foreground">Khách đã liên kết: {status.data.user.linkedUsers.toLocaleString('vi-VN')}</p>}
          {kind === 'user' && <p className="text-xs text-muted-foreground">Gửi tin thử bot khách: gửi vào Telegram của chính tài khoản admin đang đăng nhập (cần liên kết ở trang Tài khoản website trước).</p>}
          {kind === 'admin' && status.data && (
            <p className="text-muted-foreground">
              Chat nhận thông báo: {status.data.admin.chats}
              {status.data.admin.sharedToken && ' · dùng chung token với bot khách'}
            </p>
          )}
          {!status.data?.polling && <p className="text-xs text-amber-600">Máy chủ này đang tắt nhận lệnh (TELEGRAM_POLLING=false): vẫn gửi được thông báo nhưng bot không trả lời lệnh /start, /id…</p>}
          {s.pollError && <p className="text-xs text-destructive">Nhận lệnh lỗi: {s.pollError}</p>}
        </div>
      )}
    </Section>
  );
}

/** Danh sách công tắc loại thông báo (lưu vào `events` của nhóm) */
function EventSwitches({ items, v, set, disabled }: { items: { key: string; label: string; desc: string; off?: boolean }[]; v: Values; set: SetValues; disabled?: boolean }) {
  const events = (v.events ?? {}) as Record<string, boolean>;
  return (
    <div className="divide-y">
      {items.map((e) => (
        <SwitchRow
          key={e.key}
          className="py-2 first:pt-0 last:pb-0"
          label={e.label}
          description={e.desc || undefined}
          // chưa lưu lần nào: theo mặc định của API (taskFailed admin mặc định tắt)
          checked={events[e.key] ?? !e.off}
          onChange={(on) => set({ events: { ...events, [e.key]: on } })}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

export function TelegramUserTab({ onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  return (
    <div className="space-y-6">
      <SetupGuide />
      <SettingsGroup group="telegram_user" onDirtyChange={onDirtyChange} onSaved={() => qc.invalidateQueries({ queryKey: ['telegram-status'] })}>
        {(v, set) => (
          <>
            <Section title="Bot thông báo cho khách" description="Khách liên kết Telegram để nhận thông báo tác vụ AI, nạp tiền, gói cước">
              <SwitchRow label="Bật bot thông báo khách" description="Tắt thì khách không liên kết được và không nhận tin nào" checked={v.enabled === true} onChange={(enabled) => set({ enabled })} />
              <Field label="Token bot" help="Dạng 123456789:AA… lấy từ @BotFather">
                <SecretInput value={v.botToken as string} onChange={(botToken) => set({ botToken: botToken.trim() })} placeholder="Dán token bot" />
              </Field>
            </Section>
            <Section title="Loại thông báo" description="Chỉ loại đang bật mới hiện cho khách chọn ở trang Tài khoản">
              <EventSwitches items={USER_EVENTS} v={v} set={set} disabled={v.enabled !== true} />
            </Section>
          </>
        )}
      </SettingsGroup>
      <BotStatusCard kind="user" />
    </div>
  );
}

/** Bảng số dư nguồn API + ô ngưỡng cảnh báo (lưu `thresholds` trong nhóm telegram_admin) */
function BalanceThresholds({ v, set }: { v: Values; set: SetValues }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['telegram-balances'], queryFn: () => api.get<{ rows: BalanceRow[] }>('/admin/telegram/balances') });
  // đọc lại số dư ngay ở nhà cung cấp rồi ghi đè cache của bảng
  const refresh = useMutation({
    mutationFn: () => api.get<{ rows: BalanceRow[] }>('/admin/telegram/balances?refresh=true'),
    onSuccess: (d) => qc.setQueryData(['telegram-balances'], d),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const rows = q.data?.rows ?? [];
  const thresholds = (v.thresholds ?? {}) as Record<string, number | null>;
  const badge: Record<BalanceRow['level'], { text: string; cls: string }> = {
    ok: { text: 'Bình thường', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' },
    low: { text: 'Dưới ngưỡng', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
    empty: { text: 'Hết tiền', cls: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400' },
    error: { text: 'Lỗi đọc số dư', cls: 'bg-muted text-muted-foreground' },
  };
  return (
    <Section
      title="Ngưỡng cảnh báo số dư nguồn API"
      description="Số dư ≤ ngưỡng thì báo “sắp hết tiền”, ≤ 0 báo “hết tiền”. Để trống = chỉ báo khi hết. Đơn vị theo từng nguồn. Chỉ liệt kê nguồn đang bật, có khoá API và hỗ trợ đọc số dư."
      actions={
        <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          <RefreshCw className={cn(refresh.isPending && 'animate-spin')} /> Đọc số dư
        </Button>
      }
    >
      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Đang đọc số dư…</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">Chưa có nguồn API nào đang bật hỗ trợ đọc số dư (bật ở AI Studio › Công cụ AI › Khoá API).</p>
      ) : (
        <div className="divide-y">
          {rows.map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-[1_1_14rem]">
                <p className="text-sm font-medium">
                  {r.name}{' '}
                  <span className={cn('ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium', badge[r.level].cls)}>{badge[r.level].text}</span>
                </p>
                <p className="text-xs text-muted-foreground">{r.balance === null ? r.error : `Số dư: ${fmt(r.balance)} ${r.unit ?? ''}`}</p>
              </div>
              <div className="w-48">
                <NumberInput
                  min={0}
                  // đơn vị dài (vd "credit SangTao") không vừa ô nên chỉ hiện đơn vị ngắn
                  suffix={r.unit && r.unit.length <= 4 ? r.unit : undefined}
                  placeholder="Ngưỡng"
                  value={thresholds[r.key] ?? null}
                  onChange={(n) => set({ thresholds: { ...thresholds, [r.key]: n === null || n === undefined || n < 0 ? null : n } })}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Kiểm tra số dư mỗi" help="Tối thiểu 5 phút">
          <NumberInput integer suffix="phút" value={(v.balanceCheckMinutes as number) ?? 30} onChange={(n) => set({ balanceCheckMinutes: Math.max(5, n ?? 30) })} />
        </Field>
        <Field label="Nhắc lại nếu chưa nạp sau" help="Còn dưới ngưỡng / hết tiền thì nhắc lại theo chu kỳ này">
          <NumberInput integer suffix="giờ" value={(v.balanceRemindHours as number) ?? 6} onChange={(n) => set({ balanceRemindHours: Math.max(1, n ?? 6) })} />
        </Field>
        <Field label="Kiểm tra model mới của nguồn mỗi" help="Tối thiểu 15 phút — so danh mục model của các nguồn đang bật với lần trước">
          <NumberInput integer suffix="phút" value={(v.catalogCheckMinutes as number) ?? 60} onChange={(n) => set({ catalogCheckMinutes: Math.max(15, n ?? 60) })} />
        </Field>
      </div>
    </Section>
  );
}

export function TelegramAdminTab({ onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  return (
    <div className="space-y-6">
      <SetupGuide admin />
      <SettingsGroup group="telegram_admin" onDirtyChange={onDirtyChange} onSaved={() => qc.invalidateQueries({ queryKey: ['telegram-status'] })}>
        {(v, set) => (
          <>
            <Section title="Bot thông báo cho quản trị" description="Gửi sự kiện quan trọng và cảnh báo nguồn API hết tiền vào chat / nhóm Telegram của quản trị">
              <SwitchRow label="Bật bot quản trị" checked={v.enabled === true} onChange={(enabled) => set({ enabled })} />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Token bot" help="Có thể dùng chung token với bot khách, nhưng nên tạo bot riêng">
                  <SecretInput value={v.botToken as string} onChange={(botToken) => set({ botToken: botToken.trim() })} placeholder="Dán token bot" />
                </Field>
                <Field label="Chat ID nhận thông báo" help="Mỗi dòng / dấu phẩy một Chat ID (người hoặc nhóm). Nhắn /id cho bot để lấy">
                  <Textarea rows={3} value={(v.chatIds as string) ?? ''} onChange={(e) => set({ chatIds: e.target.value })} placeholder={'123456789\n-1001234567890'} className="font-mono text-sm" />
                </Field>
              </div>
            </Section>
            <Section title="Loại thông báo">
              <EventSwitches items={ADMIN_EVENTS} v={v} set={set} disabled={v.enabled !== true} />
            </Section>
            <BalanceThresholds v={v} set={set} />
          </>
        )}
      </SettingsGroup>
      <BotStatusCard kind="admin" />
    </div>
  );
}
