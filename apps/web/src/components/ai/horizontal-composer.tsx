"use client";

/**
 * Thanh soạn thảo dạng ngang kiểu KlingAI / Sora (`?layout=horizontal`):
 * - Hàng trên: cụm ô vuông nhỏ tải ảnh/video mẫu bên trái + vùng nhập prompt (hoặc dán nhanh link video TikTok/Douyin) bên phải.
 * - Khi bật "Làm nhiều cặp": hiện bảng tư liệu thu gọn kiểu VeoVip (#1, #2... với ô chữ nhật nhỏ gọn + kéo thả hàng loạt, không phình to).
 * - Tối ưu hiển thị mượt trên cả Desktop lẫn iPhone / điện thoại màn hình nhỏ.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  FileAudio,
  FileVideo,
  ImagePlus,
  Layers,
  Lightbulb,
  Link2,
  Loader2,
  Minus,
  Paperclip,
  Plus,
  Sparkles,
  Trash2,
  Wallet,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { pairReady, type PairRow } from "@/components/ai/pair-list";
import { ToolForm, fieldOptions, fieldVisible, type FormValues } from "@/components/ai/tool-form";
import { VisibilityPicker } from "@/components/ai/visibility";
import { api, errorMessage } from "@/lib/api";
import { groupsOf, modelLogoOf, pricingText, toolHref, ToolIcon } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiField, AiTool } from "@/lib/types";

const FILE_TYPES = new Set(["image", "video", "audio", "file"]);

export interface HorizontalComposerProps {
  tool: AiTool;
  models: AiTool[];
  modelPrices: (number | undefined)[];
  promptField?: AiField;
  values: FormValues;
  onChangeValues: (next: FormValues) => void;
  pairCfg: { fields: string[]; max?: number; linkField?: string } | null;
  pairFields: AiField[];
  pairs: PairRow[];
  onChangePairs: (rows: PairRow[]) => void;
  copies: number;
  maxCopies: number;
  onChangeCopies: (n: number) => void;
  inputsCount: number;
  price: number | undefined;
  balance: number;
  enough: boolean;
  quoteFetching: boolean;
  quoteError: string | null;
  isPublic: boolean;
  onChangePublic: (v: boolean) => void;
  submitting: boolean;
  onSubmit: () => void;
  demoMedia?: React.ReactNode;
}

export function HorizontalComposer({
  tool,
  models,
  modelPrices,
  promptField: pf,
  values,
  onChangeValues,
  pairCfg,
  pairFields,
  pairs,
  onChangePairs,
  copies,
  maxCopies,
  onChangeCopies,
  inputsCount,
  price,
  balance,
  enough,
  quoteFetching,
  quoteError,
  isPublic,
  onChangePublic,
  submitting,
  onSubmit,
  demoMedia,
}: HorizontalComposerProps) {
  const { t, fmt } = useI18n();
  const router = useRouter();
  const [multiPairOpen, setMultiPairOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const setField = (name: string, val: unknown) => {
    const next: FormValues = { ...values, [name]: val };
    const changed = new Set([name]);
    for (const f of tool.fields) {
      if (!f.optionsBy || !changed.has(f.optionsBy.field)) continue;
      const opts = fieldOptions(f, next);
      if (!opts.some((o) => o.value === next[f.name])) {
        next[f.name] = opts[0]?.value;
        changed.add(f.name);
      }
    }
    onChangeValues(next);
  };

  // Các ô file hiển thị thành ô vuông bên trái (nếu là công cụ theo cặp như Motion Control thì lấy từ hàng cặp #1)
  const visibleFields = tool.fields.filter((f) => !f.hidden && fieldVisible(f, values, tool.fields));
  const standaloneFileFields = pairCfg ? [] : visibleFields.filter((f) => FILE_TYPES.has(f.type));
  const optionFields = visibleFields.filter(
    (f) => !FILE_TYPES.has(f.type) && (!pf || f.name !== pf.name) && !(pairCfg && pairCfg.fields.includes(f.name)),
  );
  const simpleSelects = optionFields.filter((f) => (f.type === "select" && !f.picker) || f.type === "boolean");
  const complexFields = optionFields.filter((f) => !simpleSelects.includes(f));

  const firstPair = pairs[0] ?? {};
  const setFirstPairCell = (name: string, url: string | undefined) => {
    const next = pairs.length ? [...pairs] : [{}];
    next[0] = { ...next[0], [name]: url };
    onChangePairs(next);
  };
  const readyPairCount = pairCfg ? pairs.filter((r) => pairReady(r, pairCfg.fields)).length : 0;

  const activeLogo = modelLogoOf(tool.modelLabel || tool.name);
  const switchModel = (m: AiTool) => {
    if (m.key === tool.key) return;
    const promptVal = pf ? String(values[pf.name] ?? "").trim() : "";
    router.replace(
      toolHref(m.key, {
        g: groupsOf(m).length > 1 ? (tool.group ?? undefined) : undefined,
        prompt: promptVal || undefined,
        layout: "horizontal",
      }),
      { scroll: false },
    );
  };

  const toggleMultiPair = () => {
    setMultiPairOpen((prev) => {
      const nextOpen = !prev;
      // Mở danh sách nhiều cặp lần đầu -> tạo sẵn 2 dòng để khách thấy ngay bố cục nhiều cặp gọn gàng
      if (nextOpen && pairCfg && pairs.length < 2) {
        onChangePairs([...(pairs.length ? pairs : [{}]), {}]);
      }
      return nextOpen;
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!tool.maintenance) onSubmit();
      }}
      className="mx-auto w-full max-w-5xl space-y-3"
    >
      {demoMedia}

      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card/95 p-3.5 shadow-xl shadow-black/5 backdrop-blur-md sm:rounded-3xl sm:p-5 dark:border-white/10 dark:bg-[#17181d]">
        {/* Hàng chính: cụm ô vuông nhỏ tải media bên trái + vùng nhập prompt / link nhanh bên phải */}
        <div className="flex flex-col gap-3.5 md:flex-row md:items-stretch md:gap-4">
          {!multiPairOpen && (pairFields.length > 0 || standaloneFileFields.length > 0) && (
            <div className="flex shrink-0 flex-wrap items-start gap-2.5 md:border-r md:border-border/60 md:pr-4 dark:md:border-white/10">
              {pairCfg
                ? pairFields.map((f) => (
                    <CompactUploadTile
                      key={f.name}
                      field={f}
                      value={firstPair[f.name]}
                      onChange={(u) => setFirstPairCell(f.name, u)}
                      disabled={submitting}
                    />
                  ))
                : standaloneFileFields.map((f) =>
                    f.multiple ? (
                      <CompactMultiUploadTiles
                        key={f.name}
                        field={f}
                        values={Array.isArray(values[f.name]) ? (values[f.name] as string[]) : values[f.name] ? [String(values[f.name])] : []}
                        onChange={(list) => setField(f.name, list)}
                        disabled={submitting}
                      />
                    ) : (
                      <CompactUploadTile
                        key={f.name}
                        field={f}
                        value={Array.isArray(values[f.name]) ? (values[f.name] as string[])[0] : (values[f.name] as string | undefined)}
                        onChange={(u) => setField(f.name, u)}
                        disabled={submitting}
                      />
                    ),
                  )}
            </div>
          )}

          {/* Vùng phải: ô nhập prompt rộng (hoặc hướng dẫn + ô dán link TikTok cho công cụ không có prompt như Motion Control) */}
          {(pf || !multiPairOpen) && (
            <div className="flex min-h-[76px] min-w-0 flex-1 flex-col justify-between sm:min-h-[92px]">
              {pf ? (
                <textarea
                  value={String(values[pf.name] ?? "")}
                  maxLength={pf.max}
                  rows={3}
                  disabled={submitting}
                  placeholder={pf.placeholder ? t(pf.placeholder) : t(pf.label)}
                  onChange={(e) => setField(pf.name, e.target.value)}
                  className="w-full flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:text-[14.5px]"
                />
              ) : (
                <div className="flex flex-1 flex-col justify-center gap-2">
                  <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    {tool.description ? t(tool.description) : t("Tải ảnh nhân vật và chọn video chuyển động mẫu ở bên trái. Nội dung sẽ được AI tạo tự động.")}
                  </p>
                  {pairCfg?.linkField && (
                    <QuickVideoUrlBar
                      disabled={submitting}
                      onUploaded={(url) => setFirstPairCell(pairCfg.linkField!, url)}
                    />
                  )}
                </div>
              )}
              {pf && (
                <div className="mt-1 text-right text-[11px] text-muted-foreground/70 tabular-nums">
                  {pf.max
                    ? `${String(values[pf.name] ?? "").length.toLocaleString("vi-VN")} / ${pf.max.toLocaleString("vi-VN")}`
                    : `${String(values[pf.name] ?? "").length.toLocaleString("vi-VN")} ${t("ký tự")} · ${t("Không giới hạn")}`}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Danh sách nhiều cặp thu gọn kiểu VeoVip (hàng ngang nhỏ gọn ~60px, cuộn mượt, không phình thành ô 400px) */}
        {pairCfg && multiPairOpen && (
          <div className={cn(pf && "mt-3.5")}>
            <CompactPairTable
              fields={pairFields}
              rows={pairs}
              onChange={onChangePairs}
              max={pairCfg.max ?? 10}
              linkField={pairCfg.linkField}
              disabled={submitting}
            />
          </div>
        )}

        {complexFields.length > 0 && moreOpen && (
          <div className="mt-3.5 rounded-2xl border bg-muted/20 p-3.5 dark:border-white/10">
            <ToolForm fields={complexFields} values={values} onChange={(part) => onChangeValues({ ...values, ...part })} disabled={submitting} />
          </div>
        )}

        {/* Thanh điều khiển đáy kiểu KlingAI: các pill chọn model & thông số bên trái + nút Tạo màu xanh lá bên phải */}
        <div className="mt-3.5 flex flex-col gap-2.5 border-t border-border/60 pt-3 sm:mt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:pt-3.5 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Pill chọn Model AI */}
            {models.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={submitting}
                    className="inline-flex h-8 max-w-[205px] items-center gap-1.5 rounded-xl border bg-muted/50 px-2.5 text-xs font-semibold text-foreground transition hover:border-foreground/30 hover:bg-muted sm:h-9 sm:max-w-[260px] sm:gap-2 sm:px-3 dark:border-white/10 dark:bg-white/[0.06]"
                  >
                    {activeLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={activeLogo} alt="" className="size-4 shrink-0 rounded-sm bg-white p-0.5" />
                    ) : (
                      <ToolIcon name={tool.icon} className="size-3.5 shrink-0 text-primary" />
                    )}
                    <span className="truncate">{t(tool.modelLabel || tool.name)}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-1.5">
                  {models.map((m, idx) => {
                    const active = m.key === tool.key;
                    const logo = modelLogoOf(m.modelLabel || m.name);
                    const mp = modelPrices[idx] ?? m.price;
                    return (
                      <DropdownMenuItem
                        key={m.key}
                        onSelect={() => switchModel(m)}
                        className={cn("flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs", active && "bg-primary/10 font-semibold text-primary")}
                      >
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logo} alt="" className="size-5 shrink-0 rounded-md border bg-white p-0.5" />
                        ) : (
                          <ToolIcon name={m.icon} className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{t(m.modelLabel || m.name)}</span>
                          <span className="block text-[10.5px] text-muted-foreground">
                            {mp != null ? (mp > 0 ? fmt.price(mp) : t("Miễn phí")) : pricingText(m, t, fmt.price)}
                          </span>
                        </span>
                        {m.maintenance ? (
                          <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-bold text-amber-700 dark:text-amber-300">{t("Đang bảo trì")}</span>
                        ) : (
                          m.badge && <span className="shrink-0 rounded-full bg-foreground px-1.5 py-0.5 text-[9.5px] font-bold text-background uppercase">{t(m.badge)}</span>
                        )}
                        {active && <Check className="size-3.5 shrink-0 text-primary" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-xl border bg-muted/40 px-2.5 text-xs font-semibold sm:h-9 sm:px-3 dark:border-white/10 dark:bg-white/[0.05]">
                <Sparkles className="size-3.5 text-primary" /> {t(tool.name)}
              </span>
            )}

            {/* Các pill chọn thông số nhanh (độ phân giải, tỉ lệ, thời lượng, âm thanh...) */}
            {simpleSelects.map((f) => {
              if (f.type === "boolean") {
                return (
                  <label
                    key={f.name}
                    className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-xl border bg-muted/40 px-2.5 text-xs font-medium transition hover:bg-muted sm:h-9 sm:px-3 dark:border-white/10 dark:bg-white/[0.05]"
                  >
                    <span>{t(f.label)}</span>
                    <Switch size="sm" checked={values[f.name] === true} onCheckedChange={(v) => setField(f.name, v)} disabled={submitting} />
                  </label>
                );
              }
              const opts = fieldOptions(f, values);
              if (!opts.length) return null;
              const cur = opts.find((o) => o.value === String(values[f.name] ?? "")) ?? opts[0];
              return (
                <DropdownMenu key={f.name}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={submitting}
                      title={t(f.label)}
                      className="inline-flex h-8 items-center gap-1 rounded-xl border bg-muted/40 px-2.5 text-xs font-medium text-foreground/90 transition hover:border-foreground/30 hover:bg-muted sm:h-9 sm:gap-1.5 sm:px-3 dark:border-white/10 dark:bg-white/[0.05]"
                    >
                      <span className="text-muted-foreground">{t(f.label)}:</span>
                      <span className="max-w-[120px] truncate font-semibold text-foreground sm:max-w-[140px]">{cur ? t(cur.label) : "—"}</span>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 min-w-44 overflow-y-auto rounded-xl p-1">
                    {opts.map((o) => (
                      <DropdownMenuItem
                        key={o.value}
                        onSelect={() => setField(f.name, o.value)}
                        className={cn("flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-xs", cur?.value === o.value && "bg-muted font-semibold")}
                      >
                        <span>{t(o.label)}</span>
                        {cur?.value === o.value && <Check className="size-3.5 text-primary" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })}

            {/* Pill số bản nhân bản */}
            {maxCopies > 1 && (
              <div className="inline-flex h-8 items-center rounded-xl border bg-muted/40 px-1 text-xs sm:h-9 sm:px-1.5 dark:border-white/10 dark:bg-white/[0.05]" title={t("Số lượng nhân bản")}>
                <button
                  type="button"
                  disabled={submitting || copies <= 1}
                  onClick={() => onChangeCopies(Math.max(1, copies - 1))}
                  className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  <Minus className="size-3" />
                </button>
                <span className="px-1.5 font-semibold tabular-nums">×{copies}</span>
                <button
                  type="button"
                  disabled={submitting || copies >= maxCopies}
                  onClick={() => onChangeCopies(Math.min(maxCopies, copies + 1))}
                  className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="size-3" />
                </button>
              </div>
            )}

            {/* Pill mở danh sách làm nhiều cặp */}
            {pairCfg && (
              <button
                type="button"
                onClick={toggleMultiPair}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition sm:h-9 sm:px-3",
                  multiPairOpen
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "bg-muted/40 text-foreground/85 hover:bg-muted dark:border-white/10 dark:bg-white/[0.05]",
                )}
              >
                <Layers className="size-3.5" />
                <span>{readyPairCount > 1 ? t("{n} cặp sẵn sàng chạy", { n: readyPairCount }) : t("Làm nhiều cặp")}</span>
                <ChevronDown className={cn("size-3.5 transition", multiPairOpen && "rotate-180")} />
              </button>
            )}

            {complexFields.length > 0 && (
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1 rounded-xl border bg-muted/40 px-2.5 text-xs font-medium hover:bg-muted sm:h-9 sm:px-3 dark:border-white/10 dark:bg-white/[0.05]"
              >
                <span>{t("Tuỳ chọn thêm")}</span>
                <ChevronDown className={cn("size-3.5 transition", moreOpen && "rotate-180")} />
              </button>
            )}
          </div>

          {/* Cụm bên phải: quyền riêng tư + giá + nút Generate kiểu KlingAI (trên iPhone dàn đều toàn hàng dưới cực gọn) */}
          <div className="flex w-full items-center justify-between gap-2.5 border-t border-border/40 pt-2.5 sm:ml-auto sm:w-auto sm:justify-end sm:border-t-0 sm:pt-0 dark:border-white/10">
            <div className="flex items-center gap-2">
              <VisibilityPicker value={isPublic} onChange={onChangePublic} disabled={submitting} align="end" className="size-8 rounded-xl sm:size-9" />
              <div className="flex flex-col items-start pr-0.5 leading-tight sm:items-end">
                <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums">
                  {quoteFetching ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : <Coins className="size-3.5 text-amber-500" />}
                  {price !== undefined ? fmt.money(price) : "—"}
                </span>
                <span className={cn("text-[10px] tabular-nums", enough ? "text-muted-foreground" : "text-red-500")}>
                  {t("Số dư")}: {fmt.money(balance)}
                </span>
              </div>
            </div>
            {tool.maintenance ? (
              <button
                type="button"
                disabled
                className="inline-flex h-9 cursor-not-allowed items-center justify-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 text-xs font-bold text-amber-700 sm:h-10 sm:px-5 sm:text-sm dark:border-amber-400/35 dark:text-amber-300"
              >
                <Wrench className="size-4" />
                {t("Đang bảo trì")}
              </button>
            ) : enough ? (
              <button
                type="submit"
                disabled={submitting || !!quoteError}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-lime-400 to-emerald-400 px-4 text-xs font-bold text-zinc-950 shadow-md shadow-emerald-500/20 transition hover:brightness-105 disabled:opacity-50 sm:h-10 sm:px-5 sm:text-sm"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                {submitting ? t("Đang gửi...") : inputsCount > 1 ? t("Tạo {n} kết quả", { n: inputsCount }) : t("Tạo ngay")}
              </button>
            ) : (
              <Link
                href="/pricing"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 text-xs font-bold text-zinc-950 transition hover:brightness-105 sm:h-10"
              >
                <Wallet className="size-3.5" /> {t("Nạp tiền")}
              </Link>
            )}
          </div>
        </div>

        {quoteError && (
          <div className="mt-2.5 rounded-xl bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {quoteError}
          </div>
        )}
      </div>
    </form>
  );
}

/**
 * Bảng tư liệu tạo nhiều cặp thu gọn kiểu VeoVip (theo ảnh tham chiếu 501.jpg):
 * Mỗi dòng chỉ cao ~68px gồm [#1] + [Ô file 1 chữ nhật nhỏ] + 🔗 + [Ô file 2 chữ nhật nhỏ] + [Thao tác xoá / dán link],
 * đặt trong khung cuộn mượt tối đa 340px và hỗ trợ kéo thả nhiều ảnh/video vào cùng lúc.
 */
function CompactPairTable({
  fields,
  rows,
  onChange,
  max,
  linkField,
  disabled,
}: {
  fields: AiField[];
  rows: PairRow[];
  onChange: (rows: PairRow[]) => void;
  max: number;
  linkField?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const names = fields.map((f) => f.name);
  const list = rows.length ? rows : [{}];
  const ready = list.filter((r) => pairReady(r, names)).length;
  const [linkRow, setLinkRow] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDrag, setBulkDrag] = useState(false);

  const setCell = (i: number, name: string, url: string | undefined) => {
    const next = list.map((r, j) => (j === i ? { ...r, [name]: url } : r));
    onChange(next);
  };

  const addRow = () => {
    if (list.length >= max) return;
    onChange([...list, {}]);
  };

  const removeRow = (idx: number) => {
    if (list.length <= 1) {
      onChange([{}]);
      return;
    }
    onChange(list.filter((_, j) => j !== idx));
  };

  // Kéo thả nhiều file ảnh / video vào khung -> tự phân loại điền lần lượt vào các ô còn trống
  const handleBulkDrop = async (fileList: FileList) => {
    const dropped = Array.from(fileList);
    if (!dropped.length || disabled || bulkBusy) return;
    const imgField = fields.find((f) => f.type === "image");
    const vidField = fields.find((f) => f.type === "video");
    if (!imgField && !vidField) return;

    setBulkBusy(true);
    try {
      const next = list.map((r) => ({ ...r }));
      let filled = 0;
      for (const file of dropped) {
        const target = file.type.startsWith("video/") ? vidField : file.type.startsWith("image/") ? imgField : undefined;
        if (!target) continue;
        let rowIdx = next.findIndex((r) => !r[target.name]);
        if (rowIdx === -1) {
          if (next.length >= max) continue;
          next.push({});
          rowIdx = next.length - 1;
        }
        const fd = new FormData();
        fd.append("file", file);
        const res = await api.post<{ url: string }>("/account/ai/uploads", fd);
        next[rowIdx][target.name] = res.url;
        filled++;
      }
      if (filled > 0) {
        onChange(next);
        toast.success(t("Đã tự động điền {n} file vào danh sách cặp", { n: filled }));
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBulkBusy(false);
    }
  };

  const shortLabel = (f: AiField) => t(f.label).replace(/\s*\(.*?\)\s*/g, "").trim();

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setBulkDrag(true);
      }}
      onDragLeave={() => setBulkDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setBulkDrag(false);
        if (e.dataTransfer.files.length > 1) {
          void handleBulkDrop(e.dataTransfer.files);
        }
      }}
      className={cn(
        "overflow-hidden rounded-2xl border bg-muted/20 transition dark:border-white/10 dark:bg-[#12141a]",
        bulkDrag && "border-amber-400 ring-1 ring-amber-400/30",
      )}
    >
      {/* Header giống VeoVip: Tiêu đề + tiến độ bên trái, nút Thêm cặp màu vàng nổi bật bên phải */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2.5 sm:px-4 dark:border-white/[0.07]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-xs font-bold text-foreground sm:text-[13.5px]">{t("Danh sách tư liệu tạo video")}</span>
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {t("(Tối đa {n} cặp ảnh & video)", { n: max })}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("Đã chọn {ready}/{max} cặp · Bạn có thể kéo thả nhiều ảnh hoặc video vào khung bên dưới.", { ready, max })}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || bulkBusy || list.length >= max}
          onClick={addRow}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-amber-400 px-3 text-xs font-bold text-zinc-950 shadow-xs transition hover:bg-amber-300 disabled:opacity-45"
        >
          {bulkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t("Thêm cặp ảnh & video")}
        </button>
      </div>

      {/* Header cột trên màn hình >= sm */}
      <div className="hidden grid-cols-[44px_1fr_28px_1fr_64px] items-center gap-2 border-b border-border/50 bg-muted/30 px-4 py-1.5 text-[11px] font-medium text-muted-foreground sm:grid dark:border-white/[0.06] dark:bg-white/[0.02]">
        <span>#</span>
        <span>{fields[0] ? shortLabel(fields[0]) : ""}</span>
        <span />
        <span>{fields[1] ? shortLabel(fields[1]) : ""}</span>
        <span className="text-right">{t("Thao tác")}</span>
      </div>

      {/* Danh sách dòng cặp nhỏ gọn, có thanh cuộn dọc mượt */}
      <div className="max-h-[320px] divide-y divide-border/50 overflow-y-auto dark:divide-white/[0.06]">
        {list.map((row, idx) => {
          const isReady = pairReady(row, names);
          const showLinkInput = linkRow === idx && linkField && names.includes(linkField);
          return (
            <div
              key={idx}
              className={cn(
                "px-3 py-2.5 transition sm:px-4",
                isReady && "bg-emerald-500/[0.04]",
              )}
            >
              <div className="flex items-center justify-between gap-2 sm:grid sm:grid-cols-[44px_1fr_28px_1fr_64px]">
                {/* Số thứ tự #1, #2 */}
                <span className="inline-flex h-7 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 text-[11px] font-bold tabular-nums text-foreground/90 dark:bg-white/[0.07]">
                  #{idx + 1}
                </span>

                {/* Ô file 1 */}
                {fields[0] && (
                  <div className="min-w-0">
                    <span className="mb-1 block truncate text-[10.5px] font-semibold text-foreground/80">{shortLabel(fields[0])}</span>
                    <MiniPairCell
                      field={fields[0]}
                      value={row[fields[0].name]}
                      onChange={(u) => setCell(idx, fields[0].name, u)}
                      disabled={disabled}
                    />
                  </div>
                )}

                {/* Biểu tượng liên kết ở giữa 2 ô */}
                <div className="flex shrink-0 items-center justify-center pt-4 text-muted-foreground/60">
                  <Link2 className="size-3.5 sm:size-4" />
                </div>

                {/* Ô file 2 */}
                {fields[1] ? (
                  <div className="min-w-0">
                    <span className="mb-1 block truncate text-[10.5px] font-semibold text-foreground/80">{shortLabel(fields[1])}</span>
                    <MiniPairCell
                      field={fields[1]}
                      value={row[fields[1].name]}
                      onChange={(u) => setCell(idx, fields[1].name, u)}
                      disabled={disabled}
                    />
                  </div>
                ) : (
                  <div />
                )}

                {/* Thao tác: nút mở ô dán link TikTok cho dòng này + nút thùng rác xoá dòng */}
                <div className="flex shrink-0 items-center justify-end gap-1 pt-4">
                  {linkField && names.includes(linkField) && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setLinkRow(linkRow === idx ? null : idx)}
                      title={t("Dán link")}
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-lg transition",
                        linkRow === idx ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Link2 className="size-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeRow(idx)}
                    title={t("Xoá dòng")}
                    className="inline-flex size-7 items-center justify-center rounded-lg text-rose-500/80 transition hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-35"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>

              {showLinkInput && (
                <div className="mt-2 sm:pl-[44px]">
                  <QuickVideoUrlBar
                    disabled={disabled}
                    onUploaded={(url) => {
                      setCell(idx, linkField!, url);
                      setLinkRow(null);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Chân bảng gợi ý */}
      <div className="flex items-center gap-1.5 border-t border-border/50 bg-muted/20 px-3.5 py-2 text-[11px] text-muted-foreground sm:px-4 dark:border-white/[0.06]">
        <Lightbulb className="size-3.5 shrink-0 text-amber-500" />
        <span>{t("Mỗi cặp ảnh - video hoàn chỉnh sẽ tạo ra một kết quả tương ứng")}</span>
      </div>
    </div>
  );
}

/** Ô chữ nhật nhỏ gọn (~96x52 trên iPhone, ~132x62 trên Desktop) trong bảng nhiều cặp kiểu VeoVip */
function MiniPairCell({
  field: f,
  value,
  onChange,
  disabled,
}: {
  field: AiField;
  value?: string;
  onChange: (url: string | undefined) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const isVideo = f.type === "video";

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post<{ url: string }>("/account/ai/uploads", fd);
      onChange(res.url);
    } catch (err) {
      toast.error(`${file.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        if (!disabled) void upload(e.dataTransfer.files[0]);
      }}
      className={cn(
        "group relative h-[52px] w-[88px] overflow-hidden rounded-xl border transition sm:h-[62px] sm:w-[136px]",
        value
          ? "border-border bg-black/90"
          : "border-dashed border-border/80 bg-background/60 hover:border-foreground/40 hover:bg-muted/60 dark:border-white/15 dark:bg-white/[0.03] dark:hover:bg-white/[0.07]",
        drag && "border-primary bg-primary/10",
      )}
    >
      {value ? (
        <>
          {isVideo ? (
            <video src={value} className="size-full object-cover" muted loop playsInline autoPlay />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="size-full object-cover" />
          )}
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/75 text-white hover:bg-black"
              aria-label="Remove"
            >
              <X className="size-3" />
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
          className="flex size-full items-center justify-center text-muted-foreground transition group-hover:text-foreground"
        >
          {busy ? <Loader2 className="size-4 animate-spin text-primary" /> : <Plus className="size-4" />}
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={f.accept}
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Cụm ô vuông tải nhiều ảnh theo đúng thứ tự `#1, #2, #3...` (hỗ trợ xếp theo tên file 1, 2, 3 và đổi chỗ ◀ ▶) */
function CompactMultiUploadTiles({
  field: f,
  values: urls,
  onChange,
  disabled,
}: {
  field: AiField;
  values: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const max = f.maxFiles ?? 5;
  const canAdd = urls.length < max;
  const shortLabel = t(f.label).replace(/\s*\(.*?\)\s*/g, "").trim();

  const upload = async (files?: FileList | File[]) => {
    if (!files?.length) return;
    const list = Array.from(files)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, Math.max(0, max - urls.length));
    if (!list.length) {
      toast.error(t("Tối đa {n} file").replace("{n}", String(max)));
      return;
    }
    setBusy(true);
    const done: string[] = [];
    try {
      for (const file of list) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await api.post<{ url: string }>("/account/ai/uploads", fd);
          done.push(res.url);
        } catch (err) {
          toast.error(`${file.name}: ${errorMessage(err)}`);
        }
      }
      if (done.length) onChange([...urls, ...done]);
    } finally {
      setBusy(false);
    }
  };

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= urls.length) return;
    const next = [...urls];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-start gap-2">
      {urls.map((url, idx) => (
        <div key={`${url}-${idx}`} className="group relative size-20 shrink-0 overflow-hidden rounded-2xl border border-border bg-black/90 sm:size-[84px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`#${idx + 1}`} className="size-full object-cover" />
          <span className="absolute top-1 left-1 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
            #{idx + 1}
          </span>
          {!disabled && (
            <>
              <button
                type="button"
                onClick={() => onChange(urls.filter((_, i) => i !== idx))}
                className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/75 text-white hover:bg-black"
                aria-label="Remove"
              >
                <X className="size-3" />
              </button>
              {urls.length > 1 && (
                <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => move(idx, -1)}
                    className="inline-flex size-5 items-center justify-center rounded bg-black/75 text-white disabled:opacity-30"
                    aria-label="Move left"
                  >
                    <ChevronLeft className="size-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === urls.length - 1}
                    onClick={() => move(idx, 1)}
                    className="inline-flex size-5 items-center justify-center rounded bg-black/75 text-white disabled:opacity-30"
                    aria-label="Move right"
                  >
                    <ChevronRight className="size-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {canAdd && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!disabled) void upload(e.dataTransfer.files);
          }}
          title={t(f.label)}
          className={cn(
            "group relative size-20 shrink-0 overflow-hidden rounded-2xl border border-dashed border-border/80 bg-muted/40 transition hover:border-foreground/40 hover:bg-muted/70 sm:size-[84px] dark:border-white/15 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]",
            drag && "border-primary bg-primary/10",
          )}
        >
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => input.current?.click()}
            className="flex size-full flex-col items-center justify-center gap-1 p-1.5 text-center"
          >
            {busy ? <Loader2 className="size-4 animate-spin text-primary" /> : <Plus className="size-4 text-foreground/80" />}
            <span className="line-clamp-2 text-[10px] font-medium leading-tight text-muted-foreground group-hover:text-foreground">
              {busy ? t("Đang tải lên...") : urls.length ? `${urls.length}/${max}` : shortLabel}
            </span>
          </button>
        </div>
      )}

      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={f.accept}
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Ô vuông nhỏ tải 1 file (ảnh / video / âm thanh) kiểu KlingAI ở góc trái hộp ngang */
function CompactUploadTile({
  field: f,
  value,
  count,
  onChange,
  disabled,
}: {
  field: AiField;
  value?: string;
  count?: number;
  onChange: (url: string | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const isVideo = f.type === "video";
  const isImage = f.type === "image";
  const Icon = isVideo ? FileVideo : f.type === "audio" ? FileAudio : isImage ? ImagePlus : Paperclip;

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post<{ url: string }>("/account/ai/uploads", fd);
      onChange(res.url);
    } catch (err) {
      toast.error(`${file.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Rút gọn nhãn dài (bỏ phần trong ngoặc) để vừa ô vuông 80–92px
  const shortLabel = t(f.label).replace(/\s*\(.*?\)\s*/g, "").trim();

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!disabled) void upload(e.dataTransfer.files[0]);
      }}
      title={t(f.label)}
      className={cn(
        "group relative size-20 shrink-0 overflow-hidden rounded-2xl border transition sm:size-[92px]",
        value
          ? "border-border bg-black/90"
          : "border-dashed border-border/80 bg-muted/40 hover:border-foreground/40 hover:bg-muted/70 dark:border-white/15 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]",
        drag && "border-primary bg-primary/10",
      )}
    >
      {value ? (
        <>
          {isVideo ? (
            <video src={value} className="size-full object-cover" muted loop playsInline autoPlay />
          ) : isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full flex-col items-center justify-center p-2 text-center text-[10px] text-white">
              <Icon className="mb-1 size-5" />
              <span className="line-clamp-2">{shortLabel}</span>
            </div>
          )}
          {count && count > 1 && (
            <span className="absolute bottom-1 left-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
              +{count}
            </span>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black"
              aria-label="Remove"
            >
              <X className="size-3" />
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
          className="flex size-full flex-col items-center justify-center gap-1 p-1.5 text-center sm:gap-1.5 sm:p-2"
        >
          {busy ? <Loader2 className="size-4 animate-spin text-primary sm:size-5" /> : <Plus className="size-4 text-foreground/80 sm:size-5" />}
          <span className="line-clamp-2 text-[10.5px] font-medium leading-tight text-muted-foreground group-hover:text-foreground sm:text-[11px]">
            {busy ? t("Đang tải lên...") : shortLabel}
          </span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={f.accept}
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Thanh dán nhanh link video TikTok / Douyin / MP4 ngay trong hộp ngang */
function QuickVideoUrlBar({ disabled, onUploaded }: { disabled?: boolean; onUploaded: (url: string) => void }) {
  const { t } = useI18n();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchVideo = async () => {
    const url = link.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ url: string }>("/account/ai/uploads/from-url", { url });
      onUploaded(res.url);
      setLink("");
      toast.success(t("Đã tải video từ link"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
      <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="url"
        value={link}
        disabled={disabled || busy}
        placeholder={t("Hoặc dán nhanh link video TikTok / Douyin / MP4 vào đây...")}
        onChange={(e) => setLink(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text")?.trim();
          if (pasted && /^https?:\/\//i.test(pasted)) {
            e.preventDefault();
            setLink(pasted);
            setBusy(true);
            api
              .post<{ url: string }>("/account/ai/uploads/from-url", { url: pasted })
              .then((res) => {
                onUploaded(res.url);
                setLink("");
                toast.success(t("Đã tải video từ link"));
              })
              .catch((err) => toast.error(errorMessage(err)))
              .finally(() => setBusy(false));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void fetchVideo();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
      />
      {(link.trim() || busy) && (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void fetchVideo()}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-lg bg-foreground px-2.5 text-[11px] font-semibold text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {busy ? t("Đang tải...") : t("Lấy video")}
        </button>
      )}
    </div>
  );
}
