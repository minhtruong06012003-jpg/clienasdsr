-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "needsRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "providerTxnId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_provider_providerTxnId_key" ON "payment_transactions"("provider", "providerTxnId");

