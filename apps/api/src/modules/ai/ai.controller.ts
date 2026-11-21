import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { trustedClientIp } from '../../common/utils/client-ip.js';
import { AiService } from './ai.service.js';
import { internalToolKey, publicToolKey } from './ai-public-key.js';
import { createReadStream, mkdirSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { diskStorage } from 'multer';
import { AI_MEDIA_UPLOAD_HARD_MB, AiFilesService } from './ai-files.service.js';
import { AiCategoriesService } from './ai-categories.service.js';
import { AiCleanupService } from './ai-cleanup.service.js';
import { AdminCommunityQueryDto, AdminTaskQueryDto, BulkCommunityModerateDto, BulkMaintenanceDto, CancelTaskDto, CommunityQueryDto, CreateCategoryDto, CreateClonedVoiceDto, CreateCommunityShowcaseDto, DeleteTasksDto, DownloadTasksDto, FlagTaskViolationDto, ImportUrlDto, ModerateTaskDto, ProbeTasksUpstreamDto, RenameTaskDto, ReorderCategoriesDto, ReorderToolsDto, ReplyTaskDto, RunToolDto, TaskQueryDto, TaskVisibilityDto, ToolRunStatsQueryDto, UpdateCategoryDto, UpdateClonedVoiceDto, UpdateToolDto } from './ai.dto.js';
import { streamZipArchive } from './zip-stream.js';

/** Header Content-Disposition chuẩn RFC 6266 (ASCII fallback + UTF-8 tiếng Việt, an toàn với Node setHeader) */
function attachmentDisposition(fileName: string): string {
  const ascii =
    fileName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^\x20-\x7E]+/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'download';
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Thư mục file tạm của ô tải file AI (multer ghi ra đĩa, sau đó chuyển vào storage và xoá file tạm) */
const UPLOAD_TMP = join(tmpdir(), 'novai-ai-uploads');
mkdirSync(UPLOAD_TMP, { recursive: true });

/** Danh mục công cụ AI công khai (trang chủ, menu, form) */
@Controller('public/ai/tools')
export class PublicAiController {
  constructor(private readonly ai: AiService) {}

  @Public()
  @Get()
  list() {
    return this.ai.publicTools();
  }

  /** Đổi khoá nội bộ cũ (`<nhà cung cấp>.<công cụ>`, link đã chia sẻ trước đây) sang khoá công khai để website chuyển hướng */
  @Public()
  @Get('resolve/:key')
  resolve(@Param('key') key: string) {
    return { key: publicToolKey(internalToolKey(key)) };
  }

  /** Lượt dùng từng công cụ 30 ngày qua (nhiều nhất trước) — khung "Tính năng dùng nhiều nhất" ở trang tổng quan */
  @Public()
  @Get('popular')
  popular() {
    return this.ai.popularTools();
  }

  /** Bảng giá chi tiết từng lựa chọn cấu hình của toàn bộ dịch vụ đang hoạt động (dùng trên `/service-pricing` của cả web chính & web con) */
  @Public()
  @Get('price-matrix')
  priceMatrix() {
    return this.ai.publicPriceMatrix();
  }

  @Public()
  @Get(':key')
  detail(@Param('key') key: string) {
    return this.ai.publicTool(key);
  }

  /** Báo giá trực tiếp cho khách chưa đăng nhập khi trải nghiệm thử công cụ trong Studio (T-310) */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(':key/quote')
  @HttpCode(200)
  publicQuote(@Param('key') key: string, @Body() dto: RunToolDto) {
    return this.ai.publicQuote(key, dto?.input);
  }
}

/** File nghe thử giọng đọc (hộp chọn giọng của công cụ chuyển văn bản thành giọng nói) */
@Controller('public/ai/voice-preview')
export class PublicAiVoicePreviewController {
  constructor(private readonly ai: AiService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':provider/:voice')
  async preview(@Param('provider') provider: string, @Param('voice') voice: string, @Res() res: Response) {
    const file = await this.ai.voicePreview(provider, voice);
    // file mẫu không đổi -> cho trình duyệt / CDN giữ lâu
    res.set({ 'Content-Type': file.mimeType, 'Cache-Control': 'public, max-age=604800, immutable' });
    res.send(file.data);
  }
}

/**
 * Tải hộ file kết quả chưa sao lưu được về storage (tắt sao lưu / file quá lớn / tải lỗi) để khách không thấy link nhà cung cấp.
 * Link có chữ ký theo tác vụ + thứ tự file (AiService.publicOutput); chuyển tiếp Range để video tua được.
 */
@Controller('public/ai/output')
export class PublicAiOutputController {
  constructor(private readonly ai: AiService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':token')
  async output(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.ai.outputSource(token);
    const range = req.headers.range;
    const upstream = await fetch(file.url, { headers: range ? { range } : {}, signal: AbortSignal.timeout(30 * 60_000) }).catch(() => null);
    if (!upstream || !upstream.body || (upstream.status !== 200 && upstream.status !== 206)) {
      res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại, vui lòng tạo lại' });
      return;
    }
    // chỉ chuyển các header cần cho phát / tải file; không chuyển header định danh máy chủ nhà cung cấp
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.end());
    stream.pipe(res);
  }
}

