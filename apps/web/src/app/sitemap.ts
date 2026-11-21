import type { MetadataRoute } from "next";
import { serverGet } from "@/lib/server-api";
import { absUrl, getSeoContext, siteOrigin } from "@/lib/seo";
import type { Paginated, PostCard } from "@/lib/types";

// tạo lại sitemap mỗi giờ (bài viết / model mới tự xuất hiện)
export const revalidate = 3600;

/** Trang nội dung CMS có link ở footer (API không có danh sách trang công khai) -> chỉ đưa vào sitemap khi trang tồn tại */
const CMS_PAGES = ["dieu-khoan", "chinh-sach-bao-mat"];

/**
 * sitemap.xml: trang công khai cố định, trang tài liệu từng model API `/v1`, bài viết blog (kèm ảnh đại diện) và trang CMS.
 * Bật "Không cho lập chỉ mục toàn site" ở Admin › SEO -> sitemap rỗng.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [base, { seo }] = await Promise.all([siteOrigin(), getSeoContext()]);
  if (seo.noindexSite) return [];
  const now = new Date();
  const fixed: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/pricing`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/community`, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/api-docs`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/blog`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/register`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${base}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];
  // gọi song song: bài viết, danh mục model API, trang CMS
  const [postsRes, modelsRes, ...pages] = await Promise.all([
    serverGet<Paginated<PostCard>>("/public/posts?page=1&limit=100", 3600),
    serverGet<{ data: { id: string }[] }>("/v1/models", 3600),
    ...CMS_PAGES.map((slug) => serverGet<{ slug: string }>(`/public/pages/by-slug/${slug}`, 3600)),
  ]);
  const posts: MetadataRoute.Sitemap = (postsRes.data?.data ?? []).map((p) => {
    const image = p.featuredImage?.url;
    return {
      url: `${base}/blog/${p.slug}`,
      ...(p.publishedAt ? { lastModified: p.publishedAt } : {}),
      changeFrequency: "monthly",
      priority: 0.6,
      ...(image && seo.sitemapIncludeImages !== false ? { images: [absUrl(base, image)] } : {}),
    };
  });
  // mã model có thể chứa `/` (vd kling-2.6/first-last-frame): giữ dấu `/`, mã hoá từng đoạn
  const models: MetadataRoute.Sitemap = (modelsRes.data?.data ?? []).map((m) => ({
    url: `${base}/api-docs/models/${m.id.split("/").map(encodeURIComponent).join("/")}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));
  const cms: MetadataRoute.Sitemap = pages.flatMap((r, i) => (r.data ? [{ url: `${base}/p/${CMS_PAGES[i]}`, changeFrequency: "yearly" as const, priority: 0.3 }] : []));
  return [...fixed, ...posts, ...models, ...cms];
}
