import { matchProvinceCode, normalizeLocationName } from './locations.service.js';

describe('shipping carriers: chuẩn hoá tên địa chỉ', () => {
  it.each([
    ['Quận 1', '1'],
    ['Q. Bình Thạnh', 'binh thanh'],
    ['Huyện Củ Chi', 'cu chi'],
    ['Phường Bến Nghé', 'ben nghe'],
    ['Thị xã Sơn Tây', 'son tay'],
    ['Xã Đông Hoà', 'dong hoa'],
    ['TP. Thủ Đức', 'thu duc'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLocationName(input)).toBe(expected);
  });

  it('khớp tỉnh/thành về mã ISO từ nhiều cách viết', () => {
    expect(matchProvinceCode('Hà Nội')).toBe('VN-HN');
    expect(matchProvinceCode('Thành phố Hà Nội')).toBe('VN-HN');
    expect(matchProvinceCode('Hồ Chí Minh')).toBe('VN-SG');
    expect(matchProvinceCode('TP. Hồ Chí Minh')).toBe('VN-SG');
    expect(matchProvinceCode('Tỉnh Đồng Nai')).toBe('VN-39');
    expect(matchProvinceCode('Bà Rịa - Vũng Tàu')).toBe('VN-BV');
    expect(matchProvinceCode('Không tồn tại')).toBeNull();
  });
});
