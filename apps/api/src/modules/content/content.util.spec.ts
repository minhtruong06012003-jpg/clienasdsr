import { buildAlternates, normalizeSlugs, resolvePublicPath, slugConflicts, type SlugOwner } from './content.util.js';

const LOCALES = ['vi', 'en'];

describe('normalizeSlugs', () => {
  it('slugify từng locale, thiếu locale thì lấy slug ngôn ngữ mặc định', () => {
    expect(normalizeSlugs({ vi: 'Dự Án', en: '' }, LOCALES, 'vi', 'project')).toEqual({ vi: 'du-an', en: 'du-an' });
    expect(normalizeSlugs({ en: 'Projects' }, LOCALES, 'vi', 'project')).toEqual({ vi: 'projects', en: 'projects' });
  });
  it('không có slug nào -> sinh từ nguồn dự phòng (key)', () => {
    expect(normalizeSlugs(undefined, LOCALES, 'vi', 'real_estate')).toEqual({ vi: 'real-estate', en: 'real-estate' });
  });
  it('bỏ locale chưa bật', () => {
    expect(normalizeSlugs({ vi: 'du-an', fr: 'projets' }, LOCALES, 'vi', 'x')).toEqual({ vi: 'du-an', en: 'du-an' });
  });
});

describe('slugConflicts', () => {
  const owners: SlugOwner[] = [
    { kind: 'content_type', id: 'project', slugs: { vi: 'du-an', en: 'projects' } },
    { kind: 'taxonomy', id: 'field', slugs: { vi: 'linh-vuc', en: 'fields' } },
    { kind: 'page', id: 'p1', slugs: { vi: 'gioi-thieu' } },
  ];

  it('chặn slug hệ thống và dạng mã ngôn ngữ', () => {
    expect(slugConflicts({ vi: 'blog' }, { kind: 'content_type' }, owners, LOCALES)).toHaveLength(1);
    expect(slugConflicts({ vi: 'en' }, { kind: 'content_type' }, owners, LOCALES)).toHaveLength(1);
    expect(slugConflicts({ vi: 'products' }, { kind: 'taxonomy' }, owners, LOCALES)[0]).toContain('hệ thống');
  });

  it('chặn trùng slug loại / taxonomy / trang khác trong cùng locale', () => {
    expect(slugConflicts({ vi: 'du-an' }, { kind: 'content_type', id: 'service' }, owners, LOCALES)).toHaveLength(1);
    expect(slugConflicts({ vi: 'linh-vuc' }, { kind: 'content_type' }, owners, LOCALES)[0]).toContain('phân loại');
    expect(slugConflicts({ vi: 'gioi-thieu' }, { kind: 'taxonomy' }, owners, LOCALES)[0]).toContain('trang');
  });

  it('cho phép trùng ở locale khác và cho phép chính nó', () => {
    // "projects" là slug en của project, dùng làm slug vi của loại khác vẫn hợp lệ
    expect(slugConflicts({ vi: 'projects' }, { kind: 'content_type', id: 'service' }, owners, LOCALES)).toEqual([]);
    expect(slugConflicts({ vi: 'du-an', en: 'projects' }, { kind: 'content_type', id: 'project' }, owners, LOCALES)).toEqual([]);
  });
});

describe('resolvePublicPath', () => {
  const types = [
    { key: 'project', slugs: { vi: 'du-an', en: 'projects' }, isPublic: true, hasArchive: true },
    { key: 'team', slugs: { vi: 'doi-ngu', en: 'team' }, isPublic: true, hasArchive: false },
    { key: 'faq', slugs: { vi: 'hoi-dap', en: 'faq' }, isPublic: false, hasArchive: false },
  ];
  const taxes = [{ key: 'field', slugs: { vi: 'linh-vuc', en: 'fields' }, isPublic: true }];

  it('1 đoạn: lưu trữ nếu loại có archive, còn lại là trang', () => {
    expect(resolvePublicPath('du-an', 'vi', 'vi', types, taxes)).toEqual({ kind: 'archive', typeKey: 'project' });
    expect(resolvePublicPath('/projects/', 'en', 'vi', types, taxes)).toEqual({ kind: 'archive', typeKey: 'project' });
    expect(resolvePublicPath('doi-ngu', 'vi', 'vi', types, taxes)).toEqual({ kind: 'page', slug: 'doi-ngu' });
    expect(resolvePublicPath('gioi-thieu', 'vi', 'vi', types, taxes)).toEqual({ kind: 'page', slug: 'gioi-thieu' });
  });

  it('2 đoạn: bài của loại public, term của taxonomy public', () => {
    expect(resolvePublicPath('du-an/vinhomes', 'vi', 'vi', types, taxes)).toEqual({ kind: 'entry', typeKey: 'project', slug: 'vinhomes' });
    expect(resolvePublicPath('doi-ngu/an', 'vi', 'vi', types, taxes)).toEqual({ kind: 'entry', typeKey: 'team', slug: 'an' });
    expect(resolvePublicPath('linh-vuc/bat-dong-san', 'vi', 'vi', types, taxes)).toEqual({ kind: 'term', taxonomyKey: 'field', slug: 'bat-dong-san' });
  });

  it('slug theo locale: slug en không khớp khi locale là vi; loại không public -> none', () => {
    expect(resolvePublicPath('projects/x', 'vi', 'vi', types, taxes)).toEqual({ kind: 'none' });
    expect(resolvePublicPath('hoi-dap/x', 'vi', 'vi', types, taxes)).toEqual({ kind: 'none' });
    expect(resolvePublicPath('a/b/c', 'vi', 'vi', types, taxes)).toEqual({ kind: 'none' });
    expect(resolvePublicPath('', 'vi', 'vi', types, taxes)).toEqual({ kind: 'none' });
  });
});

describe('buildAlternates', () => {
  it('chỉ locale đang bật, có tiền tố ngôn ngữ trừ mặc định', () => {
    const tr = [
      { locale: 'vi', slug: 'vinhomes' },
      { locale: 'en', slug: 'vinhomes-en' },
      { locale: 'fr', slug: 'x' },
    ];
    expect(buildAlternates(tr, { vi: 'du-an', en: 'projects' }, LOCALES, 'vi', 'project')).toEqual({ vi: '/du-an/vinhomes', en: '/en/projects/vinhomes-en' });
  });
  it('loại không public -> rỗng; thiếu slug locale -> lùi về slug mặc định', () => {
    expect(buildAlternates([{ locale: 'vi', slug: 'a' }], null, LOCALES, 'vi', 'faq')).toEqual({});
    expect(buildAlternates([{ locale: 'en', slug: 'a' }], { vi: 'du-an' }, LOCALES, 'vi', 'project')).toEqual({ en: '/en/du-an/a' });
  });
});
