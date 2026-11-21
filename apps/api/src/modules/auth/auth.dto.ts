import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email: string;

  @IsString() @MinLength(1)
  password: string;
}

export class RegisterDto {
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email: string;

  @IsString() @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' }) @MaxLength(128)
  password: string;

  @IsString() @MinLength(1) @MaxLength(120)
  name: string;

  @IsOptional() @IsString()
  phone?: string;

  /** Token captcha (khi Cài đặt > Bảo mật bật captcha cho đăng ký) */
  @IsOptional() @IsString()
  _captcha?: string;

  /** Mã giới thiệu (link /register?ref=... — nhận cả `ref` lẫn `referralCode` từ frontend) */
  @IsOptional() @IsString() @MaxLength(64)
  ref?: string;

  @IsOptional() @IsString() @MaxLength(64)
  referralCode?: string;
}

export class RefreshDto {
  @IsOptional() @IsString()
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email: string;

  /** Nơi mở link đặt lại mật khẩu: storefront (mặc định) hoặc trang quản trị */
  @IsOptional()
  @IsIn(['web', 'admin'])
  target?: 'web' | 'admin';
}

export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString() @MinLength(8) @MaxLength(128)
  newPassword: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  bio?: string;

  @IsOptional() @IsString()
  avatarId?: string | null;

  @IsOptional() @IsString()
  locale?: string;
}

export class VerifyEmailDto {
  @IsString() @MinLength(10)
  token: string;
}

/** Bước 2 đăng nhập: mã TOTP 6 số hoặc mã dự phòng */
export class Verify2faDto {
  @IsString() @MinLength(10)
  challenge: string;

  @IsOptional() @IsString() @MaxLength(32)
  code?: string;

  @IsOptional() @IsString() @MaxLength(32)
  recoveryCode?: string;

  /** Tin cậy thiết bị này 30 ngày (không hỏi mã 2FA) */
  @IsOptional() @IsBoolean()
  remember?: boolean;

  /** Trang quản trị gửi 'admin' -> API kiểm tra lại quyền admin.access trước khi cấp token */
  @IsOptional() @IsIn(['admin', 'site'])
  target?: 'admin' | 'site';
}

export class TwoFactorCodeDto {
  @IsString() @MinLength(6) @MaxLength(32)
  code: string;
}

export class Disable2faDto {
  @IsOptional() @IsString() @MaxLength(32)
  code?: string;

  @IsOptional() @IsString() @MaxLength(128)
  password?: string;
}

/** Đăng nhập bằng Google: ID token (credential) nhận từ Google Identity Services ở frontend */
export class GoogleLoginDto {
  @IsString() @MinLength(20) @MaxLength(4096)
  idToken: string;

  @IsOptional() @IsBoolean()
  rememberMe?: boolean;

  /** Mã giới thiệu khi tạo tài khoản mới bằng Google (nhận cả `ref` lẫn `referralCode`) */
  @IsOptional() @IsString() @MaxLength(64)
  ref?: string;

  @IsOptional() @IsString() @MaxLength(64)
  referralCode?: string;
}
