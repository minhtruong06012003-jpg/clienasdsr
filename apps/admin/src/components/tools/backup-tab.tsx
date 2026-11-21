'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Database, Download, HardDrive, Loader2, RotateCcw, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate, timeAgo } from '@/lib/format';

interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
  type: 'db' | 'uploads';
}

interface BackupSettings {
  schedule: 'none' | 'daily' | 'weekly';
  hour: number;
  keep: number;
  includeUploads: boolean;
}

interface BackupList {
  data: BackupFile[];
  dir: string;
  pgDump: { ok: boolean; via: 'cmd' | 'pg_dump'; version?: string; error?: string };
  settings: BackupSettings;
  writable: boolean;
}

interface JobStatus {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  lastError: string | null;
}

/** Tab Sao lưu: tạo/tải/xoá/khôi phục bản sao lưu + lịch tự động */
export function BackupTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [includeUploads, setIncludeUploads] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null);

  const list = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupList>('/admin/tools/backups') });

  // theo dõi job sao lưu đang chạy (poll 2 giây)
  const job = useQuery({
    queryKey: ['backup-job', jobId],
    queryFn: () => api.get<JobStatus | null>(`/admin/tools/backups/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && ['DONE', 'FAILED'].includes(q.state.data.status) ? false : 2000),
  });
  useEffect(() => {
    const s = job.data?.status;
    if (!s || !jobId) return;
    if (s === 'DONE') {
      toast.success('Đã tạo bản sao lưu');
      setJobId(null);
      void qc.invalidateQueries({ queryKey: ['backups'] });
    } else if (s === 'FAILED') {
      toast.error(job.data?.lastError || 'Sao lưu thất bại');
      setJobId(null);
      void qc.invalidateQueries({ queryKey: ['backups'] });
    }
  }, [job.data, jobId, qc]);

  const create = useMutation({
    mutationFn: () => api.post<{ jobId: string }>('/admin/tools/backups', { includeUploads }),
    onSuccess: (r) => {
      setJobId(r.jobId);
      toast.info('Đang sao lưu ở chế độ nền...');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/tools/backups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success('Đã xoá bản sao lưu');
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const download = async (name: string) => {
    try {
      await api.download(`/admin/tools/backups/${encodeURIComponent(name)}/download`, name);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const d = list.data;
  const busy = create.isPending || !!jobId;

  return (
    <div className="space-y-6">
      {d && !d.pgDump.ok && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Chưa sao lưu được database: {d.pgDump.error}</p>
            <p className="mt-1 text-xs">
              Cài <code>postgresql-client</code> trên máy chủ API (Docker image đã có sẵn) hoặc đặt biến môi trường <code>BACKUP_CMD</code> / <code>BACKUP_RESTORE_CMD</code>. Ví dụ dev:{' '}
              <code>BACKUP_CMD=&quot;docker exec novai-postgres pg_dump -U cmsnt -d novai --no-owner --clean --if-exists&quot;</code>.
            </p>
          </div>
        </div>
      )}
      {d && !d.writable && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Không ghi được thư mục sao lưu <code>{d.dir}</code>. Kiểm tra quyền thư mục hoặc đặt <code>BACKUP_DIR</code>.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Section
          title="Bản sao lưu"
          description={d ? `Lưu tại ${d.dir}` : undefined}
          actions={
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={includeUploads} onCheckedChange={(v) => setIncludeUploads(!!v)} /> Kèm thư mục uploads
              </label>
              <Button size="sm" onClick={() => create.mutate()} disabled={busy || !d?.pgDump.ok || !d?.writable}>
                {busy ? <Loader2 className="animate-spin" /> : <Save />} {busy ? 'Đang sao lưu...' : 'Tạo bản sao lưu'}
              </Button>
            </div>
          }
        >
          {list.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Đang tải...
            </div>
          ) : !d?.data.length ? (
            <EmptyState icon={Database} title="Chưa có bản sao lưu nào" description="Tạo bản sao lưu đầu tiên hoặc bật lịch tự động ở bên phải." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead className="text-right">Dung lượng</TableHead>
                  <TableHead>Thời gian</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.data.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell className="font-mono text-xs">{f.name}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        {f.type === 'db' ? <Database className="size-3.5" /> : <Archive className="size-3.5" />}
                        {f.type === 'db' ? 'Database' : 'Uploads'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-sm">{formatBytes(f.size)}</TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm">{timeAgo(f.createdAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatDate(f.createdAt, 'dd/MM/yyyy HH:mm:ss')}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button size="icon-sm" variant="ghost" onClick={() => void download(f.name)} aria-label="Tải về">
                              <Download />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Tải về</TooltipContent>
                        </Tooltip>
                        {f.type === 'db' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="icon-sm" variant="ghost" onClick={() => setRestoreTarget(f)} disabled={busy} aria-label="Khôi phục">
                                <RotateCcw />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Khôi phục database từ bản này</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              aria-label="Xoá"
                              onClick={async () => {
                                if (await confirm({ title: 'Xoá bản sao lưu?', description: `File ${f.name} sẽ bị xoá vĩnh viễn khỏi máy chủ.`, destructive: true, confirmText: 'Xoá' })) remove.mutate(f.name);
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Xoá</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-xs text-muted-foreground">
            Bản sao lưu database là file <code>.sql.gz</code> tạo bằng <code>pg_dump</code> ({d?.pgDump.via === 'cmd' ? 'qua BACKUP_CMD' : d?.pgDump.version ?? 'pg_dump'}). Khôi phục thủ công:{' '}
            <code>gunzip -c file.sql.gz | psql $DATABASE_URL</code>. Nên tải bản sao lưu về nơi lưu trữ khác định kỳ.
          </p>
        </Section>

        <ScheduleCard settings={d?.settings} />
      </div>

      <RestoreDialog file={restoreTarget} onClose={() => setRestoreTarget(null)} />
    </div>
  );
}

function ScheduleCard({ settings }: { settings?: BackupSettings }) {
  const qc = useQueryClient();
  const [v, setV] = useState<BackupSettings>({ schedule: 'none', hour: 3, keep: 7, includeUploads: false });
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (settings && !dirty) setV(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const patch = (p: Partial<BackupSettings>) => {
    setV((s) => ({ ...s, ...p }));
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => api.put('/admin/settings/backup', v),
    onSuccess: () => {
      toast.success('Đã lưu lịch sao lưu');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Section title="Lịch tự động" description="Chạy nền theo giờ máy chủ, tự xoá bản cũ">
      <div className="space-y-1.5">
        <Label>Tần suất</Label>
        <Select value={v.schedule} onValueChange={(s) => patch({ schedule: s as BackupSettings['schedule'] })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Tắt</SelectItem>
            <SelectItem value="daily">Hằng ngày</SelectItem>
            <SelectItem value="weekly">Hằng tuần (Chủ nhật)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Giờ chạy (0–23)</Label>
          <Input type="number" min={0} max={23} value={v.hour} onChange={(e) => patch({ hour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} disabled={v.schedule === 'none'} />
        </div>
        <div className="space-y-1.5">
          <Label>Giữ lại (bản)</Label>
          <Input type="number" min={1} max={100} value={v.keep} onChange={(e) => patch({ keep: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <span>
          Kèm thư mục uploads
          <span className="block text-xs text-muted-foreground">File nén có thể rất lớn nếu nhiều ảnh</span>
        </span>
        <Switch checked={v.includeUploads} onCheckedChange={(c) => patch({ includeUploads: c })} disabled={v.schedule === 'none'} />
      </label>
      <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className="w-full">
        {save.isPending ? <Loader2 className="animate-spin" /> : <HardDrive />} Lưu lịch
      </Button>
      <p className="text-xs text-muted-foreground">Số bản giữ lại cũng áp dụng khi sao lưu thủ công. Bản an toàn tạo trước khi khôi phục cũng tính vào số này.</p>
    </Section>
  );
}

function RestoreDialog({ file, onClose }: { file: BackupFile | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  useEffect(() => setText(''), [file]);
  const restore = useMutation({
    mutationFn: () => api.post<{ safetyBackup: string; ms: number }>(`/admin/tools/backups/${encodeURIComponent(file!.name)}/restore`, { confirm: 'RESTORE' }),
    onSuccess: (r) => {
      toast.success(`Đã khôi phục database (${(r.ms / 1000).toFixed(1)}s). Bản an toàn: ${r.safetyBackup}`);
      onClose();
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && !restore.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" /> Khôi phục database
          </DialogTitle>
          <DialogDescription>
            Toàn bộ dữ liệu hiện tại (trang, bài viết, sản phẩm, đơn hàng, thành viên, cài đặt...) sẽ bị <strong>thay thế</strong> bằng nội dung trong <code>{file?.name}</code>. Hệ thống sẽ tự tạo một bản sao
            lưu an toàn ngay trước khi khôi phục. Trong lúc chạy, website có thể lỗi tạm thời.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="restore-confirm">
            Gõ <code className="rounded bg-muted px-1">RESTORE</code> để xác nhận
          </Label>
          <Input id="restore-confirm" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="RESTORE" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={restore.isPending}>
            Huỷ
          </Button>
          <Button variant="destructive" onClick={() => restore.mutate()} disabled={text !== 'RESTORE' || restore.isPending}>
            {restore.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} {restore.isPending ? 'Đang khôi phục...' : 'Khôi phục ngay'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
