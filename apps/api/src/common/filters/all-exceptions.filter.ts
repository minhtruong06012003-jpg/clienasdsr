import { ArgumentsHost, Catch, ConsoleLogger, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { logWriter } from '../../modules/logs/log-writer.js';
import { PrismaExceptionFilter } from './prisma-exception.filter.js';

const isPrismaError = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientValidationError || e instanceof Prisma.PrismaClientUnknownRequestError;

/**
 * Bắt MỌI exception của request HTTP: trả response giống mặc định của Nest (lỗi Prisma đổi
 * sang mã dễ hiểu qua PrismaExceptionFilter) và ghi vào nhật ký lỗi kèm thông tin request.
 * - 5xx: luôn ghi mức error (kèm stack trace).
 * - 4xx: chỉ ghi (mức warn) khi bật "Ghi cả lỗi 4xx" trong cài đặt.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly prisma = new PrismaExceptionFilter();
  /** In ra console trực tiếp (không qua AppLogger) để không ghi file 2 lần */
  private readonly console = new ConsoleLogger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const req = host.switchToHttp().getRequest<Request & { user?: { id?: string; email?: string } }>();
    const res = host.switchToHttp().getResponse<Response>();

    let status: number;
    let clientMessage: unknown;
    if (isPrismaError(exception)) {
      this.prisma.catch(exception as Prisma.PrismaClientKnownRequestError, host);
      status = res.statusCode;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      clientMessage = typeof body === 'string' ? body : (body as { message?: unknown }).message;
      if (!res.headersSent) res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      if (!res.headersSent) res.status(status).json({ statusCode: status, message: 'Internal server error' });
    }
    // response đang stream dở (tải file...) mà lỗi -> đóng kết nối
    if (res.headersSent && !res.writableEnded && status >= 500) res.end();

    const cfg = logWriter.settings;
    if (status < 500 && !(cfg.log4xx && status >= 400)) return;
    const err = exception instanceof Error ? exception : new Error(String(exception));
    const message = status < 500 && clientMessage !== undefined ? (Array.isArray(clientMessage) ? clientMessage.join('; ') : String(clientMessage)) : err.message;
    if (status >= 500) this.console.error(`${req.method} ${req.originalUrl} → ${status}: ${err.message}`, err.stack);
    logWriter.write({
      level: status >= 500 ? 'error' : 'warn',
      source: 'http',
      context: err.constructor?.name && err.constructor.name !== 'Error' ? err.constructor.name : 'ExceptionsHandler',
      message: `${message}`,
      stack: status >= 500 ? err.stack : undefined,
      request: {
        method: req.method,
        url: req.originalUrl,
        status,
        ip: req.ip,
        userId: req.user?.id,
        userEmail: req.user?.email,
        userAgent: req.get('user-agent')?.slice(0, 300),
        referer: req.get('referer')?.slice(0, 500),
      },
      // mã lỗi Prisma (P2xxx) giúp tra cứu nhanh
      meta: exception instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: exception.code } : undefined,
    });
  }
}
