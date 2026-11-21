"use client";

/**
 * Render danh sách block Page Builder bằng thư viện dùng chung @cmsnt/blocks.
 * Đặt trong client component vì RenderContext chứa hàm (Link, Image, t...) không truyền qua ranh giới server → client được.
 */
import Link from "next/link";
import { useMemo } from "react";
import { BlockRenderer, type BlockNode, type ImageProps, type LinkProps, type RenderContext } from "@cmsnt/blocks";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/** Link nội bộ dùng next/link, link ngoài dùng thẻ a */
function CmsLink({ href, ...rest }: LinkProps) {
  if (/^(https?:)?\/\//.test(href) || href.startsWith("mailto:") || href.startsWith("tel:")) return <a href={href} {...rest} />;
  return <Link href={href} {...rest} />;
}

/** Ảnh thường (media đã có URL tuyệt đối), bỏ các prop riêng của next/image */
function CmsImage({ src, alt, width, height, className, sizes, priority, fill }: ImageProps) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={width ?? undefined} height={height ?? undefined} sizes={sizes} loading={priority ? "eager" : "lazy"} className={cn(fill && "absolute inset-0 size-full object-cover", className)} />;
}

export function CmsBlocks({ blocks }: { blocks: BlockNode[] }) {
  const { fmt, locale } = useI18n();
  // giá trong block hiển thị theo tiền tệ khách chọn (giá gốc lưu theo tiền gốc website)
  const ctx = useMemo<RenderContext>(
    () => ({
      // trường đa ngôn ngữ / ngày trong block theo ngôn ngữ khách chọn, thiếu bản dịch thì thư viện lấy bản mặc định
      locale,
      defaultLocale: "vi",
      mode: "view",
      apiUrl: "",
      formatPrice: (v: number) => fmt.money(v),
      href: (path: string) => path,
      Link: CmsLink,
      Image: CmsImage,
      t: (key: string) => key,
    }),
    [fmt, locale],
  );
  return (
    <div className="@container">
      <BlockRenderer blocks={blocks} ctx={ctx} />
    </div>
  );
}
