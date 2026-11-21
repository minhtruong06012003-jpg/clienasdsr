import { redirect } from 'next/navigation';

/** Đường dẫn cũ: đã gộp vào trang Nhật ký hệ thống (giữ nguyên bộ lọc trên URL) */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) sp.append(k, x);
  const s = sp.toString();
  redirect(s ? `/system-logs/errors?${s}` : '/system-logs/errors');
}
