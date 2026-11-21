-- Cấp quyền mới "reports.view" (Báo cáo website) cho vai trò hệ thống editor & shop_manager trên các bản cài sẵn có
-- (seed chỉ tạo vai trò khi chưa tồn tại nên không tự cập nhật quyền). Chỉ thêm, không xoá quyền nào.
UPDATE "roles"
SET "permissions" = array_append("permissions", 'reports.view'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" IN ('editor', 'shop_manager')
  AND "isSystem" = true
  AND NOT ('reports.view' = ANY("permissions"))
  AND NOT ('*' = ANY("permissions"));
