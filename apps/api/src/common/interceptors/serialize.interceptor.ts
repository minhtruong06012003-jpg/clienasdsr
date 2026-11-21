import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

/** Chuyển Prisma.Decimal -> number và bỏ passwordHash trước khi trả JSON. */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serialize(data)));
  }
}

function isDecimal(value: unknown): value is { toNumber(): number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function' &&
    'd' in value &&
    'e' in value &&
    's' in value
  );
}

export function serialize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (isDecimal(value)) return value.toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value;
    // Bỏ qua đối tượng ServerResponse của Express (các route dùng @Res() tự trả response) và tránh đệ quy vòng
    if ('writableEnded' in value || ('statusCode' in value && 'req' in value)) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'passwordHash' || k === 'tokenHash') continue;
      out[k] = serialize(v, seen);
    }
    return out;
  }
  return value;
}
