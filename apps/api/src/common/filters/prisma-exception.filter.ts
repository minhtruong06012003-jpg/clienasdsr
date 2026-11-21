import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Đổi lỗi Prisma thành HTTP status dễ hiểu. Không bao giờ trả message nội bộ
 * (chứa đường dẫn, câu truy vấn) cho client — chỉ ghi log phía server.
 * Được gọi từ AllExceptionsFilter; lỗi 500 do AllExceptionsFilter ghi vào nhật ký lỗi.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError, Prisma.PrismaClientUnknownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError | Prisma.PrismaClientUnknownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, message: string, error: string) => res.status(status).json({ statusCode: status, message, error });

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return send(HttpStatus.BAD_REQUEST, 'Tham số không hợp lệ', 'Bad Request');
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          const target = (exception.meta?.target as string[] | string | undefined) ?? '';
          return send(HttpStatus.CONFLICT, `Giá trị đã tồn tại (trùng lặp)${target ? `: ${JSON.stringify(target)}` : ''}`, 'Conflict');
        }
        case 'P2025':
        case 'P2001':
          return send(HttpStatus.NOT_FOUND, 'Không tìm thấy dữ liệu', 'Not Found');
        case 'P2003':
          return send(HttpStatus.BAD_REQUEST, 'Dữ liệu liên kết không hợp lệ', 'Bad Request');
        case 'P2000':
        case 'P2005':
        case 'P2006':
        case 'P2007':
        case 'P2009':
        case 'P2023':
          return send(HttpStatus.BAD_REQUEST, 'Tham số không hợp lệ', 'Bad Request');
      }
      // lỗi từ driver (vd chuỗi không phải UUID / enum sai) -> 400
      if (/invalid input (syntax|value)|22P02|22007|23514/i.test(exception.message)) return send(HttpStatus.BAD_REQUEST, 'Tham số không hợp lệ', 'Bad Request');
    }
    return send(HttpStatus.INTERNAL_SERVER_ERROR, 'Lỗi máy chủ, vui lòng thử lại sau', 'Internal Server Error');
  }
}
