import type { ContentTypeOrder, ContentTypeSupport, FieldGroupDef, TypeLabels } from '@cmsnt/shared';
import { CONTENT_TYPE_PRESETS, type ContentTypePresetTaxonomy } from '../modules/content/content.presets.js';

/**
 * KHAI BÁO LOẠI NỘI DUNG CỦA WEBSITE (Custom Post Type + taxonomy) — nguồn sự thật nằm trong code.
 *
 * Mỗi lần API khởi động, ContentTypesSyncService đồng bộ danh sách dưới đây vào DB (source = "code"):
 * - Loại / taxonomy chưa có → tạo mới (kèm term mẫu và nhóm trường tuỳ chỉnh nếu khai báo).
 * - Đã có (trùng key) → cập nhật theo code; bản ghi cũ tạo từ admin / mẫu có sẵn được "nhận về" code.
 * - Xoá một loại khỏi file này → loại đó bị TẮT (isActive = false), bài viết vẫn giữ nguyên trong DB.
 * Loại khai báo ở đây chỉ xem được trong admin, không sửa / xoá được ở giao diện — muốn đổi thì sửa file này.
 *
 * Cách dùng nhanh: dùng lại mẫu có sẵn bằng `fromPreset('project')` (xem modules/content/content.presets.ts:
 * project, service, job, course, real_estate, event, team, testimonial, faq, portfolio, document), hoặc tự viết
 * object theo kiểu CodeContentType. Sau khi sửa: khởi động lại API.
 */

/** Một taxonomy gắn với loại nội dung (term mẫu chỉ tạo khi taxonomy được tạo lần đầu) */
export type CodeTaxonomy = ContentTypePresetTaxonomy;

/** Một loại nội dung khai báo trong code */
export interface CodeContentType {
  /** mã máy a-z0-9_ (2–40 ký tự), KHÔNG đổi sau khi đã có dữ liệu: "project" */
  key: string;
  /** tên icon lucide (kebab-case) cho menu admin */
  icon: string;
  type: {
    /** nhãn theo locale: { vi: { singular, plural }, en: {...} } */
    labels: TypeLabels;
    /** đường dẫn gốc theo locale: { vi: 'du-an', en: 'projects' } */
    slugs: Record<string, string>;
    description?: string;
    supports: ContentTypeSupport[];
    isPublic: boolean;
    hasArchive: boolean;
    searchable: boolean;
    perPage: number;
    orderBy: ContentTypeOrder;
    /** key trường tuỳ chỉnh hiện thêm làm cột trong danh sách admin */
    listColumns: string[];
  };
  taxonomies?: CodeTaxonomy[];
  /** nhóm trường tuỳ chỉnh (entity "entry"): chỉ tạo khi chưa có, sửa sau đó trong Trường tuỳ chỉnh */
  fieldGroups?: FieldGroupDef[];
}

/** Lấy một mẫu có sẵn làm khai báo (có thể ghi đè bằng `{ ...fromPreset('project'), icon: 'building' }`) */
export function fromPreset(key: string): CodeContentType {
  const p = CONTENT_TYPE_PRESETS.find((x) => x.key === key);
  if (!p) throw new Error(`content-types.config: không có mẫu "${key}"`);
  return structuredClone({ key: p.key, icon: p.icon, type: p.type, taxonomies: p.taxonomies, fieldGroups: p.fieldGroups });
}

/** Danh sách loại nội dung của website này (thứ tự trong mảng = thứ tự trên menu admin) */
export const CONTENT_TYPES: CodeContentType[] = [
  // fromPreset('project'),
  // fromPreset('service'),
  // {
  //   key: 'recruitment',
  //   icon: 'briefcase',
  //   type: {
  //     labels: { vi: { singular: 'Tin tuyển dụng', plural: 'Tuyển dụng' }, en: { singular: 'Job', plural: 'Jobs' } },
  //     slugs: { vi: 'tuyen-dung', en: 'jobs' },
  //     supports: ['editor', 'excerpt', 'featuredImage', 'revisions'],
  //     isPublic: true, hasArchive: true, searchable: true, perPage: 12, orderBy: 'publishedAt_desc', listColumns: [],
  //   },
  // },
];
