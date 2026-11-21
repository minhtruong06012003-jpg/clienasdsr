import type { Metadata } from 'next';
import { Be_Vietnam_Pro, Geist_Mono } from 'next/font/google';
import { Providers } from '@/lib/providers';
import './globals.css';

// Be Vietnam Pro: cùng font với website khách, dấu tiếng Việt rõ ràng; Geist Mono cho mã / số liệu
const beVietnamPro = Be_Vietnam_Pro({ variable: '--font-sans', subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600', '700', '800'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin', 'vietnamese'] });

export const metadata: Metadata = {
  title: { default: 'Admin Panel', template: '%s · Admin Panel' },
  description: 'Hệ thống quản trị website Admin Panel',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${beVietnamPro.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
