/**
 * Bảo mật dùng chung API + Admin: chính sách mật khẩu, so khớp IP / dải CIDR,
 * kiểu dữ liệu của Trung tâm bảo mật (nhật ký đăng nhập, quy tắc IP, điểm bảo mật).
 */

// ---------------------------------------------------------------------------- Chính sách mật khẩu

export interface PasswordPolicy {
  /** độ dài tối thiểu (6–64) */
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  /** chặn mật khẩu phổ biến / dễ đoán (danh sách nội bộ, không gọi dịch vụ ngoài) */
  blockCommon: boolean;
  /** không được chứa phần trước @ của email hoặc tên người dùng */
  blockPersonalInfo: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSymbol: false,
  blockCommon: true,
  blockPersonalInfo: true,
};

/** Đọc chính sách từ nhóm cài đặt `security` (khoá `password*`), thiếu khoá dùng mặc định */
export function readPasswordPolicy(raw: unknown): PasswordPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: string, d: boolean) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : d);
  const min = Number(r.passwordMinLength);
  return {
    minLength: Number.isFinite(min) ? Math.min(64, Math.max(6, Math.round(min))) : DEFAULT_PASSWORD_POLICY.minLength,
    requireUppercase: bool('passwordRequireUppercase', DEFAULT_PASSWORD_POLICY.requireUppercase),
    requireLowercase: bool('passwordRequireLowercase', DEFAULT_PASSWORD_POLICY.requireLowercase),
    requireNumber: bool('passwordRequireNumber', DEFAULT_PASSWORD_POLICY.requireNumber),
    requireSymbol: bool('passwordRequireSymbol', DEFAULT_PASSWORD_POLICY.requireSymbol),
    blockCommon: bool('passwordBlockCommon', DEFAULT_PASSWORD_POLICY.blockCommon),
    blockPersonalInfo: bool('passwordBlockPersonalInfo', DEFAULT_PASSWORD_POLICY.blockPersonalInfo),
  };
}

/**
 * Mật khẩu phổ biến nhất (theo các bộ rò rỉ công khai) + biến thể tiếng Việt hay gặp.
 * So khớp không phân biệt hoa thường, sau khi bỏ ký tự đặc biệt / số ở cuối (vd "Password@123" → "password").
 */
const COMMON_PASSWORDS = new Set(
  (
    '123456 123456789 12345678 1234567 12345 1234567890 111111 000000 123123 654321 666666 888888 999999 112233 121212 ' +
    '123321 159753 147258369 987654321 1q2w3e4r 1qaz2wsx qwerty qwerty123 qwertyuiop asdfgh asdfghjkl zxcvbnm abc123 ' +
    'password passw0rd password1 p@ssw0rd p@ssword admin admin123 administrator root toor letmein welcome welcome1 ' +
    'iloveyou monkey dragon master sunshine princess football baseball superman batman trustno1 shadow michael ' +
    'login guest test test123 demo changeme default secret hello hello123 whatever freedom starwars google ' +
    'matkhau matkhau123 anhyeuem emyeuanh yeuem yeuanh iloveyou123 vietnam vietnam123 hanoi saigon hochiminh ' +
    'anhyeuem123 emyeuanh123 baby honey 147258 258369 13579 a123456 aa123456 abcd1234 abcdef 123abc qweasd qazwsx ' +
    'cmsnt cmsnt123 shop shop123 website website123'
  ).split(' '),
);

/** Mật khẩu có nằm trong danh sách phổ biến / quá dễ đoán (toàn 1 ký tự, dãy liên tiếp) không */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  // bỏ hậu tố số / ký tự đặc biệt người dùng hay thêm cho "đủ điều kiện": Password@123 -> password
  const core = lower.replace(/[^a-z0-9]+/g, '').replace(/\d+$/, '');
  if (core.length >= 3 && COMMON_PASSWORDS.has(core)) return true;
  if (/^(.)\1+$/.test(lower)) return true;
  return false;
}

/**
 * Kiểm tra mật khẩu theo chính sách. Trả danh sách lỗi (rỗng = hợp lệ).
 * `ctx` (email, tên) dùng cho luật không chứa thông tin cá nhân.
 */
