import type { CancelResult, EInvoiceProvider, InvoicePayload, InvoiceRef, IssueResult, ProviderConfig, ProviderMeta, TestConnectionResult } from './provider.interface.js';

/**
 * Nhà cung cấp "Nhập tay": không gọi API nào.
 * Dùng khi doanh nghiệp phát hành hoá đơn trên phần mềm của NCC (hoặc cổng CQT) rồi nhập lại số HĐ / mã CQT / link tra cứu vào hệ thống
 * để khách xem được trên tài khoản và admin theo dõi được đơn nào đã có hoá đơn.
 * `issue()` chỉ đánh dấu hoá đơn ở trạng thái chờ (pending) — admin điền số HĐ qua API `PUT /admin/einvoices/:id/manual`.
 */
export class ManualProvider implements EInvoiceProvider {
  readonly meta: ProviderMeta = {
    key: 'manual',
    name: 'Nhập tay (phát hành ngoài hệ thống)',
    description: 'Không kết nối API. Bạn phát hành trên phần mềm của nhà cung cấp rồi nhập số hoá đơn, mã CQT và link tra cứu vào đây.',
    signing: 'none',
    fields: [
      { key: 'lookupBaseUrl', label: 'Trang tra cứu hoá đơn', type: 'url', placeholder: 'https://tracuuhoadon.gdt.gov.vn', help: 'Link gửi cho khách để tra cứu (có thể để trống)' },
    ],
    capabilities: { cancel: true, replace: true, adjust: true, pdf: false, xml: false, sync: false, testConnection: false, lookup: true },
    notes: ['Hệ thống chỉ lưu thông tin bạn nhập; không có PDF/XML tự động.'],
  };

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'Chế độ nhập tay không cần kết nối.' };
  }

  async issue(_cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult> {
    // chờ admin nhập số hoá đơn — trạng thái pending
    return { status: 'pending', providerRef: `manual:${payload.id}`, raw: { manual: true } };
  }

  async cancel(): Promise<CancelResult> {
    return { ok: true, message: 'Đã đánh dấu huỷ trong hệ thống (nhớ huỷ trên phần mềm NCC).' };
  }

  async replace(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.issue(cfg, payload);
  }

  async adjust(cfg: ProviderConfig, payload: InvoicePayload) {
    return this.issue(cfg, payload);
  }

  lookupUrl(cfg: ProviderConfig, ref: InvoiceRef): string | null {
    const base = String(cfg.lookupBaseUrl ?? '').trim();
    if (!base) return null;
    return ref.lookupCode ? `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(ref.lookupCode)}` : base;
  }
}
