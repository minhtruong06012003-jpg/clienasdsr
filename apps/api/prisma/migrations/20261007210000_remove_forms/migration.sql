-- Bỏ tính năng Form Builder: form liên hệ do từng dự án tự viết trong code
DROP TABLE IF EXISTS "form_submissions";
DROP TABLE IF EXISTS "forms";
DROP TYPE IF EXISTS "SubmissionStatus";
-- Dọn nhóm cài đặt email thông báo form (không còn dùng)
DELETE FROM "settings" WHERE "key" = 'formNotification';
-- Quyền forms.* không còn tồn tại
UPDATE "roles" SET "permissions" = ARRAY_REMOVE(ARRAY_REMOVE("permissions", 'forms.manage'), 'forms.submissions')
WHERE 'forms.manage' = ANY("permissions") OR 'forms.submissions' = ANY("permissions");
-- Bỏ block "form" (cấp ngoài cùng) khỏi nội dung đang dùng; bản lưu lịch sử (revisions) giữ nguyên
UPDATE "page_translations" SET "blocks" = COALESCE((SELECT jsonb_agg(b) FROM jsonb_array_elements("blocks") b WHERE b->>'type' IS DISTINCT FROM 'form'), '[]'::jsonb)
WHERE jsonb_typeof("blocks") = 'array' AND "blocks" @> '[{"type":"form"}]';
UPDATE "global_block_translations" SET "blocks" = COALESCE((SELECT jsonb_agg(b) FROM jsonb_array_elements("blocks") b WHERE b->>'type' IS DISTINCT FROM 'form'), '[]'::jsonb)
WHERE jsonb_typeof("blocks") = 'array' AND "blocks" @> '[{"type":"form"}]';
UPDATE "entry_translations" SET "blocks" = COALESCE((SELECT jsonb_agg(b) FROM jsonb_array_elements("blocks") b WHERE b->>'type' IS DISTINCT FROM 'form'), '[]'::jsonb)
WHERE jsonb_typeof("blocks") = 'array' AND "blocks" @> '[{"type":"form"}]';
UPDATE "theme_template_translations" SET "blocks" = COALESCE((SELECT jsonb_agg(b) FROM jsonb_array_elements("blocks") b WHERE b->>'type' IS DISTINCT FROM 'form'), '[]'::jsonb)
WHERE jsonb_typeof("blocks") = 'array' AND "blocks" @> '[{"type":"form"}]';
-- API key có thể được cấp quyền forms.*
UPDATE "api_keys" SET "permissions" = ARRAY_REMOVE(ARRAY_REMOVE("permissions", 'forms.manage'), 'forms.submissions')
WHERE 'forms.manage' = ANY("permissions") OR 'forms.submissions' = ANY("permissions");
