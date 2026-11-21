'use client';

/**
 * Nhóm model (dùng ở tab "Nhóm & model" — components/ai/group-tree-tab.tsx): logic gom nhóm + hộp tạo / sửa nhóm model.
 * Nhóm model không có bảng riêng: là danh sách tên `modelGroups` gắn trên từng công cụ — các công cụ cùng tên nhóm
 * gộp thành 1 công cụ trên website khách (tên = tên nhóm), khách chọn model theo `modelLabel`.
 * Một công cụ (model) có thể nằm trong nhiều nhóm cùng lúc; tên model (`modelLabel`) dùng chung cho mọi nhóm.
 * - Tạo nhóm: đặt tên + tích chọn các công cụ (model) đưa vào nhóm, đặt tên model hiện cho khách.
 * - Sửa nhóm: đổi tên (ghi tên mới lên mọi công cụ trong nhóm), thêm / bớt công cụ, sửa tên model.
 * - Tách nhóm: bỏ tên nhóm khỏi mọi công cụ trong nhóm (công cụ đứng riêng lại, không xoá gì).
 * - Bật / tắt nhóm: bật hoặc tắt cùng lúc mọi model trong nhóm (tắt hết = nhóm biến mất khỏi website khách).
 * - Nhóm cha = nhóm công cụ (Video, Hình ảnh...): cây Nhóm › Nhóm model xếp các nhóm model theo nhóm cha, hộp sửa
 *   gán nhóm cha cho các model chỉ thuộc nhóm này. Model dùng chung nhiều nhóm giữ nguyên nhóm cha của nó; nhóm cha của
 *   nhóm model = nhóm cha của model riêng đầu tiên (website `mergeModelGroups` dùng đúng quy tắc này).
 * API dùng chung PUT /admin/ai/tools/:key { modelGroups, modelLabel } (mảng rỗng = đứng riêng; tên model rỗng = dùng tên công cụ).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { CategoryIcon } from '@/components/ai/categories-tab';
import { type ToolCategory } from '@/components/ai/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';

/** Phần thông tin công cụ mà tab nhóm model cần (lấy từ GET /admin/ai/tools) */
export interface GroupTool {
  key: string;
  provider: string;
  /** Khoá nhóm công cụ (tab Nhóm & model) — dùng làm nhóm cha của nhóm model */
  category: string;
  name: string;
  enabled: boolean;
  maintenance?: boolean;
  sortOrder: number;
  /** Các nhóm model công cụ đang thuộc (rỗng = đứng riêng) */
  modelGroups: string[];
  modelLabel: string | null;
  /** công cụ gốc đã tách theo model: số model con (0 = không tách) */
  models: number;
}

/** Một nhóm model gom từ danh sách công cụ */
export interface GroupRow {
  id: string;
  name: string;
  tools: GroupTool[];
  /** Nhóm cha = nhóm của model riêng (chỉ thuộc nhóm này) đầu tiên, không có thì model đầu tiên — website xếp giống vậy */
  parent: string;
  /** Các nhóm cha khác nhau của các model riêng trong nhóm (> 1 = lệch, cần sửa); model dùng chung nhiều nhóm không tính */
  parents: string[];
  /** Model đại diện (model riêng đầu tiên, không có thì model đầu tiên): website đặt công cụ đã gộp đúng vị trí model này */
  rep: GroupTool;
  /** Vị trí model đại diện trong danh sách công cụ (dùng để xếp nhóm model giống website) */
  rank: number;
}

/** Model chỉ thuộc đúng 1 nhóm model (nhóm cha của nó quyết định nhóm cha của nhóm) */
export const exclusive = (t: GroupTool) => t.modelGroups.length <= 1;

/** Sắp model theo cột Thứ tự (website cũng hiện model theo thứ tự này) */
const byOrder = (a: GroupTool, b: GroupTool) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'vi');

/**
 * Gom công cụ thành các nhóm model, xếp theo vị trí model đại diện (giống website `mergeModelGroups`);
 * một công cụ ở nhiều nhóm thì xuất hiện trong từng nhóm đó.
 * `tools` phải theo đúng thứ tự API trả về (sortOrder, thời điểm tạo, tên) — model trong nhóm giữ thứ tự này.
 */
