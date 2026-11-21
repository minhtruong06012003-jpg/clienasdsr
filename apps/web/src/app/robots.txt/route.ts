import { getSeoContext, LEGACY_ROBOTS_TXT, siteOrigin } from "@/lib/seo";

// tạo lại mỗi giờ (đổi cài đặt SEO trong admin tự áp dụng)
export const revalidate = 3600;

/** Trang riêng của khách / luồng tài khoản: không cần bot đọc (khu thành viên vốn đã noindex) */
const PRIVATE = ["/dashboard", "/history", "/tools/", "/account", "/add-funds", "/checkout", "/transactions", "/affiliate", "/api-keys", "/forgot-password", "/reset-password", "/verify-email"];

/**
 * Bot AI được mời đọc nội dung công khai (trả lời câu hỏi / trích dẫn trên ChatGPT, Claude, Perplexity, Gemini, Copilot...).
 * `User-agent: *` đã cho phép, liệt kê riêng để rõ ý định và dễ chặn từng bot khi cần.
 */
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "Bingbot", "meta-externalagent", "Amazonbot", "CCBot", "DuckAssistBot", "MistralAI-User"];

/**
 * robots.txt: Admin › SEO › "Nội dung robots.txt" nếu admin đã tuỳ biến (khác bản mặc định cũ của CMSNT Panel),
 * ngược lại tự sinh: cho phép trang công khai, chặn trang riêng, mời bot AI, khai báo sitemap + llms.txt.
 * Bật "Không cho lập chỉ mục toàn site" -> chặn toàn bộ.
 */
export async function GET() {
  const [{ seo }, origin] = await Promise.all([getSeoContext(), siteOrigin()]);
  const custom = (seo.robotsTxt ?? "").trim();
  let body: string;
  if (seo.noindexSite) {
    body = "User-agent: *\nDisallow: /\n";
  } else if (custom && custom !== LEGACY_ROBOTS_TXT) {
    // nội dung admin nhập, tự thêm dòng Sitemap nếu admin quên
    body = `${custom}\n${/^sitemap:/im.test(custom) ? "" : `\nSitemap: ${origin}/sitemap.xml\n`}`;
  } else {
    const rules = ["Allow: /", ...PRIVATE.map((p) => `Disallow: ${p}`)].join("\n");
    body = [
      `User-agent: *\n${rules}`,
      `# Bot AI: được phép đọc trang công khai; tóm tắt cho AI ở ${origin}/llms.txt`,
      `${AI_BOTS.map((b) => `User-agent: ${b}`).join("\n")}\n${rules}`,
      `Sitemap: ${origin}/sitemap.xml`,
    ].join("\n\n") + "\n";
  }
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
