import { hideProviderText } from './ai-public-key.js';
import type { AiFieldDef, AiFieldOption, AiInput, AiPricing, AiToolDef } from './ai.types.js';

export interface AiPriceOptionItem {
  label: string;
  price: number;
  unit?: string | null;
}

export interface AiPriceMatrixTable {
  title?: string;
  rowHeader: string;
  columns: string[];
  rows: { label: string; prices: (number | null)[] }[];
}

export interface AiToolPriceBreakdown {
  minPrice: number | null;
  maxPrice: number | null;
  defaultPrice: number | null;
  unitLabel: string | null;
  items: AiPriceOptionItem[];
  tables?: AiPriceMatrixTable[];
  note?: string | null;
}

const GROUP_FIELD_NAMES = new Set(['server', 'mode', 'engine']);
const RES_FIELD_NAMES = new Set(['resolution', 'quality', 'size']);
const DUR_FIELD_NAMES = new Set(['duration', 'durationSec', 'seconds', 'targetDuration']);

function defaultSampleInput(fields: AiFieldDef[]): AiInput {
  const input: AiInput = { __sample: true };
  for (const f of fields) {
    if (f.name === 'count' || f.name === 'n') {
      input[f.name] = f.type === 'number' ? 1 : '1';
      continue;
    }
    if (f.default !== undefined) input[f.name] = f.default;
    else if (f.type === 'select') {
      const opts = f.optionsBy ? f.optionsBy.map[String(input[f.optionsBy.field] ?? '')] ?? f.options : f.options;
      if (opts?.length) input[f.name] = opts[0].value;
    } else if (f.type === 'number' && f.min !== undefined) input[f.name] = f.min;
    else if (f.type === 'boolean') input[f.name] = false;
  }
  return input;
}

function isFieldVisible(field: AiFieldDef, input: AiInput): boolean {
  if (field.hidden) return false;
  if (field.showIf && !field.showIf.in.includes(String(input[field.showIf.field] ?? ''))) return false;
  return true;
}

function activeOptions(field: AiFieldDef | undefined, input: AiInput): AiFieldOption[] {
  if (!field || !isFieldVisible(field, input)) return [];
  const raw = field.optionsBy ? field.optionsBy.map[String(input[field.optionsBy.field] ?? '')] ?? field.options ?? [] : field.options ?? [];
  return raw.map((o) => ({ value: o.value, label: hideProviderText(o.label) }));
}

function cleanOptionLabel(raw: string): string {
  return hideProviderText(raw)
    .replace(/\s*\((?:khuyên dùng|mặc định|recommended|default)\)/gi, '')
    .trim();
}

function shortDurLabel(opt: AiFieldOption): string {
  const v = String(opt.value).trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return `${v}s`;
  if (/^\d+(?:\.\d+)?s$/i.test(v)) return v.toLowerCase();
  const l = cleanOptionLabel(opt.label).replace(/\s*giây$/i, 's');
  return l.length <= 12 ? l : v;
}

