"use client";

/** Đếm 1 lượt xem bài viết từ trình duyệt sau khi trang hiển thị (docs/api-public.md 4.2); lỗi bỏ qua */
import { useEffect } from "react";

export function PostViewCounter({ id }: { id: string }) {
  useEffect(() => {
    fetch(`/api/public/posts/${id}/view`, { method: "POST", keepalive: true }).catch(() => {});
  }, [id]);
  return null;
}
