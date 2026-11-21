import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AiService } from './ai.service.js';

/** Kết quả tác vụ trả cho khách không lộ link nhà cung cấp: bỏ sourceUrl, link ngoài storage đi qua proxy có ký */
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const OWN = 'http://localhost:4317/uploads/ai/outputs/u/2026-10/a.mp4';
const FOREIGN = 'https://cdn.yupvox.com/out/b.mp4';
const output = { files: [{ url: OWN, type: 'video', sourceUrl: 'https://cdn.yupvox.com/out/a.mp4?token=x' }, { url: FOREIGN, type: 'video', name: 'b.mp4' }], text: 'xin chào' };

// chỉ cần prisma.aiTask.findUnique và files.pathOf cho hai hàm đang kiểm tra
const prisma = { aiTask: { findUnique: async () => ({ output }) } };
const files = { pathOf: (url: string) => (url.startsWith('http://localhost:4317/uploads/') ? url.slice(30) : null) };
const ai = new AiService(prisma as never, {} as never, {} as never, files as never, {} as never, {} as never);

describe('publicOutput / outputSource', () => {
  it('bỏ sourceUrl và thay link nhà cung cấp bằng link proxy', () => {
    const out = ai.publicOutput(TASK_ID, output);
    expect(JSON.stringify(out)).not.toMatch(/yupvox|sourceUrl/i);
    expect(out.files[0].url).toBe(OWN);
    expect(out.files[1].url).toMatch(new RegExp(`/api/public/ai/output/${TASK_ID}\\.1\\.[\\w-]{22}$`));
    expect(out.text).toBe('xin chào');
  });

  it('link proxy đúng chữ ký trả về link gốc, sai chữ ký thì 404', async () => {
    const token = ai.publicOutput(TASK_ID, output).files[1].url.split('/').pop()!;
    await expect(ai.outputSource(token)).resolves.toEqual({ url: FOREIGN, name: 'b.mp4' });
    await expect(ai.outputSource(token.replace(/\.1\./, '.0.'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ai.outputSource(`${TASK_ID}.1.xxxxxxxxxxxxxxxxxxxxxx`)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ai.outputSource('abc')).rejects.toBeInstanceOf(NotFoundException);
  });
});