/**
 * Tải xuống file kết quả (lẻ từng file hoặc đóng gói .ZIP hàng loạt) qua link có chữ ký ngắn hạn:
 * trình duyệt tải trực tiếp bằng bộ quản lý tải của hệ điều hành (Content-Disposition: attachment, không tốn RAM trình duyệt).
 */
@Controller('public/ai/download')
export class PublicAiDownloadController {
  constructor(private readonly ai: AiService) {}

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get('file/:token')
  async downloadFile(@Param('token') token: string, @Query('name') name: string | undefined, @Req() req: Request, @Res() res: Response) {
    const src = await this.ai.resolveDownloadFile(token, name);
    res.setHeader('Content-Disposition', attachmentDisposition(src.fileName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (src.localFile) {
      const st = await stat(src.localFile).catch(() => null);
      if (!st?.isFile()) {
        res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
        return;
      }
      res.setHeader('Content-Type', src.mimeType);
      res.setHeader('Content-Length', String(st.size));
      const stream = createReadStream(src.localFile);
      req.on('close', () => stream.destroy());
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    if (src.readBuffer) {
      const buf = await src.readBuffer().catch(() => null);
      if (!buf) {
        res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
        return;
      }
      res.setHeader('Content-Type', src.mimeType);
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
      return;
    }

    if (!src.remoteUrl) {
      res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
      return;
    }
    const upstream = await fetch(src.remoteUrl, { signal: AbortSignal.timeout(15 * 60_000) }).catch(() => null);
    if (!upstream || !upstream.body || !upstream.ok) {
      res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
      return;
    }
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.end());
    stream.pipe(res);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('zip/:token')
  async downloadZip(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const { zipName, entries } = await this.ai.resolveDownloadZip(token);
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(zipName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    await streamZipArchive(res, entries, () => aborted);
    if (!res.writableEnded) res.end();
  }
}

/** Trang Cộng đồng: tác phẩm khách chọn hiển thị Công khai (không cần đăng nhập) */
@Controller('public/ai/community')
export class PublicAiCommunityController {
  constructor(private readonly ai: AiService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get()
  list(@Query() q: CommunityQueryDto) {
    return this.ai.communityTasks(q);
  }

  /** Proxy file ảnh / video Cộng đồng chung cho web con (giữ nguyên domain web con, hỗ trợ Range tua mượt) */
  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get('media/:token/:filename')
  mediaWithName(
    @Param('token') token: string,
    @Param('filename') filename: string,
    @Query('dl') dl: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.serveMedia(token, filename, dl, req, res);
  }

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get('media/:token')
  mediaOnly(@Param('token') token: string, @Query('dl') dl: string | undefined, @Req() req: Request, @Res() res: Response) {
    return this.serveMedia(token, undefined, dl, req, res);
  }

  /** Một tác phẩm công khai theo mã — dùng khi bấm "Dùng lại thiết kế" để điền form */
  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':code')
  detail(@Param('code') code: string) {
    return this.ai.communityTask(code);
  }

  private async serveMedia(token: string, fileName: string | undefined, dl: string | undefined, req: Request, res: Response) {
    const src = await this.ai.resolveCommunityMedia(token);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    if (dl === '1' && fileName) {
      res.setHeader('Content-Disposition', attachmentDisposition(fileName));
    }

    if (src.localFile) {
      res.sendFile(src.localFile, (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
        }
      });
      return;
    }

    if (!src.remoteUrl) {
      res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
      return;
    }
    const range = req.headers.range;
    const upstream = await fetch(src.remoteUrl, { headers: range ? { range } : {}, signal: AbortSignal.timeout(15 * 60_000) }).catch(() => null);
    if (!upstream || !upstream.body || (upstream.status !== 200 && upstream.status !== 206)) {
      res.status(404).json({ statusCode: 404, message: 'File kết quả không còn tồn tại' });
      return;
    }
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.end());
    stream.pipe(res);
  }
}

/** Nhóm công cụ công khai (menu, bộ lọc của website khách) theo thứ tự admin xếp */
@Controller('public/ai/categories')
export class PublicAiCategoriesController {
  constructor(private readonly categories: AiCategoriesService) {}

  @Public()
  @Get()
  list() {
    return this.categories.publicList();
  }
}

/** Thành viên: chạy công cụ, tải file đầu vào, xem lịch sử tác vụ */
@Controller('account/ai')
export class AccountAiController {
  constructor(
    private readonly ai: AiService,
    private readonly files: AiFilesService,
    private readonly cleanup: AiCleanupService,
  ) {}

  /** Tải lên file đầu vào (ảnh mẫu, video, âm thanh, phụ đề) — giới hạn dung lượng ở Cài đặt › AI */
  @Throttle({ default: { limit: 360, ttl: 60_000 } })
  @Post('uploads')
  // multer ghi ra file tạm trên đĩa (không giữ trong RAM) nên nhận được video tới 1GB; giới hạn chi tiết theo Cài đặt › AI kiểm tra lại trong saveInput
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: UPLOAD_TMP }), limits: { fileSize: AI_MEDIA_UPLOAD_HARD_MB * 1024 * 1024, files: 1 } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
    @Query('demo') demo?: string,
    @Query('ticket') ticket?: string,
  ) {
    if (!file) throw new BadRequestException('Chưa chọn file');
    try {
      if (demo === '1' || demo === 'true') {
        if (!user.permissions?.includes('*') && !user.permissions?.includes('ai.tools') && !user.permissions?.includes('ai.tasks.manage')) {
          throw new ForbiddenException('Không có quyền tải video mẫu');
        }
        return await this.files.saveDemoMedia(file);
      }
      if (ticket === '1' || ticket === 'true') {
        return await this.files.saveTicketMedia(file);
      }
      return await this.files.saveInput(user.id, file);
    } finally {
      // storage local đã chuyển file đi thì unlink báo lỗi -> bỏ qua
      await unlink(file.path).catch(() => undefined);
    }
  }

  /** Tải file đầu vào từ link video (TikTok / Douyin / MP4) — dùng cho ô "Dán link" của form nhiều cặp */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('uploads/from-url')
  @HttpCode(200)
  uploadFromUrl(@CurrentUser() user: AuthUser, @Body() dto: ImportUrlDto) {
    return this.ai.importFromUrl(user.id, dto.url);
  }

  /** Báo giá credits trước khi chạy */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('tools/:key/quote')
  @HttpCode(200)
  quote(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() dto: RunToolDto) {
    return this.ai.quote(user.id, key, dto.input);
  }

  /** Chạy công cụ: trừ credits và tạo tác vụ */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('tools/:key/run')
  @HttpCode(200)
  run(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() dto: RunToolDto, @Req() req: Request) {
    // đánh dấu tác vụ gọi qua API key (admin lọc / thống kê được) + mã chống nhân đôi khi Nginx proxy_next_upstream chuyển tiếp (T-422)
    const rawReqId = req.headers['x-request-id'];
    const requestId = typeof rawReqId === 'string' && rawReqId.trim() ? rawReqId.trim().slice(0, 80) : undefined;
    return this.ai.run(user, key, dto.input, {
      ip: trustedClientIp(req),
      viaApi: (req as Request & { authMethod?: string }).authMethod === 'api_key',
      isPublic: dto.isPublic,
      requestId,
    });
  }

  @Get('stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.ai.myStats(user.id);
  }

  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser, @Query() q: TaskQueryDto) {
    return this.ai.myTasks(user.id, q);
  }

  /** Chi tiết tác vụ theo id hoặc mã (T...) — trang kết quả hỏi định kỳ khi đang xử lý */
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get('tasks/:id')
  task(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.myTask(user.id, id);
  }

  /** Trả lời câu hỏi của Muse trên tác vụ video bị từ chối -> tác vụ mới tiếp tục cùng cuộc trò chuyện */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('tasks/:id/reply')
  @HttpCode(200)
  reply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplyTaskDto, @Req() req: Request) {
    return this.ai.replyTask(user, id, dto.message, { ip: trustedClientIp(req), viaApi: (req as Request & { authMethod?: string }).authMethod === 'api_key' });
  }

  /** Đổi chế độ hiển thị tác vụ của mình (Công khai / Riêng tư) */
  @Put('tasks/:id/visibility')
  setVisibility(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TaskVisibilityDto) {
    return this.ai.setVisibility(user.id, id, dto.isPublic);
  }

  /** Đặt tên file tuỳ chọn cho tác phẩm (video / ảnh / âm thanh) để lúc tải về lưu theo tên đã đặt */
  @Put('tasks/:id/rename')
  renameTask(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameTaskDto) {
    return this.ai.renameTask(user.id, id, dto.name ?? '');
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.cancelMine(user.id, id);
  }

  /** Xoá nhiều tác phẩm đã chọn (kèm file); tác vụ đang xử lý được bỏ qua */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('tasks/delete')
  @HttpCode(200)
  deleteTasks(@CurrentUser() user: AuthUser, @Body() dto: DeleteTasksDto) {
    return this.cleanup.deleteForUser(user.id, dto.ids);
  }

  /** Tạo danh sách link tải từng file + link tải gói .ZIP cho các tác phẩm hoàn thành đã chọn */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('tasks/download-links')
  @HttpCode(200)
  downloadLinks(@CurrentUser() user: AuthUser, @Body() dto: DownloadTasksDto) {
    return this.ai.createDownloadLinks(user.id, dto);
  }

  /** Kho giọng đã nhân bản cá nhân của thành viên (T-301) */
  @Get('voices')
  listVoices(@CurrentUser() user: AuthUser) {
    return this.ai.listMyClonedVoices(user.id);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('voices')
  createVoice(@CurrentUser() user: AuthUser, @Body() dto: CreateClonedVoiceDto) {
    return this.ai.createMyClonedVoice(user.id, dto);
  }

  @Put('voices/:id')
  updateVoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateClonedVoiceDto) {
    return this.ai.updateMyClonedVoice(user.id, id, dto);
  }

  @Delete('voices/:id')
  deleteVoice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.deleteMyClonedVoice(user.id, id);
  }
}

