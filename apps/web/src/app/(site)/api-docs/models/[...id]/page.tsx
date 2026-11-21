import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { connection } from "next/server";
import { ArrowLeft, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverGet } from "@/lib/server-api";
import { getServerI18n } from "@/lib/i18n/server";
import { SITE_URL } from "@/lib/site";
import { ApiModelPricingCard } from "../../api-models-table";
import { type ApiModel, type ApiParam, C, Code, Endpoint, KvTable, Section, modelHref, sampleBody } from "../../docs-ui";

/** Mã model từ đường dẫn (catch-all vì mã có thể chứa `/`, vd `kling-2.6/first-last-frame`) */
const idOf = (parts: string[]) => parts.map((p) => decodeURIComponent(p)).join("/");

const fetchModel = (id: string) => serverGet<ApiModel>(`/v1/models/${id.split("/").map(encodeURIComponent).join("/")}`);

export async function generateMetadata({ params }: { params: Promise<{ id: string[] }> }): Promise<Metadata> {
  const id = idOf((await params).id);
  const [res, { t }] = await Promise.all([fetchModel(id), getServerI18n()]);
  const desc = res.data ? `${t(res.data.name)}${res.data.description ? ` — ${t(res.data.description)}` : ""}` : undefined;
  return { title: `${id} · ${t("Tài liệu API")}`, description: desc, alternates: { canonical: `/api-docs/models/${id.split("/").map(encodeURIComponent).join("/")}` } };
}

/**
 * Tài liệu một model của API `/v1`: Input (bảng tham số: tên, kiểu, bắt buộc, giá trị hỗ trợ, mặc định, mô tả),
 * Output (đối tượng generation trả về) và ví dụ gọi. Dữ liệu đọc trực tiếp `GET /v1/models/{id}` nên luôn khớp cấu hình admin.
 */
