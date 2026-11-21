import { describe, expect, it } from 'vitest';
import { titleOrderedEntryIds } from './content.presenter.js';

/** prisma giả: trả sẵn danh sách entry kèm bản dịch */
const fakePrisma = (rows: { id: string; translations: { locale: string; title: string }[] }[]) => ({
  entry: { findMany: async () => rows },
});

describe('titleOrderedEntryIds', () => {
  const rows = [
    { id: 'a', translations: [{ locale: 'vi', title: 'Căn hộ Bình Thạnh' }] }, // chỉ có tiếng Việt
    { id: 'b', translations: [{ locale: 'vi', title: 'Nhà phố' }, { locale: 'en', title: 'Townhouse' }] },
    { id: 'c', translations: [{ locale: 'en', title: 'Apartment' }, { locale: 'vi', title: 'Chung cư' }] },
  ];

  it('dùng tiêu đề bản dịch hiện tại, thiếu thì rơi về ngôn ngữ mặc định (không bỏ sót bài)', async () => {
    const ids = await titleOrderedEntryIds(fakePrisma(rows), {}, 'en', 'vi', 0, 10);
    expect(ids).toEqual(['c', 'a', 'b']); // Apartment, Căn hộ..., Townhouse
  });

  it('phân trang sau khi sắp', async () => {
    expect(await titleOrderedEntryIds(fakePrisma(rows), {}, 'vi', 'vi', 1, 1)).toEqual(['c']); // Căn hộ, Chung cư, Nhà phố
  });
});
