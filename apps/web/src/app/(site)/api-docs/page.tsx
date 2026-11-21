import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { BookOpen, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverGet } from "@/lib/server-api";
import { getServerI18n } from "@/lib/i18n/server";
import { SITE_URL } from "@/lib/site";
import { ApiModelsCatalog } from "./api-models-table";
import { type ApiModel, C, Code, Endpoint, KvTable, Section, sampleBody } from "./docs-ui";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("Tài liệu API"), description: t("Tích hợp tạo video, ảnh, giọng nói, âm nhạc bằng AI vào hệ thống của bạn qua REST API."), alternates: { canonical: "/api-docs" } };
}

/** Mục lục bên trái (id khớp với id các section) */
const TOC = [
  { id: "auth", label: "Xác thực" },
  { id: "flow", label: "Luồng gọi API" },
  { id: "servers", label: "Model → Server (SV)" },
  { id: "models", label: "Danh mục model" },
  { id: "input", label: "Input: tạo tác vụ" },
  { id: "output", label: "Output: kết quả" },
  { id: "estimate", label: "Báo giá" },
  { id: "upload", label: "Tải file đầu vào" },
  { id: "history", label: "Lịch sử tác vụ" },
  { id: "credits", label: "Số dư tài khoản" },
  { id: "errors", label: "Lỗi & giới hạn" },
  { id: "examples", label: "Ví dụ hoàn chỉnh" },
  { id: "model-list", label: "Model hiện có" },
  { id: "legacy", label: "API cũ" },
];

/** Thứ tự nhóm kết quả trong bảng model */
const OUTPUT_ORDER = ["image", "video", "audio", "text"];

/**
 * Tài liệu REST API công khai cho đối tác tích hợp AI Studio bằng API key (tạo ở `/api-keys`).
 * API chính `/v1` theo quy ước phổ biến (OpenAI / fal.ai): gọi bằng mã model chuẩn (vd `kling-2.6`) + tham số snake_case.
 * Bảng "Model hiện có" đọc trực tiếp `GET /v1/models` nên tự cập nhật khi admin bật/tắt công cụ; mỗi model có trang Input/Output riêng.
 * Địa chỉ API lấy theo NEXT_PUBLIC_SITE_URL hoặc host của request (trình duyệt gọi cùng origin `/api`, Next rewrite sang NestJS).
 */
