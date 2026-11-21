import { describe, expect, it } from 'vitest';
import { isPermanentMailError, retryDelayMs } from './mail-retry.js';

describe('mail-retry', () => {
  it('lịch thử lại tăng dần và dừng ở mức trần', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(4)).toBe(3_600_000);
    expect(retryDelayMs(6)).toBe(21_600_000);
    expect(retryDelayMs(99)).toBe(21_600_000);
    expect(retryDelayMs(0)).toBe(60_000);
  });

  it('địa chỉ nhận bị từ chối là lỗi vĩnh viễn', () => {
    expect(isPermanentMailError({ code: 'EENVELOPE' })).toBe(true);
    expect(isPermanentMailError({ responseCode: 550 })).toBe(true);
    expect(isPermanentMailError({ responseCode: 553 })).toBe(true);
  });

  it('lỗi tạm thời / xác thực / kết nối vẫn được thử lại', () => {
    expect(isPermanentMailError({ responseCode: 421 })).toBe(false);
    expect(isPermanentMailError({ responseCode: 451 })).toBe(false);
    expect(isPermanentMailError({ responseCode: 535, code: 'EAUTH' })).toBe(false);
    expect(isPermanentMailError({ code: 'ECONNECTION' })).toBe(false);
    expect(isPermanentMailError(new Error('timeout'))).toBe(false);
    expect(isPermanentMailError(null)).toBe(false);
  });

  it('người nhận bị từ chối: phân loại theo mã SMTP thực tế (nodemailer luôn gắn EENVELOPE)', () => {
    expect(isPermanentMailError({ code: 'EENVELOPE', message: "Can't send mail - all recipients were rejected: 421 4.7.0 Try again later" })).toBe(false);
    expect(isPermanentMailError({ code: 'EENVELOPE', message: "Can't send mail - all recipients were rejected: 550 5.1.1 User unknown" })).toBe(true);
    expect(isPermanentMailError({ code: 'EENVELOPE', response: '451 4.3.0 Temporary failure' })).toBe(false);
    expect(isPermanentMailError({ code: 'EENVELOPE' })).toBe(true);
  });
});
