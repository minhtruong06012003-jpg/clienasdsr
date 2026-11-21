'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';

interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
  unknownColumns: string[];
}

/** Hộp thoại nhập sản phẩm từ CSV: kiểm tra (dryRun) trước, rồi nhập thật */
export function ProductImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { languages, defaultLocale } = useLanguages();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'upsert' | 'insert'>('upsert');
  const [locale, setLocale] = useState<string>('');
  const [createCategories, setCreateCategories] = useState(true);
  const [downloadImages, setDownloadImages] = useState(false);
  const [running, setRunning] = useState<'check' | 'import' | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const reset = () => {
    setFile(null);
    setReport(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const run = async (dryRun: boolean) => {
    if (!file) return toast.error('Vui lòng chọn file CSV');
    setRunning(dryRun ? 'check' : 'import');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);
      form.append('locale', locale || defaultLocale);
      form.append('dryRun', dryRun ? '1' : '0');
      form.append('createCategories', createCategories ? '1' : '0');
      form.append('downloadImages', downloadImages ? '1' : '0');
      const r = await api.upload<ImportReport>('/admin/products/import', form);
      setReport(r);
      if (!dryRun) {
        toast.success(`Đã nhập: ${r.created} mới, ${r.updated} cập nhật${r.errors.length ? `, ${r.errors.length} lỗi` : ''}`);
        void qc.invalidateQueries({ queryKey: ['products'] });
        void qc.invalidateQueries({ queryKey: ['product-categories'] });
        void qc.invalidateQueries({ queryKey: ['product-brands'] });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(null);
    }
  };

  const checked = report?.dryRun && file;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nhập sản phẩm từ CSV</DialogTitle>
          <DialogDescription>
            Hỗ trợ file xuất từ hệ thống này và file WooCommerce. Khớp sản phẩm theo <code>id</code> → <code>sku</code> → <code>slug</code>. Dòng biến thể dùng <code>parentSku</code> + <code>variantOptions</code>.{' '}
            <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => api.download('/admin/products/import-template.csv', 'products-template.csv').catch((e) => toast.error(errorMessage(e)))}>
              <Download className="size-3.5" /> Tải file mẫu
            </button>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="File CSV" required help="UTF-8, dấu phân cách , hoặc ; (tự nhận). Tối đa 5.000 dòng / 20MB.">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 text-sm hover:border-primary">
              <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)` : 'Bấm để chọn file .csv'}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReport(null);
                }}
              />
            </label>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chế độ">
              <Select value={mode} onValueChange={(v) => setMode(v as 'upsert' | 'insert')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="upsert">Thêm mới & cập nhật sản phẩm đã có</SelectItem>
                  <SelectItem value="insert">Chỉ thêm mới (bỏ qua sản phẩm đã có)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Ngôn ngữ của nội dung" help="Tên, mô tả, slug trong file thuộc ngôn ngữ này">
              <Select value={locale || defaultLocale} onValueChange={setLocale}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={createCategories} onCheckedChange={(v) => setCreateCategories(!!v)} />
              Tự tạo danh mục / thương hiệu chưa có
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={downloadImages} onCheckedChange={(v) => setDownloadImages(!!v)} />
              Tải ảnh từ URL ngoài về thư viện media <span className="text-xs text-muted-foreground">(tối đa 5MB/ảnh, chậm hơn)</span>
            </label>
          </div>

          {report && <ReportView r={report} />}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!running}>
            Đóng
          </Button>
          <Button variant="secondary" onClick={() => void run(true)} disabled={!file || !!running}>
            {running === 'check' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Kiểm tra
          </Button>
          <Button onClick={() => void run(false)} disabled={!file || !!running || (!!report && !report.dryRun)} title={!checked ? 'Nên bấm "Kiểm tra" trước để xem lỗi' : undefined}>
            {running === 'import' ? <Loader2 className="animate-spin" /> : <Upload />} Nhập
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Ô thống kê một con số (tổng / tạo / cập nhật / bỏ qua) trong kết quả nhập — khai báo ngoài render để không tạo lại component mỗi lần vẽ */
function Row({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-center">
      <div className={`text-lg font-semibold tabular-nums ${cls ?? ''}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ReportView({ r }: { r: ImportReport }) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">{r.dryRun ? 'Kết quả kiểm tra (chưa ghi dữ liệu)' : 'Kết quả nhập'}</p>
      <div className="grid grid-cols-4 gap-2">
        <Row label="Tổng" value={r.total} />
        <Row label={r.dryRun ? 'Sẽ tạo' : 'Đã tạo'} value={r.created} cls="text-emerald-600 dark:text-emerald-400" />
        <Row label={r.dryRun ? 'Sẽ cập nhật' : 'Đã cập nhật'} value={r.updated} cls="text-sky-600 dark:text-sky-400" />
        <Row label="Bỏ qua" value={r.skipped} cls={r.skipped ? 'text-amber-600 dark:text-amber-400' : ''} />
      </div>
      {r.unknownColumns.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Cột không nhận ra (bỏ qua): <span className="font-mono">{r.unknownColumns.join(', ')}</span>
        </p>
      )}
      {r.errors.length > 0 && <IssueTable title={`Lỗi (${r.errors.length})`} items={r.errors} tone="error" />}
      {r.warnings.length > 0 && <IssueTable title={`Cảnh báo (${r.warnings.length})`} items={r.warnings} tone="warn" />}
      {!r.errors.length && !r.warnings.length && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-4" /> Không có lỗi
        </p>
      )}
    </div>
  );
}

function IssueTable({ title, items, tone }: { title: string; items: { row: number; message: string }[]; tone: 'error' | 'warn' }) {
  const cls = tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400';
  return (
    <div>
      <p className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${cls}`}>
        <AlertTriangle className="size-3.5" /> {title}
      </p>
      <div className="max-h-48 overflow-y-auto rounded-md border bg-background text-xs">
        <table className="w-full">
          <tbody>
            {items.map((e, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="w-16 px-2 py-1 font-mono text-muted-foreground">Dòng {e.row}</td>
                <td className="px-2 py-1">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Nút xuất CSV theo bộ lọc hiện tại của danh sách */
export function ExportCsvButton({ params }: { params: Record<string, string | number | undefined> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const q = new URLSearchParams();
          for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && !['page', 'limit', 'sort', 'order', 'trashed'].includes(k)) q.set(k, String(v));
          const s = q.toString();
          await api.download(`/admin/products/export.csv${s ? `?${s}` : ''}`, `products-${new Date().toISOString().slice(0, 10)}.csv`);
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Download />} Xuất CSV
    </Button>
  );
}
