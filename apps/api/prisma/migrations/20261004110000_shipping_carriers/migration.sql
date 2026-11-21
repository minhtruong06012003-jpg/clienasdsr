-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'PICKING', 'PICKED', 'DELIVERING', 'DELIVERED', 'RETURNING', 'RETURNED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "ShippingMethodType" ADD VALUE 'CARRIER';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "shippingMeta" JSONB;

-- AlterTable
ALTER TABLE "shipping_methods" ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "carrierService" TEXT,
ADD COLUMN     "fallbackCost" DECIMAL(15,2),
ADD COLUMN     "feeAdjust" JSONB;

-- CreateTable
CREATE TABLE "shipping_locations" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "parentCode" TEXT,
    "carrierCodes" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "carrier" TEXT NOT NULL,
    "service" TEXT,
    "serviceName" TEXT,
    "trackingCode" TEXT,
    "carrierOrderId" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "statusCode" TEXT,
    "statusMessage" TEXT,
    "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "codAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "insuranceValue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "length" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "note" TEXT,
    "payer" TEXT NOT NULL DEFAULT 'shop',
    "pickup" JSONB NOT NULL DEFAULT '{}',
    "recipient" JSONB NOT NULL DEFAULT '{}',
    "trackingUrl" TEXT,
    "labelUrl" TEXT,
    "labelPath" TEXT,
    "expectedDeliveryAt" TIMESTAMP(3),
    "pickedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_locations_code_key" ON "shipping_locations"("code");

-- CreateIndex
CREATE INDEX "shipping_locations_parentCode_idx" ON "shipping_locations"("parentCode");

-- CreateIndex
CREATE INDEX "shipping_locations_level_normalized_idx" ON "shipping_locations"("level", "normalized");

-- CreateIndex
CREATE INDEX "shipments_orderId_idx" ON "shipments"("orderId");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE INDEX "shipments_carrier_trackingCode_idx" ON "shipments"("carrier", "trackingCode");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

