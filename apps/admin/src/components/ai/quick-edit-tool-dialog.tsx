'use client';

/**
 * Hộp thoại "Sửa công cụ" mở nhanh từ bất kỳ nơi nào (vd bấm trực tiếp tên công cụ trong Chi tiết tác vụ AI — T-415 & T-416)
 * với đầy đủ 100% tính năng y hệt trang `/ai/tools` (tên, mô tả, nhóm menu, nhóm model, mã model API, video/ảnh mẫu,
 * Đang bật / Chế độ bảo trì / Nổi bật, Giá bán VND & Xoá công cụ).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, Loader2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { fmtCount, useToolCategories } from '@/components/ai/shared';
import { CategoryIcon } from '@/components/ai/categories-tab';
import { ApiModelField } from '@/components/ai/api-model-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';

interface Pricing {
  mode?: 'fixed' | 'cost' | 'free' | 'tiers' | 'per_second' | 'per_char' | 'by_resolution';
  base?: number;
  perUnit?: number;
  resolutionPrices?: Record<string, number>;
  tier10to20?: number;
  tier20to30?: number;
  multiplier?: number;
  markup?: number;
  min?: number;
  customPrice?: boolean;
}

interface QuickToolRow {
  id: string;
  key: string;
  provider: string;
  category: string;
  name: string;
  description: string | null;
  icon: string | null;
  badge: string | null;
  enabled: boolean;
  maintenance?: boolean;
  featured: boolean;
  sortOrder: number;
  pricing: Pricing;
  unitLabel: string | null;
  defaultPricing: Pricing | null;
  supportsCost: boolean;
  supportsDurationTiers?: boolean;
  supportsPerSecond?: boolean;
  supportsPerChar?: boolean;
  resolutionOptions?: { value: string; label: string }[];
  rate: number;
  costUnit: string | null;
  tasks: number;
  modelGroups: string[];
  modelLabel: string | null;
  demoVideo?: string | null;
  models: number;
}

const fmtRate = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
const fmtPrice = (n: number | null | undefined) => `${(Number(n) || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 })}đ`;

export function QuickEditToolDialog({ toolKey, onClose }: { toolKey: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const q = useQuery({
    queryKey: ['ai-tools'],
    queryFn: () => api.get<{ tools: QuickToolRow[] }>('/admin/ai/tools'),
    enabled: !!toolKey,
  });

  const tools = q.data?.tools ?? [];
  const tool = useMemo(() => (toolKey ? tools.find((t) => t.key === toolKey) ?? null : null), [tools, toolKey]);
  const modelGroups = useMemo(() => {
    const s = new Set<string>();
    for (const t of tools) for (const g of t.modelGroups ?? []) if (g) s.add(g);
    return [...s].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [tools]);

  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/admin/ai/tools/${encodeURIComponent(key)}`),
    onSuccess: () => {
      toast.success('Đã xoá công cụ');
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!toolKey) return null;

  if (q.isLoading) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sửa công cụ</DialogTitle>
            <DialogDescription className="font-mono text-xs">{toolKey}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!tool) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sửa công cụ</DialogTitle>
            <DialogDescription className="font-mono text-xs">{toolKey}</DialogDescription>
          </DialogHeader>
          <p className="py-4 text-sm text-muted-foreground">Công cụ này không tồn tại hoặc đã bị xoá ẩn khỏi danh sách.</p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const askRemove = async () => {
    const extra = tool.models ? ` và ${tool.models} model con` : '';
    const history = tool.tasks ? ` Công cụ đã có ${fmtCount(tool.tasks)} lượt chạy: lịch sử tác vụ của khách vẫn được giữ.` : '';
    if (
      await confirm({
        title: `Xoá công cụ "${tool.name}"?`,
        description: `Công cụ${extra} sẽ bị tắt và biến mất khỏi website lẫn trang quản trị (khôi phục lại ở nút "Đã xoá").${history}`,
        destructive: true,
        confirmText: 'Xoá',
      })
    ) {
      remove.mutate(tool.key);
    }
  };

  return (
    <QuickEditToolForm
      key={tool.key}
      tool={tool}
      groups={modelGroups}
      onClose={onClose}
      onRemove={() => void askRemove()}
      deleting={remove.isPending}
    />
  );
}

function QuickEditToolForm({
  tool,
  groups,
  onClose,
  onRemove,
  deleting,
}: {
  tool: QuickToolRow;
  groups: string[];
  onClose: () => void;
  onRemove: () => void;
  deleting: boolean;
}) {
  const qc = useQueryClient();
  const cats = useToolCategories();
  const [uploadingDemo, setUploadingDemo] = useState(false);
  const merged = { ...tool.defaultPricing, ...tool.pricing };
  const initialCustomPrice =
    merged.customPrice !== undefined
      ? !!merged.customPrice
      : !!(tool.pricing?.mode && tool.pricing.mode !== 'cost' && tool.pricing.mode !== 'free' && tool.supportsCost);

  const [f, setF] = useState({
    name: tool.name,
    description: tool.description ?? '',
    category: tool.category,
    icon: tool.icon ?? '',
    badge: tool.badge ?? '',
    sortOrder: tool.sortOrder,
    featured: tool.featured,
    enabled: tool.enabled,
    maintenance: !!tool.maintenance,
    modelGroups: tool.modelGroups ?? [],
    modelLabel: tool.modelLabel ?? '',
    demoVideo: tool.demoVideo ?? '',
    applyDemoToGroup: false,
    pricing: {
      mode: merged.mode ?? 'fixed',
      base: merged.base ?? 0,
      perUnit: merged.perUnit ?? 0,
      resolutionPrices: { ...(merged.resolutionPrices ?? {}) },
      tier10to20: merged.tier10to20 ?? merged.base ?? 0,
      tier20to30: merged.tier20to30 ?? merged.tier10to20 ?? merged.base ?? 0,
      multiplier: merged.multiplier ?? 1,
      markup: merged.markup ?? 0,
      min: merged.min ?? 0,
      customPrice: initialCustomPrice,
    } as Required<Pricing>,
  });

  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }));
  const setP = (patch: Partial<Pricing>) => setF((s) => ({ ...s, pricing: { ...s.pricing, ...patch } }));

  const save = useMutation({
    mutationFn: () => api.put(`/admin/ai/tools/${encodeURIComponent(tool.key)}`, f),
    onSuccess: () => {
      toast.success('Đã lưu công cụ');
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
      void qc.invalidateQueries({ queryKey: ['ai-categories'] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const cost = f.pricing.mode === 'cost';
  const tiers = f.pricing.mode === 'tiers';
  const perSecond = f.pricing.mode === 'per_second';
  const perChar = f.pricing.mode === 'per_char';
  const byResolution = f.pricing.mode === 'by_resolution';
  const resOpts = tool.resolutionOptions ?? [];
  const free = f.pricing.mode === 'free';
  const invalidResolutionPrices = byResolution && (!resOpts.length || resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) <= 0));
  const missingPerSecond =
    perSecond && (f.pricing.perUnit ?? 0) <= 0 && (!resOpts.length || resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) <= 0));
  const missingPerChar = perChar && (f.pricing.perUnit ?? 0) <= 0;

  const perSecondOf = (res: string) => Number(f.pricing.resolutionPrices?.[res]) || f.pricing.perUnit || 0;
  const samplePerSecond = (sec: number, perSec = Number(f.pricing.perUnit) || 0) => {
    const raw = ((Number(f.pricing.base) || 0) + perSec * sec) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100);
    return Math.max(Math.ceil(raw), Math.ceil(Number(f.pricing.min) || 0), perSec || f.pricing.base || f.pricing.min ? 1 : 0);
  };
  const samplePerChar = (chars: number) => {
    const per1k = Number(f.pricing.perUnit) || 0;
    const raw = ((Number(f.pricing.base) || 0) + per1k * (chars / 1000)) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100);
    return Math.max(Math.ceil(raw), Math.ceil(Number(f.pricing.min) || 0), per1k || f.pricing.base || f.pricing.min ? 1 : 0);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Sửa công cụ</DialogTitle>
          <DialogDescription className="font-mono text-xs">{tool.key}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Tên hiển thị" required>
            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={250} />
          </Field>
          <Field label="Mô tả ngắn" help={`${f.description.length}/5.000 ký tự · Để trống rồi lưu để hệ thống tự sinh mô tả chuẩn`}>
            <Textarea rows={3} maxLength={5000} value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-12">
            <Field label="Nhóm menu" help="Thêm / sửa nhóm ở tab Nhóm &amp; model" className="sm:col-span-6">
              <Select value={f.category} onValueChange={(category) => set({ category })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(cats.data ?? []).map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      <CategoryIcon name={c.icon} /> {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Nhãn" help="NEW, HOT..." className="sm:col-span-3">
              <Input value={f.badge} onChange={(e) => set({ badge: e.target.value })} maxLength={20} />
            </Field>
            <Field label="Thứ tự" className="sm:col-span-3">
              <NumberInput value={f.sortOrder} onChange={(n) => set({ sortOrder: n ?? 0 })} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nhóm model" help="Công cụ cùng nhóm gộp thành 1 trên website, khách chọn model. Một công cụ ở được nhiều nhóm">
              <GroupsInput id="quick-edit-model-groups" value={f.modelGroups} onChange={(modelGroups) => set({ modelGroups })} groups={groups} />
            </Field>
            <Field label="Tên model trong nhóm" help="Bỏ trống = dùng tên hiển thị">
              <Input value={f.modelLabel} onChange={(e) => set({ modelLabel: e.target.value })} maxLength={200} disabled={!f.modelGroups.length} />
            </Field>
          </div>
          <ApiModelField toolKey={tool.key} />
          <Field label="Icon (tên lucide)" help="vd: video, image, mic, music, wand-sparkles — tên lạ hiện icon ✨">
            <Input value={f.icon} onChange={(e) => set({ icon: e.target.value })} />
          </Field>

          <div className="space-y-2.5 rounded-xl border p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Video / ảnh mẫu riêng của model này</div>
                <p className="text-xs text-muted-foreground">
                  Mỗi model hiển thị video mẫu riêng khi khách chọn model đó trên trang công cụ (như VeoVip). Hỗ trợ MP4, WEBM, MOV, GIF, WEBP, PNG, JPG.
                </p>
              </div>
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium shadow-xs hover:bg-muted">
                {uploadingDemo ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {uploadingDemo ? 'Đang tải lên...' : 'Tải file lên'}
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,image/png,image/jpeg"
                  className="hidden"
                  disabled={uploadingDemo}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setUploadingDemo(true);
                    try {
                      const fd = new FormData();
                      fd.append('file', file);
                      const r = await api.upload<{ url: string }>('/account/ai/uploads?demo=1', fd);
                      set({ demoVideo: r.url });
                      toast.success('Đã tải video / ảnh mẫu lên (bấm Lưu để áp dụng)');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    } finally {
                      setUploadingDemo(false);
                    }
                  }}
                />
              </label>
            </div>
            <div className="flex gap-2">
              <Input value={f.demoVideo} onChange={(e) => set({ demoVideo: e.target.value })} placeholder="Tải file ở trên hoặc dán link video .mp4 / ảnh..." />
              {f.demoVideo && (
                <Button type="button" variant="outline" size="sm" onClick={() => set({ demoVideo: '' })}>
                  Gỡ
                </Button>
              )}
            </div>
            {f.demoVideo && (
              <div className="overflow-hidden rounded-lg border bg-black/95">
                {/\.(gif|webp|png|jpe?g)(\?|$)/i.test(f.demoVideo) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.demoVideo} alt="" className="mx-auto max-h-44 w-full object-contain" />
                ) : (
                  <video src={f.demoVideo} controls muted loop playsInline className="mx-auto max-h-44 w-full object-contain" />
                )}
              </div>
            )}
            {f.modelGroups.length > 0 && (
              <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                <Switch checked={f.applyDemoToGroup} onCheckedChange={(applyDemoToGroup) => set({ applyDemoToGroup })} />
                Áp dụng video mẫu này cho tất cả model trong nhóm <b>{f.modelGroups.join(', ')}</b>
              </label>
            )}
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.enabled} onCheckedChange={(enabled) => set({ enabled })} /> Đang bật
            </label>
            <label
              className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
              title="Gói vẫn hiển thị bình thường trên web nhưng nút Tạo ngay chuyển thành Đang bảo trì"
            >
              <Switch checked={f.maintenance} onCheckedChange={(maintenance) => set({ maintenance })} /> Chế độ bảo trì
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.featured} onCheckedChange={(featured) => set({ featured })} /> Nổi bật ở dashboard
            </label>
          </div>

          <div className="rounded-xl border p-4">
            <div className="mb-3 text-sm font-semibold">Giá bán (VND, trừ vào số dư ví của khách)</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cách tính">
                <Select
                  value={f.pricing.mode}
                  onValueChange={(nextMode) => {
                    const mode = nextMode as NonNullable<Pricing['mode']>;
                    const isManualMode = mode === 'fixed' || mode === 'per_second' || mode === 'per_char' || mode === 'by_resolution' || mode === 'tiers';
                    if ((mode === 'per_second' || mode === 'per_char' || mode === 'by_resolution') && f.pricing.mode !== mode) {
                      setP({ mode, base: 0, markup: 0, customPrice: true });
                    } else if (isManualMode && f.pricing.mode !== mode) {
                      setP({ mode, customPrice: true });
                    } else if (mode === 'cost' && f.pricing.mode !== 'cost') {
                      setP({ mode, customPrice: false });
                    } else {
                      setP({ mode });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Giá cố định</SelectItem>
                    {(resOpts.length > 0 || f.pricing.mode === 'by_resolution') && (
                      <SelectItem value="by_resolution">Tính theo độ phân giải (tự đặt giá từng mức)</SelectItem>
                    )}
                    {(tool.supportsPerChar || f.pricing.mode === 'per_char') && (
                      <SelectItem value="per_char">Tính theo ký tự (tự đặt giá / 1.000 ký tự)</SelectItem>
                    )}
                    {(tool.supportsPerSecond || f.pricing.mode === 'per_second') && (
                      <SelectItem value="per_second">Tính theo giây (tự đặt giá / giây)</SelectItem>
                    )}
                    {(tool.supportsDurationTiers || f.pricing.mode === 'tiers') && (
                      <SelectItem value="tiers">Giá riêng theo mốc 10–20s &amp; 20–30s</SelectItem>
                    )}
                    {tool.supportsCost && <SelectItem value="cost">Theo chi phí nhà cung cấp × tỉ giá</SelectItem>}
                    <SelectItem value="free">Miễn phí</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {free ? null : tiers ? (
                <Field label="Cơ chế áp giá" help="Web tự đo độ dài thật của video mẫu khi tải lên">
                  <Input readOnly value="Tự động theo độ dài video (10–20s / 20–30s)" />
                </Field>
              ) : byResolution ? (
                <Field label="Cơ chế áp giá" help="Áp đúng mức giá theo độ phân giải khách chọn trên form">
                  <Input readOnly value={`Theo ${resOpts.length} mức độ phân giải (${resOpts.map((o) => o.value).join(' / ')})`} />
                </Field>
              ) : perChar ? (
                <Field label="Giá mỗi 1.000 ký tự (VND / 1k ký tự)" required>
                  <NumberInput suffix="đ/1k" min={0} value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} placeholder="vd: 700" />
                </Field>
              ) : perSecond ? (
                <Field label={resOpts.length ? 'Giá mỗi giây chung (VND / giây)' : 'Giá mỗi giây (VND / giây)'} required={!resOpts.length}>
                  <NumberInput suffix="đ/s" min={0} value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} placeholder="vd: 150" />
                </Field>
              ) : cost ? (
                <Field label="Tỉ giá quy đổi" help="Đặt chung cho nhà cung cấp ở trang Nhà cung cấp API">
                  <Input readOnly value={`1 ${tool.costUnit ?? 'đơn vị nguồn'} = ${fmtRate(tool.rate)}đ`} />
                </Field>
              ) : (
                <Field label={`Giá theo ${tool.unitLabel ?? 'đơn vị'}`} help={tool.unitLabel ? `Cộng thêm cho mỗi ${tool.unitLabel}` : 'Để 0 nếu chỉ tính giá cơ bản'}>
                  <NumberInput suffix="đ" value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} />
                </Field>
              )}

              {!free && tiers && (
                <>
                  <Field label="Giá mốc 10s – 20s">
                    <NumberInput suffix="đ" value={f.pricing.tier10to20} onChange={(n) => setP({ tier10to20: n ?? 0, base: n ?? 0 })} />
                  </Field>
                  <Field label="Giá mốc 20s – 30s">
                    <NumberInput suffix="đ" value={f.pricing.tier20to30} onChange={(n) => setP({ tier20to30: n ?? 0 })} />
                  </Field>
                  <Field label="Lãi thêm (%)">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}

              {!free && byResolution && (
                <>
                  {resOpts.map((opt) => (
                    <Field key={opt.value} label={`Giá ${opt.label}`} required>
                      <NumberInput
                        suffix="đ"
                        min={0}
                        value={f.pricing.resolutionPrices?.[opt.value] ?? 0}
                        onChange={(n) => setP({ resolutionPrices: { ...(f.pricing.resolutionPrices ?? {}), [opt.value]: n ?? 0 } })}
                      />
                    </Field>
                  ))}
                  <Field label="Lãi thêm (%)">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}

              {!free &&
                perSecond &&
                resOpts.map((opt) => (
                  <Field key={opt.value} label={`Giá mỗi giây ${opt.label}`} help="Để 0 = dùng giá mỗi giây chung">
                    <NumberInput
                      suffix="đ/s"
                      min={0}
                      value={f.pricing.resolutionPrices?.[opt.value] ?? 0}
                      onChange={(n) => setP({ resolutionPrices: { ...(f.pricing.resolutionPrices ?? {}), [opt.value]: n ?? 0 } })}
                    />
                  </Field>
                ))}

              {!free && !tiers && !byResolution && (
                <>
                  <Field label="Giá cơ bản mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.base} onChange={(n) => setP({ base: n ?? 0 })} />
                  </Field>
                  <Field label="Lãi thêm (%)">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}

              {!free && (
                <Field
                  label="Tự custom giá riêng"
                  help="Bật thì khi nguồn bật Tự động cập nhật giá hoặc đổi % tăng giá chung sẽ không sửa giá model này"
                >
                  <label
                    className={`flex h-9 cursor-pointer items-center justify-between rounded-md border px-3 text-sm transition-colors ${
                      f.pricing.customPrice
                        ? 'border-amber-400 bg-amber-50/70 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                        : 'bg-background text-muted-foreground'
                    }`}
                  >
                    <span className="truncate font-medium">
                      {f.pricing.customPrice ? 'Tự custom giá (khoá giá riêng)' : 'Đồng bộ theo nguồn API'}
                    </span>
                    <Switch checked={!!f.pricing.customPrice} onCheckedChange={(customPrice) => setP({ customPrice })} />
                  </label>
                </Field>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {free
                ? 'Khách chạy công cụ này không bị trừ tiền ví (vẫn tính vào giới hạn số tác vụ chạy cùng lúc).'
                : tiers
                  ? `Mốc 10–20s: ${fmtPrice(f.pricing.tier10to20)} · Mốc 20–30s: ${fmtPrice(f.pricing.tier20to30)}${f.pricing.markup ? ` (× ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)})` : ''}`
                  : byResolution
                    ? `Bảng giá: ${resOpts.map((o) => `${o.value} = ${fmtPrice(Math.ceil((Number(f.pricing.resolutionPrices?.[o.value]) || 0) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100)))}`).join(' · ')}`
                    : perSecond && resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) > 0)
                      ? `Giá 10 giây: ${resOpts.map((o) => `${o.value} = ${fmtPrice(samplePerSecond(10, perSecondOf(o.value)))}`).join(' · ')}${f.pricing.markup ? ` (đã × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)})` : ''}`
                      : perChar
                        ? `Công thức: (${f.pricing.base ? `${fmtPrice(f.pricing.base)} + ` : ''}${fmtPrice(f.pricing.perUnit)} × số ký tự / 1.000)${f.pricing.markup ? ` × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}` : ''} — VD: 500 ký tự = ${fmtPrice(samplePerChar(500))} · 1.000 ký tự = ${fmtPrice(samplePerChar(1000))}`
                        : perSecond
                          ? `Công thức: (${f.pricing.base ? `${fmtPrice(f.pricing.base)} + ` : ''}${fmtPrice(f.pricing.perUnit)} × số giây)${f.pricing.markup ? ` × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}` : ''} — VD: 5s = ${fmtPrice(samplePerSecond(5))} · 10s = ${fmtPrice(samplePerSecond(10))}`
                          : cost
                            ? `Công thức: (chi phí NCC × tỉ giá ${fmtRate(tool.rate)} + ${fmtPrice(f.pricing.base)}) × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}`
                            : `Công thức: (${fmtPrice(f.pricing.base)}${f.pricing.perUnit ? ` + ${fmtPrice(f.pricing.perUnit)} × số ${tool.unitLabel ?? 'đơn vị'}` : ''}) × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}`}
              {!free && `${f.pricing.min ? `, tối thiểu ${fmtPrice(f.pricing.min)}` : ''}, làm tròn lên tới đồng.`}
            </p>
            {missingPerChar && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập Giá mỗi 1.000 ký tự lớn hơn 0đ, hoặc chọn Miễn phí.
              </p>
            )}
            {missingPerSecond && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập Giá mỗi giây lớn hơn 0đ (chung, hoặc riêng cho mọi độ phân giải), hoặc chọn Miễn phí.
              </p>
            )}
            {invalidResolutionPrices && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập giá lớn hơn 0đ cho tất cả các mức độ phân giải.
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            disabled={deleting || save.isPending}
          >
            <Trash2 className="size-4" /> Xoá công cụ
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !f.name.trim() || missingPerSecond || missingPerChar || invalidResolutionPrices}>
              Lưu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupInput({
  id,
  value,
  onChange,
  onPick,
  groups,
  placeholder = 'vd Tạo video AI — để trống = đứng riêng',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onPick?: (g: string) => void;
  groups: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? groups.filter((g) => g.toLowerCase().includes(q)) : groups;
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        autoComplete="off"
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'Enter' && onPick && value.trim()) {
            e.preventDefault();
            onPick(value.trim());
            setOpen(false);
          }
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
        }}
        maxLength={80}
        placeholder={placeholder}
        className="pr-8"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Danh sách nhóm model"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
        onMouseDown={(e) => {
          e.preventDefault();
          setQuery('');
          setOpen((o) => !o);
        }}
      >
        <ChevronDown className="size-4" />
      </button>
      {open && shown.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {shown.map((g) => (
            <button
              key={g}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (onPick) onPick(g);
                else onChange(g);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left hover:bg-accent ${g === value ? 'font-medium' : ''}`}
            >
              {g}
              {g === value && <Check className="size-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupsInput({ id, value, onChange, groups }: { id: string; value: string[]; onChange: (v: string[]) => void; groups: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (g: string) => {
    const name = g.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((g) => (
            <Badge key={g} variant="secondary" className="gap-1">
              {g}
              <button type="button" aria-label={`Bỏ nhóm ${g}`} className="opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((x) => x !== g))}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <div className="flex-1">
          <GroupInput
            id={id}
            value={draft}
            onChange={setDraft}
            onPick={add}
            groups={groups.filter((g) => !value.includes(g))}
            placeholder={value.length ? 'Thêm nhóm khác...' : 'Chọn nhóm hoặc gõ tên mới — trống = đứng riêng'}
          />
        </div>
        {draft.trim() && (
          <Button type="button" variant="outline" onClick={() => add(draft)}>
            Thêm
          </Button>
        )}
      </div>
    </div>
  );
}
