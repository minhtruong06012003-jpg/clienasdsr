"use client";

/**
 * Tạo hàng loạt (giống mục "Tạo hàng loạt" của sangtao.ai/imagine):
 * - Khách dán danh sách prompt (mỗi dòng một ảnh) hoặc tải file Excel / CSV (cột prompt + cột tuỳ chọn như tỉ lệ, độ phân giải).
 * - Thiết lập chung (tỉ lệ, độ phân giải, ảnh tham chiếu...) lấy từ bảng "Thiết lập" bên trái; cột trong file ghi đè cho từng dòng.
 * - Dòng thiếu / sai được báo ngay khi nhập, trước khi chạy.
 * - Trình duyệt gửi lần lượt từng dòng qua API chạy công cụ thường (mỗi dòng là một tác vụ, trừ / hoàn tiền vào số dư ví riêng):
 *   giữ đúng số luồng theo gói, giãn nhịp gửi để không vượt giới hạn 20 lần / phút của API, gặp "đang chạy tối đa luồng" thì chờ rồi gửi lại.
 * - Hỏi trạng thái cả lô bằng một request (GET /account/ai/tasks?ids=...), xuất lại file Excel kèm link từng ảnh.
 * Hàng đợi chạy trong trình duyệt nên phải giữ tab mở (có cảnh báo khi đóng tab lúc đang chạy).
 * Công cụ video có ô ảnh khởi đầu: chọn nguồn ảnh cho cả lô (BatchVideoSettings) — chỉ prompt / một ảnh chung /
 * mỗi video một ảnh (ảnh thứ N ghép prompt dòng N) / từ dự án ảnh (ảnh đã tạo ở trang Tạo ảnh).
 * Khách chỉnh được số luồng chạy cùng lúc (≤ số luồng theo gói), số bắt đầu đánh thứ tự và tên dự án (dùng khi xuất Excel).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, Download, FileSpreadsheet, FileText, Image as ImageIcon, Images, ListPlus, Loader2, Minus, Pause, Play, Plus, RotateCcw, Trash2, Upload, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { TaskThumb } from "@/components/ai/thumb";
import { fieldOptions, fieldVisible, ToolForm, type FormValues } from "@/components/ai/tool-form";
import { api, ApiError, errorMessage } from "@/lib/api";
import { downloadTasksAsZip, downloadTasksIndividually, hasDownloadableFiles } from "@/lib/bulk-download";
import { isRunning, promptFieldOf, SAMPLE_PROMPTS } from "@/lib/ai";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import type { AiField, AiTask, AiTool, Paginated } from "@/lib/types";

/** Số dòng tối đa mỗi lô (API chạy công cụ giới hạn 20 lần / phút nên 500 dòng mất khoảng 25 phút) */
export const BATCH_MAX = 500;
/** Khoảng cách tối thiểu giữa hai lần gửi (ms) — dưới giới hạn 20 lần / phút của POST /tools/:key/run */
const SUBMIT_GAP = 3200;
/** Chu kỳ hỏi trạng thái các tác vụ đang chạy (ms) */
const POLL_MS = 4000;

type RowState = "ready" | "invalid" | "queued" | "sending" | "running" | "done" | "failed";

