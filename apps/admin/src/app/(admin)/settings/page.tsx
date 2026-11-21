'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  BarChart3,
  Coins,
  Cpu,
  BellRing,
  Bug,
  Code2,
  CreditCard,
  Info,
  Megaphone,
  Mail,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  Palette,
  Percent,
  Phone,
  Radar,
  ReceiptText,
  Search,
  SearchX,
  Settings,
  ShieldCheck,
  ShoppingCart,
  ToggleRight,
  Truck,
  UserCog,
  X,
  type LucideIcon,
  KeyRound,
  Eye,
  Send,
  BotMessageSquare,
  DollarSign,
} from 'lucide-react';
import { FEATURE_LABELS, settingTabPermission, type FeatureKey } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { useConfirm } from '@/components/common/confirm-dialog';
import { GeneralTab } from '@/components/settings/general-tab';
import { SeoTab } from '@/components/settings/seo-tab';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { CommerceTab } from '@/components/settings/commerce-tab';
import { AccountTab, ContactTab, MailTab, ScriptsTab, SocialTab } from '@/components/settings/misc-tabs';
import { CommentsTab } from '@/components/settings/comments-tab';
import { ShippingTab } from '@/components/settings/shipping-tab';
import { EmailTemplatesLinkTab } from '@/components/settings/email-templates-link';
import { SecurityTab } from '@/components/settings/security-tab';
import { DigitalTab } from '@/components/settings/digital-tab';
import { AnalyticsTab } from '@/components/settings/analytics-tab';
import { EInvoiceTab } from '@/components/settings/einvoice-tab';
import { TaxTab } from '@/components/settings/tax-tab';
import { LoggingTab } from '@/components/settings/logging-tab';
import { FeaturesTab } from '@/components/settings/features-tab';
import { PaymentsTab } from '@/components/settings/payments-tab';
import { AiGeneralTab, CreditsTab } from '@/components/settings/ai-tabs';
import { NotificationsTab } from '@/components/settings/notifications-tab';
import { ContactButtonsTab, PopupTab, TrackingTab } from '@/components/settings/site-widgets-tabs';
import { DemoTab } from '@/components/settings/demo-tab';
import { CurrencyTab } from '@/components/settings/currency-tab';
import { TelegramAdminTab, TelegramUserTab } from '@/components/settings/telegram-tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { useFeatures } from '@/hooks/use-features';
import { cn } from '@/lib/utils';

type TabComponent = (p: { onDirtyChange: (d: boolean) => void }) => React.ReactNode;

/** Danh mục gom các tab trên thanh điều hướng bên trái (thứ tự hiển thị) */
const GROUPS = [
  { key: 'site', label: 'Website' },
  { key: 'ai', label: 'AI Studio' },
  // tắt bán hàng thì nhóm này chỉ còn Cổng thanh toán (khách nạp ví / mua gói)
  { key: 'commerce', label: 'Thanh toán' },
  { key: 'comms', label: 'Thông báo & thành viên' },
  { key: 'system', label: 'Hệ thống' },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];

interface TabDef {
  key: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  component: TabComponent;
  group: GroupKey;
  /** Từ khoá thêm cho ô tìm kiếm (tên trường, thuật ngữ hay gõ) */
  keywords?: string;
  /** Tab chỉ có tác dụng khi tính năng này đang bật (Cài đặt › Tính năng) */
  feature?: FeatureKey;
  /** Cài đặt kỹ thuật, chỉ vai trò "Nhà phát triển" thấy (chủ website không cần đụng tới) */
  devOnly?: boolean;
  /** Ẩn vì website AI hiện tại không dùng (web khách không đọc nhóm cài đặt này); bỏ cờ để hiện lại */
  hidden?: boolean;
}

