-- Bỏ cơ chế plugin: các module (thanh toán PayOS/SePay/Pay2S, thông báo đơn/form, mã theo dõi, nút liên hệ, webhooks)
-- nằm cố định trong mã nguồn. Cấu hình của plugin cũ được chép sang bảng settings (mỗi module một nhóm, có cờ `enabled`
-- giữ đúng trạng thái bật/tắt cũ), endpoint webhook chép sang bảng riêng, rồi xoá 3 bảng của nền tảng plugin.
-- Bảng riêng do plugin cài thêm tự tạo (nếu có) KHÔNG bị xoá.

-- 1) Bảng endpoint webhook (trước đây là JSON trong plugin_store)
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL DEFAULT '',
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "headers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- Endpoint đã lưu (giữ nguyên id để nhật ký gửi cũ vẫn khớp endpoint)
INSERT INTO "webhook_endpoints" ("id", "name", "url", "secret", "events", "enabled", "headers", "createdAt", "updatedAt")
SELECT
    CASE WHEN e->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e->>'id')::uuid ELSE gen_random_uuid() END,
    LEFT(COALESCE(NULLIF(e->>'name', ''), e->>'url'), 100),
    e->>'url',
    COALESCE(e->>'secret', ''),
    ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(e->'events') = 'array' THEN e->'events' ELSE '[]'::jsonb END)),
    COALESCE((e->>'enabled')::boolean, true),
    CASE WHEN jsonb_typeof(e->'headers') = 'object' THEN e->'headers' END,
    COALESCE((e->>'createdAt')::timestamptz AT TIME ZONE 'UTC', CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM "plugin_store" s,
     jsonb_array_elements(CASE WHEN jsonb_typeof(s."value") = 'array' THEN s."value" ELSE '[]'::jsonb END) e
WHERE s."pluginKey" = 'webhooks' AND s."key" = 'endpoints' AND COALESCE(e->>'url', '') ~* '^https?://'
ON CONFLICT ("id") DO NOTHING;

-- Cấu hình webhook kiểu cũ (1 URL trong settings plugin, chưa từng chuyển thành endpoint)
INSERT INTO "webhook_endpoints" ("id", "name", "url", "secret", "events", "enabled", "createdAt", "updatedAt")
SELECT
    gen_random_uuid(),
    LEFT(COALESCE(SUBSTRING(p."settings"->>'url' FROM '^https?://([^/:?#]+)'), p."settings"->>'url'), 100),
    p."settings"->>'url',
    COALESCE(p."settings"->>'secret', ''),
    ARRAY_REMOVE(STRING_TO_ARRAY(REGEXP_REPLACE(COALESCE(p."settings"->>'events', ''), '\s', '', 'g'), ','), ''),
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "plugins" p
WHERE p."key" = 'webhooks'
  AND COALESCE(p."settings"->>'url', '') ~* '^https?://'
  AND NOT EXISTS (SELECT 1 FROM "plugin_store" s WHERE s."pluginKey" = 'webhooks' AND s."key" = 'endpoints');

-- 2) Cấu hình plugin có sẵn -> nhóm cài đặt. jsonb_strip_nulls: giá trị null cũ = dùng mặc định của nhóm mới.
--    ON CONFLICT DO NOTHING: không ghi đè nếu nhóm đã tồn tại.
INSERT INTO "settings" ("key", "value", "isPublic", "updatedAt")
SELECT m.group_key,
       jsonb_build_object('enabled', p."enabled") || (jsonb_strip_nulls(COALESCE(p."settings", '{}'::jsonb)) - 'url' - 'secret' - 'events'),
       m.is_public,
       CURRENT_TIMESTAMP
FROM "plugins" p
JOIN (VALUES
    ('tracking-scripts', 'tracking', true),
    ('contact-buttons', 'contactButtons', true),
    ('order-notification', 'orderNotification', false),
    ('form-notification', 'formNotification', false),
    ('webhooks', 'webhooks', false),
    ('payment-payos', 'payos', false),
    ('payment-sepay', 'sepay', false),
    ('payment-pay2s', 'pay2s', false)
) AS m(plugin_key, group_key, is_public) ON m.plugin_key = p."key"
ON CONFLICT ("key") DO NOTHING;

-- 3) Quyền "plugins.manage" -> "webhooks.manage" (quyền còn lại duy nhất của mục Plugins cũ là quản lý webhook)
UPDATE "roles" SET "permissions" = ARRAY_REPLACE("permissions", 'plugins.manage', 'webhooks.manage') WHERE 'plugins.manage' = ANY("permissions");
UPDATE "api_keys" SET "permissions" = ARRAY_REPLACE("permissions", 'plugins.manage', 'webhooks.manage') WHERE 'plugins.manage' = ANY("permissions");

-- 4) Xoá bảng của nền tảng plugin
DROP TABLE "plugin_store";
DROP TABLE "plugin_migrations";
DROP TABLE "plugins";
