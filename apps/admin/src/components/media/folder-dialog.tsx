'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/common/field';

/** Dialog nhập tên thư mục (tạo mới / đổi tên) — thay cho window.prompt */
export function FolderNameDialog({ open, onOpenChange, title, description, initial = '', submitText = 'Lưu', onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; initial?: string; submitText?: string; onSubmit: (name: string) => Promise<void> | void }) {
  const [name, setName] = useState(initial);
  const [key, setKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // reset giá trị mỗi lần mở lại
  const resetKey = `${open}:${initial}`;
  if (key !== resetKey) {
    setKey(resetKey);
    setName(initial);
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v || pending) return;
    setPending(true);
    try {
      await onSubmit(v);
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <Field label="Tên thư mục">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Vd: Banner, Sản phẩm 2026..." maxLength={100} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending && <Loader2 className="animate-spin" />} {submitText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
