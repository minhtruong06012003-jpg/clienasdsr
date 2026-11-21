"use client";

/**
 * Form động của công cụ AI: dựng ô nhập theo `tool.fields` do API trả về (text, textarea, select, number,
 * công tắc, file ảnh / video / âm thanh). File được tải lên ngay khi chọn (POST /account/ai/uploads) và lưu URL vào giá trị.
 * Ô select phụ thuộc ô khác (`optionsBy`) tự chọn lựa chọn đầu tiên khi ô cha đổi; ô có `showIf` chỉ hiện khi khớp điều kiện.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FileAudio, FileVideo, ImagePlus, Loader2, Paperclip, Plus, Search, Trash2, Upload, Video, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiField, AiFieldOption } from "@/lib/types";
import { TemplatePicker } from "./template-picker";
import { VoicePicker } from "./voice-picker";

export type FormValues = Record<string, unknown>;

const FILE_TYPES = new Set(["image", "video", "audio", "file"]);

/**
 * Ô có đang hiện không (theo showIf). Truyền `fields` để xét cả ô cha: ô cha đang ẩn thì ô con cũng ẩn
 * (vd ô Giọng đọc chỉ hiện khi "Kiểu chọn giọng" hiện, mà ô đó lại chỉ hiện khi chọn "Chọn giọng đọc").
 */
export function fieldVisible(f: AiField, values: FormValues, fields?: AiField[], depth = 0): boolean {
  if (!f.showIf) return true;
  if (!f.showIf.in.includes(String(values[f.showIf.field] ?? ""))) return false;
  const parent = fields?.find((x) => x.name === f.showIf!.field);
  return !parent || depth > 5 || fieldVisible(parent, values, fields, depth + 1);
}

/** Lựa chọn thực tế của ô select */
export function fieldOptions(f: AiField, values: FormValues): AiFieldOption[] {
  if (f.optionsBy) return f.optionsBy.map[String(values[f.optionsBy.field] ?? "")] ?? [];
  return f.options ?? [];
}

/** Giá trị ban đầu: default của ô, select thì lựa chọn đầu tiên */
export function initialValues(fields: AiField[]): FormValues {
  const v: FormValues = {};
  for (const f of fields) if (f.default !== undefined) v[f.name] = f.default;
  for (const f of fields) {
    if (f.type === "select" && v[f.name] === undefined) {
      const opts = fieldOptions(f, v);
      if (opts.length && f.required) v[f.name] = opts[0].value;
    }
  }
  return v;
}

/** Số mô tả (prompt) tối đa gửi trong một lần bấm Tạo — mỗi mô tả tạo ra một tác vụ riêng */
export const MAX_PROMPTS = 8;

/**
 * Danh sách mô tả thực sự sẽ chạy: bỏ ô trống, bật "Mỗi dòng 1 mục" thì mỗi dòng của mỗi ô là một mô tả.
 * Cắt còn tối đa MAX_PROMPTS mục (`over` = số mục bị bỏ bớt để báo cho khách).
 */
export function promptItems(list: string[], perLine: boolean) {
  const all = (perLine ? list.flatMap((s) => s.split(/\r?\n/)) : list).map((s) => s.trim()).filter(Boolean);
  return { items: all.slice(0, MAX_PROMPTS), over: Math.max(0, all.length - MAX_PROMPTS) };
}

/**
 * Ô prompt nhiều mô tả: tối đa MAX_PROMPTS ô (thêm / xoá), công tắc "Mỗi dòng 1 mục" để tách mỗi dòng thành một mô tả.
 * Mỗi mô tả cho ra một kết quả riêng (trang công cụ gửi lần lượt từng tác vụ).
 */
