import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Clock, UserRound } from "lucide-react";
import { PostViewCounter } from "@/components/cms/post-view-counter";
import { serverGet } from "@/lib/server-api";
import { intlLocale } from "@/lib/i18n/config";
import { getServerI18n } from "@/lib/i18n/server";
import type { MediaRef, PostCard } from "@/lib/types";
import { JsonLd } from "@/components/json-ld";
import { absUrl, breadcrumbJsonLd, defaultOgImage, siteNameFor, siteOrigin } from "@/lib/seo";

/** Chi tiết bài viết: `GET /api/public/posts/:slug?locale=<ngôn ngữ>` (content là HTML đã được API lọc) */
interface Post extends PostCard {
  content?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  ogImage?: MediaRef | null;
  related?: PostCard[];
}

type Props = { params: Promise<{ slug: string }> };

/** Tải bài theo ngôn ngữ đang chọn; bài chưa có bản dịch (404) thì lấy bản ngôn ngữ mặc định của website (bỏ tham số locale) */
async function load(slug: string, locale: string) {
  const path = `/public/posts/${encodeURIComponent(slug)}`;
  const res = await serverGet<Post>(`${path}?locale=${locale}`);
  return res.status === 404 ? serverGet<Post>(path) : res;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { t, locale } = await getServerI18n();
  const res = await load(slug, locale);
  if (!res.data) return { title: t("Không tìm thấy bài viết") };
  const p = res.data;
  const image = p.ogImage?.url ?? p.featuredImage?.url;
  const [name, fallback] = await Promise.all([siteNameFor(locale), defaultOgImage()]);
  const title = p.seoTitle || p.title;
  const description = p.seoDescription || p.excerpt || undefined;
  // canonical + Open Graph dạng bài viết (ngày đăng, tác giả, chuyên mục) để Facebook / Zalo / Google / AI hiểu đây là bài viết
  return {
    title,
    description,
    alternates: { canonical: `/blog/${p.slug}` },
    openGraph: {
      type: "article",
      url: `/blog/${p.slug}`,
      siteName: name,
      title,
      description,
      locale: locale === "en" ? "en_US" : locale === "id" ? "id_ID" : locale === "zh" || locale === "zh-cn" ? "zh_CN" : locale === "th" ? "th_TH" : "vi_VN",
      images: [image ? { url: image } : fallback],
      ...(p.publishedAt ? { publishedTime: p.publishedAt } : {}),
      ...(p.author?.name ? { authors: [p.author.name] } : {}),
      ...(p.categories?.length ? { section: p.categories[0].name, tags: p.categories.map((c) => c.name) } : {}),
    },
  };
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const { t, fmt, locale } = await getServerI18n();
  const res = await load(slug, locale);
  if (res.status === 404) notFound();
  if (!res.data) {
    return <p className="py-24 text-center text-muted-foreground">{t("Không tải được bài viết, vui lòng thử lại sau.")}</p>;
  }
  const p = res.data;
  const origin = await siteOrigin();
  const image = p.ogImage?.url ?? p.featuredImage?.url;
  // dữ liệu cấu trúc BlogPosting + đường dẫn breadcrumb (Google hiện ngày đăng / tác giả, AI trích dẫn đúng nguồn)
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "@id": `${origin}/blog/${p.slug}#article`,
      mainEntityOfPage: `${origin}/blog/${p.slug}`,
      headline: p.title,
      ...(p.seoDescription || p.excerpt ? { description: p.seoDescription || p.excerpt } : {}),
      ...(image ? { image: absUrl(origin, image) } : {}),
      ...(p.publishedAt ? { datePublished: p.publishedAt } : {}),
      ...(p.author?.name ? { author: { "@type": "Person", name: p.author.name } } : { author: { "@id": `${origin}/#organization` } }),
      publisher: { "@id": `${origin}/#organization` },
      inLanguage: intlLocale(locale),
      ...(p.categories?.length ? { articleSection: p.categories.map((c) => c.name) } : {}),
    },
    breadcrumbJsonLd(origin, [
      [t("Trang chủ"), "/"],
      [t("Blog"), "/blog"],
      [p.title, `/blog/${p.slug}`],
    ]),
  ];
  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <JsonLd data={ld} />
      <PostViewCounter id={p.id} />
      <Link href="/blog" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t("Tất cả bài viết")}
      </Link>
      {!!p.categories?.length && <p className="mt-6 text-xs font-semibold text-primary uppercase">{p.categories.map((c) => c.name).join(" · ")}</p>}
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{p.title}</h1>
      <p className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        {p.author?.name && (
          <span className="inline-flex items-center gap-1.5">
            <UserRound className="size-4" /> {p.author.name}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="size-4" /> {fmt.dateOnly(p.publishedAt)}
        </span>
        {p.readingTime ? (
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-4" /> {t("{n} phút đọc", { n: p.readingTime })}
          </span>
        ) : null}
      </p>
      {p.featuredImage?.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.featuredImage.urls?.large ?? p.featuredImage.url} alt={p.title} className="mt-8 w-full rounded-2xl border object-cover" />
      )}
      {/* nội dung HTML từ trình soạn thảo của admin (API đã lọc XSS khi lưu) */}
      <div className="prose prose-neutral dark:prose-invert prose-a:text-primary prose-img:rounded-xl mt-8 max-w-none" dangerouslySetInnerHTML={{ __html: p.content ?? "" }} />
      {!!p.related?.length && (
        <section className="mt-14 border-t pt-8">
          <h2 className="text-xl font-semibold">{t("Bài viết liên quan")}</h2>
          <ul className="mt-4 space-y-3">
            {p.related.slice(0, 4).map((r) => (
              <li key={r.id}>
                <Link href={`/blog/${r.slug}`} className="font-medium hover:text-primary">
                  {r.title}
                </Link>
                <p className="text-xs text-muted-foreground">{fmt.dateOnly(r.publishedAt)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
