import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { diskStorage } from 'multer';
import { createReadStream, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { TavtavvideoBridgeService } from './tavtavvideo-bridge.service.js';

const CHUNK_UPLOAD_TMP = join(tmpdir(), 'novai-tavtavvideo-chunks');
mkdirSync(CHUNK_UPLOAD_TMP, { recursive: true });

interface MulterDiskFile {
  path?: string;
  buffer?: Buffer;
  size: number;
  originalname: string;
  mimetype: string;
}

/**
 * Cổng kết nối ngược (outbound HTTPS pull) dành riêng cho worker Client của nguồn `tavtavvideo`.
 * Đăng ký đủ 4 tiền tố `/api/tavtavvideo-worker(/api)/*` và `/api/flowmotion(/api)/*` để tương thích 100% cấu hình Client đang chạy.
 */
@Controller(['tavtavvideo-worker', 'tavtavvideo-worker/api', 'flowmotion', 'flowmotion/api'])
@Public()
@IgnoreAuthHeader()
@SkipThrottle()
export class TavtavvideoWorkerController {
  constructor(private readonly bridge: TavtavvideoBridgeService) {}

  @Get('healthz')
  healthz() {
    return this.bridge.getHealthSummary();
  }

  @Post('device/enroll')
  @HttpCode(200)
  enroll(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.bridge.enrollDevice(body ?? {}, req.headers as Record<string, string | string[] | undefined>);
  }

  @Post('device/hello')
  @HttpCode(200)
  async hello(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const dev = await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.handleHello(dev, body ?? {});
  }

  @Post('device/ack')
  @HttpCode(200)
  async ack(@Body() body: Record<string, unknown>, @Req() req: Request) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.ackCommand(body ?? {});
  }

  @Get('config/voices')
  async voices(@Req() req: Request) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.getMinimalVoicesCatalog();
  }

  @Get('config/styles')
  async styles(@Req() req: Request) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.getMinimalStylesCatalog();
  }

  @Post('profiles/sync')
  @HttpCode(200)
  async syncProfiles(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const dev = await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.syncProfiles(dev, body ?? {});
  }

  @Post('resources')
  @HttpCode(200)
  async resources(@Req() req: Request) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return { ok: true };
  }

  @Post('jobs/claim')
  @HttpCode(200)
  async claim(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const dev = await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.bridge.claimJobs(dev, body ?? {});
  }

  @Get('jobs/:id/source-image')
  async sourceImage(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.streamJobMedia(id, 'image', res, 1);
  }

  @Get('jobs/:id/source-images/:idx')
  async sourceImageAt(@Param('id') id: string, @Param('idx') idx: string, @Req() req: Request, @Res() res: Response) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    const parsedIdx = Math.max(1, Math.floor(Number(idx) || 1));
    return this.streamJobMedia(id, 'image', res, parsedIdx);
  }

  @Get('jobs/:id/dance-source-video')
  async danceSourceVideo(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    return this.streamJobMedia(id, 'video', res, 1);
  }

  @Post('jobs/:id/progress')
  @HttpCode(200)
  async progress(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    const job = this.bridge.getJob(id);
    if (!job) throw new NotFoundException('Không tìm thấy đơn xử lý video');
    return this.bridge.reportProgress(job, body ?? {});
  }

  @Post('jobs/:id/preview')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: CHUNK_UPLOAD_TMP }),
      limits: { fileSize: 60 * 1024 * 1024 },
    }),
  )
  async preview(
    @Param('id') id: string,
    @UploadedFile() file: MulterDiskFile | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    try {
      await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      if (file?.path) await unlink(file.path).catch(() => undefined);
      throw err;
    }
    const job = this.bridge.getJob(id);
    if (!job) {
      if (file?.path) await unlink(file.path).catch(() => undefined);
      throw new NotFoundException('Không tìm thấy đơn xử lý');
    }
    const sceneIndex = Math.max(1, Math.floor(Number(body?.scene_index ?? 1) || 1));
    return this.bridge.savePreviewImage(job, sceneIndex, file);
  }

  @Post('jobs/:id/video/chunk')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({ destination: CHUNK_UPLOAD_TMP }),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async uploadChunk(
    @Param('id') id: string,
    @UploadedFile() chunk: MulterDiskFile | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    try {
      await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      if (chunk?.path) await unlink(chunk.path).catch(() => undefined);
      throw err;
    }

    const job = this.bridge.getJob(id);
    if (!job) {
      if (chunk?.path) await unlink(chunk.path).catch(() => undefined);
      throw new NotFoundException('Không tìm thấy đơn xử lý video');
    }
    if (!chunk || (!chunk.path && !chunk.buffer)) {
      throw new BadRequestException('Thiếu dữ liệu mảnh video (chunk)');
    }

    const index = Math.floor(Number(body?.index));
    const total = Math.floor(Number(body?.total));
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total <= 0 || index >= total) {
      if (chunk.path) await unlink(chunk.path).catch(() => undefined);
      throw new BadRequestException('Chỉ số mảnh video (index / total) không hợp lệ');
    }

    return this.bridge.saveVideoChunk(job, index, total, chunk);
  }

  @Post('jobs/:id/finish')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor())
  async finish(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.bridge.requireDeviceAuth(req.headers as Record<string, string | string[] | undefined>);
    const job = this.bridge.getJob(id);
    if (!job) throw new NotFoundException('Không tìm thấy đơn xử lý video');
    const result = await this.bridge.finishJob(job, body ?? {});
    res.status(result.httpStatus);
    return result.payload;
  }

  private async streamJobMedia(id: string, kind: 'image' | 'video', res: Response, imageIndex = 1) {
    const job = this.bridge.getJob(id);
    if (!job) throw new NotFoundException('Không tìm thấy đơn xử lý video');
    const media = await this.bridge.resolveJobMediaSource(job, kind, imageIndex);
    if (!media) throw new NotFoundException('Không tìm thấy file đầu vào của đơn xử lý video');

    res.setHeader('Content-Type', media.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    if (media.size !== undefined) res.setHeader('Content-Length', String(media.size));

    if (media.localFile) {
      const stream = createReadStream(media.localFile);
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      return;
    }

    res.status(200).send(media.buffer);
  }
}