const TABS: TabDef[] = [
  { key: 'general', group: 'site', label: 'Chung', desc: 'Tên, logo, trang chủ, bảo trì', icon: Settings, component: GeneralTab, keywords: 'ten website tagline url favicon mui gio dinh dang ngay bao tri maintenance' },
  // Bật/tắt cả mảng tính năng theo loại website (bán hàng, blog, tài khoản...)
  { key: 'features', group: 'site', label: 'Tính năng', desc: 'Bật/tắt bán hàng, blog, tài khoản...', icon: ToggleRight, component: FeaturesTab, devOnly: true, keywords: 'cong tac shop blog wishlist vi danh gia' },
  { key: 'contact', group: 'site', label: 'Liên hệ', desc: 'Địa chỉ, điện thoại, bản đồ', icon: Phone, component: ContactTab, keywords: 'hotline email cong ty ma so thue gio lam viec google maps' },
  { key: 'social', group: 'site', label: 'Mạng xã hội', desc: 'Facebook, Zalo, TikTok...', icon: MessageSquare, component: SocialTab, hidden: true, keywords: 'messenger youtube instagram linkedin twitter x' },
  { key: 'appearance', group: 'site', label: 'Giao diện', desc: 'Màu sắc, font, header, footer', icon: Palette, component: AppearanceTab, keywords: 'mau chu theme color' },
  // nút liên hệ nổi ở góc website: bật/tắt, sắp xếp + icon từng kênh (nhóm public contactButtons, web vẽ ở components/site/contact-buttons)
  { key: 'contactButtons', group: 'site', label: 'Nút liên hệ nổi', desc: 'Nút Telegram, Zalo, Messenger... nổi ở góc màn hình', icon: MousePointerClick, component: ContactButtonsTab, keywords: 'nut lien he goi dien zalo telegram messenger facebook whatsapp hotline floating chat mang xa hoi social icon lien he nhanh' },
  // hộp thông báo hiện khi khách vào website (nhóm public popup, web vẽ ở components/site/popup-notice)
  { key: 'popup', group: 'site', label: 'Thông báo nổi', desc: 'Hộp thông báo hiện khi khách vào website', icon: Megaphone, component: PopupTab, keywords: 'popup thong bao noi khuyen mai announcement modal banner hop thoai' },
  { key: 'seo', group: 'site', label: 'SEO', desc: 'Tiêu đề, mô tả, robots.txt', icon: Search, component: SeoTab, keywords: 'meta title description sitemap og image google' },
  // AI Studio: nạp tiền vào ví & khuyến mãi, xử lý tác vụ (components/settings/ai-tabs.tsx); khoá API nhà cung cấp nằm riêng ở /ai/tools?tab=keys
  { key: 'credits', group: 'ai', label: 'Nạp tiền & khuyến mãi', desc: 'Tặng tiền khi đăng ký, số luồng, nạp tiền vào ví, khuyến mãi theo mốc', icon: Coins, component: CreditsTab, keywords: 'credits nap tien khuyen mai moc ty le quy doi chuong trinh giam gia luong dong thoi tang dang ky' },
  { key: 'ai-general', group: 'ai', label: 'Xử lý tác vụ AI', desc: 'Chu kỳ hỏi trạng thái, giới hạn file, tự xoá tác vụ cũ', icon: Cpu, component: AiGeneralTab, keywords: 'tac vu timeout upload file sao luu ket qua tu dong xoa don cu' },
  // Tiền tệ hiển thị trên website khách (VNĐ gốc, khách có thể xem theo USD)
  { key: 'currency', group: 'commerce', label: 'Tiền tệ', desc: 'Cho khách xem giá theo USD, tỉ giá quy đổi', icon: DollarSign, component: CurrencyTab, keywords: 'tien te usd do la ti gia ty gia quy doi vnd currency dollar' },
  { key: 'commerce', group: 'commerce', label: 'Bán hàng', desc: 'Tiền tệ, thanh toán, đánh giá', icon: ShoppingCart, component: CommerceTab, feature: 'shop', keywords: 'tien te vnd thanh toan cod chuyen khoan don hang ton kho' },
  // Web2M: nhóm cài đặt riêng có công tắc bật (PayOS / SePay / Pay2S đã ẩn)
  { key: 'payments', group: 'commerce', label: 'Cổng thanh toán', desc: 'Web2M, USDT — tài khoản nhận tiền, khoá API, URL webhook', icon: CreditCard, component: PaymentsTab, keywords: 'web2m usdt crypto trc20 bep20 ngan hang tu dong thanh toan online qr chuyen khoan webhook ipn vietqr' },
  { key: 'tax', group: 'commerce', label: 'Thuế', desc: 'Cách tính thuế, thuế suất theo vùng', icon: Percent, component: TaxTab, feature: 'shop', keywords: 'vat thue suat' },
  { key: 'shipping', group: 'commerce', label: 'Vận chuyển', desc: 'Vùng, phương thức, đơn vị vận chuyển', icon: Truck, component: ShippingTab, feature: 'shop', keywords: 'ghn ghtk phi ship giao hang van don' },
  // Kho mã số / sản phẩm ảo: email giao mã, tự hoàn thành đơn, giao bù, cảnh báo sắp hết mã, bảo hành
  { key: 'digital', group: 'commerce', label: 'Sản phẩm số', desc: 'Giao mã, tài khoản, key, bảo hành', icon: KeyRound, component: DigitalTab, feature: 'shop', keywords: 'kho ma key tai khoan acc game the cao giao ma tu dong bao hanh license' },
  { key: 'einvoice', group: 'commerce', label: 'Hoá đơn điện tử', desc: 'Nhà cung cấp, tự động xuất, VAT', icon: ReceiptText, component: EInvoiceTab, feature: 'shop', keywords: 'viettel misa hoa don vat' },
  { key: 'mail', group: 'comms', label: 'Email SMTP', desc: 'Máy chủ gửi email', icon: Mail, component: MailTab, keywords: 'smtp gui mail host port' },
  { key: 'emails', group: 'comms', label: 'Mẫu email', desc: 'Nội dung email gửi khách', icon: MailOpen, component: EmailTemplatesLinkTab, keywords: 'template thong bao' },
  // email tự động khi có đơn hàng (nhóm orderNotification)
  { key: 'notifications', group: 'comms', label: 'Thông báo email', desc: 'Email báo đơn hàng cho cửa hàng và khách', icon: BellRing, component: NotificationsTab, keywords: 'thong bao don hang email admin tu dong' },
  // bot Telegram (API modules/telegram): bot báo khách (liên kết ở trang Tài khoản website) + bot báo quản trị (cảnh báo nguồn API hết tiền)
  { key: 'telegram-user', group: 'comms', label: 'Bot Telegram khách', desc: 'Báo khách tác vụ AI, nạp tiền, gói cước qua Telegram', icon: Send, component: TelegramUserTab, keywords: 'telegram bot thong bao khach lien ket tac vu nap tien goi cuoc botfather' },
  { key: 'telegram-admin', group: 'comms', label: 'Bot Telegram admin', desc: 'Báo quản trị sự kiện + nguồn API hết tiền / chạm ngưỡng', icon: BotMessageSquare, component: TelegramAdminTab, keywords: 'telegram bot admin quan tri canh bao so du nguon api het tien nguong chat id nhom' },
  { key: 'account', group: 'comms', label: 'Tài khoản', desc: 'Đăng ký thành viên', icon: UserCog, component: AccountTab, feature: 'accounts', keywords: 'dang ky dang nhap thanh vien khach hang' },
  { key: 'comments', group: 'comms', label: 'Bình luận', desc: 'Duyệt, trả lời, thông báo', icon: MessagesSquare, component: CommentsTab, hidden: true, feature: 'blog', keywords: 'kiem duyet spam' },
  { key: 'security', group: 'system', label: 'Bảo mật', desc: 'Chống dò mật khẩu, chính sách mật khẩu, 2FA, phiên, captcha', icon: ShieldCheck, component: SecurityTab, keywords: 'recaptcha turnstile mat khau dang nhap ip chan phien canh bao' },
  { key: 'scripts', group: 'system', label: 'Mã nhúng', desc: 'Chèn mã vào head / body', icon: Code2, component: ScriptsTab, devOnly: true, keywords: 'script pixel tag manager analytics css' },
  // GA4 / GTM / Facebook Pixel / TikTok Pixel (nhóm public tracking)
  { key: 'tracking', group: 'system', label: 'Mã theo dõi', desc: 'Google Analytics 4, Tag Manager, Facebook & TikTok Pixel', icon: Radar, component: TrackingTab, keywords: 'ga4 google analytics gtm tag manager facebook pixel tiktok pixel quang cao chuyen doi' },
  { key: 'analytics', group: 'system', label: 'Thống kê truy cập', desc: 'Ghi nhận lượt xem, quyền riêng tư', icon: BarChart3, component: AnalyticsTab, keywords: 'luot xem bot ip' },
  // khoá mọi thao tác thêm/sửa/xoá khi đưa bản demo cho khách xem (chỉ Nhà phát triển bật/tắt)
  { key: 'demo', group: 'system', label: 'Chế độ demo', desc: 'Khoá thêm, sửa, xoá khi cho khách xem thử', icon: Eye, component: DemoTab, devOnly: true, keywords: 'demo xem thu chi doc read only khoa sua xoa live demo' },
  { key: 'logging', group: 'system', label: 'Nhật ký lỗi', desc: 'Mức ghi log, thời gian lưu', icon: Bug, component: LoggingTab, devOnly: true, keywords: 'log loi error' },
];

