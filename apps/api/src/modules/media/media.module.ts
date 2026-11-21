import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { LocalStorageService, S3StorageService, STORAGE, s3OptionsFromEnv, type StorageDriver } from './storage.service.js';

/**
 * Driver lưu trữ chọn theo env STORAGE_DRIVER (local | s3).
 * LocalStorageService vẫn được cung cấp riêng cho các module cần đường dẫn trên đĩa (downloads, uploads tĩnh).
 */
const storageProvider = {
  provide: STORAGE,
  inject: [LocalStorageService, ConfigService],
  useFactory: (local: LocalStorageService): StorageDriver => (process.env.STORAGE_DRIVER === 's3' ? new S3StorageService(s3OptionsFromEnv()) : local),
};

@Global()
@Module({
  controllers: [MediaController],
  providers: [MediaService, LocalStorageService, storageProvider],
  exports: [MediaService, LocalStorageService, STORAGE],
})
export class MediaModule {}
