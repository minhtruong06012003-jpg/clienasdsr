-- Vai trò "Nhà phát triển": toàn quyền như Quản trị viên, thấy thêm các mục cấu hình kỹ thuật trong admin.
-- Chỉ thêm dòng nếu chưa có; không đổi vai trò của tài khoản nào (gán bằng tay trong Thành viên).
INSERT INTO "roles" ("id", "name", "slug", "description", "permissions", "isSystem", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Nhà phát triển', 'developer', 'Toàn quyền, thấy thêm các mục cấu hình kỹ thuật (loại nội dung, trường tuỳ chỉnh, webhooks...)', ARRAY['*']::text[], true, now(), now())
ON CONFLICT ("slug") DO NOTHING;