export default async function ModelDocPage({ params }: { params: Promise<{ id: string[] }> }) {
  await connection();
  const id = idOf((await params).id);
  const [res, { t, fmt }] = await Promise.all([fetchModel(id), getServerI18n()]);
  if (!res.data) notFound();
  const m = res.data;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = SITE_URL || (host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : "");
  const base = `${origin}/api`;
  const multiImageParam = m.params.find((p) => p.type === "file_url" && p.multiple && p.file_type === "image");
  const singleFileParam = !multiImageParam ? m.params.find((p) => p.type === "file_url") : undefined;
  const demoPrompt = multiImageParam
    ? t("Giữ nguyên tư thế và bố cục của Ảnh 1, thay sang bộ trang phục ở Ảnh 2 và lấy khuôn mặt từ Ảnh 3.")
    : t("Một chú mèo phi hành gia");
  const sampleObj = sampleBody(m, demoPrompt, origin);
  const body = JSON.stringify(sampleObj, null, 2);
  const pyBodyObj = JSON.stringify(sampleObj, null, 4)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
  const ext = m.output === "video" ? "mp4" : m.output === "audio" ? "mp3" : m.output === "text" ? "txt" : "png";
  const price =
    m.pricing.mode === "free" || (m.pricing.min_price === 0 && m.pricing.max_price === 0)
      ? t("Miễn phí")
      : typeof m.pricing.min_price === "number" && typeof m.pricing.max_price === "number"
        ? m.pricing.min_price === m.pricing.max_price
          ? `${fmt.price(m.pricing.min_price)}${m.pricing.unit === "1.000 ký tự" || m.pricing.unit === "giây" ? ` / ${t(m.pricing.unit)}` : ""}`
          : `${fmt.price(m.pricing.min_price)} – ${fmt.price(m.pricing.max_price)}${m.pricing.unit === "1.000 ký tự" || m.pricing.unit === "giây" ? ` / ${t(m.pricing.unit)}` : ""}`
        : m.pricing.mode === "dynamic"
          ? t("Theo tham số — dùng POST /v1/generations/estimate để báo giá")
          : m.pricing.mode === "tiers"
            ? `10–20s: ${fmt.price(m.pricing.tier10to20 ?? m.pricing.base ?? 0)} · 20–30s: ${fmt.price(m.pricing.tier20to30 ?? 0)}`
            : [m.pricing.base ? fmt.price(m.pricing.base) : null, m.pricing.per_unit ? `${fmt.price(m.pricing.per_unit)} / ${m.pricing.unit ? t(m.pricing.unit) : t("đơn vị")}` : null].filter(Boolean).join(" + ") || t("Miễn phí");

  return (
    <div className="mx-auto max-w-5xl space-y-10 py-6">
      <div className="space-y-3">
        <Link href="/api-docs#model-list" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t("Tài liệu API")}
        </Link>
        <h1 className="font-mono text-2xl font-bold tracking-tight break-all sm:text-3xl">{m.canonical_model ?? m.id}</h1>
        <p className="text-muted-foreground">
          {t(m.name)}
          {m.description ? ` — ${t(m.description)}` : ""}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          {m.server_name && (
            <span className={m.server_status === "maintenance" ? "rounded-full bg-amber-500/15 px-2.5 py-1 font-mono font-bold text-amber-700 dark:text-amber-300" : "rounded-full bg-emerald-500/15 px-2.5 py-1 font-mono font-bold text-emerald-700 dark:text-emerald-300"}>
              {m.server_name} ({m.server_id}) · {m.server_status === "maintenance" ? "maintenance" : "healthy"}
            </span>
          )}
          {m.canonical_model && <span className="rounded-full bg-muted px-2.5 py-1 font-mono">model: {m.canonical_model}</span>}
          {m.canonical_model && m.canonical_model !== m.id && <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-muted-foreground">route_id: {m.id}</span>}
          <span className="rounded-full bg-muted px-2.5 py-1">type: {m.type}</span>
          <span className="rounded-full bg-muted px-2.5 py-1">output: {m.output}</span>
          <span className="rounded-full bg-primary-soft px-2.5 py-1 font-semibold text-primary">{price}</span>
        </div>

        {m.available_servers && m.available_servers.length > 0 && (
          <div className="rounded-2xl border bg-muted/25 p-3.5 text-xs">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-foreground">
                {t("Các Server (SV) hiện có của model")} <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-primary">{m.canonical_model ?? m.id}</code>
              </span>
              <code className="text-[11px] text-muted-foreground">GET /api/v1/models/{m.canonical_model ?? m.id}/servers</code>
            </div>
            <div className="flex flex-wrap gap-2">
              {m.available_servers.map((sv) => {
                const active = sv.model_id === m.id;
                const maint = sv.server_status === "maintenance";
                return (
                  <Link
                    key={sv.model_id}
                    href={modelHref(sv.model_id)}
                    className={
                      active
                        ? "inline-flex items-center gap-1.5 rounded-xl border border-primary bg-primary/10 px-3 py-1.5 font-semibold text-primary"
                        : maint
                          ? "inline-flex items-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/5 px-3 py-1.5 font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                          : "inline-flex items-center gap-1.5 rounded-xl border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-muted"
                    }
                  >
                    <span className={`inline-block size-2 rounded-full ${maint ? "bg-amber-500" : "bg-emerald-500"}`} />
                    <span className="font-mono font-bold">{sv.server_name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">({sv.server_id})</span>
                    {maint ? (
                      <span className="text-[11px]">· {t("Bảo trì")}</span>
                    ) : typeof sv.min_price === "number" ? (
                      <span className="text-[11px] text-muted-foreground tabular-nums">· {sv.min_price === 0 ? t("Miễn phí") : `${t("từ")} ${fmt.price(sv.min_price)}`}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <ApiModelPricingCard model={m} />

      <Section id="input" title={t("Input — tham số đầu vào")}>
        <Endpoint method="POST" path="/v1/generations" />
        <p>
          {t("Gửi JSON theo cấu trúc chuẩn")} <C>{`"model": "${m.canonical_model ?? m.id}", "server": "${m.server_id ?? "auto"}"`}</C> {t("và các tham số dưới đây ở cùng cấp. Tham số không có trong bảng sẽ bị từ chối (400).")}
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs">
              <tr>
                <th className="px-3 py-2 font-semibold">{t("Tham số")}</th>
                <th className="px-3 py-2 font-semibold">{t("Kiểu")}</th>
                <th className="px-3 py-2 font-semibold">{t("Giá trị hỗ trợ")}</th>
                <th className="px-3 py-2 font-semibold">{t("Mô tả")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="px-3 py-2 align-top">
                  <ParamName name="model" required />
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs">string</td>
                <td className="px-3 py-2 align-top space-x-1">
                  <C>{m.canonical_model ?? m.id}</C>
                  {m.canonical_model && m.canonical_model !== m.id && (
                    <>
                      <span className="text-xs text-muted-foreground">{t("hoặc")}</span> <C>{m.id}</C>
                    </>
                  )}
                </td>
                <td className="px-3 py-2 align-top">{t("Mã model chuẩn (kết hợp cùng tham số server bên dưới) hoặc mã route trực tiếp")}</td>
              </tr>
              <tr>
                <td className="px-3 py-2 align-top">
                  <ParamName name="server" />
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs">string</td>
                <td className="px-3 py-2 align-top space-x-1">
                  <C>{m.server_id ?? "sv1"}</C>
                  <C>auto</C>
                </td>
                <td className="px-3 py-2 align-top">
                  {t("Chốt máy chủ chạy đơn (vd")} <C>{m.server_id ?? "sv1"}</C>{t(") hoặc")} <C>auto</C> {t("để tự chọn SV healthy giá tốt nhất. Kiểm tra SV sống qua")} <C>GET /v1/models/{m.canonical_model ?? m.id}/servers</C>.
                </td>
              </tr>
              {m.params.map((p) => (
                <tr key={p.name}>
                  <td className="px-3 py-2 align-top">
                    <ParamName name={p.name} required={p.required} />
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs whitespace-nowrap">
                    {p.type === "file_url" ? `${p.multiple ? "string[]" : "string"} (URL ${p.file_type})` : p.type}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Values p={p} t={t} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    {t(p.description)}
                    {p.only_if && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("Chỉ có hiệu lực khi")} <C>{p.only_if.param}</C> ∈ {p.only_if.in.join(", ")}
                      </p>
                    )}
                    {p.combinations && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("Tổ hợp hợp lệ:")} {p.combinations.join("; ")}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t("Tham số file (string URL) nhận link công khai http(s) — máy chủ tự tải về — hoặc URL trả về từ API tải file POST /account/ai/uploads.")}</li>
          {multiImageParam && (
            <li>
              {t("Thứ tự phần tử trong mảng")} <C>{multiImageParam.name}</C> (<C>[url_1, url_2, url_3]</C>) {t("được hệ thống khoá cố định 1–1 theo đúng thứ tự:")}{" "}
              <strong>{t("Ảnh 1 / Image 1 / FIRST image")}</strong>, <strong>{t("Ảnh 2 / Image 2 / SECOND image")}</strong>, <strong>{t("Ảnh 3 / Image 3 / THIRD image")}</strong>
              {m.id.includes("grok") ? <> ({t("cũng hỗ trợ gọi bằng")} <C>{"<IMAGE_0>"}</C>, <C>{"<IMAGE_1>"}</C>, <C>{"<IMAGE_2>"}</C>)</> : null}.{" "}
              {t("Khi tải file từ máy qua POST /account/ai/uploads, hãy upload tuần tự theo đúng thứ tự [1, 2, 3] để mảng URL không bị đảo.")}
            </li>
          )}
          <li>{t("Bỏ trống tham số không bắt buộc thì dùng giá trị mặc định.")}</li>
        </ul>
        <p className="font-medium">{t("Ví dụ request (cURL)")}</p>
        <Code
          code={`curl -X POST ${base}/v1/generations \\
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \\
  -d '${body.replace(/'/g, "'\\''")}'`}
        />
      </Section>

      <Section id="code-samples" title={t("Code mẫu tích hợp đầy đủ (Upload file → Tạo tác vụ → Nhận kết quả)")}>
        <p className="font-medium">Python 3</p>
        <Code
          code={
            multiImageParam
              ? `import os, time, requests

BASE = "${base}"
API_KEY = os.environ["API_KEY"]  # lấy tại trang /api-keys
HEADERS = {"X-API-Key": API_KEY}

def upload_file(local_path: str) -> str:
    """Tải 1 file từ máy lên server và trả về URL đầu vào"""
    with open(local_path, "rb") as f:
        r = requests.post(f"{BASE}/account/ai/uploads", headers=HEADERS, files={"file": f}, timeout=120)
    data = r.json()
    if not r.ok:
        raise RuntimeError(data.get("message") or r.text)
    return data["url"]

# Bước 1: Upload tuần tự đúng thứ tự Ảnh 1 -> Ảnh 2 -> Ảnh 3 (hoặc dùng thẳng link https công khai)
image_urls = [
    upload_file("./1.jpg"),  # Ảnh 1 (Image 1 / FIRST image)
    upload_file("./2.jpg"),  # Ảnh 2 (Image 2 / SECOND image)
    upload_file("./3.jpg"),  # Ảnh 3 (Image 3 / THIRD image)
]

# Bước 2: Gửi yêu cầu tạo ảnh với đúng thứ tự mảng image_urls [1, 2, 3]
payload = ${pyBodyObj.replace(/\[\s*"https:\/\/example\.com\/1\.jpg"[\s\S]*?\]/, "image_urls")}
r = requests.post(f"{BASE}/v1/generations", headers=HEADERS, json=payload, timeout=60)
gen = r.json()
if not r.ok:
    raise RuntimeError(gen.get("message") or r.text)

# Bước 3: Hỏi trạng thái mỗi 5 giây tới khi hoàn tất
while gen["status"] in ("queued", "processing"):
    time.sleep(5)
    poll = requests.get(f"{BASE}/v1/generations/{gen['id']}", headers=HEADERS, timeout=60)
    gen = poll.json()

if gen["status"] != "succeeded":
    raise RuntimeError(gen.get("error") or gen["status"])

print("Kết quả:", [f["url"] for f in gen["output"]["files"]])`
              : singleFileParam
                ? `import os, time, requests

BASE = "${base}"
API_KEY = os.environ["API_KEY"]
HEADERS = {"X-API-Key": API_KEY}

with open("./input.${singleFileParam.file_type === "video" ? "mp4" : singleFileParam.file_type === "audio" ? "mp3" : "jpg"}", "rb") as f:
    up = requests.post(f"{BASE}/account/ai/uploads", headers=HEADERS, files={"file": f}, timeout=120).json()

payload = ${pyBodyObj}
payload["${singleFileParam.name}"] = up["url"]

gen = requests.post(f"{BASE}/v1/generations", headers=HEADERS, json=payload, timeout=60).json()
while gen.get("status") in ("queued", "processing"):
    time.sleep(5)
    gen = requests.get(f"{BASE}/v1/generations/{gen['id']}", headers=HEADERS, timeout=60).json()

if gen.get("status") != "succeeded":
    raise RuntimeError(gen.get("error") or gen.get("status"))
print("Kết quả:", [f["url"] for f in gen["output"]["files"]])`
                : `import os, time, requests

BASE = "${base}"
HEADERS = {"X-API-Key": os.environ["API_KEY"]}

gen = requests.post(f"{BASE}/v1/generations", headers=HEADERS, json=${pyBodyObj}, timeout=60).json()
while gen.get("status") in ("queued", "processing"):
    time.sleep(5)
    gen = requests.get(f"{BASE}/v1/generations/{gen['id']}", headers=HEADERS, timeout=60).json()

if gen.get("status") != "succeeded":
    raise RuntimeError(gen.get("error") or gen.get("status"))
print("Kết quả:", gen["output"])`
          }
        />

        <p className="font-medium">Node.js (18+)</p>
        <Code
          code={
            multiImageParam
              ? `import fs from "node:fs";
import path from "node:path";

const BASE = "${base}";
const API_KEY = process.env.API_KEY; // lấy tại trang /api-keys

async function uploadFile(filePath) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append("file", new Blob([buf]), path.basename(filePath));
  const res = await fetch(\`\${BASE}/account/ai/uploads\`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data.url;
}

// Bước 1: Upload tuần tự từng ảnh 1 -> 2 -> 3 để giữ đúng thứ tự mảng
const imageUrls = [];
for (const file of ["./1.jpg", "./2.jpg", "./3.jpg"]) {
  imageUrls.push(await uploadFile(file));
}

// Bước 2: Gửi tạo tác vụ
const createRes = await fetch(\`\${BASE}/v1/generations\`, {
  method: "POST",
  headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    ...${body},
    ${multiImageParam.name}: imageUrls,
  }),
});
let gen = await createRes.json();
if (!createRes.ok) throw new Error(gen.message || createRes.statusText);

// Bước 3: Chờ kết quả
while (["queued", "processing"].includes(gen.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  const pollRes = await fetch(\`\${BASE}/v1/generations/\${gen.id}\`, {
    headers: { "X-API-Key": API_KEY },
  });
  gen = await pollRes.json();
}
if (gen.status !== "succeeded") throw new Error(gen.error ?? gen.status);
console.log("Kết quả:", gen.output.files.map((f) => f.url));`
              : `const BASE = "${base}";
const headers = { "X-API-Key": process.env.API_KEY, "Content-Type": "application/json" };

let gen = await fetch(\`\${BASE}/v1/generations\`, {
  method: "POST",
  headers,
  body: JSON.stringify(${body}),
}).then((r) => r.json());

while (["queued", "processing"].includes(gen.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  gen = await fetch(\`\${BASE}/v1/generations/\${gen.id}\`, { headers }).then((r) => r.json());
}
if (gen.status !== "succeeded") throw new Error(gen.error ?? gen.status);
console.log("Kết quả:", gen.output);`
          }
        />
      </Section>

      <Section id="output" title={t("Output — kết quả trả về")}>
        <p>
          {t("Tác vụ chạy bất đồng bộ. POST /v1/generations trả ngay đối tượng generation với status queued hoặc processing; hỏi lại GET /v1/generations/{id} mỗi 5–10 giây tới khi status là succeeded, failed hoặc cancelled.")}
        </p>
        <Endpoint method="GET" path="/v1/generations/{id}" />
        <Code
          code={`{
  "id": "3f1c...-uuid",
  "object": "generation",
  "code": "T8KQ2M4X",
  "model": "${m.id}",
  "status": "succeeded",       // queued | processing | succeeded | failed | cancelled
  "progress": 100,
  "cost": 2400,                // ${t("số tiền đã trừ")}
  "currency": "VND",
  "refunded": false,
  "output": {
    "type": "${m.output}",
    "files": [{ "url": "${origin}/uploads/ai/outputs/....${ext}", "type": "${m.output}", "name": "${m.output}.${ext}" }],
    "text": ${m.output === "text" ? '"..."' : "null"}
  },
  "error": null,
  "created_at": "2026-10-30T08:00:00.000Z",
  "completed_at": "2026-10-30T08:01:12.000Z"
}`}
        />
        <KvTable
          head={[t("Trường"), t("Ý nghĩa")]}
          rows={[
            ["output.files[].url", t("Link file kết quả — nên tải về hệ thống của bạn, file trên máy chủ có thể được dọn sau một thời gian.")],
            ["output.text", t("Nội dung văn bản (chỉ có với model trả văn bản).")],
            ["cost", t("Số tiền VND đã trừ vào số dư; lỗi hoặc huỷ thì tự hoàn lại (refunded = true).")],
            ["error", t("Lý do lỗi khi status = failed.")],
          ]}
        />
      </Section>

      <Section id="estimate" title={t("Báo giá trước khi chạy")}>
        <Endpoint method="POST" path="/v1/generations/estimate" />
        <p>{t("Cùng body với POST /v1/generations, không chạy và không trừ tiền.")}</p>
        <Code code={`# => { "object": "estimate", "model": "${m.id}", "cost": 2400, "currency": "VND" }`} />
      </Section>

      <Button asChild>
        <Link href="/api-keys">
          <KeyRound /> {t("Lấy API key")}
        </Link>
      </Button>
    </div>
  );
}

/** Tên tham số + nhãn bắt buộc */
function ParamName({ name, required }: { name: string; required?: boolean }) {
  return (
    <span className="flex flex-col gap-0.5">
      <code className="font-mono text-[13px] font-semibold">{name}</code>
      {required && <span className="text-[11px] font-medium text-destructive">required</span>}
    </span>
  );
}

/** Cột "Giá trị hỗ trợ": danh sách lựa chọn / giới hạn / mặc định */
function Values({ p, t }: { p: ApiParam; t: (s: string) => string }) {
  const opts = p.options ?? [];
  return (
    <div className="space-y-1">
      {opts.length > 0 && (
        <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
          {opts.map((o) => (
            <span key={o.value} title={o.label} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
              {o.value}
            </span>
          ))}
        </div>
      )}
      {p.options_by && (
        <p className="text-xs text-muted-foreground">
          {t("Lựa chọn thay đổi theo")} <C>{p.options_by.param}</C>
        </p>
      )}
      {p.type === "string" && p.max !== undefined && <p className="text-xs text-muted-foreground">{t("Tối đa {n} ký tự").replace("{n}", p.max.toLocaleString("vi-VN"))}</p>}
      {(p.type === "integer" || p.type === "number") && !opts.length && (p.min !== undefined || p.max !== undefined) && (
        <p className="text-xs text-muted-foreground">
          {p.min ?? "…"} – {p.max ?? "…"}
        </p>
      )}
      {p.type === "boolean" && <p className="font-mono text-xs">true, false</p>}
      {p.max_files && <p className="text-xs text-muted-foreground">{t("Tối đa {n} file").replace("{n}", String(p.max_files))}</p>}
      {p.default !== undefined && (
        <p className="text-xs text-muted-foreground">
          {t("Mặc định:")} <C>{String(p.default)}</C>
        </p>
      )}
    </div>
  );
}
