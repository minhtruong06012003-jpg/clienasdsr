-- AlterTable
ALTER TABLE "ai_tasks" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ai_tasks_isPublic_createdAt_idx" ON "ai_tasks"("isPublic", "createdAt");

