import { describe, expect, it } from 'vitest';
import { CARD_LOG_MAX, cardCallbackLogPayload, maskCardPayload, maskMiddle } from './card-callback-log.js';

describe('Nhật ký callback nạp thẻ', () => {
  it('che giữa chuỗi, chuỗi ngắn che hết', () => {
    expect(maskMiddle('123456789012')).toBe('12********12');
    expect(maskMiddle('12345')).toBe('*****');
    expect(maskMiddle('')).toBe('');
  });

  it('che mã thẻ / serial / chữ ký ở mọi tầng, giữ nguyên trường khác', () => {
    const out = maskCardPayload({ request_id: 'NTABC', code: '123456789012345', serial: '10000000000001', callback_sign: 'abcdef0123456789', nested: { card_code: '99998888777766' }, list: [{ pin: '111122223333' }], status: 1 }) as Record<string, unknown>;
    expect(out.request_id).toBe('NTABC');
    expect(out.status).toBe(1);
    expect(out.code).toBe('12***********45');
    expect(out.serial).toBe('10**********01');
    expect(out.callback_sign).toBe('ab************89');
    expect((out.nested as Record<string, unknown>).card_code).toBe('99**********66');
    expect((out.list as Record<string, unknown>[])[0].pin).toBe('11********33');
  });

  it('request không hợp lệ không lưu payload', () => {
    expect(cardCallbackLogPayload({ query: { code: '123' }, body: { x: 'y'.repeat(50_000) } }, false)).toEqual({});
  });

  it('payload hợp lệ quá lớn bị cắt ngắn ≤ 20KB và vẫn đã che mã thẻ', () => {
    const out = cardCallbackLogPayload({ query: { code: '123456789012345' }, body: { junk: 'x'.repeat(30_000) } }, true) as { truncated?: boolean; preview?: string };
    expect(out.truncated).toBe(true);
    expect(out.preview!.length).toBe(CARD_LOG_MAX);
    expect(out.preview).not.toContain('123456789012345');
  });
});
