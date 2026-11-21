'use client';

import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Language } from '@/lib/types';

/** Hiển thị khi ngôn ngữ đang chọn chưa có bản dịch */
export function TranslationGate({ language, sourceLanguage, onCreate }: { language?: Language; sourceLanguage?: Language; onCreate: (copyFrom: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
      <Languages className="size-8 text-muted-foreground" />
      <div>
        <p className="font-medium">
          Chưa có bản {language?.name ?? ''} {language?.flag}
        </p>
        <p className="text-sm text-muted-foreground">Tạo bản dịch để nội dung hiển thị cho ngôn ngữ này.</p>
      </div>
      <div className="flex gap-2">
        {sourceLanguage && (
          <Button onClick={() => onCreate(true)}>
            Sao chép từ {sourceLanguage.name} để dịch
          </Button>
        )}
        <Button variant="outline" onClick={() => onCreate(false)}>
          Bắt đầu trống
        </Button>
      </div>
    </div>
  );
}
