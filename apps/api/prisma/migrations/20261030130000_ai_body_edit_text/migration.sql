-- Chỉnh dáng người (TMC): đổi tên + mô tả theo Studio TMC (bỏ chữ "hông" cũ).
-- Chỉ cập nhật khi còn đúng tên/mô tả mặc định cũ, không ghi đè nội dung admin đã tự sửa.
UPDATE "ai_tools" SET "name" = 'Chỉnh dáng người AI'
WHERE "key" = 'tmc.body-edit' AND "name" = 'Chỉnh dáng người';

UPDATE "ai_tools" SET "description" = 'Chỉnh vóc dáng thon gọn, tăng vòng 1, vòng 3, eo thon S-Line tự nhiên — giữ nguyên mặt, trang phục và nền.'
WHERE "key" = 'tmc.body-edit' AND "description" = 'Chỉnh eo, vòng 1, hông, dáng thon gọn tự nhiên.';
