'use client';

/**
 * Trình sửa menu bên trái của website khách (nhóm cài đặt `web_menu`, API chuẩn hoá ở apps/api/src/modules/settings/web-menu.ts).
 * - Kéo thả để sắp xếp; mỗi dòng bật/tắt hiển thị riêng.
 * - Loại mục: Liên kết (tên, đường dẫn, icon, nhãn nhỏ, mở tab mới), Tiêu đề nhóm, khối "Công cụ AI" (chỉ ẩn được, không xoá).
 * - Cột phải là bản xem trước menu theo đúng thứ tự đang sửa.
 * Website (apps/web/src/components/member/member-shell.tsx) đọc menu qua /public/bootstrap, chậm tối đa ~1 phút do cache.
 */
import { useState } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Bell,
  BookOpen,
  ChevronDown,
  CircleHelp,
  CreditCard,
  Crown,
  ExternalLink,
  FileText,
  Gift,
  Globe,
  GripVertical,
  Headset,
  Heading,
  History,
  House,
  KeyRound,
  LayoutDashboard,
  Link2,
  Lock,
  type LucideIcon,
  MessageCircle,
  Phone,
  Plus,
  ReceiptText,
  RotateCcw,
  Settings,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  Wallet,
} from 'lucide-react';
import { CATEGORY_ICONS } from '@/components/ai/categories-tab';
import { Section } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SetValues, Values } from '@/components/settings/settings-group';
import { cn } from '@/lib/utils';

export type MenuItemType = 'link' | 'heading' | 'ai_tools';

export interface MenuItem {
  id: string;
  type: MenuItemType;
  label: string;
  href: string;
  icon: string;
  badge: string;
  newTab: boolean;
  enabled: boolean;
}

/**
 * Icon chọn được cho mục menu = icon của nhóm công cụ AI + icon hay dùng cho menu.
 * Website chỉ vẽ được icon có trong bảng ICONS của apps/web/src/lib/ai.ts — thêm icon mới thì thêm ở cả hai nơi.
 */
export const MENU_ICONS: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  house: House,
  history: History,
  globe: Globe,
  'credit-card': CreditCard,
  wallet: Wallet,
  'receipt-text': ReceiptText,
  gift: Gift,
  'key-round': KeyRound,
  settings: Settings,
  crown: Crown,
  star: Star,
  bell: Bell,
  'file-text': FileText,
  'circle-help': CircleHelp,
  'message-circle': MessageCircle,
  phone: Phone,
  'external-link': ExternalLink,
  link: Link2,
  'book-open': BookOpen,
  ticket: Ticket,
  headset: Headset,
  ...CATEGORY_ICONS,
};

/** Icon theo tên (lạ / trống -> Sparkles, giống website) */
function MenuIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = (name && MENU_ICONS[name]) || Sparkles;
  return <Icon className={className} />;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Đường dẫn hợp lệ (khớp safeMenuHref ở API): "/trang-noi-bo" hoặc http(s)://... */
const validHref = (h: string) => (h.startsWith('/') && !h.startsWith('//')) || /^https?:\/\/\S+$/i.test(h);
const validExternalHref = (h: string) => /^https?:\/\/\S+$/i.test(h);

