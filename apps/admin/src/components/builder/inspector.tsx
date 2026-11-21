'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { Blocks, ClipboardCopy, Copy, Loader2, MousePointerClick, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { slugify } from '@cmsnt/shared';
import { getBlock, type BlockSettings } from '@cmsnt/blocks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Field } from '@/components/common/field';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/components/common/prompt-dialog';
import { createBlock, useBuilder } from './store';
import { copyBlock } from './clipboard';
import { BlockFields, ColorInput } from './fields';

const SPACING = [
  { value: 'none', label: 'Không' },
  { value: 'sm', label: 'Nhỏ' },
  { value: 'md', label: 'Vừa' },
  { value: 'lg', label: 'Lớn' },
  { value: 'xl', label: 'Rất lớn' },
];

function SettingsForm({ settings, onChange }: { settings: BlockSettings; onChange: (p: Partial<BlockSettings>) => void }) {
  const hide = settings.hideOn ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Khoảng cách trên">
          <Select value={settings.paddingTop ?? 'md'} onValueChange={(v) => onChange({ paddingTop: v as BlockSettings['paddingTop'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPACING.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Khoảng cách dưới">
          <Select value={settings.paddingBottom ?? 'md'} onValueChange={(v) => onChange({ paddingBottom: v as BlockSettings['paddingBottom'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPACING.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Độ rộng nội dung">
        <Select value={settings.container ?? 'default'} onValueChange={(v) => onChange({ container: v as BlockSettings['container'] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="narrow">Hẹp (đọc bài)</SelectItem>
            <SelectItem value="default">Mặc định</SelectItem>
            <SelectItem value="wide">Rộng</SelectItem>
            <SelectItem value="full">Tràn màn hình</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Màu nền">
        <ColorInput value={settings.background} onChange={(v) => onChange({ background: v })} />
      </Field>
      <Field label="Màu chữ">
        <ColorInput value={settings.textColor} onChange={(v) => onChange({ textColor: v })} />
      </Field>
      <Field label="Ẩn trên thiết bị">
        <div className="flex gap-4">
          {(['mobile', 'tablet', 'desktop'] as const).map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={hide.includes(d)} onCheckedChange={(v) => onChange({ hideOn: v ? [...hide, d] : hide.filter((x) => x !== d) })} />
              {d === 'mobile' ? 'Điện thoại' : d === 'tablet' ? 'Máy tính bảng' : 'Máy tính'}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Anchor ID" help="Dùng cho liên kết #id trong menu, vd: lien-he">
        <Input value={settings.anchor ?? ''} onChange={(e) => onChange({ anchor: e.target.value.replace(/[^a-zA-Z0-9-_]/g, '') })} />
      </Field>
      <Field label="CSS class">
        <Input value={settings.className ?? ''} onChange={(e) => onChange({ className: e.target.value })} className="font-mono text-xs" />
      </Field>
    </div>
  );
}

/** Panel bên phải: chỉnh nội dung & giao diện block đang chọn */
export function Inspector({ locale }: { locale: string }) {
  const block = useBuilder((s) => s.blocks.find((b) => b.id === s.selectedId));
  const { updateData, updateSettings, duplicate, remove } = useBuilder.getState();
  const qc = useQueryClient();
  const { can } = useAuth();
  const prompt = usePrompt();
  const [converting, setConverting] = useState(false);

  /** Lưu block thành Block dùng chung và thay bằng tham chiếu tới nó */
  const toGlobal = async () => {
    if (!block) return;
    const name = (await prompt({ title: 'Chuyển thành block dùng chung', description: 'Block sẽ được lưu vào thư viện Block dùng chung và có thể tái sử dụng ở trang khác.', label: 'Tên block', defaultValue: getBlock(block.type)?.label ?? 'Block', confirmText: 'Tạo block' }))?.trim();
    if (!name) return;
    setConverting(true);
    try {
      const { resolved: _r, ...clean } = block;
      const created = await api.post<{ key: string }>('/admin/blocks', {
        name,
        key: `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'section',
        translations: [{ locale, blocks: [clean] }],
      });
      const ref = createBlock('global-block');
      ref.data = { blockKey: created.key };
      const s = useBuilder.getState();
      s.replaceAll(s.blocks.map((b) => (b.id === block.id ? ref : b)));
      s.select(ref.id);
      void qc.invalidateQueries({ queryKey: ['blocks-select'] });
      toast.success(`Đã tạo block dùng chung "${name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setConverting(false);
    }
  };

  if (!block) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <MousePointerClick className="size-8" />
        Bấm vào một block trên canvas để chỉnh sửa. Chữ có thể sửa trực tiếp trên giao diện.
      </div>
    );
  }
  const def = getBlock(block.type);
  const data = { ...(def?.defaults ?? {}), ...(block.data ?? {}) };
  const settings = { ...(def?.defaultSettings ?? {}), ...(block.settings ?? {}) };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <DynamicIcon name={(def?.icon ?? 'square') as IconName} className="size-4" fallback={() => null} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{def?.label ?? block.type}</div>
          {def?.description && <div className="truncate text-xs text-muted-foreground">{def.description}</div>}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            copyBlock(block);
            toast.success('Đã sao chép block — mở trang khác và bấm "Dán block"');
          }}
          title="Sao chép (dán sang trang khác)"
        >
          <ClipboardCopy />
        </Button>
        {block.type !== 'global-block' && can('blocks.manage') && (
          <Button variant="ghost" size="icon-sm" onClick={toGlobal} disabled={converting} title="Lưu thành block dùng chung">
            {converting ? <Loader2 className="animate-spin" /> : <Blocks />}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={() => duplicate(block.id)} title="Nhân bản">
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => remove(block.id)} title="Xoá">
          <Trash2 />
        </Button>
      </div>
      <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-3 mt-2 grid w-auto grid-cols-2">
          <TabsTrigger value="content">Nội dung</TabsTrigger>
          <TabsTrigger value="style">Giao diện</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          <TabsContent value="content" className="p-3">
            {def ? <BlockFields key={block.id} fields={def.fields} data={data} onChange={(path, v) => updateData(block.id, path, v)} locale={locale} /> : <p className="text-sm text-muted-foreground">Block chưa đăng ký</p>}
          </TabsContent>
          <TabsContent value="style" className="p-3">
            <SettingsForm settings={settings} onChange={(p) => updateSettings(block.id, p)} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
