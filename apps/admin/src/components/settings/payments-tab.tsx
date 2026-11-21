'use client';

/**
 * Tab Cài đặt › Cổng thanh toán — hỗ trợ mở rộng nhiều cổng.
 * Mỗi cổng có icon favicon riêng (public/gateways/<key>.png, tải qua google s2) + fallback lucide.
 * Header một dòng, có ô tìm kiếm + lọc (Tất cả / Đang bật / Thiếu) để khi lên 10-20 cổng vẫn quản lý được.
 * Thêm cổng mới: thêm entry vào GATEWAYS + form validate riêng, copy favicon vào public/gateways/<key>.png.
 * Cổng chia nhóm theo `category` (Chuyển khoản / VietQR, Thẻ cào...) để danh sách dài vẫn dễ tìm.
 * Nạp thẻ cào: form ở card-topup-gateway.tsx; nhà cung cấp đổi thẻ (Card24h, TheSieuRe...) chọn trong form, không phải thêm cổng.
 * Website AI không cho nạp thẻ (khách trả gói thẳng qua cổng) nên cổng thẻ cào đang ẩn (`hidden`).
 * Đang dùng Web2M (ngân hàng tự động) + USDT (USDT Gateway): PayOS / SePay / Pay2S cũng ẩn (`hidden`), cài đặt cũ vẫn giữ trong DB.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, CircleAlert, CircleCheck, Info, Landmark, Loader2, Search, TriangleAlert, Wallet, QrCode, ShieldCheck, CreditCard, Ticket, Coins } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { CopyButton } from '@/components/common/copy-button';
import { usePaymentProviders, type PaymentProviderInfo } from '@/components/commerce/payments';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SecretInput, SwitchRow } from './inputs';
import { MultiSettingsGroup, type Values } from './settings-group';
import { CardCallbackUrl, CardTopupFields, useCardProviders, validateCardTopup } from './card-topup-gateway';
import { WalletTopupSection } from './wallet-topup-section';

type TabProps = { onDirtyChange: (d: boolean) => void };

const GROUPS = ['web2m', 'usdt', 'payos', 'sepay', 'pay2s', 'card_topup'] as const;
/** Nhóm cài đặt nạp ví (không phải cổng) — nạp cùng các nhóm cổng để lưu chung một nút */
const ALL_GROUPS = [...GROUPS, 'wallet'] as const;
const QR_DEFAULT = '__default';

const ADMIN_BASE = (process.env.NEXT_PUBLIC_ADMIN_BASE_PATH || '/admin').replace(/\/+$/, '');

/** Nhóm cổng hiển thị — thêm loại cổng mới (ví điện tử, crypto...) thì thêm nhóm ở đây */
const CATEGORIES = [
  { key: 'bank', title: 'Chuyển khoản / VietQR', desc: 'Khách thanh toán gói cước' },
  { key: 'card', title: 'Thẻ cào', desc: 'Khách nạp tiền vào ví bằng thẻ điện thoại / thẻ game' },
  { key: 'crypto', title: 'Tiền mã hoá', desc: 'Khách thanh toán gói cước bằng USDT' },
] as const;

/** Registry cổng — thêm cổng mới chỉ cần thêm một dòng ở đây + favicon public/gateways/<key>.png (favicon: false = dùng icon lucide) */
const GATEWAYS: { key: (typeof GROUPS)[number]; category: (typeof CATEGORIES)[number]['key']; title: string; domain: string; desc: string; fallback: LucideIcon; favicon?: boolean; hidden?: boolean }[] = [
  { key: 'web2m', category: 'bank', title: 'Web2M', domain: 'api.web2m.com web2m spayment ngan hang tu dong', desc: 'Ngân hàng tự động — VietQR + báo tiền vào qua webhook Web2M', fallback: Landmark },
  { key: 'usdt', category: 'crypto', title: 'USDT Gateway', domain: 'usdt crypto trc20 bep20 erc20 blockchain ntpay gateway_blockchain', desc: 'USDT nhiều mạng — tạo hoá đơn, tự xác nhận qua callback', fallback: Coins, favicon: false },
  // 3 cổng cũ đã ẩn (chỉ dùng Web2M) — giữ entry để bật lại khi cần: bỏ `hidden`
  { key: 'payos', category: 'bank', title: 'PayOS', domain: 'payos.vn', desc: 'VietQR NAPAS247 — tạo QR theo đơn, tự xác nhận qua webhook', fallback: Wallet, hidden: true },
  { key: 'sepay', category: 'bank', title: 'SePay', domain: 'sepay.vn', desc: 'Ngân hàng VN — VietQR + báo tiền vào qua webhook SePay', fallback: QrCode, hidden: true },
  { key: 'pay2s', category: 'bank', title: 'Pay2S', domain: 'pay2s.vn', desc: 'VietQR NAPAS247 qua Pay2S — IPN + webhook biến động số dư', fallback: ShieldCheck, hidden: true },
  { key: 'card_topup', category: 'card', title: 'Nạp thẻ cào', domain: 'card24h thesieure doithe1s trumthe gachthe1s the cao', desc: 'Đổi thẻ cào qua Card24h, TheSieuRe... — tự cộng ví khi thẻ đúng', fallback: Ticket, favicon: false, hidden: true },
];

