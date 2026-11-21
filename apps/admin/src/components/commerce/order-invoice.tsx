'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDate, formatMoney, i18n } from '@/lib/format';
import { formatAddress, PAYMENT_METHODS, PAYMENT_STATUSES, toNum, type Address } from './utils';

export interface InvoiceOrder {
  code: string;
  createdAt: string;
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  shippingAddress: Address | null;
  note: string | null;
  couponCode: string | null;
  subtotal: unknown;
  discountTotal: unknown;
  shippingTotal: unknown;
  taxTotal: unknown;
  total: unknown;
  items: { id: string; name: string; sku: string | null; optionValues: Record<string, string> | null; price: unknown; quantity: number; total: unknown }[];
}

export interface StoreInfo {
  siteName?: Record<string, string> | string;
  companyName?: string;
  email?: string;
  phone?: string;
  hotline?: string;
  address?: Record<string, string> | string;
  taxCode?: string;
  pricesIncludeTax?: boolean;
}

const PRINT_CSS = `
#order-invoice { display: none; }
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { background: #fff !important; }
  body > *:not(#order-invoice) { display: none !important; }
  #order-invoice { display: block !important; }
}
`;

/** Hoá đơn in (render vào body, chỉ hiện khi window.print) */
export function OrderInvoice({ order, store }: { order: InvoiceOrder; store: StoreInfo }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const money = (v: unknown) => formatMoney(toNum(v), order.currency);
  const a = order.shippingAddress;
  const storeName = store.companyName || i18n(store.siteName ?? '', 'vi');
  const storeAddress = i18n(store.address ?? '', 'vi');

  return createPortal(
    <div id="order-invoice" style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#111', fontSize: 12, lineHeight: 1.5 }}>
      <style>{PRINT_CSS}</style>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: 'top' }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{storeName}</div>
              {storeAddress && <div>{storeAddress}</div>}
              {(store.hotline || store.phone) && <div>ĐT: {store.hotline || store.phone}</div>}
              {store.email && <div>Email: {store.email}</div>}
              {store.taxCode && <div>MST: {store.taxCode}</div>}
            </td>
            <td style={{ verticalAlign: 'top', textAlign: 'right' }}>
              <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>HOÁ ĐƠN BÁN HÀNG</div>
              <div>
                Mã đơn: <b>#{order.code}</b>
              </div>
              <div>Ngày đặt: {formatDate(order.createdAt)}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: 'top', width: '50%', paddingRight: 12 }}>
              <div style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, color: '#555', marginBottom: 4 }}>Khách hàng</div>
              <div style={{ fontWeight: 600 }}>{order.customerName}</div>
              <div>{order.customerPhone}</div>
              {order.customerEmail && <div>{order.customerEmail}</div>}
            </td>
            <td style={{ verticalAlign: 'top', width: '50%' }}>
              <div style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, color: '#555', marginBottom: 4 }}>Giao đến</div>
              <div style={{ fontWeight: 600 }}>
                {a?.fullName || order.customerName} {a?.phone ? `· ${a.phone}` : ''}
              </div>
              <div>{formatAddress(a)}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f3f4f6' }}>
            {['#', 'Sản phẩm', 'SKU', 'Đơn giá', 'SL', 'Thành tiền'].map((h, i) => (
              <th key={h} style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: i >= 3 ? 'right' : 'left', fontSize: 11 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.items.map((it, i) => (
            <tr key={it.id}>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px' }}>{i + 1}</td>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px' }}>
                {it.name}
                {it.optionValues && Object.keys(it.optionValues).length > 0 && <div style={{ color: '#666', fontSize: 11 }}>{Object.values(it.optionValues).join(' / ')}</div>}
              </td>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px' }}>{it.sku ?? ''}</td>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right' }}>{money(it.price)}</td>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right' }}>{it.quantity}</td>
              <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right' }}>{money(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table style={{ width: '45%', marginLeft: 'auto', marginTop: 12, borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td style={{ padding: '3px 0' }}>Tạm tính</td>
            <td style={{ textAlign: 'right' }}>{money(order.subtotal)}</td>
          </tr>
          {toNum(order.discountTotal) > 0 && (
            <tr>
              <td style={{ padding: '3px 0' }}>Giảm giá{order.couponCode ? ` (${order.couponCode})` : ''}</td>
              <td style={{ textAlign: 'right' }}>-{money(order.discountTotal)}</td>
            </tr>
          )}
          <tr>
            <td style={{ padding: '3px 0' }}>Phí vận chuyển</td>
            <td style={{ textAlign: 'right' }}>{toNum(order.shippingTotal) > 0 ? money(order.shippingTotal) : 'Miễn phí'}</td>
          </tr>
          {toNum(order.taxTotal) > 0 && (
            <tr>
              <td style={{ padding: '3px 0' }}>Thuế{store.pricesIncludeTax ? ' (đã gồm)' : ''}</td>
              <td style={{ textAlign: 'right' }}>{money(order.taxTotal)}</td>
            </tr>
          )}
          <tr>
            <td style={{ padding: '6px 0', borderTop: '2px solid #111', fontWeight: 700, fontSize: 14 }}>Tổng cộng</td>
            <td style={{ padding: '6px 0', borderTop: '2px solid #111', fontWeight: 700, fontSize: 14, textAlign: 'right' }}>{money(order.total)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 16 }}>
        Phương thức thanh toán: <b>{PAYMENT_METHODS[order.paymentMethod] ?? order.paymentMethod}</b> · {PAYMENT_STATUSES.find((s) => s.value === order.paymentStatus)?.label ?? order.paymentStatus}
      </div>
      {order.note && <div style={{ marginTop: 6 }}>Ghi chú: {order.note}</div>}
      <div style={{ marginTop: 32, textAlign: 'center', color: '#555' }}>Cảm ơn quý khách đã mua hàng!</div>
    </div>,
    document.body,
  );
}
