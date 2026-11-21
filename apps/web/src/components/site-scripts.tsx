/**
 * Chèn mã nhúng (Cài đặt › Mã nhúng, nhóm `scripts`) và mã theo dõi (Cài đặt › Mã theo dõi, nhóm `tracking`) vào mọi trang.
 * Render phía server nên script có mặt ngay trong HTML gốc (trình duyệt tự chạy, bot xác minh như Google Search Console đọc được).
 * - `<head>`: React không cho chèn HTML thô vào head -> tách mã thành các thẻ meta / link / base / script / style / noscript rồi render từng thẻ.
 * - Đầu / cuối `<body>`: chèn HTML thô trong một div `display: contents` (không ảnh hưởng bố cục).
 */
import { createElement, type ReactNode } from "react";

/** Nhóm cài đặt `scripts` */
export type ScriptsSettings = { headCode?: string; bodyStartCode?: string; bodyEndCode?: string };
/** Nhóm cài đặt `tracking` */
export type TrackingSettings = { enabled?: boolean; ga4Id?: string; gtmId?: string; fbPixelId?: string; tiktokPixelId?: string };

/** Đổi tên thuộc tính HTML sang tên prop React (chỉ những thuộc tính hay gặp trong mã nhúng) */
const ATTR_MAP: Record<string, string> = {
  class: "className",
  charset: "charSet",
  "http-equiv": "httpEquiv",
  crossorigin: "crossOrigin",
  referrerpolicy: "referrerPolicy",
  nomodule: "noModule",
  fetchpriority: "fetchPriority",
  hreflang: "hrefLang",
};
/** Thuộc tính boolean: có mặt là bật */
const BOOL_ATTRS = new Set(["async", "defer", "nomodule"]);

/** Đọc chuỗi thuộc tính `a="1" b='2' c=3 d` thành props React */
function parseAttrs(raw: string): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    // bỏ thuộc tính sự kiện (onload=...) vì React không nhận chuỗi cho handler
    if (name.startsWith("on")) continue;
    const value = m[2] ?? m[3] ?? m[4];
    props[ATTR_MAP[name] ?? name] = BOOL_ATTRS.has(name) ? true : (value ?? "");
  }
  return props;
}

/**
 * Tách mã dán vào `<head>` thành các thẻ React. Chỉ nhận các thẻ hợp lệ trong head; chữ / thẻ khác bị bỏ qua
 * (trình duyệt cũng sẽ đẩy chúng xuống body nếu chèn thô).
 */
function headCodeToElements(code: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // thẻ có nội dung (script / style / noscript / title) hoặc thẻ đơn (meta / link / base); bỏ qua comment
  const re = /<!--[\s\S]*?-->|<(script|style|noscript)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<(meta|link|base)\b([^>]*?)\/?>/gi;
  let i = 0;
  for (const m of code.matchAll(re)) {
    const key = `${keyPrefix}-${i++}`;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const inner = m[3];
      out.push(createElement(tag, { key, ...parseAttrs(m[2]), ...(inner.trim() ? { dangerouslySetInnerHTML: { __html: inner } } : {}) }));
    } else if (m[4]) {
      out.push(createElement(m[4].toLowerCase(), { key, ...parseAttrs(m[5]) }));
    }
  }
  return out;
}

/** Chèn HTML thô (đầu / cuối body). Script trong HTML gốc do server trả về vẫn được trình duyệt chạy bình thường. */
function RawHtml({ html }: { html: string }) {
  return <div style={{ display: "contents" }} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />;
}

/** ID theo dõi hợp lệ (chặn chèn mã lạ qua ô ID) */
const ID_RULES = {
  ga4Id: /^(G|AW|UA)-[A-Z0-9-]+$/i,
  gtmId: /^GTM-[A-Z0-9]+$/i,
  fbPixelId: /^\d{5,20}$/,
  tiktokPixelId: /^[A-Z0-9]{10,30}$/i,
} as const;

/** Lấy các ID hợp lệ khi mã theo dõi đang bật */
function trackingIds(t?: TrackingSettings | null) {
  if (!t || t.enabled === false) return {};
  const pick = (k: keyof typeof ID_RULES) => {
    const v = (t[k] ?? "").trim();
    return ID_RULES[k].test(v) ? v : undefined;
  };
  return { ga4: pick("ga4Id"), gtm: pick("gtmId"), fb: pick("fbPixelId"), tiktok: pick("tiktokPixelId") };
}

/** Các thẻ đặt trong `<head>`: mã theo dõi theo ID + mã nhúng head của admin */
export function SiteHeadScripts({ scripts, tracking }: { scripts?: ScriptsSettings | null; tracking?: TrackingSettings | null }) {
  const ids = trackingIds(tracking);
  return (
    <>
      {/* Google Analytics 4 */}
      {ids.ga4 && <script async src={`https://www.googletagmanager.com/gtag/js?id=${ids.ga4}`} />}
      {ids.ga4 && (
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ids.ga4}');`,
          }}
        />
      )}
      {/* Google Tag Manager (ID do admin nhập lúc chạy nên không dùng component dựng sẵn của @next/third-parties) */}
      {ids.gtm && (
        // eslint-disable-next-line @next/next/next-script-for-ga
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${ids.gtm}');`,
          }}
        />
      )}
      {/* Facebook Pixel */}
      {ids.fb && (
        <script
          dangerouslySetInnerHTML={{
            __html: `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${ids.fb}');fbq('track','PageView');`,
          }}
        />
      )}
      {/* TikTok Pixel */}
      {ids.tiktok && (
        <script
          dangerouslySetInnerHTML={{
            __html: `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript";o.async=!0;o.src=r+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load('${ids.tiktok}');ttq.page();}(window,document,'ttq');`,
          }}
        />
      )}
      {/* mã admin dán vào <head> */}
      {scripts?.headCode?.trim() ? headCodeToElements(scripts.headCode, "head-code") : null}
    </>
  );
}

/** Ngay sau thẻ mở `<body>`: phần noscript của GTM + mã nhúng đầu body */
export function SiteBodyStartScripts({ scripts, tracking }: { scripts?: ScriptsSettings | null; tracking?: TrackingSettings | null }) {
  const ids = trackingIds(tracking);
  return (
    <>
      {ids.gtm && (
        <noscript>
          <iframe src={`https://www.googletagmanager.com/ns.html?id=${ids.gtm}`} height="0" width="0" style={{ display: "none", visibility: "hidden" }} />
        </noscript>
      )}
      {scripts?.bodyStartCode?.trim() ? <RawHtml html={scripts.bodyStartCode} /> : null}
    </>
  );
}

/** Trước thẻ đóng `</body>`: mã nhúng cuối body (widget chat, mã chuyển đổi...) */
export function SiteBodyEndScripts({ scripts }: { scripts?: ScriptsSettings | null }) {
  return scripts?.bodyEndCode?.trim() ? <RawHtml html={scripts.bodyEndCode} /> : null;
}
