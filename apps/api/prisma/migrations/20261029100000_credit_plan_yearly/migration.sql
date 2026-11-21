-- AlterTable
ALTER TABLE "credit_plans" ADD COLUMN     "yearlyPrice" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "credit_purchases" ADD COLUMN     "cycle" TEXT NOT NULL DEFAULT 'month',
ADD COLUMN     "nextRefillAt" TIMESTAMP(3),
ADD COLUMN     "refillsLeft" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "credit_purchases_refillsLeft_nextRefillAt_idx" ON "credit_purchases"("refillsLeft", "nextRefillAt");

