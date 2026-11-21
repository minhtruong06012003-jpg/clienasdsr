/**
 * Proxy (Next 16, thay middleware): đỡ link có tiền tố ngôn ngữ `/{locale}/...`.
 * API dựng link trong email / URL trả về từ cổng thanh toán theo quy ước "ngôn ngữ khác mặc định có tiền tố" (vd /en/verify-email),
 * còn web này giữ ngôn ngữ trong cookie, không có route theo tiền tố -> chuyển hướng về đường dẫn không tiền tố
 * và ghi cookie ngôn ngữ để trang mở đúng ngôn ngữ (server chỉ dùng nếu admin đang bật ngôn ngữ đó).
 */
import { NextResponse, type NextRequest } from "next/server";
import { asLocale, LOCALE_COOKIE } from "@/lib/i18n/config";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const m = /^\/([a-z]{2}(?:-[A-Za-z]{2})?)(\/.*)?$/.exec(pathname);
  if (!m) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = m[2] || "/";
  url.search = search;
  const res = NextResponse.redirect(url);
  // mã đầy đủ (vd zh-cn); ngôn ngữ chưa bật thì server bỏ qua cookie và dùng ngôn ngữ mặc định
  const locale = asLocale(m[1]);
  if (locale) res.cookies.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
}

// chỉ chạy với đường dẫn bắt đầu bằng mã ngôn ngữ 2 chữ (web không có route nào dài đúng 2 chữ cái)
export const config = {
  matcher: ["/:lang([a-z]{2})", "/:lang([a-z]{2})/:path*", "/:lang([a-z]{2}-[A-Za-z]{2})", "/:lang([a-z]{2}-[A-Za-z]{2})/:path*"],
};
