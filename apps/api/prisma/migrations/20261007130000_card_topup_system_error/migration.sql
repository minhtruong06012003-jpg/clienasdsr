-- Đánh dấu thẻ lỗi do phía hệ thống / nhà cung cấp (không tính vào giới hạn thẻ lỗi của khách)
-- AlterTable
ALTER TABLE "card_topups" ADD COLUMN     "systemError" BOOLEAN NOT NULL DEFAULT false;

