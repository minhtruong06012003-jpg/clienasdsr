/**
 * Từ điển giao diện website khách (apps/web): khoá = chuỗi gốc tiếng Việt đúng như trong code (kể cả {biến}),
 * giá trị = bản dịch. Bản tiếng Anh (thư mục en/) và tiếng Indonesia (thư mục id/, cùng bộ khoá với en/) viết sẵn trong code; admin sửa / thêm ngôn ngữ khác ở
 * menu Ngôn ngữ & tiền tệ › Bản dịch website (lưu DB, ghi đè lên bản có sẵn).
 * Dùng chung cho: web (dịch), admin (danh sách chuỗi cần dịch + bản tiếng Anh tham khảo), API (chỉ nhận khoá hợp lệ).
 */
import enCore from './en/core.js';
import enSite from './en/site.js';
import enOrder from './en/order.js';
import enFunds from './en/funds.js';
import enMember from './en/member.js';
import enAccount from './en/account.js';
import enShared from './en/shared.js';
import enStudio from './en/studio.js';
import enTools from './en/tools.js';
import enExtra from './en/extra.js';
import idCore from './id/core.js';
import idSite from './id/site.js';
import idOrder from './id/order.js';
import idFunds from './id/funds.js';
import idMember from './id/member.js';
import idAccount from './id/account.js';
import idShared from './id/shared.js';
import idStudio from './id/studio.js';
import idTools from './id/tools.js';
import idExtra from './id/extra.js';
import zhCore from './zh/core.js';
import zhSite from './zh/site.js';
import zhOrder from './zh/order.js';
import zhFunds from './zh/funds.js';
import zhMember from './zh/member.js';
import zhAccount from './zh/account.js';
import zhShared from './zh/shared.js';
import zhStudio from './zh/studio.js';
import zhTools from './zh/tools.js';
import zhExtra from './zh/extra.js';
import thCore from './th/core.js';
import thSite from './th/site.js';
import thOrder from './th/order.js';
import thFunds from './th/funds.js';
import thMember from './th/member.js';
import thAccount from './th/account.js';
import thShared from './th/shared.js';
import thStudio from './th/studio.js';
import thTools from './th/tools.js';
import thExtra from './th/extra.js';

/** Một nhóm chuỗi theo khu vực giao diện (để admin lọc khi dịch) */
export interface WebMessageGroup {
  key: string;
  label: string;
  /** bản tiếng Anh có sẵn của nhóm: { chuỗi gốc tiếng Việt: bản dịch } */
  en: Record<string, string>;
  /** bản tiếng Indonesia có sẵn của nhóm (cùng bộ khoá với en) */
  id: Record<string, string>;
  /** bản tiếng Trung giản thể có sẵn của nhóm (cùng bộ khoá với en) */
  zh: Record<string, string>;
  /** bản tiếng Thái có sẵn của nhóm (cùng bộ khoá với en) */
  th: Record<string, string>;
}

/** Các nhóm chuỗi theo thứ tự gộp (nhóm sau ghi đè nhóm trước khi trùng khoá) */
export const WEB_MESSAGE_GROUPS: WebMessageGroup[] = [
  { key: 'core', label: 'Chung & thông báo lỗi', en: enCore, id: idCore, zh: zhCore, th: thCore },
  { key: 'site', label: 'Trang công khai & tài khoản', en: enSite, id: idSite, zh: zhSite, th: thSite },
  { key: 'order', label: 'Đặt hàng & dịch vụ', en: enOrder, id: idOrder, zh: zhOrder, th: thOrder },
  { key: 'funds', label: 'Nạp tiền & giao dịch', en: enFunds, id: idFunds, zh: zhFunds, th: thFunds },
  { key: 'member', label: 'Khu vực thành viên', en: enMember, id: idMember, zh: zhMember, th: thMember },
  { key: 'account', label: 'Hồ sơ & bảo mật', en: enAccount, id: idAccount, zh: zhAccount, th: thAccount },
  { key: 'studio', label: 'AI Studio (công cụ, lịch sử, gói cước)', en: enStudio, id: idStudio, zh: zhStudio, th: thStudio },
  { key: 'tools', label: 'Công cụ AI của nhà cung cấp & gói credits', en: enTools, id: idTools, zh: zhTools, th: thTools },
  { key: 'shared', label: 'Thuật ngữ dùng chung', en: enShared, id: idShared, zh: zhShared, th: thShared },
  { key: 'extra', label: 'Bổ sung (tải hàng loạt, API /v1, tạo hàng loạt...)', en: enExtra, id: idExtra, zh: zhExtra, th: thExtra },
];

/** Bản tiếng Anh có sẵn (gộp mọi nhóm) */
export const WEB_MESSAGES_EN: Record<string, string> = Object.assign({}, ...WEB_MESSAGE_GROUPS.map((g) => g.en));

/** Bản tiếng Indonesia có sẵn (gộp mọi nhóm) */
export const WEB_MESSAGES_ID: Record<string, string> = Object.assign({}, ...WEB_MESSAGE_GROUPS.map((g) => g.id));

/** Bản tiếng Trung giản thể có sẵn (gộp mọi nhóm) */
export const WEB_MESSAGES_ZH: Record<string, string> = Object.assign({}, ...WEB_MESSAGE_GROUPS.map((g) => g.zh));

/** Bản tiếng Thái có sẵn (gộp mọi nhóm) */
export const WEB_MESSAGES_TH: Record<string, string> = Object.assign({}, ...WEB_MESSAGE_GROUPS.map((g) => g.th));

/** Ngôn ngữ gốc của chuỗi trong code website */
export const WEB_SOURCE_LOCALE = 'vi';

/** Mã ngôn ngữ hợp lệ (khớp LanguagesService.upsert): vi, en, zh-cn... */
export const LOCALE_CODE_PATTERN = /^[a-z]{2}(-[a-z]{2})?$/;

/** Bản dịch admin đã lưu: { [mã ngôn ngữ]: { chuỗi gốc: bản dịch } } */
export type WebMessagesStore = Record<string, Record<string, string>>;
