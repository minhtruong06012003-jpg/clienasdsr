-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('DRAFT', 'QUEUED', 'ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "EInvoiceKind" AS ENUM ('ORIGINAL', 'REPLACEMENT', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "invoiceRequest" JSONB;

-- CreateTable
CREATE TABLE "e_invoices" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "provider" TEXT NOT NULL,
    "kind" "EInvoiceKind" NOT NULL DEFAULT 'ORIGINAL',
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "templateCode" TEXT,
    "serial" TEXT,
    "invoiceNo" TEXT,
    "taxAuthorityCode" TEXT,
    "providerRef" TEXT,
    "lookupCode" TEXT,
    "lookupUrl" TEXT,
    "pdfPath" TEXT,
    "xmlPath" TEXT,
    "seller" JSONB NOT NULL DEFAULT '{}',
    "buyer" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "exchangeRate" DECIMAL(15,4) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "vatTotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "note" TEXT,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "reason" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "emailSentAt" TIMESTAMP(3),
    "originalId" UUID,
    "createdById" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e_invoice_logs" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "request" JSONB,
    "response" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e_invoice_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e_invoices_orderId_idx" ON "e_invoices"("orderId");

-- CreateIndex
CREATE INDEX "e_invoices_status_idx" ON "e_invoices"("status");

-- CreateIndex
CREATE INDEX "e_invoices_provider_invoiceNo_idx" ON "e_invoices"("provider", "invoiceNo");

-- CreateIndex
CREATE INDEX "e_invoices_createdAt_idx" ON "e_invoices"("createdAt");

-- CreateIndex
CREATE INDEX "e_invoice_logs_invoiceId_createdAt_idx" ON "e_invoice_logs"("invoiceId", "createdAt");

-- AddForeignKey
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "e_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_invoice_logs" ADD CONSTRAINT "e_invoice_logs_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "e_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

