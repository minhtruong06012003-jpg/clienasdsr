/**
 * 简体中文词典（"core" 模块）：键 = 代码中的越南语原始字符串（含 {变量}），值 = 简体中文翻译。
 * 缺失键时将回退显示越南语原文。
 */
const messages: Record<string, string> = {
  "Tìm múi giờ, vd Tokyo, +07": "搜索时区，例如 Tokyo、+07",
  "Không tìm thấy múi giờ": "未找到时区",
  // --- định dạng thời gian (lib/i18n/formatters.ts) ---
  "vừa xong": "刚刚",
  "{n} phút": "{n} 分钟",
  "{h} giờ {m} phút": "{h} 小时 {m} 分钟",
  "{h} giờ": "{h} 小时",
  "{d} ngày {h} giờ": "{d} 天 {h} 小时",
  "{d} ngày": "{d} 天",

  // --- providers / lỗi API phía client (lib/api.ts) ---
  "Không tải lại được dữ liệu: {error}": "无法重新加载数据：{error}",
  "Không tìm thấy dữ liệu hoặc chức năng chưa sẵn sàng": "未找到数据或功能暂未开放",
  "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút": "操作过于频繁，请几分钟后再试",
  "Máy chủ đang gặp sự cố ({status}). Vui lòng thử lại sau.": "服务器出现异常 ({status})，请稍后再试。",
  "Yêu cầu thất bại ({status})": "请求失败 ({status})",
  "Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại": "无法连接服务器，请检查网络后重试",
  "Máy chủ phản hồi không hợp lệ": "服务器响应无效",
  "Đã có lỗi xảy ra, vui lòng thử lại": "发生错误，请重试",

  // --- ngôn ngữ & khu vực (prefs-switcher, region-card) ---
  "Ngôn ngữ & tiền tệ": "语言与货币",
  "Ngôn ngữ & khu vực": "语言与地区",
  "Ngôn ngữ": "语言",
  "Ngôn ngữ hiển thị của website": "网站显示语言",
  "Tiền tệ": "货币",
  "Múi giờ": "时区",
  "Đã đổi ngôn ngữ": "语言已切换",
  "Đã đổi tiền tệ hiển thị": "显示货币已切换",
  "Đã đổi múi giờ": "时区已切换",
  "Số dư và giá hiển thị theo tiền gốc": "余额和价格以基础货币显示",
  "Quy đổi tham khảo: 1 {code} = {rate}": "参考汇率：1 {code} = {rate}",
  "mặc định": "默认",
  "Giờ hiện tại: {time}": "当前时间：{time}",
  "Theo website": "网站默认",
  "Còn {n} ngày": "剩余 {n} 天",

  // --- thành phần dùng chung (components/common.tsx, confirm-dialog, table-footer...) ---
  "Chưa có dữ liệu": "暂无数据",
  "Chức năng đang được cập nhật": "功能正在更新中",
  "Dữ liệu chưa sẵn sàng, vui lòng quay lại sau.": "数据暂未就绪，请稍后再试。",
  "Không tải được dữ liệu": "数据加载失败",
  "Thử lại": "重试",
  "Đang tải...": "加载中...",
  "Tổng {n} mục": "共 {n} 项",
  "Trang {page}/{total}": "第 {page}/{total} 页",
  "Trước": "上一页",
  "Sau": "下一页",
  "Đã sao chép": "已复制",
  "Đã sao chép {label}": "已复制 {label}",
  "Trình duyệt không cho phép sao chép, hãy chép thủ công": "浏览器不允许自动复制，请手动复制",
  "Sao chép": "复制",
  "Xác nhận": "确认",
  "Đóng": "关闭",
  "Hiển thị": "显示",
  "Tổng {n}": "共 {n} 条",
  "Đổi giao diện sáng/tối": "切换浅色/深色模式",
  "Mã QR": "二维码",
  "Không tạo được mã QR": "无法生成二维码",

  // --- trang lỗi / 404 / metadata ---
  "Đã có lỗi xảy ra": "发生错误",
  "Vui lòng thử lại sau ít phút.": "请几分钟后再试。",
  "Không tìm thấy trang": "页面未找到",
  "Trang bạn tìm không tồn tại hoặc đã bị di chuyển.": "您访问的页面不存在或已被移动。",
  "Về trang chủ": "返回首页",
  "{site} — Dịch vụ tăng tương tác mạng xã hội": "{site} — 社交媒体互动增长服务",
  // --- lib/smm.ts: nền tảng ---
  "Khác": "其他",

  // --- lib/smm.ts: trạng thái đơn ---
  "Chờ xử lý": "待处理",
  "Đang xếp hàng": "排队中",
  "Đang chạy": "进行中",
  "Hoàn thành": "已完成",
  "Hoàn tiền một phần": "部分退款",
  // --- lib/smm.ts: trạng thái bảo hành ---
  "Đang bảo hành": "补单中",
  "Từ chối": "已拒绝",

  // --- lib/smm.ts: trạng thái ticket ---
  "Mới gửi": "新提交",
  "Đã trả lời": "已回复",
  "Chờ hỗ trợ": "等待客服",
  "Đã đóng": "已关闭",

  // --- lib/smm.ts: chủ đề ticket ---
  "Ghi mã đơn và mô tả vấn đề (chưa chạy, chạy không đủ, tụt...). Ảnh chụp màn hình giúp xử lý nhanh hơn.":
    "请填写订单号并描述问题（未开始、数量不足、掉量等），附上截图有助于更快处理。",
  "Thanh toán / nạp tiền": "支付 / 充值",
  "Ghi số tiền, thời gian, ngân hàng và nội dung chuyển khoản; đính kèm ảnh biên lai.":
    "请填写金额、时间、银行及转账备注，并附上转账凭证截图。",
  "Ghi mã dịch vụ và điều bạn cần hỏi (tốc độ, bảo hành, yêu cầu link...).":
    "请填写服务 ID 及您想咨询的内容（速度、质保补单、链接要求等）。",
  "API đại lý": "代理商 API",
  "Ghi endpoint, tham số đã gửi và phản hồi nhận được (đừng gửi API key).":
    "请提供接口地址（Endpoint）、请求参数及返回结果（请勿发送您的 API Key）。",
  "Mô tả càng chi tiết càng giúp chúng tôi hỗ trợ nhanh hơn.": "描述越详细，我们就能越快为您提供协助。",

  // --- lib/smm.ts: mức ưu tiên ticket ---
  "Thấp": "低",
  "Cao": "高",
  "Khẩn cấp": "紧急",

  // --- lib/smm.ts: kiểu dịch vụ ---
  "Mặc định": "默认",
  "Bình luận tuỳ chỉnh": "自定义评论",
  "Gói": "套餐",
  "Theo dõi bài mới": "新帖订阅",
  "Nhắc tên (mentions)": "提及 (Mentions)",
  "Bình chọn (poll)": "投票 (Poll)",

  // --- lib/smm.ts: loại cập nhật dịch vụ ---
  "Dịch vụ mới": "新增服务",
  "Mở lại": "重新启用",
  "Tạm ngưng": "已停用",
  // --- lib/smm.ts: bảo hành / đơn vị giá ---
  "Bảo hành {n} ngày": "{n} 天质保",
  "Bảo hành": "质保",
  "Không bảo hành": "无质保",
  "/ gói": "/ 套餐",
  "/ 1.000": "/ 1,000",
};

export default messages;
