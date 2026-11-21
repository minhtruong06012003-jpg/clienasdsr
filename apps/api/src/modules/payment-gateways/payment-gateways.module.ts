import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { payosProvider } from './payos.provider.js';
import { sepayProvider } from './sepay.provider.js';
import { pay2sProvider } from './pay2s.provider.js';
import { web2mProvider } from './web2m.provider.js';
import { usdtProvider } from './usdt.provider.js';

/**
 * Đăng ký các cổng thanh toán online vào PaymentsService lúc khởi động. Đang dùng Web2M (nhóm cài đặt `web2m`)
 * và USDT qua USDT Gateway (nhóm `usdt`);
 * PayOS / SePay / Pay2S vẫn đăng ký nhưng ở chế độ ẩn (`hidden`): không hiện cho khách / trang Cài đặt,
 * chỉ còn nhận webhook của giao dịch cũ.
 * Thêm cổng mới: viết file `<ten>.provider.ts` triển khai PaymentProvider rồi đăng ký ở đây.
 */
@Injectable()
class PaymentGatewaysRegistrar implements OnModuleInit {
  constructor(
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const deps = { settings: this.settings, prisma: this.prisma };
    for (const provider of [web2mProvider(deps), usdtProvider(deps), payosProvider(deps), sepayProvider(deps), pay2sProvider(deps)]) this.payments.register(provider);
  }
}

// PaymentsService / SettingsService / PrismaService đều từ module Global nên không cần imports
@Module({ providers: [PaymentGatewaysRegistrar] })
export class PaymentGatewaysModule {}
