'use client';

/**
 * Dialog "Nhập mã" vào kho: chọn sản phẩm (+ biến thể), dán mã (mỗi dòng 1 mã) hoặc chọn file .txt/.csv
 * (đọc ngay trên trình duyệt), đặt lô / giá vốn / hạn dùng / ghi chú rồi gửi POST admin/digital-codes/import.
 * Dùng ở trang Kho mã số và tab "Kho mã" trong trang sửa sản phẩm (truyền sẵn productId / variantId).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileUp, Loader2, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { t as tr, type DigitalImportResult, type I18nText } from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import { DIGITAL_QK, invalidateDigital, type DigitalProductOption } from './shared';

/** Giới hạn của API cho một lần nhập */
const MAX_CODES = 10_000;
const MAX_LEN = 2000;
/** Giới hạn kích thước (file và payload JSON gửi đi) — API nhận body tối đa ~10MB nên chừa biên an toàn */
const MAX_BYTES = 9 * 1024 * 1024;
const TOO_BIG_MSG = 'File quá lớn, hãy chia nhỏ (tối đa ~9MB / lần)';

/**
 * Giải mã nội dung file theo BOM: EF BB BF (UTF-8), FF FE (UTF-16 LE), FE FF (UTF-16 BE); không có BOM -> UTF-8.
 * Trả null khi nội dung có ký tự NUL hoặc ký tự thay thế (U+FFFD) — dấu hiệu file sai mã hoá (vd UTF-16 không BOM, ANSI).
 */
