-- Bỏ đơn vị credits: số dư chạy AI chuyển hẳn sang số dư ví (VND), tỉ lệ 1 credit = 1đ.
-- Chỉ chuyển dữ liệu, không xoá cột / bảng: users."creditBalance" về 0, credit_transactions giữ làm nhật ký AI.
-- Chạy lại không cộng trùng vì chỉ đụng tới khách còn creditBalance > 0.

-- 1) ghi một giao dịch ví DEPOSIT cho mỗi khách còn credits (balanceAfter = số dư ví sau khi cộng)
INSERT INTO "wallet_transactions" ("id", "userId", "type", "amount", "balanceAfter", "note", "meta", "idempotencyKey", "createdAt")
SELECT gen_random_uuid(), u."id", 'DEPOSIT', u."creditBalance", u."walletBalance" + u."creditBalance",
       'Chuyển số dư credits sang ví (1 credit = 1đ)',
       jsonb_build_object('source', 'credits_migration', 'credits', u."creditBalance"),
       'credits-to-wallet:' || u."id", now()
FROM "users" u
WHERE u."creditBalance" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- 2) cộng vào ví và đưa credits về 0
UPDATE "users"
SET "walletBalance" = "walletBalance" + "creditBalance", "creditBalance" = 0
WHERE "creditBalance" > 0;
