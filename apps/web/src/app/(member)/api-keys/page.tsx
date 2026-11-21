"use client";

/**
 * API key của khách: tích hợp AI Studio vào hệ thống riêng (`/api/account/api-keys`).
 * - Danh sách key (tên, tiền tố nhận diện, lần dùng cuối, hạn dùng, trạng thái) + thu hồi (`DELETE /:id`).
 * - Tạo key (`POST`, tên + hạn dùng tuỳ chọn): key đầy đủ chỉ hiện một lần trong hộp thoại để khách sao chép.
 * - Thẻ "Bắt đầu nhanh": Base URL chuẩn (không lỗi hydration), 2 cách truyền Header (`X-API-Key` / `Authorization: Bearer`),
 *   bảng 6 Endpoint chính thức `/v1/*`, tab ví dụ thực tế (cURL / Python / Node.js) và liên kết thẳng tới `/api-docs`.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ApiKeyCreated, ApiKeyItem } from "@cmsnt/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { SITE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/** Nhãn + màu trạng thái key */
const KEY_STATUS: Record<ApiKeyItem["status"], { label: string; className: string }> = {
  active: { label: "Đang dùng", className: "bg-success-soft text-success" },
  expired: { label: "Hết hạn", className: "bg-warning-soft text-warning" },
  revoked: { label: "Đã thu hồi", className: "bg-muted text-muted-foreground" },
};

/** Lựa chọn hạn dùng khi tạo key (số ngày; 0 = không hết hạn) */
const EXPIRY_OPTIONS = [
  { days: 0, label: "Không hết hạn" },
  { days: 30, label: "30 ngày" },
  { days: 90, label: "90 ngày" },
  { days: 365, label: "1 năm" },
];

type SnippetLang = "curl" | "python" | "node";

