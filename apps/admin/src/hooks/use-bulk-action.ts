'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';

/** Số request chạy song song khi xử lý hàng loạt — đủ nhanh mà không chạm giới hạn 300 request/phút của API */
const CONCURRENCY = 4;

interface BulkRunOptions {
  /** danh sách id đã tích chọn */
  ids: string[];
  /** gọi API cho từng id (dùng lại endpoint đơn lẻ sẵn có, nên mọi kiểm tra quyền phía server vẫn áp dụng) */
  action: (id: string) => Promise<unknown>;
  /** mô tả thao tác cho thông báo, vd. "Đã xoá" → "Đã xoá 5 mục" */
  doneLabel: string;
  /** chạy sau khi xong (kể cả khi có mục lỗi): làm mới danh sách, bỏ chọn... */
  onDone?: (result: { ok: string[]; failed: { id: string; message: string }[] }) => void;
}

/**
 * Thao tác hàng loạt phía client cho các trang chưa có endpoint /bulk:
 * chạy action cho từng id với số luồng giới hạn, gom kết quả rồi báo 1 toast tổng hợp.
 */
export function useBulkAction() {
  const [pending, setPending] = useState(false);

  const run = async ({ ids, action, doneLabel, onDone }: BulkRunOptions) => {
    if (!ids.length || pending) return;
    setPending(true);
    const ok: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const queue = [...ids];
    // mỗi "worker" rút id kế tiếp trong hàng đợi đến khi hết
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await action(id);
          ok.push(id);
        } catch (e) {
          failed.push({ id, message: errorMessage(e) });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    } finally {
      setPending(false);
    }
    if (ok.length) toast.success(`${doneLabel} ${ok.length} mục`);
    if (failed.length) {
      // gộp các lỗi trùng nội dung để toast gọn
      const messages = [...new Set(failed.map((f) => f.message))].slice(0, 3).join('; ');
      toast.error(`${failed.length} mục không xử lý được: ${messages}`);
    }
    onDone?.({ ok, failed });
  };

  return { run, pending };
}