function GatewayIcon({ gkey, fallback: Fallback, enabled, size = 28 }: { gkey: string; fallback: LucideIcon; enabled?: boolean; size?: number }) {
  // cổng không có favicon riêng (vd Nạp thẻ cào gom nhiều nhà cung cấp) thì dùng luôn icon lucide
  const [err, setErr] = useState(GATEWAYS.find((g) => g.key === gkey)?.favicon === false);
  const src = `${ADMIN_BASE}/gateways/${gkey}.png`;
  if (err) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-lg', enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')} style={{ width: size, height: size }}>
        <Fallback className="size-4" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setErr(true)}
      className="shrink-0 rounded-lg border bg-white object-contain p-0.5 dark:bg-zinc-900"
      style={{ width: size, height: size }}
    />
  );
}

function WebhookUrl({ info, loading, canRead }: { info?: PaymentProviderInfo; loading: boolean; canRead: boolean }) {
  if (!canRead) return <p className="text-xs text-muted-foreground">Cần quyền “Cài đặt”.</p>;
  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!info?.webhookUrl) return <p className="text-xs text-muted-foreground">Chưa lấy được URL.</p>;
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 select-all truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs">{info.webhookUrl}</code>
      <CopyButton text={info.webhookUrl} size="xs" />
    </div>
  );
}

function validatePayos(v: Values): string[] {
  const m: string[] = [];
  if (!v.clientId) m.push('Client ID');
  if (!v.apiKey) m.push('API Key');
  if (!v.checksumKey) m.push('Checksum Key');
  return m;
}
function validateSepay(v: Values): string[] {
  const m: string[] = [];
  if (!v.bank) m.push('Ngân hàng');
  if (!v.accountNumber) m.push('Số tài khoản');
  if ((v.authMode || 'apikey') === 'apikey' && !v.apiKey) m.push('API Key');
  if (v.authMode === 'hmac' && !v.hmacSecret) m.push('HMAC Secret');
  return m;
}
function validatePay2s(v: Values): string[] {
  const m: string[] = [];
  if (!v.partnerCode) m.push('Partner Code');
  if (!v.accessKey) m.push('Access Key');
  if (!v.secretKey) m.push('Secret Key');
  return m;
}
/** Web2M cần đủ tài khoản nhận tiền (để dựng VietQR) + Access Token webhook (xác thực Bearer khi Web2M gọi về) */
function validateWeb2m(v: Values): string[] {
  const m: string[] = [];
  if (!v.bank) m.push('Ngân hàng');
  if (!v.accountNumber) m.push('Số tài khoản');
  if (!v.token) m.push('Access Token');
  return m;
}
/** USDT Gateway cần địa chỉ gateway + Merchant ID + API Key (gateway crypto) + tỉ giá quy đổi VND */
function validateUsdt(v: Values): string[] {
  const m: string[] = [];
  if (!v.endpoint) m.push('Địa chỉ gateway');
  if (!v.merchantId) m.push('Merchant ID');
  if (!v.apiKey) m.push('API Key');
  if (!(Number(v.rate) > 0)) m.push('Tỉ giá');
  return m;
}
const VALIDATORS: Record<string, (v: Values) => string[]> = { web2m: validateWeb2m, usdt: validateUsdt, payos: validatePayos, sepay: validateSepay, pay2s: validatePay2s };

