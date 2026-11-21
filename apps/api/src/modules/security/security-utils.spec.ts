import { describe, expect, it } from 'vitest';
import { checkPassword, DEFAULT_PASSWORD_POLICY, ipMatchesRule, isCommonPassword, isLoopbackIp, isPrivateIp, normalizeIpRule, readPasswordPolicy, ruleCoversLoopback } from '@cmsnt/shared';

/** Hàm dùng chung của Trung tâm bảo mật: chuẩn hoá / so khớp IP-CIDR và chính sách mật khẩu */
describe('IP / CIDR', () => {
  it('chuẩn hoá IP đơn và dải CIDR về địa chỉ mạng', () => {
    expect(normalizeIpRule('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpRule(' 1.2.3.4/24 ')).toBe('1.2.3.0/24');
    expect(normalizeIpRule('2001:DB8::1/32')).toBe('2001:db8::/32');
    expect(normalizeIpRule('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIpRule('1.2.3.4/32')).toBe('1.2.3.4');
  });

  it('từ chối giá trị không hợp lệ', () => {
    for (const bad of ['', 'abc', '300.1.1.1', '1.2.3', '1.2.3.4/33', '1.2.3.4/24/1', '2001:db8:::1', 'fe80::1/129']) expect(normalizeIpRule(bad)).toBeNull();
  });

  it('so khớp IPv4, IPv6 và IPv4 ánh xạ', () => {
    expect(ipMatchesRule('1.2.3.99', '1.2.3.0/24')).toBe(true);
    expect(ipMatchesRule('1.2.4.1', '1.2.3.0/24')).toBe(false);
    expect(ipMatchesRule('::ffff:1.2.3.5', '1.2.3.0/24')).toBe(true);
    expect(ipMatchesRule('2001:db8:abcd::5', '2001:db8::/32')).toBe(true);
    expect(ipMatchesRule('2001:db9::5', '2001:db8::/32')).toBe(false);
    expect(ipMatchesRule('1.2.3.4', '1.2.3.4')).toBe(true);
    expect(ipMatchesRule('1.2.3.4', '2001:db8::/32')).toBe(false);
  });

  it('nhận diện loopback và quy tắc bao trùm loopback', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(ruleCoversLoopback('0.0.0.0/0')).toBe(true);
    expect(ruleCoversLoopback('127.0.0.0/8')).toBe(true);
    expect(ruleCoversLoopback('203.113.0.0/16')).toBe(false);
  });

  it('IP mạng nội bộ (proxy) không bị tự chặn', () => {
    for (const ip of ['10.1.2.3', '172.18.0.5', '192.168.1.10', '::ffff:172.20.0.1', 'fd00::1', '127.0.0.1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['203.113.1.5', '172.32.0.1', '8.8.8.8', '2001:db8::1']) expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('Chính sách mật khẩu', () => {
  it('mật khẩu phổ biến kể cả khi thêm hoa / số / ký tự đặc biệt', () => {
    expect(isCommonPassword('123456')).toBe(true);
    expect(isCommonPassword('Password@123')).toBe(true);
    expect(isCommonPassword('MatKhau2024!')).toBe(true);
    expect(isCommonPassword('aaaaaaaa')).toBe(true);
    expect(isCommonPassword('Xk9!vbq2Lm')).toBe(false);
  });

  it('kiểm tra từng điều kiện', () => {
    const strict = { ...DEFAULT_PASSWORD_POLICY, minLength: 10, requireUppercase: true, requireNumber: true, requireSymbol: true };
    expect(checkPassword('short', strict).length).toBeGreaterThanOrEqual(3);
    expect(checkPassword('Xk9!vbq2Lmz', strict)).toEqual([]);
  });

  it('không chứa email hoặc tên (bỏ dấu tiếng Việt)', () => {
    expect(checkPassword('thanhvip!2026x', DEFAULT_PASSWORD_POLICY, { name: 'Nguyễn Thành' })).toContain('không chứa email hoặc tên của bạn');
    expect(checkPassword('Ztrongdep99#', DEFAULT_PASSWORD_POLICY, { email: 'ztrong@gmail.com' })).toContain('không chứa email hoặc tên của bạn');
  });

  it('đọc cài đặt và giới hạn độ dài 6–64', () => {
    expect(readPasswordPolicy({ passwordMinLength: 2 }).minLength).toBe(6);
    expect(readPasswordPolicy({ passwordMinLength: 999 }).minLength).toBe(64);
    expect(readPasswordPolicy({}).blockCommon).toBe(true);
  });
});
