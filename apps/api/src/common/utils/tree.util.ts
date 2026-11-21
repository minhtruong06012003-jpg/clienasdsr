import { BadRequestException } from '@nestjs/common';

interface TreeNode {
  id: string;
  parentId: string | null;
}

/** Ném lỗi nếu cây (sau khi áp thay đổi) có vòng cha–con, vd A→B→A */
export function assertNoCycle(nodes: TreeNode[], changes: TreeNode[] = []) {
  const parent = new Map(nodes.map((n) => [n.id, n.parentId]));
  for (const c of changes) parent.set(c.id, c.parentId);
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    let cur: string | null | undefined = start;
    while (cur) {
      if (seen.has(cur)) throw new BadRequestException('Cấu trúc cha–con không hợp lệ (bị lặp vòng)');
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
}

/** Danh sách id gồm gốc và toàn bộ con cháu (an toàn với dữ liệu lặp vòng) */
export function descendantIds(nodes: TreeNode[], rootId: string): string[] {
  const ids = [rootId];
  const seen = new Set(ids);
  for (let i = 0; i < ids.length; i++) {
    for (const n of nodes) {
      if (n.parentId === ids[i] && !seen.has(n.id)) {
        seen.add(n.id);
        ids.push(n.id);
      }
    }
  }
  return ids;
}
