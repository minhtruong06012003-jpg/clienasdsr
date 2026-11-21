-- AlterTable
ALTER TABLE "ai_tools" ADD COLUMN     "modelGroup" TEXT,
ADD COLUMN     "modelLabel" TEXT;


-- Gộp 3 gói Video AI của SangTao (đã tách theo model) thành 1 công cụ trên website, khách chọn model như sangtao.ai
UPDATE "ai_tools" SET "modelGroup" = 'Tạo video AI', "modelLabel" = 'Veo 3.1 Fast' WHERE "key" = 'sangtao.video-veo';
UPDATE "ai_tools" SET "modelGroup" = 'Tạo video AI', "modelLabel" = 'Omni Flash' WHERE "key" = 'sangtao.video-omni';
UPDATE "ai_tools" SET "modelGroup" = 'Tạo video AI', "modelLabel" = 'Grok 3' WHERE "key" = 'sangtao.video-grok';
