-- Cho phép một công cụ AI nằm trong nhiều nhóm model: đổi cột "modelGroup" (1 tên) thành mảng "modelGroups".
-- Thêm cột mới
ALTER TABLE "ai_tools" ADD COLUMN "modelGroups" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Chép nhóm đang có sang mảng (giữ nguyên dữ liệu) trước khi bỏ cột cũ
UPDATE "ai_tools" SET "modelGroups" = ARRAY["modelGroup"] WHERE "modelGroup" IS NOT NULL AND "modelGroup" <> '';

-- Bỏ cột cũ
ALTER TABLE "ai_tools" DROP COLUMN "modelGroup";
