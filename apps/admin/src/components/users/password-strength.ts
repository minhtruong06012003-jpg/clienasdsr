/** Ước lượng độ mạnh mật khẩu (0-4) để hiển thị thanh gợi ý */
export function passwordStrength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: '', color: 'bg-muted' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 8) score = Math.min(score, 1);
  const map = [
    { label: 'Rất yếu', color: 'bg-red-500' },
    { label: 'Yếu', color: 'bg-red-500' },
    { label: 'Trung bình', color: 'bg-amber-500' },
    { label: 'Mạnh', color: 'bg-emerald-500' },
    { label: 'Rất mạnh', color: 'bg-emerald-600' },
  ];
  return { score: Math.max(score, 1), ...map[score] };
}

/**
 * Sinh mật khẩu ngẫu nhiên an toàn, luôn có đủ chữ hoa, chữ thường, chữ số và ký tự đặc biệt
 * (để qua được mọi chính sách mật khẩu trong Cài đặt › Bảo mật).
 */
export function generatePassword(length = 14) {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*'];
  const all = groups.join('');
  const n = Math.max(length, groups.length);
  const rand = (max: number) => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % max;
  };
  const chars = groups.map((g) => g[rand(g.length)]);
  while (chars.length < n) chars.push(all[rand(all.length)]);
  // xáo trộn Fisher–Yates để 4 ký tự bắt buộc không luôn nằm đầu chuỗi
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
