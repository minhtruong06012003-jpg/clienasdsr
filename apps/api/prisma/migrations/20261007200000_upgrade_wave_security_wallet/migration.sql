-- Đợt nâng cấp 07/10/2026: hoàn kho theo dòng, nạp ví qua cổng, thông báo khách, đăng nhập Google,
-- chống dùng lại TOTP, chống bấm trùng khi admin cộng/trừ ví, chuẩn hoá nội dung chuyển khoản.
-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'admin';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "restockedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'order',
ADD COLUMN     "transferContentNorm" TEXT,
ADD COLUMN     "userId" UUID,
ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "googleId" TEXT,
ADD COLUMN     "totpLastStep" INTEGER;

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE INDEX "notifications_audience_userId_createdAt_idx" ON "notifications"("audience", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_transactions_userId_idx" ON "payment_transactions"("userId");

-- CreateIndex
CREATE INDEX "payment_transactions_provider_transferContentNorm_idx" ON "payment_transactions"("provider", "transferContentNorm");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key" ON "wallet_transactions"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Điền sẵn nội dung chuyển khoản đã chuẩn hoá cho giao dịch cũ
UPDATE "payment_transactions" SET "transferContentNorm" = upper(regexp_replace("transferContent", '[^A-Za-z0-9]', '', 'g'))
WHERE "transferContent" IS NOT NULL;