function GatewayCard({
  id,
  title,
  desc,
  gkey,
  fallback,
  enabled,
  onToggle,
  info,
  defaultOpen,
  missing,
  webhook,
  guideSteps,
  signupUrl,
  children,
}: {
  id: string;
  title: string;
  desc: string;
  gkey: string;
  fallback: LucideIcon;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  info?: Pick<PaymentProviderInfo, 'configured'>;
  defaultOpen: boolean;
  missing: string[];
  webhook: ReactNode;
  guideSteps: ReactNode[];
  /** Link đăng ký tài khoản ở cổng (tuỳ chọn) — hiện ở đầu phần nội dung cho admin chưa có tài khoản */
  signupUrl?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => {
    if (enabled) setOpen(true);
  }, [enabled]);
  const configured = !!info?.configured;
  return (
    <Collapsible open={open} onOpenChange={setOpen} id={id} className="scroll-mt-20 overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <GatewayIcon gkey={gkey} fallback={fallback} enabled={enabled} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{desc}</div>
        </div>
        <span className="flex items-center gap-1">
          <span className={cn('size-2 rounded-full', enabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')} aria-hidden />
          <span className="hidden text-xs font-medium sm:inline" style={enabled ? { color: '#059669' } : undefined}>
            {enabled ? 'Bật' : 'Tắt'}
          </span>
        </span>
        {!configured ? (
          <Badge className="hidden border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 sm:inline-flex">
            <CircleAlert className="size-3" /> Thiếu
          </Badge>
        ) : enabled ? (
          <Badge className="hidden border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 sm:inline-flex">
            <CircleCheck className="size-3" /> OK
          </Badge>
        ) : null}
        {enabled && missing.length > 0 && <span className="hidden text-xs text-amber-600 dark:text-amber-400 lg:inline">· {missing.join(', ')}</span>}
        <label className="ml-1 flex cursor-pointer items-center" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="peer sr-only" aria-label={title} />
          <span className={cn('relative inline-flex h-5 w-9 rounded-full transition', enabled ? 'bg-primary' : 'bg-zinc-200 dark:bg-zinc-700')}>
            <span className={cn('absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition', enabled && 'translate-x-4')} />
          </span>
        </label>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={`${id}-content`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={cn('size-4 transition', open && 'rotate-180')} />
        </button>
      </div>

      <CollapsibleContent id={`${id}-content`} className="border-t data-[state=closed]:hidden">
        <div className="space-y-4 p-4">
          {signupUrl && (
            <p className="text-xs text-muted-foreground">
              Chưa có tài khoản {title}?{' '}
              <a href={signupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                Đăng ký tài khoản <ExternalLink className="size-3" />
              </a>
            </p>
          )}
          {enabled && !configured && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Thiếu {missing.join(', ')} — điền đủ rồi Lưu.
            </div>
          )}
          <div className={cn(!enabled && 'opacity-60')}>{children}</div>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">Webhook</span>
            <div className="min-w-0 flex-1">{webhook}</div>
          </div>
          <div className="rounded-lg border">
            <button type="button" onClick={() => setShowGuide((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/50">
              <Info className="size-3.5 text-muted-foreground" /> Hướng dẫn
              <ChevronDown className={cn('ml-auto size-3.5 text-muted-foreground transition', showGuide && 'rotate-180')} />
            </button>
            {showGuide && (
              <ol className="list-decimal space-y-1.5 border-t px-3 py-2.5 pl-8 text-xs leading-relaxed marker:text-muted-foreground">
                {guideSteps.map((s, i) => (
                  <li key={i} className="text-foreground/80">
                    {s}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {missing.length === 0 && configured && enabled && <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CircleCheck className="size-3.5" /> Đủ thông tin</p>}
          {missing.length > 0 && (
            <button type="button" onClick={() => toast.message(`${title}: thiếu ${missing.join(', ')}`)} className="text-xs font-medium text-amber-600 hover:underline dark:text-amber-400">
              Kiểm tra: thiếu {missing.join(', ')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PaymentsTab({ onDirtyChange }: TabProps) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRead = can('payments.read') || can('settings.payments');
  const providers = usePaymentProviders(canRead);
  const info = (key: string) => providers.data?.find((p) => p.key === key);
  const urlProps = (key: string) => ({ info: info(key), loading: providers.isLoading, canRead });
  // nạp thẻ cào có API riêng (danh sách nhà cung cấp đổi thẻ + URL callback)
  const cardProviders = useCardProviders(canRead);

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'on' | 'off' | 'missing'>('all');

  return (
    <MultiSettingsGroup groups={ALL_GROUPS} onDirtyChange={onDirtyChange} onSaved={() => {
        void qc.invalidateQueries({ queryKey: ['payment-providers'] });
        void qc.invalidateQueries({ queryKey: ['card-topup-providers'] });
      }}>
      {(all, setGroup) => {
        const payos: Values = all.payos;
        const sepay: Values = all.sepay;
        const pay2s: Values = all.pay2s;
        const setPayos = (patch: Values) => setGroup('payos', patch);
        const setSepay = (patch: Values) => setGroup('sepay', patch);
        const setPay2s = (patch: Values) => setGroup('pay2s', patch);
        const w2m: Values = all.web2m;
        const setW2m = (patch: Values) => setGroup('web2m', patch);
        const usdt: Values = all.usdt;
        const setUsdt = (patch: Values) => setGroup('usdt', patch);
        const card: Values = all.card_topup;
        const setCard = (patch: Values) => setGroup('card_topup', patch);
        const cardList = cardProviders.data?.providers;

        const map: Record<string, Values> = { web2m: w2m, usdt, payos, sepay, pay2s, card_topup: card };
        const infos: Record<string, Pick<PaymentProviderInfo, 'configured'> | undefined> = {
          web2m: info('web2m'),
          usdt: info('usdt'),
          payos: info('payos'),
          sepay: info('sepay'),
          pay2s: info('pay2s'),
          card_topup: cardProviders.data ? { configured: cardProviders.data.configured } : undefined,
        };
        const validators: Record<string, (v: Values) => string[]> = { ...VALIDATORS, card_topup: (v) => validateCardTopup(v, cardList) };

        // ảnh VietQR xem trước với tài khoản Web2M đang nhập (số tiền + nội dung mẫu)
        const w2mQrUrl = w2m.bank && w2m.accountNumber ? `https://img.vietqr.io/image/${encodeURIComponent(w2m.bank)}-${encodeURIComponent(w2m.accountNumber)}-${w2m.qrTemplate || 'compact2'}.png?amount=100000&addInfo=NAPAB12CD34` : null;
        const sepayQrUrl = sepay.bank && sepay.accountNumber ? `https://img.vietqr.io/image/${encodeURIComponent(sepay.bank)}-${encodeURIComponent(sepay.accountNumber)}-compact2.png?amount=100000&addInfo=DH00000000001` : null;

        // Tính trong render prop nên không dùng hook (useMemo/useEffect...) ở đây — hook trong render prop làm lệch thứ tự hook của MultiSettingsGroup
        const needle = q.trim().toLowerCase();
        const visibleKeys = (GROUPS as readonly string[]).filter((k) => {
          const meta = GATEWAYS.find((g) => g.key === k)!;
          // cổng ẩn (vd thẻ cào): không hiện trong danh sách, cài đặt cũ vẫn giữ nguyên trong DB
          if (meta.hidden) return false;
          const v = map[k] ?? {};
          const enabled = !!v.enabled;
          const configured = !!infos[k]?.configured;
          const missing = (validators[k]?.(v) ?? []).length > 0;
          if (needle && !`${meta.title} ${meta.domain} ${k}`.toLowerCase().includes(needle)) return false;
          if (filter === 'on' && !enabled) return false;
          if (filter === 'off' && enabled) return false;
          if (filter === 'missing' && (configured || !enabled)) return false;
          if (filter === 'missing' && !missing) return false;
          return true;
        });

        // chỉ đếm các cổng đang hiện (bỏ cổng ẩn như thẻ cào)
        const shown = GATEWAYS.filter((g) => !g.hidden).map((g) => g.key as string);
        const counts = {
          all: shown.length,
          on: shown.filter((k) => !!map[k]?.enabled).length,
          off: shown.filter((k) => !map[k]?.enabled).length,
          missing: shown.filter((k) => !!map[k]?.enabled && !infos[k]?.configured).length,
        };

        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {/* website AI không có thanh toán offline: khách trả gói thẳng qua các cổng dưới đây */}
              <span>Khách thanh toán gói cước qua các cổng đang bật, gói tự kích hoạt khi cổng báo đã nhận tiền</span>
              <span className="ml-auto hidden items-center gap-1 sm:inline-flex">
                <CreditCard className="size-3.5" /> {counts.on} đang bật · {counts.missing ? <span className="text-amber-600 dark:text-amber-400">{counts.missing} thiếu cấu hình</span> : <span className="text-emerald-600 dark:text-emerald-400">đủ cấu hình</span>}
              </span>
            </div>

            {/* Tìm kiếm + lọc — quan trọng khi có nhiều cổng */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-52 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm cổng..." className="h-8 pl-8 text-sm" />
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { k: 'all', label: `Tất cả (${counts.all})` },
                    { k: 'on', label: `Đang bật (${counts.on})` },
                    { k: 'off', label: `Tắt (${counts.off})` },
                    { k: 'missing', label: `Thiếu (${counts.missing})` },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.k}
                    type="button"
                    onClick={() => setFilter(f.k)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition', filter === f.k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {visibleKeys.length === 0 && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Không có cổng nào khớp bộ lọc.</p>}

            {/* Tiêu đề nhóm cổng: chỉ hiện khi nhóm có cổng khớp bộ lọc */}
            {GATEWAYS.some((g) => g.category === 'bank' && visibleKeys.includes(g.key)) && (
              <div className="flex items-baseline gap-2 px-1 pt-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{CATEGORIES[0].title}</h3>
                <span className="truncate text-xs text-muted-foreground/80">{CATEGORIES[0].desc}</span>
              </div>
            )}

            {visibleKeys.includes('web2m') && (
              <GatewayCard
                id="web2m-card"
                title="Web2M"
                desc="Ngân hàng tự động — VietQR + báo tiền vào qua webhook Web2M"
                gkey="web2m"
                fallback={Landmark}
                enabled={!!w2m.enabled}
                onToggle={(enabled) => setW2m({ enabled })}
                info={infos.web2m}
                defaultOpen={!!w2m.enabled}
                missing={validateWeb2m(w2m)}
                webhook={<WebhookUrl {...urlProps('web2m')} />}
                signupUrl="https://api.web2m.com/Auth/Register"
                guideSteps={[
                  <>Thuê API ngân hàng và liên kết tài khoản nhận tiền ở <b>api.web2m.com</b>.</>,
                  <span key="wh">Vào trang <b>Cấu hình webhook</b> trên Web2M → Thêm mới, chọn ngân hàng, Webhook URL là ô Webhook ở trên (bắt buộc https).</span>,
                  <>Copy <b>Access Token</b> của webhook trên Web2M, dán vào ô Access Token ở đây (Web2M gửi header Authorization: Bearer &lt;Access Token&gt;).</>,
                  <>Khách chuyển khoản đúng nội dung (mã NAP...) thì ví được cộng tự động và gói cước kích hoạt. Bật và Lưu.</>,
                ]}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Ngân hàng" help="Mã VietQR, vd MB, VCB, ACB">
                    <Input value={w2m.bank ?? ''} onChange={(e) => setW2m({ bank: e.target.value.trim() })} placeholder="MB" />
                  </Field>
                  <Field label="Số tài khoản">
                    <Input value={w2m.accountNumber ?? ''} onChange={(e) => setW2m({ accountNumber: e.target.value.trim() })} className="font-mono text-sm" />
                  </Field>
                  <Field label="Chủ tài khoản">
                    <Input value={w2m.accountName ?? ''} onChange={(e) => setW2m({ accountName: e.target.value })} placeholder="NGUYEN VAN A" />
                  </Field>
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  <Field label="Access Token webhook" className="min-w-60 flex-1">
                    <SecretInput value={w2m.token} onChange={(v) => setW2m({ token: v.trim() })} />
                  </Field>
                  <Field label="Mẫu QR" className="w-40">
                    <Select value={w2m.qrTemplate || 'compact2'} onValueChange={(qrTemplate) => setW2m({ qrTemplate })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact2">Mặc định</SelectItem>
                        <SelectItem value="compact">Gọn</SelectItem>
                        <SelectItem value="qr_only">Chỉ QR</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {w2mQrUrl && (
                    <div className="rounded-lg border bg-white p-1.5 dark:bg-zinc-900">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={w2mQrUrl} alt="VietQR" className="h-28 w-auto rounded" loading="lazy" />
                    </div>
                  )}
                </div>
              </GatewayCard>
            )}

            {visibleKeys.includes('payos') && (
              <GatewayCard
                id="payos-card"
                title="PayOS"
                desc="VietQR NAPAS247 — tạo QR theo đơn, tự xác nhận qua webhook"
                gkey="payos"
                fallback={Wallet}
                enabled={!!payos.enabled}
                onToggle={(enabled) => setPayos({ enabled })}
                info={infos.payos}
                defaultOpen={!!payos.enabled}
                missing={validatePayos(payos)}
                webhook={<WebhookUrl {...urlProps('payos')} />}
                guideSteps={[
                  <>Lấy Client ID / API Key / Checksum Key ở <b>my.payos.vn</b> → Kênh thanh toán.</>,
                  <span key="wh">Khai báo Webhook URL (ô Webhook ở trên) trong kênh thanh toán.</span>,
                  <>Bật PayOS và Lưu.</>,
                ]}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Client ID">
                    <Input value={payos.clientId ?? ''} onChange={(e) => setPayos({ clientId: e.target.value.trim() })} className="font-mono text-sm" autoComplete="off" />
                  </Field>
                  <Field label="API Key">
                    <SecretInput value={payos.apiKey} onChange={(v) => setPayos({ apiKey: v.trim() })} />
                  </Field>
                  <Field label="Checksum Key">
                    <SecretInput value={payos.checksumKey} onChange={(v) => setPayos({ checksumKey: v.trim() })} />
                  </Field>
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <Field label="Độ dài nội dung CK" className="w-32">
                    <Input type="number" min={1} max={25} value={payos.descriptionLength ?? 25} onChange={(e) => setPayos({ descriptionLength: Math.min(25, Math.max(1, Math.floor(Number(e.target.value) || 0))) })} />
                  </Field>
                  <SwitchRow label="Hiện QR trên website" checked={payos.showQr !== false} onChange={(showQr) => setPayos({ showQr })} className="flex-1 py-2" />
                </div>
              </GatewayCard>
            )}

            {visibleKeys.includes('sepay') && (
              <GatewayCard
                id="sepay-card"
                title="SePay"
                desc="Ngân hàng VN — VietQR + báo tiền vào qua webhook SePay"
                gkey="sepay"
                fallback={QrCode}
                enabled={!!sepay.enabled}
                onToggle={(enabled) => setSepay({ enabled })}
                info={infos.sepay}
                defaultOpen={!!sepay.enabled}
                missing={validateSepay(sepay)}
                webhook={<WebhookUrl {...urlProps('sepay')} />}
                guideSteps={[
                  <>Liên kết tài khoản ngân hàng ở <b>my.sepay.vn</b>.</>,
                  <>Cấu trúc mã thanh toán: tiền tố = tiền tố mã đơn (DH), hậu tố Số nguyên, độ dài 11.</>,
                  <span key="wh">Webhooks → Thêm webhook “Có tiền vào”, chọn API Key/HMAC và nhập khoá ở trên. URL là ô Webhook.</span>,
                ]}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Ngân hàng">
                    <Input value={sepay.bank ?? ''} onChange={(e) => setSepay({ bank: e.target.value.trim() })} placeholder="MBBank" />
                  </Field>
                  <Field label="Số tài khoản">
                    <Input value={sepay.accountNumber ?? ''} onChange={(e) => setSepay({ accountNumber: e.target.value.trim() })} className="font-mono text-sm" />
                  </Field>
                  <Field label="Chủ tài khoản">
                    <Input value={sepay.accountName ?? ''} onChange={(e) => setSepay({ accountName: e.target.value })} placeholder="NGUYEN VAN A" />
                  </Field>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Xác thực webhook">
                    <Select value={sepay.authMode || 'apikey'} onValueChange={(authMode) => setSepay({ authMode })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="apikey">API Key</SelectItem>
                        <SelectItem value="hmac">HMAC-SHA256 — khuyến nghị</SelectItem>
                        <SelectItem value="none">Không (thử nghiệm)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {(sepay.authMode || 'apikey') === 'apikey' && (
                    <Field label="API Key webhook">
                      <SecretInput value={sepay.apiKey} onChange={(v) => setSepay({ apiKey: v.trim() })} />
                    </Field>
                  )}
                  {sepay.authMode === 'hmac' && (
                    <Field label="HMAC Secret">
                      <SecretInput value={sepay.hmacSecret} onChange={(v) => setSepay({ hmacSecret: v.trim() })} />
                    </Field>
                  )}
                </div>
                {sepay.authMode === 'none' && <p className="mt-2 text-xs text-red-600 dark:text-red-400">Không xác thực — chỉ thử nghiệm.</p>}
                <div className="mt-3 flex flex-wrap gap-3">
                  <Field label="Mẫu QR" className="w-40">
                    <Select value={sepay.qrTemplate ? sepay.qrTemplate : QR_DEFAULT} onValueChange={(v) => setSepay({ qrTemplate: v === QR_DEFAULT ? '' : v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={QR_DEFAULT}>Mặc định</SelectItem>
                        <SelectItem value="compact">Gọn</SelectItem>
                        <SelectItem value="qronly">Chỉ QR</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {sepayQrUrl && (
                    <div className="rounded-lg border bg-white p-1.5 dark:bg-zinc-900">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={sepayQrUrl} alt="VietQR" className="h-28 w-auto rounded" loading="lazy" />
                    </div>
                  )}
                </div>
              </GatewayCard>
            )}

            {visibleKeys.includes('pay2s') && (
              <GatewayCard
                id="pay2s-card"
                title="Pay2S"
                desc="VietQR NAPAS247 qua Pay2S — IPN + webhook biến động số dư"
                gkey="pay2s"
                fallback={ShieldCheck}
                enabled={!!pay2s.enabled}
                onToggle={(enabled) => setPay2s({ enabled })}
                info={infos.pay2s}
                defaultOpen={!!pay2s.enabled}
                missing={validatePay2s(pay2s)}
                webhook={<WebhookUrl {...urlProps('pay2s')} />}
                signupUrl="https://pay2s.vn/?aff=65"
                guideSteps={[
                  <>Lấy Partner Code / Access Key / Secret Key ở mục Tích hợp của Pay2S.</>,
                  <span key="wh">IPN URL gửi tự động theo giao dịch — dùng URL ở ô Webhook.</span>,
                  <>(Tuỳ chọn) Webhook biến động số dư: khai báo cùng URL và dán token.</>,
                ]}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Partner Code">
                    <Input value={pay2s.partnerCode ?? ''} onChange={(e) => setPay2s({ partnerCode: e.target.value.trim() })} className="font-mono text-sm" />
                  </Field>
                  <Field label="Partner Name">
                    <Input value={pay2s.partnerName ?? ''} onChange={(e) => setPay2s({ partnerName: e.target.value })} />
                  </Field>
                  <Field label="Access Key">
                    <SecretInput value={pay2s.accessKey} onChange={(v) => setPay2s({ accessKey: v.trim() })} />
                  </Field>
                  <Field label="Secret Key">
                    <SecretInput value={pay2s.secretKey} onChange={(v) => setPay2s({ secretKey: v.trim() })} />
                  </Field>
                </div>
                <Field label="Tài khoản nhận tiền" help="Mỗi dòng: MÃ:SỐ_TK — vd ACB:99999999" className="mt-3">
                  <Textarea value={pay2s.bankAccounts ?? ''} onChange={(e) => setPay2s({ bankAccounts: e.target.value })} rows={2} className="font-mono text-xs" placeholder="ACB:99999999" spellCheck={false} />
                </Field>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="API endpoint">
                    <Input value={pay2s.endpoint ?? ''} onChange={(e) => setPay2s({ endpoint: e.target.value.trim() })} placeholder="https://payment.pay2s.vn" className="font-mono text-sm" />
                  </Field>
                  <Field label="Token webhook">
                    <SecretInput value={pay2s.webhookToken} onChange={(v) => setPay2s({ webhookToken: v.trim() })} />
                  </Field>
                </div>
              </GatewayCard>
            )}

            {GATEWAYS.some((g) => g.category === 'crypto' && visibleKeys.includes(g.key)) && (
              <div className="flex items-baseline gap-2 px-1 pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{CATEGORIES[2].title}</h3>
                <span className="truncate text-xs text-muted-foreground/80">{CATEGORIES[2].desc}</span>
              </div>
            )}

            {visibleKeys.includes('usdt') && (
              <GatewayCard
                id="usdt-card"
                title="USDT Gateway"
                desc="USDT nhiều mạng — tạo hoá đơn, tự xác nhận qua callback"
                gkey="usdt"
                fallback={Coins}
                enabled={!!usdt.enabled}
                onToggle={(enabled) => setUsdt({ enabled })}
                info={infos.usdt}
                defaultOpen={!!usdt.enabled}
                missing={validateUsdt(usdt)}
                webhook={<WebhookUrl {...urlProps('usdt')} />}
                guideSteps={[
                  <>Trên USDT Gateway: tạo <b>Merchant</b> với gateway <b>crypto</b>, thêm ít nhất 1 ví nhận tiền (TRC20, BEP20...) và bật Merchant.</>,
                  <>Copy <b>Merchant ID</b> và <b>API Key</b> của Merchant dán vào đây, điền địa chỉ gateway (vd https://pay.domain.com).</>,
                  <span key="cb">Callback URL (ô Webhook ở trên) được gửi kèm mỗi hoá đơn, không cần khai báo trên gateway — nhưng phải truy cập được từ internet.</span>,
                  <>Số USDT = số tiền VND ÷ tỉ giá (làm tròn lên 0,01). Khách bấm “Mở trang thanh toán”, chọn mạng và chuyển đúng số USDT; gói tự kích hoạt khi blockchain xác nhận.</>,
                ]}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Địa chỉ gateway" help="Không có / ở cuối">
                    <Input value={usdt.endpoint ?? ''} onChange={(e) => setUsdt({ endpoint: e.target.value.trim() })} placeholder="https://pay.domain.com" className="font-mono text-sm" />
                  </Field>
                  <Field label="Merchant ID">
                    <Input value={usdt.merchantId ?? ''} onChange={(e) => setUsdt({ merchantId: e.target.value.trim() })} className="font-mono text-sm" autoComplete="off" />
                  </Field>
                  <Field label="API Key">
                    <SecretInput value={usdt.apiKey} onChange={(v) => setUsdt({ apiKey: v.trim() })} />
                  </Field>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field label="Tỉ giá (đ / 1 USDT)" help="Dùng để quy đổi số tiền gói sang USDT">
                    <Input type="number" min={1} step={100} value={usdt.rate ?? 26000} onChange={(e) => setUsdt({ rate: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </Field>
                  <Field label="Tối thiểu (USDT)" help="Theo cấu hình gateway (mặc định 1)">
                    <Input type="number" min={0.01} step={0.01} value={usdt.minUsdt ?? 1} onChange={(e) => setUsdt({ minUsdt: Math.max(0, Number(e.target.value) || 0) })} />
                  </Field>
                  <Field label="Ví dụ">
                    <p className="pt-2 text-sm text-muted-foreground">
                      100.000đ ≈ <b className="text-foreground">{Number(usdt.rate) > 0 ? (Math.ceil((100000 / Number(usdt.rate)) * 100) / 100).toString() : '?'} USDT</b>
                    </p>
                  </Field>
                </div>
              </GatewayCard>
            )}

            {GATEWAYS.some((g) => g.category === 'card' && visibleKeys.includes(g.key)) && (
              <div className="flex items-baseline gap-2 px-1 pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{CATEGORIES[1].title}</h3>
                <span className="truncate text-xs text-muted-foreground/80">{CATEGORIES[1].desc}</span>
              </div>
            )}

            {visibleKeys.includes('card_topup') && (
              <GatewayCard
                id="card-topup-card"
                title="Nạp thẻ cào"
                desc={`Đổi thẻ qua ${cardList?.find((p) => p.key === card.provider)?.label ?? 'nhà cung cấp'} — tự cộng ví khi thẻ đúng`}
                gkey="card_topup"
                fallback={Ticket}
                enabled={!!card.enabled}
                onToggle={(enabled) => setCard({ enabled })}
                info={infos.card_topup}
                defaultOpen={!!card.enabled}
                missing={validateCardTopup(card, cardList)}
                webhook={<CardCallbackUrl provider={card.provider} info={cardProviders.data} loading={cardProviders.isLoading} canRead={canRead} />}
                guideSteps={[
                  <>Đăng ký tài khoản đối tác (API) ở site đổi thẻ, lấy <b>Partner ID</b> và <b>Partner Key</b>.</>,
                  <span key="cb">Khai báo URL callback (ô Webhook ở trên) trong trang quản lý API của site đổi thẻ.</span>,
                  <>Chọn loại thẻ, mệnh giá, chiết khấu cho khách rồi bật và Lưu.</>,
                  <>Website khách gọi <code className="font-mono">GET /api/public/card-topup/config</code> để dựng form, <code className="font-mono">POST /api/account/card-topup</code> để gửi thẻ (cần đăng nhập).</>,
                ]}
              >
                <CardTopupFields value={card} set={setCard} providers={cardList} />
              </GatewayCard>
            )}

            {/* Thanh toán gói cước qua cổng: cổng được dùng + số tiền tối thiểu (nhóm cài đặt `wallet`) */}
            <WalletTopupSection value={all.wallet ?? {}} set={(patch) => setGroup('wallet', patch)} providers={providers.data} />

            <p className="text-xs text-muted-foreground">“••••••••” = đã lưu — để nguyên nếu không đổi. Thêm cổng mới: thêm vào <code className="font-mono">GATEWAYS</code> và đặt favicon <code className="font-mono">/public/gateways/&lt;key&gt;.png</code> (tải từ google s2 favicons).</p>
          </div>
        );
      }}
    </MultiSettingsGroup>
  );
}
