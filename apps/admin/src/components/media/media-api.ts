import { api, ApiError } from '@/lib/api';
import type { Media } from '@/lib/types';

/** Media kèm trường thùng rác (API trả về, type chung chưa khai báo) */
export type MediaItem = Media & { deletedAt?: string | null };

export interface MediaFolder {
  id: string;
  name: string;
  parentId: string | null;
  _count: { media: number; children: number };
}

export interface MediaFolderNode extends MediaFolder {
  children: MediaFolderNode[];
  depth: number;
}

export type MediaUsageType = 'page' | 'post' | 'product' | 'product_variant' | 'post_category' | 'product_category' | 'brand' | 'global_block' | 'setting' | 'user' | 'menu';

export interface MediaUsage {
  type: MediaUsageType;
  id: string;
  title: string;
  href: string;
}

export const USAGE_LABEL: Record<MediaUsageType, string> = {
  page: 'Trang',
  post: 'Bài viết',
  product: 'Sản phẩm',
  product_variant: 'Biến thể sản phẩm',
  post_category: 'Chuyên mục',
  product_category: 'Danh mục sản phẩm',
  brand: 'Thương hiệu',
  global_block: 'Global block',
  setting: 'Cài đặt',
  user: 'Người dùng',
  menu: 'Menu',
};

export const SORT_OPTIONS = [
  { value: 'newest', label: 'Mới nhất', sort: 'createdAt', order: 'desc' },
  { value: 'oldest', label: 'Cũ nhất', sort: 'createdAt', order: 'asc' },
  { value: 'name', label: 'Tên A → Z', sort: 'originalName', order: 'asc' },
  { value: 'name_desc', label: 'Tên Z → A', sort: 'originalName', order: 'desc' },
  { value: 'size', label: 'Dung lượng lớn nhất', sort: 'size', order: 'desc' },
  { value: 'size_asc', label: 'Dung lượng nhỏ nhất', sort: 'size', order: 'asc' },
] as const;
export type SortValue = (typeof SORT_OPTIONS)[number]['value'];

/** Dựng cây thư mục từ danh sách phẳng (sắp theo tên) */
export function buildFolderTree(flat: MediaFolder[]): MediaFolderNode[] {
  const byParent = new Map<string | null, MediaFolder[]>();
  for (const f of flat) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f]);
  const build = (parentId: string | null, depth: number, seen: Set<string>): MediaFolderNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((f) => !seen.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
      .map((f) => {
        const next = new Set(seen).add(f.id);
        return { ...f, depth, children: build(f.id, depth + 1, next) };
      });
  return build(null, 0, new Set());
}

/** Cây thư mục duỗi phẳng theo thứ tự hiển thị (kèm depth) — dùng cho Select "Chuyển tới" */
export function flattenFolders(flat: MediaFolder[] | undefined): MediaFolderNode[] {
  const out: MediaFolderNode[] = [];
  const walk = (nodes: MediaFolderNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(flat ? buildFolderTree(flat) : []);
  return out;
}

/** Đường dẫn thư mục dạng "Cha / Con" */
export function folderPath(flat: MediaFolder[] | undefined, id: string | null | undefined): string {
  if (!id || !flat) return '';
  const map = new Map(flat.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = map.get(id);
  let guard = 0;
  while (cur && guard++ < 50) {
    parts.unshift(cur.name);
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/** Lỗi 409 khi file đang được dùng: API kèm danh sách usage theo id */
export class MediaInUseError extends Error {
  constructor(public usage: Record<string, MediaUsage[]>) {
    super('File đang được sử dụng');
  }
}

export function isMediaInUse(err: unknown): err is ApiError & { data: { usage: Record<string, MediaUsage[]> } } {
  return err instanceof ApiError && err.status === 409 && !!(err.data as { usage?: unknown })?.usage;
}

/** Chuyển vào thùng rác; ném MediaInUseError nếu API trả 409 (chưa force) */
export async function trashMedia(ids: string[], force = false) {
  try {
    return await api.post<{ deleted: number }>('/admin/media/delete', { ids, force });
  } catch (err) {
    if (isMediaInUse(err)) throw new MediaInUseError(err.data.usage);
    throw err;
  }
}

export const restoreMedia = (ids: string[]) => api.post<{ restored: number }>('/admin/media/restore', { ids });
export const destroyMedia = (ids: string[]) => api.post<{ destroyed: number }>('/admin/media/destroy', { ids });
export const emptyTrash = () => api.post<{ destroyed: number }>('/admin/media/empty-trash');
export const moveMedia = (ids: string[], folderId: string | null) => api.post('/admin/media/move', { ids, folderId });

/** Tải file về máy (fetch blob để đặt tên file; nếu bị chặn CORS thì mở tab mới) */
export async function downloadMedia(m: Pick<Media, 'url' | 'originalName'>) {
  try {
    const res = await fetch(m.url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = m.originalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    window.open(m.url, '_blank', 'noopener');
  }
}

/** Kiểu dữ liệu kéo thả file media vào thư mục */
export const DND_MEDIA_TYPE = 'application/x-cmsnt-media-ids';

export function isRasterImage(m: { mimeType: string }) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'].includes(m.mimeType);
}

export function fileKind(m: { mimeType: string }): string {
  if (m.mimeType.startsWith('image/')) return 'Ảnh';
  if (m.mimeType.startsWith('video/')) return 'Video';
  if (m.mimeType.startsWith('audio/')) return 'Âm thanh';
  if (m.mimeType === 'application/pdf') return 'PDF';
  if (m.mimeType.includes('spreadsheet') || m.mimeType.includes('excel') || m.mimeType === 'text/csv') return 'Bảng tính';
  if (m.mimeType.includes('word')) return 'Văn bản';
  if (m.mimeType === 'application/zip') return 'Nén';
  return 'Tài liệu';
}
