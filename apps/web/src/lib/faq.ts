/* Dùng chung cho trang chủ (khối hỏi đáp) và dữ liệu cấu trúc FAQPage / llms.txt (server) nên tách khỏi component client */

/** Câu hỏi thường gặp (số dư ví tính bằng VND, dùng chung cho mọi công cụ AI; câu trùng trang /pricing dùng chung bản dịch) */
export const FAQ: [string, string][] = [
  ["Số dư dùng để làm gì?", "Số dư ví (VND) dùng chung cho mọi công cụ AI trên website. Mỗi lần tạo video, ảnh, giọng đọc sẽ trừ tiền theo model và độ dài bạn chọn — giá hiện rõ trước khi bấm tạo."],
  ["Tạo lỗi có bị mất tiền không?", "Không. Nếu AI xử lý lỗi hoặc quá thời gian, hệ thống tự hoàn lại toàn bộ số tiền của lần tạo đó vào số dư."],
  ["Thanh toán như thế nào?", "Bạn nhập số tiền muốn nạp (hoặc chọn mức gợi ý) rồi thanh toán bằng chuyển khoản ngân hàng (quét mã QR). Hệ thống tự cộng tiền vào số dư sau vài giây."],
  ["Số dư có hết hạn không?", "Không. Tiền đã nạp được giữ vĩnh viễn trong tài khoản, dùng lúc nào cũng được. Nạp càng nhiều càng được tặng thêm nhiều."],
  ["Tiếp thị liên kết hoạt động thế nào?", "Mỗi tài khoản có một link giới thiệu riêng. Người bạn giới thiệu nạp tiền, bạn nhận hoa hồng % vào ví hoa hồng và rút về số dư hoặc tài khoản ngân hàng."],
  ["Kết quả được lưu bao lâu?", "Kết quả nằm trong mục Lịch sử tạo của bạn. Nên tải về máy những file quan trọng vì file có thể được dọn sau một thời gian."],
];
