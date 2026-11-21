import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './svg-sanitize.js';

describe('sanitizeSvg', () => {
  it('giữ SVG hợp lệ: chữ hoa/thường của thẻ & thuộc tính, gradient, use nội bộ', () => {
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><path d="M0 0h10v10z" fill="url(#g)"/><use xlink:href="#g"/><text x="1">A &amp; B &lt;3</text></svg>`;
    const out = sanitizeSvg(svg)!;
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('xlink:href="#g"');
    expect(out).toContain('A &amp; B &lt;3');
    expect(out).not.toContain('<?xml');
  });

  it('bỏ script, sự kiện on*, foreignObject, style, animate/set, link javascript:', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><script><![CDATA[alert(2)]]></script>
      <style>@import url(//evil)</style>
      <foreignObject><iframe src="javascript:alert(3)"></iframe></foreignObject>
      <a href="javascript:alert(4)"><rect width="1" height="1" onclick="alert(5)"/></a>
      <animate attributeName="href" values="javascript:alert(6)"/><set attributeName="onmouseover" to="alert(7)"/>
      <use href="https://evil.com/x.svg#a"/><image href="data:image/svg+xml;base64,PHN2Zz4="/>
      <rect style="fill:url(https://evil/track)" fill="url(http://evil/x)"/>
    </svg>`;
    const out = sanitizeSvg(svg)!;
    for (const bad of ['alert', 'onload', 'onclick', '<script', '<style', 'foreignObject', 'iframe', 'javascript', '<animate', '<set', 'evil', 'svg+xml', '<a ']) {
      expect(out).not.toContain(bad);
    }
    // phần tử con hợp lệ của thẻ bị bỏ (<a>) vẫn giữ
    expect(out).toContain('<rect width="1" height="1"');
  });

  it('entity mã hoá trong href cũng bị chặn', () => {
    const out = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><use href="java&#x09;script:alert(1)"/><image href="&#106;avascript:alert(1)"/></svg>`)!;
    expect(out).not.toMatch(/script|alert/i);
  });

  it('DOCTYPE/ENTITY bị bỏ, không mở rộng entity tự khai báo', () => {
    const out = sanitizeSvg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`);
    expect(out).not.toBeNull();
    expect(out).not.toContain('<script');
    expect(out).not.toContain('ENTITY');
  });

  it('giữ ảnh raster nhúng base64, thêm xmlns khi thiếu', () => {
    const out = sanitizeSvg(`<svg><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>`)!;
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(out).toContain('href="data:image/png;base64,iVBORw0KGgo="');
  });

  it('không phải SVG -> null', () => {
    expect(sanitizeSvg('<html><body>hi</body></html>')).toBeNull();
    expect(sanitizeSvg('<script>alert(1)</script>')).toBeNull();
  });
});
