'use client';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatDate } from '@/lib/format';

/** Công tắc tự động lưu bản nháp + thời điểm tự lưu gần nhất */
export function AutosaveToggle({ enabled, onChange, lastSavedAt, hint = 'Chỉ áp dụng với bản nháp đã lưu, sau 30 giây không gõ' }: { enabled: boolean; onChange: (v: boolean) => void; lastSavedAt?: Date | null; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label className="text-sm">Tự động lưu nháp</Label>
        <p className="text-xs text-muted-foreground">{lastSavedAt ? `Đã tự lưu lúc ${formatDate(lastSavedAt, 'HH:mm')}` : hint}</p>
      </div>
      <Switch checked={enabled} onCheckedChange={onChange} aria-label="Tự động lưu nháp" />
    </div>
  );
}
