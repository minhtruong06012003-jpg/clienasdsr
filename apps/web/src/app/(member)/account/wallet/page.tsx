import { redirect } from "next/navigation";

/**
 * Link quay về mặc định của API nạp ví là `/account/wallet?topup=<id>` (docs/hop-dong-frontend.md 2.1).
 * Website không có trang nạp tiền (thanh toán gói quay về /checkout) nên chuyển sang bảng giá.
 */
export default function WalletRedirect() {
  redirect("/pricing");
}
