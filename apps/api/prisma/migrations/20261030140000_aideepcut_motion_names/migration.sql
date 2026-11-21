-- AI DeepCut: đổi tên 2 công cụ Motion theo nguồn (code đã đổi ở f0a4fa3 nhưng DB vẫn giữ tên cũ,
-- nên khách chỉ thấy 1 công cụ "Motion", công cụ còn lại vẫn mang tên "Thay nhân vật video").
-- Chỉ cập nhật khi còn đúng tên/mô tả mặc định cũ, không ghi đè nội dung admin đã tự sửa.
UPDATE "ai_tools" SET "name" = 'Motion control nền video v2 720p'
WHERE "key" = 'aideepcut.swap-character' AND "name" = 'Thay nhân vật video';

UPDATE "ai_tools" SET "description" = 'Thay người trong video bằng nhân vật trong ảnh, giữ nguyên chuyển động và nền video (Wan2.2 Animate, 720x1280 dọc).'
WHERE "key" = 'aideepcut.swap-character' AND "description" = 'Thay người trong video bằng nhân vật trong ảnh, giữ nguyên chuyển động (Wan2.2 Animate).';

UPDATE "ai_tools" SET "name" = 'Motion control nền ảnh 720p V3'
WHERE "key" = 'aideepcut.motion-image' AND "name" = 'Motion control nền ảnh';
