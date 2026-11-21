import { CopyButton } from "@/components/common";
import type { AiPriceMatrixTable, AiPriceOptionItem } from "@/lib/types";

/**
 * Thành phần giao diện và kiểu dữ liệu dùng chung của trang tài liệu API (`/api-docs`, `/api-docs/models/...`).
 */

/** Một tham số đầu vào của model như `GET /v1/models/{id}` trả về */
export type ApiParam = {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "enum" | "file_url";
  file_type?: string;
  required: boolean;
  description: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  options_count?: number;
  options_by?: { param: string; map: Record<string, { value: string; label: string }[]> };
  min?: number;
  max?: number;
  multiple?: boolean;
  max_files?: number;
  only_if?: { param: string; in: string[] };
  combinations?: string[];
};

/** Thông tin 1 máy chủ SV của cùng một model chuẩn (`available_servers` / `/v1/models/{model}/servers`) */
export type ApiAvailableServer = {
  server_id: string;
  server_name: string;
  server_status: "healthy" | "maintenance";
  maintenance: boolean;
  model_id: string;
  name: string;
  min_price?: number | null;
  max_price?: number | null;
  updated_at?: string | null;
};

/** Model của API `/v1` (kèm cấu trúc Model -> Server SV & chi tiết bảng giá từng lựa chọn cấu hình) */
export type ApiModel = {
  id: string;
  canonical_model?: string;
  group_id?: string;
  group_name?: string;
  server_id?: string;
  server_name?: string;
  server_status?: "healthy" | "maintenance";
  maintenance?: boolean;
  updated_at?: string | null;
  available_servers?: ApiAvailableServer[];
  name: string;
  type: string;
  output: string;
  description: string | null;
  pricing: {
    mode: "fixed" | "dynamic" | "free" | "tiers";
    base?: number;
    per_unit?: number;
    tier10to20?: number;
    tier20to30?: number;
    unit?: string | null;
    min?: number;
    min_price?: number | null;
    max_price?: number | null;
    default_price?: number | null;
    items?: AiPriceOptionItem[];
    tables?: AiPriceMatrixTable[];
    note?: string | null;
    currency: string;
  };
  params: ApiParam[];
};

/** Giá trị ví dụ của một tham số (để dựng request mẫu) */
export function sampleValue(p: ApiParam, demoPrompt: string, origin: string): unknown {
  if (p.default !== undefined) return p.type === "integer" ? Number(p.default) : p.default;
  if (p.options?.length) return p.type === "integer" ? Number(p.options[0].value) : p.options[0].value;
  if (p.type === "file_url") {
    const ext = p.file_type === "video" ? "mp4" : p.file_type === "audio" ? "mp3" : "jpg";
    const stem = p.file_type ?? "file";
    return p.multiple
      ? [`https://example.com/1.${ext}`, `https://example.com/2.${ext}`, `https://example.com/3.${ext}`].slice(0, Math.min(3, p.max_files ?? 3))
      : `https://example.com/${stem}.${ext}`;
  }
  if (p.type === "boolean") return false;
  if (p.type === "integer" || p.type === "number") return p.min ?? 1;
  return /prompt|text/.test(p.name) ? demoPrompt : "...";
}

/** Body JSON mẫu của `POST /v1/generations`: chuẩn `model` + `server` + tham số bắt buộc / mặc định */
export function sampleBody(m: ApiModel, demoPrompt: string, origin: string, preferCanonicalServer = true) {
  const useCanon = preferCanonicalServer && m.canonical_model && m.server_id;
  const body: Record<string, unknown> = useCanon
    ? { model: m.canonical_model, server: m.server_id }
    : { model: m.id };
  for (const p of m.params) {
    if (p.only_if) continue;
    if (p.required || p.default !== undefined || p.options?.length || /prompt/.test(p.name)) body[p.name] = sampleValue(p, demoPrompt, origin);
  }
  return body;
}

/** Một mục tài liệu có tiêu đề (id dùng cho mục lục) */
export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3 text-sm leading-relaxed">
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

/** Dòng phương thức + đường dẫn API */
export function Endpoint({ method, path, note }: { method: "GET" | "POST"; path: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2">
      <span className={method === "GET" ? "rounded-md bg-success-soft px-2 py-0.5 text-xs font-bold text-success" : "rounded-md bg-primary-soft px-2 py-0.5 text-xs font-bold text-primary"}>{method}</span>
      <code className="min-w-0 text-[13px] break-all">{path}</code>
      {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Khối mã có nút sao chép */
export function Code({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl bg-muted p-4 pr-12 text-xs leading-relaxed">{code}</pre>
      <CopyButton value={code} className="absolute top-2 right-2" />
    </div>
  );
}

/** Mã nội dòng */
export function C({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[12.5px] break-all">{children}</code>;
}

/** Bảng 2 cột (giá trị + ý nghĩa) */
export function KvTable({ head, rows }: { head: [string, string]; rows: [string, React.ReactNode][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs">
          <tr>
            <th className="px-3 py-2 font-semibold">{head[0]}</th>
            <th className="px-3 py-2 font-semibold">{head[1]}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="px-3 py-2 align-top font-mono text-xs whitespace-nowrap">{k}</td>
              <td className="px-3 py-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Đường dẫn trang chi tiết một model (mã có thể chứa `/`) */
export const modelHref = (id: string) => `/api-docs/models/${id.split("/").map(encodeURIComponent).join("/")}`;
