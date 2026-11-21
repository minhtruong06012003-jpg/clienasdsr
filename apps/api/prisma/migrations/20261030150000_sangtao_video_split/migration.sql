-- SangTao: tách công cụ "Video AI Veo 3.1 / Grok" (chọn model trong form) thành 3 gói riêng theo model
-- vì mỗi model giá khác nhau. Gói mới chép cấu hình của công cụ cũ (giá đã chỉnh, bật/tắt, nhóm menu, thứ tự),
-- rồi tắt công cụ cũ (giữ lại để xem tác vụ cũ). Máy chưa có công cụ cũ thì không làm gì (API tự thêm khi khởi động).
-- ON CONFLICT: API khởi động trước migration có thể đã tự thêm gói mới ở trạng thái tắt, giá mặc định -> ghi đè bằng cấu hình cũ.
INSERT INTO "ai_tools" ("key", "provider", "category", "name", "description", "icon", "badge", "enabled", "featured", "sortOrder", "pricing", "options", "createdAt", "updatedAt")
SELECT n."key", o."provider", o."category", n."name", n."description", o."icon", o."badge", o."enabled", o."featured", o."sortOrder", o."pricing", '{}'::jsonb, NOW(), NOW()
FROM "ai_tools" o
CROSS JOIN (VALUES
  ('sangtao.video-veo', 'Video AI Google Veo 3.1 Fast', 'Tạo video từ mô tả bằng Google Veo 3.1 Fast (720p / 1080p, 4–8 giây, có âm thanh).'),
  ('sangtao.video-omni', 'Video AI Google Omni Flash', 'Tạo video từ mô tả bằng Google Omni Flash (4–10 giây).'),
  ('sangtao.video-grok', 'Video AI Grok 3', 'Tạo video từ mô tả bằng Grok 3 Video (480p / 720p, 6–15 giây, nhiều chế độ sáng tạo).')
) AS n("key", "name", "description")
WHERE o."key" = 'sangtao.video'
ON CONFLICT ("key") DO UPDATE SET
  "category" = EXCLUDED."category", "icon" = EXCLUDED."icon", "badge" = EXCLUDED."badge", "enabled" = EXCLUDED."enabled",
  "featured" = EXCLUDED."featured", "sortOrder" = EXCLUDED."sortOrder", "pricing" = EXCLUDED."pricing", "updatedAt" = NOW();

UPDATE "ai_tools" SET "enabled" = false, "featured" = false, "updatedAt" = NOW() WHERE "key" = 'sangtao.video';
