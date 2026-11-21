import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerRequest, type ThrottlerStorage } from '@nestjs/throttler';
import { ApiKeyAuthService } from '../../modules/api-keys/api-key-auth.service.js';
import { extractApiKey, hashApiKey, isValidKeyFormat } from '../../modules/api-keys/api-key.util.js';
import { matchesServerSecret, trustedClientIp } from '../utils/client-ip.js';

// giữ export cũ cho nơi khác / test đang import từ guard
export { CLIENT_IP_HEADER, matchesServerSecret, trustedClientIp } from '../utils/client-ip.js';

/** Metadata mà @Throttle({ default: {...} }) gắn lên route/class (hằng số của @nestjs/throttler, không export ra ngoài) */
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMIT';
/** Kết quả xác thực API key được nhớ trong bộ nhớ (tránh tra DB mỗi request chỉ để quyết định có throttle hay không) */
const KEY_CACHE_TTL_MS = 60_000;
const KEY_CACHE_MAX = 5_000;

/** Đọc số nguyên dương từ env, sai định dạng thì dùng mặc định */
const envInt = (name: string, fallback: number) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Cấu hình giới hạn request toàn cục: `THROTTLE_LIMIT` request / `THROTTLE_TTL` giây cho mỗi IP
 * (mặc định 300 request / 60 giây — giữ như trước). Đọc env lúc nạp AppModule (main.ts đã nạp dotenv trước đó).
 */
export function throttleOptionsFromEnv(): ThrottlerModuleOptions {
  return {
    throttlers: [{ ttl: envInt('THROTTLE_TTL', 60) * 1000, limit: envInt('THROTTLE_LIMIT', 300) }],
    errorMessage: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút',
  };
}

type TrustedRequest = { headers?: Record<string, unknown>; ip?: string; __throttleTrusted?: boolean };

/**
 * Guard giới hạn request toàn cục (thay ThrottlerGuard mặc định):
 * - Request mang API key hợp lệ (`X-API-Key` / `Authorization: Bearer cmsnt_...`) hoặc header `x-server-secret`
 *   khớp env `SERVER_API_SECRET` được MIỄN giới hạn toàn cục — frontend SSR gọi API từ một IP duy nhất không bị 429.
 * - Route có giới hạn riêng (@Throttle trên đăng nhập, đăng ký, tra cứu đơn...) VẪN áp dụng với request được miễn,
 *   nhưng đếm theo IP thật của khách trong header `x-client-ip` (chỉ khi có x-server-secret) thay vì IP của máy chủ frontend.
 * - Request thường: giữ nguyên hành vi của ThrottlerGuard (đếm theo req.ip — đã tôn trọng TRUST_PROXY trong main.ts).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /** sha256(key) -> { hợp lệ?, hết hạn lúc } */
  private keyCache = new Map<string, { ok: boolean; until: number }>();

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly apiKeys: ApiKeyAuthService,
  ) {
    super(options, storage, reflector);
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { req } = this.getRequestResponse(props.context) as { req: TrustedRequest };
    if (!(await this.isTrusted(req))) return super.handleRequest(props);

    const routeLimit = this.reflector.getAllAndOverride<unknown>(THROTTLER_LIMIT_KEY + props.throttler.name, [props.context.getHandler(), props.context.getClass()]);
    // không có @Throttle riêng -> đây là giới hạn toàn cục -> miễn
    if (routeLimit === undefined) return true;
    // có giới hạn riêng -> vẫn đếm. Chỉ tin IP khách trong x-client-ip khi có x-server-secret (bí mật chỉ máy chủ frontend biết);
    // API key có thể bị nhúng lộ ở trình duyệt nên KHÔNG được tự khai IP (tránh đổi IP giả để dò mật khẩu)
    if (!matchesServerSecret(req.headers?.['x-server-secret'])) return super.handleRequest(props);
    return super.handleRequest({ ...props, getTracker: async () => trustedClientIp(req) });
  }

  /** Request có được miễn giới hạn toàn cục không (nhớ kết quả trên req: guard gọi handleRequest cho từng throttler) */
  private async isTrusted(req: TrustedRequest): Promise<boolean> {
    if (req.__throttleTrusted !== undefined) return req.__throttleTrusted;
    let trusted = matchesServerSecret(req.headers?.['x-server-secret']);
    if (!trusted) {
      const key = extractApiKey((req.headers ?? {}) as Record<string, string | string[] | undefined>);
      if (key && isValidKeyFormat(key)) trusted = await this.validKey(key, req.ip);
    }
    req.__throttleTrusted = trusted;
    return trusted;
  }

  /** Key còn hiệu lực không (có cache 60s cả kết quả sai — key rác không làm tra DB liên tục) */
  private async validKey(key: string, ip?: string): Promise<boolean> {
    const hash = hashApiKey(key);
    const now = Date.now();
    const hit = this.keyCache.get(hash);
    if (hit && hit.until > now) return hit.ok;
    const ok = !!(await this.apiKeys.authenticate(key, ip).catch(() => null));
    if (this.keyCache.size >= KEY_CACHE_MAX) this.keyCache.clear();
    this.keyCache.set(hash, { ok, until: now + KEY_CACHE_TTL_MS });
    return ok;
  }
}
