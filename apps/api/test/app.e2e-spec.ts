import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

/** E2E chỉ đọc (không ghi dữ liệu) — cần PostgreSQL đang chạy và đã seed */
describe('CMSNT API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health', () => request(app.getHttpServer()).get('/api/health').expect(200));

  it('GET /api/public/bootstrap trả cài đặt + ngôn ngữ', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/bootstrap').expect(200);
    expect(res.body.defaultLocale).toBeTruthy();
    expect(Array.isArray(res.body.languages)).toBe(true);
    expect(res.body.settings.mail).toBeUndefined();
  });

  it('route admin yêu cầu đăng nhập', () => request(app.getHttpServer()).get('/api/admin/pages').expect(401));

  it('đăng nhập sai trả 401', () =>
    request(app.getHttpServer()).post('/api/auth/admin/login').send({ email: 'khong-ton-tai@example.com', password: 'sai-mat-khau' }).expect(401));

  it('validate body đăng nhập', () => request(app.getHttpServer()).post('/api/auth/admin/login').send({ email: 'abc' }).expect(400));
});
