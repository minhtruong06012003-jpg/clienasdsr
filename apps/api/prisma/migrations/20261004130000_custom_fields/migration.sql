-- Trường tuỳ chỉnh (modules/custom-fields): giá trị lưu ở cột customFields của từng thực thể, định nghĩa ở bảng field_groups
ALTER TABLE "users" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "pages" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "posts" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "post_categories" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "product_categories" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "products" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "field_groups" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entity" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "placement" TEXT NOT NULL DEFAULT 'main',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "field_groups_key_key" ON "field_groups"("key");
CREATE INDEX "field_groups_entity_isActive_idx" ON "field_groups"("entity", "isActive");
