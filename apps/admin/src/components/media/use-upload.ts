'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { Media } from '@/lib/types';

export function useMediaUpload() {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const upload = async (files: FileList | File[], folderId?: string | null): Promise<Media[]> => {
    const list = Array.from(files);
    if (!list.length) return [];
    setUploading(true);
    try {
      const out: Media[] = [];
      // gửi theo lô 5 file để tránh request quá lớn
      for (let i = 0; i < list.length; i += 5) {
        const fd = new FormData();
        list.slice(i, i + 5).forEach((f) => fd.append('files', f));
        if (folderId) fd.append('folderId', folderId);
        out.push(...(await api.upload<Media[]>('/admin/media/upload', fd)));
      }
      toast.success(`Đã tải lên ${out.length} file`);
      void qc.invalidateQueries({ queryKey: ['media'] });
      return out;
    } catch (err) {
      toast.error(errorMessage(err));
      return [];
    } finally {
      setUploading(false);
    }
  };
  return { upload, uploading };
}

/** Chuyển Media -> MediaRef lưu trong dữ liệu block */
export function toMediaRef(m: Media, locale = 'vi') {
  return { id: m.id, url: m.url, alt: m.alt?.[locale] ?? '', width: m.width, height: m.height };
}

export function isImage(m: { mimeType: string }) {
  return m.mimeType.startsWith('image/');
}
