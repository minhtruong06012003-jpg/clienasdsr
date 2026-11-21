'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, KeyRound, PackageOpen, Upload } from 'lucide-react';
import type { DigitalStockRow } from '@cmsnt/shared';
import { ImportCodesDialog } from '@/components/digital-codes/import-dialog';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { NumberInput } from './number-input';
import { CodeFieldsEditor, type CodeFieldForm } from './code-fields-editor';
import { PurchaseFieldsEditor, type PurchaseFieldForm } from './purchase-fields-editor';

/** Phần cấu hình giao hàng số trong form sản phẩm */
export interface DigitalFormPart {
  isVirtual: boolean;
  codeDelivery: boolean;
  codeFields: CodeFieldForm[];
  codeWarrantyDays: number | null;
  purchaseFields: PurchaseFieldForm[];
}

/**
 * Tab "Giao hàng số" của trang sửa sản phẩm (mọi loại sản phẩm):
 * - Sản phẩm ảo: không cần địa chỉ / phí vận chuyển.
 * - Bán theo kho mã: tồn kho = số mã còn trong kho; thống kê kho, nhập mã, nhãn các phần của mã, bảo hành, hướng dẫn gửi kèm.
 * - Thông tin khách cần nhập khi mua (ID game, email cần nâng cấp...).
 */
