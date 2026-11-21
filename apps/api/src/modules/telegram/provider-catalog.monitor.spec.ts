import { describe, expect, it, vi } from 'vitest';
import { ProviderCatalogMonitor } from './provider-catalog.monitor.js';

/**
 * Monitor với Prisma / Settings / AiService / Telegram giả: chỉ bật nguồn Kapend,
 * `catalogs` = danh mục trả về ở từng lần đọc, `sent` = số chat gửi được (0 = bot lỗi).
 */
function setup(catalogs: ({ id: string; label: string }[] | Error)[], sent = 1) {
  let stored: unknown = null;
  const prisma = {
    setting: {
      findUnique: vi.fn(async () => (stored ? { value: stored } : null)),
      upsert: vi.fn(async ({ update }: { update: { value: unknown } }) => (stored = JSON.parse(JSON.stringify(update.value)))),
    },
  };
  const settings = { get: vi.fn(async (group: string) => ({ enabled: group === 'ai_kapend' })) };
  let call = 0;
  const ai = {
    providerCatalog: vi.fn(async () => {
      const r = catalogs[Math.min(call++, catalogs.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  const tg = { adminCommands: {}, notifyAdmin: vi.fn(async () => ({ sent, errors: [] })) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monitor = new ProviderCatalogMonitor(prisma as any, settings as any, ai as any, tg as any);
  return { monitor, tg, state: () => stored as Record<string, { items: Record<string, string> }> | null };
}

const A = { id: 'veo_3_1', label: 'veo_3_1 (video)' };
const B = { id: 'kling_video_5_0', label: 'kling_video_5_0 (video)' };
const C = { id: 'seedream_5_0', label: 'seedream_5_0 (image)' };

describe('ProviderCatalogMonitor', () => {
  it('lần đầu chỉ ghi nhớ làm mốc, không báo', async () => {
    const { monitor, tg, state } = setup([[A, C]]);
    const [d] = await monitor.run();
    expect(d.baseline).toBe(true);
    expect(tg.notifyAdmin).not.toHaveBeenCalled();
    expect(Object.keys(state()!.kapend.items)).toEqual(['veo_3_1', 'seedream_5_0']);
  });

  it('báo model mới và model đã gỡ ở lần sau', async () => {
    const { monitor, tg, state } = setup([[A, C], [A, B]]);
    await monitor.run();
    const [d] = await monitor.run();
    expect(d.added.map((i) => i.id)).toEqual(['kling_video_5_0']);
    expect(d.removed.map((i) => i.id)).toEqual(['seedream_5_0']);
    expect(tg.notifyAdmin).toHaveBeenCalledTimes(1);
    const html = (tg.notifyAdmin.mock.calls[0] as unknown[])[1] as string;
    expect(html).toContain('kling_video_5_0');
    expect(html).toContain('seedream_5_0');
    expect(Object.keys(state()!.kapend.items)).toEqual(['veo_3_1', 'kling_video_5_0']);
    // lần thứ ba không đổi -> không báo lại
    await monitor.run();
    expect(tg.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('chưa gửi được tin thì giữ mốc cũ để lần sau báo lại', async () => {
    const { monitor, tg, state } = setup([[A], [A, B]], 0);
    await monitor.run();
    await monitor.run();
    await monitor.run();
    expect(tg.notifyAdmin).toHaveBeenCalledTimes(2);
    expect(Object.keys(state()!.kapend.items)).toEqual(['veo_3_1']);
  });

  it('nguồn lỗi hoặc trả danh sách rỗng thì không coi là gỡ model', async () => {
    const { monitor, tg, state } = setup([[A, B], new Error('HTTP 502'), []]);
    await monitor.run();
    const [err] = await monitor.run();
    expect(err.error).toBe('HTTP 502');
    await monitor.run();
    expect(tg.notifyAdmin).not.toHaveBeenCalled();
    expect(Object.keys(state()!.kapend.items)).toEqual(['veo_3_1', 'kling_video_5_0']);
  });
});
