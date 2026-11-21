'use client';

/**
 * AI Studio › Công cụ AI:
 * - Thẻ nhà cung cấp: trạng thái bật / đã có khoá API, số công cụ, nút "Kiểm tra số dư" (GET /admin/ai/providers/:key/balance),
 * - Tab "Công cụ" (GET /admin/ai/tools): tìm + lọc theo nhà cung cấp / nhóm / nhãn / bật-tắt, sắp xếp theo lượt chạy; bật / tắt nhanh, sửa tên, mô tả, nhóm, icon, nhãn, thứ tự, giá tính bằng VND (PUT /admin/ai/tools/:key);
 *   nút thùng rác xoá công cụ kèm model con (DELETE /admin/ai/tools/:key — có lịch sử tác vụ thì API ẩn thay vì xoá dòng);
 *   nút "Đã xoá" mở danh sách công cụ đang ẩn để khôi phục (GET /admin/ai/tools/deleted, POST /admin/ai/tools/:key/restore — hiện lại ở trạng thái tắt).
 * - Nhóm model: công cụ có ô "Model AI" được API tách thành từng model con (`<khoá>~<model>`, giá / bật tắt riêng);
 *   các công cụ cùng "Nhóm model" gộp thành 1 công cụ trên website, khách chọn model ngay trên trang công cụ.
 *   Sửa nhóm từng công cụ trong hộp Sửa, hoặc tích chọn nhiều công cụ rồi bấm "Gộp nhóm model".
 * - Tab "Nhóm & model" (?tab=groups; link cũ ?tab=model-groups cũng mở tab này): cây Nhóm (menu website khách) › Nhóm model —
 *   thêm / sửa / kéo sắp xếp / xoá nhóm, tạo / sửa / tách nhóm model ngay trong thẻ nhóm — xem components/ai/group-tree-tab.tsx.
 * - Tab "Khoá API nhà cung cấp" (?tab=keys): bật nhà cung cấp, nhập khoá API, URL gốc (nhóm cài đặt `ai_<key>`).
 */
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Check, ChevronDown, CircleAlert, Film, FolderTree, KeyRound, Layers, Loader2, Pencil, Percent, Power, PowerOff, RefreshCw, Search, Tag, Trash2, Upload, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { NumberInput } from '@/components/common/number-input';
import { PermissionGate, fmtCount, fmtCredits, useToolCategories } from '@/components/ai/shared';
import { CategoryIcon } from '@/components/ai/categories-tab';
import { GroupTreeTab } from '@/components/ai/group-tree-tab';
import { buildModelGroups } from '@/components/ai/model-groups-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiModelField } from '@/components/ai/api-model-field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';

interface Pricing {
  /** free = miễn phí; tiers = tính giá riêng theo mốc 10–20s và 20–30s; per_second = tự đặt giá mỗi giây; per_char = tự đặt giá mỗi 1.000 ký tự; by_resolution = tự đặt giá từng độ phân giải */
  mode?: 'fixed' | 'cost' | 'free' | 'tiers' | 'per_second' | 'per_char' | 'by_resolution';
  base?: number;
  perUnit?: number;
  resolutionPrices?: Record<string, number>;
  tier10to20?: number;
  tier20to30?: number;
  /** hệ số riêng từng công cụ — không còn dùng (giá theo chi phí NCC nhân tỉ giá chung của nhà cung cấp) */
  multiplier?: number;
  /** % lãi cộng thêm lên giá đã tính */
  markup?: number;
  min?: number;
  /** Bật tự custom giá riêng: không bị ghi đè khi nhà cung cấp bật Tự động cập nhật giá hoặc đổi % tăng giá chung */
  customPrice?: boolean;
}

interface ToolRow {
  id: string;
  key: string;
  provider: string;
  category: string;
  name: string;
  description: string | null;
  icon: string | null;
  badge: string | null;
  enabled: boolean;
  maintenance?: boolean;
  featured: boolean;
  sortOrder: number;
  pricing: Pricing;
  available: boolean;
  output: string | null;
  unitLabel: string | null;
  defaultPricing: Pricing | null;
  supportsCost: boolean;
  supportsDurationTiers?: boolean;
  supportsPerSecond?: boolean;
  supportsPerChar?: boolean;
  resolutionOptions?: { value: string; label: string }[];
  /** tỉ giá quy đổi của nhà cung cấp: 1 đơn vị nguồn = bao nhiêu đồng (VND) */
  rate: number;
  /** tên đơn vị chi phí phía nhà cung cấp (xu, credit SangTao...) */
  costUnit: string | null;
  tasks: number;
  /** tên nhóm model (gộp thành 1 công cụ trên website) và tên model trong nhóm */
  /** Các nhóm model công cụ đang thuộc (một công cụ ở được nhiều nhóm; rỗng = đứng riêng) */
  modelGroups: string[];
  modelLabel: string | null;
  canonicalModel?: string | null;
  demoVideo?: string | null;
  /** công cụ gốc đã tách theo model: số model con (0 = không tách) */
  models: number;
}

/** Giá một lượt (lựa chọn mặc định + mốc so sánh chuẩn) API trả về cho từng công cụ */
interface ToolPrice {
  /** giá khách trả một lượt (VND) */
  credits: number | null;
  providerCost: number | null;
  /** chi phí gốc theo đơn vị nhà cung cấp (credit SangTao, xu...), chưa nhân tỉ giá */
  providerRaw?: number | null;
  /** chi phí gốc chuẩn hoá ngang hàng (720p · 5s/8s cho video) để tự động xếp hạng giữa các nguồn */
  benchCost?: number | null;
  checkedAt?: string;
  error?: string;
}

interface ProviderRow {
  key: string;
  name: string;
  website: string | null;
  defaultBadge?: string;
  enabled: boolean;
  configured: boolean;
  /** tỉ giá quy đổi đang dùng / mặc định của adapter + đơn vị chi phí */
  rate: number;
  defaultRate: number | null;
  costUnit: string | null;
  tools: number;
}

/** Giá đang áp dụng = mặc định trong adapter, ghi đè bởi phần admin đã sửa */
function cleanProviderHost(p: Pick<ProviderRow, 'key' | 'website'>): string {
  const raw = (p.website ?? '').trim();
  if (!raw) return p.key === 'tavtavvideo' ? 'nov.ai.vn' : p.key;
  return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '') || p.key;
}

function formatProviderDomainLabel(p: Pick<ProviderRow, 'key' | 'website' | 'defaultBadge'>): string {
  const host = cleanProviderHost(p);
  return p.defaultBadge ? `${host} (${p.defaultBadge})` : host;
}

function svBadgeNum(badge?: string | null): number {
  const n = Number(String(badge ?? '').replace(/^SV/i, ''));
  return Number.isFinite(n) && n > 0 ? n : 999;
}

function normToolSearchText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[()[\]{}·•–—―\-_/,:;|+~]+/g, ' ')
    .replace(/(?:^|\s)\.+|\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesToolSearch(parts: (string | null | undefined)[], rawQuery: string): boolean {
  const kw = rawQuery.trim().toLowerCase();
  if (!kw) return true;
  for (const p of parts) {
    if (p && p.toLowerCase().includes(kw)) return true;
  }
  const normQ = normToolSearchText(rawQuery);
  if (!normQ) return true;
  const normHay = normToolSearchText(parts.filter(Boolean).join(' '));
  if (normHay.includes(normQ)) return true;
  const tokens = normQ.split(' ').filter(Boolean);
  return tokens.length > 1 && tokens.every((tok) => normHay.includes(tok));
}
const pricingOf = (t: ToolRow): Pricing => ({ ...t.defaultPricing, ...t.pricing });

/** Tỉ giá quy đổi có thể lẻ (12,5 · 1,2) nên không làm tròn như số tiền */
const fmtRate = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });

/** Thành phần giá do admin đặt (giá cơ bản, giá theo đơn vị, tối thiểu) có thể lẻ, vd 0,5đ/ký tự — không làm tròn */
const fmtPrice = (n: number | null | undefined) => `${(Number(n) || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 })}đ`;

/** Mô tả cách tính giá ngắn gọn (kèm % lãi nếu có) */
function pricingLabel(t: ToolRow, p: Pricing = pricingOf(t)) {
  if (p.mode === 'free') return 'Miễn phí';
  const markup = p.markup ? ` +${p.markup}%` : '';
  if (p.mode === 'tiers') {
    return `10–20s: ${fmtPrice(p.tier10to20 ?? p.base)} · 20–30s: ${fmtPrice(p.tier20to30 ?? p.tier10to20 ?? p.base)}${markup}`;
  }
  if (p.mode === 'by_resolution') {
    const opts = t.resolutionOptions ?? [];
    const items = opts.length
      ? opts.map((o) => `${o.value}: ${fmtPrice(p.resolutionPrices?.[o.value])}`)
      : Object.entries(p.resolutionPrices ?? {}).map(([k, v]) => `${k}: ${fmtPrice(v)}`);
    return `${items.join(' · ') || 'Theo độ phân giải'}${markup}`;
  }
  if (p.mode === 'per_second') {
    const res = (t.resolutionOptions ?? []).filter((o) => (p.resolutionPrices?.[o.value] ?? 0) > 0);
    const per = res.length ? res.map((o) => `${o.value}: ${fmtPrice(p.resolutionPrices?.[o.value])}/giây`).join(' · ') : `${fmtPrice(p.perUnit)}/giây`;
    const parts = [p.base ? fmtPrice(p.base) : '', per].filter(Boolean);
    return `${parts.join(' + ')}${markup}`;
  }
  if (p.mode === 'per_char') {
    const parts = [p.base ? fmtPrice(p.base) : '', `${fmtPrice(p.perUnit)}/1.000 ký tự`].filter(Boolean);
    return `${parts.join(' + ')}${markup}`;
  }
  if (p.mode === 'cost') {
    if (!t.provider) return `Theo giá hệ thống${p.base ? ` + ${fmtPrice(p.base)}` : ''}${markup}`;
    return `Chi phí NCC × tỉ giá ${fmtRate(t.rate)}${p.base ? ` + ${fmtPrice(p.base)}` : ''}${markup}`;
  }
  const parts = [p.base ? fmtPrice(p.base) : '', p.perUnit ? `${fmtPrice(p.perUnit)}/${t.unitLabel ?? 'đơn vị'}` : ''].filter(Boolean);
  return `${parts.join(' + ') || '0đ'}${markup}`;
}

// giá trị mặc định của bộ lọc tab Công cụ (không ghi lên URL)
const FILTER_DEFAULT = { search: '', provider: 'all', category: 'all', group: 'all', badge: 'all', status: 'all', priceEval: 'all', runPeriod: 'all', from: '', to: '', sort: 'default' };

type PriceEvalLevel = 'free' | 'unique' | 'best' | 'good' | 'lv1' | 'lv2' | 'lv3';

interface PriceEvalInfo {
  level: PriceEvalLevel;
  familyKey: string;
  familyLabel: string;
  myCost: number;
  minCost: number;
  ratio: number;
  rank: number;
  total: number;
  bestBadge: string;
  badgeText: string;
  noteText: string;
  tooltip: string;
}

/** Chuẩn hoá tự động mọi tên sản phẩm / model mới trong tương lai về mã dòng model chung (không phụ thuộc tiền tố SV/provider) */
function autoNormalizeFutureModel(t: ToolRow, scope: string, scopeLabel: string): { key: string; label: string } {
  const cleanTitle = (s: string) =>
    s
      .split(/\s[·•|]\s|\s[-–—]\s|\s?\(/)[0]
      .replace(/\b(sv\d+|4k|2k|1k|1080p|720p|480p|sieu\s*re|siêu\s*rẻ|gia\s*re|giá\s*rẻ|khuyen\s*dung|khuyên\s*dùng|sieu\s*net|siêu\s*nét|toc\s*do\s*cao|tốc\s*độ\s*cao)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

  const rawCanonical = (t.canonicalModel || '')
    .toLowerCase()
    .split('/')[0]
    .replace(/-(video|image|ai|studio|cheap|lowcost|sieu-re|gia-re)$/g, '')
    .trim();

  const rawLabel = cleanTitle(t.modelLabel || t.name || t.key.replace(/^[^.]+\./, '').replace(/~/g, ' '));
  const slugSource = rawCanonical || rawLabel;
  const slug = slugSource
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/([a-z])[_\-\s]+(\d+)[_\-](\d+)/g, '$1-$2.$3')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^(tao-va-ghep-anh|tao-ghep-anh|tao-anh|chinh-sua-anh|sua-anh|tao-video|cong-cu)-/, '')
    .replace(/-(video|image|ai|studio|4k|2k|1080p|720p|sieu-re|gia-re|khuyen-dung)+$/g, '')
    .replace(/-(\d+)$/, (full, num) => (Number(num) >= 2 && Number(num) <= 9 && !rawLabel.endsWith(` ${num}`) ? '' : full))
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  const finalSlug = slug || t.key.replace(/^[^.]+\./, '').toLowerCase();
  const display = rawLabel || t.modelLabel || t.name;
  return {
    key: `${scope}:${finalSlug}`,
    label: scope === 'vid' ? display : `${scopeLabel} · ${display}`,
  };
}

