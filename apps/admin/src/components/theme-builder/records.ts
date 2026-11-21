/**
 * Nguồn bản ghi theo "target" của Theme Builder — dùng cho ô chọn bản ghi (điều kiện áp dụng,
 * dữ liệu xem trước). Target: page | post | product | post_category | post_tag | product_category
 * | entry:<typeKey> | term:<taxonomyKey> | "*".
 */
import { api, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';

export interface RecordOption {
  id: string;
  label: string;
  /** ghi chú nhỏ: trạng thái nháp, mã loại... */
  note?: string;
}

type Tr = { locale: string; title?: string; name?: string };
type Row = { id: string; status?: string; translations: Tr[] };
type TermRow = { id: string; parentId?: string | null; translations: Tr[] };

const STATUS_NOTE: Record<string, string> = { DRAFT: 'nháp', ARCHIVED: 'lưu trữ', SCHEDULED: 'hẹn giờ', draft: 'nháp', scheduled: 'hẹn giờ', trash: 'thùng rác' };

const nameOf = (trs: Tr[] | undefined, locale: string) => {
  const t = pickTr(trs ?? [], locale) ?? trs?.[0];
  return t?.title ?? t?.name ?? '(không tên)';
};

const toOption = (r: Row | TermRow, locale: string): RecordOption => ({ id: r.id, label: nameOf(r.translations, locale), note: 'status' in r && r.status ? STATUS_NOTE[r.status] : undefined });

/** Lọc danh sách đã tải về phía client (danh mục / term trả cả danh sách) */
const filterLocal = (rows: RecordOption[], search: string) => {
  const q = search.trim().toLowerCase();
  return q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
};

/** Target có danh sách bản ghi để chọn không ("*" và header/footer chung thì không) */
export function targetHasRecords(target: string | undefined | null) {
  return !!target && target !== '*';
}

/** Tìm bản ghi của target */
export async function searchRecords(target: string, search: string, locale: string): Promise<RecordOption[]> {
  if (target === 'page' || target === 'post' || target === 'product') {
    const r = await api.get<Paginated<Row>>(`/admin/${target}s`, { search, limit: 20 });
    return r.data.map((x) => toOption(x, locale));
  }
  if (target === 'post_category') return filterLocal((await api.get<TermRow[]>('/admin/posts/categories')).map((x) => toOption(x, locale)), search);
  if (target === 'product_category') return filterLocal((await api.get<TermRow[]>('/admin/products/categories')).map((x) => toOption(x, locale)), search);
  if (target === 'post_tag') {
    const r = await api.get<Paginated<TermRow> | TermRow[]>('/admin/posts/tags', { search, limit: 50 });
    return (Array.isArray(r) ? r : r.data).map((x) => toOption(x, locale));
  }
  if (target.startsWith('entry:')) {
    const rows = await api.get<{ id: string; title: string; type: string; status: string }[]>('/admin/entries/lookup', { type: target.slice(6), search });
    return rows.map((x) => ({ id: x.id, label: x.title || '(không tên)', note: STATUS_NOTE[x.status] }));
  }
  if (target.startsWith('term:')) return searchTerms(target.slice(5), search, locale);
  return [];
}

/** Term của một taxonomy tuỳ biến */
export async function searchTerms(taxonomy: string, search: string, locale: string): Promise<RecordOption[]> {
  const rows = await api.get<TermRow[]>(`/admin/taxonomies/${encodeURIComponent(taxonomy)}/terms`, { locale });
  return filterLocal(rows.map((x) => toOption(x, locale)), search);
}

/** Lấy nhãn cho các id đã chọn (hiển thị lại khi mở mẫu đã lưu) */
export async function labelRecords(target: string, ids: string[], locale: string): Promise<RecordOption[]> {
  if (!ids.length) return [];
  if (target.startsWith('entry:')) {
    const rows = await api.get<{ id: string; title: string; status: string }[]>('/admin/entries/lookup', { type: target.slice(6), ids: ids.join(',') });
    return rows.map((x) => ({ id: x.id, label: x.title || '(không tên)', note: STATUS_NOTE[x.status] }));
  }
  if (target === 'page' || target === 'post' || target === 'product') {
    const rows = await Promise.all(ids.slice(0, 30).map((id) => api.get<Row>(`/admin/${target}s/${id}`).catch(() => null)));
    return rows.filter((r): r is Row => !!r).map((x) => toOption(x, locale));
  }
  // danh mục / term: tải cả danh sách rồi lọc theo id
  const all = await searchRecords(target, '', locale).catch(() => [] as RecordOption[]);
  return all.filter((r) => ids.includes(r.id));
}
