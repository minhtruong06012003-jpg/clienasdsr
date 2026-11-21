'use client';

import { create } from 'zustand';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

const useConfirmStore = create<{ opts: ConfirmOptions | null; resolve: ((v: boolean) => void) | null; open: (o: ConfirmOptions) => Promise<boolean>; close: (v: boolean) => void }>((set, get) => ({
  opts: null,
  resolve: null,
  open: (opts) => new Promise<boolean>((resolve) => set({ opts, resolve })),
  close: (v) => {
    get().resolve?.(v);
    set({ opts: null, resolve: null });
  },
}));

/** Hộp thoại xác nhận dạng promise: if (await confirm({ title: 'Xoá?' })) ... */
export function useConfirm() {
  return useConfirmStore((s) => s.open);
}

export function ConfirmHost() {
  const { opts, close } = useConfirmStore();
  return (
    <AlertDialog open={!!opts} onOpenChange={(o) => !o && close(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description && <AlertDialogDescription>{opts.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>{opts?.cancelText ?? 'Huỷ'}</AlertDialogCancel>
          <AlertDialogAction className={opts?.destructive ? buttonVariants({ variant: 'destructive' }) : undefined} onClick={() => close(true)}>
            {opts?.confirmText ?? 'Xác nhận'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