/** Phân loại chuẩn dòng model + tác vụ để tự động so sánh ngang hàng mọi nhà cung cấp hiện tại & tương lai (T-457 / T-468) */
function classifyComparableModel(t: ToolRow): { key: string; label: string } {
  const hay = `${t.canonicalModel ?? ''} ${t.key} ${t.modelLabel ?? ''} ${t.name} ${t.modelGroups.join(' ')}`.toLowerCase();
  const p = pricingOf(t);
  const normVer = (v: string) => v.replace(/[_-]/g, '.');

  // 1. Xác định nhánh tác vụ (tránh so nhầm Tạo ảnh với Sửa ảnh / Video với Upscale / Motion ≤10s với >10s)
  let scope = 'img';
  let scopeLabel = 'Tạo ảnh';
  if (t.category === 'chinh-sua-anh-ai' || /\/edit\b|\.(edit|image-edit)\b|chỉnh sửa ảnh|sửa\s*&?\s*ghép ảnh|grok-edit/i.test(hay)) {
    if (/upscale|làm nét ảnh|tăng nét/i.test(hay)) {
      return { key: 'img-upscale:4k', label: 'Làm nét ảnh 4K' };
    }
    scope = 'img-edit';
    scopeLabel = 'Sửa ảnh';
  } else if (t.output === 'image' && /upscale|làm nét ảnh|tăng nét/i.test(hay)) {
    return { key: 'img-upscale:4k', label: 'Làm nét ảnh 4K' };
  } else if (t.output !== 'image' && /upscale|nâng cấp video|làm nét video|up4k|runup/i.test(hay)) {
    return { key: 'vid-upscale:4k', label: 'Upscale Video 4K' };
  } else if (
    p.mode === 'tiers' ||
    (/motion[-\s_]?control|chuyển động mẫu|vae motion|\bmotion\b/i.test(hay) &&
      /trên\s*10\s*s|10–20s|20–30s|\b(15|20|25|30)\s*s\b/i.test(hay))
  ) {
    const mv = /motion.*?(\d+[._-]\d+)|(\d+[._-]\d+).*?motion/i.exec(hay);
    const ver = mv ? normVer(mv[1] || mv[2]) : '2.6';
    return { key: `motion-long:${ver}`, label: `Motion Control ${ver} (>10s)` };
  } else if (/motion[-\s_]?control|chuyển động mẫu|vae motion|\bmotion\b/i.test(hay)) {
    const mv = /motion.*?(\d+[._-]\d+)|(\d+[._-]\d+).*?motion/i.exec(hay);
    const ver = mv ? normVer(mv[1] || mv[2]) : '2.6';
    return { key: `motion:${ver}`, label: `Motion Control ${ver} (≤10s)` };
  } else if (/genjutsu|thay nhân vật/i.test(hay)) {
    return { key: 'video:genjutsu', label: 'Thay nhân vật Video' };
  } else if (/avatar|lipsync|lip-sync|heygen|omnihuman/i.test(hay)) {
    return { key: 'video:avatar', label: 'Avatar / LipSync' };
  } else if (t.category === 'audio' || /suno|lyria|udio|tạo bài hát|tạo nhạc/i.test(hay)) {
    return { key: 'audio:music', label: 'Tạo nhạc AI' };
  } else if (t.output === 'audio' || t.category === 'voice' || t.category === 'giong-noi-ai' || /\btts\b|giọng đọc|nhân bản giọng|voice/i.test(hay)) {
    if (/clone|nhân bản/i.test(hay)) return { key: 'tts:clone', label: 'Nhân bản giọng AI' };
    if (/\bsrt\b|phụ đề/i.test(hay)) return { key: 'tts:srt', label: 'Lồng tiếng SRT' };
    return { key: 'tts:std', label: 'Giọng đọc AI (TTS)' };
  } else if (t.output === 'text') {
    if (/translate|dịch/i.test(hay)) return { key: 'text:translate', label: 'Dịch văn bản AI' };
    if (/summarize|tóm tắt/i.test(hay)) return { key: 'text:summarize', label: 'Tóm tắt văn bản AI' };
    if (/write|viết/i.test(hay)) return { key: 'text:write', label: 'Viết nội dung AI' };
    return { key: 'text:chat', label: 'Chat / Hỏi đáp AI' };
  } else if (t.output === 'video' || t.category === 'video') {
    scope = 'vid';
    scopeLabel = 'Video';
  }

  // 2. Nhận diện động theo họ model + số phiên bản (hỗ trợ tự động cả các đời mới trong tương lai như Seedance 3.0, Veo 4, Kling 5.0, GPT Image 3.0...)
  if (scope === 'vid') {
    const sd = /seedance[-\s_]*(\d+(?:[._-]\d+)?)(?:[-\s_]*(flash|mini|fast|lite|draft))?/i.exec(hay);
    if (sd) {
      const ver = normVer(sd[1]);
      const sub = sd[2] ? (sd[2].toLowerCase() === 'fast' ? 'mini' : sd[2].toLowerCase()) : '';
      const subLbl = sub === 'flash' ? ' Flash' : sub === 'mini' ? ' Mini/Fast' : sub ? ` ${sub.toUpperCase()}` : '';
      return { key: `vid:seedance-${ver}${sub ? `-${sub}` : ''}`, label: `Seedance ${ver}${subLbl}` };
    }
    if (/seedance/i.test(hay)) return { key: 'vid:seedance-2.0', label: 'Seedance 2.0' };

    const omni = /omni[-\s_]*(?:flash[-\s_]*)?(\d+(?:[._-]\d+)?)|veo_omni(\d+)/i.exec(hay);
    if (omni) {
      const rawV = omni[1] ? normVer(omni[1]) : omni[2] === '12' ? '1.2' : omni[2];
      const ver = rawV === '1.1' ? '1.0' : rawV;
      return { key: `vid:omni-${ver}`, label: `Google Omni Flash ${rawV === '1.0' ? '1.0/1.1' : rawV}` };
    }
    if (/omni[-\s_]*flash/i.test(hay)) return { key: 'vid:omni-1.0', label: 'Google Omni Flash 1.0/1.1' };

    const veo = /veo[-\s_]*(\d+(?:[._-]\d+)?)(?:[-\s_]*(relaxed|lite|fast|ultra))?/i.exec(hay);
    if (veo) {
      const ver = normVer(veo[1]);
      const tier = veo[2] && /relaxed|lite/i.test(veo[2]) ? 'lite' : 'fast';
      return {
        key: `vid:veo-${ver}-${tier}`,
        label: tier === 'lite' ? `Veo ${ver} Relaxed/Lite` : `Veo ${ver} / Fast`,
      };
    }

    const kling = /kling[-\s_]*(?:video[-\s_]*)?(?:v)?(\d+(?:[._-]\d+)?)/i.exec(hay);
    if (kling) {
      const major = normVer(kling[1]).split('.')[0];
      const ver = Number(major) >= 3 ? `${major}.0` : '2.x';
      return { key: `vid:kling-${ver}`, label: `Kling ${ver} Video` };
    }
    if (/kling/i.test(hay)) return { key: 'vid:kling-2.x', label: 'Kling 2.5 / 2.6 Video' };

    const wan = /\bwan[-\s_]*(\d+(?:[._-]\d+)?)/i.exec(hay);
    if (wan) {
      const major = normVer(wan[1]).split('.')[0];
      return { key: `vid:wan-${major}`, label: `Wan ${major}.0 Video` };
    }
    const fluxV = /flux[-\s_]*(\d+(?:[._-]\d+)?)/i.exec(hay);
    if (fluxV) return { key: `vid:flux-${normVer(fluxV[1])}`, label: `FLUX ${normVer(fluxV[1])} Video` };

    const mm = /minimax[-\s_]*(h\d+)|hailuo[-\s_]*(\d+(?:[._-]\d+)?)/i.exec(hay);
    if (mm) {
      const tag = (mm[1] || `hailuo-${normVer(mm[2])}`).toUpperCase();
      return { key: `vid:minimax-${tag.toLowerCase()}`, label: `MiniMax ${tag}` };
    }
    if (/minimax|hailuo/i.test(hay)) return { key: 'vid:minimax-h3', label: 'MiniMax H3 / Hailuo' };

    const grokV = /grok(?:[-\s_]*(?:imagine[-\s_]*)?(?:video[-\s_]*)?(\d+(?:[._-]\d+)?))?/i.exec(hay);
    if (grokV && /grok/i.test(hay)) {
      const ver = grokV[1] ? normVer(grokV[1]) : '1.5';
      return { key: `vid:grok-${ver}`, label: `Grok Video ${ver}` };
    }
    if (/muse|ahiep\.video/i.test(hay)) return { key: 'vid:muse', label: 'Muse Video' };
    if (/ảnh\s*thành\s*video|văn\s*bản\s*thành\s*video/i.test(hay) || t.modelGroups.some((g) => /gemini\s*video/i.test(g))) {
      return { key: 'vid:veo-3.1-lite', label: 'Veo 3.1 Relaxed/Lite' };
    }

    // Tự động chuẩn hoá cho mọi dòng video mới trong tương lai (Sora 2, PixVerse V6, Runway Gen 5, Luma Ray 3, Happy Horse, Vidu...)
    return autoNormalizeFutureModel(t, scope, scopeLabel);
  }

  // Tạo ảnh & Sửa ảnh (tự động bắt phiên bản mới tương lai)
  const gpt = /gpt[-\s_]*(?:image[-\s_]*)?(\d+(?:[._-]\d+)?)/i.exec(hay);
  if (gpt) {
    const ver = normVer(gpt[1]).includes('.') ? normVer(gpt[1]) : `${normVer(gpt[1])}.0`;
    return { key: `${scope}:gpt-${ver}`, label: `${scopeLabel} · GPT Image ${ver}` };
  }
  if (/gpt[-\s_]*image/i.test(hay)) return { key: `${scope}:gpt-2.0`, label: `${scopeLabel} · GPT Image 2.0` };

  if (/nano[-\s_]*banana[-\s_]*pro|gemini[-\s_]*3[-\s_]*pro/i.test(hay)) return { key: `${scope}:banana-pro`, label: `${scopeLabel} · Nano Banana Pro` };
  if (/nano[-\s_]*banana[-\s_]*2[._-]1/i.test(hay)) return { key: `${scope}:banana-2.1`, label: `${scopeLabel} · Nano Banana 2.1` };
  if (/nano[-\s_]*banana[-\s_]*\d*[-\s_]*lite|flash[-\s_]*lite/i.test(hay)) return { key: `${scope}:banana-lite`, label: `${scopeLabel} · Nano Banana Lite` };
  if (/nano[-\s_]*banana|gemini[-\s_]*(?:image|3[._-]1[-\s_]*flash)/i.test(hay)) return { key: `${scope}:banana-2`, label: `${scopeLabel} · Gemini / Nano Banana 2` };

  const sdr = /seedream[-\s_]*(?:v)?(\d+(?:[._-]\d+)?)/i.exec(hay);
  if (sdr) {
    const ver = normVer(sdr[1]);
    const bucket = ver.startsWith('4') ? '5.0' : ver;
    return { key: `${scope}:seedream-${bucket}`, label: `${scopeLabel} · Seedream ${bucket === '5.0' ? '5.0/4.x' : bucket}` };
  }
  if (/seedream/i.test(hay)) return { key: `${scope}:seedream-5.0`, label: `${scopeLabel} · Seedream 5.0/4.x` };

  if (/grok/i.test(hay)) return { key: `${scope}:grok-img`, label: `${scopeLabel} · Grok Image` };
  if (/kling/i.test(hay)) return { key: `${scope}:kling-img`, label: `${scopeLabel} · Kling Omni Image` };
  const fluxI = /flux[-\s_]*(\d+(?:[._-]\d+)?)?/i.exec(hay);
  if (fluxI && /flux/i.test(hay)) {
    const ver = fluxI[1] ? normVer(fluxI[1]).split('.')[0] : '';
    return { key: `${scope}:flux-img${ver ? `-${ver}` : ''}`, label: `${scopeLabel} · Flux${ver ? ` ${ver}` : ''} Image` };
  }
  if (/muse/i.test(hay)) return { key: `${scope}:muse-img`, label: `${scopeLabel} · Muse Image` };
  if (/z[-\s_]*image/i.test(hay)) return { key: `${scope}:z-image`, label: `${scopeLabel} · Z-Image` };

  // Tự động gom chuẩn mọi dòng sản phẩm tạo/sửa ảnh tương lai (Ideogram, Recraft, Midjourney, Qwen, Luma UNI...) mà không cần sửa code
  return autoNormalizeFutureModel(t, scope, scopeLabel);
}

function comparableVndOf(t: ToolRow, tp: ToolPrice | undefined): number | null {
  if (!tp || tp.credits === null || !Number.isFinite(tp.credits)) return null;
  if (tp.credits <= 0) return 0;
  if (tp.benchCost !== undefined && tp.benchCost !== null && Number.isFinite(tp.benchCost) && tp.benchCost > 0) {
    return Math.round(tp.benchCost * 100) / 100;
  }
  if (tp.providerCost !== null && Number.isFinite(tp.providerCost) && tp.providerCost > 0) {
    return Math.round(tp.providerCost * 100) / 100;
  }
  const mk = Math.max(0, Number(pricingOf(t).markup) || 0);
  return Math.round((tp.credits / (1 + mk / 100)) * 100) / 100;
}

interface ToolRunStatItem {
  runs: number;
  succeeded: number;
  refunded: number;
  revenue: number;
}

interface ToolRunStatsResponse {
  from: string;
  to: string;
  totals: ToolRunStatItem;
  byTool: Record<string, ToolRunStatItem>;
}

const vnTodayIso = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const fmtViDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-');
  return y && m && d ? `${d}/${m}/${y}` : ymd;
};

export default function AiToolsPage() {
  // useSearchParams cần Suspense khi build
  return (
    <Suspense>
      <AiToolsContent />
    </Suspense>
  );
}