export function PromptList({
  field: f,
  value,
  onChange,
  perLine,
  onPerLine,
  disabled,
}: {
  field: AiField;
  value: string[];
  onChange: (v: string[]) => void;
  perLine: boolean;
  onPerLine: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const list = value.length ? value : [""];
  const { items, over } = promptItems(list, perLine);
  const overMaxLines = f.max ? items.filter((s) => s.length > f.max!).length : 0;
  const setAt = (i: number, s: string) => onChange(list.map((x, j) => (x === list[j] && j === i ? s : j === i ? s : x)));
  const warnPasteLimit = (cur: string, el: HTMLTextAreaElement, pasted: string) => {
    if (perLine || !f.max || !pasted) return;
    const selLen = Math.max(0, (el.selectionEnd ?? cur.length) - (el.selectionStart ?? cur.length));
    if (cur.length - selLen + pasted.length > f.max) {
      toast.warning(t("Mô tả vượt giới hạn tối đa {max} ký tự của model này — phần dư đã được cắt bớt.", { max: f.max.toLocaleString("vi-VN") }));
    }
  };
  // bấm gợi ý (vd thể loại nhạc): ô mô tả 1 trống thì điền gợi ý, đã có chữ thì nối thêm sau dấu phẩy
  const pick = (v: string) => {
    const cur = list[0].trim();
    if (cur.includes(v)) return; // đã có gợi ý này rồi, không nối lặp
    const next = cur ? `${cur}, ${v}` : v;
    setAt(0, f.max && !perLine ? next.slice(0, f.max) : next);
  };
  return (
    <div>
      {f.suggestions?.options.length ? (
        <div className="mb-4">
          <div className="mb-1.5 text-[13px] font-semibold">{t(f.suggestions.label)}</div>
          <div className="flex flex-wrap justify-center gap-1.5 rounded-2xl border bg-muted/20 p-2">
            {f.suggestions.options.map((o) => (
              <button
                key={o.label}
                type="button"
                disabled={disabled}
                title={t(o.value)}
                onClick={() => pick(t(o.value))}
                className="h-8 rounded-lg px-3 text-[13px] font-medium text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {t(o.label)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold leading-snug text-foreground">
          {t(f.label)}
          {f.required && <span className="text-rose-500"> *</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
            <Switch size="sm" checked={perLine} onCheckedChange={onPerLine} disabled={disabled} />
            {t("Mỗi dòng 1 mục")}
          </label>
          <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">{t("{n}/{max} mô tả", { n: items.length, max: MAX_PROMPTS })}</span>
        </div>
      </div>
      <div className="space-y-2">
        {list.map((text, i) => (
          <div key={i} className="flex items-start gap-2">
            {list.length > 1 && <span className="w-4 shrink-0 pt-2.5 text-center text-[13px] font-semibold text-muted-foreground tabular-nums">{i + 1}</span>}
            <div className="min-w-0 flex-1">
              <Textarea
                value={text}
                maxLength={perLine ? undefined : f.max}
                rows={list.length > 1 ? 3 : 4}
                placeholder={f.placeholder ? t(f.placeholder) : undefined}
                onPaste={(e) => warnPasteLimit(text, e.currentTarget, e.clipboardData?.getData("text") ?? "")}
                onChange={(e) => setAt(i, e.target.value)}
                disabled={disabled}
                className={cn("resize-y rounded-2xl bg-muted/30 text-[13.5px] leading-relaxed focus-visible:bg-card", list.length > 1 ? "min-h-20" : "min-h-24")}
              />
              {list.length > 1 && f.max && !perLine && (
                <div className={cn("mt-0.5 text-right text-[10.5px] tabular-nums", text.length >= f.max ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                  {text.length.toLocaleString("vi-VN")} / {f.max.toLocaleString("vi-VN")} {t("ký tự")}
                </div>
              )}
            </div>
            {list.length > 1 && (
              <button type="button" disabled={disabled} onClick={() => onChange(list.filter((_, j) => j !== i))} className="mt-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-rose-600" aria-label={t("Xoá mô tả")}>
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            disabled={disabled || list.length >= MAX_PROMPTS}
            onClick={() => onChange([...list, ""])}
            title={t("Nhập tới {n} mô tả, mỗi mô tả cho ra 1 kết quả", { n: MAX_PROMPTS })}
            className="inline-flex h-7.5 shrink-0 items-center gap-1 rounded-lg border bg-card px-2.5 text-[12px] font-semibold transition hover:bg-muted disabled:opacity-50"
          >
            <Plus className="size-3.5" /> {t("Thêm mô tả")}
          </button>
          <span className="truncate text-[11px] text-muted-foreground">{t("Nhập tới {n} mô tả, mỗi mô tả cho ra 1 kết quả", { n: MAX_PROMPTS })}</span>
        </div>
        {list.length === 1 && !perLine && (
          <span className={cn("shrink-0 text-[11px] tabular-nums", f.max && list[0].length >= f.max ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
            {f.max
              ? `${list[0].length.toLocaleString("vi-VN")} / ${f.max.toLocaleString("vi-VN")} ${t("ký tự")}`
              : `${list[0].length.toLocaleString("vi-VN")} ${t("ký tự")} · ${t("Không giới hạn")}`}
          </span>
        )}
      </div>
      {over > 0 && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{t("Đã vượt {max} mô tả — chỉ {max} mô tả đầu được tạo, bỏ qua {n} mục còn lại.", { max: MAX_PROMPTS, n: over })}</p>}
      {perLine && overMaxLines > 0 && f.max && (
        <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
          {t("Có {n} dòng vượt quá giới hạn {max} ký tự của model này — vui lòng rút gọn trước khi tạo.", { n: overMaxLines, max: f.max.toLocaleString("vi-VN") })}
        </p>
      )}
      {f.help && <p className="mt-1 text-[11px] text-muted-foreground">{t(f.help)}</p>}
    </div>
  );
}

/**
 * Form động. `slots`: thay ô theo tên bằng nội dung tuỳ chỉnh (giữ đúng vị trí trong form),
 * vd trang công cụ thay ô prompt bằng PromptList.
 */
export function ToolForm({ fields, values, onChange, disabled, slots }: { fields: AiField[]; values: FormValues; onChange: (v: FormValues) => void; disabled?: boolean; slots?: Record<string, React.ReactNode> }) {
  const set = (name: string, value: unknown) => {
    const next = { ...values, [name]: value };
    // ô con phụ thuộc ô vừa đổi: giữ nếu còn hợp lệ, không thì chọn lựa chọn đầu tiên;
    // ô con bị đổi thì ô cháu (vd model → máy chủ → chất lượng) cũng được kiểm tra lại (ô cha luôn đứng trước)
    const changed = new Set([name]);
    for (const f of fields) {
      if (!f.optionsBy || !changed.has(f.optionsBy.field)) continue;
      const opts = fieldOptions(f, next);
      if (!opts.some((o) => o.value === next[f.name])) {
        next[f.name] = opts[0]?.value;
        changed.add(f.name);
      }
    }
    onChange(next);
  };
  const visible = fields.filter((f) => !f.hidden && fieldVisible(f, values, fields));
  // Tính độ dày trường hiển thị: nếu model chỉ có ít lựa chọn (vd Upscale chỉ 1-2 ô tải file / 1 ô chọn) thì chuyển sang bố cục rộng rãi, cân đối hơn
  const weight = visible.reduce((sum, f) => sum + (slots?.[f.name] !== undefined || f.type === "textarea" ? 2 : 1), 0);
  const spacious = weight <= 3;

  const isCompactSelect = (f: AiField) => !spacious && slots?.[f.name] === undefined && f.type === "select" && !f.picker;
  const isPairableFile = (f: AiField) => spacious && slots?.[f.name] === undefined && !f.multiple && (f.type === "image" || f.type === "video");

  // Gom các ô select thường liền kề nhau để trên PC (lg+) xếp 2 cột gọn gàng khi nhiều tuỳ chọn; hoặc gom 2 ô file đơn thành cặp vuông kiểu Motion Control khi ít tuỳ chọn
  const blocks: ({ kind: "single"; field: AiField } | { kind: "select-grid"; items: AiField[] } | { kind: "file-pair"; items: AiField[] })[] = [];
  for (const f of visible) {
    const last = blocks[blocks.length - 1];
    if (isCompactSelect(f) && last?.kind === "select-grid") {
      last.items.push(f);
    } else if (isCompactSelect(f)) {
      blocks.push({ kind: "select-grid", items: [f] });
    } else if (isPairableFile(f) && last?.kind === "file-pair" && last.items.length < 2) {
      last.items.push(f);
    } else if (isPairableFile(f)) {
      blocks.push({ kind: "file-pair", items: [f] });
    } else {
      blocks.push({ kind: "single", field: f });
    }
  }

  const renderField = (f: AiField, tile = false) =>
    slots?.[f.name] !== undefined ? (
      <div key={f.name}>{slots[f.name]}</div>
    ) : f.type === "select" && f.picker === "voice" ? (
      <VoicePicker
        key={f.name}
        field={f}
        options={fieldOptions(f, values)}
        value={values[f.name]}
        onChange={(v) => set(f.name, v)}
        disabled={disabled}
        modelLabel={f.optionsBy ? fieldOptions(fields.find((x) => x.name === f.optionsBy!.field)!, values).find((o) => o.value === values[f.optionsBy!.field])?.label : undefined}
      />
    ) : f.type === "select" && f.picker === "template" ? (
      <TemplatePicker key={f.name} field={f} options={fieldOptions(f, values)} value={values[f.name]} onChange={(v) => set(f.name, v)} disabled={disabled} />
    ) : (
      <Field key={f.name} field={f} values={values} value={values[f.name]} onChange={(v) => set(f.name, v)} disabled={disabled} spacious={spacious} tile={tile} />
    );

  return (
    <div className={cn(spacious ? "space-y-3.5" : "space-y-3")}>
      {blocks.map((b) =>
        b.kind === "single" ? (
          renderField(b.field)
        ) : b.kind === "file-pair" ? (
          b.items.length === 1 ? (
            renderField(b.items[0], false)
          ) : (
            <div key={b.items.map((x) => x.name).join("|")} className="grid grid-cols-2 gap-2.5">
              {b.items.map((f) => (
                <div key={f.name} className="min-w-0">
                  {renderField(f, true)}
                </div>
              ))}
            </div>
          )
        ) : b.items.length === 1 ? (
          renderField(b.items[0])
        ) : (
          <div key={b.items.map((x) => x.name).join("|")} className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-2">
            {b.items.map((f, idx) => {
              const spanFullOnPc = b.items.length % 2 === 1 && idx === b.items.length - 1;
              return (
                <div key={f.name} className={cn("min-w-0", spanFullOnPc && "lg:col-span-2")}>
                  {renderField(f)}
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

function FieldLabel({ field, extra }: { field: AiField; extra?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <Label className="text-[13px] font-semibold leading-snug">
        <span>
          {t(field.label)}
          {field.required && <span className="text-rose-500"> *</span>}
        </span>
      </Label>
      {extra}
    </div>
  );
}

function Field({ field: f, values, value, onChange, disabled, spacious, tile }: { field: AiField; values: FormValues; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; spacious?: boolean; tile?: boolean }) {
  const { t } = useI18n();
  const help = f.help ? <p className="mt-1 text-[11px] text-muted-foreground">{t(f.help)}</p> : null;

  if (FILE_TYPES.has(f.type)) {
    const count = Array.isArray(value) ? value.length : value ? 1 : 0;
    const max = f.multiple ? (f.maxFiles ?? 10) : 1;
    return (
      <div>
        {!tile && (
          <FieldLabel
            field={f}
            extra={
              f.multiple ? (
                <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                  {count > 0 ? `${count}/${max}` : t("Tối đa {n} file", { n: max })}
                </span>
              ) : null
            }
          />
        )}
        <FileField field={f} value={value} onChange={onChange} disabled={disabled} spacious={spacious} tile={tile} />
      </div>
    );
  }
  switch (f.type) {
    case "textarea": {
      const text = String(value ?? "");
      return (
        <div>
          <FieldLabel
            field={f}
            extra={
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {f.max ? `${text.length.toLocaleString("vi-VN")} / ${f.max.toLocaleString("vi-VN")}` : `${text.length.toLocaleString("vi-VN")} · ${t("Không giới hạn")}`}
              </span>
            }
          />
          <Textarea value={text} maxLength={f.max} rows={5} placeholder={f.placeholder ? t(f.placeholder) : undefined} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="min-h-32 resize-y rounded-2xl bg-muted/30 text-[14px] leading-relaxed focus-visible:bg-card" />
          {help}
        </div>
      );
    }
    case "select": {
      const opts = fieldOptions(f, values);
      return (
        <div>
          {/* Điện thoại (< lg): giữ nguyên giao diện thẻ / nút chip / select chuẩn di động như cũ */}
          <div className="lg:hidden">
            <FieldLabel field={f} />
            {opts.length && opts.every((o) => o.hint) ? (
              <div className="grid grid-cols-2 gap-2">
                {opts.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(o.value)}
                    className={cn("rounded-xl border px-3 py-2.5 text-left transition", value === o.value ? "border-foreground bg-muted ring-2 ring-foreground/15" : "bg-card hover:border-foreground/20")}
                  >
                    <span className="block text-[13px] font-semibold text-foreground">{t(o.label)}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{t(o.hint!)}</span>
                  </button>
                ))}
              </div>
            ) : opts.length && opts.length <= 5 && opts.every((o) => o.label.length <= 18) ? (
              <div className="flex flex-wrap gap-2">
                {opts.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(o.value)}
                    className={cn("h-9 min-w-14 rounded-xl border px-3.5 text-[13px] font-medium transition", value === o.value ? "border-foreground bg-muted text-foreground ring-2 ring-foreground/15" : "bg-card text-foreground/80 hover:border-foreground/20 hover:text-foreground")}
                  >
                    {t(o.label)}
                  </button>
                ))}
              </div>
            ) : (
              <select
                value={String(value ?? "")}
                disabled={disabled || !opts.length}
                onChange={(e) => onChange(e.target.value)}
                className="h-10 w-full rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
              >
                {!f.required && <option value="">—</option>}
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            )}
            {help}
          </div>
          {/* PC (lg+): nhãn nằm gọn trong thẻ + xếp 2 cột + bấm vào bung bảng chọn sang BÊN PHẢI kiểu Higgsfield */}
          <div className="hidden lg:block">
            <FlyoutSelect field={f} options={opts} value={value} onChange={onChange} disabled={disabled} />
          </div>
        </div>
      );
    }
    case "number":
      return (
        <div>
          <FieldLabel field={f} />
          <Input type="number" value={value === undefined ? "" : String(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} disabled={disabled} className="h-10 rounded-xl" />
          {help}
        </div>
      );
    case "boolean":
      return (
        <label className="flex items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2.5">
          <span className="text-[13px] font-semibold">{t(f.label)}</span>
          <Switch checked={value === true} onCheckedChange={(v) => onChange(v)} disabled={disabled} />
        </label>
      );
    default:
      return (
        <div>
          <FieldLabel field={f} />
          <Input value={String(value ?? "")} maxLength={f.max} placeholder={f.placeholder ? t(f.placeholder) : undefined} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="h-10 rounded-xl" />
          {help}
        </div>
      );
  }
}

/**
 * Ô chọn mục mở bảng nổi sang BÊN PHẢI (`side="right"` theo phong cách Higgsfield, tự xoay thông minh trên màn hình nhỏ):
 * Giữ cột Thiết lập luôn gọn gàng, bấm vào mới bung danh sách lựa chọn (kèm mô tả phụ & tìm kiếm khi nhiều mục) sang bên phải.
 */
function FlyoutSelect({
  field: f,
  options: opts,
  value,
  onChange,
  disabled,
}: {
  field: AiField;
  options: AiFieldOption[];
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const curStr = value === undefined || value === null ? "" : String(value);
  const selected = opts.find((o) => o.value === curStr);
  const kw = search.trim().toLowerCase();
  const shown = kw
    ? opts.filter((o) => t(o.label).toLowerCase().includes(kw) || o.label.toLowerCase().includes(kw) || (o.hint ? t(o.hint).toLowerCase().includes(kw) : false))
    : opts;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || !opts.length}
          title={f.help ? t(f.help) : undefined}
          className={cn(
            "group flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-left transition hover:border-foreground/35 hover:bg-muted/40 disabled:opacity-60",
            open && "border-foreground bg-muted/40 ring-1 ring-foreground/20",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-medium text-muted-foreground">
              {t(f.label)}
              {f.required && <span className="text-rose-500"> *</span>}
            </span>
            <span className={cn("mt-0.5 block truncate text-[13px] font-semibold leading-snug", selected ? "text-foreground" : "text-muted-foreground")}>
              {selected ? t(selected.label) : "—"}
            </span>
          </span>
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground", open && "translate-x-0.5 text-foreground")} />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[320px] gap-1.5 rounded-2xl border bg-popover p-2 shadow-2xl lg:w-auto lg:min-w-[320px] lg:max-w-[460px]"
      >
        <div className="px-2 pt-1 pb-0.5">
          <div className="text-[11.5px] font-semibold text-foreground">{t(f.label)}</div>
          {f.help && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{t(f.help)}</p>}
        </div>
        {opts.length >= 8 && (
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Tìm lựa chọn...")}
              className="h-8 w-full rounded-lg border bg-muted/40 pr-2.5 pl-8 text-xs outline-none focus:border-foreground/40 focus:bg-background"
            />
          </div>
        )}
        <div className="max-h-[min(60vh,400px)] space-y-0.5 overflow-y-auto pr-0.5">
          {!f.required && !kw && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition",
                !curStr ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span>—</span>
              {!curStr && <Check className="size-4 shrink-0 text-primary" />}
            </button>
          )}
          {shown.length === 0 ? (
            <p className="py-5 text-center text-xs text-muted-foreground">{t("Không có kết quả phù hợp")}</p>
          ) : (
            shown.map((o) => {
              const active = o.value === curStr;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition",
                    active ? "bg-primary/10 text-primary ring-1 ring-primary/30" : "hover:bg-muted/70",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[13px] font-semibold", active ? "text-primary" : "text-foreground")}>{t(o.label)}</span>
                    {o.hint && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{t(o.hint)}</span>}
                  </span>
                  {active && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Một file đã tải lên (xem trước + nút bỏ) */
interface Uploaded {
  url: string;
  name: string;
  mimeType: string;
}

/** Ô chọn file: kéo thả / bấm chọn, tải lên ngay, xem trước ảnh / video / âm thanh */
function FileField({ field: f, value, onChange, disabled, spacious, tile }: { field: AiField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; spacious?: boolean; tile?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  // tiến độ tải file đang gửi (0–1), hiện % khi tải file lớn
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  // tên / loại file để hiện xem trước (giá trị form chỉ giữ URL)
  const [meta, setMeta] = useState<Record<string, Uploaded>>({});
  const urls: string[] = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
  const max = f.multiple ? f.maxFiles ?? 10 : 1;

  // form được đặt lại (vd chạy lại) -> bỏ meta của file không còn
  useEffect(() => {
    setMeta((m) => Object.fromEntries(Object.entries(m).filter(([k]) => urls.includes(k))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join("|")]);

  const upload = async (files: FileList | File[]) => {
    // hộp chọn file của hệ điều hành không giữ thứ tự bấm chọn -> xếp theo tên (1.jpg, 2.jpg, 10.jpg), khách đổi lại bằng nút ◀ ▶
    const list = Array.from(files)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, Math.max(0, max - (f.multiple ? urls.length : 0)));
    if (!list.length) return toast.error(t("Tối đa {n} file", { n: max }));
    setBusy((b) => b + list.length);
    const done: Uploaded[] = [];
    for (const file of list) {
      try {
        // tải nhiều ảnh (tạo đơn số lượng lớn) dễ chạm giới hạn tải file của máy chủ (429) -> chờ rồi thử lại đúng file này, giữ thứ tự
        for (let attempt = 0; ; attempt++) {
          try {
            const fd = new FormData();
            fd.append("file", file);
            setProgress(0);
            done.push(await api.upload<Uploaded>("/account/ai/uploads", fd, setProgress));
            break;
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 429) || attempt >= 8) throw err;
            if (attempt === 0) toast.info(t("Đang tải nhiều file, tạm chờ máy chủ rồi tải tiếp..."));
            await new Promise((r) => setTimeout(r, 15_000));
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          toast.info(t("Vui lòng đăng nhập để tải file lên"));
          window.location.href = `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
          break;
        }
        toast.error(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setBusy((b) => b - 1);
        setProgress(null);
      }
    }
    if (!done.length) return;
    setMeta((m) => ({ ...m, ...Object.fromEntries(done.map((d) => [d.url, d])) }));
    onChange(f.multiple ? [...urls, ...done.map((d) => d.url)] : done[0].url);
  };

  const remove = (url: string) => onChange(f.multiple ? urls.filter((u) => u !== url) : undefined);
  // đổi chỗ file thứ i với file bên cạnh: thứ tự hiển thị = thứ tự gửi đi (@Image 1, @Image 2…)
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= urls.length) return;
    const next = [...urls];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const Icon = f.type === "video" ? FileVideo : f.type === "audio" ? FileAudio : f.type === "image" ? ImagePlus : Paperclip;
  const SpaciousIcon = f.type === "video" ? Video : f.type === "audio" ? FileAudio : Upload;
  const canAdd = urls.length < max;
  const inlineImageAdd = f.multiple && f.type === "image" && urls.length > 0;
  const singleImageUploaded = !spacious && !f.multiple && f.type === "image" && urls.length === 1;
  const singleSpaciousUploaded = !!spacious && !f.multiple && (f.type === "image" || f.type === "video") && urls.length === 1;
  const uploadingLabel = `${t("Đang tải lên...")}${progress !== null && progress > 0 ? ` ${Math.floor(progress * 100)}%` : ""}`;

  return (
    <div
      className="space-y-1.5"
      onDragOver={(e) => {
        if (!canAdd || disabled || busy > 0) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!canAdd || disabled || busy > 0) return;
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      {singleSpaciousUploaded ? (
        <div className={cn("group relative overflow-hidden rounded-2xl border bg-muted/30", tile && "aspect-square")}>
          {f.type === "video" ? (
            <video src={urls[0]} className={cn("w-full bg-black", tile ? "size-full object-cover" : "max-h-52 object-contain")} controls={!tile} muted loop={tile} autoPlay={tile} playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={urls[0]} alt={meta[urls[0]]?.name ?? ""} className={cn("w-full", tile ? "size-full object-cover" : "max-h-52 object-contain")} />
          )}
          {!disabled && (
            <>
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="absolute bottom-2 left-2 rounded-lg bg-black/65 px-2.5 py-1 text-[11.5px] font-semibold text-white opacity-0 transition group-hover:opacity-100"
              >
                {f.type === "video" ? t("Đổi video") : t("Đổi ảnh")}
              </button>
              <button
                type="button"
                onClick={() => remove(urls[0])}
                className="absolute top-2 right-2 inline-flex size-6.5 items-center justify-center rounded-full bg-black/65 text-white transition hover:bg-black/85"
                aria-label="Remove"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      ) : singleImageUploaded ? (
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/25 p-1.5 pr-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[0]} alt={meta[urls[0]]?.name ?? ""} className="size-11 shrink-0 rounded-lg border object-cover" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-foreground">{meta[urls[0]]?.name ?? urls[0].split("/").pop()}</div>
            {f.help && <p className="line-clamp-1 text-[11px] text-muted-foreground">{t(f.help)}</p>}
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(urls[0])}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-rose-600"
              aria-label="Remove"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      ) : urls.length > 0 ? (
        <div className={cn("grid gap-1.5", f.type === "image" ? "grid-cols-4 sm:grid-cols-5" : "grid-cols-1")}>
          {urls.map((url, i) => (
            <Preview
              key={url}
              url={url}
              kind={f.type}
              meta={meta[url]}
              order={f.multiple ? i + 1 : undefined}
              spacious={spacious}
              onRemove={disabled ? undefined : () => remove(url)}
              onPrev={f.multiple && !disabled && i > 0 ? () => move(i, -1) : undefined}
              onNext={f.multiple && !disabled && i < urls.length - 1 ? () => move(i, 1) : undefined}
            />
          ))}
          {inlineImageAdd && canAdd && (
            <button
              type="button"
              disabled={disabled || busy > 0}
              onClick={() => input.current?.click()}
              className={cn(
                "flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed bg-muted/20 p-1 text-center text-muted-foreground transition",
                drag ? "border-foreground bg-muted/60 text-foreground" : "hover:border-foreground/35 hover:bg-muted/40 hover:text-foreground",
              )}
            >
              {busy > 0 ? <Loader2 className="size-4 animate-spin text-foreground" /> : <Plus className="size-4" />}
              <span className="text-[10.5px] font-semibold tabular-nums">
                {busy > 0 && progress !== null && progress > 0 ? `${Math.floor(progress * 100)}%` : `${urls.length}/${max}`}
              </span>
            </button>
          )}
        </div>
      ) : null}

      {canAdd && !inlineImageAdd && (
        spacious ? (
          <button
            type="button"
            disabled={disabled || busy > 0}
            onClick={() => input.current?.click()}
            className={cn(
              "group flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-card text-center transition",
              tile ? "aspect-square gap-1.5 px-2.5 py-4" : "gap-1.5 px-4 py-6",
              drag ? "border-foreground bg-muted/60" : "hover:border-foreground/30 hover:bg-muted/20",
            )}
          >
            <span className={cn("inline-flex items-center justify-center rounded-2xl bg-muted text-foreground transition group-hover:scale-105", tile ? "size-10" : "size-11")}>
              {busy > 0 ? <Loader2 className="size-5 animate-spin" /> : <SpaciousIcon className="size-5" />}
            </span>
            <span className={cn("font-semibold leading-snug text-foreground", tile ? "text-[12.5px]" : "mt-0.5 text-[13.5px]")}>
              {busy > 0 ? (
                uploadingLabel
              ) : tile ? (
                <span>
                  {t(f.label)}
                  {f.required && <span className="text-rose-500"> *</span>}
                </span>
              ) : (
                t("Kéo thả hoặc bấm để chọn file")
              )}
            </span>
            {!busy && (
              <span className={cn("max-w-sm leading-relaxed text-muted-foreground", tile ? "line-clamp-2 text-[10.5px]" : "text-[11.5px]")}>
                {tile ? t("Bấm / Kéo thả") : f.help ? t(f.help) : t("Bấm / Kéo thả")}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || busy > 0}
            onClick={() => input.current?.click()}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-xl border border-dashed bg-muted/20 px-3 py-2 text-left transition",
              drag ? "border-foreground bg-muted/60" : "hover:border-foreground/35 hover:bg-muted/40",
            )}
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              {busy > 0 ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-foreground">
                {busy > 0 ? uploadingLabel : t("Kéo thả hoặc bấm để chọn file")}
              </span>
              {f.help && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{t(f.help)}</span>}
            </span>
            <Plus className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
          </button>
        )
      )}

      {f.help && ((tile && (!canAdd || urls.length > 0)) || (urls.length > 0 && !singleImageUploaded && (canAdd ? inlineImageAdd : true))) && (
        <p className="text-[11px] leading-snug text-muted-foreground">{t(f.help)}</p>
      )}

      <input
        ref={input}
        type="file"
        hidden
        accept={f.accept}
        multiple={!!f.multiple}
        onChange={(e) => {
          if (e.target.files?.length) upload(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Preview({ url, kind, meta, order, spacious, onRemove, onPrev, onNext }: { url: string; kind: string; meta?: Uploaded; order?: number; spacious?: boolean; onRemove?: () => void; onPrev?: () => void; onNext?: () => void }) {
  const mime = meta?.mimeType ?? "";
  const isImage = kind === "image" || mime.startsWith("image/");
  const isVideo = kind === "video" || mime.startsWith("video/");
  return (
    <div className="group relative overflow-hidden rounded-xl border bg-muted/40">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={meta?.name ?? ""} className="aspect-square w-full object-cover" />
      ) : isVideo ? (
        <video src={url} className={cn("w-full bg-black object-contain", spacious ? "max-h-48" : "max-h-28")} controls muted />
      ) : kind === "audio" || mime.startsWith("audio/") ? (
        <audio src={url} controls className="h-9 w-full px-2 py-1" />
      ) : (
        <div className="truncate px-3 py-2 text-xs">{meta?.name ?? url.split("/").pop()}</div>
      )}
      {order !== undefined && (
        <span className="absolute top-1 left-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-bold text-primary-foreground shadow" title={`@Image ${order}`}>
          {order}
        </span>
      )}
      {(onPrev || onNext) && (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
          <button type="button" onClick={onPrev} disabled={!onPrev} className="inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:invisible" aria-label="Move left">
            <ChevronLeft className="size-3" />
          </button>
          <button type="button" onClick={onNext} disabled={!onNext} className="inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:invisible" aria-label="Move right">
            <ChevronRight className="size-3" />
          </button>
        </div>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-90 hover:bg-black/80" aria-label="Remove">
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
