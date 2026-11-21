import type { Prisma } from '../../generated/prisma/client.js';

/** Dòng cần cộng lại kho (sản phẩm / phân loại + số lượng) */
export interface StockLine {
  productId: string | null;
  variantId: string | null;
  quantity: number;
}

/**
 * Cộng lại tồn kho cho một dòng (không đụng OrderItem.restockedQty): giảm soldCount, tăng stockQuantity khi sản phẩm
 * quản lý kho và bật lại IN_STOCK nếu đang OUT_OF_STOCK. Dùng khi admin sửa giảm số lượng / xoá dòng hàng,
 * và bên trong restockOrderItem().
 */
export async function giveStock(tx: Prisma.TransactionClient, line: StockLine) {
  if (!line.productId || line.quantity <= 0) return;
  const product = await tx.product.findUnique({ where: { id: line.productId } });
  if (!product) return;
  await tx.product.update({ where: { id: line.productId }, data: { soldCount: { decrement: line.quantity } } });
  if (!product.manageStock) return;
  if (line.variantId) {
    await tx.productVariant.updateMany({ where: { id: line.variantId, productId: line.productId }, data: { stockQuantity: { increment: line.quantity } } });
    await tx.productVariant.updateMany({ where: { id: line.variantId, stockStatus: 'OUT_OF_STOCK', stockQuantity: { gt: 0 } }, data: { stockStatus: 'IN_STOCK' } });
  } else {
    await tx.product.update({ where: { id: line.productId }, data: { stockQuantity: { increment: line.quantity } } });
    await tx.product.updateMany({ where: { id: line.productId, stockStatus: 'OUT_OF_STOCK', stockQuantity: { gt: 0 } }, data: { stockStatus: 'IN_STOCK' } });
  }
}

/**
 * Hoàn kho một dòng đơn hàng ĐÚNG MỘT LẦN theo OrderItem.restockedQty:
 * - khoá dòng order_items (FOR UPDATE) rồi đọc lại quantity / restockedQty mới nhất trong transaction;
 * - chỉ hoàn phần còn lại `quantity - restockedQty` (requested = undefined -> hoàn hết phần còn lại;
 *   có requested -> không vượt phần còn lại);
 * - tăng restockedQty bằng update có điều kiện (restockedQty chưa đổi) để hai request song song không cùng hoàn.
 * Trả về số lượng thực sự đã hoàn (0 nếu dòng đã hoàn đủ trước đó).
 */
export async function restockOrderItem(tx: Prisma.TransactionClient, item: { id: string; productId: string | null; variantId: string | null }, requested?: number): Promise<number> {
  const rows = await tx.$queryRaw<{ quantity: number; restockedQty: number }[]>`SELECT quantity, "restockedQty" FROM order_items WHERE id = ${item.id}::uuid FOR UPDATE`;
  if (!rows.length) return 0;
  const quantity = Number(rows[0].quantity);
  const done = Number(rows[0].restockedQty);
  const remaining = Math.max(0, quantity - done);
  const n = Math.min(remaining, requested == null ? remaining : Math.max(0, Math.floor(requested)));
  if (n <= 0) return 0;
  // điều kiện restockedQty = giá trị vừa đọc: nếu request khác đã kịp hoàn chen giữa thì không ghi đè
  const claimed = await tx.orderItem.updateMany({ where: { id: item.id, restockedQty: done }, data: { restockedQty: done + n } });
  if (!claimed.count) return 0;
  await giveStock(tx, { productId: item.productId, variantId: item.variantId, quantity: n });
  return n;
}
