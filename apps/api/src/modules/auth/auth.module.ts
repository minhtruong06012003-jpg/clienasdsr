import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthUserCache } from './auth-user.cache.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get('jwt.accessTtl') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthUserCache],
  exports: [AuthService, AuthUserCache],
})
export class AuthModule {}
