import { createHmac } from 'node:crypto';
import type { CancelResult, EInvoiceProvider, FileResult, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, SyncResult, TestConnectionResult } from './provider.interface.js';
import { EInvoiceProviderError } from './provider.interface.js';
import { assertOk, httpRequest, joinUrl, pick, str } from './http.js';

/**
 * Nhà cung cấp "Webhook tuỳ biến": gửi payload hoá đơn chuẩn (JSON) tới URL của khách hàng/đối tác tích hợp,
 * kèm chữ ký HMAC-SHA256. Dùng cho NCC chưa có adapter sẵn: đối tác viết 1 service trung gian nhận JSON này
 * rồi gọi API NCC, trả về JSON chuẩn `{ status, providerRef, invoiceNo, serial, templateCode, taxAuthorityCode, lookupCode, lookupUrl, pdfUrl }`.
 *
 * Endpoint (POST, JSON):
 *  - {baseUrl}/issue     body: { action: 'issue' | 'replace' | 'adjust', invoice: InvoicePayload }
 *  - {baseUrl}/cancel    body: { action: 'cancel', ref, reason }
 *  - {baseUrl}/status    body: { action: 'status', ref }
 *  - {baseUrl}/pdf       body: { action: 'pdf', ref } -> trả về application/pdf hoặc { base64 }
 *  - {baseUrl}/ping      body: { action: 'ping' }
 * Header: X-CMSNT-Signature = HMAC_SHA256(secret, rawBody) hex, X-CMSNT-Timestamp.
 */
