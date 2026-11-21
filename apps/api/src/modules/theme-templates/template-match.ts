import type { TemplateConditions } from '@cmsnt/shared';

/**
 * Thuật toán chọn mẫu Theme Builder (hàm thuần, không đụng DB — để test unit).
 *
 * Thứ tự ưu tiên khi nhiều mẫu cùng khớp:
 *   1. conditions.ids chứa id bản ghi           → điểm cao nhất
 *   2. conditions.termIds giao với term của bản ghi → điểm vừa
 *   3. target khớp chính xác                      → điểm thấp
 *   4. target "*"                                 → thấp nhất
 *   Hoà điểm: priority cao hơn thắng, rồi updatedAt mới hơn.
 * excludeIds chứa id bản ghi → loại mẫu.
 */

export interface MatchableTemplate {
  id: string;
  kind: string;
  target: string;
  conditions: unknown;
  priority: number;
  isActive: boolean;
  updatedAt: Date | string;
}

/** Đối tượng đang hiển thị cần tìm mẫu */
export interface MatchSubject {
  kind: string;
  /** target của đối tượng, vd "post", "entry:project"; rỗng = không rõ (chỉ mẫu "*" khớp) */
  target?: string | null;
  /** id bản ghi đang xem (single / term) */
  id?: string | null;
  /** id các term / chuyên mục / danh mục mà bản ghi thuộc về */
  termIds?: string[] | null;
}

export const MATCH_SCORE = { ids: 300, termIds: 200, exact: 100, wildcard: 0 } as const;

/** Đọc conditions từ JSON (dữ liệu DB có thể sai khuôn) */
export function readConditions(raw: unknown): TemplateConditions {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
  const out: TemplateConditions = {};
  const ids = list(r.ids);
  const termIds = list(r.termIds);
  const excludeIds = list(r.excludeIds);
  if (ids.length) out.ids = ids;
  if (termIds.length) out.termIds = termIds;
  if (excludeIds.length) out.excludeIds = excludeIds;
  return out;
}

/**
 * Điểm của một mẫu với đối tượng; null = không khớp.
 * Điều kiện nào có khai báo thì bắt buộc phải thoả (ids và termIds cùng có → phải thoả cả hai).
 */
export function scoreTemplate(tpl: MatchableTemplate, subject: MatchSubject): number | null {
  if (!tpl.isActive || tpl.kind !== subject.kind) return null;
  const exact = !!subject.target && tpl.target === subject.target;
  if (!exact && tpl.target !== '*') return null;
  const c = readConditions(tpl.conditions);
  const id = subject.id ?? null;
  if (id && c.excludeIds?.includes(id)) return null;
  let score: number = exact ? MATCH_SCORE.exact : MATCH_SCORE.wildcard;
  if (c.ids) {
    if (!id || !c.ids.includes(id)) return null;
    score = Math.max(score, MATCH_SCORE.ids + (exact ? 1 : 0));
  }
  if (c.termIds) {
    const own = subject.termIds ?? [];
    if (!c.termIds.some((t) => own.includes(t))) return null;
    if (!c.ids) score = Math.max(score, MATCH_SCORE.termIds + (exact ? 1 : 0));
  }
  return score;
}

/** Danh sách mẫu khớp, đã sắp xếp (phần tử đầu là mẫu được chọn) */
export function rankTemplates<T extends MatchableTemplate>(templates: T[], subject: MatchSubject): { template: T; score: number }[] {
  const time = (v: Date | string) => new Date(v).getTime() || 0;
  return templates
    .map((template) => ({ template, score: scoreTemplate(template, subject) }))
    .filter((x): x is { template: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || b.template.priority - a.template.priority || time(b.template.updatedAt) - time(a.template.updatedAt));
}

/** Mẫu được chọn hoặc null */
export function pickTemplate<T extends MatchableTemplate>(templates: T[], subject: MatchSubject): T | null {
  return rankTemplates(templates, subject)[0]?.template ?? null;
}