export function checkPassword(password: string, policy: PasswordPolicy, ctx: { email?: string | null; name?: string | null } = {}): string[] {
  const errors: string[] = [];
  const pw = String(password ?? '');
  if (pw.length < policy.minLength) errors.push(`tối thiểu ${policy.minLength} ký tự`);
  if (pw.length > 128) errors.push('tối đa 128 ký tự');
  if (policy.requireUppercase && !/[A-Z]/.test(pw)) errors.push('có ít nhất 1 chữ in hoa');
  if (policy.requireLowercase && !/[a-z]/.test(pw)) errors.push('có ít nhất 1 chữ thường');
  if (policy.requireNumber && !/\d/.test(pw)) errors.push('có ít nhất 1 chữ số');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) errors.push('có ít nhất 1 ký tự đặc biệt');
  if (policy.blockCommon && pw && isCommonPassword(pw)) errors.push('không dùng mật khẩu phổ biến, dễ đoán');
  if (policy.blockPersonalInfo && pw) {
    const lower = pw.toLowerCase();
    const local = (ctx.email ?? '').split('@')[0]?.toLowerCase() ?? '';
    const nameParts = (ctx.name ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\s+/)
      .filter((p) => p.length >= 4);
    const plain = lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if ((local.length >= 4 && lower.includes(local)) || nameParts.some((p) => plain.includes(p))) errors.push('không chứa email hoặc tên của bạn');
  }
  return errors;
}

/** Câu mô tả chính sách để hiển thị dưới ô nhập mật khẩu */
export function describePasswordPolicy(policy: PasswordPolicy): string {
  const parts = [`tối thiểu ${policy.minLength} ký tự`];
  if (policy.requireUppercase) parts.push('chữ in hoa');
  if (policy.requireLowercase) parts.push('chữ thường');
  if (policy.requireNumber) parts.push('chữ số');
  if (policy.requireSymbol) parts.push('ký tự đặc biệt');
  return `Mật khẩu ${parts.length > 1 ? `${parts[0]}, có ${parts.slice(1).join(', ')}` : parts[0]}${policy.blockCommon ? '; không dùng mật khẩu phổ biến' : ''}.`;
}

// ---------------------------------------------------------------------------- IP / CIDR

