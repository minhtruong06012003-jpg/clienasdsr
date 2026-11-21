-- CreateEnum
CREATE TYPE "CreditTxnType" AS ENUM ('PURCHASE', 'USAGE', 'REFUND', 'BONUS', 'ADJUST');

-- CreateEnum
CREATE TYPE "AiTaskStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AffiliateTxnType" AS ENUM ('COMMISSION', 'REVOKE', 'PAYOUT', 'PAYOUT_REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "AffiliatePayoutMethod" AS ENUM ('WALLET', 'BANK');

-- CreateEnum
CREATE TYPE "AffiliatePayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "affiliateBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customDiscount" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planId" UUID,
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referredById" UUID,
ADD COLUMN     "totalSpent" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "CreditTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "note" TEXT,
    "taskId" UUID,
    "purchaseId" UUID,
    "createdById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_plans" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "badge" TEXT,
    "highlight" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_purchases" (
    "id" UUID NOT NULL,
    "code" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID,
    "planName" TEXT NOT NULL,
    "listPrice" DECIMAL(15,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "paid" DECIMAL(15,2) NOT NULL,
    "credits" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "walletTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tools" (
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "badge" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "pricing" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_tools_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ai_tasks" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "toolKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "AiTaskStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "providerTaskId" TEXT,
    "providerData" JSONB,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "viaApi" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AffiliateTxnType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "balanceAfter" DECIMAL(15,2) NOT NULL,
    "fromUserId" UUID,
    "sourceTxnId" UUID,
    "payoutId" UUID,
    "note" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_payouts" (
    "id" UUID NOT NULL,
    "code" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "AffiliatePayoutMethod" NOT NULL,
    "status" "AffiliatePayoutStatus" NOT NULL DEFAULT 'PENDING',
    "bankName" TEXT,
    "bankAccount" TEXT,
    "bankHolder" TEXT,
    "note" TEXT,
    "adminNote" TEXT,
    "processedById" UUID,
    "processedAt" TIMESTAMP(3),
    "walletTxnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_idempotencyKey_key" ON "credit_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_transactions_userId_createdAt_idx" ON "credit_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_transactions_type_createdAt_idx" ON "credit_transactions"("type", "createdAt");

-- CreateIndex
CREATE INDEX "credit_transactions_taskId_idx" ON "credit_transactions"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_plans_slug_key" ON "credit_plans"("slug");

-- CreateIndex
CREATE INDEX "credit_plans_active_sortOrder_idx" ON "credit_plans"("active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "credit_purchases_code_key" ON "credit_purchases"("code");

-- CreateIndex
CREATE INDEX "credit_purchases_userId_createdAt_idx" ON "credit_purchases"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_tools_enabled_category_sortOrder_idx" ON "ai_tools"("enabled", "category", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tasks_code_key" ON "ai_tasks"("code");

-- CreateIndex
CREATE INDEX "ai_tasks_userId_createdAt_idx" ON "ai_tasks"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_tasks_status_nextPollAt_idx" ON "ai_tasks"("status", "nextPollAt");

-- CreateIndex
CREATE INDEX "ai_tasks_toolKey_createdAt_idx" ON "ai_tasks"("toolKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_transactions_idempotencyKey_key" ON "affiliate_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "affiliate_transactions_userId_createdAt_idx" ON "affiliate_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "affiliate_transactions_fromUserId_idx" ON "affiliate_transactions"("fromUserId");

-- CreateIndex
CREATE INDEX "affiliate_transactions_type_createdAt_idx" ON "affiliate_transactions"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_payouts_code_key" ON "affiliate_payouts"("code");

-- CreateIndex
CREATE INDEX "affiliate_payouts_status_createdAt_idx" ON "affiliate_payouts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "affiliate_payouts_userId_createdAt_idx" ON "affiliate_payouts"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- CreateIndex
CREATE INDEX "users_referredById_idx" ON "users"("referredById");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_planId_fkey" FOREIGN KEY ("planId") REFERENCES "credit_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ai_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "credit_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_planId_fkey" FOREIGN KEY ("planId") REFERENCES "credit_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_toolKey_fkey" FOREIGN KEY ("toolKey") REFERENCES "ai_tools"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "affiliate_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

