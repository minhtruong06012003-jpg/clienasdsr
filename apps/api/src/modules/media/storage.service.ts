import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Lớp lưu trữ file. Mặc định lưu local (thư mục uploads).
 * Chọn driver bằng env STORAGE_DRIVER=local|s3 (xem media.module.ts).
 */
export interface StorageDriver {
  name: string;
  put(path: string, data: Buffer, mimeType?: string): Promise<void>;
  /** Đọc lại nội dung file (dùng khi chỉnh ảnh) */
  get(path: string): Promise<Buffer>;
  /** Lưu file từ một file tạm trên đĩa (file lớn, vd video 1GB — không đọc cả file vào RAM); file tạm có thể bị chuyển đi */
  putFile(path: string, srcFile: string, mimeType?: string): Promise<void>;
  /** Đường dẫn tuyệt đối trên đĩa (chỉ driver local) — đọc từng phần file lớn mà không tải cả file */
  localPath?(path: string): string;
  delete(path: string): Promise<void>;
  url(path: string): string;
}

/** Token DI cho driver đang dùng: @Inject(STORAGE) private readonly storage: StorageDriver */
export const STORAGE = Symbol('STORAGE');

@Injectable()
export class LocalStorageService implements StorageDriver {
  name = 'local';
  readonly root: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    const dir = config.get<string>('upload.dir') ?? 'uploads';
    this.root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    this.baseUrl = `${config.get<string>('apiPublicUrl')}/uploads`;
  }

  private abs(path: string) {
    const full = resolve(join(this.root, path));
    if (!full.startsWith(this.root)) throw new Error('Đường dẫn không hợp lệ');
    return full;
  }

  async put(path: string, data: Buffer, _mimeType?: string) {
    const full = this.abs(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  get(path: string) {
    return readFile(this.abs(path));
  }

  async putFile(path: string, srcFile: string, _mimeType?: string) {
    const full = this.abs(path);
    await mkdir(dirname(full), { recursive: true });
    // chuyển file tạm sang thư mục uploads; khác ổ đĩa (EXDEV) thì chép
    await rename(srcFile, full).catch(() => copyFile(srcFile, full));
  }

  localPath(path: string) {
    return this.abs(path);
  }

  async delete(path: string) {
    await unlink(this.abs(path)).catch(() => undefined);
  }

  url(path: string) {
    return `${this.baseUrl}/${path}`;
  }
}

export interface S3Options {
  bucket: string;
  region?: string;
  /** Endpoint tuỳ chỉnh cho Cloudflare R2 / MinIO / DigitalOcean Spaces... */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** URL công khai (CDN / custom domain) — nếu bỏ trống sẽ suy ra từ endpoint/bucket */
  publicUrl?: string;
  forcePathStyle?: boolean;
}

/** Đọc cấu hình S3 từ biến môi trường (S3_*) */
export function s3OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): S3Options {
  return {
    bucket: env.S3_BUCKET ?? '',
    region: env.S3_REGION || 'auto',
    endpoint: env.S3_ENDPOINT || undefined,
    accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
    publicUrl: env.S3_PUBLIC_URL || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true',
  };
}

/**
 * Driver S3 tương thích AWS S3, Cloudflare R2, MinIO, Spaces...
 * - put: gửi kèm ContentType + Cache-Control dài hạn (file đặt tên theo hash, bất biến)
 * - url: STORAGE/S3_PUBLIC_URL + path (nên trỏ CDN / custom domain đã bật public access)
 */
@Injectable()
export class S3StorageService implements StorageDriver {
  name = 's3';
  private readonly logger = new Logger('S3Storage');
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: S3Options) {
    if (!opts.bucket) throw new Error('Thiếu S3_BUCKET khi STORAGE_DRIVER=s3');
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region || 'auto',
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
      credentials: opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
    });
    this.baseUrl = (opts.publicUrl ?? this.defaultPublicUrl()).replace(/\/$/, '');
    this.logger.log(`Dùng S3 bucket "${this.bucket}" (${opts.endpoint ?? `region ${opts.region}`}) → ${this.baseUrl}`);
  }

  private defaultPublicUrl() {
    if (this.opts.endpoint) {
      const ep = this.opts.endpoint.replace(/\/$/, '');
      return this.opts.forcePathStyle === false ? ep.replace('://', `://${this.bucket}.`) : `${ep}/${this.bucket}`;
    }
    return `https://${this.bucket}.s3.${this.opts.region || 'us-east-1'}.amazonaws.com`;
  }

  async put(path: string, data: Buffer, mimeType?: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: path, Body: data, ContentType: mimeType ?? 'application/octet-stream', CacheControl: 'public, max-age=31536000, immutable' }),
    );
  }

  async putFile(path: string, srcFile: string, mimeType?: string) {
    // gửi dạng luồng đọc từ đĩa; cần ContentLength vì SDK không tự đo được độ dài luồng
    const { size } = await stat(srcFile);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: path, Body: createReadStream(srcFile), ContentLength: size, ContentType: mimeType ?? 'application/octet-stream', CacheControl: 'public, max-age=31536000, immutable' }),
    );
  }

  async get(path: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Không đọc được file ${path} từ S3`);
    return Buffer.from(bytes);
  }

  async delete(path: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path })).catch((err: Error) => this.logger.warn(`Không xoá được ${path}: ${err.message}`));
  }

  url(path: string) {
    return `${this.baseUrl}/${path}`;
  }
}
