import { pickTemplate, rankTemplates, readConditions, scoreTemplate, type MatchableTemplate } from './template-match.js';

/** Tạo mẫu test với giá trị mặc định */
const tpl = (p: Partial<MatchableTemplate> & { id: string }): MatchableTemplate => ({
  kind: 'single',
  target: '*',
  conditions: {},
  priority: 0,
  isActive: true,
  updatedAt: '2026-01-01T00:00:00Z',
  ...p,
});

describe('readConditions', () => {
  it('bỏ giá trị sai khuôn và mảng rỗng', () => {
    expect(readConditions(null)).toEqual({});
    expect(readConditions({ ids: ['a', 1, ''], termIds: [], excludeIds: 'x' })).toEqual({ ids: ['a'] });
  });
});

describe('scoreTemplate', () => {
  const subject = { kind: 'single', target: 'entry:project', id: 'e1', termIds: ['t1', 't2'] };

  it('khác kind hoặc đang tắt → không khớp', () => {
    expect(scoreTemplate(tpl({ id: 'a', kind: 'archive' }), subject)).toBeNull();
    expect(scoreTemplate(tpl({ id: 'a', isActive: false }), subject)).toBeNull();
  });

  it('target khác (không phải *) → không khớp', () => {
    expect(scoreTemplate(tpl({ id: 'a', target: 'post' }), subject)).toBeNull();
  });

  it('excludeIds loại bản ghi', () => {
    expect(scoreTemplate(tpl({ id: 'a', target: 'entry:project', conditions: { excludeIds: ['e1'] } }), subject)).toBeNull();
  });

  it('ids không chứa bản ghi → không khớp', () => {
    expect(scoreTemplate(tpl({ id: 'a', conditions: { ids: ['e2'] } }), subject)).toBeNull();
  });

  it('termIds không giao → không khớp', () => {
    expect(scoreTemplate(tpl({ id: 'a', conditions: { termIds: ['t9'] } }), subject)).toBeNull();
  });

  it('thứ tự điểm: ids > termIds > target chính xác > *', () => {
    const byIds = scoreTemplate(tpl({ id: 'a', conditions: { ids: ['e1'] } }), subject)!;
    const byTerms = scoreTemplate(tpl({ id: 'b', target: 'entry:project', conditions: { termIds: ['t2'] } }), subject)!;
    const exact = scoreTemplate(tpl({ id: 'c', target: 'entry:project' }), subject)!;
    const wildcard = scoreTemplate(tpl({ id: 'd' }), subject)!;
    expect(byIds).toBeGreaterThan(byTerms);
    expect(byTerms).toBeGreaterThan(exact);
    expect(exact).toBeGreaterThan(wildcard);
  });

  it('không có target ở subject → chỉ mẫu * khớp', () => {
    expect(scoreTemplate(tpl({ id: 'a', kind: 'header' }), { kind: 'header' })).not.toBeNull();
    expect(scoreTemplate(tpl({ id: 'b', kind: 'header', target: 'post' }), { kind: 'header' })).toBeNull();
  });
});

describe('pickTemplate', () => {
  const subject = { kind: 'single', target: 'post', id: 'p1', termIds: ['c1'] };

  it('target chính xác thắng * dù priority thấp hơn', () => {
    const picked = pickTemplate([tpl({ id: 'all', priority: 99 }), tpl({ id: 'post', target: 'post' })], subject);
    expect(picked?.id).toBe('post');
  });

  it('mẫu theo id thắng mẫu theo chuyên mục', () => {
    const picked = pickTemplate(
      [tpl({ id: 'cat', target: 'post', conditions: { termIds: ['c1'] }, priority: 10 }), tpl({ id: 'one', target: 'post', conditions: { ids: ['p1'] } })],
      subject,
    );
    expect(picked?.id).toBe('one');
  });

  it('hoà điểm: priority cao hơn rồi updatedAt mới hơn', () => {
    const a = tpl({ id: 'a', target: 'post', priority: 1, updatedAt: '2026-01-01T00:00:00Z' });
    const b = tpl({ id: 'b', target: 'post', priority: 5, updatedAt: '2025-01-01T00:00:00Z' });
    const c = tpl({ id: 'c', target: 'post', priority: 5, updatedAt: '2026-06-01T00:00:00Z' });
    expect(rankTemplates([a, b, c], subject).map((x) => x.template.id)).toEqual(['c', 'b', 'a']);
  });

  it('không mẫu nào khớp → null', () => {
    expect(pickTemplate([tpl({ id: 'x', target: 'product' })], subject)).toBeNull();
  });
});
