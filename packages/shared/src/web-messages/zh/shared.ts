/**
 * 简体中文公共词典：跨区域复用的通用术语（最后合并以统一译法），
 * 以及会员中心菜单标签专用的 `nav::` 上下文翻译。
 */
const messages: Record<string, string> = {
  "Mã dự phòng": "备用验证码",
  "Đăng xuất": "退出登录",
  "Thành công": "成功",
  "Cho phép huỷ": "可取消",
  "Lỗi": "错误",
  "Đặt hàng": "下单",
  "Đang cập nhật": "更新中",
  "Mã": "代码",
  "bản ghi mỗi trang": "条/页",
  "Trang trước": "上一页",
  "Trang sau": "下一页",
  "Dịch vụ tăng tương tác mạng xã hội uy tín, giá rẻ, tự động 24/7": "值得信赖的高性价比社交媒体互动增长服务，7×24 小时全自动运行",
  "Đã huỷ": "已取消",
  "Đơn hàng": "订单",
  "Dịch vụ": "服务",
  "Bình thường": "正常",
  "Tăng giá": "价格上调",
  "Giảm giá": "价格下调",
  "Thao tác": "操作",
  "Nội dung": "内容",
  "Thời gian": "时间",
  "Giới thiệu bạn bè": "邀请返佣",
  "Bảng giá dịch vụ": "服务价格表",
  // nhãn menu (member-shell dịch bằng t(`nav::${label}`)) — số nhiều / động từ khác nhãn trường dữ liệu
  "nav::Dịch vụ": "服务",
  "nav::Đơn hàng": "订单",
  "nav::Đơn hàng lặp lại": "重复订单",
  "nav::Đặt hàng": "新建订单",
};

export default messages;
