import type { NextFunction, Request, Response } from 'express';
import type { IpRulesService } from './ip-rules.service.js';

/** Request vào khu quản trị: API admin và đăng nhập quản trị */
const ADMIN_PATH = /^\/api\/(admin\/|auth\/admin\/)/;

/**
 * Middleware Express chạy trước mọi route (gắn trong main.ts, sau `trust proxy` để req.ip là IP thật):
 * - IP nằm trong danh sách chặn -> 403 cho mọi request.
 * - Bật "chỉ cho phép IP trong danh sách" -> request vào khu quản trị từ IP khác -> 403.
 * Loopback (storefront SSR, cron trên cùng máy) luôn được phép — xử lý trong IpRulesService.
 * Lỗi bất ngờ khi tra quy tắc thì cho qua (fail-open) để không làm sập cả website.
 */
export function createIpFilter(ipRules: IpRulesService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await ipRules.isBlocked(req.ip)) {
        res.status(403).json({ statusCode: 403, message: 'Địa chỉ IP của bạn đã bị chặn truy cập', error: 'Forbidden' });
        return;
      }
      // chữ thường: router khớp không phân biệt hoa/thường nên /api/Admin/... cũng vào route quản trị
      const path = req.originalUrl.split('?')[0].toLowerCase();
      if (ADMIN_PATH.test(path) && !(await ipRules.isAdminAllowed(req.ip))) {
        res.status(403).json({ statusCode: 403, message: 'Địa chỉ IP của bạn không được phép truy cập trang quản trị', error: 'Forbidden' });
        return;
      }
    } catch {
      // bỏ qua: không để lỗi tra cứu chặn toàn bộ request
    }
    next();
  };
}
