import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CORE_WIDGET_AREAS, widgetAreaBlockKey } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { ThemeCapabilitiesService } from './theme-capabilities.service.js';

export interface WidgetAreaView {
  key: string;
  label: string;
  description: string | null;
  /** core | theme */
  source: string;
  /** global block chứa nội dung vùng (null = chưa tạo) */
  blockId: string | null;
}

/**
 * Vùng widget = chỗ storefront đặt sẵn để chèn nội dung. Nội dung mỗi vùng là một global block
 * key `area-<vùng>` soạn bằng Page Builder; vùng lấy từ lõi (CORE_WIDGET_AREAS) + theme khai báo.
 */
@Injectable()
export class WidgetAreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly theme: ThemeCapabilitiesService,
    private readonly events: EventEmitter2,
  ) {}

  async list(): Promise<WidgetAreaView[]> {
    const themeAreas = await this.theme.widgetAreas();
    const areas: Omit<WidgetAreaView, 'blockId'>[] = CORE_WIDGET_AREAS.map((a) => ({ key: a.key, label: a.label, description: a.description ?? null, source: a.source ?? 'core' }));
    for (const a of themeAreas) if (!areas.some((x) => x.key === a.key)) areas.push({ key: a.key, label: a.label, description: a.description ?? null, source: 'theme' });
    const blocks = await this.prisma.globalBlock.findMany({ where: { key: { in: areas.map((a) => widgetAreaBlockKey(a.key)) } }, select: { id: true, key: true } });
    return areas.map((a) => ({ ...a, blockId: blocks.find((b) => b.key === widgetAreaBlockKey(a.key))?.id ?? null }));
  }

  /** Tạo global block cho vùng nếu chưa có, trả id để admin mở Page Builder */
  async ensure(key: string): Promise<{ id: string }> {
    const area = (await this.list()).find((a) => a.key === key);
    if (!area) throw new BadRequestException(`Vùng widget "${key}" không tồn tại`);
    if (area.blockId) return { id: area.blockId };
    const blockKey = widgetAreaBlockKey(key);
    const locale = await this.languages.defaultLocale();
    // upsert để hai yêu cầu đồng thời không tạo trùng key
    const block = await this.prisma.globalBlock.upsert({
      where: { key: blockKey },
      create: { key: blockKey, name: `Vùng widget: ${area.label}`, type: 'section', isActive: true, translations: { create: [{ locale, blocks: [] }] } },
      update: {},
    });
    this.events.emit('content.changed', { type: 'block', tags: ['blocks', `block:${blockKey}`] });
    return { id: block.id };
  }
}
