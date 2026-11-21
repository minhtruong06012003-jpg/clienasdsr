import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { safeFetch, SafeFetchError } from '../../common/utils/safe-fetch.js';
import { AiService } from './ai.service.js';
import type { AiToolPriceBreakdown } from './ai-price-matrix.js';
import { AI_UPLOAD_HARD_MB, AiFilesService } from './ai-files.service.js';
import { hideProviderText, internalToolKey, publicToolKey } from './ai-public-key.js';
import { API_MODEL_RE, apiParams, canonicalModelSlug, fileFields, slugGroup, slugModel, toInternalInput } from './ai-model-api.js';
import { providerDefaultBadge } from './providers/index.js';
import { isDeletedTool, type AiFieldDef } from './ai.types.js';

/** Công cụ như AiService.publicTools() trả về (chỉ các trường cần dùng) */
type PublicTool = {
  key: string;
  name: string;
  description: string | null;
  category: string;
  badge?: string | null;
  maintenance?: boolean;
  updatedAt?: Date | string;
  group?: string | null;
  groups?: string[];
  modelLabel: string;
  output: string;
  price?: number | null;
  fields: AiFieldDef[];
  pricing: { mode: 'fixed' | 'dynamic' | 'free' | 'tiers'; base?: number; perUnit?: number; tier10to20?: number; tier20to30?: number; unitLabel?: string | null; min: number };
};

/** Tác vụ như AiService.myTask() trả về */
type Task = {
  id: string;
  code: string;
  toolKey: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  progress: number;
  output: unknown;
  credits: number;
  refunded: boolean;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  tool: { output: string } | null;
};

type ModelFilter = {
  type?: string;
  output?: string;
  server?: string;
  status?: 'healthy' | 'maintenance' | 'all';
  canonical_model?: string;
};

