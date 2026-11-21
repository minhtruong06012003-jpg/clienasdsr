-- Nạp thẻ cào vào ví thành viên (modules/card-topup)
-- CreateEnum
CREATE TYPE "CardTopupStatus" AS ENUM ('PENDING', 'SUCCESS', 'WRONG_VALUE', 'FAILED');

-- CreateTable
CREATE TABLE "card_topups" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "telco" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "declaredValue" INTEGER NOT NULL,
    "realValue" INTEGER,
    "providerAmount" DECIMAL(15,2),
    "credited" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "CardTopupStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "providerRef" TEXT,
    "walletTxnId" UUID,
    "reviewedById" UUID,
    "ip" TEXT,
    "checkedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_topups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_topups_code_key" ON "card_topups"("code");

-- CreateIndex
CREATE INDEX "card_topups_userId_createdAt_idx" ON "card_topups"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "card_topups_status_createdAt_idx" ON "card_topups"("status", "createdAt");

-- CreateIndex
CREATE INDEX "card_topups_serial_pin_idx" ON "card_topups"("serial", "pin");

-- AddForeignKey
ALTER TABLE "card_topups" ADD CONSTRAINT "card_topups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_topups" ADD CONSTRAINT "card_topups_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

