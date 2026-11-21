import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const TASK_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
/** Khoá nhóm công cụ: chữ thường không dấu, số, gạch ngang (danh sách nhóm do admin quản lý, xem AiCategoriesService) */
export const CATEGORY_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Khách chạy công cụ: input là object theo form của công cụ (kiểm tra chi tiết ở validateInput) */
export class RunToolDto {
  @IsObject() input: Record<string, unknown>;
  /** Hiển thị công khai kết quả (mặc định riêng tư) */
  @IsOptional() @IsBoolean() isPublic?: boolean;
}

/** Khách trả lời câu hỏi của Muse trên tác vụ video bị từ chối (tạo tác vụ mới, tính tiền như một video) */
export class ReplyTaskDto {
  @IsString() @IsNotEmpty({ message: 'Nhập câu trả lời' }) @MaxLength(20_000) message: string;
}

/** Tải file đầu vào từ link (TikTok / Douyin / MP4) */
export class ImportUrlDto {
  @IsString() @MaxLength(1000) url: string;
}

/** Lọc trang Cộng đồng: nhóm, công cụ, từ khoá trong prompt */
export class CommunityQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(CATEGORY_KEY) category?: string;
  @IsOptional() @IsString() @MaxLength(80) tool?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/** Khách đổi chế độ hiển thị của tác vụ: công khai / riêng tư */
export class TaskVisibilityDto {
  @IsBoolean() isPublic: boolean;
}

/** Khách đặt tên riêng cho video / ảnh để lúc tải về lưu theo đúng tên đã đặt (để trống = quay về mã đơn mặc định) */
export class RenameTaskDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
}

/** Khách xoá nhiều tác phẩm cùng lúc (tối đa 100 / lần) */
export class DeleteTasksDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids: string[];
}

/** Khách lấy link tải hàng loạt (tải từng file hoặc nén .ZIP, tối đa 500 tác vụ / lần — khớp giới hạn lô) */
export class DownloadTasksDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
  /** Nhãn đặt tên file theo từng taskId (vd trang Tạo hàng loạt truyền "#1", "Dự án #1") */
  @IsOptional() @IsObject() labels?: Record<string, string>;
  /** Tên gợi ý cho file .zip (không kèm đuôi .zip) */
  @IsOptional() @IsString() @MaxLength(80) zipName?: string;
}

/** Admin kiểm duyệt: ẩn tác phẩm khỏi Cộng đồng (khoá không cho bật lại) hoặc bỏ ẩn (trả về Công khai) */
export class ModerateTaskDto {
  @IsBoolean() hidden: boolean;
}

