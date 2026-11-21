-- AlterTable
ALTER TABLE "products" ADD COLUMN     "taxClass" TEXT;

-- CreateTable
CREATE TABLE "content_types" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '{}',
    "slugs" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'file-text',
    "supports" TEXT[] DEFAULT ARRAY['editor', 'excerpt', 'featuredImage', 'revisions']::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "hasArchive" BOOLEAN NOT NULL DEFAULT true,
    "searchable" BOOLEAN NOT NULL DEFAULT true,
    "perPage" INTEGER NOT NULL DEFAULT 12,
    "orderBy" TEXT NOT NULL DEFAULT 'publishedAt_desc',
    "listColumns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'admin',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomies" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '{}',
    "slugs" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "hierarchical" BOOLEAN NOT NULL DEFAULT true,
    "contentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "showInFilter" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxonomies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "taxonomyId" UUID NOT NULL,
    "parentId" UUID,
    "imageId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_translations" (
    "id" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "taxonomyId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,

    CONSTRAINT "term_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "parentId" UUID,
    "authorId" UUID,
    "featuredImageId" UUID,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_translations" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "excerpt" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoKeywords" TEXT,
    "canonicalUrl" TEXT,
    "ogImageId" UUID,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "nofollow" BOOLEAN NOT NULL DEFAULT false,
    "schemaJson" JSONB,

    CONSTRAINT "entry_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_terms" (
    "entryId" UUID NOT NULL,
    "termId" UUID NOT NULL,

    CONSTRAINT "entry_terms_pkey" PRIMARY KEY ("entryId","termId")
);

-- CreateTable
CREATE TABLE "entry_revisions" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entry_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '*',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_template_translations" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "theme_template_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" UUID NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_locks" (
    "id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "userName" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("userId","productId")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "userId" UUID,
    "items" JSONB NOT NULL DEFAULT '[]',
    "email" TEXT,
    "locale" TEXT,
    "subtotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "convertedOrderCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" JSONB NOT NULL DEFAULT '{}',
    "type" TEXT NOT NULL DEFAULT 'select',
    "values" JSONB NOT NULL DEFAULT '[]',
    "filterable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "taxClass" TEXT NOT NULL DEFAULT 'standard',
    "country" TEXT NOT NULL DEFAULT '*',
    "province" TEXT NOT NULL DEFAULT '*',
    "rate" DECIMAL(6,3) NOT NULL,
    "shipping" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_types_key_key" ON "content_types"("key");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomies_key_key" ON "taxonomies"("key");

-- CreateIndex
CREATE INDEX "terms_taxonomyId_idx" ON "terms"("taxonomyId");

-- CreateIndex
CREATE UNIQUE INDEX "term_translations_termId_locale_key" ON "term_translations"("termId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "term_translations_taxonomyId_locale_slug_key" ON "term_translations"("taxonomyId", "locale", "slug");

-- CreateIndex
CREATE INDEX "entries_typeId_status_publishedAt_idx" ON "entries"("typeId", "status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "entry_translations_entryId_locale_key" ON "entry_translations"("entryId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "entry_translations_typeId_locale_slug_key" ON "entry_translations"("typeId", "locale", "slug");

-- CreateIndex
CREATE INDEX "entry_terms_termId_idx" ON "entry_terms"("termId");

-- CreateIndex
CREATE INDEX "entry_revisions_entryId_locale_idx" ON "entry_revisions"("entryId", "locale");

-- CreateIndex
CREATE INDEX "theme_templates_kind_isActive_idx" ON "theme_templates"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "theme_template_translations_templateId_locale_key" ON "theme_template_translations"("templateId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "edit_locks_entity_entityId_key" ON "edit_locks"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "carts_token_key" ON "carts"("token");

-- CreateIndex
CREATE INDEX "carts_userId_idx" ON "carts"("userId");

-- CreateIndex
CREATE INDEX "carts_lastActivityAt_idx" ON "carts"("lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_key_key" ON "product_attributes"("key");

-- CreateIndex
CREATE INDEX "tax_rates_taxClass_isActive_idx" ON "tax_rates"("taxClass", "isActive");

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_taxonomyId_fkey" FOREIGN KEY ("taxonomyId") REFERENCES "taxonomies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_translations" ADD CONSTRAINT "term_translations_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "content_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_translations" ADD CONSTRAINT "entry_translations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_template_translations" ADD CONSTRAINT "theme_template_translations_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "theme_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tìm kiếm tiếng Việt không dấu (modules/search): tạo extension unaccent nếu tài khoản DB được phép.
-- Không tạo được thì API tự lùi về tìm ILIKE có dấu, migration vẫn thành công.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Khong tao duoc extension unaccent: %', SQLERRM;
END $$;
