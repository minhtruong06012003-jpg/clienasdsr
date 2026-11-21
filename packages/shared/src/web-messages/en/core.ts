/**
 * Từ điển tiếng Anh nhóm "core": khoá = chuỗi gốc tiếng Việt đúng như trong code (kể cả {biến}), giá trị = bản dịch.
 * Thiếu khoá -> hiện chuỗi gốc tiếng Việt.
 */
const messages: Record<string, string> = {
  "Tìm múi giờ, vd Tokyo, +07": "Search time zone, e.g. Tokyo, +07",
  "Không tìm thấy múi giờ": "No time zone found",
  // --- định dạng thời gian (lib/i18n/formatters.ts) ---
  "vừa xong": "just now",
  "{n} phút": "{n} min",
  "{h} giờ {m} phút": "{h} h {m} min",
  "{h} giờ": "{h} h",
  "{d} ngày {h} giờ": "{d} d {h} h",
  "{d} ngày": "{d} d",

  // --- providers / lỗi API phía client (lib/api.ts) ---
  "Không tải lại được dữ liệu: {error}": "Couldn't reload data: {error}",
  "Không tìm thấy dữ liệu hoặc chức năng chưa sẵn sàng": "Data not found or feature not available yet",
  "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút": "You're going too fast, please try again in a few minutes",
  "Máy chủ đang gặp sự cố ({status}). Vui lòng thử lại sau.": "The server is having trouble ({status}). Please try again later.",
  "Yêu cầu thất bại ({status})": "Request failed ({status})",
  "Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại": "Can't reach the server, please check your connection and try again",
  "Máy chủ phản hồi không hợp lệ": "Invalid server response",
  "Đã có lỗi xảy ra, vui lòng thử lại": "Something went wrong, please try again",

  // --- ngôn ngữ & khu vực (prefs-switcher, region-card) ---
  "Ngôn ngữ & tiền tệ": "Language & currency",
  "Ngôn ngữ & khu vực": "Language & region",
  "Ngôn ngữ": "Language",
  "Ngôn ngữ hiển thị của website": "Website display language",
  "Tiền tệ": "Currency",
  "Múi giờ": "Time zone",
  "Đã đổi ngôn ngữ": "Language changed",
  "Đã đổi tiền tệ hiển thị": "Display currency changed",
  "Đã đổi múi giờ": "Time zone changed",
  "Số dư và giá hiển thị theo tiền gốc": "Balance and prices are shown in the base currency",
  "Quy đổi tham khảo: 1 {code} = {rate}": "Reference rate: 1 {code} = {rate}",
  "mặc định": "default",
  "Giờ hiện tại: {time}": "Current time: {time}",
  "Theo website": "Website default",
  "Còn {n} ngày": "{n} days left",

  // --- thành phần dùng chung (components/common.tsx, confirm-dialog, table-footer...) ---
  "Chưa có dữ liệu": "No data yet",
  "Chức năng đang được cập nhật": "This feature is being updated",
  "Dữ liệu chưa sẵn sàng, vui lòng quay lại sau.": "Data isn't ready yet, please come back later.",
  "Không tải được dữ liệu": "Couldn't load data",
  "Thử lại": "Retry",
  "Đang tải...": "Loading...",
  "Tổng {n} mục": "Total: {n} items",
  "Trang {page}/{total}": "Page {page}/{total}",
  "Trước": "Previous",
  "Sau": "Next",
  "Đã sao chép": "Copied",
  "Đã sao chép {label}": "Copied {label}",
  "Trình duyệt không cho phép sao chép, hãy chép thủ công": "Your browser blocked copying, please copy manually",
  "Sao chép": "Copy",
  "Xác nhận": "Confirm",
  "Đóng": "Close",
  "Hiển thị": "Show",
  "Tổng {n}": "Total: {n}",
  "Đổi giao diện sáng/tối": "Toggle light/dark mode",
  "Mã QR": "QR code",
  "Không tạo được mã QR": "Couldn't generate QR code",

  // --- trang lỗi / 404 / metadata ---
  "Đã có lỗi xảy ra": "Something went wrong",
  "Vui lòng thử lại sau ít phút.": "Please try again in a few minutes.",
  "Không tìm thấy trang": "Page not found",
  "Trang bạn tìm không tồn tại hoặc đã bị di chuyển.": "The page you're looking for doesn't exist or has been moved.",
  "Về trang chủ": "Back to home",
  "{site} — Dịch vụ tăng tương tác mạng xã hội": "{site} — Social media growth services",
  // --- lib/smm.ts: nền tảng ---
  "Khác": "Other",

  // --- lib/smm.ts: trạng thái đơn ---
  "Chờ xử lý": "Pending",
  "Đang xếp hàng": "Queued",
  "Đang chạy": "In progress",
  "Hoàn thành": "Completed",
  "Hoàn tiền một phần": "Partial",
  // --- lib/smm.ts: trạng thái bảo hành ---
  "Đang bảo hành": "Refilling",
  "Từ chối": "Rejected",

  // --- lib/smm.ts: trạng thái ticket ---
  "Mới gửi": "Open",
  "Đã trả lời": "Answered",
  "Chờ hỗ trợ": "Awaiting support",
  "Đã đóng": "Closed",

  // --- lib/smm.ts: chủ đề ticket ---
  "Ghi mã đơn và mô tả vấn đề (chưa chạy, chạy không đủ, tụt...). Ảnh chụp màn hình giúp xử lý nhanh hơn.":
    "Include the order ID and describe the issue (not started, partial, drop...). Screenshots help us resolve it faster.",
  "Thanh toán / nạp tiền": "Payment / deposit",
  "Ghi số tiền, thời gian, ngân hàng và nội dung chuyển khoản; đính kèm ảnh biên lai.":
    "Include the amount, time, bank and transfer description; attach a photo of the receipt.",
  "Ghi mã dịch vụ và điều bạn cần hỏi (tốc độ, bảo hành, yêu cầu link...).": "Include the service ID and your question (speed, refill, link requirements...).",
  "API đại lý": "Reseller API",
  "Ghi endpoint, tham số đã gửi và phản hồi nhận được (đừng gửi API key).": "Include the endpoint, parameters sent and the response received (don't share your API key).",
  "Mô tả càng chi tiết càng giúp chúng tôi hỗ trợ nhanh hơn.": "The more detail you provide, the faster we can help.",

  // --- lib/smm.ts: mức ưu tiên ticket ---
  "Thấp": "Low",
  "Cao": "High",
  "Khẩn cấp": "Urgent",

  // --- lib/smm.ts: kiểu dịch vụ ---
  "Mặc định": "Default",
  "Bình luận tuỳ chỉnh": "Custom comments",
  "Gói": "Package",
  "Theo dõi bài mới": "Subscriptions",
  "Nhắc tên (mentions)": "Mentions",
  "Bình chọn (poll)": "Poll",

  // --- lib/smm.ts: loại cập nhật dịch vụ ---
  "Dịch vụ mới": "New service",
  "Mở lại": "Re-enabled",
  "Tạm ngưng": "Disabled",
  // --- lib/smm.ts: bảo hành / đơn vị giá ---
  "Bảo hành {n} ngày": "{n}-day refill",
  "Bảo hành": "Refill",
  "Không bảo hành": "No refill",
  "/ gói": "/ package",
  "/ 1.000": "/ 1,000",
};

export default messages;
