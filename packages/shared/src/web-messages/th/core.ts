/**
 * พจนานุกรมภาษาไทย กลุ่ม "core": คีย์ = ข้อความต้นฉบับภาษาเวียดนามตามในโค้ด (รวมถึง {ตัวแปร}), ค่า = คำแปลภาษาไทย
 * หากไม่มีคีย์ -> แสดงข้อความต้นฉบับภาษาเวียดนาม
 */
const messages: Record<string, string> = {
  "Tìm múi giờ, vd Tokyo, +07": "ค้นหาเขตเวลา เช่น Tokyo, +07",
  "Không tìm thấy múi giờ": "ไม่พบเขตเวลา",
  // --- định dạng thời gian (lib/i18n/formatters.ts) ---
  "vừa xong": "เมื่อสักครู่",
  "{n} phút": "{n} นาที",
  "{h} giờ {m} phút": "{h} ชม. {m} นาที",
  "{h} giờ": "{h} ชม.",
  "{d} ngày {h} giờ": "{d} วัน {h} ชม.",
  "{d} ngày": "{d} วัน",

  // --- providers / lỗi API phía client (lib/api.ts) ---
  "Không tải lại được dữ liệu: {error}": "ไม่สามารถโหลดข้อมูลซ้ำได้: {error}",
  "Không tìm thấy dữ liệu hoặc chức năng chưa sẵn sàng": "ไม่พบข้อมูลหรือฟีเจอร์นี้ยังไม่พร้อมใช้งาน",
  "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút": "คุณทำรายการเร็วเกินไป กรุณาลองอีกครั้งในอีกสักครู่",
  "Máy chủ đang gặp sự cố ({status}). Vui lòng thử lại sau.": "เซิร์ฟเวอร์กำลังขัดข้อง ({status}) กรุณาลองอีกครั้งในภายหลัง",
  "Yêu cầu thất bại ({status})": "คำขอล้มเหลว ({status})",
  "Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại": "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง",
  "Máy chủ phản hồi không hợp lệ": "การตอบกลับจากเซิร์ฟเวอร์ไม่ถูกต้อง",
  "Đã có lỗi xảy ra, vui lòng thử lại": "เกิดข้อผิดพลาด กรุณาลองอีกครั้ง",

  // --- ngôn ngữ & khu vực (prefs-switcher, region-card) ---
  "Ngôn ngữ & tiền tệ": "ภาษาและสกุลเงิน",
  "Ngôn ngữ & khu vực": "ภาษาและภูมิภาค",
  "Ngôn ngữ": "ภาษา",
  "Ngôn ngữ hiển thị của website": "ภาษาที่ใช้แสดงผลบนเว็บไซต์",
  "Tiền tệ": "สกุลเงิน",
  "Múi giờ": "เขตเวลา",
  "Đã đổi ngôn ngữ": "เปลี่ยนภาษาแล้ว",
  "Đã đổi tiền tệ hiển thị": "เปลี่ยนสกุลเงินที่แสดงแล้ว",
  "Đã đổi múi giờ": "เปลี่ยนเขตเวลาแล้ว",
  "Số dư và giá hiển thị theo tiền gốc": "ยอดคงเหลือและราคาแสดงตามสกุลเงินหลัก",
  "Quy đổi tham khảo: 1 {code} = {rate}": "อัตราแลกเปลี่ยนอ้างอิง: 1 {code} = {rate}",
  "mặc định": "ค่าเริ่มต้น",
  "Giờ hiện tại: {time}": "เวลาปัจจุบัน: {time}",
  "Theo website": "ตามค่าเริ่มต้นของเว็บไซต์",
  "Còn {n} ngày": "เหลืออีก {n} วัน",

  // --- thành phần dùng chung (components/common.tsx, confirm-dialog, table-footer...) ---
  "Chưa có dữ liệu": "ยังไม่มีข้อมูล",
  "Chức năng đang được cập nhật": "ฟีเจอร์นี้กำลังอยู่ระหว่างการอัปเดต",
  "Dữ liệu chưa sẵn sàng, vui lòng quay lại sau.": "ข้อมูลยังไม่พร้อมใช้งาน กรุณากลับมาใหม่ในภายหลัง",
  "Không tải được dữ liệu": "ไม่สามารถโหลดข้อมูลได้",
  "Thử lại": "ลองอีกครั้ง",
  "Đang tải...": "กำลังโหลด...",
  "Tổng {n} mục": "ทั้งหมด {n} รายการ",
  "Trang {page}/{total}": "หน้า {page}/{total}",
  "Trước": "ก่อนหน้า",
  "Sau": "ถัดไป",
  "Đã sao chép": "คัดลอกแล้ว",
  "Đã sao chép {label}": "คัดลอก {label} แล้ว",
  "Trình duyệt không cho phép sao chép, hãy chép thủ công": "เบราว์เซอร์ไม่อนุญาตให้คัดลอก กรุณาคัดลอกด้วยตนเอง",
  "Sao chép": "คัดลอก",
  "Xác nhận": "ยืนยัน",
  "Đóng": "ปิด",
  "Hiển thị": "แสดง",
  "Tổng {n}": "ทั้งหมด {n}",
  "Đổi giao diện sáng/tối": "สลับโหมดสว่าง/มืด",
  "Mã QR": "QR Code",
  "Không tạo được mã QR": "ไม่สามารถสร้าง QR Code ได้",

  // --- trang lỗi / 404 / metadata ---
  "Đã có lỗi xảy ra": "เกิดข้อผิดพลาด",
  "Vui lòng thử lại sau ít phút.": "กรุณาลองอีกครั้งในอีกสักครู่",
  "Không tìm thấy trang": "ไม่พบหน้าที่ต้องการ",
  "Trang bạn tìm không tồn tại hoặc đã bị di chuyển.": "หน้าที่คุณค้นหาไม่มีอยู่หรือถูกย้ายไปแล้ว",
  "Về trang chủ": "กลับสู่หน้าแรก",
  "{site} — Dịch vụ tăng tương tác mạng xã hội": "{site} — บริการเพิ่มยอดเอนเกจเมนต์โซเชียลมีเดีย",
  // --- lib/smm.ts: nền tảng ---
  "Khác": "อื่นๆ",

  // --- lib/smm.ts: trạng thái đơn ---
  "Chờ xử lý": "รอดำเนินการ",
  "Đang xếp hàng": "อยู่ในคิว",
  "Đang chạy": "กำลังดำเนินการ",
  "Hoàn thành": "เสร็จสิ้น",
  "Hoàn tiền một phần": "คืนเงินบางส่วน",
  // --- lib/smm.ts: trạng thái bảo hành ---
  "Đang bảo hành": "กำลังเติมยอดประกัน",
  "Từ chối": "ปฏิเสธ",

  // --- lib/smm.ts: trạng thái ticket ---
  "Mới gửi": "เปิดใหม่",
  "Đã trả lời": "ตอบกลับแล้ว",
  "Chờ hỗ trợ": "รอฝ่ายสนับสนุน",
  "Đã đóng": "ปิดแล้ว",

  // --- lib/smm.ts: chủ đề ticket ---
  "Ghi mã đơn và mô tả vấn đề (chưa chạy, chạy không đủ, tụt...). Ảnh chụp màn hình giúp xử lý nhanh hơn.":
    "ระบุรหัสคำสั่งซื้อและรายละเอียดปัญหา (ยังไม่เริ่มทำงาน ยอดไม่ครบ ยอดลด ฯลฯ) แนบภาพหน้าจอเพื่อช่วยให้ตรวจสอบได้เร็วขึ้น",
  "Thanh toán / nạp tiền": "การชำระเงิน / เติมเงิน",
  "Ghi số tiền, thời gian, ngân hàng và nội dung chuyển khoản; đính kèm ảnh biên lai.":
    "ระบุจำนวนเงิน เวลา ธนาคาร และบันทึกการโอน พร้อมแนบรูปสลิปการโอนเงิน",
  "Ghi mã dịch vụ và điều bạn cần hỏi (tốc độ, bảo hành, yêu cầu link...).": "ระบุรหัสบริการและสิ่งที่ต้องการสอบถาม (ความเร็ว การรับประกัน ข้อกำหนดของลิงก์ ฯลฯ)",
  "API đại lý": "API ตัวแทนจำหน่าย",
  "Ghi endpoint, tham số đã gửi và phản hồi nhận được (đừng gửi API key).": "ระบุ endpoint พารามิเตอร์ที่ส่ง และการตอบกลับที่ได้รับ (ห้ามส่ง API key เด็ดขาด)",
  "Mô tả càng chi tiết càng giúp chúng tôi hỗ trợ nhanh hơn.": "ยิ่งระบุรายละเอียดชัดเจน เราจะยิ่งช่วยเหลือคุณได้เร็วยิ่งขึ้น",

  // --- lib/smm.ts: mức ưu tiên ticket ---
  "Thấp": "ต่ำ",
  "Cao": "สูง",
  "Khẩn cấp": "เร่งด่วน",

  // --- lib/smm.ts: kiểu dịch vụ ---
  "Mặc định": "ค่าเริ่มต้น",
  "Bình luận tuỳ chỉnh": "ความคิดเห็นแบบกำหนดเอง",
  "Gói": "แพ็กเกจ",
  "Theo dõi bài mới": "ติดตามโพสต์ใหม่อัตโนมัติ",
  "Nhắc tên (mentions)": "การกล่าวถึง (Mentions)",
  "Bình chọn (poll)": "โหวตโพล (Poll)",

  // --- lib/smm.ts: loại cập nhật dịch vụ ---
  "Dịch vụ mới": "บริการใหม่",
  "Mở lại": "เปิดใช้งานอีกครั้ง",
  "Tạm ngưng": "ระงับชั่วคราว",
  // --- lib/smm.ts: bảo hành / đơn vị giá ---
  "Bảo hành {n} ngày": "รับประกัน {n} วัน",
  "Bảo hành": "รับประกัน",
  "Không bảo hành": "ไม่รับประกัน",
  "/ gói": "/ แพ็กเกจ",
  "/ 1.000": "/ 1,000",
};

export default messages;
