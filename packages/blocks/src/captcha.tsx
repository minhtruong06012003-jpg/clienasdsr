'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type CaptchaProvider = 'none' | 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha';

/** Cấu hình captcha công khai (từ bootstrap.captcha) — không có secret */
export interface CaptchaConfig {
  provider: CaptchaProvider;
  siteKey: string;
  /** form đang bật: forms | register | review | comment */
  on?: string[];
}

export type CaptchaScope = 'forms' | 'register' | 'review' | 'comment' | 'login';

/* ---- Nạp script của từng nhà cung cấp đúng 1 lần ---- */

type WidgetApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | number;
  reset: (id?: string | number) => void;
  remove?: (id: string | number) => void;
  ready?: (cb: () => void) => void;
  execute?: (siteKey: string, opts: { action: string }) => Promise<string>;
};

declare global {
  interface Window {
    turnstile?: WidgetApi;
    grecaptcha?: WidgetApi;
    hcaptcha?: WidgetApi;
    __cmsntCaptchaLoad?: Partial<Record<string, Promise<WidgetApi>>>;
  }
}

function scriptUrl(provider: CaptchaProvider, siteKey: string): string {
  switch (provider) {
    case 'turnstile':
      return 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    case 'recaptcha-v2':
      return 'https://www.google.com/recaptcha/api.js?render=explicit';
    case 'recaptcha-v3':
      return `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    case 'hcaptcha':
      return 'https://js.hcaptcha.com/1/api.js?render=explicit';
    default:
      return '';
  }
}

function globalApi(provider: CaptchaProvider): WidgetApi | undefined {
  if (provider === 'turnstile') return window.turnstile;
  if (provider === 'hcaptcha') return window.hcaptcha;
  if (provider === 'recaptcha-v2' || provider === 'recaptcha-v3') return window.grecaptcha;
  return undefined;
}

/** Nạp SDK (1 lần / provider) và trả về API toàn cục khi sẵn sàng */
function loadCaptcha(provider: CaptchaProvider, siteKey: string): Promise<WidgetApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const key = provider === 'recaptcha-v3' ? `${provider}:${siteKey}` : provider;
  window.__cmsntCaptchaLoad ??= {};
  const cached = window.__cmsntCaptchaLoad[key];
  if (cached) return cached;
  const promise = new Promise<WidgetApi>((resolve, reject) => {
    const existing = globalApi(provider);
    if (existing && provider !== 'recaptcha-v3') return resolve(existing);
    const url = scriptUrl(provider, siteKey);
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      const api = globalApi(provider);
      if (!api) return reject(new Error('captcha api missing'));
      // grecaptcha / hcaptcha cần ready() trước khi render
      if (api.ready) api.ready(() => resolve(api));
      else resolve(api);
    };
    s.onerror = () => reject(new Error('captcha script failed'));
    document.head.appendChild(s);
  });
  window.__cmsntCaptchaLoad[key] = promise;
  promise.catch(() => {
    delete window.__cmsntCaptchaLoad?.[key];
  });
  return promise;
}

/** Captcha có áp dụng cho scope này không */
export function captchaEnabled(config: CaptchaConfig | null | undefined, scope: CaptchaScope): config is CaptchaConfig {
  return !!config && config.provider !== 'none' && !!config.siteKey && (config.on?.includes(scope) ?? true);
}

export interface CaptchaHandle {
  /** có captcha cho form này không (false -> widget rỗng, getToken trả undefined) */
  enabled: boolean;
  /** phần tử widget để đặt trong form (reCAPTCHA v3 không hiện gì) */
  widget: ReactNode;
  /** lấy token khi submit; ném lỗi (message = `strings.required`) nếu người dùng chưa xác minh */
  getToken: () => Promise<string | undefined>;
  /** đặt lại widget sau khi gửi (token chỉ dùng 1 lần) */
  reset: () => void;
}

export interface CaptchaStrings {
  /** "Vui lòng xác minh bạn không phải robot" */
  required?: string;
  /** "Không tải được captcha" */
  loadError?: string;
}

/**
 * Hook dùng captcha trong form: `const captcha = useCaptcha(config, 'register')`,
 * render `{captcha.widget}` trong form, khi submit `const token = await captcha.getToken()` rồi gửi `_captcha: token`.
 * - Turnstile / reCAPTCHA v2 / hCaptcha: widget hiển thị, token lấy từ callback.
 * - reCAPTCHA v3: vô hình, `getToken` gọi `execute(siteKey, { action: scope })` lúc submit.
 */
export function useCaptcha(config: CaptchaConfig | null | undefined, scope: CaptchaScope, strings?: CaptchaStrings): CaptchaHandle {
  const enabled = captchaEnabled(config, scope);
  const provider = enabled ? config.provider : 'none';
  const siteKey = enabled ? config.siteKey : '';
  const tokenRef = useRef<string | null>(null);
  const apiRef = useRef<WidgetApi | null>(null);
  const widgetIdRef = useRef<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reset = useCallback(() => {
    tokenRef.current = null;
    if (apiRef.current && widgetIdRef.current != null && provider !== 'recaptcha-v3') {
      try {
        apiRef.current.reset(widgetIdRef.current);
      } catch {
        /* widget đã bị gỡ */
      }
    }
    setTick((t) => t + 1);
  }, [provider]);

  const getToken = useCallback(async () => {
    if (!enabled) return undefined;
    if (provider === 'recaptcha-v3') {
      const api = apiRef.current ?? (await loadCaptcha(provider, siteKey));
      apiRef.current = api;
      if (!api.execute) throw new Error(strings?.loadError ?? 'Captcha unavailable');
      return api.execute(siteKey, { action: scope });
    }
    if (!tokenRef.current) throw new Error(strings?.required ?? 'Please complete the captcha');
    return tokenRef.current;
  }, [enabled, provider, siteKey, scope, strings?.required, strings?.loadError]);

  const widget = useMemo(() => {
    if (!enabled || provider === 'recaptcha-v3') return null;
    return <CaptchaWidget key={`${provider}:${siteKey}:${tick}`} provider={provider} siteKey={siteKey} onToken={(t) => (tokenRef.current = t)} onReady={(api, id) => ((apiRef.current = api), (widgetIdRef.current = id))} onError={() => setError(strings?.loadError ?? 'Could not load captcha')} error={error} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, provider, siteKey, tick, error]);

  return { enabled, widget, getToken, reset };
}

function CaptchaWidget({ provider, siteKey, onToken, onReady, onError, error }: { provider: CaptchaProvider; siteKey: string; onToken: (t: string | null) => void; onReady: (api: WidgetApi, id: string | number) => void; onError: () => void; error: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let api: WidgetApi | null = null;
    let id: string | number | null = null;
    const el = ref.current;
    if (!el) return;
    loadCaptcha(provider, siteKey)
      .then((a) => {
        if (cancelled) return;
        api = a;
        const expired = () => onToken(null);
        const opts: Record<string, unknown> =
          provider === 'turnstile'
            ? { sitekey: siteKey, callback: onToken, 'expired-callback': expired, 'error-callback': expired, 'timeout-callback': expired }
            : { sitekey: siteKey, callback: onToken, 'expired-callback': expired, 'error-callback': expired };
        id = a.render(el, opts);
        onReady(a, id);
      })
      .catch(() => !cancelled && onError());
    return () => {
      cancelled = true;
      if (api && id != null) {
        try {
          api.remove?.(id);
        } catch {
          /* bỏ qua */
        }
      }
      el.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, siteKey]);
  return (
    <div data-captcha={provider}>
      <div ref={ref} className="min-h-[65px]" />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
