/**
 * Bản thể hiện hoá đơn dạng HTML (in / lưu PDF từ trình duyệt).
 * Dùng khi NCC không trả PDF (nhập tay, webhook chưa có file) hoặc để xem nhanh trong admin/tài khoản.
 * Lưu ý pháp lý: bản thể hiện chính thức là file của NCC/CQT; bản này ghi rõ "Bản thể hiện tham khảo" nếu chưa có PDF gốc.
 */
import type { EInvoice } from '../../generated/prisma/client.js';
import type { InvoiceBuyer, InvoiceLine, InvoiceSeller } from './providers/provider.interface.js';
import { summarize, vatRateCode } from './einvoice.calc.js';

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const KIND_LABEL: Record<string, string> = { ORIGINAL: 'HOÁ ĐƠN GIÁ TRỊ GIA TĂNG', REPLACEMENT: 'HOÁ ĐƠN GIÁ TRỊ GIA TĂNG (THAY THẾ)', ADJUSTMENT: 'HOÁ ĐƠN GIÁ TRỊ GIA TĂNG (ĐIỀU CHỈNH)' };
const STATUS_LABEL: Record<string, string> = { DRAFT: 'Nháp', QUEUED: 'Chờ phát hành', ISSUING: 'Đang phát hành', ISSUED: 'Đã phát hành', CANCELLED: 'ĐÃ HUỶ', REPLACED: 'Đã bị thay thế', ADJUSTED: 'Đã điều chỉnh', FAILED: 'Lỗi' };

