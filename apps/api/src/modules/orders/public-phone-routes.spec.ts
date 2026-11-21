import { describe, expect, it } from 'vitest';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { PublicOrdersController } from './orders.controller.js';
import { DownloadsController } from '../downloads/downloads.controller.js';

/** Đọc metadata route (method + path + header) Nest gắn qua decorator */
const route = (handler: unknown) => ({
  method: Reflect.getMetadata(METHOD_METADATA, handler as object) as RequestMethod,
  path: Reflect.getMetadata(PATH_METADATA, handler as object) as string,
  headers: (Reflect.getMetadata(HEADERS_METADATA, handler as object) ?? []) as { name: string; value: string }[],
});

describe('SĐT không nằm trên URL: tra cứu đơn + file tải về', () => {
  it('có biến thể POST nhận SĐT trong body', () => {
    expect(route(PublicOrdersController.prototype.lookupPost)).toMatchObject({ method: RequestMethod.POST, path: 'public/orders/lookup' });
    expect(route(DownloadsController.prototype.guestPost)).toMatchObject({ method: RequestMethod.POST, path: 'public/orders/:code/downloads' });
  });

  it('GET cũ vẫn còn nhưng trả header Deprecation: true', () => {
    for (const h of [PublicOrdersController.prototype.lookup, DownloadsController.prototype.guest]) {
      const r = route(h);
      expect(r.method).toBe(RequestMethod.GET);
      expect(r.headers).toContainEqual({ name: 'Deprecation', value: 'true' });
    }
  });
});
