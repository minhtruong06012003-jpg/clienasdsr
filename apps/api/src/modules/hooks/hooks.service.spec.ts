import { HooksService } from './hooks.service.js';

describe('HooksService', () => {
  let hooks: HooksService;

  beforeEach(() => {
    hooks = new HooksService();
  });

  it('chạy filter theo thứ tự priority', async () => {
    hooks.addFilter<string>('title', (v) => `${v}-b`, 20);
    hooks.addFilter<string>('title', (v) => `${v}-a`, 5);
    expect(await hooks.applyFilters('title', 'x')).toBe('x-a-b');
  });

  it('lỗi trong một hook không làm hỏng chuỗi', async () => {
    const calls: string[] = [];
    hooks.addAction('evt', () => {
      throw new Error('boom');
    });
    hooks.addAction('evt', () => {
      calls.push('ok');
    });
    await hooks.doAction('evt');
    expect(calls).toEqual(['ok']);
  });

  it('hàm trả về từ addFilter gỡ đúng hook đó', async () => {
    const off = hooks.addFilter<number>('n', (v) => v * 2);
    hooks.addFilter<number>('n', (v) => v + 1);
    expect(await hooks.applyFilters('n', 3)).toBe(7);
    off();
    expect(await hooks.applyFilters('n', 3)).toBe(4);
  });
});
