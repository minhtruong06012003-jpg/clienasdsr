import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { headers } from "next/headers";
import { ImageResponse } from "next/og";
import { siteNameFor } from "@/lib/seo";

export const runtime = "nodejs";

let cachedBgUri: string | null = null;
let cachedFont: ArrayBuffer | null | undefined = undefined;

function getBaseBgUri(): string | null {
  if (cachedBgUri) return cachedBgUri;
  const candidates = [
    path.join(process.cwd(), "public/images/home/og-cover-base.jpg"),
    path.join(process.cwd(), "apps/web/public/images/home/og-cover-base.jpg"),
    "/var/www/nov.ai.vn/apps/web/public/images/home/og-cover-base.jpg",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const buf = readFileSync(p);
        cachedBgUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
        return cachedBgUri;
      }
    } catch {
      // thử đường dẫn tiếp theo
    }
  }
  return null;
}

function getBoldFont(): ArrayBuffer | null {
  if (cachedFont !== undefined) return cachedFont;
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const buf = readFileSync(p);
        cachedFont = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        return cachedFont;
      }
    } catch {
      // thử font tiếp theo
    }
  }
  cachedFont = null;
  return null;
}

/**
 * Ảnh OpenGraph 1200×630 động theo tên thương hiệu riêng của từng website (T-372):
 * Web chính hiển thị "NOV AI", mỗi web con hiển thị đúng tên thương hiệu / tên miền của web con đó,
 * tuyệt đối không dính tên hoặc thông tin của web nguồn khi chia sẻ link trên Zalo / Facebook / Telegram.
 */
export async function GET() {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0].replace(/^www\./i, "").trim();
  const siteName = (await siteNameFor("vi")).trim();
  const resolved = siteName || (host && host !== "localhost" && host !== "127.0.0.1" ? host : "NOV AI");
  const brand = resolved.toUpperCase();

  const bgUri = getBaseBgUri();
  const fontData = getBoldFont();

  const len = brand.length;
  const fontSize = len <= 10 ? 64 : len <= 14 ? 52 : len <= 18 ? 44 : 36;
  const topPos = len <= 10 ? 176 : len <= 14 ? 186 : 194;

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          position: "relative",
          backgroundColor: "#000000",
          color: "#ffffff",
          fontFamily: fontData ? "BrandBold" : "sans-serif",
        }}
      >
        {bgUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bgUri}
            alt=""
            width={1200}
            height={630}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "1200px",
              height: "630px",
              objectFit: "cover",
            }}
          />
        ) : null}
        <div
          style={{
            position: "absolute",
            left: "72px",
            top: `${topPos}px`,
            maxWidth: "590px",
            display: "flex",
            alignItems: "center",
            fontSize: `${fontSize}px`,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.08,
            color: "#ffffff",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {brand}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fontData
        ? {
            fonts: [{ name: "BrandBold", data: fontData, weight: 700 as const, style: "normal" as const }],
          }
        : {}),
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    },
  );
}
