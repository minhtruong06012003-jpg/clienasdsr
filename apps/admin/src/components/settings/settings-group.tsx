'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useSettingGroup } from '@/hooks/use-settings';
import { cn } from '@/lib/utils';
import { useUnsavedGuard } from '@/hooks/use-unsaved';

// giá trị cài đặt có cấu trúc linh hoạt theo từng nhóm
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Values = Record<string, any>;
export type SetValues = (patch: Values) => void;

/** Trường lưu media id: API có thể trả về object media -> chuẩn hoá về id */
export function mediaId(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'id' in (v as object)) return String((v as { id: string }).id);
  return null;
}

/** Object media (nếu có) để ImageIdField hiển thị ngay không cần tải lại */
export function mediaInitial(v: unknown) {
  return v && typeof v === 'object' && 'url' in (v as object) ? (v as { id: string; url: string; urls?: Record<string, string> }) : undefined;
}

/**
 * Khung form cho một nhóm cài đặt: tải dữ liệu, giữ bản nháp, theo dõi thay đổi chưa lưu,
 * nút Lưu / Hoàn tác riêng cho từng nhóm (PUT /admin/settings/:group).
 */
export function SettingsGroup({
  group,
  mediaFields = [],
  onDirtyChange,
  onSaved,
  children,
}: {
  group: string;
  /** các khoá lưu media id (logo, favicon...) */
  mediaFields?: string[];
  onDirtyChange?: (dirty: boolean) => void;
  /** gọi sau khi lưu xong (vd làm mới dữ liệu phụ thuộc cài đặt) */
  onSaved?: () => void;
  children: (values: Values, set: SetValues, original: Values) => ReactNode;
}) {
  const qc = useQueryClient();
  const query = useSettingGroup<Values>(group);
  const [values, setValues] = useState<Values | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (query.data && !values) setValues(query.data);
  }, [query.data, values]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const set: SetValues = useCallback((patch) => {
    setValues((v) => (v ? { ...v, ...patch } : v));
    setDirty(true);
  }, []);

  const save = useMutation({
    mutationFn: () => {
      if (!values) throw new Error('Chưa sẵn sàng');
      const body: Values = { ...values };
      for (const k of mediaFields) body[k] = mediaId(body[k]);
      return api.put<Values>(`/admin/settings/${group}`, body);
    },
    onSuccess: (data) => {
      toast.success('Đã lưu cài đặt');
      qc.setQueryData(['settings', group], data);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      setValues(data);
      setDirty(false);
      onSaved?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (dirty && !save.isPending) save.mutate();
  }, [dirty, save]);
  useUnsavedGuard(dirty, doSave);

  if (!values) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {children(values, set, query.data ?? {})}
      <SettingsSaveBar
        dirty={dirty}
        saving={save.isPending}
        onReset={() => {
          setValues(query.data ?? null);
          setDirty(false);
        }}
        onSave={() => save.mutate()}
      />
    </div>
  );
}

/** Giá trị của nhiều nhóm cài đặt cùng lúc: { [group]: Values } */
export type GroupValues = Record<string, Values>;
export type SetGroupValues = (group: string, patch: Values) => void;

/**
 * Như SettingsGroup nhưng cho một tab gồm NHIỀU nhóm cài đặt (vd Cổng thanh toán = payos + sepay + pay2s):
 * tải tất cả nhóm, giữ bản nháp riêng từng nhóm, một thanh Lưu / Hoàn tác chung.
 * Khi lưu chỉ gửi PUT cho các nhóm có thay đổi, lần lượt từng nhóm; nhóm nào lỗi thì vẫn giữ trạng thái chưa lưu.
 */
