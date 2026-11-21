import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * Dịch thông báo lỗi mặc định (tiếng Anh) của class-validator sang tiếng Việt.
 *
 * - Chỉ dịch khi thông báo đúng là câu mặc định của class-validator (bắt đầu bằng tên trường,
 *   "each value in <trường>", "property <trường> should not exist"...). Thông báo tiếng Việt đã
 *   tự gắn trong DTO (`@IsString({ message: '...' })`) được giữ nguyên.
 * - Tên trường lồng nhau ghi theo đường dẫn đầy đủ (vd `items.0.quantity`) để admin/frontend biết lỗi ở đâu.
 * - Giữ đúng cấu trúc response mặc định của Nest: `{ statusCode: 400, message: string[], error: 'Bad Request' }`
 *   (admin `lib/api.ts` đọc `message` — mảng chuỗi thì nối bằng dấu phẩy).
 */

/** Một constraint -> hàm dựng phần "vị ngữ" tiếng Việt từ câu mặc định tiếng Anh (lấy số / danh sách giá trị trong câu gốc) */
type Translator = (english: string) => string | null;

/** Lấy số đầu tiên xuất hiện sau cụm `after` trong câu tiếng Anh (vd "must not be less than 5" -> "5") */
const numberAfter = (english: string, after: string) => {
  const i = english.indexOf(after);
  if (i < 0) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(english.slice(i + after.length));
  return m ? m[0] : null;
};

/** Lấy danh sách giá trị cho isIn / isEnum: "... must be one of the following values: a, b, c" */
const valuesAfterColon = (english: string) => {
  const i = english.lastIndexOf(':');
  return i >= 0 ? english.slice(i + 1).trim() : '';
};

/** Khoá = tên constraint của class-validator (vd IS_UUID = 'isUuid', IS_ISO8601 = 'isIso8601') */
const TRANSLATORS: Record<string, Translator> = {
  isNotEmpty: () => 'không được để trống',
  isDefined: () => 'là bắt buộc',
  arrayNotEmpty: () => 'không được để trống',
  isNotEmptyObject: () => 'không được để trống',
  isString: () => 'phải là chuỗi ký tự',
  isNumber: () => 'phải là số',
  isInt: () => 'phải là số nguyên',
  isPositive: () => 'phải là số dương',
  isNegative: () => 'phải là số âm',
  isNumberString: () => 'phải là chuỗi số',
  isBoolean: () => 'phải là true hoặc false',
  isBooleanString: () => 'phải là "true" hoặc "false"',
  isEmail: () => 'phải là địa chỉ email hợp lệ',
  isUuid: () => 'phải là UUID hợp lệ',
  isUrl: () => 'phải là đường dẫn URL hợp lệ',
  isArray: () => 'phải là danh sách (mảng)',
  isObject: () => 'phải là object',
  isDate: () => 'phải là ngày giờ hợp lệ',
  isDateString: () => 'phải là ngày giờ hợp lệ (ISO 8601)',
  isIso8601: () => 'phải là ngày giờ hợp lệ (ISO 8601)',
  isHexColor: () => 'phải là mã màu hex hợp lệ',
  isJson: () => 'phải là chuỗi JSON hợp lệ',
  isIp: () => 'phải là địa chỉ IP hợp lệ',
  isPhoneNumber: () => 'phải là số điện thoại hợp lệ',
  isMobilePhone: () => 'phải là số điện thoại di động hợp lệ',
  isAlphanumeric: () => 'chỉ được chứa chữ và số',
  isLowercase: () => 'phải viết thường',
  matches: () => 'không đúng định dạng',
  min: (e) => `không được nhỏ hơn ${numberAfter(e, 'less than') ?? '?'}`,
  max: (e) => `không được lớn hơn ${numberAfter(e, 'greater than') ?? '?'}`,
  minLength: (e) => `phải có ít nhất ${numberAfter(e, 'equal to') ?? '?'} ký tự`,
  maxLength: (e) => `không được dài quá ${numberAfter(e, 'equal to') ?? '?'} ký tự`,
  isLength: (e) => (/longer/.test(e) ? `phải có ít nhất ${numberAfter(e, 'equal to') ?? '?'} ký tự` : `không được dài quá ${numberAfter(e, 'equal to') ?? '?'} ký tự`),
  arrayMaxSize: (e) => `chỉ được có tối đa ${numberAfter(e, 'no more than') ?? '?'} phần tử`,
  arrayMinSize: (e) => `phải có ít nhất ${numberAfter(e, 'at least') ?? '?'} phần tử`,
  arrayUnique: () => 'không được có phần tử trùng nhau',
  isNotIn: () => 'có giá trị không được phép',
  minDate: () => 'không được sớm hơn mốc cho phép',
  maxDate: () => 'không được muộn hơn mốc cho phép',
  isIn: (e) => `phải là một trong các giá trị: ${valuesAfterColon(e)}`,
  isEnum: (e) => `phải là một trong các giá trị: ${valuesAfterColon(e)}`,
  equals: () => 'không đúng giá trị yêu cầu',
};

/** Ghép tên trường theo đường dẫn lồng nhau (vd `items.0.quantity`) */
const joinPath = (parent: string, property: string) => (parent ? `${parent}.${property}` : property);

/**
 * Dịch MỘT thông báo của constraint. `property` là tên trường gốc (class-validator dùng nó trong câu mặc định),
 * `field` là đường dẫn đầy đủ để hiển thị. Trả nguyên văn khi không nhận ra câu mặc định (thông báo tự gắn trong DTO).
 */
export function translateConstraint(constraint: string, message: string, property: string, field: string): string {
  // trường không được khai báo trong DTO (whitelist + forbidNonWhitelisted)
  if (constraint === 'whitelistValidation' && message === `property ${property} should not exist`) return `Trường "${field}" không được phép gửi lên`;
  if (constraint === 'nestedValidation' && message.startsWith('nested property')) return `Trường "${field}" phải là object hoặc mảng`;
  if (constraint === 'unknownValue') return 'Dữ liệu gửi lên không hợp lệ';

  const translator = TRANSLATORS[constraint];
  if (!translator) return message;
  // câu mặc định luôn bắt đầu bằng "<trường> ..." hoặc "each value in <trường> ..." (validate từng phần tử, each: true)
  const eachPrefix = `each value in ${property} `;
  if (message.startsWith(eachPrefix)) {
    const rest = translator(message.slice(eachPrefix.length));
    return rest ? `Mỗi phần tử của trường "${field}" ${rest}` : message;
  }
  if (message.startsWith(`${property} `)) {
    const rest = translator(message.slice(property.length + 1));
    return rest ? `Trường "${field}" ${rest}` : message;
  }
  return message;
}

/** Duyệt cây lỗi (kể cả lỗi lồng nhau của @ValidateNested) thành danh sách câu thông báo tiếng Việt */
export function translateValidationErrors(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const err of errors) {
    const field = joinPath(parent, err.property);
    for (const [constraint, message] of Object.entries(err.constraints ?? {})) out.push(translateConstraint(constraint, message, err.property, field));
    if (err.children?.length) out.push(...translateValidationErrors(err.children, field));
  }
  // bỏ câu trùng (vd nhiều phần tử cùng lỗi) nhưng giữ thứ tự
  return [...new Set(out)];
}

/** `exceptionFactory` cho ValidationPipe toàn cục: 400 với `message` là mảng câu tiếng Việt */
export function validationExceptionFactory(errors: ValidationError[]) {
  const messages = translateValidationErrors(errors);
  return new BadRequestException(messages.length ? messages : ['Dữ liệu gửi lên không hợp lệ']);
}
