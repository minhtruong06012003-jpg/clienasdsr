-- AlterTable
ALTER TABLE "plugins" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "manifest" JSONB,
ADD COLUMN     "path" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'builtin';

-- CreateTable
CREATE TABLE "plugin_migrations" (
    "id" UUID NOT NULL,
    "pluginKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_store" (
    "pluginKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_store_pkey" PRIMARY KEY ("pluginKey","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "plugin_migrations_pluginKey_name_key" ON "plugin_migrations"("pluginKey", "name");

