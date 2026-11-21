import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';

// LOG_DIR được đọc lúc import -> đặt thư mục tạm trước khi nạp module
const dir = mkdtempSync(join(tmpdir(), 'cmsnt-logs-'));
process.env.LOG_DIR = dir;
const { logWriter, redactText, LOG_FILE_RE } = await import('./log-writer.js');
const { AppLogger } = await import('./app-logger.js');
const { AllExceptionsFilter } = await import('../../common/filters/all-exceptions.filter.js');
const { LogsService } = await import('./logs.service.js');

/** Đọc toàn bộ dòng log đã ghi (đợi stream ghi xong) */
async function readEntries() {
  await new Promise((r) => setTimeout(r, 30));
  const file = readdirSync(dir).find((n) => LOG_FILE_RE.test(n));
  if (!file) return [];
  return readFileSync(join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Giả lập ArgumentsHost của request HTTP */
function httpHost(url = '/api/test') {
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    end() {},
  };
  const req = { method: 'GET', originalUrl: url, ip: '1.2.3.4', user: { id: 'u1', email: 'a@b.c' }, get: () => undefined };
  const host = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  return { host: host as never, res };
}

afterAll(() => {
  logWriter.closeStream();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  logWriter.closeStream();
  for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true });
  logWriter.configure({ level: 'warn', log4xx: false, captureClient: true, maxFileMb: 50 });
});

describe('redactText', () => {
  it('che mật khẩu, token, Bearer', () => {
    expect(redactText('/login?password=abc&x=1')).toBe('/login?password=***&x=1');
    expect(redactText('{"token":"xyz"}')).toBe('{"token":"***"}');
    expect(redactText('Authorization: Bearer eyJhbGci.abc')).toBe('Authorization: Bearer ***');
  });
});

describe('AppLogger', () => {
  it('ghi error kèm context + stack, bỏ qua mức thấp hơn cấu hình', async () => {
    const logger = new AppLogger();
    logger.setLogLevels([]); // không in ra console khi chạy test
    const err = new Error('boom');
    logger.error('Gửi mail lỗi', err.stack, 'Mail');
    logger.log('khởi động', 'Bootstrap');
    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', source: 'api', context: 'Mail', message: 'Gửi mail lỗi' });
    expect(entries[0].stack).toContain('boom');
  });

  it('context Cron -> nguồn cron', async () => {
    const logger = new AppLogger();
    logger.setLogLevels([]);
    logger.warn('Cron "x" lỗi', 'Cron');
    expect((await readEntries())[0]).toMatchObject({ level: 'warn', source: 'cron' });
  });
});

describe('AllExceptionsFilter', () => {
  it('lỗi 500 trả response chuẩn và ghi log kèm request', async () => {
    const filter = new AllExceptionsFilter();
    (filter as unknown as { console: { error: () => void } }).console = { error: () => {} };
    const { host, res } = httpHost('/api/orders?token=abc');
    filter.catch(new TypeError('cannot read x'), host);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    const [e] = await readEntries();
    expect(e).toMatchObject({ level: 'error', source: 'http', context: 'TypeError', message: 'cannot read x', request: { method: 'GET', url: '/api/orders?token=***', status: 500, userId: 'u1' } });
    expect(e.stack).toContain('TypeError');
  });

  it('HttpException giữ nguyên body; 4xx không ghi trừ khi bật log4xx', async () => {
    const filter = new AllExceptionsFilter();
    const { host, res } = httpHost();
    filter.catch(new NotFoundException('Không tìm thấy'), host);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, message: 'Không tìm thấy' });
    expect(await readEntries()).toHaveLength(0);

    logWriter.configure({ log4xx: true });
    filter.catch(new NotFoundException('Không tìm thấy'), httpHost().host);
    expect((await readEntries())[0]).toMatchObject({ level: 'warn', message: 'Không tìm thấy', request: { status: 404 } });
  });

  it('HttpException 5xx cũng được ghi', async () => {
    const filter = new AllExceptionsFilter();
    (filter as unknown as { console: { error: () => void } }).console = { error: () => {} };
    filter.catch(new InternalServerErrorException('hỏng'), httpHost().host);
    expect((await readEntries())[0]).toMatchObject({ level: 'error', request: { status: 500 } });
  });
});

describe('LogsService.entries', () => {
  const settings = { get: async () => ({}) };
  const cron = { add: () => () => {} };

  it('mới nhất trước, phân trang, đếm theo level, lọc tìm kiếm', async () => {
    for (let i = 1; i <= 7; i++) logWriter.write({ level: i % 2 ? 'error' : 'warn', source: 'api', message: `lỗi số ${i}` });
    await readEntries();
    const svc = new LogsService(settings as never, cron as never);
    const p1 = await svc.entries({ limit: 3, page: 1 });
    expect(p1.meta).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });
    expect(p1.data.map((e) => e.message)).toEqual(['lỗi số 7', 'lỗi số 6', 'lỗi số 5']);
    const p3 = await svc.entries({ limit: 3, page: 3 });
    expect(p3.data.map((e) => e.message)).toEqual(['lỗi số 1']);
    expect(p1.counts).toMatchObject({ error: 4, warn: 3 });

    const onlyWarn = await svc.entries({ level: 'warn' });
    expect(onlyWarn.meta.total).toBe(3);
    expect(onlyWarn.counts.error).toBe(4); // số trên chip không bị lọc level

    const search = await svc.entries({ search: 'SỐ 3' });
    expect(search.data.map((e) => e.message)).toEqual(['lỗi số 3']);
  });

  it('chặn tên file lạ', async () => {
    const svc = new LogsService(settings as never, cron as never);
    expect(() => svc.assertName('../.env')).toThrow();
  });
});
