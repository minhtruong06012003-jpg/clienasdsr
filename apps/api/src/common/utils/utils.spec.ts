import { slugify, buildPath, hasPermission } from '@cmsnt/shared';
import { excerptFrom, readingTime, stripHtml } from './html.util.js';
import { effectivePrice } from '../../modules/products/products.presenter.js';

describe('slugify', () => {
  it('bỏ dấu tiếng Việt và ký tự đặc biệt', () => {
    expect(slugify('Điện thoại Nova X Pro – Giá tốt!')).toBe('dien-thoai-nova-x-pro-gia-tot');
    expect(slugify('  Áo thun (nhiều size)  ')).toBe('ao-thun-nhieu-size');
  });
});

describe('buildPath', () => {
  it('ngôn ngữ mặc định không có tiền tố', () => {
    expect(buildPath('product', 'ao-thun', 'vi', 'vi')).toBe('/products/ao-thun');
    expect(buildPath('page', 'about-us', 'en', 'vi')).toBe('/en/about-us');
    expect(buildPath('home', null, 'en', 'vi')).toBe('/en');
    expect(buildPath('home', null, 'vi', 'vi')).toBe('/');
  });
});

describe('hasPermission', () => {
  it('quyền * là toàn quyền, còn lại phải có đủ', () => {
    expect(hasPermission(['*'], 'pages.write')).toBe(true);
    expect(hasPermission(['pages.read'], ['pages.read', 'pages.write'])).toBe(false);
    expect(hasPermission(undefined, 'pages.read')).toBe(false);
  });
});

describe('html utils', () => {
  it('tính thời gian đọc và trích đoạn', () => {
    const html = `<p>${'từ '.repeat(450)}</p>`;
    expect(readingTime(html)).toBe(2);
    expect(stripHtml('<b>A</b>&nbsp;<i>B</i>')).toBe('A B');
    expect(excerptFrom('<p>Một hai ba bốn năm</p>', 9)).toBe('Một hai…');
  });
});

describe('effectivePrice', () => {
  it('chỉ áp giá khuyến mãi trong thời gian sale', () => {
    const past = new Date(Date.now() - 86400_000);
    const future = new Date(Date.now() + 86400_000);
    expect(effectivePrice({ price: 100, salePrice: 80 }).finalPrice).toBe(80);
    expect(effectivePrice({ price: 100, salePrice: 80, saleEnd: past }).finalPrice).toBe(100);
    expect(effectivePrice({ price: 100, salePrice: 80, saleStart: future }).finalPrice).toBe(100);
    expect(effectivePrice({ price: 100, salePrice: 120 }).salePrice).toBeNull();
  });
});