function money(v: number, currency = 'VND') {
  const n = Number(v) || 0;
  return currency === 'VND' ? `${n.toLocaleString('vi-VN')}` : n.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function date(d: Date | string | null | undefined) {
  if (!d) return '';
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}

export interface PrintOptions {
  /** Tên website / shop (in ở chân trang) */
  siteName?: string;
  /** Tên nhà cung cấp HĐĐT */
  providerName?: string;
  /** Có PDF gốc của NCC hay không (để ghi chú "bản thể hiện tham khảo") */
  hasOfficialPdf?: boolean;
  original?: { invoiceNo?: string | null; serial?: string | null; templateCode?: string | null; issuedAt?: Date | null } | null;
}

/** Dựng HTML đầy đủ (self-contained, in được bằng Ctrl+P) */
export function renderInvoiceHtml(inv: EInvoice, opts: PrintOptions = {}): string {
  const seller = (inv.seller ?? {}) as unknown as InvoiceSeller;
  const buyer = (inv.buyer ?? {}) as unknown as InvoiceBuyer;
  const lines = (inv.items ?? []) as unknown as InvoiceLine[];
  const totals = summarize(lines, 0, inv.currency);
  const cancelled = inv.status === 'CANCELLED';
  const unofficial = !opts.hasOfficialPdf;
  const rows = lines
    .map(
      (l) => `<tr>
  <td class="c">${l.index}</td>
  <td>${esc(l.name)}${l.sku ? `<div class="muted">SKU: ${esc(l.sku)}</div>` : ''}${l.adjustment ? `<div class="muted">${l.adjustment === 'increase' ? 'Điều chỉnh tăng' : 'Điều chỉnh giảm'}</div>` : ''}</td>
  <td class="c">${esc(l.unit)}</td>
  <td class="r">${l.quantity}</td>
  <td class="r">${money(l.unitPrice, inv.currency)}</td>
  <td class="r">${l.discount ? money(l.discount, inv.currency) : ''}</td>
  <td class="r">${money(l.amount, inv.currency)}</td>
  <td class="c">${esc(vatRateCode(l.vatRate))}${l.vatRate >= 0 ? '%' : ''}</td>
  <td class="r">${money(l.vatAmount, inv.currency)}</td>
  <td class="r">${money(l.total, inv.currency)}</td>
</tr>`,
    )
    .join('');
  const breakdown = totals.breakdown.map((b) => `<tr><td>Thuế suất ${esc(vatRateCode(b.vatRate))}${b.vatRate >= 0 ? '%' : ''}</td><td class="r">${money(b.amount, inv.currency)}</td><td class="r">${money(b.vatAmount, inv.currency)}</td></tr>`).join('');
  const buyerName = buyer.anonymous ? 'Người mua không lấy hoá đơn' : buyer.legalName || buyer.name || '';
  const original = opts.original;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(KIND_LABEL[inv.kind] ?? 'Hoá đơn')} ${esc(inv.serial ?? '')} ${esc(inv.invoiceNo ?? '')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Times, serif; color: #111; margin: 0; background: #f3f4f6; }
  .page { position: relative; max-width: 860px; margin: 24px auto; background: #fff; padding: 36px 40px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { text-align: center; font-size: 22px; letter-spacing: .5px; margin: 0 0 4px; }
  .sub { text-align: center; font-style: italic; margin-bottom: 14px; }
  .meta { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; margin-bottom: 14px; }
  .meta div { line-height: 1.5; }
  .box { border: 1px solid #333; padding: 10px 14px; margin-bottom: 10px; font-size: 14px; line-height: 1.55; }
  .box b { display: inline-block; min-width: 150px; }
  table.items { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  table.items th, table.items td { border: 1px solid #333; padding: 6px 7px; vertical-align: top; }
  table.items th { background: #f0f0f0; font-weight: 600; text-align: center; }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; }
  .muted { color: #666; font-size: 11px; }
  .totals { display: flex; justify-content: space-between; gap: 24px; margin-top: 12px; font-size: 14px; }
  .totals table { border-collapse: collapse; }
  .totals td { padding: 3px 8px; }
  .totals .grand td { font-weight: 700; border-top: 1px solid #333; }
  .words { margin-top: 10px; font-size: 14px; font-style: italic; }
  .sign { display: flex; justify-content: space-around; margin-top: 30px; font-size: 14px; text-align: center; }
  .sign div { width: 45%; }
  .sign small { display: block; font-style: italic; color: #444; }
  .foot { margin-top: 22px; font-size: 12px; color: #555; text-align: center; border-top: 1px dashed #999; padding-top: 10px; }
  .stamp { position: absolute; top: 120px; right: 60px; transform: rotate(-18deg); border: 4px solid #c00; color: #c00; font-weight: 700; font-size: 34px; padding: 6px 18px; opacity: .55; letter-spacing: 2px; }
  .ref { position: absolute; top: 90px; right: 50px; font-size: 12px; color: #555; border: 1px dashed #999; padding: 4px 8px; text-align: center; }
  .toolbar { max-width: 860px; margin: 16px auto 0; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar button { font: inherit; padding: 8px 16px; border: 1px solid #333; background: #fff; cursor: pointer; border-radius: 6px; }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; max-width: none; padding: 10mm 12mm; } .toolbar { display: none; } @page { size: A4; margin: 10mm; } }
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">In / Lưu PDF</button></div>
<div class="page">
  ${cancelled ? '<div class="stamp">ĐÃ HUỶ</div>' : ''}
  ${unofficial && !cancelled ? '<div class="ref">Bản thể hiện tham khảo<br/>Bản gốc tra cứu tại cổng nhà cung cấp / CQT</div>' : ''}
  <h1>${esc(KIND_LABEL[inv.kind] ?? 'HOÁ ĐƠN')}</h1>
  <div class="sub">Ngày ${date(inv.issuedAt ?? inv.invoiceDate)}${inv.status !== 'ISSUED' && inv.status !== 'ADJUSTED' && inv.status !== 'REPLACED' ? ` · ${esc(STATUS_LABEL[inv.status] ?? inv.status)}` : ''}</div>
  <div class="meta">
    <div>Mẫu số: <b>${esc(inv.templateCode ?? '')}</b><br/>Ký hiệu: <b>${esc(inv.serial ?? '')}</b><br/>Số: <b>${esc(inv.invoiceNo ?? '(chưa cấp)')}</b></div>
    <div style="text-align:right">${inv.taxAuthorityCode ? `Mã CQT: <b>${esc(inv.taxAuthorityCode)}</b><br/>` : ''}${inv.lookupCode ? `Mã tra cứu: <b>${esc(inv.lookupCode)}</b><br/>` : ''}${inv.lookupUrl ? `Tra cứu: ${esc(inv.lookupUrl)}` : ''}</div>
  </div>
  <div class="box">
    <div><b>Đơn vị bán hàng:</b> ${esc(seller.name)}</div>
    <div><b>Mã số thuế:</b> ${esc(seller.taxCode)}</div>
    <div><b>Địa chỉ:</b> ${esc(seller.address)}</div>
    ${seller.phone || seller.email ? `<div><b>Điện thoại / Email:</b> ${esc([seller.phone, seller.email].filter(Boolean).join(' · '))}</div>` : ''}
    ${seller.bankAccount ? `<div><b>Số tài khoản:</b> ${esc(seller.bankAccount)}${seller.bankName ? ` — ${esc(seller.bankName)}` : ''}</div>` : ''}
  </div>
  <div class="box">
    <div><b>Họ tên người mua:</b> ${esc(buyer.anonymous ? '' : buyer.name)}</div>
    <div><b>Tên đơn vị:</b> ${esc(buyerName)}</div>
    <div><b>Mã số thuế:</b> ${esc(buyer.taxCode ?? '')}${buyer.idNumber ? ` &nbsp; <b style="min-width:auto">CCCD:</b> ${esc(buyer.idNumber)}` : ''}</div>
    <div><b>Địa chỉ:</b> ${esc(buyer.address ?? '')}</div>
    ${buyer.email || buyer.phone ? `<div><b>Email / Điện thoại:</b> ${esc([buyer.email, buyer.phone].filter(Boolean).join(' · '))}</div>` : ''}
    <div><b>Hình thức thanh toán:</b> ${esc(inv.paymentMethod ?? 'TM/CK')} &nbsp; <b style="min-width:auto">Đồng tiền:</b> ${esc(inv.currency)}</div>
    ${original ? `<div><b>Hoá đơn gốc:</b> Mẫu số ${esc(original.templateCode ?? '')}, ký hiệu ${esc(original.serial ?? '')}, số ${esc(original.invoiceNo ?? '')}, ngày ${date(original.issuedAt)}</div>` : ''}
    ${inv.reason ? `<div><b>Lý do:</b> ${esc(inv.reason)}</div>` : ''}
  </div>
  <table class="items">
    <thead><tr><th>STT</th><th>Tên hàng hoá, dịch vụ</th><th>ĐVT</th><th>Số lượng</th><th>Đơn giá</th><th>Chiết khấu</th><th>Thành tiền</th><th>Thuế suất</th><th>Tiền thuế</th><th>Tổng</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10" class="c">Không có dòng hàng</td></tr>'}</tbody>
  </table>
  <div class="totals">
    <table><thead><tr><th style="text-align:left">Tổng hợp theo thuế suất</th><th>Tiền hàng</th><th>Tiền thuế</th></tr></thead><tbody>${breakdown}</tbody></table>
    <table>
      <tr><td>Cộng tiền hàng (chưa thuế):</td><td class="r">${money(totals.subtotal, inv.currency)}</td></tr>
      <tr><td>Tiền thuế GTGT:</td><td class="r">${money(totals.vatTotal, inv.currency)}</td></tr>
      <tr class="grand"><td>Tổng tiền thanh toán:</td><td class="r">${money(totals.total, inv.currency)} ${inv.currency === 'VND' ? 'đ' : esc(inv.currency)}</td></tr>
    </table>
  </div>
  <div class="words">Số tiền viết bằng chữ: <b>${esc(totals.totalInWords)}</b></div>
  ${inv.note ? `<div class="words">Ghi chú: ${esc(inv.note)}</div>` : ''}
  ${cancelled ? `<div class="words">Đã huỷ ngày ${date(inv.cancelledAt)}${inv.cancelReason ? ` — lý do: ${esc(inv.cancelReason)}` : ''}</div>` : ''}
  <div class="sign">
    <div>NGƯỜI MUA HÀNG<small>(Ký, ghi rõ họ tên)</small></div>
    <div>NGƯỜI BÁN HÀNG<small>(Ký điện tử${opts.providerName ? ` qua ${esc(opts.providerName)}` : ''})</small></div>
  </div>
  <div class="foot">${unofficial ? 'Bản thể hiện tham khảo được tạo từ dữ liệu hệ thống; bản thể hiện chính thức do nhà cung cấp hoá đơn điện tử / cơ quan thuế cung cấp. ' : ''}${opts.siteName ? esc(opts.siteName) + ' · ' : ''}Tạo lúc ${new Date().toLocaleString('vi-VN')}</div>
</div>
</body>
</html>`;
}
