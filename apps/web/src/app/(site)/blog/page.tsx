import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CalendarDays, Clock } from "lucide-react";
import { serverGet } from "@/lib/server-api";
import { getServerI18n } from "@/lib/i18n/server";
import type { Paginated, PostCard } from "@/lib/types";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Blog & hướng dẫn"), description: t("Kiến thức, mẹo dùng AI sáng tạo nội dung và hướng dẫn sử dụng."), alternates: { canonical: "/blog" } };
}

type Props = { searchParams: Promise<{ page?: string }> };

/** Danh sách bài viết: `GET /api/public/posts?page&limit&locale=<ngôn ngữ đang chọn>` */
export default async function BlogPage({ searchParams }: Props) {
  // luôn render theo request (không prerender lúc build khi API chưa chạy)
  await connection();
  const sp = await searchParams;
  const { t, fmt, locale } = await getServerI18n();
  const page = Math.max(1, Number(sp.page) || 1);
  let res = await serverGet<Paginated<PostCard>>(`/public/posts?page=${page}&limit=12&locale=${locale}`);
  // chưa có bài nào dịch sang ngôn ngữ đang chọn -> hiện bài theo ngôn ngữ mặc định của website
  if (res.data && !res.data.data?.length) {
    const fallback = await serverGet<Paginated<PostCard>>(`/public/posts?page=${page}&limit=12`);
    if (fallback.data?.data?.length) res = fallback;
  }
  const posts = res.data?.data ?? [];
  const meta = res.data?.meta;

  return (
    <div>
      <header className="bg-hero border-b">
        <div className="mx-auto max-w-7xl px-4 py-14 text-center sm:px-6">
          <p className="text-sm font-semibold tracking-wide text-primary uppercase">{t("Blog")}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{t("Kiến thức & hướng dẫn")}</h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{t("Mẹo phát triển kênh, cập nhật thuật toán và hướng dẫn sử dụng dịch vụ.")}</p>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        {!res.data ? (
          <p className="py-16 text-center text-muted-foreground">{res.status === 404 ? t("Blog đang tạm tắt.") : t("Không tải được bài viết, vui lòng thử lại sau.")}</p>
        ) : !posts.length ? (
          <p className="py-16 text-center text-muted-foreground">{t("Chưa có bài viết nào.")}</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((p) => (
              <Link key={p.id} href={`/blog/${p.slug}`} className="group flex flex-col overflow-hidden rounded-2xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/5">
                <div className="bg-brand-gradient relative aspect-[16/9] overflow-hidden">
                  {p.featuredImage?.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.featuredImage.urls?.medium ?? p.featuredImage.url} alt={p.title} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                  )}
                </div>
                <div className="flex flex-1 flex-col p-5">
                  {!!p.categories?.length && <p className="text-xs font-semibold text-primary uppercase">{p.categories[0].name}</p>}
                  <h2 className="mt-1 line-clamp-2 text-lg font-semibold group-hover:text-primary">{p.title}</h2>
                  {p.excerpt && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{p.excerpt}</p>}
                  <p className="mt-auto flex items-center gap-3 pt-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="size-3.5" /> {fmt.dateOnly(p.publishedAt)}
                    </span>
                    {p.readingTime ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3.5" /> {t("{n} phút đọc", { n: p.readingTime })}
                      </span>
                    ) : null}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
        {meta && meta.totalPages > 1 && (
          <nav className="mt-10 flex items-center justify-center gap-2 text-sm">
            {page > 1 && (
              <Link href={`/blog?page=${page - 1}`} className="rounded-lg border px-4 py-2 hover:bg-muted">
                ← {t("Trang trước")}
              </Link>
            )}
            <span className="px-2 text-muted-foreground">
              {t("Trang {page}/{total}", { page: meta.page, total: meta.totalPages })}
            </span>
            {page < meta.totalPages && (
              <Link href={`/blog?page=${page + 1}`} className="rounded-lg border px-4 py-2 hover:bg-muted">
                {t("Trang sau")} →
              </Link>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
