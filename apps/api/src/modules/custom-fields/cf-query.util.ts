/**
 * Lấy bộ lọc trường tuỳ chỉnh từ query string của API public.
 * Hỗ trợ cả hai dạng (tuỳ query parser của Express):
 *   ?cf[platform]=netflix&cf[level]=beginner   -> { platform: 'netflix', level: 'beginner' }
 *   ?cf.platform=netflix                        -> { platform: 'netflix' }
 * ValidationPipe (whitelist) bỏ key lạ trong DTO nên controller đọc trực tiếp từ req.query.
 */
export function parseCfQuery(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  const nested = q.cf;
  if (nested && typeof nested === 'object') for (const [k, v] of Object.entries(nested as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  for (const [k, v] of Object.entries(q)) {
    const m = /^cf(?:\[([a-z0-9_]+)\]|\.([a-z0-9_]+))$/i.exec(k);
    if (m && typeof v === 'string') out[m[1] ?? m[2]] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
