import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getServerI18n } from "@/lib/i18n/server";
import { serverGet } from "@/lib/server-api";
import type { AiTool } from "@/lib/types";
import { groupsOf, toolHref } from "@/lib/ai";
import { ToolView } from "./tool-view";

/** Tiêu đề tab = tên công cụ theo ngôn ngữ khách (lấy từ API, lỗi thì dùng tiêu đề chung) */
export async function generateMetadata({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const [{ key }, { g }] = await Promise.all([params, searchParams]);
  const [res, { t }] = await Promise.all([serverGet<AiTool>(`/public/ai/tools/${encodeURIComponent(decodeURIComponent(key))}`), getServerI18n()]);
  // công cụ thuộc nhóm model: tiêu đề là tên nhóm (model ở nhiều nhóm: nhóm theo ?g=, không có thì nhóm đầu tiên)
  const groups = res.data ? groupsOf(res.data) : [];
  const name = (typeof g === "string" && groups.includes(g) ? g : groups[0]) || res.data?.name;
  return { title: name ? t(name) : "AI Studio" };
}

/** Trang chạy một công cụ AI */
export default async function ToolPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { key } = await params;
  // link cũ dạng `<nhà cung cấp>.<công cụ>` -> chuyển sang khoá công khai (không lộ tên nhà cung cấp), giữ nguyên ?prompt= / ?reuse=
  const raw = decodeURIComponent(key);
  if (raw.split("~")[0].includes(".")) {
    const res = await serverGet<{ key: string }>(`/public/ai/tools/resolve/${encodeURIComponent(raw)}`, 3600);
    if (res.data?.key && res.data.key !== raw) {
      const qs = new URLSearchParams(Object.entries(await searchParams).flatMap(([k, v]) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => [k, x]))).toString();
      redirect(`${toolHref(res.data.key)}${qs ? `?${qs}` : ""}`);
    }
  }
  // ToolView đọc ?prompt= (useSearchParams) nên bọc Suspense
  return (
    <Suspense>
      <ToolView toolKey={raw} />
    </Suspense>
  );
}
