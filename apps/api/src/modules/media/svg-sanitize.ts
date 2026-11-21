import sanitizeHtml from 'sanitize-html';

/**
 * Làm sạch file SVG người dùng tải lên bằng DANH SÁCH CHO PHÉP (allowlist) thay cho chặn theo regex.
 *
 * Vì sao dùng sanitize-html (đã có sẵn trong dependencies) ở chế độ XML:
 * - Allowlist an toàn theo cấu trúc: chỉ thẻ / thuộc tính khai báo dưới đây được ghi ra, giá trị thuộc tính
 *   luôn được escape lại — các cách lách regex cũ (mã hoá entity, xuống dòng giữa `on` và `=`, `xlink:href`
 *   kiểu `java&#x09;script:`, `<animate attributeName="href">`...) không còn đường vào.
 * - DOCTYPE / khai báo ENTITY / processing instruction bị bỏ (chống XXE, billion laughs); `<script>`, `<style>`,
 *   `<foreignObject>`, `<iframe>`, thẻ animate/set (đổi được href thành javascript:) bị bỏ cả nội dung.
 * - Thuộc tính `href` / `xlink:href` chỉ nhận tham chiếu nội bộ `#id` hoặc ảnh raster nhúng `data:image/(png|jpeg|gif|webp)`.
 * - `style` (thuộc tính) giữ được để không vỡ màu/kích thước, nhưng bỏ hẳn nếu có `url(` ra ngoài, `@import`,
 *   `expression(`, `javascript:` hoặc `behavior:`. Thẻ `<style>` bị bỏ vì sanitize-html ghi nội dung thẻ này nguyên văn.
 * Áp dụng cho MỌI driver lưu trữ: local còn có thêm CSP sandbox khi phục vụ /uploads, nhưng S3/CDN thì không
 * gắn được header đó — nên file phải sạch ngay từ lúc lưu.
 */

/** Thẻ SVG tĩnh được giữ (hình học, gradient, mặt nạ, filter, chữ) — không có thẻ chạy script / nhúng tài liệu khác */
const SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'image',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
];

/** Thuộc tính trình bày / hình học được giữ (không có on*, không có thuộc tính nạp tài nguyên ngoài) */
const SVG_ATTRS = [
  'id', 'class', 'style', 'transform', 'opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits', 'filter', 'filterUnits', 'primitiveUnits',
  'color', 'display', 'visibility', 'overflow', 'vector-effect', 'shape-rendering', 'paint-order', 'mix-blend-mode', 'isolation',
  'xmlns', 'xmlns:xlink', 'version', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration', 'writing-mode', 'dx', 'dy', 'rotate', 'textLength',
  'lengthAdjust', 'startOffset', 'xml:space',
  'in', 'in2', 'result', 'stdDeviation', 'mode', 'type', 'values', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent',
  'k1', 'k2', 'k3', 'k4', 'operator', 'radius', 'scale', 'xChannelSelector', 'yChannelSelector', 'baseFrequency', 'numOctaves',
  'seed', 'stitchTiles', 'flood-color', 'flood-opacity', 'lighting-color', 'surfaceScale', 'diffuseConstant', 'specularConstant',
  'specularExponent', 'kernelMatrix', 'kernelUnitLength', 'order', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode',
  'preserveAlpha', 'azimuth', 'elevation', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'limitingConeAngle', 'z',
  'color-interpolation', 'color-interpolation-filters', 'enable-background',
  'href', 'xlink:href', 'aria-label', 'aria-hidden', 'role', 'focusable',
];

/** href hợp lệ: tham chiếu nội bộ (#id) hoặc ảnh raster nhúng base64 (không cho data:image/svg+xml — lồng SVG khác) */
const SAFE_HREF = /^(#[\w.:-]+|data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+)$/i;
/** CSS nguy hiểm trong thuộc tính style: tải tài nguyên ngoài, import, biểu thức IE, javascript: */
const UNSAFE_CSS = /url\s*\(\s*(?!['"]?#)|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: SVG_TAGS,
  allowedAttributes: { '*': SVG_ATTRS },
  // không áp danh sách scheme mặc định của sanitize-html (href được kiểm riêng bằng SAFE_HREF ở transformTags)
  allowedSchemes: [],
  allowedSchemesAppliedToAttributes: [],
  allowProtocolRelative: false,
  // thẻ không cho phép: bỏ thẻ, giữ phần con hợp lệ; script/style/... bị bỏ cả nội dung (nonTextTags)
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'foreignObject', 'iframe'],
  // XML: giữ đúng chữ hoa/thường của thẻ & thuộc tính SVG (viewBox, linearGradient...)
  parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false, decodeEntities: true },
  selfClosing: [],
  transformTags: {
    '*': (tagName, attribs) => {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(attribs)) {
        if ((name === 'href' || name === 'xlink:href') && !SAFE_HREF.test(value.trim())) continue;
        if (name === 'style' && UNSAFE_CSS.test(value)) continue;
        // presentation attribute cũng có thể chứa url(...) (fill="url(http://...)") -> chỉ nhận url(#id)
        if (name !== 'style' && /url\s*\(/i.test(value) && !/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(value.trim())) continue;
        out[name] = value;
      }
      return { tagName, attribs: out };
    },
  },
};

/**
 * Làm sạch nội dung SVG. Trả chuỗi SVG an toàn, hoặc null nếu sau khi làm sạch không còn phần tử `<svg>` gốc
 * (file không phải SVG thật / toàn mã độc).
 */
export function sanitizeSvg(input: string): string | null {
  // Bỏ BOM, khai báo XML, chú thích và DOCTYPE (kể cả phần khai báo ENTITY trong [...]) TRƯỚC khi phân tích:
  // DOCTYPE có thể khai báo entity; trình phân tích sẽ không mở rộng chúng, nhưng phần [...] làm lệch việc tách thẻ.
  const text = input
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\]\s*)?>/gi, '');
  let clean = sanitizeHtml(text, OPTIONS);
  // chỉ giữ phần tử gốc <svg>...</svg> (chữ thừa ngoài phần tử gốc là XML không hợp lệ)
  const start = clean.search(/<svg[\s>]/);
  const end = clean.lastIndexOf('</svg>');
  if (start < 0 || end < start) return null;
  clean = clean.slice(start, end + '</svg>'.length);
  // file SVG mở trực tiếp (Content-Type image/svg+xml) cần đúng namespace mới được hiểu là SVG:
  // ép xmlns của phần tử gốc về namespace SVG (bản xuất Illustrator cũ dùng xmlns="&ns_svg;" — entity không còn)
  const rootEnd = clean.indexOf('>');
  let root = clean.slice(0, rootEnd).replace(/\sxmlns="[^"]*"/, '');
  root = root.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/\sxmlns:xlink="/.test(root) || /\sxlink:href="/.test(clean)) {
    root = root.replace(/\sxmlns:xlink="[^"]*"/, '').replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/, '$& xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return root + clean.slice(rootEnd);
}
