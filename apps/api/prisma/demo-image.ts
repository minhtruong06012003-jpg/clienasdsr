/** Ảnh demo: nền gradient + chữ tự co cho vừa khung (không dùng emoji vì sharp không có font màu) */
export function demoSvg(opts: { w: number; h: number; from: string; to: string; title: string; sub?: string }) {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const size = Math.round(Math.min(opts.h * 0.12, (opts.w * 1.5) / Math.max(opts.title.length, 1)));
  const subSize = Math.round(size * 0.45);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.w}" height="${opts.h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${opts.from}"/><stop offset="1" stop-color="${opts.to}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${opts.w * 0.85}" cy="${opts.h * 0.2}" r="${opts.h * 0.35}" fill="#ffffff" opacity="0.08"/>
    <circle cx="${opts.w * 0.1}" cy="${opts.h * 0.9}" r="${opts.h * 0.25}" fill="#ffffff" opacity="0.06"/>
    ${opts.title ? `<text x="50%" y="${opts.sub ? '46%' : '50%'}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#fff" text-anchor="middle" dominant-baseline="middle">${esc(opts.title)}</text>` : ''}
    ${opts.sub ? `<text x="50%" y="60%" font-family="Helvetica, Arial, sans-serif" font-size="${subSize}" fill="#fff" opacity="0.85" text-anchor="middle" dominant-baseline="middle">${esc(opts.sub)}</text>` : ''}
  </svg>`;
}