/** Bỏ dấu tiếng Việt + chữ thường để tìm kiếm không phân biệt dấu */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

function SettingsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const confirm = useConfirm();
  const { isOn } = useFeatures();
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const { can, isDeveloper, user } = useAuth();
  const rawPerms = user?.role.permissions;
  // chỉ hiển thị các mục cài đặt mà vai trò được cấp quyền; tab kỹ thuật (devOnly) hiện với Nhà phát triển hoặc khi được tích cấp riêng mục đó
  const canTab = useCallback(
    (t: TabDef) => {
      const p = settingTabPermission(t.key);
      if (!can(p)) return false;
      if (t.devOnly && !isDeveloper && !rawPerms?.includes(p)) return false;
      return true;
    },
    [can, isDeveloper, rawPerms],
  );
  const tabs = useMemo(() => TABS.filter((t) => !t.hidden && (!t.feature || isOn(t.feature)) && canTab(t)), [isOn, canTab]);
  const tabKey = tabs.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : (tabs[0]?.key ?? 'general');
  const tab = tabs.find((t) => t.key === tabKey);
  const Comp = tab?.component;
  const tabOff = !!tab?.feature && !isOn(tab.feature);

  // lọc tab theo ô tìm kiếm (tên, mô tả, từ khoá; không dấu), rồi chia theo nhóm
  const grouped = useMemo(() => {
    const needle = fold(q.trim());
    const match = (t: TabDef) => !needle || fold(`${t.label} ${t.desc} ${t.keywords ?? ''}`).includes(needle);
    return GROUPS.map((g) => ({ ...g, items: tabs.filter((t) => t.group === g.key && match(t)) })).filter((g) => g.items.length > 0);
  }, [tabs, q]);

  const go = async (key: string) => {
    if (key === tabKey) return;
    if (dirty && tab && !(await confirm({ title: 'Bỏ thay đổi chưa lưu?', description: `Các thay đổi trong mục “${tab.label}” chưa được lưu sẽ bị mất.`, confirmText: 'Bỏ thay đổi', destructive: true }))) return;
    setDirty(false);
    router.replace(`${pathname}?tab=${key}`, { scroll: false });
    // sang mục mới thì đưa về đầu nội dung (tránh đứng giữa trang dài của mục cũ)
    window.scrollTo({ top: 0 });
  };
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  // phím "/" để nhảy vào ô tìm cài đặt (bỏ qua khi đang gõ trong ô nhập khác)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!tab || !Comp) {
    return (
      <>
        <PageHeader title="Cài đặt" description="Cấu hình chung cho website, bán hàng, email và hệ thống" />
        <PageBody>
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
            Tài khoản của bạn chưa được cấp quyền truy cập mục cài đặt nào.
          </div>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Cài đặt" description="Cấu hình chung cho website, bán hàng, email và hệ thống" />
      <PageBody>
        <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
          {/* Thanh điều hướng các mục cài đặt (desktop) */}
          <nav aria-label="Mục cài đặt" className="hidden lg:block">
            <div className="sticky top-32 flex max-h-[calc(100vh-9rem)] flex-col">
              <div className="relative mb-3 shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter: mở mục đầu tiên khớp; Esc: xoá từ khoá
                    if (e.key === 'Enter' && grouped[0]) void go(grouped[0].items[0].key);
                    if (e.key === 'Escape') setQ('');
                  }}
                  placeholder="Tìm cài đặt..."
                  aria-label="Tìm cài đặt"
                  className="h-9 pl-8 pr-8"
                />
                {q ? (
                  <button type="button" onClick={() => setQ('')} aria-label="Xoá từ khoá" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                    <X className="size-3.5" />
                  </button>
                ) : (
                  <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground">/</kbd>
                )}
              </div>
              <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pr-2">
                {grouped.map((g) => (
                  <div key={g.key}>
                    <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g.label}</p>
                    <ul className="space-y-0.5">
                      {g.items.map((t) => {
                        const active = t.key === tabKey;
                        const off = !!t.feature && !isOn(t.feature);
                        return (
                          <li key={t.key}>
                            <button
                              type="button"
                              onClick={() => go(t.key)}
                              title={t.desc}
                              aria-current={active ? 'page' : undefined}
                              className={cn(
                                'group relative flex h-8 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm transition-colors',
                                active ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                              )}
                            >
                              {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                              <t.icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                              <span className={cn('min-w-0 flex-1 truncate', off && !active && 'text-muted-foreground')}>{t.label}</span>
                              {active && dirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Có thay đổi chưa lưu" />}
                              {off && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">Tắt</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {grouped.length === 0 && (
                  <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
                    <SearchX className="size-5" />
                    Không có mục nào khớp “{q}”
                  </div>
                )}
              </div>
            </div>
          </nav>

          {/* Chọn mục trên màn hình nhỏ: dropdown chia nhóm */}
          <div className="lg:hidden">
            <Select value={tabKey} onValueChange={go}>
              <SelectTrigger className="h-10 w-full" aria-label="Chọn mục cài đặt">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map((g) => {
                  const items = tabs.filter((t) => t.group === g.key);
                  if (!items.length) return null;
                  return (
                    <SelectGroup key={g.key}>
                      <SelectLabel>{g.label}</SelectLabel>
                      {items.map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          <t.icon className="size-4 text-muted-foreground" />
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 max-w-4xl space-y-5">
            {/* Tiêu đề của mục đang mở */}
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card text-primary shadow-xs">
                <tab.icon className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{GROUPS.find((g) => g.key === tab.group)?.label}</p>
                <h2 className="text-lg font-semibold leading-tight tracking-tight">{tab.label}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{tab.desc}</p>
              </div>
            </div>
            {/* Mục phụ thuộc tính năng đang tắt: nhắc để khỏi cấu hình mà không thấy tác dụng */}
            {tabOff && tab.feature && (
              <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/30">
                <Info className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                <p className="text-muted-foreground">
                  Tính năng <b className="text-foreground">{FEATURE_LABELS[tab.feature].label}</b> đang tắt nên các cài đặt dưới đây chưa có tác dụng trên website. Vẫn có thể cấu hình trước —{' '}
                  <button type="button" onClick={() => go('features')} className="font-medium text-primary hover:underline">
                    bật lại ở mục Tính năng
                  </button>
                  .
                </p>
              </div>
            )}
            <Comp key={tab.key} onDirtyChange={onDirtyChange} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}
