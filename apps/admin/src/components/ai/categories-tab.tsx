'use client';

/**
 * Nhóm công cụ (dùng ở tab "Nhóm & model" — components/ai/group-tree-tab.tsx): bảng icon + hộp thêm / sửa nhóm.
 * Nhóm tắt bị ẩn khỏi website khách cùng mọi công cụ trong nhóm (khách không mở / chạy được).
 * Nhóm hiển thị trên menu + bộ lọc của website khách theo đúng thứ tự ở đây. Xoá chỉ được khi nhóm không còn công cụ.
 * API: GET/POST /admin/ai/categories, PUT /admin/ai/categories/:key, PUT /admin/ai/categories/order, DELETE /admin/ai/categories/:key.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AudioLines,
  BookOpen,
  Bot,
  Brush,
  Camera,
  Clapperboard,
  Code,
  Film,
  Gamepad2,
  GraduationCap,
  Heart,
  Image as ImageIcon,
  Images,
  Languages,
  type LucideIcon,
  Megaphone,
  Mic,
  Music,
  Newspaper,
  Palette,
  ScanFace,
  ScrollText,
  Shirt,
  ShoppingBag,
  Sparkles,
  Users,
  Video,
  WandSparkles,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { type ToolCategory } from '@/components/ai/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Icon chọn được cho nhóm (tên lucide). Website khách chỉ vẽ được icon có trong bảng ICONS
 * của apps/web/src/lib/ai.ts — thêm icon mới thì thêm ở cả hai nơi.
 */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  video: Video,
  image: ImageIcon,
  mic: Mic,
  music: Music,
  'scroll-text': ScrollText,
  wrench: Wrench,
  sparkles: Sparkles,
  'wand-sparkles': WandSparkles,
  film: Film,
  clapperboard: Clapperboard,
  images: Images,
  'audio-lines': AudioLines,
  languages: Languages,
  users: Users,
  shirt: Shirt,
  'scan-face': ScanFace,
  newspaper: Newspaper,
  palette: Palette,
  camera: Camera,
  bot: Bot,
  brush: Brush,
  megaphone: Megaphone,
  'book-open': BookOpen,
  code: Code,
  'gamepad-2': Gamepad2,
  heart: Heart,
  'shopping-bag': ShoppingBag,
  'graduation-cap': GraduationCap,
};

/** Icon của nhóm theo tên (tên lạ / trống -> Sparkles, giống website khách) */
export function CategoryIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = (name && CATEGORY_ICONS[name]) || Sparkles;
  return <Icon className={className} />;
}

/** Hộp thêm / sửa nhóm: tên, khoá (chỉ khi thêm), icon */
export function CategoryDialog({ category, onClose, onSaved }: { category: Partial<ToolCategory>; onClose: () => void; onSaved: () => void }) {
  const isNew = !category.key;
  const [f, setF] = useState({ label: category.label ?? '', key: '', icon: category.icon ?? 'sparkles' });
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post('/admin/ai/categories', { label: f.label, key: f.key.trim() || undefined, icon: f.icon })
        : api.put(`/admin/ai/categories/${encodeURIComponent(category.key!)}`, { label: f.label, icon: f.icon }),
    onSuccess: () => {
      toast.success(isNew ? 'Đã thêm nhóm' : 'Đã lưu nhóm');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Thêm nhóm công cụ' : 'Sửa nhóm công cụ'}</DialogTitle>
          {!isNew && <DialogDescription className="font-mono text-xs">{category.key}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Tên nhóm" required>
            <Input value={f.label} onChange={(e) => setF((s) => ({ ...s, label: e.target.value }))} maxLength={60} autoFocus />
          </Field>
          {isNew && (
            <Field label="Khoá" help="Chữ thường không dấu, số, gạch ngang. Bỏ trống = tự tạo từ tên. Không đổi được sau khi tạo.">
              <Input value={f.key} onChange={(e) => setF((s) => ({ ...s, key: e.target.value.toLowerCase() }))} maxLength={40} placeholder="vd: mang-xa-hoi" className="font-mono" />
            </Field>
          )}
          <Field label="Icon">
            <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
              {Object.entries(CATEGORY_ICONS).map(([name, Icon]) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => setF((s) => ({ ...s, icon: name }))}
                  className={cn('inline-flex size-9 items-center justify-center rounded-lg border transition hover:bg-muted', f.icon === name && 'border-primary bg-primary/10 text-primary')}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.label.trim()}>
            {isNew ? 'Thêm' : 'Lưu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
