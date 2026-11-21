-- Bỏ tính năng thông báo trong admin + thông báo khách (/api/account/notifications)
DROP TABLE IF EXISTS "notifications";
-- Job dọn thông báo / tổng hợp sắp hết hàng của module cũ (nếu còn trong hàng đợi)
DELETE FROM "jobs" WHERE "type" LIKE 'notifications.%';
