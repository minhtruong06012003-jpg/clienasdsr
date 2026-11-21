-- Bỏ tính năng Webhooks gửi đi (webhook nhận vào của cổng thanh toán / vận chuyển không liên quan)
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhook_endpoints";
DROP TYPE IF EXISTS "DeliveryStatus";
-- Nhóm cài đặt và job còn sót của module webhooks
DELETE FROM "settings" WHERE "key" = 'webhooks';
DELETE FROM "jobs" WHERE "type" = 'webhooks.deliver';
-- Quyền webhooks.manage không còn tồn tại
UPDATE "roles" SET "permissions" = ARRAY_REMOVE("permissions", 'webhooks.manage') WHERE 'webhooks.manage' = ANY("permissions");
UPDATE "api_keys" SET "permissions" = ARRAY_REMOVE("permissions", 'webhooks.manage') WHERE 'webhooks.manage' = ANY("permissions");
