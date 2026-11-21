-- Kho mã số (key / tài khoản / thẻ...), sản phẩm ảo, thông tin khách nhập khi mua, trạng thái giao mã của đơn

-- CreateEnum
CREATE TYPE "DigitalCodeStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'SOLD', 'DISABLED', 'REVOKED');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "codeStatus" TEXT,
ADD COLUMN     "codesDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "requiresShipping" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "product_translations" ADD COLUMN     "deliveryNote" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "codeDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "codeFields" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "codeWarrantyDays" INTEGER,
ADD COLUMN     "isVirtual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchaseFields" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "digital_codes" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "batch" TEXT,
    "note" TEXT,
    "costPrice" DECIMAL(15,2),
    "expiresAt" TIMESTAMP(3),
    "status" "DigitalCodeStatus" NOT NULL DEFAULT 'AVAILABLE',
    "source" TEXT NOT NULL DEFAULT 'import',
    "orderId" UUID,
    "orderItemId" UUID,
    "reservedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "reportStatus" TEXT,
    "reportNote" TEXT,
    "reportedAt" TIMESTAMP(3),
    "reportReply" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "replacesId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digital_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "digital_codes_productId_variantId_status_idx" ON "digital_codes"("productId", "variantId", "status");

-- CreateIndex
CREATE INDEX "digital_codes_orderId_idx" ON "digital_codes"("orderId");

-- CreateIndex
CREATE INDEX "digital_codes_orderItemId_idx" ON "digital_codes"("orderItemId");

-- CreateIndex
CREATE INDEX "digital_codes_reportStatus_idx" ON "digital_codes"("reportStatus");

-- CreateIndex
CREATE INDEX "digital_codes_batch_idx" ON "digital_codes"("batch");

-- CreateIndex
CREATE UNIQUE INDEX "digital_codes_productId_contentHash_key" ON "digital_codes"("productId", "contentHash");

-- CreateIndex
CREATE INDEX "orders_codeStatus_idx" ON "orders"("codeStatus");

-- AddForeignKey
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Đơn cũ chỉ gồm sản phẩm số (DIGITAL) -> không cần giao hàng
UPDATE "orders" o SET "requiresShipping" = false WHERE EXISTS (SELECT 1 FROM "order_items" i WHERE i."orderId" = o.id) AND NOT EXISTS (SELECT 1 FROM "order_items" i LEFT JOIN "products" p ON p.id = i."productId" WHERE i."orderId" = o.id AND (p.id IS NULL OR p.type <> 'DIGITAL'));
