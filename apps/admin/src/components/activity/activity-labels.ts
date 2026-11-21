/**
 * Nhãn tiếng Việt cho nhật ký hoạt động (dùng chung cho trang Nhật ký và tab Hoạt động của thành viên).
 */
export const ENTITY: Record<string, { label: string; href?: (id: string) => string }> = {
  page: { label: 'Trang', href: (id) => `/pages/${id}` },
  post: { label: 'Bài viết', href: (id) => `/posts/${id}` },
  product: { label: 'Sản phẩm', href: (id) => `/products/${id}` },
  order: { label: 'Đơn hàng', href: (id) => `/orders/${id}` },
  user: { label: 'Thành viên', href: (id) => `/users/${id}` },
  form: { label: 'Form' },
  menu: { label: 'Menu', href: (id) => `/menus/${id}` },
  media: { label: 'Media' },
  role: { label: 'Vai trò', href: (id) => `/roles/${id}` },
  language: { label: 'Ngôn ngữ' },
  settings: { label: 'Cài đặt' },
  // 'plugin': chỉ còn trong nhật ký cũ (trước khi bỏ cơ chế plugin) — giữ để hiển thị đúng lịch sử
  plugin: { label: 'Plugin' },
  webhook: { label: 'Webhook' },
  comment: { label: 'Bình luận' },
  review: { label: 'Đánh giá' },
  backup: { label: 'Sao lưu' },
  cache: { label: 'Cache' },
  submission: { label: 'Dữ liệu form' },
  auth: { label: 'Đăng nhập' },
  tools: { label: 'Công cụ' },
  // trang thành viên đã bỏ tab Ví nên link về trang thành viên
  wallet: { label: 'Ví', href: (id) => `/users/${id}` },
  // tài khoản khách tự thao tác (vd account.deleted = khách tự xoá tài khoản)
  account: { label: 'Tài khoản khách' },
  // giao dịch cổng thanh toán (payment.confirm, payment.overpaid...)
  payment: { label: 'Thanh toán' },
  ai_task: { label: 'Tác vụ AI', href: () => '/ai/tasks' },
  ai: { label: 'AI Studio' },
};

/** Nhóm hành động (prefix trước dấu chấm) cho bộ lọc */
export const ACTION_GROUPS: Record<string, string> = {
  auth: 'Đăng nhập',
  user: 'Thành viên',
  role: 'Vai trò',
  page: 'Trang',
  post: 'Bài viết',
  product: 'Sản phẩm',
  order: 'Đơn hàng',
  media: 'Media',
  menu: 'Menu',
  form: 'Form',
  submission: 'Dữ liệu form',
  settings: 'Cài đặt',
  language: 'Ngôn ngữ',
  plugin: 'Plugin',
  webhook: 'Webhook',
  comment: 'Bình luận',
  review: 'Đánh giá',
  backup: 'Sao lưu',
  cache: 'Cache',
  tools: 'Công cụ',
  wallet: 'Ví',
  account: 'Tài khoản khách',
  payment: 'Thanh toán',
  ai: 'AI Studio',
};

export const VERB: Record<string, { label: string; className: string }> = {
  create: { label: 'Tạo mới', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  created: { label: 'Tạo mới', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  update: { label: 'Cập nhật', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  updated: { label: 'Cập nhật', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  delete: { label: 'Xoá', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  deleted: { label: 'Xoá', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  trashed: { label: 'Vào thùng rác', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  restored: { label: 'Khôi phục', className: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  published: { label: 'Xuất bản', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  login: { label: 'Đăng nhập', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' },
  save: { label: 'Lưu', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  upsert: { label: 'Lưu', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  bulk: { label: 'Hàng loạt', className: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' },
  clear: { label: 'Xoá cache', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  restore: { label: 'Khôi phục', className: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  revokeSessions: { label: 'Đăng xuất mọi thiết bị', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  enable: { label: 'Bật', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  disable: { label: 'Tắt', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' },
  install: { label: 'Cài đặt', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  upgrade: { label: 'Nâng cấp', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  settings: { label: 'Cài đặt', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  import: { label: 'Nhập dữ liệu', className: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' },
  export: { label: 'Xuất dữ liệu', className: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' },
  statusChanged: { label: 'Đổi trạng thái', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  // ví thành viên
  deposit: { label: 'Nạp tiền', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  withdraw: { label: 'Trừ tiền', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  payment: { label: 'Thanh toán', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  refund: { label: 'Hoàn tiền', className: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  unlock: { label: 'Mở khoá', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  session_revoked: { label: 'Thu hồi phiên', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  // đăng nhập / 2FA (auth.*)
  failed: { label: 'Đăng nhập thất bại', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  locked: { label: 'Bị khoá tạm thời', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  welcome: { label: 'Gửi email chào mừng', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  '2fa.enabled': { label: 'Bật 2FA', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  '2fa.disabled': { label: 'Tắt 2FA', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  '2fa.reset': { label: 'Đặt lại 2FA', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  '2fa.recovery_regenerated': { label: 'Tạo lại mã dự phòng', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  '2fa.recovery_used': { label: 'Dùng mã dự phòng', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  // auth.google_linked: tài khoản có sẵn (cùng email) được liên kết với Google ở lần đăng nhập Google đầu tiên
  google_linked: { label: 'Liên kết Google', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  // payment.confirm: admin xác nhận thủ công đã nhận tiền
  confirm: { label: 'Xác nhận thủ công', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  // payment.overpaid: khách chuyển thừa tiền so với giao dịch
  overpaid: { label: 'Chuyển thừa tiền', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  task_cancelled: { label: 'Huỷ & hoàn tiền', className: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  task_hidden: { label: 'Ẩn khỏi Cộng đồng', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  task_unhidden: { label: 'Bỏ ẩn Cộng đồng', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
};

export function describe(action: string) {
  const [entity, ...rest] = action.split('.');
  const verb = rest.join('.');
  return { entity: ENTITY[entity]?.label ?? entity, verb: VERB[verb] ?? { label: verb || action, className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' } };
}