/** IPv4 -> số 32 bit; không hợp lệ -> null */
function ipv4ToBigInt(ip: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const v = Number(m[i]);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

/** IPv6 (kể cả dạng rút gọn "::" và đuôi IPv4) -> số 128 bit; không hợp lệ -> null */
function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.toLowerCase();
  if (s.includes('%')) s = s.split('%')[0];
  // đuôi IPv4: ::ffff:1.2.3.4
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

interface ParsedIp {
  v: 4 | 6;
  n: bigint;
}

/** Chuẩn hoá IP từ request (bỏ tiền tố ::ffff: của IPv4 ánh xạ) */
export function normalizeIp(ip: string | null | undefined): string {
  const s = String(ip ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

function parseIp(ip: string): ParsedIp | null {
  const s = normalizeIp(ip);
  const v4 = ipv4ToBigInt(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = s.includes(':') ? ipv6ToBigInt(s) : null;
  return v6 !== null ? { v: 6, n: v6 } : null;
}

/**
 * Chuẩn hoá một quy tắc IP do người dùng nhập: IP đơn hoặc CIDR ("1.2.3.0/24", "2001:db8::/32").
 * Trả null nếu không hợp lệ. CIDR được làm tròn về địa chỉ mạng (1.2.3.4/24 -> 1.2.3.0/24).
 */
export function normalizeIpRule(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const [addr, bitsRaw, extra] = raw.split('/');
  if (extra !== undefined) return null;
  const p = parseIp(addr);
  if (!p) return null;
  const max = p.v === 4 ? 32 : 128;
  if (bitsRaw === undefined) return p.v === 4 ? formatIpv4(p.n) : formatIpv6(p.n);
  if (!/^\d{1,3}$/.test(bitsRaw)) return null;
  const bits = Number(bitsRaw);
  if (bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  const net = p.n & mask;
  if (bits === max) return p.v === 4 ? formatIpv4(net) : formatIpv6(net);
  return `${p.v === 4 ? formatIpv4(net) : formatIpv6(net)}/${bits}`;
}

function formatIpv4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join('.');
}

function formatIpv6(n: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // rút gọn chuỗi số 0 dài nhất thành "::"
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

/** IP có thuộc quy tắc (IP đơn hoặc CIDR đã chuẩn hoá) không */
export function ipMatchesRule(ip: string | null | undefined, rule: string): boolean {
  const p = parseIp(String(ip ?? ''));
  if (!p) return false;
  const [addr, bitsRaw] = rule.split('/');
  const r = parseIp(addr);
  if (!r || r.v !== p.v) return false;
  const max = p.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return false;
  if (bits === 0) return true;
  const shift = BigInt(max - bits);
  return p.n >> shift === r.n >> shift;
}

/** Địa chỉ nội bộ máy chủ (127.0.0.0/8, ::1) — không bao giờ bị chặn để storefront SSR / cron luôn chạy */
export function isLoopbackIp(ip: string | null | undefined): boolean {
  const s = normalizeIp(ip);
  return s === '::1' || ipMatchesRule(s, '127.0.0.0/8');
}

/**
 * IP mạng nội bộ (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10) hoặc loopback.
 * Khi API đứng sau proxy ở container / máy khác mà chưa đặt TRUST_PROXY, mọi khách hiện chung IP nội bộ
 * của proxy — hệ thống không tự chặn những IP này để tránh chặn nhầm toàn bộ người dùng.
 */
export function isPrivateIp(ip: string | null | undefined): boolean {
  const s = normalizeIp(ip);
  if (isLoopbackIp(s)) return true;
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'].some((r) => ipMatchesRule(s, r));
}

/** Quy tắc có bao trùm địa chỉ loopback không (chặn quy tắc kiểu 0.0.0.0/0 hay 127.0.0.1) */
export function ruleCoversLoopback(rule: string): boolean {
  return ipMatchesRule('127.0.0.1', rule) || ipMatchesRule('::1', rule);
}

// ---------------------------------------------------------------------------- Kiểu Trung tâm bảo mật

export type IpRuleType = 'block' | 'allow_admin';

export interface IpRuleView {
  id: string;
  type: IpRuleType;
  value: string;
  note: string | null;
  source: 'manual' | 'auto';
  expiresAt: string | null;
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

export type LoginFailReason = 'password' | '2fa' | 'locked' | 'ip_blocked' | 'ip_not_allowed' | 'not_admin' | 'inactive' | 'pending';

export const LOGIN_FAIL_LABELS: Record<LoginFailReason, string> = {
  password: 'Sai mật khẩu / email',
  '2fa': 'Sai mã 2FA',
  locked: 'Tài khoản đang bị khoá',
  ip_blocked: 'IP bị chặn',
  ip_not_allowed: 'IP không được phép vào quản trị',
  not_admin: 'Không có quyền quản trị',
  inactive: 'Tài khoản bị vô hiệu',
  pending: 'Chưa xác minh email',
};

export interface LoginAttemptView {
  id: string;
  email: string;
  user: { id: string; name: string } | null;
  ip: string | null;
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  success: boolean;
  reason: LoginFailReason | null;
  area: 'admin' | 'site';
  method: 'password' | 'totp' | 'recovery' | 'google' | null;
  createdAt: string;
}

/** Một mục kiểm tra trong điểm bảo mật */
export interface SecurityCheck {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  /** điểm tối đa của mục (tổng mọi mục = 100) */
  weight: number;
  /** gợi ý xử lý + nơi xử lý trong admin */
  hint?: string;
  href?: string;
}

export interface SecurityOverview {
  /** 0–100 */
  score: number;
  checks: SecurityCheck[];
  stats: {
    /** 24 giờ qua */
    failed24h: number;
    success24h: number;
    lockedUsers: number;
    blockedIps: number;
    adminsWithout2fa: number;
    admins: number;
  };
  /** IP gửi nhiều lượt sai nhất 24 giờ qua */
  topFailedIps: { ip: string; count: number; blocked: boolean }[];
  /** số lượt đăng nhập theo ngày (14 ngày) */
  daily: { date: string; success: number; failed: number }[];
  /** IP của chính người đang xem (để thêm vào danh sách cho phép) */
  yourIp: string | null;
}
