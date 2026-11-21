'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileJson, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';

const SECTIONS = [
  { key: 'pages', label: 'Trang (kèm nội dung Page Builder)' },
  { key: 'blocks', label: 'Block dùng chung' },
  { key: 'menus', label: 'Menu' },
  { key: 'settings', label: 'Cài đặt (trừ SMTP)' },
  { key: 'languages', label: 'Ngôn ngữ' },
];

const LABEL: Record<string, string> = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]));

type Report = Record<string, { created: number; updated: number; skipped: number }>;

export function ExportImportTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.key));
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<'skip' | 'overwrite'>('skip');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<Report | null>(null);

  const doExport = async () => {
    setExporting(true);
    try {
      const bundle = await api.get<object>('/admin/tools/export', { sections: sections.join(',') });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cmsnt-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const doImport = async (file: File) => {
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      return toast.error('File JSON không hợp lệ');
    }
    if (
      mode === 'overwrite' &&
      !(await confirm({ title: 'Ghi đè dữ liệu trùng?', description: 'Trang, block, menu, cài đặt trùng key/slug sẽ bị thay bằng nội dung trong file. Nên sao lưu database trước (pnpm db:backup).', destructive: true, confirmText: 'Nhập và ghi đè' }))
    )
      return;
    setImporting(true);
    setReport(null);
    try {
      const res = await api.post<{ report: Report }>('/admin/tools/import', { bundle, mode });
      setReport(res.report);
      toast.success('Nhập dữ liệu hoàn tất');
      void qc.invalidateQueries();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Xuất dữ liệu" description="Tải về file JSON chứa bộ giao diện & cấu hình hiện tại. Bài viết, sản phẩm, đơn hàng và thành viên không được xuất.">
        <div className="space-y-2">
          {SECTIONS.map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={sections.includes(s.key)} onCheckedChange={(v) => setSections(v ? [...sections, s.key] : sections.filter((x) => x !== s.key))} />
              {s.label}
            </label>
          ))}
        </div>
        <Button onClick={doExport} disabled={exporting || !sections.length}>
          {exporting ? <Loader2 className="animate-spin" /> : <Download />} Tải file xuất
        </Button>
      </Section>

      <Section title="Nhập dữ liệu" description="Nhập file JSON xuất từ một website Admin Panel khác. Thao tác chỉ thêm / cập nhật, không xoá dữ liệu hiện có.">
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'skip' | 'overwrite')} className="space-y-1">
          <div className="flex items-start gap-2">
            <RadioGroupItem value="skip" id="mode-skip" className="mt-0.5" />
            <Label htmlFor="mode-skip" className="block font-normal">
              <span className="font-medium">Bỏ qua mục đã tồn tại</span>
              <span className="block text-xs text-muted-foreground">An toàn — chỉ thêm mục mới (trang mới được tạo ở dạng nháp)</span>
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="overwrite" id="mode-overwrite" className="mt-0.5" />
            <Label htmlFor="mode-overwrite" className="block font-normal">
              <span className="font-medium">Ghi đè mục trùng</span>
              <span className="block text-xs text-muted-foreground">Cập nhật mục trùng key/slug theo nội dung trong file</span>
            </Label>
          </div>
        </RadioGroup>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = '';
          }}
        />
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? <Loader2 className="animate-spin" /> : <Upload />} Chọn file JSON để nhập
        </Button>
        {report && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mục</TableHead>
                <TableHead className="text-right">Tạo mới</TableHead>
                <TableHead className="text-right">Cập nhật</TableHead>
                <TableHead className="text-right">Bỏ qua</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(report).map(([k, r]) => (
                <TableRow key={k}>
                  <TableCell className="flex items-center gap-2">
                    <FileJson className="size-4 text-muted-foreground" /> {LABEL[k] ?? k}
                  </TableCell>
                  <TableCell className="text-right text-emerald-600 dark:text-emerald-400">{r.created}</TableCell>
                  <TableCell className="text-right text-blue-600 dark:text-blue-400">{r.updated}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{r.skipped}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">Lưu ý: ảnh trong nội dung vẫn trỏ về URL của website gốc — hãy tải lại ảnh vào thư viện Media nếu website gốc sẽ ngừng hoạt động.</p>
      </Section>
    </div>
  );
}
