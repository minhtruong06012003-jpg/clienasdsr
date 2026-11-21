'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Nút sao chép một chuỗi (URL webhook, khoá...) vào clipboard, đổi icon ✓ trong giây lát sau khi chép */
export function CopyButton({ text, label = 'Sao chép', className, size = 'sm' }: { text: string; label?: string; className?: string; size?: 'sm' | 'xs' }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        toast.success('Đã sao chép');
        setTimeout(() => setDone(false), 1500);
      },
      () => toast.error('Không sao chép được, hãy bôi đen và sao chép thủ công'),
    );
  return (
    <Button type="button" variant="outline" size={size} className={cn('shrink-0', className)} onClick={copy} disabled={!text}>
      {done ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />} {done ? 'Đã chép' : label}
    </Button>
  );
}