/** Các mục cộng đồng mà tài khoản Cộng tác viên (không có `web_menu.manage`) được phép tự sửa */
const CTV_EDITABLE_IDS = new Set(['4g0eq2pg', 'fwqk2cbf', '6stz8x1x']);
const isCtvEditableItem = (item: MenuItem) =>
  CTV_EDITABLE_IDS.has(item.id) || (item.type === 'link' && /^https?:\/\//i.test(item.href.trim()));

/** Ô chọn icon: bấm mở bảng icon */
function IconPicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={disabled ? false : open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="shrink-0" title="Chọn icon" disabled={disabled}>
          <MenuIcon name={value} className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="grid grid-cols-8 gap-1">
          {Object.entries(MENU_ICONS).map(([name, Icon]) => (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
              className={cn('inline-flex size-8 items-center justify-center rounded-md border border-transparent hover:bg-muted', value === name && 'border-primary bg-primary/10 text-primary')}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Một dòng trong danh sách: tay kéo, nội dung theo loại, công tắc hiện/ẩn, nút xoá */
function SortableRow({
  item,
  onChange,
  onRemove,
  restricted,
  locked,
}: {
  item: MenuItem;
  onChange: (patch: Partial<MenuItem>) => void;
  onRemove: () => void;
  restricted?: boolean;
  locked?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !!restricted });
  const badHref = item.type === 'link' && !locked && !(restricted ? validExternalHref(item.href.trim()) : validHref(item.href.trim()));
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-card p-2',
        isDragging && 'z-10 shadow-lg',
        !item.enabled && 'opacity-60',
        item.type !== 'link' && 'bg-muted/40',
        locked && 'bg-muted/30 opacity-75',
        restricted && !locked && 'border-primary/40 ring-1 ring-primary/15',
      )}
    >
      {restricted ? (
        locked ? (
          <span className="mt-2.5 shrink-0 text-muted-foreground/60" title="Mục hệ thống đã khoá">
            <Lock className="size-3.5" />
          </span>
        ) : (
          <span className="mt-2.5 shrink-0 text-primary" title="Mục được phép chỉnh sửa">
            <Link2 className="size-3.5" />
          </span>
        )
      ) : (
        <button type="button" className="mt-2 cursor-grab touch-none text-muted-foreground hover:text-foreground" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
          <GripVertical className="size-4" />
        </button>
      )}

      <div className="min-w-0 flex-1 space-y-2">
        {item.type === 'link' && (
          <>
            <div className="flex gap-2">
              <IconPicker value={item.icon} onChange={(icon) => onChange({ icon })} disabled={locked} />
              <Input value={item.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Tên hiển thị" maxLength={60} disabled={locked} />
              <Input value={item.badge} onChange={(e) => onChange({ badge: e.target.value })} placeholder="Nhãn" title="Nhãn nhỏ bên phải (vd: %, Mới). Bỏ trống = không có" maxLength={12} className="w-20 shrink-0" disabled={locked} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={item.href}
                onChange={(e) => onChange({ href: e.target.value })}
                placeholder={restricted ? 'https://...' : '/duong-dan hoặc https://...'}
                maxLength={500}
                aria-invalid={badHref}
                disabled={locked}
                className={cn('min-w-48 flex-1 font-mono text-xs', badHref && 'border-destructive')}
              />
              <label className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', locked && 'opacity-70')}>
                <Switch checked={item.newTab} onCheckedChange={(newTab) => onChange({ newTab })} disabled={locked} />
                Mở tab mới
              </label>
            </div>
            {badHref && (
              <p className="text-xs text-destructive">
                {restricted
                  ? 'Liên kết cộng đồng phải bắt đầu bằng http:// hoặc https:// hợp lệ.'
                  : 'Đường dẫn phải bắt đầu bằng “/” (trang trong website) hoặc http(s):// — dòng sai sẽ bị bỏ khi lưu.'}
              </p>
            )}
          </>
        )}

        {item.type === 'heading' && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0">
              <Heading /> Tiêu đề
            </Badge>
            <Input value={item.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Tên tiêu đề nhóm (vd: Tài khoản)" maxLength={60} disabled={locked} />
          </div>
        )}

        {item.type === 'ai_tools' && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge className="shrink-0">
                <Sparkles /> Khối công cụ AI
              </Badge>
              <Input value={item.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Tiêu đề khối" maxLength={60} disabled={locked} />
            </div>
            <p className="text-xs text-muted-foreground">Tiêu đề + các nhóm công cụ (Video, Hình ảnh...). Sửa nhóm ở AI Studio › Công cụ AI › tab Nhóm & model.</p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 pt-1.5">
        <Switch
          checked={item.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          disabled={locked}
          title={locked ? 'Mục hệ thống đã khoá' : item.enabled ? 'Đang hiện — bấm để ẩn' : 'Đang ẩn — bấm để hiện'}
        />
        {!restricted && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={item.type === 'ai_tools'}
            aria-label="Xoá mục"
            title={item.type === 'ai_tools' ? 'Khối Công cụ AI không xoá được, chỉ ẩn' : 'Xoá mục'}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Bản xem trước menu bên trái website (chỉ mục đang hiện) */
function MenuPreview({ items }: { items: MenuItem[] }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">Xem trước</div>
      <div className="space-y-0.5">
        {items
          .filter((i) => i.enabled)
          .map((i) => {
            if (i.type === 'heading') return <div key={i.id} className="px-3 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{i.label || '—'}</div>;
            if (i.type === 'ai_tools')
              return (
                <div key={i.id}>
                  <div className="px-3 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{i.label}</div>
                  {['Video', 'Hình ảnh', 'Giọng nói'].map((g) => (
                    <div key={g} className="flex h-8 items-center gap-3 rounded-lg px-3 text-[13px] text-muted-foreground">
                      <Sparkles className="size-3.5" />
                      <span className="flex-1">{g}</span>
                      <ChevronDown className="size-3.5" />
                    </div>
                  ))}
                  <div className="px-3 text-[11px] text-muted-foreground italic">…các nhóm công cụ</div>
                </div>
              );
            return (
              <div key={i.id} className="flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] font-medium">
                <MenuIcon name={i.icon} className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{i.label || i.href}</span>
                {i.newTab && <ExternalLink className="size-3 text-muted-foreground" />}
                {i.badge && <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold">{i.badge}</span>}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** Nội dung trang: danh sách kéo thả + nút thêm + xem trước. `v`/`set` từ SettingsGroup group="web_menu" */
export function MenuEditor({ v, set, defaults, restricted }: { v: Values; set: SetValues; defaults: MenuItem[]; restricted?: boolean }) {
  const items: MenuItem[] = Array.isArray(v.items) ? v.items : [];
  const setItems = (next: MenuItem[]) => set({ items: next });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (restricted || !over || active.id === over.id) return;
    setItems(arrayMove(items, items.findIndex((i) => i.id === active.id), items.findIndex((i) => i.id === over.id)));
  };
  const add = (type: MenuItemType) =>
    setItems([...items, { id: uid(), type, label: '', href: type === 'link' ? '/' : '', icon: type === 'link' ? 'link' : '', badge: '', newTab: false, enabled: true }]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <Section
        title="Các mục menu"
        description={
          restricted
            ? 'Các mục menu hệ thống được khoá cố định. Bạn có thể tự chỉnh sửa 2 mục liên kết cộng đồng (Telegram & Nhóm Facebook) bên dưới rồi bấm Lưu.'
            : 'Kéo biểu tượng ⋮⋮ để sắp xếp, công tắc để ẩn/hiện. Đường dẫn bắt đầu bằng “/” là trang trong website (vd /pricing), hoặc dán link ngoài https://...'
        }
        actions={
          !restricted ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setItems(defaults.map((d) => ({ ...d })))} title="Đưa menu về như ban đầu (chưa lưu cho tới khi bấm Lưu)">
              <RotateCcw /> Về mặc định
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-2">
          {restricted && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0 text-primary" />
              <span>
                Tài khoản Cộng tác viên chỉ được phép chỉnh sửa <strong className="text-foreground">2 mục liên kết cộng đồng</strong> (Telegram &amp; Cộng đồng Facebook) ở cuối danh sách.
              </span>
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              {items.map((item) => {
                const locked = !!restricted && !isCtvEditableItem(item);
                return (
                  <SortableRow
                    key={item.id}
                    item={item}
                    restricted={restricted}
                    locked={locked}
                    onChange={(patch) => {
                      if (locked) return;
                      setItems(items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
                    }}
                    onRemove={() => {
                      if (restricted) return;
                      setItems(items.filter((i) => i.id !== item.id));
                    }}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {!restricted && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" variant="outline" onClick={() => add('link')}>
                <Plus /> Thêm liên kết
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add('heading')}>
                <Heading /> Thêm tiêu đề nhóm
              </Button>
            </div>
          )}
        </div>
      </Section>
      <div className="lg:sticky lg:top-20 lg:self-start">
        <MenuPreview items={items} />
      </div>
    </div>
  );
}
