import { redirect } from "next/navigation";

/**
 * Trang nạp tiền vào ví nằm ở /pricing (nhập số tiền tự do + khuyến mãi theo mốc) rồi trả qua cổng ở trang thanh toán.
 * Giữ đường dẫn cũ /add-funds (link đã chia sẻ, bookmark) và chuyển sang bảng giá.
 */
export default function AddFundsPage() {
  redirect("/pricing");
}
