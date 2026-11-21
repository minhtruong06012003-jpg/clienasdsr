export type EmailTemplateGroup = 'order' | 'account' | 'other';

export interface EmailTemplateVar {
  name: string;
  label: string;
}

export interface EmailTemplateListItem {
  key: string;
  name: string;
  description: string;
  group: EmailTemplateGroup;
  audience: 'customer' | 'admin';
  customized: boolean;
  enabled: boolean;
  locales: Record<string, { exists: boolean; customized: boolean; enabled: boolean }>;
  updatedAt: string | null;
}

export interface EmailTemplateList {
  data: EmailTemplateListItem[];
  groups: Record<EmailTemplateGroup, string>;
  locales: string[];
  defaultLocale: string;
}

export interface EmailTemplateDetail {
  key: string;
  name: string;
  description: string;
  group: EmailTemplateGroup;
  audience: 'customer' | 'admin';
  vars: EmailTemplateVar[];
  locale: string;
  subject: string;
  html: string;
  enabled: boolean;
  customized: boolean;
  default: { subject: string; html: string };
  updatedAt: string | null;
}

/** QUEUED/SENDING: trong hàng chờ gửi; CANCELLED: quản trị viên huỷ khi còn chờ */
export type EmailLogStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'CANCELLED';

export interface EmailLogRow {
  id: string;
  to: string;
  subject: string;
  templateKey: string | null;
  templateName: string | null;
  status: EmailLogStatus;
  error: string | null;
  meta: Record<string, unknown>;
  canResend: boolean;
  /** email chứa mã / tài khoản (giao mã số): nội dung không lưu lại sau khi gửi, không gửi lại từ nhật ký */
  sensitive?: boolean;
  html?: string;
  /** hàng chờ: số lần đã thử / tối đa, lần thử kế tiếp, thời điểm gửi xong, ưu tiên */
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  priority: number;
  createdAt: string;
}

export const GROUP_ORDER: EmailTemplateGroup[] = ['order', 'account', 'other'];
