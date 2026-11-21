'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ExternalLink, FileDown, Info, KeyRound, Layers, Link2, ListChecks, Loader2, Save, Trash2, Truck, Warehouse } from 'lucide-react';
import { normalizeCodeFields, normalizePurchaseFields, type DigitalStockRow } from '@cmsnt/shared';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { SlugInput } from '@/components/common/slug-input';
import { TranslationGate } from '@/components/common/translation-gate';
import { useConfirm } from '@/components/common/confirm-dialog';
import { PreviewButton } from '@/components/common/preview-button';
import { RevisionsDialog } from '@/components/common/revisions-dialog';
import { AutosaveToggle } from '@/components/common/autosave-toggle';
import { StatusBadge } from '@/components/common/status-badge';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { SeoPanel } from '@/components/seo/seo-panel';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { GalleryField, ImageIdField } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput, NumberInput } from '@/components/commerce/number-input';
import { OptionsEditor, uid, VariantsTable, type ProductOption, type VariantForm } from '@/components/commerce/variants-editor';
import { SpecsEditor, type SpecRow } from '@/components/commerce/specs-editor';
import { RelatedProducts } from '@/components/commerce/related-products';
import { DownloadsEditor, type DownloadForm } from '@/components/commerce/downloads-editor';
import { DigitalDeliveryPanel } from '@/components/commerce/digital-delivery-panel';
import { codeFieldsError, fromCodeFieldForms, toCodeFieldForms, type CodeFieldForm } from '@/components/commerce/code-fields-editor';
import { fromPurchaseFieldForms, purchaseFieldsError, toPurchaseFieldForms, type PurchaseFieldForm } from '@/components/commerce/purchase-fields-editor';
import { flattenTree, fromLocalInput, PRODUCT_TYPES, STOCK_STATUSES, toLocalInput, toNumOrNull } from '@/components/commerce/utils';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, pickTr } from '@/lib/format';
import { effectiveStatus, isFutureDate } from '@/lib/publish';
import { siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus, I18nText, SeoFields } from '@/lib/types';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';
import { useAutosave } from '@/hooks/use-autosave';

type ProductType = 'SIMPLE' | 'VARIABLE' | 'DIGITAL';
type MediaRef = { id: string; url: string; urls: Record<string, string> };

interface ProductTranslation extends SeoFields {
  locale: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string;
  /** hướng dẫn sử dụng gửi kèm mã (sản phẩm bán theo kho mã) */
  deliveryNote?: string | null;
}

interface ProductDetail {
  id: string;
  type: ProductType;
  status: ContentStatus;
  sku: string | null;
  barcode: string | null;
  price: unknown;
  salePrice: unknown;
  saleStart: string | null;
  saleEnd: string | null;
  costPrice: unknown;
  manageStock: boolean;
  stockQuantity: number;
  stockStatus: string;
  lowStockThreshold: number | null;
  weight: unknown;
  vatRate?: number | null;
  taxClass?: string | null;
  length: unknown;
  width: unknown;
  height: unknown;
  brandId: string | null;
  featuredImageId: string | null;
  featuredImage: MediaRef | null;
  gallery: MediaRef[];
  options: ProductOption[] | null;
  specs: { label: I18nText; value: I18nText }[] | null;
  customFields?: Record<string, unknown>;
  isFeatured: boolean;
  sortOrder: number;
  publishedAt: string | null;
  categoryIds: string[];
  relatedIds: string[];
  variants: {
    id: string;
    sku: string | null;
    optionValues: Record<string, string>;
    price: unknown;
    salePrice: unknown;
    stockQuantity: number;
    stockStatus: string;
    imageId: string | null;
    image: MediaRef | null;
    weight: unknown;
    isActive: boolean;
  }[];
  /** file tải về (sản phẩm số) */
  downloads?: { id: string; name: string; mediaId: string | null; media: { id: string; originalName: string; size: number; url: string } | null; url: string | null; downloadLimit: number | null; expiryDays: number | null }[];
  translations: ProductTranslation[];
  /** sản phẩm ảo / kho mã (module Kho mã số) */
  isVirtual?: boolean;
  codeDelivery?: boolean;
  codeFields?: unknown;
  codeWarrantyDays?: number | null;
  purchaseFields?: unknown;
  /** thống kê kho mã theo biến thể (chỉ có khi codeDelivery) */
  codeStats?: DigitalStockRow[];
}

/** Ảnh chụp sản phẩm trong lịch sử phiên bản (API trả nguyên snapshot) */
interface ProductRevisionDetail {
  id: string;
  title: string;
  createdAt: string;
  snapshot: {
    type: string;
    status: string;
    sku: string | null;
    price: number;
    salePrice: number | null;
    manageStock: boolean;
    stockQuantity: number;
    stockStatus: string;
    isFeatured: boolean;
    galleryIds: string[];
    categoryIds: string[];
    variants: { sku: string | null; optionValues: Record<string, string>; price: number; salePrice: number | null; stockQuantity: number; isActive: boolean }[];
    translations: { locale: string; name: string; slug: string; shortDescription?: string | null }[];
  };
}

interface FormState {
  type: ProductType;
  status: ContentStatus;
  sku: string;
  barcode: string;
  price: number | null;
  salePrice: number | null;
  saleStart: string;
  saleEnd: string;
  costPrice: number | null;
  manageStock: boolean;
  stockQuantity: number | null;
  stockStatus: string;
  lowStockThreshold: number | null;
  weight: number | null;
  vatRate: number | null;
  /** lớp thuế (Cài đặt › Thuế, chế độ theo bảng thuế suất); rỗng = standard */
  taxClass: string;
  length: number | null;
  width: number | null;
  height: number | null;
  brandId: string | null;
  featuredImageId: string | null;
  gallery: MediaRef[];
  options: ProductOption[];
  specs: SpecRow[];
  customFields: Record<string, unknown>;
  isFeatured: boolean;
  sortOrder: number | null;
  publishedAt: string;
  categoryIds: string[];
  relatedIds: string[];
  variants: VariantForm[];
  downloads: DownloadForm[];
  /** sản phẩm ảo: không cần giao hàng */
  isVirtual: boolean;
  /** bán theo kho mã: tồn kho = số mã còn trong kho */
  codeDelivery: boolean;
  codeFields: CodeFieldForm[];
  codeWarrantyDays: number | null;
  purchaseFields: PurchaseFieldForm[];
  translations: Record<string, ProductTranslation>;
}