function parseDurSec(opt: AiFieldOption): number | null {
  const m = /^(\d+(?:\.\d+)?)s?$/i.exec(String(opt.value).trim()) ?? /^(\d+(?:\.\d+)?)\s*(?:s|giây)/i.exec(opt.label.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resRank(opt: AiFieldOption): number {
  const s = `${opt.value} ${opt.label}`.toLowerCase();
  if (/\b360p\b/.test(s)) return 10;
  if (/\b480p\b/.test(s)) return 20;
  if (/\b540p\b/.test(s)) return 30;
  if (/\b720p\b/.test(s)) return 40;
  if (/\b(?:1k|1024)\b/.test(s)) return 50;
  if (/\b(?:1080p|fhd|full\s*hd)\b/.test(s)) return 60;
  if (/\b(?:2k|1440p|qhd)\b/.test(s)) return 70;
  if (/\b(?:4k|2160p|uhd)\b/.test(s)) return 80;
  if (/\bstandard\b|tiêu chuẩn/.test(s)) return 45;
  if (/\bhd\b|cao cấp/.test(s)) return 65;
  return 100;
}

function selectMilestoneDurations(opts: AiFieldOption[]): { chosen: AiFieldOption[]; trimmedRange: [number, number] | null } {
  const withSec = opts.map((o, idx) => ({ o, sec: parseDurSec(o), idx }));
  if (withSec.every((x) => x.sec !== null)) {
    withSec.sort((a, b) => a.sec! - b.sec! || a.idx - b.idx);
    const dedup: typeof withSec = [];
    const seen = new Set<number>();
    for (const item of withSec) {
      if (!seen.has(item.sec!)) {
        seen.add(item.sec!);
        dedup.push(item);
      }
    }
    if (dedup.length <= 7) {
      return { chosen: dedup.map((x) => x.o), trimmedRange: null };
    }
    const minS = dedup[0].sec!;
    const maxS = dedup[dedup.length - 1].sec!;
    const milestones = [minS, 5, 8, 10, 12, 15, 20, 25, 30, 60, maxS];
    const picked: AiFieldOption[] = [];
    const pickedSec = new Set<number>();
    for (const m of milestones) {
      const hit = dedup.find((x) => x.sec === m);
      if (hit && !pickedSec.has(hit.sec!)) {
        pickedSec.add(hit.sec!);
        picked.push(hit.o);
      }
      if (picked.length >= 7 && m !== maxS) break;
    }
    if (!pickedSec.has(maxS)) {
      if (picked.length >= 7) picked[picked.length - 1] = dedup[dedup.length - 1].o;
      else picked.push(dedup[dedup.length - 1].o);
    }
    return { chosen: picked, trimmedRange: [minS, maxS] };
  }
  return { chosen: opts.slice(0, 8), trimmedRange: null };
}

function finalizeBreakdown(
  partial: {
    items: AiPriceOptionItem[];
    tables?: AiPriceMatrixTable[];
    unitLabel?: string | null;
    defaultPrice?: number | null;
    note?: string | null;
  },
): AiToolPriceBreakdown {
  const allPrices: number[] = [];
  for (const it of partial.items) {
    if (Number.isFinite(it.price) && it.price >= 0) allPrices.push(it.price);
  }
  for (const tb of partial.tables ?? []) {
    for (const r of tb.rows) {
      for (const p of r.prices) {
        if (p !== null && Number.isFinite(p) && p >= 0) allPrices.push(p);
      }
    }
  }
  if (partial.defaultPrice !== null && partial.defaultPrice !== undefined && Number.isFinite(partial.defaultPrice)) {
    allPrices.push(partial.defaultPrice);
  }
  const minPrice = allPrices.length ? Math.min(...allPrices) : null;
  const maxPrice = allPrices.length ? Math.max(...allPrices) : null;
  const defaultPrice = partial.defaultPrice ?? minPrice;
  return {
    minPrice,
    maxPrice,
    defaultPrice,
    unitLabel: partial.unitLabel ?? null,
    items: partial.items,
    ...(partial.tables?.length ? { tables: partial.tables } : {}),
    ...(partial.note ? { note: hideProviderText(partial.note) } : {}),
  };
}

/**
 * Dựng bảng giá chi tiết theo từng lựa chọn cấu hình của một công cụ AI trên website hiện tại.
 * `quoteFn` gọi trực tiếp `quoteDetail` với công thức giá thật của website (đã tính đủ tỉ giá, % lãi web chính / web con, giá sàn).
 */
export async function computeToolPriceBreakdown(
  def: AiToolDef,
  providerKey: string,
  pricing: AiPricing,
  quoteFn: (input: AiInput) => Promise<number | null>,
): Promise<AiToolPriceBreakdown> {
  const baseIn = defaultSampleInput(def.fields);
  const markupFactor = 1 + Math.max(0, Number(pricing.markup) || 0) / 100;

  // 1) Công cụ miễn phí
  if (pricing.mode === 'free') {
    return {
      minPrice: 0,
      maxPrice: 0,
      defaultPrice: 0,
      unitLabel: null,
      items: [{ label: 'Miễn phí sử dụng', price: 0 }],
      ...(def.priceHint ? { note: hideProviderText(def.priceHint) } : {}),
    };
  }

  // 2) Công cụ tính theo mốc thời lượng cố định (`tiers` — Motion Control 10s–30s)
  if (pricing.mode === 'tiers') {
    const floor = Math.ceil(Number(pricing.min) || 0);
    const t1 = Math.max(Math.ceil((Number(pricing.tier10to20) || Number(pricing.base) || 0) * markupFactor), floor, 1);
    const t2 = Math.max(Math.ceil((Number(pricing.tier20to30) || Number(pricing.tier10to20) || Number(pricing.base) || 0) * markupFactor), floor, 1);
    return finalizeBreakdown({
      defaultPrice: t1,
      unitLabel: 'video',
      items: [
        { label: 'Video mẫu 10s – 20s', price: t1, unit: 'video' },
        { label: 'Video mẫu 20s – 30s', price: t2, unit: 'video' },
      ],
      note: def.priceHint,
    });
  }

  const defaultPrice = await quoteFn(baseIn);

  // 3) Công cụ Giọng nói AI (có hộp chọn giọng `picker === 'voice'`)
  const voiceField = def.fields.find((f) => f.picker === 'voice' && !f.hidden);
  if (voiceField) {
    const vOpts = voiceField.options ?? [];
    const stdOpt = vOpts.find((o) => !/cao cấp|premium|x2\.5|x2/i.test(o.label)) ?? vOpts[0];
    const premOpt = vOpts.find((o) => /cao cấp|premium|x2\.5|x2/i.test(o.label));
    const stdPrice = stdOpt ? await quoteFn({ ...baseIn, [voiceField.name]: stdOpt.value }) : defaultPrice;
    const premCandidateVal = premOpt ? premOpt.value : voiceField.allowClonedVoices ? 'uvoice_000000000000' : null;
    const premPrice = premCandidateVal ? await quoteFn({ ...baseIn, [voiceField.name]: premCandidateVal }) : null;
    const unit = def.unitLabel || '1.000 ký tự';
    const items: AiPriceOptionItem[] = [];
    if (stdPrice !== null) items.push({ label: premPrice !== null && premPrice !== stdPrice ? 'Giọng tiêu chuẩn' : 'Mọi giọng đọc', price: stdPrice, unit });
    if (premPrice !== null && premPrice !== stdPrice) {
      items.push({
        label: voiceField.allowClonedVoices ? 'Giọng cao cấp & Giọng nhân bản' : 'Giọng cao cấp',
        price: premPrice,
        unit,
      });
    }
    return finalizeBreakdown({ defaultPrice: stdPrice ?? defaultPrice, unitLabel: unit, items, note: def.priceHint });
  }

  // 4) Công cụ Nâng cấp Video 4K (`up4k`)
  if (providerKey === 'up4k') {
    const model = String(baseIn.model ?? '4k-fast').toLowerCase();
    if (model === '4k-fast') {
      const [p35, p70] = await Promise.all([
        quoteFn({ ...baseIn, __sampleSec: 35 }),
        quoteFn({ ...baseIn, __sampleSec: 70 }),
      ]);
      const items: AiPriceOptionItem[] = [];
      if (p35 !== null) items.push({ label: 'Video ≤ 35s (đồng giá)', price: p35, unit: 'video' });
      if (p70 !== null) items.push({ label: 'Video 36s – 70s', price: p70, unit: 'video' });
      return finalizeBreakdown({
        defaultPrice: p35 ?? defaultPrice,
        unitLabel: 'video',
        items,
        note: 'Trên 35 giây tính thêm theo từng nấc 35 giây',
      });
    }
    const sampleSecs = [5, 10, 15, 30];
    const prices = await Promise.all(sampleSecs.map((s) => quoteFn({ ...baseIn, __sampleSec: s })));
    const items = sampleSecs
      .map((s, idx) => (prices[idx] !== null ? { label: `Video ${s}s`, price: prices[idx]! } : null))
      .filter((x): x is AiPriceOptionItem => !!x);
    return finalizeBreakdown({
      defaultPrice: prices[1] ?? defaultPrice,
      unitLabel: 'giây',
      items,
      note: 'Tính chính xác theo từng 0,1 giây độ dài video tải lên',
    });
  }

  const resCandidates = def.fields
    .filter((f) => !f.hidden && f.type === 'select' && RES_FIELD_NAMES.has(f.name))
    .sort((a, b) => activeOptions(b, baseIn).length - activeOptions(a, baseIn).length);
  const resField = resCandidates[0];
  const secondaryResField = resCandidates.length > 1 && activeOptions(resCandidates[1], baseIn).length >= 2 ? resCandidates[1] : undefined;
  const groupField = def.fields.find((f) => !f.hidden && f.type === 'select' && GROUP_FIELD_NAMES.has(f.name)) ?? secondaryResField;
  const optField = def.fields.find((f) => !f.hidden && f.type === 'select' && f.name === 'option');
  const durField = def.fields.find((f) => !f.hidden && f.type === 'select' && DUR_FIELD_NAMES.has(f.name));
  const audioField = def.fields.find((f) => !f.hidden && f.type === 'boolean' && f.name === 'audio');
  const draftField = def.fields.find((f) => !f.hidden && f.type === 'boolean' && f.name === 'draft');

  // 5) Bảng ma trận 2 chiều (Độ phân giải × Thời lượng) cho các công cụ tạo Video đa cấu hình
  if (resField && durField) {
    const groupOpts = groupField ? activeOptions(groupField, baseIn) : [{ value: '__default__', label: '' }];
    const rawTables: { groupLabel: string; audioLabel: string; table: AiPriceMatrixTable; key: string }[] = [];
    let trimmedNote: string | null = null;

    for (const gOpt of groupOpts) {
      const gInput: AiInput = groupField && gOpt.value !== '__default__' ? { ...baseIn, [groupField.name]: gOpt.value } : { ...baseIn };
      const resOpts = [...activeOptions(resField, gInput)].sort((a, b) => resRank(a) - resRank(b));
      const allDurOpts = activeOptions(durField, gInput);
      if (!resOpts.length || !allDurOpts.length) continue;

      const { chosen: durOpts, trimmedRange } = selectMilestoneDurations(allDurOpts);
      if (trimmedRange && !trimmedNote) {
        trimmedNote = `Hỗ trợ chọn tự do từng giây từ ${trimmedRange[0]}s đến ${trimmedRange[1]}s`;
      }
      const columns = durOpts.map(shortDurLabel);

      const hasAudio = !!audioField && isFieldVisible(audioField, gInput);
      const defaultAudio = Boolean(gInput.audio);
      const audioVariants: { val: boolean | null; label: string }[] = hasAudio
        ? [
            { val: defaultAudio, label: defaultAudio ? 'Có âm thanh' : 'Tắt âm thanh' },
            { val: !defaultAudio, label: !defaultAudio ? 'Có âm thanh' : 'Tắt âm thanh' },
          ]
        : [{ val: null, label: '' }];

      let firstVariantFingerprint = '';
      for (let vIdx = 0; vIdx < audioVariants.length; vIdx++) {
        const av = audioVariants[vIdx];
        const rows: { label: string; prices: (number | null)[] }[] = [];
        for (const rOpt of resOpts) {
          const prices = await Promise.all(
            durOpts.map((dOpt) =>
              quoteFn({
                ...gInput,
                [resField.name]: rOpt.value,
                [durField.name]: dOpt.value,
                ...(av.val !== null ? { audio: av.val } : {}),
                ...(draftField ? { draft: false } : {}),
              }),
            ),
          );
          if (prices.some((p) => p !== null)) {
            rows.push({ label: cleanOptionLabel(rOpt.label), prices });
          }
        }

        // Hàng "Bản nháp (Nhanh)" nếu công cụ có bật `draft` và chỉ thêm ở bảng đầu của nhóm
        if (vIdx === 0 && draftField && isFieldVisible(draftField, gInput)) {
          const draftPrices = await Promise.all(
            durOpts.map((dOpt) =>
              quoteFn({
                ...gInput,
                [durField.name]: dOpt.value,
                ...(av.val !== null ? { audio: av.val } : {}),
                draft: true,
              }),
            ),
          );
          if (draftPrices.some((p) => p !== null)) {
            const draftFp = JSON.stringify(draftPrices);
            if (!rows.some((r) => JSON.stringify(r.prices) === draftFp)) {
              rows.push({ label: 'Bản nháp (Nhanh)', prices: draftPrices });
            }
          }
        }

        if (!rows.length) continue;
        const fp = JSON.stringify({ columns, rows });
        if (vIdx === 1 && fp === firstVariantFingerprint) continue;
        if (vIdx === 0) firstVariantFingerprint = fp;

        rawTables.push({
          groupLabel: gOpt.label ? cleanOptionLabel(gOpt.label) : '',
          audioLabel: av.label,
          table: { rowHeader: cleanOptionLabel(resField.label) || 'Độ phân giải', columns, rows },
          key: `${av.label}::${fp}`,
        });
      }
    }

    // Gộp các chế độ (vd t2v / i2v / flf / ref) nếu có chung 100% bảng giá để tránh lặp bảng trùng
    const mergedByKey = new Map<string, { groupLabels: string[]; audioLabel: string; table: AiPriceMatrixTable }>();
    const totalDistinctGroups = new Set(rawTables.map((x) => x.groupLabel).filter(Boolean)).size;
    for (const entry of rawTables) {
      const cur = mergedByKey.get(entry.key);
      if (cur) {
        if (entry.groupLabel && !cur.groupLabels.includes(entry.groupLabel)) cur.groupLabels.push(entry.groupLabel);
      } else {
        mergedByKey.set(entry.key, {
          groupLabels: entry.groupLabel ? [entry.groupLabel] : [],
          audioLabel: entry.audioLabel,
          table: entry.table,
        });
      }
    }

    const distinctAudioLabels = new Set([...mergedByKey.values()].map((x) => x.audioLabel).filter(Boolean)).size;
    const finalTables: AiPriceMatrixTable[] = [...mergedByKey.values()].map((m) => {
      const showGroup = m.groupLabels.length > 0 && m.groupLabels.length < totalDistinctGroups;
      const parts: string[] = [];
      if (showGroup) parts.push(m.groupLabels.join(' / '));
      if (distinctAudioLabels > 1 && m.audioLabel) parts.push(m.audioLabel);
      return {
        ...m.table,
        ...(parts.length ? { title: parts.join(' · ') } : {}),
      };
    });

    // Trích tóm tắt nhanh ở dòng đầu (mức đầu của mỗi độ phân giải ở bảng chính)
    const summaryItems: AiPriceOptionItem[] = [];
    const primary = finalTables[0];
    if (primary) {
      for (const r of primary.rows.slice(0, 4)) {
        const firstIdx = r.prices.findIndex((p) => p !== null);
        if (firstIdx >= 0 && r.prices[firstIdx] !== null) {
          summaryItems.push({
            label: `${r.label} · ${primary.columns[firstIdx]}`,
            price: r.prices[firstIdx]!,
          });
        }
      }
    }

    return finalizeBreakdown({
      defaultPrice,
      unitLabel: def.unitLabel ?? null,
      items: summaryItems,
      tables: finalTables,
      note: trimmedNote ?? def.priceHint ?? null,
    });
  }

  // 6) Công cụ 1 chiều hoặc tổ hợp gọn (TMC `option`, Ảnh 1K/2K/4K, Topaz `engine × quality`, hoặc chỉ `duration`)
  const hasUploadedMediaWithoutDurSelect =
    !durField &&
    !optField &&
    def.fields.some((f) => f.type === 'video' || f.type === 'audio');

  const detectMediaRate = async (input: AiInput): Promise<{ price: number; unit: string | null } | null> => {
    if (!hasUploadedMediaWithoutDurSelect) {
      const p = await quoteFn(input);
      return p !== null ? { price: p, unit: def.unitLabel ?? null } : null;
    }
    const [p1, p10, p20] = await Promise.all([
      quoteFn({ ...input, __sampleSec: 1 }),
      quoteFn({ ...input, __sampleSec: 10 }),
      quoteFn({ ...input, __sampleSec: 20 }),
    ]);
    if (p10 === null) return p1 !== null ? { price: p1, unit: def.unitLabel ?? null } : null;
    if (p1 !== null && p10 === p1 && (p20 === null || p20 === p10)) {
      return { price: p10, unit: def.unitLabel && def.unitLabel !== 'giây' ? def.unitLabel : 'video' };
    }
    if (p20 !== null && p20 > p10) {
      const perSec = Math.round((p20 - p10) / 10);
      if (perSec > 0) return { price: perSec, unit: 'giây' };
    }
    return { price: Math.max(1, Math.round(p10 / 10)), unit: 'giây' };
  };

  if (optField) {
    const opts = activeOptions(optField, baseIn);
    const items: AiPriceOptionItem[] = [];
    for (const o of opts) {
      const p = await quoteFn({ ...baseIn, [optField.name]: o.value });
      if (p !== null) items.push({ label: cleanOptionLabel(o.label), price: p });
    }
    if (items.length) {
      return finalizeBreakdown({ defaultPrice, unitLabel: def.unitLabel ?? null, items, note: def.priceHint });
    }
  }

  if (groupField && resField) {
    const gOpts = activeOptions(groupField, baseIn);
    const comboItems: AiPriceOptionItem[] = [];
    for (const g of gOpts) {
      const gIn = { ...baseIn, [groupField.name]: g.value };
      const rOpts = [...activeOptions(resField, gIn)].sort((a, b) => resRank(a) - resRank(b));
      for (const r of rOpts) {
        const res = await detectMediaRate({ ...gIn, [resField.name]: r.value });
        if (res) {
          comboItems.push({
            label: gOpts.length > 1 ? `${cleanOptionLabel(g.label)} · ${cleanOptionLabel(r.label)}` : cleanOptionLabel(r.label),
            price: res.price,
            unit: res.unit,
          });
        }
      }
    }
    if (comboItems.length) {
      return finalizeBreakdown({ defaultPrice, unitLabel: comboItems[0]?.unit ?? def.unitLabel ?? null, items: comboItems, note: def.priceHint });
    }
  }

  const singleSelectField = resField ?? durField ?? groupField;
  if (singleSelectField) {
    let opts = activeOptions(singleSelectField, baseIn);
    if (singleSelectField === resField) opts = [...opts].sort((a, b) => resRank(a) - resRank(b));
    else if (singleSelectField === durField) opts = selectMilestoneDurations(opts).chosen;

    const items: AiPriceOptionItem[] = [];
    for (const o of opts) {
      const res = await detectMediaRate({ ...baseIn, [singleSelectField.name]: o.value });
      if (res) {
        items.push({
          label: singleSelectField === durField ? shortDurLabel(o) : cleanOptionLabel(o.label),
          price: res.price,
          unit: res.unit,
        });
      }
    }
    if (items.length) {
      return finalizeBreakdown({ defaultPrice, unitLabel: items[0]?.unit ?? def.unitLabel ?? null, items, note: def.priceHint });
    }
  }

  // 7) Công cụ 1 mức giá cố định / theo giây đơn thuần
  const singleRate = await detectMediaRate(baseIn);
  const finalPrice = singleRate?.price ?? defaultPrice;
  const finalUnit = singleRate?.unit ?? def.unitLabel ?? null;
  const items: AiPriceOptionItem[] =
    finalPrice !== null
      ? [
          {
            label: finalUnit === 'giây' ? 'Đơn giá theo thời lượng' : finalUnit ? `1 ${finalUnit}` : '1 lượt thực hiện',
            price: finalPrice,
            unit: finalUnit,
          },
        ]
      : [];

  return finalizeBreakdown({
    defaultPrice: finalPrice,
    unitLabel: finalUnit,
    items,
    note: def.priceHint,
  });
}
