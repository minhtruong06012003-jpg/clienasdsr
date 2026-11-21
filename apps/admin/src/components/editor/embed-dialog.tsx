'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { resolveEmbed } from './extensions';

/** Hộp thoại nhúng video / iframe: YouTube, Facebook, TikTok, Google Maps, Vimeo hoặc mã iframe (chỉ https) */
export function EmbedDialog({ editor, open, onOpenChange }: { editor: Editor; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [input, setInput] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  useEffect(() => {
    if (open) {
      setInput('');
      setWidth('');
      setHeight('');
    }
  }, [open]);
  const resolved = useMemo(() => resolveEmbed(input), [input]);

  const insert = () => {
    if (!resolved) return toast.error('URL không hợp lệ. Chỉ chấp nhận liên kết https hoặc mã iframe có src https.');
    const chain = editor.chain().focus();
    if (resolved.kind === 'youtube') chain.setYoutubeVideo({ src: resolved.src }).run();
    else chain.setEmbed({ src: resolved.src, width: width.trim() || resolved.width || '100%', height: height.trim() || resolved.height || '450', title: resolved.title ?? null }).run();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nhúng video / iframe</DialogTitle>
          <DialogDescription>Dán liên kết YouTube, Facebook, TikTok, Vimeo, Google Maps (link nhúng) hoặc mã &lt;iframe&gt;. Chỉ chấp nhận nguồn https.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder={'https://www.youtube.com/watch?v=...\nhoặc <iframe src="https://..."></iframe>'} className="min-h-24 font-mono text-xs" />
          {input.trim() && (
            <p className={resolved ? 'break-all text-xs text-muted-foreground' : 'text-xs text-destructive'}>{resolved ? `Nguồn: ${resolved.src}` : 'Không nhận dạng được liên kết hợp lệ.'}</p>
          )}
          {resolved?.kind === 'iframe' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rte-embed-w">Rộng</Label>
                <Input id="rte-embed-w" value={width} onChange={(e) => setWidth(e.target.value)} placeholder={resolved.width ?? '100%'} className="h-8" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rte-embed-h">Cao (px)</Label>
                <Input id="rte-embed-h" value={height} onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))} placeholder={resolved.height ?? '450'} className="h-8" />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button type="button" disabled={!resolved} onClick={insert}>
            Chèn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
