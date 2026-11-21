-- Lý do admin khoá tạm thời tài khoản (hiện trong thông báo khi thành viên đăng nhập)
ALTER TABLE "users" ADD COLUMN "lockReason" TEXT;