/** Trạng thái tác vụ nội bộ -> trạng thái chữ thường của API `/v1` */
const STATUS: Record<Task['status'], string> = { PENDING: 'queued', PROCESSING: 'processing', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled' };

/** Danh sách lựa chọn dài hơn mức này (vd hàng nghìn giọng đọc) không trả trong `GET /v1/models`, xem chi tiết từng model */
const LIST_OPTIONS_MAX = 60;

/** Số file URL ngoài tối đa tải về trong một lần gọi */
const MAX_REMOTE_FILES = 10;

/** Chuẩn hoá nhãn máy chủ SVx từ badge hoặc provider (tuyệt đối không lộ tên nhà cung cấp nội bộ) */
function resolveServerBadge(intKey: string, badge?: string | null): { serverId: string; serverName: string } {
  const cleanBadge = String(badge ?? '').trim();
  if (/^SV\d+$/i.test(cleanBadge)) {
    const upper = cleanBadge.toUpperCase();
    return { serverId: upper.toLowerCase(), serverName: upper };
  }
  const providerKey = intKey.includes('.') ? intKey.slice(0, intKey.indexOf('.')) : '';
  const def = providerKey ? providerDefaultBadge(providerKey) : 'SV1';
  const upper = def.toUpperCase();
  return { serverId: upper.toLowerCase(), serverName: upper };
}

/** Số thứ tự SV để sắp xếp SV1 -> SV2 -> SV15 */
function serverOrderNum(serverId: string): number {
  const n = Number(serverId.replace(/^sv/i, ''));
  return Number.isFinite(n) ? n : 999;
}

/** Giá đại diện (VNĐ) để sắp xếp server rẻ nhất lên đầu */
function representativePrice(t: PublicTool, bd?: AiToolPriceBreakdown): number {
  if (t.pricing.mode === 'free') return 0;
  if (bd && typeof bd.minPrice === 'number' && bd.minPrice >= 0) return bd.minPrice;
  if (typeof t.price === 'number' && t.price >= 0) return t.price;
  if (typeof t.pricing.base === 'number' && t.pricing.base > 0) return t.pricing.base;
  if (typeof t.pricing.tier10to20 === 'number' && t.pricing.tier10to20 > 0) return t.pricing.tier10to20;
  return Number.MAX_SAFE_INTEGER;
}

/** Tên đẹp của nhóm canonical_model (bỏ mô tả sau dấu · / ngoặc) */
function cleanCanonicalDisplayName(t: PublicTool): string {
  const raw = (t.modelLabel || t.name || '').trim();
  const head = raw.split(/\s[·•|]\s|\s[-–—]\s|\s?\(/)[0]?.trim() || raw;
  return head.replace(/^(Tạo\s*&\s*Ghép\s*Ảnh|Tạo\s*video|Tạo\s*ảnh)\s+/i, '').trim() || raw;
}

/**
 * API khách theo model chuẩn (`/api/v1`): danh mục model, cấu trúc `Model -> Server (SV)` (T-445),
 * tạo / xem tác vụ bằng tên model gốc + máy chủ SV tuỳ chọn + tham số chuẩn.
 */
@Injectable()
export class AiModelApiService {
  private readonly logger = new Logger('AiModelApi');
  /** Bảng mã model <-> khoá công cụ nội bộ, làm mới mỗi phút hoặc khi admin đổi mã */
  private ids: { at: number; byKey: Map<string, string>; byId: Map<string, string> } | null = null;
  private loading: Promise<NonNullable<AiModelApiService['ids']>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly files: AiFilesService,
  ) {}

  // ---------------- mã model ----------------

  /** Bảng mã model (sinh mã cho công cụ mới chưa có) — gộp các lần gọi song song để không sinh trùng */
  private async idMap() {
    if (this.ids && Date.now() - this.ids.at < 60_000) return this.ids;
    this.loading ??= this.buildIds().finally(() => (this.loading = null));
    return (this.ids = await this.loading);
  }

  /**
   * Đọc mã model đã lưu; công cụ chưa có mã thì sinh: tên model chuẩn (vd `kling-2.6`), trùng với mã đã có thì thêm tác vụ
   * phía sau (vd `kling-2.6/first-last-frame`). Công cụ đang bật, đứng trước được ưu tiên giữ tên gọn.
   * Bỏ qua công cụ gốc đã tách theo model (khách gọi model con).
   */
  private async buildIds() {
    const rawRows = await this.prisma.aiTool.findMany({
      select: { key: true, name: true, modelLabel: true, options: true, enabled: true, sortOrder: true, createdAt: true },
      orderBy: [{ enabled: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const rows = rawRows.filter((r) => !isDeletedTool(r.options));
    const parents = new Set(rows.filter((r) => r.key.includes('~')).map((r) => r.key.slice(0, r.key.indexOf('~'))));
    const byKey = new Map<string, string>();
    const byId = new Map<string, string>();
    const saved = (r: (typeof rows)[number]) => String(((r.options ?? {}) as Record<string, unknown>).apiModel ?? '');
    for (const r of rows) {
      const id = saved(r);
      if (id && !byId.has(id)) {
        byKey.set(r.key, id);
        byId.set(id, r.key);
      }
    }
    for (const r of rows) {
      if (byKey.has(r.key) || parents.has(r.key)) continue;
      const sep = r.key.indexOf('~');
      const task = slugModel(r.key.slice(r.key.indexOf('.') + 1, sep < 0 ? undefined : sep)) || 'tool';
      const cand = sep < 0 ? task : slugModel(r.modelLabel || r.key.slice(sep + 1)) || task;
      let id = cand;
      if (byId.has(id) && sep >= 0 && task !== cand) id = `${cand}/${task}`;
      for (let n = 2; byId.has(id); n++) id = sep >= 0 && task !== cand ? `${cand}/${task}-${n}` : `${cand}-${n}`;
      byKey.set(r.key, id);
      byId.set(id, r.key);
      await this.prisma.aiTool.update({ where: { key: r.key }, data: { options: { ...((r.options ?? {}) as object), apiModel: id } } });
      this.logger.log(`Mã model API cho ${r.key}: ${id}`);
    }
    return { at: Date.now(), byKey, byId };
  }

  /** Admin đổi mã model API của một công cụ (để trống = sinh lại tự động) */
  async setApiModel(key: string, raw: string | null | undefined) {
    const row = await this.prisma.aiTool.findUnique({ where: { key }, select: { key: true, options: true } });
    if (!row) throw new NotFoundException('Không tìm thấy công cụ');
    const id = String(raw ?? '').trim().toLowerCase();
    if (id && !API_MODEL_RE.test(id)) throw new BadRequestException('Mã model chỉ gồm chữ thường, số, dấu . - _ và tối đa một dấu / (vd kling-2.6 hoặc kling-2.6/image-to-video)');
    if (id) {
      const other = (await this.idMap()).byId.get(id);
      if (other && other !== key) throw new ConflictException(`Mã model "${id}" đang dùng cho công cụ khác`);
    }
    const options = { ...((row.options ?? {}) as Record<string, unknown>) };
    if (id) options.apiModel = id;
    else delete options.apiModel;
    await this.prisma.aiTool.update({ where: { key }, data: { options: options as object } });
    this.ids = null;
    return { key, apiModel: (await this.idMap()).byKey.get(key) ?? null };
  }

  /** Mã model API của mọi công cụ (trang admin hiển thị) */
  async adminApiModels() {
    return Object.fromEntries((await this.idMap()).byKey);
  }

  // ---------------- danh mục model & cấu trúc Model -> Server (SV) ----------------

  /** Trình bày một công cụ thành model của API `/v1` (kèm server_id, server_status, canonical_model & bảng giá chi tiết) */
  private present(t: PublicTool, id: string, full: boolean, bd?: AiToolPriceBreakdown) {
    const intKey = internalToolKey(t.key);
    const { serverId, serverName } = resolveServerBadge(intKey, t.badge);
    const isMaint = Boolean(t.maintenance);
    const serverStatus: 'healthy' | 'maintenance' = isMaint ? 'maintenance' : 'healthy';
    const canonicalModel = canonicalModelSlug(id, t.modelLabel || t.name, t.category);
    const groupName = t.group ?? cleanCanonicalDisplayName(t);
    const groupId = slugGroup(t.group) ?? canonicalModel;
    const updatedAt = t.updatedAt ? new Date(t.updatedAt).toISOString() : null;

    const params = apiParams(t.fields).map((p) => {
      if (!full && p.options && p.options.length > LIST_OPTIONS_MAX) return { ...p, options: undefined, options_count: p.options.length };
      return p;
    });
    const pr = t.pricing;
    const matrixMeta = bd
      ? {
          min_price: bd.minPrice,
          max_price: bd.maxPrice,
          default_price: bd.defaultPrice,
          ...(bd.unitLabel ? { unit: bd.unitLabel } : {}),
          items: bd.items,
          ...(bd.tables?.length ? { tables: bd.tables } : {}),
          ...(bd.note ? { note: bd.note } : {}),
        }
      : {};
    return {
      id,
      object: 'model',
      canonical_model: canonicalModel,
      group_id: groupId,
      group_name: groupName,
      server_id: serverId,
      server_name: serverName,
      server_status: serverStatus,
      maintenance: isMaint,
      updated_at: updatedAt,
      name: t.modelLabel || t.name,
      type: t.category,
      output: t.output,
      description: t.description,
      pricing:
        pr.mode === 'free'
          ? { mode: 'free', min_price: 0, max_price: 0, default_price: 0, currency: 'VND' }
          : pr.mode === 'dynamic'
            ? { mode: 'dynamic', min: pr.min, currency: 'VND', ...matrixMeta }
            : pr.mode === 'tiers'
              ? {
                  mode: 'tiers',
                  base: Math.ceil(pr.tier10to20 ?? pr.base ?? 0),
                  tier10to20: Math.ceil(pr.tier10to20 ?? pr.base ?? 0),
                  tier20to30: Math.ceil(pr.tier20to30 ?? pr.tier10to20 ?? pr.base ?? 0),
                  min: pr.min,
                  currency: 'VND',
                  ...matrixMeta,
                }
              : {
                  mode: 'fixed',
                  base: Math.round((pr.base ?? 0) * 10000) / 10000,
                  per_unit: Math.round((pr.perUnit ?? 0) * 10000) / 10000,
                  unit: pr.unitLabel ?? null,
                  min: pr.min,
                  currency: 'VND',
                  ...matrixMeta,
                },
      params,
    };
  }

  /** Đọc toàn bộ danh sách công cụ công khai kèm id & bảng giá để lọc / nhóm */
  private async loadCatalogEntries() {
    const [ids, toolsRaw, matrix] = await Promise.all([
      this.idMap(),
      this.ai.publicTools(),
      this.ai.publicPriceMatrix().catch(() => ({} as Record<string, AiToolPriceBreakdown>)),
    ]);
    const tools = toolsRaw as unknown as PublicTool[];
    const entries: {
      tool: PublicTool;
      intKey: string;
      id: string;
      canonicalModel: string;
      serverId: string;
      serverName: string;
      serverStatus: 'healthy' | 'maintenance';
      repPrice: number;
      bd?: AiToolPriceBreakdown;
    }[] = [];
    for (const t of tools) {
      const intKey = internalToolKey(t.key);
      const id = ids.byKey.get(intKey);
      if (!id) continue;
      const { serverId, serverName } = resolveServerBadge(intKey, t.badge);
      const serverStatus: 'healthy' | 'maintenance' = t.maintenance ? 'maintenance' : 'healthy';
      const canonicalModel = canonicalModelSlug(id, t.modelLabel || t.name, t.category);
      const bd = matrix[t.key];
      entries.push({
        tool: t,
        intKey,
        id,
        canonicalModel,
        serverId,
        serverName,
        serverStatus,
        repPrice: representativePrice(t, bd),
        bd,
      });
    }
    return { ids, entries, matrix };
  }

  /** `GET /v1/models`: danh sách model đang mở bán (mỗi model kèm sẵn `canonical_model`, `server_id`, `server_name`, `server_status`) */
  async listModels(q: ModelFilter = {}) {
    const { entries } = await this.loadCatalogEntries();
    const serverFilter = q.server ? q.server.trim().toLowerCase() : undefined;
    const canonFilter = q.canonical_model
      ? canonicalModelSlug(q.canonical_model.trim().toLowerCase(), q.canonical_model.trim())
      : undefined;
    const statusFilter = q.status && q.status !== 'all' ? q.status : undefined;

    const data = entries
      .filter((e) => {
        if (q.type && e.tool.category !== q.type) return false;
        if (q.output && e.tool.output !== q.output) return false;
        if (serverFilter && e.serverId !== serverFilter) return false;
        if (statusFilter && e.serverStatus !== statusFilter) return false;
        if (canonFilter && e.canonicalModel !== canonFilter && e.id !== q.canonical_model?.trim().toLowerCase()) return false;
        return true;
      })
      .map((e) => this.present(e.tool, e.id, false, e.bd));
    return { object: 'list', data };
  }

  /**
   * `GET /v1/models/groups`: danh mục gộp theo cấu trúc `Model -> Server (SV)` (T-445).
   * Mỗi phần tử là 1 model chuẩn (vd `seedream-5.5`, `seedance-2.5`, `wan-3.0`) chứa mảng `servers` (`sv1`..`sv15+`)
   * kèm `server_status` (`healthy` | `maintenance`), bảng giá, tham số và `recommended_server_id`.
   */
  async listModelGroups(q: ModelFilter = {}) {
    const { entries } = await this.loadCatalogEntries();
    const serverFilter = q.server ? q.server.trim().toLowerCase() : undefined;
    const statusFilter = q.status && q.status !== 'all' ? q.status : undefined;
    const canonFilter = q.canonical_model
      ? canonicalModelSlug(q.canonical_model.trim().toLowerCase(), q.canonical_model.trim())
      : undefined;

    const grouped = new Map<string, typeof entries>();
    for (const e of entries) {
      if (q.type && e.tool.category !== q.type) continue;
      if (q.output && e.tool.output !== q.output) continue;
      if (serverFilter && e.serverId !== serverFilter) continue;
      if (statusFilter && e.serverStatus !== statusFilter) continue;
      if (canonFilter && e.canonicalModel !== canonFilter) continue;
      const arr = grouped.get(e.canonicalModel) ?? [];
      arr.push(e);
      grouped.set(e.canonicalModel, arr);
    }

    const data = [...grouped.entries()].map(([canon, list]) => {
      const sortedServers = [...list].sort((a, b) => {
        if (a.serverStatus !== b.serverStatus) return a.serverStatus === 'healthy' ? -1 : 1;
        if (a.repPrice !== b.repPrice) return a.repPrice - b.repPrice;
        return serverOrderNum(a.serverId) - serverOrderNum(b.serverId);
      });
      const primary = sortedServers[0];
      const healthyList = sortedServers.filter((s) => s.serverStatus === 'healthy');
      const recommended = healthyList[0] ?? null;
      const prices = sortedServers
        .map((s) => (s.repPrice < Number.MAX_SAFE_INTEGER ? s.repPrice : null))
        .filter((x): x is number => x !== null);
      const maxPrices = sortedServers
        .map((s) => (typeof s.bd?.maxPrice === 'number' ? s.bd.maxPrice : s.repPrice < Number.MAX_SAFE_INTEGER ? s.repPrice : null))
        .filter((x): x is number => x !== null);

      return {
        object: 'model_group',
        model: canon,
        name: cleanCanonicalDisplayName(primary.tool),
        type: primary.tool.category,
        output: primary.tool.output,
        group_id: slugGroup(primary.tool.group) ?? canon,
        group_name: primary.tool.group ?? cleanCanonicalDisplayName(primary.tool),
        healthy_servers_count: healthyList.length,
        total_servers_count: sortedServers.length,
        recommended_server_id: recommended?.serverId ?? null,
        recommended_model_id: recommended?.id ?? null,
        min_price: prices.length ? Math.min(...prices) : null,
        max_price: maxPrices.length ? Math.max(...maxPrices) : null,
        currency: 'VND',
        servers: sortedServers.map((s) => {
          const presented = this.present(s.tool, s.id, false, s.bd);
          return {
            server_id: s.serverId,
            server_name: s.serverName,
            server_status: s.serverStatus,
            maintenance: s.serverStatus === 'maintenance',
            model_id: s.id,
            name: presented.name,
            updated_at: presented.updated_at,
            pricing: presented.pricing,
            params: presented.params,
          };
        }),
      };
    });

    return { object: 'list', data };
  }

  /**
   * `GET /v1/models/{model}/servers`: kiểm tra danh sách toàn bộ máy chủ (`SV1..SV15+`) của 1 model,
   * trạng thái sống (`healthy` | `maintenance`), bảng giá & tham số từng SV trước khi confirm gọi `POST /v1/generations`.
   */
  async getModelServers(modelOrId: string) {
    const raw = String(modelOrId ?? '').trim().toLowerCase();
    if (!raw) throw new BadRequestException('Thiếu mã model');
    const { entries } = await this.loadCatalogEntries();
    const targetCanon = canonicalModelSlug(raw, raw);

    // Cho phép truyền cả mã canonical (`seedream-5.5`) lẫn mã route lẻ (`seedream-5-5`)
    const exactEntry = entries.find((e) => e.id === raw);
    const resolvedCanon = exactEntry ? exactEntry.canonicalModel : targetCanon;
    const matched = entries.filter(
      (e) => e.canonicalModel === resolvedCanon || slugGroup(e.tool.group) === raw,
    );

    if (!matched.length) {
      throw new NotFoundException(`Model "${modelOrId}" không tồn tại hoặc không có máy chủ nào đang mở. Xem danh sách ở GET /api/v1/models/groups`);
    }

    const sortedServers = [...matched].sort((a, b) => {
      if (a.serverStatus !== b.serverStatus) return a.serverStatus === 'healthy' ? -1 : 1;
      if (a.repPrice !== b.repPrice) return a.repPrice - b.repPrice;
      return serverOrderNum(a.serverId) - serverOrderNum(b.serverId);
    });
    const healthyList = sortedServers.filter((s) => s.serverStatus === 'healthy');
    const recommended = healthyList[0] ?? null;
    const primary = sortedServers[0];

    return {
      object: 'model_servers',
      model: resolvedCanon,
      name: cleanCanonicalDisplayName(primary.tool),
      type: primary.tool.category,
      output: primary.tool.output,
      healthy_servers_count: healthyList.length,
      total_servers_count: sortedServers.length,
      recommended_server_id: recommended?.serverId ?? null,
      recommended_model_id: recommended?.id ?? null,
      servers: sortedServers.map((s) => {
        const presented = this.present(s.tool, s.id, true, s.bd);
        return {
          server_id: s.serverId,
          server_name: s.serverName,
          server_status: s.serverStatus,
          maintenance: s.serverStatus === 'maintenance',
          model_id: s.id,
          name: presented.name,
          description: presented.description,
          updated_at: presented.updated_at,
          pricing: presented.pricing,
          params: presented.params,
        };
      }),
    };
  }

  /**
   * Tìm công cụ theo `model` + tuỳ chọn `server` (`"sv15"` | `"auto"`):
   * - Nếu truyền `server` cụ thể (vd `"sv15"`): chọn đúng máy chủ `SV15` của model đó (nếu SV đó đang `maintenance` thì báo lỗi rõ kèm danh sách SV `healthy`).
   * - Nếu truyền `server: "auto"`: tự chọn máy chủ `healthy` có giá tốt nhất và tương thích bộ tham số gửi lên.
   * - Nếu không truyền `server`: giữ nguyên tương thích ngược 100% theo `id` route lẻ (hoặc nếu gửi `canonical_model` như `seedance-2.0` / route đang bảo trì thì tự định tuyến sang SV `healthy` tương đương).
   */
  private async findModel(id: string, serverSelector?: string | null, rawParams?: Record<string, unknown>) {
    const normId = String(id ?? '').trim().toLowerCase();
    const normServer = serverSelector ? serverSelector.trim().toLowerCase() : null;
    if (normServer && !/^(sv\d+|auto)$/.test(normServer)) {
      throw new BadRequestException(`Tham số "server" ("${serverSelector}") không hợp lệ — hãy truyền mã máy chủ dạng "sv1", "sv3", "sv15"... hoặc "auto"`);
    }

    const { ids, entries } = await this.loadCatalogEntries();
    const targetCanon = canonicalModelSlug(normId, normId);
    const exactById = entries.find((e) => e.id === normId);
    const resolvedCanon = exactById ? exactById.canonicalModel : targetCanon;
    const family = entries.filter((e) => e.canonicalModel === resolvedCanon);

    const pickBestCompatible = (candidates: typeof entries) => {
      const sorted = [...candidates].sort((a, b) => {
        if (a.serverStatus !== b.serverStatus) return a.serverStatus === 'healthy' ? -1 : 1;
        if (a.repPrice !== b.repPrice) return a.repPrice - b.repPrice;
        return serverOrderNum(a.serverId) - serverOrderNum(b.serverId);
      });
      if (rawParams && Object.keys(rawParams).length > 0 && sorted.length > 1) {
        const compatible = sorted.find((c) => {
          try {
            const { unknown } = toInternalInput(c.tool.fields, rawParams);
            return unknown.length === 0;
          } catch {
            return false;
          }
        });
        if (compatible) return compatible;
      }
      return sorted[0];
    };

    // 1) Khách chỉ định rõ `server` ("sv1".."sv99" hoặc "auto")
    if (normServer) {
      if (!family.length) {
        throw new NotFoundException(`Model "${id}" không tồn tại. Xem danh sách model & server ở GET /api/v1/models/groups`);
      }
      const healthyFamily = family.filter((e) => e.serverStatus === 'healthy');
      const healthyHint = healthyFamily.length
        ? `Các máy chủ đang hoạt động (healthy): ${[...new Set(healthyFamily.map((h) => `${h.serverName} ("${h.serverId}")`))].join(', ')}`
        : 'Hiện tất cả máy chủ của model này đều đang tạm bảo trì';

      if (normServer === 'auto') {
        if (!healthyFamily.length) {
          throw new ConflictException(`Tất cả máy chủ của model "${resolvedCanon}" hiện đang bảo trì tạm thời (maintenance). Xem trạng thái tại GET /api/v1/models/${resolvedCanon}/servers`);
        }
        const chosen = pickBestCompatible(healthyFamily);
        const fullTool = ((await this.ai.publicTool(chosen.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? chosen.tool;
        return { key: chosen.intKey, pubKey: chosen.tool.key, tool: fullTool, resolvedId: chosen.id, serverId: chosen.serverId, serverName: chosen.serverName, canonicalModel: chosen.canonicalModel };
      }

      const onServer = family.filter((e) => e.serverId === normServer);
      if (!onServer.length) {
        const allAvailable = [...new Set(family.map((f) => `${f.serverName} ("${f.serverId}", ${f.serverStatus})`))].join(', ');
        throw new NotFoundException(
          `Model "${resolvedCanon}" không có trên máy chủ "${normServer.toUpperCase()}". Máy chủ hiện có của model này: ${allAvailable}. Xem chi tiết tại GET /api/v1/models/${resolvedCanon}/servers`,
        );
      }
      const healthyOnServer = onServer.filter((e) => e.serverStatus === 'healthy');
      if (!healthyOnServer.length) {
        throw new ConflictException(
          `Máy chủ ${normServer.toUpperCase()} của model "${resolvedCanon}" đang bảo trì tạm thời (server_status: maintenance). ${healthyHint}. Xem GET /api/v1/models/${resolvedCanon}/servers`,
        );
      }
      // Nếu khách vừa truyền đúng route id cụ thể trên đúng SV đó thì ưu tiên route đó, ngược lại chọn bản tương thích tham số / giá rẻ nhất trên SV đó
      const exactOnServer = healthyOnServer.find((e) => e.id === normId);
      const chosen = exactOnServer ?? pickBestCompatible(healthyOnServer);
      const fullTool = ((await this.ai.publicTool(chosen.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? chosen.tool;
      return { key: chosen.intKey, pubKey: chosen.tool.key, tool: fullTool, resolvedId: chosen.id, serverId: chosen.serverId, serverName: chosen.serverName, canonicalModel: chosen.canonicalModel };
    }

    // 2) Không truyền `server`: giữ tương thích ngược theo route `id`, kèm tự động chuyển sang SV `healthy` nếu route mặc định đang bảo trì
    if (exactById) {
      if (exactById.serverStatus === 'healthy' || !rawParams) {
        const fullTool = ((await this.ai.publicTool(exactById.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? exactById.tool;
        return { key: exactById.intKey, pubKey: exactById.tool.key, tool: fullTool, resolvedId: exactById.id, serverId: exactById.serverId, serverName: exactById.serverName, canonicalModel: exactById.canonicalModel };
      }
      // Khi gọi tạo đơn / báo giá mà route mặc định đang bảo trì -> tự động chuyển sang SV healthy cùng canonical_model nếu có
      const altHealthy = family.filter((e) => e.serverStatus === 'healthy');
      if (altHealthy.length) {
        const chosen = pickBestCompatible(altHealthy);
        const fullTool = ((await this.ai.publicTool(chosen.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? chosen.tool;
        return { key: chosen.intKey, pubKey: chosen.tool.key, tool: fullTool, resolvedId: chosen.id, serverId: chosen.serverId, serverName: chosen.serverName, canonicalModel: chosen.canonicalModel };
      }
    }

    // 3) Khách truyền `canonical_model` (vd `seedance-2.0`, `minimax-h3`) hoặc biến thể `<model>/image`, `<model>/edit`
    if (family.length) {
      const healthyFamily = family.filter((e) => e.serverStatus === 'healthy');
      const chosen = pickBestCompatible(healthyFamily.length ? healthyFamily : family);
      const fullTool = ((await this.ai.publicTool(chosen.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? chosen.tool;
      return { key: chosen.intKey, pubKey: chosen.tool.key, tool: fullTool, resolvedId: chosen.id, serverId: chosen.serverId, serverName: chosen.serverName, canonicalModel: chosen.canonicalModel };
    }

    const [baseSlug, suffix] = normId.split('/');
    const wantsEdit = suffix ? /edit/.test(suffix) : false;
    const fallback =
      entries.find((e) => e.tool.key.toLowerCase() === normId) ??
      entries.find((e) => slugModel(e.tool.modelLabel || e.tool.name) === normId) ??
      (baseSlug
        ? entries.find((e) => {
            if (slugModel(e.tool.modelLabel || e.tool.name) !== baseSlug && e.canonicalModel !== baseSlug) return false;
            const isEditTool = /edit|chinh-sua/.test(`${e.tool.key} ${e.tool.category}`);
            return suffix ? (wantsEdit ? isEditTool : !isEditTool) : true;
          }) ?? entries.find((e) => slugModel(e.tool.modelLabel || e.tool.name) === baseSlug)
        : undefined);

    if (fallback) {
      const fullTool = ((await this.ai.publicTool(fallback.tool.key).catch(() => null)) as unknown as PublicTool | null) ?? fallback.tool;
      return { key: fallback.intKey, pubKey: fallback.tool.key, tool: fullTool, resolvedId: fallback.id, serverId: fallback.serverId, serverName: fallback.serverName, canonicalModel: fallback.canonicalModel };
    }

    const directKey = ids.byId.get(normId);
    if (directKey) throw new NotFoundException(`Model "${id}" đang tạm dừng. Xem danh sách model & server đang hoạt động ở GET /api/v1/models/groups`);
    throw new NotFoundException(`Model "${id}" không tồn tại. Xem danh sách ở GET /api/v1/models`);
  }

  /** `GET /v1/models/{id}`: chi tiết đầy đủ tham số đầu vào, bảng giá từng lựa chọn & danh sách `available_servers` cùng model */
  async getModel(id: string) {
    const [{ pubKey, tool, resolvedId, canonicalModel }, { entries, matrix }] = await Promise.all([
      this.findModel(id),
      this.loadCatalogEntries(),
    ]);
    const siblingServers = entries
      .filter((e) => e.canonicalModel === canonicalModel)
      .sort((a, b) => {
        if (a.serverStatus !== b.serverStatus) return a.serverStatus === 'healthy' ? -1 : 1;
        if (a.repPrice !== b.repPrice) return a.repPrice - b.repPrice;
        return serverOrderNum(a.serverId) - serverOrderNum(b.serverId);
      })
      .map((s) => ({
        server_id: s.serverId,
        server_name: s.serverName,
        server_status: s.serverStatus,
        maintenance: s.serverStatus === 'maintenance',
        model_id: s.id,
        name: s.tool.modelLabel || s.tool.name,
        min_price: s.repPrice < Number.MAX_SAFE_INTEGER ? s.repPrice : null,
        max_price: typeof s.bd?.maxPrice === 'number' ? s.bd.maxPrice : s.repPrice < Number.MAX_SAFE_INTEGER ? s.repPrice : null,
        updated_at: s.tool.updatedAt ? new Date(s.tool.updatedAt).toISOString() : null,
      }));
    return {
      ...this.present(tool, resolvedId, true, matrix[pubKey]),
      available_servers: siblingServers,
    };
  }

  // ---------------- tạo / xem tác vụ ----------------

  /**
   * Tách body phẳng `{ model, server?, ...tham số }` (hoặc `{ model, server?, input: {...} }`) thành model + server + input nội bộ.
   * Hỗ trợ truyền `server` / `server_id` (vd `"sv15"` hoặc `"auto"`) mà không xung đột với tham số `server` nội bộ (vd `"vip1"`, `"vip2"`).
   */
  private async parse(userId: string, body: Record<string, unknown>, download: boolean) {
    const model = String(body?.model ?? '').trim();
    if (!model) throw new BadRequestException('Thiếu tham số "model". Xem danh sách ở GET /api/v1/models/groups');
    const { model: _m, input: nested, ...flat } = body;
    const merged: Record<string, unknown> = {
      ...(nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {}),
      ...flat,
    };

    let serverSelector: string | null = null;
    if (merged.server_id !== undefined && merged.server_id !== null && String(merged.server_id).trim() !== '') {
      serverSelector = String(merged.server_id).trim();
      delete merged.server_id;
    } else if (typeof merged.server === 'string' && /^(sv\d+|auto)$/i.test(merged.server.trim())) {
      serverSelector = merged.server.trim();
      delete merged.server;
    } else if (merged.server_id !== undefined) {
      delete merged.server_id;
    }

    const { key, tool, resolvedId, serverId, serverName, canonicalModel } = await this.findModel(model, serverSelector, merged);
    const { input, unknown } = toInternalInput(tool.fields, merged);
    if (unknown.length) throw new BadRequestException(`Model "${resolvedId}" (${serverName}) không có tham số: ${unknown.join(', ')}. Xem GET /api/v1/models/${resolvedId}`);
    if (download) await this.importRemoteFiles(userId, tool.fields, input);
    return { key, model: resolvedId, canonicalModel, serverId, serverName, input };
  }

  /**
   * Ô file nhận cả URL công khai bên ngoài (vd https://.../anh.jpg): tải về máy chủ như khách tự tải lên
   * (chặn địa chỉ nội bộ, giới hạn dung lượng, kiểm tra đúng loại file) rồi thay bằng URL của mình.
   */
  private async importRemoteFiles(userId: string, fields: AiFieldDef[], input: Record<string, unknown>) {
    let count = 0;
    for (const f of fileFields(fields)) {
      const v = input[f.name];
      if (v === undefined || v === null || v === '') continue;
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x));
      const out: string[] = [];
      for (const url of list) {
        if (this.files.ownsInput(userId, url) || !/^https?:\/\//i.test(url)) {
          out.push(url);
          continue;
        }
        if (++count > MAX_REMOTE_FILES) throw new BadRequestException(`Tối đa ${MAX_REMOTE_FILES} file URL ngoài mỗi lần gọi, hãy tải file lên trước qua POST /api/account/ai/uploads`);
        out.push(await this.download(userId, url, f));
      }
      input[f.name] = Array.isArray(v) ? out : out[0];
    }
  }

  /** Tải một file URL ngoài về storage đầu vào của khách */
  private async download(userId: string, url: string, f: AiFieldDef) {
    try {
      const res = await safeFetch(url, { timeoutMs: 120_000, maxBytes: AI_UPLOAD_HARD_MB * 1024 * 1024, maxRedirects: 5 });
      if (!res.ok) throw new BadRequestException(`Không tải được file "${url}" (HTTP ${res.status})`);
      if (f.type !== 'file' && !res.mime.startsWith(`${f.type}/`)) throw new BadRequestException(`File "${url}" không phải ${f.type} (nhận được ${res.mime || 'không rõ định dạng'})`);
      const name = (new URL(res.url).pathname.split('/').pop() || `${f.type}`).slice(0, 120);
      return (await this.files.saveInput(userId, { buffer: res.body, mimetype: res.mime, originalname: name, size: res.body.length })).url;
    } catch (err) {
      if (err instanceof SafeFetchError) throw new BadRequestException(err.code === 'TOO_LARGE' ? `File "${url}" quá lớn (tối đa ${AI_UPLOAD_HARD_MB}MB)` : `Không tải được file "${url}": ${err.message}`);
      throw err;
    }
  }

  /** Trình bày tác vụ theo định dạng API `/v1` (kèm `canonical_model`, `server_id`, `server_name`) */
  private async presentTask(t: Task) {
    const ids = await this.idMap();
    const intKey = internalToolKey(t.toolKey);
    const modelId = ids.byKey.get(intKey) ?? t.toolKey;
    const { serverId, serverName } = resolveServerBadge(intKey);
    const canonicalModel = canonicalModelSlug(modelId, modelId);
    const out = this.ai.publicOutput(t.id, t.output) as { files: { url: string; type: string; name?: string }[]; text?: string };
    return {
      id: t.id,
      object: 'generation',
      code: t.code,
      model: modelId,
      canonical_model: canonicalModel,
      server_id: serverId,
      server_name: serverName,
      status: STATUS[t.status] ?? t.status.toLowerCase(),
      progress: t.progress,
      cost: t.credits,
      currency: 'VND',
      refunded: t.refunded,
      output:
        t.status === 'SUCCEEDED'
          ? { type: t.tool?.output ?? out.files?.[0]?.type ?? null, files: (out.files ?? []).map((x) => ({ url: x.url, type: x.type, name: x.name ?? null })), text: out.text ?? null }
          : null,
      error: hideProviderText(t.error),
      created_at: t.createdAt,
      completed_at: t.completedAt,
    };
  }

  /** `POST /v1/generations/estimate`: báo giá theo `model` + `server` tuỳ chọn, không trừ tiền */
  async estimate(user: AuthUser, body: Record<string, unknown>) {
    const { key, model, canonicalModel, serverId, serverName, input } = await this.parse(user.id, body, false);
    const { credits, originalCredits, discount } = await this.ai.quote(user.id, publicToolKey(key), input);
    return {
      object: 'estimate',
      model,
      canonical_model: canonicalModel,
      server_id: serverId,
      server_name: serverName,
      cost: credits,
      ...(discount > 0 ? { original_cost: originalCredits, discount_percent: discount } : {}),
      currency: 'VND',
    };
  }

  /** `POST /v1/generations`: trừ tiền + tạo tác vụ (hỗ trợ chốt máy chủ qua `server: "sv15"` hoặc `"auto"`) */
  async create(user: AuthUser, body: Record<string, unknown>, ip: string | null) {
    const { key, input } = await this.parse(user.id, body, true);
    const task = (await this.ai.run(user, publicToolKey(key), input, { ip, viaApi: true })) as unknown as Task;
    return this.presentTask(task);
  }

  /** `GET /v1/generations/{id}` (id uuid hoặc mã T...) */
  async get(user: AuthUser, id: string) {
    return this.presentTask((await this.ai.myTask(user.id, id)) as unknown as Task);
  }

  /** `GET /v1/generations`: lịch sử, mới nhất trước */
  async list(user: AuthUser, q: { page?: number; limit?: number; status?: string; model?: string }) {
    const status = q.status ? Object.entries(STATUS).find(([, v]) => v === q.status)?.[0] : undefined;
    if (q.status && !status) throw new BadRequestException('status phải là queued | processing | succeeded | failed | cancelled');
    const tool = q.model
      ? ((await this.idMap()).byId.get(q.model.toLowerCase()) ?? (await this.findModel(q.model)).key)
      : undefined;
    const res = (await this.ai.myTasks(user.id, { page: q.page, limit: q.limit, status, tool: tool ? publicToolKey(tool) : undefined } as never)) as unknown as {
      data: Task[];
      meta: { total: number; page: number; limit: number; totalPages: number };
    };
    return { object: 'list', data: await Promise.all(res.data.map((t) => this.presentTask(t))), meta: res.meta };
  }
}
