-- Hàng chờ gửi email: dùng chính bảng email_logs làm outbox (trạng thái + lịch thử lại + ưu tiên)

-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'QUEUED';
ALTER TYPE "EmailStatus" ADD VALUE 'SENDING';
ALTER TYPE "EmailStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "attachments" JSONB,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Nhật ký cũ (gửi trực tiếp, 1 lần): điền số lần thử + thời điểm gửi để thống kê đúng
UPDATE "email_logs" SET "attempts" = 1, "sentAt" = "createdAt", "updatedAt" = "createdAt" WHERE "status" = 'SENT';
UPDATE "email_logs" SET "attempts" = 1, "updatedAt" = "createdAt" WHERE "status" = 'FAILED';

-- CreateIndex
CREATE INDEX "email_logs_status_nextAttemptAt_idx" ON "email_logs"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "email_logs_sentAt_idx" ON "email_logs"("sentAt");
