'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error';

/** Bắt lỗi JavaScript không được xử lý trên trang quản trị và gửi vào Nhật ký lỗi */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportClientError(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => reportClientError(e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