export function buildModelGroups(tools: GroupTool[] | undefined): GroupRow[] {
  const list = tools ?? [];
  const index = new Map(list.map((t, i) => [t.key, i]));
  const map = new Map<string, GroupTool[]>();
  for (const t of list) for (const g of t.modelGroups) map.set(g, [...(map.get(g) ?? []), t]);
  return [...map.entries()]
    .map(([name, items]) => {
      const own = items.filter(exclusive);
      const rep = own[0] ?? items[0];
      return { id: name, name, tools: items, parent: rep.category, parents: [...new Set(own.map((t) => t.category))], rep, rank: index.get(rep.key)! };
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Hộp tạo / sửa nhóm model: tên nhóm, danh sách công cụ trong nhóm (tích chọn) và tên model hiện cho khách.
 * Chỉ gửi PUT cho công cụ có thay đổi: vào nhóm / đổi tên nhóm / đổi tên model / bị bỏ khỏi nhóm.
 */
export function ModelGroupEditDialog({
  name,
  tools,
  groups,
  categories,
  defaultParent,
  providerName,
  onClose,
}: {
  name: string;
  tools: GroupTool[];
  groups: string[];
  categories: ToolCategory[];
  /** Nhóm cha đang có của nhóm (sửa) hoặc nhóm cha gợi ý (thêm mới) */
  defaultParent: string;
  providerName: (key: string) => string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = !name;
  const [groupName, setGroupName] = useState(name);
  // nhóm cha gán cho mọi model trong nhóm khi lưu
  const [parent, setParent] = useState(defaultParent);
  // công cụ đang chọn vào nhóm -> tên model (chuỗi rỗng = dùng tên công cụ)
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map(tools.filter((t) => name && t.modelGroups.includes(name)).map((t) => [t.key, t.modelLabel ?? ''])));
  const [search, setSearch] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);

  const trimmed = groupName.trim();
  // trùng tên nhóm khác -> chặn (muốn gộp 2 nhóm thì sửa từng nhóm, tránh lỡ tay trộn)
  const duplicate = !!trimmed && trimmed !== name && groups.includes(trimmed);

  // công cụ gốc đã tách thành model con thì không đưa vào nhóm (website dùng các model con)
  const candidates = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const norm = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .replace(/[()[\]{}·•–—―\-_/,:;|+~]+/g, ' ')
        .replace(/(?:^|\s)\.+|\.(?=\s|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const normQ = kw ? norm(kw) : '';
    const tokens = normQ ? normQ.split(' ').filter(Boolean) : [];
    return tools
      .filter((t) => t.models === 0 || picked.has(t.key))
      .filter((t) => !onlyPicked || picked.has(t.key))
      .filter((t) => {
        if (!kw) return true;
        const pName = providerName(t.provider);
        if (
          t.name.toLowerCase().includes(kw) ||
          (t.modelLabel ?? '').toLowerCase().includes(kw) ||
          t.key.toLowerCase().includes(kw) ||
          t.modelGroups.some((g) => g.toLowerCase().includes(kw)) ||
          pName.toLowerCase().includes(kw)
        ) {
          return true;
        }
        if (!normQ) return true;
        const hay = norm([t.name, t.modelLabel ?? '', t.key, pName, ...t.modelGroups].join(' '));
        return hay.includes(normQ) || (tokens.length > 1 && tokens.every((tok) => hay.includes(tok)));
      })
      .sort((a, b) => Number(picked.has(b.key)) - Number(picked.has(a.key)) || byOrder(a, b));
  }, [tools, picked, search, onlyPicked, providerName]);

  const toggle = (t: GroupTool, on: boolean) =>
    setPicked((m) => {
      const next = new Map(m);
      if (on) next.set(t.key, t.modelLabel ?? '');
      else next.delete(t.key);
      return next;
    });
  const setLabel = (key: string, label: string) => setPicked((m) => new Map(m).set(key, label));

  // các thay đổi cần gửi lên API (chỉ đụng tới tên nhóm này trong danh sách nhóm của công cụ, giữ nguyên các nhóm khác)
  const changes = useMemo(() => {
    const list: { key: string; body: { modelGroups: string[]; modelLabel?: string; category?: string } }[] = [];
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    for (const t of tools) {
      const label = picked.get(t.key);
      if (label !== undefined) {
        // model trong nhóm: thay tên cũ bằng tên mới tại chỗ (giữ thứ tự nhóm), chưa có thì thêm vào cuối
        const next = t.modelGroups.includes(name) ? t.modelGroups.map((g) => (g === name ? trimmed : g)) : [...t.modelGroups, trimmed];
        const groups = [...new Set(next)];
        // nhóm cha chỉ đổi cho model chỉ thuộc nhóm này (model dùng chung giữ nhóm cha cũ để không làm lệch nhóm khác)
        const moveParent = !!parent && groups.length === 1 && t.category !== parent;
        if (!same(groups, t.modelGroups) || (t.modelLabel ?? '') !== label.trim() || moveParent)
          list.push({ key: t.key, body: { modelGroups: groups, modelLabel: label.trim(), ...(moveParent ? { category: parent } : {}) } });
      } else if (name && t.modelGroups.includes(name)) list.push({ key: t.key, body: { modelGroups: t.modelGroups.filter((g) => g !== name) } });
    }
    return list;
  }, [tools, picked, trimmed, name, parent]);

  const toggleMaint = useMutation({
    mutationFn: (r: { key: string; maintenance: boolean }) => api.put(`/admin/ai/tools/${encodeURIComponent(r.key)}`, { maintenance: r.maintenance }),
    onSuccess: (_d, r) => {
      toast.success(r.maintenance ? 'Đã bật chế độ Đang bảo trì cho model này' : 'Đã tắt bảo trì cho model này');
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const save = useMutation({
    mutationFn: async () => {
      for (const c of changes) await api.put(`/admin/ai/tools/${encodeURIComponent(c.key)}`, c.body);
      if (name && trimmed && name !== trimmed) {
        for (const cat of categories) {
          if (cat.groupOrder?.includes(name)) {
            await api.put(`/admin/ai/categories/${encodeURIComponent(cat.key)}`, {
              groupOrder: cat.groupOrder.map((g) => (g === name ? trimmed : g)),
            });
          }
        }
      }
    },
    onSuccess: () => {
      toast.success(isNew ? `Đã tạo nhóm model “${trimmed}”` : `Đã lưu nhóm model “${trimmed}”`);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
    // đổi nhóm cha làm thay đổi cả số công cụ của các nhóm
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
      void qc.invalidateQueries({ queryKey: ['ai-categories'] });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Thêm nhóm model' : 'Sửa nhóm model'}</DialogTitle>
          <DialogDescription>Tích chọn các công cụ đưa vào nhóm và đặt tên model hiện trong ô chọn model của khách (bỏ trống = tên công cụ). Một công cụ có thể nằm trong nhiều nhóm, tên model dùng chung cho mọi nhóm.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Tên nhóm model" required error={duplicate ? 'Đã có nhóm model trùng tên' : undefined} help="Tên hiện trên website khách cho công cụ đã gộp.">
            <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={80} placeholder="vd Tạo video AI" autoFocus />
          </Field>
          <Field label="Nhóm cha" required help="Nhóm trên menu website khách chứa công cụ đã gộp. Áp dụng cho các model chỉ thuộc nhóm này (model dùng chung nhiều nhóm giữ nhóm cha cũ). Thêm nhóm cha mới bằng nút “Thêm nhóm” ở tab Nhóm &amp; model.">
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Chọn nhóm cha" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    <CategoryIcon name={c.icon} className="size-4" /> {c.label}
                    {!c.enabled && <span className="text-xs text-muted-foreground">(đang tắt)</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={`Công cụ trong nhóm (${picked.size})`}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm tên, mã công cụ, nhà cung cấp..." className="pl-8" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={onlyPicked} onCheckedChange={(v) => setOnlyPicked(v === true)} /> Chỉ hiện đã chọn
              </label>
            </div>
            <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
              {candidates.length === 0 && <div className="p-4 text-center text-sm text-muted-foreground">Không có công cụ khớp</div>}
              {candidates.map((t) => {
                const on = picked.has(t.key);
                // công cụ đang thuộc nhóm khác: chọn vào đây thì vẫn ở nhóm cũ, thêm cả nhóm này
                const other = t.modelGroups.filter((g) => g !== name).join(', ');
                return (
                  <div key={t.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                      <Checkbox checked={on} onCheckedChange={(v) => toggle(t, v === true)} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {t.name} {!t.enabled && <span className="text-xs font-normal text-muted-foreground">(đang tắt)</span>}
                          {t.maintenance && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">Đang bảo trì</span>}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {providerName(t.provider)} · <span className="font-mono">{t.key}</span>
                          {other && <span className="text-sky-600"> · {on ? 'cũng ở' : 'đang ở'} nhóm “{other}”</span>}
                        </div>
                      </div>
                    </label>
                    {on && (
                      <div className="flex w-full items-center gap-1.5 sm:w-auto">
                        <Button
                          type="button"
                          size="sm"
                          variant={t.maintenance ? 'default' : 'outline'}
                          className={t.maintenance ? 'h-8 shrink-0 bg-amber-500 text-zinc-950 hover:bg-amber-400' : 'h-8 shrink-0 text-xs'}
                          disabled={toggleMaint.isPending && toggleMaint.variables?.key === t.key}
                          onClick={() => toggleMaint.mutate({ key: t.key, maintenance: !t.maintenance })}
                          title={t.maintenance ? 'Bấm để tắt bảo trì (mở lại nút Tạo ngay)' : 'Bấm để chuyển model này sang chế độ Đang bảo trì'}
                        >
                          <Wrench className="size-3.5" />
                          {t.maintenance ? 'Đang bảo trì' : 'Bảo trì'}
                        </Button>
                        <Input value={picked.get(t.key) ?? ''} onChange={(e) => setLabel(t.key, e.target.value)} maxLength={200} placeholder={t.name} className="h-8 flex-1 sm:w-52" aria-label="Tên model" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !trimmed || !parent || duplicate || !picked.size || !changes.length}>
            {isNew ? 'Tạo nhóm' : 'Lưu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
