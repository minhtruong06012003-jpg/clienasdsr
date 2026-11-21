import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const schedulerOff = process.env.DISABLE_SCHEDULER === '1' || process.env.DISABLE_SCHEDULER === 'true';
    const isChild = process.env.TENANT_ROLE === 'child';
    const defaultMax = schedulerOff ? 2 : isChild ? 3 : 10;
    const max = Math.max(2, Number(process.env.DB_POOL_MAX) || defaultMax);
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
        max,
        idleTimeoutMillis: schedulerOff || isChild ? 10_000 : 20_000,
        connectionTimeoutMillis: 10_000,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