/** Admin đánh dấu cảnh báo vi phạm nội dung hoặc gỡ cảnh báo (T-273) */
export class FlagTaskViolationDto {
  @IsIn(['flagged', 'dismissed']) status: 'flagged' | 'dismissed';
  @IsOptional() @IsIn(['nsfw', 'kyc', 'illegal', 'policy_blocked']) category?: 'nsfw' | 'kyc' | 'illegal' | 'policy_blocked';
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Lọc lịch sử tác vụ của khách */
export class TaskQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(TASK_STATUSES) declare status?: string;
  @IsOptional() @IsString() @MaxLength(80) tool?: string;
  @IsOptional() @Matches(CATEGORY_KEY) category?: string;
  /** Lọc theo danh sách id tác vụ (phân tách bằng dấu phẩy, tối đa 200) — trang "Tạo hàng loạt" hỏi trạng thái cả lô bằng một request */
  @IsOptional() @Matches(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(,[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){0,199}$/i) ids?: string;
}

/** Lọc tác vụ toàn hệ thống (admin) */
export class AdminTaskQueryDto extends TaskQueryDto {
  /** Cho phép thêm bộ lọc `STUCK` = tác vụ Đang chờ / Đang xử lý quá 30 phút */
  @IsOptional() @IsIn([...TASK_STATUSES, 'STUCK']) declare status?: string;
  /** Kiểm duyệt Cộng đồng: public = đang công khai, blocked = đã bị admin ẩn */
  @IsOptional() @IsIn(['public', 'blocked']) visibility?: 'public' | 'blocked';
  @IsOptional() @IsString() @MaxLength(40) provider?: string;
  @IsOptional() @IsUUID() userId?: string;
  /** Lọc theo ngày tạo (giờ Việt Nam): hôm nay / hôm qua / hôm kia */
  @IsOptional() @IsIn(['today', 'yesterday', 'daybefore']) day?: 'today' | 'yesterday' | 'daybefore';
  /** Lọc đơn có cảnh báo vi phạm nội dung (T-273) */
  @IsOptional() @IsIn(['any', 'nsfw', 'kyc', 'illegal', 'policy_blocked']) violation?: 'any' | 'nsfw' | 'kyc' | 'illegal' | 'policy_blocked';
}

/** Giá credits của công cụ */
export class ToolPricingDto {
  @IsOptional() @IsIn(['fixed', 'cost', 'free', 'tiers', 'per_second', 'per_char', 'by_resolution']) mode?: 'fixed' | 'cost' | 'free' | 'tiers' | 'per_second' | 'per_char' | 'by_resolution';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) base?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) perUnit?: number;
  @IsOptional() @IsObject() resolutionPrices?: Record<string, number>;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) tier10to20?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) tier20to30?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) multiplier?: number;
  /** % lãi cộng thêm (0 – 10.000%) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(10000) markup?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) min?: number;
  /** Bật tự custom giá riêng: bỏ qua khi đồng bộ % tăng giá / tự động cập nhật giá từ nguồn API (T-370) */
  @IsOptional() @IsBoolean() customPrice?: boolean;
}

/** Admin sửa công cụ */
export class UpdateToolDto {
  @IsOptional() @IsString() @MaxLength(250) name?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** Khoá nhóm (phải có trong danh sách nhóm — service kiểm tra) */
  @IsOptional() @Matches(CATEGORY_KEY) category?: string;
  @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @IsOptional() @IsString() @MaxLength(40) badge?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Chế độ bảo trì: gói vẫn hiển thị cho khách xem nhưng thay nút Tạo ngay bằng Đang bảo trì và chặn gửi đơn */
  @IsOptional() @IsBoolean() maintenance?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => ToolPricingDto) pricing?: ToolPricingDto;
  /** Các nhóm model của công cụ (công cụ cùng nhóm gộp thành 1 trên website; một công cụ ở được nhiều nhóm); mảng rỗng = đứng riêng */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) modelGroups?: string[];
  /** Tên model hiện trong ô chọn model của nhóm; chuỗi rỗng = dùng tên công cụ */
  @IsOptional() @IsString() @MaxLength(200) modelLabel?: string;
  /** URL video / ảnh mẫu hiển thị trên trang công cụ khách; chuỗi rỗng = gỡ bỏ */
  @IsOptional() @IsString() @MaxLength(1000) demoVideo?: string;
  /** Áp dụng cùng video mẫu cho tất cả công cụ thuộc cùng nhóm model */
  @IsOptional() @IsBoolean() applyDemoToGroup?: boolean;
  /** Tên nhóm model cụ thể cần đồng bộ video mẫu cho toàn bộ model trong nhóm */
  @IsOptional() @IsString() @MaxLength(80) applyDemoGroup?: string;
}

/** Admin thêm nhóm công cụ (bỏ trống khoá -> tự sinh từ tên) */
export class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(60) label: string;
  @IsOptional() @IsString() @MaxLength(40) key?: string;
  @IsOptional() @IsString() @MaxLength(40) icon?: string;
}

/** Admin sửa nhóm công cụ (khoá không đổi được vì công cụ lưu theo khoá) */
export class UpdateCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) label?: string;
  @IsOptional() @IsString() @MaxLength(40) icon?: string;
  /** Bật / tắt nhóm trên website khách */
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Thứ tự các nhóm model con bên trong nhóm cha (giữ vững vị trí kể cả khi nhóm dùng chung 100% model với nhóm khác — T-496) */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) groupOrder?: string[];
}

/** Admin sắp xếp lại nhóm: danh sách khoá theo thứ tự mới */
export class ReorderCategoriesDto {
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) keys: string[];
}

