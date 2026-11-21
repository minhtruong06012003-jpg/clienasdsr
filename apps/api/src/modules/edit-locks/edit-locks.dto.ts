import { IsString, Matches, MaxLength } from 'class-validator';

/** Tham số đường dẫn khoá: entity (page|post|product|entry|theme_template|global_block|...) + id bản ghi */
export class EditLockParamsDto {
  @IsString() @Matches(/^[a-z][a-z0-9_:-]{1,39}$/, { message: 'entity không hợp lệ' })
  entity!: string;

  @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9_.:-]+$/, { message: 'id không hợp lệ' })
  id!: string;
}

/** Body của beacon nhả khoá */
export class ReleaseBeaconDto {
  @IsString() @MaxLength(2000)
  token!: string;
}
