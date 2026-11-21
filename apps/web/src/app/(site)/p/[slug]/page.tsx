import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { BlockNode } from "@cmsnt/blocks";
import { CmsBlocks } from "@/components/cms/cms-blocks";
import { serverGet } from "@/lib/server-api";
import { getServerI18n } from "@/lib/i18n/server";

/** Trang CMS trả về từ `GET /api/public/pages/by-slug/:slug?locale=<ngôn ngữ>` */
interface CmsPage {
  id: string;
  title: string;
  slug: string;
  excerpt?: string | null;
  blocks?: BlockNode[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  noindex?: boolean;
}

type Props = { params: Promise<{ slug: string }> };

/** Tải trang theo ngôn ngữ đang chọn; trang chưa có bản dịch (404) thì lấy bản ngôn ngữ mặc định (bỏ tham số locale) */
async function load(slug: string, locale: string) {
  const path = `/public/pages/by-slug/${encodeURIComponent(slug)}`;
  const res = await serverGet<CmsPage>(`${path}?locale=${locale}`);
  return res.status === 404 ? serverGet<CmsPage>(path) : res;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { t, locale } = await getServerI18n();
  const res = await load(slug, locale);
  if (!res.data) return { title: t("Không tìm thấy trang") };
  return {
    title: res.data.seoTitle || res.data.title,
    description: res.data.seoDescription || res.data.excerpt || undefined,
    alternates: { canonical: `/p/${res.data.slug}` },
    robots: res.data.noindex ? { index: false } : undefined,
  };
}

/** Trang nội dung (điều khoản, chính sách...) dựng bằng Page Builder */
export default async function CmsPageRoute({ params }: Props) {
  const { slug } = await params;
  const { t, locale } = await getServerI18n();
  const res = await load(slug, locale);
  if (res.status === 404) notFound();
  if (!res.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold">{t("Không tải được trang")}</h1>
        <p className="mt-2 text-muted-foreground">{"error" in res ? res.error : ""}</p>
      </div>
    );
  }
  const page = res.data;
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  return (
    <article>
      <header className="bg-hero border-b">
        <div className="mx-auto max-w-4xl px-4 py-14 text-center sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{page.title}</h1>
          {page.excerpt && <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{page.excerpt}</p>}
        </div>
      </header>
      {blocks.length ? <CmsBlocks blocks={blocks} /> : <p className="py-16 text-center text-muted-foreground">{t("Trang chưa có nội dung.")}</p>}
    </article>
  );
}