/** Sắp xếp lại công cụ (kéo thả nhóm model ở admin): khoá công cụ theo thứ tự mới */
export class ReorderToolsDto {
  @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) keys: string[];
}

/** Bật / tắt chế độ bảo trì hàng loạt cho danh sách công cụ đã chọn */
export class BulkMaintenanceDto {
  @IsArray() @ArrayMaxSize(1000) @IsString({ each: true }) keys: string[];
  @IsBoolean() maintenance: boolean;
}

/** Admin huỷ tác vụ */
export class CancelTaskDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/** Lọc thống kê số lượt chạy công cụ theo ngày / khoảng ngày (múi giờ Việt Nam UTC+7) */
export class ToolRunStatsQueryDto {
  @IsOptional() @IsIn(['all', 'today', 'yesterday', 'daybefore', '7d', '30d', 'custom']) period?: 'all' | 'today' | 'yesterday' | 'daybefore' | '7d' | '30d' | 'custom';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

/** Thành viên tạo mẫu giọng mới vào Kho giọng đã nhân bản cá nhân */
export class CreateClonedVoiceDto {
  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập tên giọng nói' }) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsString() @Matches(/^[a-z]{2,5}$/i) language: string;
  @IsIn(['male', 'female']) gender: 'male' | 'female';
  @IsString() @IsNotEmpty({ message: 'Vui lòng tải lên file giọng mẫu' }) @MaxLength(1000) refAudioUrl: string;
  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập lời nói tương ứng trong file mẫu' }) @MaxLength(2000) refText: string;
}

/** Thành viên cập nhật tên / mô tả / ngôn ngữ / giới tính của giọng đã nhân bản */
export class UpdateClonedVoiceDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @Matches(/^[a-z]{2,5}$/i) language?: string;
  @IsOptional() @IsIn(['male', 'female']) gender?: 'male' | 'female';
}

/** Admin lọc trang quản lý Cộng đồng (`/admin/ai/community` — T-324, T-325) */
export class AdminCommunityQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['public', 'candidates', 'blocked']) tab?: 'public' | 'candidates' | 'blocked';
  @IsOptional() @IsIn(['all', 'video', 'image']) mediaType?: 'all' | 'video' | 'image';
  @IsOptional() @IsString() @MaxLength(80) tool?: string;
}

/** Admin thao tác hàng loạt trên trang quản lý Cộng đồng */
export class BulkCommunityModerateDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids: string[];
  @IsIn(['publish', 'publish_pin', 'unpublish', 'hide', 'pin', 'unpin']) action: 'publish' | 'publish_pin' | 'unpublish' | 'hide' | 'pin' | 'unpin';
}

/** Admin tự đăng thêm Video / Ảnh mẫu nổi bật lên Cộng đồng */
export class CreateCommunityShowcaseDto {
  @IsString() @IsNotEmpty() @MaxLength(1000) fileUrl: string;
  @IsIn(['video', 'image']) fileType: 'video' | 'image';
  @IsString() @IsNotEmpty() @MaxLength(120) toolKey: string;
  @IsOptional() @IsString() @MaxLength(5000) prompt?: string;
  @IsOptional() @IsBoolean() pin?: boolean;
}

/** Tải Video Hàng Loạt Không Logo — Quét danh sách video từ URL Kênh / User / Từ khoá (T-382) */
export class BulkExtractDto {
  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập đường dẫn kênh hoặc từ khoá' }) @MaxLength(1000) query: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

/** Tải Video Hàng Loạt Không Logo — Tạo lô tải video hàng loạt (T-382) */
export class BulkCreateJobDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsString({ each: true }) urls: string[];
  @IsOptional() @IsIn(['360p', '480p', '720p', 'best']) quality?: '360p' | '480p' | '720p' | 'best';
}

/** Admin quét trạng thái realtime trực tiếp bên API nguồn cho các mục Đã hoàn tiền / Đã huỷ / Đang xử lý >30p (T-495) */
export class ProbeTasksUpstreamDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @IsString({ each: true }) ids: string[];
  @IsOptional() @IsBoolean() force?: boolean;
}
