import { describe, expect, it } from 'vitest';
import { escapeHtml, formatDate, formatMoney, render, usedPaths } from './template-engine.js';

describe('template-engine', () => {
  it('thay biến và escape HTML', () => {
    expect(render('Xin chào {{user.name}}!', { user: { name: '<b>An</b>' } })).toBe('Xin chào &lt;b&gt;An&lt;/b&gt;!');
    expect(render('{{{html}}}', { html: '<b>đậm</b>' })).toBe('<b>đậm</b>');
  });

  it('biến thiếu -> rỗng, không lỗi', () => {
    expect(render('a{{x.y.z}}b', {})).toBe('ab');
    expect(render('{{money total}}', {})).toBe('');
  });

  it('khối each với this, @index và biến ngoài', () => {
    const out = render('{{#each items}}{{@number}}. {{this.name}} x{{this.qty}} ({{order.code}}){{#unless @last}}, {{/unless}}{{/each}}', {
      order: { code: 'DH1' },
      items: [
        { name: 'A', qty: 1 },
        { name: 'B', qty: 2 },
      ],
    });
    expect(out).toBe('1. A x1 (DH1), 2. B x2 (DH1)');
    expect(render('{{#each tags}}[{{this}}]{{/each}}', { tags: ['x', 'y'] })).toBe('[x][y]');
    expect(render('{{#each none}}x{{/each}}', {})).toBe('');
  });

  it('if / else / unless', () => {
    const tpl = '{{#if order.note}}Ghi chú: {{order.note}}{{else}}Không ghi chú{{/if}}';
    expect(render(tpl, { order: { note: 'giao giờ hành chính' } })).toBe('Ghi chú: giao giờ hành chính');
    expect(render(tpl, { order: { note: '' } })).toBe('Không ghi chú');
    expect(render('{{#if list}}có{{/if}}', { list: [] })).toBe('');
    expect(render('{{#unless paid}}chưa trả{{/unless}}', { paid: false })).toBe('chưa trả');
  });

  it('khối lồng nhau', () => {
    const tpl = '{{#each groups}}{{this.name}}:{{#each this.items}}{{this}}{{#if @last}}.{{else}},{{/if}}{{/each}} {{/each}}';
    expect(render(tpl, { groups: [{ name: 'G', items: [1, 2] }] })).toBe('G:1,2. ');
  });

  it('helper money/date và helper tuỳ chỉnh', () => {
    expect(render('{{money total}}', { total: 1500000 })).toBe('1.500.000₫');
    expect(render('{{money total}}', { total: 10.5 }, { helpers: { money: (v) => formatMoney(v, { currencySymbol: '$', currencyPosition: 'before', decimals: 2, thousandSeparator: ',', decimalSeparator: '.' }) } })).toBe('$10.50');
    expect(render('{{upper name}}', { name: 'an' })).toBe('AN');
    expect(render('{{date at}}', { at: '2026-01-02T03:04:00.000Z' }, { helpers: { date: (v) => formatDate(v) } })).toBe('02/01/2026 10:04');
  });

  it('bỏ qua thẻ không hợp lệ, giữ chuỗi nguyên văn', () => {
    expect(render('{{#foo}}x{{/foo}}', {})).toBe('{{#foo}}x');
    expect(render('100% {{', {})).toBe('100% {{');
  });

  it('usedPaths liệt kê biến', () => {
    expect(usedPaths('{{a}} {{#each b}}{{this.c}}{{/each}} {{#if d}}{{money e}}{{/if}}')).toEqual(['a', 'b', 'this.c', 'd', 'e']);
  });

  it('formatMoney theo cài đặt', () => {
    expect(formatMoney(1234567, { currencySymbol: '₫', currencyPosition: 'after', thousandSeparator: '.', decimalSeparator: ',', decimals: 0 })).toBe('1.234.567₫');
    expect(formatMoney(-5000)).toBe('-5.000₫');
    expect(formatMoney('abc')).toBe('abc');
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });
});
