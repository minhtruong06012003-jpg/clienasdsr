'use client';

import { RefreshCw } from 'lucide-react';
import { slugify } from '@cmsnt/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/** Ô nhập slug (đường dẫn) có tiền tố và nút tạo lại từ tiêu đề */
export function SlugInput({ value, onChange, source, prefix }: { value: string; onChange: (v: string) => void; source?: string; prefix?: string }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border focus-within:ring-3 focus-within:ring-ring/50">
      {prefix && <span className="flex items-center bg-muted px-2.5 text-xs text-muted-foreground">{prefix}</span>}
      <Input value={value} onChange={(e) => onChange(e.target.value)} onBlur={(e) => onChange(slugify(e.target.value))} className="rounded-none border-0 shadow-none focus-visible:ring-0" placeholder="tu-dong-tao-tu-tieu-de" />
      {source !== undefined && (
        <Button type="button" variant="ghost" size="icon" className="rounded-none" title="Tạo lại từ tiêu đề" onClick={() => onChange(slugify(source))}>
          <RefreshCw />
        </Button>
      )}
    </div>
  );
}
