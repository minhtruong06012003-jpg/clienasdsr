'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Crop, FlipHorizontal, FlipVertical, Loader2, RotateCcw, RotateCw, Scaling, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { MediaItem } from './media-api';

type Rect = { x: number; y: number; width: number; height: number };
type Rotate = 0 | 90 | 180 | 270;
const ASPECTS: Record<string, number | null> = { free: null, '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9, '3:4': 3 / 4, '9:16': 9 / 16 };

const clampRect = (r: Rect, W: number, H: number): Rect => {
  const width = Math.max(1, Math.min(Math.round(r.width), W));
  const height = Math.max(1, Math.min(Math.round(r.height), H));
  const x = Math.max(0, Math.min(Math.round(r.x), W - width));
  const y = Math.max(0, Math.min(Math.round(r.y), H - height));
  return { x, y, width, height };
};

/**
 * Chỉnh ảnh: cắt (kéo vùng trên ảnh hoặc nhập số), xoay, lật, đổi kích thước.
 * Thứ tự áp dụng ở máy chủ: cắt -> xoay -> lật -> đổi cỡ. Toạ độ cắt theo pixel ảnh gốc.
 */
export function ImageEditorDialog({ open, onOpenChange, media, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; media: MediaItem; onSaved?: (m: MediaItem) => void }) {
  const qc = useQueryClient();
  const W = media.width ?? 0;
  const H = media.height ?? 0;
  const [rotate, setRotate] = useState<Rotate>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [aspect, setAspect] = useState<string>('free');
  const [resizeW, setResizeW] = useState('');
  const [resizeH, setResizeH] = useState('');
  const [keepRatio, setKeepRatio] = useState(true);
  const [resetKey, setResetKey] = useState<string | null>(null);
  const key = `${open}:${media.id}:${media.path}`;
  if (resetKey !== key) {
    setResetKey(key);
    setRotate(0);
    setFlipH(false);
    setFlipV(false);
    setCrop(null);
    setAspect('free');
    setResizeW('');
    setResizeH('');
  }

  // ---- khung xem trước ----
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 560, h: 380 });
  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open]);
  const swapped = rotate === 90 || rotate === 270;
  const scale = useMemo(() => {
    if (!W || !H) return 1;
    const rw = swapped ? H : W;
    const rh = swapped ? W : H;
    return Math.min((stage.w - 16) / rw, (stage.h - 16) / rh, 1);
  }, [W, H, swapped, stage]);
  const canDraw = rotate === 0 && !flipH && !flipV;

  // ---- vẽ vùng cắt bằng chuột ----
  const innerRef = useRef<HTMLDivElement>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const toImage = (e: ReactPointerEvent) => {
    const r = innerRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(W, (e.clientX - r.left) / scale)), y: Math.max(0, Math.min(H, (e.clientY - r.top) / scale)) };
  };
  const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => {
    let width = Math.abs(b.x - a.x);
    let height = Math.abs(b.y - a.y);
    const ratio = ASPECTS[aspect];
    if (ratio) {
      // khoá tỉ lệ theo cạnh dài hơn
      if (width / ratio >= height) height = width / ratio;
      else width = height * ratio;
    }
    const x = b.x < a.x ? a.x - width : a.x;
    const y = b.y < a.y ? a.y - height : a.y;
    return clampRect({ x, y, width, height }, W, H);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canDraw || e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drawStart.current = toImage(e);
    setCrop(null);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drawStart.current) return;
    setCrop(rectFrom(drawStart.current, toImage(e)));
  };
  const onPointerUp = () => {
    if (!drawStart.current) return;
    drawStart.current = null;
    setCrop((c) => (c && (c.width < 4 || c.height < 4) ? null : c));
  };

  const setCropField = (k: keyof Rect, v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const base = crop ?? { x: 0, y: 0, width: W, height: H };
    const next = { ...base, [k]: n };
    const ratio = ASPECTS[aspect];
    if (ratio && k === 'width') next.height = n / ratio;
    if (ratio && k === 'height') next.width = n * ratio;
    setCrop(clampRect(next, W, H));
  };
  const changeAspect = (v: string) => {
    setAspect(v);
    const ratio = ASPECTS[v];
    if (!ratio) return;
    // tạo/điều chỉnh vùng cắt lớn nhất có thể theo tỉ lệ, canh giữa
    let width = W;
    let height = width / ratio;
    if (height > H) {
      height = H;
      width = height * ratio;
    }
    setCrop(clampRect({ x: (W - width) / 2, y: (H - height) / 2, width, height }, W, H));
  };

  // ---- kích thước kết quả ----
  const afterCrop = { w: crop ? crop.width : W, h: crop ? crop.height : H };
  const afterRotate = swapped ? { w: afterCrop.h, h: afterCrop.w } : afterCrop;
  const outW = Number(resizeW) || 0;
  const outH = Number(resizeH) || 0;
  const result = (() => {
    if (!outW && !outH) return afterRotate;
    // fit: inside + withoutEnlargement (giống sharp)
    const r = Math.min(outW ? outW / afterRotate.w : Infinity, outH ? outH / afterRotate.h : Infinity, 1);
    return { w: Math.round(afterRotate.w * r), h: Math.round(afterRotate.h * r) };
  })();
  const onResizeW = (v: string) => {
    setResizeW(v);
    if (keepRatio && Number(v) > 0) setResizeH(String(Math.round((Number(v) * afterRotate.h) / afterRotate.w)));
  };
  const onResizeH = (v: string) => {
    setResizeH(v);
    if (keepRatio && Number(v) > 0) setResizeW(String(Math.round((Number(v) * afterRotate.w) / afterRotate.h)));
  };

  const dirty = rotate !== 0 || flipH || flipV || !!crop || outW > 0 || outH > 0;
  const reset = () => {
    setRotate(0);
    setFlipH(false);
    setFlipV(false);
    setCrop(null);
    setAspect('free');
    setResizeW('');
    setResizeH('');
  };

  const save = useMutation({
    mutationFn: () => {
      // lật ngang + lật dọc = xoay 180°
      let rot = rotate;
      let flip: 'h' | 'v' | undefined = flipH ? 'h' : flipV ? 'v' : undefined;
      if (flipH && flipV) {
        rot = ((rot + 180) % 360) as Rotate;
        flip = undefined;
      }
      const body: Record<string, unknown> = {};
      if (crop) body.crop = clampRect(crop, W, H);
      if (rot) body.rotate = rot;
      if (flip) body.flip = flip;
      if (outW || outH) body.resize = { ...(outW ? { width: outW } : {}), ...(outH ? { height: outH } : {}) };
      return api.post<MediaItem>(`/admin/media/${media.id}/edit`, body);
    },
    onSuccess: (m) => {
      toast.success('Đã lưu ảnh đã chỉnh');
      void qc.invalidateQueries({ queryKey: ['media'] });
      onSaved?.(m);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const innerW = W * scale;
  const innerH = H * scale;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="flex max-h-[92vh] max-w-[min(1000px,96vw)] flex-col gap-3 sm:max-w-[min(1000px,96vw)]">
        <DialogHeader>
          <DialogTitle>Chỉnh ảnh</DialogTitle>
          <DialogDescription>
            {media.originalName} — {W} × {H}px. Ảnh gốc sẽ bị ghi đè (giữ nguyên id), các kích thước thumb/medium/large được tạo lại.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-[1fr_260px]">
          {/* Xem trước */}
          <div className="space-y-2">
            <div ref={stageRef} className={cn('relative h-[380px] w-full overflow-hidden rounded-lg border bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]', canDraw ? 'cursor-crosshair' : 'cursor-default')}>
              <div
                ref={innerRef}
                className="absolute select-none"
                style={{ width: innerW, height: innerH, left: (stage.w - innerW) / 2, top: (stage.h - innerH) / 2, transform: `rotate(${rotate}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})` }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={media.urls.large ?? media.url} alt="" draggable={false} className="block h-full w-full" />
                {crop && (
                  <div className="pointer-events-none absolute border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={{ left: crop.x * scale, top: crop.y * scale, width: crop.width * scale, height: crop.height * scale }}>
                    <span className="absolute -top-5 left-0 rounded bg-primary px-1 text-[10px] text-primary-foreground">
                      {Math.round(crop.width)} × {Math.round(crop.height)}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {canDraw ? 'Kéo chuột trên ảnh để chọn vùng cắt.' : 'Đang xoay/lật: nhập vùng cắt bằng số (toạ độ theo ảnh gốc) hoặc đặt lại để kéo trên ảnh.'} Kết quả: <b>{result.w} × {result.h}px</b>
            </p>
          </div>

          {/* Công cụ */}
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Xoay & lật</Label>
              <div className="flex flex-wrap gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => setRotate(((rotate + 270) % 360) as Rotate)} title="Xoay trái 90°">
                  <RotateCcw /> Trái
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setRotate(((rotate + 90) % 360) as Rotate)} title="Xoay phải 90°">
                  <RotateCw /> Phải
                </Button>
                <ToggleGroup type="multiple" variant="outline" size="sm" value={[flipH ? 'h' : '', flipV ? 'v' : ''].filter(Boolean)} onValueChange={(v: string[]) => (setFlipH(v.includes('h')), setFlipV(v.includes('v')))}>
                  <ToggleGroupItem value="h" aria-label="Lật ngang" title="Lật ngang">
                    <FlipHorizontal />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="v" aria-label="Lật dọc" title="Lật dọc">
                    <FlipVertical />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {rotate !== 0 && <p className="text-xs text-muted-foreground">Xoay {rotate}°</p>}
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                <Crop className="size-3.5" /> Cắt ảnh
              </Label>
              <Select value={aspect} onValueChange={changeAspect}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Tự do</SelectItem>
                  <SelectItem value="1:1">Vuông 1:1</SelectItem>
                  <SelectItem value="4:3">4:3</SelectItem>
                  <SelectItem value="3:4">3:4 (dọc)</SelectItem>
                  <SelectItem value="16:9">16:9</SelectItem>
                  <SelectItem value="9:16">9:16 (dọc)</SelectItem>
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-1.5">
                {(['x', 'y', 'width', 'height'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1 text-xs">
                    <span className="w-5 text-muted-foreground">{{ x: 'X', y: 'Y', width: 'R', height: 'C' }[k]}</span>
                    <Input type="number" min={0} className="h-7 px-2 text-xs" value={crop ? Math.round(crop[k]) : k === 'width' ? W : k === 'height' ? H : 0} onChange={(e) => setCropField(k, e.target.value)} />
                  </label>
                ))}
              </div>
              <div className="flex gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => setCrop({ x: 0, y: 0, width: W, height: H })}>
                  Toàn bộ
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => (setCrop(null), setAspect('free'))} disabled={!crop}>
                  Bỏ cắt
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                <Scaling className="size-3.5" /> Đổi kích thước (px)
              </Label>
              <div className="grid grid-cols-2 gap-1.5">
                <Input type="number" min={1} placeholder={`Rộng ${afterRotate.w}`} className="h-7 px-2 text-xs" value={resizeW} onChange={(e) => onResizeW(e.target.value)} />
                <Input type="number" min={1} placeholder={`Cao ${afterRotate.h}`} className="h-7 px-2 text-xs" value={resizeH} onChange={(e) => onResizeH(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={keepRatio} onCheckedChange={(v) => setKeepRatio(v === true)} /> Giữ tỉ lệ
              </label>
              <p className="text-xs text-muted-foreground">Chỉ thu nhỏ, không phóng to quá kích thước gốc.</p>
            </div>
          </div>
        </div>
        <DialogFooter className="items-center">
          <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={reset} disabled={!dirty || save.isPending}>
            <Undo2 /> Đặt lại
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Huỷ
          </Button>
          <Button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Lưu ảnh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
