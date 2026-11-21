import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { serverGet } from "@/lib/server-api";
import type { AiTool } from "@/lib/types";
import { Landing } from "@/components/site/landing";
import { JsonLd } from "@/components/json-ld";
import { mergeModelGroups, type AiCategoryRaw } from "@/lib/ai";
import { FAQ } from "@/lib/faq";
import { defaultDescription, defaultOgImage, ogLocaleOf, siteNameFor, siteOrigin } from "@/lib/seo";

// metadata riêng cho trang chủ: tiêu đề đầy đủ (không ghép template) + Open Graph khi chia sẻ link
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerI18n();
  const [name, description, image] = await Promise.all([siteNameFor(locale), defaultDescription(locale, t), defaultOgImage()]);
  return {
    title: { absolute: t("{name} — Tạo video, ảnh, giọng nói bằng AI", { name }) },
    description,
    alternates: { canonical: "/" },
    openGraph: { type: "website", url: "/", siteName: name, title: t("{name} — Nền tảng AI tất cả trong một", { name }), description, locale: ogLocaleOf(locale), images: [image] },
  };
}

/** Trang chủ: danh sách công cụ AI lấy sẵn ở server (cache 60 giây) để HTML có nội dung cho SEO */
export default async function HomePage() {
  // lấy song song công cụ + nhóm (thứ tự nhóm do admin xếp)
  const [tools, categories, { t, locale }, origin] = await Promise.all([serverGet<AiTool[]>("/public/ai/tools"), serverGet<AiCategoryRaw[]>("/public/ai/categories"), getServerI18n(), siteOrigin()]);
  const name = await siteNameFor(locale);
  // dữ liệu cấu trúc: hỏi đáp (FAQPage) + danh mục công cụ AI (ItemList các dịch vụ), giúp Google / AI trả lời đúng về website
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        "@id": `${origin}/#faq`,
        mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: t(q), acceptedAnswer: { "@type": "Answer", text: t(a) } })),
      },
      {
        "@type": "ItemList",
        "@id": `${origin}/#tools`,
        name: t("Công cụ AI trên {name}", { name }),
        itemListElement: mergeModelGroups(tools.data ?? undefined).map((x, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: {
            "@type": "Service",
            name: t(x.group || x.name),
            ...(x.description ? { description: t(x.description) } : {}),
            serviceType: x.output,
            provider: { "@id": `${origin}/#organization` },
          },
        })),
      },
    ],
  };
  return (
    <>
      <JsonLd data={ld} />
      <Landing initialTools={tools.data ?? undefined} initialCategories={categories.data ?? undefined} />
    </>
  );
}
