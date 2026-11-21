'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getBlock, type BlockNode } from '@cmsnt/blocks';
import { TEMPLATE_KINDS, TEMPLATE_KIND_LABELS, type TemplateConditions, type TemplateKind, type ThemeTemplateView } from '@cmsnt/shared';
import { createBlock } from '@/components/builder/store';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguages } from '@/hooks/use-languages';
import { api, errorMessage } from '@/lib/api';
import { ConditionsEditor, TargetSelect, targetLabel, useTemplateTargets } from './template-settings';

/** Mô tả ngắn từng loại mẫu */
export const TEMPLATE_KIND_HINTS: Record<TemplateKind, string> = {
  single: 'Bố cục trang chi tiết: bài viết, sản phẩm, trang, bài của loại nội dung tuỳ biến',
  archive: 'Trang danh sách: blog, cửa hàng, chuyên mục, danh mục, lưu trữ loại nội dung, phân loại',
  header: 'Phần đầu trang (thay header mặc định của giao diện)',
  footer: 'Phần chân trang (thay footer mặc định của giao diện)',
  search: 'Trang kết quả tìm kiếm',
  not_found: 'Trang báo không tìm thấy (404)',
};

/** Bố cục gợi ý khi tạo mẫu mới — chỉ thêm block mà admin đã đăng ký */
const STARTER: Record<TemplateKind, { type: string; data?: Record<string, unknown> }[]> = {
  single: [{ type: 'breadcrumbs' }, { type: 'dynamic-title' }, { type: 'dynamic-meta' }, { type: 'dynamic-image' }, { type: 'dynamic-content' }],
  archive: [{ type: 'breadcrumbs' }, { type: 'dynamic-title' }, { type: 'query-loop', data: { source: 'current', pagination: true } }],
  search: [{ type: 'dynamic-title' }, { type: 'query-loop', data: { source: 'current', pagination: true } }],
  not_found: [{ type: 'heading' }, { type: 'rich-text' }],
  header: [],
  footer: [],
};

function starterBlocks(kind: TemplateKind): BlockNode[] {
  return STARTER[kind]
    .filter((s) => getBlock(s.type))
    .map((s) => {
      const b = createBlock(s.type);
      return s.data ? { ...b, data: { ...b.data, ...s.data } } : b;
    });
}

/** Hộp thoại tạo mẫu Theme Builder: loại mẫu, đối tượng áp dụng, điều kiện, ưu tiên */
export function CreateTemplateDialog({ open, onOpenChange, initialKind }: { open: boolean; onOpenChange: (o: boolean) => void; initialKind?: TemplateKind | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { defaultLocale } = useLanguages();
  const [kind, setKind] = useState<TemplateKind>('single');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(0);
  const [conditions, setConditions] = useState<TemplateConditions>({});
  const [starter, setStarter] = useState(true);
  const targets = useTemplateTargets(kind);

  // mở lại hộp thoại -> đặt lại form theo loại mẫu được chọn sẵn
  useEffect(() => {
    if (!open) return;
    setKind(initialKind ?? 'single');
    setTarget('');
    setName('');
    setPriority(0);
    setConditions({});
    setStarter(true);
  }, [open, initialKind]);

  // header / footer: mặc định áp toàn website
  useEffect(() => {
    if (!target && targets.data?.length) setTarget(targets.data.some((t) => t.value === '*') ? '*' : '');
  }, [targets.data, target]);

  const create = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('Vui lòng chọn đối tượng áp dụng');
      const finalName = name.trim() || `${TEMPLATE_KIND_LABELS[kind]} — ${targetLabel(targets.data, target)}`;
      return api.post<ThemeTemplateView>('/admin/theme-templates', {
        name: finalName,
        kind,
        target,
        conditions,
        priority,
        isActive: true,
        translations: [{ locale: defaultLocale, blocks: starter ? starterBlocks(kind).map(({ resolved: _r, ...b }) => b) : [] }],
      });
    },
    onSuccess: (t) => {
      toast.success('Đã tạo mẫu');
      void qc.invalidateQueries({ queryKey: ['theme-templates'] });
      onOpenChange(false);
      router.push(`/theme-builder/${t.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tạo mẫu giao diện</DialogTitle>
          <DialogDescription>Mẫu thay bố cục mặc định của website cho đối tượng được chọn; nội dung soạn bằng Page Builder.</DialogDescription>
        </DialogHeader>
        <form
          id="create-template"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Loại mẫu" required help={TEMPLATE_KIND_HINTS[kind]}>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as TemplateKind);
                setTarget('');
                setConditions({});
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {TEMPLATE_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Áp dụng cho" required>
            <TargetSelect
              kind={kind}
              value={target}
              onChange={(v) => {
                setTarget(v);
                setConditions({});
              }}
            />
          </Field>
          {target && <ConditionsEditor kind={kind} target={target} value={conditions} onChange={setConditions} locale={defaultLocale} />}
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="Tên mẫu" help="Để trống sẽ tự đặt theo loại + đối tượng">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={target ? `${TEMPLATE_KIND_LABELS[kind]} — ${targetLabel(targets.data, target)}` : 'vd: Chi tiết dự án'} />
            </Field>
            <Field label="Ưu tiên" help="Số lớn thắng">
              <Input type="number" value={priority} onChange={(e) => setPriority(Math.trunc(Number(e.target.value) || 0))} />
            </Field>
          </div>
          {STARTER[kind].length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={starter} onCheckedChange={(v) => setStarter(!!v)} />
              Bắt đầu với bố cục gợi ý (tiêu đề, ảnh, nội dung...)
            </label>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button type="submit" form="create-template" disabled={!target || create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />} Tạo và soạn mẫu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
