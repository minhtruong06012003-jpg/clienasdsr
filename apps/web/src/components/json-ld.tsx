import { jsonLdString } from "@/lib/seo";

/** Thẻ <script type="application/ld+json"> nhúng dữ liệu cấu trúc schema.org (đã chặn `</script>` trong nội dung) */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}
