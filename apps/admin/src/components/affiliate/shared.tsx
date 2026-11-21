'use client';

/** Kiểu dữ liệu + nhãn dùng chung của trang Tiếp thị liên kết (API /admin/affiliate/*) */
import Link from 'next/link';

export type AffiliateTxnType = 'COMMISSION' | 'REVOKE' | 'PAYOUT' | 'PAYOUT_REFUND' | 'ADJUST';
export type PayoutStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type PayoutMethod = 'WALLET' | 'BANK';

export interface UserRef {
  id: string;
  name: string;
  email: string;
}

/** Một dòng sổ cái ví hoa hồng */
export interface AffiliateTxn {
  id: string;
  type: AffiliateTxnType;
  amount: number | string;
  balanceAfter: number | string;
  note: string | null;
  createdAt: string;
  user: UserRef;
  fromUser: UserRef | null;
  createdBy: { id: string; name: string } | null;
  payout: { id: string; code: number } | null;
}

/** Một yêu cầu rút hoa hồng */
export interface AffiliatePayout {
  id: string;
  code: number;
  amount: number | string;
  method: PayoutMethod;
  status: PayoutStatus;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  note: string | null;
  adminNote: string | null;
  processedAt: string | null;
  createdAt: string;
  user: UserRef & { affiliateBalance: number | string };
  processedBy: { id: string; name: string } | null;
}

/** GET /admin/affiliate/stats */
export interface AffiliateStats {
  settings: { enabled: boolean; commission: number; minPayout: number };
  commissionTotal: number;
  commission30d: number;
  revokedTotal: number;
  outstanding: number;
  pendingCount: number;
  pendingAmount: number;
  paidToWallet: number;
  paidToBank: number;
  referred: number;
  referrers: number;
  top: (UserRef & { referralCode: string | null; affiliateBalance: number; earned: number; referrals: number })[];
}

/** Màu nhãn (cùng bảng màu với components/ai/shared.tsx, kèm biến thể dark) */
const TONE = {
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  pink: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
} as const;

export const TXN_TYPE: Record<AffiliateTxnType, { label: string; className: string }> = {
  COMMISSION: { label: 'Hoa hồng', className: TONE.pink },
  REVOKE: { label: 'Thu hồi', className: TONE.red },
  PAYOUT: { label: 'Rút tiền', className: TONE.amber },
  PAYOUT_REFUND: { label: 'Hoàn yêu cầu rút', className: TONE.violet },
  ADJUST: { label: 'Admin điều chỉnh', className: TONE.sky },
};
export const TXN_TYPES = Object.keys(TXN_TYPE) as AffiliateTxnType[];

export const PAYOUT_STATUS: Record<PayoutStatus, { label: string; className: string }> = {
  PENDING: { label: 'Chờ duyệt', className: TONE.amber },
  APPROVED: { label: 'Đã duyệt', className: TONE.emerald },
  REJECTED: { label: 'Từ chối', className: TONE.red },
  CANCELLED: { label: 'Khách huỷ', className: TONE.slate },
};
export const PAYOUT_STATUSES = Object.keys(PAYOUT_STATUS) as PayoutStatus[];

export const PAYOUT_METHOD: Record<PayoutMethod, string> = { WALLET: 'Vào số dư ví', BANK: 'Ngân hàng' };

/** Ô tên + email khách, bấm mở trang thành viên */
export function UserCell({ user }: { user: UserRef }) {
  return (
    <div className="min-w-0 max-w-48">
      <Link href={`/users/${user.id}`} className="line-clamp-1 text-sm font-medium hover:text-primary">
        {user.name}
      </Link>
      <div className="truncate text-xs text-muted-foreground">{user.email}</div>
    </div>
  );
}