export default async function ApiDocsPage() {
  // luôn render theo request (danh mục model đổi theo cài đặt admin, không prerender lúc build)
  await connection();
  const { t } = await getServerI18n();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = SITE_URL || (host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : "");
  const base = `${origin}/api`;
  const models = (await serverGet<{ data: ApiModel[] }>("/v1/models")).data?.data ?? [];
  // model mẫu: ưu tiên model tạo ảnh (đối tác hay hỏi nhất)
  const sample = models.find((m) => m.output === "image" && m.params.some((p) => p.name === "prompt")) ?? models[0];
  const sampleId = sample?.id ?? "gpt-image-2";
  const demoPrompt = t("Một chú mèo phi hành gia");
  const body = sample ? sampleBody(sample, demoPrompt, origin) : { model: sampleId, prompt: demoPrompt, aspect_ratio: "1:1" };
  const bodyJson = JSON.stringify(body, null, 2);
  const sorted = [...models].sort((a, b) => OUTPUT_ORDER.indexOf(a.output) - OUTPUT_ORDER.indexOf(b.output) || a.id.localeCompare(b.id));

  return (
    <div className="pt-2">
      <header className="rounded-3xl border bg-card px-5 py-8 text-center shadow-xs sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">{t("Dành cho nhà phát triển")}</p>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">{t("Tài liệu API")}</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-muted-foreground">
            {t("Gọi các model AI (ảnh, video, giọng nói, âm nhạc...) bằng tên model chuẩn và tham số quen thuộc. Tiền trừ vào số dư tài khoản (VND) giống hệt khi dùng trên web.")}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/api-keys">
                <KeyRound /> {t("Quản lý & Lấy API key")}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <a href="#model-list">
                <BookOpen /> {t("Xem danh mục Model & Bảng giá")}
              </a>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 py-8 lg:grid-cols-[190px_minmax(0,1fr)]">
        {/* mục lục: cố định khi cuộn trên màn hình rộng */}
        <nav className="hidden lg:block">
          <ul className="sticky top-24 space-y-1 text-sm">
            {TOC.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block rounded-lg px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  {t(s.label)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 space-y-12">
          <Section id="auth" title={t("Xác thực")}>
            <p>
              {t("Mọi yêu cầu gửi tới địa chỉ gốc dưới đây. Tạo API key ở trang")} <Link href="/api-keys" className="font-medium text-primary underline-offset-4 hover:underline">{t("API cho nhà phát triển")}</Link>{" "}
              {t("(cần đăng nhập), rồi gửi kèm trong header")} <C>X-API-Key</C> {t("hoặc")} <C>Authorization: Bearer</C>.
            </p>
            <Code code={base} />
            <Code
              code={`# Cách 1: Header X-API-Key
curl ${base}/v1/models -H "X-API-Key: <YOUR_API_KEY>"

# Cách 2: Header Authorization Bearer chuẩn
curl ${base}/v1/models -H "Authorization: Bearer <YOUR_API_KEY>"`}
            />
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("Key chỉ hiện đầy đủ một lần khi tạo. Mất key thì thu hồi và tạo key mới.")}</li>
              <li>{t("Chỉ dùng key ở máy chủ của bạn, không nhúng vào mã chạy trên trình duyệt hay ứng dụng di động.")}</li>
              <li>{t("Dữ liệu gửi và nhận ở dạng JSON (trừ API tải file dùng multipart/form-data).")}</li>
            </ul>
          </Section>

          <Section id="flow" title={t("Luồng đấu nối chuẩn: Model → Check Server (SV) → Confirm")}>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>
                <strong>{t("Bước 1 — Chọn Model chuẩn:")}</strong> <C>GET /v1/models/groups</C> ({t("hoặc")} <C>GET /v1/models</C>) {t("— trả danh sách model chuẩn như")} <C>seedream-5.5</C>, <C>seedance-2.5</C>, <C>wan-3.0</C>, <C>nano-banana-pro</C> {t("kèm danh sách các máy chủ")} <C>SV1..SV15+</C>.
              </li>
              <li>
                <strong>{t("Bước 2 — Kiểm tra Server (SV) sống & bảng giá:")}</strong> <C>GET /v1/models/{"{model}"}/servers</C> ({t("vd")} <C>GET /v1/models/seedream-5.5/servers</C>) {t("— kiểm tra")} <C>server_status</C> (<C>healthy</C> | <C>maintenance</C>), {t("bảng giá từng SV và")} <C>recommended_server_id</C>.
              </li>
              <li>
                <strong>{t("Bước 3 — Confirm chạy đơn (chốt đúng SV hoặc auto):")}</strong> <C>POST /v1/generations</C> {t("với")} <C>{`{ "model": "seedream-5.5", "server": "sv15", ... }`}</C> ({t("hoặc")} <C>{`"server": "auto"`}</C>) {t("— hệ thống định tuyến thẳng vào SV đã chọn, trừ tiền và trả ngay id tác vụ.")}
              </li>
              <li>
                <strong>{t("Bước 4 — Nhận kết quả:")}</strong> <C>GET /v1/generations/{"{id}"}</C> {t("mỗi 5–10 giây tới khi status là succeeded, lấy link file trong output.files.")}
              </li>
            </ol>
            <p>
              {t("Tương thích ngược 100%: tích hợp cũ gọi trực tiếp bằng mã route lẻ (vd")} <C>seedream-5.5-2</C>, <C>kling-2.6/first-last-frame</C>{t(") không truyền")} <C>server</C> {t("vẫn chạy bình thường.")}
            </p>
          </Section>

          <Section id="servers" title={t("Cấu trúc Model → Server (SV) & Kiểm tra trạng thái SV")}>
            <Endpoint method="GET" path="/v1/models/groups" note={t("Không cần key · Cây Model -> Servers[]")} />
            <p>
              {t("Gộp toàn bộ các route lẻ cùng dòng model về một mã chuẩn duy nhất (canonical_model), bên trong chứa mảng")} <C>servers</C> ({t("các máy chủ")} <C>sv1</C>, <C>sv3</C>, <C>sv14</C>, <C>sv15</C>...) {t("để đối tác không phải xử lý các hậu tố -2, -3 rời rạc.")}
            </p>
            <Endpoint method="GET" path="/v1/models/{model}/servers" note={t("Không cần key · Check SV sống & giá")} />
            <p>
              {t("Kiểm tra tức thời máy chủ nào của model đang hoạt động tốt (")}<C>healthy</C>{t(") hay đang bảo trì (")}<C>maintenance</C>{t("), kèm máy chủ đề xuất giá tốt nhất (")}<C>recommended_server_id</C>{t("):")}
            </p>
            <Code
              code={`# Kiểm tra danh sách SV sống của model seedream-5.5
curl ${base}/v1/models/seedream-5.5/servers

# Kết quả trả về:
{
  "object": "model_servers",
  "model": "seedream-5.5",
  "name": "Seedream 5.5",
  "output": "image",
  "healthy_servers_count": 4,
  "total_servers_count": 4,
  "recommended_server_id": "sv15",
  "recommended_model_id": "seedream-5-5",
  "servers": [
    {
      "server_id": "sv15",
      "server_name": "SV15",
      "server_status": "healthy",      // "healthy" (sống) | "maintenance" (đang bảo trì)
      "maintenance": false,
      "model_id": "seedream-5-5",
      "pricing": { "mode": "dynamic", "min_price": 400, "max_price": 800, "currency": "VND" },
      "params": [ ... ],
      "updated_at": "2026-11-21T00:50:00.000Z"
    },
    {
      "server_id": "sv3",
      "server_name": "SV3",
      "server_status": "healthy",
      "maintenance": false,
      "model_id": "seedream-5.5",
      "pricing": { ... },
      "params": [ ... ]
    }
  ]
}`}
            />
            <p className="font-medium">{t("Chốt Server khi gọi báo giá (/estimate) hoặc tạo tác vụ (/generations):")}</p>
            <Code
              code={`# Cách A: Chỉ định cứng máy chủ (nếu SV đó đang maintenance hệ thống trả 409 kèm danh sách SV healthy)
curl -X POST ${base}/v1/generations \\
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "seedream-5.5", "server": "sv15", "prompt": "${demoPrompt}", "aspect_ratio": "1:1"}'

# Cách B: Để hệ thống tự động chọn máy chủ healthy có giá tốt nhất ("server": "auto")
curl -X POST ${base}/v1/generations \\
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "seedream-5.5", "server": "auto", "prompt": "${demoPrompt}", "aspect_ratio": "1:1"}'`}
            />
          </Section>

          <Section id="models" title={t("Danh mục model")}>
            <Endpoint method="GET" path="/v1/models?output=image&server=sv15&status=healthy" note={t("Không cần key")} />
            <p>
              {t("Danh sách model đang mở bán (mỗi phần tử kèm sẵn")} <C>canonical_model</C>, <C>server_id</C>, <C>server_name</C>, <C>server_status</C>{t("). Lọc tuỳ chọn theo")} <C>output</C> (<C>image</C> | <C>video</C> | <C>audio</C> | <C>text</C>), <C>server</C> (<C>sv1..sv15+</C>), <C>status</C> (<C>healthy</C> | <C>maintenance</C>), <C>canonical_model</C> {t("hoặc")} <C>type</C>.
            </p>
            <Endpoint method="GET" path="/v1/models/{id}" note={t("Không cần key")} />
            <p>{t("Chi tiết một model với đầy đủ tham số đầu vào và danh sách các máy chủ cùng dòng (available_servers).")}</p>
            <Code
              code={`{
  "id": "${sampleId}",
  "object": "model",
  "canonical_model": "${sample?.canonical_model ?? sampleId}",
  "server_id": "${sample?.server_id ?? "sv3"}",
  "server_name": "${sample?.server_name ?? "SV3"}",
  "server_status": "${sample?.server_status ?? "healthy"}",
  "maintenance": false,
  "name": "${sample ? t(sample.name) : "GPT Image 2"}",
  "type": "${sample?.type ?? "image"}",
  "output": "${sample?.output ?? "image"}",       // image | video | audio | text
  "pricing": { "mode": "fixed", "base": 1500, "per_unit": 0, "unit": null, "min": 0, "currency": "VND" },
  "params": [
    { "name": "prompt", "type": "string", "required": true, "description": "${t("Mô tả")}", "max": 20000 },
    { "name": "aspect_ratio", "type": "enum", "required": false, "default": "1:1",
      "options": [{ "value": "1:1", "label": "1:1" }, { "value": "16:9", "label": "16:9" }] },
    { "name": "image_url", "type": "file_url", "file_type": "image", "required": false, "description": "${t("Ảnh mẫu")}" }
  ]
}`}
            />
            <p className="font-medium">{t("Ý nghĩa các trường của params:")}</p>
            <KvTable
              head={[t("Trường"), t("Ý nghĩa")]}
              rows={[
                ["type", <>string · integer · number · boolean · enum · file_url {t("(URL file, xem phần tải file)")}</>],
                ["required / default", t("Bắt buộc hay không, giá trị dùng khi bỏ trống.")],
                ["options", t("Giá trị hợp lệ của enum (value gửi lên API, label là nhãn hiển thị).")],
                ["min / max", t("Giới hạn số; với string là độ dài tối đa.")],
                ["multiple / max_files", t("Tham số file nhận mảng nhiều URL.")],
                ["only_if", t("Tham số chỉ có hiệu lực khi tham số khác có giá trị nằm trong danh sách.")],
                ["options_by", t("Lựa chọn thay đổi theo giá trị tham số khác.")],
                ["combinations", t("duration và resolution chỉ nhận các tổ hợp liệt kê ở đây.")],
              ]}
            />
          </Section>

          <Section id="input" title={t("Input: tạo tác vụ")}>
            <Endpoint method="POST" path="/v1/generations" />
            <p>
              {t("Body là JSON phẳng:")} <C>model</C> {t("+ các tham số của model đó ở cùng cấp. Tham số sai tên hoặc không có trong params bị từ chối (400) để bạn phát hiện lỗi sớm.")}
            </p>
            <Code
              code={`curl -X POST ${base}/v1/generations \\
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \\
  -d '${bodyJson.replace(/'/g, "'\\''")}'`}
            />
            <p>{t("Kết quả trả ngay đối tượng generation (status queued / processing). Tiền được trừ lúc tạo, lỗi thì tự hoàn lại.")}</p>
          </Section>

          <Section id="output" title={t("Output: kết quả")}>
            <Endpoint method="GET" path="/v1/generations/{id}" />
            <p>{t("Nhận id (uuid) hoặc mã tác vụ (code). Hỏi lại mỗi 5–10 giây cho tới khi status là succeeded, failed hoặc cancelled.")}</p>
            <Code
              code={`{
  "id": "3f1c...-uuid",
  "object": "generation",
  "code": "T8KQ2M4X",
  "model": "${sampleId}",
  "status": "succeeded",
  "progress": 100,
  "cost": 1500,                 // ${t("số tiền VND đã trừ")}
  "currency": "VND",
  "refunded": false,
  "output": {
    "type": "image",
    "files": [{ "url": "${origin}/uploads/ai/outputs/....png", "type": "image", "name": "image.png" }],
    "text": null                // ${t("chỉ có với model trả văn bản")}
  },
  "error": null,
  "created_at": "2026-10-30T08:00:00.000Z",
  "completed_at": "2026-10-30T08:00:41.000Z"
}`}
            />
            <KvTable
              head={["status", t("Ý nghĩa")]}
              rows={[
                ["queued", t("Đã nhận, đang gửi sang máy chủ AI")],
                ["processing", t("Đang xử lý; progress là phần trăm hoàn thành (nếu có)")],
                ["succeeded", t("Xong; kết quả nằm trong output.files (và output.text)")],
                ["failed", t("Lỗi; lý do ở error, tiền tự hoàn lại vào số dư (refunded = true)")],
                ["cancelled", t("Đã huỷ, tiền được hoàn lại vào số dư")],
              ]}
            />
            <p>{t("Nên tải file kết quả về hệ thống của bạn: file trên máy chủ có thể được dọn sau một thời gian.")}</p>
          </Section>

          <Section id="estimate" title={t("Báo giá & Ma trận bảng giá từng lựa chọn")}>
            <Endpoint method="POST" path="/v1/generations/estimate" />
            <p>{t("Cùng body với tạo tác vụ, chỉ tính số tiền (VND) thực tế sẽ trừ (đã tự động áp % chiết khấu riêng của tài khoản API nếu có), không chạy và không trừ tiền.")}</p>
            <Code code={`# => { "object": "estimate", "model": "${sampleId}", "cost": 1425, "original_cost": 1500, "discount_percent": 5, "currency": "VND" }`} />
            <Endpoint method="GET" path="/v1/models" note={t("Trả sẵn pricing.tables & pricing.items cho toàn bộ model")} />
            <p>
              {t("Trong kết quả của")} <C>GET /v1/models</C> {t("và")} <C>GET /v1/models/{"{id}"}</C>, {t("trường")} <C>pricing</C>{" "}
              {t("chứa đầy đủ bảng giá chi tiết từng cấu hình theo thời gian thực:")} <C>min_price</C>, <C>max_price</C>, <C>default_price</C>,{" "}
              <C>items</C> ({t("từng mức cấu hình")}) {t("và")} <C>tables</C> ({t("ma trận Độ phân giải × Thời lượng cho các model Video")}) {t("để đối tác đồng bộ bảng giá tự động sang web riêng.")}
            </p>
          </Section>

          <Section id="upload" title={t("Tải file đầu vào")}>
            <p>
              {t("Tham số kiểu file_url (vd image_url, video_url, reference_image_urls) nhận một trong hai:")}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("Link công khai http(s) tới file (ảnh PNG/JPG/WEBP, video MP4/MOV/WEBM, âm thanh MP3/WAV/M4A) — máy chủ tự tải về, tối đa 10 file mỗi lần gọi.")}</li>
              <li>{t("URL trả về từ API tải file dưới đây (file nằm trên máy tính / máy chủ của bạn).")}</li>
            </ul>
            <Endpoint method="POST" path="/account/ai/uploads" />
            <Code
              code={`curl -X POST ${base}/account/ai/uploads \\
  -H "X-API-Key: $API_KEY" \\
  -F "file=@./anh-mau.jpg"

# => { "url": "${origin}/uploads/ai/inputs/...", "name": "anh-mau.jpg", "mimeType": "image/jpeg", "size": 183204 }`}
            />
          </Section>

          <Section id="history" title={t("Lịch sử tác vụ")}>
            <Endpoint method="GET" path="/v1/generations?page=1&limit=20&status=succeeded&model={id}" />
            <p>
              {t("Mới nhất trước, có phân trang:")} <C>{`{ "object": "list", "data": [...], "meta": { "total", "page", "limit", "totalPages" } }`}</C>.
            </p>
          </Section>

          <Section id="credits" title={t("Số dư tài khoản")}>
            <Endpoint method="GET" path="/account/credits" />
            <Code
              code={`{
  "credits": 54000,           // ${t("số dư ví hiện có (VND)")}
  "concurrency": 3,           // ${t("số tác vụ được chạy cùng lúc")}
  "totalUsed": 126000,       // ${t("tổng tiền đã dùng (VND)")}
  ...
}`}
            />
          </Section>

          <Section id="errors" title={t("Lỗi & giới hạn")}>
            <p>
              {t("Lỗi trả mã HTTP 4xx/5xx kèm thông báo đọc được:")} <C>{`{ "statusCode": 400, "message": "...", "error": "Bad Request" }`}</C>
            </p>
            <KvTable
              head={[t("Mã"), t("Ý nghĩa")]}
              rows={[
                ["400", t("Thiếu / sai tham số, tổ hợp không hợp lệ, số dư không đủ")],
                ["401", t("Key sai, hết hạn hoặc đã thu hồi")],
                ["403", t("Key không được gọi API này")],
                ["404", t("Model hoặc tác vụ không tồn tại / model đang tạm dừng")],
                ["409", t("Đang chạy quá số luồng của gói")],
                ["429", t("Gọi quá nhanh, chờ rồi thử lại")],
              ]}
            />
            <p>{t("Giới hạn tốc độ: tạo tác vụ 120 lần/phút, báo giá 600 lần/phút, hỏi trạng thái 1.200 lần/phút, tải file 30 lần/phút.")}</p>
          </Section>

          <Section id="examples" title={t("Ví dụ hoàn chỉnh")}>
            <p className="font-medium">Node.js (18+)</p>
            <Code
              code={`const BASE = "${base}";
const headers = { "X-API-Key": process.env.API_KEY, "Content-Type": "application/json" };

async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message);
  return body;
}

// 1) ${t("gửi input")}
let gen = await call("/v1/generations", {
  method: "POST",
  body: JSON.stringify(${JSON.stringify(body)}),
});

// 2) ${t("hỏi trạng thái tới khi xong")}
while (["queued", "processing"].includes(gen.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  gen = await call("/v1/generations/" + gen.id);
}
if (gen.status !== "succeeded") throw new Error(gen.error ?? gen.status);
console.log(gen.output.files.map((f) => f.url));`}
            />
            <p className="font-medium">Python 3</p>
            <Code
              code={`import os, time, requests

BASE = "${base}"
H = {"X-API-Key": os.environ["API_KEY"]}

def call(method, path, **kw):
    r = requests.request(method, BASE + path, headers=H, timeout=60, **kw)
    body = r.json()
    if not r.ok:
        raise RuntimeError(body.get("message"))
    return body

gen = call("POST", "/v1/generations", json=${JSON.stringify(body).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False")})

while gen["status"] in ("queued", "processing"):
    time.sleep(5)
    gen = call("GET", f"/v1/generations/{gen['id']}")

if gen["status"] != "succeeded":
    raise RuntimeError(gen.get("error") or gen["status"])
print([f["url"] for f in gen["output"]["files"]])`}
            />
          </Section>

          <Section id="model-list" title={t("Model hiện có & Bảng giá chi tiết từng lựa chọn")}>
            <p>{t("Bảng giá dưới đây đồng bộ trực tiếp 100% theo thời gian thực với hệ thống (nếu tài khoản của bạn có % chiết khấu riêng sẽ tự động hiện sẵn mức giá sau giảm). Bấm vào mã model để mở tài liệu chi tiết và code mẫu tích hợp của model đó.")}</p>
            {sorted.length ? (
              <ApiModelsCatalog models={sorted} />
            ) : (
              <p className="text-muted-foreground">{t("Chưa tải được danh mục model, hãy gọi GET /v1/models để xem.")}</p>
            )}
          </Section>

          <Section id="legacy" title={t("API cũ (vẫn hoạt động)")}>
            <p>
              {t("Tích hợp trước đây theo mã công cụ vẫn chạy bình thường:")} <C>POST /account/ai/tools/{"{key}"}/run</C> {t("với")} <C>{`{ "input": {...} }`}</C>,{" "}
              <C>POST /account/ai/tools/{"{key}"}/quote</C>, <C>GET /account/ai/tasks/{"{id}"}</C>. {t("Danh mục mã công cụ:")} <C>GET /public/ai/tools</C>.{" "}
              {t("Tích hợp mới nên dùng API /v1 ở trên.")}
            </p>
          </Section>
        </article>
      </div>
    </div>
  );
}
