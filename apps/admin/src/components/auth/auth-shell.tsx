'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Coins, Gift, ShieldCheck, Sparkles } from 'lucide-react';
import { t } from '@cmsnt/shared';
import { api } from '@/lib/api';
import { HAS_WEB_URL, WEB_HOME } from '@/lib/site';
import { ThemeToggle } from '@/components/common/theme-toggle';
import type { I18nText } from '@/lib/types';

interface SiteInfo {
  settings?: { general?: { siteName?: I18nText; logo?: { url: string; urls?: { thumb?: string } } | null } };
}

/** Tên + logo website (từ API công khai) để trang đăng nhập nhận diện đúng thương hiệu của khách hàng */
export function useSiteBrand() {
  const q = useQuery({ queryKey: ['public-site-brand'], queryFn: () => api.get<SiteInfo>('/public/bootstrap'), staleTime: 5 * 60_000, retry: 0 });
  const general = q.data?.settings?.general;
  return { siteName: t(general?.siteName, 'vi', 'en') || '', logoUrl: general?.logo?.url ?? null };
}

/** Điểm nổi bật của trang quản trị website dịch vụ AI (cột trái trang đăng nhập) */
const FEATURES = [
  { icon: Bot, title: 'Công cụ AI', text: 'Bật/tắt công cụ, đặt giá (VND) theo từng model' },
  { icon: Sparkles, title: 'Theo dõi tác vụ', text: 'Video, ảnh, giọng nói — trạng thái, hoàn tiền vào ví khi lỗi' },
  { icon: Coins, title: 'Gói nạp tiền', text: 'Nạp tiền vào ví kèm tặng thêm, thanh toán QR, doanh thu' },
  { icon: Gift, title: 'Tiếp thị liên kết', text: 'Hoa hồng giới thiệu, duyệt yêu cầu rút tiền' },
];

/** Khung chung cho trang đăng nhập / quên / đặt lại mật khẩu */
export function AuthShell({ children }: { children: ReactNode }) {
  const { siteName } = useSiteBrand();

  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* Cột giới thiệu (máy tính) */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-700 text-white lg:flex lg:flex-col dark:from-blue-950 dark:via-indigo-950 dark:to-slate-950">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.07)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_top_left,black_20%,transparent_75%)]"
        />
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full bg-white/10 blur-3xl dark:bg-blue-500/10" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -left-20 size-[26rem] rounded-full bg-fuchsia-400/20 blur-3xl dark:bg-violet-600/10" />

        <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <div className="leading-tight">
              <div className="font-semibold">Admin Panel</div>
              <div className="text-xs text-white/60">Hệ thống quản trị website</div>
            </div>
          </div>

          <div className="max-w-lg space-y-8">
            <div className="space-y-4">
              <h1 className="text-4xl font-bold leading-[1.15] tracking-tight xl:text-[2.75rem]">Quản trị AI Studio, gọn trong một nơi</h1>
              <p className="text-base text-white/70">Công cụ AI, tác vụ, gói cước, thanh toán và thành viên — theo dõi tức thì, không cần lập trình.</p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <li key={f.title} className="flex gap-3 rounded-xl bg-white/[0.07] p-3.5 ring-1 ring-white/10 backdrop-blur-sm">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
                    <f.icon className="size-[18px]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{f.title}</span>
                    <span className="block text-xs leading-relaxed text-white/65">{f.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between text-xs text-white/55">
            <span>© {new Date().getFullYear()} Admin Panel{siteName ? ` · ${siteName}` : ''}</span>
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" /> Kết nối được mã hoá
            </span>
          </div>
        </div>
      </aside>

      {/* Cột biểu mẫu */}
      <main className="flex min-h-svh flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-2.5 lg:invisible">
            <span className="text-sm font-semibold">Admin Panel</span>
          </div>
          <ThemeToggle />
        </header>

        <div className="flex flex-1 items-center justify-center px-5 py-6 sm:px-8">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-5 py-5 text-xs text-muted-foreground">
          {/* link về website chỉ hiện khi đã cấu hình NEXT_PUBLIC_WEB_URL */}
          {HAS_WEB_URL && (
            <>
              <a href={WEB_HOME} className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <ArrowLeft className="size-3.5" /> Về {siteName || 'trang web'}
              </a>
              <span className="hidden sm:inline">·</span>
            </>
          )}
          <span>Chỉ dành cho quản trị viên & nhân viên được cấp quyền</span>
        </footer>
      </main>
    </div>
  );
}

/** Ô báo lỗi / thành công dùng trong form đăng nhập */
export function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : tone === 'success'
        ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
        : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm leading-relaxed ${cls}`}>
      {children}
    </div>
  );
}