/** Một dòng trong lô: prompt + giá trị ghi đè (từ cột file) + trạng thái chạy */
export interface BatchRow {
  id: number;
  prompt: string;
  /** Giá trị ô select ghi đè cho riêng dòng này (khoá = tên ô của công cụ) */
  over: Record<string, string>;
  state: RowState;
  /** Lý do dòng sai (invalid) hoặc lỗi khi gửi (failed) */
  message?: string;
  /** Dữ liệu gửi đi — chốt lúc bấm chạy để đổi thiết lập giữa chừng không ảnh hưởng dòng đã xếp hàng */
  input?: FormValues;
  task?: AiTask;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Chuẩn hoá tiêu đề cột để so khớp: chữ thường, bỏ dấu, bỏ khoảng trắng / gạch */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
/** Tên cột thường gặp -> danh sách tên ô có thể khớp của công cụ */
const FIELD_ALIASES: Record<string, string[]> = {
  ratio: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  tile: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  tyle: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  tilekhunghinh: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  khunghinh: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  aspect: ["aspectRatio", "aspect", "aspect_ratio", "ratio", "size"],
  size: ["size", "aspectRatio", "aspect", "resolution"],
  khoanh: ["size", "aspectRatio", "aspect"],
  res: ["resolution", "quality", "size", "option"],
  dophangiai: ["resolution", "quality", "size", "option"],
  donet: ["resolution", "quality", "size", "option"],
  chatluong: ["quality", "resolution", "option"],
  quality: ["quality", "resolution", "option"],
  thoiluong: ["duration", "option"],
  dodai: ["duration", "option"],
  duration: ["duration", "option"],
  seconds: ["duration", "option"],
  giay: ["duration", "option"],
  soluong: ["count", "n"],
  soluongvideo: ["count", "n"],
  soluonganh: ["count", "n"],
  soanh: ["n", "count"],
  count: ["count", "n"],
  n: ["n", "count"],
};
const PROMPT_HEADERS = new Set(["prompt", "mota", "motaprompt", "noidung", "text"]);

/**
 * Chuyển ô đọc từ Excel về chuỗi sạch:
 * Excel tự biến tỉ lệ khung hình kiểu "16:9", "9:16", "1:1", "21:9" thành giờ trong ngày (mốc 1899-12-30 / 1899-12-31).
 * Khôi phục ngược lại thành "H:M" để không bị báo lỗi "1899-12-30T16:09:00.000Z không hợp lệ".
 */
function excelCellToString(c: unknown): string {
  if (c === null || c === undefined) return "";
  if (c instanceof Date) {
    if (c.getUTCFullYear() <= 1900 && c.getUTCSeconds() === 0) {
      const mins = Math.round((c.getTime() - Date.UTC(1899, 11, 30)) / 60_000);
      if (mins > 0 && mins < 48 * 60) {
        return `${Math.floor(mins / 60)}:${mins % 60}`;
      }
    }
    return c.toISOString();
  }
  return String(c);
}

/** So khớp linh hoạt giá trị khách nhập trong Excel/CSV với danh sách lựa chọn hợp lệ của ô */
function matchFieldOption(f: AiField, rawInput: string, vals: FormValues): string {
  const raw = rawInput.trim();
  const opts = fieldOptions(f, vals);
  if (!opts.length || !raw) return raw;
  const lower = raw.toLowerCase();
  const direct = opts.find((o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower);
  if (direct) return direct.value;

  // Trường hợp Excel xuất tỉ lệ khung hình "16:9" thành số thập phân phần ngày (vd 0.6729166667)
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0 && num < 2 && raw.includes(".")) {
    const mins = Math.round(num * 1440);
    const ratio = `${Math.floor(mins / 60)}:${mins % 60}`;
    const byRatio = opts.find((o) => o.value === ratio);
    if (byRatio) return byRatio.value;
  }

  // Hỗ trợ khách gõ tắt: "10s" / "10 giây" -> "10", "x2" / "×2" -> "2", "16:9 (ngang)" -> "16:9"
  const stripped = lower
    .replace(/^[x×]\s*/, "")
    .replace(/\s*(s|sec|seconds?|giây|giay)$/i, "")
    .replace(/\s*\(.*?\)\s*$/, "")
    .trim();
  const byStripped = opts.find((o) => o.value.toLowerCase() === stripped || o.label.toLowerCase() === stripped);
  return byStripped ? byStripped.value : raw;
}

/** Tách CSV / TSV (hỗ trợ ô trong dấu ngoặc kép có xuống dòng, tự nhận dấu phân cách tab / ; / ,) */
function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = first.includes("\t") ? "\t" : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** Link tuyệt đối của file kết quả (để mở được từ file Excel) */
const absUrl = (u: string) => (u.startsWith("/") && typeof window !== "undefined" ? window.location.origin + u : u);

/** Nguồn ảnh khởi đầu của lô video: chỉ prompt / một ảnh chung / mỗi video một ảnh / từ dự án ảnh */
export type ImageMode = "none" | "shared" | "each" | "project";

/** Các ô ảnh chính (không tính khung cuối / ảnh phụ thứ 2) của công cụ video hoặc ảnh */
function primaryImageFields(tool: AiTool): AiField[] {
  if (tool.output !== "video" && tool.output !== "image") return [];
  const all = tool.fields.filter((f) => f.type === "image" && !f.hidden);
  if (!all.length) return [];
  const primary = all.filter((f) => !/^(lastFrame|endImage|image2)$/i.test(f.name));
  return primary.length ? primary : all;
}

/** Ô ảnh khởi đầu / tham chiếu đang áp dụng cho lô video hoặc lô ảnh */
export function startImageField(tool: AiTool, values?: FormValues) {
  const candidates = primaryImageFields(tool);
  if (!candidates.length) return undefined;
  if (values) {
    const active = candidates.find((f) => fieldVisible(f, values, tool.fields));
    if (active) return active;
  }
  return candidates[0];
}

/**
 * Tự động đồng bộ ô select điều khiển chế độ đầu vào (vd `mode`: `<model>:t2v` <-> `<model>:i2v` / `<model>:ref`)
 * khi khách chuyển qua lại giữa "Chỉ prompt" và "Một ảnh chung / Mỗi mục một ảnh / Từ dự án ảnh".
 */
function resolveImageControlPatch(tool: AiTool, imgField: AiField | undefined, values: FormValues, wantImage: boolean): Record<string, string> | null {
  if (!imgField?.showIf) return null;
  const ctrl = tool.fields.find((x) => x.name === imgField.showIf!.field);
  if (!ctrl) return null;
  const opts = fieldOptions(ctrl, values);
  if (!opts.length) return null;
  const cur = String(values[ctrl.name] ?? "");
  const candidates = primaryImageFields(tool);
  const allImgModes = new Set(candidates.filter((c) => c.showIf?.field === ctrl.name).flatMap((c) => c.showIf!.in));
  if (wantImage) {
    if (allImgModes.has(cur)) return null;
    const allowed = new Set(imgField.showIf.in);
    const picked =
      opts.find((o) => allowed.has(o.value) && /(?:^|:)i2v$/i.test(o.value)) ??
      opts.find((o) => allowed.has(o.value)) ??
      opts.find((o) => allImgModes.has(o.value));
    return picked ? { [ctrl.name]: picked.value } : null;
  }
  if (!allImgModes.has(cur)) return null;
  const picked = opts.find((o) => !allImgModes.has(o.value) && /(?:^|:)t2v$/i.test(o.value)) ?? opts.find((o) => !allImgModes.has(o.value));
  return picked ? { [ctrl.name]: picked.value } : null;
}

/** Ảnh do khách tạo đã lưu trên storage của website (dùng lại làm đầu vào được; link proxy của nguồn thì không) */
const isOwnOutput = (url: string) => /\/ai\/outputs\//.test(url);

/** Các ô select ghi đè được theo từng dòng (đang hiện với thiết lập chung) */
function overridableFields(tool: AiTool, shared: FormValues) {
  return tool.fields.filter((f) => f.type === "select" && !f.hidden && fieldVisible(f, shared, tool.fields));
}

/**
 * Trạng thái + thao tác của một lô. Gọi ở trang công cụ để chân bảng "Thiết lập" (nút chạy, chi phí)
 * và khung danh sách bên phải dùng chung.
 */
export function useBatch(tool: AiTool, shared: FormValues, concurrency: number, isPublic = false, onChangeShared?: (patch: FormValues) => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const pf = promptFieldOf(tool);
  const [rows, setRowsState] = useState<BatchRow[]>([]);
  // ref là nguồn dữ liệu cho vòng gửi (async), state để vẽ lại giao diện
  const ref = useRef<BatchRow[]>([]);
  const nextId = useRef(1);
  const [running, setRunningState] = useState(false);
  const runningRef = useRef(false);
  const loopActive = useRef(false);
  const lastSubmit = useRef(0);
  const concurrencyRef = useRef(concurrency);
  const imgField = startImageField(tool, shared);
  const initialHasImgMode = !!imgField && (imgField.required || (!!imgField.showIf && fieldVisible(imgField, shared, tool.fields)));
  // nguồn ảnh của lô (ô ảnh bắt buộc hoặc đang ở chế độ Ảnh → Video / Tham chiếu thì mặc định "một ảnh chung"), danh sách ảnh theo thứ tự dòng
  const [imageMode, setImageModeState] = useState<ImageMode>(initialHasImgMode ? "shared" : "none");
  const [images, setImages] = useState<string[]>([]);
  const updateShared = useCallback(
    (patch: FormValues) => {
      onChangeShared?.(patch);
    },
    [onChangeShared],
  );
  const setImageMode = useCallback(
    (next: ImageMode) => {
      setImageModeState(next);
      const modePatch = resolveImageControlPatch(tool, imgField, shared, next !== "none");
      if (modePatch) onChangeShared?.(modePatch);
    },
    [imgField, onChangeShared, shared, tool],
  );
  // nếu khách tự đổi ô "Chế độ đầu vào" (vd Chữ → Video <-> Ảnh → Video / Tham chiếu) ở bảng Thiết lập thì đồng bộ ngược lại thẻ Nguồn ảnh
  const ctrlFieldName = imgField?.showIf?.field;
  const ctrlValue = ctrlFieldName ? String(shared[ctrlFieldName] ?? "") : "";
  const prevCtrlRef = useRef(ctrlValue);
  useEffect(() => {
    if (!ctrlFieldName || prevCtrlRef.current === ctrlValue) return;
    prevCtrlRef.current = ctrlValue;
    const allImgModes = new Set(
      primaryImageFields(tool)
        .filter((c) => c.showIf?.field === ctrlFieldName)
        .flatMap((c) => c.showIf!.in),
    );
    const inImgModes = allImgModes.has(ctrlValue);
    if (inImgModes && imageMode === "none") setImageModeState("shared");
    else if (!inImgModes && imageMode !== "none") setImageModeState("none");
  }, [ctrlFieldName, ctrlValue, imageMode, tool]);
  // số luồng khách tự chọn (không vượt số luồng theo gói), số bắt đầu đánh thứ tự, tên dự án
  // null = chưa chỉnh -> theo số luồng tối đa của gói (gói tải xong sau lần vẽ đầu)
  const [limitPick, setLimit] = useState<number | null>(null);
  const [startNo, setStartNo] = useState(1);
  const [project, setProject] = useState("");
  // chế độ hiển thị đọc qua ref: vòng gửi async luôn lấy lựa chọn mới nhất
  const publicRef = useRef(isPublic);
  useEffect(() => {
    publicRef.current = isPublic;
  }, [isPublic]);
  // số luồng thực tế = lựa chọn của khách, tối đa theo gói
  const maxThreads = Math.max(1, concurrency);
  const limit = Math.min(limitPick ?? maxThreads, maxThreads);
  useEffect(() => {
    concurrencyRef.current = Math.max(1, limit);
  }, [limit, maxThreads]);

  const setRows = useCallback((fn: (r: BatchRow[]) => BatchRow[]) => {
    ref.current = fn(ref.current);
    setRowsState(ref.current);
  }, []);
  const patch = useCallback((id: number, p: Partial<BatchRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))), [setRows]);
  const setRunning = (v: boolean) => {
    runningRef.current = v;
    setRunningState(v);
  };

  /** Kiểm tra một dòng: prompt quá dài, giá trị ghi đè không có trong danh sách lựa chọn */
  const check = useCallback(
    (prompt: string, over: Record<string, string>): string | undefined => {
      if (pf?.max && prompt.length > pf.max) return t("Prompt dài {n} ký tự, tối đa {max}", { n: prompt.length, max: pf.max });
      const vals = { ...shared, ...over };
      for (const [name, v] of Object.entries(over)) {
        const f = tool.fields.find((x) => x.name === name);
        if (f && !fieldOptions(f, vals).some((o) => o.value === v)) return t("{label} \"{v}\" không hợp lệ", { label: t(f.label), v });
      }
      return undefined;
    },
    [pf, shared, tool.fields, t],
  );

  /** Thêm các dòng mới vào cuối danh sách (bỏ dòng prompt trống, cắt ở BATCH_MAX) */
  const add = useCallback(
    (items: { prompt: string; over?: Record<string, string> }[]) => {
      const valid = items.map((x) => ({ prompt: x.prompt.trim(), over: x.over ?? {} })).filter((x) => x.prompt);
      const room = BATCH_MAX - ref.current.length;
      if (room <= 0) {
        toast.error(t("Mỗi lô tối đa {n} dòng", { n: BATCH_MAX }));
        return 0;
      }
      const take = valid.slice(0, room);
      setRows((rs) => [
        ...rs,
        ...take.map((x) => {
          const message = check(x.prompt, x.over);
          return { id: nextId.current++, prompt: x.prompt, over: x.over, state: (message ? "invalid" : "ready") as RowState, message };
        }),
      ]);
      if (valid.length > room) toast.warning(t("Chỉ thêm {n} dòng đầu, mỗi lô tối đa {max} dòng", { n: room, max: BATCH_MAX }));
      return take.length;
    },
    [check, setRows, t],
  );

  /** Đọc bảng (từ Excel / CSV): nhận diện dòng tiêu đề, cột prompt và các cột ghi đè */
  const addTable = useCallback(
    (table: string[][]) => {
      const rowsIn = table.filter((r) => r.some((c) => c.trim()));
      if (!rowsIn.length) return 0;
      const fields = overridableFields(tool, shared);
      const head = rowsIn[0].map((c) => norm(c));
      const colOf = (f: AiField) => head.findIndex((h) => h && (h === norm(f.name) || h === norm(f.label) || FIELD_ALIASES[h]?.includes(f.name)));
      const promptCol = head.findIndex((h) => PROMPT_HEADERS.has(h) || (pf && (h === norm(pf.name) || h === norm(pf.label))));
      const hasHeader = promptCol >= 0;
      const cols = hasHeader ? fields.map((f) => ({ f, i: colOf(f) })).filter((x) => x.i >= 0) : [];
      const body = hasHeader ? rowsIn.slice(1) : rowsIn;
      return add(
        body.map((r) => {
          const over: Record<string, string> = {};
          for (const { f, i } of cols) {
            const raw = String(r[i] ?? "").trim();
            if (!raw) continue;
            // nhận cả giá trị ("720p", "10"), nhãn hiển thị ("10 giây", "16:9 (ngang)") lẫn chuỗi Excel tự đổi giờ
            over[f.name] = matchFieldOption(f, raw, { ...shared, ...over });
          }
          return { prompt: String(r[hasHeader ? promptCol : 0] ?? ""), over };
        }),
      );
    },
    [add, pf, shared, tool],
  );

  /** Đọc file .xlsx / .csv / .tsv / .txt */
  const addFile = useCallback(
    async (file: File) => {
      try {
        let table: string[][];
        if (/\.xlsx$/i.test(file.name)) {
          const { readSheet } = await import("read-excel-file/browser");
          const data = await readSheet(file);
          table = data.map((r) => r.map((c) => excelCellToString(c)));
        } else if (/\.(csv|tsv|txt)$/i.test(file.name)) {
          table = parseDelimited(await file.text());
        } else {
          toast.error(t("Chỉ hỗ trợ file .xlsx, .csv, .tsv hoặc .txt"));
          return;
        }
        const n = addTable(table);
        if (n) toast.success(t("Đã thêm {n} dòng từ {file}", { n, file: file.name }));
        else toast.error(t("Không tìm thấy prompt nào trong file"));
      } catch (err) {
        toast.error(t("Không đọc được file: {e}", { e: (err as Error).message }));
      }
    },
    [addTable, t],
  );

  /** Vòng gửi: lấy dòng đang xếp hàng, giữ số luồng và nhịp gửi, xử lý lỗi tạm thời */
  const loop = useCallback(async () => {
    if (loopActive.current) return;
    loopActive.current = true;
    try {
      while (runningRef.current) {
        const next = ref.current.find((r) => r.state === "queued");
        if (!next) break;
        const active = ref.current.filter((r) => r.state === "sending" || r.state === "running").length;
        if (active >= concurrencyRef.current) {
          await sleep(1500);
          continue;
        }
        const wait = lastSubmit.current + SUBMIT_GAP - Date.now();
        if (wait > 0) {
          await sleep(wait);
          continue; // kiểm tra lại (có thể vừa bấm dừng)
        }
        lastSubmit.current = Date.now();
        patch(next.id, { state: "sending", message: undefined });
        try {
          const task = await api.post<AiTask>(`/account/ai/tools/${encodeURIComponent(tool.key)}/run`, { input: next.input, isPublic: publicRef.current });
          qc.setQueryData(["ai", "task", task.id], task);
          patch(next.id, { task, state: isRunning(task.status) ? "running" : task.status === "SUCCEEDED" ? "done" : "failed", message: task.error ?? undefined });
          qc.invalidateQueries({ queryKey: ["credits"] });
        } catch (err) {
          const status = err instanceof ApiError ? err.status : 0;
          const msg = errorMessage(err);
          // đang chạy tối đa số luồng (tác vụ ngoài lô cũng tính) / gửi quá nhanh / mất mạng -> xếp hàng lại, chờ rồi thử tiếp
          if (status === 409 || status === 429 || status === 0 || status >= 500) {
            patch(next.id, { state: "queued" });
            await sleep(status === 429 ? 20_000 : status === 409 ? 4000 : 8000);
            continue;
          }
          // hết số dư ("Số dư ví không đủ", bản API cũ báo "credits") / công cụ bảo trì hoặc tắt -> dừng cả lô, dòng giữ trong hàng chờ để chạy tiếp sau
          if (/credits|số dư|bảo trì|tạm dừng/i.test(msg) || status === 404) {
            patch(next.id, { state: "queued" });
            setRunning(false);
            toast.error(t("Đã tạm dừng lô: {e}", { e: msg }));
            break;
          }
          patch(next.id, { state: "failed", message: msg });
        }
      }
    } finally {
      loopActive.current = false;
    }
    // hết dòng chờ gửi -> tắt trạng thái chạy (các tác vụ đã gửi vẫn tiếp tục được hỏi trạng thái)
    if (runningRef.current && !ref.current.some((r) => r.state === "queued")) setRunning(false);
  }, [patch, qc, t, tool.key]);

  /** Bắt đầu / chạy tiếp: chốt dữ liệu gửi cho các dòng sẵn sàng rồi đưa vào hàng chờ */
  const start = useCallback(() => {
    if (!pf) return;
    // ô bắt buộc khác (vd ảnh gốc của công cụ chỉnh ảnh) phải có ở thiết lập chung
    // (ô ảnh khởi đầu chỉ lấy từ thiết lập chung khi chọn "Một ảnh chung")
    const missing = tool.fields.find((f) => f.name !== pf.name && !(imgField && f === imgField && imageMode !== "shared") && f.required && fieldVisible(f, shared, tool.fields) && (shared[f.name] === undefined || shared[f.name] === "" || (Array.isArray(shared[f.name]) && !(shared[f.name] as unknown[]).length)));
    if (missing) {
      toast.error(t("Vui lòng nhập \"{label}\" ở bảng Thiết lập", { label: t(missing.label) }));
      return;
    }
    if (imgField?.required && imageMode === "none") {
      toast.error(t("Công cụ này cần ảnh khởi đầu, vui lòng chọn nguồn ảnh"));
      return;
    }
    if (imgField && imageMode === "shared") {
      const sharedImg = shared[imgField.name];
      const hasShared = Array.isArray(sharedImg) ? sharedImg.length > 0 : !!sharedImg;
      if (!hasShared) {
        toast.error(t("Vui lòng tải ảnh lên ở mục \"{label}\"", { label: t(imgField.label) }));
        return;
      }
    }
    // ảnh của dòng thứ i: không ảnh / ảnh chung / ảnh thứ i trong danh sách (thiếu ảnh -> dòng báo sai, không gửi)
    const imageOf = (i: number) => (imageMode === "none" ? undefined : imageMode === "shared" ? (shared[imgField!.name] as string | string[] | undefined) : images[i]);
    setRows((rs) =>
      rs.map((r, i) => {
        if (r.state !== "ready") return r;
        const image = imgField ? imageOf(i) : undefined;
        const hasImg = Array.isArray(image) ? image.length > 0 : !!image;
        if (imgField && (imageMode === "each" || imageMode === "project") && !hasImg) return { ...r, state: "invalid", message: t("Chưa có ảnh thứ {n} cho dòng này", { n: i + 1 }) };
        const input: FormValues = { ...shared, ...r.over, [pf.name]: r.prompt };
        if (imgField) {
          if (hasImg) {
            const modePatch = resolveImageControlPatch(tool, imgField, input, true);
            if (modePatch) Object.assign(input, modePatch);
            input[imgField.name] = imgField.multiple && !Array.isArray(image) ? [image] : image;
          } else {
            delete input[imgField.name];
          }
        }
        return { ...r, state: "queued", input };
      }),
    );
    if (!ref.current.some((r) => r.state === "queued")) {
      toast.error(t("Chưa có dòng nào sẵn sàng để chạy"));
      return;
    }
    setRunning(true);
    void loop();
  }, [imageMode, imgField, images, loop, pf, setRows, shared, t, tool]);

  const pause = () => setRunning(false);
  /** Đưa các dòng lỗi về sẵn sàng để chạy lại (lần chạy lại dùng thiết lập chung hiện tại) */
  const retryFailed = () => setRows((rs) => rs.map((r) => (r.state === "failed" ? { ...r, state: "ready", message: undefined, task: undefined, input: undefined } : r)));
  /** Xoá một dòng chưa gửi */
  const remove = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id || r.state === "sending" || r.state === "running"));
  /** Xoá cả danh sách (chỉ khi không còn dòng đang gửi / đang chạy) */
  const clear = () => setRows((rs) => rs.filter((r) => r.state === "sending" || r.state === "running"));

  // đổi thiết lập chung -> kiểm tra lại các dòng chưa chạy (giá trị ghi đè có thể hết hợp lệ khi đổi model)
  useEffect(() => {
    // không có dòng chưa chạy -> bỏ qua (tránh vẽ lại mỗi lần gõ ở bảng Thiết lập)
    if (!ref.current.some((r) => r.state === "ready" || r.state === "invalid")) return;
    setRows((rs) =>
      rs.map((r) => {
        if (r.state !== "ready" && r.state !== "invalid") return r;
        const message = check(r.prompt, r.over);
        return { ...r, state: message ? "invalid" : "ready", message };
      }),
    );
  }, [check, setRows, imageMode, images]);

  // hỏi trạng thái các tác vụ đang chạy của lô bằng một request
  const runningIds = useMemo(() => rows.filter((r) => r.state === "running" && r.task).map((r) => r.task!.id), [rows]);
  const idsKey = runningIds.slice(0, 200).join(",");
  const poll = useQuery({
    queryKey: ["ai", "batch", idsKey],
    queryFn: () => api.get<Paginated<AiTask>>("/account/ai/tasks", { ids: idsKey, limit: 200 }),
    enabled: !!idsKey,
    refetchInterval: POLL_MS,
    meta: { silentError: true },
  });
  useEffect(() => {
    const list = poll.data?.data;
    if (!list?.length) return;
    const byId = new Map(list.map((x) => [x.id, x]));
    let finished = 0;
    setRows((rs) =>
      rs.map((r) => {
        const x = r.state === "running" && r.task ? byId.get(r.task.id) : undefined;
        if (!x) return r;
        if (isRunning(x.status)) return { ...r, task: x };
        finished++;
        return { ...r, task: x, state: x.status === "SUCCEEDED" ? "done" : "failed", message: x.error ?? undefined };
      }),
    );
    // có tác vụ vừa xong -> làm mới số dư (hoàn tiền khi lỗi) và lịch sử
    if (finished) {
      qc.invalidateQueries({ queryKey: ["credits"] });
      qc.invalidateQueries({ queryKey: ["ai", "tasks"] });
    }
  }, [poll.data, qc, setRows]);

  // đang gửi / còn dòng chờ -> cảnh báo khi đóng tab (hàng chờ nằm trong trình duyệt)
  const busy = running || rows.some((r) => r.state === "sending");
  useEffect(() => {
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy]);

  // đếm theo trạng thái (thanh tiến độ, nút chạy)
  const count = useMemo(() => {
    const c: Record<RowState, number> = { ready: 0, invalid: 0, queued: 0, sending: 0, running: 0, done: 0, failed: 0 };
    for (const r of rows) c[r.state]++;
    return c;
  }, [rows]);

  // cả lô vừa xong (không còn dòng chờ / đang chạy) -> báo kết quả một lần
  const wasActive = useRef(false);
  useEffect(() => {
    const active = count.queued + count.sending + count.running > 0;
    if (wasActive.current && !active && (count.done || count.failed)) toast.success(t("Lô hoàn tất: {ok} thành công, {fail} lỗi", { ok: count.done, fail: count.failed }));
    wasActive.current = active;
  }, [count, t]);

  /** Tên hiển thị của dòng thứ i (đánh số từ `startNo`, kèm tên dự án nếu có) */
  const labelOf = (i: number) => `${project.trim() ? `${project.trim()} ` : ""}#${startNo + i}`;
  return {
    rows,
    count,
    running,
    busy,
    add,
    addFile,
    start,
    pause,
    retryFailed,
    remove,
    clear,
    fields: overridableFields(tool, shared),
    shared,
    updateShared,
    imgField,
    imageMode,
    setImageMode,
    images,
    setImages,
    limit,
    setLimit,
    maxThreads,
    startNo,
    setStartNo,
    project,
    setProject,
    labelOf,
  };
}