export default function ApiKeysPage() {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [lastCreatedKey, setLastCreatedKey] = useState<string>("");
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const [origin, setOrigin] = useState<string>(SITE_URL || "");
  const [lang, setLang] = useState<SnippetLang>("curl");

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) {
      setOrigin(window.location.origin);
    }
  }, []);

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<{ data: ApiKeyItem[] }>("/account/api-keys"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/account/api-keys/${id}`),
    onSuccess: () => {
      toast.success(t("Đã thu hồi API key"));
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // key đã thu hồi xếp sau key đang dùng
  const rows = [...(keys.data?.data ?? [])].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
  const base = `${origin}/api`;
  const keySample = lastCreatedKey || "<YOUR_API_KEY>";

  const snippets: Record<SnippetLang, string> = {
    curl: `# 1) Xem cây danh mục Model -> Server (SV1..SV15+) & bảng giá
curl ${base}/v1/models/groups

# 2) Check Server (SV) nào của model đang sống (healthy / maintenance) & giá
curl ${base}/v1/models/nano-banana-pro/servers

# 3) Confirm chạy đơn (chốt đúng server "sv3" hoặc để "auto" tự chọn SV sống rẻ nhất)
curl -X POST ${base}/v1/generations \\
  -H "X-API-Key: ${keySample}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"nano-banana-pro","server":"auto","prompt":"Một chú mèo phi hành gia 4K","aspect_ratio":"1:1"}'

# 4) Kiểm tra kết quả & số dư ví (VNĐ)
curl ${base}/v1/generations/<ID_HOAC_MA_TAC_VU> -H "X-API-Key: ${keySample}"
curl ${base}/account/credits -H "X-API-Key: ${keySample}"`,
    python: `import time, requests

BASE = "${base}"
HEADERS = {"X-API-Key": "${keySample}"}  # hoặc {"Authorization": "Bearer ${keySample}"}

# 1) Check SV đang sống (healthy) của model nano-banana-pro
sv_info = requests.get(f"{BASE}/v1/models/nano-banana-pro/servers", timeout=30).json()
server_id = sv_info["recommended_server_id"] or "auto"

# 2) Confirm tạo tác vụ AI trên đúng SV đã chọn
gen = requests.post(
    f"{BASE}/v1/generations",
    headers=HEADERS,
    json={"model": "nano-banana-pro", "server": server_id, "prompt": "Một chú mèo phi hành gia 4K", "aspect_ratio": "1:1"},
    timeout=60,
).json()

# 3) Hỏi trạng thái mỗi 5 giây tới khi hoàn tất
while gen.get("status") in ("queued", "processing"):
    time.sleep(5)
    gen = requests.get(f"{BASE}/v1/generations/{gen['id']}", headers=HEADERS, timeout=60).json()

if gen.get("status") != "succeeded":
    raise RuntimeError(gen.get("error") or gen)
print("File kết quả:", [f["url"] for f in gen["output"]["files"]])`,
    node: `const BASE = "${base}";
const HEADERS = { "X-API-Key": "${keySample}", "Content-Type": "application/json" };

// 1) Check SV đang sống (healthy) của model
const svInfo = await fetch(\`\${BASE}/v1/models/nano-banana-pro/servers\`).then((r) => r.json());
const server = svInfo.recommended_server_id || "auto";

// 2) Confirm tạo tác vụ AI trên đúng SV đã chọn
let gen = await fetch(\`\${BASE}/v1/generations\`, {
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({ model: "nano-banana-pro", server, prompt: "Một chú mèo phi hành gia 4K", aspect_ratio: "1:1" }),
}).then((r) => r.json());

// 3) Hỏi trạng thái mỗi 5 giây tới khi hoàn tất
while (["queued", "processing"].includes(gen.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  gen = await fetch(\`\${BASE}/v1/generations/\${gen.id}\`, { headers: HEADERS }).then((r) => r.json());
}
if (gen.status !== "succeeded") throw new Error(gen.error || JSON.stringify(gen));
console.log("File kết quả:", gen.output.files.map((f) => f.url));`,
  };

  return (
    <div className="pt-2">
      <PageHeader
        title={t("API cho nhà phát triển")}
        description={t("Kết nối toàn bộ 110+ model Video, Ảnh, Giọng nói AI vào website, ứng dụng hoặc công cụ tự động của bạn. Tiền trừ trực tiếp vào số dư ví (VNĐ) kèm đầy đủ % chiết khấu riêng của tài khoản.")}
        icon={<KeyRound className="size-5" />}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/api-docs">
                <BookOpen /> {t("Tài liệu API & Bảng giá Model")}
              </Link>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> {t("Tạo API key")}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* danh sách key */}
        <section className="min-w-0 rounded-2xl border bg-card p-4 shadow-xs md:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-bold">{t("Khoá API của bạn")}</h3>
            <span className="text-xs text-muted-foreground">
              {rows.filter((x) => x.status === "active").length}/60 {t("đang dùng")}
            </span>
          </div>
          {keys.isLoading ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : keys.isError ? (
            <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
          ) : !rows.length ? (
            <EmptyState
              icon={<KeyRound className="size-6" />}
              title={t("Bạn chưa có API key nào")}
              description={t("Tạo một key để bắt đầu gọi API từ hệ thống của bạn.")}
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus /> {t("Tạo API key")}
                </Button>
              }
            />
          ) : (
            <ul className="-mx-1 divide-y">
              {rows.map((k) => (
                <li key={k.id} className="flex items-start gap-3 px-1 py-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {k.name}
                      <StatusBadge status={k.status} map={KEY_STATUS} />
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{k.prefix}••••••••</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("Tạo lúc {time}", { time: fmt.dateTime(k.createdAt) })}
                      {" · "}
                      {k.lastUsedAt ? t("Dùng lần cuối {time}", { time: fmt.dateTime(k.lastUsedAt) }) : t("Chưa dùng")}
                      {k.expiresAt && ` · ${t("Hết hạn {time}", { time: fmt.dateTime(k.expiresAt) })}`}
                    </p>
                  </div>
                  {k.status === "active" && (
                    <Button size="icon-sm" variant="ghost" aria-label={t("Thu hồi")} title={t("Thu hồi")} onClick={() => setRevoking(k)}>
                      <Trash2 className="text-destructive" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 flex gap-2 rounded-xl bg-warning-soft p-3 text-xs text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            {t("Giữ bí mật API key, chỉ dùng ở máy chủ của bạn (không nhúng vào trang web hay ứng dụng phía người dùng). Key lộ ra hãy thu hồi ngay và tạo key mới.")}
          </p>
        </section>

        {/* hướng dẫn tích hợp chuẩn */}
        <section className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 shadow-xs md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold">{t("Bắt đầu nhanh — Chuẩn REST API /v1")}</h3>
            <Link href="/api-docs#model-list" className="text-xs font-semibold text-primary hover:underline">
              {t("Tra cứu mã model & tham số →")}
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-semibold">{t("Địa chỉ gốc (Base URL)")}</p>
              <div className="flex items-center gap-1 rounded-xl border bg-muted/60 p-1 pl-3">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{base}</code>
                <CopyButton value={base} label={t("Địa chỉ API")} />
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold">{t("Header xác thực (hỗ trợ cả 2 cách)")}</p>
              <div className="rounded-xl border bg-muted/60 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
                <div>X-API-Key: &lt;YOUR_API_KEY&gt;</div>
                <div className="text-muted-foreground">Authorization: Bearer &lt;YOUR_API_KEY&gt;</div>
              </div>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold">{t("Các Endpoint chính thức")}</p>
            <div className="overflow-x-auto rounded-xl border text-xs">
              <table className="w-full text-left">
                <tbody className="divide-y">
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/v1/models/groups</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Danh mục gộp chuẩn Model → Server (SV1..SV15+) kèm giá & SV đề xuất")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/v1/models/{"{model}"}/servers</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Kiểm tra danh sách SV sống (healthy / maintenance) & giá của 1 model")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/v1/models</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Danh sách toàn bộ model đang mở (kèm server_id, server_status & bảng giá)")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/v1/models/{"{id}"}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Chi tiết đầy đủ tham số đầu vào (params) của 1 model")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold text-primary">POST</span>/v1/generations/estimate</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Ước tính chính xác số tiền VNĐ trước khi chạy (không trừ tiền)")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold text-primary">POST</span>/v1/generations</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Tạo tác vụ AI mới — trả ngay id/code (lỗi tự động hoàn 100% tiền về ví)")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/v1/generations/{"{id}"}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Kiểm tra tiến độ (queued → processing → succeeded) & nhận link file")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold text-primary">POST</span>/account/ai/uploads</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Upload file ảnh / video / âm thanh mẫu từ máy chủ của bạn (multipart/form-data)")}</td>
                  </tr>
                  <tr>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap"><span className="mr-1.5 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">GET</span>/account/credits</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{t("Kiểm tra số dư ví hiện tại (VNĐ) & hạn mức số luồng chạy song song")}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">{t("Ví dụ tích hợp thực tế")}</p>
              <div className="inline-flex rounded-lg border bg-muted/50 p-0.5 text-[11px] font-semibold">
                {(
                  [
                    ["curl", "cURL"],
                    ["python", "Python"],
                    ["node", "Node.js"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setLang(k)}
                    className={cn(
                      "rounded-md px-2.5 py-1 transition",
                      lang === k ? "bg-foreground text-background shadow-2xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative">
              <pre className="max-h-72 overflow-auto rounded-xl border bg-muted/70 p-3 pr-11 font-mono text-[11.5px] leading-relaxed">
                {snippets[lang]}
              </pre>
              <CopyButton value={snippets[lang]} label={t("Code mẫu")} className="absolute top-2 right-2" />
            </div>
          </div>

          <Button variant="default" className="w-full" asChild>
            <Link href="/api-docs">
              <BookOpen /> {t("Mở Tài liệu API đầy đủ & Bảng giá chi tiết từng Model")}
            </Link>
          </Button>
        </section>
      </div>

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(k) => {
            setCreateOpen(false);
            setCreated(k);
            setLastCreatedKey(k.key);
            void qc.invalidateQueries({ queryKey: ["api-keys"] });
          }}
        />
      )}
      {created && <CreatedDialog item={created} onClose={() => setCreated(null)} />}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t("Thu hồi API key \"{name}\"?", { name: revoking?.name ?? "" })}
        description={t("Hệ thống đang dùng key này sẽ không gọi API được nữa. Không thể hoàn tác.")}
        confirmText={t("Thu hồi")}
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}

/** Hộp thoại tạo key: tên gợi nhớ + hạn dùng */
function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (k: ApiKeyCreated) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [days, setDays] = useState(0);
  const create = useMutation({
    mutationFn: () =>
      api.post<ApiKeyCreated>("/account/api-keys", {
        name: name.trim(),
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
      }),
    onSuccess: onCreated,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Tạo API key")}</DialogTitle>
          <DialogDescription>{t("Đặt tên để dễ nhận biết key dùng ở đâu (vd: Website bán hàng, Bot Telegram, Tool tự động).")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="key-name">{t("Tên key")}</Label>
            <Input id="key-name" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("Hạn dùng")}</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {EXPIRY_OPTIONS.map((o) => (
                <Button key={o.days} type="button" size="sm" variant={days === o.days ? "default" : "outline"} onClick={() => setDays(o.days)}>
                  {t(o.label)}
                </Button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Huỷ")}
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Spinner />}
              {t("Tạo key")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Hiện key đầy đủ một lần duy nhất sau khi tạo */
function CreatedDialog({ item, onClose }: { item: ApiKeyCreated; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Đã tạo API key \"{name}\"", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("Sao chép và lưu key ở nơi an toàn. Vì lý do bảo mật, key chỉ hiện đúng một lần này.")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1 rounded-xl bg-muted p-1 pl-3">
          <code className="min-w-0 flex-1 break-all text-sm">{item.key}</code>
          <CopyButton value={item.key} label={t("API key")} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("Tôi đã lưu key")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
