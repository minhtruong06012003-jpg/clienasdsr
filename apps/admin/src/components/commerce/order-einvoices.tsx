'use client';

/**
 * Section "Hoá đơn điện tử" trong trang chi tiết đơn hàng:
 * yêu cầu xuất hoá đơn của khách, danh sách hoá đơn đã lập (số, trạng thái, PDF) và nút lập hoá đơn.
 */

import Link from 'next/link';
import { FileDown, FileText, Plus, ReceiptText } from 'lucide-react';
import { Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { ACTIVE_STATUSES, EInvoiceKindBadge, EInvoiceStatusBadge, invoiceNumber, openEInvoicePdf, type InvoiceRequest, type OrderEInvoice } from './einvoice';
import { toNum } from './utils';

export function OrderEInvoicesSection({ orderId, currency, invoiceRequest, eInvoices }: { orderId: string; currency: string; invoiceRequest: InvoiceRequest | null | undefined; eInvoices: OrderEInvoice[] | undefined }) {
  const { can } = useAuth();
  const canRead = can('einvoice.read');
  const canWrite = can('einvoice.write');
  if (!canRead) return null;
  const list = eInvoices ?? [];
  // đã có hoá đơn còn hiệu lực (nháp/chờ/đã phát hành) thì không lập thêm hoá đơn gốc
  const hasActive = list.some((e) => ACTIVE_STATUSES.includes(e.status));
  const req = invoiceRequest?.requested ? invoiceRequest : null;

  return (
    <Section
      title="Hoá đơn điện tử"
      actions={
        canWrite &&
        !hasActive && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/orders/einvoices/new?orderId=${orderId}`}>
              <Plus /> Lập hoá đơn
            </Link>
          </Button>
        )
      }
    >
      {req && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs dark:border-sky-900 dark:bg-sky-950/30">
          <p className="mb-1 flex items-center gap-1 font-medium text-sky-800 dark:text-sky-300">
            <ReceiptText className="size-3.5" /> Khách yêu cầu xuất hoá đơn ({req.type === 'company' ? 'công ty' : 'cá nhân'})
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-foreground">
            {req.name && (
              <>
                <dt className="text-muted-foreground">Tên</dt>
                <dd className="break-words">{req.name}</dd>
              </>
            )}
            {req.taxCode && (
              <>
                <dt className="text-muted-foreground">MST</dt>
                <dd className="font-mono">{req.taxCode}</dd>
              </>
            )}
            {req.idNumber && (
              <>
                <dt className="text-muted-foreground">CCCD</dt>
                <dd className="font-mono">{req.idNumber}</dd>
              </>
            )}
            {req.address && (
              <>
                <dt className="text-muted-foreground">Địa chỉ</dt>
                <dd className="break-words">{req.address}</dd>
              </>
            )}
            {req.email && (
              <>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="break-all">{req.email}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {list.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="size-4" /> Chưa lập hoá đơn điện tử cho đơn này.
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {list.map((e) => {
            const no = invoiceNumber(e);
            const canPdf = !!e.pdfPath && e.provider !== 'manual';
            return (
              <li key={e.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/orders/einvoices/${e.id}`} className={no ? 'font-mono font-semibold hover:text-primary' : 'text-muted-foreground hover:text-primary'}>
                      {no ?? 'Chưa có số'}
                    </Link>
                    <EInvoiceKindBadge kind={e.kind} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <EInvoiceStatusBadge status={e.status} className="text-[10px]" />
                    <span className="tabular-nums">{formatMoney(toNum(e.total), currency)}</span>
                    {e.issuedAt && <span>· {formatDate(e.issuedAt, 'dd/MM/yyyy')}</span>}
                  </div>
                  {e.status === 'FAILED' && e.errorMessage && <p className="mt-0.5 line-clamp-2 text-xs text-red-600 dark:text-red-400">{e.errorMessage}</p>}
                </div>
                {canPdf && (
                  <Button variant="ghost" size="icon-xs" title="Xem PDF" onClick={() => void openEInvoicePdf(e.id)}>
                    <FileDown />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
