import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { translateValidationErrors, validationExceptionFactory } from './validation-messages.js';

/** DTO lồng nhau để kiểm tra đường dẫn trường `items.0.qty` */
class ItemDto {
  @IsInt() @Min(1) qty: number;
}

/** DTO mẫu: đủ các constraint hay dùng + một thông báo tiếng Việt tự gắn */
class SampleDto {
  @IsNotEmpty() @IsString() name: string;
  @IsEmail() email: string;
  @MinLength(8) password: string;
  @MaxLength(5) code: string;
  @IsInt() @Max(10) age: number;
  @IsIn(['a', 'b']) kind: string;
  @IsUUID() id: string;
  @IsArray() @ArrayMaxSize(2) @IsString({ each: true }) tags: string[];
  @IsOptional() @IsString({ message: 'Ghi chú phải là chữ' }) note?: unknown;
  @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
}

async function messagesFor(plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(SampleDto, plain), { whitelist: true, forbidNonWhitelisted: true });
  return translateValidationErrors(errors);
}

describe('translateValidationErrors', () => {
  it('dịch các constraint phổ biến kèm tên trường và tham số', async () => {
    const msgs = await messagesFor({ name: '', email: 'x', password: '123', code: '1234567', age: 11.5, kind: 'c', id: 'abc', tags: ['a', 1, 'c'], items: [{ qty: 0 }] });
    expect(msgs).toContain('Trường "name" không được để trống');
    expect(msgs).toContain('Trường "email" phải là địa chỉ email hợp lệ');
    expect(msgs).toContain('Trường "password" phải có ít nhất 8 ký tự');
    expect(msgs).toContain('Trường "code" không được dài quá 5 ký tự');
    expect(msgs).toContain('Trường "age" phải là số nguyên');
    expect(msgs).toContain('Trường "age" không được lớn hơn 10');
    expect(msgs).toContain('Trường "kind" phải là một trong các giá trị: a, b');
    expect(msgs).toContain('Trường "id" phải là UUID hợp lệ');
    expect(msgs).toContain('Trường "tags" chỉ được có tối đa 2 phần tử');
    expect(msgs).toContain('Mỗi phần tử của trường "tags" phải là chuỗi ký tự');
    expect(msgs).toContain('Trường "items.0.qty" không được nhỏ hơn 1');
  });

  it('giữ nguyên thông báo tiếng Việt đã gắn trong DTO', async () => {
    const msgs = await messagesFor({ note: 5 });
    expect(msgs).toContain('Ghi chú phải là chữ');
  });

  it('báo trường thừa khi bật forbidNonWhitelisted', async () => {
    const msgs = await messagesFor({ hacker: 1 });
    expect(msgs).toContain('Trường "hacker" không được phép gửi lên');
  });

  it('exceptionFactory giữ cấu trúc response mặc định của Nest (message là mảng)', async () => {
    const errors = await validate(plainToInstance(SampleDto, {}));
    const body = validationExceptionFactory(errors).getResponse() as { statusCode: number; message: string[]; error: string };
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.error).toBe('Bad Request');
  });
});