const emptyTr = (locale: string): ProductTranslation => ({ locale, name: '', slug: '', shortDescription: '', description: '', deliveryNote: '', seoTitle: '', seoDescription: '', seoKeywords: '', canonicalUrl: '', noindex: false, ogImageId: null, schemaJson: null });

const fromDetail = (p: ProductDetail): FormState => ({
  type: p.type,
  status: p.status,
  sku: p.sku ?? '',
  barcode: p.barcode ?? '',
  price: toNumOrNull(p.price),
  salePrice: toNumOrNull(p.salePrice),
  saleStart: toLocalInput(p.saleStart),
  saleEnd: toLocalInput(p.saleEnd),
  costPrice: toNumOrNull(p.costPrice),
  manageStock: p.manageStock,
  stockQuantity: p.stockQuantity,
  stockStatus: p.stockStatus,
  lowStockThreshold: p.lowStockThreshold,
  weight: toNumOrNull(p.weight),
  vatRate: p.vatRate ?? null,
  taxClass: p.taxClass ?? '',
  length: toNumOrNull(p.length),
  width: toNumOrNull(p.width),
  height: toNumOrNull(p.height),
  brandId: p.brandId,
  featuredImageId: p.featuredImageId,
  gallery: p.gallery ?? [],
  options: Array.isArray(p.options) ? p.options : [],
  specs: (Array.isArray(p.specs) ? p.specs : []).map((s) => ({ _key: uid(), label: s.label ?? {}, value: s.value ?? {} })),
  customFields: p.customFields ?? {},
  isFeatured: p.isFeatured,
  sortOrder: p.sortOrder,
  publishedAt: toLocalInput(p.publishedAt),
  categoryIds: p.categoryIds,
  relatedIds: p.relatedIds ?? [],
  variants: p.variants.map((v) => ({
    id: v.id,
    _key: v.id,
    sku: v.sku ?? '',
    optionValues: v.optionValues ?? {},
    price: toNumOrNull(v.price),
    salePrice: toNumOrNull(v.salePrice),
    stockQuantity: v.stockQuantity,
    stockStatus: v.stockStatus,
    imageId: v.imageId,
    image: v.image,
    weight: toNumOrNull(v.weight),
    isActive: v.isActive,
  })),
  downloads: (p.downloads ?? []).map((d) => ({ id: d.id, _key: d.id, name: d.name, mediaId: d.mediaId, media: d.media, url: d.url ?? '', downloadLimit: d.downloadLimit, expiryDays: d.expiryDays })),
  isVirtual: !!p.isVirtual,
  codeDelivery: !!p.codeDelivery,
  codeFields: toCodeFieldForms(normalizeCodeFields(p.codeFields)),
  codeWarrantyDays: p.codeWarrantyDays ?? null,
  purchaseFields: toPurchaseFieldForms(normalizePurchaseFields(p.purchaseFields)),
  translations: Object.fromEntries(p.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t, deliveryNote: t.deliveryNote ?? '' }])),
});

