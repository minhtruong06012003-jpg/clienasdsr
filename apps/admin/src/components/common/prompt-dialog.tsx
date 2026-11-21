'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Ô nhập nhiều dòng (Textarea) */
  multiline?: boolean;
  /** Không cho xác nhận khi để trống (mặc định true) */
  required?: boolean;
  confirmText?: string;
  cancelText?: string;
}

const usePromptStore = create<{ opts: PromptOptions | null; resolve: ((v: string | null) => void) | null; open: (o: PromptOptions) => Promise<string | null>; close: (v: string | null) => void }>((set, get) => ({
  opts: null,
  resolve: null,
  open: (opts) => new Promise<string | null>((resolve) => set({ opts, resolve })),
  close: (v) => {
    get().resolve?.(v);
    set({ opts: null, resolve: null });
  },
}));

/** Hộp thoại nhập chuỗi dạng promise (thay window.prompt): const name = await prompt({ title: 'Tên block' }); null nếu huỷ */
export function usePrompt() {
  return usePromptStore((s) => s.open);
}

export function PromptHost() {
  const { opts, close } = usePromptStore();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (opts) setValue(opts.defaultValue ?? '');
  }, [opts]);
  const required = opts?.required ?? true;
  const submit = () => {
    if (required && !value.trim()) return;
    close(value);
  };
  return (
    <Dialog open={!!opts} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{opts?.title}</DialogTitle>
            {opts?.description ? <DialogDescription>{opts.description}</DialogDescription> : <DialogDescription className="sr-only">Nhập giá trị rồi bấm xác nhận</DialogDescription>}
          </DialogHeader>
          <div className="space-y-1.5">
            {opts?.label && <Label htmlFor="prompt-dialog-input">{opts.label}</Label>}
            {opts?.multiline ? (
              <Textarea id="prompt-dialog-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts.placeholder} className="min-h-40" />
            ) : (
              <Input id="prompt-dialog-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts?.placeholder} />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(null)}>
              {opts?.cancelText ?? 'Huỷ'}
            </Button>
            <Button type="submit" disabled={required && !value.trim()}>
              {opts?.confirmText ?? 'Xác nhận'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
