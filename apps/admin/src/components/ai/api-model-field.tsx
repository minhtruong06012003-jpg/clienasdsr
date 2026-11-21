'use client';

/**
 * Ô "Mã model API" trong hộp sửa công cụ: mã khách dùng khi gọi API `/v1` (vd `kling-2.6`, `gpt-image-2`).
 * Mã tự sinh từ tên model lần đầu rồi giữ cố định; admin đổi được (để trống + Lưu = sinh lại tự động).
 * Lưu riêng bằng nút của ô này (`PUT /admin/ai/api-models/:key`), không đi chung nút Lưu của form công cụ.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';

export function ApiModelField({ toolKey }: { toolKey: string }) {
  const qc = useQueryClient();
  // bảng { khoá công cụ: mã model API } của mọi công cụ
  const ids = useQuery({ queryKey: ['ai-api-models'], queryFn: () => api.get<Record<string, string>>('/admin/ai/api-models') });
  const current = ids.data?.[toolKey] ?? '';
  const [value, setValue] = useState('');
  useEffect(() => setValue(current), [current]);
  const save = useMutation({
    mutationFn: () => api.put<{ apiModel: string | null }>(`/admin/ai/api-models/${encodeURIComponent(toolKey)}`, { apiModel: value.trim() || null }),
    onSuccess: (r) => {
      toast.success(`Mã model API: ${r.apiModel ?? '—'}`);
      qc.invalidateQueries({ queryKey: ['ai-api-models'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`api-model-${toolKey}`}>Mã model API</Label>
      <div className="flex gap-2">
        <Input
          id={`api-model-${toolKey}`}
          className="font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          placeholder="vd kling-2.6 hoặc kling-2.6/image-to-video"
          maxLength={121}
          disabled={ids.isLoading}
        />
        <Button type="button" variant="outline" onClick={() => save.mutate()} disabled={save.isPending || value.trim() === current}>
          Lưu mã
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Khách gọi <code>POST /api/v1/generations</code> với <code>{'{ "model": "…" }'}</code>. Đổi mã sẽ làm hỏng tích hợp cũ của khách đang dùng mã này. Để trống rồi lưu = sinh lại tự động.
      </p>
    </div>
  );
}
