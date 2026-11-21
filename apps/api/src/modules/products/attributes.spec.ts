import { attrWhere, parseAttrQuery } from './attributes.filter.js';
import { normalizeAttributeValues, attributeKey } from './attributes.service.js';

describe('attributes: parseAttrQuery', () => {
  it('đọc dạng lồng (qs extended) và tách dấu phẩy', () => {
    expect(parseAttrQuery({ attr: { color: 'red,blue', size: ['m', 'l'] } })).toEqual({ color: ['red', 'blue'], size: ['m', 'l'] });
  });
  it('đọc khoá phẳng attr[key] / attr.key / attr_key, gộp + bỏ trùng', () => {
    expect(parseAttrQuery({ 'attr[color]': 'red', 'attr.color': 'red,green', attr_size: 'xl' })).toEqual({ color: ['red', 'green'], size: ['xl'] });
  });
  it('bỏ key không hợp lệ, giá trị rỗng; không có gì -> undefined', () => {
    expect(parseAttrQuery({ attr: { 'bad key': 'x', ok: ' , ' } })).toBeUndefined();
    expect(parseAttrQuery({ cf: { a: 'b' }, page: '1' })).toBeUndefined();
    expect(parseAttrQuery(null)).toBeUndefined();
  });
  it('giới hạn số giá trị mỗi thuộc tính', () => {
    const many = Array.from({ length: 50 }, (_, i) => `v${i}`).join(',');
    expect(parseAttrQuery({ attr: { color: many } })!.color).toHaveLength(20);
  });
});

describe('attributes: attrWhere', () => {
  it('không lọc -> mảng rỗng', () => {
    expect(attrWhere(undefined)).toEqual([]);
  });
  it('cùng một biến thể đang bán phải khớp mọi thuộc tính (OR trong từng thuộc tính)', () => {
    expect(attrWhere({ color: ['red', 'blue'], size: ['m'] })).toEqual([
      {
        variants: {
          some: {
            isActive: true,
            AND: [
              { OR: [{ optionValues: { path: ['color'], equals: 'red' } }, { optionValues: { path: ['color'], equals: 'blue' } }] },
              { OR: [{ optionValues: { path: ['size'], equals: 'm' } }] },
            ],
          },
        },
      },
    ]);
  });
});

describe('attributes: chuẩn hoá', () => {
  it('mã thuộc tính từ tên tiếng Việt', () => {
    expect(attributeKey('Màu sắc')).toBe('mau_sac');
  });
  it('giá trị: giữ mã đã nhập, mã rỗng sinh từ nhãn, bỏ trùng, nhãn rỗng lấy mã', () => {
    expect(
      normalizeAttributeValues([
        { value: ' do ', label: { vi: 'Đỏ' }, color: '#ff0000' },
        { value: 'do', label: { vi: 'Đỏ 2' } },
        { value: '', label: { vi: 'Xanh lá' } },
        { value: 'x', label: {} },
      ]),
    ).toEqual([
      { value: 'do', label: { vi: 'Đỏ' }, color: '#ff0000', imageId: null },
      { value: 'xanh-la', label: { vi: 'Xanh lá' }, color: null, imageId: null },
      { value: 'x', label: { vi: 'x' }, color: null, imageId: null },
    ]);
    // mã viết hoa (vd size "S") được giữ nguyên để khớp biến thể cũ
    expect(normalizeAttributeValues([{ value: 'S', label: { vi: 'S' } }])[0].value).toBe('S');
  });
});