function AiToolsContent() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // ?tab=keys cũ chuyển thẳng sang menu chuyên biệt Nhà cung cấp API (/ai/providers)
  const rawTab = sp.get('tab') === 'model-groups' ? 'groups' : (sp.get('tab') ?? '');
  const tab = rawTab === 'groups' ? 'groups' : 'tools';
  const goTab = (t: string) => router.replace(t === 'tools' ? pathname : `${pathname}?tab=${t}`, { scroll: false });
  const [editing, setEditing] = useState<ToolRow | null>(null);
  const [bulkPricing, setBulkPricing] = useState(false);
  const [bulkBadge, setBulkBadge] = useState(false);
  const [bulkGroup, setBulkGroup] = useState(false);
  const [demoTargets, setDemoTargets] = useState<ToolRow[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  // khoá (`key`, cũng là id dòng của DataTable) các công cụ đang tích chọn để sửa giá nhanh (không chọn gì thì sửa theo bộ lọc)
  const [selected, setSelected] = useState<string[]>([]);
  // Tự động đồng bộ liên tục danh sách sản phẩm mới & giá gốc mới nhất từ các nhà cung cấp mỗi 60 giây + ngay khi quay lại tab (T-457 / T-468)
  const q = useQuery({
    queryKey: ['ai-tools'],
    queryFn: () => api.get<{ hideProviders?: boolean; providers: ProviderRow[]; tools: ToolRow[] }>('/admin/ai/tools'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  // Giá một lượt & giá vốn chuẩn hoá theo bảng giá live mới nhất của từng nhà cung cấp (tự động cập nhật liên tục mỗi 60 giây)
  const prices = useQuery({
    queryKey: ['ai-tools', 'prices'],
    queryFn: () => api.get<Record<string, ToolPrice>>('/admin/ai/tools/prices'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const refreshLivePrices = useMutation({
    mutationFn: async () => {
      const [toolsRes, freshPrices] = await Promise.all([
        api.get<{ hideProviders?: boolean; providers: ProviderRow[]; tools: ToolRow[] }>('/admin/ai/tools'),
        api.get<Record<string, ToolPrice>>('/admin/ai/tools/prices', { fresh: '1' }),
      ]);
      qc.setQueryData(['ai-tools'], toolsRes);
      qc.setQueryData(['ai-tools', 'prices'], freshPrices);
      return freshPrices;
    },
    onSuccess: () => toast.success('Đã quét trực tiếp bảng giá mới nhất từ toàn bộ nhà cung cấp và cập nhật lại nhận định giá'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (r: { key: string; enabled: boolean }) => api.put(`/admin/ai/tools/${encodeURIComponent(r.key)}`, { enabled: r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleMaintenance = useMutation({
    mutationFn: (r: { key: string; maintenance: boolean }) => api.put(`/admin/ai/tools/${encodeURIComponent(r.key)}`, { maintenance: r.maintenance }),
    onSuccess: (_d, r) => {
      toast.success(r.maintenance ? 'Đã chuyển gói sang chế độ Đang bảo trì' : 'Đã tắt bảo trì — mở tạo lại bình thường');
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const bulkMaintenance = useMutation({
    mutationFn: (r: { keys: string[]; maintenance: boolean }) => api.put<{ updated: number }>('/admin/ai/tools/maintenance', r),
    onSuccess: (res, r) => {
      toast.success(
        r.maintenance
          ? `Đã chuyển ${res.updated} dịch vụ sang chế độ Đang bảo trì`
          : `Đã tắt bảo trì cho ${res.updated} dịch vụ`,
      );
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const bulkEnabled = useMutation({
    mutationFn: async (r: { keys: string[]; enabled: boolean }) => {
      const chunk = 10;
      for (let i = 0; i < r.keys.length; i += chunk) {
        await Promise.all(
          r.keys.slice(i, i + chunk).map((k) => api.put(`/admin/ai/tools/${encodeURIComponent(k)}`, { enabled: r.enabled })),
        );
      }
      return { updated: r.keys.length };
    },
    onSuccess: (res, r) => {
      toast.success(r.enabled ? `Đã bật ${res.updated} công cụ / model đã chọn` : `Đã tắt ${res.updated} công cụ / model đã chọn`);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/admin/ai/tools/${encodeURIComponent(key)}`),
    onSuccess: (_d, key) => {
      toast.success('Đã xoá công cụ');
      setEditing((cur) => (cur && (cur.key === key || cur.key.startsWith(`${key}~`)) ? null : cur));
      setSelected((s) => s.filter((k) => k !== key && !k.startsWith(`${key}~`)));
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askRemove = async (r: ToolRow) => {
    const extra = r.models ? ` và ${r.models} model con` : '';
    const history = r.tasks ? ` Công cụ đã có ${fmtCount(r.tasks)} lượt chạy: lịch sử tác vụ của khách vẫn được giữ.` : '';
    if (await confirm({ title: `Xoá công cụ "${r.name}"?`, description: `Công cụ${extra} sẽ bị tắt và biến mất khỏi website lẫn trang quản trị (khôi phục lại ở nút "Đã xoá").${history}`, destructive: true, confirmText: 'Xoá' })) remove.mutate(r.key);
  };
  const bulkRemove = useMutation({
    mutationFn: async (keys: string[]) => {
      // Nếu đã chọn cả công cụ cha thì bỏ qua model con `<cha>~<con>` để không gọi xoá trùng
      const keySet = new Set(keys);
      const deduped = keys.filter((k) => {
        const sep = k.indexOf('~');
        return sep === -1 || !keySet.has(k.slice(0, sep));
      });
      const chunk = 10;
      for (let i = 0; i < deduped.length; i += chunk) {
        await Promise.all(
          deduped.slice(i, i + chunk).map((k) => api.delete(`/admin/ai/tools/${encodeURIComponent(k)}`)),
        );
      }
      return { count: keys.length };
    },
    onSuccess: (res, keys) => {
      toast.success(`Đã xoá ${res.count} công cụ / model đã chọn`);
      const removedSet = new Set(keys);
      setEditing((cur) => {
        if (!cur) return null;
        const base = cur.key.split('~')[0];
        return removedSet.has(cur.key) || removedSet.has(base) ? null : cur;
      });
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askBulkRemove = async () => {
    if (!selected.length) return;
    const selRows = (q.data?.tools ?? []).filter((t) => selected.includes(t.key));
    const totalRuns = selRows.reduce((s, r) => s + (r.tasks || 0), 0);
    const historyNote = totalRuns > 0 ? ` Tổng ${fmtCount(totalRuns)} lượt chạy lịch sử của khách vẫn được giữ nguyên.` : '';
    if (
      await confirm({
        title: `Xoá ${selected.length} công cụ đã chọn?`,
        description: `${selected.length} công cụ đã chọn (kèm các model con nếu có) sẽ bị tắt và biến mất khỏi website lẫn trang quản trị (luôn khôi phục lại được ở nút "Đã xoá").${historyNote}`,
        destructive: true,
        confirmText: `Xoá (${selected.length})`,
      })
    ) {
      bulkRemove.mutate(selected);
    }
  };
  const hideProviders = !!q.data?.hideProviders;
  const providers = q.data?.providers ?? [];
  const name = (k: string) => {
    const p = providers.find((x) => x.key === k);
    return p ? formatProviderDomainLabel(p) : k;
  };
  useEffect(() => {
    if (rawTab === 'keys') {
      router.replace(hideProviders ? '/ai/tools' : '/ai/providers');
    }
  }, [rawTab, hideProviders, router]);

  // bộ lọc + sắp xếp: danh sách công cụ ít và đã tải hết nên lọc ngay ở trình duyệt.
  // Giá trị lọc lưu trên URL (?q=&provider=&category=&badge=&status=&sort=) để F5 / gửi link vẫn giữ nguyên bộ lọc;
  // giá trị mặc định không ghi lên URL cho gọn.
  const filter = useMemo(
    () => ({
      search: sp.get('q') ?? FILTER_DEFAULT.search,
      provider: sp.get('provider') ?? FILTER_DEFAULT.provider,
      category: sp.get('category') ?? FILTER_DEFAULT.category,
      group: sp.get('group') ?? FILTER_DEFAULT.group,
      badge: sp.get('badge') ?? FILTER_DEFAULT.badge,
      status: sp.get('status') ?? FILTER_DEFAULT.status,
      priceEval: sp.get('priceEval') ?? FILTER_DEFAULT.priceEval,
      runPeriod: sp.get('runPeriod') ?? FILTER_DEFAULT.runPeriod,
      from: sp.get('from') ?? FILTER_DEFAULT.from,
      to: sp.get('to') ?? FILTER_DEFAULT.to,
      sort: sp.get('sort') ?? FILTER_DEFAULT.sort,
    }),
    [sp],
  );
  const setF = (patch: Partial<typeof filter>) => {
    const next = { ...filter, ...patch };
    const params = new URLSearchParams(sp.toString());
    (Object.keys(FILTER_DEFAULT) as (keyof typeof FILTER_DEFAULT)[]).forEach((k) => {
      const param = k === 'search' ? 'q' : k;
      const v = k === 'search' ? next[k].trim() : next[k];
      if (v && v !== FILTER_DEFAULT[k]) params.set(param, v);
      else params.delete(param);
    });
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // ListToolbar tự giữ chữ trong ô tìm kiếm -> đổi key để ô được tạo lại (xoá chữ) khi bấm "Xoá lọc".
  // URL cập nhật bất đồng bộ nên chỉ tạo lại ô sau khi `q` đã mất khỏi URL (nếu tạo ngay, ô lấy lại từ khoá cũ).
  const [resetKey, setResetKey] = useState(0);
  const pendingClear = useRef(false);
  useEffect(() => {
    if (pendingClear.current && !filter.search) {
      pendingClear.current = false;
      setResetKey((k) => k + 1);
    }
  }, [filter.search]);
  const clearFilter = () => {
    pendingClear.current = !!filter.search;
    setF(FILTER_DEFAULT);
  };
  const runStatsEnabled = filter.runPeriod !== 'all';
  const runStats = useQuery({
    queryKey: ['ai-tools', 'run-stats', filter.runPeriod, filter.from, filter.to],
    queryFn: () =>
      api.get<ToolRunStatsResponse>('/admin/ai/tools/run-stats', {
        period: filter.runPeriod,
        ...(filter.runPeriod === 'custom'
          ? {
              from: filter.from || vnTodayIso(),
              to: filter.to || filter.from || vnTodayIso(),
            }
          : {}),
      }),
    enabled: runStatsEnabled,
  });
  const statOfTool = useMemo(() => {
    const map = runStats.data?.byTool;
    if (!runStatsEnabled || !map) return null;
    return (r: ToolRow): ToolRunStatItem => {
      const direct = map[r.key];
      if (r.models > 0) {
        const prefix = `${r.key}~`;
        let runs = direct?.runs ?? 0;
        let succeeded = direct?.succeeded ?? 0;
        let refunded = direct?.refunded ?? 0;
        let revenue = direct?.revenue ?? 0;
        for (const [k, v] of Object.entries(map)) {
          if (k.startsWith(prefix)) {
            runs += v.runs;
            succeeded += v.succeeded;
            refunded += v.refunded;
            revenue += v.revenue;
          }
        }
        return { runs, succeeded, refunded, revenue };
      }
      return direct ?? { runs: 0, succeeded: 0, refunded: 0, revenue: 0 };
    };
  }, [runStatsEnabled, runStats.data]);

  // Tính bảng so sánh & nhận định mức giá gốc giữa tất cả các nhà cung cấp trong cùng 1 phân loại model (T-457)
  const priceEvalMap = useMemo(() => {
    const out = new Map<string, PriceEvalInfo>();
    if (hideProviders || !q.data?.tools?.length || !prices.data) return out;

    const provBadge = new Map(providers.map((p) => [p.key, p.defaultBadge || p.key.toUpperCase()]));
    const provActive = new Map(providers.map((p) => [p.key, p.enabled && p.configured]));

    type Entry = { tool: ToolRow; cost: number; sv: string; activeProv: boolean; fam: { key: string; label: string } };
    const byFamily = new Map<string, Entry[]>();

    for (const t of q.data.tools) {
      if (!t.available) continue;
      if (t.models > 0 && !t.key.includes('~')) continue;
      const p = pricingOf(t);
      const tp = prices.data[t.key];
      if (p.mode === 'free' || tp?.credits === 0) {
        out.set(t.key, {
          level: 'free',
          familyKey: 'free',
          familyLabel: 'Miễn phí',
          myCost: 0,
          minCost: 0,
          ratio: 1,
          rank: 1,
          total: 1,
          bestBadge: provBadge.get(t.provider) ?? t.provider,
          badgeText: 'Miễn phí (0đ)',
          noteText: 'Tiện ích miễn phí giữ chân khách',
          tooltip: 'Công cụ miễn phí 0đ',
        });
        continue;
      }
      const c = comparableVndOf(t, tp);
      if (c === null || c <= 0) continue;
      const fam = classifyComparableModel(t);
      const entry: Entry = {
        tool: t,
        cost: c,
        sv: provBadge.get(t.provider) ?? t.provider,
        activeProv: provActive.get(t.provider) ?? true,
        fam,
      };
      byFamily.set(fam.key, [...(byFamily.get(fam.key) ?? []), entry]);
    }

    const fmtShort = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

    for (const entries of byFamily.values()) {
      entries.sort((a, b) => a.cost - b.cost || Number(b.tool.enabled) - Number(a.tool.enabled));
      const total = entries.length;
      if (total === 1) {
        const only = entries[0];
        out.set(only.tool.key, {
          level: 'unique',
          familyKey: only.fam.key,
          familyLabel: only.fam.label,
          myCost: only.cost,
          minCost: only.cost,
          ratio: 1,
          rank: 1,
          total: 1,
          bestBadge: only.sv,
          badgeText: '1 nguồn duy nhất',
          noteText: `${only.fam.label} · Chưa trùng SV khác`,
          tooltip: `[${only.fam.label}] Chỉ có duy nhất trên ${only.sv} (${fmtShort(only.cost)})`,
        });
        continue;
      }

      // Ưu tiên lấy mốc rẻ nhất từ nguồn API đang bật để nguồn đã tắt không làm lệch chuẩn so sánh
      const activePool = entries.filter((e) => e.activeProv);
      const bench = (activePool.length > 0 ? activePool : entries)[0];
      const minCost = bench.cost;
      const leaderboard = entries
        .map((e, idx) => `${idx + 1}. ${e.sv}: ${fmtShort(e.cost)}${e.tool.enabled ? '' : ' (ẩn)'}`)
        .join(' · ');

      entries.forEach((e, idx) => {
        const rank = idx + 1;
        const ratio = minCost > 0 ? e.cost / minCost : 1;
        const pct = Math.max(1, Math.round((ratio - 1) * 100));
        const mult = ratio >= 10 ? Math.round(ratio).toString() : ratio.toFixed(1).replace(/\.0$/, '');
        const tooltip = `Phân loại [${e.fam.label}] (${total} gói): ${leaderboard}`;

        if (ratio <= 1.05) {
          out.set(e.tool.key, {
            level: 'best',
            familyKey: e.fam.key,
            familyLabel: e.fam.label,
            myCost: e.cost,
            minCost,
            ratio,
            rank,
            total,
            bestBadge: bench.sv,
            badgeText: `★ Rẻ nhất (${rank}/${total})`,
            noteText: e.tool.enabled ? `${e.fam.label} · Giữ bật chính` : `${e.fam.label} · Rẻ nhất, cân nhắc bật!`,
            tooltip,
          });
        } else if (ratio <= 1.35) {
          out.set(e.tool.key, {
            level: 'good',
            familyKey: e.fam.key,
            familyLabel: e.fam.label,
            myCost: e.cost,
            minCost,
            ratio,
            rank,
            total,
            bestBadge: bench.sv,
            badgeText: `Hợp lý +${pct}% (${rank}/${total})`,
            noteText: `Giữ dự phòng (rẻ nhất: ${bench.sv} ${fmtShort(minCost)})`,
            tooltip,
          });
        } else if (ratio <= 1.85) {
          out.set(e.tool.key, {
            level: 'lv1',
            familyKey: e.fam.key,
            familyLabel: e.fam.label,
            myCost: e.cost,
            minCost,
            ratio,
            rank,
            total,
            bestBadge: bench.sv,
            badgeText: `Đắt mức 1 · +${pct}% (${rank}/${total})`,
            noteText: e.tool.enabled
              ? `Cân nhắc ẩn bớt (${bench.sv} chỉ ${fmtShort(minCost)})`
              : `Đã ẩn · Đắt hơn ${bench.sv} (${fmtShort(minCost)})`,
            tooltip,
          });
        } else if (ratio <= 3.0) {
          out.set(e.tool.key, {
            level: 'lv2',
            familyKey: e.fam.key,
            familyLabel: e.fam.label,
            myCost: e.cost,
            minCost,
            ratio,
            rank,
            total,
            bestBadge: bench.sv,
            badgeText: `Đắt mức 2 · gấp ${mult}x (${rank}/${total})`,
            noteText: e.tool.enabled
              ? `Nên ẩn đỡ loãng (${bench.sv} chỉ ${fmtShort(minCost)})`
              : `Đã ẩn hợp lý (${bench.sv} chỉ ${fmtShort(minCost)})`,
            tooltip,
          });
        } else {
          out.set(e.tool.key, {
            level: 'lv3',
            familyKey: e.fam.key,
            familyLabel: e.fam.label,
            myCost: e.cost,
            minCost,
            ratio,
            rank,
            total,
            bestBadge: bench.sv,
            badgeText: `Đắt mức 3 · gấp ${mult}x (${rank}/${total})`,
            noteText: e.tool.enabled
              ? `Khuyên ẩn ngay! (${bench.sv} chỉ ${fmtShort(minCost)})`
              : `Đã ẩn ✓ (đắt gấp ${mult}x ${bench.sv})`,
            tooltip,
          });
        }
      });
    }

    return out;
  }, [hideProviders, q.data?.tools, prices.data, providers]);

  const filtered = useMemo(() => {
    const rawSearch = filter.search.trim();
    const list = (q.data?.tools ?? []).filter(
      (t) =>
        (!rawSearch ||
          matchesToolSearch(
            [
              t.name,
              t.modelLabel,
              t.badge,
              t.key,
              t.canonicalModel,
              t.description,
              !hideProviders ? name(t.provider) : '',
              !hideProviders ? t.provider : '',
              ...t.modelGroups,
            ],
            rawSearch,
          )) &&
        (filter.provider === 'all' || t.provider === filter.provider) &&
        (filter.category === 'all' || t.category === filter.category) &&
        // nhóm model: 'none' = công cụ đứng riêng
        (filter.group === 'all' || (filter.group === 'none' ? !t.modelGroups.length : t.modelGroups.includes(filter.group))) &&
        // nhãn: 'all' = mọi công cụ, 'none' = công cụ không gắn nhãn, còn lại so khớp đúng nhãn
        (filter.badge === 'all' || (filter.badge === 'none' ? !t.badge : t.badge === filter.badge)) &&
        (filter.priceEval === 'all' ||
          (() => {
            const ev = priceEvalMap.get(t.key);
            if (!ev) return false;
            if (filter.priceEval === 'expensive_on') return t.enabled && (ev.level === 'lv1' || ev.level === 'lv2' || ev.level === 'lv3');
            if (filter.priceEval === 'expensive_all') return ev.level === 'lv1' || ev.level === 'lv2' || ev.level === 'lv3';
            return ev.level === filter.priceEval;
          })()) &&
        (filter.status === 'all' ||
          (filter.status === 'maintenance'
            ? !!t.maintenance
            : filter.status === 'hasDemo'
              ? !!t.demoVideo
              : filter.status === 'noDemo'
                ? !t.demoVideo
                : t.enabled === (filter.status === 'on'))),
    );
    const runsOf = (t: ToolRow) => (statOfTool ? statOfTool(t).runs : t.tasks);
    // sắp xếp theo lượt chạy (theo kỳ đang lọc hoặc toàn thời gian); "mặc định" giữ thứ tự API trả về
    if (filter.sort === 'most') list.sort((a, b) => runsOf(b) - runsOf(a));
    if (filter.sort === 'least') list.sort((a, b) => runsOf(a) - runsOf(b));
    // sắp xếp theo giá / lượt (giá khách trả với lựa chọn mặc định); công cụ chưa tính được giá luôn xếp cuối
    if (filter.sort === 'priceHigh' || filter.sort === 'priceLow') {
      const dir = filter.sort === 'priceHigh' ? -1 : 1;
      const priceOf = (key: string) => prices.data?.[key]?.credits ?? null;
      list.sort((a, b) => {
        const pa = priceOf(a.key);
        const pb = priceOf(b.key);
        if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1;
        return (pa - pb) * dir;
      });
    }
    return list.map((t) => ({ ...t, id: t.key }));
  }, [q.data, prices.data, filter, statOfTool, priceEvalMap]);
  // danh sách nhóm admin quản lý (tab Nhóm & model); bộ lọc chỉ liệt kê nhóm đang có công cụ
  const cats = useToolCategories();
  const catOf = (key: string) => cats.data?.find((c) => c.key === key);
  const categories = (cats.data ?? []).filter((c) => q.data?.tools.some((t) => t.category === c.key)).map((c) => ({ value: c.key, label: c.label }));
  // các nhãn đang được gắn cho công cụ (không trùng, sắp theo ABC) để làm lựa chọn bộ lọc nhãn
  const badges = [...new Set((q.data?.tools ?? []).map((t) => t.badge).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b, 'vi'));
  // sắp xếp các nhóm model theo đúng thứ tự từ trên xuống dưới của tab Nhóm & model (?tab=groups — T-458 & T-459)
  const modelGroups = useMemo(() => {
    const grouped = buildModelGroups(q.data?.tools);
    const catList = cats.data ?? [];
    const catRank = new Map(catList.map((c, idx) => [c.key, idx]));
    const sorted = [...grouped].sort((a, b) => {
      const ca = catRank.get(a.parent) ?? 999;
      const cb = catRank.get(b.parent) ?? 999;
      if (ca !== cb) return ca - cb;
      return a.rank - b.rank;
    });
    if (filter.category !== 'all') {
      return sorted
        .filter((g) => g.parent === filter.category || g.tools.some((t) => t.category === filter.category))
        .map((g) => g.name);
    }
    return sorted.map((g) => g.name);
  }, [q.data?.tools, cats.data, filter.category]);
  const filtering =
    filter.search !== '' ||
    filter.provider !== 'all' ||
    filter.category !== 'all' ||
    filter.group !== 'all' ||
    filter.badge !== 'all' ||
    filter.status !== 'all' ||
    filter.priceEval !== 'all' ||
    filter.runPeriod !== 'all' ||
    filter.sort !== 'default';

  const columns: Column<ToolRow>[] = [
    {
      key: 'name',
      header: 'Công cụ',
      mobile: 'primary',
      className: 'min-w-[220px] whitespace-normal',
      cell: (r) => (
        // không hiện mã key cho gọn bảng; rê chuột lên tên vẫn xem được key (ô tìm kiếm vẫn tìm theo key)
        <div className="min-w-0" title={r.key}>
          {/* flex-wrap: trên điện thoại các nhãn tự xuống dòng thay vì ép tên công cụ */}
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {r.name}
            {r.badge && <Badge variant="secondary">{r.badge}</Badge>}
            {r.maintenance && (
              <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                Đang bảo trì
              </Badge>
            )}
            {!r.available && <Badge variant="destructive">Đã gỡ khỏi mã nguồn</Badge>}
            {r.models > 0 && <Badge variant="outline">Đã tách thành {r.models} model</Badge>}
          </div>
          {r.modelLabel && r.modelLabel.trim() && r.modelLabel.trim() !== r.name.trim() && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Hiển thị web: <span className="font-medium text-foreground/85">{r.modelLabel}</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'demoVideo',
      header: 'Video mẫu',
      cell: (r) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center">
          {r.demoVideo ? (
            <button
              type="button"
              onClick={() => setDemoTargets([r])}
              title="Bấm để xem / đổi / gỡ video mẫu"
              className="group relative h-9 w-16 shrink-0 overflow-hidden rounded-md border bg-black/90 shadow-2xs transition hover:ring-2 hover:ring-primary"
            >
              {/\.(gif|webp|png|jpe?g)(\?|$)/i.test(r.demoVideo) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.demoVideo} alt="" className="h-full w-full object-cover" />
              ) : (
                <video
                  src={r.demoVideo}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => {
                    e.currentTarget.pause();
                    e.currentTarget.currentTime = 0;
                  }}
                  className="h-full w-full object-cover"
                />
              )}
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 py-0.5 text-center text-[9px] font-medium text-white opacity-0 transition group-hover:opacity-100">
                Đổi
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDemoTargets([r])}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed px-2 text-[11px] text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Upload className="size-3" /> Gắn
            </button>
          )}
        </div>
      ),
    },
    {
      // chuyên mục (nhóm model): website gộp các công cụ cùng nhóm thành 1, khách chọn model
      key: 'modelGroups',
      header: 'Chuyên mục',
      mobile: 'wide',
      className: 'min-w-[180px] whitespace-normal',
      cell: (r) =>
        r.modelGroups.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="space-y-0.5">
            {/* công cụ ở nhiều nhóm: mỗi nhóm một dòng */}
            {r.modelGroups.map((g) => (
              <div key={g} className="flex items-start gap-1 text-xs text-primary">
                <Layers className="mt-0.5 size-3 shrink-0" />
                <span>
                  {g} › {r.modelLabel || r.name}
                </span>
              </div>
            ))}
          </div>
        ),
    },
    ...(hideProviders ? [] : [{ key: 'provider', header: 'Nhà cung cấp', cell: (r: ToolRow) => <span className="text-sm">{name(r.provider)}</span> }]),
    {
      key: 'category',
      header: 'Nhóm',
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <CategoryIcon name={catOf(r.category)?.icon} className="size-3.5 text-muted-foreground" />
          {catOf(r.category)?.label ?? r.category}
        </span>
      ),
    },
    {
      key: 'pricing',
      header: 'Giá',
      cell: (r) => {
        const p = pricingOf(r);
        const isCustom =
          p.customPrice === true ||
          (p.customPrice === undefined && !!r.pricing?.mode && r.pricing.mode !== 'cost' && r.pricing.mode !== 'free' && r.supportsCost);
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-xs">{pricingLabel(r, p)}</span>
            {isCustom && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
                Custom
              </Badge>
            )}
          </div>
        );
      },
    },
    ...(hideProviders
      ? []
      : [
          {
            key: 'priceEval',
            header: 'Nhận định giá',
            mobile: 'wide' as const,
            className: 'min-w-[215px]',
            cell: (r: ToolRow) => {
              if (r.models > 0 && !r.key.includes('~')) {
                return <span className="text-xs text-muted-foreground">—</span>;
              }
              if (prices.isLoading && !prices.data) {
                return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
              }
              const ev = priceEvalMap.get(r.key);
              if (!ev) return <span className="text-xs text-muted-foreground">—</span>;
              const pillCls =
                ev.level === 'best' || ev.level === 'free'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : ev.level === 'good'
                    ? 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                    : ev.level === 'lv1'
                      ? 'border-amber-500/40 bg-amber-500/12 text-amber-800 dark:text-amber-300'
                      : ev.level === 'lv2'
                        ? 'border-orange-500/40 bg-orange-500/12 text-orange-800 dark:text-orange-300'
                        : ev.level === 'lv3'
                          ? 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300'
                          : 'border-border bg-muted/50 text-muted-foreground';
              return (
                <div className="space-y-0.5 whitespace-nowrap" title={ev.tooltip}>
                  <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${pillCls}`}>
                    {ev.badgeText}
                  </span>
                  <div className="text-[11px] text-muted-foreground">{ev.noteText}</div>
                </div>
              );
            },
          },
        ]),
    {
      key: 'perRun',
      header: 'Giá / lượt',
      mobile: 'wide',
      cell: (r) => {
        const p = prices.data?.[r.key];
        if (!p) return prices.isLoading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <span className="text-muted-foreground">—</span>;
        if (p.credits === null)
          return (
            <span className="text-xs text-destructive" title={p.error}>
              Không tính được
            </span>
          );
        return (
          <div className="whitespace-nowrap" title="Dòng trên: Giá bán khách trả · Dòng dưới: Giá vốn gốc của gói">
            <div className="text-sm font-medium tabular-nums">{fmtCredits(p.credits)}</div>
            {p.providerCost !== null && (
              <div className="text-[11px] text-muted-foreground tabular-nums">
                Gốc: {p.providerCost.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}đ
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'tasks',
      header: runStatsEnabled ? 'Lượt chạy (kỳ lọc)' : 'Lượt chạy',
      cell: (r) => {
        if (!runStatsEnabled) return <span className="tabular-nums">{fmtCount(r.tasks)}</span>;
        if (runStats.isLoading) return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
        const st = statOfTool ? statOfTool(r) : { runs: 0, succeeded: 0, refunded: 0, revenue: 0 };
        if (!st.runs) return <span className="text-muted-foreground tabular-nums">0</span>;
        return (
          <div className="whitespace-nowrap">
            <div className="text-sm font-semibold tabular-nums">{fmtCount(st.runs)} lượt</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">✓ {fmtCount(st.succeeded)}</span>
              {st.refunded > 0 && <span className="ml-1.5 text-amber-600 dark:text-amber-400">· ↺ {fmtCount(st.refunded)}</span>}
              {st.revenue > 0 && <span className="ml-1.5">· {fmtCredits(st.revenue)}</span>}
            </div>
          </div>
        );
      },
    },
    { key: 'enabled', header: 'Bật', mobile: 'action', cell: (r) => <Switch checked={r.enabled} onCheckedChange={(enabled) => toggle.mutate({ key: r.key, enabled })} onClick={(e) => e.stopPropagation()} /> },
    {
      key: 'maintenance',
      header: 'Bảo trì',
      cell: (r) => (
        <div title={r.maintenance ? 'Đang bảo trì: khách vẫn thấy gói nhưng nút Tạo ngay đổi thành Đang bảo trì' : 'Bật để tạm bảo trì gói này mà không cần ẩn đi'}>
          <Switch
            checked={!!r.maintenance}
            onCheckedChange={(maintenance) => toggleMaintenance.mutate({ key: r.key, maintenance })}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(r)} aria-label="Sửa">
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={remove.isPending && remove.variables === r.key}
            onClick={(e) => {
              e.stopPropagation();
              void askRemove(r);
            }}
            aria-label="Xoá"
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Công cụ AI"
        description={
          hideProviders
            ? 'Danh mục công cụ AI đang hoạt động trên website (tự động đồng bộ cấu hình & giá từ hệ thống trung tâm).'
            : `Quản lý danh sách công cụ AI, giá bán (VND), % lãi, nhóm model và chế độ bảo trì. Nhận định giá tự động cập nhật liên tục theo giá gốc mới nhất cho cả các sản phẩm tương lai (SV1–SV${providers.length || 17}).`
        }
        breadcrumbs={[{ label: 'AI Studio' }, { label: 'Công cụ AI' }]}
        actions={
          !hideProviders ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={refreshLivePrices.isPending || prices.isFetching}
                onClick={() => refreshLivePrices.mutate()}
                title="Hệ thống tự động quét giá mới nhất mỗi 60 giây. Bấm để ép tải lại bảng giá trực tiếp từ toàn bộ nhà cung cấp ngay lập tức."
              >
                <RefreshCw className={refreshLivePrices.isPending || prices.isFetching ? 'animate-spin' : ''} />
                {prices.dataUpdatedAt
                  ? `Giá live · ${new Date(prices.dataUpdatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                  : 'Cập nhật giá live'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => router.push('/ai/providers')}>
                <KeyRound /> Nhà cung cấp API &amp; Số dư
              </Button>
            </div>
          ) : undefined
        }
      />
      <PageBody>
        <PermissionGate permission="ai.tools">
          <Tabs value={tab} onValueChange={goTab} className="mb-4">
            <TabsList>
              <TabsTrigger value="tools">
                <Wrench /> Công cụ
              </TabsTrigger>
              <TabsTrigger value="groups">
                <FolderTree /> Nhóm &amp; model
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === 'groups' ? (
            <GroupTreeTab tools={q.data?.tools} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} providerName={name} />
          ) : (
            <div className="space-y-4">
              <ListToolbar
                key={resetKey}
                search={filter.search}
                onSearchChange={(search) => setF({ search })}
                placeholder="Tìm tên công cụ, tên hiển thị trên web, mã SV, domain nguồn..."
                filters={
                  <>
                    {!hideProviders && (
                      <FilterSelect
                        searchable
                        searchPlaceholder={`Gõ domain nguồn, mã SV1..SV${providers.length || 18}...`}
                        value={filter.provider}
                        onChange={(provider) => setF({ provider })}
                        options={[
                          { value: 'all', label: 'Tất cả nhà cung cấp' },
                          ...[...providers]
                            .sort((a, b) => svBadgeNum(a.defaultBadge) - svBadgeNum(b.defaultBadge))
                            .map((p) => ({
                              value: p.key,
                              label: formatProviderDomainLabel(p),
                            })),
                        ]}
                      />
                    )}
                    <FilterSelect
                      searchable
                      searchPlaceholder="Gõ tên nhóm..."
                      value={filter.category}
                      onChange={(category) => setF({ category })}
                      options={[{ value: 'all', label: 'Tất cả nhóm' }, ...categories]}
                    />
                    <FilterSelect
                      searchable
                      searchPlaceholder="Gõ tên nhóm model..."
                      value={filter.group}
                      onChange={(group) => setF({ group })}
                      options={[{ value: 'all', label: 'Tất cả nhóm model' }, ...modelGroups.map((g) => ({ value: g, label: g }))]}
                    />
                    {!hideProviders && (
                      <FilterSelect
                        value={filter.priceEval}
                        onChange={(priceEval) => setF({ priceEval })}
                        options={[
                          { value: 'all', label: 'Nhận định giá: Tất cả' },
                          { value: 'expensive_on', label: '⚠️ Đang bật mà Đắt (Nên ẩn)' },
                          { value: 'expensive_all', label: 'Mọi gói Đắt (Mức 1–3)' },
                          { value: 'best', label: '★ Rẻ nhất từng dòng model' },
                          { value: 'good', label: 'Hợp lý / Dự phòng (≤+35%)' },
                          { value: 'lv1', label: 'Đắt mức 1 (+35% → +85%)' },
                          { value: 'lv2', label: 'Đắt mức 2 (gấp 1.85x → 3x)' },
                          { value: 'lv3', label: 'Đắt mức 3 (> gấp 3x)' },
                        ]}
                      />
                    )}
                    <FilterSelect
                      value={filter.status}
                      onChange={(status) => setF({ status })}
                      options={[
                        { value: 'all', label: 'Bật & tắt' },
                        { value: 'on', label: 'Đang bật' },
                        { value: 'off', label: 'Đang tắt' },
                        { value: 'maintenance', label: 'Đang bảo trì' },
                        { value: 'hasDemo', label: 'Đã có video mẫu' },
                        { value: 'noDemo', label: 'Chưa có video mẫu' },
                      ]}
                    />
                    <FilterSelect
                      value={filter.runPeriod}
                      onChange={(runPeriod) => {
                        if (runPeriod === 'custom') {
                          const today = vnTodayIso();
                          setF({
                            runPeriod,
                            from: filter.from || today,
                            to: filter.to || filter.from || today,
                            ...(filter.sort === 'default' ? { sort: 'most' } : {}),
                          });
                        } else {
                          setF({
                            runPeriod,
                            from: '',
                            to: '',
                            ...(runPeriod !== 'all' && filter.sort === 'default' ? { sort: 'most' } : {}),
                          });
                        }
                      }}
                      options={[
                        { value: 'all', label: 'Lượt chạy: Toàn thời gian' },
                        { value: 'today', label: 'Lượt chạy: Hôm nay' },
                        { value: 'yesterday', label: 'Lượt chạy: Hôm qua' },
                        { value: 'daybefore', label: 'Lượt chạy: Hôm kia' },
                        { value: '7d', label: 'Lượt chạy: 7 ngày qua' },
                        { value: '30d', label: 'Lượt chạy: 30 ngày qua' },
                        { value: 'custom', label: 'Chọn ngày cụ thể...' },
                      ]}
                    />
                    {filter.runPeriod === 'custom' && (
                      <div className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
                        <CalendarDays className="size-3.5 text-muted-foreground" />
                        <input
                          type="date"
                          value={filter.from || vnTodayIso()}
                          onChange={(e) => {
                            const v = e.target.value;
                            setF({ from: v, to: !filter.to || filter.to < v ? v : filter.to });
                          }}
                          className="h-7 bg-transparent text-xs outline-none"
                          aria-label="Từ ngày"
                        />
                        <span className="text-muted-foreground">→</span>
                        <input
                          type="date"
                          value={filter.to || filter.from || vnTodayIso()}
                          onChange={(e) => setF({ to: e.target.value })}
                          className="h-7 bg-transparent text-xs outline-none"
                          aria-label="Đến ngày"
                        />
                      </div>
                    )}
                    <FilterSelect
                      value={filter.sort}
                      onChange={(sort) => setF({ sort })}
                      options={[
                        { value: 'default', label: 'Thứ tự mặc định' },
                        { value: 'most', label: 'Lượt chạy nhiều nhất' },
                        { value: 'least', label: 'Lượt chạy ít nhất' },
                        { value: 'priceHigh', label: 'Giá cao → thấp' },
                        { value: 'priceLow', label: 'Giá thấp → cao' },
                      ]}
                    />
                    {filtering && (
                      <Button variant="ghost" size="sm" onClick={clearFilter}>
                        <X /> Xoá lọc
                      </Button>
                    )}
                    <Button variant={selected.length ? 'default' : 'outline'} size="sm" disabled={!filtered.length && !selected.length} onClick={() => setBulkPricing(true)}>
                      <Percent /> {selected.length ? `Sửa giá ${selected.length} công cụ đã chọn` : 'Sửa giá hàng loạt'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowDeleted(true)}>
                      <ArchiveRestore /> Đã xoá
                    </Button>
                    <Button variant={selected.length ? 'default' : 'outline'} size="sm" disabled={!filtered.length && !selected.length} onClick={() => setBulkBadge(true)}>
                      <Tag /> {selected.length ? `Sửa nhãn ${selected.length} công cụ đã chọn` : 'Sửa nhãn hàng loạt'}
                    </Button>
                    {selected.length > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setBulkGroup(true)}>
                        <Layers /> Gộp nhóm model ({selected.length})
                      </Button>
                    )}
                    {selected.length > 0 && (() => {
                      const selRows = (q.data?.tools ?? []).filter((t) => selected.includes(t.key));
                      const allEnabled = selRows.length > 0 && selRows.every((t) => t.enabled);
                      const anyEnabled = selRows.some((t) => t.enabled);
                      const allMaint = selRows.length > 0 && selRows.every((t) => !!t.maintenance);
                      const anyMaint = selRows.some((t) => !!t.maintenance);
                      return (
                        <>
                          {!allEnabled && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                              disabled={bulkEnabled.isPending}
                              onClick={() => bulkEnabled.mutate({ keys: selected, enabled: true })}
                            >
                              {bulkEnabled.isPending ? <Loader2 className="animate-spin" /> : <Power />}
                              Bật ({selected.length})
                            </Button>
                          )}
                          {anyEnabled && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                              disabled={bulkEnabled.isPending}
                              onClick={() => bulkEnabled.mutate({ keys: selected, enabled: false })}
                            >
                              {bulkEnabled.isPending ? <Loader2 className="animate-spin" /> : <PowerOff />}
                              Tắt ({selected.length})
                            </Button>
                          )}
                          {!allMaint && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                              disabled={bulkMaintenance.isPending}
                              onClick={() => bulkMaintenance.mutate({ keys: selected, maintenance: true })}
                            >
                              {bulkMaintenance.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
                              Bảo trì ({selected.length})
                            </Button>
                          )}
                          {anyMaint && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={bulkMaintenance.isPending}
                              onClick={() => bulkMaintenance.mutate({ keys: selected, maintenance: false })}
                            >
                              {bulkMaintenance.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                              Tắt bảo trì ({selected.length})
                            </Button>
                          )}
                        </>
                      );
                    })()}
                    {selected.length > 0 && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                          disabled={bulkRemove.isPending}
                          onClick={() => void askBulkRemove()}
                        >
                          {bulkRemove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                          Xoá ({selected.length})
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                          <X /> Bỏ chọn
                        </Button>
                      </>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {filtered.length} / {q.data?.tools.length ?? 0} công cụ
                    </span>
                  </>
                }
              />
              {runStatsEnabled && runStats.data && (() => {
                // Nếu đang lọc theo nhà cung cấp / nhóm / tìm kiếm thì cộng thêm tổng riêng của các dòng đang hiển thị
                const scoped = filtered
                  .filter((r) => !r.key.includes('~') ? r.models === 0 : true)
                  .reduce(
                    (acc, r) => {
                      const st = runStats.data!.byTool[r.key];
                      if (st) {
                        acc.runs += st.runs;
                        acc.succeeded += st.succeeded;
                        acc.refunded += st.refunded;
                        acc.revenue += st.revenue;
                      }
                      return acc;
                    },
                    { runs: 0, succeeded: 0, refunded: 0, revenue: 0 },
                  );
                const hasSubFilter = filter.search !== '' || filter.provider !== 'all' || filter.category !== 'all' || filter.group !== 'all' || filter.badge !== 'all' || filter.status !== 'all';
                const show = hasSubFilter ? scoped : runStats.data.totals;
                const rangeLabel = runStats.data.from === runStats.data.to ? `ngày ${fmtViDay(runStats.data.from)}` : `${fmtViDay(runStats.data.from)} → ${fmtViDay(runStats.data.to)}`;
                return (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-2.5 text-xs dark:border-sky-900/60 dark:bg-sky-950/30">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                      <CalendarDays className="size-3.5 text-sky-600 dark:text-sky-400" />
                      Đo đếm lượt chạy ({rangeLabel}{hasSubFilter ? ' · theo bộ lọc hiện tại' : ' · toàn hệ thống'}):
                    </span>
                    <span>
                      Tổng: <b className="tabular-nums">{fmtCount(show.runs)} lượt</b>
                    </span>
                    <span className="text-emerald-700 dark:text-emerald-400">
                      Thành công: <b className="tabular-nums">{fmtCount(show.succeeded)}</b>
                    </span>
                    <span className="text-amber-700 dark:text-amber-400">
                      Lỗi / hoàn: <b className="tabular-nums">{fmtCount(show.refunded)}</b>
                    </span>
                    <span>
                      Thực thu: <b className="tabular-nums text-primary">{fmtCredits(show.revenue)}</b>
                    </span>
                  </div>
                );
              })()}
              {/* khoá chính của công cụ là `key` -> gán vào id cho DataTable */}
              <DataTable
                columns={columns}
                data={q.data ? filtered : undefined}
                loading={q.isLoading}
                error={q.error}
                onRetry={() => void q.refetch()}
                onRowClick={(r) => setEditing(r)}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                emptyTitle={filtering ? 'Không có công cụ khớp bộ lọc' : 'Chưa có công cụ'}
              />
            </div>
          )}
          {editing && <EditToolDialog tool={editing} groups={modelGroups} onClose={() => setEditing(null)} onRemove={() => askRemove(editing)} deleting={remove.isPending && remove.variables === editing.key} />}
          {showDeleted && (
            <DeletedToolsDialog
              providerName={name}
              providers={providers}
              activeTools={q.data?.tools ?? []}
              activePrices={prices.data ?? {}}
              hideProviders={hideProviders}
              onClose={() => setShowDeleted(false)}
            />
          )}
          {bulkGroup && (
            <ModelGroupDialog
              tools={(q.data?.tools ?? []).filter((t) => selected.includes(t.key))}
              groups={modelGroups}
              onClose={() => setBulkGroup(false)}
              onSaved={() => setSelected([])}
            />
          )}
          {bulkPricing && (
            <BulkPricingDialog
              // đã tích chọn -> chỉ sửa các công cụ đó (kể cả đang bị bộ lọc ẩn); chưa chọn -> sửa mọi công cụ đang hiện theo bộ lọc
              tools={selected.length ? (q.data?.tools ?? []).filter((t) => selected.includes(t.key)) : filtered}
              scope={selected.length ? 'đã chọn' : 'đang hiện theo bộ lọc'}
              onClose={() => setBulkPricing(false)}
              onSaved={() => setSelected([])}
            />
          )}
          {bulkBadge && (
            <BulkBadgeDialog
              tools={selected.length ? (q.data?.tools ?? []).filter((t) => selected.includes(t.key)) : filtered}
              badges={badges}
              scope={selected.length ? 'đã chọn' : 'đang hiện theo bộ lọc'}
              onClose={() => setBulkBadge(false)}
              onSaved={() => setSelected([])}
            />
          )}
          {demoTargets && (
            <BulkDemoVideoDialog
              initialTools={demoTargets}
              allTools={q.data?.tools ?? []}
              onClose={() => setDemoTargets(null)}
              onSaved={() => setSelected([])}
            />
          )}
        </PermissionGate>
      </PageBody>
    </>
  );
}

/** Chuẩn hoá không dấu tiếng Việt để gõ tìm nhanh trong danh sách xổ xuống (T-384) */
const foldSearch = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();

/** Ô chọn một bộ lọc trên thanh công cụ — hỗ trợ vừa xổ xuống chọn nhanh vừa gõ tên tìm kiếm (T-384) */
function FilterSelect({
  value,
  onChange,
  options,
  searchable = false,
  searchPlaceholder = 'Gõ tên để tìm nhanh...',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  if (!searchable) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const currentLabel = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';
  const kw = foldSearch(query.trim());
  const filtered = kw ? options.filter((o) => foldSearch(`${o.label} ${o.value}`).includes(kw)) : options;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-52 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        >
          <span className="truncate text-left">{currentLabel}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) {
                e.preventDefault();
                onChange(filtered[0].value);
                setOpen(false);
                setQuery('');
              }
            }}
            placeholder={searchPlaceholder}
            className="h-8 w-full rounded-md border bg-background pr-7 pl-8 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">Không có kết quả khớp</div>
          ) : (
            filtered.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition hover:bg-accent hover:text-accent-foreground ${
                    active ? 'bg-accent/60 font-medium' : ''
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Ô nhập tên nhóm model kèm danh sách các nhóm đang có.
 * Bấm / focus vào ô là hiện đủ mọi nhóm (datalist của trình duyệt lọc theo chữ đang có nên chỉ hiện 1 nhóm);
 * gõ chữ mới thì lọc theo chữ đã gõ, vẫn cho nhập tên nhóm mới.
 */
function GroupInput({
  id,
  value,
  onChange,
  onPick,
  groups,
  placeholder = 'vd Tạo video AI — để trống = đứng riêng',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Có thì bấm một nhóm trong danh sách / Enter sẽ gọi hàm này (thêm nhóm) thay vì điền vào ô */
  onPick?: (g: string) => void;
  groups: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  // chữ dùng để lọc: rỗng khi vừa mở (hiện đủ nhóm), chỉ có giá trị khi người dùng gõ
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? groups.filter((g) => g.toLowerCase().includes(q)) : groups;
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        autoComplete="off"
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) (e.stopPropagation(), setOpen(false));
          // chế độ thêm nhóm: Enter = thêm tên đang gõ
          if (e.key === 'Enter' && onPick && value.trim()) (e.preventDefault(), onPick(value.trim()), setOpen(false));
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
        }}
        maxLength={80}
        placeholder={placeholder}
        className="pr-8"
      />
      {/* nút mũi tên: mở / đóng danh sách nhóm */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Danh sách nhóm model"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
        onMouseDown={(e) => {
          e.preventDefault();
          setQuery('');
          setOpen((o) => !o);
        }}
      >
        <ChevronDown className="size-4" />
      </button>
      {open && shown.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {shown.map((g) => (
            <button
              key={g}
              type="button"
              // mousedown + preventDefault: chọn trước khi ô nhập mất focus làm đóng danh sách
              onMouseDown={(e) => {
                e.preventDefault();
                if (onPick) onPick(g);
                else onChange(g);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left hover:bg-accent ${g === value ? 'font-medium' : ''}`}
            >
              {g}
              {g === value && <Check className="size-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Chọn nhiều nhóm model cho một công cụ: nhóm đã chọn hiện dạng thẻ (bấm X để bỏ),
 * ô bên dưới chọn nhóm có sẵn hoặc gõ tên nhóm mới rồi Enter / bấm Thêm.
 */
function GroupsInput({ id, value, onChange, groups }: { id: string; value: string[]; onChange: (v: string[]) => void; groups: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (g: string) => {
    const name = g.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((g) => (
            <Badge key={g} variant="secondary" className="gap-1">
              {g}
              <button type="button" aria-label={`Bỏ nhóm ${g}`} className="opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((x) => x !== g))}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <div className="flex-1">
          <GroupInput id={id} value={draft} onChange={setDraft} onPick={add} groups={groups.filter((g) => !value.includes(g))} placeholder={value.length ? 'Thêm nhóm khác...' : 'Chọn nhóm hoặc gõ tên mới — trống = đứng riêng'} />
        </div>
        {draft.trim() && (
          <Button type="button" variant="outline" onClick={() => add(draft)}>
            Thêm
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Thêm các công cụ đã tích chọn vào một nhóm model (website hiện 1 công cụ, khách chọn model) hoặc bỏ khỏi nhóm đó.
 * Công cụ đang ở nhóm khác vẫn giữ nhóm cũ (một công cụ ở được nhiều nhóm). Để trống tên + Bỏ = bỏ khỏi mọi nhóm.
 * Tên model trong nhóm: giữ tên đã đặt, chưa có thì dùng tên công cụ (sửa lại trong hộp Sửa từng công cụ).
 */
function ModelGroupDialog({ tools, groups, onClose, onSaved }: { tools: ToolRow[]; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [group, setGroup] = useState('');
  const name = group.trim();
  const save = useMutation({
    mutationFn: async (mode: 'add' | 'remove') => {
      for (const t of tools) {
        // thêm: nối tên nhóm vào cuối (đã có thì bỏ qua); bỏ: xoá đúng tên đó, tên trống = bỏ hết
        const next = mode === 'add' ? (t.modelGroups.includes(name) ? t.modelGroups : [...t.modelGroups, name]) : name ? t.modelGroups.filter((g) => g !== name) : [];
        if (next.length !== t.modelGroups.length) await api.put(`/admin/ai/tools/${encodeURIComponent(t.key)}`, { modelGroups: next });
      }
    },
    onSuccess: (_, mode) => {
      toast.success(mode === 'add' ? `Đã thêm ${tools.length} công cụ vào nhóm “${name}”` : name ? `Đã bỏ ${tools.length} công cụ khỏi nhóm “${name}”` : `Đã tách ${tools.length} công cụ khỏi mọi nhóm model`);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Gộp nhóm model</DialogTitle>
          <DialogDescription>Các công cụ cùng nhóm hiện thành 1 công cụ trên website (tên = tên nhóm), khách chọn model ngay trên trang công cụ. Một công cụ có thể ở nhiều nhóm. Thứ tự model theo cột Thứ tự.</DialogDescription>
        </DialogHeader>
        <Field label="Tên nhóm model" help="Chọn nhóm có sẵn hoặc gõ tên mới. Công cụ đang ở nhóm khác vẫn giữ nhóm đó. Để trống + Bỏ = tách khỏi mọi nhóm">
          <GroupInput id="bulk-model-groups" value={group} onChange={setGroup} groups={groups} />
        </Field>
        <div className="max-h-56 overflow-y-auto rounded-lg border p-2 text-xs">
          {tools.map((t) => (
            <div key={t.key} className="flex items-baseline justify-between gap-3 py-1">
              <span className="truncate font-medium">{t.name}</span>
              <span className="shrink-0 truncate text-muted-foreground">{t.modelGroups.length ? t.modelGroups.join(', ') : 'Đứng riêng'}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="outline" onClick={() => save.mutate('remove')} disabled={save.isPending || !tools.length}>
            {name ? 'Bỏ khỏi nhóm này' : 'Bỏ khỏi mọi nhóm'}
          </Button>
          <Button onClick={() => save.mutate('add')} disabled={save.isPending || !tools.length || !name}>
            Thêm {tools.length} công cụ vào nhóm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DeletedTool {
  key: string;
  name: string;
  provider: string;
  badge?: string | null;
  category?: string;
  output?: ToolRow['output'];
  modelGroups?: string[];
  modelLabel: string | null;
  canonicalModel?: string | null;
  models?: number;
  pricing?: Pricing;
  defaultPricing?: Pricing | null;
  credits?: number | null;
  providerCost?: number | null;
  benchCost?: number | null;
  tasks: number;
}

/** Công cụ đã xoá (đang ẩn khỏi website và admin): đối chiếu trực tiếp Nhận định giá với bảng chính để phát hiện ngay nếu lỡ xoá nhầm hàng giá tốt (T-470) */
function DeletedToolsDialog({
  providerName,
  providers,
  activeTools,
  activePrices,
  hideProviders,
  onClose,
}: {
  providerName: (key: string) => string;
  providers: ProviderRow[];
  activeTools: ToolRow[];
  activePrices: Record<string, ToolPrice>;
  hideProviders: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [evalTab, setEvalTab] = useState<'all' | 'gem' | 'expensive'>('all');
  const q = useQuery({ queryKey: ['ai-tools', 'deleted'], queryFn: () => api.get<DeletedTool[]>('/admin/ai/tools/deleted') });
  const restore = useMutation({
    mutationFn: (key: string) => api.post<{ restored: number }>(`/admin/ai/tools/${encodeURIComponent(key)}/restore`, {}),
    onSuccess: (r) => toast.success(r.restored > 1 ? `Đã khôi phục ${r.restored} công cụ (đang tắt, bật lại khi đã xem giá)` : 'Đã khôi phục công cụ (đang tắt, bật lại khi đã xem giá)'),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });

  // Tính nhận định giá cho từng công cụ đã xoá khi đặt cạnh các nguồn đang hoạt động ngoài bảng chính
  const deletedEvalMap = useMemo(() => {
    const map = new Map<
      string,
      {
        level: PriceEvalLevel;
        isGem: boolean;
        badgeText: string;
        noteText: string;
        tooltip: string;
        myCost: number;
      }
    >();
    if (hideProviders || !q.data?.length) return map;

    const provBadge = new Map(providers.map((p) => [p.key, p.defaultBadge || p.key.toUpperCase()]));
    const provActive = new Map(providers.map((p) => [p.key, p.enabled && p.configured]));
    const fmtShort = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

    // Gom chuẩn giá thấp nhất đang có ngoài bảng chính theo từng dòng model
    const activeByFam = new Map<string, { sv: string; cost: number; enabled: boolean; activeProv: boolean }[]>();
    for (const t of activeTools) {
      if (!t.available) continue;
      if (t.models > 0 && !t.key.includes('~')) continue;
      const tp = activePrices[t.key];
      const p = pricingOf(t);
      if (p.mode === 'free' || tp?.credits === 0) continue;
      const c = comparableVndOf(t, tp);
      if (c === null || c <= 0) continue;
      const fam = classifyComparableModel(t);
      activeByFam.set(fam.key, [
        ...(activeByFam.get(fam.key) ?? []),
        {
          sv: provBadge.get(t.provider) ?? t.provider,
          cost: c,
          enabled: t.enabled,
          activeProv: provActive.get(t.provider) ?? true,
        },
      ]);
    }
    for (const list of activeByFam.values()) {
      list.sort((a, b) => a.cost - b.cost || Number(b.enabled) - Number(a.enabled));
    }

    for (const d of q.data) {
      if ((d.models ?? 0) > 0 && !d.key.includes('~')) continue;
      const pseudoRow: ToolRow = {
        id: d.key,
        key: d.key,
        provider: d.provider,
        name: d.name,
        description: null,
        category: d.category ?? 'video',
        icon: null,
        badge: d.badge ?? null,
        featured: false,
        enabled: false,
        sortOrder: 0,
        pricing: d.pricing ?? {},
        defaultPricing: d.defaultPricing ?? null,
        available: true,
        output: d.output ?? 'video',
        unitLabel: null,
        supportsCost: true,
        rate: 1,
        costUnit: null,
        tasks: d.tasks,
        modelGroups: d.modelGroups ?? [],
        modelLabel: d.modelLabel,
        canonicalModel: d.canonicalModel ?? null,
        models: d.models ?? 0,
      };
      const p = pricingOf(pseudoRow);
      if (p.mode === 'free' || d.credits === 0) {
        map.set(d.key, {
          level: 'free',
          isGem: true,
          badgeText: '★ Miễn phí (0đ)',
          noteText: 'Công cụ tiện ích 0đ — cân nhắc khôi phục',
          tooltip: 'Công cụ miễn phí 0đ đang nằm trong mục Đã xoá',
          myCost: 0,
        });
        continue;
      }
      const myCost = comparableVndOf(pseudoRow, {
        credits: d.credits ?? null,
        providerCost: d.providerCost ?? null,
        benchCost: d.benchCost ?? null,
      });
      if (myCost === null || myCost <= 0) continue;

      const fam = classifyComparableModel(pseudoRow);
      const peers = activeByFam.get(fam.key) ?? [];
      const activePool = peers.filter((x) => x.activeProv);
      const bench = (activePool.length > 0 ? activePool : peers)[0];

      if (!bench) {
        map.set(d.key, {
          level: 'unique',
          isGem: true,
          badgeText: '★ Độc quyền (chưa có ngoài bảng)',
          noteText: `${fam.label} · Gốc ${fmtShort(myCost)} — Cân nhắc khôi phục!`,
          tooltip: `[${fam.label}] Hiện ngoài bảng chính chưa có nguồn nào cung cấp model này (Gốc: ${fmtShort(myCost)})`,
          myCost,
        });
        continue;
      }

      const ratio = myCost / bench.cost;
      const pct = Math.max(1, Math.round((ratio - 1) * 100));
      const mult = ratio >= 10 ? Math.round(ratio).toString() : ratio.toFixed(1).replace(/\.0$/, '');
      const peerText = peers.slice(0, 5).map((x) => `${x.sv}: ${fmtShort(x.cost)}`).join(' · ');
      const tooltip = `[${fam.label}] Gốc gói này: ${fmtShort(myCost)} | Ngoài bảng: ${peerText}`;

      if (ratio <= 1.05) {
        const savedPct = ratio < 0.98 ? ` (rẻ hơn ${Math.round((1 - ratio) * 100)}%!)` : '';
        map.set(d.key, {
          level: 'best',
          isGem: true,
          badgeText: `★ Rẻ nhất nếu khôi phục!${savedPct}`,
          noteText: `${fam.label} · Gốc ${fmtShort(myCost)} vs ${bench.sv} ${fmtShort(bench.cost)}`,
          tooltip,
          myCost,
        });
      } else if (ratio <= 1.35) {
        map.set(d.key, {
          level: 'good',
          isGem: true,
          badgeText: `Hợp lý +${pct}% (dự phòng tốt)`,
          noteText: `${fam.label} · Gốc ${fmtShort(myCost)} (rẻ nhất: ${bench.sv} ${fmtShort(bench.cost)})`,
          tooltip,
          myCost,
        });
      } else if (ratio <= 1.85) {
        map.set(d.key, {
          level: 'lv1',
          isGem: false,
          badgeText: `Đắt mức 1 · +${pct}%`,
          noteText: `Xoá hợp lý (${bench.sv} chỉ ${fmtShort(bench.cost)})`,
          tooltip,
          myCost,
        });
      } else if (ratio <= 3.0) {
        map.set(d.key, {
          level: 'lv2',
          isGem: false,
          badgeText: `Đắt mức 2 · gấp ${mult}x`,
          noteText: `Xoá đúng (${bench.sv} chỉ ${fmtShort(bench.cost)})`,
          tooltip,
          myCost,
        });
      } else {
        map.set(d.key, {
          level: 'lv3',
          isGem: false,
          badgeText: `Đắt mức 3 · gấp ${mult}x`,
          noteText: `Xoá đúng ✓ (${bench.sv} chỉ ${fmtShort(bench.cost)})`,
          tooltip,
          myCost,
        });
      }
    }
    return map;
  }, [hideProviders, q.data, providers, activeTools, activePrices]);

  const gemCount = useMemo(() => {
    let n = 0;
    for (const d of q.data ?? []) {
      if (deletedEvalMap.get(d.key)?.isGem) n++;
    }
    return n;
  }, [q.data, deletedEvalMap]);

  const expensiveCount = useMemo(() => {
    let n = 0;
    for (const d of q.data ?? []) {
      const ev = deletedEvalMap.get(d.key);
      if (ev && !ev.isGem) n++;
    }
    return n;
  }, [q.data, deletedEvalMap]);

  const kw = search.trim();
  const rows = (q.data ?? []).filter((t) => {
    if (
      kw &&
      !matchesToolSearch(
        [t.name, t.modelLabel, t.badge, t.key, t.canonicalModel, providerName(t.provider), t.provider, ...(t.modelGroups ?? [])],
        kw,
      )
    ) {
      return false;
    }
    if (evalTab === 'gem') return !!deletedEvalMap.get(t.key)?.isGem;
    if (evalTab === 'expensive') {
      const ev = deletedEvalMap.get(t.key);
      return !!ev && !ev.isGem;
    }
    return true;
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Công cụ đã xoá &amp; Đối chiếu giá gốc</DialogTitle>
          <DialogDescription>
            Hệ thống tự động chấm điểm giá vốn các công cụ đã xoá so với các nguồn đang hoạt động để phát hiện ngay nếu có công cụ giá tốt hoặc độc quyền bị xoá nhầm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm tên, mã công cụ hoặc nhà cung cấp..." />
          {!hideProviders && (q.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setEvalTab('all')}
                className={`rounded-md border px-2.5 py-1 font-medium transition ${
                  evalTab === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted'
                }`}
              >
                Tất cả ({q.data?.length ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setEvalTab('gem')}
                className={`rounded-md border px-2.5 py-1 font-medium transition ${
                  evalTab === 'gem'
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300'
                }`}
              >
                ⭐ Giá tốt / Độc quyền — kiểm tra xoá nhầm ({gemCount})
              </button>
              <button
                type="button"
                onClick={() => setEvalTab('expensive')}
                className={`rounded-md border px-2.5 py-1 font-medium transition ${
                  evalTab === 'expensive' ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted'
                }`}
              >
                Đắt mức 1–3 · Xoá đúng ({expensiveCount})
              </button>
            </div>
          )}
        </div>
        <div className="max-h-[56vh] overflow-y-auto rounded-lg border">
          {q.isLoading ? (
            <div className="flex justify-center p-6 text-muted-foreground">
              <Loader2 className="animate-spin" />
            </div>
          ) : q.error ? (
            <p className="p-4 text-sm text-destructive">{errorMessage(q.error)}</p>
          ) : !rows.length ? (
            <p className="p-4 text-sm text-muted-foreground">{kw || evalTab !== 'all' ? 'Không có công cụ khớp bộ lọc' : 'Chưa có công cụ nào bị xoá'}</p>
          ) : (
            rows.map((t) => {
              const ev = deletedEvalMap.get(t.key);
              const pillCls =
                !ev
                  ? ''
                  : ev.level === 'best' || ev.level === 'free' || ev.level === 'unique'
                    ? 'border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                    : ev.level === 'good'
                      ? 'border-sky-500/40 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                      : ev.level === 'lv1'
                        ? 'border-amber-500/40 bg-amber-500/12 text-amber-800 dark:text-amber-300'
                        : ev.level === 'lv2'
                          ? 'border-orange-500/40 bg-orange-500/12 text-orange-800 dark:text-orange-300'
                          : 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300';
              return (
                <div key={t.key} className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0 sm:flex-nowrap">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{t.name}</span>
                      {t.badge && <Badge variant="secondary">{t.badge}</Badge>}
                      {(t.models ?? 0) > 0 && <Badge variant="outline">Gồm {t.models} model con</Badge>}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {providerName(t.provider)} · {t.key}
                      {t.tasks ? ` · ${fmtCount(t.tasks)} lượt chạy` : ''}
                      {t.credits !== null && t.credits !== undefined ? ` · Bán: ${fmtCredits(t.credits)}` : ''}
                      {ev && ev.myCost > 0 ? ` · Gốc: ${Math.round(ev.myCost).toLocaleString('vi-VN')}đ` : ''}
                    </div>
                  </div>
                  {!hideProviders && ev && (
                    <div className="shrink-0 text-right" title={ev.tooltip}>
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${pillCls}`}>
                        {ev.badgeText}
                      </span>
                      <div className="mt-0.5 max-w-[240px] truncate text-[11px] text-muted-foreground">{ev.noteText}</div>
                    </div>
                  )}
                  <Button size="sm" variant="outline" className="shrink-0" disabled={restore.isPending} onClick={() => restore.mutate(t.key)}>
                    {restore.isPending && restore.variables === t.key ? <Loader2 className="animate-spin" /> : <ArchiveRestore />} Khôi phục
                  </Button>
                </div>
              );
            })
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Các ô giá sửa được hàng loạt */
type BulkField = 'mode' | 'base' | 'markup' | 'min';

/** Giá mới của một công cụ sau khi áp các ô đã tick; `skipped` = giữ cách tính cũ vì không hỗ trợ "theo chi phí NCC" (các ô khác vẫn áp) */
function bulkNext(t: ToolRow, on: Record<BulkField, boolean>, v: Required<Pricing>) {
  const cur = pricingOf(t);
  const next: Pricing = { ...cur };
  const skipped = on.mode && v.mode === 'cost' && !t.supportsCost;
  if (on.mode && !skipped) next.mode = v.mode;
  if (cur.mode !== 'cost' && next.mode === 'cost') {
    // giá cố định cũ không còn là phí cộng thêm hợp lý -> về 0 (chi phí NCC nhân tỉ giá chung của nhà cung cấp)
    next.base = 0;
  }
  if (on.base) next.base = v.base;
  if (on.markup) next.markup = v.markup;
  if (on.min) next.min = v.min;
  // giá cố định mà không có giá cơ bản / theo đơn vị -> mỗi lượt chỉ thu 1đ (hoặc mức tối thiểu), dễ lỗ
  // so theo giá trị đã chuẩn hoá: ô chưa có (undefined) coi như mặc định (mode fixed, hệ số 1, còn lại 0)
  const norm = (p: Pricing) => [p.mode ?? 'fixed', p.base ?? 0, p.perUnit ?? 0, p.tier10to20 ?? 0, p.tier20to30 ?? 0, p.markup ?? 0, p.min ?? 0].join('|');
  const changed = norm(cur) !== norm(next);
  const free = changed && next.mode === 'fixed' && !next.base && !next.perUnit && !next.min;
  return { cur, next, skipped, free, changed };
}

/**
 * Sửa giá cho nhiều công cụ cùng lúc (các công cụ đã tích chọn, hoặc đang hiện theo bộ lọc nếu chưa chọn): chỉ ô nào tick mới đổi, phần còn lại giữ nguyên.
 * - "Theo chi phí NCC" chỉ áp cho công cụ hỗ trợ (supportsCost), công cụ khác giữ cách tính cũ;
 *   công cụ chuyển từ giá cố định sang thì giá cơ bản về 0 (trừ khi tick "Giá cơ bản").
 * - Tỉ giá quy đổi đặt chung cho mỗi nhà cung cấp ở tab Khoá API, không sửa ở đây.
 * - Chặn lưu nếu có công cụ thành giá cố định 0đ (khách chạy gần như miễn phí).
 */
function BulkPricingDialog({ tools, scope, onClose, onSaved }: { tools: ToolRow[]; scope: string; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [on, setOn] = useState<Record<BulkField, boolean>>({ mode: false, base: false, markup: true, min: false });
  const [v, setV] = useState<Required<Pricing>>({ mode: 'cost', base: 0, perUnit: 0, resolutionPrices: {}, tier10to20: 0, tier20to30: 0, multiplier: 1, markup: 0, min: 0, customPrice: false });
  const setVal = (patch: Partial<Pricing>) => setV((s) => ({ ...s, ...patch }));
  const rows = tools.map((t) => ({ t, ...bulkNext(t, on, v) }));
  const changed = rows.filter((r) => r.changed);
  const free = rows.filter((r) => r.free);
  const skipped = rows.filter((r) => r.skipped).length;
  const save = useMutation({
    // API thay cả object pricing -> gửi lại toàn bộ giá mới của từng công cụ
    mutationFn: async () => {
      for (const r of changed) await api.put(`/admin/ai/tools/${encodeURIComponent(r.t.key)}`, { pricing: r.next });
    },
    onSuccess: () => {
      toast.success(`Đã cập nhật giá ${changed.length} công cụ${skipped ? ` (${skipped} công cụ giữ cách tính cũ)` : ''}`);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
    // lỗi giữa chừng thì các công cụ đã lưu vẫn được làm mới
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });
  /** Một ô giá có ô tick bật / tắt việc áp dụng */
  const row = (k: BulkField, label: string, input: ReactNode, help?: string, disabled?: boolean) => (
    <div className="grid grid-cols-[auto_1fr] items-start gap-3">
      <Switch className="mt-7" checked={on[k] && !disabled} disabled={disabled} onCheckedChange={(c) => setOn((s) => ({ ...s, [k]: c }))} />
      <Field label={label} help={help}>
        <div className={on[k] && !disabled ? '' : 'pointer-events-none opacity-50'}>{input}</div>
      </Field>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sửa giá hàng loạt</DialogTitle>
          <DialogDescription>Áp cho {tools.length} công cụ {scope}. Bật ô nào thì ô đó thay giá trị mới (không cộng dồn), ô tắt giữ nguyên.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {row(
            'mode',
            'Cách tính',
            <Select value={v.mode} onValueChange={(mode) => setVal({ mode: mode as NonNullable<Pricing['mode']> })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cost">Theo chi phí nhà cung cấp × tỉ giá</SelectItem>
                <SelectItem value="fixed">Giá cố định</SelectItem>
                <SelectItem value="free">Miễn phí</SelectItem>
              </SelectContent>
            </Select>,
            'Công cụ không hỗ trợ tính theo chi phí NCC giữ cách tính cũ',
          )}
          {row('base', 'Giá cơ bản mỗi lượt', <NumberInput suffix="đ" value={v.base} onChange={(n) => setVal({ base: n ?? 0 })} />)}
          {row('markup', 'Lãi thêm (%)', <NumberInput value={v.markup} onChange={(n) => setVal({ markup: n ?? 0 })} />, 'vd 20 = giá × 1,2; 0 = bỏ % lãi')}
          {row('min', 'Tối thiểu mỗi lượt', <NumberInput suffix="đ" value={v.min} onChange={(n) => setVal({ min: n ?? 0 })} />)}
        </div>
        <div className="max-h-56 overflow-y-auto rounded-lg border p-2 text-xs">
          {rows.map((r) => (
            <div key={r.t.key} className="flex items-baseline justify-between gap-3 py-1">
              <span className="truncate font-medium">{r.t.name}</span>
              <span className={`text-right ${r.free ? 'text-destructive' : r.changed ? '' : 'text-muted-foreground'}`}>
                {r.changed ? `${pricingLabel(r.t, r.cur)} → ${pricingLabel(r.t, r.next)}` : `${pricingLabel(r.t, r.cur)} (không đổi)`}
                {r.skipped && <span className="block text-amber-600">Giữ cách tính cũ — chưa hỗ trợ tính theo chi phí NCC</span>}
              </span>
            </div>
          ))}
        </div>
        {free.length > 0 && (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <CircleAlert className="size-4 shrink-0" /> {free.length} công cụ sẽ thành giá cố định 0đ (khách chạy gần như miễn phí). Bật “Giá cơ bản” hoặc “Tối thiểu” để đặt giá.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !changed.length || free.length > 0}>
            Áp dụng cho {changed.length} công cụ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sửa nhãn (badge: SV1, SV4, HOT, MỚI, 2K... hoặc xoá nhãn) hàng loạt cho các công cụ đã tích chọn,
 * hoặc toàn bộ công cụ đang hiện theo bộ lọc (vd lọc theo Nhà cung cấp rồi gắn nhãn chung 1 chạm).
 */
function BulkBadgeDialog({ tools, badges, scope, onClose, onSaved }: { tools: ToolRow[]; badges: string[]; scope: string; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [badge, setBadge] = useState('');
  const clean = badge.trim().slice(0, 20);
  const changed = tools.filter((t) => (t.badge ?? '') !== clean);

  const save = useMutation({
    mutationFn: async () => {
      const chunkSize = 8;
      for (let i = 0; i < changed.length; i += chunkSize) {
        await Promise.all(
          changed.slice(i, i + chunkSize).map((t) => api.put(`/admin/ai/tools/${encodeURIComponent(t.key)}`, { badge: clean })),
        );
      }
    },
    onSuccess: () => {
      toast.success(clean ? `Đã gắn nhãn “${clean}” cho ${changed.length} công cụ` : `Đã xoá nhãn khỏi ${changed.length} công cụ`);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sửa nhãn hàng loạt</DialogTitle>
          <DialogDescription>
            Áp dụng cho {tools.length} công cụ {scope}. Nhập nhãn mới (vd SV1, SV4, HOT, MỚI, 2K…) hoặc để trống để gỡ nhãn khỏi toàn bộ công cụ này.
          </DialogDescription>
        </DialogHeader>

        <Field label="Nhãn mới (tối đa 20 ký tự)" help="Bấm chọn nhanh nhãn đang dùng bên dưới hoặc gõ nhãn mới. Để trống = xoá nhãn">
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={badge}
                onChange={(e) => setBadge(e.target.value)}
                maxLength={20}
                placeholder="Ví dụ: SV1, SV4, HOT, MỚI... (để trống = xoá nhãn)"
                autoFocus
              />
              {badge && (
                <Button type="button" variant="outline" onClick={() => setBadge('')}>
                  Xoá chữ
                </Button>
              )}
            </div>
            {badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {badges.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBadge(b)}
                    className={`rounded-md border px-2 py-0.5 text-xs font-medium transition ${clean === b ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Field>

        <div className="max-h-56 overflow-y-auto rounded-lg border p-2 text-xs">
          {tools.map((t) => {
            const cur = t.badge ?? '';
            const willChange = cur !== clean;
            return (
              <div key={t.key} className="flex items-baseline justify-between gap-3 py-1">
                <span className="truncate font-medium">{t.name}</span>
                <span className={`shrink-0 text-right ${willChange ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                  {willChange ? `${cur || 'Không nhãn'} → ${clean || 'Không nhãn'}` : `${cur || 'Không nhãn'} (giữ nguyên)`}
                </span>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !changed.length}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {clean ? `Gắn nhãn “${clean}” (${changed.length} công cụ)` : `Gỡ nhãn (${changed.length} công cụ)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Gắn hoặc gỡ Video / Ảnh mẫu cho 1 hoặc nhiều model cùng lúc (vd tích 4 model rồi tải lên 1 lần áp dụng cho cả 4).
 * Trong hộp cũng cho phép tìm & tích thêm / bỏ bớt model để không bị sót.
 */
function BulkDemoVideoDialog({
  initialTools,
  allTools,
  onClose,
  onSaved,
}: {
  initialTools: ToolRow[];
  allTools: ToolRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [keys, setKeys] = useState<string[]>(() => initialTools.map((t) => t.key));
  const [pickerSearch, setPickerSearch] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [url, setUrl] = useState<string>(() => {
    const first = initialTools.find((t) => t.demoVideo)?.demoVideo ?? '';
    return initialTools.length === 1 ? first : initialTools.every((t) => (t.demoVideo ?? '') === first) ? first : '';
  });

  const cleanUrl = url.trim();
  const targetSet = useMemo(() => new Set(keys), [keys]);
  const targets = useMemo(() => allTools.filter((t) => targetSet.has(t.key)), [allTools, targetSet]);
  const withDemoCount = targets.filter((t) => !!t.demoVideo).length;

  const pickerList = useMemo(() => {
    const kw = pickerSearch.trim();
    return allTools.filter(
      (t) =>
        t.models === 0 &&
        (!kw || matchesToolSearch([t.name, t.modelLabel, t.badge, t.key, ...t.modelGroups], kw)),
    );
  }, [allTools, pickerSearch]);

  const toggleKey = (k: string) =>
    setKeys((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const save = useMutation({
    mutationFn: async (nextUrl: string) => {
      const chunkSize = 8;
      for (let i = 0; i < targets.length; i += chunkSize) {
        await Promise.all(
          targets.slice(i, i + chunkSize).map((t) =>
            api.put(`/admin/ai/tools/${encodeURIComponent(t.key)}`, { demoVideo: nextUrl }),
          ),
        );
      }
    },
    onSuccess: (_d, nextUrl) => {
      toast.success(
        nextUrl
          ? `Đã gắn video / ảnh mẫu cho ${targets.length} model`
          : `Đã gỡ video / ảnh mẫu khỏi ${targets.length} model`,
      );
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {targets.length === 1 ? `Video / ảnh mẫu · ${targets[0].name}` : `Gắn video / ảnh mẫu (${targets.length} model)`}
          </DialogTitle>
          <DialogDescription>
            Tải lên 1 video (.mp4, .webm, .mov) hoặc ảnh (.gif, .webp, .png, .jpg) rồi bấm Áp dụng để gắn đồng loạt cho toàn bộ model bên dưới.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-xs transition hover:opacity-90">
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {uploading ? 'Đang tải file lên...' : 'Tải video / ảnh lên'}
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,image/png,image/jpeg"
                className="hidden"
                disabled={uploading || save.isPending}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setUploading(true);
                  try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const r = await api.upload<{ url: string }>('/account/ai/uploads?demo=1', fd);
                    setUrl(r.url);
                    toast.success('Đã tải file lên — bấm Áp dụng để lưu cho các model đã chọn');
                  } catch (err) {
                    toast.error(errorMessage(err));
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
            <Input
              className="min-w-52 flex-1"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Hoặc dán link .mp4 / ảnh trực tiếp..."
            />
            {url && (
              <Button type="button" variant="outline" size="sm" onClick={() => setUrl('')}>
                Xoá link
              </Button>
            )}
          </div>

          {cleanUrl && (
            <div className="overflow-hidden rounded-xl border bg-black/95">
              {/\.(gif|webp|png|jpe?g)(\?|$)/i.test(cleanUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cleanUrl} alt="" className="mx-auto max-h-52 w-full object-contain" />
              ) : (
                <video key={cleanUrl} src={cleanUrl} controls muted loop playsInline className="mx-auto max-h-52 w-full object-contain" />
              )}
            </div>
          )}

          <div className="space-y-2 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                Model áp dụng ({targets.length})
              </span>
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowPicker((v) => !v)}>
                {showPicker ? 'Thu gọn danh sách chọn' : '+ Chọn thêm / bớt model'}
              </Button>
            </div>

            {showPicker ? (
              <div className="space-y-2 pt-1">
                <Input
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="Tìm nhanh tên model (vd: Tạo ảnh AI, Sửa & ghép ảnh, Seedance...)"
                  className="h-8 text-xs"
                />
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-1.5 text-xs">
                  {pickerList.map((t) => {
                    const checked = targetSet.has(t.key);
                    return (
                      <label
                        key={t.key}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 transition hover:bg-muted ${checked ? 'bg-primary/10 font-medium' : ''}`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleKey(t.key)}
                            className="size-3.5 accent-primary"
                          />
                          <span className="truncate">{t.name}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {t.demoVideo ? '🎬 Đã có' : 'Chưa có'}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto text-xs">
                {targets.map((t) => (
                  <div key={t.key} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
                    <span className="truncate font-medium">{t.name}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">{t.demoVideo ? '🎬 Đã có mẫu' : 'Chưa có mẫu'}</span>
                      {targets.length > 1 && (
                        <button
                          type="button"
                          onClick={() => toggleKey(t.key)}
                          className="text-muted-foreground hover:text-destructive"
                          title="Bỏ khỏi đợt áp dụng này"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div>
            {withDemoCount > 0 && (
              <Button
                type="button"
                variant="outline"
                className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                disabled={save.isPending || uploading || !targets.length}
                onClick={() => save.mutate('')}
              >
                <Trash2 className="size-3.5" /> Gỡ video mẫu ({withDemoCount})
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              onClick={() => save.mutate(cleanUrl)}
              disabled={save.isPending || uploading || !cleanUrl || !targets.length}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : <Film />}
              Áp dụng cho {targets.length} model
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hộp sửa công cụ */
function EditToolDialog({
  tool,
  groups,
  onClose,
  onRemove,
  deleting,
}: {
  tool: ToolRow;
  groups: string[];
  onClose: () => void;
  onRemove?: () => void;
  deleting?: boolean;
}) {
  const qc = useQueryClient();
  const cats = useToolCategories();
  const [uploadingDemo, setUploadingDemo] = useState(false);
  const merged = { ...tool.defaultPricing, ...tool.pricing };
  const initialCustomPrice =
    merged.customPrice !== undefined
      ? !!merged.customPrice
      : !!(tool.pricing?.mode && tool.pricing.mode !== 'cost' && tool.pricing.mode !== 'free' && tool.supportsCost);
  const [f, setF] = useState({
    name: tool.name,
    description: tool.description ?? '',
    category: tool.category,
    icon: tool.icon ?? '',
    badge: tool.badge ?? '',
    sortOrder: tool.sortOrder,
    featured: tool.featured,
    enabled: tool.enabled,
    maintenance: !!tool.maintenance,
    modelGroups: tool.modelGroups,
    modelLabel: tool.modelLabel ?? '',
    demoVideo: tool.demoVideo ?? '',
    applyDemoToGroup: false,
    pricing: {
      mode: merged.mode ?? 'fixed',
      base: merged.base ?? 0,
      perUnit: merged.perUnit ?? 0,
      resolutionPrices: { ...(merged.resolutionPrices ?? {}) },
      tier10to20: merged.tier10to20 ?? merged.base ?? 0,
      tier20to30: merged.tier20to30 ?? merged.tier10to20 ?? merged.base ?? 0,
      multiplier: merged.multiplier ?? 1,
      markup: merged.markup ?? 0,
      min: merged.min ?? 0,
      customPrice: initialCustomPrice,
    } as Required<Pricing>,
  });
  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }));
  const setP = (patch: Partial<Pricing>) => setF((s) => ({ ...s, pricing: { ...s.pricing, ...patch } }));
  const save = useMutation({
    mutationFn: () => api.put(`/admin/ai/tools/${encodeURIComponent(tool.key)}`, f),
    onSuccess: () => {
      toast.success('Đã lưu công cụ');
      qc.invalidateQueries({ queryKey: ['ai-tools'] });
      // số công cụ mỗi nhóm (tab Nhóm & model) đổi theo
      qc.invalidateQueries({ queryKey: ['ai-categories'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cost = f.pricing.mode === 'cost';
  const tiers = f.pricing.mode === 'tiers';
  const perSecond = f.pricing.mode === 'per_second';
  const perChar = f.pricing.mode === 'per_char';
  const byResolution = f.pricing.mode === 'by_resolution';
  const resOpts = tool.resolutionOptions ?? [];
  // miễn phí: ẩn các ô giá, khách chạy không bị trừ tiền ví
  const free = f.pricing.mode === 'free';
  const invalidResolutionPrices = byResolution && (!resOpts.length || resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) <= 0));
  // theo giây: thiếu giá chung thì mọi độ phân giải phải có giá mỗi giây riêng
  const missingPerSecond =
    perSecond && (f.pricing.perUnit ?? 0) <= 0 && (!resOpts.length || resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) <= 0));
  const missingPerChar = perChar && (f.pricing.perUnit ?? 0) <= 0;
  const perSecondOf = (res: string) => Number(f.pricing.resolutionPrices?.[res]) || f.pricing.perUnit || 0;
  const samplePerSecond = (sec: number, perSec = Number(f.pricing.perUnit) || 0) => {
    const raw = ((Number(f.pricing.base) || 0) + perSec * sec) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100);
    return Math.max(Math.ceil(raw), Math.ceil(Number(f.pricing.min) || 0), perSec || f.pricing.base || f.pricing.min ? 1 : 0);
  };
  const samplePerChar = (chars: number) => {
    const per1k = Number(f.pricing.perUnit) || 0;
    const raw = ((Number(f.pricing.base) || 0) + per1k * (chars / 1000)) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100);
    return Math.max(Math.ceil(raw), Math.ceil(Number(f.pricing.min) || 0), per1k || f.pricing.base || f.pricing.min ? 1 : 0);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Sửa công cụ</DialogTitle>
          <DialogDescription className="font-mono text-xs">{tool.key}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Tên hiển thị" required>
            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={250} />
          </Field>
          <Field label="Mô tả ngắn" help={`${f.description.length}/5.000 ký tự · Để trống rồi lưu để hệ thống tự sinh mô tả chuẩn`}>
            <Textarea rows={3} maxLength={5000} value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-12">
            <Field label="Nhóm menu" help="Thêm / sửa nhóm ở tab Nhóm &amp; model" className="sm:col-span-6">
              <Select value={f.category} onValueChange={(category) => set({ category })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(cats.data ?? []).map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      <CategoryIcon name={c.icon} /> {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Nhãn" help="NEW, HOT..." className="sm:col-span-3">
              <Input value={f.badge} onChange={(e) => set({ badge: e.target.value })} maxLength={20} />
            </Field>
            <Field label="Thứ tự" className="sm:col-span-3">
              <NumberInput value={f.sortOrder} onChange={(n) => set({ sortOrder: n ?? 0 })} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nhóm model" help="Công cụ cùng nhóm gộp thành 1 trên website, khách chọn model. Một công cụ ở được nhiều nhóm">
              <GroupsInput id="edit-model-groups" value={f.modelGroups} onChange={(modelGroups) => set({ modelGroups })} groups={groups} />
            </Field>
            <Field label="Tên model trong nhóm" help="Bỏ trống = dùng tên hiển thị">
              <Input value={f.modelLabel} onChange={(e) => set({ modelLabel: e.target.value })} maxLength={200} disabled={!f.modelGroups.length} />
            </Field>
          </div>
          {/* mã khách dùng khi gọi API /v1 theo model chuẩn (lưu riêng) */}
          <ApiModelField toolKey={tool.key} />
          <Field label="Icon (tên lucide)" help="vd: video, image, mic, music, wand-sparkles — tên lạ hiện icon ✨">
            <Input value={f.icon} onChange={(e) => set({ icon: e.target.value })} />
          </Field>
          <div className="space-y-2.5 rounded-xl border p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Video / ảnh mẫu riêng của model này</div>
                <p className="text-xs text-muted-foreground">Mỗi model hiển thị video mẫu riêng khi khách chọn model đó trên trang công cụ (như VeoVip). Hỗ trợ MP4, WEBM, MOV, GIF, WEBP, PNG, JPG.</p>
              </div>
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium shadow-xs hover:bg-muted">
                {uploadingDemo ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {uploadingDemo ? 'Đang tải lên...' : 'Tải file lên'}
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,image/png,image/jpeg"
                  className="hidden"
                  disabled={uploadingDemo}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setUploadingDemo(true);
                    try {
                      const fd = new FormData();
                      fd.append('file', file);
                      const r = await api.upload<{ url: string }>('/account/ai/uploads?demo=1', fd);
                      set({ demoVideo: r.url });
                      toast.success('Đã tải video / ảnh mẫu lên (bấm Lưu để áp dụng)');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    } finally {
                      setUploadingDemo(false);
                    }
                  }}
                />
              </label>
            </div>
            <div className="flex gap-2">
              <Input value={f.demoVideo} onChange={(e) => set({ demoVideo: e.target.value })} placeholder="Tải file ở trên hoặc dán link video .mp4 / ảnh..." />
              {f.demoVideo && (
                <Button type="button" variant="outline" size="sm" onClick={() => set({ demoVideo: '' })}>
                  Gỡ
                </Button>
              )}
            </div>
            {f.demoVideo && (
              <div className="overflow-hidden rounded-lg border bg-black/95">
                {/\.(gif|webp|png|jpe?g)(\?|$)/i.test(f.demoVideo) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.demoVideo} alt="" className="mx-auto max-h-44 w-full object-contain" />
                ) : (
                  <video src={f.demoVideo} controls muted loop playsInline className="mx-auto max-h-44 w-full object-contain" />
                )}
              </div>
            )}
            {f.modelGroups.length > 0 && (
              <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                <Switch checked={f.applyDemoToGroup} onCheckedChange={(applyDemoToGroup) => set({ applyDemoToGroup })} />
                Áp dụng video mẫu này cho tất cả model trong nhóm <b>{f.modelGroups.join(', ')}</b>
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.enabled} onCheckedChange={(enabled) => set({ enabled })} /> Đang bật
            </label>
            <label className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300" title="Gói vẫn hiển thị bình thường trên web nhưng nút Tạo ngay chuyển thành Đang bảo trì">
              <Switch checked={f.maintenance} onCheckedChange={(maintenance) => set({ maintenance })} /> Chế độ bảo trì
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.featured} onCheckedChange={(featured) => set({ featured })} /> Nổi bật ở dashboard
            </label>
          </div>

          <div className="rounded-xl border p-4">
            <div className="mb-3 text-sm font-semibold">Giá bán (VND, trừ vào số dư ví của khách)</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cách tính">
                <Select
                  value={f.pricing.mode}
                  onValueChange={(nextMode) => {
                    const mode = nextMode as NonNullable<Pricing['mode']>;
                    const isManualMode = mode === 'fixed' || mode === 'per_second' || mode === 'per_char' || mode === 'by_resolution' || mode === 'tiers';
                    if ((mode === 'per_second' || mode === 'per_char' || mode === 'by_resolution') && f.pricing.mode !== mode) {
                      // Chuyển từ chế độ khác sang tự đặt giá: đưa Giá cơ bản & Lãi thêm về 0 và tự bật khoá Custom giá riêng
                      setP({ mode, base: 0, markup: 0, customPrice: true });
                    } else if (isManualMode && f.pricing.mode !== mode) {
                      setP({ mode, customPrice: true });
                    } else if (mode === 'cost' && f.pricing.mode !== 'cost') {
                      setP({ mode, customPrice: false });
                    } else {
                      setP({ mode });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Giá cố định</SelectItem>
                    {(resOpts.length > 0 || f.pricing.mode === 'by_resolution') && (
                      <SelectItem value="by_resolution">Tính theo độ phân giải (tự đặt giá từng mức)</SelectItem>
                    )}
                    {(tool.supportsPerChar || f.pricing.mode === 'per_char') && (
                      <SelectItem value="per_char">Tính theo ký tự (tự đặt giá / 1.000 ký tự)</SelectItem>
                    )}
                    {(tool.supportsPerSecond || f.pricing.mode === 'per_second') && (
                      <SelectItem value="per_second">Tính theo giây (tự đặt giá / giây)</SelectItem>
                    )}
                    {(tool.supportsDurationTiers || f.pricing.mode === 'tiers') && (
                      <SelectItem value="tiers">Giá riêng theo mốc 10–20s &amp; 20–30s</SelectItem>
                    )}
                    {tool.supportsCost && <SelectItem value="cost">Theo chi phí nhà cung cấp × tỉ giá</SelectItem>}
                    <SelectItem value="free">Miễn phí</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {free ? null : tiers ? (
                <Field label="Cơ chế áp giá" help="Web tự đo độ dài thật của video mẫu khi tải lên">
                  <Input readOnly value="Tự động theo độ dài video (10–20s / 20–30s)" />
                </Field>
              ) : byResolution ? (
                <Field label="Cơ chế áp giá" help="Áp đúng mức giá theo độ phân giải khách chọn trên form">
                  <Input readOnly value={`Theo ${resOpts.length} mức độ phân giải (${resOpts.map((o) => o.value).join(' / ')})`} />
                </Field>
              ) : perChar ? (
                <Field
                  label="Giá mỗi 1.000 ký tự (VND / 1k ký tự)"
                  required
                  help="Nhân chính xác với số ký tự khách nhập chia 1.000 (chữ Trung/Nhật/Hàn tự động ×2,5 không lo hụt vốn)"
                >
                  <NumberInput suffix="đ/1k" min={0} value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} placeholder="vd: 700" />
                </Field>
              ) : perSecond ? (
                <Field
                  label={resOpts.length ? 'Giá mỗi giây chung (VND / giây)' : 'Giá mỗi giây (VND / giây)'}
                  required={!resOpts.length}
                  help={
                    resOpts.length
                      ? 'Dùng cho độ phân giải chưa đặt giá riêng ở dưới. Đặt đủ giá từng độ phân giải thì có thể để 0'
                      : 'Nhân trực tiếp với số giây khách chọn (vd 4s, 8s, 15s, 20s) hoặc độ dài file tải lên'
                  }
                >
                  <NumberInput suffix="đ/s" min={0} value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} placeholder="vd: 150" />
                </Field>
              ) : cost ? (
                <Field label="Tỉ giá quy đổi" help="Đặt chung cho nhà cung cấp ở tab Khoá API nhà cung cấp">
                  <Input readOnly value={`1 ${tool.costUnit ?? 'đơn vị nguồn'} = ${fmtRate(tool.rate)}đ`} />
                </Field>
              ) : (
                <Field label={`Giá theo ${tool.unitLabel ?? 'đơn vị'}`} help={tool.unitLabel ? `Cộng thêm cho mỗi ${tool.unitLabel}` : 'Để 0 nếu chỉ tính giá cơ bản'}>
                  <NumberInput suffix="đ" value={f.pricing.perUnit} onChange={(n) => setP({ perUnit: n ?? 0 })} />
                </Field>
              )}
              {!free && tiers && (
                <>
                  <Field label="Giá mốc 10s – 20s" help="Áp dụng khi video mẫu dài trên 10s đến 20s (ghép 2 cảnh)">
                    <NumberInput
                      suffix="đ"
                      value={f.pricing.tier10to20}
                      onChange={(n) => setP({ tier10to20: n ?? 0, base: n ?? 0 })}
                    />
                  </Field>
                  <Field label="Giá mốc 20s – 30s" help="Áp dụng khi video mẫu dài trên 20s đến 30s (ghép 3 cảnh)">
                    <NumberInput
                      suffix="đ"
                      value={f.pricing.tier20to30}
                      onChange={(n) => setP({ tier20to30: n ?? 0 })}
                    />
                  </Field>
                  <Field label="Lãi thêm (%)" help="Cộng thêm % lên giá đã tính, vd 20 = giá × 1,2. Để 0 nếu không cộng">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}
              {!free && byResolution && (
                <>
                  {resOpts.map((opt) => (
                    <Field key={opt.value} label={`Giá ${opt.label}`} required>
                      <NumberInput
                        suffix="đ"
                        min={0}
                        value={f.pricing.resolutionPrices?.[opt.value] ?? 0}
                        onChange={(n) =>
                          setP({
                            resolutionPrices: {
                              ...(f.pricing.resolutionPrices ?? {}),
                              [opt.value]: n ?? 0,
                            },
                          })
                        }
                        placeholder="Nhập giá VND"
                      />
                    </Field>
                  ))}
                  <Field label="Lãi thêm (%)" help="Cộng thêm % lên giá đã tính, vd 20 = giá × 1,2. Để 0 nếu không cộng">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}
              {!free &&
                perSecond &&
                resOpts.map((opt) => (
                  <Field key={opt.value} label={`Giá mỗi giây ${opt.label}`} help="Để 0 = dùng giá mỗi giây chung">
                    <NumberInput
                      suffix="đ/s"
                      min={0}
                      value={f.pricing.resolutionPrices?.[opt.value] ?? 0}
                      onChange={(n) => setP({ resolutionPrices: { ...(f.pricing.resolutionPrices ?? {}), [opt.value]: n ?? 0 } })}
                    />
                  </Field>
                ))}
              {!free && !tiers && !byResolution && (
                <>
                  <Field label="Giá cơ bản mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.base} onChange={(n) => setP({ base: n ?? 0 })} />
                  </Field>
                  <Field label="Lãi thêm (%)" help="Cộng thêm % lên giá đã tính, vd 20 = giá × 1,2. Để 0 nếu không cộng">
                    <NumberInput value={f.pricing.markup} onChange={(n) => setP({ markup: n ?? 0 })} />
                  </Field>
                  <Field label="Tối thiểu mỗi lượt">
                    <NumberInput suffix="đ" value={f.pricing.min} onChange={(n) => setP({ min: n ?? 0 })} />
                  </Field>
                </>
              )}
              {!free && (
                <Field
                  label="Tự custom giá riêng"
                  help="Bật thì khi nguồn bật Tự động cập nhật giá hoặc đổi % tăng giá chung sẽ không sửa giá model này"
                >
                  <label
                    className={`flex h-9 cursor-pointer items-center justify-between rounded-md border px-3 text-sm transition-colors ${
                      f.pricing.customPrice
                        ? 'border-amber-400 bg-amber-50/70 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                        : 'bg-background text-muted-foreground'
                    }`}
                  >
                    <span className="truncate font-medium">
                      {f.pricing.customPrice ? 'Tự custom giá (khoá giá riêng)' : 'Đồng bộ theo nguồn API'}
                    </span>
                    <Switch checked={!!f.pricing.customPrice} onCheckedChange={(customPrice) => setP({ customPrice })} />
                  </label>
                </Field>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {free
                ? 'Khách chạy công cụ này không bị trừ tiền ví (vẫn tính vào giới hạn số tác vụ chạy cùng lúc).'
                : tiers
                  ? `Mốc 10–20s: ${fmtPrice(f.pricing.tier10to20)} · Mốc 20–30s: ${fmtPrice(f.pricing.tier20to30)}${f.pricing.markup ? ` (× ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)})` : ''}`
                  : byResolution
                    ? `Bảng giá: ${resOpts.map((o) => `${o.value} = ${fmtPrice(Math.ceil((Number(f.pricing.resolutionPrices?.[o.value]) || 0) * (1 + Math.max(0, Number(f.pricing.markup) || 0) / 100)))}`).join(' · ')}`
                    : perSecond && resOpts.some((o) => (Number(f.pricing.resolutionPrices?.[o.value]) || 0) > 0)
                      ? `Giá 10 giây: ${resOpts.map((o) => `${o.value} = ${fmtPrice(samplePerSecond(10, perSecondOf(o.value)))}`).join(' · ')}${f.pricing.markup ? ` (đã × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)})` : ''}`
                      : perChar
                        ? `Công thức: (${f.pricing.base ? `${fmtPrice(f.pricing.base)} + ` : ''}${fmtPrice(f.pricing.perUnit)} × số ký tự / 1.000)${f.pricing.markup ? ` × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}` : ''} — VD: 500 ký tự = ${fmtPrice(samplePerChar(500))} · 1.000 ký tự = ${fmtPrice(samplePerChar(1000))} · 5.000 ký tự = ${fmtPrice(samplePerChar(5000))}`
                        : perSecond
                          ? `Công thức: (${f.pricing.base ? `${fmtPrice(f.pricing.base)} + ` : ''}${fmtPrice(f.pricing.perUnit)} × số giây)${f.pricing.markup ? ` × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}` : ''} — VD: 5s = ${fmtPrice(samplePerSecond(5))} · 8s = ${fmtPrice(samplePerSecond(8))} · 15s = ${fmtPrice(samplePerSecond(15))} · 20s = ${fmtPrice(samplePerSecond(20))}`
                          : cost
                            ? `Công thức: (chi phí NCC × tỉ giá ${fmtRate(tool.rate)} + ${fmtPrice(f.pricing.base)}) × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}`
                            : `Công thức: (${fmtPrice(f.pricing.base)}${f.pricing.perUnit ? ` + ${fmtPrice(f.pricing.perUnit)} × số ${tool.unitLabel ?? 'đơn vị'}` : ''}) × ${fmtRate(1 + (Number(f.pricing.markup) || 0) / 100)}`}
              {!free && `${f.pricing.min ? `, tối thiểu ${fmtPrice(f.pricing.min)}` : ''}, làm tròn lên tới đồng.`}
            </p>
            {missingPerChar && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập Giá mỗi 1.000 ký tự lớn hơn 0đ, hoặc chọn Miễn phí.
              </p>
            )}
            {missingPerSecond && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập Giá mỗi giây lớn hơn 0đ (chung, hoặc riêng cho mọi độ phân giải), hoặc chọn Miễn phí.
              </p>
            )}
            {invalidResolutionPrices && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" /> Vui lòng nhập giá lớn hơn 0đ cho tất cả các mức độ phân giải.
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {onRemove ? (
            <Button type="button" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onRemove} disabled={deleting || save.isPending}>
              <Trash2 className="size-4" /> Xoá công cụ
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !f.name.trim() || missingPerSecond || missingPerChar || invalidResolutionPrices}>
              Lưu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