/** Admin AI Studio: công cụ, nhóm công cụ, nhà cung cấp, tác vụ */
@Controller('admin/ai')
export class AdminAiController {
  constructor(
    private readonly ai: AiService,
    private readonly categories: AiCategoriesService,
    private readonly files: AiFilesService,
  ) {}

  /** Tải lên video / ảnh mẫu hướng dẫn hiển thị trên trang công cụ khách (tối đa 200MB) */
  @RequirePermissions('ai.tools')
  @Post('demo-upload')
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: UPLOAD_TMP }), limits: { fileSize: 200 * 1024 * 1024, files: 1 } }))
  async uploadDemo(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Chưa chọn file');
    try {
      return await this.files.saveDemoMedia(file);
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /** Danh sách nhóm + số công cụ mỗi nhóm */
  @RequirePermissions('ai.tools')
  @Get('categories')
  listCategories() {
    return this.categories.adminList();
  }

  @RequirePermissions('ai.tools')
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() actor: AuthUser) {
    return this.categories.create(dto, actor.id);
  }

  /** Sắp xếp lại (đặt trước `categories/:key` để không bị hiểu là khoá "order") */
  @RequirePermissions('ai.tools')
  @Put('categories/order')
  reorderCategories(@Body() dto: ReorderCategoriesDto, @CurrentUser() actor: AuthUser) {
    return this.categories.reorder(dto.keys, actor.id);
  }

  @RequirePermissions('ai.tools')
  @Put('categories/:key')
  updateCategory(@Param('key') key: string, @Body() dto: UpdateCategoryDto, @CurrentUser() actor: AuthUser) {
    return this.categories.update(key, dto, actor.id);
  }

  /** Xoá nhóm — chỉ khi không còn công cụ nào thuộc nhóm */
  @RequirePermissions('ai.tools')
  @Delete('categories/:key')
  removeCategory(@Param('key') key: string, @CurrentUser() actor: AuthUser) {
    return this.categories.remove(key, actor.id);
  }

  @RequirePermissions('ai.tasks')
  @Get('stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.ai.adminStats(user);
  }

  @RequirePermissions('ai.tools')
  @Get('tools')
  tools(@CurrentUser() user: AuthUser) {
    return this.ai.adminTools(user);
  }

  /** Giá một lượt (theo lựa chọn mặc định + mốc so sánh chuẩn) của từng công cụ, hiện ở cột "Giá / lượt" & "Nhận định giá" */
  @RequirePermissions('ai.tools')
  @Get('tools/prices')
  toolPrices(@Query('fresh') fresh: string | undefined, @CurrentUser() user: AuthUser) {
    return this.ai.adminToolPrices(user, fresh === '1' || fresh === 'true');
  }

  /** Thống kê số lượt chạy, lượt thành công / hoàn tiền và doanh thu thực thu của từng công cụ theo ngày / khoảng ngày */
  @RequirePermissions('ai.tools')
  @Get('tools/run-stats')
  toolRunStats(@Query() q: ToolRunStatsQueryDto, @CurrentUser() user: AuthUser) {
    return this.ai.adminToolRunStats(q, user);
  }

  /** Công cụ đã xoá (đang ẩn), để khôi phục */
  @RequirePermissions('ai.tools')
  @Get('tools/deleted')
  deletedTools(@CurrentUser() user: AuthUser) {
    return this.ai.adminDeletedTools(user);
  }

  /** Khôi phục công cụ đã xoá (kèm model con), công cụ hiện lại ở trạng thái tắt */
  @RequirePermissions('ai.tools')
  @Post('tools/:key/restore')
  restoreTool(@Param('key') key: string) {
    return this.ai.restoreTool(internalToolKey(key));
  }

  /** Sắp xếp lại công cụ (đặt trước `tools/:key` để không bị hiểu là khoá "order") */
  @RequirePermissions('ai.tools')
  @Put('tools/order')
  reorderTools(@Body() dto: ReorderToolsDto) {
    return this.ai.reorderTools(dto.keys.map((k) => internalToolKey(k)));
  }

  /** Bật / tắt chế độ bảo trì hàng loạt cho các công cụ đã chọn */
  @RequirePermissions('ai.tools')
  @Put('tools/maintenance')
  bulkMaintenance(@Body() dto: BulkMaintenanceDto) {
    return this.ai.bulkMaintenanceTools(dto.keys.map((k) => internalToolKey(k)), dto.maintenance);
  }

  @RequirePermissions('ai.tools')
  @Put('tools/:key')
  updateTool(@Param('key') key: string, @Body() dto: UpdateToolDto) {
    return this.ai.updateTool(internalToolKey(key), dto);
  }

  /** Xoá công cụ (kèm model con); công cụ có lịch sử tác vụ / adapter còn khai báo thì ẩn vĩnh viễn thay vì xoá dòng */
  @RequirePermissions('ai.tools')
  @Delete('tools/:key')
  deleteTool(@Param('key') key: string) {
    return this.ai.deleteTool(internalToolKey(key));
  }

  /** Kiểm tra kết nối + số dư tài khoản ở nhà cung cấp */
  @RequirePermissions('ai.tools')
  @Get('providers/:key/balance')
  balance(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.ai.providerBalance(key, user);
  }

  @RequirePermissions('ai.tasks')
  @Get('tasks')
  tasks(@Query() q: AdminTaskQueryDto, @CurrentUser() user: AuthUser) {
    return this.ai.adminTasks(q, user);
  }

  /** Quét & tự động xử lý các đơn lỗi hoàn tiền + quét trạng thái chuẩn các đơn Đang xử lý > 30p ngay lập tức (T-417 & T-428) */
  @RequirePermissions('ai.tasks')
  @Post('tasks/auto-check')
  @HttpCode(200)
  async autoCheckFailedTasks(@CurrentUser() user: AuthUser) {
    const [failedRes, stuckRes] = await Promise.all([
      this.ai.runFailedTasksAutoCheck(500, user),
      this.ai.runStuckTasksLiveScan(user),
    ]);
    return { ...failedRes, ...stuckRes };
  }

  /** Quét riêng trạng thái chuẩn trực tiếp trên nguồn của các đơn Đang xử lý > 30p (T-428) */
  @RequirePermissions('ai.tasks')
  @Post('tasks/scan-stuck')
  @HttpCode(200)
  scanStuckTasks(@CurrentUser() user: AuthUser) {
    return this.ai.runStuckTasksLiveScan(user);
  }

  /** Hỏi realtime trạng thái trực tiếp bên API nguồn cho các mục Đã hoàn tiền / Đã huỷ / Đang xử lý > 30p (T-495) */
  @RequirePermissions('ai.tasks')
  @Post('tasks/live-upstream')
  @HttpCode(200)
  probeTasksUpstreamLive(@Body() dto: ProbeTasksUpstreamDto, @CurrentUser() user: AuthUser) {
    return this.ai.probeTasksUpstreamLive(dto.ids, user, dto.force === true);
  }

  @RequirePermissions('ai.tasks')
  @Get('tasks/:id')
  task(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.ai.adminTask(id, user);
  }

  /** Kiểm duyệt trang Cộng đồng: ẩn / bỏ ẩn tác phẩm công khai */
  @RequirePermissions('ai.tasks.manage')
  @Put('tasks/:id/moderation')
  moderate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ModerateTaskDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminModerate(id, dto.hidden, actor);
  }

  /** Đánh dấu cảnh báo vi phạm nội dung (Nude/18+, KYC, Vi phạm pháp luật) hoặc gỡ cảnh báo — chỉ Admin thấy (T-273, T-281) */
  @RequirePermissions('ai.tasks')
  @Put('tasks/:id/violation')
  flagViolation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FlagTaskViolationDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminFlagViolation(id, dto, actor);
  }

  /** Xử lý đơn vi phạm thực sự: thu hồi kết quả & huỷ đơn KHÔNG hoàn tiền (T-281) */
  @RequirePermissions('ai.tasks.manage')
  @Post('tasks/:id/revoke-violation')
  @HttpCode(200)
  revokeViolation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelTaskDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminRevokeViolation(id, actor, dto.reason);
  }

  @RequireAnyPermission('ai.tasks.manage', 'ai.tools')
  @Get('community')
  adminCommunity(@Query() q: AdminCommunityQueryDto, @CurrentUser() user: AuthUser) {
    return this.ai.adminCommunityList(q, user);
  }

  @RequireAnyPermission('ai.tasks.manage', 'ai.tools')
  @Post('community/moderate')
  @HttpCode(200)
  bulkModerateCommunity(@Body() dto: BulkCommunityModerateDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminBulkCommunityModerate(dto, actor);
  }

  @RequireAnyPermission('ai.tasks.manage', 'ai.tools')
  @Post('community/showcase')
  createCommunityShowcase(@Body() dto: CreateCommunityShowcaseDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminCreateCommunityShowcase(dto, actor);
  }

  /** Gửi trực tiếp lệnh huỷ / hoàn đơn sang bên API nguồn và trả về phản hồi thực tế của nguồn (chưa tự hoàn khách trên web — T-501) */
  @RequirePermissions('ai.tasks.manage')
  @Post('tasks/:id/cancel-upstream-only')
  @HttpCode(200)
  cancelUpstreamOnly(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.ai.adminCancelUpstreamOnly(id, actor);
  }

  @RequirePermissions('ai.tasks.manage')
  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() dto: CancelTaskDto, @CurrentUser() actor: AuthUser) {
    return this.ai.adminCancel(id, actor, dto.reason);
  }
}
