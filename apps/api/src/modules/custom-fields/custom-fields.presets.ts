import type { FieldGroupDef } from '@cmsnt/shared';

/**
 * Mẫu nhóm trường có sẵn — cài 1 chạm trong admin (Trường tuỳ chỉnh › Mẫu có sẵn).
 * Mục đích: dựng nhanh website bán khoá học, tài khoản số, phần mềm bản quyền... mà không cần
 * sửa lõi. Khách hàng có thể sửa lại sau khi cài (mẫu chỉ là điểm xuất phát).
 */
export interface FieldGroupPreset {
  key: string;
  name: string;
  description: string;
  /** icon lucide hiển thị trong admin */
  icon: string;
  groups: FieldGroupDef[];
}

export const FIELD_GROUP_PRESETS: FieldGroupPreset[] = [
  {
    key: 'course',
    name: 'Khoá học online',
    description: 'Thông tin khoá học cho sản phẩm: thời lượng, số bài, trình độ, giảng viên, video giới thiệu, chương trình học, link vào học sau khi mua.',
    icon: 'graduation-cap',
    groups: [
      {
        key: 'course_info',
        name: 'Thông tin khoá học',
        description: 'Hiển thị ở trang chi tiết khoá học',
        entity: 'product',
        placement: 'main',
        fields: [
          { key: 'level', label: 'Trình độ', type: 'select', options: [{ value: 'beginner', label: 'Cơ bản' }, { value: 'intermediate', label: 'Trung cấp' }, { value: 'advanced', label: 'Nâng cao' }], default: 'beginner', width: 'half' },
          { key: 'duration_hours', label: 'Thời lượng (giờ)', type: 'number', min: 0, step: 0.5, width: 'half' },
          { key: 'lesson_count', label: 'Số bài học', type: 'number', min: 0, width: 'half' },
          { key: 'language', label: 'Ngôn ngữ giảng dạy', type: 'text', i18n: true, width: 'half', placeholder: 'Tiếng Việt' },
          { key: 'certificate', label: 'Có cấp chứng chỉ', type: 'boolean', default: false, width: 'half' },
          { key: 'lifetime_access', label: 'Truy cập trọn đời', type: 'boolean', default: true, width: 'half' },
          { key: 'intro_video', label: 'Video giới thiệu (YouTube/Vimeo URL)', type: 'url' },
          { key: 'requirements', label: 'Yêu cầu đầu vào', type: 'textarea', i18n: true, rows: 3 },
          { key: 'outcomes', label: 'Bạn sẽ học được', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Nội dung', type: 'text', i18n: true }] },
          {
            key: 'curriculum',
            label: 'Chương trình học',
            type: 'repeater',
            itemLabelField: 'title',
            fields: [
              { key: 'title', label: 'Tên chương', type: 'text', i18n: true },
              { key: 'lessons', label: 'Số bài', type: 'number', min: 0, width: 'half' },
              { key: 'duration', label: 'Thời lượng', type: 'text', width: 'half', placeholder: '45 phút' },
              { key: 'preview_url', label: 'Link học thử', type: 'url' },
            ],
          },
        ],
      },
      {
        key: 'course_instructor',
        name: 'Giảng viên',
        entity: 'product',
        placement: 'sidebar',
        fields: [
          { key: 'instructor_name', label: 'Tên giảng viên', type: 'text' },
          { key: 'instructor_title', label: 'Chức danh', type: 'text', i18n: true },
          { key: 'instructor_avatar', label: 'Ảnh giảng viên', type: 'image' },
          { key: 'instructor_bio', label: 'Giới thiệu', type: 'textarea', i18n: true, rows: 4 },
        ],
      },
      {
        key: 'course_access',
        name: 'Truy cập sau khi mua',
        description: 'Chỉ nhân viên thấy; dùng để gửi cho học viên sau khi thanh toán',
        entity: 'product',
        placement: 'sidebar',
        fields: [
          { key: 'access_url', label: 'Link vào học', type: 'url', public: false },
          { key: 'access_note', label: 'Hướng dẫn truy cập', type: 'textarea', rows: 3, public: false },
        ],
      },
    ],
  },
  {
    key: 'digital_account',
    name: 'Tài khoản số / dịch vụ',
    description: 'Bán tài khoản Netflix, Spotify, ChatGPT, VPN...: nền tảng, gói, thời hạn, bảo hành, cách bàn giao, lưu ý sử dụng. Bật "Bán theo kho mã" ở sản phẩm để nhập sẵn tài khoản và tự giao khi khách thanh toán.',
    icon: 'key-round',
    groups: [
      {
        key: 'account_info',
        name: 'Thông tin tài khoản',
        entity: 'product',
        placement: 'main',
        fields: [
          { key: 'platform', label: 'Nền tảng', type: 'text', placeholder: 'Netflix, Spotify, ChatGPT...', width: 'half' },
          { key: 'plan', label: 'Gói', type: 'text', i18n: true, placeholder: 'Premium 4K', width: 'half' },
          { key: 'duration_days', label: 'Thời hạn (ngày)', type: 'number', min: 0, width: 'half' },
          { key: 'account_type', label: 'Loại tài khoản', type: 'select', options: [{ value: 'private', label: 'Chính chủ (riêng)' }, { value: 'shared', label: 'Dùng chung (slot)' }, { value: 'upgrade', label: 'Nâng cấp trên tài khoản của khách' }], default: 'private', width: 'half' },
          { key: 'warranty', label: 'Bảo hành', type: 'text', i18n: true, placeholder: 'Bảo hành trọn thời gian sử dụng', width: 'half' },
          { key: 'delivery_time', label: 'Thời gian bàn giao', type: 'text', i18n: true, placeholder: 'Tự động sau thanh toán', width: 'half' },
          { key: 'devices', label: 'Số thiết bị dùng cùng lúc', type: 'number', min: 1, width: 'half' },
          { key: 'region', label: 'Khu vực áp dụng', type: 'text', placeholder: 'Toàn cầu / Việt Nam', width: 'half' },
          { key: 'features', label: 'Quyền lợi', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Nội dung', type: 'text', i18n: true }] },
          { key: 'usage_guide', label: 'Hướng dẫn sử dụng', type: 'richtext', i18n: true },
          { key: 'notes', label: 'Lưu ý trước khi mua', type: 'textarea', i18n: true, rows: 3 },
        ],
      },
      {
        key: 'account_internal',
        name: 'Ghi chú nội bộ',
        description: 'Không hiển thị trên website',
        entity: 'product',
        placement: 'sidebar',
        fields: [
          { key: 'supplier', label: 'Nguồn nhập', type: 'text', public: false },
          { key: 'internal_note', label: 'Ghi chú', type: 'textarea', rows: 3, public: false },
        ],
      },
    ],
  },
  {
    key: 'software_license',
    name: 'Phần mềm / bản quyền',
    description: 'Bán key bản quyền, phần mềm tải về: phiên bản, hệ điều hành, loại giấy phép, số thiết bị, link tải, yêu cầu hệ thống.',
    icon: 'package-check',
    groups: [
      {
        key: 'software_info',
        name: 'Thông tin phần mềm',
        entity: 'product',
        placement: 'main',
        fields: [
          { key: 'version', label: 'Phiên bản', type: 'text', width: 'half' },
          { key: 'vendor', label: 'Nhà phát hành', type: 'text', width: 'half' },
          { key: 'os', label: 'Hệ điều hành', type: 'multiselect', options: [{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'macOS' }, { value: 'linux', label: 'Linux' }, { value: 'android', label: 'Android' }, { value: 'ios', label: 'iOS' }] },
          { key: 'license_type', label: 'Loại giấy phép', type: 'select', options: [{ value: 'lifetime', label: 'Vĩnh viễn' }, { value: 'subscription', label: 'Thuê bao' }, { value: 'oem', label: 'OEM' }, { value: 'retail', label: 'Retail' }], width: 'half' },
          { key: 'device_limit', label: 'Số thiết bị kích hoạt', type: 'number', min: 1, width: 'half' },
          { key: 'activation_guide', label: 'Hướng dẫn kích hoạt', type: 'richtext', i18n: true },
          { key: 'system_requirements', label: 'Yêu cầu hệ thống', type: 'textarea', i18n: true, rows: 4 },
          { key: 'download_url', label: 'Link tải bản cài đặt (công khai)', type: 'url' },
          { key: 'changelog_url', label: 'Trang nhật ký thay đổi', type: 'url' },
        ],
      },
    ],
  },
  {
    key: 'post_extra',
    name: 'Bài viết nâng cao',
    description: 'Thêm cho bài viết: nguồn tham khảo, tác giả khách, video, bài nổi bật ghim, file đính kèm.',
    icon: 'newspaper',
    groups: [
      {
        key: 'post_extra',
        name: 'Thông tin thêm',
        entity: 'post',
        placement: 'sidebar',
        fields: [
          { key: 'guest_author', label: 'Tác giả khách', type: 'text', help: 'Để trống = dùng tài khoản đăng bài' },
          { key: 'source', label: 'Nguồn tham khảo', type: 'link', i18n: true },
          { key: 'video_url', label: 'Video (YouTube URL)', type: 'url' },
          { key: 'attachment', label: 'Tệp đính kèm', type: 'file' },
          { key: 'sponsored', label: 'Bài tài trợ', type: 'boolean', default: false },
        ],
      },
    ],
  },
  {
    key: 'member_profile',
    name: 'Hồ sơ thành viên mở rộng',
    description: 'Thêm cho thành viên: ngày sinh, giới tính, công ty, mã số thuế, Zalo/Telegram, nhóm khách hàng.',
    icon: 'contact',
    groups: [
      {
        key: 'member_profile',
        name: 'Hồ sơ mở rộng',
        entity: 'user',
        placement: 'main',
        fields: [
          { key: 'birthday', label: 'Ngày sinh', type: 'date', width: 'half' },
          { key: 'gender', label: 'Giới tính', type: 'select', options: [{ value: 'male', label: 'Nam' }, { value: 'female', label: 'Nữ' }, { value: 'other', label: 'Khác' }], width: 'half' },
          { key: 'company', label: 'Công ty', type: 'text', width: 'half' },
          { key: 'tax_code', label: 'Mã số thuế', type: 'text', width: 'half' },
          { key: 'zalo', label: 'Zalo', type: 'text', width: 'half' },
          { key: 'telegram', label: 'Telegram', type: 'text', width: 'half' },
          { key: 'segment', label: 'Nhóm khách hàng', type: 'select', options: [{ value: 'new', label: 'Mới' }, { value: 'regular', label: 'Thân thiết' }, { value: 'vip', label: 'VIP' }, { value: 'wholesale', label: 'Đại lý / sỉ' }], public: false },
          { key: 'staff_note', label: 'Ghi chú của nhân viên', type: 'textarea', rows: 3, public: false },
        ],
      },
    ],
  },
  {
    key: 'game_account',
    name: 'Shop acc game',
    description: 'Bán tài khoản game (Liên Quân, Free Fire, PUBG, Genshin...): game, máy chủ, rank, cấp, số tướng/skin, đăng ký bằng gì, ảnh chi tiết. Mỗi acc nên là 1 sản phẩm bật "Bán theo kho mã" (nhập 1 mã "tài khoản|mật khẩu") để tự giao khi thanh toán.',
    icon: 'gamepad-2',
    groups: [
      {
        key: 'game_account_info',
        name: 'Thông tin acc',
        description: 'Hiển thị ở trang chi tiết acc',
        entity: 'product',
        placement: 'main',
        fields: [
          { key: 'game', label: 'Game', type: 'text', placeholder: 'Liên Quân Mobile, Free Fire...', width: 'half' },
          { key: 'server', label: 'Máy chủ', type: 'text', placeholder: 'Việt Nam, Asia...', width: 'half' },
          { key: 'rank', label: 'Rank', type: 'text', placeholder: 'Cao Thủ, Kim Cương...', width: 'half' },
          { key: 'level', label: 'Cấp độ', type: 'number', min: 0, width: 'half' },
          { key: 'heroes_count', label: 'Số tướng / nhân vật', type: 'number', min: 0, width: 'half' },
          { key: 'skins_count', label: 'Số skin / trang phục', type: 'number', min: 0, width: 'half' },
          {
            key: 'register_by',
            label: 'Đăng ký bằng',
            type: 'select',
            options: [
              { value: 'facebook', label: 'Facebook' },
              { value: 'google', label: 'Google' },
              { value: 'garena', label: 'Tài khoản Garena' },
              { value: 'email', label: 'Email' },
              { value: 'phone', label: 'Số điện thoại' },
              { value: 'other', label: 'Khác' },
            ],
            default: 'garena',
            width: 'half',
          },
          { key: 'can_change_info', label: 'Đổi được thông tin (email, SĐT, mật khẩu)', type: 'boolean', default: true, width: 'half' },
          { key: 'highlights', label: 'Điểm nổi bật', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Nội dung', type: 'text', i18n: true }] },
          { key: 'screenshots', label: 'Ảnh chi tiết acc', type: 'gallery' },
          { key: 'notes', label: 'Ghi chú cho người mua', type: 'textarea', i18n: true, rows: 3 },
        ],
      },
      {
        key: 'game_account_internal',
        name: 'Ghi chú nội bộ',
        description: 'Không hiển thị trên website',
        entity: 'product',
        placement: 'sidebar',
        fields: [
          { key: 'supplier', label: 'Nguồn nhập acc', type: 'text', public: false },
          { key: 'internal_note', label: 'Ghi chú', type: 'textarea', rows: 3, public: false },
        ],
      },
    ],
  },
  {
    key: 'gift_card',
    name: 'Thẻ cào / gift card',
    description: 'Bán thẻ cào điện thoại, thẻ game, gift card (Steam, Google Play, iTunes...): nhà phát hành, mệnh giá, khu vực, hạn dùng, cách nạp. Bật "Bán theo kho mã" để nhập sẵn "số seri|mã thẻ" và tự giao khi thanh toán.',
    icon: 'credit-card',
    groups: [
      {
        key: 'gift_card_info',
        name: 'Thông tin thẻ',
        entity: 'product',
        placement: 'main',
        fields: [
          { key: 'issuer', label: 'Nhà phát hành', type: 'text', placeholder: 'Viettel, Garena, Steam, Google Play...', width: 'half' },
          { key: 'face_value', label: 'Mệnh giá', type: 'number', min: 0, width: 'half' },
          { key: 'currency', label: 'Đơn vị mệnh giá', type: 'text', placeholder: 'VND, USD...', default: 'VND', width: 'half' },
          { key: 'region', label: 'Khu vực sử dụng', type: 'text', placeholder: 'Việt Nam / Toàn cầu / US', width: 'half' },
          { key: 'validity', label: 'Hạn dùng', type: 'text', i18n: true, placeholder: '12 tháng kể từ ngày mua', width: 'half' },
          { key: 'delivery_time', label: 'Thời gian giao thẻ', type: 'text', i18n: true, placeholder: 'Tự động ngay sau thanh toán', width: 'half' },
          { key: 'redeem_url', label: 'Trang nạp thẻ', type: 'url' },
          { key: 'redeem_guide', label: 'Cách nạp', type: 'richtext', i18n: true },
          { key: 'notes', label: 'Lưu ý', type: 'textarea', i18n: true, rows: 3 },
        ],
      },
    ],
  },
];