export default function ProductEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('product', isNew ? null : id);
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('general');
  /** đếm số lần sửa để biết có thay đổi trong lúc đang lưu không */
  const editsRef = useRef(0);
  const active = locale ?? defaultLocale;
  const canWrite = can('products.write');
  const langName = (code: string) => languages.find((l) => l.code === code)?.name ?? code;

  const product = useQuery({ queryKey: ['product', id], queryFn: () => api.get<ProductDetail>(`/admin/products/${id}`), enabled: !isNew });
  const categories = useQuery({ queryKey: ['product-categories', 'all'], queryFn: () => api.get<{ id: string; parentId: string | null; translations: { locale: string; name: string }[] }[]>('/admin/products/categories') });
  const brands = useQuery({ queryKey: ['product-brands'], queryFn: () => api.get<{ id: string; name: string }[]>('/admin/products/brands') });
  const categoryTree = useMemo(() => flattenTree(categories.data ?? []), [categories.data]);

  useEffect(() => {
    if (form) return;
    if (isNew && languages.length) {
      setForm({
        type: 'SIMPLE',
        status: 'DRAFT',
        sku: '',
        barcode: '',
        price: null,
        salePrice: null,
        saleStart: '',
        saleEnd: '',
        costPrice: null,
        manageStock: false,
        stockQuantity: 0,
        stockStatus: 'IN_STOCK',
        lowStockThreshold: null,
        weight: null,
        vatRate: null,
        taxClass: '',
        length: null,
        width: null,
        height: null,
        brandId: null,
        featuredImageId: null,
        gallery: [],
        options: [],
        specs: [],
        customFields: {},
        isFeatured: false,
        sortOrder: 0,
        publishedAt: '',
        categoryIds: [],
        relatedIds: [],
        variants: [],
        downloads: [],
        isVirtual: false,
        codeDelivery: false,
        codeFields: [],
        codeWarrantyDays: null,
        purchaseFields: [],
        translations: { [defaultLocale]: emptyTr(defaultLocale) },
      });
    } else if (product.data) {
      setForm(fromDetail(product.data));
    }
  }, [isNew, languages.length, product.data, defaultLocale, form]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    editsRef.current++;
    setDirty(true);
  };
  const updateTr = (patch: Partial<ProductTranslation>) => {
    setForm((f) => (f ? { ...f, translations: { ...f.translations, [active]: { ...f.translations[active], ...patch } } } : f));
    editsRef.current++;
    setDirty(true);
  };
  /** Biến thể đã lưu trên server (để xoá khi đổi sang loại không có biến thể) */
  const savedVariantCount = product.data?.variants.length ?? 0;

  const save = useMutation({
    // chụp lại "phiên bản" lúc bắt đầu lưu -> chỉ xoá cờ chưa lưu nếu không có thay đổi mới trong lúc lưu
    onMutate: () => ({ edits: editsRef.current }),
    mutationFn: async ({ status, auto }: { status?: ContentStatus; auto?: boolean }) => {
      if (!form) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      const skipped: string[] = [];
      const translations: ProductTranslation[] = [];
      for (const t of Object.values(form.translations)) {
        if (t.name.trim()) translations.push(t);
        else if (!t.slug.trim() && !(t.shortDescription ?? '').trim() && !t.description.replace(/<[^>]*>/g, '').trim() && !(t.seoTitle ?? '').trim() && !(t.seoDescription ?? '').trim() && !(t.deliveryNote ?? '').trim()) skipped.push(t.locale);
        else throw new Error(`Bản ${langName(t.locale)} thiếu tên sản phẩm`);
      }
      if (!translations.length) throw new Error('Vui lòng nhập tên sản phẩm');
      if (skipped.length && !auto) toast.info(`Bỏ qua bản ${skipped.map(langName).join(', ')} vì còn trống`);
      const variable = form.type === 'VARIABLE';
      const backorder = form.stockStatus === 'BACKORDER';
      /** bán theo kho mã luôn quản lý tồn kho */
      const manage = form.manageStock || form.codeDelivery;
      const variantStatus = (v: VariantForm) => (manage ? (backorder ? 'BACKORDER' : (v.stockQuantity ?? 0) > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK') : v.stockStatus);

      if (variable) {
        if (form.variants.some((v) => v.price == null)) throw new Error('Vui lòng nhập giá cho tất cả biến thể');
        if (form.variants.some((v) => v.salePrice != null && v.salePrice >= (v.price ?? 0))) throw new Error('Giá khuyến mãi của biến thể phải nhỏ hơn giá gốc');
        const skus = form.variants.map((v) => v.sku.trim()).filter(Boolean);
        if (new Set(skus).size !== skus.length) throw new Error('SKU của các biến thể bị trùng');
      } else if (form.salePrice != null && form.salePrice >= (form.price ?? 0)) {
        throw new Error('Giá khuyến mãi phải nhỏ hơn giá gốc');
      }
      // cấu hình kho mã / ô khách nhập: kiểm tra mã khoá hợp lệ, không trùng
      if (form.codeDelivery) {
        const codeErr = codeFieldsError(form.codeFields);
        if (codeErr) throw new Error(codeErr);
      }
      const pfErr = purchaseFieldsError(form.purchaseFields);
      if (pfErr) throw new Error(`Thông tin khách nhập: ${pfErr}`);
      if (form.type === 'DIGITAL') {
        if (form.downloads.some((d) => !d.name.trim())) throw new Error('Vui lòng nhập tên hiển thị cho tất cả file tải về');
        if (form.downloads.some((d) => !d.mediaId && !d.url.trim())) throw new Error('Mỗi file tải về cần chọn file từ thư viện hoặc nhập URL');
      }

      const activeVariants = form.variants.filter((v) => v.isActive);
      const variantPrices = activeVariants.map((v) => v.price ?? 0);
      const body = {
        type: form.type,
        // tự lưu: giữ nguyên trạng thái nháp; chọn Xuất bản mà ngày đăng ở tương lai -> hẹn giờ
        status: auto ? 'DRAFT' : effectiveStatus(status ?? form.status, form.publishedAt),
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
        price: variable && variantPrices.length ? Math.min(...variantPrices) : (form.price ?? 0),
        salePrice: variable ? null : form.salePrice,
        saleStart: variable ? null : fromLocalInput(form.saleStart),
        saleEnd: variable ? null : fromLocalInput(form.saleEnd),
        costPrice: form.costPrice,
        // bán theo kho mã: luôn quản lý tồn kho (số lượng do API tính lại theo kho mã)
        manageStock: manage,
        stockQuantity: variable && manage ? form.variants.reduce((s, v) => s + (v.stockQuantity ?? 0), 0) : (form.stockQuantity ?? 0),
        stockStatus: variable && !manage ? (activeVariants.some((v) => v.stockStatus !== 'OUT_OF_STOCK') ? 'IN_STOCK' : 'OUT_OF_STOCK') : form.stockStatus,
        lowStockThreshold: manage ? form.lowStockThreshold : null,
        weight: form.weight,
        vatRate: form.vatRate,
        taxClass: form.taxClass.trim() || null,
        length: form.length,
        width: form.width,
        height: form.height,
        brandId: form.brandId,
        featuredImageId: form.featuredImageId,
        galleryIds: form.gallery.map((g) => g.id),
        options: form.options.filter((o) => o.key && o.values.length),
        specs: form.specs.filter((s) => Object.values(s.label).some(Boolean)).map(({ label, value }) => ({ label, value })),
        customFields: form.customFields,
        isFeatured: form.isFeatured,
        sortOrder: form.sortOrder ?? 0,
        // để trống: nếu đã có ngày trước đó -> gửi null để xoá; chưa từng có -> không gửi (API tự đặt khi xuất bản)
        publishedAt: form.publishedAt ? fromLocalInput(form.publishedAt) : product.data?.publishedAt ? null : undefined,
        categoryIds: form.categoryIds,
        relatedIds: form.relatedIds,
        ...(variable
          ? {
              variants: form.variants.map((v) => ({
                id: v.id,
                sku: v.sku.trim() || null,
                optionValues: v.optionValues,
                price: v.price ?? 0,
                salePrice: v.salePrice,
                stockQuantity: v.stockQuantity ?? 0,
                stockStatus: variantStatus(v),
                imageId: v.imageId,
                weight: v.weight,
                isActive: v.isActive,
              })),
            }
          : !isNew && savedVariantCount > 0
            ? { variants: [] } // đổi VARIABLE -> SIMPLE/DIGITAL: xoá biến thể cũ (đã xác nhận trước khi lưu)
            : {}),
        // file tải về chỉ gửi khi là sản phẩm số (API cũng chỉ lưu khi DIGITAL)
        ...(form.type === 'DIGITAL' ? { downloads: form.downloads.map((d) => ({ id: d.id, name: d.name.trim(), mediaId: d.mediaId, url: d.mediaId ? null : d.url.trim() || null, downloadLimit: d.downloadLimit, expiryDays: d.expiryDays })) } : {}),
        // giao hàng số: sản phẩm ảo, bán theo kho mã, nhãn phần mã, bảo hành, ô khách nhập khi mua
        isVirtual: form.isVirtual,
        codeDelivery: form.codeDelivery,
        codeFields: fromCodeFieldForms(form.codeFields),
        codeWarrantyDays: form.codeWarrantyDays,
        purchaseFields: fromPurchaseFieldForms(form.purchaseFields),
        translations: translations.map((t) => ({ ...t, shortDescription: t.shortDescription || null, deliveryNote: (t.deliveryNote ?? '').trim() || null })),
      };
      return isNew ? api.post<ProductDetail>('/admin/products', body) : api.patch<ProductDetail>(`/admin/products/${id}`, body);
    },
    onSuccess: (data, vars, snap) => {
      if (vars.auto) {
        autosave.markSaved();
        toast.info(`Đã tự lưu lúc ${formatDate(new Date(), 'HH:mm')}`, { id: 'autosave', duration: 2500 });
      } else toast.success('Đã lưu sản phẩm');
      const unchanged = !!snap && snap.edits === editsRef.current;
      if (unchanged) setDirty(false);
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['products-revisions', data.id] });
      qc.setQueryData(['product', data.id], data);
      if (isNew) {
        router.replace(`/products/${data.id}`);
        return;
      }
      if (unchanged) {
        setForm(fromDetail(data));
        return;
      }
      // có thay đổi mới trong lúc lưu -> giữ nguyên form, chỉ cập nhật slug và id biến thể vừa tạo
      setForm((f) => {
        if (!f) return f;
        const translations = { ...f.translations };
        for (const d of data.translations) if (translations[d.locale]) translations[d.locale] = { ...translations[d.locale], slug: d.slug };
        const key = (o: Record<string, string>) => JSON.stringify(Object.entries(o ?? {}).sort());
        const variants = f.variants.map((v) => (v.id ? v : { ...v, id: data.variants.find((d) => key(d.optionValues) === key(v.optionValues))?.id }));
        return { ...f, status: data.status, translations, variants };
      });
    },
    onError: (e, vars) => {
      if (vars.auto) toast.error(`Tự lưu thất bại: ${errorMessage(e)}`, { id: 'autosave' });
      else toast.error(errorMessage(e));
    },
  });

  /** Lưu (nút / Ctrl+S): kiểm tra quyền, tránh gửi trùng, xác nhận xoá biến thể khi bỏ loại "có biến thể" */
  const submit = useCallback(
    async (status?: ContentStatus) => {
      if (!canWrite || save.isPending || !form) return;
      if (!isNew && form.type !== 'VARIABLE' && savedVariantCount > 0) {
        const ok = await confirm({
          title: `Xoá ${savedVariantCount} biến thể cũ?`,
          description: 'Sản phẩm không còn là loại "có biến thể". Các biến thể đã lưu sẽ bị xoá vĩnh viễn khi lưu.',
          destructive: true,
          confirmText: 'Xoá biến thể và lưu',
        });
        if (!ok) return;
      }
      save.mutate({ status });
    },
    [canWrite, save, form, isNew, savedVariantCount, confirm],
  );
  const doSave = useCallback(() => void submit(undefined), [submit]);
  useUnsavedGuard(dirty, canWrite ? doSave : undefined);

  // Tự động lưu bản nháp (đã có id, đang DRAFT) sau 30 giây không gõ; không tự lưu khi cần xác nhận xoá biến thể
  const autosave = useAutosave({
    active: !isNew && canWrite && form?.status === 'DRAFT' && !(form?.type !== 'VARIABLE' && savedVariantCount > 0) && !lock.readOnly,
    dirty,
    signal: form,
    onSave: () => {
      if (!save.isPending) save.mutate({ auto: true });
    },
  });

  const removeTranslation = async () => {
    if (!canWrite) return;
    const lang = languages.find((l) => l.code === active);
    if (!(await confirm({ title: `Xoá bản dịch ${lang?.name ?? active}?`, description: 'Thay đổi chưa lưu ở các ngôn ngữ khác cũng sẽ bị bỏ.', destructive: true, confirmText: 'Xoá bản dịch' }))) return;
    try {
      const data = await api.delete<ProductDetail>(`/admin/products/${id}/translations/${active}`);
      qc.setQueryData(['product', id], data);
      setForm(null);
      setDirty(false);
      setLocale(null);
      toast.success('Đã xoá bản dịch');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  useEffect(() => {
    if (form && form.type !== 'VARIABLE' && tab === 'variants') setTab('general');
    if (form && (form.type === 'DIGITAL' || form.isVirtual || form.codeDelivery) && tab === 'shipping') setTab('general');
    if (form && form.type !== 'DIGITAL' && tab === 'downloads') setTab('general');
  }, [form, tab]);

  if (!form || (!isNew && product.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tr = form.translations[active];
  const savedLocales = product.data?.translations.map((t) => t.locale) ?? [];
  const publicUrl = tr?.slug ? siteUrl('product', tr.slug, active, defaultLocale) : '';
  const createTranslation = (copy: boolean) => {
    const src = form.translations[defaultLocale] ?? Object.values(form.translations)[0];
    updateTr(copy && src ? { ...src, locale: active, slug: '' } : emptyTr(active));
  };
  const scheduled = (form.status === 'PUBLISHED' || form.status === 'SCHEDULED') && isFutureDate(form.publishedAt);
  /** Lưu nháp để lấy id (xem trước sản phẩm mới) */
  const ensureId = async () => {
    if (!isNew) return id;
    const data = await save.mutateAsync({ status: 'DRAFT' });
    return data.id;
  };
  /** Sau khi khôi phục phiên bản ở server: nạp lại form từ dữ liệu mới */
  const onRestored = (data: ProductDetail) => {
    qc.setQueryData(['product', id], data);
    setForm(fromDetail(data));
    setDirty(false);
  };
  const price = form.price ?? 0;
  const discount = form.salePrice != null && price > 0 && form.salePrice < price ? Math.round((1 - form.salePrice / price) * 100) : 0;
  const sellPrice = form.salePrice != null && form.salePrice < price ? form.salePrice : price;
  const margin = form.costPrice != null && sellPrice > 0 ? sellPrice - form.costPrice : null;
  /** hàng ảo (không cần vận chuyển): loại số, bật "sản phẩm ảo" hoặc bán theo kho mã */
  const virtual = form.type === 'DIGITAL' || form.isVirtual || form.codeDelivery;
  /** Sau khi nhập mã: tải lại sản phẩm, cập nhật thống kê + tồn kho trong form mà không đánh dấu "chưa lưu" */
  const refreshStock = async () => {
    if (isNew) return;
    try {
      const data = await api.get<ProductDetail>(`/admin/products/${id}`);
      qc.setQueryData(['product', id], data);
      setForm((f) =>
        f
          ? {
              ...f,
              stockQuantity: data.stockQuantity,
              stockStatus: f.stockStatus === 'BACKORDER' ? f.stockStatus : data.stockStatus,
              variants: f.variants.map((v) => {
                const d = v.id ? data.variants.find((x) => x.id === v.id) : undefined;
                return d ? { ...v, stockQuantity: d.stockQuantity, stockStatus: d.stockStatus } : v;
              }),
            }
          : f,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title={isNew ? 'Thêm sản phẩm' : pickTr(Object.values(form.translations), active)?.name || 'Chỉnh sửa sản phẩm'}
        breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: isNew ? 'Mới' : 'Chỉnh sửa' }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={active} onChange={setLocale} has={(c) => !!form.translations[c]?.name} />
            {!isNew && <RevisionsDialog<ProductRevisionDetail, ProductDetail> resource="products" id={id} canRestore={canWrite} onRestored={onRestored} renderPreview={(d) => <RevisionPreview d={d} />} />}
            <PreviewButton type="product" id={isNew ? null : id} locale={active} ensureId={canWrite ? ensureId : undefined} />
            {!isNew && publicUrl && form.status === 'PUBLISHED' && (
              <Button variant="outline" size="sm" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Xem
                </a>
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => void submit('DRAFT')} disabled={save.isPending}>
                Lưu nháp
              </Button>
            )}
            {canWrite && can('products.publish') && (
              <Button size="sm" onClick={() => void submit('PUBLISHED')} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
                {scheduled ? 'Hẹn giờ đăng' : form.status === 'PUBLISHED' ? 'Cập nhật' : 'Xuất bản'}
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <EditLockBanner lock={lock} />
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <div className="min-w-0 space-y-6">
            {!tr ? (
              <TranslationGate language={languages.find((l) => l.code === active)} sourceLanguage={languages.find((l) => l.code === defaultLocale && l.code !== active)} onCreate={createTranslation} />
            ) : (
              <Section
                actions={
                  canWrite && !isNew && active !== defaultLocale && savedLocales.includes(active) && savedLocales.length > 1 ? (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={removeTranslation}>
                      <Trash2 /> Xoá bản dịch
                    </Button>
                  ) : undefined
                }
                title={languages.length > 1 ? `Nội dung · ${languages.find((l) => l.code === active)?.name ?? active}` : undefined}
              >
                <Field label="Tên sản phẩm" required>
                  <Input value={tr.name} onChange={(e) => updateTr({ name: e.target.value })} placeholder="Nhập tên sản phẩm" className="h-11 text-lg font-medium" autoFocus={isNew} />
                </Field>
                <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tên sản phẩm">
                  <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.name} prefix={`/${active !== defaultLocale ? `${active}/` : ''}products/`} />
                </Field>
                <Field label="Mô tả ngắn" help="Hiển thị cạnh giá ở trang sản phẩm và trong danh sách.">
                  <Textarea value={tr.shortDescription ?? ''} onChange={(e) => updateTr({ shortDescription: e.target.value })} rows={3} />
                </Field>
                <Field label="Mô tả chi tiết">
                  <RichTextEditor value={tr.description} onChange={(description) => updateTr({ description })} minHeight={360} />
                </Field>
              </Section>
            )}

            <Section
              title="Dữ liệu sản phẩm"
              actions={
                <Select value={form.type} onValueChange={(v) => update({ type: v as ProductType })}>
                  <SelectTrigger size="sm" className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            >
              <Tabs value={tab} onValueChange={setTab} className="gap-4">
                <TabsList variant="line" className="w-full flex-wrap justify-start gap-y-1 border-b pb-1 group-data-horizontal/tabs:h-auto">
                  <TabsTrigger value="general">
                    <Info /> Chung
                  </TabsTrigger>
                  <TabsTrigger value="inventory">
                    <Warehouse /> Kho hàng
                  </TabsTrigger>
                  {!virtual && (
                    <TabsTrigger value="shipping">
                      <Truck /> Vận chuyển
                    </TabsTrigger>
                  )}
                  {form.type === 'VARIABLE' && (
                    <TabsTrigger value="variants">
                      <Layers /> Thuộc tính & Biến thể
                      {form.variants.length > 0 && <Badge variant="secondary">{form.variants.length}</Badge>}
                    </TabsTrigger>
                  )}
                  {form.type === 'DIGITAL' && (
                    <TabsTrigger value="downloads">
                      <FileDown /> File tải về
                      {form.downloads.length > 0 && <Badge variant="secondary">{form.downloads.length}</Badge>}
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="digital">
                    <KeyRound /> Giao hàng số
                    {form.codeDelivery && <Badge variant="secondary">Kho mã</Badge>}
                  </TabsTrigger>
                  <TabsTrigger value="specs">
                    <ListChecks /> Thông số
                    {form.specs.length > 0 && <Badge variant="secondary">{form.specs.length}</Badge>}
                  </TabsTrigger>
                  <TabsTrigger value="related">
                    <Link2 /> Liên quan
                    {form.relatedIds.length > 0 && <Badge variant="secondary">{form.relatedIds.length}</Badge>}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="general" className="space-y-4">
                  {form.type === 'VARIABLE' && (
                    <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                      <Box className="mt-0.5 size-4 shrink-0" />
                      Giá bán được đặt cho từng biến thể ở tab “Thuộc tính & Biến thể”. Giá dưới đây dùng làm giá mặc định khi tạo biến thể mới; giá hiển thị của sản phẩm là giá thấp nhất trong các biến thể.
                    </p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={form.type === 'VARIABLE' ? 'Giá mặc định' : 'Giá bán'} required={form.type !== 'VARIABLE'}>
                      <MoneyInput value={form.price} onChange={(v) => update({ price: v })} placeholder="0" />
                    </Field>
                    {form.type !== 'VARIABLE' && (
                      <Field label="Giá khuyến mãi" help={discount ? `Giảm ${discount}%` : 'Để trống nếu không giảm giá'} error={form.salePrice != null && form.price != null && form.salePrice >= form.price ? 'Phải nhỏ hơn giá bán' : undefined}>
                        <MoneyInput value={form.salePrice} onChange={(v) => update({ salePrice: v })} />
                      </Field>
                    )}
                  </div>
                  {form.type !== 'VARIABLE' && form.salePrice != null && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Bắt đầu khuyến mãi" help="Để trống = áp dụng ngay">
                        <Input type="datetime-local" value={form.saleStart} onChange={(e) => update({ saleStart: e.target.value })} />
                      </Field>
                      <Field label="Kết thúc khuyến mãi" help="Để trống = không giới hạn">
                        <Input type="datetime-local" value={form.saleEnd} onChange={(e) => update({ saleEnd: e.target.value })} />
                      </Field>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Giá vốn" help="Chỉ dùng nội bộ, không hiển thị trên website">
                      <MoneyInput value={form.costPrice} onChange={(v) => update({ costPrice: v })} />
                    </Field>
                    {/* Thuế suất GTGT riêng dùng khi xuất hoá đơn điện tử */}
                    <Field label="Thuế suất GTGT (hoá đơn điện tử)" help="Để mặc định nếu dùng thuế suất chung ở Cài đặt › Hoá đơn điện tử">
                      <Select value={form.vatRate == null ? 'default' : String(form.vatRate)} onValueChange={(v) => update({ vatRate: v === 'default' ? null : Number(v) })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Theo mặc định</SelectItem>
                          <SelectItem value="0">0%</SelectItem>
                          <SelectItem value="5">5%</SelectItem>
                          <SelectItem value="8">8%</SelectItem>
                          <SelectItem value="10">10%</SelectItem>
                          <SelectItem value="-1">Không chịu thuế (KCT)</SelectItem>
                          <SelectItem value="-2">Không kê khai, tính nộp thuế (KKKNT)</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {/* Lớp thuế cho thuế theo vùng (Cài đặt › Thuế); để trống = standard */}
                    <Field label="Lớp thuế" help="Dùng khi Cài đặt › Thuế chọn “Theo bảng thuế suất”. Để trống = standard">
                      <Input value={form.taxClass} onChange={(e) => update({ taxClass: e.target.value })} list="product-tax-classes" placeholder="standard" className="font-mono text-sm" />
                      <datalist id="product-tax-classes">
                        <option value="standard" />
                        <option value="reduced" />
                        <option value="zero" />
                      </datalist>
                    </Field>
                    {margin != null && form.type !== 'VARIABLE' && (
                      <div className="flex flex-col justify-center rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                        <span className="text-xs text-muted-foreground">Lợi nhuận dự kiến</span>
                        <span className={margin >= 0 ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-destructive'}>
                          {formatMoney(margin)} ({sellPrice > 0 ? Math.round((margin / sellPrice) * 100) : 0}%)
                        </span>
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="inventory" className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Mã SKU" help="Mã quản lý kho, không trùng lặp">
                      <Input value={form.sku} onChange={(e) => update({ sku: e.target.value })} className="font-mono" />
                    </Field>
                    <Field label="Mã vạch (Barcode)" help="EAN, UPC, ISBN...">
                      <Input value={form.barcode} onChange={(e) => update({ barcode: e.target.value })} className="font-mono" />
                    </Field>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>Quản lý tồn kho</Label>
                      <p className="text-xs text-muted-foreground">Tự trừ kho khi có đơn và tự chuyển “Hết hàng” khi số lượng về 0</p>
                    </div>
                    <Switch checked={form.manageStock || form.codeDelivery} disabled={form.codeDelivery} onCheckedChange={(v) => update({ manageStock: v })} />
                  </div>
                  {form.codeDelivery && (
                    <p className="flex items-start gap-2 rounded-lg bg-primary/5 p-3 text-xs text-muted-foreground">
                      <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
                      Sản phẩm bán theo kho mã: số lượng tồn kho được tính theo số mã còn trong kho, không sửa tay. Nhập thêm mã ở tab “Giao hàng số”.
                    </p>
                  )}
                  {form.manageStock || form.codeDelivery ? (
                    <div className="grid gap-4 sm:grid-cols-3">
                      {form.type === 'VARIABLE' ? (
                        <Field label="Tổng tồn kho" help="Tính từ các biến thể">
                          <Input value={form.variants.reduce((s, v) => s + (v.stockQuantity ?? 0), 0)} disabled className="tabular-nums" />
                        </Field>
                      ) : (
                        <Field label="Số lượng trong kho" help={form.codeDelivery ? 'Tính theo kho mã' : undefined}>
                          <NumberInput value={form.stockQuantity} onChange={(v) => update({ stockQuantity: v })} integer disabled={form.codeDelivery} />
                        </Field>
                      )}
                      <Field label="Ngưỡng sắp hết hàng" help="Cảnh báo khi tồn kho ≤ ngưỡng">
                        <NumberInput value={form.lowStockThreshold} onChange={(v) => update({ lowStockThreshold: v })} integer min={0} placeholder="Mặc định" />
                      </Field>
                      <Field label="Khi hết hàng">
                        <Select value={form.stockStatus === 'BACKORDER' ? 'BACKORDER' : 'STOP'} onValueChange={(v) => update({ stockStatus: v === 'BACKORDER' ? 'BACKORDER' : (form.stockQuantity ?? 0) > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK' })}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="STOP">Ngừng bán</SelectItem>
                            <SelectItem value="BACKORDER">Cho phép đặt trước</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  ) : form.type === 'VARIABLE' ? (
                    <p className="text-sm text-muted-foreground">Trạng thái kho được đặt cho từng biến thể.</p>
                  ) : (
                    <Field label="Trạng thái kho" className="sm:max-w-xs">
                      <Select value={form.stockStatus} onValueChange={(v) => update({ stockStatus: v })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STOCK_STATUSES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </TabsContent>

                <TabsContent value="shipping" className="space-y-4">
                  <Field label="Cân nặng" className="sm:max-w-xs">
                    <NumberInput value={form.weight} onChange={(v) => update({ weight: v })} min={0} suffix="kg" />
                  </Field>
                  <Field label="Kích thước (D × R × C)">
                    <div className="grid grid-cols-3 gap-2 sm:max-w-md">
                      <NumberInput value={form.length} onChange={(v) => update({ length: v })} min={0} placeholder="Dài" suffix="cm" />
                      <NumberInput value={form.width} onChange={(v) => update({ width: v })} min={0} placeholder="Rộng" suffix="cm" />
                      <NumberInput value={form.height} onChange={(v) => update({ height: v })} min={0} placeholder="Cao" suffix="cm" />
                    </div>
                  </Field>
                </TabsContent>

                <TabsContent value="variants" className="space-y-6">
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold">Thuộc tính</h4>
                    <OptionsEditor value={form.options} onChange={(options) => update({ options })} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold">Biến thể</h4>
                    <VariantsTable options={form.options} value={form.variants} onChange={(variants) => update({ variants })} manageStock={form.manageStock || form.codeDelivery} defaultPrice={form.price} readOnlyStock={form.codeDelivery} />
                  </div>
                </TabsContent>

                <TabsContent value="downloads">
                  <DownloadsEditor value={form.downloads} onChange={(downloads) => update({ downloads })} />
                </TabsContent>

                <TabsContent value="digital">
                  <DigitalDeliveryPanel
                    productId={isNew ? null : id}
                    productType={form.type}
                    value={form}
                    // bật kho mã -> bật luôn quản lý tồn kho
                    onChange={(patch) => update(patch.codeDelivery ? { ...patch, manageStock: true } : patch)}
                    deliveryNote={tr ? (tr.deliveryNote ?? '') : undefined}
                    onDeliveryNoteChange={(deliveryNote) => updateTr({ deliveryNote })}
                    localeName={languages.length > 1 ? langName(active) : undefined}
                    codeStats={product.data?.codeStats}
                    onCodesImported={() => void refreshStock()}
                  />
                </TabsContent>

                <TabsContent value="specs">
                  <SpecsEditor value={form.specs} onChange={(specs) => update({ specs })} />
                </TabsContent>

                <TabsContent value="related">
                  <RelatedProducts value={form.relatedIds} onChange={(relatedIds) => update({ relatedIds })} excludeId={isNew ? undefined : id} />
                </TabsContent>
              </Tabs>
            </Section>

            {/* Trường tuỳ chỉnh (nhóm ở cột chính): theo loại sản phẩm + danh mục; tự ẩn khi không có nhóm */}
            <CustomFieldsPanel entity="product" placement="main" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ productType: form.type, categoryIds: form.categoryIds }} locale={active} />

            {tr && (
              <Section title="Tối ưu SEO" description={`Cho bản ${languages.find((l) => l.code === active)?.name ?? active}`}>
                <SeoPanel value={tr} onChange={updateTr} title={tr.name} slug={tr.slug} content={`${tr.shortDescription ?? ''} ${tr.description}`} url={publicUrl || `.../products/${tr.slug}`} hasImage={!!form.featuredImageId} />
              </Section>
            )}
          </div>

          <div className="space-y-6">
            <Section title="Xuất bản" actions={<StatusBadge status={scheduled ? 'SCHEDULED' : form.status} />}>
              <Field label="Trạng thái" help={scheduled ? `Sẽ tự mở bán lúc ${formatDate(new Date(form.publishedAt))}` : undefined}>
                <Select value={form.status === 'SCHEDULED' ? 'PUBLISHED' : form.status} onValueChange={(v) => update({ status: v as ContentStatus })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DRAFT">Bản nháp</SelectItem>
                    {can('products.publish') && <SelectItem value="PUBLISHED">{scheduled ? 'Hẹn giờ mở bán' : 'Đã xuất bản'}</SelectItem>}
                    <SelectItem value="ARCHIVED">Lưu trữ</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Ngày đăng"
                help="Đặt ngày trong tương lai để hẹn giờ mở bán. Để trống: tự đặt khi xuất bản."
                action={
                  form.publishedAt ? (
                    <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => update({ publishedAt: '' })}>
                      Xoá ngày
                    </button>
                  ) : undefined
                }
              >
                <Input type="datetime-local" value={form.publishedAt} onChange={(e) => update({ publishedAt: e.target.value })} />
              </Field>
              <Field label="Thứ tự hiển thị" help="Số nhỏ hiển thị trước khi sắp xếp thủ công">
                <NumberInput value={form.sortOrder} onChange={(v) => update({ sortOrder: v })} integer />
              </Field>
              <div className="flex items-center justify-between">
                <Label>Sản phẩm nổi bật</Label>
                <Switch checked={form.isFeatured} onCheckedChange={(v) => update({ isFeatured: v })} />
              </div>
              {!isNew && canWrite && <AutosaveToggle enabled={autosave.enabled} onChange={autosave.setEnabled} lastSavedAt={autosave.lastSavedAt} />}
              {!isNew && can('products.delete') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-destructive"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Chuyển sản phẩm vào thùng rác?', description: 'Có thể khôi phục từ tab Thùng rác trong danh sách sản phẩm.', destructive: true }))) return;
                    try {
                      await api.post(`/admin/products/${id}/trash`);
                      toast.success('Đã chuyển sản phẩm vào thùng rác');
                      void qc.invalidateQueries({ queryKey: ['products'] });
                      setDirty(false);
                      router.push('/products');
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 /> Chuyển vào thùng rác
                </Button>
              )}
            </Section>

            <Section title="Ảnh đại diện">
              <ImageIdField value={form.featuredImageId} initial={product.data?.featuredImage} onChange={(fid) => update({ featuredImageId: fid })} aspect="aspect-square" />
            </Section>

            <Section title="Thư viện ảnh" description="Kéo thả để sắp xếp thứ tự">
              <GalleryField value={form.gallery} onChange={(gallery) => update({ gallery })} mapMedia={(m) => ({ id: m.id, url: m.url, urls: m.urls })} />
            </Section>

            <Section title="Danh mục" actions={<Link href="/products/categories" className="text-xs text-primary">Quản lý</Link>}>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {categoryTree.length === 0 && <p className="text-sm text-muted-foreground">Chưa có danh mục</p>}
                {categoryTree.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: c.depth * 20 }}>
                    <Checkbox checked={form.categoryIds.includes(c.id)} onCheckedChange={(v) => update({ categoryIds: v ? [...form.categoryIds, c.id] : form.categoryIds.filter((x) => x !== c.id) })} />
                    {pickTr(c.translations, defaultLocale)?.name}
                  </label>
                ))}
              </div>
            </Section>

            <Section title="Thương hiệu" actions={<Link href="/products/brands" className="text-xs text-primary">Quản lý</Link>}>
              <Select value={form.brandId ?? 'none'} onValueChange={(v) => update({ brandId: v === 'none' ? null : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Chọn thương hiệu" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Không có —</SelectItem>
                  {brands.data?.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Section>
            {/* Trường tuỳ chỉnh (nhóm ở cột phải) */}
            <CustomFieldsPanel entity="product" placement="sidebar" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ productType: form.type, categoryIds: form.categoryIds }} locale={active} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** Tóm tắt một phiên bản sản phẩm trong hộp thoại lịch sử */
function RevisionPreview({ d }: { d: ProductRevisionDetail }) {
  const snap = d.snapshot;
  const row = (label: string, value: ReactNode) => (
    <div className="flex justify-between gap-3 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase text-muted-foreground">Tên theo ngôn ngữ</p>
        {snap.translations?.map((t) => (
          <p key={t.locale} className="text-sm">
            <span className="mr-1 text-[10px] uppercase text-muted-foreground">{t.locale}</span>
            <span className="font-medium">{t.name}</span> <span className="text-xs text-muted-foreground">/{t.slug}</span>
          </p>
        ))}
      </div>
      <div>
        {row('Trạng thái', <StatusBadge status={snap.status} />)}
        {row('Loại', PRODUCT_TYPES.find((t) => t.value === snap.type)?.label ?? snap.type)}
        {row('SKU', snap.sku || '—')}
        {row('Giá', formatMoney(snap.price))}
        {row('Giá KM', snap.salePrice != null ? formatMoney(snap.salePrice) : '—')}
        {row('Kho', snap.manageStock ? `${snap.stockQuantity} (${STOCK_STATUSES.find((x) => x.value === snap.stockStatus)?.label ?? snap.stockStatus})` : (STOCK_STATUSES.find((x) => x.value === snap.stockStatus)?.label ?? snap.stockStatus))}
        {row('Nổi bật', snap.isFeatured ? 'Có' : 'Không')}
        {row('Danh mục', `${snap.categoryIds?.length ?? 0}`)}
        {row('Ảnh thư viện', `${snap.galleryIds?.length ?? 0}`)}
      </div>
      {snap.variants?.length > 0 && (
        <div>
          <p className="mb-1 text-xs uppercase text-muted-foreground">Biến thể ({snap.variants.length})</p>
          <div className="max-h-48 overflow-y-auto rounded-md border text-xs">
            {snap.variants.map((v, i) => (
              <div key={i} className={`flex items-center justify-between gap-2 px-2 py-1 ${i % 2 ? 'bg-muted/40' : ''} ${v.isActive ? '' : 'opacity-50'}`}>
                <span className="truncate">{Object.values(v.optionValues ?? {}).join(' / ') || v.sku || `#${i + 1}`}</span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(v.salePrice ?? v.price)} · kho {v.stockQuantity}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