export type Batch = ReturnType<typeof useBatch>;

/** Cách tách chữ dán vào ô thành các prompt: mỗi dòng / ngăn bằng dòng trống / ngăn bằng dòng "---" / cả ô là một prompt */
type SplitMode = "line" | "blank" | "dash" | "whole";
const SPLIT_MODES: { mode: SplitMode; label: string }[] = [
  { mode: "line", label: "Mỗi dòng" },
  { mode: "blank", label: "Dòng trống" },
  { mode: "dash", label: "Dòng ---" },
  { mode: "whole", label: "Cả ô là 1 prompt" },
];
/** Dòng chỉ gồm "---" (ngăn cách prompt) */
const DASH_LINE = /^[ \t]*-{3,}[ \t]*\r?$/m;

/** Tách chữ dán vào thành danh sách prompt theo cách khách chọn (bỏ prompt trống) */
function splitPrompts(text: string, mode: SplitMode): string[] {
  const parts =
    mode === "whole" ? [text] : mode === "dash" ? text.split(new RegExp(DASH_LINE.source, "gm")) : text.split(mode === "blank" ? /\r?\n[ \t]*\r?\n/ : /\r?\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Dòng trông như phần tiếp theo của MỘT prompt nhiều dòng (gạch đầu dòng, tiêu đề markdown, **tiêu đề đậm**, đánh số):
 * khách dán cả prompt dài vào chế độ "mỗi dòng" sẽ bị tách mỗi dòng thành một video riêng (vd đơn chỉ có "**VIDEO FORMAT**").
 */
const CONT_LINE = /^\s*(?:[-*•+]\s|#{1,6}\s|\*\*[^*]+\*\*:?\s*$|\d+[.)]\s)/;

const STATE_UI: Record<RowState, { label: string; className: string }> = {
  ready: { label: "Sẵn sàng", className: "bg-muted text-muted-foreground" },
  invalid: { label: "Sai dữ liệu", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  queued: { label: "Đang chờ", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
  sending: { label: "Đang gửi", className: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" },
  running: { label: "Đang tạo", className: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" },
  done: { label: "Hoàn tất", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  failed: { label: "Lỗi", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
};

/** Khung bên phải của chế độ tạo hàng loạt: nhập prompt / file, danh sách dòng, tiến độ, xuất Excel */
export function BatchPanel({ tool, batch }: { tool: AiTool; batch: Batch }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const { rows, count } = batch;
  const total = rows.length;
  const finished = count.done + count.failed;
  const started = finished + count.queued + count.sending + count.running;
  const [split, setSplit] = useState<SplitMode>("line");
  const prompts = splitPrompts(text, split);
  const lines = prompts.length;
  // số dòng trông như thuộc một prompt nhiều dòng — từ 2 dòng trở lên thì cảnh báo trước khi tách mỗi dòng một prompt
  const contLines = split === "line" ? text.split(/\r?\n/).filter((l) => CONT_LINE.test(l)).length : 0;
  // "video" hay "ảnh" trong câu chữ theo loại kết quả của công cụ
  const noun = tool.output === "video" ? t("video") : t("ảnh");

  /** Ảnh khởi đầu sẽ dùng cho dòng thứ i (xem trước trước khi gửi) */
  const rowImage = (i: number) => (!batch.imgField || batch.imageMode === "none" ? undefined : batch.imageMode === "shared" ? undefined : batch.images[i]);

  const safeKey = tool.key.replace(/[^a-zA-Z0-9_-]+/g, "-");

  /** File mẫu: sheet prompt (cột prompt + các cột tuỳ chọn đúng theo model hiện tại, định dạng Text chống Excel đổi "16:9" thành giờ) và sheet hướng dẫn */
  const template = async () => {
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const fields = batch.fields;
      const samples = SAMPLE_PROMPTS[tool.category] ?? SAMPLE_PROMPTS.image;
      const textCell = (val: string) => ({ value: val, type: String, format: "@" });
      const head = ["prompt", ...fields.map((f) => f.name)].map((v) => ({ value: v, type: String, format: "@", fontWeight: "bold" as const }));
      const body = samples.map((p, i) => [
        textCell(t(p)),
        ...fields.map((f) => {
          const opts = fieldOptions(f, batch.shared);
          if (!opts.length) return textCell("");
          // Cột số bản (count) giữ cố định theo thiết lập chung (mặc định 1) để tránh nhân bản ngoài ý muốn; các cột khác minh hoạ giá trị hợp lệ của đúng model đang mở
          if (f.name === "count") {
            return textCell(String(batch.shared[f.name] ?? opts[0].value));
          }
          const picked = i === 0 && batch.shared[f.name] !== undefined ? String(batch.shared[f.name]) : opts[i % opts.length].value;
          return textCell(picked);
        }),
      ]);
      const guide = [
        [
          { value: t("Cột"), type: String, fontWeight: "bold" as const },
          { value: t("Ý nghĩa"), type: String, fontWeight: "bold" as const },
          { value: t("Giá trị hợp lệ"), type: String, fontWeight: "bold" as const },
        ],
        [textCell("prompt"), textCell(t("Mô tả (bắt buộc, mỗi dòng một {x})", { x: noun })), textCell("")],
        ...fields.map((f) => {
          const opts = fieldOptions(f, batch.shared);
          const validList = opts
            .map((o) => o.value)
            .filter((v, idx, arr) => arr.indexOf(v) === idx)
            .join(", ");
          return [
            textCell(f.name),
            textCell(`${t(f.label)} — ${t("để trống = dùng thiết lập chung")}`),
            textCell(validList),
          ];
        }),
      ];
      await writeXlsxFile([
        { sheet: "prompt", data: [head, ...body], columns: [{ width: 70 }, ...fields.map(() => ({ width: 16 }))] },
        { sheet: "huong-dan", data: guide, columns: [{ width: 16 }, { width: 55 }, { width: 50 }] },
      ]).toFile(`mau-tao-hang-loat-${safeKey}.xlsx`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  /** Xuất danh sách kèm trạng thái + link kết quả */
  const exportXlsx = async () => {
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const fields = batch.fields;
      const textCell = (val: string) => ({ value: val, type: String, format: "@" });
      const head = ["#", t("Tên"), "prompt", ...fields.map((f) => f.name), t("Trạng thái"), t("Mã tác vụ"), t("Link kết quả"), t("Ghi chú")].map((v) => ({
        value: v,
        type: String,
        format: "@",
        fontWeight: "bold" as const,
      }));
      const body = rows.map((r, i) => [
        batch.startNo + i,
        textCell(batch.labelOf(i)),
        textCell(r.prompt),
        ...fields.map((f) => textCell(String(r.over[f.name] ?? r.input?.[f.name] ?? ""))),
        textCell(t(STATE_UI[r.state].label)),
        textCell(r.task?.code ?? ""),
        textCell((r.task?.output?.files ?? []).map((f) => absUrl(f.url)).join("\n")),
        textCell(r.message ?? ""),
      ]);
      await writeXlsxFile([head, ...body], {
        columns: [{ width: 6 }, { width: 24 }, { width: 60 }, ...fields.map(() => ({ width: 14 })), { width: 14 }, { width: 14 }, { width: 70 }, { width: 40 }],
      }).toFile(`${batch.project.trim().replace(/[\\/:*?"<>|]+/g, " ") || `tao-hang-loat-${safeKey}`}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  // Tải hàng loạt toàn bộ dòng đã hoàn tất (từng file gốc hoặc nén .ZIP theo đúng số thứ tự dòng)
  const [dlMode, setDlMode] = useState<null | "files" | "zip">(null);
  const [dlProgress, setDlProgress] = useState<{ cur: number; total: number } | null>(null);
  const doneItems = useMemo(
    () => rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "done" && hasDownloadableFiles(r.task)),
    [rows],
  );
  const buildBatchDownloadMeta = () => {
    const ids: string[] = [];
    const labels: Record<string, string> = {};
    for (const { r, i } of doneItems) {
      if (!r.task) continue;
      ids.push(r.task.id);
      labels[r.task.id] = batch.labelOf(i);
    }
    const zipName = `${batch.project.trim().replace(/[\\/:*?"<>|]+/g, " ") || `tao-hang-loat-${tool.key}`}-${new Date().toISOString().slice(0, 10)}`;
    return { ids, labels, zipName };
  };
  const downloadBatchFiles = async () => {
    const { ids, labels } = buildBatchDownloadMeta();
    if (!ids.length || dlMode) return;
    setDlMode("files");
    setDlProgress({ cur: 0, total: ids.length });
    try {
      const res = await downloadTasksIndividually(ids, {
        labels,
        onProgress: (cur, total) => setDlProgress({ cur, total }),
      });
      toast.success(
        res.fileCount > 1
          ? t("Đã bắt đầu tải {n} file về máy (nếu trình duyệt hỏi quyền tải nhiều file, hãy bấm Cho phép)", { n: res.fileCount })
          : t("Đang tải file về máy"),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDlMode(null);
      setDlProgress(null);
    }
  };
  const downloadBatchZip = async () => {
    const { ids, labels, zipName } = buildBatchDownloadMeta();
    if (!ids.length || dlMode) return;
    setDlMode("zip");
    try {
      const res = await downloadTasksAsZip(ids, { labels, zipName });
      toast.success(t("Đang tải file nén .ZIP ({n} file)", { n: res.fileCount }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDlMode(null);
    }
  };

  return (
    <section className="flex min-h-[520px] flex-col gap-4 rounded-3xl border bg-card p-4 shadow-sm sm:p-5">
      <div>
        <h2 className="text-base font-semibold">{t("Tạo hàng loạt")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("Mỗi dòng một prompt (prompt nhiều dòng thì ngăn bằng dòng ---) — tối đa {n} dòng mỗi lô. Thiết lập chung lấy từ bảng bên trái; file Excel có thể ghi đè từng dòng.", { n: BATCH_MAX })}
        </p>
      </div>

      {/* nhập prompt: dán chữ hoặc tải file */}
      <div
        className={cn("rounded-2xl border border-dashed p-3 transition", drag && "border-foreground/40 bg-muted/40")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void batch.addFile(f);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            // có dòng "---" thì khách đang ngăn các prompt nhiều dòng bằng "---" -> tự chuyển cách tách
            if (split === "line" && DASH_LINE.test(v)) setSplit("dash");
          }}
          rows={5}
          placeholder={
            tool.output === "video"
              ? t("Dán danh sách prompt, mỗi dòng một video...\nVí dụ:\nCảnh flycam bay qua ruộng bậc thang lúc bình minh\nChú mèo phi hành gia lơ lửng trong trạm vũ trụ")
              : t("Dán danh sách prompt, mỗi dòng một ảnh...\nVí dụ:\nLogo quán cà phê tối giản, nền trắng\nPoster phim khoa học viễn tưởng, chữ \"NOV AI\"")
          }
          className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/30"
        />
        {/* cách tách prompt: prompt dài nhiều dòng thì ngăn bằng dòng trống / "---" hoặc dán cả ô là một prompt */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("Tách prompt theo:")}</span>
          {SPLIT_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              onClick={() => setSplit(m.mode)}
              className={cn("h-7 rounded-full border px-2.5 transition", split === m.mode ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        {contLines >= 2 && (
          <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t("Có vẻ bạn dán một prompt nhiều dòng (gạch đầu dòng, tiêu đề). Đang tách mỗi dòng thành một {x} riêng — {n} {x}.", { x: noun, n: lines })}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setSplit("whole")} className="h-7 rounded-full bg-amber-600 px-2.5 font-semibold text-white">
                {t("Cả ô là 1 prompt")}
              </button>
              <button type="button" onClick={() => setSplit("dash")} className="h-7 rounded-full border border-amber-400 px-2.5">
                {t("Mỗi prompt ngăn bằng dòng ---")}
              </button>
            </div>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!lines}
            onClick={() => {
              if (batch.add(prompts.map((p) => ({ prompt: p })))) setText("");
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background disabled:opacity-50"
          >
            <ListPlus className="size-3.5" /> {lines ? t("Thêm {n} dòng", { n: lines }) : t("Thêm vào danh sách")}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition hover:bg-muted">
            <Upload className="size-3.5" /> {t("Tải file Excel / CSV")}
          </button>
          <button type="button" onClick={() => void template()} className="inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition hover:bg-muted">
            <FileSpreadsheet className="size-3.5" /> {t("File mẫu")}
          </button>
          <span className="text-[11px] text-muted-foreground">{t("hoặc kéo thả file vào đây")}</span>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void batch.addFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {total > 0 && (
        <>
          {/* tiến độ + thao tác cả lô */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{t("{n} dòng", { n: total })}</span>
                {count.invalid > 0 && <span className="text-red-600">{t("{n} sai dữ liệu", { n: count.invalid })}</span>}
                {started > 0 && <span>{t("{done}/{all} đã xong", { done: finished, all: started })}</span>}
                {count.done > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <CheckCircle2 className="size-3.5" /> {count.done}
                  </span>
                )}
                {count.failed > 0 && (
                  <span className="inline-flex items-center gap-1 text-red-600">
                    <XCircle className="size-3.5" /> {count.failed}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {batch.running ? (
                  <button type="button" onClick={batch.pause} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:bg-muted">
                    <Pause className="size-3.5" /> {t("Tạm dừng")}
                  </button>
                ) : (
                  count.queued > 0 && (
                    <button type="button" onClick={batch.start} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:bg-muted">
                      <Play className="size-3.5" /> {t("Chạy tiếp")}
                    </button>
                  )
                )}
                {count.failed > 0 && !batch.running && (
                  <button type="button" onClick={batch.retryFailed} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:bg-muted">
                    <RotateCcw className="size-3.5" /> {t("Chạy lại dòng lỗi")}
                  </button>
                )}
                {doneItems.length > 0 && (
                  <>
                    <button
                      type="button"
                      disabled={!!dlMode}
                      onClick={() => void downloadBatchFiles()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                    >
                      {dlMode === "files" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                      {dlMode === "files" && dlProgress
                        ? t("Đang tải {cur}/{total}...", { cur: dlProgress.cur, total: dlProgress.total })
                        : t("Tải từng file ({n})", { n: doneItems.length })}
                    </button>
                    <button
                      type="button"
                      disabled={!!dlMode}
                      onClick={() => void downloadBatchZip()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
                    >
                      {dlMode === "zip" ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                      {dlMode === "zip" ? t("Đang nén...") : t("Tải nén .ZIP ({n})", { n: doneItems.length })}
                    </button>
                  </>
                )}
                <button type="button" onClick={() => void exportXlsx()} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:bg-muted">
                  <FileSpreadsheet className="size-3.5" /> {t("Xuất Excel")}
                </button>
                {!batch.busy && (
                  <button type="button" onClick={batch.clear} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:hover:bg-red-500/10">
                    <Trash2 className="size-3.5" /> {t("Xoá danh sách")}
                  </button>
                )}
              </div>
            </div>
            {started > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${Math.round((finished / started) * 100)}%` }} />
              </div>
            )}
            {batch.busy && <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("Đang chạy hàng chờ trong trình duyệt — giữ tab này mở cho tới khi gửi hết. Phần đã gửi vẫn được tạo và lưu ở Lịch sử nếu bạn rời trang.")}</p>}
          </div>

          {/* danh sách dòng */}
          <div className="studio-scroll -mx-1 max-h-[70dvh] space-y-2 overflow-y-auto px-1">
            {rows.map((r, i) => {
              const st = STATE_UI[r.state];
              const file = r.task?.output?.files?.[0];
              return (
                <div key={r.id} className="flex items-start gap-3 rounded-2xl border p-2.5">
                  <div className="w-20 shrink-0 overflow-hidden rounded-xl border sm:w-24">
                    {r.task ? (
                      file ? (
                        <a href={file.url} target="_blank" rel="noreferrer" className="group block">
                          <TaskThumb task={r.task} className="aspect-square" />
                        </a>
                      ) : (
                        <TaskThumb task={r.task} className="aspect-square" />
                      )
                    ) : (
                      <div className="studio-dots flex aspect-square items-center justify-center text-xs font-semibold text-muted-foreground">
                        {r.state === "sending" ? <Loader2 className="size-4 animate-spin" /> : rowImage(i) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={rowImage(i)} alt="" className="size-full object-cover" />
                        ) : (
                          `#${batch.startNo + i}`
                        )}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-[13px] leading-snug" title={r.prompt}>
                        <span className="mr-1 text-muted-foreground">{batch.labelOf(i)}</span>
                        {r.prompt}
                      </p>
                      {(r.state === "ready" || r.state === "invalid" || (r.state === "queued" && !batch.running)) && (
                        <button type="button" onClick={() => batch.remove(r.id)} className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" title={t("Xoá dòng")}>
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                      <span className={cn("rounded-full px-1.5 py-0.5 font-semibold", st.className)}>{t(st.label)}</span>
                      {r.state === "running" && r.task?.progress ? <span className="text-muted-foreground">{r.task.progress}%</span> : null}
                      {r.task?.code && <span className="text-muted-foreground">{t("Mã đơn")}: {r.task.code}</span>}
                      {r.state === "done" && r.task && hasDownloadableFiles(r.task) && (
                        <button
                          type="button"
                          onClick={() => {
                            const task = r.task!;
                            void downloadTasksIndividually([task.id], { labels: { [task.id]: batch.labelOf(i) } }).catch((err) => toast.error(errorMessage(err)));
                          }}
                          className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 font-medium text-foreground transition hover:bg-foreground hover:text-background"
                        >
                          <Download className="size-2.5" /> {t("Tải về")}
                        </button>
                      )}
                      {Object.entries(r.over).map(([k, v]) => (
                        <span key={k} className="rounded-full border px-1.5 py-0.5 text-muted-foreground">
                          {v}
                        </span>
                      ))}
                    </div>
                    {r.message && <p className={cn("mt-1 line-clamp-2 text-[11px]", r.state === "invalid" || r.state === "failed" ? "text-red-600" : "text-muted-foreground")}>{r.message}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Thẻ chọn nguồn ảnh của lô video / lô ảnh */
const IMAGE_MODES_VIDEO: { mode: ImageMode; title: string; hint: string; icon: typeof FileText }[] = [
  { mode: "none", title: "Chỉ prompt", hint: "Tạo video từ chữ, không cần ảnh", icon: FileText },
  { mode: "shared", title: "Một ảnh chung", hint: "Mọi video bắt đầu từ cùng một ảnh", icon: ImageIcon },
  { mode: "each", title: "Mỗi video một ảnh", hint: "Ảnh thứ N ghép với prompt dòng N", icon: Images },
  { mode: "project", title: "Từ dự án ảnh", hint: "Dùng bộ ảnh đã tạo ở trang Tạo ảnh", icon: Images },
];

const IMAGE_MODES_IMAGE: { mode: ImageMode; title: string; hint: string; icon: typeof FileText }[] = [
  { mode: "none", title: "Chỉ prompt", hint: "Tạo ảnh từ chữ, không cần ảnh gốc", icon: FileText },
  { mode: "shared", title: "Một ảnh chung", hint: "Dùng chung ảnh gốc / tham chiếu cho cả lô", icon: ImageIcon },
  { mode: "each", title: "Mỗi dòng một ảnh", hint: "Ảnh thứ N ghép với prompt dòng N", icon: Images },
  { mode: "project", title: "Từ dự án ảnh", hint: "Dùng bộ ảnh đã tạo ở trang Tạo ảnh", icon: Images },
];

/** Ô tăng / giảm số nguyên (số luồng, đánh số từ) */
function Stepper({ value, min, max, onChange }: { value: number; min: number; max?: number; onChange: (n: number) => void }) {
  const clamp = (n: number) => Math.max(min, max !== undefined ? Math.min(max, n) : n);
  return (
    <div className="inline-flex h-10 w-full items-center justify-between rounded-xl border bg-card">
      <button type="button" disabled={value <= min} onClick={() => onChange(clamp(value - 1))} className="inline-flex size-10 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-40" aria-label="-">
        <Minus className="size-4" />
      </button>
      <input
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(clamp(parseInt(e.target.value.replace(/\D/g, ""), 10) || min))}
        className="w-12 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
      />
      <button type="button" disabled={max !== undefined && value >= max} onClick={() => onChange(clamp(value + 1))} className="inline-flex size-10 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-40" aria-label="+">
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/**
 * Thiết lập riêng của chế độ tạo hàng loạt (bảng Thiết lập bên trái):
 * - công cụ video có ô ảnh khởi đầu: 4 thẻ nguồn ảnh + ô tải nhiều ảnh (mỗi video một ảnh) / lưới chọn ảnh đã tạo (từ dự án ảnh);
 * - số luồng tạo song song (1 – số luồng theo gói), đánh số từ, tên dự án.
 * Ô ảnh chung dùng ô ảnh khởi đầu sẵn có của form (trang công cụ chỉ ẩn ô đó khi chọn nguồn khác).
 */
export function BatchSettings({ tool, batch }: { tool: AiTool; batch: Batch }) {
  const { t } = useI18n();
  const f = batch.imgField;
  const isVideo = tool.output === "video";
  const modes = isVideo ? IMAGE_MODES_VIDEO : IMAGE_MODES_IMAGE;
  const active = batch.count.sending + batch.count.running;
  const prompts = batch.rows.length;
  return (
    <div className="mb-4 space-y-4">
      {f && (
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">{t("Nguồn ảnh")}</div>
          <div className="grid grid-cols-2 gap-2">
            {modes.map((m) => {
              const on = batch.imageMode === m.mode;
              // ô ảnh bắt buộc (hoặc model không có chế độ Chữ → Video) thì không chọn được "Chỉ prompt"
              const noTextMode =
                m.mode === "none" &&
                (!!f.required ||
                  (!!f.showIf &&
                    (() => {
                      const ctrl = tool.fields.find((x) => x.name === f.showIf!.field);
                      if (!ctrl) return false;
                      const allImgModes = new Set(
                        primaryImageFields(tool)
                          .filter((c) => c.showIf?.field === ctrl.name)
                          .flatMap((c) => c.showIf!.in),
                      );
                      return !fieldOptions(ctrl, batch.shared).some((o) => !allImgModes.has(o.value));
                    })()));
              const off = noTextMode;
              return (
                <button
                  key={m.mode}
                  type="button"
                  disabled={off || batch.busy}
                  onClick={() => batch.setImageMode(m.mode)}
                  aria-pressed={on}
                  className={cn("relative rounded-2xl border p-3 text-left transition disabled:opacity-40", on ? "border-primary bg-primary/10 ring-1 ring-primary" : "bg-card hover:border-foreground/30")}
                >
                  {on && <CheckCircle2 className="absolute top-2 right-2 size-4 text-primary" />}
                  <m.icon className={cn("size-5", on ? "text-primary" : "text-muted-foreground")} />
                  <span className="mt-1.5 block text-[13px] font-semibold">{t(m.title)}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{t(m.hint)}</span>
                </button>
              );
            })}
          </div>
          {batch.imageMode === "shared" && (
            <div className="mt-3">
              <ToolForm
                fields={[{ ...f, showIf: undefined }]}
                values={{ [f.name]: batch.shared[f.name] }}
                onChange={(v) => batch.updateShared({ [f.name]: v[f.name] })}
                disabled={batch.busy}
              />
            </div>
          )}
          {batch.imageMode === "each" && (
            <div className="mt-3">
              <ToolForm
                fields={[{ name: "images", label: isVideo ? t("Ảnh cho từng video (theo thứ tự dòng prompt)") : t("Ảnh cho từng dòng (theo thứ tự dòng prompt)"), type: "image", multiple: true, maxFiles: BATCH_MAX, accept: f.accept }]}
                values={{ images: batch.images }}
                onChange={(v) => batch.setImages(((v.images as string[] | undefined) ?? []).filter(Boolean))}
                disabled={batch.busy}
              />
              <ImageCount images={batch.images.length} prompts={prompts} />
            </div>
          )}
          {batch.imageMode === "project" && (
            <div className="mt-3">
              <ProjectImages selected={batch.images} onChange={batch.setImages} disabled={batch.busy} />
              <ImageCount images={batch.images.length} prompts={prompts} />
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">{t("Số luồng")}</div>
          <Stepper value={batch.limit} min={1} max={batch.maxThreads} onChange={batch.setLimit} />
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">{t("Đánh số từ")}</div>
          <Stepper value={batch.startNo} min={1} max={99999} onChange={batch.setStartNo} />
        </div>
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground">
        {t("Tạo cùng lúc tối đa {n} {x} của bạn (chỉnh được 1–{max}) · đang chạy {r}, {free} trống.", {
          n: batch.limit,
          x: isVideo ? t("video") : t("ảnh"),
          max: batch.maxThreads,
          r: active,
          free: Math.max(0, batch.limit - active),
        })}
      </p>
      <div>
        <div className="mb-1.5 text-[13px] font-semibold">{isVideo ? t("Tên dự án video") : t("Tên dự án")}</div>
        <input
          value={batch.project}
          maxLength={60}
          onChange={(e) => batch.setProject(e.target.value)}
          placeholder={t("Tự đặt theo giờ")}
          onFocus={() => {
            // để trống thì gợi ý tên theo giờ hiện tại (vd "Dự án 31-10 21:05")
            if (!batch.project) {
              const d = new Date();
              const p = (n: number) => String(n).padStart(2, "0");
              batch.setProject(`${t("Dự án")} ${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`);
            }
          }}
          className="h-10 w-full rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
        />
      </div>
    </div>
  );
}

/** Số ảnh so với số dòng prompt (ảnh thứ N ghép dòng N) */
function ImageCount({ images, prompts }: { images: number; prompts: number }) {
  const { t } = useI18n();
  if (!images && !prompts) return null;
  const short = prompts > images;
  return (
    <p className={cn("mt-1.5 text-[11px]", short ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
      {short ? t("Đã chọn {i} ảnh cho {p} dòng prompt — dòng thiếu ảnh sẽ không được gửi.", { i: images, p: prompts }) : t("Đã chọn {i} ảnh cho {p} dòng prompt.", { i: images, p: prompts })}
    </p>
  );
}

/**
 * Chọn ảnh đã tạo (tác vụ ảnh thành công của khách, chỉ ảnh đã lưu trên website) theo thứ tự bấm:
 * ảnh bấm thứ N ghép với prompt dòng N.
 */
function ProjectImages({ selected, onChange, disabled }: { selected: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["ai", "tasks", "project-images"],
    queryFn: () => api.get<Paginated<AiTask>>("/account/ai/tasks", { category: "image", status: "SUCCEEDED", limit: 100 }),
    meta: { silentError: true },
  });
  const urls = useMemo(() => (q.data?.data ?? []).flatMap((x) => (x.output?.files ?? []).filter((f) => f.type === "image" && isOwnOutput(f.url)).map((f) => f.url)), [q.data]);
  const toggle = (u: string) => onChange(selected.includes(u) ? selected.filter((x) => x !== u) : [...selected, u]);
  if (q.isLoading) return <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  if (!urls.length) return <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">{t("Bạn chưa có ảnh nào đã tạo. Hãy tạo ảnh ở trang Tạo ảnh trước.")}</p>;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{t("Bấm ảnh theo thứ tự muốn ghép với các dòng prompt")}</span>
        <span className="flex gap-2">
          <button type="button" disabled={disabled} onClick={() => onChange(urls)} className="font-medium text-foreground hover:underline">{t("Chọn tất cả")}</button>
          {selected.length > 0 && <button type="button" disabled={disabled} onClick={() => onChange([])} className="font-medium hover:underline">{t("Bỏ chọn")}</button>}
        </span>
      </div>
      <div className="studio-scroll grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto pr-1">
        {urls.map((u) => {
          const n = selected.indexOf(u);
          return (
            <button key={u} type="button" disabled={disabled} onClick={() => toggle(u)} className={cn("relative overflow-hidden rounded-lg border transition", n >= 0 ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" loading="lazy" className="aspect-square w-full object-cover" />
              {n >= 0 && <span className="absolute top-1 left-1 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{n + 1}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
