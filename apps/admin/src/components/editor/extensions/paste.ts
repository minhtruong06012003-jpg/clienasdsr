/** Thuộc tính được giữ lại khi làm sạch HTML dán từ Word / Google Docs */
const KEEP_ATTRS: Record<string, string[]> = {
  A: ['href', 'target', 'rel'],
  IMG: ['src', 'alt', 'title', 'width', 'height'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
  OL: ['start'],
  IFRAME: ['src', 'width', 'height', 'title'],
};

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function wrapInto(el: Element, tag: string) {
  const w = el.ownerDocument.createElement(tag);
  while (el.firstChild) w.appendChild(el.firstChild);
  el.appendChild(w);
}

/** HTML có phải từ Word / Google Docs / Outlook... không */
export function isOfficeHtml(html: string) {
  return /urn:schemas-microsoft-com|class="?Mso|docs-internal-guid|content="Microsoft|xmlns:o=|<o:p>|docs\.google\.com/i.test(html);
}

/**
 * Làm sạch HTML dán vào: bỏ style/script/comment; với nội dung từ Word/Google Docs thì
 * chuyển span có style đậm/nghiêng/gạch chân thành b/i/u, bỏ toàn bộ style/class/id rác.
 */
export function cleanPastedHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  // nội dung copy từ chính ProseMirror -> giữ nguyên để không mất định dạng
  if (html.includes('data-pm-slice')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  body.querySelectorAll('style, script, meta, link, title, xml, noscript, object, embed').forEach((e) => e.remove());
  const comments: Node[] = [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  if (!isOfficeHtml(html)) return body.innerHTML;

  // Word: <o:p>, <v:...>; Google Docs: wrapper <b style="font-weight:normal" id="docs-internal-guid-...">
  body.querySelectorAll('b[id^="docs-internal-guid"], b[style*="font-weight:normal"], b[style*="font-weight: normal"]').forEach(unwrap);
  Array.from(body.getElementsByTagName('*'))
    .filter((e) => e.tagName.includes(':'))
    .forEach(unwrap);

  // span có style -> thẻ ngữ nghĩa, rồi bỏ span
  body.querySelectorAll('span, font').forEach((span) => {
    const st = (span.getAttribute('style') || '').toLowerCase();
    const fw = st.match(/font-weight\s*:\s*([^;]+)/)?.[1]?.trim();
    const bold = fw === 'bold' || fw === 'bolder' || (fw !== undefined && Number(fw) >= 600);
    const italic = /font-style\s*:\s*italic/.test(st);
    const underline = /text-decoration(-line)?\s*:\s*[^;]*underline/.test(st);
    const strike = /text-decoration(-line)?\s*:\s*[^;]*line-through/.test(st);
    if (underline) wrapInto(span, 'u');
    if (strike) wrapInto(span, 's');
    if (italic) wrapInto(span, 'em');
    if (bold) wrapInto(span, 'strong');
    unwrap(span);
  });

  // bỏ thuộc tính rác
  body.querySelectorAll('*').forEach((el) => {
    const keep = KEEP_ATTRS[el.tagName] ?? [];
    for (const attr of Array.from(el.attributes)) if (!keep.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
  });
  // bỏ đoạn rỗng chỉ chứa khoảng trắng / &nbsp;
  body.querySelectorAll('p').forEach((p) => {
    if (!p.querySelector('img, br') && !p.textContent?.replace(/ /g, '').trim()) p.remove();
  });
  return body.innerHTML;
}
