import { arrayMove } from '@dnd-kit/sortable';
import type { MenuItemNode } from '@cmsnt/shared';

/** Số cấp tối đa của menu (0, 1, 2 = 3 cấp) */
export const MAX_DEPTH = 2;
export const INDENT = 28;

export interface FlatItem {
  id: string;
  parentId: string | null;
  depth: number;
  node: MenuItemNode;
}

export function flatten(items: MenuItemNode[], parentId: string | null = null, depth = 0): FlatItem[] {
  return items.flatMap((node) => [{ id: node.id, parentId, depth, node }, ...flatten(node.children ?? [], node.id, depth + 1)]);
}

/** Dựng lại cây từ danh sách phẳng (giữ thứ tự, gắn con theo parentId) */
export function buildTree(flat: FlatItem[]): MenuItemNode[] {
  const root: MenuItemNode[] = [];
  const map = new Map<string, MenuItemNode>();
  for (const f of flat) map.set(f.id, { ...f.node, children: [] });
  for (const f of flat) {
    const node = map.get(f.id)!;
    const parent = f.parentId ? map.get(f.parentId) : null;
    (parent ? parent.children : root).push(node);
  }
  return root;
}

/** Bỏ các mục con của những id đang thu gọn / đang kéo */
export function removeChildrenOf(items: FlatItem[], ids: string[]) {
  const exclude = new Set(ids);
  return items.filter((item) => {
    if (item.parentId && exclude.has(item.parentId)) {
      exclude.add(item.id);
      return false;
    }
    return true;
  });
}

/** Độ sâu của cây con (0 = không có con) */
export function subtreeHeight(node: MenuItemNode): number {
  return node.children?.length ? 1 + Math.max(...node.children.map(subtreeHeight)) : 0;
}

export function countDescendants(node: MenuItemNode): number {
  return (node.children ?? []).reduce((s, c) => s + 1 + countDescendants(c), 0);
}

/** Tính vị trí cấp mới khi kéo (theo ví dụ SortableTree của dnd-kit) + giới hạn 3 cấp */
export function getProjection(items: FlatItem[], activeId: string, overId: string, dragOffset: number) {
  const overIndex = items.findIndex((i) => i.id === overId);
  const activeIndex = items.findIndex((i) => i.id === activeId);
  const active = items[activeIndex];
  const moved = arrayMove(items, activeIndex, overIndex);
  const prev = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  const projected = active.depth + Math.round(dragOffset / INDENT);
  const limit = MAX_DEPTH - subtreeHeight(active.node);
  const maxDepth = Math.min(prev ? prev.depth + 1 : 0, Math.max(limit, 0));
  const minDepth = Math.min(next ? next.depth : 0, maxDepth);
  const depth = Math.max(minDepth, Math.min(projected, maxDepth));

  const parentId = (() => {
    if (depth === 0 || !prev) return null;
    if (depth === prev.depth) return prev.parentId;
    if (depth > prev.depth) return prev.id;
    return (
      moved
        .slice(0, overIndex)
        .reverse()
        .find((i) => i.depth === depth)?.parentId ?? null
    );
  })();
  return { depth, parentId };
}

/** Cập nhật một nút trong cây */
export function updateNode(items: MenuItemNode[], id: string, patch: Partial<MenuItemNode>): MenuItemNode[] {
  return items.map((n) => (n.id === id ? { ...n, ...patch } : { ...n, children: updateNode(n.children ?? [], id, patch) }));
}

export function removeNode(items: MenuItemNode[], id: string): MenuItemNode[] {
  return items.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeNode(n.children ?? [], id) }));
}

/** Thụt vào: trở thành con cuối của mục anh em phía trên */
export function indentNode(items: MenuItemNode[], id: string): MenuItemNode[] | null {
  const flat = flatten(items);
  const idx = flat.findIndex((f) => f.id === id);
  const item = flat[idx];
  if (!item) return null;
  const siblings = flat.filter((f) => f.parentId === item.parentId);
  const pos = siblings.findIndex((s) => s.id === id);
  if (pos <= 0) return null;
  if (item.depth + 1 + subtreeHeight(item.node) > MAX_DEPTH) return null;
  const newParent = siblings[pos - 1];
  // di chuyển cả cây con xuống sau con cuối của newParent: thứ tự phẳng không đổi, chỉ đổi parentId
  const next = flat.map((f) => (f.id === id ? { ...f, parentId: newParent.id } : f));
  return buildTree(next);
}

/** Thụt ra: thành anh em ngay sau mục cha */
export function outdentNode(items: MenuItemNode[], id: string): MenuItemNode[] | null {
  const flat = flatten(items);
  const item = flat.find((f) => f.id === id);
  if (!item || !item.parentId) return null;
  const parent = flat.find((f) => f.id === item.parentId)!;
  // tách item + cây con ra rồi chèn sau toàn bộ cây con của parent
  const block: FlatItem[] = [];
  const rest: FlatItem[] = [];
  const ids = new Set([id]);
  for (const f of flat) {
    if (f.id === id || (f.parentId && ids.has(f.parentId) && f.id !== parent.id)) {
      ids.add(f.id);
      block.push(f.id === id ? { ...f, parentId: parent.parentId } : f);
    } else rest.push(f);
  }
  const parentIdx = rest.findIndex((f) => f.id === parent.id);
  let end = parentIdx + 1;
  const parentDesc = new Set([parent.id]);
  while (end < rest.length && rest[end].parentId && parentDesc.has(rest[end].parentId!)) {
    parentDesc.add(rest[end].id);
    end++;
  }
  return buildTree([...rest.slice(0, end), ...block, ...rest.slice(end)]);
}

/** Đổi chỗ với anh em trên / dưới */
export function moveSibling(items: MenuItemNode[], id: string, dir: -1 | 1): MenuItemNode[] | null {
  const idx = items.findIndex((n) => n.id === id);
  if (idx >= 0) {
    const to = idx + dir;
    if (to < 0 || to >= items.length) return null;
    return arrayMove(items, idx, to);
  }
  let changed: MenuItemNode[] | null = null;
  const out = items.map((n) => {
    if (changed) return n;
    const res = moveSibling(n.children ?? [], id, dir);
    if (res) {
      changed = res;
      return { ...n, children: res };
    }
    return n;
  });
  return changed ? out : null;
}