export function MultiSettingsGroup({
  groups,
  onDirtyChange,
  onSaved,
  children,
}: {
  /** danh sách nhóm — cố định trong suốt vòng đời component */
  groups: readonly string[];
  onDirtyChange?: (dirty: boolean) => void;
  /** gọi sau khi lưu xong (vd làm mới dữ liệu phụ thuộc cài đặt) */
  onSaved?: () => void;
  children: (values: GroupValues, set: SetGroupValues, original: GroupValues) => ReactNode;
}) {
  const qc = useQueryClient();
  const queries = useQueries({ queries: groups.map((g) => ({ queryKey: ['settings', g], queryFn: () => api.get<Values>(`/admin/settings/${g}`) })) });
  const loaded = queries.every((q) => q.data);
  const original: GroupValues = Object.fromEntries(groups.map((g, i) => [g, queries[i].data ?? {}]));
  const [values, setValues] = useState<GroupValues | null>(null);
  // tập nhóm đang có thay đổi chưa lưu
  const [dirtyGroups, setDirtyGroups] = useState<string[]>([]);
  const dirty = dirtyGroups.length > 0;

  // nạp bản nháp lần đầu khi mọi nhóm đã tải xong
  useEffect(() => {
    if (loaded && !values) setValues(Object.fromEntries(groups.map((g, i) => [g, queries[i].data as Values])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, values]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const set: SetGroupValues = (group, patch) => {
    setValues((v) => (v ? { ...v, [group]: { ...v[group], ...patch } } : v));
    setDirtyGroups((d) => (d.includes(group) ? d : [...d, group]));
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!values) throw new Error('Chưa sẵn sàng');
      // lưu tuần tự: nhóm nào xong thì cập nhật bản nháp + bỏ khỏi danh sách chưa lưu ngay
      for (const g of groups.filter((x) => dirtyGroups.includes(x))) {
        const data = await api.put<Values>(`/admin/settings/${g}`, values[g]);
        qc.setQueryData(['settings', g], data);
        setValues((v) => (v ? { ...v, [g]: data } : v));
        setDirtyGroups((d) => d.filter((x) => x !== g));
      }
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt');
      onSaved?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const doSave = useCallback(() => {
    if (dirty && !save.isPending) save.mutate();
  }, [dirty, save]);
  useUnsavedGuard(dirty, doSave);

  if (!values) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {children(values, set, original)}
      <SettingsSaveBar
        dirty={dirty}
        saving={save.isPending}
        onReset={() => {
          setValues(original);
          setDirtyGroups([]);
        }}
        onSave={() => save.mutate()}
      />
    </div>
  );
}

/**
 * Thanh Lưu / Hoàn tác dính đáy màn hình, dùng chung cho mọi tab Cài đặt.
 * Khi có thay đổi: nổi bật viền + nhãn cảnh báo; khi sạch: báo "Đã lưu" nhẹ nhàng. Gợi ý phím tắt ⌘/Ctrl+S.
 */
export function SettingsSaveBar({ dirty, saving, onSave, onReset, saveLabel = 'Lưu thay đổi' }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; saveLabel?: string }) {
  // nhãn phím tắt theo hệ điều hành (đọc sau khi mount để không lệch HTML lúc SSR)
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur transition-colors md:-mx-6 md:px-6',
        dirty && 'border-t-amber-300 dark:border-t-amber-800',
      )}
    >
      {dirty ? (
        <span className="mr-auto flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
          </span>
          Có thay đổi chưa lưu
        </span>
      ) : (
        <span className="mr-auto flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> Đã lưu mọi thay đổi
        </span>
      )}
      <Button variant="ghost" disabled={!dirty || saving} onClick={onReset}>
        <RotateCcw /> Hoàn tác
      </Button>
      <Button onClick={onSave} disabled={!dirty || saving}>
        {saving ? <Loader2 className="animate-spin" /> : <Save />} {saveLabel}
        <kbd className="ml-1 hidden rounded bg-primary-foreground/15 px-1.5 font-sans text-[10px] font-medium sm:inline">{mac ? '⌘S' : 'Ctrl+S'}</kbd>
      </Button>
    </div>
  );
}
