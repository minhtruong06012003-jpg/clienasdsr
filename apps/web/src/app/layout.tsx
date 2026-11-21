import type { Metadata, Viewport } from "next";
import { DEFAULT_SITE_FONT, findSiteFont, googleFontHref, siteFontStack } from "@cmsnt/shared";
import { Dancing_Script, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { ContactButtons } from "@/components/site/contact-buttons";
import { PopupNotice } from "@/components/site/popup-notice";
import { SiteBodyEndScripts, SiteBodyStartScripts, SiteHeadScripts, type ScriptsSettings, type TrackingSettings } from "@/components/site-scripts";
import { getI18nInitial, getServerI18n } from "@/lib/i18n/server";
import { PALETTE_BOOT_SCRIPT } from "@/lib/palette";
import { serverGet } from "@/lib/server-api";
import { defaultDescription, defaultOgImage, getSeoContext, ogLocaleOf, pickLocaleTranslated, siteJsonLd, siteNameFor, siteOrigin } from "@/lib/seo";
import type { AppearanceConfig } from "@/lib/site-theme";
import { JsonLd } from "@/components/json-ld";
import type { Bootstrap } from "@/lib/types";
import "./globals.css";

const handwritten = Dancing_Script({ variable: "--font-handwritten-face", subsets: ["latin", "vietnamese"], weight: ["700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "vietnamese"] });

/** Favicon mặc định (tia sét trắng trên nền đen) khi admin chưa upload favicon; để dạng data URI vì file-based icon.svg sẽ đè favicon upload */
const DEFAULT_FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#27272a"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M35 10 17 36h13l-3 18 20-27H34l1-17Z" fill="#fff"/></svg>',
)}`;

/**
 * Metadata mặc định theo ngôn ngữ khách chọn, lấy từ Admin › Cài đặt › SEO (mẫu tiêu đề, tiêu đề / mô tả / từ khoá mặc định,
 * ảnh chia sẻ, tài khoản X, mã xác minh Google / Bing, chặn lập chỉ mục) và favicon ở Cài đặt › Chung.
 * Chưa cấu hình thì dùng tên / mô tả từ biến môi trường (qua từ điển dịch).
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerI18n();
  const [{ seo, general }, name, description] = await Promise.all([getSeoContext(), siteNameFor(locale), defaultDescription(locale, t)]);
  const favicon = general?.favicon?.url;
  const tagline = pickLocaleTranslated((general as { tagline?: Record<string, string> } | undefined)?.tagline, locale, t);
  // mẫu tiêu đề admin dùng %title% / %siteName% / %tagline% -> template của Next dùng %s
  const template = (seo.titleTemplate || `%title% · ${name}`).replace(/%title%/g, "%s").replace(/%siteName%/g, name).replace(/%tagline%/g, tagline);
  const ogImage = await defaultOgImage();
  const keywords = pickLocaleTranslated(seo.defaultKeywords, locale, t) || t("tạo video AI, tạo ảnh AI, giọng đọc AI, chuyển văn bản thành giọng nói, tạo nhạc AI, Veo 3, Kling, Midjourney, Nano Banana, GPT Image, ElevenLabs");
  const twitter = seo.twitterHandle ? `@${seo.twitterHandle.replace(/^@/, "")}` : undefined;
  return {
    title: { default: pickLocaleTranslated(seo.defaultTitle, locale, t) || t("{site} — Sáng tạo video, ảnh, giọng nói bằng AI", { site: name }), template },
    description,
    keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
    applicationName: name,
    metadataBase: new URL(await siteOrigin()),
    icons: favicon ? { icon: favicon, apple: favicon } : { icon: { url: DEFAULT_FAVICON, type: "image/svg+xml" } },
    openGraph: { type: "website", siteName: name, description, locale: ogLocaleOf(locale), images: [ogImage] },
    twitter: { card: "summary_large_image", ...(twitter ? { site: twitter } : {}), images: [ogImage.url] },
    // cho phép Google / AI hiện đoạn trích dài, ảnh lớn, video xem trước; bật chặn toàn site ở Admin › SEO -> noindex mọi trang
    robots: seo.noindexSite
      ? { index: false, follow: false }
      : { index: true, follow: true, googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large", "max-video-preview": -1 } },
    verification: {
      ...(seo.googleVerification ? { google: seo.googleVerification } : {}),
      ...(seo.bingVerification ? { other: { "msvalidate.01": seo.bingVerification } } : {}),
    },
    // không tự biến số điện thoại / địa chỉ trong nội dung thành link trên Safari iOS
    formatDetection: { telephone: false, address: false, email: false },
  };
}

/** Viewport mobile: cho phép nội dung tràn vùng tai thỏ (dùng safe-area cho thanh điều hướng dưới), màu thanh trình duyệt theo giao diện */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1320" },
  ],
};

/** Layout gốc: font, chủ đề sáng/tối, React Query, đăng nhập, ngôn ngữ / tiền tệ / múi giờ */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // ngôn ngữ / tiền tệ / múi giờ khách đã chọn (cookie) + cài đặt website -> render đúng ngay từ server
  const i18n = await getI18nInitial();
  // dữ liệu cấu trúc Organization + WebSite cho mọi trang (Google, Bing, công cụ AI nhận diện thương hiệu)
  const { t } = await getServerI18n();
  const siteLd = await siteJsonLd(i18n.locale, await defaultDescription(i18n.locale, t));
  // mã nhúng + mã theo dõi admin cấu hình (cùng bootstrap đã cache 60 giây, Next gộp request trùng)
  const boot = await serverGet<Bootstrap>("/public/bootstrap");
  const scripts = boot.data?.settings.scripts as ScriptsSettings | undefined;
  const tracking = boot.data?.settings.tracking as TrackingSettings | undefined;
  const appearance = boot.data?.settings.appearance as (AppearanceConfig & { fontFamily?: string }) | undefined;
  // font admin chọn (Cài đặt › Font chữ); font mặc định đã nạp sẵn bằng next/font nên chỉ tải thêm khi chọn font khác
  const font = findSiteFont(appearance?.fontFamily);
  const customFont = font && font.name !== DEFAULT_SITE_FONT ? font : null;
  const YUPVOX_FONT_STACK = `"Google Sans", system-ui, -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif`;
  return (
    <html lang={i18n.locale} className={`${handwritten.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* chèn bảng phối màu khách đã chọn trước khi vẽ trang để không nháy màu mặc định */}
        <script dangerouslySetInnerHTML={{ __html: PALETTE_BOOT_SCRIPT }} />
        {customFont ? (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
            <link rel="stylesheet" href={googleFontHref(customFont)} />
            {/* ghi đè biến --font-sans khi admin chọn font riêng */}
            <style dangerouslySetInnerHTML={{ __html: `:root:root{--site-font-sans:${siteFontStack(customFont)};--font-sans:${siteFontStack(customFont)}}` }} />
          </>
        ) : (
          <style dangerouslySetInnerHTML={{ __html: `:root:root{--site-font-sans:${YUPVOX_FONT_STACK};--font-sans:${YUPVOX_FONT_STACK}}` }} />
        )}
        <SiteHeadScripts scripts={scripts} tracking={tracking} />
      </head>
      <body className="min-h-full">
        <SiteBodyStartScripts scripts={scripts} tracking={tracking} />
        <JsonLd data={siteLd} />
        <Providers i18n={i18n} appearance={appearance} bootstrap={boot.data ?? undefined}>
          {children}
          {/* nút liên hệ nổi ở góc màn hình (Cài đặt › Nút liên hệ) */}
          <ContactButtons />
          {/* hộp thông báo nổi khi khách vào website (Cài đặt › Thông báo nổi) */}
          <PopupNotice />
        </Providers>
        <SiteBodyEndScripts scripts={scripts} />
      </body>
    </html>
  );
}
