/**
 * Từ điển tiếng Anh dùng chung: thuật ngữ xuất hiện ở nhiều khu vực (gộp sau cùng để thống nhất một bản dịch),
 * và bản dịch theo ngữ cảnh `nav::` cho nhãn menu khu vực thành viên.
 */
const messages: Record<string, string> = {
  "Mã dự phòng": "Recovery code",
  "Đăng xuất": "Log out",
  "Thành công": "Successful",
  "Cho phép huỷ": "Cancellable",
  "Lỗi": "Error",
  "Đặt hàng": "Place order",
  "Đang cập nhật": "Updating",
  "Mã": "Code",
  "bản ghi mỗi trang": "rows per page",
  "Trang trước": "Previous page",
  "Trang sau": "Next page",
  "Dịch vụ tăng tương tác mạng xã hội uy tín, giá rẻ, tự động 24/7": "Trusted, affordable social media growth services, fully automated 24/7",
  "Đã huỷ": "Canceled",
  "Đơn hàng": "Order",
  "Dịch vụ": "Service",
  "Bình thường": "Normal",
  "Tăng giá": "Price increase",
  "Giảm giá": "Price decrease",
  "Thao tác": "Actions",
  "Nội dung": "Content",
  "Thời gian": "Time",
  "Giới thiệu bạn bè": "Affiliates",
  "Bảng giá dịch vụ": "Service pricing",
  // nhãn menu (member-shell dịch bằng t(`nav::${label}`)) — số nhiều / động từ khác nhãn trường dữ liệu
  "nav::Dịch vụ": "Services",
  "nav::Đơn hàng": "Orders",
  "nav::Đơn hàng lặp lại": "Repeat orders",
  "nav::Đặt hàng": "New order",
};

export default messages;
