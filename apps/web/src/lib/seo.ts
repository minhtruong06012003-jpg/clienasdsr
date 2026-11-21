/**
 * Tiện ích SEO dùng chung cho server component: đọc cài đặt Admin › SEO, địa chỉ gốc tuyệt đối của website,
 * dữ liệu cấu trúc schema.org (JSON-LD) cho Google / Bing và các công cụ AI (ChatGPT, Perplexity, Gemini...).
 */
import { cache } from "react";
import { headers } from "next/headers";
import { serverGet } from "./server-api";
import { intlLocale } from "./i18n/config";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./site";
import type { Bootstrap, MediaRef } from "./types";

/** Nhóm cài đặt `seo` (Admin › Cài đặt › SEO); chuỗi đa ngôn ngữ lưu dạng { vi, en } */
export interface SeoSettings {
  titleTemplate?: string;
  defaultTitle?: Record<string, string> | string;
  defaultDescription?: Record<string, string> | string;
  defaultKeywords?: Record<string, string> | string;
  defaultOgImage?: MediaRef | string | null;
  twitterHandle?: string;
  robotsTxt?: string;
  noindexSite?: boolean;
  googleVerification?: string;
  bingVerification?: string;
  organizationType?: string;
  organizationLogo?: MediaRef | string | null;
  sitemapIncludeImages?: boolean;
}

/** Ảnh chia sẻ mặc định khi admin chưa chọn (route động tạo ảnh theo thương hiệu từng site — T-372) */
export const DEFAULT_OG_IMAGE = { url: "/og-banner.png", width: 1200, height: 630 };

/** Nội dung robots.txt mặc định kế thừa từ CMSNT Panel (đường dẫn shop không có ở web này) -> coi như admin chưa tuỳ biến */
export const LEGACY_ROBOTS_TXT = "User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account";

/** Lấy chuỗi theo ngôn ngữ từ giá trị đa ngôn ngữ (thiếu bản dịch -> tiếng Việt -> bản bất kỳ) */
export function pickLocale(v: Record<string, string> | string | null | undefined, locale: string): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v[locale] || v.vi || Object.values(v).find(Boolean) || "";
}

/** Lấy chuỗi đa ngôn ngữ có dịch tự động qua từ điển `t(...)` khi ngôn ngữ đang xem chưa được Admin nhập riêng (T-282) */
export function pickLocaleTranslated(
  v: Record<string, string> | string | null | undefined,
  locale: string,
  t: (s: string) => string,
): string {
  if (!v) return "";
  if (typeof v === "string") return t(v);
  if (v[locale]) return v[locale];
  const fallback = v.vi || Object.values(v).find(Boolean) || "";
  return fallback ? t(fallback) : "";
}

/** Mã OpenGraph locale chuẩn theo ngôn ngữ giao diện */
export function ogLocaleOf(locale: string): string {
  if (locale === "en") return "en_US";
  if (locale === "id") return "id_ID";
  if (locale === "zh-cn") return "zh_CN";
  if (locale === "th") return "th_TH";
  return "vi_VN";
}

/** URL ảnh từ trường media (API có thể trả object đã giải id hoặc chỉ id chuỗi -> bỏ qua) */
export const mediaUrl = (m: MediaRef | string | null | undefined) => (m && typeof m === "object" && m.url ? m.url : null);

/** Cài đặt website dùng cho SEO, đọc một lần mỗi request (bootstrap đã cache 60 giây) */
export const getSeoContext = cache(async () => {
  const boot = await serverGet<Bootstrap>("/public/bootstrap");
  const settings = boot.data?.settings;
  const seo = (settings?.seo as SeoSettings | undefined) ?? {};
  const general = settings?.general;
  const social = (settings?.social as Record<string, string> | undefined) ?? {};
  const contact = (settings?.contact as Record<string, string> | undefined) ?? {};
  return { seo, general, social, contact, ok: !!boot.data };
});

/** Tên website theo ngôn ngữ (Cài đặt › Chung), chưa đặt thì lấy theo domain của request để web con không bao giờ dính tên web nguồn (T-372) */
export async function siteNameFor(locale: string) {
  const { general } = await getSeoContext();
  const configured = pickLocale(general?.siteName, locale);
  if (configured) return configured;
  if (process.env.NEXT_PUBLIC_SITE_NAME) return process.env.NEXT_PUBLIC_SITE_NAME;
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0].replace(/^www\./i, "").trim();
  if (!host || /^nov\.ai\.vn$/i.test(host) || host === "localhost" || host === "127.0.0.1") return SITE_NAME;
  return host;
}

