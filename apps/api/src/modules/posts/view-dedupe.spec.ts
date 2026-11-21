import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ViewDeduper } from './view-dedupe.js';
import { PostsService } from './posts.service.js';

describe('ViewDeduper', () => {
  it('cùng khoá trong cửa sổ chỉ tính 1 lần, hết cửa sổ thì tính lại', () => {
    const d = new ViewDeduper(1000, 100);
    expect(d.isDuplicate('ip|a', 0)).toBe(false);
    d.mark('ip|a', 0);
    expect(d.isDuplicate('ip|a', 999)).toBe(true);
    expect(d.isDuplicate('ip|b', 999)).toBe(false);
    expect(d.isDuplicate('ip|a', 1000)).toBe(false);
  });

  it('giới hạn số khoá: dọn khoá hết hạn rồi bỏ khoá cũ nhất', () => {
    const d = new ViewDeduper(1000, 10);
    for (let i = 0; i < 10; i++) d.mark(`k${i}`, 0);
    // khoá mới khi đã đầy, các khoá cũ còn hạn -> bỏ khoá cũ nhất, còn ~90%
    d.mark('k10', 500);
    expect(d.size).toBeLessThanOrEqual(10);
    expect(d.isDuplicate('k10', 500)).toBe(true);
    expect(d.isDuplicate('k0', 500)).toBe(false);
    // khoá hết hạn bị dọn trước
    for (let i = 0; i < 20; i++) d.mark(`n${i}`, 5000);
    expect(d.size).toBeLessThanOrEqual(10);
  });
});

describe('PostsService.registerView', () => {
  /** Dựng service chỉ với prisma giả (các phụ thuộc khác không dùng trong registerView) */
  const make = (count: number) => {
    const updateMany = vi.fn().mockResolvedValue({ count });
    const svc = new PostsService({ post: { updateMany } } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { svc, updateMany };
  };

  it('tính lượt xem bài đã xuất bản, cùng IP + bài lần 2 không chạm DB', async () => {
    const { svc, updateMany } = make(1);
    await expect(svc.registerView('p1', '1.1.1.1')).resolves.toEqual({ counted: true });
    await expect(svc.registerView('p1', '1.1.1.1')).resolves.toEqual({ counted: false });
    await expect(svc.registerView('p1', '2.2.2.2')).resolves.toEqual({ counted: true });
    expect(updateMany).toHaveBeenCalledTimes(2);
    const where = updateMany.mock.calls[0][0].where;
    // điều kiện chỉ bài công khai: chưa xoá + PUBLISHED/hẹn giờ đã tới
    expect(where).toMatchObject({ id: 'p1', deletedAt: null });
    expect(JSON.stringify(where)).toContain('PUBLISHED');
    expect(updateMany.mock.calls[0][0].data).toEqual({ viewCount: { increment: 1 } });
  });

  it('bài không tồn tại / chưa xuất bản -> 404 và không ghi nhận chống trùng', async () => {
    const { svc, updateMany } = make(0);
    await expect(svc.registerView('draft', '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.registerView('draft', '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
