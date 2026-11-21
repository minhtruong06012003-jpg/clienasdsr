import { mergeModelGroups } from "@/lib/ai";
import { FAQ } from "@/lib/faq";
import { serverGet } from "@/lib/server-api";
import { defaultDescription, getSeoContext, pickLocale, siteNameFor, siteOrigin } from "@/lib/seo";
import { createT } from "@/lib/i18n/translate";
import type { AiTool, Paginated, PostCard } from "@/lib/types";

// tạo lại mỗi giờ (công cụ / model / bài viết mới tự cập nhật)
export const revalidate = 3600;

/** Tên nhóm đầu ra hiển thị trong llms.txt */
const OUTPUT_LABEL: Record<string, string> = { video: "Video", image: "Ảnh", audio: "Âm thanh / giọng đọc", text: "Văn bản" };

/** Dòng mô tả một mục, bỏ xuống dòng để không vỡ định dạng Markdown */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * /llms.txt (đề xuất llmstxt.org): bản tóm tắt Markdown của website cho mô hình ngôn ngữ (ChatGPT, Claude, Perplexity, Gemini...)
 * đọc nhanh khi trả lời người dùng: website làm gì, công cụ AI đang có, cách tính phí, hỏi đáp, tài liệu API từng model, bài viết.
 * Viết bằng tiếng Việt (ngôn ngữ mặc định); dữ liệu lấy trực tiếp từ API nên luôn khớp cấu hình admin.
 */
export async function GET() {
  const t = createT("vi");
  const [origin, name, description, { seo, contact }, toolsRes, modelsRes, postsRes] = await Promise.all([
    siteOrigin(),
    siteNameFor("vi"),
    defaultDescription("vi", t),
    getSeoContext(),
    serverGet<AiTool[]>("/public/ai/tools", 3600),
    serverGet<{ data: { id: string; name: string; output: string; description?: string | null }[] }>("/v1/models", 3600),
    serverGet<Paginated<PostCard>>("/public/posts?page=1&limit=50", 3600),
  ]);
  // admin chặn lập chỉ mục toàn site -> không công bố nội dung cho AI
  if (seo.noindexSite) return new Response("", { status: 404 });

  const lines: string[] = [`# ${name}`, "", `> ${oneLine(description)}`, ""];
  lines.push(
    `${name} là nền tảng AI tất cả trong một tại Việt Nam: tạo video, ảnh, giọng đọc (chuyển văn bản thành giọng nói), âm nhạc bằng các model AI hàng đầu trên cùng một tài khoản.`,
    "- Thanh toán theo lượt dùng bằng số dư ví (VND), không cần đăng ký gói tháng; giá hiện rõ trước khi bấm tạo.",
    "- Tạo lỗi hoặc quá thời gian: tự hoàn lại toàn bộ tiền của lần tạo đó.",
    "- Nạp tiền bằng chuyển khoản ngân hàng (quét mã QR), tiền vào ví sau vài giây; số dư không hết hạn.",
    "- Có REST API cho nhà phát triển và chương trình tiếp thị liên kết (hoa hồng % trên tiền nạp của người được giới thiệu).",
    "",
  );

  // công cụ AI theo loại đầu ra (công cụ cùng nhóm model gộp thành một, như trên website)
  const tools = mergeModelGroups(toolsRes.data ?? undefined);
  if (tools.length) {
    lines.push("## Công cụ AI", "");
    for (const out of ["video", "image", "audio", "text"]) {
      const list = tools.filter((x) => x.output === out);
      if (!list.length) continue;
      lines.push(`### ${OUTPUT_LABEL[out]}`, "");
      for (const x of list) lines.push(`- **${oneLine(t(x.group || x.name))}**${x.description ? `: ${oneLine(t(x.description))}` : ""}`);
      lines.push("");
    }
  }

  lines.push(
    "## Trang chính",
    "",
    `- [Trang chủ](${origin}/): giới thiệu, danh sách công cụ AI, hỏi đáp`,
    `- [Bảng giá nạp tiền](${origin}/pricing): mức nạp và khuyến mãi tặng thêm`,
    `- [Cộng đồng](${origin}/community): tác phẩm AI khách chia sẻ công khai kèm prompt`,
    `- [Đăng ký](${origin}/register): tạo tài khoản miễn phí`,
    `- [Blog & hướng dẫn](${origin}/blog)`,
    "",
    "## Tài liệu API",
    "",
    `- [Tổng quan REST API](${origin}/api-docs): xác thực bằng API key, tạo tác vụ, lấy kết quả, báo giá, lỗi & giới hạn`,
  );
  for (const m of modelsRes.data?.data ?? []) {
    const path = m.id.split("/").map(encodeURIComponent).join("/");
    lines.push(`- [${m.id}](${origin}/api-docs/models/${path}): ${oneLine(t(m.name))} (${m.output})${m.description ? ` — ${oneLine(t(m.description))}` : ""}`);
  }
  lines.push("");

  lines.push("## Câu hỏi thường gặp", "");
  for (const [q, a] of FAQ) lines.push(`### ${t(q)}`, "", t(a), "");

  const posts = postsRes.data?.data ?? [];
  if (posts.length) {
    lines.push("## Bài viết", "");
    for (const p of posts) lines.push(`- [${oneLine(p.title)}](${origin}/blog/${p.slug})${p.excerpt ? `: ${oneLine(p.excerpt)}` : ""}`);
    lines.push("");
  }

  // thông tin liên hệ admin khai báo (Cài đặt › Liên hệ)
  const contacts = [
    typeof contact.companyName === "string" && contact.companyName ? `- Đơn vị: ${contact.companyName}` : "",
    typeof contact.email === "string" && contact.email ? `- Email: ${contact.email}` : "",
    typeof contact.hotline === "string" && contact.hotline ? `- Hotline: ${contact.hotline}` : typeof contact.phone === "string" && contact.phone ? `- Điện thoại: ${contact.phone}` : "",
    pickLocale(contact.address as unknown as Record<string, string>, "vi") ? `- Địa chỉ: ${pickLocale(contact.address as unknown as Record<string, string>, "vi")}` : "",
  ].filter(Boolean);
  if (contacts.length) lines.push("## Liên hệ", "", ...contacts, "");

  lines.push("## Optional", "", `- [Sitemap](${origin}/sitemap.xml)`, "");
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