export class CustomWebhookProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'custom',
    name: 'Webhook tuỳ biến (NCC khác)',
    description: 'Gửi JSON hoá đơn chuẩn tới dịch vụ trung gian của bạn (ký HMAC). Dùng cho nhà cung cấp chưa có adapter sẵn.',
    docsUrl: '/docs/hoa-don-dien-tu.md#webhook-tuy-bien',
    signing: 'server',
    fields: [
      { key: 'baseUrl', label: 'Base URL dịch vụ trung gian', type: 'url', required: true, placeholder: 'https://bridge.example.com/einvoice' },
      { key: 'secret', label: 'Secret ký HMAC', type: 'password', required: true, help: 'Dịch vụ của bạn dùng secret này để xác minh header X-CMSNT-Signature' },
      { key: 'apiKey', label: 'API key (tuỳ chọn)', type: 'password', help: 'Gửi trong header Authorization: Bearer ...' },
      { key: 'lookupUrlTemplate', label: 'Mẫu link tra cứu', type: 'text', placeholder: 'https://tracuu.example.com/{lookupCode}', help: 'Dùng {lookupCode}, {invoiceNo}, {serial}' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: true, xml: true, sync: true, testConnection: true, lookup: true },
  };

  private async call<T = Record<string, unknown>>(cfg: ProviderConfig, path: string, body: Record<string, unknown>, binary = false) {
    const raw = JSON.stringify({ ...body, environment: cfg.environment, sentAt: new Date().toISOString() });
    const ts = String(Date.now());
    const sig = createHmac('sha256', str(cfg.secret)).update(`${ts}.${raw}`).digest('hex');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-CMSNT-Signature': sig, 'X-CMSNT-Timestamp': ts };
    if (cfg.apiKey) headers.Authorization = `Bearer ${str(cfg.apiKey)}`;
    const res = await httpRequest<T>(joinUrl(str(cfg.baseUrl), path), { method: 'POST', headers, body: raw, binary, timeoutMs: 60_000 });
    assertOk(res, `Webhook ${path}`);
    return res;
  }

  private toIssueResult(data: Record<string, unknown>): IssueResult {
    const providerRef = str(data.providerRef ?? data.id);
    if (!providerRef) throw new EInvoiceProviderError('Dịch vụ trung gian không trả về providerRef', data);
    return {
      status: data.status === 'pending' ? 'pending' : 'issued',
      providerRef,
      invoiceNo: str(data.invoiceNo) || null,
      serial: str(data.serial) || null,
      templateCode: str(data.templateCode) || null,
      taxAuthorityCode: str(data.taxAuthorityCode) || null,
      lookupCode: str(data.lookupCode) || null,
      lookupUrl: str(data.lookupUrl) || null,
      pdfUrl: str(data.pdfUrl) || null,
      xmlUrl: str(data.xmlUrl) || null,
      issuedAt: data.issuedAt ? new Date(String(data.issuedAt)) : null,
      raw: data,
    };
  }

  async testConnection(cfg: ProviderConfig): Promise<TestConnectionResult> {
    const res = await this.call(cfg, 'ping', { action: 'ping' });
    return { ok: true, message: str(pick(res.data, 'message'), 'Kết nối thành công'), details: res.data as Record<string, unknown> };
  }

  async issue(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const res = await this.call(cfg, 'issue', { action: 'issue', invoice: payload });
    return this.toIssueResult(res.data);
  }

  async replace(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const res = await this.call(cfg, 'issue', { action: 'replace', invoice: payload });
    return this.toIssueResult(res.data);
  }

  async adjust(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    const res = await this.call(cfg, 'issue', { action: 'adjust', invoice: payload });
    return this.toIssueResult(res.data);
  }

  async cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult> {
    const res = await this.call(cfg, 'cancel', { action: 'cancel', ref, reason });
    return { ok: pick(res.data, 'ok') !== false, message: str(pick(res.data, 'message')) || null, raw: res.data };
  }

  async sync(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult> {
    const res = await this.call(cfg, 'status', { action: 'status', ref });
    const d = res.data;
    const allowed = ['pending', 'issued', 'cancelled', 'replaced', 'adjusted', 'rejected'];
    const s = str(d.status);
    return {
      status: (allowed.includes(s) ? s : 'unknown') as SyncResult['status'],
      invoiceNo: str(d.invoiceNo) || null,
      serial: str(d.serial) || null,
      templateCode: str(d.templateCode) || null,
      taxAuthorityCode: str(d.taxAuthorityCode) || null,
      lookupCode: str(d.lookupCode) || null,
      lookupUrl: str(d.lookupUrl) || null,
      issuedAt: d.issuedAt ? new Date(String(d.issuedAt)) : null,
      message: str(d.message) || null,
      raw: d,
    };
  }

  private async file(cfg: ProviderConfig, ref: InvoiceRef, path: 'pdf' | 'xml'): Promise<FileResult> {
    const res = await this.call<Record<string, unknown>>(cfg, path, { action: path, ref }, true);
    const ct = res.headers.get('content-type') ?? '';
    const buf = res.buffer ?? Buffer.alloc(0);
    if (ct.includes('json')) {
      // { base64: "..." }
      const json = JSON.parse(buf.toString('utf8')) as { base64?: string; fileName?: string };
      if (!json.base64) throw new EInvoiceProviderError('Dịch vụ trung gian không trả về file', json);
      return { buffer: Buffer.from(json.base64, 'base64'), mimeType: path === 'pdf' ? 'application/pdf' : 'application/xml', fileName: json.fileName };
    }
    return { buffer: buf, mimeType: path === 'pdf' ? 'application/pdf' : 'application/xml' };
  }

  getPdf(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'pdf');
  }

  getXml(cfg: ProviderConfig, ref: InvoiceRef) {
    return this.file(cfg, ref, 'xml');
  }

  lookupUrl(cfg: ProviderConfig, ref: InvoiceRef): string | null {
    const tpl = str(cfg.lookupUrlTemplate).trim();
    if (!tpl) return null;
    return tpl.replace('{lookupCode}', encodeURIComponent(str(ref.lookupCode))).replace('{invoiceNo}', encodeURIComponent(str(ref.invoiceNo))).replace('{serial}', encodeURIComponent(str(ref.serial)));
  }
}