function decodeText(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf);
  let encoding = 'utf-8';
  let offset = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) offset = 3;
  else if (b[0] === 0xff && b[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (b[0] === 0xfe && b[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  }
  const text = new TextDecoder(encoding).decode(b.subarray(offset));
  if (text.includes('\u0000') || text.includes('\uFFFD')) return null;
  return text;
}

/** Sản phẩm (admin product GET) — chỉ lấy phần cần để dựng lựa chọn khi đã biết productId */
interface ProductLite {
  id: string;
  type: string;
  sku: string | null;
  codeDelivery?: boolean;
  translations: { locale: string; name: string }[];
  /** các tuỳ chọn (Màu, Size...) để dựng nhãn biến thể theo tiếng Việt */
  options?: { key: string; name: I18nText; values: { value: string; label: I18nText }[] }[] | null;
  variants: { id: string; sku: string | null; isActive?: boolean; optionValues: Record<string, string> | null }[];
}

/** Tách 1 dòng CSV thành các cột (hỗ trợ "..." và "" bên trong) */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Tên lô mặc định theo thời điểm mở dialog */
const defaultBatch = () => `Lô ${formatDate(new Date(), 'dd/MM/yyyy HH:mm')}`;

export function ImportCodesDialog({ open, onOpenChange, productId, variantId, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; productId?: string; variantId?: string | null; onDone?: (result: DigitalImportResult) => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<DigitalProductOption | null>(null);
  const [variant, setVariant] = useState<string>('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 300);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  // file CSV: bỏ dòng đầu (tiêu đề cột) — chỉ hiện tuỳ chọn khi vừa chọn file .csv
  const [csvRows, setCsvRows] = useState<string[] | null>(null);
  const [skipHeader, setSkipHeader] = useState(false);
  const [batch, setBatch] = useState(defaultBatch);
  const [costPrice, setCostPrice] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<DigitalImportResult | null>(null);

  // mỗi lần mở: đặt lại form, giữ sản phẩm / biến thể được truyền vào
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setVariant(variantId ?? '');
    setSearch('');
    setText('');
    setFileName(null);
    setCsvRows(null);
    setSkipHeader(false);
    setBatch(defaultBatch());
    setCostPrice('');
    setExpiresAt('');
    setNote('');
    setResult(null);
  }, [open, productId, variantId]);

  // danh sách sản phẩm để chọn (khi chưa truyền productId)
  const products = useQuery({
    queryKey: [DIGITAL_QK, 'products', q],
    queryFn: () => api.get<DigitalProductOption[]>('/admin/digital-codes/products', { search: q || undefined }),
    enabled: open && !productId,
  });
  // đã biết productId -> lấy tên + biến thể từ API sản phẩm admin
  const fixed = useQuery({
    queryKey: [DIGITAL_QK, 'product-lite', productId],
    queryFn: () => api.get<ProductLite>(`/admin/products/${productId}`),
    enabled: open && !!productId,
  });
  const fixedProduct: DigitalProductOption | null = useMemo(() => {
    const p = fixed.data;
    if (!p) return null;
    const name = p.translations.find((t) => t.locale === 'vi')?.name ?? p.translations[0]?.name ?? 'Sản phẩm';
    return {
      id: p.id,
      name,
      sku: p.sku,
      type: p.type,
      codeDelivery: !!p.codeDelivery,
      // chỉ biến thể đang bật; nhãn = "Tên tuỳ chọn: Nhãn giá trị" theo tiếng Việt (fallback key / value thô)
      variants: (p.variants ?? [])
        .filter((v) => v.isActive !== false)
        .map((v) => {
          const label = Object.entries(v.optionValues ?? {})
            .map(([k, x]) => {
              const opt = p.options?.find((o) => o.key === k);
              const val = opt?.values.find((ov) => ov.value === x);
              return `${(opt && tr(opt.name, 'vi')) || k}: ${(val && tr(val.label, 'vi')) || x}`;
            })
            .join(' / ');
          return { id: v.id, sku: v.sku, label: label || v.sku || v.id.slice(0, 8) };
        }),
    };
  }, [fixed.data]);

  const product = productId ? fixedProduct : picked;
  const needVariant = !!product && product.type === 'VARIABLE' && product.variants.length > 0;

  // các dòng mã hợp lệ (bỏ dòng trống) để đếm trước khi gửi
  const lines = useMemo(() => text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean), [text]);
  const tooLong = lines.filter((l) => l.length > MAX_LEN).length;

  /** Đọc file .txt / .csv ngay trên trình duyệt (nhận BOM UTF-8/UTF-16); CSV: các cột nối bằng "|" */
  const readFile = async (file: File) => {
    if (file.size > MAX_BYTES) return toast.error(TOO_BIG_MSG);
    const raw = decodeText(await file.arrayBuffer());
    if (raw === null) return toast.error('File không đúng mã hoá, hãy lưu dạng UTF-8');
    const isCsv = /\.csv$/i.test(file.name);
    const rows = raw.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    const out = isCsv ? rows.map((l) => parseCsvLine(l).filter((c, i, arr) => c !== '' || i < arr.length - 1).join('|')) : rows;
    // giữ lại các dòng CSV để bật/tắt "Bỏ dòng đầu" mà không phải đọc lại file
    setCsvRows(isCsv ? out : null);
    setSkipHeader(false);
    setText(out.join('\n'));
    setFileName(file.name);
  };

  /** Bật/tắt bỏ dòng tiêu đề của file CSV vừa đọc */
  const toggleSkipHeader = (on: boolean) => {
    setSkipHeader(on);
    if (csvRows) setText((on ? csvRows.slice(1) : csvRows).join('\n'));
  };

  const submit = useMutation({
    mutationFn: () =>
      api.post<DigitalImportResult>('/admin/digital-codes/import', {
        productId: product!.id,
        variantId: needVariant ? variant || null : null,
        codes: lines,
        batch: batch.trim() || undefined,
        costPrice: costPrice.trim() === '' ? null : Number(costPrice),
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
        note: note.trim() || undefined,
      }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Đã nhập ${r.created.toLocaleString('vi-VN')} mã`);
      invalidateDigital(qc);
      void qc.invalidateQueries({ queryKey: ['product', product?.id] });
      onDone?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onSubmit = () => {
    // chặn bấm/nhấn Enter nhiều lần khi đang gửi
    if (submit.isPending) return;
    if (!product) return toast.error('Vui lòng chọn sản phẩm');
    if (needVariant && !variant) return toast.error('Sản phẩm có biến thể: vui lòng chọn biến thể');
    if (!lines.length) return toast.error('Chưa có mã nào để nhập');
    if (lines.length > MAX_CODES) return toast.error(`Tối đa ${MAX_CODES.toLocaleString('vi-VN')} mã mỗi lần, hãy chia nhỏ file`);
    if (tooLong) return toast.error(`Có ${tooLong} dòng dài quá ${MAX_LEN} ký tự`);
    if (costPrice.trim() && !(Number(costPrice) >= 0)) return toast.error('Giá vốn không hợp lệ');
    // ước lượng kích thước payload (UTF-8) để không vượt giới hạn body của API
    if (new TextEncoder().encode(JSON.stringify(lines)).length > MAX_BYTES) return toast.error(TOO_BIG_MSG);
    submit.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nhập mã vào kho</DialogTitle>
          <DialogDescription>Mỗi dòng một mã. Mã gồm nhiều phần (tài khoản, mật khẩu...) thì cách nhau bằng dấu “|”. Mã trùng với kho sẽ tự bỏ qua.</DialogDescription>
        </DialogHeader>

        {result ? (
          // khối kết quả sau khi nhập
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
              <CheckCircle2 className="size-6 shrink-0" />
              <div>
                <p className="font-semibold">Đã nhập {result.created.toLocaleString('vi-VN')} mã vào kho</p>
                <p className="text-xs opacity-90">
                  {product?.name}
                  {needVariant && variant ? ` · ${product?.variants.find((v) => v.id === variant)?.label ?? ''}` : ''}
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                { label: 'Đã thêm', value: result.created },
                { label: 'Trùng (bỏ qua)', value: result.duplicates },
                { label: 'Không hợp lệ', value: result.invalid },
                { label: 'Đơn được giao bù', value: result.fulfilledOrders },
              ].map((x) => (
                <div key={x.label} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{x.label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{x.value.toLocaleString('vi-VN')}</dd>
                </div>
              ))}
            </dl>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setText('');
                  setFileName(null);
                  setCsvRows(null);
                  setSkipHeader(false);
                  setBatch(defaultBatch());
                }}
              >
                Nhập tiếp
              </Button>
              <Button onClick={() => onOpenChange(false)}>Xong</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {/* Chọn sản phẩm */}
            <Field label="Sản phẩm" required>
              {productId ? (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                  {fixed.isLoading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <span className="font-medium">{fixedProduct?.name ?? 'Không tải được sản phẩm'}</span>}
                  {fixedProduct?.sku && <span className="font-mono text-xs text-muted-foreground">{fixedProduct.sku}</span>}
                </div>
              ) : picked ? (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{picked.name}</span>
                  {picked.sku && <span className="font-mono text-xs text-muted-foreground">{picked.sku}</span>}
                  {!picked.codeDelivery && <Badge variant="outline">Sẽ bật bán theo kho mã</Badge>}
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => setPicked(null)} aria-label="Chọn sản phẩm khác">
                    <X />
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm tên sản phẩm, SKU..." className="pl-8" autoFocus />
                  </div>
                  <div className="max-h-48 divide-y overflow-y-auto rounded-lg border">
                    {products.isLoading ? (
                      <div className="flex h-16 items-center justify-center">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : !products.data?.length ? (
                      <p className="p-4 text-center text-sm text-muted-foreground">Không tìm thấy sản phẩm</p>
                    ) : (
                      products.data.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-muted/60"
                          onClick={() => {
                            setPicked(p);
                            setVariant('');
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {p.sku && <span className="font-mono text-xs text-muted-foreground">{p.sku}</span>}
                          {p.variants.length > 0 && <Badge variant="secondary">{p.variants.length} biến thể</Badge>}
                          {p.codeDelivery && <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Kho mã</Badge>}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </Field>

            {needVariant && (
              <Field label="Biến thể" required>
                <Select value={variant} onValueChange={setVariant}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Chọn biến thể" />
                  </SelectTrigger>
                  <SelectContent>
                    {product.variants.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.label}
                        {v.sku ? ` (${v.sku})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {/* Nội dung mã */}
            <Field
              label="Danh sách mã"
              required
              action={
                <div className="flex items-center gap-2">
                  {fileName && (
                    <span className="max-w-40 truncate text-xs text-muted-foreground" title={fileName}>
                      {fileName}
                    </span>
                  )}
                  <Button type="button" size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                    <FileUp /> Chọn file .txt / .csv
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".txt,.csv,text/plain,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void readFile(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              }
              help={
                <span className={cn(lines.length > MAX_CODES && 'text-destructive')}>
                  {lines.length.toLocaleString('vi-VN')} mã
                  {tooLong > 0 && <span className="text-destructive"> · {tooLong} dòng quá {MAX_LEN} ký tự</span>}
                  {' · '}Gợi ý định dạng: <span className="font-mono">tài khoản|mật khẩu|ghi chú</span>. File CSV: các cột được nối bằng “|”.
                </span>
              }
            >
              {csvRows && (
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <Checkbox checked={skipHeader} onCheckedChange={(v) => toggleSkipHeader(v === true)} />
                  Bỏ dòng đầu (tiêu đề)
                </label>
              )}
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="max-h-72 font-mono text-xs" placeholder={'ABCD-EFGH-IJKL\nuser01@mail.com|matkhau123|2FA: 123456'} spellCheck={false} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Lô" help="Để lọc / quản lý theo đợt nhập">
                <Input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={100} />
              </Field>
              <Field label="Giá vốn / mã" help="Không bắt buộc">
                <Input type="number" min={0} step="any" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} placeholder="0" />
              </Field>
              <Field label="Hạn dùng" help="Hết hạn sẽ không bán">
                <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </Field>
            </div>
            <Field label="Ghi chú">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Vd: Nhập từ nhà cung cấp A" />
            </Field>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Huỷ
              </Button>
              <Button type="submit" disabled={submit.isPending || !lines.length || !product}>
                {submit.isPending && <Loader2 className="animate-spin" />} Nhập {lines.length ? lines.length.toLocaleString('vi-VN') : ''} mã
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

