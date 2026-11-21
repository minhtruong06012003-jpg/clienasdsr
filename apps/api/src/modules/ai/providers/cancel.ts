import { AiProviderError, type AiCallContext, type AiProvider, type AiToolDef } from '../ai.types.js';
import { joinUrl, pickMessage, str } from './http.js';

export interface UpstreamCancelResult {
  ok: boolean;
  httpStatus?: number;
  upstreamStatus?: string;
  note: string;
  raw?: unknown;
}

interface ProbeSpec {
  method: 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

async function runProbe(spec: ProbeSpec): Promise<{ status: number; ok: boolean; data: any }> {
  try {
    const res = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text().catch(() => '');
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text.slice(0, 300) };
      }
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: { error: (err as Error).message } };
  }
}

function summarizeBody(data: any): string {
  if (!data) return '';
  const msg =
    str(data?.message) ||
    str(data?.detail) ||
    str(data?.error?.message) ||
    str(data?.error) ||
    pickMessage(data) ||
    str(data?.rawText);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function originOf(baseUrl: string, fallback: string): string {
  try {
    const u = new URL(baseUrl || fallback);
    return `${u.protocol}//${u.host}`;
  } catch {
    return fallback;
  }
}

/**
 * T-427 & T-429: Gọi sang API nhà cung cấp để huỷ đơn ngay khi Admin / Khách / Hệ thống huỷ hoàn tiền.
 * - Dù nguồn có hỗ trợ huỷ qua API hay không, vẫn thử gọi lệnh huỷ an toàn (timeout ngắn 8s) + kiểm tra trạng thái thực tế trên nguồn.
 * - Luôn trả về `note` rõ ràng để lưu lên tác vụ cho Admin đối soát chống thất thoát doanh thu.
 */
export async function cancelTaskUpstream(
  providerKey: string,
  tool: AiToolDef | undefined,
  providerTaskId: string,
  ctx: AiCallContext,
  provider?: AiProvider,
): Promise<UpstreamCancelResult> {
  const rawId = (providerTaskId ?? '').trim();
  if (!rawId) {
    return { ok: true, upstreamStatus: 'not_submitted', note: 'Đơn chưa gửi sang nguồn (chưa phát sinh mã NCC)' };
  }

  // Nếu adapter có hàm cancel() riêng thì ưu tiên gọi trước
  if (provider?.cancel && tool) {
    try {
      return await provider.cancel(tool, rawId, ctx);
    } catch (err) {
      return {
        ok: false,
        upstreamStatus: 'error',
        note: `Gọi huỷ nguồn lỗi: ${(err as Error).message.slice(0, 160)}`,
      };
    }
  }

  const apiKey = str(ctx.config.apiKey).trim();
  const sessionCookie = str((ctx.config as Record<string, unknown>).sessionCookie).trim();
  if (!apiKey && !sessionCookie) {
    return { ok: false, upstreamStatus: 'no_credentials', note: 'Nguồn chưa cấu hình khoá API để gọi huỷ' };
  }

  const stdHeaders: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'NovAIStudio/1.0',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {}),
    ...(sessionCookie ? { Cookie: sessionCookie } : {}),
  };
  const jsonHeaders: Record<string, string> = { ...stdHeaders, 'Content-Type': 'application/json' };

  // ---------------- 1. MAIVIDEO (SV15 — T-429) ----------------
  if (providerKey === 'maivideo') {
    const base = originOf(ctx.config.baseUrl, 'https://maivideo.top');
    const isImg = rawId.startsWith('img:') || rawId.startsWith('piximg_') || tool?.output === 'image';
    const jobId = rawId.replace(/^(?:vid|img):/, '');
    const kindPath = isImg ? 'image-generation' : 'video-generation';

    const probes: ProbeSpec[] = [
      { method: 'POST', url: `${base}/api/v1/${kindPath}/${encodeURIComponent(jobId)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${base}/api/v1/${kindPath}/${encodeURIComponent(jobId)}`, headers: stdHeaders },
    ];
    if (!isImg) {
      probes.push(
        { method: 'POST', url: `${base}/api/pixverse-video/jobs/${encodeURIComponent(jobId)}/cancel`, headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: `${base}/api/pixverse-video/jobs/${encodeURIComponent(jobId)}`, headers: stdHeaders },
      );
    }

    let lastHttp = 0;
    let lastMsg = '';
    for (const p of probes) {
      const r = await runProbe(p);
      if (r.status > 0) {
        lastHttp = r.status;
        lastMsg = summarizeBody(r.data);
      }
      if (r.ok && r.data?.error !== true) {
        return {
          ok: true,
          httpStatus: r.status,
          upstreamStatus: 'cancelled',
          note: `Đã gọi API huỷ thành công bên nguồn (HTTP ${r.status}${lastMsg ? `: ${lastMsg}` : ''})`,
          raw: r.data,
        };
      }
    }

    // Kiểm tra trạng thái thực tế của job trên MaiVideo để báo chính xác đơn đã huỷ/xoá hay còn đang chạy
    const stCheck = await runProbe({
      method: 'DELETE' as any, // placeholder overridden below
      url: `${base}/api/v1/${kindPath}/${encodeURIComponent(jobId)}`,
      headers: stdHeaders,
    } as never).catch(() => null);
    void stCheck;

    try {
      const checkRes = await fetch(`${base}/api/v1/${kindPath}/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: stdHeaders,
        signal: AbortSignal.timeout(8_000),
      });
      const txt = await checkRes.text().catch(() => '');
      const checkJson = txt ? JSON.parse(txt) : null;
      if (checkRes.status === 404 || /không tìm thấy job/i.test(txt)) {
        return {
          ok: true,
          httpStatus: 404,
          upstreamStatus: 'deleted_or_cancelled',
          note: 'Đơn đã được huỷ / xoá bên nguồn (nguồn báo không còn job đang chạy)',
          raw: checkJson,
        };
      }
      const liveSt = str(checkJson?.status ?? checkJson?.job?.status).toLowerCase() || `http_${checkRes.status}`;
      if (['cancelled', 'canceled', 'error', 'failed'].includes(liveSt)) {
        return {
          ok: true,
          httpStatus: checkRes.status,
          upstreamStatus: liveSt,
          note: `Đơn bên nguồn đã dừng (${liveSt}) — không phát sinh trừ credit nguồn`,
          raw: checkJson,
        };
      }
      if (liveSt === 'completed' || liveSt === 'partial') {
        return {
          ok: false,
          httpStatus: lastHttp || checkRes.status,
          upstreamStatus: liveSt,
          note: `Nguồn báo job đã hoàn tất (${liveSt}) nên không thể huỷ ngược lại`,
          raw: checkJson,
        };
      }
      return {
        ok: false,
        httpStatus: lastHttp || 405,
        upstreamStatus: liveSt,
        note: sessionCookie
          ? `Đã gọi huỷ nhưng nguồn trả HTTP ${lastHttp} (${lastMsg || 'chưa cho huỷ'}) · Trạng thái nguồn: ${liveSt}`
          : `API Key nguồn chưa mở cổng huỷ (HTTP ${lastHttp || 405}) · Trạng thái nguồn: ${liveSt}`,
        raw: { cancelHttp: lastHttp, cancelMsg: lastMsg, statusCheck: checkJson },
      };
    } catch {
      return {
        ok: false,
        httpStatus: lastHttp,
        upstreamStatus: 'unknown',
        note: `Đã gọi huỷ nguồn (HTTP ${lastHttp || 'timeout'}${lastMsg ? `: ${lastMsg}` : ''})`,
      };
    }
  }

  // ---------------- 2. AI DEEPCUT (SV4 — T-427) ----------------
  if (providerKey === 'aideepcut') {
    const base = (ctx.config.baseUrl || 'https://aideepcut.com/api/v1').replace(/\/$/, '');
    const origin = originOf(base, 'https://aideepcut.com');
    const probes: ProbeSpec[] = [
      { method: 'POST', url: `${base}/tasks/${encodeURIComponent(rawId)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${base}/tasks/${encodeURIComponent(rawId)}`, headers: stdHeaders },
      { method: 'DELETE', url: `${origin}/api/tasks?id=${encodeURIComponent(rawId)}`, headers: stdHeaders },
    ];
    let lastHttp = 0;
    let lastMsg = '';
    for (const p of probes) {
      const r = await runProbe(p);
      if (r.status > 0) {
        lastHttp = r.status;
        lastMsg = summarizeBody(r.data);
      }
      if (r.ok && r.data?.ok !== false && r.data?.error !== true) {
        return {
          ok: true,
          httpStatus: r.status,
          upstreamStatus: 'cancelled',
          note: `Đã huỷ đơn bên nguồn thành công (${lastMsg || `HTTP ${r.status}`})`,
          raw: r.data,
        };
      }
    }
    return probeLiveFallback(tool, rawId, ctx, provider, lastHttp, lastMsg);
  }

  // ---------------- 3. IVOI (SV6) ----------------
  if (providerKey === 'ivoi') {
    const [jobId, tempCloneId = ''] = rawId.split('::');
    const origin = originOf(ctx.config.baseUrl, 'https://ivoi.io');
    if (tempCloneId) {
      await runProbe({ method: 'DELETE', url: `${origin}/api/v1/voices/${encodeURIComponent(tempCloneId)}`, headers: stdHeaders }).catch(() => null);
    }
    const probes: ProbeSpec[] = [
      { method: 'POST', url: `${origin}/api/v1/tts/jobs/${encodeURIComponent(jobId)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${origin}/api/v1/tts/jobs/${encodeURIComponent(jobId)}`, headers: stdHeaders },
    ];
    let lastHttp = 0;
    let lastMsg = '';
    for (const p of probes) {
      const r = await runProbe(p);
      if (r.status > 0) {
        lastHttp = r.status;
        lastMsg = summarizeBody(r.data);
      }
      if (r.ok) {
        return { ok: true, httpStatus: r.status, upstreamStatus: 'cancelled', note: `Đã huỷ tác vụ giọng đọc bên nguồn (${lastMsg || `HTTP ${r.status}`})`, raw: r.data };
      }
    }
    return probeLiveFallback(tool, rawId, ctx, provider, lastHttp, lastMsg);
  }

  // ---------------- 4. CÁC NGUỒN CÒN LẠI (SV1, SV2, SV3, SV5, SV7, SV9, SV10, SV12, SV13, SV14) ----------------
  const base = (ctx.config.baseUrl || '').replace(/\/$/, '');
  const probes: ProbeSpec[] = [];

  if (providerKey === 'fable') {
    const fBase = base || 'https://fablemedical.shop/v1';
    if (!rawId.startsWith('stitch:')) {
      probes.push(
        { method: 'POST', url: joinUrl(fBase, `/videos/${encodeURIComponent(rawId)}/cancel`), headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: joinUrl(fBase, `/videos/${encodeURIComponent(rawId)}`), headers: stdHeaders },
      );
    }
  } else if (providerKey === 'tmc' || providerKey === 'tramsangtao' || providerKey === 'up4k') {
    if (!rawId.startsWith('tmc-tool-') && base) {
      probes.push(
        { method: 'POST', url: joinUrl(base, `/jobs/${encodeURIComponent(rawId)}/cancel`), headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: joinUrl(base, `/jobs/${encodeURIComponent(rawId)}`), headers: stdHeaders },
      );
    }
  } else if (providerKey === 'kapend') {
    const kOrigin = originOf(base, 'https://kapend.com');
    const cleanIds = rawId.includes('|') ? rawId.split('|').filter(Boolean) : [rawId.replace(/^logo:/, '')];
    for (const cid of cleanIds.slice(0, 4)) {
      probes.push(
        { method: 'POST', url: `${kOrigin}/api/generation-jobs/${encodeURIComponent(cid)}/cancel`, headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: `${kOrigin}/api/generation-jobs/${encodeURIComponent(cid)}`, headers: stdHeaders },
      );
    }
  } else if (providerKey === 'prismforge') {
    const pfBase = base || 'https://prismforge.cloud/v1';
    const isImg = rawId.startsWith('img:') || tool?.output === 'image';
    const cid = rawId.replace(/^(?:vid|img):/, '');
    const kind = isImg ? 'images' : 'videos';
    probes.push(
      { method: 'POST', url: joinUrl(pfBase, `/${kind}/${encodeURIComponent(cid)}/cancel`), headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: joinUrl(pfBase, `/${kind}/${encodeURIComponent(cid)}`), headers: stdHeaders },
    );
  } else if (providerKey === 'ahiep') {
    if (rawId.startsWith('video:') && base) {
      const cid = rawId.slice(6);
      probes.push(
        { method: 'POST', url: joinUrl(base, `/videos/${encodeURIComponent(cid)}/cancel`), headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: joinUrl(base, `/videos/${encodeURIComponent(cid)}`), headers: stdHeaders },
      );
    }
  } else if (providerKey === 'runup') {
    if (base) {
      probes.push(
        { method: 'POST', url: joinUrl(base, `/video-jobs/${encodeURIComponent(rawId)}/cancel`), headers: jsonHeaders, body: '{}' },
        { method: 'DELETE', url: joinUrl(base, `/video-jobs/${encodeURIComponent(rawId)}`), headers: stdHeaders },
      );
    }
  } else if (providerKey === 'gommo') {
    const gBase = base || 'https://v2.api.gommo.net';
    const parts = rawId.split(':');
    const idBase = parts.length >= 2 ? parts[1] : rawId;
    probes.push(
      { method: 'POST', url: `${gBase}/ai/jobs/${encodeURIComponent(idBase)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${gBase}/ai/jobs/${encodeURIComponent(idBase)}`, headers: stdHeaders },
    );
  } else if (providerKey === 'botsd') {
    const bBase = originOf(base, 'https://botsd.pro');
    const cid = rawId.replace(/^img:/, '');
    probes.push(
      { method: 'POST', url: `${bBase}/api/web/video/job/${encodeURIComponent(cid)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${bBase}/api/web/video/job/${encodeURIComponent(cid)}`, headers: stdHeaders },
    );
  } else if (providerKey === 'aishop24') {
    const aBase = originOf(base, 'https://aishop24.io.vn');
    const cid = rawId.replace(/^(?:img|vid):/, '');
    probes.push(
      { method: 'POST', url: `${aBase}/api/v1/jobs/${encodeURIComponent(cid)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${aBase}/api/v1/jobs/${encodeURIComponent(cid)}`, headers: stdHeaders },
    );
  } else if (providerKey === 'plenxai') {
    const pBase = originOf(base, 'https://plenxai.com');
    const cid = rawId.replace(/^(?:img|vid):/, '');
    probes.push(
      { method: 'POST', url: `${pBase}/api/v1/tasks/${encodeURIComponent(cid)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${pBase}/api/v1/tasks/${encodeURIComponent(cid)}`, headers: stdHeaders },
    );
  } else if (providerKey === 'seedancebot') {
    const sBase = originOf(base, 'https://seedancecreationbot.online');
    const cid = rawId.replace(/^(?:img|vid):/, '');
    probes.push(
      { method: 'POST', url: `${sBase}/api/v1/tasks/${encodeURIComponent(cid)}/cancel`, headers: jsonHeaders, body: '{}' },
      { method: 'DELETE', url: `${sBase}/api/v1/tasks/${encodeURIComponent(cid)}`, headers: stdHeaders },
    );
  }

  let lastHttp = 0;
  let lastMsg = '';
  for (const p of probes) {
    const r = await runProbe(p);
    if (r.status > 0) {
      lastHttp = r.status;
      lastMsg = summarizeBody(r.data);
    }
    if (r.ok && r.data?.ok !== false && r.data?.success !== false) {
      return {
        ok: true,
        httpStatus: r.status,
        upstreamStatus: 'cancelled',
        note: `Đã gửi lệnh huỷ bên nguồn thành công (${lastMsg || `HTTP ${r.status}`})`,
        raw: r.data,
      };
    }
  }

  return probeLiveFallback(tool, rawId, ctx, provider, lastHttp, lastMsg);
}

async function probeLiveFallback(
  tool: AiToolDef | undefined,
  rawId: string,
  ctx: AiCallContext,
  provider: AiProvider | undefined,
  lastHttp: number,
  lastMsg: string,
): Promise<UpstreamCancelResult> {
  if (provider?.poll && tool) {
    try {
      const live = await Promise.race([
        provider.poll(tool, rawId, ctx),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
      ]);
      if (live) {
        if (live.status === 'failed') {
          return {
            ok: true,
            httpStatus: lastHttp || 200,
            upstreamStatus: 'failed_or_cancelled',
            note: `Đơn bên nguồn đã dừng / lỗi (${(live.error || 'đã đóng').slice(0, 100)})`,
            raw: live.raw,
          };
        }
        if (live.status === 'succeeded') {
          return {
            ok: false,
            upstreamStatus: 'succeeded',
            note: 'Đơn bên nguồn đã tạo xong kết quả nên không thể huỷ ngược lại',
            raw: { pollStatus: 'succeeded' },
          };
        }
        const pctTxt = live.progress ? ` (${live.progress}%)` : '';
        return {
          ok: false,
          upstreamStatus: live.status,
          note: `Nguồn này không hỗ trợ huỷ đơn giữa chừng qua API — đơn bên nguồn vẫn đang chạy${pctTxt}`,
          raw: { cancelHttp: lastHttp, cancelMsg: lastMsg, pollStatus: live.status },
        };
      }
    } catch (err) {
      const e = err as AiProviderError;
      if (e instanceof AiProviderError && !e.retryable) {
        return {
          ok: true,
          httpStatus: lastHttp || 200,
          upstreamStatus: 'failed_or_cancelled',
          note: `Đơn bên nguồn đã dừng / hoàn phí (${e.message.slice(0, 100)})`,
          raw: e.raw,
        };
      }
    }
  }

  return {
    ok: false,
    upstreamStatus: lastHttp === 404 || lastHttp === 405 ? 'unsupported' : 'unknown',
    note:
      lastHttp === 404 || lastHttp === 405
        ? 'Nguồn này không có cổng huỷ đơn qua API'
        : lastHttp
          ? `Nguồn từ chối lệnh huỷ${lastMsg ? `: ${lastMsg}` : ''}`
          : 'Nguồn xử lý đồng bộ / không có cổng huỷ riêng',
  };
}
