"use client";

/**
 * Trang "Website con" (/child-panels) theo bố cục SMM Child Panels (smm.vn/child-panels) + biểu mẫu NovAI Hub:
 * - Trái: Hộp hướng dẫn trỏ bản ghi A (và www nếu muốn) về 103.200.22.81 + nút kiểm tra DNS trực tiếp + 5 trường khởi tạo đúng chuẩn ảnh tham chiếu.
 * - Phải: Quy trình 3 bước & quyền lợi Website con.
 * - Dưới: Bảng quản lý danh sách Website con của khách (trạng thái, link web/admin, xem & chép mật khẩu quản trị).
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Headphones,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { contactHref, findContactChannel, normalizeContactButtons } from "@cmsnt/shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, ErrorState, PageHeader } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useBootstrap, useCredits } from "@/lib/queries";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

interface ChildPanelConfig {
  enabled: boolean;
  vpsIp: string;
  price: number;
  minDeposit: number;
  autoApprove: boolean;
  maxPerUser: number;
}

interface ChildPanelItem {
  id: string;
  domain: string;
  siteName: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
  siteCode: string | null;
  fee: number;
  status: "PENDING" | "PROVISIONING" | "ACTIVE" | "REJECTED" | "FAILED";
  note: string | null;
  createdAt: string;
}

interface ChildPanelsResponse {
  config: ChildPanelConfig;
  totalDeposited: number;
  items: ChildPanelItem[];
}

interface DnsCheckResult {
  domain: string;
  vpsIp: string;
  ok: boolean;
  ips: string[];
  wwwOk: boolean;
  wwwIps: string[];
  error: string | null;
}

const STATUS_META: Record<ChildPanelItem["status"], { label: string; className: string; icon: typeof Clock }> = {
  PENDING: { label: "Chờ kích hoạt", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", icon: Clock },
  PROVISIONING: { label: "Đang khởi tạo", className: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300", icon: RefreshCw },
  ACTIVE: { label: "Đang hoạt động", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", icon: CheckCircle2 },
  REJECTED: { label: "Từ chối", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", icon: XCircle },
  FAILED: { label: "Cần kiểm tra", className: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300", icon: XCircle },
};

export default function ChildPanelsPage() {
  const { t, fmt } = useI18n();
  const qc = useQueryClient();
  const credits = useCredits();
  const boot = useBootstrap();

  const contactItems = useMemo(() => {
    const cfgContacts = normalizeContactButtons(boot.data?.settings?.contactButtons);
    if (!cfgContacts.enabled) return [];
    return cfgContacts.items
      .map((it) => ({
        key: it.key,
        label: it.label.trim() || findContactChannel(it.key)?.label || t("Liên hệ"),
        href: contactHref(it.key, it.url),
      }))
      .filter((it) => it.href);
  }, [boot.data?.settings?.contactButtons, t]);

  const [domain, setDomain] = useState("");
  const [siteName, setSiteName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [dnsInfo, setDnsInfo] = useState<DnsCheckResult | null>(null);
  const [dnsBusy, setDnsBusy] = useState(false);

  const q = useQuery({
    queryKey: ["child-panels"],
    queryFn: () => api.get<ChildPanelsResponse>("/account/child-panels"),
    refetchInterval: (query) =>
      query.state.data?.items?.some((x) => x.status === "PROVISIONING" || x.status === "PENDING") ? 10_000 : false,
  });

  const cfg = q.data?.config;
  const vpsIp = cfg?.vpsIp || "103.200.22.81";
  const balance = credits.data?.credits ?? 0;

  const cleanDomainInput = (raw: string) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");

  const verifyDns = async () => {
    const d = cleanDomainInput(domain);
    if (!d) {
      toast.error(t("Vui lòng nhập domain trước khi kiểm tra DNS"));
      return;
    }
    setDomain(d);
    setDnsBusy(true);
    try {
      const res = await api.get<DnsCheckResult>("/account/child-panels/check-dns", { domain: d });
      setDnsInfo(res);
      if (res.ok) toast.success(t("Domain {d} đã trỏ đúng bản ghi A về {ip}!", { d: res.domain, ip: res.vpsIp }));
      else toast.warning(t("Domain {d} chưa trỏ bản ghi A về {ip}", { d: res.domain, ip: res.vpsIp }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDnsBusy(false);
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<ChildPanelItem>("/account/child-panels", {
        domain: cleanDomainInput(domain),
        siteName: siteName.trim() || cleanDomainInput(domain),
        adminEmail: adminEmail.trim(),
        adminName: adminName.trim() || undefined,
        adminPassword: adminPassword.trim() || undefined,
      }),
    onSuccess: (created) => {
      toast.success(
        created.status === "PROVISIONING"
          ? t("Đã gửi yêu cầu và đang khởi tạo Website con tự động!")
          : t("Đã gửi yêu cầu tạo Website con! Vui lòng liên hệ Admin để được kích hoạt."),
      );
      setDomain("");
      setSiteName("");
      setAdminEmail("");
      setAdminName("");
      setAdminPassword("");
      setDnsInfo(null);
      void qc.invalidateQueries({ queryKey: ["child-panels"] });
      void qc.invalidateQueries({ queryKey: ["credits"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("Website con")}
          description={t("Khởi tạo website AI thương hiệu riêng trên tên miền của bạn.")}
          icon={<Globe className="size-5" />}
        />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("Website con")}
          description={t("Khởi tạo website AI thương hiệu riêng trên tên miền của bạn.")}
          icon={<Globe className="size-5" />}
        />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  }

  const items = q.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Website con")}
        description={t("Sở hữu website AI mang tên miền và thương hiệu riêng, đồng bộ tự động toàn bộ công cụ AI.")}
        icon={<Globe className="size-5" />}
      />

      {/* Lưới 2 cột kiểu SMM Child Panels: Trái = Bảng tạo web con · Phải = Hướng dẫn, Quyền lợi & Liên hệ kích hoạt */}
      <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
        {/* Khung biểu mẫu tạo Website con */}
        <section className="rounded-2xl border bg-card p-4 shadow-xs sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold sm:text-lg">{t("Khởi tạo Website con")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("Điền thông tin tên miền và tài khoản quản trị cho website con của bạn.")}
              </p>
            </div>
            {cfg && (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                {cfg.price > 0 ? fmt.money(cfg.price) : t("Miễn phí khởi tạo")}
              </span>
            )}
          </div>

          {/* Khung hướng dẫn trỏ bản ghi A (giống khung Nameservers của smm.vn/child-panels) */}
          <div className="mb-5 rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] p-3.5 sm:p-4">
            <div className="flex items-start gap-2.5">
              <Server className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
              <div className="min-w-0 flex-1 text-xs leading-relaxed">
                <p className="font-semibold text-foreground">
                  {t("Trỏ bản ghi A của domain (và www nếu muốn) về")} <span className="font-mono text-sky-600 dark:text-sky-400">{vpsIp}</span>
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("Vui lòng vào trang quản lý tên miền (Cloudflare, Tenten, Nhân Hoà, Namecheap...) cấu hình bản ghi A như sau trước khi bấm Tạo web con:")}
                </p>
                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-2 rounded-xl border bg-background/90 px-3 py-2">
                    <div className="min-w-0">
                      <span className="block text-[10.5px] text-muted-foreground">Host: @ · Type: A</span>
                      <span className="font-mono text-xs font-bold text-foreground">{vpsIp}</span>
                    </div>
                    <CopyButton value={vpsIp} label="IP" />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-xl border bg-background/90 px-3 py-2">
                    <div className="min-w-0">
                      <span className="block text-[10.5px] text-muted-foreground">{t("Host: www · Type: A (tuỳ chọn)")}</span>
                      <span className="font-mono text-xs font-bold text-foreground">{vpsIp}</span>
                    </div>
                    <CopyButton value={vpsIp} label="IP" />
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("Lưu ý: Nếu dùng Cloudflare, hãy tắt đám mây cam (chuyển sang DNS Only / đám mây xám) để hệ thống tự cài chứng chỉ SSL miễn phí.")}
                </p>
              </div>
            </div>
          </div>

          {/* Biểu mẫu 5 mục đúng chuẩn ảnh tham chiếu */}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {/* 1. Domain */}
            <div className="space-y-1.5">
              <Label htmlFor="cp-domain">{t("Domain (không có www, không có https://)")}</Label>
              <div className="flex gap-2">
                <Input
                  id="cp-domain"
                  required
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    if (dnsInfo) setDnsInfo(null);
                  }}
                  placeholder="vidu.com"
                  className="h-10 font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0"
                  disabled={dnsBusy || !domain.trim()}
                  onClick={() => void verifyDns()}
                >
                  {dnsBusy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  {t("Kiểm tra DNS")}
                </Button>
              </div>
              {dnsInfo && (
                <p className={cn("text-xs font-medium", dnsInfo.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                  {dnsInfo.ok
                    ? `✓ ${t("Đã trỏ đúng bản ghi A về")} ${dnsInfo.vpsIp}${dnsInfo.wwwOk ? " (+ www)" : ""}`
                    : `⚠ ${t("Chưa trỏ về")} ${dnsInfo.vpsIp} (${dnsInfo.ips.length ? dnsInfo.ips.join(", ") : t("chưa có bản ghi A")})`}
                </p>
              )}
            </div>

            {/* 2. Tên website */}
            <div className="space-y-1.5">
              <Label htmlFor="cp-sitename">{t("Tên website")}</Label>
              <Input
                id="cp-sitename"
                required
                maxLength={80}
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder={t("Tên hiện trên web")}
                className="h-10"
              />
            </div>

            {/* 3. Email admin web con */}
            <div className="space-y-1.5">
              <Label htmlFor="cp-email">{t("Email admin web con")}</Label>
              <Input
                id="cp-email"
                type="email"
                required
                maxLength={160}
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@vidu.com"
                className="h-10"
              />
            </div>

            {/* 4. Tên admin */}
            <div className="space-y-1.5">
              <Label htmlFor="cp-admin-name">{t("Tên admin")}</Label>
              <Input
                id="cp-admin-name"
                maxLength={80}
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder={t("Quản trị viên")}
                className="h-10"
              />
            </div>

            {/* 5. Mật khẩu admin */}
            <div className="space-y-1.5">
              <Label htmlFor="cp-admin-pw">{t("Mật khẩu admin (để trống = tự sinh)")}</Label>
              <div className="relative">
                <Input
                  id="cp-admin-pw"
                  type={showPw ? "text" : "password"}
                  minLength={10}
                  maxLength={100}
                  autoComplete="new-password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder={t("Tối thiểu 10 ký tự hoặc để trống hệ thống tự sinh")}
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Toggle password"
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {cfg && cfg.minDeposit > 0 && (
              <div className="rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t("Yêu cầu tổng nạp tối thiểu")}: <strong className="text-foreground">{fmt.money(cfg.minDeposit)}</strong> ·{" "}
                {t("Tổng nạp của bạn")}: <strong className="text-foreground">{fmt.money(q.data?.totalDeposited ?? 0)}</strong>
              </div>
            )}

            {cfg && cfg.price > 0 && (
              <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-3.5 py-2.5 text-xs">
                <span>
                  {t("Phí khởi tạo")}: <strong className="text-sm font-bold text-foreground">{fmt.money(cfg.price)}</strong>
                </span>
                <span>
                  {t("Số dư ví")}: <strong className={cn("font-semibold", balance >= cfg.price ? "text-foreground" : "text-red-500")}>{fmt.money(balance)}</strong>
                </span>
              </div>
            )}

            <div className="pt-1">
              <button
                type="submit"
                disabled={create.isPending || cfg?.enabled === false}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-50"
              >
                {create.isPending && <Loader2 className="size-4 animate-spin" />}
                {t("Tạo web con")}
              </button>
            </div>
          </form>
        </section>

        {/* Cột phải: Quy trình, Quyền lợi & Lưu ý liên hệ Admin kích hoạt (T-253) */}
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold sm:text-base">
              <Sparkles className="size-4 text-primary" /> {t("Quy trình kích hoạt 3 bước")}
            </h3>
            <ol className="mt-3.5 space-y-3 text-xs leading-relaxed">
              <li className="flex gap-3">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  1
                </span>
                <div>
                  <p className="font-semibold text-foreground">{t("Trỏ tên miền về máy chủ")}</p>
                  <p className="text-muted-foreground">
                    {t("Trỏ bản ghi A của domain (và www nếu muốn) về")} <code className="rounded bg-muted px-1 py-0.5 font-mono font-semibold text-foreground">{vpsIp}</code>.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  2
                </span>
                <div>
                  <p className="font-semibold text-foreground">{t("Điền thông tin & Gửi tạo")}</p>
                  <p className="text-muted-foreground">
                    {t("Nhập domain, tên website, email và mật khẩu quản trị rồi bấm nút Tạo web con.")}
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  3
                </span>
                <div>
                  <p className="font-semibold text-foreground">{t("Liên hệ Admin kích hoạt & Bàn giao SSL")}</p>
                  <p className="text-muted-foreground">
                    {t("Liên hệ Admin duyệt kích hoạt để hệ thống tự cài HTTPS miễn phí và cấp quyền truy cập trang quản trị /admin.")}
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <section className="rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold sm:text-base">
              <ShieldCheck className="size-4 text-emerald-500" /> {t("Tính năng có sẵn trên Website con")}
            </h3>
            <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                <span>{t("Giao diện AI Studio hiện đại, hỗ trợ 4 ngôn ngữ (Việt, Anh, Indonesia, Trung) và Sáng/Tối.")}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                <span>{t("Đồng bộ tự động 100% công cụ tạo Video AI, Motion Control, Tạo ảnh 4K, Giọng nói từ hệ thống chính.")}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                <span>{t("Trang quản trị riêng (https://domain-cua-ban/admin) để theo dõi thành viên, doanh thu và đơn tạo AI.")}</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                <span>{t("Miễn phí máy chủ vận hành 24/7 và tự động gia hạn chứng chỉ bảo mật SSL.")}</span>
              </li>
            </ul>
          </section>

          {/* Hộp nhắc liên hệ Admin để kích hoạt sau khi ấn Tạo web con (T-253) */}
          <section className="flex flex-1 flex-col justify-between rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 shadow-xs sm:p-5">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-foreground sm:text-base">
                <Headphones className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                {t("Liên hệ Admin để kích hoạt")}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t("Sau khi ấn")} <strong className="font-semibold text-foreground">{t("Tạo web con")}</strong>
                {t(", bạn vui lòng liên hệ Admin (gửi kèm tên miền vừa tạo) để được kiểm tra bản ghi DNS và kích hoạt Website con nhanh chóng nhé!")}
              </p>
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <Link
                href="/support?new=1"
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-foreground px-3.5 text-xs font-semibold text-background shadow-2xs transition hover:opacity-90"
              >
                <MessageSquarePlus className="size-3.5" />
                {t("Gửi Ticket kích hoạt")}
              </Link>
              {contactItems.map((c) => (
                <a
                  key={c.key}
                  href={c.href}
                  target={/^https?:/i.test(c.href) ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-background/90 px-3.5 text-xs font-semibold text-foreground transition hover:bg-background"
                >
                  {c.label}
                  <ExternalLink className="size-3 text-muted-foreground" />
                </a>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Bảng danh sách Website con của khách */}
      <section className="rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold sm:text-base">{t("Danh sách Website con của bạn")}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {items.length} / {cfg?.maxPerUser ?? 5}
          </span>
        </div>

        {!items.length ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("Bạn chưa đăng ký Website con nào. Hãy trỏ tên miền về IP bên trên và tạo ngay!")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[680px]">
              <TableHeader className="bg-muted/60">
                <TableRow>
                  <TableHead className="text-xs font-semibold">Domain</TableHead>
                  <TableHead className="text-xs font-semibold">{t("Tên website")}</TableHead>
                  <TableHead className="text-xs font-semibold">{t("Tài khoản Admin")}</TableHead>
                  <TableHead className="text-xs font-semibold">{t("Trạng thái")}</TableHead>
                  <TableHead className="text-xs font-semibold">{t("Thời gian")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const st = STATUS_META[item.status] ?? STATUS_META.PENDING;
                  const StIcon = st.icon;
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-mono text-xs font-bold sm:text-sm">{item.domain}</div>
                        {item.status === "ACTIVE" && (
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                            <a
                              href={`https://${item.domain}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-primary hover:underline"
                            >
                              {t("Mở web")} <ExternalLink className="size-3" />
                            </a>
                            <a
                              href={`https://${item.domain}/admin`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-primary hover:underline"
                            >
                              {t("Trang Admin")} <ExternalLink className="size-3" />
                            </a>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-medium sm:text-sm">{item.siteName}</TableCell>
                      <TableCell>
                        <div className="space-y-1 text-xs">
                          <div className="font-mono">{item.adminEmail}</div>
                          <PasswordReveal password={item.adminPassword} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", st.className)}>
                          <StIcon className={cn("size-3", item.status === "PROVISIONING" && "animate-spin")} />
                          {t(st.label)}
                        </span>
                        {item.note && <p className="mt-1 max-w-xs text-[11px] text-muted-foreground">{item.note}</p>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmt.dateTime(item.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function PasswordReveal({ password }: { password: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg bg-muted/70 px-2 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{t("Mật khẩu")}:</span>
      <span className="font-mono font-semibold">{open ? password : "••••••••••"}</span>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground" title={open ? "Hide" : "Show"}>
        {open ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
      </button>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(password).then(() => toast.success(t("Đã sao chép mật khẩu")));
        }}
        className="text-muted-foreground hover:text-foreground"
        title="Copy"
      >
        <Copy className="size-3" />
      </button>
    </div>
  );
}
