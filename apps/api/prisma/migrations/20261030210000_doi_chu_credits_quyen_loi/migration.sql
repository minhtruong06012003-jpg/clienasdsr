-- Bỏ credits: đổi 2 dòng quyền lợi mặc định (khung "Mọi lần nạp đều bao gồm") nếu admin chưa sửa lại.
UPDATE "settings"
SET "value" = replace(replace("value"::text,
      '"Credit có thời hạn vĩnh viễn"', '"Số dư không có thời hạn"'),
      '"Credit được cộng ngay sau khi thanh toán"', '"Tiền được cộng vào số dư ngay sau khi thanh toán"')::jsonb,
    "updatedAt" = now()
WHERE "key" = 'credits'
  AND ("value"::text LIKE '%"Credit có thời hạn vĩnh viễn"%' OR "value"::text LIKE '%"Credit được cộng ngay sau khi thanh toán"%');