export function DigitalDeliveryPanel({
  productId,
  productType,
  value,
  onChange,
  deliveryNote,
  onDeliveryNoteChange,
  localeName,
  codeStats,
  onCodesImported,
}: {
  /** null = sản phẩm chưa lưu (chưa nhập mã được) */
  productId: string | null;
  productType: 'SIMPLE' | 'VARIABLE' | 'DIGITAL';
  value: DigitalFormPart;
  onChange: (patch: Partial<DigitalFormPart>) => void;
  /** undefined = ngôn ngữ đang chọn chưa có bản dịch */
  deliveryNote: string | null | undefined;
  onDeliveryNoteChange: (v: string) => void;
  /** tên ngôn ngữ đang sửa (hiện cạnh ô hướng dẫn) */
  localeName?: string;
  codeStats?: DigitalStockRow[];
  /** gọi sau khi nhập mã xong để tải lại thống kê + tồn kho */
  onCodesImported?: () => void;
}) {
  const { can } = useAuth();
  const [importing, setImporting] = useState<{ variantId?: string } | null>(null);
  const virtualByType = productType === 'DIGITAL';
  const stats = codeStats ?? [];
  const total = stats.reduce((s, r) => ({ available: s.available + r.available, reserved: s.reserved + r.reserved, sold: s.sold + r.sold }), { available: 0, reserved: 0, sold: 0 });
  const canManage = can('digital_codes.manage');

  return (
    <div className="space-y-4">
      {/* Sản phẩm ảo: ẩn tab vận chuyển, giỏ toàn hàng ảo không cần địa chỉ */}
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <div>
          <Label>Sản phẩm ảo — không cần giao hàng</Label>
          <p className="text-xs text-muted-foreground">
            {virtualByType ? 'Sản phẩm số luôn là hàng ảo.' : 'Dịch vụ, nạp game, nâng cấp tài khoản... Đơn chỉ gồm hàng ảo không cần địa chỉ và không tính phí vận chuyển.'}
            {value.codeDelivery && !virtualByType && ' Sản phẩm bán theo kho mã luôn được coi là hàng ảo.'}
          </p>
        </div>
        <Switch checked={virtualByType || value.codeDelivery || value.isVirtual} disabled={virtualByType || value.codeDelivery} onCheckedChange={(isVirtual) => onChange({ isVirtual })} />
      </div>

      {/* Bán theo kho mã: tồn kho tự tính theo số mã còn lại */}
      <div className={cn('rounded-lg border p-3', value.codeDelivery && 'border-primary/30 bg-primary/5')}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="flex items-center gap-1.5">
              <KeyRound className="size-4 text-primary" /> Bán theo kho mã (key / tài khoản / thẻ)
            </Label>
            <p className="text-xs text-muted-foreground">Mỗi đơn được cấp tự động mã từ kho khi thanh toán. Tồn kho tự tính bằng số mã còn trong kho (theo từng biến thể) — không sửa tay.</p>
          </div>
          <Switch checked={value.codeDelivery} onCheckedChange={(codeDelivery) => onChange({ codeDelivery })} />
        </div>

        {value.codeDelivery && (
          <div className="mt-4 space-y-4">
            {/* Thống kê kho mã theo biến thể (API trả codeStats khi codeDelivery) */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold">Kho mã</h4>
                {stats.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {total.available} còn · {total.reserved} đang giữ · {total.sold} đã giao
                  </span>
                )}
                <div className="ml-auto flex flex-wrap gap-2">
                  {productId && can('digital_codes.read') && (
                    <Button type="button" variant="ghost" size="sm" asChild>
                      <Link href={`/digital-codes?productId=${productId}`} target="_blank">
                        <ExternalLink /> Mở kho mã
                      </Link>
                    </Button>
                  )}
                  {canManage && (
                    <Button type="button" size="sm" onClick={() => setImporting({})} disabled={!productId}>
                      <Upload /> Nhập mã
                    </Button>
                  )}
                </div>
              </div>
              {!productId ? (
                <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">Lưu sản phẩm (nháp) trước rồi mới nhập mã vào kho.</p>
              ) : stats.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  <PackageOpen className="size-4 shrink-0" /> Chưa có thống kê kho — lưu sản phẩm sau khi bật “Bán theo kho mã” rồi nhập mã.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">{productType === 'VARIABLE' ? 'Biến thể' : 'Sản phẩm'}</th>
                        <th className="px-2 py-2 text-right font-medium">Còn</th>
                        <th className="px-2 py-2 text-right font-medium">Đang giữ</th>
                        <th className="px-2 py-2 text-right font-medium">Đã giao</th>
                        <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">Khoá / thu hồi</th>
                        <th className="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((r) => (
                        <tr key={r.variantId ?? 'product'} className="border-t">
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.variantLabel || r.productName}</div>
                            <div className="flex flex-wrap gap-1">
                              {r.lowStock && <Badge variant="outline" className="h-4 border-amber-300 px-1 text-[10px] text-amber-700 dark:border-amber-800 dark:text-amber-300">Sắp hết</Badge>}
                              {r.expiringSoon > 0 && <span className="text-[11px] text-amber-600 dark:text-amber-400">{r.expiringSoon} sắp hết hạn</span>}
                              {r.expired > 0 && <span className="text-[11px] text-destructive">{r.expired} đã hết hạn</span>}
                            </div>
                          </td>
                          <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', r.available === 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>{r.available}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{r.reserved}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{r.sold}</td>
                          <td className="hidden px-2 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                            {r.disabled} / {r.revoked}
                          </td>
                          <td className="px-1 py-1 text-right">
                            {canManage && (
                              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setImporting({ variantId: r.variantId ?? undefined })} aria-label="Nhập mã cho dòng này" title="Nhập mã">
                                <Upload />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {stats.some((r) => r.available === 0) && (
                <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" /> Dòng hết mã sẽ hiện “Hết hàng” trên website (trừ khi cho phép đặt trước ở tab Kho hàng).
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Các phần của mã</h4>
              <p className="text-xs text-muted-foreground">Đặt nhãn cho từng phần khi một mã gồm nhiều thông tin (tài khoản, mật khẩu, 2FA...). Khách thấy từng phần có nhãn và nút sao chép.</p>
              <CodeFieldsEditor value={value.codeFields} onChange={(codeFields) => onChange({ codeFields })} />
            </div>

            <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
              <Field label="Bảo hành" help="Trong thời gian này khách được bấm “Báo lỗi” để yêu cầu đổi mã. Để trống = không bảo hành.">
                <NumberInput value={value.codeWarrantyDays} onChange={(v) => onChange({ codeWarrantyDays: v == null ? null : Math.max(0, Math.floor(v)) })} integer min={0} suffix="ngày" placeholder="Không" />
              </Field>
              <Field label={`Hướng dẫn sử dụng gửi kèm${localeName ? ` · ${localeName}` : ''}`} help="Hiện cạnh mã ở trang đơn hàng và trong email giao mã (vd: cách đăng nhập, cách kích hoạt key).">
                {deliveryNote === undefined ? (
                  <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">Ngôn ngữ này chưa có bản dịch — tạo bản dịch ở phần nội dung trước.</p>
                ) : (
                  <Textarea value={deliveryNote ?? ''} onChange={(e) => onDeliveryNoteChange(e.target.value)} rows={4} placeholder="Vd: Đăng nhập tại ..., không đổi mật khẩu trong 24 giờ đầu." />
                )}
              </Field>
            </div>
          </div>
        )}
      </div>

      {/* Thông tin khách nhập khi mua: áp dụng cho mọi loại sản phẩm */}
      <div className="space-y-2">
        <div>
          <h4 className="text-sm font-semibold">Thông tin khách cần nhập khi mua</h4>
          <p className="text-xs text-muted-foreground">Hiện ở trang sản phẩm trước khi thêm vào giỏ; giá trị được lưu theo từng dòng đơn để bạn xử lý (nạp game, nâng cấp tài khoản...).</p>
        </div>
        <PurchaseFieldsEditor value={value.purchaseFields} onChange={(purchaseFields) => onChange({ purchaseFields })} />
      </div>

      {productId && importing && (
        <ImportCodesDialog
          open
          onOpenChange={(o) => !o && setImporting(null)}
          productId={productId}
          variantId={importing.variantId}
          onDone={() => onCodesImported?.()}
        />
      )}
    </div>
  );
}