/**
 * Địa chỉ gốc tuyệt đối (không có `/` cuối): NEXT_PUBLIC_SITE_URL -> Cài đặt › Chung › siteUrl -> host của request.
 * Dùng cho sitemap, robots.txt, llms.txt, JSON-LD (đều cần URL tuyệt đối).
 */
export async function siteOrigin(): Promise<string> {
  if (SITE_URL) return SITE_URL;
  const { general } = await getSeoContext();
  if (general?.siteUrl) return general.siteUrl.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}` : "http://localhost:3318";
}

/** robots cho trang công khai nằm trong khu thành viên (layout noindex): cho index, trừ khi admin chặn toàn site */
export async function publicRobots() {
  const { seo } = await getSeoContext();
  return seo.noindexSite ? { index: false, follow: false } : { index: true, follow: true };
}

/** Đổi đường dẫn tương đối thành URL tuyệt đối theo địa chỉ gốc */
export const absUrl = (origin: string, path: string) => (/^https?:\/\//.test(path) ? path : `${origin}${path.startsWith("/") ? "" : "/"}${path}`);

/** Mô tả mặc định: Admin › SEO (theo ngôn ngữ, tự dịch qua `t(...)` nếu chưa nhập riêng) -> NEXT_PUBLIC_SITE_DESCRIPTION */
export async function defaultDescription(locale: string, t: (s: string) => string) {
  const { seo } = await getSeoContext();
  return pickLocaleTranslated(seo.defaultDescription, locale, t) || t(SITE_DESCRIPTION);
}

/**
 * Ảnh chia sẻ mặc định: Admin › SEO › OG image -> ảnh bìa tĩnh.
 * Trang con khai báo `openGraph` sẽ thay hẳn openGraph của layout (Next không gộp sâu) nên phải tự gắn lại ảnh này.
 */
export async function defaultOgImage(): Promise<{ url: string; width?: number; height?: number }> {
  const [{ seo }, name] = await Promise.all([getSeoContext(), siteNameFor("vi")]);
  const url = mediaUrl(seo.defaultOgImage);
  return url ? { url } : { url: `/og-banner.png?s=${encodeURIComponent(name)}&v=2`, width: 1200, height: 630 };
}

/** Đường dẫn mạng xã hội admin khai báo (Cài đặt › Mạng xã hội) -> `sameAs` của Organization */
function socialLinks(social: Record<string, string>) {
  return Object.values(social).filter((v) => typeof v === "string" && /^https?:\/\//.test(v));
}

/**
 * JSON-LD Organization + WebSite cho mọi trang (Google Knowledge Panel, AI nhận diện thương hiệu).
 * `@id` cố định để các schema khác (bài viết, dịch vụ) tham chiếu lại tổ chức này.
 */
export async function siteJsonLd(locale: string, description: string) {
  const [origin, name, { seo, general, social, contact }] = await Promise.all([siteOrigin(), siteNameFor(locale), getSeoContext()]);
  const logo = mediaUrl(seo.organizationLogo) ?? mediaUrl(general?.logo) ?? null;
  const email = typeof contact.email === "string" && contact.email ? contact.email : undefined;
  const phone = typeof contact.phone === "string" && contact.phone ? contact.phone : undefined;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": seo.organizationType || "Organization",
        "@id": `${origin}/#organization`,
        name,
        url: `${origin}/`,
        description,
        ...(logo ? { logo: absUrl(origin, logo) } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { telephone: phone } : {}),
        ...(socialLinks(social).length ? { sameAs: socialLinks(social) } : {}),
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name,
        url: `${origin}/`,
        description,
        inLanguage: intlLocale(locale),
        publisher: { "@id": `${origin}/#organization` },
      },
    ],
  };
}

/** JSON-LD BreadcrumbList từ danh sách [tên, đường dẫn] (đường dẫn tương đối) */
export function breadcrumbJsonLd(origin: string, items: [string, string][]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: absUrl(origin, path) })),
  };
}

/** Chuỗi JSON an toàn để nhúng vào thẻ <script> (chặn `</script>` trong nội dung admin nhập) */
export const jsonLdString = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
