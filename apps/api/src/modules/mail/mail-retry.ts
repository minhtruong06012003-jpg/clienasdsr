/** Chính sách thử lại của hàng chờ email (hàm thuần, dùng bởi MailService và test) */

/** Khoảng chờ trước lần thử lại thứ n (giây): 1 phút, 5 phút, 15 phút, 1 giờ, 3 giờ, 6 giờ... */
const RETRY_DELAYS = [60, 300, 900, 3600, 10_800, 21_600];
export const retryDelayMs = (attempt: number) => RETRY_DELAYS[Math.min(Math.max(attempt, 1), RETRY_DELAYS.length) - 1] * 1000;

/** Mã phản hồi SMTP 3 chữ số của lỗi: lấy từ responseCode, hoặc từ chuỗi phản hồi / thông báo lỗi */
export function smtpCode(err: unknown): number | null {
  const e = err as { responseCode?: number; response?: string; message?: string } | null;
  if (Number(e?.responseCode) >= 200) return Number(e!.responseCode);
  const m = /\b([245]\d\d)[\s-]/.exec(`${e?.response ?? ''} ${e?.message ?? ''}`);
  return m ? Number(m[1]) : null;
}

/**
 * Lỗi SMTP vĩnh viễn → không thử lại (thử lại vô ích, còn làm xấu uy tín máy chủ gửi):
 * địa chỉ nhận bị từ chối hẳn / không tồn tại / sai cú pháp (501, 550, 551, 553).
 * Lỗi tạm thời 4xx (kể cả khi người nhận bị từ chối tạm — nodemailer vẫn gắn mã EENVELOPE),
 * lỗi xác thực 535, mất kết nối... đều được thử lại.
 */
export function isPermanentMailError(err: unknown): boolean {
  const code = smtpCode(err);
  if (code !== null) return [501, 550, 551, 553].includes(code);
  // người nhận bị từ chối nhưng không rõ mã → coi là vĩnh viễn
  return (err as { code?: string } | null)?.code === 'EENVELOPE';
}
